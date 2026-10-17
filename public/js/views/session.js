// Training mode: warm-up -> one exercise at a time with a rest timer -> summary.
import { chime, keepAwake, unlockAudio } from '../audio.js';
import { getExercise, isBodyweight } from '../exercises.js';
import { ExercisePhoto, ExerciseThumb, formatRest, lastTimeText, loadText, repRange, setsText, usesBodyweight } from '../exui.js';
import { html, useEffect, useRef, useState } from '../lib.js';
import * as S from '../session.js';
import { closeOverlay, closeOverlayThen, openOverlay, replaceOverlay, toast, useStore } from '../store.js';
import { Icon, Ring, Sheet, Stepper, confirmDialog, cx, registerOverlay, useClosing, useNow } from '../ui.js';
import { clamp, fmtClock, fmtDuration, fmtInt, haptic, plural } from '../util.js';

function TopBar({ session, title, sub, right }) {
  const now = useNow(1000);
  return html`<header class="session-top">
    <button class="icon-btn" onClick=${() => closeOverlay()} aria-label="Minimise workout"><${Icon} name="down" /></button>
    <div class="mid">
      <b class="ellipsis">${title || session.name}</b>
      <span class="num">${sub || fmtClock((now - session.startedAt) / 1000)}</span>
    </div>
    <div class="end">${right}</div>
  </header>`;
}

// ---- warm-up -----------------------------------------------------------------------------

function Warmup({ session }) {
  const warm = session.warm;
  const move = warm.moves[warm.i];
  const running = Boolean(warm.endsAt);
  const paused = warm.left !== null && warm.left !== undefined;
  const begun = running || paused || warm.i > 0;
  const isLast = warm.i === warm.moves.length - 1;
  const now = useNow(200, running);
  // Short screens (iPhone SE) get a smaller timer so the whole move fits without scrolling.
  const compact = window.innerHeight < 720;
  const totalMs = move.sec * 1000;
  const leftMs = running ? Math.max(0, warm.endsAt - now) : paused ? warm.left : totalMs;

  useEffect(() => {
    if (!running || now < warm.endsAt) return;
    chime(isLast ? 'done' : 'tick');
    haptic();
    S.warmNext();
  }, [now, warm.endsAt]);

  return html`
    <${TopBar}
      session=${session}
      title="Warm-up"
      sub=${`${warm.i + 1} of ${warm.moves.length}`}
      right=${html`<button class="btn btn-quiet" onClick=${S.warmSkip}>Skip</button>`}
    />
    <div class="dots">${warm.moves.map((_, i) => html`<i class=${cx(i === warm.i && 'on', i < warm.i && 'past')} />`)}</div>
    <div class="warm">
      <${ExercisePhoto} ex=${getExercise(move.exId)} />
      <h2 class="h2" style=${{ marginTop: '18px' }}>${move.name}</h2>
      <p class="sub soft" style=${{ marginTop: '6px' }}>${move.cue}</p>
      <div class="warm-timer">
        <${Ring} size=${compact ? 128 : 168} stroke=${compact ? 10 : 12} value=${leftMs} max=${totalMs}>
          <div class="hero-num num" style=${{ fontSize: compact ? '40px' : '50px' }}>${Math.ceil(leftMs / 1000)}</div>
          <div class="small muted strong">seconds</div>
        <//>
      </div>
    </div>
    <div class="warm-foot">
      ${!begun
        ? html`<button
            class="btn btn-primary btn-lg"
            style=${{ gridColumn: '1 / -1' }}
            onClick=${() => {
              unlockAudio();
              S.warmStart();
            }}
          >
            <${Icon} name="play" size="20" /> Start warm-up
          </button>`
        : html`
            <button class="btn btn-secondary btn-lg" onClick=${running ? S.warmPause : S.warmResume}>
              <${Icon} name=${running ? 'pause' : 'play'} size="20" /> ${running ? 'Pause' : 'Resume'}
            </button>
            <button class="btn btn-primary btn-lg" onClick=${S.warmNext}>
              ${isLast ? 'Start lifting' : 'Next'} <${Icon} name="forward" size="20" />
            </button>
          `}
    </div>
  `;
}

// ---- rest timer --------------------------------------------------------------------------

