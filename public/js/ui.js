// Small shared building blocks. Views compose these; none of them know about the server.
import { ICONS } from './icons.js';
import { createContext, html, useContext, useEffect, useReducer, useRef, useState } from './lib.js';
import { closeOverlay, set, useStore } from './store.js';
import { clamp, fmtNum, haptic, parseNumber } from './util.js';

export const cx = (...names) => names.filter(Boolean).join(' ');

export function Icon({ name, size = 24, stroke = 2, class: className }) {
  return html`<svg
    class=${className}
    width=${size}
    height=${size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width=${stroke}
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    dangerouslySetInnerHTML=${{ __html: ICONS[name] || '' }}
  />`;
}

/** Re-render on an interval (for countdowns). Returns the current time in ms. */
export function useNow(intervalMs = 250, active = true) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, active]);
  return now;
}

// ---- overlays ----------------------------------------------------------------------------

const OverlayContext = createContext({ closing: false });
const registry = {};

export function registerOverlay(type, component) {
  registry[type] = component;
}

const EXIT_MS = 300;

/**
 * Renders the overlay stack. An overlay that was just closed stays mounted (same instance, so it
 * keeps its state) with `closing` set for as long as its exit animation runs.
 */
export function OverlayHost() {
  const { overlays } = useStore();
  const [, rerender] = useReducer((n) => n + 1, 0);
  const shown = useRef([]);

  const now = Date.now();
  const leaving = shown.current
    .filter((old) => !overlays.some((live) => live.id === old.id))
    .map((old) => (old.closing ? old : { ...old, closing: true, expires: now + EXIT_MS }))
    .filter((old) => old.expires > now);
  const all = [...overlays.map((o) => ({ ...o, closing: false })), ...leaving].sort((a, b) => a.id - b.id);
  shown.current = all;

  useEffect(() => {
    if (!leaving.length) return undefined;
    const soonest = Math.min(...leaving.map((o) => o.expires));
    const timer = setTimeout(rerender, Math.max(0, soonest - Date.now()) + 16);
    return () => clearTimeout(timer);
  });

  // Only the top screen can be used; the ones beneath it are out of reach for taps, focus and screen readers.
  const topId = overlays.length ? overlays[overlays.length - 1].id : null;
  return all.map((overlay) => {
    const View = registry[overlay.type];
    if (!View) return null;
    return html`<div class="overlay-slot" key=${overlay.id} inert=${overlay.id !== topId}>
      <${OverlayContext.Provider} value=${{ closing: overlay.closing }}>
        <${View} ...${overlay.props} />
      <//>
    </div>`;
  });
}

export const useClosing = () => useContext(OverlayContext).closing;

/** A full page that slides over the tabs. */
export function Screen({ title, children, right, foot, onBack, rise = false, backIcon = 'left', bodyRef, bodyClass }) {
  const closing = useClosing();
  return html`<div class=${cx('screen', rise && 'rise', closing && 'closing')} role="dialog" aria-label=${title}>
    <header class=${cx('screen-head', right && 'wide-right')}>
      <button class="icon-btn" onClick=${onBack || (() => closeOverlay())} aria-label=${backIcon === 'x' ? 'Close' : 'Go back'}>
        <${Icon} name=${backIcon} />
      </button>
      <div class="screen-title ellipsis">${title}</div>
      <div>${right}</div>
    </header>
    <div class=${cx('screen-body', bodyClass)} ref=${bodyRef}>${children}</div>
    ${foot && html`<footer class="screen-foot">${foot}</footer>`}
  </div>`;
}

