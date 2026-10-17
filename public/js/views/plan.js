// Editing the training plan: which workout falls on which day, and what each workout contains.
import { TEMPLATES, defaultRest, emptyPlan, exerciseName, getExercise, planFromTemplate, routineById, templateLetters, useExercises } from '../exercises.js';
import { ExerciseThumb, formatRest, repRange } from '../exui.js';
import { html, useState } from '../lib.js';
import { closeOverlay, openOverlay, replaceOverlay, savePlan, useStore } from '../store.js';
import { Empty, Field, Icon, Row, Screen, Sheet, Stepper, confirmDialog, registerOverlay } from '../ui.js';
import { WEEKDAYS, plural, uid } from '../util.js';
import { WeekDots } from './onboarding.js';

const currentPlan = (s) => s.plan || emptyPlan();

function updateRoutine(plan, routineId, change) {
  return { ...plan, routines: plan.routines.map((routine) => (routine.id === routineId ? change(routine) : routine)) };
}

// ---- templates ---------------------------------------------------------------------------

function TemplatesScreen() {
  const s = useStore();
  const choose = async (template) => {
    if (s.plan?.routines?.length) {
      const yes = await confirmDialog({
        title: 'Replace your plan?',
        message: 'Your current workouts and weekly schedule will be replaced. Your logged history stays.',
        confirm: 'Replace',
        danger: true,
      });
      if (!yes) return;
    }
    savePlan(planFromTemplate(template));
    closeOverlay();
  };
  return html`<${Screen} title="Choose a plan">
    <div class="stack">
      <p class="sub soft">Each plan comes filled with proven exercises. Change anything afterwards.</p>
      ${TEMPLATES.map(
        (template) =>
          html`<button class="template" onClick=${() => choose(template)}>
            <span class="h3" style=${{ display: 'block' }}>${template.name}</span>
            <span class="sub muted" style=${{ display: 'block', marginTop: '3px' }}>${template.blurb}</span>
            <${WeekDots} letters=${templateLetters(template)} />
          </button>`,
      )}
    </div>
  <//>`;
}

// ---- the week and the list of workouts ---------------------------------------------------

function PlanScreen() {
  const s = useStore();
  const plan = currentPlan(s);

  const addRoutine = () => {
    const routine = { id: uid('r'), name: `Workout ${plan.routines.length + 1}`, exercises: [] };
    savePlan({ ...plan, routines: [...plan.routines, routine] });
    openOverlay('routine', { routineId: routine.id });
  };

  return html`<${Screen} title="Training plan">
    <div class="stack">
      <div class="section-title" style=${{ marginTop: 0 }}>Your week</div>
      <div class="list">
        ${WEEKDAYS.map((day, i) => {
          const routine = routineById(plan, plan.schedule[i]);
          return html`<${Row} title=${day} value=${routine ? routine.name : 'Rest'} onClick=${() => openOverlay('pickDay', { dayIndex: i })} />`;
        })}
      </div>

      <div class="section-title">Workouts</div>
      ${plan.routines.length === 0
        ? html`<div class="card"><${Empty} icon="dumbbell" title="No workouts yet" text="Create one, or start from a ready-made plan." /></div>`
        : html`<div class="list">
            ${plan.routines.map(
              (routine) =>
                html`<${Row}
                  title=${routine.name}
                  sub=${plural(routine.exercises.length, 'exercise')}
                  onClick=${() => openOverlay('routine', { routineId: routine.id })}
                />`,
            )}
          </div>`}
      <button class="btn btn-secondary btn-block" style=${{ background: 'var(--surface)' }} onClick=${addRoutine}>
        <${Icon} name="plus" size="20" /> New workout
      </button>
      <button class="btn btn-quiet btn-block" onClick=${() => openOverlay('templates')}>Start over from a ready-made plan</button>
    </div>
  <//>`;
}

function PickDaySheet({ dayIndex }) {
  const s = useStore();
  const plan = currentPlan(s);
  const assign = (routineId) => {
    const schedule = [...plan.schedule];
    schedule[dayIndex] = routineId;
    savePlan({ ...plan, schedule });
    closeOverlay();
  };
  const current = plan.schedule[dayIndex];
  const tick = (on) => (on ? html`<${Icon} name="check" size="20" stroke="2.6" />` : null);
  return html`<${Sheet} title=${WEEKDAYS[dayIndex]}>
    <div class="list" style=${{ background: 'var(--surface-2)' }}>
      ${plan.routines.map(
        (routine) => html`<${Row} title=${routine.name} sub=${plural(routine.exercises.length, 'exercise')} onClick=${() => assign(routine.id)} chevron=${false} right=${tick(current === routine.id)} />`,
      )}
      <${Row} title="Rest day" onClick=${() => assign(null)} chevron=${false} right=${tick(!current)} />
    </div>
  <//>`;
}

// ---- one workout -------------------------------------------------------------------------

