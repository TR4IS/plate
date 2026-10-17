// Daily calorie and macro targets from body measurements.

export const ACTIVITY = [
  { id: 'sedentary', label: 'Mostly sitting', hint: 'Desk job, little exercise', factor: 1.2 },
  { id: 'light', label: 'Lightly active', hint: '1 to 3 workouts a week', factor: 1.375 },
  { id: 'moderate', label: 'Active', hint: '3 to 5 workouts a week', factor: 1.55 },
  { id: 'very', label: 'Very active', hint: '6 or more hard workouts a week', factor: 1.725 },
];

export const GOALS = [
  { id: 'lose', label: 'Lose fat', hint: 'Eat a little under what you burn', shift: -0.2, proteinPerKg: 2.0 },
  { id: 'maintain', label: 'Stay the same', hint: 'Eat what you burn', shift: 0, proteinPerKg: 1.6 },
  { id: 'gain', label: 'Build muscle', hint: 'Eat a little over what you burn', shift: 0.1, proteinPerKg: 1.8 },
];

export const DEFAULT_TARGETS = { calories: 2200, protein: 140, carbs: 250, fat: 70 };

const roundTo = (n, step) => Math.round(n / step) * step;

/**
 * Suggested daily targets.
 * Energy: Mifflin-St Jeor resting rate x activity factor, shifted for the goal.
 * Protein scales with body weight, fat is a quarter of calories, carbohydrate takes the rest.
 */
export function suggestTargets({ sex, age, heightCm, weightKg, activity, goal }) {
  if (!age || !heightCm || !weightKg) return { ...DEFAULT_TARGETS };
  const resting = 10 * weightKg + 6.25 * heightCm - 5 * age + (sex === 'female' ? -161 : 5);
  const factor = ACTIVITY.find((a) => a.id === activity)?.factor || 1.375;
  const plan = GOALS.find((g) => g.id === goal) || GOALS[1];

  const floor = sex === 'female' ? 1200 : 1500;
  const calories = Math.max(floor, roundTo(resting * factor * (1 + plan.shift), 10));
  const protein = Math.min(240, roundTo(weightKg * plan.proteinPerKg, 5));
  const fat = Math.max(roundTo(weightKg * 0.6, 5), roundTo((calories * 0.25) / 9, 5));
  const carbs = Math.max(50, roundTo((calories - protein * 4 - fat * 9) / 4, 5));
  return { calories, protein, carbs, fat };
}

export const targetsOf = (profile) => ({ ...DEFAULT_TARGETS, ...(profile?.targets || {}) });

export function totalsOf(meals) {
  const totals = { calories: 0, protein: 0, carbs: 0, fat: 0 };
  for (const meal of meals) {
    totals.calories += meal.calories || 0;
    totals.protein += meal.protein || 0;
    totals.carbs += meal.carbs || 0;
    totals.fat += meal.fat || 0;
  }
  return totals;
}
