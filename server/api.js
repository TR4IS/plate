import fs from 'node:fs';
import path from 'node:path';
import { AI_DAILY_LIMIT, DATA_DIR, VERSION } from './config.js';
import { q, tx, getDoc, putDoc, getSetting, setSetting, parseJson } from './db.js';
import { HttpError, clientIp, readJson, sendJson } from './http.js';
import * as auth from './auth.js';
import * as ai from './ai.js';

const KB = 1024;
const MB = 1024 * KB;

// ---- small validators --------------------------------------------------------------------

const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(v);
const isExerciseId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v);

function text(value, max) {
  return typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max)
    : '';
}

function num(value, min, max, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

const round = (n, places) => Math.round(n * 10 ** places) / 10 ** places;

function requireDay(value) {
  if (!isDay(value)) throw new HttpError(400, 'A date is missing or malformed.');
  return value;
}

function requireId(value) {
  if (!isId(value)) throw new HttpError(400, 'An id is missing or malformed.');
  return value;
}

function timestamp(value) {
  const n = Math.round(Number(value));
  // Anything outside 2015..2100 is a client bug, not a real moment.
  return Number.isFinite(n) && n > 1.4e12 && n < 4.1e12 ? n : Date.now();
}

function decodeJpeg(base64, maxBytes) {
  if (typeof base64 !== 'string' || !base64) return null;
  const clean = base64.replace(/^data:image\/jpeg;base64,/, '');
  if (clean.length > maxBytes * 1.4) throw new HttpError(413, 'That photo is too large.');
  const buf = Buffer.from(clean, 'base64');
  if (buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) {
    throw new HttpError(400, 'The photo must be a JPEG image.');
  }
  if (buf.length > maxBytes) throw new HttpError(413, 'That photo is too large.');
  return buf;
}

function requirePassword(value) {
  if (typeof value !== 'string' || value.length < auth.MIN_PASSWORD) {
    throw new HttpError(400, `Use a password with at least ${auth.MIN_PASSWORD} characters.`);
  }
  if (value.length > 200) throw new HttpError(400, 'That password is too long.');
  return value;
}

function requireName(raw) {
  const { name, key } = auth.normalizeName(raw);
  if (name.length < 2 || name.length > 24) throw new HttpError(400, 'Names need 2 to 24 characters.');
  return { name, key };
}

const publicUser = (user) => ({ id: user.id, name: user.name, isAdmin: user.isAdmin });

// ---- people ------------------------------------------------------------------------------

const userPhotoDir = (userId) => path.join(DATA_DIR, 'photos', String(userId));
const photoPath = (userId, mealId) => path.join(userPhotoDir(userId), `${mealId}.jpg`);

function insertUser({ name, key }, passHash, isAdmin) {
  try {
    const info = q('INSERT INTO users (name, name_key, pass_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)').run(
      name,
      key,
      passHash,
      isAdmin ? 1 : 0,
      Date.now(),
    );
    return Number(info.lastInsertRowid);
  } catch (err) {
    if (String(err?.message).includes('UNIQUE')) throw new HttpError(409, 'That name is already taken. Pick another.');
    throw err;
  }
}

function deleteUser(userId) {
  q('DELETE FROM users WHERE id = ?').run(userId);
  fs.rmSync(userPhotoDir(userId), { recursive: true, force: true });
}

function signIn(ctx, userId, name, isAdmin) {
  const token = auth.createSession(userId);
  ctx.res.setHeader('Set-Cookie', auth.sessionCookie(ctx.req, token));
  return { user: { id: userId, name, isAdmin } };
}

const userCount = () => q('SELECT COUNT(*) AS n FROM users').get().n;
const normalizeCode = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// ---- meals -------------------------------------------------------------------------------

const MEAL_COLUMNS = 'id, day, ts, name, calories, protein, carbs, fat, items, note, source, has_photo, meta';

function mealFromRow(row) {
  return {
    id: row.id,
    day: row.day,
    ts: row.ts,
    name: row.name,
    calories: row.calories,
    protein: row.protein,
    carbs: row.carbs,
    fat: row.fat,
    items: parseJson(row.items, []),
    note: row.note,
    source: row.source,
    photo: row.has_photo === 1,
    meta: parseJson(row.meta, {}),
  };
}

function mealsBetween(userId, from, to) {
  return q(`SELECT ${MEAL_COLUMNS} FROM meals WHERE user_id = ? AND day >= ? AND day <= ? ORDER BY ts`)
    .all(userId, from, to)
    .map(mealFromRow);
}

function sanitizeMeal(body) {
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 30).map((item) => ({
    name: text(item?.name, 80) || 'Food',
    portion: text(item?.portion, 40),
    grams: round(num(item?.grams, 0, 10000), 0),
    calories: round(num(item?.calories, 0, 30000), 0),
    protein: round(num(item?.protein, 0, 3000), 1),
    carbs: round(num(item?.carbs, 0, 3000), 1),
    fat: round(num(item?.fat, 0, 3000), 1),
    ...(item?.off ? { off: true } : {}),
  }));
  const meta = {};
  if (['low', 'medium', 'high'].includes(body.meta?.confidence)) meta.confidence = body.meta.confidence;
  if (body.meta?.notes) meta.notes = text(body.meta.notes, 200);
  if (body.meta?.portion) meta.portion = round(num(body.meta.portion, 0.1, 10, 1), 2);
  return {
    day: requireDay(body.day),
    ts: timestamp(body.ts),
    name: text(body.name, 80) || 'Meal',
    calories: round(num(body.calories, 0, 30000), 0),
    protein: round(num(body.protein, 0, 3000), 1),
    carbs: round(num(body.carbs, 0, 3000), 1),
    fat: round(num(body.fat, 0, 3000), 1),
    items,
    note: text(body.note, 500),
    source: ['photo', 'text', 'manual'].includes(body.source) ? body.source : 'manual',
    meta,
  };
}

