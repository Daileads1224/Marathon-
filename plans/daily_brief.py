"""Evening reminder: tomorrow's training and today's open items and meal logging.

Usage:
  python3 plans/daily_brief.py WEEKS_DIR [MEALS_DIR] [--tz America/New_York] [--date YYYY-MM-DD]

WEEKS_DIR / MEALS_DIR hold the app's weeks/<monday>.json and meals/<YYYY-MM>.json documents
(ArtifactData list with out_dir). Prints a one-line notification first, then the detail.
"""
import argparse, json, os
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

PACE = {'easy': '8:30–9:30', 'recovery': '9:30–10:15', 'long': '8:15–9:15'}
ORDER = ['run', 'strength', 'mobility', 'recovery', 'cross', 'nutrition', 'rest', 'other']


def load(dir_, key):
    out = []
    if not dir_ or not os.path.isdir(dir_):
        return out
    for f in sorted(os.listdir(dir_)):
        if f.endswith('.json'):
            doc = json.load(open(os.path.join(dir_, f)))
            out.append((doc.get('data') or doc).get(key))
    return out


def minutes(details):
    first = (details or '').split('\n')[0]
    return first.rstrip('.') if 'min' in first else ''


def label(it):
    p = it.get('planned') or {}
    if it['category'] == 'run':
        bits = [it['title']]
        if p.get('distance'):
            bits.append(f"{p['distance']:g} mi")
        if it.get('runType') in PACE and '@' not in it['title']:
            bits.append(f"@ {PACE[it['runType']]}")
        return ' '.join(bits)
    if it['category'] in ('strength', 'mobility', 'recovery'):
        m = minutes(it.get('details'))
        return f"{it['title']} ({m})" if m else it['title']
    return it['title']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('weeks_dir')
    ap.add_argument('meals_dir', nargs='?')
    ap.add_argument('--tz', default='America/New_York')
    ap.add_argument('--date', help='today, as YYYY-MM-DD (default: now in --tz)')
    a = ap.parse_args()
    today = date.fromisoformat(a.date) if a.date else datetime.now(ZoneInfo(a.tz)).date()
    tmr = today + timedelta(days=1)

    items = [i for week in load(a.weeks_dir, 'items') for i in (week or [])]
    by_day = lambda d: sorted((i for i in items if i['date'] == d.isoformat()),
                              key=lambda i: ORDER.index(i['category']) if i['category'] in ORDER else 99)
    tomorrow = [i for i in by_day(tmr) if not i.get('done')]
    open_today = [i for i in by_day(today) if not i.get('done') and i['category'] in ('run', 'strength', 'mobility', 'recovery')]

    meals = {}
    for month in load(a.meals_dir, 'days'):
        meals.update(month or {})
    logged = sum(len(v or []) for v in (meals.get(today.isoformat()) or {}).values())

    day_name = tmr.strftime('%a')
    runs = [label(i) for i in tomorrow if i['category'] == 'run']
    others = [label(i) for i in tomorrow if i['category'] in ('strength', 'mobility', 'recovery', 'cross')]
    fuel = [i['title'] for i in tomorrow if i['category'] == 'nutrition' and i['title'] != 'Daily fuel targets']
    rest = not runs and any(i['category'] == 'rest' for i in tomorrow)

    head = f"{day_name}: " + ('; '.join(runs) if runs else 'Rest day' if rest else 'No run planned')
    if others:
        head += ' + ' + ', '.join(o.split(' (')[0] for o in others)
    nudges = []
    if logged == 0:
        nudges.append('No meals logged today')
    elif logged < 3:
        nudges.append(f'Only {logged} meal item{"s" if logged != 1 else ""} logged today')
    if open_today:
        nudges.append(f"{len(open_today)} open today: {', '.join(i['title'] for i in open_today)[:60]}")
    line = head + ('. ' + '. '.join(nudges) if nudges else '') + '.'
    print(line[:200])

    print()
    print(f"Tomorrow, {tmr.strftime('%A %b %-d')}:")
    for i in tomorrow:
        if i['category'] == 'nutrition':
            continue
        print(f"- {label(i)}")
    if fuel:
        print(f"Fueling: {', '.join(fuel)}")
    print(f"Today: {logged} meal item{'s' if logged != 1 else ''} logged" + (f"; still open: {', '.join(i['title'] for i in open_today)}" if open_today else '; training all ticked off'))


if __name__ == '__main__':
    main()
