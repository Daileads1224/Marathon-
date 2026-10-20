// Bulk import (CSV) and the built-in sample plan.

import { CATEGORIES, RUN_TYPES, addDays, startOfWeek, isValidISO, parseDuration, num, today } from './store.js';

export const CSV_TEMPLATE = `date,week,day,category,title,details,distance,duration,run_type
,1,Mon,mobility,Hip mobility routine,"Leg swings, 90/90, pigeon — 15 min",,15,
,1,Tue,run,Easy run,Conversational pace,4,,easy
,1,Tue,strength,Lower body strength,"Squats 3x10; RDL 3x10; calf raises 3x15",,30,
,1,Wed,run,Intervals,"6 x 800m @ 5K pace, 400m jog",6,,intervals
,1,Sat,run,Long run,Practice fueling: gel every 45 min,10,,long
,1,Sat,nutrition,Carb-focused dinner,~8g carbs per kg the night before,,,
2026-11-08,,,rest,Rest day,,,,
`;

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Minimal RFC-4180-ish CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',' || c === '\t') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(f => f.trim() !== ''));
}

function matchCategory(raw) {
  const s = (raw || '').trim().toLowerCase();
  if (!s) return 'other';
  if (CATEGORIES[s]) return s;
  const aliases = {
    running: 'run', stretch: 'mobility', stretching: 'mobility', yoga: 'mobility', mobility: 'mobility',
    gym: 'strength', weights: 'strength', lift: 'strength', food: 'nutrition', diet: 'nutrition',
    fuel: 'nutrition', hydration: 'nutrition', bike: 'cross', cycling: 'cross', swim: 'cross',
    'cross-training': 'cross', crosstraining: 'cross', 'foam roll': 'recovery', massage: 'recovery', off: 'rest',
  };
  if (aliases[s]) return aliases[s];
  const byLabel = Object.entries(CATEGORIES).find(([, c]) => c.label.toLowerCase() === s);
  return byLabel ? byLabel[0] : 'other';
}

/**
 * Turns CSV text into items. Each row needs either a `date` (YYYY-MM-DD) or
 * `week` + `day` (resolved against the plan start date).
 * Returns { items, errors }.
 */
export function importCSV(text, settings) {
  const rows = parseCSV(text);
  if (!rows.length) return { items: [], errors: ['No rows found.'] };
  const header = rows[0].map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const col = name => header.indexOf(name);
  if (col('title') < 0 && col('category') < 0) {
    return { items: [], errors: ['Header row must include at least "title" or "category" (see the template).'] };
  }
  const planStart = settings.startDate ? startOfWeek(settings.startDate) : null;
  const items = [], errors = [];

  rows.slice(1).forEach((r, idx) => {
    const get = name => (col(name) >= 0 ? (r[col(name)] || '').trim() : '');
    const line = idx + 2;
    let date = get('date');
    if (!date) {
      const week = parseInt(get('week'), 10);
      const day = DAY_NAMES.indexOf(get('day').slice(0, 3).toLowerCase());
      if (!week || day < 0) { errors.push(`Line ${line}: needs a date, or week + day.`); return; }
      if (!planStart) { errors.push(`Line ${line}: set a plan start date in Settings to use week/day.`); return; }
      const offset = (day - settings.weekStart + 7) % 7;
      date = addDays(planStart, (week - 1) * 7 + offset);
    }
    if (!isValidISO(date)) { errors.push(`Line ${line}: "${date}" is not a YYYY-MM-DD date.`); return; }
    const category = matchCategory(get('category'));
    const runType = get('run_type').toLowerCase();
    items.push({
      date, category,
      title: get('title') || CATEGORIES[category].label,
      details: get('details'),
      runType: category === 'run' && RUN_TYPES[runType] ? runType : (category === 'run' ? 'easy' : undefined),
      planned: { distance: num(get('distance')), duration: parseDuration(get('duration')) },
    });
  });
  return { items, errors };
}

/**
 * A classic 16-week build: base → peak → 3-week taper, a cutback every 4th week,
 * two strength sessions, daily-ish mobility, and fueling practice on long runs.
 */
