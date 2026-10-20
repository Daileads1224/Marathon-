"""Generates the Sub-3:10 Long Island Marathon plan (Oct 12, 2026 – May 2, 2027)
as a ready-made plan for the app (JSON) and a spreadsheet (CSV).

Run:  python3 plans/build_sub310.py
"""
import csv, json, os
from datetime import date, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
BASE_START = date(2026, 10, 12)
BUILD_START = date(2026, 12, 28)
RACE = date(2027, 5, 2)

PACE = {
    'recovery': '9:30–10:15/mi', 'easy': '8:30–9:30/mi', 'long': '8:15–9:15/mi', 'mp': '7:10–7:15/mi',
    't': '6:45–6:55/mi', 'hmp': '6:50–6:55/mi', 'i': '6:15–6:25/mi (3:53–3:59/km)', 'strides': '5:45–6:00/mi',
}
WU = 'Includes 1.5–2 mi easy warm-up and 1–2 mi cool-down.'

items = []
def add(d, category, title, details='', distance=None, run_type=None):
    items.append({'date': d.isoformat(), 'category': category, 'title': title, 'details': details.strip(),
                  'distance': distance, 'run_type': run_type})

def easy(d, miles, extra='', title='Easy run'):
    add(d, 'run', title, f"Easy pace {PACE['easy']}, conversational.\n{extra}", miles, 'easy')

def mobility(d):
    add(d, 'mobility', 'Post-run mobility', '10 min: hips, calves, thoracic spine.')

def monday(d, note=''):
    add(d, 'rest', 'Rest day', f'Full rest, or 30–45 min easy cross-training (bike, elliptical or swim).\n{note}')
    add(d, 'recovery', 'Foam roll + light mobility', '10–15 min. Quads, calves, glutes, hips.')

STRENGTH_EX = """Bulgarian split squat — {s} × 6–8/leg, heavy
Romanian deadlift — {s} × 6–8
Step-ups (knee-height box) — {s} × 8/leg
Calf raises, straight + bent knee — {s} × 12–15 each, weighted
Hip thrust or glute bridge — {s} × 8–10
Copenhagen plank — {s} × 20–30 s/side
Dead bug + side plank — 2–3 × 30–45 s"""

def strength(d, phase, label):
    heavy = phase in ('base', 'foundation')
    sets = 3 if heavy else 2
    body = STRENGTH_EX.format(s=sets)
    if heavy:
        body += '\nPogo hops, then bounds — 3 × 20 s\n\nGo heavy: stop 2–3 reps short of failure.'
    elif phase == 'taper':
        body += '\n\nTaper: lighter, keep it crisp — nothing to failure.'
    else:
        body += '\n\nBuild phase: hold the weight steady, fewer sets.'
    add(d, 'strength', f'Strength — {label}', f'30–40 min.\n{body}')

def gut_target(d):
    if d < date(2027, 1, 1): return 'practice ~30–40 g carbs/hour'
    if d < date(2027, 2, 1): return '~40 g carbs/hour'
    if d < date(2027, 3, 1): return '~50–60 g carbs/hour'
    return '60–90 g carbs/hour'

def daily_fuel(d, kind):
    if kind == 'long':
        add(d, 'nutrition', 'Long-run fueling',
            f"Before (2–3 h): 1–2 g carbs/kg, low fat & fiber — e.g. bagel with honey + banana.\n"
            f"During: gel every 25–30 min + sports drink — train your gut: {gut_target(d)}; 400–800 ml fluid & 300–600 mg sodium/hour.\n"
            f"After (within 1 h): 1–1.2 g carbs/kg + 20–30 g protein — chocolate milk & a sandwich.\n"
            f"Today: 7–10 g carbs/kg.")
    elif kind == 'workout':
        add(d, 'nutrition', 'Fuel the workout',
            "2–3 h before: 1–2 g carbs/kg, low fat & fiber.\nWithin 1 h after: 1–1.2 g carbs/kg + 20–30 g protein (rice bowl, or chocolate milk + sandwich).\n"
            "Daily: 5–7 g carbs/kg, 1.6–1.8 g protein/kg — 4 meals of ~30 g protein.")
    else:
        add(d, 'nutrition', 'Daily fuel targets',
            "5–7 g carbs/kg (≈375–525 g at 75 kg), 1.6–1.8 g protein/kg (≈120–135 g).\nSpread protein across 4 meals of ~30 g. Don't diet during the build. Keep alcohol light.")

