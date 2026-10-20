import {
  store, itemsByDate, CATEGORIES, RUN_TYPES, uid,
  today, addDays, startOfWeek, daysBetween, fmtDate, fromISO, toISO, isValidISO,
  parseDuration, fmtDuration, fmtPace, num,
} from './store.js';
import { importCSV, samplePlan, CSV_TEMPLATE } from './plans.js';
import { weeklyVolumeChart, completionBars, bindTooltips } from './charts.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ui = {
  date: today(),
  month: today().slice(0, 8) + '01',
  calMode: 'month',
  hidden: new Set(),       // categories filtered out of the calendar
  showPast: false,
  importOpen: false,
  flash: '',
};

const S = () => store.get().settings;
const unit = () => S().units;

// ---------- derived numbers ----------

/** Distance that counts as "completed": logged actual, else planned if ticked off. */
function doneDistance(it) {
  if (!it.done || it.category !== 'run') return 0;
  return num(it.actual?.distance) ?? num(it.planned?.distance) ?? 0;
}
const plannedDistance = it => (it.category === 'run' ? num(it.planned?.distance) ?? 0 : 0);

function planRange() {
  const items = store.get().items;
  const dates = items.map(i => i.date).sort();
  const start = S().startDate || dates[0];
  const end = S().raceDate || dates[dates.length - 1];
  return start && end ? { start: startOfWeek(start), end } : null;
}

function weekNumber(iso) {
  const r = planRange();
  if (!r) return null;
  return Math.floor(daysBetween(r.start, startOfWeek(iso)) / 7) + 1;
}

function weekTotals(weekStartIso, byDate) {
  let planned = 0, actual = 0;
  for (let i = 0; i < 7; i++) {
    for (const it of byDate.get(addDays(weekStartIso, i)) || []) {
      planned += plannedDistance(it);
      actual += doneDistance(it);
    }
  }
  return { planned, actual };
}

function itemMeta(it) {
  const p = it.planned || {}, bits = [];
  if (it.category === 'run' && it.runType && RUN_TYPES[it.runType]) bits.push(RUN_TYPES[it.runType]);
  if (p.distance) bits.push(`${p.distance} ${unit()}`);
  if (p.duration) bits.push(fmtDuration(p.duration));
  if (it.done && it.actual) {
    const a = it.actual, done = [];
    if (a.distance) done.push(`${a.distance} ${unit()}`);
    if (a.duration) done.push(fmtDuration(a.duration));
    if (a.distance && a.duration) done.push(fmtPace(a.duration, a.distance));
    if (a.rpe) done.push(`RPE ${a.rpe}`);
    if (done.length) bits.push(`✓ ${done.join(' · ')}`);
  }
  return bits.join(' · ');
}

// ---------- shell ----------

function renderHeader() {
  const s = S();
  const el = $('#race-banner');
  const t = today();
  if (s.raceDate) {
    const days = daysBetween(t, s.raceDate);
    const wk = weekNumber(t), r = planRange();
    const total = r ? Math.ceil((daysBetween(r.start, r.end) + 1) / 7) : null;
    el.innerHTML = `
      <strong>${esc(s.raceName || 'Race day')}</strong>
      <span>${days > 0 ? `${days} day${days === 1 ? '' : 's'} to go` : days === 0 ? 'is TODAY! 🏁' : 'complete 🎉'}</span>
      ${wk && total && wk >= 1 && wk <= total ? `<span class="pill">Week ${wk} of ${total}</span>` : ''}`;
  } else {
    el.innerHTML = `<a href="#settings">Set your race date →</a>`;
  }
}

const VIEWS = { today: renderToday, calendar: renderCalendar, plan: renderPlan, progress: renderProgress, settings: renderSettings };

function route() {
  const name = (location.hash.slice(1) || 'today').split('/')[0];
  const view = VIEWS[name] ? name : 'today';
  $$('.nav a').forEach(a => a.classList.toggle('active', a.getAttribute('href') === `#${view}`));
  renderHeader();
  // Fresh element each render so per-view listeners never stack up.
  const old = $('#view');
  const main = old.cloneNode(false);
  old.replaceWith(main);
  VIEWS[view](main);
  bindTooltips(main);
}

// ---------- shared day list ----------

function dayListHTML(date) {
  const items = itemsByDate().get(date) || [];
  if (!items.length) return `<p class="empty">Nothing scheduled.</p>`;
  return `<ul class="items">${items.map(it => `
    <li class="item cat-${it.category} ${it.done ? 'done' : ''}" data-id="${it.id}">
      <button class="check" data-action="toggle" aria-label="${it.done ? 'Mark not done' : 'Mark done'}" aria-pressed="${!!it.done}">${it.done ? '✓' : ''}</button>
      <button class="item-body" data-action="open">
        <span class="item-title">${CATEGORIES[it.category]?.icon || ''} ${esc(it.title)}</span>
        <span class="item-meta">${esc(itemMeta(it))}</span>
        ${it.details ? `<span class="item-details">${esc(it.details)}</span>` : ''}
      </button>
    </li>`).join('')}</ul>`;
}

