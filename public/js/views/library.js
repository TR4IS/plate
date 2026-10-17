// Browsing and picking exercises, the how-to sheet for one exercise, and adding your own.
import { api } from '../api.js';
import {
  EQUIPMENT_LABEL,
  GROUPS,
  MUSCLE_LABEL,
  equipmentLabel,
  exerciseSubtitle,
  getExercise,
  isBodyweight,
  loadSteps,
  muscleLabel,
  searchExercises,
  useExercises,
} from '../exercises.js';
import { ExercisePhoto, ExerciseThumb, loadText, setsText } from '../exui.js';
import { html, useEffect, useMemo, useRef, useState } from '../lib.js';
import { closeOverlay, closeOverlayThen, openOverlay, saveCustom, toast, useStore } from '../store.js';
import { Empty, Field, Icon, Screen, Sheet, Spinner, confirmDialog, cx, registerOverlay } from '../ui.js';
import { fmtDay, kgToUnit, plural, uid, weightUnit } from '../util.js';

const PAGE = 40;

/**
 * pick: undefined (browse; a tap opens the how-to), 'single' (a tap chooses), 'multi' (tick several, then Add).
 * onPick receives the chosen exercise ids after this screen has closed.
 */
function LibraryScreen({ pick, title, onPick, muscle }) {
  const s = useStore();
  const ready = useExercises();
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState(() => GROUPS.find((g) => g.muscles?.includes(muscle))?.id || null);
  const [chosen, setChosen] = useState([]);
  const [limit, setLimit] = useState(PAGE);
  const sentinel = useRef(null);
  const body = useRef(null);

  const results = useMemo(() => (ready ? searchExercises({ query, group }) : []), [ready, query, group, s.custom]);

  useEffect(() => {
    setLimit(PAGE);
    body.current?.scrollTo(0, 0);
  }, [query, group]);

  // Render more rows as the end of the list scrolls into view.
  useEffect(() => {
    if (!sentinel.current || !('IntersectionObserver' in window)) return undefined;
    const observer = new IntersectionObserver((entries) => entries[0].isIntersecting && setLimit((n) => n + PAGE * 2), {
      root: body.current,
      rootMargin: '600px',
    });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [ready, results]);

  const tap = (ex) => {
    if (pick === 'single') closeOverlayThen(() => onPick([ex.id]));
    else if (pick === 'multi') setChosen((ids) => (ids.includes(ex.id) ? ids.filter((id) => id !== ex.id) : [...ids, ex.id]));
    else openOverlay('exercise', { exId: ex.id });
  };

  const foot =
    pick === 'multi' &&
    html`<button class="btn btn-primary btn-lg btn-block" disabled=${chosen.length === 0} onClick=${() => closeOverlayThen(() => onPick(chosen))}>
      ${chosen.length ? `Add ${plural(chosen.length, 'exercise')}` : 'Choose exercises'}
    </button>`;

  return html`<${Screen} title=${title || 'Exercises'} foot=${foot} bodyRef=${body}>
    <div class="picker-bar">
      <div class="search">
        <${Icon} name="search" size="20" />
        <input
          class="input"
          type="search"
          enterkeyhint="search"
          autocomplete="off"
          autocorrect="off"
          spellcheck="false"
          placeholder="Search 870+ exercises"
          aria-label="Search exercises"
          value=${query}
          onInput=${(event) => setQuery(event.target.value)}
        />
      </div>
      <div class="chips" role="group" aria-label="Filter by muscle">
        <button class="chip" aria-pressed=${String(group === null)} onClick=${() => setGroup(null)}>All</button>
        ${GROUPS.filter((g) => !g.custom || s.custom.length > 0).map(
          (g) => html`<button class="chip" aria-pressed=${String(group === g.id)} onClick=${() => setGroup(group === g.id ? null : g.id)}>${g.label}</button>`,
        )}
      </div>
    </div>

    ${!ready
      ? html`<div class="center" style=${{ display: 'grid', placeItems: 'center', minHeight: '200px' }}><${Spinner} /></div>`
      : results.length === 0
        ? html`<${Empty} icon="search" title="No exercises found" text="Try another word, or add it as your own." />`
        : html`<div class="list">
            ${results.slice(0, limit).map(
              (ex) =>
                html`<div class="ex-row" key=${ex.id}>
                  <button class="ex-main" onClick=${() => tap(ex)} aria-pressed=${pick === 'multi' ? String(chosen.includes(ex.id)) : undefined}>
                    <${ExerciseThumb} exId=${ex.id} />
                    <span class="grow">
                      <span class="name" style=${{ display: 'block' }}>${ex.name}</span>
                      <span class="small muted" style=${{ display: 'block', marginTop: '2px' }}>${exerciseSubtitle(ex)}</span>
                    </span>
                    ${pick === 'multi' && html`<span class=${cx('pick-check', chosen.includes(ex.id) && 'on')}><${Icon} name="check" size="15" stroke="3" /></span>`}
                    ${!pick && html`<${Icon} name="right" size="18" class="muted" />`}
                  </button>
                  ${pick &&
                  html`<button class="icon-btn" onClick=${() => openOverlay('exercise', { exId: ex.id })} aria-label=${`How to do ${ex.name}`}>
                    <${Icon} name="info" size="20" class="muted" />
                  </button>`}
                </div>`,
            )}
          </div>`}
    <div ref=${sentinel} style=${{ height: '1px' }} />

    <button class="btn btn-quiet btn-block" style=${{ marginTop: '10px' }} onClick=${() => openOverlay('customExercise', { name: query.trim() })}>
      <${Icon} name="plus" size="18" /> Add your own exercise
    </button>
  <//>`;
}

function ExerciseSheet({ exId }) {
  const s = useStore();
  useExercises();
  const ex = getExercise(exId);
  const unit = weightUnit(s.profile);
  const [steps, setSteps] = useState(null);
  const [sessions, setSessions] = useState(null);

  useEffect(() => {
    let alive = true;
    loadSteps(exId)
      .then((list) => alive && setSteps(list))
      .catch(() => alive && setSteps([]));
    api('GET', `/api/exercises/${encodeURIComponent(exId)}/history?limit=6`)
      .then((data) => alive && setSessions(data.sessions))
      .catch(() => alive && setSessions([]));
    return () => {
      alive = false;
    };
  }, [exId]);

  if (!ex) return html`<${Sheet} title="Exercise"><${Empty} icon="dumbbell" title="Loading…" /><//>`;

  const record = s.stats[exId];
  const remove = async () => {
    const yes = await confirmDialog({
      title: 'Delete this exercise?',
      message: 'It will be removed from your library. Workouts you already logged keep it.',
      confirm: 'Delete',
      danger: true,
    });
    if (!yes) return;
    saveCustom(s.custom.filter((item) => item.id !== exId));
    closeOverlay();
  };

  return html`<${Sheet} title=${ex.name}>
    <div class="stack">
      ${!ex.custom && html`<${ExercisePhoto} ex=${ex} />`}

      <div class="tags">
        ${(ex.pm || []).map((m) => html`<span class="badge">${muscleLabel(m)}</span>`)}
        <span class="badge">${equipmentLabel(ex)}</span>
        ${ex.lvl && html`<span class="badge" style=${{ textTransform: 'capitalize' }}>${ex.lvl}</span>`}
        ${ex.mech && html`<span class="badge" style=${{ textTransform: 'capitalize' }}>${ex.mech}</span>`}
      </div>
      ${ex.sm?.length > 0 && html`<p class="small muted">Also works ${ex.sm.map(muscleLabel).join(', ').toLowerCase()}.</p>`}

      ${record &&
      html`<div class="stat-pair">
        <div class="stat">
          <div class="k">${record.bestW > 0 ? 'Heaviest' : 'Most reps'}</div>
          <div class="v">${record.bestW > 0 ? loadText(Math.round(kgToUnit(record.bestW, unit) * 100) / 100, unit) : record.bestReps}</div>
        </div>
        <div class="stat">
          <div class="k">Times done</div>
          <div class="v">${record.n}</div>
        </div>
      </div>`}

      ${steps === null
        ? html`<div class="skeleton" style=${{ height: '120px' }} />`
        : steps.length > 0 &&
          html`<div>
            <div class="section-title" style=${{ margin: '4px 0 12px', padding: 0 }}>How to do it</div>
            <ol class="steps">${steps.map((step) => html`<li><span>${step}</span></li>`)}</ol>
          </div>`}

      ${sessions?.length > 0 &&
      html`<div>
        <div class="section-title" style=${{ margin: '4px 0 6px', padding: 0 }}>Your recent sessions</div>
        ${sessions.map(
          (session) =>
            html`<div class="item-row">
              <span class="grow soft">${fmtDay(session.day, s.today)}</span>
              <span class="num strong">
                ${setsText(session.sets.map(([kg, reps]) => [Math.round(kgToUnit(kg, unit) * 100) / 100, reps]), unit, isBodyweight(ex))}
              </span>
            </div>`,
        )}
      </div>`}

      ${ex.custom && html`<button class="btn btn-quiet btn-danger btn-block" onClick=${remove}><${Icon} name="trash" size="18" /> Delete this exercise</button>`}
    </div>
  <//>`;
}

const CUSTOM_MUSCLES = ['chest', 'lats', 'middle back', 'shoulders', 'biceps', 'triceps', 'quadriceps', 'hamstrings', 'glutes', 'calves', 'abdominals', 'forearms'];
const CUSTOM_EQUIPMENT = ['barbell', 'dumbbell', 'machine', 'cable', 'body only', 'kettlebells', 'bands', 'other'];

function CustomExerciseSheet({ name: startName = '' }) {
  const s = useStore();
  const [name, setName] = useState(startName);
  const [muscle, setMuscle] = useState('chest');
  const [equipment, setEquipment] = useState('machine');

  const save = () => {
    const exercise = { id: uid('c'), name: name.trim(), cat: 'strength', eq: equipment, pm: [muscle], sm: [], custom: true };
    saveCustom([...s.custom, exercise]);
    closeOverlay();
    toast('Added to your library', 'good');
  };

  const foot = html`<button class="btn btn-primary btn-lg btn-block" disabled=${name.trim().length < 2} onClick=${save}>Add exercise</button>`;
  return html`<${Sheet} title="Your own exercise" foot=${foot}>
    <div class="stack">
      <${Field} label="Name">
        <input class="input" placeholder="e.g. Hammer Strength Row" autocomplete="off" value=${name} onInput=${(event) => setName(event.target.value)} />
      <//>
      <${Field} label="Main muscle">
        <div class="chips">
          ${CUSTOM_MUSCLES.map((m) => html`<button class="chip" aria-pressed=${String(muscle === m)} onClick=${() => setMuscle(m)}>${MUSCLE_LABEL[m]}</button>`)}
        </div>
      <//>
      <${Field} label="Equipment">
        <div class="chips">
          ${CUSTOM_EQUIPMENT.map(
            (e) => html`<button class="chip" aria-pressed=${String(equipment === e)} onClick=${() => setEquipment(e)}>${EQUIPMENT_LABEL[e]}</button>`,
          )}
        </div>
      <//>
      <p class="small muted">${isBodyweight({ eq: equipment }) ? 'Weight you log for this exercise counts as extra load on top of your body.' : ''}</p>
    </div>
  <//>`;
}

registerOverlay('library', LibraryScreen);
registerOverlay('exercise', ExerciseSheet);
registerOverlay('customExercise', CustomExerciseSheet);
