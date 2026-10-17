import { html, render } from './lib.js';
import { boot, openOverlay, resetHistory, setTab, state, useStore } from './store.js';
import { DialogHost, Icon, OverlayHost, Spinner, ToastHost, useNow } from './ui.js';
import { fmtClock } from './util.js';
import { loadExercises } from './exercises.js';
import './viewport.js';
import { AuthView } from './views/auth.js';
import { Onboarding } from './views/onboarding.js';
import { TodayTab } from './views/today.js';
import { WorkoutTab } from './views/workout.js';
import { HistoryTab } from './views/history.js';
import { SettingsTab } from './views/settings.js';
// These register the screens that open on top of the tabs.
import './views/capture.js';
import './views/meal.js';
import './views/session.js';
import './views/plan.js';
import './views/library.js';

const TABS = { today: TodayTab, workout: WorkoutTab, history: HistoryTab, settings: SettingsTab };

function TabButton({ id, icon, label, active }) {
  return html`<button class="tab" aria-current=${active ? 'page' : undefined} onClick=${() => setTab(id)}>
    <${Icon} name=${icon} size="24" stroke=${active ? 2.3 : 2} />
    <span>${label}</span>
  </button>`;
}

function TabBar({ tab }) {
  return html`<nav class="tabbar" aria-label="Main">
    <${TabButton} id="today" icon="today" label="Today" active=${tab === 'today'} />
    <${TabButton} id="workout" icon="dumbbell" label="Workout" active=${tab === 'workout'} />
    <button class="tab-camera" aria-label="Scan a meal" onClick=${() => openOverlay('capture')}>
      <${Icon} name="camera" size="26" />
    </button>
    <${TabButton} id="history" icon="history" label="History" active=${tab === 'history'} />
    <${TabButton} id="settings" icon="settings" label="Settings" active=${tab === 'settings'} />
  </nav>`;
}

/** Shown above the tab bar while a workout is running, so it is one tap away from anywhere. */
function ResumePill({ session }) {
  const now = useNow(1000);
  const label = session.phase === 'summary' ? 'Workout finished' : fmtClock((now - session.startedAt) / 1000);
  return html`<button class="resume-pill" onClick=${() => openOverlay('session')}>
    <i class="dot" />
    <span class="grow ellipsis"><b>${session.name}</b> <span class="num" style=${{ opacity: 0.7 }}> · ${label}</span></span>
    <span class="go">Resume</span>
  </button>`;
}

function OfflineScreen() {
  return html`<div class="auth" style=${{ justifyContent: 'center', alignItems: 'center', textAlign: 'center' }}>
    <${Icon} name="offline" size="40" />
    <h1 class="h2" style=${{ marginTop: '18px' }}>Can't reach Plate</h1>
    <p class="sub soft" style=${{ marginTop: '8px', maxWidth: '280px' }}>Check your connection, or that the server is running, then try again.</p>
    <button class="btn btn-primary" style=${{ marginTop: '24px' }} onClick=${() => location.reload()}>Try again</button>
  </div>`;
}

function App() {
  const s = useStore();
  if (s.phase === 'boot') return html`<div class="boot"><${Spinner} /></div>`;
  if (s.phase === 'offline') return html`<${OfflineScreen} />`;
  if (s.phase === 'auth') return html`<${AuthView} /><${ToastHost} />`;
  if (s.phase === 'onboarding') return html`<${Onboarding} /><${DialogHost} /><${ToastHost} />`;

  const Tab = TABS[s.tab] || TodayTab;
  const sessionOpen = s.overlays.some((overlay) => overlay.type === 'session');
  // While a screen or sheet is open, what lies underneath is out of reach for taps, focus and screen readers.
  return html`
    <div class="tabs" inert=${s.overlays.length > 0}>
      <${Tab} key=${s.tab} />
      ${s.session && !sessionOpen && html`<${ResumePill} session=${s.session} />`}
      <${TabBar} tab=${s.tab} />
    </div>
    <${OverlayHost} />
    <${DialogHost} />
    <${ToastHost} />
  `;
}

resetHistory();
render(html`<${App} />`, document.getElementById('app'));
boot();
// Warm the exercise library in the background so the Workout tab opens instantly.
loadExercises().catch(() => {});

if ('serviceWorker' in navigator && window.isSecureContext) {
  const hadWorker = Boolean(navigator.serviceWorker.controller);
  let updated = false;
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  // A new release was downloaded in the background. Switch to it the next time the app is
  // brought back to the front, as long as that would not interrupt a workout or an open screen.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    updated = hadWorker;
  });
  document.addEventListener('visibilitychange', () => {
    if (updated && document.visibilityState === 'visible' && !state.session && state.overlays.length === 0) location.reload();
  });
}