/** A panel that rises from the bottom. Drag the handle down, or tap outside, to dismiss. */
export function Sheet({ title, children, foot, right, onClose }) {
  const closing = useClosing();
  const panel = useRef(null);
  const drag = useRef(null);
  const close = onClose || (() => closeOverlay());

  const handlers = {
    onTouchStart: (event) => {
      drag.current = { startY: event.touches[0].clientY, startedAt: Date.now(), dy: 0 };
      panel.current.style.transition = 'none';
    },
    onTouchMove: (event) => {
      if (!drag.current) return;
      drag.current.dy = Math.max(0, event.touches[0].clientY - drag.current.startY);
      panel.current.style.transform = `translateY(${drag.current.dy}px)`;
    },
    onTouchEnd: () => {
      const d = drag.current;
      drag.current = null;
      if (!d) return;
      const flicked = d.dy > 30 && d.dy / Math.max(1, Date.now() - d.startedAt) > 0.5;
      panel.current.style.transition = 'transform 0.26s cubic-bezier(0.32, 0.72, 0, 1)';
      if (d.dy > 120 || flicked) {
        // Finish the motion the finger started instead of replaying the closing animation.
        panel.current.style.transform = 'translateY(100%)';
        panel.current.style.animation = 'none';
        close();
      } else {
        panel.current.style.transform = '';
      }
    },
  };

  return html`<div class=${cx('sheet-layer', closing && 'closing')}>
    <div class="sheet-scrim" onClick=${close} />
    <div class="sheet surface" ref=${panel} role="dialog" aria-label=${title}>
      <div class="sheet-grab" ...${handlers} />
      ${title &&
      html`<div class="sheet-head" ...${handlers}>
        <h2 class="h3 ellipsis">${title}</h2>
        ${right || html`<button class="icon-btn filled" onClick=${close} aria-label="Close"><${Icon} name="x" size="20" /></button>`}
      </div>`}
      <div class="sheet-body">${children}</div>
      ${foot && html`<div class="sheet-foot">${foot}</div>`}
    </div>
  </div>`;
}

// ---- dialogs and toasts ------------------------------------------------------------------

let resolveDialog = null;

/** Ask a yes/no question. Resolves true when confirmed. */
export function confirmDialog({ title, message, confirm = 'OK', cancel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    resolveDialog = resolve;
    set({ dialog: { title, message, confirm, cancel, danger } });
  });
}

export function DialogHost() {
  const { dialog } = useStore();
  if (!dialog) return null;
  const answer = (value) => {
    set({ dialog: null });
    resolveDialog?.(value);
    resolveDialog = null;
  };
  return html`<div class="dialog-layer">
    <div class="sheet-scrim" onClick=${() => answer(false)} />
    <div class="dialog" role="alertdialog" aria-label=${dialog.title}>
      <h2 class="h3">${dialog.title}</h2>
      ${dialog.message && html`<p class="sub soft" style=${{ marginTop: '8px' }}>${dialog.message}</p>`}
      <div class="actions">
        <button class=${cx('btn btn-block', dialog.danger ? 'btn-secondary btn-danger' : 'btn-primary')} onClick=${() => answer(true)}>
          ${dialog.confirm}
        </button>
        <button class="btn btn-block btn-quiet" onClick=${() => answer(false)}>${dialog.cancel}</button>
      </div>
    </div>
  </div>`;
}

export function ToastHost() {
  const { toast } = useStore();
  if (!toast) return null;
  const icon = toast.kind === 'error' ? 'alert' : toast.kind === 'good' ? 'check' : null;
  return html`<div class="toast" role="status" key=${toast.id}>
    <div>${icon && html`<${Icon} name=${icon} size="18" />`}<span>${toast.message}</span></div>
  </div>`;
}

// ---- controls ----------------------------------------------------------------------------

export function Segmented({ options, value, onChange }) {
  return html`<div class="seg" role="group">
    ${options.map(
      (option) =>
        html`<button type="button" aria-pressed=${String(option.value === value)} onClick=${() => onChange(option.value)}>
          ${option.label}
        </button>`,
    )}
  </div>`;
}