function saveMeal(userId, id, meal, photo) {
  const existing = q('SELECT has_photo FROM meals WHERE user_id = ? AND id = ?').get(userId, id);
  if (photo) {
    fs.mkdirSync(userPhotoDir(userId), { recursive: true });
    fs.writeFileSync(photoPath(userId, id), photo);
  }
  const hasPhoto = photo || existing?.has_photo === 1 ? 1 : 0;
  q(
    `INSERT INTO meals (user_id, id, day, ts, name, calories, protein, carbs, fat, items, note, source, has_photo, meta, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, id) DO UPDATE SET
       day = excluded.day, ts = excluded.ts, name = excluded.name, calories = excluded.calories,
       protein = excluded.protein, carbs = excluded.carbs, fat = excluded.fat, items = excluded.items,
       note = excluded.note, source = excluded.source, has_photo = excluded.has_photo, meta = excluded.meta,
       updated_at = excluded.updated_at`,
  ).run(
    userId,
    id,
    meal.day,
    meal.ts,
    meal.name,
    meal.calories,
    meal.protein,
    meal.carbs,
    meal.fat,
    JSON.stringify(meal.items),
    meal.note,
    meal.source,
    hasPhoto,
    JSON.stringify(meal.meta),
    Date.now(),
  );
}

// ---- workouts ----------------------------------------------------------------------------

function sanitizeWorkout(body) {
  const startedAt = timestamp(body.startedAt);
  const exercises = (Array.isArray(body.exercises) ? body.exercises : [])
    .slice(0, 40)
    .filter((ex) => isExerciseId(ex?.exId))
    .map((ex) => ({
      exId: ex.exId,
      name: text(ex.name, 80) || 'Exercise',
      sets: (Array.isArray(ex.sets) ? ex.sets : []).slice(0, 40).map((set) => ({
        w: round(num(set?.w, 0, 2000), 3),
        r: Math.round(num(set?.r, 0, 2000)),
      })),
      ...(text(ex.note, 300) ? { note: text(ex.note, 300) } : {}),
    }))
    .filter((ex) => ex.sets.length > 0);
  return {
    day: requireDay(body.day),
    startedAt,
    finishedAt: Math.max(startedAt, timestamp(body.finishedAt)),
    name: text(body.name, 60) || 'Workout',
    routineId: text(body.routineId, 40),
    note: text(body.note, 500),
    warmup: Boolean(body.warmup),
    exercises,
  };
}

