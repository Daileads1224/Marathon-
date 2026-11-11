"""Turn planned runs into Intervals.icu structured workouts and upsert them.

Intervals.icu then pushes the next 7 days of planned workouts to Garmin Connect, which syncs
them to the watch. Each event's external_id is the app's activity id, so re-running updates
workouts in place, and runs removed from the plan are deleted from the calendar.

Usage:
  python3 plans/intervals_sync.py WEEKS_DIR [--from YYYY-MM-DD] [--days 21] [--post] [--recreate]

WEEKS_DIR holds the app's weeks/<monday>.json documents (an ArtifactData list with out_dir).
Without --post it prints the events it would send. Authentication is added by the session's
network proxy, so no key is read here.

Garmin only receives pace targets when the Intervals.icu Run sport settings have a threshold
pace. Workouts sent before it was set need --recreate to be exported to Garmin again.
"""
import argparse, json, os, re, subprocess, sys
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

API = 'https://intervals.icu/api/v1/athlete/0'
TAG = 'marathon-planner'

# Pace zones per mile (from the plan), as (fast, slow) strings.
PACE = {
    'recovery': ('9:30', '10:15'), 'easy': ('8:30', '9:30'), 'long': ('8:15', '9:15'),
    'MP': ('7:10', '7:15'), 'T': ('6:45', '6:55'), 'HMP': ('6:50', '6:55'),
    'I': ('6:15', '6:25'), 'rep': ('5:45', '6:00'), 'race10k': ('6:45', '6:52'),
}
MI_KM = 1.609344


def pace(zone, unit):
    """'6:45-6:55/mi Pace', or the same converted to /km."""
    fast, slow = PACE[zone]
    if unit == 'mi':
        return f'{fast}-{slow}/mi Pace'
    def km(p):
        m, s = map(int, p.split(':')); t = round((m * 60 + s) / MI_KM)
        return f'{t // 60}:{t % 60:02d}'
    return f'{km(fast)}-{km(slow)}/km Pace'


def dist(miles, unit):
    if unit == 'mi':
        return f'{miles:g}mi'
    return f'{round(miles * MI_KM, 2):g}km'


def rep_dist(text, unit):
    """'1.5 mi' / '1000m' / '2 km' -> (step length string, miles)."""
    m = re.match(r'([\d.]+)\s*(mi|km|m)\b', text.strip())
    if not m:
        return None, 0
    v, u = float(m.group(1)), m.group(2)
    miles = v if u == 'mi' else v / MI_KM if u == 'km' else v / 1609.344
    if u in ('m', 'km'):
        return f'{v:g}{u}', miles  # keep metric reps as written
    return dist(miles, unit), miles


def zone_of(text):
    t = text.lower()
    if '@hmp' in t: return 'HMP'
    if '@mp' in t: return 'MP'
    if '@i' in t: return 'I'
    if '@t' in t or 'threshold' in t: return 'T'
    if 'rep pace' in t: return 'rep'
    return 'T'


def recovery(details):
    """Recovery between reps from the plan text: '2 min jog', '2:30 jog', '400m jog'."""
    if '400m jog' in details:
        return '400m'
    m = re.search(r'(\d+)(?::(\d+))?\s*(?:min)?\s*jog', details)
    if not m:
        return '2m'
    return f'{int(m.group(1)) * 60 + int(m.group(2))}s' if m.group(2) else f'{m.group(1)}m'


