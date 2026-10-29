# Changelog

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
