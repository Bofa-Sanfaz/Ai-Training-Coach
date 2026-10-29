# v3 Work Plan & Progress Log

Kept up to date while working so context isn't lost. ✅ done · 🔄 in progress · ⏳ pending

## Locations
| What | Path |
|------|------|
| Project | `C:\dev\Ai-Training-Coach` |
| Untouched original (v2) | `C:\dev\backups\Ai-Training-Coach-v2-original` |
| Build tools (Node 20, JDK 17, Android SDK) | `C:\dev\tools` |
| Finished APKs | `C:\dev\releases` |

## Architecture (v3)
```
www/
  index.html          app shell (markup only) + crash guard / recovery screen
  classic.html        previous v2 app, kept as the UI rollback target
  css/app.css         design system (light/dark tokens, components, animations)
  js/vendor/          dexie, plotly-basic, jspdf, autotable (offline)
  js/app/
    util.js           formatting, dates, markdown renderer
    ui.js             toasts, dialogs, sheets, panels, back button, theme
    db.js             Dexie schema (unchanged v1-v3, shared with classic), config, backups, restore points
    physio.js         zones, ride metrics (zones, VAM, drift, TRIMP), fitness/fatigue/form, records
    strava.js         OAuth, token cache, paginated sync with progress
    ai.js             Gemini client + all prompt builders
    views/*.js        rides, detail, trends, compare, coach, reports, profile
    main.js           boot, deep links, version-upgrade restore point
scripts/
  patch-android.js    applies manifest/strings/icons/splash/version to android/ (CI + local)
  build-apk.ps1       one-command local build → C:\dev\releases
android-res/          launcher icons, adaptive icon, splash (generated from assets/logo.svg)
```
**DB compatibility rule:** never bump the Dexie version — new fields are non-indexed, so classic.html can still open the same database (that is what makes UI rollback safe).

## Decisions from the user (2026-10-29)
- The app ships as an **APK only** → old Streamlit architecture (`app.py`, `requirements.txt`) **removed** (copy kept in `C:\dev\backups`). `classic.html` stays only as the in-app rollback target.
- Keep everything organised in `docs/*.md` so context isn't lost.
- Use design/animation skills & tools from GitHub → applied Anthropic's `frontend-design` skill guidelines (fetched from `anthropics/claude-plugins-official`); suggested installing the `frontend-design` and `Design` plugins.

## Design direction (from frontend-design review)
- Subject: a personal cycling coach for one rider. Visual language = **heart-rate zone colours** (they carry meaning everywhere: ride accent bar, zone strip, charts). Strava orange only for actions/brand.
- Type: **Barlow** for text, **Barlow Semi Condensed** for numbers/titles (race-number feel), bundled in `www/fonts` (OFL).
- No ALL-CAPS labels, sentence case. Motion only for user actions (panel slide, sheet, send, zone bars filling on open) — no fade-in on every card.
- One bold element: the week summary on Rides. Everything else quiet.

## Tasks
1. ✅ Download repo into `C:\dev`, back up original
2. ✅ Full review → `docs/REVIEW.md`
3. ✅ Toolchain downloaded; vendor libs bundled; classic.html rollback copy
4. ✅ Rewrite web app (all modules + views + recovery + main)
5. ✅ New features: profile/zones editor, fitness-fatigue-form (TRIMP), weekly summary, records, search/filter, light/dark, share sheet, restore points, classic switch, demo data
6. ✅ Logo + adaptive/themed/legacy launcher icons + splash (`scripts/render-icons.ps1`)
7. ✅ `app.py` removed (user: APK only)
8. ✅ Browser test with demo data (all tabs, rollback round-trip, classic opens shared DB, no console errors)
9. ✅ Build APK — SDK license accepted by user 2026-10-29. Output `C:\dev\releases\RidePartner-v3.0.0-30000.apk` (3.7 MB), package com.ridepartner.v2, signed with persistent-keystore.jks (SHA-256 46:E1:0C:…:C3:15, same as CI)
12. ✅ Pushed to GitHub on branch `v3-rebuild` (portable git in `C:\dev\tools\git`). Not merged into `main` — open a PR to review: https://github.com/Bofa-Sanfaz/Ai-Training-Coach/pull/new/v3-rebuild
10. ✅ CI workflow, README, CHANGELOG, ROLLBACK, BUILD docs
11. ✅ User asked for a lighter theme → light is default, lab panel/readouts now light too

## Not verified yet
- Real Strava sync and Gemini calls (no credentials here) — logic reviewed, demo data used for everything else.
- On-device behaviour (back button, share sheet, deep link) — needs a phone test.
