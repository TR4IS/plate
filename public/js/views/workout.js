// The Workout tab: this week at a glance, the selected day's workout, and the Start button.
import { unlockAudio } from '../audio.js';
import { focusOf, getExercise, routineById, useExercises } from '../exercises.js';
import { ExerciseThumb, lastTimeText, repRange } from '../exui.js';
import { html, useState } from '../lib.js';
import { startSession } from '../session.js';
import { openOverlay, replaceOverlay, useStore } from '../store.js';
import { Empty, Icon, Sheet, cx, registerOverlay } from '../ui.js';
import { WEEKDAYS, WEEKDAYS_SHORT, addDays, mondayOf, plural, weekdayIndex, weightUnit } from '../util.js';

/** Rough length of a workout: time under the bar plus the planned rests, plus the warm-up. */
function estimateMinutes(routine, warmup) {
  const seconds = routine.exercises.reduce((total, item) => total + item.sets * (45 + (item.restSec || 90)), 0);
  return Math.max(10, Math.round((seconds / 60 + (warmup ? 4 : 0)) / 5) * 5);
}

/** Start (or return to) a workout. `open` is how the session screen should appear. */
function begin(routine, session, open = openOverlay) {
  unlockAudio();
  if (!session) startSession(routine);
  open('session');
}

function RoutineCard({ s, routine, label }) {
  const unit = weightUnit(s.profile);
  const focus = focusOf(routine.exercises.map((item) => item.exId));
  const running = s.session;
  const otherRunning = running && running.routineId !== routine.id;
  return html`
    <section class="card">
      <div class="eyebrow">${label}</div>
      <h2 class="h2">${routine.name}</h2>
      ${focus.length > 0 && html`<p class="sub soft" style=${{ marginTop: '6px' }}>${focus.join(' · ')}</p>`}
      <p class="sub muted" style=${{ marginTop: '2px' }}>
        ${plural(routine.exercises.length, 'exercise')} · about ${estimateMinutes(routine, s.profile?.warmup !== false)} min
      </p>
      <button
        class="btn btn-primary btn-lg btn-block"
        style=${{ marginTop: '18px' }}
        disabled=${routine.exercises.length === 0}
        onClick=${() => begin(routine, running)}
      >
        <${Icon} name="play" size="20" />
        ${running ? (otherRunning ? `Resume ${running.name}` : 'Resume workout') : 'Start training'}
      </button>
    </section>

    ${routine.exercises.length === 0
      ? html`<div class="card"><${Empty} icon="dumbbell" title="No exercises yet" text="Add some to this workout to get started." /></div>`
      : html`<div class="list">
          ${routine.exercises.map((item) => {
            const ex = getExercise(item.exId);
            const last = lastTimeText(s.stats, item.exId, unit);
            return html`<button class="ex-row" onClick=${() => openOverlay('exercise', { exId: item.exId })}>
              <${ExerciseThumb} exId=${item.exId} />
              <span class="grow">
                <span class="name" style=${{ display: 'block' }}>${ex?.name || item.exId.replaceAll('_', ' ')}</span>
                <span class="small muted num" style=${{ display: 'block', marginTop: '2px' }}>
                  ${item.sets} × ${repRange(item)}${last ? ` · last ${last}` : ''}
                </span>
              </span>
              <${Icon} name="right" size="18" class="muted" />
            </button>`;
          })}
        </div>`}

    <button class="btn btn-quiet btn-block" onClick=${() => openOverlay('routine', { routineId: routine.id })}>
      <${Icon} name="pencil" size="18" /> Edit this workout
    </button>
  `;
}

function RestDay({ s }) {
  return html`<section class="card">
    <${Empty} icon="bed" title="Rest day" text="Recovery is part of the plan.">
      ${s.plan.routines.length > 0 &&
      html`<button class="btn btn-secondary" style=${{ marginTop: '14px' }} onClick=${() => openOverlay('pickWorkout')}>Train anyway</button>`}
    <//>
  </section>`;
}

