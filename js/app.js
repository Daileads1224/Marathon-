import {
  store, itemsByDate, CATEGORIES, RUN_TYPES, uid, cloud, connectCloud, pendingWrites,
  today, addDays, startOfWeek, daysBetween, fmtDate, fromISO, toISO, isValidISO,
  parseDuration, fmtDuration, fmtPace, num,
} from './store.js';
import { importCSV, samplePlan, CSV_TEMPLATE } from './plans.js';
import { weeklyVolumeChart, completionBars, bindTooltips } from './charts.js';
import { getSample, coachRun, coachError, describeChange, applyProposal, pendingProposals } from './coach.js';
import { getMcp, syncStrava, stravaError, isSyncing } from './strava.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const ICON_CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_CLOSE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ui = {
  date: today(),
  month: today().slice(0, 8) + '01',
  calMode: 'month',
  hidden: new Set(),       // categories filtered out of the calendar
  showPast: false,
  importOpen: false,
  flash: '',
  strava: { available: false, msg: '', error: false },
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
  else if (it.category !== 'run') bits.push(CATEGORIES[it.category]?.short || 'Other');
  if (p.distance) bits.push(`${p.distance} ${unit()}`);
  if (p.duration) bits.push(fmtDuration(p.duration));
  if (it.done && it.actual) {
    const a = it.actual, done = [];
    if (a.distance) done.push(`${a.distance} ${unit()}`);
    if (a.duration) done.push(fmtDuration(a.duration));
    if (a.distance && a.duration) done.push(fmtPace(a.duration, a.distance));
    if (a.hr) done.push(`${a.hr} bpm`);
    if (a.rpe) done.push(`RPE ${a.rpe}`);
    if (done.length) bits.push(`${it.category === 'run' ? 'Ran' : 'Done'} ${done.join(' · ')}`);
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
      <span>${days > 0 ? `${days} day${days === 1 ? '' : 's'} to go` : days === 0 ? 'is today' : 'complete'}</span>
      ${wk && total && wk >= 1 && wk <= total ? `<span class="pill">Week ${wk} of ${total}</span>` : ''}`;
  } else {
    el.innerHTML = `<a href="#setup">Set your race date →</a>`;
  }
  renderSync();
}

function renderSync() {
  const el = $('#sync');
  if (!el) return;
  const st = cloud.status;
  el.hidden = cloud.mode !== 'cloud';
  el.className = `sync sync-${st}`;
  el.textContent = st === 'connecting' ? 'Loading…' : st === 'ready' ? (pendingWrites() ? 'Saving…' : 'Synced') : st === 'offline' ? 'Offline' : st === 'error' ? 'Not saved' : '';
  el.title = cloud.message || (st === 'ready' ? 'Saved to your claude.ai account' : '');
}

const VIEWS = { today: renderToday, calendar: renderCalendar, plan: renderPlan, progress: renderProgress, setup: renderSettings };

function route() {
  if (location.hash === '#settings') return location.replace('#setup');
  const name = (location.hash.slice(1) || 'today').split('/')[0];
  const view = VIEWS[name] ? name : 'today';
  $$('.nav a').forEach(a => a.classList.toggle('active', a.getAttribute('href') === `#${view}`));
  renderHeader();
  // Fresh element each render so per-view listeners never stack up.
  const old = $('#view');
  const main = old.cloneNode(false);
  old.replaceWith(main);
  if (cloud.status === 'error' || cloud.status === 'offline') {
    main.insertAdjacentHTML('afterbegin', `<p class="banner warn" role="status">${esc(cloud.message)}</p>`);
  }
  VIEWS[view](main);
  bindTooltips(main);
}

// ---------- in-page prompts (claude.ai pages can't show confirm/alert) ----------

