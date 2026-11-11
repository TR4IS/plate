import { api } from '../api.js';
import { routineById } from '../exercises.js';
import { html, useEffect, useState } from '../lib.js';
import { targetsOf, totalsOf } from '../nutrition.js';
import { loadMeals, mealPhotoUrl, openOverlay, setTab, useStore } from '../store.js';
import { Empty, Icon, Ring, Spinner, cx } from '../ui.js';
import { addDays, clamp, fmtDayLong, fmtInt, fmtTime, plural, weekdayIndex } from '../util.js';

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

function MacroChip({ kind, label, value, target }) {
  const percent = target > 0 ? clamp((value / target) * 100, 0, 100) : 0;
  return html`<div class=${cx('hero-macro', kind)}>
    <div class="hero-macro-top"><span>${label}</span><b class="num">${Math.round(value)}<small>/${Math.round(target)}g</small></b></div>
    <div class="hero-macro-bar"><i style=${{ width: `${percent}%` }} /></div>
  </div>`;
}

/** The dark scoreboard: calories left, a progress ring and the three macros. Shared with the day view in History. */
export function DaySummary({ meals, targets }) {
  const totals = totalsOf(meals);
  const left = targets.calories - totals.calories;
  const over = left < 0;
  const percent = targets.calories > 0 ? Math.round((totals.calories / targets.calories) * 100) : 0;
  return html`<section class="hero-card">
    <div class="hero-top">
      <div>
        <div class="hero-label">${over ? 'Over by' : 'Left'}</div>
        <div class="hero-num num">${fmtInt(Math.abs(left))}<small>kcal</small></div>
        <div class="hero-sub num">${fmtInt(totals.calories)} eaten · ${fmtInt(targets.calories)} goal</div>
      </div>
      <${Ring} size=${92} stroke=${10} value=${totals.calories} max=${targets.calories} over=${over}>
        <span class="hero-pct num">${percent}%</span>
      <//>
    </div>
    <div class="hero-macros">
      <${MacroChip} kind="protein" label="Protein" value=${totals.protein} target=${targets.protein} />
      <${MacroChip} kind="carbs" label="Carbs" value=${totals.carbs} target=${targets.carbs} />
      <${MacroChip} kind="fat" label="Fat" value=${totals.fat} target=${targets.fat} />
    </div>
  </section>`;
}