function saveWorkout(userId, id, workout) {
  let setCount = 0;
  let volume = 0;
  for (const ex of workout.exercises) {
    for (const set of ex.sets) {
      setCount += 1;
      volume += set.w * set.r;
    }
  }
  q(
    `INSERT INTO workouts (user_id, id, day, started_at, finished_at, name, data, set_count, volume, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, id) DO UPDATE SET
       day = excluded.day, started_at = excluded.started_at, finished_at = excluded.finished_at, name = excluded.name,
       data = excluded.data, set_count = excluded.set_count, volume = excluded.volume, updated_at = excluded.updated_at`,
  ).run(userId, id, workout.day, workout.startedAt, workout.finishedAt, workout.name, JSON.stringify(workout), setCount, volume, Date.now());

  q('DELETE FROM workout_sets WHERE user_id = ? AND workout_id = ?').run(userId, id);
  const insert = q(
    'INSERT INTO workout_sets (user_id, workout_id, ex_id, idx, weight, reps, started_at, day) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const ex of workout.exercises) {
    ex.sets.forEach((set, idx) => insert.run(userId, id, ex.exId, idx, set.w, set.r, workout.startedAt, workout.day));
  }
}

function workoutSummaries(userId, before, limit) {
  return q(
    `SELECT id, day, started_at, finished_at, name, set_count, volume,
            (SELECT COUNT(DISTINCT ex_id) FROM workout_sets s WHERE s.user_id = w.user_id AND s.workout_id = w.id) AS ex_count
       FROM workouts w
      WHERE user_id = ? AND started_at < ?
      ORDER BY started_at DESC LIMIT ?`,
  )
    .all(userId, before, limit)
    .map((row) => ({
      id: row.id,
      day: row.day,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      name: row.name,
      sets: row.set_count,
      volume: round(row.volume, 1),
      exercises: row.ex_count,
    }));
}

/** For every exercise the person has done: what they did last time, and their records. Weights in kg. */
function exerciseStats(userId) {
  const rows = q(
    `SELECT ex_id, workout_id, day, weight, reps FROM workout_sets
      WHERE user_id = ? ORDER BY ex_id, started_at DESC, idx`,
  ).all(userId);
  const stats = {};
  const seen = {};
  for (const row of rows) {
    let s = stats[row.ex_id];
    if (!s) {
      s = stats[row.ex_id] = { last: { day: row.day, sets: [] }, bestW: 0, bestE1: 0, bestReps: 0, n: 0 };
      seen[row.ex_id] = { lastId: row.workout_id, ids: new Set() };
    }
    const track = seen[row.ex_id];
    if (row.workout_id === track.lastId) s.last.sets.push([row.weight, row.reps]);
    track.ids.add(row.workout_id);
    if (row.weight > s.bestW) s.bestW = row.weight;
    if (row.reps > s.bestReps) s.bestReps = row.reps;
    const e1 = row.weight * (1 + row.reps / 30);
    if (e1 > s.bestE1) s.bestE1 = round(e1, 2);
  }
  for (const id of Object.keys(stats)) stats[id].n = seen[id].ids.size;
  return stats;
}

// ---- data export / import ----------------------------------------------------------------

const DOC_KEYS = ['profile', 'plan', 'custom'];