# ---------------- Base block: 11 weeks, 30 → 45 mi, easier every 4th week ----------------
BASE = [30, 33, 36, 29, 36, 39, 41, 33, 40, 43, 45]

def split(total, weights):
    raw = [total * w / sum(weights) for w in weights]
    out = [int(x) for x in raw]
    for i in sorted(range(len(raw)), key=lambda i: raw[i] - out[i], reverse=True)[: total - sum(out)]:
        out[i] += 1
    return out

for w, miles in enumerate(BASE):
    mon = BASE_START + timedelta(weeks=w)
    tue, wed, thu, fri, sat, sun = (mon + timedelta(days=i) for i in range(1, 7))
    cut = w in (3, 7)
    label = f'Base week {w + 1} of 11 · {miles} mi' + (' (easier week)' if cut else '')
    long_mi = round(miles * 0.3)
    run_fri = miles >= 36
    days = [tue, wed, thu] + ([fri] if run_fri else []) + [sat]
    weights = [1, 1.2, 1] + ([0.8] if run_fri else []) + [1]
    dist = dict(zip(days, split(miles - long_mi, weights)))

    monday(mon, label)
    easy(tue, dist[tue], f"Finish with 6 × 20 s strides @ {PACE['strides']} — fast and relaxed, full recovery.\n{label}", 'Easy run + strides')
    mobility(tue); strength(tue, 'base', 'A'); daily_fuel(tue, 'easy')
    easy(wed, dist[wed], 'Finish with 6–8 × 10 s steep hill sprints, walk down to recover fully.', 'Easy run + hill sprints')
    mobility(wed); daily_fuel(wed, 'easy')
    if w == 6:  # Thanksgiving week
        easy(thu, dist[thu], 'Optional: run a Thanksgiving turkey trot instead as a fitness check (go by effort).')
    else:
        easy(thu, dist[thu])
    mobility(thu); daily_fuel(thu, 'easy')
    if run_fri:
        easy(fri, dist[fri]); mobility(fri)
    else:
        add(fri, 'rest', 'Rest from running', 'No run today — strength only.')
    strength(fri, 'base', 'B'); daily_fuel(fri, 'easy')
    if w == 8:
        add(sat, 'run', '10K time trial (benchmark)',
            f"Fitness check: 42:30 or faster = on track for sub-3:10.\n2 mi warm-up + strides, 10K hard but even, 1–2 mi cool-down. "
            f"(If you'd rather, use a December 10K race.)", dist[sat], 'race')
    else:
        easy(sat, dist[sat], f"Finish with 6 × 20 s strides @ {PACE['strides']}.", 'Easy run + strides')
    mobility(sat); daily_fuel(sat, 'easy')
    add(sun, 'run', 'Long run', f"Easy to steady, {PACE['long']}. All easy in the base block.", long_mi, 'long')
    mobility(sun); daily_fuel(sun, 'long' if long_mi >= 10 else 'easy')

add(BASE_START + timedelta(days=14), 'other', 'Confirm race date', 'Confirm the Long Island Marathon date (expected Sun May 2, 2027) on the race site and register.')
add(BASE_START + timedelta(days=15), 'other', 'Book blood test: ferritin + vitamin D', 'Low levels are common in runners and hurt performance. Do this in the base block.')