function bindDayList(root) {
  root.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const li = btn.closest('[data-id]');
    if (!li) return;
    const it = store.get().items.find(i => i.id === li.dataset.id);
    if (!it) return;
    if (btn.dataset.action === 'toggle') {
      store.updateItem(it.id, { done: !it.done, completedAt: !it.done ? new Date().toISOString() : undefined });
    } else if (btn.dataset.action === 'open') {
      openItemDialog(it);
    }
  });
}

// ---------- Today ----------

function renderToday(main) {
  const d = ui.date, t = today();
  const items = itemsByDate().get(d) || [];
  const done = items.filter(i => i.done).length;
  const log = store.get().logs[d] || {};
  const ws = startOfWeek(d);
  const byDate = itemsByDate();

  main.innerHTML = `
    <div class="day-nav">
      <button class="icon-btn" data-nav="-1" aria-label="Previous day">‹</button>
      <div class="day-title">
        <h2>${d === t ? 'Today' : esc(fmtDate(d, { weekday: 'long' }))}</h2>
        <span class="muted">${esc(fmtDate(d, { month: 'long', day: 'numeric', year: 'numeric' }))}</span>
      </div>
      <button class="icon-btn" data-nav="1" aria-label="Next day">›</button>
      ${d !== t ? `<button class="btn small" data-nav="today">Today</button>` : ''}
    </div>

    <div class="week-strip">${[...Array(7)].map((_, i) => {
      const day = addDays(ws, i), list = byDate.get(day) || [];
      const all = list.length && list.every(x => x.done);
      return `<button class="ws-day ${day === d ? 'sel' : ''} ${day === t ? 'is-today' : ''}" data-day="${day}">
        <span>${esc(fmtDate(day, { weekday: 'narrow' }))}</span>
        <b>${fromISO(day).getDate()}</b>
        <span class="dots">${list.slice(0, 4).map(x => `<i class="dot cat-${x.category} ${x.done ? 'on' : ''}"></i>`).join('')}${all ? '✓' : ''}</span>
      </button>`;
    }).join('')}</div>

    <section class="card">
      <div class="card-head">
        <h3>Plan ${items.length ? `<span class="muted">${done}/${items.length} done</span>` : ''}</h3>
        <button class="btn small primary" id="add-here">+ Add</button>
      </div>
      ${items.length ? `<div class="progress-line"><span style="width:${(done / items.length) * 100}%"></span></div>` : ''}
      <div id="day-list">${dayListHTML(d)}</div>
    </section>

    <section class="card">
      <div class="card-head"><h3>Daily check-in</h3><span class="muted small" id="ci-saved"></span></div>
      <form id="checkin" class="grid-form">
        <label>Sleep (hrs)<input type="number" step="0.25" min="0" max="24" name="sleep" value="${esc(log.sleep)}"></label>
        <label>Weight<input type="number" step="0.1" min="0" name="weight" value="${esc(log.weight)}"></label>
        <label>Energy (1–5)<input type="number" min="1" max="5" name="energy" value="${esc(log.energy)}"></label>
        <label>Soreness (1–5)<input type="number" min="1" max="5" name="soreness" value="${esc(log.soreness)}"></label>
        <label>Water (cups)<input type="number" min="0" name="water" value="${esc(log.water)}"></label>
        <label class="span-all">Notes<textarea name="notes" rows="2" placeholder="How did you feel? Any aches?">${esc(log.notes)}</textarea></label>
      </form>
    </section>`;

  main.addEventListener('click', e => {
    const nav = e.target.closest('[data-nav]');
    if (nav) {
      ui.date = nav.dataset.nav === 'today' ? today() : addDays(ui.date, +nav.dataset.nav);
      return route();
    }
    const day = e.target.closest('[data-day]');
    if (day) { ui.date = day.dataset.day; return route(); }
  });
  $('#add-here').onclick = () => openItemDialog(null, d);
  bindDayList($('#day-list'));

  const form = $('#checkin');
  form.addEventListener('change', () => {
    const data = Object.fromEntries(new FormData(form));
    store.setLog(d, data);
  });
}

// ---------- Calendar ----------

