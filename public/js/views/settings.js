// Settings and everything reachable from it: goals, body weight, training preferences,
// the owner's server settings (AI, people), backups and the account.
import { api } from '../api.js';
import { html, useEffect, useRef, useState } from '../lib.js';
import { ACTIVITY, GOALS, suggestTargets, targetsOf } from '../nutrition.js';
import { closeOverlay, deleteWeight, errorText, logWeight, logout, openOverlay, refresh, saveProfile, set, toast, useStore } from '../store.js';
import { Empty, Field, Icon, NumberInput, Row, Screen, Segmented, Sheet, Spinner, Stepper, Toggle, confirmDialog, cx, registerOverlay } from '../ui.js';
import { cmToFeetInches, dayStr, fmtDay, fmtInt, fmtNum, kgToUnit, parseDay, plural, unitToKg, weightUnit } from '../util.js';
import { HeightInput } from './onboarding.js';

/** Save profile changes; when targets are automatic, recompute them from the new numbers. */
function saveWithTargets(profile, changes) {
  const next = { ...profile, ...changes };
  saveProfile(next.autoTargets !== false ? { ...changes, targets: suggestTargets(next) } : changes);
}

const heightText = (profile) => {
  if (!profile.heightCm) return '';
  if (profile.units !== 'imperial') return `${Math.round(profile.heightCm)} cm`;
  const { feet, inches } = cmToFeetInches(profile.heightCm);
  return `${feet}′ ${inches}″`;
};

export function SettingsTab() {
  const s = useStore();
  const profile = s.profile || {};
  const unit = weightUnit(profile);
  const targets = targetsOf(profile);
  const weightKg = s.weights.length ? s.weights[s.weights.length - 1].kg : profile.weightKg;
  const trainingDays = (s.plan?.schedule || []).filter(Boolean).length;

  const signOut = async () => {
    const yes = await confirmDialog({
      title: 'Sign out?',
      message: s.session ? 'The workout in progress on this phone will be discarded.' : '',
      confirm: 'Sign out',
    });
    if (yes) logout();
  };

  return html`<div class="page">
    <header class="page-head"><h1 class="h1">Settings</h1></header>
    <div class="stack">
      <button class="mini-card" onClick=${() => openOverlay('account')}>
        <span class="avatar" style=${{ background: 'var(--ink)', color: 'var(--on-ink)', margin: 0 }}>${(s.user?.name || '?')[0].toUpperCase()}</span>
        <span class="grow">
          <span class="strong ellipsis" style=${{ display: 'block' }}>${s.user?.name}</span>
          <span class="small muted" style=${{ display: 'block' }}>${s.user?.isAdmin ? 'Owner of this server' : 'Account and password'}</span>
        </span>
        <${Icon} name="right" size="18" class="muted" />
      </button>

      <div class="section-title">Goals</div>
      <div class="list">
        <${Row} icon="target" title="Daily targets" value=${`${fmtInt(targets.calories)} kcal`} onClick=${() => openOverlay('targets')} />
        <${Row} icon="scale" title="Body weight" value=${weightKg ? `${fmtNum(kgToUnit(weightKg, unit), 1)} ${unit}` : 'Add'} onClick=${() => openOverlay('weight')} />
        <${Row} icon="user" title="About you" value=${[profile.age && `${profile.age} y`, heightText(profile)].filter(Boolean).join(' · ')} onClick=${() => openOverlay('body')} />
      </div>

      <div class="section-title">Training</div>
      <div class="list">
        <${Row} icon="calendar" title="Training plan" value=${trainingDays ? `${trainingDays} days a week` : 'Not set'} onClick=${() => openOverlay(trainingDays ? 'plan' : 'templates')} />
        <${Row} icon="book" title="Exercise library" onClick=${() => openOverlay('library')} />
        <${Row} icon="timer" title="Workout preferences" onClick=${() => openOverlay('trainingPrefs')} />
      </div>

      <div class="section-title">App</div>
      <div class="list">
        <div class="row has-icon">
          <span class="row-icon"><${Icon} name="palette" size="18" /></span>
          <span class="grow">Appearance</span>
          <${Segmented}
            value=${profile.theme || 'auto'}
            onChange=${(theme) => saveProfile({ theme })}
            options=${[
              { value: 'auto', label: 'Auto' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </div>
        <div class="row has-icon">
          <span class="row-icon"><${Icon} name="ruler" size="18" /></span>
          <span class="grow">Units</span>
          <${Segmented}
            value=${profile.units || 'metric'}
            onChange=${(units) => saveProfile({ units, weightStep: undefined })}
            options=${[
              { value: 'metric', label: 'kg · cm' },
              { value: 'imperial', label: 'lb · ft' },
            ]}
          />
        </div>
        <${Row} icon="squarePlus" title="Add to Home Screen" onClick=${() => openOverlay('install')} />
      </div>

      ${s.user?.isAdmin &&
      html`<div class="section-title">This server</div>
        <div class="list">
          <${Row} icon="sparkles" title="AI connection" value=${s.ai.ready ? s.ai.provider : 'Not connected'} onClick=${() => openOverlay('aiSettings')} />
          <${Row} icon="users" title="People" onClick=${() => openOverlay('people')} />
        </div>`}

      <div class="section-title">Your data</div>
      <div class="list">
        <${Row} icon="download" title="Backup and restore" onClick=${() => openOverlay('backup')} />
      </div>

      <div class="list"><${Row} icon="logout" title="Sign out" onClick=${signOut} chevron=${false} /></div>
      <p class="small muted center" style=${{ marginTop: '4px' }}>Plate ${s.version}</p>
    </div>
  </div>`;
}