/** Ask a question in a modal. buttons: [{label, value, kind}]. Resolves the chosen value, or null. */
function ask(title, body = '', buttons = [{ label: 'Cancel', value: null }, { label: 'OK', value: true, kind: 'primary' }]) {
  const dlg = $('#confirm');
  dlg.innerHTML = `<div class="dlg">
    <h2 class="ask-title">${esc(title)}</h2>
    ${body ? `<p class="ask-body">${esc(body)}</p>` : ''}
    <footer class="dlg-foot">${buttons.map((b, i) => `<button class="btn ${b.kind || ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</footer>
  </div>`;
  return new Promise(resolve => {
    let result = null;
    $$('[data-i]', dlg).forEach(b => (b.onclick = () => { result = buttons[+b.dataset.i].value; dlg.close(); }));
    dlg.addEventListener('close', () => resolve(result), { once: true });
    dlg.showModal();
    $('.btn.primary, .btn.danger', dlg)?.focus();
  });
}
const confirmAction = (title, body, okLabel = 'OK', kind = 'primary') =>
  ask(title, body, [{ label: 'Cancel', value: null }, { label: okLabel, value: true, kind }]);

function toast(msg) {
  let el = $('#toast');
  if (!el) { el = Object.assign(document.createElement('div'), { id: 'toast', role: 'status' }); document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 3500);
}

// ---------- coaching & proposals ----------

function coachHTML(note) {
  if (!note) return '';
  const list = (label, arr) => arr?.length ? `<p class="coach-label">${label}</p><ul>${arr.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
  return `<div class="coach rating-${esc(note.rating)}">
    <p class="coach-head"><span class="coach-tag">Coach</span> ${esc(note.headline)}</p>
    <p>${esc(note.summary)}</p>
    ${list('Went well', note.wentWell)}${list('Watch', note.watch)}
    ${note.nextTime ? `<p class="coach-label">Next time</p><p>${esc(note.nextTime)}</p>` : ''}
  </div>`;
}

function proposalsHTML() {
  const list = pendingProposals();
  if (!list.length) return '';
  return list.map(([id, p]) => `<section class="card proposal" data-proposal="${esc(id)}">
    <div class="card-head"><h3><span class="coach-tag">Suggested change</span> ${esc(p.title)}</h3></div>
    ${p.reason ? `<p>${esc(p.reason)}</p>` : ''}
    <ul class="changes">${(p.changes || []).map(c => `<li>${esc(describeChange(c))}</li>`).join('')}</ul>
    <div class="btn-row"><button class="btn" data-dismiss>Dismiss</button><button class="btn primary" data-accept>Accept change</button></div>
  </section>`).join('');
}

function bindProposals(root) {
  root.addEventListener('click', e => {
    const card = e.target.closest('[data-proposal]');
    if (!card) return;
    const id = card.dataset.proposal;
    if (e.target.closest('[data-accept]')) {
      const n = applyProposal(id);
      toast(n ? `Plan updated (${n} change${n === 1 ? '' : 's'}).` : 'Nothing to change: those activities have moved or passed.');
    } else if (e.target.closest('[data-dismiss]')) {
      store.updateProposal(id, { status: 'dismissed', decidedAt: new Date().toISOString() });
    }
  });
}

// ---------- shared day list ----------

function dayListHTML(date) {
  const items = itemsByDate().get(date) || [];
  if (!items.length) return `<p class="empty">Nothing scheduled.</p>`;
  return `<ul class="items">${items.map(it => `
    <li class="item cat-${it.category} ${it.done ? 'done' : ''}" data-id="${it.id}">
      <button class="check" data-action="toggle" aria-label="${it.done ? 'Mark not done' : 'Mark done'}" aria-pressed="${!!it.done}">${it.done ? ICON_CHECK : ''}</button>
      <button class="item-body" data-action="open">
        <span class="item-title">${esc(it.title)}</span>
        <span class="item-meta">${esc(itemMeta(it))}</span>
        ${it.details ? `<span class="item-details">${esc(it.details)}</span>` : ''}
        ${store.get().coaching[it.id] ? `<span class="item-coach">${esc(store.get().coaching[it.id].headline)}</span>` : ''}
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

// ---------- Strava ----------

function ago(iso) {
  if (!iso) return 'never';
  const min = Math.round((Date.now() - new Date(iso)) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

function stravaBarHTML() {
  if (!ui.strava.available) return '';
  const st = store.get().strava || {};
  const busy = isSyncing();
  return `<div class="strava-bar ${ui.strava.error ? 'is-error' : ''}" role="status">
    <span class="strava-mark" aria-hidden="true">S</span>
    <span class="strava-text">${esc(ui.strava.msg || (st.lastSyncAt ? `Strava synced ${ago(st.lastSyncAt)}` : 'Bring in your runs from Strava'))}</span>
    <button class="btn small" data-strava-sync ${busy ? 'disabled' : ''}>${busy ? 'Syncing…' : st.lastSyncAt ? 'Sync' : 'Connect & sync'}</button>
  </div>`;
}

/** Sync Strava, then coach the runs from the last few days that have no coaching yet. */
async function runSync() {
  if (isSyncing()) return;
  ui.strava = { ...ui.strava, msg: 'Checking Strava…', error: false };
  route();
  try {
    const { imported } = await syncStrava({ onProgress: msg => { ui.strava.msg = msg; route(); } });
    ui.strava.msg = imported.length ? `Imported ${imported.length} run${imported.length === 1 ? '' : 's'} from Strava` : 'No new runs on Strava';
    route();
    const recent = imported.filter(r => r.date >= addDays(today(), -3) && !store.get().coaching[r.itemId]);
    if (recent.length && await getSample()) {
      for (const [n, r] of recent.entries()) {
        const run = store.get().items.find(i => i.id === r.itemId);
        if (!run) continue;
        ui.strava.msg = `Coaching run ${n + 1} of ${recent.length}…`; route();
        try {
          const note = await coachRun(run);
          toast(`Coach: ${note.headline}`);
        } catch (e) {
          ui.strava.msg = coachError(e); route();
          if (['not_granted', 'sampling_disabled', 'rate_limited'].includes(e?.code)) break;
        }
      }
      ui.strava.msg = '';
    }
  } catch (e) {
    ui.strava = { ...ui.strava, msg: stravaError(e), error: true };
  }
  route();
}

let autoSynced = false;
/** Once per visit, sync automatically if Strava was synced before and not in the last 30 minutes. */
function maybeAutoSync() {
  if (autoSynced || cloud.status !== 'ready' || !ui.strava.available) return;
  autoSynced = true;
  const last = store.get().strava?.lastSyncAt;
  if (last && Date.now() - new Date(last) > 30 * 60000) runSync();
}

function stravaDetailsHTML(it) {
  const a = it.actual || {}, an = a.analysis;
  if (!a.stravaId || !an) return '';
  const zones = an.hrZones;
  const zoneBar = zones ? `<div class="zones" role="img" aria-label="Time in heart-rate zones: ${zones.percent.map((p, i) => `Zone ${i + 1} ${p}%`).join(', ')}">
      ${zones.percent.map((p, i) => p ? `<span class="z z${i + 1}" style="flex:${p}" data-tip="${esc(`<b>Zone ${i + 1}</b> (${zones.boundsBpm[i][0]}${zones.boundsBpm[i][1] ? `–${zones.boundsBpm[i][1]}` : '+'} bpm)<br>${fmtDuration(zones.seconds[i])} · ${p}%`)}"></span>` : '').join('')}
    </div>
    <div class="zone-legend">${zones.percent.map((p, i) => `<span><i class="z z${i + 1}"></i>Z${i + 1} ${p}%</span>`).join('')}</div>` : '';
  const laps = an.laps?.length > 1 ? `<div class="table-wrap"><table class="laps">
      <thead><tr><th>Lap</th><th class="num">Dist</th><th class="num">Time</th><th class="num">Pace</th><th class="num">HR</th></tr></thead>
      <tbody>${an.laps.map((l, i) => `<tr><td>${i + 1}</td><td class="num">${l.dist ?? ''}</td><td class="num">${l.time ? `${Math.floor(l.time / 60)}:${String(Math.round(l.time % 60)).padStart(2, '0')}` : ''}</td><td class="num">${esc(l.pace ?? '')}</td><td class="num">${l.hr ?? ''}</td></tr>`).join('')}</tbody>
    </table></div>` : '';
  return `<section class="strava-detail">
    <p class="strava-head"><span class="strava-mark" aria-hidden="true">S</span> From Strava${a.stravaName ? `: ${esc(a.stravaName)}` : ''}
      · <a href="https://www.strava.com/activities/${esc(a.stravaId)}" target="_blank" rel="noopener">View on Strava</a></p>
    <p class="small muted">${[a.hr && `Avg HR ${a.hr}`, a.maxHr && `max ${a.maxHr}`, an.cadenceStepsPerMin && `${an.cadenceStepsPerMin} spm`, an.elevationGainMeters != null && `${unit() === 'mi' ? Math.round(an.elevationGainMeters * 3.281) + ' ft' : an.elevationGainMeters + ' m'} climb`].filter(Boolean).join(' · ')}</p>
    ${zoneBar}${laps}
  </section>`;
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
      return `<button class="ws-day ${day === d ? 'sel' : ''} ${day === t ? 'is-today' : ''} ${all ? 'all-done' : ''}" data-day="${day}">
        <span>${esc(fmtDate(day, { weekday: 'narrow' }))}</span>
        <b>${fromISO(day).getDate()}</b>
        <span class="dots">${list.slice(0, 4).map(x => `<i class="dot ${x.done ? 'on' : ''}"></i>`).join('')}</span>
      </button>`;
    }).join('')}</div>

    ${stravaBarHTML()}
    ${proposalsHTML()}

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
  bindProposals(main);
  const syncBtn = $('[data-strava-sync]', main);
  if (syncBtn) syncBtn.onclick = runSync;

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
    `<button class="chip cat-${k} ${ui.hidden.has(k) ? 'off' : ''}" data-filter="${k}" aria-pressed="${!ui.hidden.has(k)}">${c.short}</button>`).join('');

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
            <span class="cal-mini">${(() => { const d = list.filter(x => x.category === 'run').reduce((s, x) => s + (x.done ? doneDistance(x) : plannedDistance(x)), 0); return d ? `<b>${+d.toFixed(1)}</b>` : ''; })()}<span class="mini-dots">${list.slice(0, 5).map(x => `<i class="dot ${x.done ? 'on' : ''}"></i>`).join('')}</span></span>
            <span class="chips">${list.slice(0, 4).map(it => `<span class="cal-chip cat-${it.category} ${it.done ? 'done' : ''}" title="${esc(it.title)}"><span class="ct">${esc(it.title)}</span></span>`).join('')}
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
    <header class="dlg-head"><h2>${esc(fmtDate(date, { weekday: 'long', month: 'long', day: 'numeric' }))}</h2><button class="icon-btn" data-close aria-label="Close">${ICON_CLOSE}</button></header>
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
      <h2><span class="cat-badge">${esc(CATEGORIES[it.category]?.label)}</span> ${esc(it.title)}</h2>
      <button class="icon-btn" data-close aria-label="Close">${ICON_CLOSE}</button>
    </header>
    <p class="muted">${esc(fmtDate(it.date, { weekday: 'long', month: 'long', day: 'numeric' }))}${itemMeta({ ...it, done: false }) ? ' · ' + esc(itemMeta({ ...it, done: false })) : ''}</p>
    ${it.details ? `<div class="details-box">${esc(it.details)}</div>` : ''}
    ${stravaDetailsHTML(it)}
    <form id="log-form" class="grid-form">
      <label class="span-all toggle"><input type="checkbox" name="done" ${it.done ? 'checked' : ''}> <span>Completed</span></label>
      ${isRun ? `<label>Distance (${unit()})<input type="number" step="0.01" min="0" name="distance" value="${esc(a.distance)}" placeholder="${esc(p.distance ?? '')}"></label>` : ''}
      <label><span>Time <small>(mm:ss or h:mm:ss)</small></span><input name="duration" inputmode="numeric" value="${esc(a.duration ? fmtDuration(a.duration).replace(' min', '') : '')}" placeholder="${esc(p.duration ? fmtDuration(p.duration) : '')}"></label>
      <label>Effort (RPE 1–10)<input type="number" min="1" max="10" name="rpe" value="${esc(a.rpe)}"></label>
      ${isRun ? `<label>Avg HR<input type="number" min="0" name="hr" value="${esc(a.hr)}"></label>` : ''}
      <label class="span-all">Notes<textarea name="notes" rows="3" placeholder="Splits, how it felt, what you ate…">${esc(a.notes)}</textarea></label>
      <p class="span-all muted" id="pace-out"></p>
    </form>
    ${isRun ? `<div id="coach-box">${coachHTML(store.get().coaching[it.id])}</div>
      <div class="btn-row" id="coach-row" hidden><button class="btn small" data-coach>${store.get().coaching[it.id] ? 'Coach this run again' : 'Get coaching'}</button><span class="muted small" id="coach-status"></span></div>` : ''}
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
    bindTooltips(dlg);
    $('[data-edit]', dlg).onclick = () => openEditDialog(it);
    const coachBtn = $('[data-coach]', dlg);
    if (coachBtn) getSample().then(sample => {
      if (!sample || !dlg.contains(coachBtn)) return;
      $('#coach-row', dlg).hidden = false;
      coachBtn.onclick = () => runCoaching(it.id, dlg);
    });
    $('[data-save]', dlg).onclick = async () => {
      const f = new FormData(form);
      const actual = {
        ...(it.actual || {}),
        distance: num(f.get('distance')), duration: parseDuration(f.get('duration')),
        rpe: num(f.get('rpe')), hr: num(f.get('hr')), notes: (f.get('notes') || '').trim(),
      };
      const hasData = ['distance', 'duration', 'rpe', 'hr', 'notes'].some(k => actual[k]);
      const done = f.get('done') === 'on' || (hasData && !it.done);
      store.updateItem(it.id, { actual, done, completedAt: done ? (it.completedAt || new Date().toISOString()) : undefined });
      // Coach every completed run with logged data, once, when Claude is available here.
      if (isRun && done && hasData && !store.get().coaching[it.id] && await getSample()) {
        return runCoaching(it.id, dlg);
      }
      afterDialogChange();
    };
  });
}

