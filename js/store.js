// State, persistence and date helpers.
//
// The app keeps one in-memory state and renders from it synchronously.
// Persistence has two layers:
//   - localStorage: a cache on this device (the only store on GitHub Pages).
//   - claude.ai `db`: when the app runs as a claude.ai artifact, the real store,
//     shared across devices and readable/writable by Claude. Documents:
//       plan/settings            race + preferences
//       plan/strava              Strava sync status (last sync, heart-rate zones)
//       weeks/<monday>           { items: [...] } every activity in that Mon–Sun week
//       checkins/<YYYY-MM>       { days: { '2026-11-11': {...} } }
//       coaching/<itemId>        a coaching note for one activity
//       proposals/<id>           a suggested plan change (pending/accepted/dismissed)

const KEY = 'marathon-planner-v1';

export const CATEGORIES = {
  run:       { label: 'Run',               icon: '🏃' },
  strength:  { label: 'Strength',          icon: '🏋️' },
  mobility:  { label: 'Stretch & Mobility', icon: '🧘' },
  nutrition: { label: 'Nutrition',         icon: '🥗' },
  cross:     { label: 'Cross-training',    icon: '🚴' },
  recovery:  { label: 'Recovery',          icon: '🧊' },
  rest:      { label: 'Rest',              icon: '💤' },
  other:     { label: 'Other',             icon: '📌' },
};

export const RUN_TYPES = {
  easy: 'Easy', long: 'Long run', tempo: 'Tempo', intervals: 'Intervals',
  recovery: 'Recovery', hills: 'Hills', race: 'Race',
};

const DEFAULT_STATE = {
  version: 1,
  settings: { raceName: '', raceDate: '', startDate: '', units: 'mi', weekStart: 1, coachNotes: '' },
  items: [],
  logs: {},
  coaching: {},
  proposals: {},
  strava: {},
};

let state = loadCache();
const listeners = new Set();

/** mode: 'local' (GitHub Pages / file) or 'cloud' (claude.ai). status: 'local' | 'connecting' | 'ready' | 'offline' | 'error'. */
export const cloud = { mode: 'local', status: 'local', message: '' };
let db = null;

function loadCache() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return normalize(JSON.parse(raw));
  } catch (e) { /* storage blocked or corrupt: start empty */ }
  return structuredClone(DEFAULT_STATE);
}

function saveCache() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* cache only */ }
}

function normalize(s) {
  const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  return {
    ...structuredClone(DEFAULT_STATE),
    ...s,
    settings: { ...DEFAULT_STATE.settings, ...obj(s.settings) },
    items: Array.isArray(s.items) ? s.items : [],
    logs: obj(s.logs),
    coaching: obj(s.coaching),
    proposals: obj(s.proposals),
    strava: obj(s.strava),
  };
}

// Coalesce re-renders: a burst of saves and cloud snapshots becomes one render.
let notifyTimer = null;
const notify = () => {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => { notifyTimer = null; listeners.forEach(fn => fn(state)); }, 16);
};

/** Save locally, re-render, and push the touched documents to the cloud. */
function commit(paths = []) {
  saveCache();
  notify();
  if (db) new Set(paths).forEach(p => schedule(p));
}

// ---------- document mapping ----------

/** Monday of the week containing `iso` — fixed, so the weekStart setting never moves data. */
export function weekKey(iso) {
  const d = fromISO(iso);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return toISO(d);
}
const weekPath = iso => `weeks/${weekKey(iso)}`;
const monthPath = iso => `checkins/${iso.slice(0, 7)}`;

/** The body a document should have right now, or null to delete it. */
function bodyFor(path) {
  const [col, id] = path.split('/');
  if (col === 'plan' && id === 'strava') return Object.keys(state.strava).length ? { ...state.strava } : null;
  if (col === 'plan') return { ...state.settings };
  if (col === 'weeks') {
    const items = state.items.filter(i => weekKey(i.date) === id);
    return items.length ? { items } : null;
  }
  if (col === 'checkins') {
    const days = Object.fromEntries(Object.entries(state.logs).filter(([d]) => d.startsWith(id)));
    return Object.keys(days).length ? { days } : null;
  }
  if (col === 'coaching') return state.coaching[id] ?? null;
  if (col === 'proposals') return state.proposals[id] ?? null;
  return null;
}

function allPaths(s = state) {
  return [
    'plan/settings',
    ...(Object.keys(s.strava).length ? ['plan/strava'] : []),
    ...s.items.map(i => weekPath(i.date)),
    ...Object.keys(s.logs).map(monthPath),
    ...Object.keys(s.coaching).map(id => `coaching/${id}`),
    ...Object.keys(s.proposals).map(id => `proposals/${id}`),
  ];
}

