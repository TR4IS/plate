// ---- ids ---------------------------------------------------------------------------------

export function uid(prefix) {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${random}`;
}

// ---- dates (all "days" are the phone's local calendar date, YYYY-MM-DD) ------------------

const pad = (n) => String(n).padStart(2, '0');

export function dayStr(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function parseDay(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(day, count) {
  const date = parseDay(day);
  date.setDate(date.getDate() + count);
  return dayStr(date);
}

/** Monday = 0 ... Sunday = 6. */
export function weekdayIndex(day) {
  return (parseDay(day).getDay() + 6) % 7;
}

export function mondayOf(day) {
  return addDays(day, -weekdayIndex(day));
}

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const WEEKDAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const dateLongFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
const dateYearFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

/** "Today", "Yesterday", or "Wed 7 Oct" (with the year once it is not this year). */
export function fmtDay(day, today = dayStr()) {
  if (day === today) return 'Today';
  if (day === addDays(today, -1)) return 'Yesterday';
  if (day === addDays(today, 1)) return 'Tomorrow';
  const date = parseDay(day);
  return date.getFullYear() === parseDay(today).getFullYear() ? dateFmt.format(date) : dateYearFmt.format(date);
}

export const fmtDayLong = (day) => dateLongFmt.format(parseDay(day));
export const fmtTime = (ts) => timeFmt.format(new Date(ts));

/** 95 -> "1:35". For countdowns. */
export function fmtClock(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** 4320 -> "1 h 12 min". For summaries. */
export function fmtDuration(totalSeconds) {
  const minutes = Math.max(1, Math.round(totalSeconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)} h ${rest} min` : `${Math.floor(minutes / 60)} h`;
}

// ---- numbers and units -------------------------------------------------------------------

const intFmt = new Intl.NumberFormat();

export const fmtInt = (n) => intFmt.format(Math.round(n || 0));

/** Up to `places` decimals, without trailing zeros: 82.5, 80, 61.25. */
export function fmtNum(n, places = 1) {
  const factor = 10 ** places;
  return String(Math.round((n || 0) * factor) / factor);
}

export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

const LB_PER_KG = 2.2046226218;

export const weightUnit = (profile) => (profile?.units === 'imperial' ? 'lb' : 'kg');
export const kgToUnit = (kg, unit) => (unit === 'lb' ? kg * LB_PER_KG : kg);
export const unitToKg = (value, unit) => (unit === 'lb' ? value / LB_PER_KG : value);

/** A stored kilogram value shown in the person's unit: "82.5 kg" / "182 lb". */
export function fmtWeight(kg, unit, places = 2) {
  return `${fmtNum(kgToUnit(kg, unit), places)} ${unit}`;
}

export function cmToFeetInches(cm) {
  const totalInches = Math.round(cm / 2.54);
  return { feet: Math.floor(totalInches / 12), inches: totalInches % 12 };
}

export const feetInchesToCm = (feet, inches) => Math.round((feet * 12 + inches) * 2.54);

/** Text typed into a number field -> number, accepting a comma as the decimal mark. */
export function parseNumber(textValue) {
  const n = Number(String(textValue).replace(',', '.').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// ---- misc --------------------------------------------------------------------------------

export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export const sum = (list, pick) => list.reduce((total, item) => total + (pick(item) || 0), 0);

export function plural(count, word, many = `${word}s`) {
  return `${count} ${count === 1 ? word : many}`;
}

let hapticLabel = null;

/** A light tap on iPhones that support it (Safari fires one when a switch control toggles). */
export function haptic() {
  try {
    if (navigator.vibrate) {
      navigator.vibrate(10);
      return;
    }
    if (!hapticLabel) {
      hapticLabel = document.createElement('label');
      hapticLabel.className = 'haptic';
      hapticLabel.setAttribute('aria-hidden', 'true');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.setAttribute('switch', '');
      input.tabIndex = -1;
      hapticLabel.appendChild(input);
      document.body.appendChild(hapticLabel);
    }
    hapticLabel.click();
  } catch {
    /* feedback is a nicety; never let it break a tap */
  }
}

export const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
