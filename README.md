# Ride Partner — AI cycling coach (Android)

Offline-first cycling coach for one rider. Syncs rides from Strava, measures heart-rate zones, climbing VAM,
aerobic decoupling and training load, and uses Google Gemini as a personal coach.

<img src="assets/logo-512.png" width="96" alt="Ride Partner logo" />

## What's in the app (v3)
| Tab | What it does |
|-----|--------------|
| **Rides** | Weekly summary (rides, km, time, climb, streak, form), search & filters, rides grouped by month with zone strip |
| **Ride detail** | Key stats, W/kg, zone time, VAM, decoupling, load; comparison with prior rides of the same intent; stream chart; AI debrief and chat (with screenshots) |
| **Trends** | Fitness / Fatigue / Form (CTL / ATL / TSB from TRIMP), weekly volume, ride-by-ride progression, AI season audit |
| **Compare** | Two or three rides side by side + AI comparison |
| **Coach** | Master season coach with full memory + every ride thread |
| **Reports** | 7d / 30d / 1y / all-time KPIs vs previous period, zone strain, all-time records, AI review, A4 PDF export |
| **Profile** | Athlete, weight log, training phases, max/resting HR + zones, Strava & Gemini, light/dark theme, backups, restore points, Classic (v2) rollback, diagnostics, demo rides |

## Project layout
```
www/                  the app (no build step — plain HTML/CSS/JS)
  index.html          v3 app shell
  classic.html        previous v2 app, kept as the rollback version
  css/app.css         design system (light default + dark theme)
  fonts/              Barlow (SIL OFL)
  img/logo.svg        logo
  js/recovery.js      crash guard & recovery screen
  js/vendor/          Dexie, Plotly (basic), jsPDF, autotable — bundled for offline use
  js/app/             util, ui, db, physio, athlete, strava, ai, charts, demo, main
  js/app/views/       rides, detail, trends, compare, coach, reports, profile
android-res/          launcher icons (adaptive + themed + legacy PNG) and splash
assets/               logo sources and 512/1024 px PNGs
scripts/
  build-apk.ps1       local one-command build → C:\dev\releases
  patch-android.js    applies name, deep link, icons, splash, version to android/
  render-icons.ps1    regenerates PNG icons from the SVGs
docs/                 review, plan, changelog, rollback and build guides
```

## Docs
- [docs/REVIEW.md](docs/REVIEW.md) — everything that was wrong in v2 and how it was fixed
- [docs/CHANGELOG.md](docs/CHANGELOG.md) — what changed in v3
- [docs/ROLLBACK.md](docs/ROLLBACK.md) — how to undo a bad update (data and version)
- [docs/BUILD.md](docs/BUILD.md) — building the APK locally and on GitHub
- [docs/PLAN.md](docs/PLAN.md) — architecture, decisions and progress log
