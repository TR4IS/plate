import { routineById } from '../exercises.js';
import { html, useEffect } from '../lib.js';
import { targetsOf, totalsOf } from '../nutrition.js';
import { loadMeals, mealPhotoUrl, openOverlay, setTab, useStore } from '../store.js';
import { Empty, Icon, Meter, Ring, Spinner, cx } from '../ui.js';
import { fmtDayLong, fmtInt, fmtTime, plural, weekdayIndex } from '../util.js';

export function MealThumb({ meal, small }) {
  const url = mealPhotoUrl(meal);
  if (url) return html`<img class=${cx('thumb', small && 'sm')} src=${url} alt="" loading="lazy" />`;
  return html`<span class=${cx('thumb blank', small && 'sm')}><${Icon} name=${meal.source === 'manual' ? 'pencil' : 'utensils'} size="20" /></span>`;
}

export function MealRow({ meal }) {
  return html`<button class="row meal-row" onClick=${() => openOverlay('meal', { meal })}>
    <${MealThumb} meal=${meal} />
    <span class="grow">
      <span class="strong ellipsis" style=${{ display: 'block' }}>${meal.name}</span>
      <span class="small muted num" style=${{ display: 'block', marginTop: '1px' }}>
        ${fmtTime(meal.ts)} · P ${Math.round(meal.protein)} · C ${Math.round(meal.carbs)} · F ${Math.round(meal.fat)}
      </span>
    </span>
    <span class="kcal num">${fmtInt(meal.calories)}<small>kcal</small></span>
  </button>`;
}

/** The ring and the three macro meters for one day. Shared with the day view in History. */
export function DaySummary({ meals, targets }) {
  const totals = totalsOf(meals);
  const left = targets.calories - totals.calories;
  const over = left < 0;
  // A smaller ring on short screens (iPhone SE) leaves room for the first meals above the fold.
  const compact = window.innerHeight < 720;
  return html`<section class="card">
    <div class="today-ring">
      <${Ring} size=${compact ? 176 : 216} stroke=${compact ? 15 : 18} value=${totals.calories} max=${targets.calories} over=${over}>
        <div class="hero-num" style=${compact ? { fontSize: '48px' } : null}>${fmtInt(Math.abs(left))}</div>
        <div class="caption">${over ? 'kcal over' : 'kcal left'}</div>
      <//>
      <div class="today-sub num"><b>${fmtInt(totals.calories)}</b> eaten · <b>${fmtInt(targets.calories)}</b> goal</div>
    </div>
    <div class="macro-row">
      <${Meter} kind="protein" label="Protein" value=${totals.protein} target=${targets.protein} />
      <${Meter} kind="carbs" label="Carbs" value=${totals.carbs} target=${targets.carbs} />
      <${Meter} kind="fat" label="Fat" value=${totals.fat} target=${targets.fat} />
    </div>
  </section>`;
}

function TrainingCard({ s }) {
  const routine = routineById(s.plan, s.plan?.schedule?.[weekdayIndex(s.today)]);
  const doneToday = s.workouts.some((w) => w.day === s.today);
  if (!routine && !doneToday) return null;
  return html`<button class="mini-card" onClick=${() => setTab('workout')}>
    <span class="row-icon" style=${doneToday ? { background: 'var(--good-soft)', color: 'var(--good)' } : null}>
      <${Icon} name=${doneToday ? 'check' : 'dumbbell'} size="18" />
    </span>
    <span class="grow">
      <span class="strong" style=${{ display: 'block' }}>${doneToday ? 'Workout done' : routine.name}</span>
      <span class="small muted" style=${{ display: 'block' }}>
        ${doneToday ? 'Nice work today' : `Today's training · ${plural(routine.exercises.length, 'exercise')}`}
      </span>
    </span>
    <${Icon} name="right" size="18" class="muted" />
  </button>`;
}

/** Says so when changes are still only on this phone. Nothing is shown when everything is saved. */
function SyncBadge({ s }) {
  const waiting = s.pending > 0;
  if (s.online && !waiting) return null;
  const cut = !s.online || s.stalled;
  const label = !cut ? 'Saving' : waiting ? 'Saved on this phone' : 'Offline';
  return html`<span class="badge" style=${{ marginBottom: '8px' }} role="status">
    <${Icon} name=${cut ? 'offline' : 'refresh'} size="13" />${label}
  </span>`;
}

export function TodayTab() {
  const s = useStore();
  const meals = s.meals[s.today];
  useEffect(() => {
    if (!s.meals[s.today]) loadMeals(s.today).catch(() => {});
  }, [s.today]);

  return html`<div class="page">
    <header class="page-head">
      <div>
        <div class="eyebrow">${fmtDayLong(s.today)}</div>
        <h1 class="h1">Today</h1>
      </div>
      <${SyncBadge} s=${s} />
    </header>

    <div class="stack">
      <${DaySummary} meals=${meals || []} targets=${targetsOf(s.profile)} />

      ${!s.ai.ready &&
      html`<button class="note" onClick=${() => (s.user?.isAdmin ? openOverlay('aiSettings') : null)} style=${{ textAlign: 'left', width: '100%' }}>
        <${Icon} name="sparkles" size="20" />
        <span>
          ${s.user?.isAdmin
            ? html`<b class="strong" style=${{ color: 'var(--ink)' }}>Connect an AI to scan meals.</b> Tap to add your API key.`
            : 'Photo scanning is not set up yet. Ask the owner of this server to connect an AI.'}
        </span>
      </button>`}

      <${TrainingCard} s=${s} />

      <div class="row-between" style=${{ marginTop: '6px' }}>
        <h2 class="section-title" style=${{ margin: 0 }}>Meals</h2>
        <button class="btn btn-sm btn-secondary" style=${{ background: 'var(--surface)' }} onClick=${() => openOverlay('describe')}>
          <${Icon} name="keyboard" size="18" /> Type it
        </button>
      </div>

      ${!meals
        ? html`<div class="card center" style=${{ display: 'grid', placeItems: 'center', minHeight: '120px' }}><${Spinner} /></div>`
        : meals.length === 0
          ? html`<div class="card">
              <${Empty} icon="camera" title="Nothing logged yet" text="Tap the camera button to scan your first meal." />
            </div>`
          : html`<div class="list">${meals.map((meal) => html`<${MealRow} key=${meal.id} meal=${meal} />`)}</div>`}
    </div>
  </div>`;
}
