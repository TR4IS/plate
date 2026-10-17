// Timer sounds and keeping the screen on during a workout.
import { state } from './store.js';

let context = null;

/** Browsers only allow sound after a tap, so call this from a tap handler before any timer starts. */
export function unlockAudio() {
  try {
    context = context || new (window.AudioContext || window.webkitAudioContext)();
    if (context.state === 'suspended') context.resume();
  } catch {
    context = null;
  }
}

function tone(frequency, startAt, duration, volume = 0.22) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(volume, startAt + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + duration + 0.05);
}

/** 'done' = two rising notes (timer finished), 'tick' = one short note (moving on). */
export function chime(kind = 'done') {
  if (!context || state.profile?.sound === false) return;
  try {
    const now = context.currentTime;
    if (kind === 'tick') {
      tone(660, now, 0.16, 0.16);
    } else {
      tone(784, now, 0.2);
      tone(1047, now + 0.19, 0.34);
    }
  } catch {
    /* sound is a nicety */
  }
}

let wakeLock = null;
let wanted = false;

async function acquire() {
  try {
    if (wanted && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    }
  } catch {
    wakeLock = null;
  }
}

/** Keep the phone from dimming while training. The lock is dropped by the system when you leave the app. */
export function keepAwake(on) {
  wanted = on;
  if (on) acquire();
  else if (wakeLock) wakeLock.release().catch(() => {});
}

document.addEventListener('visibilitychange', acquire);
