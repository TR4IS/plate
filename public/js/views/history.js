// History: what you ate each day and every workout you finished.
import { api } from '../api.js';
import { loadText, usesBodyweight } from '../exui.js';
import { html, useEffect, useState } from '../lib.js';
import { targetsOf, totalsOf } from '../nutrition.js';
import { closeOverlay, deleteWorkout, loadMeals, loadMoreWorkouts, loadWorkout, openOverlay, toast, useStore } from '../store.js';
import { Empty, Icon, Screen, Segmented, Spinner, confirmDialog, cx, registerOverlay } from '../ui.js';
import { addDays, fmtDay, fmtDuration, fmtInt, kgToUnit, mondayOf, parseDay, plural, weightUnit } from '../util.js';
import { DaySummary, MealRow } from './today.js';

const PAGE = 45;
const LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
let rememberedSegment = 'food';

/** Days the phone has loaded are fresher than the server's summary (changes may still be on their way). */
function withLocalDays(serverDays, localMeals) {
  const byDay = new Map(serverDays.map((d) => [d.day, d]));
  for (const [day, meals] of Object.entries(localMeals)) {
    if (meals.length === 0) byDay.delete(day);
    else byDay.set(day, { day, ...totalsOf(meals), meals: meals.length });
  }
  return [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day));
}

/** Calories for each of the last seven days against the goal. Tap a bar to read that day. */
function WeekChart({ days, today, goal }) {
  const [selected, setSelected] = useState(today);
  const byDay = new Map(days.map((d) => [d.day, d]));
  const week = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6));
  const logged = week.filter((day) => byDay.has(day));
  const average = logged.length ? logged.reduce((total, day) => total + byDay.get(day).calories, 0) / logged.length : 0;
  const top = Math.max(goal * 1.18, ...week.map((day) => byDay.get(day)?.calories || 0));
  const shown = byDay.get(selected);

  return html`<section class="card">
    <div class="row-between" style=${{ alignItems: 'flex-start' }}>
      <div class="stat">
        <div class="k">${fmtDay(selected, today)}</div>
        <div class="v">${fmtInt(shown?.calories || 0)}<small>kcal</small></div>
        <div class="small muted num" style=${{ marginTop: '2px' }}>
          ${shown ? `P ${Math.round(shown.protein)} · C ${Math.round(shown.carbs)} · F ${Math.round(shown.fat)}` : 'Nothing logged'}
        </div>
      </div>
      <div class="stat" style=${{ textAlign: 'right' }}>
        <div class="k">7-day average</div>
        <div class="v" style=${{ fontSize: '20px' }}>${fmtInt(average)}<small>kcal</small></div>
      </div>
    </div>

    <div class="bars" role="group" aria-label="Calories over the last seven days">
      <div class="goal" style=${{ bottom: `${(goal / top) * 100}%` }}><span class="num">Goal ${fmtInt(goal)}</span></div>
      ${week.map((day) => {
        const calories = byDay.get(day)?.calories || 0;
        return html`<button
          class=${cx('bar-col', !calories && 'zero')}
          aria-pressed=${String(day === selected)}
          aria-label=${`${fmtDay(day, today)}: ${fmtInt(calories)} kcal`}
          onClick=${() => (day === selected && calories ? openOverlay('day', { day }) : setSelected(day))}
        >
          <span class="bar" style=${{ height: `${(calories / top) * 100}%` }} />
        </button>`;
      })}
    </div>
    <div class="bar-axis" aria-hidden="true">
      ${week.map((day) => html`<span class=${cx(day === selected && 'sel')}>${LETTERS[parseDay(day).getDay()]}</span>`)}
    </div>
  </section>`;
}