function renderCalendar(main) {
  const byDate = itemsByDate();
  const t = today();
  const ws = S().weekStart;
  const dayNames = [...Array(7)].map((_, i) => fmtDate(addDays('2023-01-01', ws + i), { weekday: 'short' }));
  const visible = it => !ui.hidden.has(it.category);

  const filters = Object.entries(CATEGORIES).map(([k, c]) =>
    `<button class="chip cat-${k} ${ui.hidden.has(k) ? 'off' : ''}" data-filter="${k}" aria-pressed="${!ui.hidden.has(k)}">${c.icon} ${c.label}</button>`).join('');

  let title, body;
  if (ui.calMode === 'month') {
    const first = ui.month;
    title = fmtDate(first, { month: 'long', year: 'numeric' });
    const gridStart = startOfWeek(first);
    const m = fromISO(first).getMonth();
    const rows = [];
    for (let w = 0; w < 6; w++) {
      const rowStart = addDays(gridStart, w * 7);
      if (w > 3 && fromISO(rowStart).getMonth() !== m) break;
      const tot = weekTotals(rowStart, byDate);
      const wn = weekNumber(rowStart);
      rows.push(`<div class="cal-row">
        ${[...Array(7)].map((_, i) => {
          const day = addDays(rowStart, i);
          const list = (byDate.get(day) || []).filter(visible);
          const out = fromISO(day).getMonth() !== m;
          const race = day === S().raceDate;
          return `<button class="cal-cell ${out ? 'out' : ''} ${day === t ? 'is-today' : ''} ${race ? 'race' : ''}" data-day="${day}">
            <span class="cal-num">${fromISO(day).getDate()}</span>
            <span class="chips">${list.slice(0, 4).map(it => `<span class="cal-chip cat-${it.category} ${it.done ? 'done' : ''}" title="${esc(it.title)}"><span class="ci">${CATEGORIES[it.category]?.icon}</span><span class="ct">${esc(it.title)}</span></span>`).join('')}
            ${list.length > 4 ? `<span class="more">+${list.length - 4}</span>` : ''}</span>
          </button>`;
        }).join('')}
        <div class="cal-week" data-tip="${esc(`<b>${wn && wn > 0 ? `Week ${wn}` : 'Week'}</b><br>Planned ${+tot.planned.toFixed(1)} ${unit()}<br>Done ${+tot.actual.toFixed(1)} ${unit()}`)}">
          ${wn && wn > 0 ? `<span class="muted">W${wn}</span>` : ''}
          ${tot.planned ? `<b>${+tot.actual.toFixed(1)}</b><span class="muted">/${+tot.planned.toFixed(1)}</span>` : ''}
        </div>
      </div>`);
    }
    body = `<div class="cal">
      <div class="cal-row cal-head">${dayNames.map(n => `<span>${esc(n)}</span>`).join('')}<span class="cal-week">${unit()}</span></div>
      ${rows.join('')}
    </div>`;
  } else {
    const start = startOfWeek(ui.date);
    const wn = weekNumber(start);
    const tot = weekTotals(start, byDate);
    title = `${wn && wn > 0 ? `Week ${wn} · ` : ''}${fmtDate(start, { month: 'short', day: 'numeric' })} – ${fmtDate(addDays(start, 6), { month: 'short', day: 'numeric' })}`;
    body = `<p class="muted week-sum">${+tot.actual.toFixed(1)} of ${+tot.planned.toFixed(1)} ${unit()} run</p>
      <div class="week-cols">${[...Array(7)].map((_, i) => {
        const day = addDays(start, i);
        return `<div class="week-col ${day === t ? 'is-today' : ''}">
          <div class="week-col-head"><button class="link" data-day="${day}">${esc(fmtDate(day, { weekday: 'short', day: 'numeric' }))}</button>
          <button class="icon-btn small" data-add="${day}" aria-label="Add to ${esc(fmtDate(day))}">+</button></div>
          <div class="day-list" data-date="${day}">${dayListHTML(day)}</div>
        </div>`;
      }).join('')}</div>`;
  }

  main.innerHTML = `
    <div class="cal-toolbar">
      <div class="seg" role="tablist">
        <button class="${ui.calMode === 'month' ? 'active' : ''}" data-mode="month">Month</button>
        <button class="${ui.calMode === 'week' ? 'active' : ''}" data-mode="week">Week</button>
      </div>
      <div class="cal-nav">
        <button class="icon-btn" data-step="-1" aria-label="Previous">‹</button>
        <h2>${esc(title)}</h2>
        <button class="icon-btn" data-step="1" aria-label="Next">›</button>
      </div>
      <button class="btn small" data-step="0">Today</button>
    </div>
    <div class="chips-row">${filters}</div>
    ${body}`;

  main.addEventListener('click', e => {
    const el = e.target.closest('[data-mode],[data-step],[data-filter],[data-day],[data-add]');
    if (!el) return;
    if (el.dataset.mode) { ui.calMode = el.dataset.mode; if (el.dataset.mode === 'week' && ui.date.slice(0, 7) !== ui.month.slice(0, 7)) ui.date = ui.month; }
    else if (el.dataset.step != null) {
      const n = +el.dataset.step;
      if (n === 0) { ui.date = today(); ui.month = today().slice(0, 8) + '01'; }
      else if (ui.calMode === 'month') {
        const d = fromISO(ui.month); d.setMonth(d.getMonth() + n); ui.month = toISO(d);
      } else { ui.date = addDays(ui.date, n * 7); ui.month = ui.date.slice(0, 8) + '01'; }
    } else if (el.dataset.filter) {
      const k = el.dataset.filter;
      ui.hidden.has(k) ? ui.hidden.delete(k) : ui.hidden.add(k);
    } else if (el.dataset.add) { return openItemDialog(null, el.dataset.add); }
    else if (el.dataset.day) {
      if (ui.calMode === 'month' || el.classList.contains('link')) return openDayDialog(el.dataset.day);
    }
    route();
  });
  $$('.day-list', main).forEach(bindDayList);
}

// ---------- dialogs ----------

const dialog = () => $('#dialog');

function showDialog(html, onBind) {
  const dlg = dialog();
  dlg.innerHTML = `<div class="dlg">${html}</div>`;
  $$('[data-close]', dlg).forEach(b => (b.onclick = () => dlg.close()));
  onBind?.(dlg);
  if (!dlg.open) dlg.showModal();
}