// ---------- cloud write queue ----------
// One write at a time per document (the latest body wins), at most a few in flight overall.

const queue = new Map();      // path -> { dirty, running }
let inFlight = 0;
const waiting = [];
const MAX_IN_FLIGHT = 4;

function schedule(path) {
  let q = queue.get(path);
  if (!q) queue.set(path, (q = { dirty: false, running: false }));
  q.dirty = true;
  if (!q.running) run(path, q);
}

async function run(path, q) {
  q.running = true;
  while (q.dirty) {
    q.dirty = false;
    if (inFlight >= MAX_IN_FLIGHT) await new Promise(r => waiting.push(r));
    inFlight++;
    try {
      const body = bodyFor(path);
      if (body) await db.doc(path).set(body);
      else await db.doc(path).delete();
    } catch (e) {
      if (e?.code === 'unavailable') { q.dirty = true; await new Promise(r => setTimeout(r, 500 + Math.random() * 1000)); }
      else setStatus('error', e?.code === 'quota_exceeded' ? 'Your claude.ai storage is full.' : `Couldn't save a change (${e?.code || 'error'}).`);
    } finally {
      inFlight--;
      waiting.shift()?.();
    }
  }
  q.running = false;
  queue.delete(path);
}

const busy = path => queue.has(path);
export const pendingWrites = () => queue.size;

// ---------- cloud connection ----------

function setStatus(status, message = '') {
  cloud.status = status;
  cloud.message = message;
  notify();
}

/** Connect to claude.ai storage if this page runs there. Safe to call anywhere. */
export async function connectCloud() {
  const c = typeof window !== 'undefined' && window.claude;
  if (!c?.use) return null;
  cloud.mode = 'cloud';
  setStatus('connecting');
  let handle;
  try { handle = await c.use('db'); } catch { handle = null; }
  if (!handle) { cloud.mode = 'local'; setStatus('local'); return null; }
  db = handle;

  const seen = new Set();
  const expect = ['plan', 'strava', 'weeks', 'checkins', 'coaching', 'proposals'];
  const timer = setTimeout(() => {
    if (cloud.status === 'connecting') setStatus('offline', "Can't reach your saved data yet. Showing what's on this device.");
  }, 10000);
  const ready = (name, meta) => {
    if (meta.fromCache) return;
    seen.add(name);
    if (expect.every(n => seen.has(n)) && cloud.status !== 'error') { clearTimeout(timer); setStatus('ready'); }
  };
  const fail = e => setStatus('error', e?.code === 'revoked' ? 'Access to your saved data was withdrawn.' : `Lost the connection to your saved data (${e?.code}). Reload to reconnect.`);

  db.doc('plan/settings').onSnapshot(snap => {
    if (!busy('plan/settings') && snap.exists) state.settings = { ...DEFAULT_STATE.settings, ...snap.data() };
    ready('plan', snap.metadata);
    saveCache(); notify();
  }, fail);

  db.doc('plan/strava').onSnapshot(snap => {
    if (!busy('plan/strava')) state.strava = snap.exists ? { ...snap.data() } : {};
    ready('strava', snap.metadata);
    saveCache(); notify();
  }, fail);

  // Collections map document id -> body; documents with an unsaved local change keep the local copy.
  const watch = (col, apply) => db.collection(col).onSnapshot(snap => {
    const docs = Object.fromEntries(snap.docs.map(d => [d.id, d.data()]));
    apply(docs);
    ready(col, snap.metadata);
    saveCache(); notify();
  }, fail);

  watch('weeks', docs => {
    const local = new Map();
    for (const it of state.items) {
      const k = weekKey(it.date);
      if (!local.has(k)) local.set(k, []);
      local.get(k).push(it);
    }
    const keys = new Set([...Object.keys(docs), ...[...local.keys()].filter(k => busy(`weeks/${k}`))]);
    const items = [];
    for (const k of keys) {
      if (busy(`weeks/${k}`)) items.push(...(local.get(k) || []));
      else if (Array.isArray(docs[k]?.items)) items.push(...docs[k].items);
    }
    state.items = items;
  });
  watch('checkins', docs => {
    const logs = {};
    for (const [d, v] of Object.entries(state.logs)) if (busy(monthPath(d))) logs[d] = v;
    for (const [m, body] of Object.entries(docs)) {
      if (busy(`checkins/${m}`)) continue;
      Object.assign(logs, body?.days || {});
    }
    state.logs = logs;
  });
  const mapWatch = col => watch(col, docs => {
    const next = {};
    for (const [id, v] of Object.entries(state[col])) if (busy(`${col}/${id}`)) next[id] = v;
    for (const [id, body] of Object.entries(docs)) if (!busy(`${col}/${id}`)) next[id] = body;
    state[col] = next;
  });
  mapWatch('coaching');
  mapWatch('proposals');
  return db;
}