function exportData(user) {
  return {
    app: 'plate',
    version: 1,
    exportedAt: new Date().toISOString(),
    name: user.name,
    profile: getDoc(user.id, 'profile'),
    plan: getDoc(user.id, 'plan'),
    custom: getDoc(user.id, 'custom'),
    weights: q('SELECT day, kg FROM weights WHERE user_id = ? ORDER BY day').all(user.id),
    meals: q(`SELECT ${MEAL_COLUMNS} FROM meals WHERE user_id = ? ORDER BY ts`).all(user.id).map(mealFromRow),
    workouts: q('SELECT id, data FROM workouts WHERE user_id = ? ORDER BY started_at')
      .all(user.id)
      .map((row) => ({ id: row.id, ...parseJson(row.data, {}) })),
  };
}

function importData(userId, data) {
  if (data?.app !== 'plate') throw new HttpError(400, 'That file is not a Plate backup.');
  const counts = { meals: 0, workouts: 0, weights: 0 };
  tx(() => {
    for (const key of DOC_KEYS) {
      if (data[key] && typeof data[key] === 'object') putDoc(userId, key, data[key]);
    }
    for (const entry of Array.isArray(data.weights) ? data.weights : []) {
      if (!isDay(entry?.day)) continue;
      q('INSERT INTO weights (user_id, day, kg) VALUES (?, ?, ?) ON CONFLICT(user_id, day) DO UPDATE SET kg = excluded.kg').run(
        userId,
        entry.day,
        round(num(entry.kg, 20, 500, 70), 2),
      );
      counts.weights += 1;
    }
    for (const meal of Array.isArray(data.meals) ? data.meals : []) {
      if (!isId(meal?.id) || !isDay(meal?.day)) continue;
      saveMeal(userId, meal.id, sanitizeMeal(meal), null);
      counts.meals += 1;
    }
    for (const workout of Array.isArray(data.workouts) ? data.workouts : []) {
      if (!isId(workout?.id) || !isDay(workout?.day)) continue;
      saveWorkout(userId, workout.id, sanitizeWorkout(workout));
      counts.workouts += 1;
    }
  });
  return counts;
}

// ---- routes ------------------------------------------------------------------------------

const routes = [];

/** access: 'public' | 'user' (default) | 'admin'. */
function route(method, pattern, handler, { access = 'user', bodyLimit = 256 * KB } = {}) {
  const names = [];
  const source = pattern.replace(/:(\w+)/g, (_, name) => {
    names.push(name);
    return '([^/]+)';
  });
  routes.push({ method, regex: new RegExp(`^${source}$`), names, handler, access, bodyLimit });
}

// -- session

route('GET', '/api/state', ({ user }) => ({ version: VERSION, needsSetup: userCount() === 0, user: user ? publicUser(user) : null }), {
  access: 'public',
});

route(
  'POST',
  '/api/setup',
  async (ctx) => {
    const identity = requireName(ctx.body.name);
    const hash = await auth.hashPassword(requirePassword(ctx.body.password));
    // Checked again inside the transaction so two people can't both become the owner.
    const id = tx(() => {
      if (userCount() > 0) throw new HttpError(409, 'This app already has an owner. Sign in instead.');
      return insertUser(identity, hash, true);
    });
    if (!getSetting('invite')) setSetting('invite', auth.newInviteCode());
    return signIn(ctx, id, identity.name, true);
  },
  { access: 'public' },
);