function RoutineScreen({ routineId }) {
  const s = useStore();
  useExercises();
  const plan = currentPlan(s);
  const routine = routineById(plan, routineId);
  if (!routine) return html`<${Screen} title="Workout" />`;

  const change = (mutate) => savePlan(updateRoutine(plan, routineId, mutate));

  const move = (index, direction) =>
    change((r) => {
      const exercises = [...r.exercises];
      const target = index + direction;
      [exercises[index], exercises[target]] = [exercises[target], exercises[index]];
      return { ...r, exercises };
    });

  const add = (ids) =>
    change((r) => ({
      ...r,
      exercises: [
        ...r.exercises,
        ...ids.map((exId) => ({ exId, sets: 3, repMin: 8, repMax: 12, restSec: defaultRest(getExercise(exId), s.profile?.restSec || 90) })),
      ],
    }));

  const removeRoutine = async () => {
    const yes = await confirmDialog({
      title: `Delete ${routine.name}?`,
      message: 'It will be removed from your week too. Workouts you already logged stay in your history.',
      confirm: 'Delete',
      danger: true,
    });
    if (!yes) return;
    closeOverlay();
    savePlan({
      routines: plan.routines.filter((r) => r.id !== routineId),
      schedule: plan.schedule.map((id) => (id === routineId ? null : id)),
    });
  };

  return html`<${Screen} title="Edit workout">
    <div class="stack">
      <${Field} label="Name">
        <input
          class="input"
          style=${{ background: 'var(--surface)' }}
          value=${routine.name}
          maxlength="40"
          onInput=${(event) => change((r) => ({ ...r, name: event.target.value }))}
          onBlur=${(event) => !event.target.value.trim() && change((r) => ({ ...r, name: 'Workout' }))}
        />
      <//>

      <div class="section-title">Exercises</div>
      ${routine.exercises.length === 0
        ? html`<div class="card"><${Empty} icon="dumbbell" title="Empty workout" text="Add the exercises you want to do, in order." /></div>`
        : html`<div class="list">
            ${routine.exercises.map(
              (item, i) =>
                html`<div class="edit-ex" key=${`${item.exId}-${i}`}>
                  <div class="order">
                    <button disabled=${i === 0} onClick=${() => move(i, -1)} aria-label="Move up"><${Icon} name="up" size="20" /></button>
                    <button disabled=${i === routine.exercises.length - 1} onClick=${() => move(i, 1)} aria-label="Move down">
                      <${Icon} name="down" size="20" />
                    </button>
                  </div>
                  <button class="ex-main" onClick=${() => openOverlay('planItem', { routineId, index: i })}>
                    <${ExerciseThumb} exId=${item.exId} />
                    <span class="grow">
                      <span class="name" style=${{ display: 'block' }}>${exerciseName(item.exId)}</span>
                      <span class="small muted num" style=${{ display: 'block', marginTop: '2px' }}>
                        ${item.sets} × ${repRange(item)} · rest ${formatRest(item.restSec)}
                      </span>
                    </span>
                    <${Icon} name="right" size="18" class="muted" />
                  </button>
                </div>`,
            )}
          </div>`}

      <button
        class="btn btn-secondary btn-block"
        style=${{ background: 'var(--surface)' }}
        onClick=${() => openOverlay('library', { pick: 'multi', title: 'Add exercises', onPick: add })}
      >
        <${Icon} name="plus" size="20" /> Add exercises
      </button>
      <button class="btn btn-quiet btn-danger btn-block" onClick=${removeRoutine}><${Icon} name="trash" size="18" /> Delete this workout</button>
    </div>
  <//>`;
}

/** Sets, rep range and rest for one exercise inside a workout. */
function PlanItemSheet({ routineId, index }) {
  const s = useStore();
  const plan = currentPlan(s);
  const routine = routineById(plan, routineId);
  const item = routine?.exercises[index];
  // Hold on to what was opened, so the sheet still renders while it closes after "Remove".
  const [opened] = useState(item);
  const shown = item || opened;
  if (!shown) return html`<${Sheet} title="Exercise" />`;

  const patch = (changes) =>
    savePlan(updateRoutine(plan, routineId, (r) => ({ ...r, exercises: r.exercises.map((entry, i) => (i === index ? { ...entry, ...changes } : entry)) })));

  const remove = () => {
    closeOverlay();
    savePlan(updateRoutine(plan, routineId, (r) => ({ ...r, exercises: r.exercises.filter((_, i) => i !== index) })));
  };

  return html`<${Sheet} title=${exerciseName(shown.exId)}>
    <div class="stack">
      <${Stepper} label="Sets" value=${shown.sets} min=${1} max=${12} places=${0} compact onChange=${(sets) => patch({ sets })} />
      <div style=${{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
        <${Stepper}
          label="Reps, from"
          value=${shown.repMin}
          min=${1}
          max=${100}
          places=${0}
          compact
          onChange=${(repMin) => patch({ repMin, repMax: Math.max(repMin, shown.repMax) })}
        />
        <${Stepper}
          label="Reps, to"
          value=${shown.repMax}
          min=${1}
          max=${100}
          places=${0}
          compact
          onChange=${(repMax) => patch({ repMax, repMin: Math.min(repMax, shown.repMin) })}
        />
      </div>
      <${Stepper} label="Rest between sets" unit="seconds" value=${shown.restSec} step=${15} max=${600} places=${0} compact onChange=${(restSec) => patch({ restSec })} />
      <div class="list" style=${{ background: 'var(--surface-2)' }}>
        <${Row} title="How to do it" onClick=${() => replaceOverlay('exercise', { exId: shown.exId })} />
      </div>
      <button class="btn btn-quiet btn-danger btn-block" onClick=${remove}><${Icon} name="trash" size="18" /> Remove from this workout</button>
    </div>
  <//>`;
}

registerOverlay('templates', TemplatesScreen);
registerOverlay('plan', PlanScreen);
registerOverlay('pickDay', PickDaySheet);
registerOverlay('routine', RoutineScreen);
registerOverlay('planItem', PlanItemSheet);
