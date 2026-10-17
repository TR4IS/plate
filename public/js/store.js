// App state, persistence and syncing.
//
// The phone is the source of truth while you use it: every change is applied to `state` at once,
// saved locally, and queued in an "outbox" that is sent to the server as soon as it is reachable.
// That is what lets you log sets in a gym with no signal.
import { ApiError, api, setUnauthorizedHandler } from './api.js';
import { useEffect, useReducer, useRef } from './lib.js';
import { dayStr, debounce, uid } from './util.js';

const KEYS = {
  cache: 'plate.cache.v1',
  session: 'plate.session.v1',
  outbox: 'plate.outbox.v1',
  owner: 'plate.owner',
  theme: 'plate.theme',
  hints: 'plate.hints.v1',
};

const ls = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
  del(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* private mode */
    }
  },
};

const blank = () => ({
  phase: 'boot', // boot | offline | auth | onboarding | app
  needsSetup: false,
  version: '',
  user: null,
  profile: null,
  plan: null,
  custom: [],
  meals: {}, // day -> meals, oldest first
  mealsRev: 0, // bumped whenever any meal changes, so history lists know to reload
  weights: [], // [{ day, kg }] oldest first
  workouts: [], // summaries, newest first
  workoutsEnd: false,
  stats: {}, // exercise id -> { last, bestW, bestE1, bestReps, n }
  ai: { ready: false, provider: '' },
  session: null, // the workout in progress
  today: dayStr(),
  online: navigator.onLine !== false,
  pending: 0, // changes saved on this phone that the server has not confirmed yet
  stalled: false, // the last attempt to send them failed
  tab: 'today',
  overlays: [],
  toast: null,
  dialog: null,
});

export const state = blank();

// ---- subscriptions -----------------------------------------------------------------------

const listeners = new Set();
let version = 0;
let scheduled = false;

export function notify() {
  version += 1;
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    for (const listener of [...listeners]) listener();
  });
}

export function set(patch) {
  Object.assign(state, patch);
  notify();
}

/** Re-render the calling component whenever the store changes; returns the store. */
export function useStore() {
  const [, rerender] = useReducer((n) => n + 1, 0);
  const seen = useRef(version);
  seen.current = version;
  useEffect(() => {
    listeners.add(rerender);
    if (seen.current !== version) rerender();
    return () => listeners.delete(rerender);
  }, []);
  return state;
}

// ---- toast -------------------------------------------------------------------------------

let toastTimer;
export function toast(message, kind = 'info', ms = 2400) {
  clearTimeout(toastTimer);
  set({ toast: { message, kind, id: Date.now() } });
  toastTimer = setTimeout(() => set({ toast: null }), ms);
}

export const errorText = (err) => (err instanceof ApiError ? err.message : 'Something went wrong. Try again.');

// ---- one-time hints (e.g. the camera tips card) ------------------------------------------

export const hintSeen = (name) => Boolean(ls.get(KEYS.hints, {})[name]);
export function markHint(name) {
  ls.set(KEYS.hints, { ...ls.get(KEYS.hints, {}), [name]: true });
}

// ---- theme -------------------------------------------------------------------------------

