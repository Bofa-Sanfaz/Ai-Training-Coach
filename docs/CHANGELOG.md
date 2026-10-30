# Changelog

## 3.8.0 — 2026-10-30 · screenshots in full, accounts, arcs
- **Screenshot reader v2** (`shots.js`): pick up to 8 screens at once; one AI call groups them per workout (summary, heart-rate / pace / elevation / cadence charts, splits, lengths, zone times) and reads every number, table row and chart curve. The approval screen shows consistency checks (splits vs duration and km, lengths vs distance, chart average vs summary, pace vs distance/time, zone times), the screenshots, a preview chart (pace and split axes in m:ss), include-toggles and the tables read. Saving turns the curves into a 10-s stream (HR, speed scaled to the summary distance, altitude, cadence → zones, load, charts), pool lengths into the per-length swim model, and keeps device extras (min HR, max cadence, stride, descent, VO2max, training effect, recovery, zones, splits). Squad fallback `/ai/extract` takes `images[]`.
- **Accounts for the web app** (`account.js`, server `src/account.js`, migration 0004): username + password; PBKDF2 (210k) derives an auth key (server stores only its SHA-256) and an encryption key that never leaves the device. The whole app (workouts, streams, chats, settings incl. keys, squad, local prefs) is gzip + AES-GCM encrypted and uploaded in ≤ 900 kB parts with versioned commits (conflict → pull first); 2 min after a change and when the app is hidden. Signing in on another device restores everything. 8 wrong passwords → 15 min lock. Profile → Account card. The Android app is unchanged.
- **Web introduction**: Welcome → **Account (required)** → **About you (required)** → Huawei history → Squad → AI coach → Done; no Skip until both are done. Strava is gone from the web app (new Strava API apps need a paid plan); Training shows Screenshot · Log.
- **Arcs** (Squad → Crew → *Start Arc N*): everyone in the challenge approves (banner with who approved, Approve / Not now / Call it off); then the challenge restarts today — scores, streaks, the feed and the chat start fresh (earlier ones one tap away) — with a full-screen "ARC N" animation on every device. From Arc 2 on, the arc that ended is archived (`arcs`) and Aether writes a thorough end-of-arc report and analysis (mode `arc`, whole-arc scoreboard, 20–35 lines); Report gets 🏁 Arc chips with the arc's own scores, weeks won, graphs, the AI analysis and a PDF. Workouts of earlier arcs stay shared for their reports.
- Server: `POST /api/c/:id/arc` (propose / approve / cancel), challenge columns `arc, arc_seq, arc_vote, arcs`; fixed the report month being dropped from AI requests.
- Arc animation: light streak → the old number glitches and shatters → the new one slams in (screen shake, shockwave rings, rotating light rays, spark trails, embers) → confetti cannons → the crew flies in with a VS → "Arc N champion" banner; haptics on native; reduced-motion respected.
- Audit fixes: an ended arc keeps everyone's "own usual" snapshot (its report and champion never re-score); a new arc refreshes the baselines to the last 4 weeks; screenshots read at 2000 px with a 32k output budget (thinking counts), a reply cut at the limit keeps its complete workouts, today's date in the prompt, a future year is corrected and flagged, a missing date flagged; pace/speed use the moving time when the screens show it; accounts: vault parts as base64 text the server only passes through (no CPU-heavy byte conversion), workouts logged on this device survive a pull from another device (merged and re-uploaded), sign-out offers to remove the data from a shared device; signups capped at 30 accounts and challenges at 40 so strangers can't fill the free database. Tests: 106 passing.

## 3.7.0 — 2026-10-30 · first-run flow for a Huawei user
- Introduction on the web app: Welcome → About you → **Huawei history** (request steps, import the export ZIP right there, or "Skip for now" → reminder card on Training until imported) → **Connect Strava** (Huawei Health → Third-party services → Strava; Strava API app values with copy buttons; Client ID/Secret + Connect) → AI coach → Squad → Done. The step is remembered, so Strava's sign-in page returns to the next step; the invite code is kept too.
- History comes before the squad, so the "own usual" baseline uses the real past; importing later refreshes the squad baseline automatically.
- Week card follows the person's sports: non-riders see km over all sports and "walk(s)/session(s)" (riders unchanged: "ride km"); singular for one session.