function RestBar({ rest }) {
  const now = useNow(200);
  const leftMs = rest.endsAt - now;
  const over = leftMs <= 0;
  const announced = useRef(null);

  useEffect(() => {
    if (!over || announced.current === rest.endsAt) return undefined;
    announced.current = rest.endsAt;
    // Coming back to the app long after the timer ended should not ring.
    if (Date.now() - rest.endsAt < 3000) {
      chime('done');
      haptic();
    }
    const timer = setTimeout(S.clearRest, 12000);
    return () => clearTimeout(timer);
  }, [over, rest.endsAt]);

  if (over) {
    return html`<div class="rest-bar over" role="status">
      <${Icon} name="zap" size="20" />
      <span class="grow strong">Rest over. Go!</span>
      <button onClick=${S.clearRest}>OK</button>
    </div>`;
  }
  const percent = clamp(1 - leftMs / rest.total, 0, 1) * 100;
  return html`<div class="rest-bar" role="timer" aria-label="Rest timer">
    <i class="fill" style=${{ width: `${percent}%` }} />
    <span class="lbl">Rest</span>
    <span class="time num grow">${fmtClock(Math.ceil(leftMs / 1000))}</span>
    <button onClick=${() => S.adjustRest(-15)} aria-label="15 seconds less">−15</button>
    <button onClick=${() => S.adjustRest(15)} aria-label="15 seconds more">+15</button>
    <button onClick=${S.clearRest}>Skip</button>
  </div>`;
}

// ---- finishing ---------------------------------------------------------------------------

async function finish(session) {
  const { setsDone, setsPlanned } = S.sessionProgress(session);
  if (setsDone === 0) {
    const end = await confirmDialog({
      title: 'Nothing logged yet',
      message: 'End this workout without saving it?',
      confirm: 'End workout',
      danger: true,
    });
    if (end) closeOverlayThen(S.discardSession);
    return;
  }
  if (setsDone < setsPlanned) {
    const yes = await confirmDialog({
      title: 'Finish workout?',
      message: `You've logged ${setsDone} of ${setsPlanned} planned sets.`,
      confirm: 'Finish',
      cancel: 'Keep going',
    });
    if (!yes) return;
  }
  haptic();
  S.finishSession();
}

async function discard() {
  const yes = await confirmDialog({
    title: 'Discard this workout?',
    message: 'The sets you logged will not be saved.',
    confirm: 'Discard',
    danger: true,
  });
  if (yes) closeOverlayThen(S.discardSession);
}

// ---- one exercise ------------------------------------------------------------------------