# ---------------- 18-week build ----------------
# (phase, weekly miles, Tue (title, details, mi, type), Thu (...), Sun (...), Wed, Fri (0 = rest), Sat)
T, I, H, MP = PACE['t'], PACE['i'], PACE['hmp'], PACE['mp']
BUILD = [
    ('Foundation', 45, ('8×60s uphill', 'Hard but controlled uphill effort, jog down to recover.', 6, 'hills'),
        ('3×1.5 mi @T', f'2 min jog between. T = {T}.', 8, 'tempo'), ('Long run', '14 mi easy.', 14, 'long'), 7, 4, 6),
    ('Foundation', 48, ('6×1000m @I', f'2:30 jog recoveries. I = {I}.', 8, 'intervals'),
        ('4 mi tempo @T', f'T = {T}.', 8, 'tempo'), ('Long run', '15 mi easy.', 15, 'long'), 7, 4, 6),
    ('Foundation', 51, ('10×60s uphill', 'Hard but controlled uphill effort, jog down.', 7, 'hills'),
        ('2×2.5 mi @T', f'3 min jog between. T = {T}.', 9, 'tempo'), ('Long run — last 3 @MP', f'16 mi, last 3 @ MP {MP}.', 16, 'long'), 8, 5, 6),
    ('Cutback', 42, ('Fartlek 10×1 min on / 1 min off', 'On ≈ 10K–5K effort, off = easy jog.', 7, 'intervals'),
        ('Easy 6 + strides', f'6 × 20 s strides @ {PACE["strides"]}.', 6, 'easy'), ('Long run', '12 mi easy.', 12, 'long'), 7, 4, 6),
    ('Foundation', 53, ('5×1 mi @T', f'1 min jog between. T = {T}.', 9, 'tempo'),
        ('9 mi with 6 @MP', f'MP = {MP}. Take a gel if over 75 min.', 9, 'tempo'), ('Long run', '17 mi easy.', 17, 'long'), 8, 4, 6),
    ('Foundation', 56, ('6×1000m @I', f'2:30 jog recoveries. I = {I}.', 8, 'intervals'),
        ('5 mi tempo @T', f'T = {T}.', 9, 'tempo'), ('Long run — last 4 @MP', f'18 mi, last 4 @ MP {MP}.', 18, 'long'), 9, 5, 7),
    ('Cutback', 47, ('10×400m @ rep pace', f'400m jog between. Rep pace {PACE["strides"]}.', 8, 'intervals'),
        ('Easy 6 + strides', f'6 × 20 s strides @ {PACE["strides"]}.', 6, 'easy'), ('Long run', '13 mi easy.', 13, 'long'), 8, 5, 7),
    ('Build', 57, ('5×1200m @I', f'3 min jog recoveries. I = {I}.', 9, 'intervals'),
        ('3×2 mi @T', f'2 min jog between. T = {T}.', 10, 'tempo'), ('Long run', '18 mi easy.', 18, 'long'), 8, 5, 7),
    ('Build', 60, ('4×1.5 mi @T', f'2 min jog between. T = {T}.', 10, 'tempo'),
        ('11 mi with 8 @MP', f'MP = {MP}. BENCHMARK: MP should feel controlled, heart rate steady. Gel if over 75 min.', 11, 'tempo'),
        ('Long run', '20 mi easy to steady. Cap at ~3 hours.', 20, 'long'), 8, 4, 7),
    ('Cutback', 50, ('6×800m @I', f'2 min jog recoveries. I = {I}.', 8, 'intervals'),
        ('Easy 7 + strides', f'6 × 20 s strides @ {PACE["strides"]}.', 7, 'easy'), ('Long run', '14 mi easy.', 14, 'long'), 9, 5, 7),
    ('Build', 62, ('6×1 mi @HMP', f'1 min jog between. HMP = {H}.', 10, 'tempo'),
        ('13 mi with 10 @MP', f'MP = {MP}. Practice race fueling.', 13, 'tempo'), ('Long run — last 5 @MP', f'20 mi, last 5 @ MP {MP}.', 20, 'long'), 8, 4, 7),
    ('Tune-up', 52, ('3×1 mi @T', f'2 min jog between. T = {T}. Longer warm-up/cool-down.', 9, 'tempo'),
        ('Easy 5 + strides', f'6 × 20 s strides @ {PACE["strides"]}.', 5, 'easy'),
        ('🏁 Tune-up half marathon', 'Target ≤ 1:31 (1:29–1:30 means 3:05–3:08 is possible). If slower than 1:32, aim for 3:15 and recheck your paces. '
         'No half available? Run a hard 10–12 mi effort at HMP instead.\n~2 mi warm-up + 13.1 race + cool-down.', 16, 'race'), 10, 6, 6),
    ('Race-specific', 64, ('2×3 mi @T', f'3 min jog between. T = {T}.', 10, 'tempo'),
        ('12 mi with 8 @MP', f'MP = {MP}. Practice race fueling.', 12, 'tempo'), ('Long run', '20 mi easy.', 20, 'long'), 9, 6, 7),
    ('Race-specific', 62, ('5×2 km @HMP', f'2 min jog between. HMP = {H}.', 10, 'tempo'),
        ('13 mi easy (medium-long)', f'Easy {PACE["easy"]}.', 13, 'easy'), ('Long run — last 4 @MP', f'22 mi, last 4 @ MP {MP}. Cap at ~3 hours.', 22, 'long'), 7, 4, 6),
    ('Peak', 65, ('6×1 mi @T', f'1 min jog between. T = {T}.', 11, 'tempo'),
        ('10 mi with 6 @MP', f'MP = {MP}.', 11, 'tempo'),
        ('Dress rehearsal: 18 mi with 14 @MP', f'BENCHMARK: averages 7:10–7:15 without straining = 3:10 is realistic.\nWear race kit & shoes, eat your race breakfast, use your race fueling plan.', 18, 'long'), 10, 7, 8),
    ('Taper', 54, ('5×1000m @I', f'2:30 jog recoveries. I = {I}.', 8, 'intervals'),
        ('10 mi with 6 @MP', f'MP = {MP}.', 10, 'tempo'), ('Long run — last 3 @MP', f'16 mi, last 3 @ MP {MP}.', 16, 'long'), 8, 5, 7),
    ('Taper', 42, ('4×1 mi @T', f'2 min jog between. T = {T}.', 8, 'tempo'),
        ('8 mi with 4 @MP', f'MP = {MP}.', 8, 'tempo'), ('Long run', '12 mi easy.', 12, 'long'), 7, 0, 7),
]

