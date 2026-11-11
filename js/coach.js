// Run coaching and plan-change proposals, using Claude through the artifact's `sample` capability.

import { store, CATEGORIES, RUN_TYPES, addDays, today, fmtDuration, fmtPace, num } from './store.js';

let samplePromise = null;
/** Resolves the `sample` function, or null when Claude isn't available on this page. */
export function getSample() {
  if (!samplePromise) {
    const c = typeof window !== 'undefined' && window.claude;
    samplePromise = c?.use ? c.use('sample').catch(() => null) : Promise.resolve(null);
  }
  return samplePromise;
}

const ERRORS = {
  not_granted: 'Coaching is turned off for this page. You can allow Claude in the page permissions.',
  sampling_disabled: "Claude isn't available on this account.",
  rate_limited: 'Too many requests just now. Try again in a minute.',
  session_expired: 'Sign in to claude.ai again, then retry.',
  invalid_json: "Claude's answer came back in the wrong format. Try again.",
  refused: 'Claude declined to coach this run.',
};
export const coachError = e => ERRORS[e?.code] || 'Coaching failed. Try again.';

const line = it => {
  const p = it.planned || {}, a = it.actual || {};
  const bits = [`${it.date} [${it.id}] ${CATEGORIES[it.category]?.label || it.category}: ${it.title}`];
  if (it.runType) bits.push(`type=${RUN_TYPES[it.runType] || it.runType}`);
  if (p.distance) bits.push(`planned ${p.distance}`);
  if (p.duration) bits.push(`planned ${fmtDuration(p.duration)}`);
  bits.push(it.done ? 'DONE' : 'not done');
  if (it.done) {
    if (a.distance) bits.push(`ran ${a.distance}`);
    if (a.duration) bits.push(`in ${fmtDuration(a.duration)} (${fmtPace(a.duration, a.distance || p.distance)})`);
    if (a.hr) bits.push(`avg HR ${a.hr}`);
    if (a.rpe) bits.push(`RPE ${a.rpe}`);
    if (a.notes) bits.push(`notes: "${String(a.notes).slice(0, 200)}"`);
  }
  return bits.join(' · ');
};

function buildPrompt(run) {
  const s = store.get();
  const { settings, items, logs } = s;
  const t = today();
  const recent = items.filter(i => i.category === 'run' && i.date >= addDays(run.date, -21) && i.date <= run.date && i.id !== run.id)
    .sort((a, b) => a.date.localeCompare(b.date));
  const upcoming = items.filter(i => i.date > t && i.date <= addDays(t, 14) && ['run', 'strength', 'cross', 'rest'].includes(i.category))
    .sort((a, b) => a.date.localeCompare(b.date));
  const checkins = Object.entries(logs).filter(([d]) => d >= addDays(run.date, -7) && d <= addDays(run.date, 1))
    .sort().map(([d, l]) => `${d}: ${Object.entries(l).map(([k, v]) => `${k}=${String(v).slice(0, 120)}`).join(', ')}`);
  const a = run.actual || {}, p = run.planned || {};
  const stream = a.analysis ? `\nDetailed data from the watch:\n${JSON.stringify(a.analysis).slice(0, 6000)}` : '';

  return `You are an experienced marathon coach reviewing one run for your athlete. Be specific, encouraging and honest. Use the athlete's units (${settings.units}).

ATHLETE AND GOAL
Race: ${settings.raceName || 'marathon'} on ${settings.raceDate || 'an unknown date'}. Today is ${t}.
${settings.coachNotes || '(No pace zones or goal notes given. Infer sensible guidance from the plan.)'}

THE RUN TO REVIEW
Planned: ${run.title}${run.runType ? ` (${RUN_TYPES[run.runType] || run.runType})` : ''}${p.distance ? `, ${p.distance} ${settings.units}` : ''}.
Plan details: ${(run.details || '').slice(0, 800)}
Actual: ${a.distance ? `${a.distance} ${settings.units}` : 'distance not logged'}${a.duration ? `, ${fmtDuration(a.duration)}, avg pace ${fmtPace(a.duration, a.distance || p.distance)}` : ''}${a.hr ? `, avg HR ${a.hr}` : ''}${a.rpe ? `, RPE ${a.rpe}/10` : ''}.
Athlete notes: ${a.notes || '(none)'}${stream}

LAST 3 WEEKS OF RUNS
${recent.map(line).join('\n') || '(none)'}

RECENT CHECK-INS (sleep hrs, energy/soreness 1-5)
${checkins.join('\n') || '(none)'}

NEXT 14 DAYS OF THE PLAN (ids in brackets)
${upcoming.map(line).join('\n') || '(none)'}

TASK
1. Judge the run against its purpose and pace zones (e.g. easy runs genuinely easy, threshold reps on target and even). If heart-rate or split data is present, use it.
2. Note trends across recent runs and check-ins (fatigue, pacing drift, missed sessions).
3. Only if the evidence clearly warrants it, propose a concrete change to UPCOMING items (dates after ${t}). Prefer small changes: adjust a pace target, swap a workout for easy running, add rest, shorten a run. Never touch the race itself. Usually no change is needed: then "proposal" is null.

Reply with only JSON of this shape:
{"headline": "one short sentence verdict",
 "rating": "great" | "good" | "mixed" | "concern",
 "summary": "2-4 sentences of coaching",
 "wentWell": ["..."], "watch": ["..."],
 "nextTime": "one practical tip for the next similar session",
 "proposal": null | {"title": "short name of the change", "reason": "why, citing the data",
   "changes": [
     {"op": "update", "id": "<item id>", "date"?: "YYYY-MM-DD", "title"?: "...", "details"?: "...", "distance"?: number},
     {"op": "delete", "id": "<item id>"},
     {"op": "add", "date": "YYYY-MM-DD", "category": "run|strength|mobility|nutrition|cross|recovery|rest|other", "title": "...", "details": "...", "distance"?: number, "runType"?: "easy|long|tempo|intervals|recovery|hills|race"}
   ]}}`;
}