function ExerciseView({ session, s }) {
  const index = session.cur;
  const ex = session.exercises[index];
  const info = getExercise(ex.exId);
  const bodyweight = isBodyweight(info);
  const unit = session.unit;
  const draft = ex.draft || S.suggestSet(ex, unit);
  const [extra, setExtra] = useState(false); // logging a set beyond the planned number
  const [justLogged, setJustLogged] = useState(-1);
  const scroller = useRef(null);

  useEffect(() => {
    setExtra(false);
    setJustLogged(-1);
    scroller.current?.scrollTo(0, 0);
  }, [index, ex.exId]);

  const planned = ex.sets.length >= ex.targetSets;
  const logging = !planned || extra;
  const nextIndex = S.nextOpenIndex(session);
  const step = s.profile?.weightStep || (unit === 'lb' ? 5 : 2.5);
  const last = lastTimeText(s.stats, ex.exId, unit);
  const rows = Math.max(ex.targetSets, ex.sets.length + (logging ? 1 : 0));

  const log = () => {
    unlockAudio();
    const position = ex.sets.length;
    const { record } = S.logSet();
    haptic();
    setJustLogged(position);
    setExtra(false);
    if (record) toast('New personal best', 'good');
  };

  return html`
    <${TopBar}
      session=${session}
      right=${html`<button class="icon-btn" onClick=${S.showList} aria-label="All exercises"><${Icon} name="list" /></button>`}
    />
    <div class="progress-line" aria-hidden="true">
      ${session.exercises.map(
        (item, i) => html`<i class=${cx((item.skipped || item.sets.length >= item.targetSets) && 'done', i === index && 'now')} />`,
      )}
    </div>

    <div class="session-scroll" ref=${scroller}>
      <div class="ex-compact">
        <button class="ex-photo-btn" onClick=${() => openOverlay('exercise', { exId: ex.exId })} aria-label="How to do this exercise">
          <${ExercisePhoto} ex=${info} tag=${false} />
        </button>
        <div class="grow">
          <div class="eyebrow">Exercise ${index + 1} of ${session.exercises.length}</div>
          <h2 class="h3">${ex.name}</h2>
          <div class="target-line">
            <span class="badge">${plural(ex.targetSets, 'set')}</span>
            <span class="badge">${repRange(ex)} reps</span>
            <span class="badge"><${Icon} name="timer" size="12" stroke="2.4" />${formatRest(ex.restSec)}</span>
          </div>
        </div>
        <button class="icon-btn" style=${{ alignSelf: 'flex-start' }} onClick=${() => openOverlay('exerciseMenu', { exIndex: index })} aria-label="Exercise options">
          <${Icon} name="more" />
        </button>
      </div>

      ${last && html`<div class="last-time"><${Icon} name="history" size="15" /><span>Last time: <b>${last}</b></span></div>`}

      <div class="set-list">
        ${Array.from({ length: rows }, (_, i) => {
          const set = ex.sets[i];
          if (set) {
            return html`<button
              class=${cx('set-row done', i === justLogged && 'just-done')}
              onClick=${() => openOverlay('setEdit', { exIndex: index, setIndex: i })}
              aria-label=${`Set ${i + 1}: ${loadText(set.w, unit, bodyweight)} for ${set.r} reps. Tap to edit`}
            >
              <span class="n"><${Icon} name="check" size="16" stroke="3" /></span>
              <span class="val num">${loadText(set.w, unit, bodyweight)}<span>×</span>${set.r}</span>
              ${set.pr ? html`<span class="pr-chip"><${Icon} name="trophy" size="11" stroke="2.6" />BEST</span>` : html`<${Icon} name="pencil" size="16" class="muted" />`}
            </button>`;
          }
          if (i === ex.sets.length && logging) {
            return html`<div class="set-row current">
              <span class="n">${i + 1}</span>
              <span class="val">Set ${i + 1}</span>
              <span class="hint">${repRange(ex)} reps</span>
            </div>`;
          }
          return html`<div class="set-row todo"><span class="n">${i + 1}</span><span>${repRange(ex)} reps</span><span /></div>`;
        })}
      </div>
    </div>

    <div class="session-dock">
      ${session.rest && html`<${RestBar} rest=${session.rest} />`}
      ${logging
        ? html`
            <div class="dock-steppers">
              <${Stepper}
                label=${bodyweight ? 'Added weight' : 'Weight'}
                unit=${unit}
                value=${draft.w}
                step=${step}
                max=${2000}
                onChange=${(w) => S.setDraft({ w })}
              />
              <${Stepper} label="Reps" value=${draft.r} step=${1} max=${500} places=${0} onChange=${(r) => S.setDraft({ r })} />
            </div>
            <button class="btn btn-primary btn-lg btn-block" onClick=${log}>
              <${Icon} name="check" size="22" stroke="2.6" /> Log set ${ex.sets.length + 1}
            </button>
          `
        : html`<div class="dock-done">
            ${nextIndex === -1
              ? html`<button class="btn btn-primary btn-lg btn-block" onClick=${() => finish(session)}>Finish workout</button>`
              : html`<button class="btn btn-primary btn-lg btn-block" onClick=${S.goNext}>
                  <span class="ellipsis">Next: ${session.exercises[nextIndex].name}</span>
                  <${Icon} name="forward" size="20" />
                </button>`}
            <button class="btn btn-quiet btn-block" onClick=${() => setExtra(true)}><${Icon} name="plus" size="18" /> Add another set</button>
          </div>`}
    </div>
  `;
}

// ---- all exercises -----------------------------------------------------------------------