export function Toggle({ checked, onChange, label }) {
  return html`<button
    type="button"
    class="toggle"
    role="switch"
    aria-checked=${String(Boolean(checked))}
    aria-label=${label}
    onClick=${() => {
      haptic();
      onChange(!checked);
    }}
  />`;
}

export function Field({ label, children, hint }) {
  return html`<div class="field">
    <label>${label}</label>
    ${children}
    ${hint && html`<div class="small muted" style=${{ paddingLeft: '4px' }}>${hint}</div>`}
  </div>`;
}

/** A text box for a number, with an optional unit shown inside it. Calls onChange with a number. */
export function NumberInput({ value, onChange, unit, placeholder, places = 1, min = 0, max = 99999, ariaLabel }) {
  const [draft, setDraft] = useState(null);
  const shown = draft ?? (value || value === 0 ? fmtNum(value, places) : '');
  return html`<div class="input-wrap">
    <input
      class="input"
      inputmode="decimal"
      enterkeyhint="done"
      autocomplete="off"
      aria-label=${ariaLabel}
      placeholder=${placeholder}
      value=${shown}
      onFocus=${(event) => {
        setDraft(shown);
        const input = event.target;
        setTimeout(() => input.select(), 0);
      }}
      onInput=${(event) => {
        setDraft(event.target.value);
        if (event.target.value.trim() !== '') onChange(clamp(parseNumber(event.target.value), min, max));
      }}
      onBlur=${() => setDraft(null)}
      onKeyDown=${(event) => event.key === 'Enter' && event.target.blur()}
    />
    ${unit && html`<span class="unit">${unit}</span>`}
  </div>`;
}

/**
 * [-] number [+]. Tap the number to type it; hold a button to keep stepping.
 * Stepping snaps to multiples of `step`, so 61 kg + 2.5 gives 62.5, then 65.
 */
export function Stepper({ label, unit, value, onChange, step = 1, min = 0, max = 9999, places = 2, compact = false }) {
  const [draft, setDraft] = useState(null);
  const latest = useRef(value);
  latest.current = value;
  const holdTimer = useRef(null);

  const bump = (direction) => {
    const current = latest.current;
    const ratio = current / step;
    const snapped = direction > 0 ? Math.floor(ratio + 1e-6) * step + step : Math.ceil(ratio - 1e-6) * step - step;
    const next = clamp(Math.round(snapped * 1000) / 1000, min, max);
    if (next === current) return;
    latest.current = next;
    onChange(next);
    haptic();
  };

  const stop = () => clearTimeout(holdTimer.current);
  const press = (direction) => (event) => {
    if (event.button > 0) return;
    setDraft(null);
    bump(direction);
    let delay = 320;
    const repeat = () => {
      bump(direction);
      delay = Math.max(60, delay * 0.8);
      holdTimer.current = setTimeout(repeat, delay);
    };
    stop();
    holdTimer.current = setTimeout(repeat, 450);
  };
  useEffect(() => stop, []);

  const hold = (direction) => ({
    onPointerDown: press(direction),
    onPointerUp: stop,
    onPointerLeave: stop,
    onPointerCancel: stop,
    onContextMenu: (event) => event.preventDefault(),
  });

  const commit = () => {
    if (draft !== null && draft.trim() !== '') onChange(clamp(parseNumber(draft), min, max));
    setDraft(null);
  };

  return html`<div class=${cx('stepper', compact && 'compact')}>
    ${label && html`<div class="stepper-label">${label}${unit && html`<span class="stepper-unit">(${unit})</span>`}</div>`}
    <div class="stepper-body">
      <button type="button" class="stepper-btn" aria-label=${`Less ${label || ''}`} ...${hold(-1)}>
        <${Icon} name="minus" size="22" stroke="2.4" />
      </button>
      <input
        class="stepper-value num"
        inputmode="decimal"
        enterkeyhint="done"
        autocomplete="off"
        aria-label=${label}
        value=${draft ?? fmtNum(value, places)}
        onFocus=${(event) => {
          setDraft(fmtNum(value, places));
          const input = event.target;
          setTimeout(() => input.select(), 0);
        }}
        onInput=${(event) => setDraft(event.target.value)}
        onBlur=${commit}
        onKeyDown=${(event) => event.key === 'Enter' && event.target.blur()}
      />
      <button type="button" class="stepper-btn" aria-label=${`More ${label || ''}`} ...${hold(1)}>
        <${Icon} name="plus" size="22" stroke="2.4" />
      </button>
    </div>
  </div>`;
}

