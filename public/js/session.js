// The workout in progress: one plain object, replaced on every change and saved to the phone at once.
//
// Weights inside a session are in the person's display unit (so "+" adds exactly 2.5 kg or 5 lb);
// they are converted to kilograms when the workout is finished and stored.
import { buildWarmup, defaultRest, getExercise } from './exercises.js';
import { saveWorkout, setSession, state } from './store.js';
import { dayStr, kgToUnit, uid, unitToKg, weightUnit } from './util.js';

const round2 = (n) => Math.round(n * 100) / 100;
const estimatedMax = (weight, reps) => weight * (1 + reps / 30);

function sessionExercise(entry) {
  const ex = getExercise(entry.exId);
  return {
    exId: entry.exId,
    name: ex?.name || entry.name || 'Exercise',
    targetSets: entry.sets || 3,
    repMin: entry.repMin || 8,
    repMax: entry.repMax || 12,
    restSec: entry.restSec || defaultRest(ex, state.profile?.restSec || 90),
    sets: [],
    draft: null,
    skipped: false,
  };
}

/** What to pre-fill for the next set: last time's numbers, following today's weight if you changed it. */
export function suggestSet(sessionEx, unit = state.session?.unit || 'kg') {
  const index = sessionEx.sets.length;
  const last = (state.stats[sessionEx.exId]?.last?.sets || []).map(([kg, reps]) => ({ w: round2(kgToUnit(kg, unit)), r: reps }));
  const before = sessionEx.sets[index - 1];
  const lastSame = last[index] || last[last.length - 1];

  let w = lastSame ? lastSame.w : 0;
  if (before) {
    const followedLastTime = last[index - 1] && last[index - 1].w === before.w && last[index];
    w = followedLastTime ? last[index].w : before.w;
  }
  const r = lastSame?.r || before?.r || sessionEx.repMin;
  return { w, r };
}

const withDraft = (sessionEx, unit) => (sessionEx.draft ? sessionEx : { ...sessionEx, draft: suggestSet(sessionEx, unit) });

function update(mutator) {
  const session = state.session;
  if (!session) return null;
  const next = mutator({ ...session, exercises: session.exercises.map((ex) => ex) });
  setSession(next);
  return next;
}

function patchExercise(session, index, patch) {
  session.exercises[index] = { ...session.exercises[index], ...patch };
  return session;
}

// ---- starting and leaving ----------------------------------------------------------------

export function startSession(routine) {
  const profile = state.profile || {};
  const exercises = routine.exercises.map(sessionExercise);
  const warmup = profile.warmup !== false && exercises.length > 0;
  const unit = weightUnit(profile);
  if (exercises.length) exercises[0] = withDraft(exercises[0], unit);
  setSession({
    id: uid('w'),
    routineId: routine.id || '',
    name: routine.name,
    day: dayStr(),
    startedAt: Date.now(),
    unit,
    phase: warmup ? 'warmup' : 'train',
    warm: warmup
      ? { moves: buildWarmup(routine.exercises.map((e) => e.exId), profile.warmupSec || 30), i: 0, endsAt: null, left: null }
      : null,
    warmedUp: false,
    exercises,
    cur: 0,
    view: 'exercise',
    rest: null,
  });
}

export const discardSession = () => setSession(null);

// ---- warm-up -----------------------------------------------------------------------------

export function warmStart() {
  update((s) => ({ ...s, warm: { ...s.warm, endsAt: Date.now() + s.warm.moves[s.warm.i].sec * 1000, left: null } }));
}

export function warmPause() {
  update((s) => (s.warm.endsAt ? { ...s, warm: { ...s.warm, left: Math.max(0, s.warm.endsAt - Date.now()), endsAt: null } } : s));
}

export function warmResume() {
  update((s) => (s.warm.left !== null ? { ...s, warm: { ...s.warm, endsAt: Date.now() + s.warm.left, left: null } } : s));
}

/** Move to the next warm-up move (its timer starts by itself), or into the workout after the last one. */
export function warmNext() {
  update((s) => {
    const i = s.warm.i + 1;
    if (i >= s.warm.moves.length) return { ...s, phase: 'train', warmedUp: true, warm: { ...s.warm, endsAt: null, left: null } };
    return { ...s, warm: { ...s.warm, i, endsAt: Date.now() + s.warm.moves[i].sec * 1000, left: null } };
  });
}

export function warmSkip() {
  update((s) => ({ ...s, phase: 'train', warm: { ...s.warm, endsAt: null, left: null } }));
}

// ---- lifting -----------------------------------------------------------------------------

export function openExercise(index) {
  update((s) => {
    patchExercise(s, index, withDraft(s.exercises[index], s.unit));
    return { ...s, cur: index, view: 'exercise' };
  });
}

export const showList = () => update((s) => ({ ...s, view: 'list' }));

export function setDraft(patch) {
  update((s) => patchExercise(s, s.cur, { draft: { ...withDraft(s.exercises[s.cur], s.unit).draft, ...patch } }));
}

/**
 * Was this set better than anything before it? Compared by estimated one-rep max, or by reps
 * for bodyweight work. A first-ever attempt at an exercise is not called a record.
 */
function beatsRecord(sessionEx, set, unit) {
  const record = state.stats[sessionEx.exId];
  if (!record || !record.n) return false;
  const earlier = sessionEx.sets;
  if (set.w <= 0) {
    return record.bestW <= 0 && set.r > Math.max(record.bestReps, ...earlier.map((s) => s.r));
  }
  const kg = unitToKg(set.w, unit);
  const bestSoFar = Math.max(record.bestE1, ...earlier.map((s) => estimatedMax(unitToKg(s.w, unit), s.r)));
  return estimatedMax(kg, set.r) > bestSoFar + 0.05;
}