for w, (phase, miles, tue_w, thu_w, sun_w, wed_mi, fri_mi, sat_mi) in enumerate(BUILD):
    mon = BUILD_START + timedelta(weeks=w)
    tue, wed, thu, fri, sat, sun = (mon + timedelta(days=i) for i in range(1, 7))
    assert tue_w[2] + wed_mi + thu_w[2] + fri_mi + sat_mi + sun_w[2] == miles, (w + 1, miles)
    label = f'Build week {w + 1} of 18 · {phase} · {miles} mi'
    sphase = 'foundation' if w < 6 else ('taper' if w >= 15 else 'build')
    workout = lambda t: f"{t[1]}\n{WU if t[3] not in ('easy', 'long') else ''}\n{label}"

    monday(mon, label)
    add(tue, 'run', tue_w[0], workout(tue_w), tue_w[2], tue_w[3]); mobility(tue)
    strength(tue, sphase, 'Tue'); daily_fuel(tue, 'workout')
    easy(wed, wed_mi, f"Day after a hard session — start at recovery pace {PACE['recovery']}."); mobility(wed); daily_fuel(wed, 'easy')
    add(thu, 'run', thu_w[0], workout(thu_w), thu_w[2], thu_w[3]); mobility(thu)
    daily_fuel(thu, 'workout' if thu_w[3] != 'easy' else 'easy')
    if fri_mi:
        easy(fri, fri_mi, 'Recovery pace for the first miles.'); mobility(fri)
    else:
        add(fri, 'rest', 'Rest day', 'Taper — rest from running.')
    if w < 15:
        strength(fri, sphase, 'Fri')
    daily_fuel(fri, 'easy')
    easy(sat, sat_mi, f"Finish with 6 × 20 s strides @ {PACE['strides']}.", 'Easy run + strides'); mobility(sat)
    daily_fuel(sat, 'easy')
    add(sun, 'run', sun_w[0], f"{sun_w[1]}\n{label}", sun_w[2], sun_w[3]); mobility(sun)
    daily_fuel(sun, 'long')

add(date(2027, 2, 1), 'other', 'Buy race shoes (if racing in carbon plates)', 'Test them in at least two MP workouts and the week 15 dress rehearsal.')

