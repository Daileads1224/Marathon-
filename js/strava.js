// Strava sync through the viewer's claude.ai Strava connector (the artifact's `mcp` capability).
// Pulls runs, matches each to that day's planned run (or adds it), and stores distance, time,
// heart rate, laps and time in each heart-rate zone on the activity.

import { store, today, addDays } from './store.js';

const SERVER = 'Strava';
const RUN_SPORTS = new Set(['Run', 'TrailRun', 'VirtualRun']);
const METERS = { mi: 1609.344, km: 1000 };

let mcpPromise = null;
/** Resolves the `mcp` namespace, or null when connectors aren't available on this page. */
export function getMcp() {
  if (!mcpPromise) {
    const c = typeof window !== 'undefined' && window.claude;
    mcpPromise = c?.use ? c.use('mcp').catch(() => null) : Promise.resolve(null);
  }
  return mcpPromise;
}

const ERRORS = {
  needs_reauth: 'Strava needs to be reconnected: claude.ai Settings → Connectors → Strava.',
  server_not_connected: 'Connect Strava in claude.ai Settings → Connectors, then sync again.',
  selection_required: 'Choose which Strava connection to use when claude.ai asks, then sync again.',
  not_in_manifest: 'Strava is turned off for this page. Allow it in the page permissions, then sync again.',
  approval_required: 'Allow this page to read your Strava data when claude.ai asks, then sync again.',
  blocked_by_policy: 'Your organization blocks Strava here.',
  server_unavailable: "Strava isn't responding right now. Try again in a minute.",
  capability_disabled: "Strava sync isn't available in this view. Open the app on claude.ai.",
};
export const stravaError = e =>
  ERRORS[e?.code] || (e?.code === 'tool_error' ? `Strava reported a problem: ${String(e.message).slice(0, 160)}` : 'Strava sync failed. Try again.');

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** One read from the Strava connector, retried once when the error says that may help. */
async function call(mcp, tool, input) {
  const run = async () => {
    const res = await mcp.callTool(SERVER, tool, input, { cache: false });
    const p = res?.payload;
    if (typeof p === 'string') { try { return JSON.parse(p); } catch { return {}; } }
    return p ?? {};
  };
  try { return await run(); }
  catch (e) {
    if (!e?.retryable) throw e;
    await sleep(e.retryAfterMs ?? 800 + Math.random() * 800);
    return run();
  }
}