def workout(item, unit='mi'):
    """Intervals.icu workout text for one planned run, and its planned miles."""
    title, details = item.get('title', ''), item.get('details', '')
    total = (item.get('planned') or {}).get('distance') or 0
    rt = item.get('runType') or 'easy'
    lines = []
    WU = lambda mi: ['Warmup', f'- {dist(mi, unit)} {pace("easy", unit)}', '']
    CD = lambda mi: ['Cooldown', f'- {dist(max(1, round(mi, 1)), unit)} {pace("easy", unit)}']
    strides = re.search(r'(\d+)\s*×\s*20\s*s strides|(\d+)\s+strides|strides', f'{title} {details}', re.I)

    # n × distance @zone  (e.g. 3×1.5 mi @T, 6×1000m @I, 10×400m @ rep pace)
    m = re.search(r'(\d+)\s*×\s*([\d.]+\s*(?:mi|km|m))\b\s*@?\s*(\w+)?', title)
    # n × time (hill repeats, fartlek, 2 × 8 min @T)
    mt = re.search(r'(\d+)\s*×\s*(\d+)\s*(s|min)\b', title)
    # N mi with M @MP / last M @MP
    mw = re.search(r'([\d.]+)\s*mi with\s*([\d.]+)\s*@\s*(MP|HMP|T)', title)
    ml = re.search(r'last\s*([\d.]+)\s*@\s*MP', title)
    mtempo = re.search(r'([\d.]+)\s*mi tempo', title)

    if rt == 'race' and 'half' in title.lower():
        lines += WU(2) + ['Race', f'- {dist(13.1, unit)} {pace("HMP", unit)}', ''] + CD(max(1, total - 15.1))
    elif rt == 'race' and '10k' in title.lower():
        lines += WU(2) + ['10K time trial', f'- {dist(6.2, unit)} {pace("race10k", unit)}', ''] + CD(max(1, total - 8.2))
    elif rt == 'race' and 'marathon' in title.lower():
        lines += ['Race', f'- {dist(26.2, unit)} {pace("MP", unit)}']
    elif m and not mw and 'with' not in title.split('×')[0]:
        n, (step, step_mi), z = int(m.group(1)), rep_dist(m.group(2), unit), zone_of(title)
        rec = recovery(details)
        work_mi = n * step_mi + n * 0.2
        wu = 2 if total - work_mi >= 3 else 1.5
        lines += WU(wu) + [f'Main set {n}x', f'- {step} {pace(z, unit)}', f'- {rec} {pace("recovery", unit)}', ''] + CD(total - wu - work_mi)
    elif mt:
        n, v, u = int(mt.group(1)), int(mt.group(2)), mt.group(3)
        on = f'{v}s' if u == 's' else f'{v}m'
        if 'uphill' in title.lower():
            work, rec, label = f'- {on} hard uphill effort', f'- {on} easy jog down', 'Hill repeats'
        elif 'fartlek' in title.lower():
            work, rec, label = f'- {on} 10K–5K effort', '- 1m easy jog', 'Fartlek'
        else:
            work, rec, label = f'- {on} {pace(zone_of(title), unit)}', f'- {recovery(details)} {pace("recovery", unit)}', 'Main set'
        lines += WU(2 if total >= 6 else 1.5) + [f'{label} {n}x', work, rec, ''] + CD(max(1, total - 4))
    elif re.search(r'\d+\s*mi with\s*\d+\s*×\s*1\s*mi\s*@MP', title):  # 6 mi with 3×1 mi @MP
        n = int(re.search(r'with\s*(\d+)\s*×', title).group(1))
        lines += WU(1.5) + [f'Main set {n}x', f'- {dist(1, unit)} {pace("MP", unit)}', f'- 2m {pace("recovery", unit)}', ''] + CD(max(1, total - 1.5 - n * 1.2))
    elif mw:
        tot, work, z = float(mw.group(1)), float(mw.group(2)), mw.group(3)
        wu = max(1, round((tot - work) / 2, 1))
        lines += WU(wu) + ['Main set', f'- {dist(work, unit)} {pace(z, unit)}', ''] + CD(tot - work - wu)
    elif mtempo:
        work = float(mtempo.group(1))
        lines += WU(2) + ['Tempo', f'- {dist(work, unit)} {pace("T", unit)}', ''] + CD(max(1, total - work - 2))
    elif rt == 'long':
        last = float(ml.group(1)) if ml else 0
        lines += ['Long run', f'- {dist(total - last, unit)} {pace("long", unit)}']
        if last:
            lines += ['', 'Finish at marathon pace', f'- {dist(last, unit)} {pace("MP", unit)}']
    else:
        z = 'recovery' if rt == 'recovery' else 'easy'
        lines += ['Easy run', f'- {dist(total or 3, unit)} {pace(z, unit)}']
        if strides:
            n = next((int(g) for g in strides.groups() if g), 6)
            lines += ['', f'Strides {n}x', f'- 20s {pace("rep", unit)}', f'- 60s {pace("recovery", unit)}']
        if 'hill sprint' in title.lower():
            lines += ['', 'Hill sprints 6x', '- 10s max effort uphill', '- 90s walk down']
    return '\n'.join(lines), total


