// Plate demo: a stand-in for the server that runs inside the visitor's browser.
// Every request the app makes to /api/... is answered here from sample data kept in localStorage,
// so the public demo needs no account, stores nothing on a server and never calls a paid AI.
// Built into the site by tools/build_demo.mjs; the real app never loads this file.
(() => {
  const BASE = document.currentScript?.dataset.base || '/plate';
  const DB_KEY = 'plate-demo-db-v1';
  const USER = { id: 1, name: 'Demo', isAdmin: false };
  const realFetch = window.fetch.bind(window);

  // ---- helpers ---------------------------------------------------------------------------

  const pad = (n) => String(n).padStart(2, '0');
  const dayStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (day, n) => {
    const [y, m, d] = day.split('-').map(Number);
    return dayStr(new Date(y, m - 1, d + n));
  };
  const weekdayIndex = (day) => {
    const [y, m, d] = day.split('-').map(Number);
    return (new Date(y, m - 1, d).getDay() + 6) % 7; // Monday = 0
  };
  const at = (day, hour, minute = 0) => {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(y, m - 1, d, hour, minute).getTime();
  };
  const round = (n, places = 1) => Math.round(n * 10 ** places) / 10 ** places;
  const id = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  class DemoError extends Error {
    constructor(status, message, data) {
      super(message);
      this.status = status;
      this.data = data;
    }
  }

  // ---- food the demo knows -------------------------------------------------------------

  // Per portion: [name, portion, grams, kcal, protein, carbs, fat]
  const FOODS = {
    kabsa: ['Chicken kabsa rice', '1 plate', 350, 520, 22, 78, 13],
    chicken: ['Grilled chicken breast', '150 g', 150, 248, 46.5, 0, 5.4],
    rice: ['Steamed white rice', '1 cup', 160, 208, 4.3, 45, 0.4],
    salad: ['Mixed salad with olive oil', '1 bowl', 150, 110, 2, 8, 8],
    egg: ['Boiled eggs', '2 eggs', 100, 155, 12.6, 1.1, 10.6],
    eggs: ['Boiled eggs', '2 eggs', 100, 155, 12.6, 1.1, 10.6],
    oats: ['Oatmeal with milk', '1 bowl', 250, 300, 12, 48, 7],
    banana: ['Banana', '1 medium', 118, 105, 1.3, 27, 0.4],
    dates: ['Dates', '3 dates', 24, 70, 0.6, 18, 0],
    coffee: ['Arabic coffee', '2 cups', 120, 10, 0.3, 1.5, 0],
    latte: ['Latte', '1 medium', 350, 190, 12, 18, 7],
    shawarma: ['Chicken shawarma wrap', '1 wrap', 280, 560, 32, 48, 26],
    burger: ['Beef burger', '1 burger', 220, 540, 30, 40, 29],
    fries: ['French fries', '1 medium', 117, 365, 4, 48, 17],
    pizza: ['Pepperoni pizza', '2 slices', 220, 600, 26, 66, 26],
    pasta: ['Pasta with tomato sauce', '1 plate', 300, 420, 14, 78, 6],
    steak: ['Grilled beef steak', '200 g', 200, 500, 52, 0, 32],
    salmon: ['Baked salmon', '150 g', 150, 310, 34, 0, 19],
    yogurt: ['Greek yogurt', '1 cup', 200, 146, 20, 8, 4],
    protein: ['Protein shake', '1 scoop with water', 330, 120, 24, 3, 1.5],
    shake: ['Protein shake', '1 scoop with water', 330, 120, 24, 3, 1.5],
    bread: ['Arabic bread', '1 piece', 60, 165, 5.5, 33, 0.7],
    hummus: ['Hummus', '3 tbsp', 75, 125, 6, 11, 7],
    falafel: ['Falafel', '4 pieces', 68, 225, 9, 21, 12],
    foul: ['Ful medames', '1 bowl', 200, 220, 13, 30, 5],
    apple: ['Apple', '1 medium', 180, 95, 0.5, 25, 0.3],
    sandwich: ['Chicken sandwich', '1 sandwich', 200, 420, 28, 42, 14],
    sushi: ['Salmon sushi rolls', '8 pieces', 240, 380, 16, 60, 8],
    tuna: ['Tuna in water', '1 can', 120, 130, 29, 0, 1],
    milk: ['Milk', '1 glass', 250, 150, 8, 12, 8],
    toast: ['Toast', '2 slices', 60, 160, 5.5, 29, 2],
    butter: ['Butter', '1 tbsp', 14, 100, 0.1, 0, 11.5],
    cheese: ['Cheese', '2 slices', 40, 160, 10, 0.5, 13],
    juice: ['Orange juice', '1 glass', 250, 112, 1.7, 26, 0.5],
    scrambled: ['Scrambled eggs', '2 eggs', 120, 200, 13, 2, 15],
  };
  const food = (key, scale = 1, showScale = true) => {
    const [name, portion, grams, calories, protein, carbs, fat] = FOODS[key];
    return {
      name,
      portion: scale === 1 || !showScale ? portion : `${scale} × ${portion}`,
      grams: Math.round(grams * scale),
      calories: Math.round(calories * scale),
      protein: round(protein * scale),
      carbs: round(carbs * scale),
      fat: round(fat * scale),
    };
  };
  const totals = (items) => ({
    calories: Math.round(items.reduce((t, i) => t + i.calories, 0)),
    protein: round(items.reduce((t, i) => t + i.protein, 0)),
    carbs: round(items.reduce((t, i) => t + i.carbs, 0)),
    fat: round(items.reduce((t, i) => t + i.fat, 0)),
  });

  function estimate({ note, hasImage }) {
    const words = String(note || '').toLowerCase();
    const scale = /\b(double|two plates|large|big)\b/.test(words) ? 1.5 : /\b(small|half)\b/.test(words) ? 0.6 : 1;
    let keys = Object.keys(FOODS).filter((key) => new RegExp(`\\b${key}s?\\b`).test(words));
    // "chicken shawarma" is one wrap, not a chicken breast plus a wrap.
    const dishes = ['kabsa', 'shawarma', 'sandwich', 'burger', 'pizza', 'pasta', 'salad'];
    keys = keys.filter(
      (key) =>
        !(key === 'eggs' && keys.includes('egg')) &&
        !(key === 'shake' && keys.includes('protein')) &&
        !(['chicken', 'salmon', 'tuna'].includes(key) && keys.some((k) => dishes.includes(k) && k !== 'salad')),
    );
    if (keys.length === 0) {
      if (!hasImage && words.trim()) {
        throw new DemoError(422, "The demo only knows a few foods. Try words like chicken, rice, kabsa, eggs, salad, shawarma, pizza or dates.", {
          code: 'not_food',
        });
      }
      keys = ['kabsa', 'salad'];
    }
    const items = keys.slice(0, 6).map((key) => food(key, scale));
    const name = items.length === 1 ? items[0].name : `${items[0].name} and more`;
    return {
      name,
      items,
      ...totals(items),
      confidence: hasImage ? 'medium' : 'high',
      notes: 'Demo estimate made in your browser. The real app sends this to Claude, OpenAI or Gemini.',
    };
  }

  // ---- sample data ---------------------------------------------------------------------

  const DAY_MEALS = [
    [['Breakfast', 8, ['oats', 'banana', 'coffee']], ['Lunch', 13, ['kabsa', 'salad']], ['Snack', 17, ['protein', 'dates']], ['Dinner', 21, ['chicken', 'rice', 'salad']]],
    [['Breakfast', 8, ['foul', 'bread', 'egg']], ['Lunch', 14, ['shawarma']], ['Snack', 17, ['yogurt', 'apple']], ['Dinner', 21, ['salmon', 'rice', 'salad']]],
    [['Breakfast', 9, ['egg', 'bread', 'hummus']], ['Lunch', 13, ['chicken', 'rice', 'salad']], ['Snack', 18, ['protein', 'banana']], ['Dinner', 21, ['steak', 'salad']]],
    [['Breakfast', 8, ['yogurt', 'oats']], ['Lunch', 14, ['sandwich', 'apple']], ['Snack', 17, ['dates', 'latte']], ['Dinner', 20, ['pasta', 'tuna']]],
  ];

  // Starting working weights in kg; anything not listed uses 20 kg.
  const START_KG = {
    'Barbell_Bench_Press_-_Medium_Grip': 70, Incline_Dumbbell_Press: 24, Seated_Dumbbell_Press: 20, Cable_Crossover: 15,
    Side_Lateral_Raise: 9, 'Triceps_Pushdown_-_Rope_Attachment': 25, Pullups: 0, Bent_Over_Barbell_Row: 60,
    Seated_Cable_Rows: 55, Face_Pull: 20, Barbell_Curl: 30, Barbell_Squat: 90, Romanian_Deadlift: 80, Leg_Press: 160,
    Leg_Extensions: 45, Lying_Leg_Curls: 35, Standing_Calf_Raises: 60, Standing_Military_Press: 45,
    'Barbell_Incline_Bench_Press_-_Medium_Grip': 60, Dumbbell_Bench_Press: 28, Butterfly: 45,
    Cable_Rope_Overhead_Triceps_Extension: 20, Barbell_Deadlift: 120, 'Wide-Grip_Lat_Pulldown': 55,
    'One-Arm_Dumbbell_Row': 30, Reverse_Flyes: 8, Incline_Dumbbell_Curl: 12, Dumbbell_Shrug: 30,
    Front_Barbell_Squat: 70, Barbell_Hip_Thrust: 100, Dumbbell_Lunges: 18, Seated_Leg_Curl: 40, Seated_Calf_Raise: 40,
  };

  async function seed() {
    const [{ TEMPLATES, planFromTemplate }, { ACTIVITY, GOALS, suggestTargets }] = await Promise.all([
      import(`${BASE}/js/exercises.js`),
      import(`${BASE}/js/nutrition.js`),
    ]);
    const library = await realFetch(`${BASE}/exercises/index.json`).then((res) => res.json()).catch(() => []);
    const names = new Map(library.map((ex) => [ex.id, ex.name]));

    const goal = (GOALS.find((g) => /cut|lose/i.test(g.id)) || GOALS[0]).id;
    const activity = (ACTIVITY.find((a) => /moder/i.test(a.id)) || ACTIVITY[2] || ACTIVITY[0]).id;
    const form = { units: 'metric', sex: 'male', age: 22, heightCm: 178, weightKg: 78, goal, activity };
    const profile = {
      ...form,
      targets: suggestTargets(form),
      autoTargets: true,
      restSec: 90,
      warmup: true,
      warmupSec: 30,
      sound: false,
      theme: 'auto',
      onboarded: true,
    };
    const plan = planFromTemplate(TEMPLATES.find((t) => t.id === 'ppl6') || TEMPLATES[0]);

    const today = dayStr();
    const meals = [];
    const workouts = [];
    const weights = [];
    const DAYS = 28;
    for (let back = DAYS; back >= 0; back--) {
      const day = addDays(today, -back);
      const menu = DAY_MEALS[back % DAY_MEALS.length];
      const isToday = back === 0;
      menu.forEach(([name, hour, keys], i) => {
        if (isToday && i > 1) return; // leave room in today's targets for the visitor to log something
        // Portions vary a little from day to day so the history doesn't repeat itself.
        const portion = [1, 1.25, 0.8, 1, 1.15, 0.9, 1.3][(back * 3 + i) % 7];
        const items = keys.map((key, k) => food(key, k === 0 ? portion : 1, false));
        meals.push({
          id: id('m'),
          day,
          ts: at(day, hour, (back * 7) % 50),
          name,
          ...totals(items),
          items,
          note: '',
          source: i === 1 ? 'photo' : 'text',
          photo: false,
          meta: { confidence: 'high' },
        });
      });
      if (back % 2 === 0 || back < 4) weights.push({ day, kg: round(79.4 - (DAYS - back) * 0.06 + ((back * 37) % 5) * 0.08, 1) });

      const routine = plan.schedule[weekdayIndex(day)] && plan.routines.find((r) => r.id === plan.schedule[weekdayIndex(day)]);
      if (!routine || isToday) continue;
      const weeksIn = Math.floor((DAYS - back) / 7);
      const startedAt = at(day, 18, 5);
      const exercises = routine.exercises.map((entry) => {
        const base = START_KG[entry.exId] ?? 20;
        const w = base === 0 ? 0 : round(base + weeksIn * (base >= 60 ? 2.5 : 1), 1);
        const sets = Array.from({ length: entry.sets }, (_, s) => ({ w, r: Math.max(entry.repMin, entry.repMax - s - ((back + s) % 2)) }));
        return { exId: entry.exId, name: names.get(entry.exId) || entry.exId.replaceAll('_', ' '), sets };
      });
      const setCount = exercises.reduce((t, ex) => t + ex.sets.length, 0);
      workouts.push({
        id: id('w'),
        day,
        startedAt,
        finishedAt: startedAt + (setCount * 2.6 + 6) * 60_000,
        name: routine.name,
        routineId: routine.id,
        note: '',
        warmup: true,
        exercises,
      });
    }
    return { v: 1, profile, plan, custom: [], meals, workouts, weights, photos: {} };
  }

  // ---- storage -------------------------------------------------------------------------

  let db = null;
  async function load() {
    if (db) return db;
    try {
      db = JSON.parse(localStorage.getItem(DB_KEY) || 'null');
    } catch {
      db = null;
    }
    if (!db || db.v !== 1) {
      db = await seed();
      save();
    }
    return db;
  }
  function save() {
    try {
      localStorage.setItem(DB_KEY, JSON.stringify(db));
    } catch {
      // Out of room: photos are the big part, keep the newest two and try again.
      const keep = Object.keys(db.photos).slice(-2);
      db.photos = Object.fromEntries(keep.map((k) => [k, db.photos[k]]));
      try {
        localStorage.setItem(DB_KEY, JSON.stringify(db));
      } catch {
        /* the demo keeps working in memory */
      }
    }
  }

  // ---- what the server would answer ----------------------------------------------------

  const withPhoto = (meal) => (db.photos[meal.id] ? { ...meal, photo: true, localPhoto: db.photos[meal.id] } : meal);
  const mealsBetween = (from, to) =>
    db.meals.filter((m) => m.day >= from && m.day <= to).sort((a, b) => a.ts - b.ts).map(withPhoto);

  function summaries(before, limit) {
    return db.workouts
      .filter((w) => w.startedAt < before)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit)
      .map((w) => ({
        id: w.id,
        day: w.day,
        startedAt: w.startedAt,
        finishedAt: w.finishedAt,
        name: w.name,
        sets: w.exercises.reduce((t, ex) => t + ex.sets.length, 0),
        volume: round(w.exercises.reduce((t, ex) => t + ex.sets.reduce((s, set) => s + set.w * set.r, 0), 0), 1),
        exercises: new Set(w.exercises.map((ex) => ex.exId)).size,
      }));
  }

  function stats() {
    const out = {};
    const sorted = [...db.workouts].sort((a, b) => b.startedAt - a.startedAt);
    for (const w of sorted) {
      for (const ex of w.exercises) {
        let s = out[ex.exId];
        if (!s) s = out[ex.exId] = { last: { day: w.day, sets: ex.sets.map((set) => [set.w, set.r]) }, bestW: 0, bestE1: 0, bestReps: 0, n: 0, ids: new Set() };
        s.ids.add(w.id);
        for (const set of ex.sets) {
          s.bestW = Math.max(s.bestW, set.w);
          s.bestReps = Math.max(s.bestReps, set.r);
          s.bestE1 = Math.max(s.bestE1, round(set.w * (1 + set.r / 30), 2));
        }
      }
    }
    for (const key of Object.keys(out)) {
      out[key].n = out[key].ids.size;
      delete out[key].ids;
    }
    return out;
  }

  const notInDemo = () => {
    throw new DemoError(403, "That isn't available in the demo.");
  };

  async function handle(method, path, query, body) {
    await load();
    let m;
    if (method === 'GET' && path === '/api/state') return { version: 'demo', needsSetup: false, user: USER };
    if (method === 'POST' && path === '/api/logout') {
      // Signing out of the demo starts it over with fresh sample data.
      for (const key of Object.keys(localStorage)) if (key.startsWith('plate')) localStorage.removeItem(key);
      db = null;
      setTimeout(() => location.reload(), 50);
      return { ok: true };
    }
    if (method === 'POST' && /^\/api\/(login|setup|signup)$/.test(path)) return { user: USER };
    if (method === 'GET' && path === '/api/bootstrap') {
      const day = query.get('day') || dayStr();
      return {
        version: 'demo',
        user: USER,
        profile: db.profile,
        plan: db.plan,
        custom: db.custom,
        meals: mealsBetween(day, day),
        weights: [...db.weights].sort((a, b) => (a.day < b.day ? -1 : 1)),
        workouts: summaries(Number.MAX_SAFE_INTEGER, 40),
        stats: stats(),
        ai: { ready: true, provider: 'Demo' },
      };
    }
    if (method === 'PUT' && (m = path.match(/^\/api\/docs\/(profile|plan|custom)$/))) {
      db[m[1]] = body.value;
      save();
      return { ok: true };
    }
    if (method === 'GET' && path === '/api/meals') {
      const from = query.get('from');
      return { meals: mealsBetween(from, query.get('to') || from) };
    }
    if (method === 'GET' && path === '/api/days') {
      const before = query.get('before') || '9999-12-31';
      const limit = Number(query.get('limit')) || 30;
      const byDay = new Map();
      for (const meal of db.meals) {
        if (meal.day >= before) continue;
        const d = byDay.get(meal.day) || { day: meal.day, calories: 0, protein: 0, carbs: 0, fat: 0, meals: 0 };
        d.calories += meal.calories;
        d.protein += meal.protein;
        d.carbs += meal.carbs;
        d.fat += meal.fat;
        d.meals += 1;
        byDay.set(meal.day, d);
      }
      const days = [...byDay.values()]
        .sort((a, b) => (a.day < b.day ? 1 : -1))
        .slice(0, limit)
        .map((d) => ({ ...d, protein: round(d.protein), carbs: round(d.carbs), fat: round(d.fat) }));
      return { days };
    }
    if ((m = path.match(/^\/api\/meals\/([^/]+)$/))) {
      if (method === 'DELETE') {
        db.meals = db.meals.filter((meal) => meal.id !== m[1]);
        delete db.photos[m[1]];
        save();
        return { ok: true };
      }
      if (method === 'PUT') {
        const { photo, hadPhoto, ...meal } = body;
        if (typeof photo === 'string' && photo) {
          db.photos[m[1]] = photo.startsWith('data:') ? photo : `data:image/jpeg;base64,${photo}`;
          const keys = Object.keys(db.photos);
          if (keys.length > 8) delete db.photos[keys[0]];
        }
        db.meals = db.meals.filter((x) => x.id !== m[1]);
        db.meals.push({ ...meal, id: m[1], photo: Boolean(db.photos[m[1]]), items: meal.items || [], meta: meal.meta || {} });
        save();
        return { ok: true };
      }
    }
    if (method === 'POST' && path === '/api/analyze') {
      await wait(900 + Math.random() * 600);
      const hasImage = Boolean(body.image);
      const text = [body.note, body.correction].filter(Boolean).join(' ');
      return { estimate: estimate({ note: text, hasImage }) };
    }
    if (method === 'GET' && path === '/api/workouts') {
      const before = Number(query.get('before')) || Number.MAX_SAFE_INTEGER;
      return { workouts: summaries(before, Number(query.get('limit')) || 30) };
    }
    if ((m = path.match(/^\/api\/workouts\/([^/]+)$/))) {
      if (method === 'GET') {
        const workout = db.workouts.find((w) => w.id === m[1]);
        if (!workout) throw new DemoError(404, 'That workout no longer exists.');
        return { workout };
      }
      if (method === 'PUT') {
        db.workouts = db.workouts.filter((w) => w.id !== m[1]);
        db.workouts.push({ ...body, id: m[1], exercises: (body.exercises || []).filter((ex) => ex.sets?.length) });
        save();
        return { ok: true };
      }
      if (method === 'DELETE') {
        db.workouts = db.workouts.filter((w) => w.id !== m[1]);
        save();
        return { ok: true };
      }
    }
    if (method === 'GET' && path === '/api/stats') return { stats: stats() };
    if (method === 'GET' && (m = path.match(/^\/api\/exercises\/([^/]+)\/history$/))) {
      const exId = decodeURIComponent(m[1]);
      const limit = Number(query.get('limit')) || 12;
      const sessions = [...db.workouts]
        .sort((a, b) => b.startedAt - a.startedAt)
        .filter((w) => w.exercises.some((ex) => ex.exId === exId))
        .slice(0, limit)
        .map((w) => ({ id: w.id, day: w.day, sets: w.exercises.filter((ex) => ex.exId === exId).flatMap((ex) => ex.sets.map((s) => [s.w, s.r])) }));
      return { sessions };
    }
    if ((m = path.match(/^\/api\/weights\/(\d{4}-\d{2}-\d{2})$/))) {
      db.weights = db.weights.filter((w) => w.day !== m[1]);
      if (method === 'PUT') db.weights.push({ day: m[1], kg: round(Number(body.kg), 2) });
      save();
      return { ok: true };
    }
    if (method === 'POST' && path === '/api/account/name') {
      const name = String(body.name || '').trim().slice(0, 24);
      if (name.length < 2) throw new DemoError(400, 'Names need 2 to 24 characters.');
      USER.name = name;
      return { user: { ...USER } };
    }
    if (method === 'GET' && path === '/api/export') {
      return { app: 'plate', version: 1, exportedAt: new Date().toISOString(), name: USER.name, profile: db.profile, plan: db.plan, custom: db.custom, weights: db.weights, meals: db.meals, workouts: db.workouts };
    }
    return notInDemo();
  }

  // ---- hook into fetch -----------------------------------------------------------------

  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);
    const method = (init.method || 'GET').toUpperCase();
    let body = {};
    try {
      body = init.body ? JSON.parse(init.body) : {};
    } catch {
      body = {};
    }
    const headers = { 'Content-Type': 'application/json' };
    try {
      const data = await handle(method, url.pathname, url.searchParams, body);
      if (url.pathname === '/api/export') headers['Content-Disposition'] = `attachment; filename="plate-demo-${dayStr()}.json"`;
      return new Response(JSON.stringify(data), { status: 200, headers });
    } catch (err) {
      const status = err instanceof DemoError ? err.status : 500;
      if (!(err instanceof DemoError)) console.error('[plate demo]', err);
      return new Response(JSON.stringify({ error: err.message || 'Something went wrong in the demo.', ...(err.data || {}) }), { status, headers });
    }
  };
})();
