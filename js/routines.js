// Strength and stretching routines: a small library, plus parsing of exercise lines in activity details.
// An exercise line looks like "Name — dose — cue" (cue optional), e.g. "Calf raises — 3 × 12–15 — weighted".

/** Why each strength exercise is in the plan, matched by keyword. */
const STRENGTH_WHY = [
  [/split squat/i, 'Single-leg strength for the push-off'],
  [/deadlift/i, 'Hamstrings and glutes'],
  [/step-up/i, 'Hip control and hill strength'],
  [/calf/i, 'Achilles and calf durability, the most common marathon breakdown'],
  [/hip thrust|glute bridge/i, 'Glute power'],
  [/copenhagen/i, 'Adductors and groin'],
  [/dead bug|side plank|plank/i, 'Core stability late in the race'],
  [/pogo|bound/i, 'Tendon stiffness and running economy'],
  [/squat/i, 'Quads and glutes'],
  [/lunge/i, 'Single-leg strength and balance'],
];
export const whyFor = name => STRENGTH_WHY.find(([re]) => re.test(name))?.[1] || '';

export const ROUTINES = {
  postRun: {
    title: 'Post-run mobility',
    minutes: 10,
    when: 'After every run',
    exercises: [
      { name: 'Calf stretch, straight knee', dose: '45 s/side', note: 'Heel down, lean into a wall' },
      { name: 'Calf stretch, bent knee', dose: '45 s/side', note: 'Targets the soleus and Achilles' },
      { name: 'Kneeling hip flexor stretch', dose: '45 s/side', note: 'Squeeze the glute, tuck the pelvis' },
      { name: 'Hamstring stretch, heel on a step', dose: '45 s/side', note: 'Hinge from the hips, back flat' },
      { name: 'Figure-4 glute stretch', dose: '45 s/side', note: 'Lying on your back, pull the knee in' },
      { name: 'Thoracic open books', dose: '8/side', note: 'Follow the top hand with your eyes' },
    ],
  },
  foamRoll: {
    title: 'Foam roll + light mobility',
    minutes: 12,
    when: 'Rest days and recovery days',
    exercises: [
      { name: 'Foam roll calves', dose: '60 s/side', note: 'Pause on tender spots, breathe' },
      { name: 'Foam roll quads', dose: '60 s/side', note: 'Hip to just above the knee' },
      { name: 'Foam roll outer quad and glutes', dose: '60 s/side', note: 'Stay off the knee joint' },
      { name: 'Foam roll upper back', dose: '60 s', note: 'Hands behind the head, small rolls' },
      { name: '90/90 hip switches', dose: '10 slow reps', note: 'Sit tall, knees fall side to side' },
      { name: 'Leg swings, front-back and side-side', dose: '10 each/side', note: 'Hold a wall, relaxed swings' },
    ],
  },
  warmUp: {
    title: 'Dynamic warm-up',
    minutes: 6,
    when: 'Before workouts, after the first easy mile',
    exercises: [
      { name: 'Leg swings, front-back', dose: '10/side', note: 'Relaxed, growing range' },
      { name: 'Leg swings, side-side', dose: '10/side', note: '' },
      { name: 'Walking lunge with twist', dose: '6/side', note: 'Rotate toward the front leg' },
      { name: 'A-skips', dose: '2 × 20 m', note: 'Quick, light contacts' },
      { name: 'Butt kicks', dose: '2 × 20 m', note: '' },
      { name: 'Strides', dose: '2–4 × 20 s', note: 'Build to fast and relaxed' },
    ],
  },
};

/** The routine text written into activity details, one exercise per line. */
export const routineDetails = r => `${r.minutes} min.\n${r.exercises.map(e => `${e.name} — ${e.dose}${e.note ? ` — ${e.note}` : ''}`).join('\n')}`;

/** Split details into exercise rows ("Name — dose — cue") and free-text notes. */
export function parseExercises(details = '') {
  const exercises = [], notes = [];
  for (const raw of String(details).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+[—–-]{1,2}\s+/);
    if (parts.length >= 2 && parts[0].length < 60) exercises.push({ name: parts[0], dose: parts[1], note: parts.slice(2).join(' — ') });
    else notes.push(line);
  }
  return { exercises, notes };
}

/** Exercises for a stretching/recovery activity: its own lines, else the matching library routine. */
export function routineFor(item) {
  const own = parseExercises(item.details);
  if (own.exercises.length) return { ...own, minutes: null };
  const lib = item.category === 'recovery' || /foam/i.test(item.title) ? ROUTINES.foamRoll : ROUTINES.postRun;
  return { exercises: lib.exercises, notes: own.notes, minutes: lib.minutes };
}

/** Rough minutes for a list of exercises ("45 s/side" counts both sides). */
export function estimateMinutes(exercises) {
  let sec = 0;
  for (const e of exercises) {
    const m = /(\d+)\s*s\b/.exec(e.dose);
    if (m) sec += +m[1] * (/side/.test(e.dose) ? 2 : 1) * (/(\d+)\s*×/.exec(e.dose)?.[1] || 1);
    else sec += 60;
  }
  return Math.max(1, Math.round(sec / 60));
}