function ListView({ session }) {
  const { setsDone, setsPlanned } = S.sessionProgress(session);
  return html`
    <${TopBar} session=${session} />
    <div class="session-scroll">
      <div class="row-between" style=${{ marginBottom: '14px' }}>
        <h2 class="h2">Exercises</h2>
        <span class="badge num">${setsDone} of ${setsPlanned} sets</span>
      </div>
      <div class="list">
        ${session.exercises.map((ex, i) => {
          const done = ex.sets.length >= ex.targetSets;
          const status = ex.skipped
            ? 'Skipped'
            : done
              ? `Done · ${plural(ex.sets.length, 'set')}`
              : ex.sets.length
                ? `${ex.sets.length} of ${ex.targetSets} sets`
                : `${ex.targetSets} × ${repRange(ex)}`;
          return html`<button class="ex-row" onClick=${() => S.openExercise(i)} style=${ex.skipped ? { opacity: 0.55 } : null}>
            <${ExerciseThumb} exId=${ex.exId} />
            <span class="grow">
              <span class="name" style=${{ display: 'block' }}>${ex.name}</span>
              <span class="small muted num" style=${{ display: 'block', marginTop: '2px' }}>${status}</span>
            </span>
            ${done && !ex.skipped
              ? html`<span class="item-check" style=${{ background: 'var(--good)', color: '#fff' }}><${Icon} name="check" size="14" stroke="3" /></span>`
              : html`<${Icon} name="right" size="18" class="muted" />`}
          </button>`;
        })}
      </div>
      <button
        class="btn btn-quiet btn-block"
        style=${{ marginTop: '8px' }}
        onClick=${() => openOverlay('library', { pick: 'multi', title: 'Add exercises', onPick: (ids) => S.addExercises(ids) })}
      >
        <${Icon} name="plus" size="18" /> Add exercise
      </button>
    </div>
    <div class="session-dock">
      ${session.rest && html`<${RestBar} rest=${session.rest} />`}
      <div class="dock-done">
        <button class="btn btn-primary btn-lg btn-block" onClick=${() => finish(session)}>Finish workout</button>
        <button class="btn btn-quiet btn-danger btn-block" onClick=${discard}>Discard workout</button>
      </div>
    </div>
  `;
}

// ---- summary -----------------------------------------------------------------------------

function Summary({ session }) {
  const summary = session.summary;
  const unit = session.unit;
  const done = () => closeOverlayThen(S.discardSession);
  return html`
    <div class="session-scroll" style=${{ paddingTop: 'calc(var(--safe-top) + 20px)' }}>
      <div class="summary-hero">
        <div class="big-check"><${Icon} name="check" size="38" stroke="3" /></div>
        <h1 class="h1">Workout complete</h1>
        <p class="sub muted">${session.name}</p>
      </div>
      <div class="tiles">
        <div class="tile"><div class="v">${fmtDuration(summary.seconds)}</div><div class="k">Time</div></div>
        <div class="tile"><div class="v">${summary.sets}</div><div class="k">Sets</div></div>
        <div class="tile"><div class="v">${fmtInt(summary.volume)}</div><div class="k">Volume, ${unit}</div></div>
      </div>

      ${summary.records.length > 0 &&
      html`<div class="section-title" style=${{ margin: '22px 0 8px' }}>Personal bests</div>
        <div class="list">
          ${summary.records.map(
            (record) =>
              html`<div class="row has-icon">
                <span class="row-icon" style=${{ background: 'var(--good-soft)', color: 'var(--good)' }}><${Icon} name="trophy" size="18" /></span>
                <span class="grow"><span class="strong ellipsis" style=${{ display: 'block' }}>${record.name}</span></span>
                <span class="row-value num" style=${{ color: 'var(--ink)' }}>${loadText(record.w, unit, usesBodyweight(record.exId))} × ${record.r}</span>
              </div>`,
          )}
        </div>`}

      <div class="section-title" style=${{ margin: '22px 0 8px' }}>What you did</div>
      <div class="list">
        ${session.exercises
          .filter((ex) => ex.sets.length > 0)
          .map(
            (ex) =>
              html`<div class="row">
                <span class="grow">
                  <span class="strong ellipsis" style=${{ display: 'block' }}>${ex.name}</span>
                  <span class="small muted num" style=${{ display: 'block' }}>
                    ${setsText(ex.sets.map((set) => [set.w, set.r]), unit, usesBodyweight(ex.exId))}
                  </span>
                </span>
              </div>`,
          )}
      </div>
    </div>
    <div class="screen-foot"><button class="btn btn-primary btn-lg btn-block" onClick=${done}>Done</button></div>
  `;
}

// ---- the screen and its sheets -----------------------------------------------------------

function SessionScreen() {
  const s = useStore();
  const closing = useClosing();
  // Keep showing the last state while the screen slides away after the workout is cleared.
  const lastSeen = useRef(s.session);
  if (s.session) lastSeen.current = s.session;
  const session = s.session || lastSeen.current;

  useEffect(() => {
    keepAwake(true);
    return () => keepAwake(false);
  }, []);
  useEffect(() => {
    if (!s.session && !closing) closeOverlay();
  }, [Boolean(s.session)]);

  if (!session) return html`<div class=${cx('session', closing && 'closing')} />`;
  const view =
    session.phase === 'warmup'
      ? html`<${Warmup} session=${session} />`
      : session.phase === 'summary'
        ? html`<${Summary} session=${session} />`
        : session.view === 'list' || !session.exercises.length
          ? html`<${ListView} session=${session} />`
          : html`<${ExerciseView} session=${session} s=${s} />`;
  return html`<div class=${cx('session', closing && 'closing')} role="dialog" aria-label="Workout">${view}</div>`;
}

