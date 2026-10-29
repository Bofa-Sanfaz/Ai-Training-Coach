# Changelog

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
