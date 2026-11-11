// Running, Strength and Stretching tabs.

import { store, today, addDays, fmtDate, fmtPace, weekKey } from './store.js';
import { ROUTINES, parseExercises, routineFor, whyFor, estimateMinutes } from './routines.js';

const KEY_RUNS = new Set(['tempo', 'intervals', 'hills', 'long', 'race']);

/** Training phase of the week containing `iso`, read from the plan's "Base week 3 of 11" / "Build week 5 of 18 · Foundation" notes. */
export function weekPhase(iso, items = store.get().items) {
  const start = weekKey(iso), end = addDays(start, 6);
  for (const it of items) {
    if (it.date < start || it.date > end) continue;
    const m = /(Base|Build) week (\d+) of (\d+)(?: · ([A-Za-z -]+?) ·)?/.exec(it.details || '');
    if (m) return { block: m[1], week: +m[2], of: +m[3], phase: m[1] === 'Base' ? 'Base' : (m[4] || 'Build').trim() };
  }
  return null;
}

const sortByDate = (a, b) => a.date.localeCompare(b.date);

/** A row in the same shape as the day list, so the shared toggle/open handler works. */
function rowHTML(it, ctx, extra = '') {
  const { esc } = ctx;
  return `<li class="item cat-${it.category} ${it.done ? 'done' : ''}" data-id="${it.id}">
    <button class="check" data-action="toggle" aria-label="${it.done ? 'Mark not done' : 'Mark done'}" aria-pressed="${!!it.done}">${it.done ? ctx.ICON_CHECK : ''}</button>
    <button class="item-body" data-action="open">
      <span class="item-date">${esc(fmtDate(it.date, { weekday: 'short', month: 'short', day: 'numeric' }))}${it.date === today() ? ' · Today' : ''}</span>
      <span class="item-title">${esc(it.title)}</span>
      <span class="item-meta">${esc(ctx.itemMeta(it))}</span>
      ${extra}
    </button>
  </li>`;
}

function exerciseTable(exercises, ctx, { why = false, doseLabel = 'Sets × reps' } = {}) {
  const { esc } = ctx;
  return `<div class="table-wrap"><table class="ex-table">
    <thead><tr><th>Exercise</th><th>${doseLabel}</th><th>${why ? 'Why' : 'Cue'}</th></tr></thead>
    <tbody>${exercises.map(e => `<tr><td class="ex-name">${esc(e.name)}</td><td class="ex-dose">${esc(e.dose)}</td><td class="ex-note">${esc(why ? whyFor(e.name) || e.note : e.note)}</td></tr>`).join('')}</tbody>
  </table></div>`;
}

// ---------- Running ----------

