// State, persistence and date helpers. Everything lives in localStorage.

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
  settings: { raceName: '', raceDate: '', startDate: '', units: 'mi', weekStart: 1 },
  items: [],
  logs: {},
};

let state = load();
const listeners = new Set();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return normalize(JSON.parse(raw));
  } catch (e) { console.warn('Could not load saved data', e); }
  return structuredClone(DEFAULT_STATE);
}

function normalize(s) {
  return {
    ...structuredClone(DEFAULT_STATE),
    ...s,
    settings: { ...DEFAULT_STATE.settings, ...(s.settings || {}) },
    items: Array.isArray(s.items) ? s.items : [],
    logs: s.logs && typeof s.logs === 'object' ? s.logs : {},
  };
}

function commit() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); }
  catch (e) { alert('Could not save — storage may be full or blocked.'); }
  listeners.forEach(fn => fn(state));
}

export const store = {
  get: () => state,
  subscribe: fn => listeners.add(fn),

  updateSettings(patch) { state.settings = { ...state.settings, ...patch }; commit(); },

  addItems(items) {
    state.items.push(...items.map(it => ({ id: uid(), done: false, actual: {}, ...it })));
    commit();
  },
  updateItem(id, patch) {
    const it = state.items.find(i => i.id === id);
    if (it) Object.assign(it, patch);
    commit();
  },
  updateSeries(seriesId, fromDate, patch) {
    state.items.forEach(it => {
      if (it.seriesId === seriesId && it.date >= fromDate) Object.assign(it, patch);
    });
    commit();
  },
  deleteItem(id) { state.items = state.items.filter(i => i.id !== id); commit(); },
  deleteSeries(seriesId, fromDate) {
    state.items = state.items.filter(i => !(i.seriesId === seriesId && i.date >= fromDate));
    commit();
  },
  clearItems() { state.items = []; commit(); },

  setLog(date, log) {
    const clean = Object.fromEntries(Object.entries(log).filter(([, v]) => v !== '' && v != null));
    if (Object.keys(clean).length) state.logs[date] = clean; else delete state.logs[date];
    commit();
  },

  replaceAll(next) { state = normalize(next); commit(); },
  reset() { state = structuredClone(DEFAULT_STATE); commit(); },
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