/** Ask Claude to coach a run; stores the note and any proposal. Resolves the note. */
export async function coachRun(run, { onProgress } = {}) {
  const sample = await getSample();
  if (!sample) throw { code: 'capability_disabled' };
  const res = await sample.json(buildPrompt(run), {
    cache: false,
    onText: onProgress ? () => onProgress() : undefined,
  });
  if (!res || typeof res !== 'object' || !res.summary) throw { code: 'invalid_json' };
  const note = {
    itemId: run.id, date: run.date, createdAt: new Date().toISOString(), source: 'page',
    headline: String(res.headline || ''), rating: String(res.rating || ''), summary: String(res.summary || ''),
    wentWell: Array.isArray(res.wentWell) ? res.wentWell.map(String) : [],
    watch: Array.isArray(res.watch) ? res.watch.map(String) : [],
    nextTime: String(res.nextTime || ''),
  };
  const proposal = validateProposal(res.proposal);
  if (proposal) note.proposalId = store.addProposal({ ...proposal, fromItemId: run.id, source: 'coaching' });
  store.setCoaching(run.id, note);
  return note;
}

/** Keep only changes that point at real, future items; returns null when nothing usable is left. */
export function validateProposal(p) {
  if (!p || typeof p !== 'object' || !Array.isArray(p.changes)) return null;
  const items = store.get().items, t = today();
  const changes = p.changes.filter(c => {
    if (c?.op === 'add') return typeof c.date === 'string' && c.date >= t && CATEGORIES[c.category] && c.title;
    const it = items.find(i => i.id === c?.id);
    // Today's activities can change until they're done; past ones and the race never do.
    if (!it || it.date < t || (it.date === t && it.done) || (it.runType === 'race' && /marathon/i.test(it.title))) return false;
    return c.op === 'delete' || (c.op === 'update' && (!c.date || c.date >= t));
  });
  return changes.length ? { title: String(p.title || 'Plan change'), reason: String(p.reason || ''), changes } : null;
}

/** Plain-language description of one change, for the proposal card. */
export function describeChange(c) {
  const it = store.get().items.find(i => i.id === c.id);
  const name = it ? `${it.title} (${it.date})` : 'an activity';
  if (c.op === 'delete') return `Remove ${name}`;
  if (c.op === 'add') return `Add ${c.title} on ${c.date}${c.distance ? ` · ${c.distance} ${store.get().settings.units}` : ''}`;
  const bits = [];
  if (c.date && it && c.date !== it.date) bits.push(`move to ${c.date}`);
  if (c.title && it && c.title !== it.title) bits.push(`becomes "${c.title}"`);
  if (c.distance != null && it && c.distance !== it.planned?.distance) bits.push(`${it.planned?.distance ?? '–'} → ${c.distance} ${store.get().settings.units}`);
  if (c.details && it && c.details !== it.details) bits.push('new instructions');
  return `Change ${name}: ${bits.join(', ') || 'details'}`;
}

/** Apply an accepted proposal to the plan. Changes whose item no longer exists are skipped. */
export function applyProposal(id) {
  const p = store.get().proposals[id];
  if (!p) return 0;
  const valid = validateProposal(p);
  let applied = 0;
  for (const c of valid?.changes || []) {
    if (c.op === 'delete') { store.deleteItem(c.id); applied++; continue; }
    if (c.op === 'add') {
      store.addItems([{
        date: c.date, category: c.category, title: String(c.title), details: String(c.details || ''),
        runType: c.category === 'run' ? (RUN_TYPES[c.runType] ? c.runType : 'easy') : undefined,
        planned: { distance: num(c.distance), duration: null }, addedBy: 'coach',
      }]);
      applied++; continue;
    }
    const it = store.get().items.find(i => i.id === c.id);
    if (!it) continue;
    const patch = {};
    if (c.date) patch.date = c.date;
    if (c.title) patch.title = String(c.title);
    if (c.details) patch.details = String(c.details);
    if (c.distance != null) patch.planned = { ...it.planned, distance: num(c.distance) };
    store.updateItem(c.id, patch);
    applied++;
  }
  store.updateProposal(id, { status: 'accepted', decidedAt: new Date().toISOString(), applied });
  return applied;
}

export const pendingProposals = () =>
  Object.entries(store.get().proposals).filter(([, p]) => p.status === 'pending')
    .sort((a, b) => String(a[1].createdAt).localeCompare(String(b[1].createdAt)));