// ---- data display ------------------------------------------------------------------------

/** A circular meter. The fill animates from empty the first time it appears. */
export function Ring({ size = 200, stroke = 16, value, max, over = false, children }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const fraction = ready && max > 0 ? clamp(value / max, 0, 1) : 0;
  const circle = { cx: size / 2, cy: size / 2, r: radius, fill: 'none', 'stroke-width': stroke };
  return html`<div class=${cx('ring', over && 'over')} style=${{ width: `${size}px`, height: `${size}px` }}>
    <svg width=${size} height=${size} aria-hidden="true">
      <circle class="ring-track" ...${circle} />
      <circle
        class="ring-fill"
        ...${circle}
        stroke-linecap="round"
        stroke-dasharray=${circumference}
        stroke-dashoffset=${circumference * (1 - fraction)}
      />
    </svg>
    <div class="ring-center">${children}</div>
  </div>`;
}

/** One macro against its daily target. `kind` is protein | carbs | fat. */
export function Meter({ kind, label, value, target }) {
  const percent = target > 0 ? clamp((value / target) * 100, 0, 100) : 0;
  return html`<div class=${cx('meter', kind)}>
    <div class="meter-top">
      <span class="meter-name"><i />${label}</span>
    </div>
    <div class="meter-bar"><i style=${{ width: `${percent}%` }} /></div>
    <div class="meter-val" style=${{ marginTop: '7px' }}>${Math.round(value)}<span> / ${Math.round(target)} g</span></div>
  </div>`;
}

export function MacroPills({ protein, carbs, fat }) {
  return html`<div class="macro-pills">
    <span class="macro-pill protein"><i />${Math.round(protein)} g <span>protein</span></span>
    <span class="macro-pill carbs"><i />${Math.round(carbs)} g <span>carbs</span></span>
    <span class="macro-pill fat"><i />${Math.round(fat)} g <span>fat</span></span>
  </div>`;
}

export function Empty({ icon, title, text, children }) {
  return html`<div class="empty">
    ${icon && html`<div class="empty-icon"><${Icon} name=${icon} size="26" /></div>`}
    ${title && html`<div class="empty-title">${title}</div>`}
    ${text && html`<div class="sub">${text}</div>`}
    ${children}
  </div>`;
}

export function Spinner({ small }) {
  return html`<div class=${cx('spinner', small && 'sm')} role="progressbar" aria-label="Loading" />`;
}

/** A row in a settings-style list. Renders a button when onClick is given. */
export function Row({ icon, title, sub, value, onClick, right, chevron = Boolean(onClick), danger }) {
  const Tag = onClick ? 'button' : 'div';
  return html`<${Tag} class=${cx('row', icon && 'has-icon')} onClick=${onClick} type=${onClick ? 'button' : undefined}>
    ${icon && html`<span class="row-icon"><${Icon} name=${icon} size="18" /></span>`}
    <span class="grow">
      <span class=${cx('ellipsis', danger && 'btn-danger')} style=${{ display: 'block' }}>${title}</span>
      ${sub && html`<span class="small muted" style=${{ display: 'block' }}>${sub}</span>`}
    </span>
    ${value !== undefined && value !== null && html`<span class="row-value">${value}</span>`}
    ${right}
    ${chevron && html`<${Icon} name="right" size="18" class="chev" />`}
  <//>`;
}