route(
  'POST',
  '/api/login',
  async (ctx) => {
    const { key } = auth.normalizeName(ctx.body.name);
    const password = typeof ctx.body.password === 'string' ? ctx.body.password : '';
    // The tight limit (8 tries) is per name AND address, so a stranger who only knows someone's name cannot lock
    // that person out of their own account. A looser per-name cap still stops guessing spread across many addresses.
    const ip = clientIp(ctx.req);
    const wait =
      auth.rateLimit(`login-ip:${ip}`, 30, 15 * 60_000) ||
      auth.rateLimit(`login-pair:${key}:${ip}`, 8, 15 * 60_000) ||
      auth.rateLimit(`login-name:${key}`, 80, 15 * 60_000);
    if (wait) throw new HttpError(429, `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.`);

    const row = q('SELECT id, name, pass_hash, is_admin FROM users WHERE name_key = ?').get(key);
    // Hash even when the name is unknown, so response time doesn't reveal which names exist.
    const ok = await auth.verifyPassword(password, row?.pass_hash || 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
    if (!row || !ok) throw new HttpError(401, 'Wrong name or password.');
    return signIn(ctx, row.id, row.name, row.is_admin === 1);
  },
  { access: 'public' },
);

route(
  'POST',
  '/api/signup',
  async (ctx) => {
    const wait = auth.rateLimit(`signup-ip:${clientIp(ctx.req)}`, 10, 60 * 60_000);
    if (wait) throw new HttpError(429, 'Too many attempts. Try again later.');
    if (userCount() === 0) throw new HttpError(409, 'Set the app up first.');
    const invite = getSetting('invite');
    if (!invite) throw new HttpError(403, 'New accounts are switched off. Ask the owner for an invite.');
    if (normalizeCode(ctx.body.code) !== normalizeCode(invite)) throw new HttpError(403, 'That invite code is not right.');

    const identity = requireName(ctx.body.name);
    const hash = await auth.hashPassword(requirePassword(ctx.body.password));
    const id = insertUser(identity, hash, false);
    return signIn(ctx, id, identity.name, false);
  },
  { access: 'public' },
);

route('POST', '/api/logout', (ctx) => {
  auth.endSession(ctx.user.sessionHash);
  ctx.res.setHeader('Set-Cookie', auth.clearedCookie(ctx.req));
  return { ok: true };
});

// -- everything the app needs on launch, in one request

route('GET', '/api/bootstrap', ({ user, query }) => {
  const day = requireDay(query.get('day'));
  const config = ai.aiConfig();
  return {
    version: VERSION,
    user: publicUser(user),
    profile: getDoc(user.id, 'profile'),
    plan: getDoc(user.id, 'plan'),
    custom: getDoc(user.id, 'custom', []),
    meals: mealsBetween(user.id, day, day),
    weights: q('SELECT day, kg FROM weights WHERE user_id = ? ORDER BY day DESC LIMIT 400').all(user.id).reverse(),
    workouts: workoutSummaries(user.id, Number.MAX_SAFE_INTEGER, 40),
    stats: exerciseStats(user.id),
    ai: { ready: config.ready, provider: ai.PROVIDER_INFO[config.provider]?.label || 'Test' },
  };
});

route('PUT', '/api/docs/:key', ({ user, params, body }) => {
  if (!DOC_KEYS.includes(params.key)) throw new HttpError(404, 'Not found.');
  if (body.value === null || typeof body.value !== 'object') throw new HttpError(400, 'Nothing to save.');
  putDoc(user.id, params.key, body.value);
  return { ok: true };
}, { bodyLimit: 512 * KB });

// -- food

route('GET', '/api/meals', ({ user, query }) => {
  const from = requireDay(query.get('from'));
  const to = requireDay(query.get('to') || from);
  return { meals: mealsBetween(user.id, from, to) };
});

route('GET', '/api/days', ({ user, query }) => {
  const before = isDay(query.get('before')) ? query.get('before') : '9999-12-31';
  const limit = Math.round(num(query.get('limit'), 1, 120, 30));
  const days = q(
    `SELECT day, SUM(calories) AS calories, SUM(protein) AS protein, SUM(carbs) AS carbs, SUM(fat) AS fat, COUNT(*) AS meals
       FROM meals WHERE user_id = ? AND day < ? GROUP BY day ORDER BY day DESC LIMIT ?`,
  ).all(user.id, before, limit);
  return { days: days.map((d) => ({ ...d, protein: round(d.protein, 1), carbs: round(d.carbs, 1), fat: round(d.fat, 1) })) };
});

route(
  'PUT',
  '/api/meals/:id',
  ({ user, params, body }) => {
    const id = requireId(params.id);
    const meal = sanitizeMeal(body);
    saveMeal(user.id, id, meal, decodeJpeg(body.photo, 900 * KB));
    return { ok: true };
  },
  { bodyLimit: 2 * MB },
);

route('DELETE', '/api/meals/:id', ({ user, params }) => {
  const id = requireId(params.id);
  q('DELETE FROM meals WHERE user_id = ? AND id = ?').run(user.id, id);
  fs.rmSync(photoPath(user.id, id), { force: true });
  return { ok: true };
});

route('GET', '/api/meals/:id/photo', async ({ user, params, res }) => {
  const id = requireId(params.id);
  let data;
  try {
    data = await fs.promises.readFile(photoPath(user.id, id));
  } catch {
    throw new HttpError(404, 'No photo.');
  }
  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Content-Length': data.length,
    // A meal's photo never changes, so the phone can keep it.
    'Cache-Control': 'private, max-age=31536000, immutable',
  });
  res.end(data);
});