// ---- goals -------------------------------------------------------------------------------

function TargetsSheet() {
  const s = useStore();
  const profile = s.profile || {};
  const targets = targetsOf(profile);
  const auto = profile.autoTargets !== false;
  const edit = (field) => (value) => saveProfile({ autoTargets: false, targets: { ...targets, [field]: Math.round(value) } });
  const fromMacros = targets.protein * 4 + targets.carbs * 4 + targets.fat * 9;

  return html`<${Sheet} title="Daily targets">
    <div class="stack">
      <${Field} label="Goal">
        <${Segmented}
          value=${profile.goal || 'maintain'}
          onChange=${(goal) => saveWithTargets(profile, { goal })}
          options=${GOALS.map((g) => ({ value: g.id, label: g.label }))}
        />
      <//>
      <${Field} label="Activity">
        <select class="input" value=${profile.activity || 'light'} onChange=${(event) => saveWithTargets(profile, { activity: event.target.value })}>
          ${ACTIVITY.map((a) => html`<option value=${a.id}>${a.label} (${a.hint.toLowerCase()})</option>`)}
        </select>
      <//>

      <div class="row-between" style=${{ padding: '4px 4px 0' }}>
        <span>
          <span class="strong" style=${{ display: 'block' }}>Work them out for me</span>
          <span class="small muted" style=${{ display: 'block' }}>From your weight, height, age, activity and goal</span>
        </span>
        <${Toggle}
          checked=${auto}
          label="Work the targets out automatically"
          onChange=${(on) => saveProfile(on ? { autoTargets: true, targets: suggestTargets(profile) } : { autoTargets: false })}
        />
      </div>

      <${Field} label="Calories">
        <${NumberInput} value=${targets.calories} unit="kcal" places=${0} max=${10000} ariaLabel="Calories" onChange=${edit('calories')} />
      <//>
      <div style=${{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
        <${Field} label="Protein"><${NumberInput} value=${targets.protein} unit="g" places=${0} max=${600} ariaLabel="Protein" onChange=${edit('protein')} /><//>
        <${Field} label="Carbs"><${NumberInput} value=${targets.carbs} unit="g" places=${0} max=${1500} ariaLabel="Carbs" onChange=${edit('carbs')} /><//>
        <${Field} label="Fat"><${NumberInput} value=${targets.fat} unit="g" places=${0} max=${500} ariaLabel="Fat" onChange=${edit('fat')} /><//>
      </div>
      <p class="small muted" style=${{ padding: '0 4px' }}>
        ${auto ? 'Type a number to set your own target instead.' : `Your macros add up to ${fmtInt(fromMacros)} kcal.`}
      </p>
    </div>
  <//>`;
}

function BodySheet() {
  const s = useStore();
  const profile = s.profile || {};
  return html`<${Sheet} title="About you">
    <div class="stack">
      <${Segmented}
        value=${profile.sex || 'male'}
        onChange=${(sex) => saveWithTargets(profile, { sex })}
        options=${[
          { value: 'male', label: 'Male' },
          { value: 'female', label: 'Female' },
        ]}
      />
      <${Field} label="Age">
        <${NumberInput} value=${profile.age} unit="years" places=${0} max=${110} ariaLabel="Age" onChange=${(age) => saveWithTargets(profile, { age })} />
      <//>
      <${Field} label="Height">
        <${HeightInput} units=${profile.units} cm=${profile.heightCm} onChange=${(heightCm) => saveWithTargets(profile, { heightCm })} />
      <//>
      <p class="small muted" style=${{ padding: '0 4px' }}>Used only to work out your calorie and protein targets.</p>
    </div>
  <//>`;
}