export function samplePlan(settings) {
  const km = settings.units === 'km';
  const d = mi => (km ? Math.round(mi * 1.609 * 10) / 10 : mi);
  const weeks = 16;
  const raceDate = settings.raceDate || addDays(startOfWeek(addDays(today(), 7)), weeks * 7 - 1);
  // Week 1 starts so the race lands on the final weekend.
  const start = addDays(startOfWeek(raceDate), -(weeks - 1) * 7);
  const longRuns = [8, 9, 10, 8, 11, 12, 13, 10, 14, 15, 16, 12, 18, 20, 12, 0];
  const easy =     [3, 3, 4, 3, 4, 4, 5, 4, 5, 5, 6, 5, 6, 6, 5, 3];
  const quality = [
    ['Strides', '4 mi easy + 6 x 20s strides'], ['Tempo', '1 mi WU, 2 mi @ tempo, 1 mi CD'],
    ['Intervals', '6 x 800m @ 5K pace, 400m jog'], ['Easy + strides', 'Cutback week — keep it light'],
  ];
  const items = [];
  const add = (week, dow, it) => {
    const offset = (dow - settings.weekStart + 7) % 7;
    const date = addDays(start, week * 7 + offset);
    if (date >= raceDate) return;
    items.push({ date, ...it });
  };

  for (let w = 0; w < weeks; w++) {
    const taper = w >= weeks - 3;
    const [qTitle, qDetails] = w >= 4 && !taper ? quality[w % 4] : quality[0];
    const qDist = d(easy[w] + (taper ? 0 : 2));

    add(w, 1, { category: 'rest', title: 'Rest day', details: 'Full rest. Walk if you like.' });
    add(w, 1, { category: 'mobility', title: 'Mobility flow', details: 'Hips, hamstrings, calves, thoracic spine — 15 min', planned: { duration: 900 } });

    add(w, 2, { category: 'run', runType: 'easy', title: 'Easy run', details: 'Conversational pace', planned: { distance: d(easy[w]) } });
    add(w, 2, { category: 'strength', title: 'Strength A — lower body', details: 'Goblet squat 3x10\nRomanian deadlift 3x10\nWalking lunges 3x12/leg\nCalf raises 3x15\nPlank 3x45s', planned: { duration: 1800 } });

    add(w, 3, { category: 'run', runType: qTitle === 'Tempo' ? 'tempo' : qTitle === 'Intervals' ? 'intervals' : 'easy', title: qTitle, details: qDetails, planned: { distance: qDist } });
    add(w, 3, { category: 'mobility', title: 'Post-run stretch', details: 'Quads, hip flexors, glutes, calves — 10 min', planned: { duration: 600 } });

    add(w, 4, { category: 'run', runType: 'easy', title: 'Easy run', details: 'Conversational pace', planned: { distance: d(easy[w]) } });
    if (!taper || w === weeks - 3) {
      add(w, 4, { category: 'strength', title: 'Strength B — single leg & core', details: 'Bulgarian split squat 3x8/leg\nSingle-leg glute bridge 3x12\nStep-ups 3x10/leg\nDead bugs 3x10\nSide plank 3x30s/side', planned: { duration: 1800 } });
    }

    add(w, 5, { category: 'cross', title: 'Cross-train or rest', details: 'Optional 30–45 min bike, swim or elliptical', planned: { duration: 2400 } });
    add(w, 5, { category: 'nutrition', title: 'Pre-long-run fueling', details: 'Carb-forward dinner, hydrate well, lay out gear', });

    if (w < weeks - 1) {
      add(w, 6, { category: 'run', runType: 'long', title: 'Long run', details: longRuns[w] >= 13 ? 'Practice race fueling: gel every 40–45 min + water' : 'Easy, steady effort', planned: { distance: d(longRuns[w]) } });
      add(w, 6, { category: 'nutrition', title: 'Recovery meal', details: 'Within 60 min: carbs + 20–30g protein', });
      add(w, 0, { category: 'run', runType: 'recovery', title: 'Recovery run', details: 'Very easy — shake out the legs', planned: { distance: d(Math.max(2, easy[w] - 1)) } });
      add(w, 0, { category: 'recovery', title: 'Foam roll & stretch', details: 'IT band, quads, calves, glutes — 15 min', planned: { duration: 900 } });
    }
  }
  // Race week: carb load, then the race itself on race day (whatever weekday it falls on).
  [3, 2, 1].forEach(n => items.push({ date: addDays(raceDate, -n), category: 'nutrition', title: 'Carb load', details: '8–10 g carbs per kg body weight; keep fiber low; hydrate' }));
  items.push({ date: raceDate, category: 'run', runType: 'race', title: `🏁 ${settings.raceName || 'Race day'}`, details: 'Trust the training. Start conservative, fuel early.', planned: { distance: d(26.2) } });
  return { items, start, raceDate };
}
