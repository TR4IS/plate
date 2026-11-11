// Logging food: the in-app camera, "describe it" for text-only, and the estimate you confirm.
import { blobToBase64, photoFromFile, photoFromVideo } from '../image.js';
import { html, useEffect, useLayoutEffect, useRef, useState } from '../lib.js';
import {
  analyzeMeal,
  closeOverlay,
  errorText,
  hintSeen,
  markHint,
  replaceOverlay,
  saveMeal,
  toast,
  useStore,
} from '../store.js';
import { Icon, MacroPills, Screen, Sheet, Spinner, cx, registerOverlay, useClosing } from '../ui.js';
import { dayStr, fmtDay, fmtInt, fmtNum, haptic, parseDay, sum, uid } from '../util.js';

const TIPS = [
  { icon: 'sun', text: 'Use good light and avoid hard shadows', short: 'Good light, no hard shadows' },
  { icon: 'target', text: 'Fit the whole plate inside the corners', short: 'Whole plate inside the corners' },
  { icon: 'hand', text: 'Shoot from above at a slight angle, with a fork or your hand in view for scale', short: 'From above, with a fork for scale' },
  { icon: 'note', text: 'Afterwards, add a note for what the camera cannot see: oil, sauces, weights', short: 'Add a note for oil and sauces' },
];

function TipsCard({ onDone }) {
  return html`<div class="cam-tips">
    <h3>For the most accurate estimate</h3>
    <ul>
      ${TIPS.map((tip) => html`<li><${Icon} name=${tip.icon} size="18" /><span>${tip.text}</span></li>`)}
    </ul>
    <button class="got-it" onClick=${onDone}>Got it</button>
  </div>`;
}

/** One tip at a time along the bottom of the preview, once the full card has been dismissed. */
function TipTicker({ onOpen }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setIndex((i) => (i + 1) % TIPS.length), 4200);
    return () => clearInterval(timer);
  }, []);
  const tip = TIPS[index];
  return html`<button class="cam-hint" onClick=${onOpen} key=${index}>
    <${Icon} name=${tip.icon} size="16" /><span>${tip.short}</span>
  </button>`;
}

const CAMERA_PROBLEM = {
  insecure: {
    title: 'The live camera needs a secure address',
    text: 'Open Plate through your https address to use it. You can still take a photo with the system camera.',
  },
  denied: {
    title: 'Camera access is off',
    text: 'Allow it in Settings › Safari › Camera, or tap "aA" in the address bar › Website Settings. You can still take a photo below.',
  },
  unavailable: { title: "Couldn't start the camera", text: 'Another app may be using it. You can still take or choose a photo.' },
};

/**
 * The camera card grows out of the button that opened it and rises into place, then shrinks back
 * into it on close. The card's real shape is revealed with a clip, so nothing inside is stretched.
 */