function SetEditSheet({ exIndex, setIndex }) {
  const s = useStore();
  const session = s.session;
  const ex = session?.exercises[exIndex];
  const set = ex?.sets[setIndex];
  const [w, setW] = useState(set?.w || 0);
  const [r, setR] = useState(set?.r || 0);
  const unit = session?.unit || 'kg';
  const step = s.profile?.weightStep || (unit === 'lb' ? 5 : 2.5);

  const foot = html`<button
    class="btn btn-primary btn-lg btn-block"
    onClick=${() => {
      S.updateSet(exIndex, setIndex, { w, r });
      closeOverlay();
    }}
  >
    Save
  </button>`;
  return html`<${Sheet} title=${`Set ${setIndex + 1}`} foot=${foot}>
    <div class="dock-steppers">
      <${Stepper} label="Weight" unit=${unit} value=${w} step=${step} max=${2000} onChange=${setW} />
      <${Stepper} label="Reps" value=${r} step=${1} max=${500} places=${0} onChange=${setR} />
    </div>
    <button
      class="btn btn-quiet btn-danger btn-block"
      onClick=${() => {
        S.removeSet(exIndex, setIndex);
        closeOverlay();
      }}
    >
      <${Icon} name="trash" size="18" /> Delete this set
    </button>
  <//>`;
}

function ExerciseMenuSheet({ exIndex }) {
  const s = useStore();
  const ex = s.session?.exercises[exIndex];
  if (!ex) return html`<${Sheet} title="Options" />`;

  const swap = async () => {
    if (ex.sets.length) {
      const yes = await confirmDialog({
        title: 'Swap this exercise?',
        message: 'The sets you already logged for it will be removed.',
        confirm: 'Swap',
        danger: true,
      });
      if (!yes) return;
    }
    const muscle = getExercise(ex.exId)?.pm?.[0];
    replaceOverlay('library', { pick: 'single', title: 'Swap exercise', muscle, onPick: ([id]) => S.replaceExercise(exIndex, id) });
  };

  const skip = () => {
    const skipping = !ex.skipped;
    S.toggleSkip(exIndex);
    closeOverlay();
    if (skipping && s.session.cur === exIndex) S.goNext();
  };

  const remove = async () => {
    const yes = await confirmDialog({ title: 'Remove from this workout?', message: ex.name, confirm: 'Remove', danger: true });
    if (!yes) return;
    S.removeExercise(exIndex);
    closeOverlay();
  };

  return html`<${Sheet} title=${ex.name}>
    <div class="stack">
      <div class="list" style=${{ background: 'var(--surface-2)' }}>
        <button class="row has-icon" onClick=${() => replaceOverlay('exercise', { exId: ex.exId })}>
          <span class="row-icon" style=${{ background: 'var(--surface)' }}><${Icon} name="info" size="18" /></span>
          <span class="grow">How to do it</span>
          <${Icon} name="right" size="18" class="chev" />
        </button>
        <button class="row has-icon" onClick=${swap}>
          <span class="row-icon" style=${{ background: 'var(--surface)' }}><${Icon} name="swap" size="18" /></span>
          <span class="grow">Swap for another exercise</span>
          <${Icon} name="right" size="18" class="chev" />
        </button>
        <button class="row has-icon" onClick=${skip}>
          <span class="row-icon" style=${{ background: 'var(--surface)' }}><${Icon} name=${ex.skipped ? 'undo' : 'skip'} size="18" /></span>
          <span class="grow">${ex.skipped ? 'Bring it back' : 'Skip it today'}</span>
        </button>
      </div>
      <${Stepper}
        label="Rest between sets"
        unit="seconds"
        value=${ex.restSec}
        step=${15}
        max=${600}
        places=${0}
        compact
        onChange=${(seconds) => S.setRestLength(exIndex, seconds)}
      />
      <button class="btn btn-quiet btn-danger btn-block" onClick=${remove}><${Icon} name="trash" size="18" /> Remove from this workout</button>
    </div>
  <//>`;
}

registerOverlay('session', SessionScreen);
registerOverlay('setEdit', SetEditSheet);
registerOverlay('exerciseMenu', ExerciseMenuSheet);