function openDayDialog(date) {
  ui.date = date;
  const render = () => showDialog(`
    <header class="dlg-head"><h2>${esc(fmtDate(date, { weekday: 'long', month: 'long', day: 'numeric' }))}</h2><button class="icon-btn" data-close aria-label="Close">✕</button></header>
    <div id="dlg-day">${dayListHTML(date)}</div>
    <footer class="dlg-foot"><button class="btn" data-goto>Open day</button><button class="btn primary" data-add>+ Add activity</button></footer>`,
  dlg => {
    bindDayList($('#dlg-day', dlg));
    $('[data-add]', dlg).onclick = () => openItemDialog(null, date);
    $('[data-goto]', dlg).onclick = () => { dlg.close(); location.hash = '#today'; route(); };
  });
  dayDialogRefresh = render;
  render();
}
let dayDialogRefresh = null;

function openItemDialog(it, date) {
  if (it) return openLogDialog(it);
  openEditDialog(null, date);
}

function openLogDialog(it) {
  const a = it.actual || {}, p = it.planned || {};
  const isRun = it.category === 'run';
  showDialog(`
    <header class="dlg-head">
      <h2><span class="cat-badge cat-${it.category}">${CATEGORIES[it.category]?.icon} ${CATEGORIES[it.category]?.label}</span> ${esc(it.title)}</h2>
      <button class="icon-btn" data-close aria-label="Close">✕</button>
    </header>
    <p class="muted">${esc(fmtDate(it.date, { weekday: 'long', month: 'long', day: 'numeric' }))}${itemMeta({ ...it, done: false }) ? ' · ' + esc(itemMeta({ ...it, done: false })) : ''}</p>
    ${it.details ? `<div class="details-box">${esc(it.details)}</div>` : ''}
    <form id="log-form" class="grid-form">
      <label class="span-all toggle"><input type="checkbox" name="done" ${it.done ? 'checked' : ''}> <span>Completed</span></label>
      ${isRun ? `<label>Distance (${unit()})<input type="number" step="0.01" min="0" name="distance" value="${esc(a.distance)}" placeholder="${esc(p.distance ?? '')}"></label>` : ''}
      <label><span>Time <small>(mm:ss or h:mm:ss)</small></span><input name="duration" inputmode="numeric" value="${esc(a.duration ? fmtDuration(a.duration).replace(' min', '') : '')}" placeholder="${esc(p.duration ? fmtDuration(p.duration) : '')}"></label>
      <label>Effort (RPE 1–10)<input type="number" min="1" max="10" name="rpe" value="${esc(a.rpe)}"></label>
      ${isRun ? `<label>Avg HR<input type="number" min="0" name="hr" value="${esc(a.hr)}"></label>` : ''}
      <label class="span-all">Notes<textarea name="notes" rows="3" placeholder="Splits, how it felt, what you ate…">${esc(a.notes)}</textarea></label>
      <p class="span-all muted" id="pace-out"></p>
    </form>
    <footer class="dlg-foot">
      <button class="btn" data-edit>Edit plan</button>
      <button class="btn primary" data-save>Save</button>
    </footer>`,
  dlg => {
    const form = $('#log-form', dlg);
    const updatePace = () => {
      const f = new FormData(form);
      const pace = fmtPace(parseDuration(f.get('duration')), num(f.get('distance')));
      $('#pace-out', dlg).textContent = pace ? `Pace: ${pace}` : '';
    };
    form.addEventListener('input', updatePace); updatePace();
    $('[data-edit]', dlg).onclick = () => openEditDialog(it);
    $('[data-save]', dlg).onclick = () => {
      const f = new FormData(form);
      const actual = {
        distance: num(f.get('distance')), duration: parseDuration(f.get('duration')),
        rpe: num(f.get('rpe')), hr: num(f.get('hr')), notes: (f.get('notes') || '').trim(),
      };
      const hasData = Object.values(actual).some(v => v);
      const done = f.get('done') === 'on' || (hasData && !it.done);
      store.updateItem(it.id, { actual, done, completedAt: done ? (it.completedAt || new Date().toISOString()) : undefined });
      afterDialogChange();
    };
  });
}

