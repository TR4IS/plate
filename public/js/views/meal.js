// Looking at one logged meal, and the form for editing it or entering one by hand.
import { html, useEffect, useRef, useState } from '../lib.js';
import { closeOverlay, deleteMeal, mealPhotoUrl, openOverlay, saveMeal, toast, useStore } from '../store.js';
import { Field, Icon, MacroPills, NumberInput, Sheet, confirmDialog, cx, registerOverlay } from '../ui.js';
import { dayStr, fmtDay, fmtInt, fmtTime, haptic, parseDay, uid } from '../util.js';

const SOURCE_LABEL = { photo: 'Scanned from a photo', text: 'Estimated from your description', manual: 'Entered by hand' };

function MealSheet({ meal: opened }) {
  const s = useStore();
  // Show the live copy, so an edit made from here is reflected straight away.
  const live = Object.values(s.meals)
    .flat()
    .find((m) => m.id === opened.id);
  const meal = live || opened;
  const photo = mealPhotoUrl(meal);

  const remove = async () => {
    const yes = await confirmDialog({ title: 'Delete this meal?', message: meal.name, confirm: 'Delete', danger: true });
    if (!yes) return;
    deleteMeal(meal.id);
    closeOverlay();
  };

  const logAgain = () => {
    const today = dayStr();
    saveMeal({ ...meal, id: uid('m'), day: today, ts: Date.now(), photo: false, localPhoto: undefined });
    haptic();
    closeOverlay();
    toast('Added to today', 'good');
  };

  const foot = html`<div style=${{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
    <button class="btn btn-secondary" onClick=${() => openOverlay('mealEdit', { meal })}><${Icon} name="pencil" size="18" /> Edit</button>
    <button class="btn btn-primary" onClick=${logAgain}><${Icon} name="plus" size="20" /> Log again</button>
  </div>`;

  return html`<${Sheet} title=${meal.name} foot=${foot}>
    <div class="stack">
      ${photo && html`<img class="result-photo" src=${photo} alt="" />`}
      <div>
        <div class="result-total"><span class="n">${fmtInt(meal.calories)}</span><span class="soft strong">kcal</span></div>
        <div class="small muted" style=${{ marginTop: '6px' }}>
          ${fmtDay(meal.day, s.today)} at ${fmtTime(meal.ts)} · ${SOURCE_LABEL[meal.source] || SOURCE_LABEL.manual}
        </div>
      </div>
      <${MacroPills} protein=${meal.protein} carbs=${meal.carbs} fat=${meal.fat} />

      ${meal.items?.length > 0 &&
      html`<div style=${{ borderTop: '1px solid var(--line)' }}>
        ${meal.items.map(
          (item) =>
            html`<div class=${cx('item-row', item.off && 'off')}>
              <span class="grow">
                <span class="item-name" style=${{ display: 'block' }}>${item.name}</span>
                <span class="small muted" style=${{ display: 'block' }}>
                  ${item.portion || `${item.grams} g`} · P ${Math.round(item.protein)} · C ${Math.round(item.carbs)} · F ${Math.round(item.fat)}
                </span>
              </span>
              <span class="item-kcal num">${fmtInt(item.calories)}</span>
            </div>`,
        )}
      </div>`}

      ${meal.note && html`<div class="note"><${Icon} name="note" size="20" /><span>${meal.note}</span></div>`}
      ${meal.meta?.notes && html`<div class="note"><${Icon} name="bulb" size="20" /><span>${meal.meta.notes}</span></div>`}

      <button class="btn btn-quiet btn-danger btn-block" onClick=${remove}><${Icon} name="trash" size="18" /> Delete meal</button>
    </div>
  <//>`;
}