## 3.6.3 — 2026-10-30 · manual + screenshots first
- Assad's Huawei Health app has no Strava sharing, so the main way in is manual: **Training → camera** (or the Log form's "Fill from screenshot(s)", or Squad → Screenshot) — pick one or several workout screenshots; the AI reads every number into the sport-specific form, one after another ("2 of 5"), to check and save.
- Screenshots are read with the person's own AI key (free Gemini) when set up, otherwise the squad's Aether; a clear hint when neither exists.
- Introduction: screenshot and Log first; Strava/Huawei export as optional. Profile's Strava steps folded under "Optional".

## 3.6.2 — 2026-10-30 · sport-specific manual log, polish
- **Log a workout** has fields per sport: swim (pool × lengths → distance, main stroke, avg/max HR, calories, SWOLF, total strokes), walk/run (distance, steps, cadence, climbing, HR, calories, treadmill), ride (distance, climbing, power, cadence, HR, calories, indoor), gym (activity: strength/elliptical/rowing/stairs/HIIT/yoga/other, HR, calories, reps, optional distance); all with effort (RPE) and a note; live pace/speed preview; values kept when switching sport; an unnamed gym session is named after its activity. The same form checks screenshot imports. Manual SWOLF/stroke/calories reach the squad summary and the coaches.
- Polish: Reports daily-load chart always shows at least a week (no full-width wall for one session); week card keeps "N-week streak" together; web app Profile no longer shows a placeholder bike name; Squad quick actions (Log workout · Screenshot · Log weight · Ask Aether); chat row says "invite a friend" until someone joins.

## 3.6.1 — 2026-10-30 · automatic for Assad tonight (free)
- **Huawei Health → Strava → app**: on the web app Strava walks import directly (no inbox); Profile → Connections shows the one-time steps (Huawei Health → Strava link, his own free Strava API app with this site as callback domain). Strava API calls verified to work from the browser (CORS).
- **Log a workout by hand** (Training → Log, Squad → Log workout): sport, date/time, duration, distance, HR, steps, kcal; swims with pool length × lengths → distance and pace /100 m. Saved as "Logged by hand".
- Introduction: Strava (automatic) first on the web app, then Log by hand, Huawei history export, screenshot.
- Everything stays free: Strava account and API app, Huawei's Strava link, Cloudflare free plan, Gemini free key.

## 3.6.0 — 2026-10-30 · Huawei, introduction, free-plan proof squad
- **Huawei Health import** (`huawei.js`, vendored zip.js 2.24.0 BSD-3 for AES ZIPs): reads Huawei's data export (2025 multi-file and legacy layouts, `partTimeMap` quirk), maps sport codes, local time from `timeZone`, HR/GPS/speed/altitude/step-rate samples → one 5-s stream (zones, TRIMP, route, charts), steps/cadence, calories, climbing (1 m hysteresis), pool swims → per-length swim model (segments longer than the pool split evenly). Own id range (−start−3), duplicates and deleted sessions skipped, pre-2026 ignored, password remembered locally (kept out of exported backups). Tested with generated AES-encrypted exports.
- **First-run introduction** (`views/intro.js`): fresh installs / web app only; name, sex, age → max HR (208 − 0.7 × age), resting HR, weight; zones rebuilt from the person's max HR (not the owner's defaults); workout sources (Huawei first on the web), free Gemini key, squad join (invite link handled inside), done. Profile → Introduction reopens it. No "What's new" for brand-new users.
- **Web app = Gemini only** for the personal coaches: only the Gemini provider shown, picker goes straight to Gemini models, fallback = another Gemini model, "keep retrying" unchanged. Samsung Health card explains it is Android-only on iPhone.
- **Squad server CPU** (free plan 10 ms/request, measured with `wrangler tail` on 6 months of heavy history): AI context now comes from a digest the phones build and upload (`PUT /digest`, `SquadCore.digest`; last 14 days in full, 62 days compact); the server falls back to reading history only if the digest misses newer events. AI runs 30–49 ms → 9–12 ms; sync pages 3–8 ms (bodies passed through without re-encoding, 300 per page); explicit challenge columns; index `events(challenge_id, kind, seq)`.
- Apple Health route evaluated and not used (Huawei rarely passes workouts to Apple Health, never swim lengths).