# ---------------- Race week (week 18) ----------------
mon = BUILD_START + timedelta(weeks=17)
tue, wed, thu, fri, sat = (mon + timedelta(days=i) for i in range(1, 6))
label = 'Build week 18 of 18 · Race week · 24 mi + race'
monday(mon, label)
add(mon, 'other', 'Race-week checklist: logistics', 'Confirm race date, start time, bib pickup and travel plan.')
add(tue, 'run', '6 mi with 3×1 mi @MP', f'MP = {MP}. Easy before and after.\n{label}', 6, 'tempo'); mobility(tue); daily_fuel(tue, 'workout')
easy(wed, 6, 'Relaxed.'); mobility(wed); daily_fuel(wed, 'easy')
add(wed, 'other', 'Race-week checklist: forecast & pacing', 'Check the forecast and set the pacing plan. Hot (65°F+) or windy: start 5–10 s/mi slower.')
easy(thu, 5, f"Finish with 4 × 20 s strides @ {PACE['strides']}.", 'Easy 5 + 4 strides'); mobility(thu); daily_fuel(thu, 'easy')
easy(fri, 4, 'Short and easy.'); mobility(fri)
add(fri, 'nutrition', 'Carb load — day 1', '8–10 g carbs/kg (≈600–750 g at 75 kg), low fiber. Hydrate.')
add(sat, 'run', 'Shakeout 2–3 mi + 4 strides', 'Very easy.', 3, 'recovery')
add(sat, 'nutrition', 'Carb load — day 2', '8–10 g carbs/kg (≈600–750 g at 75 kg), low fiber. Hydrate.')
add(sat, 'other', 'Lay out kit, gels and race breakfast', 'Nothing new on race day: shoes, socks, shorts, gels and breakfast all tested. Anti-chafe, throwaway layers, bathroom plan.')
add(RACE, 'nutrition', 'Race-morning fueling',
    '3 h before: 2–3 g carbs/kg (150–225 g) — bagel, banana, jam, sports drink.\nGel 10–15 min before the start, then one every 25–30 min (6–7 gels) + sports drink at aid stations for 60–90 g/hour.\n'
    'Caffeine (optional): ~3 mg/kg (~200 mg) 1 h before, or a caffeinated gel after mile 16.')
add(RACE, 'run', '🏁 Long Island Marathon — goal sub-3:10',
    'Run an even race. Halfway in ~1:34:30–1:35:00.\nMiles 1–3: 7:15–7:20 (should feel too easy)\nMiles 4–13.1: 7:10–7:13\nMiles 14–20: 7:10–7:13 — stay patient, fuel on schedule\n'
    'Miles 20–26.2: 7:05–7:12 only if strong\nAim for 7:10–7:12 on the watch (GPS reads long).', 26.2, 'race')

items.sort(key=lambda i: i['date'])
ORDER = ['run', 'strength', 'mobility', 'nutrition', 'cross', 'recovery', 'rest', 'other']
items.sort(key=lambda i: (i['date'], ORDER.index(i['category'])))

plan = {
    'name': 'Sub-3:10 Marathon — Long Island 2027',
    'description': '11-week base (Oct 12) + 18-week build to the Long Island Marathon on Sun May 2, 2027. Runs, strength, mobility, fueling and race-week tasks.',
    'settings': {'raceName': 'Long Island Marathon', 'raceDate': RACE.isoformat(), 'startDate': BASE_START.isoformat(), 'units': 'mi', 'weekStart': 1},
    'items': [{
        'date': i['date'], 'category': i['category'], 'title': i['title'], 'details': i['details'],
        **({'runType': i['run_type']} if i['category'] == 'run' else {}),
        'planned': {'distance': i['distance'], 'duration': None},
    } for i in items],
}
with open(os.path.join(HERE, 'sub-3-10-long-island-2027.json'), 'w') as f:
    json.dump(plan, f, ensure_ascii=False, indent=1)
with open(os.path.join(HERE, 'sub-3-10-long-island-2027.csv'), 'w', newline='') as f:
    wr = csv.writer(f)
    wr.writerow(['date', 'category', 'title', 'details', 'distance', 'duration', 'run_type'])
    for i in items:
        wr.writerow([i['date'], i['category'], i['title'], i['details'], i['distance'] or '', '', i['run_type'] or ''])

# Summary for sanity-checking against the PDF.
from collections import defaultdict
wk = defaultdict(float)
for i in items:
    if i['category'] == 'run':
        d = date.fromisoformat(i['date'])
        wk[d - timedelta(days=d.weekday())] += i['distance'] or 0
print(len(items), 'items')
print(' '.join(f'{k:%b%d}:{v:g}' for k, v in sorted(wk.items())))