route(
  'POST',
  '/api/analyze',
  async ({ user, body }) => {
    if (auth.rateLimit(`ai:${user.id}`, 8, 60_000)) throw new HttpError(429, 'Slow down a little. Try again in a minute.');
    const today = new Date().toISOString().slice(0, 10);
    const used = q('SELECT count FROM ai_usage WHERE user_id = ? AND day = ?').get(user.id, today)?.count || 0;
    if (used >= AI_DAILY_LIMIT) throw new HttpError(429, `You've reached today's limit of ${AI_DAILY_LIMIT} AI estimates.`);

    const image = decodeJpeg(body.image, 4 * MB);
    const note = text(body.note, 600);
    const correction = text(body.correction, 600);
    if (!image && !note) throw new HttpError(400, 'Add a photo or describe the meal.');
    const previous = correction && body.previous && typeof body.previous === 'object' ? ai.normalizeEstimate(body.previous) : null;

    const estimate = await ai.estimateMeal({ imageBase64: image ? image.toString('base64') : null, note, previous, correction });
    q('INSERT INTO ai_usage (user_id, day, count) VALUES (?, ?, 1) ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1').run(
      user.id,
      today,
    );
    return { estimate };
  },
  { bodyLimit: 6 * MB },
);

// -- training

route('GET', '/api/workouts', ({ user, query }) => {
  const before = num(query.get('before'), 0, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  const limit = Math.round(num(query.get('limit'), 1, 100, 30));
  return { workouts: workoutSummaries(user.id, before, limit) };
});

route('GET', '/api/workouts/:id', ({ user, params }) => {
  const row = q('SELECT id, data FROM workouts WHERE user_id = ? AND id = ?').get(user.id, requireId(params.id));
  if (!row) throw new HttpError(404, 'That workout no longer exists.');
  return { workout: { id: row.id, ...parseJson(row.data, {}) } };
});

route(
  'PUT',
  '/api/workouts/:id',
  ({ user, params, body }) => {
    const id = requireId(params.id);
    const workout = sanitizeWorkout(body);
    tx(() => saveWorkout(user.id, id, workout));
    return { ok: true };
  },
  { bodyLimit: 512 * KB },
);

route('DELETE', '/api/workouts/:id', ({ user, params }) => {
  q('DELETE FROM workouts WHERE user_id = ? AND id = ?').run(user.id, requireId(params.id));
  return { ok: true };
});

route('GET', '/api/stats', ({ user }) => ({ stats: exerciseStats(user.id) }));

route('GET', '/api/exercises/:exId/history', ({ user, params, query }) => {
  if (!isExerciseId(params.exId)) throw new HttpError(400, 'Unknown exercise.');
  const limit = Math.round(num(query.get('limit'), 1, 60, 12));
  const rows = q(
    `SELECT workout_id, day, weight, reps FROM workout_sets
      WHERE user_id = ? AND ex_id = ?
        AND workout_id IN (SELECT workout_id FROM workout_sets WHERE user_id = ? AND ex_id = ?
                            GROUP BY workout_id ORDER BY MAX(started_at) DESC LIMIT ?)
      ORDER BY started_at DESC, idx`,
  ).all(user.id, params.exId, user.id, params.exId, limit);
  const sessions = [];
  for (const row of rows) {
    let session = sessions[sessions.length - 1];
    if (!session || session.id !== row.workout_id) sessions.push((session = { id: row.workout_id, day: row.day, sets: [] }));
    session.sets.push([row.weight, row.reps]);
  }
  return { sessions };
});

// -- body weight

route('PUT', '/api/weights/:day', ({ user, params, body }) => {
  const day = requireDay(params.day);
  const kg = Number(body.kg);
  if (!Number.isFinite(kg) || kg < 20 || kg > 500) throw new HttpError(400, 'That weight does not look right.');
  q('INSERT INTO weights (user_id, day, kg) VALUES (?, ?, ?) ON CONFLICT(user_id, day) DO UPDATE SET kg = excluded.kg').run(
    user.id,
    day,
    round(kg, 2),
  );
  return { ok: true };
});

route('DELETE', '/api/weights/:day', ({ user, params }) => {
  q('DELETE FROM weights WHERE user_id = ? AND day = ?').run(user.id, requireDay(params.day));
  return { ok: true };
});

// -- account

route('POST', '/api/account/name', ({ user, body }) => {
  const identity = requireName(body.name);
  try {
    q('UPDATE users SET name = ?, name_key = ? WHERE id = ?').run(identity.name, identity.key, user.id);
  } catch (err) {
    if (String(err?.message).includes('UNIQUE')) throw new HttpError(409, 'That name is already taken. Pick another.');
    throw err;
  }
  return { user: { ...publicUser(user), name: identity.name } };
});

route('POST', '/api/account/password', async ({ user, body }) => {
  const row = q('SELECT pass_hash FROM users WHERE id = ?').get(user.id);
  if (!(await auth.verifyPassword(String(body.current || ''), row.pass_hash))) {
    throw new HttpError(403, 'Your current password is not right.');
  }
  q('UPDATE users SET pass_hash = ? WHERE id = ?').run(await auth.hashPassword(requirePassword(body.next)), user.id);
  auth.endOtherSessions(user.id, user.sessionHash);
  return { ok: true };
});

route('POST', '/api/account/delete', async (ctx) => {
  const { user, body } = ctx;
  if (user.isAdmin) throw new HttpError(403, "The owner's account can't be deleted from inside the app.");
  const row = q('SELECT pass_hash FROM users WHERE id = ?').get(user.id);
  if (!(await auth.verifyPassword(String(body.password || ''), row.pass_hash))) {
    throw new HttpError(403, 'That password is not right.');
  }
  deleteUser(user.id);
  ctx.res.setHeader('Set-Cookie', auth.clearedCookie(ctx.req));
  return { ok: true };
});

route('GET', '/api/export', ({ user, res }) => {
  const body = JSON.stringify(exportData(user));
  const stamp = new Date().toISOString().slice(0, 10);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Content-Disposition': `attachment; filename="plate-backup-${stamp}.json"`,
    'Cache-Control': 'no-store',
  });
  res.end(body);
});

