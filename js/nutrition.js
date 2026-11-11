// Nutrition tab: a meal log per day with progress against the plan's carb and protein targets.

import { store, today, addDays, fmtDate, num } from './store.js';
import { getSample } from './coach.js';

export const SLOTS = [
  ['breakfast', 'Breakfast'], ['lunch', 'Lunch'], ['dinner', 'Dinner'], ['snacks', 'Snacks'], ['fuel', 'During runs'],
];

/** Body weight in kg from Setup, else the latest check-in weight (read in the Setup unit). */
export function bodyKg() {
  const { settings, logs } = store.get();
  const toKg = w => (settings.weightUnit === 'kg' ? w : w * 0.4536);
  if (num(settings.bodyWeight)) return toKg(num(settings.bodyWeight));
  const last = Object.keys(logs).sort().reverse().find(d => num(logs[d]?.weight));
  return last ? toKg(num(logs[last].weight)) : null;
}

/** The day's targets in grams, following the plan: carbs by training load, protein 1.6–1.8 g/kg. */
export function dayTargets(date, kg) {
  const day = store.get().items.filter(i => i.date === date);
  const carbLoad = day.some(i => i.category === 'nutrition' && /carb load/i.test(i.title));
  const big = day.some(i => i.category === 'run' && (i.runType === 'long' || i.runType === 'race' || (num(i.planned?.distance) || 0) >= 13));
  const run = day.some(i => i.category === 'run');
  const [label, lo, hi] = carbLoad ? ['Carb-load day', 8, 10] : big ? ['Long-run day', 7, 10] : run ? ['Training day', 5, 7] : ['Rest day', 5, 7];
  return { label, gkg: [lo, hi], carbs: kg && [lo * kg, hi * kg], protein: kg && [1.6 * kg, 1.8 * kg] };
}

export function dayTotals(date) {
  const meals = store.get().meals[date] || {};
  const t = { carbs: 0, protein: 0, fat: 0, kcal: 0, count: 0 };
  for (const list of Object.values(meals)) for (const e of list || []) {
    t.carbs += num(e.carbs) || 0; t.protein += num(e.protein) || 0; t.fat += num(e.fat) || 0;
    t.kcal += num(e.kcal) || 0; t.count++;
  }
  return t;
}

const kcalOf = (c, p, f) => Math.round((c || 0) * 4 + (p || 0) * 4 + (f || 0) * 9);

function bar(label, value, range, unit = 'g') {
  if (!range) return `<div class="macro"><div class="macro-head"><span>${label}</span><b>${Math.round(value)} ${unit}</b></div></div>`;
  const [lo, hi] = range, max = hi * 1.15;
  const pct = Math.min(100, (value / max) * 100);
  const state = value < lo ? 'under' : value > hi ? 'over' : 'in';
  return `<div class="macro macro-${state}">
    <div class="macro-head"><span>${label}</span><b>${Math.round(value)}<small> / ${Math.round(lo)}–${Math.round(hi)} ${unit}</small></b></div>
    <div class="macro-track"><span class="macro-band" style="left:${(lo / max) * 100}%;width:${((hi - lo) / max) * 100}%"></span><span class="macro-fill" style="width:${pct}%"></span></div>
    <div class="macro-note">${state === 'under' ? `${Math.round(lo - value)} ${unit} to go` : state === 'over' ? 'Above target' : 'On target'}</div>
  </div>`;
}