/** Edit an existing meal, or (with no `meal`) add one by typing the numbers. */
function MealEditSheet({ meal, day, photoUrl, photoBase64 }) {
  const isNew = !meal;
  const today = dayStr();
  const [form, setForm] = useState({
    name: meal?.name || '',
    calories: meal?.calories ?? null,
    protein: meal?.protein ?? null,
    carbs: meal?.carbs ?? null,
    fat: meal?.fat ?? null,
    day: meal?.day || day || today,
  });
  const patch = (changes) => setForm((current) => ({ ...current, ...changes }));
  const nameRef = useRef(null);
  useEffect(() => {
    if (!isNew) return undefined;
    const timer = setTimeout(() => nameRef.current?.focus(), 350);
    return () => clearTimeout(timer);
  }, []);

  // Calories follow the macros until you type a calorie number yourself.
  const [caloriesTouched, setCaloriesTouched] = useState(!isNew);
  const fromMacros = Math.round((form.protein || 0) * 4 + (form.carbs || 0) * 4 + (form.fat || 0) * 9);
  const calories = caloriesTouched ? form.calories : fromMacros || form.calories;

  const valid = form.name.trim().length > 0 && calories > 0;

  const save = () => {
    const sameDay = meal && meal.day === form.day;
    const ts = sameDay ? meal.ts : form.day === today ? Date.now() : parseDay(form.day).getTime() + 12 * 3600 * 1000;
    const numbersChanged =
      meal && (meal.calories !== calories || meal.protein !== form.protein || meal.carbs !== form.carbs || meal.fat !== form.fat);
    saveMeal(
      {
        ...(meal || { id: uid('m'), items: [], note: '', source: 'manual', meta: {} }),
        name: form.name.trim(),
        calories: Math.round(calories),
        protein: form.protein || 0,
        carbs: form.carbs || 0,
        fat: form.fat || 0,
        day: form.day,
        ts,
        // A hand-corrected total no longer matches the AI's item breakdown, so drop the breakdown.
        ...(numbersChanged ? { items: [] } : {}),
      },
      photoBase64 || null,
      photoUrl || null,
    );
    haptic();
    closeOverlay();
    if (isNew) toast(form.day === today ? 'Added to today' : `Added to ${fmtDay(form.day)}`, 'good');
  };

  const foot = html`<button class="btn btn-primary btn-lg btn-block" disabled=${!valid} onClick=${save}>${isNew ? 'Add meal' : 'Save'}</button>`;
  const grid = { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' };

  return html`<${Sheet} title=${isNew ? 'Add a meal' : 'Edit meal'} foot=${foot}>
    <div class="stack">
      ${photoUrl && html`<img class="result-photo" src=${photoUrl} alt="" />`}
      <${Field} label="Name">
        <input
          ref=${nameRef}
          class="input"
          placeholder="e.g. Chicken and rice"
          autocomplete="off"
          value=${form.name}
          onInput=${(event) => patch({ name: event.target.value })}
        />
      <//>
      <${Field} label="Calories">
        <${NumberInput}
          value=${calories}
          unit="kcal"
          places=${0}
          max=${20000}
          ariaLabel="Calories"
          onChange=${(v) => {
            setCaloriesTouched(true);
            patch({ calories: v });
          }}
        />
      <//>
      <div style=${grid}>
        <${Field} label="Protein"><${NumberInput} value=${form.protein} unit="g" max=${2000} ariaLabel="Protein" onChange=${(v) => patch({ protein: v })} /><//>
        <${Field} label="Carbs"><${NumberInput} value=${form.carbs} unit="g" max=${2000} ariaLabel="Carbs" onChange=${(v) => patch({ carbs: v })} /><//>
        <${Field} label="Fat"><${NumberInput} value=${form.fat} unit="g" max=${2000} ariaLabel="Fat" onChange=${(v) => patch({ fat: v })} /><//>
      </div>
      <${Field} label="Day">
        <input class="input" type="date" max=${today} value=${form.day} onChange=${(event) => event.target.value && patch({ day: event.target.value })} />
      <//>
    </div>
  <//>`;
}

registerOverlay('meal', MealSheet);
registerOverlay('mealEdit', MealEditSheet);