// ---- body weight -------------------------------------------------------------------------

/**
 * Weight over time. Drag across it to read any day; the list below holds the same numbers.
 * The marker is an HTML element so it stays round while the SVG stretches to the card's width.
 */
function WeightChart({ entries, unit }) {
  const [hover, setHover] = useState(null);
  const svgRef = useRef(null);
  const W = 320;
  const H = 120;
  const padX = 8;
  const padTop = 12;
  const padBottom = 10;

  const times = entries.map((e) => parseDay(e.day).getTime());
  const values = entries.map((e) => kgToUnit(e.kg, unit));
  const t0 = times[0];
  const span = Math.max(1, times[times.length - 1] - t0);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const range = Math.max(high - low, 0.5);
  const x = (i) => padX + ((times[i] - t0) / span) * (W - padX * 2);
  const y = (i) => padTop + (1 - (values[i] - low) / range) * (H - padTop - padBottom);

  const line = entries.map((_, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(i).toFixed(1)}`).join('');
  const area = `${line}L${x(entries.length - 1).toFixed(1)} ${H}L${x(0).toFixed(1)} ${H}Z`;
  const shown = hover ?? entries.length - 1;

  const pick = (event) => {
    const box = svgRef.current.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * W;
    let nearest = 0;
    for (let i = 1; i < entries.length; i++) if (Math.abs(x(i) - px) < Math.abs(x(nearest) - px)) nearest = i;
    setHover(nearest);
  };

  return html`<div>
    <div class="stat">
      <div class="k">${fmtDay(entries[shown].day)}</div>
      <div class="v">${fmtNum(values[shown], 1)}<small>${unit}</small></div>
    </div>
    <div class="spark-wrap">
      <svg
        ref=${svgRef}
        class="spark"
        viewBox=${`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label=${`Body weight from ${fmtDay(entries[0].day)} to ${fmtDay(entries[entries.length - 1].day)}`}
        onPointerDown=${pick}
        onPointerMove=${pick}
        onPointerLeave=${() => setHover(null)}
        onPointerUp=${() => setHover(null)}
      >
        <path class="area" d=${area} />
        <path class="line" d=${line} vector-effect="non-scaling-stroke" />
        ${hover !== null && html`<line class="cursor" x1=${x(shown)} x2=${x(shown)} y1="0" y2=${H} vector-effect="non-scaling-stroke" />`}
      </svg>
      <i class="spark-dot" style=${{ left: `${(x(shown) / W) * 100}%`, top: `${(y(shown) / H) * 100}%` }} />
    </div>
  </div>`;
}

function WeightScreen() {
  const s = useStore();
  const unit = weightUnit(s.profile);
  const entries = s.weights;
  const latest = entries.length ? entries[entries.length - 1] : null;
  const [value, setValue] = useState(() => Math.round(kgToUnit(latest?.kg || s.profile?.weightKg || 75, unit) * 10) / 10);
  const today = dayStr();
  const loggedToday = latest?.day === today;

  const save = () => {
    const profile = s.profile || {};
    const kg = Math.round(unitToKg(value, unit) * 100) / 100;
    logWeight(kg, today);
    if (profile.autoTargets !== false) saveProfile({ targets: suggestTargets({ ...profile, weightKg: kg }) });
    toast('Weight saved', 'good');
  };

  const remove = async (entry) => {
    const yes = await confirmDialog({ title: 'Delete this entry?', message: fmtDay(entry.day), confirm: 'Delete', danger: true });
    if (yes) deleteWeight(entry.day);
  };

  const recent = entries.slice(-120);
  const first = recent[0];
  const change = latest && first && first !== latest ? kgToUnit(latest.kg - first.kg, unit) : null;

  return html`<${Screen} title="Body weight">
    <div class="stack">
      <section class="card">
        <${Stepper} label=${loggedToday ? "Today's weight" : 'Log your weight today'} unit=${unit} value=${value} step=${0.1} min=${20} max=${700} places=${1} onChange=${setValue} />
        <button class="btn btn-primary btn-block" style=${{ marginTop: '14px' }} onClick=${save}>${loggedToday ? 'Update' : 'Save'}</button>
      </section>

      ${recent.length >= 2 &&
      html`<section class="card">
        <${WeightChart} entries=${recent} unit=${unit} />
        ${change !== null &&
        html`<p class="small muted num" style=${{ marginTop: '10px' }}>
          ${change === 0 ? 'No change' : `${change > 0 ? '+' : '−'}${fmtNum(Math.abs(change), 1)} ${unit}`} since ${fmtDay(first.day)}
        </p>`}
      </section>`}

      ${entries.length > 0 &&
      html`<div class="section-title">Entries</div>
        <div class="list">
          ${[...entries]
            .reverse()
            .slice(0, 60)
            .map(
              (entry) =>
                html`<div class="row" key=${entry.day}>
                  <span class="grow">${fmtDay(entry.day)}</span>
                  <span class="row-value num" style=${{ color: 'var(--ink)' }}>${fmtNum(kgToUnit(entry.kg, unit), 1)} ${unit}</span>
                  <button class="icon-btn" style=${{ marginRight: '-10px' }} onClick=${() => remove(entry)} aria-label=${`Delete ${fmtDay(entry.day)}`}>
                    <${Icon} name="trash" size="18" class="muted" />
                  </button>
                </div>`,
            )}
        </div>`}
    </div>
  <//>`;
}

// ---- training preferences ----------------------------------------------------------------

function TrainingPrefsSheet() {
  const s = useStore();
  const profile = s.profile || {};
  const unit = weightUnit(profile);
  const steps = unit === 'lb' ? [2.5, 5, 10] : [1, 2.5, 5];
  const step = profile.weightStep || (unit === 'lb' ? 5 : 2.5);

  return html`<${Sheet} title="Workout preferences">
    <div class="stack">
      <div class="row-between" style=${{ padding: '0 4px' }}>
        <span>
          <span class="strong" style=${{ display: 'block' }}>Warm-up first</span>
          <span class="small muted" style=${{ display: 'block' }}>A few guided moves for the muscles you are about to train</span>
        </span>
        <${Toggle} checked=${profile.warmup !== false} label="Warm-up first" onChange=${(warmup) => saveProfile({ warmup })} />
      </div>
      ${profile.warmup !== false &&
      html`<${Field} label="Seconds per warm-up move">
        <${Segmented}
          value=${profile.warmupSec || 30}
          onChange=${(warmupSec) => saveProfile({ warmupSec })}
          options=${[20, 30, 45].map((n) => ({ value: n, label: `${n} s` }))}
        />
      <//>`}
      <${Field} label=${`The + and − buttons change weight by`}>
        <${Segmented} value=${step} onChange=${(weightStep) => saveProfile({ weightStep })} options=${steps.map((n) => ({ value: n, label: `${n} ${unit}` }))} />
      <//>
      <${Stepper}
        label="Rest for exercises you add"
        unit="seconds"
        value=${profile.restSec || 90}
        step=${15}
        min=${0}
        max=${600}
        places=${0}
        compact
        onChange=${(restSec) => saveProfile({ restSec })}
      />
      <div class="row-between" style=${{ padding: '0 4px' }}>
        <span>
          <span class="strong" style=${{ display: 'block' }}>Timer sounds</span>
          <span class="small muted" style=${{ display: 'block' }}>A chime when rest or a warm-up move ends</span>
        </span>
        <${Toggle} checked=${profile.sound !== false} label="Timer sounds" onChange=${(sound) => saveProfile({ sound })} />
      </div>
      <p class="small muted" style=${{ padding: '0 4px' }}>iPhones play the chime only when the ring switch is on.</p>
    </div>
  <//>`;
}

function InstallSheet() {
  return html`<${Sheet} title="Add to Home Screen">
    <div class="stack">
      <p class="sub soft">Plate opens full screen, like an app, when you start it from your Home Screen.</p>
      <ol class="steps">
        <li><span>Open this page in <b>Safari</b>.</span></li>
        <li><span>Tap the <b>Share</b> button at the bottom of the screen.</span></li>
        <li><span>Scroll down and choose <b>Add to Home Screen</b>, then tap <b>Add</b>.</span></li>
        <li><span>Open <b>Plate</b> from your Home Screen and sign in once.</span></li>
      </ol>
      <div class="note">
        <${Icon} name="camera" size="20" />
        <span>The first time you scan a meal, allow camera access. To stop iPhone asking each time: Settings › Apps › Safari › Camera › Allow.</span>
      </div>
    </div>
  <//>`;
}

// ---- account -----------------------------------------------------------------------------

function AccountSheet() {
  const s = useStore();
  const [name, setName] = useState(s.user?.name || '');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const run = async (label, task) => {
    setBusy(label);
    setError('');
    try {
      await task();
    } catch (err) {
      setError(errorText(err));
    }
    setBusy('');
  };

  const rename = () =>
    run('name', async () => {
      const data = await api('POST', '/api/account/name', { name });
      set({ user: data.user });
      toast('Name changed', 'good');
    });

  const changePassword = () =>
    run('password', async () => {
      await api('POST', '/api/account/password', { current, next });
      setCurrent('');
      setNext('');
      toast('Password changed', 'good');
    });

  const removeAccount = async () => {
    const yes = await confirmDialog({
      title: 'Delete your account?',
      message: 'All your meals, workouts and settings on this server will be erased. This cannot be undone.',
      confirm: 'Delete everything',
      danger: true,
    });
    if (!yes) return;
    run('delete', async () => {
      await api('POST', '/api/account/delete', { password: current });
      logout();
    });
  };

  return html`<${Sheet} title="Account">
    <div class="stack">
      <${Field} label="Name" hint="This is also what you type to sign in.">
        <input class="input" autocomplete="username" value=${name} onInput=${(event) => setName(event.target.value)} />
      <//>
      ${name.trim() !== s.user?.name &&
      html`<button class="btn btn-secondary btn-block" onClick=${rename} disabled=${busy === 'name' || name.trim().length < 2}>Save name</button>`}

      <div class="section-title" style=${{ padding: 0 }}>Change password</div>
      <input
        class="input"
        type="password"
        autocomplete="current-password"
        placeholder="Current password"
        value=${current}
        onInput=${(event) => setCurrent(event.target.value)}
      />
      <input
        class="input"
        type="password"
        autocomplete="new-password"
        placeholder="New password (at least 8 characters)"
        value=${next}
        onInput=${(event) => setNext(event.target.value)}
      />
      ${error && html`<div class="form-error" role="alert">${error}</div>`}
      <button class="btn btn-secondary btn-block" onClick=${changePassword} disabled=${busy === 'password' || !current || next.length < 8}>
        ${busy === 'password' ? html`<${Spinner} small />` : 'Change password'}
      </button>

      ${!s.user?.isAdmin &&
      html`<button class="btn btn-quiet btn-danger btn-block" onClick=${removeAccount} disabled=${!current}>
        <${Icon} name="trash" size="18" /> Delete my account
      </button>
      <p class="small muted center">Enter your current password above to delete the account.</p>`}
    </div>
  <//>`;
}

// ---- backup ------------------------------------------------------------------------------

function BackupSheet() {
  const [backup, setBackup] = useState(null); // { blob, meals, workouts }
  const [failed, setFailed] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const fileInput = useRef(null);
  const fileName = `plate-backup-${dayStr()}.json`;

  // The file is prepared up front, so tapping "Save" can hand it to iOS immediately.
  useEffect(() => {
    let alive = true;
    fetch('/api/export', { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error('export failed'))))
      .then((text) => {
        if (!alive) return;
        const data = JSON.parse(text);
        setBackup({ blob: new Blob([text], { type: 'application/json' }), meals: data.meals.length, workouts: data.workouts.length });
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  const save = async () => {
    const file = new File([backup.blob], fileName, { type: 'application/json' });
    try {
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Plate backup' });
        return;
      }
    } catch (err) {
      if (err?.name === 'AbortError') return;
    }
    const url = URL.createObjectURL(backup.blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  const restore = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      toast('That file is not a Plate backup.', 'error');
      return;
    }
    const yes = await confirmDialog({
      title: 'Restore this backup?',
      message: 'Its meals and workouts are added to your account, and your goals and plan are replaced by the ones in the file.',
      confirm: 'Restore',
    });
    if (!yes) return;
    setRestoring(true);
    try {
      const { imported } = await api('POST', '/api/import', data, { timeout: 180000 });
      await refresh();
      toast(`Restored ${plural(imported.meals, 'meal')} and ${plural(imported.workouts, 'workout')}`, 'good', 4000);
      closeOverlay();
    } catch (err) {
      toast(errorText(err), 'error', 5000);
      setRestoring(false);
    }
  };

  return html`<${Sheet} title="Backup and restore">
    <div class="stack">
      <p class="sub soft">A backup is one file with your meals, workouts, weight log, goals and plan. Meal photos are not included.</p>
      <button class="btn btn-primary btn-block" onClick=${save} disabled=${!backup}>
        ${backup ? html`<${Icon} name="download" size="20" /> Save backup` : failed ? "Couldn't prepare the backup" : html`<${Spinner} small /> Preparing…`}
      </button>
      ${backup && html`<p class="small muted center num">${plural(backup.meals, 'meal')} · ${plural(backup.workouts, 'workout')}</p>`}
      <button class="btn btn-secondary btn-block" onClick=${() => fileInput.current.click()} disabled=${restoring}>
        ${restoring ? html`<${Spinner} small /> Restoring…` : 'Restore from a backup file'}
      </button>
      <input ref=${fileInput} type="file" accept="application/json,.json" hidden onChange=${restore} />
    </div>
  <//>`;
}

// ---- owner: AI connection ----------------------------------------------------------------

const PROVIDER_HELP = {
  anthropic: { site: 'console.anthropic.com', url: 'https://console.anthropic.com/settings/keys', text: 'Create a key under API keys. You pay per use.' },
  openai: {
    site: 'platform.openai.com',
    url: 'https://platform.openai.com/api-keys',
    text: 'Create a key under API keys. This is billed separately from a ChatGPT subscription.',
  },
  gemini: {
    site: 'aistudio.google.com',
    url: 'https://aistudio.google.com/apikey',
    text: 'Tap "Get API key". There is a free tier with a small daily allowance.',
  },
  groq: {
    site: 'console.groq.com',
    url: 'https://console.groq.com/keys',
    text: 'Create a key under API Keys. Free tier, and the fastest answers. With a key here, Plate also uses Groq whenever your main AI is busy.',
  },
};

function AiSettingsScreen() {
  const [admin, setAdmin] = useState(null);
  const [provider, setProvider] = useState('anthropic');
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState(null);
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState(null); // { ok, text }
  const [failed, setFailed] = useState(false);

  const adopt = (data, chosen) => {
    const id = data.ai.providers[chosen] ? chosen : 'anthropic';
    setAdmin(data);
    setProvider(id);
    setModel(data.ai.providers[id].model);
  };

  useEffect(() => {
    api('GET', '/api/admin')
      .then((data) => adopt(data, data.ai.provider))
      .catch(() => setFailed(true));
  }, []);

  if (!admin) {
    return html`<${Screen} title="AI connection">
      ${failed
        ? html`<${Empty} icon="offline" title="Couldn't load" text="Check your connection and try again." />`
        : html`<div class="center" style=${{ display: 'grid', placeItems: 'center', minHeight: '220px' }}><${Spinner} /></div>`}
    <//>`;
  }

  const info = admin.ai.providers[provider];
  const help = PROVIDER_HELP[provider];
  const options = [...new Set([...Object.keys(info.suggested), info.model, model, ...(models || []).map((m) => m.id)])].filter(Boolean);
  const labelOf = (id) => info.suggested[id] || models?.find((m) => m.id === id)?.label || id;

  const switchProvider = (id) => {
    setProvider(id);
    setModel(admin.ai.providers[id].model);
    setKey('');
    setModels(null);
    setResult(null);
  };

  const persist = async () => {
    const data = await api('PUT', '/api/admin/ai', { provider, model, ...(key.trim() ? { apiKey: key.trim() } : {}) });
    adopt(data, provider);
    setKey('');
    await refresh().catch(() => {});
  };

  const save = async () => {
    setBusy('save');
    setResult(null);
    try {
      await persist();
      toast('Saved', 'good');
    } catch (err) {
      setResult({ ok: false, text: errorText(err) });
    }
    setBusy('');
  };

  const test = async () => {
    setBusy('test');
    setResult(null);
    try {
      await persist();
      const outcome = await api('POST', '/api/admin/ai/test', null, { timeout: 100000 });
      setResult({ ok: true, text: `It works. ${info.label} answered in ${fmtNum(outcome.ms / 1000, 1)} s.` });
    } catch (err) {
      setResult({ ok: false, text: errorText(err) });
    }
    setBusy('');
  };

  const loadModels = async () => {
    setBusy('models');
    setResult(null);
    try {
      if (key.trim()) await persist();
      const data = await api('GET', `/api/admin/ai/models?provider=${provider}`, null, { timeout: 30000 });
      setModels(data.models);
    } catch (err) {
      setResult({ ok: false, text: errorText(err) });
    }
    setBusy('');
  };

  const removeKey = async () => {
    setBusy('save');
    try {
      adopt(await api('PUT', '/api/admin/ai', { provider, apiKey: '' }), provider);
      await refresh().catch(() => {});
    } catch (err) {
      setResult({ ok: false, text: errorText(err) });
    }
    setBusy('');
  };

  const foot = html`<div style=${{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
    <button class="btn btn-secondary" style=${{ background: 'var(--surface)' }} onClick=${test} disabled=${Boolean(busy) || (!info.key && !key.trim())}>
      ${busy === 'test' ? html`<${Spinner} small />` : 'Test'}
    </button>
    <button class="btn btn-primary" onClick=${save} disabled=${Boolean(busy)}>${busy === 'save' ? html`<${Spinner} small />` : 'Save'}</button>
  </div>`;

  return html`<${Screen} title="AI connection" foot=${foot}>
    <div class="stack">
      <p class="sub soft">The AI reads your food photos. Pick a service, paste its key, and everyone on this server can scan meals.</p>
      <${Segmented}
        value=${provider}
        onChange=${switchProvider}
        options=${Object.entries(admin.ai.providers).map(([id, p]) => ({ value: id, label: p.label }))}
      />

      <${Field} label="API key">
        <input
          class="input"
          style=${{ background: 'var(--surface)' }}
          type="password"
          autocomplete="off"
          autocapitalize="none"
          spellcheck="false"
          placeholder=${info.key ? `Saved: ${info.key}` : 'Paste your key'}
          value=${key}
          onInput=${(event) => setKey(event.target.value)}
        />
      <//>
      <p class="small muted" style=${{ padding: '0 4px', marginTop: '-6px' }}>
        ${info.keySource === 'env' ? 'Using the key from the server settings. Paste one here to use a different key. ' : ''}
        ${help.text} Get one at <a class="link" href=${help.url} target="_blank" rel="noopener noreferrer">${help.site}</a>.
        ${info.keySource === 'app' && html` <button class="link" onClick=${removeKey}>Remove saved key</button>`}
      </p>

      <${Field} label="Model">
        <select class="input" style=${{ background: 'var(--surface)' }} value=${model} onChange=${(event) => setModel(event.target.value)}>
          ${options.map((id) => html`<option value=${id}>${labelOf(id)}</option>`)}
        </select>
      <//>
      ${!models &&
      html`<button class="btn btn-quiet btn-block" onClick=${loadModels} disabled=${Boolean(busy) || (!info.key && !key.trim())}>
        ${busy === 'models' ? html`<${Spinner} small /> Loading…` : 'Show every model this key can use'}
      </button>`}

      ${result &&
      html`<div class=${cx('note', !result.ok && 'danger')} role="status">
        <${Icon} name=${result.ok ? 'check' : 'alert'} size="20" /><span>${result.text}</span>
      </div>`}
      <p class="small muted" style=${{ padding: '0 4px' }}>
        Each person can request up to ${admin.ai.dailyLimit} estimates a day, which keeps the bill predictable.
      </p>
    </div>
  <//>`;
}

// ---- owner: people -----------------------------------------------------------------------

function PeopleScreen() {
  const s = useStore();
  const [admin, setAdmin] = useState(null);
  const [failed, setFailed] = useState(false);
  const load = () =>
    api('GET', '/api/admin')
      .then(setAdmin)
      .catch(() => setFailed(true));
  useEffect(() => {
    load();
  }, []);

  if (!admin) {
    return html`<${Screen} title="People">
      ${failed
        ? html`<${Empty} icon="offline" title="Couldn't load" text="Check your connection and try again." />`
        : html`<div class="center" style=${{ display: 'grid', placeItems: 'center', minHeight: '220px' }}><${Spinner} /></div>`}
    <//>`;
  }

  const invite = async (action) => {
    try {
      setAdmin(await api('POST', '/api/admin/invite', { action }));
    } catch (err) {
      toast(errorText(err), 'error');
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(admin.invite);
      toast('Code copied', 'good');
    } catch {
      toast('Copy it by hand: press and hold the code.');
    }
  };

  return html`<${Screen} title="People">
    <div class="stack">
      <section class="card">
        <div class="strong">Invite code</div>
        <p class="small muted" style=${{ margin: '4px 0 14px' }}>
          ${admin.invite
            ? `Share your address (${location.host}) and this code. People tap "Create an account" and enter it.`
            : 'New accounts are switched off. Nobody can join until you turn them on again.'}
        </p>
        ${admin.invite &&
        html`<div class="code-box">
          <span class="num" style=${{ userSelect: 'all', WebkitUserSelect: 'all' }}>${admin.invite}</span>
          <button class="btn btn-sm btn-secondary" style=${{ background: 'var(--surface)' }} onClick=${copy}><${Icon} name="copy" size="16" /> Copy</button>
        </div>`}
        <div style=${{ display: 'flex', gap: '8px', marginTop: '12px' }}>
          <button class="btn btn-sm btn-secondary" onClick=${() => invite('rotate')}>${admin.invite ? 'New code' : 'Turn on'}</button>
          ${admin.invite && html`<button class="btn btn-sm btn-quiet" onClick=${() => invite('disable')}>Turn off</button>`}
        </div>
      </section>

      <div class="section-title">${plural(admin.users.length, 'person', 'people')}</div>
      <div class="list">
        ${admin.users.map(
          (user) =>
            html`<${Row}
              title=${user.name}
              sub=${`${user.isAdmin ? 'Owner · ' : ''}${plural(user.meals, 'meal')} · ${plural(user.workouts, 'workout')}`}
              onClick=${user.id === s.user?.id ? undefined : () => openOverlay('person', { user, onChange: setAdmin })}
            />`,
        )}
      </div>
      <button class="btn btn-secondary btn-block" style=${{ background: 'var(--surface)' }} onClick=${() => openOverlay('addPerson', { onChange: setAdmin })}>
        <${Icon} name="plus" size="20" /> Add someone yourself
      </button>
    </div>
  <//>`;
}

function AddPersonSheet({ onChange }) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    setError('');
    try {
      onChange(await api('POST', '/api/admin/users', { name, password }));
      closeOverlay();
      toast(`${name.trim()} can sign in now`, 'good');
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  const foot = html`<button class="btn btn-primary btn-lg btn-block" onClick=${add} disabled=${busy || name.trim().length < 2 || password.length < 8}>Create account</button>`;
  return html`<${Sheet} title="Add someone" foot=${foot}>
    <div class="stack">
      <${Field} label="Their name"><input class="input" autocomplete="off" value=${name} onInput=${(event) => setName(event.target.value)} /><//>
      <${Field} label="A password for them" hint="At least 8 characters. They can change it after signing in.">
        <input class="input" autocomplete="off" autocapitalize="none" spellcheck="false" value=${password} onInput=${(event) => setPassword(event.target.value)} />
      <//>
      ${error && html`<div class="form-error" role="alert">${error}</div>`}
    </div>
  <//>`;
}

function PersonSheet({ user, onChange }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const reset = async () => {
    setError('');
    try {
      await api('POST', `/api/admin/users/${user.id}/password`, { password });
      closeOverlay();
      toast(`New password set for ${user.name}`, 'good');
    } catch (err) {
      setError(errorText(err));
    }
  };

  const remove = async () => {
    const yes = await confirmDialog({
      title: `Remove ${user.name}?`,
      message: 'Their account and everything they logged will be erased from this server.',
      confirm: 'Remove',
      danger: true,
    });
    if (!yes) return;
    try {
      onChange(await api('DELETE', `/api/admin/users/${user.id}`));
      closeOverlay();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return html`<${Sheet} title=${user.name}>
    <div class="stack">
      <${Field} label="Set a new password" hint="Use this if they forgot theirs. It signs them out everywhere.">
        <input class="input" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="At least 8 characters" value=${password} onInput=${(event) => setPassword(event.target.value)} />
      <//>
      ${error && html`<div class="form-error" role="alert">${error}</div>`}
      <button class="btn btn-secondary btn-block" onClick=${reset} disabled=${password.length < 8}>Set password</button>
      <button class="btn btn-quiet btn-danger btn-block" onClick=${remove}><${Icon} name="trash" size="18" /> Remove ${user.name}</button>
    </div>
  <//>`;
}

registerOverlay('targets', TargetsSheet);
registerOverlay('body', BodySheet);
registerOverlay('weight', WeightScreen);
registerOverlay('trainingPrefs', TrainingPrefsSheet);
registerOverlay('install', InstallSheet);
registerOverlay('account', AccountSheet);
registerOverlay('backup', BackupSheet);
registerOverlay('aiSettings', AiSettingsScreen);
registerOverlay('people', PeopleScreen);
registerOverlay('addPerson', AddPersonSheet);
registerOverlay('person', PersonSheet);
