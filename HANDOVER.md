# Training Partner — Handover

_Last updated: 2026-10-29. Read this first; it describes the app as it is now. The athlete-facing explanation of every function, context and calculation is `docs/Training-Partner-Guide.pdf` (source `docs/guide/Training-Partner-Guide.html`). History: `docs/CHANGELOG.md`; decisions: `docs/PLAN.md`._

## 1. What it is
Training Partner (formerly Ride Partner) is a personal, offline-first Android app for one athlete who rides (MTB/XC), runs, swims and trains in the gym. It syncs workouts from **Strava** and from the **Galaxy Watch via Samsung Health → Health Connect**, computes training physiology locally, and provides **AI coaching** (Aether + task-specific coaches) through the athlete's own API keys.

- Package: `com.ridepartner.v2` (kept so updates install in place; display name "Training Partner")
- Installed on the athlete's phone: see `C:\dev\releases` (one APK only). 3.5.0 (30501, squad server address built in) installed 2026-10-30; data kept (87 workouts, restore point "Before update to v3.5.0"), live server reachable from the phone.
- Source: GitHub `Bofa-Sanfaz/Ai-Training-Coach`, branch **`v3-rebuild`** (not merged into `main`). Local copy: `C:\dev\Ai-Training-Coach`.

## 2. Where things are
| What | Path |
|---|---|
| Project | `C:\dev\Ai-Training-Coach` |
| Current APK (only one kept) | `C:\dev\releases\RidePartner-v<ver>-<code>.apk` |
| Older APKs | `C:\dev\backups\old-apks` |
| Original v2 source | `C:\dev\backups\Ai-Training-Coach-v2-original` |
| Phone data copies (no API keys) | `C:\dev\backups\phone-rescue*.json`, `phone-now-*.json` |
| Portable toolchain | `C:\dev\tools` (node22, jdk21, android-sdk 36, git) |

## 3. Architecture
Plain HTML/CSS/JS (no bundler; classic scripts share one global scope — no duplicate top-level names) wrapped by **Capacitor 8**.
```
www/index.html            app shell; www/classic.html = old v2 UI (rollback)
www/css/app.css           design system + v3.3 components + motion system
www/js/recovery.js        crash guard + recovery screen
www/js/vendor/            dexie, plotly-basic, jspdf(+autotable), canvas-confetti (ISC)
www/js/app/util.js        formatting, dates, markdown
www/js/app/ui.js          toasts, dialogs, sheets, panels, back button, theme, haptics, capPlugin(), liveBubble, aiStatusIn
www/js/app/motion.js      view transitions, count-up, stagger, route draw, nav indicator, ripples, intro, confetti/records
www/js/app/db.js          Dexie schema v1–v3 (never bump — classic.html shares the DB), backups, restore points
www/js/app/sport.js       sports (ride/run/walk/swim/other), units, data flags + mv(), quality sheet, delete, activity inbox
www/js/app/physio.js      zones, metrics, TRIMP, CTL/ATL/TSB, records per sport, weekly totals (flag-aware)
www/js/app/athlete.js     weight log, training phases
www/js/app/strava.js      OAuth, sync (2026+, all sports, inbox routing, watch-copy replacement), streams
www/js/app/providers.js   AI providers, per-agent model choice, picker, strict retry, streaming, fallback, spend cap
www/js/app/skills.js      coach skills (www/skills/*.md), per-agent injection, GitHub import
www/js/app/health.js      Health Connect: wellness (+derived resting HR) and watch workouts (+inbox)
www/js/app/ai.js          per-agent context + prompts, style rules, coach memory, plan-update parsing
www/js/app/plan.js        template, day overrides (with sport), targets, adherence, AI planner
www/js/app/route.js       route SVG + share card
www/js/app/views/*.js     rides(Training), detail(+detail-sport), trends, compare, coach(Aether), reports(+PDF), profile
www/js/app/squad-core.js  SHARED with the squad server: event folding, relative scoring, monthly numbers
www/js/app/views/squad.js       Squad: storage, outbox + polling sync, sharing summaries/wellness, Home/Feed/Crew, chat, sheets, screenshot import
www/js/app/views/squad-stats.js Squad Stats + monthly Report (Plotly) + Report PDF
www/manifest.webmanifest  web app (friends on iPhone add it to the home screen)
www/js/app/huawei.js      Huawei Health data-export importer (zip.js for AES ZIPs)
www/js/app/views/intro.js first-run introduction (fresh installs / web app)
squad/                    Squad server: Cloudflare Worker + D1 (see squad/README.md — deploy, limits, tests)
scripts/                  build-apk.ps1, patch-android.js, phone-update.ps1, phone-rescue.js, phone-eval.js
```

