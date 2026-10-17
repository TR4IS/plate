// End-to-end checks of the HTTP API against a real server process with a throwaway database.
// Run with: npm test
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 4300 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-test-'));
let server;

/** A tiny client that remembers its session cookie, like a browser would. */
function client() {
  let cookie = '';
  return async function call(method, url, body, headers = {}) {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.arrayBuffer();
    return { status: res.status, data, headers: res.headers };
  };
}

const fakeJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 7)]).toString('base64');
const owner = client();
const friend = client();

before(async () => {
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, AI_PROVIDER: 'mock', AI_DAILY_LIMIT: '5' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (chunk) => String(chunk).includes('is running') && resolve());
    server.on('exit', (code) => reject(new Error(`server exited early (${code})`)));
  });
});

after(async () => {
  // Wait for the process to let go of the database file before removing the folder (Windows needs this).
  const exited = new Promise((resolve) => server.once('exit', resolve));
  server.kill();
  await exited;
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('first visit asks for setup, and only one owner can be created', async () => {
  const state = await owner('GET', '/api/state');
  assert.equal(state.data.needsSetup, true);
  assert.equal(state.data.user, null);

  assert.equal((await owner('POST', '/api/setup', { name: 'Sam', password: 'short' })).status, 400);
  const created = await owner('POST', '/api/setup', { name: '  Sam  ', password: 'correct horse' });
  assert.equal(created.status, 200);
  assert.deepEqual(created.data.user, { id: 1, name: 'Sam', isAdmin: true });

  assert.equal((await client()('POST', '/api/setup', { name: 'Eve', password: 'another pass' })).status, 409);
  assert.equal((await owner('GET', '/api/state')).data.user.name, 'Sam');
});

test('signing in checks the password and ignores name case', async () => {
  const fresh = client();
  assert.equal((await fresh('POST', '/api/login', { name: 'sam', password: 'wrong password' })).status, 401);
  assert.equal((await fresh('GET', '/api/bootstrap?day=2026-10-09')).status, 401);
  assert.equal((await fresh('POST', '/api/login', { name: 'SAM', password: 'correct horse' })).status, 200);
  assert.equal((await fresh('GET', '/api/bootstrap?day=2026-10-09')).status, 200);
  assert.equal((await fresh('POST', '/api/logout')).status, 200);
  assert.equal((await fresh('GET', '/api/bootstrap?day=2026-10-09')).status, 401);
});

test('profile and plan documents are stored per person', async () => {
  const profile = { units: 'metric', targets: { calories: 2400, protein: 170, carbs: 250, fat: 75 } };
  assert.equal((await owner('PUT', '/api/docs/profile', { value: profile })).status, 200);
  assert.equal((await owner('PUT', '/api/docs/secrets', { value: {} })).status, 404);
  const boot = await owner('GET', '/api/bootstrap?day=2026-10-09');
  assert.deepEqual(boot.data.profile, profile);
  assert.equal(boot.data.plan, null);
  assert.deepEqual(boot.data.ai, { ready: true, provider: 'Test' });
});

test('meals can be saved with a photo, listed, summarised and deleted', async () => {
  const meal = {
    day: '2026-10-09',
    ts: Date.UTC(2026, 9, 9, 12, 30),
    name: 'Chicken rice bowl',
    calories: 551,
    protein: 52.3,
    carbs: 51,
    fat: 13.3,
    items: [{ name: 'Chicken', portion: '150 g', grams: 150, calories: 248, protein: 46.5, carbs: 0, fat: 5.4 }],
    source: 'photo',
    meta: { confidence: 'medium', notes: 'ok' },
    photo: fakeJpeg,
  };
  assert.equal((await owner('PUT', '/api/meals/meal_aaaa1111', meal)).status, 200);
  assert.equal((await owner('PUT', '/api/meals/meal_bbbb2222', { ...meal, photo: undefined, name: 'Oats', calories: 300, ts: meal.ts - 1 })).status, 200);
  assert.equal((await owner('PUT', '/api/meals/meal_cccc3333', { ...meal, photo: undefined, day: '2026-10-08' })).status, 200);
  assert.equal((await owner('PUT', '/api/meals/x', meal)).status, 400);
  assert.equal((await owner('PUT', '/api/meals/meal_dddd4444', { ...meal, photo: Buffer.alloc(300).toString('base64') })).status, 400);

  const today = await owner('GET', '/api/meals?from=2026-10-09');
  assert.deepEqual(today.data.meals.map((m) => m.name), ['Oats', 'Chicken rice bowl']);
  assert.equal(today.data.meals[1].photo, true);
  assert.equal(today.data.meals[1].items[0].name, 'Chicken');

  // Saving again without a photo keeps the one already stored.
  assert.equal((await owner('PUT', '/api/meals/meal_aaaa1111', { ...meal, photo: undefined, name: 'Edited' })).status, 200);
  const photo = await owner('GET', '/api/meals/meal_aaaa1111/photo');
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get('content-type'), 'image/jpeg');
  assert.equal(photo.data.byteLength, 404);

  const days = await owner('GET', '/api/days?limit=10');
  assert.deepEqual(days.data.days.map((d) => [d.day, d.calories, d.meals]), [['2026-10-09', 851, 2], ['2026-10-08', 551, 1]]);

  assert.equal((await owner('DELETE', '/api/meals/meal_aaaa1111')).status, 200);
  assert.equal((await owner('GET', '/api/meals/meal_aaaa1111/photo')).status, 404);
  assert.equal((await owner('GET', '/api/meals?from=2026-10-08&to=2026-10-09')).data.meals.length, 2);
});

test('the AI estimate endpoint validates input, applies corrections and enforces the daily limit', async () => {
  assert.equal((await owner('POST', '/api/analyze', {})).status, 400);
  assert.equal((await owner('POST', '/api/analyze', { image: 'bm90IGFuIGltYWdl' })).status, 400);

  const first = await owner('POST', '/api/analyze', { image: fakeJpeg, note: 'lunch' });
  assert.equal(first.status, 200);
  assert.equal(first.data.estimate.name, 'Chicken rice bowl');
  assert.equal(first.data.estimate.items.length, 3);
  assert.equal(first.data.estimate.calories, 551);
  assert.equal(first.data.estimate.protein, 52.3);

  const notFood = await owner('POST', '/api/analyze', { note: 'this is not food' });
  assert.equal(notFood.status, 422);
  assert.equal(notFood.data.code, 'not_food');

  const fixed = await owner('POST', '/api/analyze', { note: 'lunch', previous: first.data.estimate, correction: 'I ate double' });
  assert.equal(fixed.data.estimate.calories, 1102);

  // Limit is 5 a day in this test run; two successes so far, the refusal did not count.
  for (let i = 0; i < 3; i++) assert.equal((await owner('POST', '/api/analyze', { note: 'snack' })).status, 200);
  const blocked = await owner('POST', '/api/analyze', { note: 'snack' });
  assert.equal(blocked.status, 429);
});

test('workouts feed the history, last-time lookup and records', async () => {
  const workout = (startedAt, bench) => ({
    day: new Date(startedAt).toISOString().slice(0, 10),
    startedAt,
    finishedAt: startedAt + 55 * 60_000,
    name: 'Push A',
    routineId: 'r1',
    warmup: true,
    exercises: [
      { exId: 'Barbell_Bench_Press_-_Medium_Grip', name: 'Barbell Bench Press', sets: bench },
      { exId: 'Pushups', name: 'Push-Up', sets: [{ w: 0, r: 20 }] },
      { exId: 'Skipped_One', name: 'Skipped', sets: [] },
      { exId: 'bad id!', name: 'Bad', sets: [{ w: 1, r: 1 }] },
    ],
  });
  const t1 = Date.UTC(2026, 9, 5, 17);
  const t2 = Date.UTC(2026, 9, 8, 17);
  assert.equal((await owner('PUT', '/api/workouts/wk_first001', workout(t1, [{ w: 80, r: 8 }, { w: 80, r: 7 }]))).status, 200);
  assert.equal((await owner('PUT', '/api/workouts/wk_second02', workout(t2, [{ w: 82.5, r: 6 }, { w: 80, r: 8 }, { w: 80, r: 8 }]))).status, 200);
  // Saving the same workout twice (a retry after a dropped connection) must not duplicate its sets.
  assert.equal((await owner('PUT', '/api/workouts/wk_second02', workout(t2, [{ w: 82.5, r: 6 }, { w: 80, r: 8 }, { w: 80, r: 8 }]))).status, 200);

  const list = await owner('GET', '/api/workouts');
  assert.deepEqual(list.data.workouts.map((w) => [w.id, w.sets, w.exercises, w.volume]), [
    ['wk_second02', 4, 2, 82.5 * 6 + 80 * 16],
    ['wk_first001', 3, 2, 80 * 15],
  ]);

  const full = await owner('GET', '/api/workouts/wk_second02');
  assert.equal(full.data.workout.exercises.length, 2);
  assert.equal(full.data.workout.warmup, true);

  const { stats } = (await owner('GET', '/api/stats')).data;
  const bench = stats['Barbell_Bench_Press_-_Medium_Grip'];
  assert.deepEqual(bench.last, { day: '2026-10-08', sets: [[82.5, 6], [80, 8], [80, 8]] });
  assert.equal(bench.bestW, 82.5);
  assert.equal(bench.n, 2);
  assert.equal(bench.bestE1, Math.round(80 * (1 + 8 / 30) * 100) / 100);
  assert.equal(stats.Pushups.bestReps, 20);

  const history = await owner('GET', '/api/exercises/Barbell_Bench_Press_-_Medium_Grip/history');
  assert.deepEqual(history.data.sessions.map((s) => [s.day, s.sets.length]), [['2026-10-08', 3], ['2026-10-05', 2]]);

  assert.equal((await owner('DELETE', '/api/workouts/wk_second02')).status, 200);
  assert.equal((await owner('GET', '/api/stats')).data.stats['Barbell_Bench_Press_-_Medium_Grip'].last.day, '2026-10-05');
  assert.equal((await owner('GET', '/api/workouts/wk_second02')).status, 404);
});

test('body weight entries are one per day', async () => {
  assert.equal((await owner('PUT', '/api/weights/2026-10-08', { kg: 82.4 })).status, 200);
  assert.equal((await owner('PUT', '/api/weights/2026-10-09', { kg: 82.1 })).status, 200);
  assert.equal((await owner('PUT', '/api/weights/2026-10-09', { kg: 81.9 })).status, 200);
  assert.equal((await owner('PUT', '/api/weights/2026-10-09', { kg: 5 })).status, 400);
  const boot = await owner('GET', '/api/bootstrap?day=2026-10-09');
  assert.deepEqual(boot.data.weights, [{ day: '2026-10-08', kg: 82.4 }, { day: '2026-10-09', kg: 81.9 }]);
});

test('a second person joins with the invite code and sees only their own data', async () => {
  const admin = await owner('GET', '/api/admin');
  assert.equal(admin.status, 200);
  assert.match(admin.data.invite, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

  assert.equal((await friend('POST', '/api/signup', { name: 'Noor', password: 'long enough pw', code: 'WRONG' })).status, 403);
  assert.equal((await friend('POST', '/api/signup', { name: 'sam', password: 'long enough pw', code: admin.data.invite })).status, 409);
  const joined = await friend('POST', '/api/signup', { name: 'Noor', password: 'long enough pw', code: admin.data.invite.toLowerCase() });
  assert.equal(joined.status, 200);
  assert.equal(joined.data.user.isAdmin, false);

  const boot = await friend('GET', '/api/bootstrap?day=2026-10-09');
  assert.equal(boot.data.meals.length, 0);
  assert.equal(boot.data.profile, null);
  assert.deepEqual(boot.data.stats, {});
  assert.equal((await friend('GET', '/api/meals/meal_bbbb2222/photo')).status, 404);
  assert.equal((await friend('GET', '/api/workouts/wk_first001')).status, 404);
  assert.equal((await friend('GET', '/api/admin')).status, 403);
  assert.equal((await friend('PUT', '/api/admin/ai', { provider: 'openai' })).status, 403);
});

test('the owner manages the AI connection, invites and people', async () => {
  const saved = await owner('PUT', '/api/admin/ai', { provider: 'gemini', apiKey: 'AIzaSyTESTKEY1234567890', model: 'gemini-flash-latest' });
  assert.equal(saved.data.ai.provider, 'gemini');
  assert.equal(saved.data.ai.providers.gemini.key, 'AIza••••7890');
  assert.equal(saved.data.ai.providers.gemini.keySource, 'app');
  assert.equal(saved.data.ai.providers.anthropic.model, 'claude-opus-5-5');
  assert.equal(JSON.stringify(saved.data).includes('TESTKEY'), false);
  assert.equal((await owner('PUT', '/api/admin/ai', { provider: 'nope' })).status, 400);

  const rotated = await owner('POST', '/api/admin/invite', { action: 'rotate' });
  assert.notEqual(rotated.data.invite, null);
  const closed = await owner('POST', '/api/admin/invite', { action: 'disable' });
  assert.equal(closed.data.invite, null);
  assert.equal((await client()('POST', '/api/signup', { name: 'Late', password: 'long enough pw', code: rotated.data.invite })).status, 403);

  const withGuest = await owner('POST', '/api/admin/users', { name: 'Guest', password: 'guest password' });
  const guest = withGuest.data.users.find((u) => u.name === 'Guest');
  assert.ok(guest);
  const guestClient = client();
  assert.equal((await guestClient('POST', '/api/login', { name: 'guest', password: 'guest password' })).status, 200);
  assert.equal((await owner('POST', `/api/admin/users/${guest.id}/password`, { password: 'brand new pass' })).status, 200);
  assert.equal((await guestClient('GET', '/api/bootstrap?day=2026-10-09')).status, 401, 'old sessions end on reset');
  assert.equal((await owner('DELETE', `/api/admin/users/${guest.id}`)).status, 200);
  assert.equal((await client()('POST', '/api/login', { name: 'guest', password: 'brand new pass' })).status, 401);
  assert.equal((await owner('DELETE', '/api/admin/users/1')).status, 400);
});

test('a backup can be exported and restored into another account', async () => {
  const exported = await owner('GET', '/api/export');
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-disposition'), /plate-backup-\d{4}-\d{2}-\d{2}\.json/);
  assert.equal(exported.data.meals.length, 2);
  assert.equal(exported.data.workouts.length, 1);

  assert.equal((await friend('POST', '/api/import', { app: 'other' })).status, 400);
  const restored = await friend('POST', '/api/import', exported.data);
  assert.deepEqual(restored.data.imported, { meals: 2, workouts: 1, weights: 2 });
  const boot = await friend('GET', '/api/bootstrap?day=2026-10-09');
  assert.equal(boot.data.profile.targets.protein, 170);
  assert.equal(boot.data.workouts.length, 1);
  assert.equal(boot.data.stats.Pushups.bestReps, 20);
});

test('account changes: rename, change password, delete', async () => {
  assert.equal((await friend('POST', '/api/account/name', { name: 'Sam' })).status, 409);
  assert.equal((await friend('POST', '/api/account/name', { name: 'Noor A' })).data.user.name, 'Noor A');
  assert.equal((await friend('POST', '/api/account/password', { current: 'nope', next: 'another long pw' })).status, 403);
  assert.equal((await friend('POST', '/api/account/password', { current: 'long enough pw', next: 'another long pw' })).status, 200);
  assert.equal((await owner('POST', '/api/account/delete', { password: 'correct horse' })).status, 403);
  assert.equal((await friend('POST', '/api/account/delete', { password: 'another long pw' })).status, 200);
  assert.equal((await client()('POST', '/api/login', { name: 'noor a', password: 'another long pw' })).status, 401);
});

test('static files, the app shell fallback and safety headers', async () => {
  const anon = client();
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(home.headers.get('x-frame-options'), 'DENY');

  const deep = await fetch(`${base}/some/screen`);
  assert.equal(deep.status, 200);
  assert.match(deep.headers.get('content-type'), /text\/html/);

  assert.equal((await fetch(`${base}/missing.js`)).status, 404);
  assert.equal((await fetch(`${base}/..%2f..%2fpackage.json`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e/server/index.js`)).status, 404);
  assert.equal((await anon('GET', '/api/nope')).status, 404);

  const index = await fetch(`${base}/exercises/index.json`, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(index.status, 200);
  const etag = index.headers.get('etag');
  assert.equal((await fetch(`${base}/exercises/index.json`, { headers: { 'If-None-Match': etag } })).status, 304);

  // The service worker is generated: it must name every script the app loads, or offline launch breaks.
  const worker = await (await fetch(`${base}/sw.js`)).text();
  assert.doesNotMatch(worker, /__VERSION__|__SHELL__/);
  const scripts = fs
    .readdirSync(path.join(root, 'public/js'), { recursive: true })
    .map((file) => String(file).replaceAll('\\', '/'))
    .filter((file) => file.endsWith('.js'));
  assert.ok(scripts.length > 20);
  for (const script of scripts) assert.ok(worker.includes(`"/js/${script}"`), `sw.js does not cache /js/${script}`);
  for (const other of ['"/"', '"/css/app.css"', '"/exercises/index.json"', '"/exercises/steps.json"']) assert.ok(worker.includes(other));

  const blocked = await owner('POST', '/api/logout', null, { 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(blocked.status, 403);
  const notJson = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(notJson.status, 415);
});
