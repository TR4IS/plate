// First-run setup: body measurements -> goal -> suggested targets -> a training plan.
import { TEMPLATES, planFromTemplate, templateLetters } from '../exercises.js';
import { html, useState } from '../lib.js';
import { ACTIVITY, GOALS, suggestTargets } from '../nutrition.js';
import { logWeight, savePlan, saveProfile, useStore } from '../store.js';
import { Field, Icon, NumberInput, Segmented, cx } from '../ui.js';
import { WEEKDAYS_SHORT, cmToFeetInches, feetInchesToCm, fmtInt, kgToUnit, unitToKg } from '../util.js';

export function Choice({ selected, onClick, title, hint, children }) {
  return html`<button type="button" class="choice" aria-pressed=${String(selected)} onClick=${onClick}>
    <span class="grow">
      <span class="strong" style=${{ display: 'block' }}>${title}</span>
      ${hint && html`<span class="small muted" style=${{ display: 'block', marginTop: '2px' }}>${hint}</span>`}
      ${children}
    </span>
    <span class="tick"><${Icon} name="check" size="15" stroke="3" /></span>
  </button>`;
}

/** Height entry that follows the chosen unit system. Value in and out is centimetres. */
export function HeightInput({ units, cm, onChange }) {
  if (units !== 'imperial') {
    return html`<${NumberInput} value=${cm} onChange=${onChange} unit="cm" places=${0} max=${260} ariaLabel="Height in centimetres" />`;
  }
  const { feet, inches } = cmToFeetInches(cm || 0);
  return html`<div style=${{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
    <${NumberInput} value=${feet} onChange=${(v) => onChange(feetInchesToCm(v, inches))} unit="ft" places=${0} max=${8} ariaLabel="Feet" />
    <${NumberInput} value=${inches} onChange=${(v) => onChange(feetInchesToCm(feet, v))} unit="in" places=${0} max=${11} ariaLabel="Inches" />
  </div>`;
}

/** Seven small boxes, Monday to Sunday, with a letter on training days. */
export function WeekDots({ letters }) {
  return html`<span class="week-dots">
    ${letters.map((letter, i) => html`<i class=${cx(!letter && 'off')} title=${WEEKDAYS_SHORT[i]}>${letter || '·'}</i>`)}
  </span>`;
}

const STEPS = 4;