route('POST', '/api/import', ({ user, body }) => ({ imported: importData(user.id, body) }), { bodyLimit: 40 * MB });

// -- owner only

function adminView() {
  const config = ai.aiConfig();
  const providers = {};
  for (const id of ai.PROVIDERS) {
    const info = ai.PROVIDER_INFO[id];
    providers[id] = {
      label: info.label,
      model: config.models[id],
      defaultModel: info.defaultModel,
      suggested: info.suggested,
      key: ai.maskKey(config.keys[id]),
      keySource: config.keySource[id],
    };
  }
  const users = q(
    `SELECT u.id, u.name, u.is_admin, u.created_at,
            (SELECT COUNT(*) FROM meals m WHERE m.user_id = u.id) AS meals,
            (SELECT COUNT(*) FROM workouts w WHERE w.user_id = u.id) AS workouts
       FROM users u ORDER BY u.created_at`,
  ).all();
  return {
    ai: { provider: config.provider, ready: config.ready, providers, dailyLimit: AI_DAILY_LIMIT },
    invite: getSetting('invite'),
    users: users.map((u) => ({ id: u.id, name: u.name, isAdmin: u.is_admin === 1, createdAt: u.created_at, meals: u.meals, workouts: u.workouts })),
  };
}

route('GET', '/api/admin', adminView, { access: 'admin' });