## 3b. Squad (3.5)
- Tab **Squad** = its own app section: Home · Chat (panel) · Feed · Stats · Report · Crew; switcher for several challenges.
- Server `squad/` (free Cloudflare Worker + D1, cron every 15 min). Everything is an event with a per-challenge `seq`; clients pull `/changes?since=` and push an outbox (`squad_outbox`) with client ids → idempotent. Poll 4 s (chat) / 15 s (tab) / 60 s.
- Local config keys: `squad_challenges` (entries incl. member token, `shared`, `daily_shared`, sharing toggles), `squad_outbox`, `squad_data_<id>` (events, members, challenge), `squad_current`, `squad_server`, `squad_name`.
- AI: owner's provider config + key stored only on the server; client calls `POST /ai/run` when a response says `ai_due`; lease on `challenges.ai_lock`; etiquette (90 s quiet, 1 per 2 h, 4/day), recaps, monthly report, screenshot → workout (`/ai/extract`).
- Fairness: scores only against own baseline; weight only as a change (UI, PDF, AI).
- AI context digest: phones upload `SquadCore.digest` after each sync (`PUT /api/c/:id/digest`); AI runs use it when it covers the newest activity/wellness seq, else read history (keeps AI runs ≈10 ms CPU on the free plan).
- Web app (friend's iPhone): Gemini-only personal AI (`geminiOnly()`), Huawei import, introduction; Samsung card explains it is Android-only. Config keys: `intro_done`, `athlete_age`, `huawei_zip_pw` (sensitive), `huawei_last_import`.
- **Live** since 2026-10-29: https://training-partner-squad.training-partner-squad.workers.dev (owner's Cloudflare account; wrangler is logged in on this PC). Redeploy with `cd squad; npx wrangler deploy` (also republishes the web app from `www/`). Tests: `squad/test/api-test.mjs` (68 local checks), live smoke test 15/15 (test data removed).

## 4. Data (IndexedDB "RidePartnerDB", phone only)
`workouts` (+ `sport`, `indoor`, `data_flags`, `source:'health'` with negative `strava_id`), `streams`, `threads` (session chats; `pending`, `kind`, `ai_*`), `master_chat` (Aether; `pending`, proposals, `ai_*`), `graph_threads`, `reports`, `config`.
New config keys in 3.3: `coach_memory`, `deleted_workouts`, `activity_inbox`, `activity_rules`, `activity_skipped`, `compare_ai_<ids>`, `health_perm_ver`, `health_workouts_scanned`; `ai_providers.agentModels` = `{agent: {pid, model, strict}}`.

## 5. AI
Agents: aether, ride, compare, report, trends, planner (`AI_AGENTS`). Context per agent and every formula: see the guide PDF, sections 6–8. Budgets in `contextBudget(agent)`. Reply rules in `formattingRules()`; skills in `www/skills`.
Phone (2026-10-29): providers Gemini (gemini-3.8-flash), Groq (gpt-oss-120b, active), OpenRouter (set to a *code* model — recommend switching to a chat model).

## 6. Build & release
`powershell -ExecutionPolicy Bypass -File scripts\build-apk.ps1 -VersionCode <n>` → single APK in `C:\dev\releases`. Raise the version code every build.
Update in place: `adb install -r <apk>` (same key `persistent-keystore.jks`, alias androiddebugkey / android).
Diagnostics over USB: `adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>` then `node scripts/phone-eval.js 9333 "<read-only expression>"` (the app must be in the foreground) or `node scripts/phone-rescue.js 9333 out.json` to copy data.

## 7. Privacy
Public repo: commits use `Bofa-Sanfaz@users.noreply.github.com`; never commit backups, keys, `.claude/`, `android/`, `www/_tmp*`, `.wrangler/`, `.dev.vars`, the Samsung SDK AAR. Squad member tokens and the AI key never go into the repo (tokens live in the app's DB, the key in D1). Health Connect is read-only. WebView debugging is enabled for USB diagnostics (only an adb-authorised computer can use it).

## 8. Known limits / next ideas
- Samsung Health shares neither resting HR nor HRV with Health Connect: resting HR is estimated (lowest hourly average); HRV unavailable.
- Swims/treadmill/gym come from the Samsung Health Data SDK (native/samsung-swims, built in only when the AAR is at C:\dev\tools\samsung-health-data-sdk — not in the repo; CI builds without it). Needs Samsung Health developer mode for data read on the phone.
- Sleep is only present on nights the watch is worn.
- True background retries need the app process alive (Android may freeze it); unanswered messages resume when the app is opened again.