function useMorph(cardRef, origin, closing) {
  const still = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const shapes = () => {
    const card = cardRef.current.getBoundingClientRect();
    const radius = parseFloat(getComputedStyle(cardRef.current).borderTopLeftRadius) || 32;
    const from = origin
      ? {
          top: Math.max(0, origin.top - card.top),
          right: Math.max(0, card.right - (origin.left + origin.width)),
          bottom: Math.max(0, card.bottom - (origin.top + origin.height)),
          left: Math.max(0, origin.left - card.left),
          radius: origin.radius,
        }
      : { top: card.height - 64, right: card.width / 2 - 32, bottom: 0, left: card.width / 2 - 32, radius: 32 };
    const clip = (b) => `inset(${b.top}px ${b.right}px ${b.bottom}px ${b.left}px round ${b.radius}px)`;
    return { small: clip(from), full: clip({ top: 0, right: 0, bottom: 0, left: 0, radius }) };
  };

  useLayoutEffect(() => {
    if (!cardRef.current || still()) return;
    const { small, full } = shapes();
    cardRef.current.animate(
      [
        { clipPath: small, transform: 'translateY(18px)' },
        { clipPath: full, transform: 'translateY(0)' },
      ],
      { duration: 520, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' },
    );
  }, []);

  useEffect(() => {
    if (!closing || !cardRef.current || still()) return;
    const { small, full } = shapes();
    cardRef.current.animate(
      [
        { clipPath: full, opacity: 1 },
        { clipPath: small, opacity: 0.6 },
      ],
      { duration: 280, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' },
    );
  }, [closing]);
}

function CaptureScreen({ day, origin }) {
  const s = useStore();
  const closing = useClosing();
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const handedOff = useRef(false);
  const libraryInput = useRef(null);
  const systemCameraInput = useRef(null);
  const cardRef = useRef(null);

  const [status, setStatus] = useState('starting'); // starting | live | insecure | denied | unavailable
  const [facing, setFacing] = useState('environment');
  const [restart, setRestart] = useState(0);
  const [photo, setPhoto] = useState(null); // { analysis, keep, url }
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(0);
  const [tipsOpen, setTipsOpen] = useState(() => !hintSeen('camera-tips'));
  const [menuOpen, setMenuOpen] = useState(false);
  useMorph(cardRef, origin, closing);

  const stopStream = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  // The camera runs only while the live preview is on screen.
  useEffect(() => {
    if (photo || closing) return undefined;
    let cancelled = false;
    (async () => {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setStatus('insecure');
        return;
      }
      setStatus('starting');
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        video.srcObject = stream;
        await video.play().catch(() => {});
        if (!cancelled) setStatus('live');
      } catch (err) {
        if (!cancelled) setStatus(err?.name === 'NotAllowedError' || err?.name === 'SecurityError' ? 'denied' : 'unavailable');
      }
    })();
    return () => {
      cancelled = true;
      stopStream();
    };
  }, [facing, Boolean(photo), closing, restart]);

  // iOS freezes the stream when the app goes to the background; start a fresh one on return.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stopStream();
      else setRestart((n) => n + 1);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  useEffect(
    () => () => {
      if (photo && !handedOff.current) URL.revokeObjectURL(photo.url);
    },
    [photo],
  );

  const dismissTips = () => {
    markHint('camera-tips');
    setTipsOpen(false);
  };

  const shoot = async () => {
    if (status !== 'live' || busy) return;
    haptic();
    setFlash(Date.now());
    try {
      setPhoto(await photoFromVideo(videoRef.current));
      dismissTips();
    } catch {
      toast("Couldn't take the photo. Try again.", 'error');
    }
  };

  const pickFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      setPhoto(await photoFromFile(file));
      dismissTips();
    } catch {
      toast("That image couldn't be opened. Try another.", 'error');
    }
  };

  const send = async () => {
    if (busy || !photo) return;
    setBusy(true);
    try {
      const image = await blobToBase64(photo.analysis);
      const estimate = await analyzeMeal({ image, note: note.trim() });
      const photoBase64 = await blobToBase64(photo.keep);
      handedOff.current = true;
      replaceOverlay('estimate', { estimate, note: note.trim(), day, image, photoUrl: photo.url, photoBase64, source: 'photo' });
    } catch (err) {
      setBusy(false);
      toast(errorText(err), 'error', 5000);
    }
  };

  const logWithoutAi = async () => {
    const photoBase64 = await blobToBase64(photo.keep);
    handedOff.current = true;
    replaceOverlay('mealEdit', { day, photoUrl: photo.url, photoBase64 });
  };

  const problem = CAMERA_PROBLEM[status];
  const menu = (action) => () => {
    setMenuOpen(false);
    action();
  };

  // A card that rises over the lower part of the screen, with the app still in view above it.
  return html`<div class=${cx('cam', closing && 'closing')} role="dialog" aria-label="Scan a meal">
    <button class="cam-backdrop" aria-label="Close camera" tabindex="-1" onClick=${() => !busy && closeOverlay()} />
    <div class="cam-card" ref=${cardRef}>
    <div class="cam-view">
      ${photo
        ? html`<img class="shot" key=${photo.url} src=${photo.url} alt="Your photo" />`
        : html`<video ref=${videoRef} class=${cx(facing === 'user' && 'mirror', status === 'live' ? 'focused' : 'waking')} playsinline muted autoplay />`}
      ${flash > 0 && html`<div class="cam-flash" key=${flash} />`}

      ${photo &&
      !busy &&
      html`<div class="cam-top">
        <button class="glass-btn" onClick=${() => setPhoto(null)}><${Icon} name="retake" size="18" /> Retake</button>
        <button class="glass-btn" onClick=${() => closeOverlay()} aria-label="Close"><${Icon} name="x" size="20" /></button>
      </div>`}

      ${!photo && status === 'live' && html`<div class="cam-frame"><i /><i /><i /><i /></div>`}
      ${!photo &&
      problem &&
      html`<div class="cam-message">
        <${Icon} name="camera" size="34" />
        <b class="strong" style=${{ color: '#fff', fontSize: '18px' }}>${problem.title}</b>
        <span class="sub">${problem.text}</span>
        <button class="btn" onClick=${() => systemCameraInput.current.click()}>Take a photo</button>
        <button class="btn alt" onClick=${() => libraryInput.current.click()}>Choose from library</button>
      </div>`}

      ${!photo && !problem && (tipsOpen ? html`<${TipsCard} onDone=${dismissTips} />` : html`<${TipTicker} onOpen=${() => setTipsOpen(true)} />`)}
      ${busy && html`<div class="cam-scan"><p>Estimating your meal…</p></div>`}

    ${photo
      ? html`<div class="cam-compose">
          <div class="compose-box">
            <textarea
              rows="1"
              placeholder="Add details (optional)"
              aria-label="Details for the AI"
              value=${note}
              disabled=${busy}
              onInput=${(event) => {
                setNote(event.target.value);
                event.target.style.height = 'auto';
                event.target.style.height = `${Math.min(110, event.target.scrollHeight)}px`;
              }}
            />
            <button class="send-btn" onClick=${send} disabled=${busy || !s.ai.ready} aria-label="Estimate this meal">
              ${busy ? html`<${Spinner} small />` : html`<${Icon} name="arrowUp" size="22" stroke="2.5" />`}
            </button>
          </div>
          ${!busy &&
          html`<div class="small center" style=${{ color: 'rgba(255,255,255,0.6)' }}>
            ${s.ai.ready
              ? 'e.g. "cooked in butter", "about 200 g of rice", "ate half"'
              : html`No AI connected yet. <button class="link" style=${{ color: '#fff' }} onClick=${logWithoutAi}>Enter the numbers yourself</button>`}
          </div>`}
        </div>`
      : html`<div class="cam-controls">
          <button class="cam-side" onClick=${() => closeOverlay()} aria-label="Close camera">
            <${Icon} name="left" size="22" />
          </button>
          <button class="shutter" onClick=${shoot} disabled=${status !== 'live'} aria-label="Take photo" />
          <button class="cam-side" onClick=${() => setMenuOpen(!menuOpen)} aria-label="More" aria-expanded=${String(menuOpen)}>
            <${Icon} name="more" size="22" />
          </button>
          ${menuOpen &&
          html`<div class="cam-menu" role="menu">
            <button role="menuitem" onClick=${menu(() => libraryInput.current.click())}><${Icon} name="image" size="19" /> Choose a photo</button>
            <button role="menuitem" disabled=${status !== 'live'} onClick=${menu(() => setFacing(facing === 'environment' ? 'user' : 'environment'))}>
              <${Icon} name="flip" size="19" /> Switch camera
            </button>
            <button role="menuitem" onClick=${menu(() => setTipsOpen(true))}><${Icon} name="bulb" size="19" /> Photo tips</button>
          </div>`}
        </div>`}
    </div>
    </div>

    <input ref=${libraryInput} type="file" accept="image/*" hidden onChange=${pickFile} />
    <input ref=${systemCameraInput} type="file" accept="image/*" capture="environment" hidden onChange=${pickFile} />
  </div>`;
}