async function runCoaching(itemId, dlg) {
  const run = store.get().items.find(i => i.id === itemId);
  const status = $('#coach-status', dlg), btn = $('[data-coach]', dlg), box = $('#coach-box', dlg);
  if (!run || !box) return;
  $('#coach-row', dlg).hidden = false;
  if (btn) btn.disabled = true;
  box.innerHTML = `<p class="coach thinking">Your coach is reviewing this run…</p>`;
  try {
    const note = await coachRun(run);
    if (!dlg.contains(box)) return toast(`Coaching ready: ${note.headline}`);
    box.innerHTML = coachHTML(note);
    if (note.proposalId) box.insertAdjacentHTML('beforeend', `<p class="small">Your coach also suggested a plan change. Review it on the Today screen.</p>`);
    if (status) status.textContent = '';
  } catch (e) {
    if (!dlg.contains(box)) return;
    box.innerHTML = coachHTML(store.get().coaching[itemId]);
    if (status) status.textContent = coachError(e);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Coach this run again'; }
  }
}

function openEditDialog(it, date) {
  const isNew = !it;
  const v = it || { date: date || ui.date, category: 'run', runType: 'easy', title: '', details: '', planned: {} };
  const dow = fromISO(v.date).getDay();
  const days = [...Array(7)].map((_, i) => (S().weekStart + i) % 7);
  showDialog(`
    <header class="dlg-head"><h2>${isNew ? 'Add activity' : 'Edit activity'}</h2><button class="icon-btn" data-close aria-label="Close">${ICON_CLOSE}</button></header>
    <form id="edit-form" class="grid-form">
      <label>Date<input type="date" name="date" value="${esc(v.date)}" required></label>
      <label>Category<select name="category">${Object.entries(CATEGORIES).map(([k, c]) => `<option value="${k}" ${k === v.category ? 'selected' : ''}>${c.label}</option>`).join('')}</select></label>
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
          if (!dows.length || !isValidISO(until) || until < d0) return ask('Check the repeat settings', 'Pick at least one weekday and an end date after the start date.', [{ label: 'OK', value: true, kind: 'primary' }]);
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
    if (del) del.onclick = async () => {
      const choice = await ask(`Delete "${it.title}" on ${fmtDate(it.date)}?`, '', [
        { label: 'Cancel', value: null },
        ...(it.seriesId ? [{ label: 'This and all future repeats', value: 'series', kind: 'danger' }] : []),
        { label: it.seriesId ? 'Just this one' : 'Delete', value: 'one', kind: 'danger' },
      ]);
      if (choice === 'series') store.deleteSeries(it.seriesId, it.date);
      else if (choice === 'one') store.deleteItem(it.id);
      else return;
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

    ${proposalsHTML()}

    <section class="card">
      <h3>Build your plan</h3>
      <p class="muted">Add activities one at a time (with weekly repeats), import your whole plan from a spreadsheet, or start from a sample 16-week plan and edit it.</p>
      <div class="btn-row">
        <button class="btn" id="toggle-import">Import from spreadsheet (CSV)</button>
        <button class="btn" id="sample">Load sample 16-week plan</button>
        ${items.length ? `<button class="btn danger" id="clear">Clear plan</button>` : ''}
      </div>
      <div id="bundled"></div>
      <div id="import" ${ui.importOpen ? '' : 'hidden'}>
        <p class="small">Paste rows from Excel/Google Sheets or upload a .csv. Columns: <code>date</code> <em>or</em> <code>week</code> + <code>day</code>, then <code>category</code>, <code>title</code>, <code>details</code>, <code>distance</code>, <code>duration</code>, <code>run_type</code>.
        Categories: ${Object.keys(CATEGORIES).map(k => `<code>${k}</code>`).join(' ')}. Week/day rows use your plan start date${S().startDate ? ` (${esc(fmtDate(S().startDate))})` : ' — <a href="#setup">set it in Setup</a>'}.</p>
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
            <button class="pl-title link" data-action="edit">${esc(it.title)}${it.seriesId ? ' <span class="tag">Weekly</span>' : ''}</button>
            <span class="pl-meta muted">${esc(itemMeta({ ...it, done: false }))}</span>
            <span class="pl-done">${it.done ? 'Done' : ''}</span>
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
  bindProposals(main);
  $('#sample').onclick = async () => {
    const extra = items.length ? 'It is added on top of your existing activities.' : '';
    if (!await confirmAction(`Load a 16-week plan ending on ${S().raceDate ? fmtDate(S().raceDate) : 'a race date 16 weeks out'}?`, extra, 'Load plan')) return;
    const { items: plan, start, raceDate } = samplePlan(S());
    store.updateSettings({ startDate: S().startDate || start, raceDate: S().raceDate || raceDate, raceName: S().raceName || 'My Marathon' });
    store.addItems(plan);
    route();
  };
  loadBundledPlans($('#bundled'), items.length);
  const clear = $('#clear');
  if (clear) clear.onclick = async () => {
    if (await confirmAction('Delete every activity in your plan?', 'Check-ins and settings are kept. Consider exporting a backup first.', 'Delete plan', 'danger')) { store.clearItems(); route(); }
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
      const body = [
        existing ? `This replaces your current plan of ${existing} activities. Check-ins are kept.` : '',
        plan.settings?.raceDate ? `Race date will be set to ${fmtDate(plan.settings.raceDate)}.` : '',
      ].filter(Boolean).join(' ');
      if (!await confirmAction(`Load "${plan.name}" (${plan.items.length} activities)?`, body, existing ? 'Replace plan' : 'Load plan')) return;
      if (existing) store.clearItems();
      if (plan.settings) store.updateSettings(plan.settings);
      store.addItems(plan.items);
      route();
    } catch (err) {
      toast(`Could not load the plan: ${err.message}`);
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
    return { key, label: c.label, done: list.filter(i => i.done).length, total: list.length };
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

// ---------- Setup ----------

function renderSettings(main) {
  const s = S();
  const inCloud = cloud.mode === 'cloud';
  main.innerHTML = `
    <h2>Setup</h2>
    <section class="card">
      <h3>Race</h3>
      <form id="settings" class="grid-form">
        <label class="span-all">Race name<input name="raceName" value="${esc(s.raceName)}" placeholder="e.g. Chicago Marathon"></label>
        <label>Race date<input type="date" name="raceDate" value="${esc(s.raceDate)}"></label>
        <label>Plan start date<input type="date" name="startDate" value="${esc(s.startDate)}"></label>
        <label>Units<select name="units"><option value="mi" ${s.units === 'mi' ? 'selected' : ''}>Miles</option><option value="km" ${s.units === 'km' ? 'selected' : ''}>Kilometers</option></select></label>
        <label>Week starts on<select name="weekStart"><option value="1" ${s.weekStart === 1 ? 'selected' : ''}>Monday</option><option value="0" ${s.weekStart === 0 ? 'selected' : ''}>Sunday</option></select></label>
        <label class="span-all">Notes for your coach<textarea name="coachNotes" rows="7" placeholder="Goal time, pace zones, heart-rate zones, injuries, schedule constraints. Claude reads this every time it coaches a run.">${esc(s.coachNotes)}</textarea></label>
      </form>
      <p class="muted small" id="saved"></p>
    </section>
    <section class="card">
      <h3>Your data</h3>
      <p class="muted">${inCloud
        ? 'Your plan, logs and coaching are saved privately to your claude.ai account and show up on every device where you open this page. Claude can read them to coach you.'
        : 'Everything is stored privately in this browser on this device. Export a backup regularly, and use it to move your plan to another phone or computer.'}</p>
      <div class="btn-row">
        <button class="btn" id="export">Export backup (JSON)</button>
        <label class="btn file">Restore backup<input type="file" id="restore" accept=".json,application/json" hidden></label>
        <button class="btn" id="export-csv">Export plan as CSV</button>
        <button class="btn danger" id="reset">Erase everything</button>
      </div>
    </section>`;

  const form = $('#settings');
  form.addEventListener('change', () => {
    const f = Object.fromEntries(new FormData(form));
    f.coachNotes = (f.coachNotes || '').trim();
    store.updateSettings({ ...f, weekStart: +f.weekStart });
    $('#saved').textContent = 'Saved';
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
      if (await confirmAction(`Replace all current data with this backup (${data.items.length} activities)?`, inCloud ? 'This replaces the plan saved to your claude.ai account.' : '', 'Replace')) {
        store.replaceAll(data); route(); toast('Backup restored.');
      }
    } catch (err) { toast(`Could not restore: ${err.message}`); }
    e.target.value = '';
  };
  $('#reset').onclick = async () => {
    if (await confirmAction('Erase your entire plan, logs and settings?', 'This cannot be undone.', 'Erase everything', 'danger')) { store.reset(); route(); }
  };
}

// ---------- utils & boot ----------

async function download(name, text, type) {
  // claude.ai pages save files through the downloads capability; plain links are blocked there.
  if (window.claude?.use) {
    const dl = await window.claude.use('downloads').catch(() => null);
    if (dl) {
      try { await dl.save({ filename: name, data: text }); } catch (e) { if (e?.code !== 'declined') toast("Couldn't save the file here."); }
      return;
    }
  }
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Re-render when data changes, but don't blow away a form the user is typing in.
store.subscribe(() => {
  const view = location.hash.slice(1) || 'today';
  const active = document.activeElement;
  renderSync();
  maybeAutoSync();
  if (view === 'setup') {
    if (!active?.closest('#settings, textarea, input')) route();
    return;
  }
  if (active?.closest('#checkin')) { $('#ci-saved') && ($('#ci-saved').textContent = 'Saved'); return; }
  route();
  if ($('#dlg-day')) dayDialogRefresh?.();
});

dialog().addEventListener('close', () => { dayDialogRefresh = null; });
window.addEventListener('hashchange', route);
route();
connectCloud();
getMcp().then(mcp => {
  ui.strava.available = !!mcp && cloud.mode === 'cloud';
  if (ui.strava.available) { route(); maybeAutoSync(); }
});

// Offline support only for the GitHub Pages copy; claude.ai pages don't allow service workers.
if (!window.claude && 'serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