function FoodHistory({ s }) {
  const [serverDays, setServerDays] = useState(null);
  const [end, setEnd] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const synced = s.pending === 0;

  useEffect(() => {
    let alive = true;
    api('GET', `/api/days?limit=${PAGE}`)
      .then((data) => {
        if (!alive) return;
        setServerDays(data.days);
        setEnd(data.days.length < PAGE);
        setFailed(false);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [s.mealsRev, synced]);

  const more = async () => {
    setLoadingMore(true);
    try {
      const oldest = serverDays[serverDays.length - 1].day;
      const data = await api('GET', `/api/days?before=${oldest}&limit=${PAGE}`);
      setServerDays([...serverDays, ...data.days]);
      setEnd(data.days.length < PAGE);
    } catch {
      toast("Couldn't load more. Check your connection.", 'error');
    }
    setLoadingMore(false);
  };

  if (!serverDays && !failed) return html`<div class="center" style=${{ display: 'grid', placeItems: 'center', minHeight: '220px' }}><${Spinner} /></div>`;
  const days = withLocalDays(serverDays || [], s.meals);
  const targets = targetsOf(s.profile);

  return html`<div class="stack">
    <${WeekChart} days=${days} today=${s.today} goal=${targets.calories} />
    ${failed && html`<div class="note"><${Icon} name="offline" size="20" /><span>You're offline, so only recent days are shown.</span></div>`}
    ${days.length === 0
      ? html`<div class="card"><${Empty} icon="utensils" title="No meals yet" text="Meals you log will be listed here, day by day." /></div>`
      : html`<div class="list">
          ${days.map(
            (d) =>
              html`<button class="row day-row" key=${d.day} onClick=${() => openOverlay('day', { day: d.day })}>
                <span class="grow">
                  <span class="strong" style=${{ display: 'block' }}>${fmtDay(d.day, s.today)}</span>
                  <span class="small muted num" style=${{ display: 'block' }}>
                    ${plural(d.meals, 'meal')} · P ${Math.round(d.protein)} · C ${Math.round(d.carbs)} · F ${Math.round(d.fat)}
                  </span>
                </span>
                <span class="kcal num">${fmtInt(d.calories)} <span class="small muted">kcal</span></span>
                <${Icon} name="right" size="18" class="chev" />
              </button>`,
          )}
        </div>`}
    ${serverDays && !end && html`<button class="btn btn-quiet btn-block" onClick=${more} disabled=${loadingMore}>${loadingMore ? 'Loading…' : 'Show earlier days'}</button>`}
  </div>`;
}

function WorkoutHistory({ s }) {
  const unit = weightUnit(s.profile);
  const [loadingMore, setLoadingMore] = useState(false);
  const monday = mondayOf(s.today);
  const monthAgo = addDays(s.today, -29);
  const thisWeek = s.workouts.filter((w) => w.day >= monday).length;
  const thisMonth = s.workouts.filter((w) => w.day >= monthAgo).length;

  const more = async () => {
    setLoadingMore(true);
    try {
      await loadMoreWorkouts();
    } catch {
      toast("Couldn't load more. Check your connection.", 'error');
    }
    setLoadingMore(false);
  };

  if (s.workouts.length === 0) {
    return html`<div class="card"><${Empty} icon="dumbbell" title="No workouts yet" text="Finish a workout and it will show up here." /></div>`;
  }
  return html`<div class="stack">
    <section class="card">
      <div class="stat-pair">
        <div class="stat"><div class="k">This week</div><div class="v">${thisWeek}<small>${thisWeek === 1 ? 'workout' : 'workouts'}</small></div></div>
        <div class="stat"><div class="k">Last 30 days</div><div class="v">${thisMonth}<small>${thisMonth === 1 ? 'workout' : 'workouts'}</small></div></div>
      </div>
    </section>
    <div class="list">
      ${s.workouts.map(
        (w) =>
          html`<button class="row wk-row has-icon" key=${w.id} onClick=${() => openOverlay('workoutDetail', { id: w.id })}>
            <span class="row-icon strong">${w.name[0]}</span>
            <span class="grow">
              <span class="strong ellipsis" style=${{ display: 'block' }}>${w.name}</span>
              <span class="small muted num" style=${{ display: 'block' }}>
                ${fmtDay(w.day, s.today)} · ${fmtDuration((w.finishedAt - w.startedAt) / 1000)} · ${plural(w.sets, 'set')}
              </span>
            </span>
            <span class="kcal num">${fmtInt(kgToUnit(w.volume, unit))} <span class="small muted">${unit}</span></span>
            <${Icon} name="right" size="18" class="chev" />
          </button>`,
      )}
    </div>
    ${!s.workoutsEnd && html`<button class="btn btn-quiet btn-block" onClick=${more} disabled=${loadingMore}>${loadingMore ? 'Loading…' : 'Show earlier workouts'}</button>`}
  </div>`;
}

export function HistoryTab() {
  const s = useStore();
  const [segment, setSegment] = useState(rememberedSegment);
  rememberedSegment = segment;
  return html`<div class="page">
    <header class="page-head"><h1 class="h1">History</h1></header>
    <div style=${{ marginBottom: '14px' }}>
      <${Segmented}
        value=${segment}
        onChange=${setSegment}
        options=${[
          { value: 'food', label: 'Food' },
          { value: 'workouts', label: 'Workouts' },
        ]}
      />
    </div>
    ${segment === 'food' ? html`<${FoodHistory} s=${s} />` : html`<${WorkoutHistory} s=${s} />`}
  </div>`;
}

function DayScreen({ day }) {
  const s = useStore();
  const meals = s.meals[day];
  useEffect(() => {
    loadMeals(day).catch(() => {});
  }, [day]);

  return html`<${Screen} title=${fmtDay(day, s.today)}>
    <div class="stack">
      <${DaySummary} meals=${meals || []} targets=${targetsOf(s.profile)} />
      <div class="section-title">Meals</div>
      ${!meals
        ? html`<div class="card center" style=${{ display: 'grid', placeItems: 'center', minHeight: '100px' }}><${Spinner} /></div>`
        : meals.length === 0
          ? html`<div class="card"><${Empty} icon="utensils" title="Nothing logged" /></div>`
          : html`<div class="list">${meals.map((meal) => html`<${MealRow} key=${meal.id} meal=${meal} />`)}</div>`}
      <div style=${{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
        <button class="btn btn-secondary" style=${{ background: 'var(--surface)' }} onClick=${() => openOverlay('capture', { day })}>
          <${Icon} name="camera" size="20" /> Scan
        </button>
        <button class="btn btn-secondary" style=${{ background: 'var(--surface)' }} onClick=${() => openOverlay('describe', { day })}>
          <${Icon} name="keyboard" size="20" /> Type it
        </button>
      </div>
    </div>
  <//>`;
}

function WorkoutScreen({ id }) {
  const s = useStore();
  const unit = weightUnit(s.profile);
  const [workout, setWorkout] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    loadWorkout(id)
      .then((doc) => alive && setWorkout(doc))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [id]);

  const remove = async () => {
    const yes = await confirmDialog({
      title: 'Delete this workout?',
      message: 'It will be removed from your history and your records.',
      confirm: 'Delete',
      danger: true,
    });
    if (!yes) return;
    deleteWorkout(id);
    closeOverlay();
  };

  if (!workout) {
    return html`<${Screen} title="Workout">
      ${failed
        ? html`<${Empty} icon="offline" title="Couldn't load this workout" text="Check your connection and try again." />`
        : html`<div class="center" style=${{ display: 'grid', placeItems: 'center', minHeight: '220px' }}><${Spinner} /></div>`}
    <//>`;
  }

  const display = (kg) => Math.round(kgToUnit(kg, unit) * 100) / 100;
  const sets = workout.exercises.reduce((total, ex) => total + ex.sets.length, 0);
  const volume = workout.exercises.reduce((total, ex) => total + ex.sets.reduce((sub, set) => sub + set.w * set.r, 0), 0);

  return html`<${Screen} title=${workout.name}>
    <div class="stack">
      <p class="sub muted center">${fmtDay(workout.day, s.today)}${workout.warmup ? ' · warmed up' : ''}</p>
      <div class="tiles">
        <div class="tile"><div class="v">${fmtDuration((workout.finishedAt - workout.startedAt) / 1000)}</div><div class="k">Time</div></div>
        <div class="tile"><div class="v">${sets}</div><div class="k">Sets</div></div>
        <div class="tile"><div class="v">${fmtInt(kgToUnit(volume, unit))}</div><div class="k">Volume, ${unit}</div></div>
      </div>
      ${workout.exercises.map(
        (ex) =>
          html`<section class="card" style=${{ padding: '16px 18px' }}>
            <button class="row-between" style=${{ width: '100%', textAlign: 'left' }} onClick=${() => openOverlay('exercise', { exId: ex.exId })}>
              <span class="strong">${ex.name}</span>
              <${Icon} name="info" size="18" class="muted" />
            </button>
            <div class="set-grid num" style=${{ marginTop: '12px' }}>
              ${ex.sets.map(
                (set, i) =>
                  html`<span class="idx">${i + 1}</span><span>${loadText(display(set.w), unit, usesBodyweight(ex.exId))} × ${set.r}</span><span />`,
              )}
            </div>
          </section>`,
      )}
      <button class="btn btn-quiet btn-danger btn-block" onClick=${remove}><${Icon} name="trash" size="18" /> Delete workout</button>
    </div>
  <//>`;
}

registerOverlay('day', DayScreen);
registerOverlay('workoutDetail', WorkoutScreen);