/** Log the drafted set of the open exercise and start the rest timer. Returns { record }. */
export function logSet() {
  let record = false;
  update((s) => {
    const ex = withDraft(s.exercises[s.cur], s.unit);
    const set = { w: Math.max(0, ex.draft.w), r: Math.max(0, Math.round(ex.draft.r)), at: Date.now() };
    record = beatsRecord(ex, set, s.unit);
    if (record) set.pr = true;
    const sets = [...ex.sets, set];
    const logged = { ...ex, sets, skipped: false };
    patchExercise(s, s.cur, { ...logged, draft: suggestSet(logged, s.unit) });
    const restMs = ex.restSec * 1000;
    return { ...s, rest: restMs > 0 ? { endsAt: Date.now() + restMs, total: restMs, exIndex: s.cur } : null };
  });
  return { record };
}

export function updateSet(exIndex, setIndex, patch) {
  update((s) => {
    const ex = s.exercises[exIndex];
    const sets = ex.sets.map((set, i) => (i === setIndex ? { ...set, ...patch, pr: undefined } : set));
    return patchExercise(s, exIndex, { sets });
  });
}

export function removeSet(exIndex, setIndex) {
  update((s) => {
    const ex = s.exercises[exIndex];
    const trimmed = { ...ex, sets: ex.sets.filter((_, i) => i !== setIndex) };
    return patchExercise(s, exIndex, { ...trimmed, draft: suggestSet(trimmed, s.unit) });
  });
}

export function adjustRest(seconds) {
  update((s) => {
    if (!s.rest) return s;
    const endsAt = Math.max(Date.now(), s.rest.endsAt + seconds * 1000);
    return { ...s, rest: { ...s.rest, endsAt, total: Math.max(s.rest.total + seconds * 1000, endsAt - Date.now()) } };
  });
}

export const clearRest = () => update((s) => ({ ...s, rest: null }));

/** Change how long the rest timer runs for one exercise, for the rest of this workout. */
export function setRestLength(exIndex, seconds) {
  update((s) => patchExercise(s, exIndex, { restSec: seconds }));
}

const isDone = (ex) => ex.skipped || ex.sets.length >= ex.targetSets;

/** Index of the next exercise that still has sets to do, looking forward from the open one first. */
export function nextOpenIndex(session) {
  const count = session.exercises.length;
  for (let step = 1; step <= count; step++) {
    const index = (session.cur + step) % count;
    if (!isDone(session.exercises[index])) return index;
  }
  return -1;
}

export function goNext() {
  const session = state.session;
  if (!session) return;
  const index = nextOpenIndex(session);
  if (index === -1) showList();
  else openExercise(index);
}

export function toggleSkip(index) {
  update((s) => patchExercise(s, index, { skipped: !s.exercises[index].skipped }));
}

/** Swap an exercise for another one (machine taken, sore joint), keeping its sets-and-reps target. */
export function replaceExercise(index, exId) {
  update((s) => {
    const old = s.exercises[index];
    const fresh = sessionExercise({ exId, sets: old.targetSets, repMin: old.repMin, repMax: old.repMax });
    return patchExercise(s, index, withDraft(fresh, s.unit));
  });
}

export function addExercises(exIds) {
  update((s) => ({
    ...s,
    exercises: [...s.exercises, ...exIds.map((exId) => sessionExercise({ exId, sets: 3, repMin: 8, repMax: 12 }))],
  }));
}

export function removeExercise(index) {
  update((s) => {
    const exercises = s.exercises.filter((_, i) => i !== index);
    const cur = Math.min(s.cur > index ? s.cur - 1 : s.cur, Math.max(0, exercises.length - 1));
    return { ...s, exercises, cur, view: 'list' };
  });
}

// ---- progress and finishing --------------------------------------------------------------

export function sessionProgress(session) {
  let setsDone = 0;
  let setsPlanned = 0;
  let volume = 0;
  for (const ex of session.exercises) {
    setsDone += ex.sets.length;
    if (!ex.skipped) setsPlanned += Math.max(ex.targetSets, ex.sets.length);
    for (const set of ex.sets) volume += set.w * set.r;
  }
  return { setsDone, setsPlanned, volume };
}

/** Save the workout and switch the session to its summary screen. */
export function finishSession() {
  const session = state.session;
  if (!session) return;
  const finishedAt = Date.now();
  const done = session.exercises.filter((ex) => ex.sets.length > 0);

  const records = [];
  for (const ex of done) {
    const best = ex.sets.filter((set) => set.pr).sort((a, b) => estimatedMax(b.w, b.r) - estimatedMax(a.w, a.r) || b.r - a.r)[0];
    if (best) records.push({ exId: ex.exId, name: ex.name, w: best.w, r: best.r });
  }

  const workout = {
    id: session.id,
    day: session.day,
    startedAt: session.startedAt,
    finishedAt,
    name: session.name,
    routineId: session.routineId,
    warmup: session.warmedUp,
    exercises: done.map((ex) => ({
      exId: ex.exId,
      name: ex.name,
      sets: ex.sets.map((set) => ({ w: Math.round(unitToKg(set.w, session.unit) * 1000) / 1000, r: set.r })),
    })),
  };
  if (workout.exercises.length) saveWorkout(workout);

  const { setsDone, volume } = sessionProgress(session);
  setSession({
    ...session,
    phase: 'summary',
    rest: null,
    summary: { seconds: Math.round((finishedAt - session.startedAt) / 1000), sets: setsDone, volume, exercises: done.length, records },
  });
}