export function Onboarding() {
  const { user, profile } = useStore();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({
    units: profile?.units || 'metric',
    sex: profile?.sex || 'male',
    age: profile?.age || null,
    heightCm: profile?.heightCm || null,
    weightKg: profile?.weightKg || null,
    goal: profile?.goal || 'maintain',
    activity: profile?.activity || 'light',
  });
  const [templateId, setTemplateId] = useState('ppl6');
  const patch = (changes) => setForm((current) => ({ ...current, ...changes }));

  const unit = form.units === 'imperial' ? 'lb' : 'kg';
  const targets = suggestTargets(form);
  const measured = form.age >= 13 && form.heightCm >= 100 && form.weightKg >= 30;

  const finish = () => {
    saveProfile({ ...form, targets, autoTargets: true, restSec: 90, warmup: true, warmupSec: 30, sound: true, theme: 'auto', onboarded: true });
    if (form.weightKg) logWeight(form.weightKg);
    const template = TEMPLATES.find((t) => t.id === templateId);
    if (template) savePlan(planFromTemplate(template));
  };

  const pages = [
    html`<div>
        <h1 class="h1">Hi ${user?.name?.split(' ')[0]}</h1>
        <p class="sub soft" style=${{ marginTop: '10px' }}>A few numbers so your calorie and protein targets fit you.</p>
      </div>
      <${Segmented}
        value=${form.units}
        onChange=${(units) => patch({ units })}
        options=${[
          { value: 'metric', label: 'kg · cm' },
          { value: 'imperial', label: 'lb · ft' },
        ]}
      />
      <${Segmented}
        value=${form.sex}
        onChange=${(sex) => patch({ sex })}
        options=${[
          { value: 'male', label: 'Male' },
          { value: 'female', label: 'Female' },
        ]}
      />
      <${Field} label="Age">
        <${NumberInput} value=${form.age} onChange=${(age) => patch({ age })} unit="years" places=${0} max=${110} ariaLabel="Age" />
      <//>
      <${Field} label="Height">
        <${HeightInput} units=${form.units} cm=${form.heightCm} onChange=${(heightCm) => patch({ heightCm })} />
      <//>
      <${Field} label="Weight">
        <${NumberInput}
          value=${form.weightKg ? kgToUnit(form.weightKg, unit) : null}
          onChange=${(v) => patch({ weightKg: unitToKg(v, unit) })}
          unit=${unit}
          max=${900}
          ariaLabel="Weight"
        />
      <//>`,

    html`<div>
        <h1 class="h1">Your goal</h1>
        <p class="sub soft" style=${{ marginTop: '10px' }}>This sets how many calories you aim for each day.</p>
      </div>
      <div class="stack" style=${{ gap: '10px' }}>
        ${GOALS.map(
          (goal) =>
            html`<${Choice} title=${goal.label} hint=${goal.hint} selected=${form.goal === goal.id} onClick=${() => patch({ goal: goal.id })} />`,
        )}
      </div>
      <div class="section-title">How active are you?</div>
      <div class="stack" style=${{ gap: '10px' }}>
        ${ACTIVITY.map(
          (level) =>
            html`<${Choice}
              title=${level.label}
              hint=${level.hint}
              selected=${form.activity === level.id}
              onClick=${() => patch({ activity: level.id })}
            />`,
        )}
      </div>`,

    html`<div>
        <h1 class="h1">Your daily targets</h1>
        <p class="sub soft" style=${{ marginTop: '10px' }}>A starting point worked out from your numbers. You can change any of them later in Settings.</p>
      </div>
      <div class="target-tile">
        <div class="label" style=${{ paddingLeft: 0 }}>Calories</div>
        <div class="v" style=${{ fontSize: '44px' }}>${fmtInt(targets.calories)}<small>kcal</small></div>
      </div>
      <div class="target-grid">
        ${[
          ['Protein', targets.protein, 'protein'],
          ['Carbs', targets.carbs, 'carbs'],
          ['Fat', targets.fat, 'fat'],
        ].map(
          ([label, grams, kind]) =>
            html`<div class=${cx('target-tile', kind)}>
              <div class="meter-name"><i />${label}</div>
              <div class="v">${grams}<small>g</small></div>
            </div>`,
        )}
      </div>`,

    html`<div>
        <h1 class="h1">Pick a training plan</h1>
        <p class="sub soft" style=${{ marginTop: '10px' }}>Each one comes filled with proven exercises. Swap, add or remove anything whenever you like.</p>
      </div>
      <div class="stack" style=${{ gap: '10px' }}>
        ${TEMPLATES.map(
          (template) =>
            html`<${Choice} title=${template.name} hint=${template.blurb} selected=${templateId === template.id} onClick=${() => setTemplateId(template.id)}>
              <${WeekDots} letters=${templateLetters(template)} />
            <//>`,
        )}
        <${Choice} title="I'll build my own later" hint="Start with an empty plan" selected=${templateId === null} onClick=${() => setTemplateId(null)} />
      </div>`,
  ];

  const last = step === STEPS - 1;
  return html`<div class="onboard on-bg">
    <div class="onboard-progress">${Array.from({ length: STEPS }, (_, i) => html`<i class=${cx(i <= step && 'on')} />`)}</div>
    <div class="onboard-body" key=${step}>${pages[step]}</div>
    <div class="onboard-foot">
      ${step > 0 && html`<button class="btn btn-secondary" onClick=${() => setStep(step - 1)} aria-label="Back"><${Icon} name="left" /></button>`}
      <button class="btn btn-primary btn-lg grow" disabled=${step === 0 && !measured} onClick=${() => (last ? finish() : setStep(step + 1))}>
        ${last ? 'Start using Plate' : 'Continue'}
      </button>
    </div>
  </div>`;
}