export function renderRunning(main, ctx) {
  const { esc, unit } = ctx;
  const { items, settings, strava, coaching } = store.get();
  const t = today();
  const runs = items.filter(i => i.category === 'run').sort(sortByDate);
  const ws = ctx.startOfWeek(t), we = addDays(ws, 6);
  const week = runs.filter(r => r.date >= ws && r.date <= we);
  const planned = week.reduce((s, r) => s + ctx.plannedDistance(r), 0);
  const done = week.reduce((s, r) => s + ctx.doneDistance(r), 0);
  const next = runs.filter(r => r.date > t && KEY_RUNS.has(r.runType)).slice(0, 4);
  const recent = runs.filter(r => r.done && r.date <= t).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
  const ph = weekPhase(t);
  const zones = Array.isArray(settings.paceZones) ? settings.paceZones : [];
  const hr = strava?.zones?.heart_rate_zones;

  main.innerHTML = `
    <div class="page-head"><h2>Running</h2>${ph ? `<span class="pill">${esc(ph.phase)} · ${esc(ph.block)} week ${ph.week} of ${ph.of}</span>` : ''}</div>
    ${ctx.stravaBarHTML()}

    <section class="card">
      <div class="card-head"><h3>This week <span class="muted">${esc(fmtDate(ws, { month: 'short', day: 'numeric' }))} – ${esc(fmtDate(we, { month: 'short', day: 'numeric' }))}</span></h3>
        <span class="figure">${+done.toFixed(1)}<small> / ${+planned.toFixed(1)} ${unit()}</small></span></div>
      <div class="progress-line"><span style="width:${planned ? Math.min(100, (done / planned) * 100) : 0}%"></span></div>
      ${week.length ? `<ul class="items">${week.map(r => rowHTML(r, ctx, coaching[r.id] ? `<span class="item-coach">${esc(coaching[r.id].headline)}</span>` : (r.date < t && !r.done ? '<span class="item-flag">Missed</span>' : ''))).join('')}</ul>` : '<p class="empty">No runs planned this week.</p>'}
    </section>

    <div class="two-col">
      <section class="card">
        <h3>Key sessions coming up</h3>
        ${next.length ? `<ul class="items">${next.map(r => rowHTML(r, ctx, r.details ? `<span class="item-details">${esc(r.details.split('\n')[0])}</span>` : '')).join('')}</ul>` : '<p class="empty">No key sessions scheduled.</p>'}
      </section>
      <section class="card">
        <h3>Your zones</h3>
        ${zones.length ? `<div class="table-wrap"><table class="zone-table"><thead><tr><th>Zone</th><th>Pace /${unit()}</th><th>Used for</th></tr></thead>
          <tbody>${zones.map(z => `<tr><td>${esc(z.zone)}</td><td class="num">${esc(z.pace)}</td><td class="muted">${esc(z.use)}</td></tr>`).join('')}</tbody></table></div>`
          : '<p class="muted small">Add pace zones to your coach notes in Setup.</p>'}
        ${hr ? `<p class="coach-label">Heart rate (Strava)</p>
          <div class="hr-zones">${hr.map((z, i) => `<span><i class="z z${i + 1}"></i>Z${i + 1} ${z.min}${z.max ? `–${z.max}` : '+'}</span>`).join('')}</div>` : ''}
      </section>
    </div>

    <section class="card">
      <h3>Recent runs</h3>
      ${recent.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Run</th><th class="num">Dist</th><th class="num">Pace</th><th class="num">HR</th><th class="hide-sm">Coach</th></tr></thead>
        <tbody>${recent.map(r => {
          const a = r.actual || {}, d = ctx.doneDistance(r);
          return `<tr data-id="${r.id}"><td>${esc(fmtDate(r.date, { month: 'short', day: 'numeric' }))}</td>
            <td><button class="link" data-open-run="${r.id}">${esc(r.title)}</button></td>
            <td class="num">${d ? +d.toFixed(2) : ''}</td><td class="num">${esc(fmtPace(a.duration, d))}</td><td class="num">${a.hr ?? ''}</td>
            <td class="notes hide-sm"><span class="clamp">${esc(coaching[r.id]?.headline || '')}</span></td></tr>`;
        }).join('')}</tbody></table></div>` : '<p class="empty">Sync Strava or log a run to see it here.</p>'}
    </section>`;

  ctx.bindRows(main);
  const sync = main.querySelector('[data-strava-sync]');
  if (sync) sync.onclick = ctx.runSync;
  main.addEventListener('click', e => {
    const b = e.target.closest('[data-open-run]');
    const it = b && store.get().items.find(i => i.id === b.dataset.openRun);
    if (it) ctx.openItemDialog(it);
  });
}

// ---------- Strength ----------

function strengthGuidance(ph, t) {
  const race = store.get().settings.raceDate;
  if (race && t >= addDays(race, -10)) return 'Race is under 10 days away: no heavy lifting until after the race.';
  if (!ph) return 'Lift twice a week for 30–40 minutes: after Tuesday\'s workout and on Friday, so easy days stay easy.';
  if (ph.block === 'Base' || ph.phase === 'Foundation') return 'Heavy phase: 3 sets, stop 2–3 reps short of failure. Lift after Tuesday\'s workout and on Friday.';
  if (ph.phase === 'Taper' || ph.phase === 'Race week') return 'Taper: once a week, lighter loads, nothing to failure.';
  return 'Build phase: hold the weight steady and drop to 2 sets. Lift after Tuesday\'s workout and on Friday.';
}

export function renderStrength(main, ctx) {
  const { esc } = ctx;
  const t = today();
  const all = store.get().items.filter(i => i.category === 'strength').sort(sortByDate);
  const nextUp = all.find(i => i.date >= t);
  const upcoming = all.filter(i => i.date >= t && i !== nextUp).slice(0, 6);
  const month = t.slice(0, 7);
  const monthItems = all.filter(i => i.date.startsWith(month) && i.date <= t);
  const parsed = nextUp ? parseExercises(nextUp.details) : null;
  const ph = weekPhase(t);

  main.innerHTML = `
    <div class="page-head"><h2>Strength</h2><span class="muted small">${monthItems.filter(i => i.done).length} of ${monthItems.length} sessions done this month</span></div>
    <p class="lede">${esc(strengthGuidance(ph, t))}</p>

    ${nextUp ? `<section class="card session" data-id="${nextUp.id}">
      <div class="card-head">
        <div><p class="eyebrow">${nextUp.date === t ? 'Today' : 'Next session'} · ${esc(fmtDate(nextUp.date, { weekday: 'long', month: 'short', day: 'numeric' }))}</p>
          <h3 class="session-title">${esc(nextUp.title)}</h3></div>
        <button class="btn ${nextUp.done ? '' : 'primary'} small" data-action="toggle">${nextUp.done ? 'Done' : 'Mark done'}</button>
      </div>
      ${parsed.exercises.length ? exerciseTable(parsed.exercises, ctx, { why: true }) : `<p class="small">${esc(nextUp.details)}</p>`}
      ${parsed.notes.length ? `<p class="muted small session-notes">${parsed.notes.map(esc).join(' ')}</p>` : ''}
      <button class="link small" data-action="open">Log or edit this session</button>
    </section>` : '<section class="card"><p class="empty">No strength sessions scheduled.</p></section>'}

    <section class="card">
      <h3>Coming up</h3>
      ${upcoming.length ? `<ul class="items">${upcoming.map(i => rowHTML(i, ctx)).join('')}</ul>` : '<p class="empty">Nothing else scheduled.</p>'}
    </section>`;

  ctx.bindRows(main);
}

// ---------- Stretching ----------

export function renderStretching(main, ctx) {
  const { esc } = ctx;
  const t = today();
  const all = store.get().items.filter(i => i.category === 'mobility' || i.category === 'recovery').sort(sortByDate);
  const todays = all.filter(i => i.date === t);
  const nextUp = todays.find(i => !i.done) || todays[0] || all.find(i => i.date > t);
  const ws = ctx.startOfWeek(t);
  const week = all.filter(i => i.date >= ws && i.date <= addDays(ws, 6));
  const r = nextUp && routineFor(nextUp);

  const card = (key) => {
    const x = ROUTINES[key];
    return `<section class="card">
      <div class="card-head"><h3>${esc(x.title)}</h3><span class="pill">${x.minutes} min</span></div>
      <p class="muted small">${esc(x.when)}</p>
      ${exerciseTable(x.exercises, ctx, { doseLabel: 'Time / reps' })}
    </section>`;
  };

  main.innerHTML = `
    <div class="page-head"><h2>Stretching & mobility</h2><span class="muted small">${week.filter(i => i.done).length} of ${week.length} done this week</span></div>

    ${nextUp ? `<section class="card session" data-id="${nextUp.id}">
      <div class="card-head">
        <div><p class="eyebrow">${nextUp.date === t ? 'Today' : 'Next session'} · ${esc(fmtDate(nextUp.date, { weekday: 'long', month: 'short', day: 'numeric' }))}</p>
          <h3 class="session-title">${esc(nextUp.title)} <span class="muted">· ${r.minutes || estimateMinutes(r.exercises)} min</span></h3></div>
        <button class="btn ${nextUp.done ? '' : 'primary'} small" data-action="toggle">${nextUp.done ? 'Done' : 'Mark done'}</button>
      </div>
      ${exerciseTable(r.exercises, ctx, { doseLabel: 'Time / reps' })}
    </section>` : ''}

    <section class="card">
      <h3>This week</h3>
      ${week.length ? `<ul class="items">${week.map(i => rowHTML(i, ctx)).join('')}</ul>` : '<p class="empty">No stretching scheduled this week.</p>'}
    </section>

    <h3 class="section-label">Routines</h3>
    <div class="two-col">${card('postRun')}${card('foamRoll')}</div>
    ${card('warmUp')}`;

  ctx.bindRows(main);
}