function openEditDialog(it, date) {
  const isNew = !it;
  const v = it || { date: date || ui.date, category: 'run', runType: 'easy', title: '', details: '', planned: {} };
  const dow = fromISO(v.date).getDay();
  const days = [...Array(7)].map((_, i) => (S().weekStart + i) % 7);
  showDialog(`
    <header class="dlg-head"><h2>${isNew ? 'Add activity' : 'Edit activity'}</h2><button class="icon-btn" data-close aria-label="Close">✕</button></header>
    <form id="edit-form" class="grid-form">
      <label>Date<input type="date" name="date" value="${esc(v.date)}" required></label>
      <label>Category<select name="category">${Object.entries(CATEGORIES).map(([k, c]) => `<option value="${k}" ${k === v.category ? 'selected' : ''}>${c.icon} ${c.label}</option>`).join('')}</select></label>
      <label class="span-all">Title<input name="title" value="${esc(v.title)}" placeholder="e.g. Long run, Lower body strength, Pre-run breakfast" required></label>
      <label class="run-only">Run type<select name="runType">${Object.entries(RUN_TYPES).map(([k, l]) => `<option value="${k}" ${k === v.runType ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="run-only">Distance (${unit()})<input type="number" step="0.01" min="0" name="distance" value="${esc(v.planned?.distance)}"></label>
      <label><span>Duration <small>(min or h:mm:ss)</small></span><input name="duration" value="${esc(v.planned?.duration ? fmtDuration(v.planned.duration).replace(' min', '') : '')}" placeholder="e.g. 30 or 1:15:00"></label>
      <label class="span-all">Details<textarea name="details" rows="5" placeholder="Workout structure, exercises & sets, stretches, meals, targets…">${esc(v.details)}</textarea></label>
      ${isNew ? `
        <fieldset class="span-all repeat">
          <label class="toggle"><input type="checkbox" name="repeat"> <span>Repeat weekly</span></label>
          <div class="repeat-opts" hidden>
            <div class="dow">${days.map(d => `<label><input type="checkbox" name="dow" value="${d}" ${d === dow ? 'checked' : ''}><span>${esc(fmtDate(addDays('2023-01-01', d), { weekday: 'short' }))}</span></label>`).join('')}</div>
            <label>Until<input type="date" name="until" value="${esc(S().raceDate || addDays(v.date, 7 * 8))}"></label>
          </div>
        </fieldset>` : (it.seriesId ? `<label class="span-all toggle"><input type="checkbox" name="applySeries"> <span>Apply to all future repeats of this activity</span></label>` : '')}
    </form>
    <footer class="dlg-foot">
      ${!isNew ? `<button class="btn danger" data-delete>Delete</button>` : ''}
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" data-save>${isNew ? 'Add' : 'Save'}</button>
    </footer>`,
  dlg => {
    const form = $('#edit-form', dlg);
    const sync = () => {
      const run = form.category.value === 'run';
      $$('.run-only', form).forEach(el => (el.hidden = !run));
      const opts = $('.repeat-opts', form);
      if (opts) opts.hidden = !form.repeat.checked;
    };
    form.addEventListener('change', sync); sync();

    $('[data-save]', dlg).onclick = () => {
      if (!form.reportValidity()) return;
      const f = new FormData(form);
      const category = f.get('category');
      const fields = {
        category,
        title: f.get('title').trim(),
        details: f.get('details').trim(),
        runType: category === 'run' ? f.get('runType') : undefined,
        planned: { distance: category === 'run' ? num(f.get('distance')) : null, duration: parseDuration(f.get('duration')) },
      };
      const d0 = f.get('date');
      if (isNew) {
        if (f.get('repeat') === 'on') {
          const dows = f.getAll('dow').map(Number), until = f.get('until');
          if (!dows.length || !isValidISO(until) || until < d0) return alert('Pick at least one weekday and an end date after the start date.');
          const seriesId = uid(), items = [];
          for (let d = d0; d <= until; d = addDays(d, 1)) {
            if (dows.includes(fromISO(d).getDay())) items.push({ ...fields, date: d, seriesId });
          }
          store.addItems(items);
        } else {
          store.addItems([{ ...fields, date: d0 }]);
        }
      } else if (f.get('applySeries') === 'on') {
        store.updateSeries(it.seriesId, it.date, fields);
        if (d0 !== it.date) store.updateItem(it.id, { date: d0 });
      } else {
        store.updateItem(it.id, { ...fields, date: d0 });
      }
      afterDialogChange();
    };
    const del = $('[data-delete]', dlg);
    if (del) del.onclick = () => {
      if (it.seriesId && confirm('Also delete all future repeats of this activity?\n\nOK = this and all future · Cancel = choose again')) {
        store.deleteSeries(it.seriesId, it.date);
      } else if (confirm(`Delete "${it.title}" on ${fmtDate(it.date)}?`)) {
        store.deleteItem(it.id);
      } else return;
      afterDialogChange();
    };
  });
}

function afterDialogChange() {
  const dlg = dialog();
  if (dayDialogRefresh) dayDialogRefresh();
  else dlg.close();
}

// ---------- Plan ----------

function renderPlan(main) {
  const items = store.get().items;
  const t = today();
  const byWeek = new Map();
  [...items].sort((a, b) => a.date.localeCompare(b.date))
    .filter(it => ui.showPast || it.date >= startOfWeek(t))
    .forEach(it => {
      const w = startOfWeek(it.date);
      if (!byWeek.has(w)) byWeek.set(w, []);
      byWeek.get(w).push(it);
    });

  main.innerHTML = `
    <div class="page-head">
      <h2>Training plan</h2>
      <button class="btn primary" id="add">+ Add activity</button>
    </div>

    <section class="card">
      <h3>Build your plan</h3>
      <p class="muted">Add activities one at a time (with weekly repeats), import your whole plan from a spreadsheet, or start from a sample 16-week plan and edit it.</p>
      <div class="btn-row">
        <button class="btn" id="toggle-import">📥 Import from spreadsheet (CSV)</button>
        <button class="btn" id="sample">✨ Load sample 16-week plan</button>
        ${items.length ? `<button class="btn danger" id="clear">Clear plan</button>` : ''}
      </div>
      <div id="bundled"></div>
      <div id="import" ${ui.importOpen ? '' : 'hidden'}>
        <p class="small">Paste rows from Excel/Google Sheets or upload a .csv. Columns: <code>date</code> <em>or</em> <code>week</code> + <code>day</code>, then <code>category</code>, <code>title</code>, <code>details</code>, <code>distance</code>, <code>duration</code>, <code>run_type</code>.
        Categories: ${Object.keys(CATEGORIES).map(k => `<code>${k}</code>`).join(' ')}. Week/day rows use your plan start date${S().startDate ? ` (${esc(fmtDate(S().startDate))})` : ' — <a href="#settings">set it in Settings</a>'}.</p>
        <textarea id="csv" rows="8" spellcheck="false" placeholder="${esc(CSV_TEMPLATE.split('\n').slice(0, 3).join('\n'))}"></textarea>
        <div class="btn-row">
          <label class="btn file">Choose file…<input type="file" id="csv-file" accept=".csv,.tsv,.txt" hidden></label>
          <button class="btn" id="template">Download template</button>
          <button class="btn primary" id="do-import">Import</button>
        </div>
        <div id="import-msg">${ui.flash}</div>
      </div>
    </section>

    <div class="page-head">
      <h3>${ui.showPast ? 'All weeks' : 'Upcoming'} <span class="muted">(${items.length} activities total)</span></h3>
      <label class="toggle small"><input type="checkbox" id="show-past" ${ui.showPast ? 'checked' : ''}> <span>Show past weeks</span></label>
    </div>
    ${byWeek.size ? [...byWeek].map(([w, list]) => {
      const wn = weekNumber(w);
      const planned = list.reduce((s, i) => s + plannedDistance(i), 0);
      return `<section class="card week-block">
        <div class="card-head"><h3>${wn && wn > 0 ? `Week ${wn} · ` : ''}${esc(fmtDate(w, { month: 'short', day: 'numeric' }))} – ${esc(fmtDate(addDays(w, 6), { month: 'short', day: 'numeric' }))}</h3>
        ${planned ? `<span class="muted">${+planned.toFixed(1)} ${unit()}</span>` : ''}</div>
        <ul class="plan-list">${list.map(it => `
          <li class="cat-${it.category} ${it.done ? 'done' : ''}" data-id="${it.id}">
            <span class="pl-date">${esc(fmtDate(it.date, { weekday: 'short', day: 'numeric' }))}</span>
            <button class="pl-title link" data-action="edit">${CATEGORIES[it.category]?.icon} ${esc(it.title)} ${it.seriesId ? '<span class="muted" title="Repeats weekly">↻</span>' : ''}</button>
            <span class="pl-meta muted">${esc(itemMeta({ ...it, done: false }))}</span>
            <span>${it.done ? '✓' : ''}</span>
          </li>`).join('')}</ul>
      </section>`;
    }).join('') : `<p class="empty">No activities yet. Add one, import a spreadsheet, or load the sample plan.</p>`}`;

  $('#add').onclick = () => openEditDialog(null, t);
  $('#show-past').onchange = e => { ui.showPast = e.target.checked; route(); };
  ui.flash = '';
  $('#toggle-import').onclick = () => { ui.importOpen = $('#import').hidden; $('#import').hidden = !ui.importOpen; };
  $('#template').onclick = () => download('marathon-plan-template.csv', CSV_TEMPLATE, 'text/csv');
  $('#csv-file').onchange = async e => { const f = e.target.files[0]; if (f) $('#csv').value = await f.text(); };
  $('#do-import').onclick = () => {
    const { items: rows, errors } = importCSV($('#csv').value, S());
    const msg = `
      ${rows.length ? `<p class="ok">Imported ${rows.length} activit${rows.length === 1 ? 'y' : 'ies'}.</p>` : ''}
      ${errors.length ? `<ul class="errors">${errors.slice(0, 12).map(e => `<li>${esc(e)}</li>`).join('')}${errors.length > 12 ? `<li>…and ${errors.length - 12} more</li>` : ''}</ul>` : ''}`;
    if (rows.length) { ui.flash = msg; ui.importOpen = errors.length > 0; store.addItems(rows); }
    else $('#import-msg').innerHTML = msg;
  };
  $('#sample').onclick = () => {
    const extra = items.length ? '\n\nThis is added on top of your existing activities.' : '';
    if (!confirm(`Load a 16-week plan ending on ${S().raceDate ? fmtDate(S().raceDate) : 'a race date 16 weeks out'}?${extra}`)) return;
    const { items: plan, start, raceDate } = samplePlan(S());
    store.updateSettings({ startDate: S().startDate || start, raceDate: S().raceDate || raceDate, raceName: S().raceName || 'My Marathon' });
    store.addItems(plan);
    route();
  };
  loadBundledPlans($('#bundled'), items.length);
  const clear = $('#clear');
  if (clear) clear.onclick = () => {
    if (confirm('Delete every activity in your plan? (Check-ins and settings are kept. Consider exporting a backup first.)')) { store.clearItems(); route(); }
  };
  main.addEventListener('click', e => {
    const b = e.target.closest('[data-action="edit"]');
    if (!b) return;
    const it = items.find(i => i.id === b.closest('[data-id]').dataset.id);
    if (it) openEditDialog(it);
  });
}

/** Ready-made plans shipped in /plans (listed in plans/index.json). */
async function loadBundledPlans(el, existing) {
  let list;
  try { list = await (await fetch('plans/index.json')).json(); } catch { return; }
  if (!list?.length || !el.isConnected) return;
  el.innerHTML = `<h3 class="bundled-head">Ready-made plans</h3>${list.map((p, i) => `
    <div class="bundled-plan">
      <div><b>${esc(p.name)}</b><br><span class="muted small">${esc(p.description)}</span></div>
      <button class="btn primary small" data-plan="${i}">Load</button>
    </div>`).join('')}`;
  el.addEventListener('click', async e => {
    const b = e.target.closest('[data-plan]');
    if (!b) return;
    const meta = list[+b.dataset.plan];
    b.disabled = true;
    try {
      const plan = await (await fetch(`plans/${meta.file}`)).json();
      const msg = `Load "${plan.name}" (${plan.items.length} activities)?` +
        (existing ? `\n\nThis REPLACES your current plan of ${existing} activities. Check-ins are kept.` : '') +
        (plan.settings?.raceDate ? `\n\nRace date will be set to ${fmtDate(plan.settings.raceDate)}.` : '');
      if (!confirm(msg)) return;
      if (existing) store.clearItems();
      if (plan.settings) store.updateSettings(plan.settings);
      store.addItems(plan.items);
      route();
    } catch (err) {
      alert(`Could not load the plan: ${err.message}`);
    } finally { b.disabled = false; }
  });
}

// ---------- Progress ----------

function renderProgress(main) {
  const { items, logs } = store.get();
  const t = today();
  const byDate = itemsByDate();
  const past = items.filter(i => i.date <= t);
  const doneCount = past.filter(i => i.done).length;
  const pct = past.length ? Math.round((doneCount / past.length) * 100) : 0;
  const runs = items.filter(i => i.category === 'run' && i.done);
  const totalDist = runs.reduce((s, i) => s + doneDistance(i), 0);
  const longest = runs.reduce((m, i) => Math.max(m, doneDistance(i)), 0);
  const thisWeek = weekTotals(startOfWeek(t), byDate);

  // Streak: consecutive scheduled days with everything done, walking back from today
  // (today only counts once it's complete; empty days are skipped).
  let streak = 0;
  for (let d = t, guard = 0; guard < 400; d = addDays(d, -1), guard++) {
    const list = byDate.get(d);
    if (!list?.length) continue;
    if (list.every(i => i.done)) streak++;
    else if (d === t) continue;
    else break;
  }

  const sleeps = [...Array(7)].map((_, i) => num(logs[addDays(t, -i)]?.sleep)).filter(v => v != null);
  const avgSleep = sleeps.length ? (sleeps.reduce((a, b) => a + b, 0) / sleeps.length).toFixed(1) : '–';

  // Weekly volume across the plan.
  const r = planRange();
  const weeks = [];
  if (r) {
    for (let w = r.start; w <= r.end; w = addDays(w, 7)) {
      weeks.push({ start: w, ...weekTotals(w, byDate), isCurrent: w === startOfWeek(t) });
      if (weeks.length > 60) break;
    }
  }

  const catRows = Object.entries(CATEGORIES).map(([key, c]) => {
    const list = past.filter(i => i.category === key);
    return { key, label: c.label, icon: c.icon, done: list.filter(i => i.done).length, total: list.length };
  }).filter(r => r.total);

  const recent = runs.filter(i => i.date <= t).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 12);

  main.innerHTML = `
    <h2>Progress</h2>
    <div class="tiles">
      <div class="tile"><span class="tile-label">Completion to date</span><b>${pct}%</b><span class="muted">${doneCount} of ${past.length} activities</span></div>
      <div class="tile"><span class="tile-label">This week</span><b>${+thisWeek.actual.toFixed(1)}<small> / ${+thisWeek.planned.toFixed(1)} ${unit()}</small></b><span class="muted">run so far</span></div>
      <div class="tile"><span class="tile-label">Total logged</span><b>${+totalDist.toFixed(1)}<small> ${unit()}</small></b><span class="muted">${runs.length} runs</span></div>
      <div class="tile"><span class="tile-label">Longest run</span><b>${+longest.toFixed(1)}<small> ${unit()}</small></b></div>
      <div class="tile"><span class="tile-label">Streak</span><b>${streak}<small> day${streak === 1 ? '' : 's'}</small></b><span class="muted">fully completed</span></div>
      <div class="tile"><span class="tile-label">Avg sleep (7d)</span><b>${avgSleep}<small> hrs</small></b></div>
    </div>

    <section class="card">
      <h3>Weekly ${unit() === 'km' ? 'kilometers' : 'mileage'}</h3>
      ${weeklyVolumeChart(weeks, unit(), Math.min(1068, main.clientWidth) - 34)}
    </section>

    <section class="card">
      <h3>Completion by category <span class="muted small">(through today)</span></h3>
      ${completionBars(catRows)}
    </section>

    <section class="card">
      <h3>Recent runs</h3>
      ${recent.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Run</th><th class="num">Dist</th><th class="num">Time</th><th class="num">Pace</th><th class="num">RPE</th><th>Notes</th></tr></thead>
        <tbody>${recent.map(i => `<tr data-id="${i.id}">
          <td>${esc(fmtDate(i.date, { month: 'short', day: 'numeric' }))}</td>
          <td><button class="link" data-open>${esc(i.title)}</button></td>
          <td class="num">${+doneDistance(i).toFixed(2) || ''}</td>
          <td class="num">${esc(fmtDuration(i.actual?.duration))}</td>
          <td class="num">${esc(fmtPace(i.actual?.duration, doneDistance(i)))}</td>
          <td class="num">${esc(i.actual?.rpe ?? '')}</td>
          <td class="notes">${esc(i.actual?.notes ?? '')}</td>
        </tr>`).join('')}</tbody></table></div>` : '<p class="muted">Tick off or log a run to see it here.</p>'}
    </section>`;

  main.addEventListener('click', e => {
    const b = e.target.closest('[data-open]');
    if (!b) return;
    const it = items.find(i => i.id === b.closest('[data-id]').dataset.id);
    if (it) openLogDialog(it);
  });
}

// ---------- Settings ----------

function renderSettings(main) {
  const s = S();
  main.innerHTML = `
    <h2>Settings</h2>
    <section class="card">
      <h3>Race</h3>
      <form id="settings" class="grid-form">
        <label class="span-all">Race name<input name="raceName" value="${esc(s.raceName)}" placeholder="e.g. Chicago Marathon"></label>
        <label>Race date<input type="date" name="raceDate" value="${esc(s.raceDate)}"></label>
        <label>Plan start date<input type="date" name="startDate" value="${esc(s.startDate)}"></label>
        <label>Units<select name="units"><option value="mi" ${s.units === 'mi' ? 'selected' : ''}>Miles</option><option value="km" ${s.units === 'km' ? 'selected' : ''}>Kilometers</option></select></label>
        <label>Week starts on<select name="weekStart"><option value="1" ${s.weekStart === 1 ? 'selected' : ''}>Monday</option><option value="0" ${s.weekStart === 0 ? 'selected' : ''}>Sunday</option></select></label>
      </form>
      <p class="muted small" id="saved"></p>
    </section>
    <section class="card">
      <h3>Your data</h3>
      <p class="muted">Everything is stored privately in this browser on this device. Export a backup regularly, and use it to move your plan to another phone or computer.</p>
      <div class="btn-row">
        <button class="btn" id="export">⬇️ Export backup (JSON)</button>
        <label class="btn file">⬆️ Restore backup<input type="file" id="restore" accept=".json,application/json" hidden></label>
        <button class="btn" id="export-csv">Export plan as CSV</button>
        <button class="btn danger" id="reset">Erase everything</button>
      </div>
    </section>`;

  const form = $('#settings');
  form.addEventListener('change', () => {
    const f = Object.fromEntries(new FormData(form));
    store.updateSettings({ ...f, weekStart: +f.weekStart });
    $('#saved').textContent = 'Saved ✓';
    renderHeader();
  });
  $('#export').onclick = () => download(`marathon-backup-${today()}.json`, JSON.stringify(store.get(), null, 2), 'application/json');
  $('#export-csv').onclick = () => {
    const q = v => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const rows = [...store.get().items].sort((a, b) => a.date.localeCompare(b.date)).map(i =>
      [i.date, '', '', i.category, i.title, i.details, i.planned?.distance, i.planned?.duration ? fmtDuration(i.planned.duration).replace(' min', '') : '', i.runType, i.done ? 'yes' : '', i.actual?.distance, fmtDuration(i.actual?.duration), i.actual?.rpe, i.actual?.notes].map(q).join(','));
    download(`marathon-plan-${today()}.csv`, ['date,week,day,category,title,details,distance,duration,run_type,done,actual_distance,actual_time,rpe,notes', ...rows].join('\n'), 'text/csv');
  };
  $('#restore').onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || !Array.isArray(data.items)) throw new Error('Not a backup file');
      if (confirm(`Replace all current data with this backup (${data.items.length} activities)?`)) { store.replaceAll(data); route(); }
    } catch (err) { alert(`Could not restore: ${err.message}`); }
  };
  $('#reset').onclick = () => {
    if (confirm('Erase your entire plan, logs and settings? This cannot be undone.')) { store.reset(); route(); }
  };
}

// ---------- utils & boot ----------

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Re-render when data changes, but don't blow away a form the user is typing in.
store.subscribe(() => {
  const view = location.hash.slice(1) || 'today';
  if (view === 'settings') return;
  const active = document.activeElement;
  if (active?.closest('#checkin')) { $('#ci-saved') && ($('#ci-saved').textContent = 'Saved ✓'); return; }
  route();
  if ($('#dlg-day')) dayDialogRefresh?.();
});

dialog().addEventListener('close', () => { dayDialogRefresh = null; });
window.addEventListener('hashchange', route);
route();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