const round = (v, d = 0) => (v == null || isNaN(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

/** Seconds spent in each heart-rate zone, from (time, heart_rate) samples. */
function timeInZones(streams, bounds) {
  const t = streams?.time, hr = streams?.heart_rate;
  if (!Array.isArray(t) || !Array.isArray(hr) || !bounds?.length || t.length !== hr.length) return null;
  const secs = bounds.map(() => 0);
  for (let i = 1; i < t.length; i++) {
    const h = hr[i], dt = t[i] - t[i - 1];
    if (!(dt > 0) || h == null) continue;
    let z = bounds.length - 1;
    while (z > 0 && h < bounds[z].min) z--;
    secs[z] += dt;
  }
  const total = secs.reduce((a, b) => a + b, 0);
  return total ? { seconds: secs, percent: secs.map(s => round((s / total) * 100)) } : null;
}

const fmtPace = (sec, dist) => {
  if (!sec || !dist) return null;
  const p = Math.round(sec / dist);
  return `${Math.floor(p / 60)}:${String(p % 60).padStart(2, '0')}`;
};

/** The fields stored on an activity's `actual` for one Strava run. */
function toActual(act, perf, streams, zones, units) {
  const m = METERS[units] || METERS.mi;
  const s = act.summary || {};
  const distance = round((s.distance || 0) / m, 2);
  const hrBounds = Array.isArray(zones?.heart_rate_zones) ? zones.heart_rate_zones : null;
  const laps = Array.isArray(perf?.laps) ? perf.laps.slice(0, 40).map(l => {
    const d = round((l.distance || 0) / m, 2);
    return { dist: d, time: l.moving_time ?? l.elapsed_time, pace: fmtPace(l.moving_time ?? l.elapsed_time, d), hr: round(l.avg_hr), maxHr: round(l.max_hr), elev: round(l.elevation_gain) };
  }) : [];
  const zoneTime = perf?.has_heartrate ? timeInZones(streams, hrBounds) : null;
  return {
    distance,
    duration: s.moving_time || s.elapsed_time || null,
    hr: perf?.has_heartrate ? round(perf.average_heartrate) : null,
    maxHr: perf?.has_heartrate ? round(perf.max_heartrate) : null,
    stravaId: String(act.id),
    stravaName: act.name || '',
    analysis: {
      source: 'Strava',
      paceUnit: `min/${units}`,
      elapsedSeconds: s.elapsed_time ?? null,
      elevationGainMeters: round(s.elevation_gain),
      cadenceStepsPerMin: perf?.average_cadence ? round(perf.average_cadence * 2) : null,
      relativeEffort: s.relative_effort ?? null,
      weather: act.weather || null,
      laps,
      hrZones: zoneTime && { boundsBpm: hrBounds.map(z => [z.min, z.max ?? null]), ...zoneTime },
    },
  };
}

let syncing = null;
export const isSyncing = () => !!syncing;

/**
 * Pull new Strava runs into the plan. Resolves { imported: [{itemId, date, added}], skipped }.
 * Only one sync runs at a time; a second call joins the first.
 */
export function syncStrava({ onProgress } = {}) {
  if (!syncing) syncing = doSync(onProgress).finally(() => { syncing = null; });
  return syncing;
}

async function doSync(onProgress = () => {}) {
  const mcp = await getMcp();
  if (!mcp) throw { code: 'capability_disabled' };
  const { settings, strava } = store.get();
  const units = settings.units || 'mi';
  const since = strava?.lastActivityDate
    ? addDays(strava.lastActivityDate, -2)
    : (settings.startDate && settings.startDate <= today() ? settings.startDate : addDays(today(), -28));

  onProgress('Checking Strava for new runs…');
  const acts = [];
  let after;
  for (let page = 0; page < 5; page++) {
    const res = await call(mcp, 'list_activities', {
      first: 100, ordering: 'StartDateLocalAsc', range_start: `${since}T00:00:00`, ...(after ? { after } : {}),
    });
    acts.push(...(res.activities || []));
    if (!res.has_next_page || !res.end_cursor) break;
    after = res.end_cursor;
  }
  const known = new Set(store.get().items.map(i => i.actual?.stravaId).filter(Boolean));
  const fresh = acts.filter(a => RUN_SPORTS.has(a.sport_type) && !known.has(String(a.id)));
  const lastDate = acts.map(a => String(a.start_local || '').slice(0, 10)).filter(Boolean).sort().pop();

  let zones = strava?.zones || null;
  if (fresh.length) {
    try { zones = await call(mcp, 'get_athlete_zones', {}); } catch { /* keep stored zones */ }
  }

  const imported = [];
  for (const [n, act] of fresh.entries()) {
    onProgress(`Importing run ${n + 1} of ${fresh.length}…`);
    const perf = await call(mcp, 'get_activity_performance', { activity_id: String(act.id) });
    let streams = null;
    if (perf?.has_heartrate) {
      try { streams = await call(mcp, 'get_activity_streams', { activity_id: String(act.id), streams: ['time', 'heart_rate'], resolution: 300 }); }
      catch { /* zones are optional */ }
    }
    const actual = toActual(act, perf, streams, zones, units);
    const date = String(act.start_local || '').slice(0, 10);
    if (!date) continue;

    // Match the planned run that day closest in distance; otherwise add the run to the plan.
    const candidates = store.get().items.filter(i => i.date === date && i.category === 'run' && !i.actual?.stravaId);
    const best = candidates.sort((a, b) =>
      Math.abs((a.planned?.distance ?? actual.distance) - actual.distance) - Math.abs((b.planned?.distance ?? actual.distance) - actual.distance))[0];
    if (best) {
      const keep = { rpe: best.actual?.rpe ?? null, notes: best.actual?.notes || '' };
      store.updateItem(best.id, { done: true, completedAt: best.completedAt || new Date().toISOString(), actual: { ...actual, ...keep } });
      imported.push({ itemId: best.id, date, added: false });
    } else {
      store.addItems([{
        date, category: 'run', runType: 'easy', title: act.name || 'Run', addedBy: 'strava',
        details: 'Imported from Strava. This run was not in the plan.', planned: { distance: null, duration: null },
        done: true, completedAt: new Date().toISOString(), actual,
      }]);
      const added = store.get().items.find(i => i.actual?.stravaId === actual.stravaId);
      if (added) imported.push({ itemId: added.id, date, added: true });
    }
  }

  store.setStrava({
    lastSyncAt: new Date().toISOString(),
    lastActivityDate: [strava?.lastActivityDate, lastDate].filter(Boolean).sort().pop() || null,
    zones: zones ? { heart_rate_zones: zones.heart_rate_zones || null } : null,
  });
  return { imported };
}