function DescribeSheet({ day }) {
  const s = useStore();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 350);
    return () => clearTimeout(timer);
  }, []);

  const estimate = async () => {
    if (busy || !text.trim()) return;
    setBusy(true);
    try {
      const result = await analyzeMeal({ note: text.trim() });
      replaceOverlay('estimate', { estimate: result, note: text.trim(), day, source: 'text' });
    } catch (err) {
      setBusy(false);
      toast(errorText(err), 'error', 5000);
    }
  };

  return html`<${Sheet} title="Describe your meal">
    <div class="stack">
      <textarea
        ref=${inputRef}
        class="input"
        rows="4"
        placeholder="e.g. 2 scrambled eggs, 2 slices of toast with butter and a latte"
        value=${text}
        onInput=${(event) => setText(event.target.value)}
      />
      ${!s.ai.ready && html`<div class="note"><${Icon} name="sparkles" size="20" /><span>No AI is connected yet, so estimates are unavailable. You can still enter the numbers yourself.</span></div>`}
      <button class="btn btn-primary btn-lg btn-block" onClick=${estimate} disabled=${!text.trim() || busy || !s.ai.ready}>
        ${busy ? html`<${Spinner} small /> Estimating…` : html`<${Icon} name="sparkles" size="20" /> Estimate`}
      </button>
      <button class="btn btn-quiet btn-block" onClick=${() => replaceOverlay('mealEdit', { day })}>Enter the numbers myself</button>
    </div>
  <//>`;
}

