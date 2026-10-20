// Small dependency-free SVG charts with a hover tooltip.

import { fmtDate } from './store.js';

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function niceMax(v) {
  if (v <= 0) return 10;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  return [1, 2, 2.5, 5, 10].map(m => m * p).find(m => m >= v);
}

/**
 * Weekly volume, drawn at `width` px so labels stay legible (scrolls if there are many weeks): a wide light "planned" bar with a narrower solid "completed" bar inside it.
 * weeks: [{ start, planned, actual, isCurrent }]
 */
export function weeklyVolumeChart(weeks, unit, width = 640) {
  if (!weeks.length) return '<p class="muted">Add runs with a planned distance to see weekly volume.</p>';
  const W = Math.max(width, weeks.length * 22), H = 240, pad = { l: 36, r: 8, t: 12, b: 28 };
  const max = niceMax(Math.max(...weeks.map(w => Math.max(w.planned, w.actual))));
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const bw = iw / weeks.length;
  const y = v => pad.t + ih - (v / max) * ih;
  const ticks = [0, max / 4, max / 2, (3 * max) / 4, max];

  const grid = ticks.map(t => `
    <line x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}" class="${t === 0 ? 'axis' : 'grid'}"/>
    <text x="${pad.l - 6}" y="${y(t) + 4}" class="tick" text-anchor="end">${+t.toFixed(1)}</text>`).join('');

  const bar = (x, w, v) => {
    if (!v) return '';
    const h = Math.max(2, (v / max) * ih), r = Math.min(4, w / 2, h);
    const top = pad.t + ih - h, bottom = pad.t + ih;
    return `M${x},${bottom} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${bottom} Z`;
  };

  const bars = weeks.map((w, i) => {
    const x0 = pad.l + i * bw;
    const pw = Math.max(4, bw - 6), aw = Math.max(3, pw * 0.5);
    const tip = `<b>Week ${i + 1}</b> · ${esc(fmtDate(w.start, { month: 'short', day: 'numeric' }))}<br>Planned: ${+w.planned.toFixed(1)} ${unit}<br>Completed: ${+w.actual.toFixed(1)} ${unit}`;
    const label = (i % Math.ceil(weeks.length / 12) === 0 || w.isCurrent)
      ? `<text x="${x0 + bw / 2}" y="${H - 10}" class="tick ${w.isCurrent ? 'current' : ''}" text-anchor="middle">${w.isCurrent ? '▲' : i + 1}</text>` : '';
    return `
      <path d="${bar(x0 + 3, pw, w.planned)}" class="bar-planned"/>
      <path d="${bar(x0 + 3 + (pw - aw) / 2, aw, w.actual)}" class="bar-actual"/>
      ${label}
      <rect x="${x0}" y="${pad.t}" width="${bw}" height="${ih}" class="hit" data-tip="${esc(tip)}"/>`;
  }).join('');

  return `
    <div class="legend"><span><i class="sw sw-planned"></i>Planned</span><span><i class="sw sw-actual"></i>Completed</span><span class="muted">▲ this week</span></div>
    <div class="chart-scroll"><svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Weekly ${unit} planned versus completed">${grid}${bars}</svg></div>`;
}

/** Horizontal completion bars per category. rows: [{ label, icon, done, total }] */
export function completionBars(rows) {
  if (!rows.length) return '<p class="muted">Nothing scheduled up to today yet.</p>';
  return `<div class="hbars">${rows.map(r => {
    const pct = r.total ? Math.round((r.done / r.total) * 100) : 0;
    return `<div class="hbar" data-tip="${esc(`<b>${r.label}</b><br>${r.done} of ${r.total} done (${pct}%)`)}">
      <span class="hbar-label">${r.icon} ${esc(r.label)}</span>
      <span class="hbar-track"><span class="hbar-fill cat-${r.key}" style="width:${pct}%"></span></span>
      <span class="hbar-val">${pct}%</span>
    </div>`;
  }).join('')}</div>`;
}

/** Attach one shared tooltip to any [data-tip] inside root. */
export function bindTooltips(root) {
  let tip = document.getElementById('tooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'tooltip';
    tip.setAttribute('role', 'tooltip');
    document.body.appendChild(tip);
  }
  root.querySelectorAll('[data-tip]').forEach(el => {
    const show = e => {
      tip.innerHTML = el.dataset.tip;
      tip.style.display = 'block';
      const pt = e.touches ? e.touches[0] : e;
      const x = Math.min(pt.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
      tip.style.left = `${Math.max(8, x)}px`;
      tip.style.top = `${pt.clientY - tip.offsetHeight - 12}px`;
      el.classList.add('hover');
    };
    const hide = () => { tip.style.display = 'none'; el.classList.remove('hover'); };
    el.addEventListener('mousemove', show);
    el.addEventListener('mouseleave', hide);
    el.addEventListener('touchstart', show, { passive: true });
    el.addEventListener('touchend', () => setTimeout(hide, 1500));
  });
}
