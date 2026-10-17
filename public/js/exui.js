// Exercise bits shared by the workout, session, plan and library screens.
import { exerciseImage, getExercise, isBodyweight } from './exercises.js';
import { html, useEffect, useState } from './lib.js';
import { Icon, cx } from './ui.js';
import { fmtNum, kgToUnit } from './util.js';

export function ExerciseThumb({ exId }) {
  const ex = getExercise(exId);
  if (!ex?.img) return html`<span class="ex-thumb blank"><${Icon} name="dumbbell" size="22" /></span>`;
  return html`<img class="ex-thumb" src=${exerciseImage(exId, 't')} alt="" loading="lazy" width="54" height="54" />`;
}

/**
 * The reference photos for an exercise. There are two (start and end of the movement);
 * with `animate` they alternate so the motion is easy to read at a glance.
 */
export function ExercisePhoto({ ex, animate = true, tag = true, class: className }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    setFrame(0);
    if (!animate || !ex?.img) return undefined;
    const timer = setInterval(() => setFrame((f) => 1 - f), 1500);
    return () => clearInterval(timer);
  }, [ex?.id, animate]);

  if (!ex?.img) {
    return html`<div class=${cx('ex-photo blank', className)}><${Icon} name="dumbbell" size="34" /></div>`;
  }
  return html`<div class=${cx('ex-photo', className)}>
    <img src=${exerciseImage(ex.id, 0)} alt=${`${ex.name}, starting position`} style=${{ opacity: frame === 0 ? 1 : 0 }} />
    <img src=${exerciseImage(ex.id, 1)} alt=${`${ex.name}, end position`} style=${{ opacity: frame === 1 ? 1 : 0 }} />
    ${tag && html`<span class="frame-tag">${frame === 0 ? 'Start' : 'Finish'}</span>`}
  </div>`;
}

export const repRange = (item) => (item.repMin === item.repMax ? `${item.repMin}` : `${item.repMin}–${item.repMax}`);

/** True for movements where zero weight means "just my body" (pull-ups, push-ups, planks). */
export const usesBodyweight = (exId) => isBodyweight(getExercise(exId));

/** A load in the person's unit. Zero reads as "Bodyweight" only for bodyweight movements. */
export function loadText(weight, unit, bodyweight = false) {
  if (weight > 0) return `${fmtNum(weight, 2)} ${unit}`;
  return bodyweight ? 'Bodyweight' : `0 ${unit}`;
}

/** Compact sets: "80 kg × 8 · 8 · 7" when the weight never changed, else "80×8 · 85×6". `sets` are [weight, reps]. */
export function setsText(sets, unit, bodyweight = false) {
  if (!sets?.length) return '';
  if (sets.every(([w]) => w === sets[0][0])) return `${loadText(sets[0][0], unit, bodyweight)} × ${sets.map(([, r]) => r).join(' · ')}`;
  return sets.map(([w, r]) => `${w > 0 || !bodyweight ? fmtNum(w, 2) : 'BW'}×${r}`).join(' · ');
}

/** What was done last time for an exercise (stored in kg), in the person's unit. Null without history. */
export function lastTimeText(stats, exId, unit) {
  const sets = stats[exId]?.last?.sets;
  if (!sets?.length) return null;
  return setsText(sets.map(([kg, reps]) => [Math.round(kgToUnit(kg, unit) * 100) / 100, reps]), unit, usesBodyweight(exId));
}

export function formatRest(seconds) {
  if (!seconds) return 'No rest';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m}:${String(s).padStart(2, '0')}` : `${m} min`;
}