const CONFIDENCE = { high: 'Confident', medium: 'Fairly sure', low: 'Rough guess' };
const round1 = (n) => Math.round(n * 10) / 10;

function EstimateScreen({ estimate: first, note, day, image, photoUrl, photoBase64, source }) {
  const [estimate, setEstimate] = useState(first);
  const [name, setName] = useState(first.name);
  const [off, setOff] = useState(() => new Set());
  const [portion, setPortion] = useState(1);
  const [fix, setFix] = useState('');
  const [fixing, setFixing] = useState(false);
  const saved = useRef(false);

  useEffect(
    () => () => {
      if (photoUrl && !saved.current) URL.revokeObjectURL(photoUrl);
    },
    [],
  );

  const included = estimate.items.filter((_, i) => !off.has(i));
  const total = (field) => sum(included, (item) => item[field]) * portion;
  // Read the date now rather than from app state, so a meal logged just after midnight lands on the new day.
  const today = dayStr();
  const targetDay = day || today;

  const toggle = (index) => {
    const next = new Set(off);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    setOff(next);
  };

  const refine = async () => {
    if (fixing || !fix.trim()) return;
    setFixing(true);
    try {
      const next = await analyzeMeal({ image, note, previous: estimate, correction: fix.trim() });
      setEstimate(next);
      setName(next.name);
      setOff(new Set());
      setPortion(1);
      setFix('');
    } catch (err) {
      toast(errorText(err), 'error', 5000);
    } finally {
      setFixing(false);
    }
  };

  const save = () => {
    if (!included.length) return;
    // A meal added to an earlier day sits at midday; today's uses the real time.
    const ts = targetDay === today ? Date.now() : parseDay(targetDay).getTime() + 12 * 3600 * 1000;
    const meal = {
      id: uid('m'),
      day: targetDay,
      ts,
      name: name.trim() || estimate.name,
      calories: Math.round(total('calories')),
      protein: round1(total('protein')),
      carbs: round1(total('carbs')),
      fat: round1(total('fat')),
      items: estimate.items.map((item, i) => ({
        ...item,
        grams: Math.round(item.grams * portion),
        calories: Math.round(item.calories * portion),
        protein: round1(item.protein * portion),
        carbs: round1(item.carbs * portion),
        fat: round1(item.fat * portion),
        ...(off.has(i) ? { off: true } : {}),
      })),
      note,
      source,
      meta: { confidence: estimate.confidence, notes: estimate.notes, portion },
    };
    saved.current = true;
    saveMeal(meal, photoBase64 || null, photoUrl || null);
    haptic();
    closeOverlay();
    toast(targetDay === today ? 'Added to today' : `Added to ${fmtDay(targetDay)}`, 'good');
  };

  const foot = html`<button class="btn btn-primary btn-lg btn-block" onClick=${save} disabled=${!included.length || fixing}>
    ${targetDay === today ? 'Add to today' : `Add to ${fmtDay(targetDay)}`}
  </button>`;

  return html`<${Screen} title="Your meal" rise backIcon="x" foot=${foot}>
    <div class="stack">
      ${photoUrl && html`<img class="result-photo" src=${photoUrl} alt="" />`}

      <div>
        <input
          class="input h2"
          style=${{ background: 'none', padding: 0, height: '36px', borderRadius: 0, boxShadow: 'none' }}
          aria-label="Meal name"
          value=${name}
          onInput=${(event) => setName(event.target.value)}
        />
        <div class="result-total" style=${{ marginTop: '6px' }}>
          <span class="n">${fmtInt(total('calories'))}</span><span class="soft strong">kcal</span>
        </div>
      </div>
      <${MacroPills} protein=${total('protein')} carbs=${total('carbs')} fat=${total('fat')} />

      <div class="card" style=${{ padding: '6px 18px', opacity: fixing ? 0.5 : 1 }}>
        ${estimate.items.map(
          (item, i) =>
            html`<button class=${cx('item-row', off.has(i) && 'off')} onClick=${() => toggle(i)} aria-pressed=${String(!off.has(i))}>
              <span class="item-check"><${Icon} name="check" size="14" stroke="3" /></span>
              <span class="grow">
                <span class="item-name" style=${{ display: 'block' }}>${item.name}</span>
                <span class="small muted" style=${{ display: 'block' }}>${item.portion || `${item.grams} g`}</span>
              </span>
              <span class="item-kcal num">${fmtInt(item.calories * portion)}</span>
            </button>`,
        )}
      </div>

      <div class="portion" style=${{ background: 'var(--surface)' }}>
        <span class="strong">Portion eaten</span>
        <span class="portion-ctrl">
          <button onClick=${() => setPortion(Math.max(0.25, portion - 0.25))} aria-label="Less"><${Icon} name="minus" size="18" /></button>
          <b class="num">${fmtNum(portion, 2)}×</b>
          <button onClick=${() => setPortion(Math.min(4, portion + 0.25))} aria-label="More"><${Icon} name="plus" size="18" /></button>
        </span>
      </div>

      ${(estimate.notes || estimate.confidence) &&
      html`<div class="note">
        <${Icon} name="bulb" size="20" />
        <span><b class="strong" style=${{ color: 'var(--ink)' }}>${CONFIDENCE[estimate.confidence] || 'Estimate'}.</b> ${estimate.notes}</span>
      </div>`}

      <div class="compose-box themed">
        <textarea
          rows="1"
          placeholder="Not right? Tell the AI what to change"
          aria-label="Correction for the AI"
          value=${fix}
          disabled=${fixing}
          onInput=${(event) => setFix(event.target.value)}
          onKeyDown=${(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              refine();
            }
          }}
        />
        <button
          class="send-btn"
          onClick=${refine}
          disabled=${fixing || !fix.trim()}
          aria-label="Send correction"
        >
          ${fixing ? html`<${Spinner} small />` : html`<${Icon} name="arrowUp" size="22" stroke="2.5" />`}
        </button>
      </div>
    </div>
  <//>`;
}

registerOverlay('capture', CaptureScreen);
registerOverlay('describe', DescribeSheet);
registerOverlay('estimate', EstimateScreen);