export function applyTheme() {
  const theme = state.profile?.theme;
  const root = document.documentElement;
  // Stored as a bare word (not JSON) because theme.js reads it before anything else loads.
  try {
    if (theme === 'light' || theme === 'dark') {
      root.setAttribute('data-theme', theme);
      localStorage.setItem(KEYS.theme, theme);
    } else {
      root.removeAttribute('data-theme');
      localStorage.removeItem(KEYS.theme);
    }
  } catch {
    /* private mode */
  }
  const dark = theme === 'dark' || (theme !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.setAttribute('content', dark ? '#000000' : '#f3f3f1');
}

// ---- local cache -------------------------------------------------------------------------

const stripLocal = (meal) => {
  const { localPhoto, ...rest } = meal;
  return rest;
};

const saveCache = debounce(() => {
  if (!state.user) return;
  ls.set(KEYS.cache, {
    userId: state.user.id,
    user: state.user,
    version: state.version,
    profile: state.profile,
    plan: state.plan,
    custom: state.custom,
    meals: { [state.today]: (state.meals[state.today] || []).map(stripLocal) },
    weights: state.weights,
    workouts: state.workouts.slice(0, 40),
    stats: state.stats,
    ai: state.ai,
  });
}, 300);

function changed() {
  notify();
  saveCache();
}

function clearLocal() {
  for (const key of [KEYS.cache, KEYS.session, KEYS.outbox, KEYS.owner]) ls.del(key);
  outbox = [];
  workoutDocs.clear();
}

// ---- outbox ------------------------------------------------------------------------------

let outbox = []; // [{ id, method, url, body, key }]
let flushing = null;
let retryTimer = null;
let retryDelay = 4000;
// Counts every local change. A server snapshot requested before a change and received after it
// is out of date, so readers compare this before and after and ask again if it moved.
let changeCount = 0;

function persistOutbox() {
  // If storage is full (a queue of photos while offline), the queue still lives in memory.
  ls.set(KEYS.outbox, outbox);
  if (state.pending !== outbox.length) set({ pending: outbox.length });
}

const isPending = (key) => outbox.some((entry) => entry.key === key);

/**
 * Queue a change for the server. A later change with the same `key` replaces an earlier one that
 * has not been sent yet, so ten quick edits become one request.
 */
function enqueue(method, url, body, key) {
  const superseded = outbox.find((entry) => entry.key === key && !entry.sending);
  if (superseded) {
    // Don't lose a photo that was waiting to upload when the meal is edited again.
    if (method === 'PUT' && superseded.body?.photo && body && !body.photo) body = { ...body, photo: superseded.body.photo };
    outbox = outbox.filter((entry) => entry !== superseded);
  }
  outbox.push({ id: uid('q'), method, url, body, key });
  changeCount += 1;
  persistOutbox();
  // Settings and plan edits arrive in bursts (typing a name, holding a stepper): send them once they settle.
  if (key.startsWith('doc:')) flushSoon();
  else flushOutbox();
}

const flushSoon = debounce(() => flushOutbox(), 800);

export function flushOutbox() {
  if (flushing) return flushing;
  flushing = (async () => {
    let sentWorkoutDelete = false;
    while (outbox.length) {
      const entry = outbox[0];
      entry.sending = true;
      try {
        await api(entry.method, entry.url, entry.body, { timeout: 45000 });
        retryDelay = 4000;
        if (state.stalled) set({ stalled: false });
        if (entry.method === 'DELETE' && entry.key.startsWith('workout:')) sentWorkoutDelete = true;
      } catch (err) {
        entry.sending = false;
        const status = err instanceof ApiError ? err.status : 0;
        if (status === 0 || status === 401 || status === 408 || status === 429 || status >= 500) {
          // The server can't be reached (or isn't accepting us) right now; keep everything and try again later.
          if (!state.stalled) set({ stalled: true });
          if (status !== 401) scheduleRetry();
          return;
        }
        // The server refused it for good (bad data). Drop it rather than block everything behind it.
        toast(`A change could not be saved: ${err.message}`, 'error', 5000);
      }
      outbox = outbox.filter((item) => item !== entry);
      persistOutbox();
    }
    // Records depend on every workout, so after a deletion ask the server for the recomputed ones.
    if (sentWorkoutDelete) refreshStats();
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(flushOutbox, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 60000);
}

/** Re-apply changes that are still waiting to be sent on top of data just fetched from the server. */
function overlayPending() {
  for (const entry of outbox) {
    const [kind, id] = entry.key.split(':');
    if (kind === 'meal') {
      removeMealLocal(id);
      if (entry.method === 'PUT') {
        const { photo, hadPhoto, ...meal } = entry.body;
        insertMealLocal({ ...meal, id, photo: Boolean(photo || hadPhoto), ...localPhotoOf(id) });
      }
    } else if (kind === 'workout') {
      state.workouts = state.workouts.filter((w) => w.id !== id);
      if (entry.method === 'PUT') insertWorkoutLocal({ ...entry.body, id });
    }
  }
}

// ---- boot, sign-in, refresh --------------------------------------------------------------

let lastRefresh = 0;

function applyCache(cache) {
  Object.assign(state, {
    user: cache.user,
    version: cache.version || '',
    profile: cache.profile,
    plan: cache.plan,
    custom: cache.custom || [],
    meals: cache.meals || {},
    weights: cache.weights || [],
    workouts: cache.workouts || [],
    stats: cache.stats || {},
    ai: cache.ai || { ready: false, provider: '' },
  });
}

const phaseFor = (profile) => (profile?.onboarded ? 'app' : 'onboarding');

export async function boot() {
  state.session = ls.get(KEYS.session);
  outbox = ls.get(KEYS.outbox, []) || [];
  state.pending = outbox.length;

  // Show the last known state straight away so the app opens instantly, even with no signal.
  const cache = ls.get(KEYS.cache);
  if (cache?.userId && cache.user) {
    applyCache(cache);
    overlayPending();
    applyTheme();
    set({ phase: phaseFor(state.profile) });
  }

  try {
    const remote = await api('GET', '/api/state');
    state.version = remote.version;
    if (!remote.user) {
      set({ ...blank(), phase: 'auth', needsSetup: remote.needsSetup, session: state.session, pending: outbox.length });
      return;
    }
    // Someone else used this browser last: their cached data and queued changes must not leak over.
    const owner = ls.get(KEYS.owner);
    if (owner !== null && owner !== remote.user.id) {
      clearLocal();
      Object.assign(state, blank());
    }
    state.user = remote.user;
    ls.set(KEYS.owner, remote.user.id);
    await flushOutbox();
    await refresh();
  } catch {
    // No server and nothing cached: there is nothing to show yet.
    if (state.phase === 'boot') set({ phase: 'offline' });
  }
}

/**
 * Fetch something from the server that will replace local state. Queued changes are sent first,
 * and if a new change is made while the request is in the air the answer is thrown away and
 * asked for again, so a slow response can never wipe out something the person just did.
 */
async function freshFromServer(url) {
  for (let attempt = 0; ; attempt++) {
    const before = changeCount;
    await flushOutbox();
    const data = await api('GET', url);
    if (before === changeCount || attempt === 2) return data;
  }
}

export async function refresh() {
  const today = dayStr();
  const data = await freshFromServer(`/api/bootstrap?day=${today}`);
  lastRefresh = Date.now();
  state.version = data.version;
  state.user = data.user;
  state.ai = data.ai;
  if (!isPending('doc:profile')) state.profile = data.profile;
  if (!isPending('doc:plan')) state.plan = data.plan;
  if (!isPending('doc:custom')) state.custom = data.custom || [];
  state.meals = { ...state.meals, [today]: data.meals.map((meal) => ({ ...meal, ...localPhotoOf(meal.id) })) };
  state.weights = data.weights;
  state.workouts = data.workouts;
  state.workoutsEnd = data.workouts.length < 40;
  state.stats = data.stats;
  state.today = today;
  overlayPending();
  applyTheme();
  state.phase = phaseFor(state.profile);
  changed();
}

async function refreshStats() {
  try {
    state.stats = (await freshFromServer('/api/stats')).stats;
    changed();
  } catch {
    /* stale records are harmless; the next refresh fixes them */
  }
}

/** Called when the app comes back to the foreground or regains a connection. */
export function wake() {
  if (state.phase !== 'app' && state.phase !== 'onboarding') return;
  const today = dayStr();
  if (today !== state.today) set({ today });
  flushOutbox().then(() => {
    if (Date.now() - lastRefresh > 60_000 || !state.meals[today]) refresh().catch(() => {});
  });
}

async function signedIn(user) {
  // Queued changes and a half-done workout belong to whoever used this phone last.
  if (ls.get(KEYS.owner) !== user.id) {
    clearLocal();
    state.session = null;
  }
  ls.set(KEYS.owner, user.id);
  state.user = user;
  await refresh();
}

export async function login(name, password) {
  await signedIn((await api('POST', '/api/login', { name, password })).user);
}

export async function setupOwner(name, password) {
  await signedIn((await api('POST', '/api/setup', { name, password })).user);
}

export async function signup(name, password, code) {
  await signedIn((await api('POST', '/api/signup', { name, password, code })).user);
}

export async function logout() {
  try {
    await flushOutbox();
    await api('POST', '/api/logout');
  } catch {
    /* signing out locally still works offline */
  }
  clearLocal();
  resetHistory();
  set({ ...blank(), phase: 'auth' });
  applyTheme();
}

setUnauthorizedHandler(() => {
  if (state.phase === 'app' || state.phase === 'onboarding') {
    resetHistory();
    set({ phase: 'auth', overlays: [] });
  }
});

// ---- profile, plan, own exercises --------------------------------------------------------

export function saveProfile(patch) {
  state.profile = { ...(state.profile || {}), ...patch };
  if (state.phase === 'onboarding' && state.profile.onboarded) state.phase = 'app';
  applyTheme();
  enqueue('PUT', '/api/docs/profile', { value: state.profile }, 'doc:profile');
  changed();
}

export function savePlan(plan) {
  state.plan = plan;
  enqueue('PUT', '/api/docs/plan', { value: plan }, 'doc:plan');
  changed();
}

export function saveCustom(list) {
  state.custom = list;
  enqueue('PUT', '/api/docs/custom', { value: list }, 'doc:custom');
  changed();
}

// ---- meals -------------------------------------------------------------------------------

// Photos taken this session, shown instantly while the upload is still on its way.
const localPhotos = new Map();
const localPhotoOf = (id) => (localPhotos.has(id) ? { localPhoto: localPhotos.get(id) } : {});

function removeMealLocal(id) {
  for (const day of Object.keys(state.meals)) {
    if (state.meals[day].some((meal) => meal.id === id)) state.meals[day] = state.meals[day].filter((meal) => meal.id !== id);
  }
}

function insertMealLocal(meal) {
  if (!state.meals[meal.day]) return; // that day isn't loaded; it will include the meal when it is
  state.meals[meal.day] = [...state.meals[meal.day], meal].sort((a, b) => a.ts - b.ts);
}

export async function loadMeals(day) {
  const { meals } = await freshFromServer(`/api/meals?from=${day}`);
  state.meals = { ...state.meals, [day]: meals.map((meal) => ({ ...meal, ...localPhotoOf(meal.id) })) };
  overlayPending();
  changed();
}

/** Create or update a meal. `photoBase64` is only passed when a new photo was taken. */
export function saveMeal(meal, photoBase64 = null, localPhotoUrl = null) {
  if (localPhotoUrl) localPhotos.set(meal.id, localPhotoUrl);
  const record = { ...stripLocal(meal), photo: Boolean(meal.photo || photoBase64) };
  removeMealLocal(meal.id);
  if (!state.meals[record.day] && record.day === state.today) state.meals[record.day] = [];
  insertMealLocal({ ...record, ...localPhotoOf(meal.id) });
  const { id, photo, ...body } = record;
  // hadPhoto only matters locally (see overlayPending); the server ignores it.
  enqueue('PUT', `/api/meals/${id}`, photoBase64 ? { ...body, photo: photoBase64 } : { ...body, hadPhoto: photo }, `meal:${id}`);
  state.mealsRev += 1;
  changed();
}

export function deleteMeal(id) {
  removeMealLocal(id);
  localPhotos.delete(id);
  enqueue('DELETE', `/api/meals/${id}`, null, `meal:${id}`);
  state.mealsRev += 1;
  changed();
}

export const mealPhotoUrl = (meal) => meal.localPhoto || (meal.photo ? `/api/meals/${meal.id}/photo` : null);

export function analyzeMeal(payload) {
  return api('POST', '/api/analyze', payload, { timeout: 100000 }).then((data) => data.estimate);
}

// ---- body weight -------------------------------------------------------------------------

export function logWeight(kg, day = dayStr()) {
  state.weights = [...state.weights.filter((entry) => entry.day !== day), { day, kg }].sort((a, b) => a.day.localeCompare(b.day));
  enqueue('PUT', `/api/weights/${day}`, { kg }, `weight:${day}`);
  // The newest weigh-in is "your weight" for the calorie targets.
  saveProfile({ weightKg: state.weights[state.weights.length - 1].kg });
}

export function deleteWeight(day) {
  state.weights = state.weights.filter((entry) => entry.day !== day);
  enqueue('DELETE', `/api/weights/${day}`, null, `weight:${day}`);
  if (state.weights.length) saveProfile({ weightKg: state.weights[state.weights.length - 1].kg });
  else changed();
}

// ---- workouts ----------------------------------------------------------------------------

const workoutDocs = new Map(); // id -> full workout, for anything opened or saved this session

function summarize(workout) {
  let sets = 0;
  let volume = 0;
  for (const ex of workout.exercises) {
    for (const s of ex.sets) {
      sets += 1;
      volume += s.w * s.r;
    }
  }
  return {
    id: workout.id,
    day: workout.day,
    startedAt: workout.startedAt,
    finishedAt: workout.finishedAt,
    name: workout.name,
    sets,
    volume: Math.round(volume * 10) / 10,
    exercises: workout.exercises.length,
  };
}

function insertWorkoutLocal(workout) {
  workoutDocs.set(workout.id, workout);
  state.workouts = [summarize(workout), ...state.workouts.filter((w) => w.id !== workout.id)].sort((a, b) => b.startedAt - a.startedAt);
}

/** Save a finished workout (weights in kg) and fold it into "last time" and the records right away. */
export function saveWorkout(workout) {
  insertWorkoutLocal(workout);
  const stats = { ...state.stats };
  for (const ex of workout.exercises) {
    if (!ex.sets.length) continue;
    const prev = stats[ex.exId];
    const isNewest = !prev || workout.day >= prev.last.day;
    stats[ex.exId] = {
      last: isNewest ? { day: workout.day, sets: ex.sets.map((s) => [s.w, s.r]) } : prev.last,
      bestW: Math.max(prev?.bestW || 0, ...ex.sets.map((s) => s.w)),
      bestE1: Math.max(prev?.bestE1 || 0, ...ex.sets.map((s) => Math.round(s.w * (1 + s.r / 30) * 100) / 100)),
      bestReps: Math.max(prev?.bestReps || 0, ...ex.sets.map((s) => s.r)),
      n: (prev?.n || 0) + 1,
    };
  }
  state.stats = stats;
  const { id, ...body } = workout;
  enqueue('PUT', `/api/workouts/${id}`, body, `workout:${id}`);
  changed();
}

export function deleteWorkout(id) {
  state.workouts = state.workouts.filter((w) => w.id !== id);
  workoutDocs.delete(id);
  enqueue('DELETE', `/api/workouts/${id}`, null, `workout:${id}`);
  changed();
}

export async function loadWorkout(id) {
  if (workoutDocs.has(id)) return workoutDocs.get(id);
  const { workout } = await api('GET', `/api/workouts/${id}`);
  workoutDocs.set(id, workout);
  return workout;
}

export async function loadMoreWorkouts() {
  const oldest = state.workouts[state.workouts.length - 1];
  if (!oldest || state.workoutsEnd) return;
  const { workouts } = await api('GET', `/api/workouts?before=${oldest.startedAt}&limit=40`);
  state.workouts = [...state.workouts, ...workouts.filter((w) => !state.workouts.some((have) => have.id === w.id))];
  state.workoutsEnd = workouts.length < 40;
  notify();
}

// ---- the workout in progress -------------------------------------------------------------

/** Replace the in-progress workout. Written to storage immediately: a set must never be lost. */
export function setSession(session) {
  state.session = session;
  if (session) ls.set(KEYS.session, session);
  else ls.del(KEYS.session);
  notify();
}

// ---- screens stacked above the tabs ------------------------------------------------------
//
// Every overlay gets a browser-history entry, so the iPhone's swipe-back gesture closes it.

let overlaySeq = Date.now() % 1_000_000;

export function resetHistory() {
  history.replaceState({ plate: 0 }, '');
}

export function openOverlay(type, props = {}) {
  const id = ++overlaySeq;
  history.pushState({ plate: id }, '');
  set({ overlays: [...state.overlays, { id, type, props }] });
}

// Stepping back in history is asynchronous. Counting the closes already under way stops two
// quick "close" calls from stepping back twice and leaving the app.
let closesUnderWay = 0;

/** Close the top overlay (or the top `count`). */
export function closeOverlay(count = 1) {
  const n = Math.min(count, state.overlays.length - closesUnderWay);
  if (n <= 0) return;
  closesUnderWay += n;
  history.go(-n);
}

/** Close the top overlay(s), then run `fn` once the browser has finished stepping back. */
export function closeOverlayThen(fn, count = 1) {
  const n = Math.min(count, state.overlays.length - closesUnderWay);
  if (n <= 0) {
    fn();
    return;
  }
  window.addEventListener('popstate', () => setTimeout(fn, 0), { once: true });
  closesUnderWay += n;
  history.go(-n);
}

/** Swap the top overlay for another without growing the history stack. */
export function replaceOverlay(type, props = {}) {
  if (!state.overlays.length) return openOverlay(type, props);
  const id = ++overlaySeq;
  history.replaceState({ plate: id }, '');
  set({ overlays: [...state.overlays.slice(0, -1), { id, type, props }] });
}

window.addEventListener('popstate', (event) => {
  closesUnderWay = 0;
  const id = event.state?.plate || 0;
  if (id === 0) {
    if (state.overlays.length) set({ overlays: [] });
    return;
  }
  const index = state.overlays.findIndex((overlay) => overlay.id === id);
  if (index >= 0) {
    if (index < state.overlays.length - 1) set({ overlays: state.overlays.slice(0, index + 1) });
  } else {
    // A leftover entry (after a reload, or "forward" to a closed screen): step back over it.
    history.back();
  }
});

export function setTab(tab) {
  if (state.tab !== tab) set({ tab });
}

window.addEventListener('online', () => {
  set({ online: true });
  wake();
});
window.addEventListener('offline', () => set({ online: false }));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') wake();
  // Leaving the app: send anything still waiting rather than holding it for the debounce.
  else if (state.user) flushOutbox();
});
setInterval(() => {
  if (document.visibilityState === 'visible' && dayStr() !== state.today) wake();
}, 60_000);
