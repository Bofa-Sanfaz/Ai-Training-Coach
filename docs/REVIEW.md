# Code Review — Ride Partner v2 (original code)

Reviewed: `www/index.html` (4,556 lines, the code shipped in the APK), `app.py` (Streamlit desktop version),
`package.json`, `capacitor.config.json`, `.github/workflows/build-apk.yml`.

Severity: 🔴 breaks something / wrong numbers · 🟠 misleading or fragile · 🟡 polish

---

## 1. App-breaking / robustness

| # | Sev | Where | Problem | Fix (v3) |
|---|-----|-------|---------|----------|
| R1 | 🔴 | `index.html` head | All libraries load from CDNs with a fallback to `js/*.min.js`, but **the `js/` folder does not exist**. With no internet on app start, Dexie never loads and the whole app is dead (no rides, no settings). | Libraries are bundled in `www/js/vendor/` and loaded locally. |
| R2 | 🔴 | Android | No hardware **Back button** handling — back exits the app from any screen, even with a ride or dialog open. | Back closes dialog → sheet → panel → returns to Rides → exits. |
| R3 | 🟠 | Export/PDF | Writes to `EXTERNAL_STORAGE/Download` which fails on Android 11+ (scoped storage); fallback to Documents often fails too. | Uses the Android share sheet (`@capacitor/share`) with Documents/browser fallback. |
| R4 | 🟠 | Sync | On a Strava 429 (rate limit) the stream loop `break`s, so **metrics for every remaining ride are never computed**. | Stops fetching but still computes metrics for rides that already have streams; tells you how many remain. |
| R5 | 🟠 | Sync | Only 10 pages × 50 activities (500) are scanned. | 200 per page (Strava max), up to 20 pages. |
| R6 | 🟠 | Sync | Filters on legacy `type` only; ignores `sport_type` (e.g. `EMountainBikeRide`). | Checks `sport_type` and `type`. |
| R7 | 🟠 | Gemini | Network errors are swallowed silently (only `console.warn`). | Visible error toast + retry card. |
| R8 | 🟠 | Debrief | If prompt building throws, the loading banner and disabled button stay stuck forever. | `try/finally` around all AI flows. |
| R9 | 🟠 | Reports | Only one cached report (`id: 1`) — switching 7D→30D throws away the other review. | One cached review per timeframe. |
| R10 | 🟡 | Everywhere | `alert()` / `confirm()` popups for everything. | Toasts and in-app dialogs. |

## 2. Calculation errors

| # | Sev | Where | Problem | Fix (v3) |
|---|-----|-------|---------|----------|
| C1 | 🔴 | Ride detail | "Aerobic Decoupling" shows **`undefined bpm drift`** for rides whose metrics were never computed (`undefined !== null` is true). Same bug in Telemetry, Compare and Master-coach **prompts sent to the AI** (`undefined bpm drift`). | Single `driftText()` helper that checks both `null` and `undefined`. |
| C2 | 🔴 | Ride detail | VAM / decoupling cards were rendered **before** metrics were computed, so the first open showed stale values. | Metrics computed first, then rendered. |
| C3 | 🔴 | Delta table | "Prior 5 avg speed" = Σ distance of all 5 rides ÷ Σ moving time of only rides that have `moving_sec` → **inflated speed** when any ride lacks moving time. | Distance and time summed over the same rides. |
| C4 | 🟠 | Delta table | "Same intent" compared a Zone 2 ride against Zone 4 / interval rides (only `intent_type` matched). | Matches target zone + format first, falls back to intent type. |
| C5 | 🔴 | Climbing VAM | VAM was only computed if the ride had a **heart-rate** stream (early return). Rides without HR never got VAM. | VAM computed independently of HR. |
| C6 | 🟠 | Zone time | First interval `times[1]-times[0]` treated as 1 s because `times[0]` is `0` (falsy check). | Proper Δt for every sample. |
| C7 | 🟠 | Decoupling | Efficiency used speeds already rounded to 0.1 km/h; never used real power. | Unrounded values; uses real power ÷ HR when the ride has a power meter (`device_watts`), else speed ÷ HR (labelled). |
| C8 | 🔴 | Totals | `reduce((a,b) => a + b.kilojoules)` → **NaN kJ** in reports/PDF/master prompt if any ride lacks kJ. | Null-safe sums everywhere. |
| C9 | 🟠 | Reports | Current and previous period both include the boundary instant (`>=` and `<=`) → a ride can be counted twice. | Half-open windows. |
| C10 | 🟠 | Recovery gap | Gap measured start-to-start, ignoring the previous ride's duration (a 3 h ride followed by another 1 h later shows "4 h recovery"). | Gap = this start − (previous start + previous elapsed time). |
| C11 | 🟡 | Duration | Mixed formats: `45:30` (min:sec) vs `1h 5m` (unpadded). | `1:05:12` / `45:30` everywhere from `moving_sec`. |
| C12 | 🟠 | Zones | Max HR 207 and zone limits hard-coded in ~10 places (UI labels, intent picker, prompts, PDF). `app.py` uses **202** → the two apps disagree. | Editable in Profile (defaults stay 207 / 135-155-171-189); both apps use the same defaults. |
| C13 | 🟡 | 1-min timeline | O(minutes × samples) loop (≈2 M iterations for a 3 h ride). | Single pass. |
| C14 | 🟡 | Markdown | AI headings on the last line weren't converted; lists not wrapped in `<ul>`. | Small proper Markdown renderer. |

## 3. Hard-coded personal data
- Athlete name "Mustafa" and bike "Kron XC150" are hard-coded in every prompt, chat label and PDF. → Now Profile settings (defaults kept).
- AI model list is fixed; no way to type a new model ID. → Custom model field added.

## 4. `app.py` (Streamlit desktop version) — removed
Found before removal (kept for the record): max HR 202 vs 207 in the APK, durations shown as `95:12`,
"Climbing VAM" was really total ascent ÷ moving time, the Gemini key was sent in the URL query string,
multi-part AI replies were truncated. The user confirmed the app is APK-only, so `app.py` and
`requirements.txt` were deleted (copy in `C:\dev\backups\Ai-Training-Coach-v2-original`).

## 5. Build / CI
- Icons were generated as vectors only and all PNGs deleted → no launcher icon on Android 7.x (API < 26).
- Splash screen still shows the default Capacitor logo.
- `versionCode` = GitHub run number; local builds couldn't upgrade over it. → `30000 + run_number`.