export function renderNutrition(main, ctx) {
  const { esc, ui } = ctx;
  const d = ui.nutDate || (ui.nutDate = today());
  const kg = bodyKg();
  const tg = dayTargets(d, kg);
  const tot = dayTotals(d);
  const meals = store.get().meals[d] || {};
  const guidance = store.get().items.filter(i => i.date === d && i.category === 'nutrition');
  const s = store.get().settings;

  const week = [...Array(7)].map((_, i) => addDays(d, i - 6)).map(day => {
    const t = dayTotals(day), g = dayTargets(day, kg);
    return { day, t, g };
  });

  main.innerHTML = `
    <div class="day-nav">
      <button class="icon-btn" data-nav="-1" aria-label="Previous day">‹</button>
      <div class="day-title"><h2>Nutrition</h2><span class="muted">${esc(fmtDate(d, { weekday: 'long', month: 'long', day: 'numeric' }))}</span></div>
      <button class="icon-btn" data-nav="1" aria-label="Next day">›</button>
      ${d !== today() ? '<button class="btn small" data-nav="today">Today</button>' : ''}
    </div>

    ${kg ? '' : `<section class="card">
      <h3>Set your body weight</h3>
      <p class="muted small">Targets are grams per kilogram of body weight, so the app needs your weight to work them out.</p>
      <form id="weight-form" class="inline-form">
        <input type="number" step="0.1" min="30" name="bodyWeight" placeholder="Weight" aria-label="Body weight" required>
        <select name="weightUnit" aria-label="Unit"><option value="lb" ${s.weightUnit !== 'kg' ? 'selected' : ''}>lb</option><option value="kg" ${s.weightUnit === 'kg' ? 'selected' : ''}>kg</option></select>
        <button class="btn primary">Save</button>
      </form>
    </section>`}

    <section class="card">
      <div class="card-head"><h3>${esc(tg.label)} <span class="muted">· ${tg.gkg[0]}–${tg.gkg[1]} g carbs/kg</span></h3>
        <span class="muted small">${tot.count} item${tot.count === 1 ? '' : 's'} logged</span></div>
      <div class="macros">
        ${bar('Carbs', tot.carbs, tg.carbs)}
        ${bar('Protein', tot.protein, tg.protein)}
        ${bar('Fat', tot.fat, null)}
        ${bar('Calories', tot.kcal, null, 'kcal')}
      </div>
      ${guidance.length ? `<div class="guidance">${guidance.map(g => `<div><p class="coach-label">${esc(g.title)}</p><p class="small">${esc(g.details).replace(/\n/g, '<br>')}</p></div>`).join('')}</div>` : ''}
    </section>

    ${SLOTS.map(([slot, label]) => {
      const list = meals[slot] || [];
      const st = list.reduce((a, e) => ({ c: a.c + (num(e.carbs) || 0), p: a.p + (num(e.protein) || 0), k: a.k + (num(e.kcal) || 0) }), { c: 0, p: 0, k: 0 });
      return `<section class="card meal" data-slot="${slot}">
        <div class="card-head"><h3>${label}</h3>${list.length ? `<span class="muted small">${Math.round(st.c)} g C · ${Math.round(st.p)} g P · ${Math.round(st.k)} kcal</span>` : ''}</div>
        ${list.length ? `<ul class="meal-list">${list.map(e => `<li>
          <span class="meal-food">${esc(e.food)}</span>
          <span class="meal-macros">${Math.round(num(e.carbs) || 0)} C · ${Math.round(num(e.protein) || 0)} P · ${Math.round(num(e.fat) || 0)} F · ${Math.round(num(e.kcal) || 0)} kcal</span>
          <button class="icon-btn small" data-remove="${esc(e.id)}" aria-label="Remove ${esc(e.food)}">${ctx.ICON_CLOSE}</button>
        </li>`).join('')}</ul>` : ''}
        <form class="meal-form" data-slot="${slot}">
          <input name="food" placeholder="${slot === 'fuel' ? 'e.g. 2 gels, 500 ml sports drink' : 'What did you eat? e.g. 2 eggs, toast, banana'}" aria-label="${label}: food" required>
          <div class="meal-nums">
            <label>Carbs g<input name="carbs" type="number" min="0" step="1" inputmode="numeric"></label>
            <label>Protein g<input name="protein" type="number" min="0" step="1" inputmode="numeric"></label>
            <label>Fat g<input name="fat" type="number" min="0" step="1" inputmode="numeric"></label>
            <label>kcal<input name="kcal" type="number" min="0" step="1" inputmode="numeric" placeholder="auto"></label>
          </div>
          <div class="btn-row">
            <button type="button" class="btn small" data-estimate hidden>Estimate macros</button>
            <button class="btn small primary">Add</button>
            <span class="muted small" data-status></span>
          </div>
        </form>
      </section>`;
    }).join('')}

    <section class="card">
      <h3>Last 7 days</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Day</th><th>Type</th><th class="num">Carbs</th><th class="num">Target</th><th class="num">Protein</th><th class="num">Target</th><th class="num">kcal</th></tr></thead>
        <tbody>${week.map(({ day, t, g }) => `<tr ${day === d ? 'class="is-sel"' : ''}>
          <td><button class="link" data-goto="${day}">${esc(fmtDate(day, { weekday: 'short', day: 'numeric' }))}</button></td>
          <td>${esc(g.label.replace(' day', ''))}</td>
          <td class="num">${t.count ? Math.round(t.carbs) : '–'}</td><td class="num muted">${g.carbs ? `${Math.round(g.carbs[0])}–${Math.round(g.carbs[1])}` : '–'}</td>
          <td class="num">${t.count ? Math.round(t.protein) : '–'}</td><td class="num muted">${g.protein ? `${Math.round(g.protein[0])}–${Math.round(g.protein[1])}` : '–'}</td>
          <td class="num">${t.count ? Math.round(t.kcal) : '–'}</td></tr>`).join('')}</tbody>
      </table></div>
      <p class="muted small">Targets from your plan: carbs ${tg.gkg[0] === 8 ? '8–10' : '5–7 (7–10 on long-run days)'} g/kg, protein 1.6–1.8 g/kg${kg ? `, at ${Math.round(kg)} kg` : ''}.</p>
    </section>`;

  main.addEventListener('click', e => {
    const nav = e.target.closest('[data-nav]');
    if (nav) { ui.nutDate = nav.dataset.nav === 'today' ? today() : addDays(d, +nav.dataset.nav); return ctx.route(); }
    const go = e.target.closest('[data-goto]');
    if (go) { ui.nutDate = go.dataset.goto; return ctx.route(); }
    const rm = e.target.closest('[data-remove]');
    if (rm) store.removeMeal(d, rm.closest('[data-slot]').dataset.slot, rm.dataset.remove);
  });

  const wf = main.querySelector('#weight-form');
  if (wf) wf.addEventListener('submit', e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(wf));
    store.updateSettings({ bodyWeight: num(f.bodyWeight), weightUnit: f.weightUnit });
  });

  main.querySelectorAll('.meal-form').forEach(form => {
    form.addEventListener('submit', e => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(form));
      const c = num(f.carbs), p = num(f.protein), fat = num(f.fat);
      store.addMeal(d, form.dataset.slot, {
        food: f.food.trim(), carbs: c, protein: p, fat, kcal: num(f.kcal) ?? kcalOf(c, p, fat),
      });
    });
    const est = form.querySelector('[data-estimate]');
    getSample().then(sample => {
      if (!sample || !est.isConnected) return;
      est.hidden = false;
      est.onclick = async () => {
        const food = form.food.value.trim();
        const status = form.querySelector('[data-status]');
        if (!food) { status.textContent = 'Describe the food first.'; form.food.focus(); return; }
        est.disabled = true; status.textContent = 'Estimating…';
        try {
          const r = await sample.json(`Estimate the macronutrients for this food as eaten by an adult. Use typical US portion sizes unless amounts are given.
Food: ${food}
Reply with only JSON: {"carbs": grams, "protein": grams, "fat": grams, "kcal": number, "note": "one short line on the portion assumed"}`, { modelTier: 'quick' });
          for (const k of ['carbs', 'protein', 'fat', 'kcal']) if (num(r?.[k]) != null) form[k].value = Math.round(num(r[k]));
          status.textContent = r?.note ? `Assumed: ${r.note}` : 'Estimated. Adjust if needed, then Add.';
        } catch (err) {
          status.textContent = err?.code === 'not_granted' ? 'Claude is turned off for this page.' : "Couldn't estimate. Enter the numbers yourself.";
        } finally { est.disabled = false; }
      };
    });
  });
}
