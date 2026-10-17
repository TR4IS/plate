// The exercise library (876 movements with photos), search, plan templates and the warm-up builder.
import { useEffect, useState } from './lib.js';
import { state } from './store.js';
import { uid } from './util.js';

let library = null;
let byId = new Map();
let loading = null;
let steps = null;

export function loadExercises() {
  if (!loading) {
    loading = fetch('/exercises/index.json')
      .then((res) => {
        if (!res.ok) throw new Error('library unavailable');
        return res.json();
      })
      .then((list) => {
        library = list;
        byId = new Map(list.map((ex) => [ex.id, ex]));
        return list;
      })
      .catch((err) => {
        loading = null;
        throw err;
      });
  }
  return loading;
}

/** True once the library is in memory; triggers the load and re-renders when it arrives. */
export function useExercises() {
  const [ready, setReady] = useState(Boolean(library));
  useEffect(() => {
    if (library) return;
    let alive = true;
    loadExercises()
      .then(() => alive && setReady(true))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return ready;
}

export const getExercise = (id) => byId.get(id) || (state.custom || []).find((ex) => ex.id === id) || null;

/** Name to show for an exercise id, falling back to what was stored when the library isn't loaded. */
export const exerciseName = (id, fallback) => getExercise(id)?.name || fallback || id.replaceAll('_', ' ');

/** frame: 0 (start position), 1 (end position) or 't' (square thumbnail). */
export const exerciseImage = (id, frame) => `/exercises/img/${id}/${frame}.webp`;

export async function loadSteps(id) {
  if (!steps) steps = await fetch('/exercises/steps.json').then((res) => res.json());
  return steps[id] || [];
}

// ---- labels ------------------------------------------------------------------------------

export const MUSCLE_LABEL = {
  abdominals: 'Abs',
  abductors: 'Outer thighs',
  adductors: 'Inner thighs',
  biceps: 'Biceps',
  calves: 'Calves',
  chest: 'Chest',
  forearms: 'Forearms',
  glutes: 'Glutes',
  hamstrings: 'Hamstrings',
  lats: 'Lats',
  'lower back': 'Lower back',
  'middle back': 'Mid back',
  neck: 'Neck',
  quadriceps: 'Quads',
  shoulders: 'Shoulders',
  traps: 'Traps',
  triceps: 'Triceps',
};

export const EQUIPMENT_LABEL = {
  barbell: 'Barbell',
  dumbbell: 'Dumbbell',
  cable: 'Cable',
  machine: 'Machine',
  'body only': 'Bodyweight',
  kettlebells: 'Kettlebell',
  bands: 'Band',
  'e-z curl bar': 'EZ bar',
  'medicine ball': 'Medicine ball',
  'exercise ball': 'Exercise ball',
  'foam roll': 'Foam roller',
  other: 'Other',
  none: 'No equipment',
};

export const GROUPS = [
  { id: 'chest', label: 'Chest', muscles: ['chest'] },
  { id: 'back', label: 'Back', muscles: ['lats', 'middle back', 'lower back', 'traps'] },
  { id: 'shoulders', label: 'Shoulders', muscles: ['shoulders'] },
  { id: 'biceps', label: 'Biceps', muscles: ['biceps'] },
  { id: 'triceps', label: 'Triceps', muscles: ['triceps'] },
  { id: 'legs', label: 'Legs', muscles: ['quadriceps', 'hamstrings', 'adductors', 'abductors'] },
  { id: 'glutes', label: 'Glutes', muscles: ['glutes'] },
  { id: 'calves', label: 'Calves', muscles: ['calves'] },
  { id: 'core', label: 'Core', muscles: ['abdominals'] },
  { id: 'forearms', label: 'Forearms', muscles: ['forearms'] },
  { id: 'stretch', label: 'Stretches', category: 'stretching' },
  { id: 'cardio', label: 'Cardio', category: 'cardio' },
  { id: 'mine', label: 'My own', custom: true },
];

export const muscleLabel = (muscle) => MUSCLE_LABEL[muscle] || muscle;
export const equipmentLabel = (ex) => EQUIPMENT_LABEL[ex?.eq] || 'Other';
export const exerciseSubtitle = (ex) => [muscleLabel(ex?.pm?.[0] || ''), equipmentLabel(ex)].filter(Boolean).join(' · ');

/** Exercises where the "weight" is extra load on top of your body (pull-ups, dips, push-ups). */
export const isBodyweight = (ex) => ex?.eq === 'body only' || ex?.eq === 'none';

/** The muscles a list of exercises mostly trains, most-used first: ["Chest", "Shoulders", "Triceps"]. */
export function focusOf(exerciseIds, limit = 3) {
  const counts = new Map();
  for (const id of exerciseIds) {
    const muscle = getExercise(id)?.pm?.[0];
    if (muscle) counts.set(muscle, (counts.get(muscle) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([muscle]) => muscleLabel(muscle));
}

// ---- search ------------------------------------------------------------------------------

const normalize = (textValue) =>
  String(textValue)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const CATEGORY_RANK = { strength: 0, powerlifting: 1, 'olympic weightlifting': 2, strongman: 3, plyometrics: 4, cardio: 5, stretching: 6 };

function searchKey(ex) {
  if (!ex._key) {
    const words = normalize(`${ex.name} ${ex.aka || ''} ${(ex.pm || []).map(muscleLabel).join(' ')} ${equipmentLabel(ex)}`);
    // The squashed copy lets "pullup" match "pull up" and "pull-up".
    Object.defineProperty(ex, '_key', { value: `${words} ${words.replaceAll(' ', '')}`, enumerable: false });
  }
  return ex._key;
}

/** Filtered, sorted exercises. With nothing typed, the popular lifts come first. */
export function searchExercises({ query = '', group = null } = {}) {
  let list = [...(state.custom || []), ...(library || [])];
  const chosen = GROUPS.find((g) => g.id === group);
  if (chosen?.custom) list = list.filter((ex) => ex.custom);
  else if (chosen?.category) list = list.filter((ex) => ex.cat === chosen.category);
  else if (chosen) list = list.filter((ex) => chosen.muscles.includes(ex.pm?.[0]));

  const tokens = normalize(query).split(' ').filter(Boolean);
  if (tokens.length) list = list.filter((ex) => tokens.every((token) => searchKey(ex).includes(token)));

  const phrase = normalize(query);
  const rank = (ex) => {
    const name = normalize(ex.name);
    const startsWith = phrase && name.startsWith(phrase) ? 0 : 1;
    return [startsWith, ex.custom ? 0 : 1, ex.pop || 999, CATEGORY_RANK[ex.cat] ?? 3];
  };
  return list
    .map((ex) => ({ ex, key: rank(ex) }))
    .sort((a, b) => {
      for (let i = 0; i < a.key.length; i++) if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
      return a.ex.name.localeCompare(b.ex.name);
    })
    .map((entry) => entry.ex);
}

// ---- plan templates ----------------------------------------------------------------------

/** Rest that suits the movement: big compound lifts need longer than single-joint work. */
export function defaultRest(ex, fallback = 90) {
  if (ex?.mech === 'compound') return Math.max(fallback, 120);
  if (ex?.mech === 'isolation') return Math.min(fallback, 75);
  return fallback;
}

const item = (exId, sets, repMin, repMax, restSec) => ({ exId, sets, repMin, repMax, restSec });

const ROUTINES = {
  'Push A': [
    item('Barbell_Bench_Press_-_Medium_Grip', 4, 6, 8, 150),
    item('Incline_Dumbbell_Press', 3, 8, 10, 120),
    item('Seated_Dumbbell_Press', 3, 8, 10, 120),
    item('Cable_Crossover', 3, 12, 15, 60),
    item('Side_Lateral_Raise', 3, 12, 15, 60),
    item('Triceps_Pushdown_-_Rope_Attachment', 3, 10, 12, 75),
  ],
  'Pull A': [
    item('Pullups', 4, 6, 10, 120),
    item('Bent_Over_Barbell_Row', 4, 6, 8, 150),
    item('Seated_Cable_Rows', 3, 10, 12, 90),
    item('Face_Pull', 3, 12, 15, 60),
    item('Barbell_Curl', 3, 8, 12, 75),
    item('Hammer_Curls', 3, 10, 12, 60),
  ],
  'Legs A': [
    item('Barbell_Squat', 4, 6, 8, 180),
    item('Romanian_Deadlift', 3, 8, 10, 150),
    item('Leg_Press', 3, 10, 12, 120),
    item('Leg_Extensions', 3, 12, 15, 75),
    item('Lying_Leg_Curls', 3, 10, 12, 75),
    item('Standing_Calf_Raises', 4, 10, 15, 60),
  ],
  'Push B': [
    item('Standing_Military_Press', 4, 6, 8, 150),
    item('Barbell_Incline_Bench_Press_-_Medium_Grip', 3, 8, 10, 120),
    item('Dumbbell_Bench_Press', 3, 8, 12, 120),
    item('Side_Lateral_Raise', 4, 12, 15, 60),
    item('Butterfly', 3, 12, 15, 60),
    item('Cable_Rope_Overhead_Triceps_Extension', 3, 10, 12, 75),
  ],
  'Pull B': [
    item('Barbell_Deadlift', 3, 5, 5, 180),
    item('Wide-Grip_Lat_Pulldown', 3, 8, 12, 90),
    item('One-Arm_Dumbbell_Row', 3, 8, 12, 90),
    item('Reverse_Flyes', 3, 12, 15, 60),
    item('Incline_Dumbbell_Curl', 3, 10, 12, 75),
    item('Dumbbell_Shrug', 3, 10, 12, 75),
  ],
  'Legs B': [
    item('Front_Barbell_Squat', 4, 6, 8, 180),
    item('Barbell_Hip_Thrust', 3, 8, 12, 120),
    item('Dumbbell_Lunges', 3, 10, 12, 90),
    item('Seated_Leg_Curl', 3, 10, 12, 75),
    item('Leg_Extensions', 3, 12, 15, 75),
    item('Seated_Calf_Raise', 4, 12, 15, 60),
  ],
  'Upper A': [
    item('Barbell_Bench_Press_-_Medium_Grip', 4, 6, 8, 150),
    item('Bent_Over_Barbell_Row', 4, 6, 8, 150),
    item('Seated_Dumbbell_Press', 3, 8, 10, 120),
    item('Wide-Grip_Lat_Pulldown', 3, 10, 12, 90),
    item('Barbell_Curl', 3, 10, 12, 75),
    item('Triceps_Pushdown_-_Rope_Attachment', 3, 10, 12, 75),
  ],
  'Lower A': [
    item('Barbell_Squat', 4, 6, 8, 180),
    item('Romanian_Deadlift', 3, 8, 10, 150),
    item('Leg_Press', 3, 10, 12, 120),
    item('Lying_Leg_Curls', 3, 10, 12, 75),
    item('Standing_Calf_Raises', 4, 10, 15, 60),
    item('Hanging_Leg_Raise', 3, 10, 15, 60),
  ],
  'Upper B': [
    item('Standing_Military_Press', 4, 6, 8, 150),
    item('Pullups', 4, 6, 10, 120),
    item('Incline_Dumbbell_Press', 3, 8, 10, 120),
    item('Seated_Cable_Rows', 3, 10, 12, 90),
    item('Side_Lateral_Raise', 3, 12, 15, 60),
    item('Face_Pull', 3, 12, 15, 60),
  ],
  'Lower B': [
    item('Barbell_Deadlift', 3, 5, 5, 180),
    item('Hack_Squat', 3, 8, 10, 150),
    item('Dumbbell_Lunges', 3, 10, 12, 90),
    item('Seated_Leg_Curl', 3, 10, 12, 75),
    item('Leg_Extensions', 3, 12, 15, 75),
    item('Seated_Calf_Raise', 4, 12, 15, 60),
  ],
  'Full body A': [
    item('Barbell_Squat', 3, 6, 8, 180),
    item('Barbell_Bench_Press_-_Medium_Grip', 3, 6, 8, 150),
    item('Bent_Over_Barbell_Row', 3, 8, 10, 120),
    item('Side_Lateral_Raise', 3, 12, 15, 60),
    item('Barbell_Curl', 2, 10, 12, 75),
    item('Crunches', 3, 15, 20, 45),
  ],
  'Full body B': [
    item('Barbell_Deadlift', 3, 5, 5, 180),
    item('Standing_Military_Press', 3, 6, 8, 150),
    item('Wide-Grip_Lat_Pulldown', 3, 8, 12, 90),
    item('Dumbbell_Lunges', 3, 10, 12, 90),
    item('Triceps_Pushdown_-_Rope_Attachment', 3, 10, 12, 75),
    item('Hanging_Leg_Raise', 3, 10, 15, 60),
  ],
  'Full body C': [
    item('Leg_Press', 3, 10, 12, 120),
    item('Incline_Dumbbell_Press', 3, 8, 10, 120),
    item('Seated_Cable_Rows', 3, 10, 12, 90),
    item('Romanian_Deadlift', 3, 8, 10, 150),
    item('Face_Pull', 3, 12, 15, 60),
    item('Hammer_Curls', 3, 10, 12, 60),
  ],
};

// `week` runs Monday to Sunday; null is a rest day. `as` renames a routine for that template.
export const TEMPLATES = [
  {
    id: 'ppl6',
    name: 'Push · Pull · Legs ×2',
    blurb: 'Six days a week. Every muscle twice.',
    week: ['Push A', 'Pull A', 'Legs A', 'Push B', 'Pull B', 'Legs B', null],
  },
  {
    id: 'ppl3',
    name: 'Push · Pull · Legs',
    blurb: 'Three days a week. The classic split.',
    week: ['Push A', null, 'Pull A', null, 'Legs A', null, null],
    as: { 'Push A': 'Push', 'Pull A': 'Pull', 'Legs A': 'Legs' },
  },
  {
    id: 'ul4',
    name: 'Upper · Lower',
    blurb: 'Four days a week. Balanced work and rest.',
    week: ['Upper A', 'Lower A', null, 'Upper B', 'Lower B', null, null],
  },
  {
    id: 'fb3',
    name: 'Full body',
    blurb: 'Three days a week. Best when time is short.',
    week: ['Full body A', null, 'Full body B', null, 'Full body C', null, null],
  },
];

export const templateLetters = (template) => template.week.map((name) => (name ? name[0] : ''));

export function planFromTemplate(template) {
  const ids = {};
  const routines = [];
  for (const source of template.week) {
    if (!source || ids[source]) continue;
    ids[source] = uid('r');
    routines.push({
      id: ids[source],
      name: template.as?.[source] || source,
      exercises: ROUTINES[source].map((entry) => ({ ...entry })),
    });
  }
  return { routines, schedule: template.week.map((source) => (source ? ids[source] : null)) };
}

export const emptyPlan = () => ({ routines: [], schedule: [null, null, null, null, null, null, null] });

export const routineById = (plan, id) => plan?.routines?.find((routine) => routine.id === id) || null;

// ---- warm-up -----------------------------------------------------------------------------

const WARMUP_CUE = {
  Arm_Circles: 'Arms out to the sides. Make slow circles, then reverse halfway.',
  Shoulder_Circles: 'Roll both shoulders forward, up, back and down. Reverse halfway.',
  Dynamic_Chest_Stretch: 'Arms straight in front, swing them wide open and back in.',
  Elbows_Back: 'Hands on your lower back, gently pull your elbows together.',
  Triceps_Stretch: 'Hand behind your head, pull the elbow gently. Swap arms halfway.',
  Wrist_Circles: 'Arms out, circle both wrists. Reverse halfway.',
  Dynamic_Back_Stretch: 'Swing straight arms up in front of you, a little higher each time.',
  Upper_Back_Stretch: 'Clasp your hands, reach forward and round your upper back.',
  One_Arm_Against_Wall: 'Forearm on a wall, lean in to open your lat. Swap sides halfway.',
  Cat_Stretch: 'On hands and knees, round your spine up and let your head drop.',
  Standing_Biceps_Stretch: 'Clasp your hands behind you, straighten your arms and lift.',
  Standing_Hip_Circles: 'Knee up to hip height, draw a big circle. Swap legs halfway.',
  Front_Leg_Raises: 'Hold a support and swing one leg forward and back. Swap halfway.',
  Side_Leg_Raises: 'Hold a support and swing one leg out to the side. Swap halfway.',
  Sit_Squats: 'Easy bodyweight squats, sitting back into your hips.',
  Kneeling_Hip_Flexor: 'Half-kneel and push your hips forward. Swap sides halfway.',
  Inchworm: 'Walk your hands out to a plank, then walk your feet up to them.',
  Ankle_Circles: 'Lift one foot and draw circles with your toes. Swap halfway.',
  Standing_Lateral_Stretch: 'One hand behind your head, lean to the other side. Swap halfway.',
};

const WARMUP_FOR = {
  chest: ['Dynamic_Chest_Stretch', 'Elbows_Back'],
  shoulders: ['Arm_Circles', 'Shoulder_Circles'],
  triceps: ['Triceps_Stretch'],
  biceps: ['Standing_Biceps_Stretch'],
  forearms: ['Wrist_Circles'],
  lats: ['Dynamic_Back_Stretch', 'One_Arm_Against_Wall'],
  'middle back': ['Upper_Back_Stretch'],
  traps: ['Shoulder_Circles'],
  'lower back': ['Cat_Stretch'],
  quadriceps: ['Sit_Squats', 'Kneeling_Hip_Flexor'],
  hamstrings: ['Front_Leg_Raises', 'Inchworm'],
  glutes: ['Standing_Hip_Circles'],
  abductors: ['Standing_Hip_Circles'],
  adductors: ['Side_Leg_Raises'],
  calves: ['Ankle_Circles'],
  abdominals: ['Standing_Lateral_Stretch'],
};

const UPPER = new Set(['chest', 'shoulders', 'triceps', 'biceps', 'forearms', 'lats', 'middle back', 'traps']);
const LOWER = new Set(['quadriceps', 'hamstrings', 'glutes', 'abductors', 'adductors', 'calves']);
const WARMUP_SIZE = 6;

/**
 * Pick about six warm-up moves for the muscles a workout trains: a general opener first,
 * then one move per muscle in order of how much work that muscle will get.
 */
export function buildWarmup(exerciseIds, secondsEach = 30) {
  const counts = new Map();
  for (const id of exerciseIds) {
    const ex = getExercise(id);
    for (const muscle of ex?.pm || []) counts.set(muscle, (counts.get(muscle) || 0) + 2);
    for (const muscle of ex?.sm || []) counts.set(muscle, (counts.get(muscle) || 0) + 1);
  }
  const muscles = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([muscle]) => muscle);

  const picked = [];
  const add = (id) => {
    if (id && !picked.includes(id) && picked.length < WARMUP_SIZE) picked.push(id);
  };
  if (muscles.some((m) => UPPER.has(m))) add('Arm_Circles');
  if (muscles.some((m) => LOWER.has(m))) add('Standing_Hip_Circles');
  // First pass takes each muscle's main move; a second pass fills any room left with alternates.
  for (const pass of [0, 1]) for (const muscle of muscles) add(WARMUP_FOR[muscle]?.[pass]);
  for (const fallback of ['Arm_Circles', 'Standing_Hip_Circles', 'Sit_Squats', 'Cat_Stretch']) {
    if (picked.length >= 4) break;
    add(fallback);
  }

  return picked.map((id) => ({
    exId: id,
    name: getExercise(id)?.name || id.replaceAll('_', ' '),
    cue: WARMUP_CUE[id] || '',
    sec: secondsEach,
  }));
}
