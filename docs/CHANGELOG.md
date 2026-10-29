# Changelog

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
