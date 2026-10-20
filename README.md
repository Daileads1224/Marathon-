# Marathon Planner

A simple, phone-friendly app for planning and tracking marathon training: runs, strength work, stretching and mobility, nutrition, cross-training, recovery and rest days, all on one calendar.

There's no account and no server. Your data stays in your browser on your device.

## Features

- **Today**: the day's checklist with one-tap check-off, a week strip with completion dots, and a daily check-in (sleep, weight, energy, soreness, water, notes).
- **Calendar**: a color-coded **month** view with weekly mileage (done/planned), and a **week** view with full workout details. You can filter by category, and tapping a day opens it.
- **Plan**: build your whole plan three ways:
  - add activities one at a time, with **weekly repeats** (e.g. strength every Tue/Thu until race day)
  - **import a spreadsheet** (CSV, or paste straight from Excel/Google Sheets), by date or by week number + weekday
  - load a **sample 16-week plan** (long-run build, cutback weeks, 3-week taper, strength, mobility, fueling, race-week carb load) and edit it
- **Log results**: actual distance, time (pace is calculated for you), effort (RPE), heart rate and notes for any activity.
- **Progress**: completion %, weekly and total distance, longest run, streak, average sleep, a planned-vs-completed weekly mileage chart, completion by category, and a recent runs table.
- **Settings**: race name and date (shown as a countdown with "Week N of M"), plan start date, miles/km, Monday or Sunday week start, JSON backup/restore and CSV export.
- Works offline and can be installed to your home screen (PWA).

## Running it

It's plain HTML/CSS/JavaScript with no build step and no dependencies. Because it uses JavaScript modules, it has to be served over HTTP rather than opened as a file:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

### Putting it on your phone (free)

1. On GitHub, open **Settings → Pages**, set *Source* to "Deploy from a branch", and pick your branch with the `/ (root)` folder.
2. Open the URL GitHub gives you (e.g. `https://<user>.github.io/Marathon-/`) on your phone.
3. Choose **Add to Home Screen** (Safari share menu, or the Chrome ⋮ menu). It now opens like an app and works offline.

> Data is stored per browser and device. To move your plan between your laptop and phone, use **Settings → Export backup** on one and **Restore backup** on the other.

## Importing a plan from a spreadsheet

The first row must be a header. Each row needs **either** a `date` (`YYYY-MM-DD`) **or** a `week` + `day` (`Mon`…`Sun`, counted from the plan start date in Settings).

| column | example | notes |
|---|---|---|
| `date` | `2026-11-08` | or leave blank and use week/day |
| `week` | `3` | week 1 = the week containing your plan start date |
| `day` | `Sat` | |
| `category` | `run` | `run`, `strength`, `mobility`, `nutrition`, `cross`, `recovery`, `rest`, `other` (common words like *stretching*, *yoga*, *gym*, *bike* also work) |
| `title` | `Long run` | |
| `details` | `Gel every 45 min` | exercises, sets, meals, targets: anything |
| `distance` | `14` | in your chosen units |
| `duration` | `45` or `1:15:00` | minutes, or h:mm:ss |
| `run_type` | `long` | `easy`, `long`, `tempo`, `intervals`, `recovery`, `hills`, `race` |

The **Plan → Import → Download template** button gives you a ready-made example file.

## Project layout

```
index.html            app shell
css/styles.css        styles (light + dark mode)
js/store.js           data model, localStorage persistence, date/pace helpers
js/plans.js           CSV import and the sample 16-week plan
js/charts.js          SVG charts + tooltips
js/app.js             views: Today, Calendar, Plan, Progress, Settings
sw.js                 offline cache
manifest.webmanifest  install-to-home-screen metadata
```