route(
  'PUT',
  '/api/admin/ai',
  ({ body }) => {
    ai.saveAiConfig({ provider: body.provider, model: body.model, apiKey: body.apiKey });
    return adminView();
  },
  { access: 'admin' },
);

route('POST', '/api/admin/ai/test', () => ai.testConnection(), { access: 'admin' });

route('GET', '/api/admin/ai/models', ({ query }) => ai.listModels(query.get('provider')), { access: 'admin' });

route(
  'POST',
  '/api/admin/invite',
  ({ body }) => {
    setSetting('invite', body.action === 'disable' ? null : auth.newInviteCode());
    return adminView();
  },
  { access: 'admin' },
);

route(
  'POST',
  '/api/admin/users',
  async ({ body }) => {
    const identity = requireName(body.name);
    insertUser(identity, await auth.hashPassword(requirePassword(body.password)), false);
    return adminView();
  },
  { access: 'admin' },
);

route(
  'POST',
  '/api/admin/users/:id/password',
  async ({ params, body }) => {
    const id = Number(params.id);
    const hash = await auth.hashPassword(requirePassword(body.password));
    const info = Number.isInteger(id) ? q('UPDATE users SET pass_hash = ? WHERE id = ?').run(hash, id) : null;
    if (!info?.changes) throw new HttpError(404, 'That person no longer exists.');
    q('DELETE FROM sessions WHERE user_id = ?').run(id);
    return { ok: true };
  },
  { access: 'admin' },
);

route(
  'DELETE',
  '/api/admin/users/:id',
  ({ user, params }) => {
    const id = Number(params.id);
    if (id === user.id) throw new HttpError(400, "You can't remove yourself.");
    if (!Number.isInteger(id)) throw new HttpError(404, 'That person no longer exists.');
    deleteUser(id);
    return adminView();
  },
  { access: 'admin' },
);

// ---- dispatcher --------------------------------------------------------------------------

export async function handleApi(req, res, url) {
  let match = null;
  let params = {};
  for (const candidate of routes) {
    if (candidate.method !== req.method) continue;
    const found = candidate.regex.exec(url.pathname);
    if (!found) continue;
    match = candidate;
    try {
      params = Object.fromEntries(candidate.names.map((name, i) => [name, decodeURIComponent(found[i + 1])]));
    } catch {
      throw new HttpError(400, 'Malformed address.');
    }
    break;
  }
  if (!match) throw new HttpError(404, 'Not found.');

  const changesState = req.method !== 'GET' && req.method !== 'HEAD';
  // Browsers label requests that another site triggered; refuse those outright.
  if (changesState && req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site request blocked.');

  const user = auth.userFromRequest(req);
  if (match.access !== 'public' && !user) throw new HttpError(401, 'Please sign in.');
  if (match.access === 'admin' && !user.isAdmin) throw new HttpError(403, 'Only the owner can do that.');

  const hasBody = changesState && (Number(req.headers['content-length']) > 0 || req.headers['transfer-encoding']);
  const body = hasBody ? await readJson(req, match.bodyLimit) : {};

  const result = await match.handler({ req, res, user, params, query: url.searchParams, body });
  if (!res.writableEnded && result !== undefined) sendJson(res, 200, result);
}