## 3.5.0 — 2026-10-29 · Squad
- **Squad** (`views/squad.js`, `views/squad-stats.js`, shared `squad-core.js`; server `squad/`): shared challenges with friends as its own section with sub-tabs Home · Chat · Feed · Stats · Report · Crew and a challenge switcher.
- Server: Cloudflare Worker + D1 (free, serverless, cron every 15 min). Invite codes, hashed member tokens, per-challenge event log with `seq`; idempotent client ids; `/changes?since=` sync; owner-only settings and AI setup; leave/rejoin; max 6 members; CORS for the Android app; serves `www/` as the web app.
- Client sync: persistent outbox, polling 4 s / 15 s / 60 s + on resume/online; pending posts shown; offline-safe (tested: queued while offline, survives reload, delivered once).
- Sharing: workout summaries from the challenge start (stats, swim lengths, PBs vs own history, RPE/feel/note and the coach's first sentence — optional), edits re-share, deletes remove; opt-in body & wellness (weight, resting HR, HRV, sleep, steps) as `daily` events, cleared when switched off.
- Scoring against oneself: consistency 40 + volume 30 + improvement 30 + bonuses; baselines from the 4 weeks before the challenge (or the first week); weekly duels; monthly numbers (`SquadCore.month`) shared by app, PDF and AI. Weight only ever as a change.
- Aether in the squad (server side, owner's key, spend cap): @Aether / review / roast / monthly report; unprompted messages for PBs, streaks, first workout, quiet members and lively chats with etiquette (90 s quiet, ≤1 per 2 h, ≤4/day, PASS allowed, one reply at a time via a lease, replies attached with `reply_to`); daily recap, weekly duel, final recap; screenshot → workout (`/ai/extract`).
- Stats (Plotly): per-person table, points/minutes/pace vs own usual per week, duels, sport mix, time of day, training calendar, weight change, steps, resting HR, sleep, PB list. Report: month chips, per-person tiles, minutes per day, on track vs own usual, points per week, AI report, PDF (light charts on paper).
- Web app for friends: `manifest.webmanifest`, home-screen icons, Strava sign-in on the web (own Strava API app), neutral name defaults, join link `#join=CODE`.
- Walk is its own sport (`walk`, pace /km, steps, cadence; one-time migration of existing walks).
- Reports: training-story graphs, balance radar, Barlow fonts in the PDF; AI context gets every swim length and km/5-km splits; the activity inbox no longer brings back reviewed items.
- Exported backups leave out squad tokens and the outbox; restores keep current squad memberships.
- Fix: view transitions interrupted by a quick tap no longer log an error.

## 3.4.0 — 2026-10-29 · every sport its own metrics
- Swim metrics from the per-length log (`buildSwimDetail` in sport.js): pool length, lengths, swim vs rest time, pace /100 m on swim time, SWOLF avg/best, strokes per length, stroke rate, stroke mix, fastest length, best 50/100/200/400 m, 100 m splits. Native reader returns intervals (time, strokes, style), cadence, steps, VO2max, reps, min HR; existing watch sessions back-filled (`shd_ver` 2).
- Per-sport workout detail (`views/detail-sport.js`): hero numbers, stats, best efforts, stream metrics; swim per-length chart + splits + length table; irrelevant fields removed (e.g. no speed/elevation/VAM/power for swims and gym, no weight for swims/gym, no climbing on treadmill).
- Per-sport feed cards, Trends progression metrics (with defaults per sport) and best efforts (swim distances), records (fastest 100 m, best SWOLF, highest cadence), Compare rows and verdict (SWOLF), PDF sport pages (SWOLF, cadence), AI session block (swim technique, splits; drift only for rides/runs).
- Duplicates: sessions are the same when they start within 2 min or overlap ≥ 50 % (`sameSession`); one-time merge (`dedupeWorkouts`, restore point first); watch cycling never goes to the inbox; skipped inbox items remembered by time.
- Fixes: delete dialog for gym sessions, Compare verdict wording, Trends metric selection per sport, chart text inside swim bars.

## 3.3.6 — 2026-10-29
- **Automatic swims, treadmill and gym from Samsung Health** via the Samsung Health Data SDK (native module `native/samsung-swims`, added by `patch-android.js` only when the SDK AAR is in `C:\dev\tools\samsung-health-data-sdk`; never committed). Read-only, Samsung Health developer mode for data read. Imports pool/open-water swims (distance, pool length, active swim time, per-second HR → zones/load), treadmill and outdoor runs (HR + speed), stationary bike, elliptical, rowing, stairs, strength sets; walks/squash/other → inbox; outdoor rides and rest breaks skipped. Runs on every wellness sync; Profile → Samsung Health shows status. First import on the phone: 38 sessions (9 swims, 14 treadmill runs…).
- Strava "Workout" twins of watch treadmill / gym-bike sessions take the watch's sport.

## 3.3.4 — 2026-10-29
- Trends: range chips longer than the load history (e.g. 6m / 1y when history starts in May) are dimmed with a tooltip, and the chart shows where the history starts — they previously looked identical to All without explanation.

## 3.3.3 — 2026-10-29
- **Swims**: Samsung Health doesn't share swim sessions with Health Connect (checked on the phone: 118 sessions since January, none of them swims). New importer for Samsung Health's own export (Profile → Samsung Health → Import Samsung Health export): exercise CSV + optional live_data JSON files for per-second heart rate; Samsung codes mapped (14001 pool swim, 15005 treadmill, 15003 exercise bike, 15006 elliptical, 15001 step machine, 15004/14010 rowing, 15002 weights, 10007 circuits, 9002 yoga, 9001 pilates; walks/hikes/custom → inbox).
- Treadmill/gym-bike sessions that Strava files as a generic "Workout" take the watch's sport (indoor run / indoor ride).
- One-time rescan of Health Connect from January so watch walks reach the inbox.

## 3.3.2 — 2026-10-29
- Fixed the squashed/cut-off Fitness · Fatigue · Form chart ("Trends stuck"): a chart drawn while its screen was hidden got Plotly's default 700 × 450 size and kept it. Hidden draws are now parked and drawn at the real size when the screen appears; mis-sized charts are resized on show. Found on the phone over USB (`scripts/phone-eval.js`).

## 3.3.1 — 2026-10-29
- Activity inbox, 2026+ only, Reports sport selector, much richer PDF, Aether context at three resolutions with coach verdicts and data completeness, derived resting HR, conversation-review rules (no-bike ≠ rest, no invented facts), Trends no longer renders inside the tab transition, charts can't trap scrolling, guide PDF.

## 3.3.0 — 2026-10-29 · Training Partner
Full explanation for the athlete: `docs/Training-Partner-Guide.pdf` (source `docs/guide/Training-Partner-Guide.html`).
### Multi-sport
- Renamed to **Training Partner**; sports: ride, run, swim, gym & other (`www/js/app/sport.js`). Per-sport numbering, units (pace for runs/swims), colours, icons and filters (Training, Trends, Compare, Reports).
- Strava imports runs, swims and gym types; Samsung Health (Health Connect) imports pool/open-water swims, treadmill/outdoor runs, stationary bike and gym sessions with a heart-rate stream (`addHealthSession`). Strava copies replace watch copies (±5 min) keeping intent/rating/note/flags.
- Only workouts from 2026-01-01 (`MIN_WORKOUT_DATE`; Strava `after=`).
- **Activity inbox** for other types (walk/hike → run, others → gym & other) with per-type rules (`activity_rules`, `activity_inbox`, `activity_skipped`).
- Health permissions now include exercise, distance and active calories; resting HR derived from the lowest hourly HR when Samsung shares none; sleep coverage reported to the coaches.
### Data quality
- Flag sheet per workout: sport, indoor, data errors (elevation, distance/speed, HR, power), exclude, delete. `mv()` hides flagged values everywhere (records, best efforts, totals, load, compare, AI).
- Delete with restore point and a permanent "deleted" list (`deleted_workouts`).
### AI
- Model per coach with a two-level picker (provider → models), strict "keep retrying this one" mode (10 s → 5 min backoff, up to 2 h, waits for connection), per-agent concurrency instead of one global lock.
- Every reply stores and shows provider · model · seconds (`ai_provider`, `ai_model`, `ai_secs`).
- Chat messages saved immediately (`pending`), replies finish in the background, unanswered messages resumed on app resume / back online.
- Coach memory (`coach_memory`, `<remember>` tags) shared by all coaches; Profile card to add/delete.
- Style rules from a review of real conversations (concise, no hype, no repeated questions, weight only when relevant, no invented numbers/sessions, honest readiness). plan-actions: "no bike" ≠ rest, sessions carry a sport, never claim "applied".
- Context: whole history at three resolutions (6 weeks per session incl. athlete note + coach verdict, weekly, monthly), mass only on change, compact zones, data-completeness line, per-minute peaks in the timeline. Fixed: every Gemini model was treated as a "small" model ("gemini" matched "mini").
### Screens
- Charts no longer disappear on redraw (`drawChart`), can't trap touch scrolling, and heavy screens render after the transition.
- Compare rebuilt: same sport, smart defaults, verdict, efficiency, paired bars, zones, speed/HR overlay, saved AI answer.
- Reports: sport selector, sport tiles with deltas, efficiency and intensity split, records per sport with "mark as data error".
- PDF rebuilt: cover, verdict, KPI tiles vs previous period, per-sport breakdown, load/volume/intensity charts (JPEG), week-by-week table, a page per sport, highlights & records, plan adherence, recovery log, data quality & memory, styled review, colour-coded ledger.
- Motion (`motion.js`): view-transition tab pushes, card→detail morph, count-ups, route drawing, sliding tab indicator, ripples, intro, confetti for records (canvas-confetti 1.9.3, ISC, vendored). Respects reduced motion.
### Developer
- `webContentsDebuggingEnabled` on (USB diagnostics); `scripts/phone-eval.js` evaluates read-only expressions in the app over USB.

## 3.2.1 — 2026-10-29
- AI timeouts: wait up to 75 s for the first word, then only give up if a reply stops streaming for 45 s (long answers no longer cut off at a fixed limit); a timeout moves straight to the next provider.
- Restore JSON also restores telemetry streams when the backup contains them.
- `scripts/phone-update.ps1` + `scripts/phone-rescue.js`: update over USB without losing data; if the installed app was signed with an older key, copy all its data out first (see docs/ROLLBACK.md).

## 3.2.0 — 2026-10-29
### Your plan, made dynamic
- **Weekly template**: enter your own preset plan once (Mon–Sun); it repeats every week.
- **Day changes** for weeks that fluctuate (by you, Aether or the AI planner) without touching the template; "Back to template" resets a day.
- **Weekly targets**: a default plus one-off overrides for this or next week.
- Planned sessions are marked done automatically when a ride exists that day (or tick them), missed ones show a red ✕; 14-day adherence feeds the coaches.
- "Adapt with AI" re-plans only the next 7 days, keeping your template wherever it still fits.

### Aether — the season coach
- The master coach is now **Aether**: fullest context of all AIs and the only one that can change your plan and targets.
- When you ask ("I can only ride twice this week", or paste your plan) Aether proposes a change; it appears as a card with **Apply / Dismiss** — nothing changes without your tap (a restore point is created first).
- Quick prompts: Ready today? · Review my week · Adjust my week · Set up my plan.

### AI context, per role
- Each AI role now gets its own context (see `www/js/app/ai.js`): Aether everything; ride coach the ride + planned session + load and wellness *on that date*; compare, reports, trends and planner each what they need. Long sections are trimmed automatically for small free models.
- **Coach skills** (SKILL.md format, `www/skills/`): coach voice, intensity & zones, load & readiness, ride analysis, plan design, fuel & recovery, MTB terrain, plan actions — each assigned to the roles that need it. Written from open coaching protocols on GitHub (estruyf/skill-cycling-plan-coach, CrankAddict Section 11, disco-trooper cycling-training) and the underlying science (Seiler, Banister, Friel). Import more skills from any GitHub link in Profile.

### Samsung Health (Galaxy Watch) via Health Connect
- Read-only import of sleep (with stages), resting HR, HRV, weight, steps and VO2max. Rides still come from Strava.
- Readiness strip on Rides (sleep, resting HR vs baseline, HRV vs baseline); wellness feeds Aether, the ride coach, planner and reports.
- New scale weights can be copied into the weight log automatically.
- Least privilege: only 9 read permissions are requested; every write permission is stripped at build time. Privacy policy screen included.

### Platform & fixes
- **Capacitor 8** (Android 16 target, Node 22, JDK 21).
- **Fixed (also affected v2):** native plugins were never registered because the app has no JS bundler, so the Android Back button handler, the Strava sign-in deep link and file saving silently fell back. The app now talks to the native bridge directly.
- Status-bar icon colour follows the light/dark theme.
- Removed a stray empty `www/js/package.json`; demo heart rates capped below max HR.

## 3.1.0 — 2026-10-29
### AI providers (fixes + new)
- **Fixed:** v2 offered `gemini-3.7-flash` and `gemini-3.5-flash`, which are not on Google's current model list → requests could fail. Retired IDs now switch to `gemini-3.8-flash` automatically.
- New provider system (`www/js/app/providers.js`): Google Gemini, Groq, OpenRouter, Mistral (free tiers), Anthropic Claude, OpenAI, DeepSeek (paid) and any OpenAI-compatible endpoint (e.g. local Ollama / LM Studio).
- Models are loaded live from each provider ("Load"); "Test" sends a real one-line request.
- **Monthly spend cap** for paid providers with real token-based cost tracking (Claude prices filled in automatically, OpenRouter prices read from its model list).
- **Automatic fallback**: if the main provider fails or hits a limit, free providers are tried first.
- Replies **stream in** as they're written (blinking caret), everywhere the coach answers.
- Native HTTP fallback on Android when a provider blocks browser requests (CORS).
- API keys are never written to backups, restore points or recovery exports; restores keep the keys you already have.

### New features
- **AI week plan**: 7 days built from form (TSB), training phase, weekly goals and the last 21 days; checklist in Coach, today's session on Rides.
- **Weekly goals** (distance / time / rides) shown as progress under each stat in the week card.
- **Route map** (offline SVG, coloured by heart-rate zone) from the GPS stream or Strava's summary polyline.
- **Shareable ride card** (1080×1350 PNG) via the share sheet.
- **Feel + RPE (1–10) + private note** per ride; session-RPE load; all passed to the coach.
- **Training calendar** (daily load heat-map, tap a day to open its rides).
- **Best efforts**: speed and heart rate over 1/5/20/60 min for every ride; power curve, NP, IF and TSS **only for power-meter rides** (Coggan method as implemented in GoldenCheetah). Strava's own power estimate is still shown as "Est. power"; the app adds no power estimate of its own.
- Optional FTP setting (else 95% of best measured 20-min power).
- Pull down on Rides to sync, optional auto-sync on open (max every 3 h), haptic feedback (toggle in Profile).

### Fixes / polish
- Week card simplified (goals inline, one status line); calendar contrast; Strava sport type shown as words; plan card collapses to 3 days.
- Weight changes no longer trigger needless recalculation of every ride.

## 3.0.0 — 2026-10-29
Full rebuild of the app (same Android package `com.ridepartner.v2`, installs as an update; your data stays).

### Design
- New logo: two wheels joined by a heartbeat, plus a spark for the AI coach. Adaptive icon, Android 13 themed icon, legacy PNGs, branded splash (Capacitor's default logo removed).
- Light theme by default (dark mode optional in Profile → Appearance).
- Bottom navigation, full-screen ride detail with a fixed chat composer, bottom sheets, toasts and in-app dialogs.
- Barlow / Barlow Semi Condensed typography bundled offline; heart-rate zone colours used consistently as the visual language.
- Motion only where it answers an action (panel slide, sheets, zone bars, typing indicator); respects reduced-motion.

### New features
- Fitness / Fatigue / Form (CTL 42 d / ATL 7 d / TSB) from Banister TRIMP per ride.
- Weekly summary with streak and form on the Rides tab; weekly volume chart; all-time records (tap to open the ride).
- Search and filters (training / play / no intent / needs review), rides grouped by month.
- Editable max HR, resting HR and zone limits (auto-suggest from max HR); used by every calculation, label and AI prompt.
- Athlete name and bike are settings (were hard-coded).
- Custom Gemini model ID field; automatic fallback to the next model on server errors.
- Backups and PDFs go through the Android share sheet (save to Files/Drive or send).
- Restore points (automatic before update, sync, import, zone change, demo, Classic switch; plus manual), one-tap rollback.
- Classic v2 interface kept inside the app as a version rollback.
- Recovery screen if the app fails to start twice (retry, Classic, roll back data, export).
- Demo rides for trying the app without Strava.
- Android Back button closes dialogs/sheets/panels, then returns to Rides, then exits.

### Fixes
See [REVIEW.md](REVIEW.md) for the full list (offline startup, "undefined bpm drift", NaN kJ, prior-speed inflation, VAM without HR strap, recovery gap, rate-limit handling, period double counting, report cache, storage on Android 11+, …).

### Removed
- Streamlit desktop version (`app.py`, `requirements.txt`) — the app ships as an APK only. A copy is in `C:\dev\backups\Ai-Training-Coach-v2-original`.

## 2.x
Original single-file version (now `www/classic.html`).