// ---------- mutations ----------

export const store = {
  get: () => state,
  subscribe: fn => listeners.add(fn),

  updateSettings(patch) { state.settings = { ...state.settings, ...patch }; commit(['plan/settings']); },

  addItems(items) {
    const added = items.map(it => ({ id: uid(), done: false, actual: {}, ...it }));
    state.items.push(...added);
    commit(added.map(i => weekPath(i.date)));
  },
  updateItem(id, patch) {
    const it = state.items.find(i => i.id === id);
    if (!it) return;
    const before = weekPath(it.date);
    Object.assign(it, patch);
    commit([before, weekPath(it.date)]);
  },
  updateSeries(seriesId, fromDate, patch) {
    const paths = [];
    state.items.forEach(it => {
      if (it.seriesId === seriesId && it.date >= fromDate) { Object.assign(it, patch); paths.push(weekPath(it.date)); }
    });
    commit(paths);
  },
  deleteItem(id) {
    const it = state.items.find(i => i.id === id);
    state.items = state.items.filter(i => i.id !== id);
    commit(it ? [weekPath(it.date)] : []);
  },
  deleteSeries(seriesId, fromDate) {
    const gone = state.items.filter(i => i.seriesId === seriesId && i.date >= fromDate);
    state.items = state.items.filter(i => !gone.includes(i));
    commit(gone.map(i => weekPath(i.date)));
  },
  clearItems() {
    const paths = state.items.map(i => weekPath(i.date));
    state.items = [];
    commit(paths);
  },

  setLog(date, log) {
    const clean = Object.fromEntries(Object.entries(log).filter(([, v]) => v !== '' && v != null));
    if (Object.keys(clean).length) state.logs[date] = clean; else delete state.logs[date];
    commit([monthPath(date)]);
  },

  setCoaching(itemId, note) {
    if (note) state.coaching[itemId] = note; else delete state.coaching[itemId];
    commit([`coaching/${itemId}`]);
  },
  addProposal(p) {
    const id = uid();
    state.proposals[id] = { status: 'pending', createdAt: new Date().toISOString(), ...p };
    commit([`proposals/${id}`]);
    return id;
  },
  updateProposal(id, patch) {
    if (!state.proposals[id]) return;
    state.proposals[id] = { ...state.proposals[id], ...patch };
    commit([`proposals/${id}`]);
  },

  setStrava(patch) { state.strava = { ...state.strava, ...patch }; commit(['plan/strava']); },

  replaceAll(next) {
    const old = allPaths();
    state = normalize(next);
    commit([...old, ...allPaths()]);
  },
  reset() {
    const old = allPaths();
    state = structuredClone(DEFAULT_STATE);
    commit(old);
  },
};

export function itemsByDate() {
  const map = new Map();
  for (const it of state.items) {
    if (!map.has(it.date)) map.set(it.date, []);
    map.get(it.date).push(it);
  }
  const order = Object.keys(CATEGORIES);
  for (const list of map.values()) {
    list.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
  }
  return map;
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------- dates (ISO 'YYYY-MM-DD' strings, local time) ----------

export function toISO(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
export function fromISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export const today = () => toISO(new Date());
export function addDays(iso, n) {
  const d = fromISO(iso); d.setDate(d.getDate() + n); return toISO(d);
}
export function startOfWeek(iso, weekStart = state.settings.weekStart) {
  const d = fromISO(iso);
  const diff = (d.getDay() - weekStart + 7) % 7;
  d.setDate(d.getDate() - diff);
  return toISO(d);
}
export function daysBetween(a, b) {
  return Math.round((fromISO(b) - fromISO(a)) / 86400000);
}
export function fmtDate(iso, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  return fromISO(iso).toLocaleDateString(undefined, opts);
}
export function isValidISO(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(fromISO(s));
}

// ---------- durations & pace ----------

/** "45" → 45 min, "45:30" → 45m30s, "1:05:30" → 1h5m30s. Returns seconds or null. */
export function parseDuration(str) {
  if (str == null || String(str).trim() === '') return null;
  const parts = String(str).trim().split(':').map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 1) return Math.round(parts[0] * 60);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}
export function fmtDuration(sec) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.round(sec % 60);
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return s ? `${m}:${String(s).padStart(2, '0')}` : `${m} min`;
}
export function fmtPace(sec, dist) {
  if (!sec || !dist) return '';
  const p = Math.round(sec / dist);
  return `${Math.floor(p / 60)}:${String(p % 60).padStart(2, '0')} /${state.settings.units}`;
}
export function num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}