/** Choose any workout from the plan to do right now (used on rest days). */
function PickWorkoutSheet() {
  const s = useStore();
  return html`<${Sheet} title="Which workout?">
    <div class="list" style=${{ background: 'var(--surface-2)' }}>
      ${(s.plan?.routines || []).map(
        (routine) =>
          html`<button class="row" onClick=${() => begin(routine, s.session, replaceOverlay)}>
            <span class="grow">
              <span class="strong" style=${{ display: 'block' }}>${routine.name}</span>
              <span class="small muted" style=${{ display: 'block' }}>${plural(routine.exercises.length, 'exercise')}</span>
            </span>
            <${Icon} name="play" size="18" class="muted" />
          </button>`,
      )}
    </div>
  <//>`;
}

export function WorkoutTab() {
  const s = useStore();
  useExercises();
  const todayIndex = weekdayIndex(s.today);
  const [selected, setSelected] = useState(todayIndex);
  const plan = s.plan;
  const hasPlan = plan?.routines?.length > 0;

  const monday = mondayOf(s.today);
  const sunday = addDays(monday, 6);
  const doneDays = new Set(s.workouts.filter((w) => w.day >= monday && w.day <= sunday).map((w) => weekdayIndex(w.day)));
  const routine = hasPlan ? routineById(plan, plan.schedule?.[selected]) : null;
  const label = selected === todayIndex ? 'Today' : WEEKDAYS[selected];

  return html`<div class="page">
    <header class="page-head">
      <div>
        <div class="eyebrow">${hasPlan ? `${doneDays.size} of ${plan.schedule.filter(Boolean).length} done this week` : 'Training'}</div>
        <h1 class="h1">Workout</h1>
      </div>
      ${hasPlan &&
      html`<button class="icon-btn filled" style=${{ background: 'var(--surface)', marginBottom: '2px' }} onClick=${() => openOverlay('plan')} aria-label="Edit plan">
        <${Icon} name="calendar" size="20" />
      </button>`}
    </header>

    ${!hasPlan
      ? html`<div class="stack">
          <section class="card">
            <${Empty} icon="dumbbell" title="Build your training plan" text="Pick a ready-made plan, then change anything you like. It stays until you edit it.">
              <button class="btn btn-primary btn-block" style=${{ marginTop: '16px' }} onClick=${() => openOverlay('templates')}>Choose a plan</button>
              <button class="btn btn-quiet" onClick=${() => openOverlay('plan')}>Start from scratch</button>
            <//>
          </section>
        </div>`
      : html`<div class="stack">
          <div class="week" role="group" aria-label="Days of the week">
            ${WEEKDAYS_SHORT.map((name, i) => {
              const day = routineById(plan, plan.schedule?.[i]);
              const done = doneDays.has(i);
              return html`<button
                class=${cx(i === todayIndex && 'today', done && 'done', !day && 'rest')}
                aria-pressed=${String(i === selected)}
                aria-label=${`${WEEKDAYS[i]}: ${day ? day.name : 'rest'}${done ? ', done' : ''}`}
                onClick=${() => setSelected(i)}
              >
                <span>${name}</span>
                <span class="dot">${done ? html`<${Icon} name="check" size="15" stroke="3" />` : day ? day.name[0] : '–'}</span>
              </button>`;
            })}
          </div>
          ${routine ? html`<${RoutineCard} s=${s} routine=${routine} label=${label} />` : html`<${RestDay} s=${s} />`}
          <button class="mini-card" onClick=${() => openOverlay('library')}>
            <span class="row-icon"><${Icon} name="book" size="18" /></span>
            <span class="grow">
              <span class="strong" style=${{ display: 'block' }}>Exercise library</span>
              <span class="small muted" style=${{ display: 'block' }}>Photos and how-to for 870+ exercises</span>
            </span>
            <${Icon} name="right" size="18" class="muted" />
          </button>
        </div>`}
  </div>`;
}

registerOverlay('pickWorkout', PickWorkoutSheet);