def load_items(weeks_dir):
    items = []
    for f in sorted(os.listdir(weeks_dir)):
        if f.endswith('.json'):
            doc = json.load(open(os.path.join(weeks_dir, f)))
            items += (doc.get('data') or doc).get('items', [])
    return items


def curl(method, url, body=None):
    cmd = ['curl', '-sS', '-X', method, url, '-H', 'Content-Type: application/json', '-w', '\n%{http_code}']
    if body is not None:
        cmd += ['--data-binary', '@-']
    out = subprocess.run(cmd, input=json.dumps(body) if body is not None else None, capture_output=True, text=True)
    text, _, code = out.stdout.rpartition('\n')
    return int(code or 0), text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('weeks_dir')
    # Scheduled runs happen on UTC machines; 'today' means today where the athlete is.
    ap.add_argument('--tz', default='America/New_York')
    ap.add_argument('--from', dest='start', default=None)
    ap.add_argument('--days', type=int, default=21)
    ap.add_argument('--unit', default='mi', choices=['mi', 'km'])
    ap.add_argument('--post', action='store_true')
    ap.add_argument('--recreate', action='store_true',
                    help='delete and re-create this window\'s workouts so Intervals.icu sends them to Garmin again')
    a = ap.parse_args()
    a.start = a.start or datetime.now(ZoneInfo(a.tz)).date().isoformat()
    end = (date.fromisoformat(a.start) + timedelta(days=a.days - 1)).isoformat()

    runs = [i for i in load_items(a.weeks_dir)
            if i.get('category') == 'run' and a.start <= i['date'] <= end and not i.get('done')]
    events = []
    for r in sorted(runs, key=lambda r: r['date']):
        text, miles = workout(r, a.unit)
        events.append({
            'category': 'WORKOUT', 'type': 'Run', 'external_id': r['id'],
            'start_date_local': f"{r['date']}T00:00:00", 'name': r['title'],
            'description': text, 'distance': round(miles * 1609.344) if miles else None, 'tags': [TAG],
            'target': 'PACE',  # export pace targets to the watch rather than leaving it to "auto"
        })
    if not a.post:
        print(json.dumps(events, ensure_ascii=False, indent=1))
        return

    if a.recreate:
        code, text = curl('PUT', f'{API}/events/bulk-delete', [{'external_id': e['external_id']} for e in events])
        print('deleted for re-create', code, text[:120])
    code, text = curl('POST', f'{API}/events/bulk?upsert=true', events)
    print('upsert', code, text[:300] if code >= 300 else f'{len(events)} workouts')
    if code >= 300:
        sys.exit(1)
    # Remove workouts this script created earlier whose runs are no longer in the plan window.
    code, text = curl('GET', f'{API}/events?oldest={a.start}&newest={end}&category=WORKOUT')
    if code == 200:
        keep = {e['external_id'] for e in events}
        stale = [{'external_id': e['external_id']} for e in json.loads(text)
                 if TAG in (e.get('tags') or []) and e.get('external_id') and e['external_id'] not in keep]
        if stale:
            code, text = curl('PUT', f'{API}/events/bulk-delete', stale)
            print('deleted', len(stale), code)


if __name__ == '__main__':
    main()