/** Days in a row with at least one meal logged, ending today (or yesterday, if today is still empty). */
function useStreak(s, mealsToday) {
  const [days, setDays] = useState(null);
  useEffect(() => {
    let alive = true;
    api('GET', '/api/days?limit=60')
      .then((data) => alive && setDays(new Set(data.days.map((d) => d.day))))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [s.mealsRev]);
  if (!days) return 0;
  const logged = new Set(days);
  if (mealsToday > 0) logged.add(s.today);
  let day = logged.has(s.today) ? s.today : addDays(s.today, -1);
  let count = 0;
  while (logged.has(day)) {
    count += 1;
    day = addDays(day, -1);
  }
  return count;
}

/** Today's meals in time order, with today's training slotted in as the next thing to do. */
function Timeline({ s, meals }) {
  const routine = routineById(s.plan, s.plan?.schedule?.[weekdayIndex(s.today)]);
  const doneToday = s.workouts.some((w) => w.day === s.today);
  const sorted = [...meals].sort((a, b) => a.ts - b.ts);

  const training =
    routine || doneToday
      ? html`<button class=${cx('tl-row tl-train', doneToday && 'done')} onClick=${() => setTab('workout')}>
          <span class="tl-time"><${Icon} name=${doneToday ? 'check' : 'dumbbell'} size="16" /></span>
          <span class="grow">
            <span class="strong ellipsis" style=${{ display: 'block' }}>${doneToday ? 'Workout done' : routine.name}</span>
            <span class="small muted" style=${{ display: 'block' }}>
              ${doneToday ? 'Nice work today' : plural(routine.exercises.length, 'exercise')}
            </span>
          </span>
          ${doneToday ? html`<${Icon} name="right" size="18" class="muted" />` : html`<span class="tl-go">Start</span>`}
        </button>`
      : null;

  if (sorted.length === 0) {
    return html`<div class="list">
      <${Empty} icon="camera" title="Nothing logged yet" text="Snap your first meal to start the day." />
      ${training}
    </div>`;
  }
  return html`<div class="list timeline">
    ${sorted.map(
      (meal) => html`<button key=${meal.id} class="tl-row" onClick=${() => openOverlay('meal', { meal })}>
        <span class="tl-time num">${fmtTime(meal.ts)}</span>
        <${MealThumb} meal=${meal} small />
        <span class="grow">
          <span class="strong ellipsis" style=${{ display: 'block' }}>${meal.name}</span>
          <span class="small muted num" style=${{ display: 'block' }}>P ${Math.round(meal.protein)} · C ${Math.round(meal.carbs)} · F ${Math.round(meal.fat)}</span>
        </span>
        <span class="kcal num">${fmtInt(meal.calories)}</span>
      </button>`,
    )}
    ${training}
  </div>`;
}

/** Where the tapped button is, so the camera can grow out of it. */
export const originOf = (event) => {
  const el = event.currentTarget;
  const box = el.getBoundingClientRect();
  const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 16;
  return { left: box.left, top: box.top, width: box.width, height: box.height, radius };
};

/** Says so when changes are still only on this phone. Nothing is shown when everything is saved. */
function SyncBadge({ s }) {
  const waiting = s.pending > 0;
  if (s.online && !waiting) return null;
  const cut = !s.online || s.stalled;
  const label = !cut ? 'Saving' : waiting ? 'Saved on this phone' : 'Offline';
  return html`<span class="badge" role="status">
    <${Icon} name=${cut ? 'offline' : 'refresh'} size="13" />${label}
  </span>`;
}

export function TodayTab() {
  const s = useStore();
  const meals = s.meals[s.today];
  useEffect(() => {
    if (!s.meals[s.today]) loadMeals(s.today).catch(() => {});
  }, [s.today]);
  const streak = useStreak(s, meals?.length || 0);
  const initial = (s.user?.name || '?')[0].toUpperCase();

  return html`<div class="page">
    <header class="page-head">
      <div>
        <div class="eyebrow">${fmtDayLong(s.today)}</div>
        <h1 class="h1">Today</h1>
      </div>
      <div class="head-actions">
        <${SyncBadge} s=${s} />
        ${streak >= 2 &&
        html`<span class="streak num" title="Days in a row with a meal logged"><${Icon} name="flame" size="15" />${streak} days</span>`}
        <button class="avatar-btn" aria-label="Settings and account" onClick=${() => setTab('settings')}>${initial}</button>
      </div>
    </header>

    <div class="stack">
      <${DaySummary} meals=${meals || []} targets=${targetsOf(s.profile)} />

      <div class="log-actions">
        <button class="btn btn-primary btn-lg log-snap" onClick=${(event) => openOverlay('capture', { origin: originOf(event) })}>
          <${Icon} name="camera" size="22" /> Snap a meal
        </button>
        <button class="btn btn-secondary btn-lg log-type" aria-label="Type a meal" onClick=${() => openOverlay('describe')}>
          <${Icon} name="keyboard" size="22" /> Type
        </button>
      </div>

      ${!s.ai.ready &&
      html`<button class="note" onClick=${() => (s.user?.isAdmin ? openOverlay('aiSettings') : null)} style=${{ textAlign: 'left', width: '100%' }}>
        <${Icon} name="sparkles" size="20" />
        <span>
          ${s.user?.isAdmin
            ? html`<b class="strong" style=${{ color: 'var(--ink)' }}>Connect an AI to scan meals.</b> Tap to add your API key.`
            : 'Photo scanning is not set up yet. Ask the owner of this server to connect an AI.'}
        </span>
      </button>`}

      <h2 class="section-title">Timeline</h2>
      ${!meals
        ? html`<div class="card center" style=${{ display: 'grid', placeItems: 'center', minHeight: '120px' }}><${Spinner} /></div>`
        : html`<${Timeline} s=${s} meals=${meals} />`}
    </div>
  </div>`;
}
