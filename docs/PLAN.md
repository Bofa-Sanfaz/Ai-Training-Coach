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

## v3.1 (user requests 2026-10-29)
- "Add all useful features, fix APIs, no bugs, learn from GitHub" → see CHANGELOG 3.1.0.
- User clarified: **no app-side power estimate** (inaccurate) — keep Strava's single estimate as "Est. power"; NP/IF/TSS/power curve only from real power-meter data.
- User asked for **free + paid AI APIs, add-your-own, spend cap** → `www/js/app/providers.js`.
- Learned from GitHub: GoldenCheetah `src/Metrics/Coggan.cpp` (NP/IF/TSS), Anthropic `frontend-design` skill (UI principles), google/fonts (Barlow).
- Verified: Gemini model list (ai.google.dev, Oct 2026), Gemini REST streaming + models list, Anthropic Messages API headers/streaming (claude-api skill), free-tier providers (OpenRouter blog et al.).
- Tested in browser: fallback (Gemini 429 → Groq streamed), Claude request shape + cost math, spend cap blocking, back button, exports without keys, all tabs error-free.

## v3.2 (user requests 2026-10-29)
- Preset plan that fluctuates → weekly template + date overrides + weekly targets (default / this week / next week) in `plan.js`.
- Master coach named **Aether**; can change plan/targets via `<plan-update>` proposals the user approves (`coach.js`, `ai.js`, skill `plan-actions`).
- Per-agent context review → `ai.js` rewritten as a context library; `contextBudget()` trims for small models.
- "Add skills, fetch from GitHub" → `www/skills/*.md` (SKILL.md format) + `skills.js` (per-agent assignment, import from GitHub URL).
- Samsung Health (Galaxy Watch 8 Classic) → Health Connect via `@capgo/capacitor-health` 8.x → required **Capacitor 8** upgrade (Node 22, JDK 21, SDK 36).
- Found & fixed: `Capacitor.Plugins.X` never existed without a bundler (affected v2 too) → `capPlugin()` now calls the native bridge directly.
- Privacy: user asked not to leak anything on public GitHub → commit author switched to the GitHub no-reply address; branch history rewritten and force-pushed with the user's OK (2026-10-29); keystore/password were already public from the original CI (flagged to the user).

## v3.3–3.4 (done 2026-10-29)
Multi-sport (ride/run/swim/gym), Samsung Health Data SDK (swims, treadmill, gym), per-sport metrics (SWOLF, splits, cadence), data flags, delete, inbox, model per coach, coach memory, designed PDF. See CHANGELOG.

---

# Phase 5 — "Squad": shared challenges with a friend

## 5.1 Goal (from the user, 2026-10-29)
A **Start new challenge** button opens a shared space for the athlete and his friend **Assad**:
- one shared UI: **3-way chat** (athlete, Assad, the AI), an **activity feed** of both, comments and reactions, AI reviews on request, **AI that can interrupt** on its own, and a **roast mode**;
- **challenges that are fair across different bodies**: each person is scored against **his own baseline** (relative improvement, consistency, targets), never raw head-to-head numbers;
- the personal side of the app stays exactly as it is; the shared side only receives **summaries**;
- **sync is critical**, everything must be **free**, and nothing may **stop working after hours/days of inactivity**;
- Assad: **iPhone + Huawei Watch Fit 5 Pro + Huawei Health app**, mostly **walking and swimming**. His app is the **same app with the same sections** — nothing is hidden or rearranged for him (user, 2026-10-29: "dont change sections for him"). His sports only matter for the AI's context and for which improvement metrics his score uses.

## 5.2 Constraints found in research
| Fact | Consequence |
|---|---|
| The app is an Android APK; Assad is on iPhone | Assad uses the **same app as a web app (PWA)**, installed from Safari ("Add to Home Screen"). No App Store, no Mac, no fees. |
| A web app cannot read Apple Health / Huawei Health | Assad's data comes through **Huawei Health → Strava** (native link since 2025) and our existing Strava sync; anything Huawei doesn't send is added by **screenshot → AI reads the numbers** or a quick manual entry. |
| New Strava API apps are "single player" (owner only) | Assad creates **his own free Strava API app** (strava.com/settings/api) and pastes its ID/secret, exactly like the athlete did. |
| Supabase/Render/etc. free tiers pause or sleep when idle | Use **Cloudflare Workers** (free plan, serverless — nothing to pause) + **D1** (SQLite) for storage + **Cron Triggers** for the AI's own initiatives. |
| The AI key must not be exposed to Assad | The athlete's AI provider/key is stored **server-side** (Worker secret / D1, never returned to clients). The Worker calls the model, so the AI works even when the athlete's phone is off. |
| Free limits (Workers ~100k requests/day, D1 free quotas, 5 cron triggers) | Two people + AI use a few thousand requests/day with polling — far inside the limits. |

## 5.3 Architecture
```
 Athlete's Android app ─┐                      ┌─ Cloudflare Worker "squad" (free)
 (Capacitor, personal   │  HTTPS JSON (sync)   │   /api/*  REST + long-poll
  data stays local)     ├─────────────────────►│   D1: challenges, members, feed,
 Assad's iPhone PWA ────┘   push queue/outbox   │       messages, comments, scores
 (same www, served by                          │   AI relay (athlete's key, server side)
  the Worker at /)                             │   Cron: AI check-ins, daily recap
                                               └─ static assets: www/ (the PWA)
```
- **Identity**: no accounts. Creating a challenge returns an **invite code**; joining with the code issues a random **member token** (stored on the device, sent as `Authorization: Bearer`). The Worker checks token ↔ challenge on every call.
- **Sync model**: every row has a server `seq` (monotonic per challenge). Clients keep `lastSeq` and call `GET /api/c/:id/changes?since=seq` → everything newer (messages, feed items, comments, reactions, scores). Writes go through a local **outbox** (IndexedDB) and are retried until acknowledged → works offline, nothing is lost, order is preserved by server `seq`.
- **Freshness**: 4 s polling while the chat is open, 60 s while the app is open elsewhere, on app resume, and after each own write. (WebSockets/Durable Objects can replace polling later without changing the data model.)
- **Personal → shared**: after each sync/import/debrief, the app posts **activity summaries** (sport, date, duration, distance, pace, HR, load, sport highlights like SWOLF/cadence, the coach's one-line verdict, personal-best flags). Raw streams, notes and wellness never leave the phone unless the athlete opts in.

## 5.4 The AI in the squad
- **One strong model** with the athlete's key, configured from the athlete's app (Profile → Squad AI), stored server-side; spend cap enforced server-side.
- **Triggers**: (1) `@AI` / "Ask AI" → answers; (2) **Review** button on a message or activity → review; (3) **Roast** button → playful roast of a person/activity (never about bodies, health, weight unless invited; always ends constructive); (4) **Interruptions** — the Worker decides after new events: a new personal best, a missed planned day, a streak broken, someone silent for 3 days, a heated chat, or a daily recap at 21:00 (cron).
- **Interruption etiquette** (to avoid talking over people): the AI never interrupts within **90 s** of the last human message (debounce), at most **1 unprompted message per 2 hours** and **4 per day**, answers to `@AI` immediately; a server **lock per challenge** ensures only one AI reply at a time; if humans post while the AI is writing, the AI reply is posted with `reply_to` the message it answered and the next run sees the new messages (no stale double answers).
- **Context the AI gets**: challenge rules and both scoreboards, last 7 days of both feeds (summaries), the last ~40 chat messages, each member's sports and baselines, recent PBs and streaks.

## 5.5 Fair challenges (relative to yourself)
Each member's **baseline** = his own last 4 weeks before the challenge (per sport). Score types:
- **Consistency**: active days/week vs own target (e.g. 4) → % of target.
- **Volume vs own baseline**: minutes per week compared with own baseline → % change.
- **Improvement**: sport-specific — swim pace /100 m or SWOLF (Assad, athlete), walking pace or distance (Assad), ride/run efficiency (athlete) → % better than own baseline.
- **Streaks** and **personal bests** during the challenge → bonus points.
- **Weekly duel**: each week the higher relative score wins the week; AI announces it with a recap.
Score = weighted sum (consistency 40 %, volume 30 %, improvement 30 %) + bonuses. Fully shown, nothing hidden.

## 5.6 Features (initial set)
Start/join challenge (invite code, name, dates, goal type) · members with avatars/colours · shared feed (activities, PBs, streaks) · comments + emoji reactions on activities and messages · 3-way chat with AI, Ask/Review/Roast buttons · AI interruptions (rules above) · live scoreboard + weekly duel + history · badges (first PB, 7-day streak, early bird…) · daily recap by AI · Assad's web app (same sections as the Android app) · screenshot import for workouts Huawei doesn't sync · notifications in-app (badge on the Squad tab); web push later.

## 5.7 Milestones
1. **Plan** (this section). ✅
2. **Walk as its own sport** (Assad walks; walks no longer count as runs): pace /km, steps, cadence. ✅ 3.5
3. **Squad server**: Worker + D1 schema + API (create/join, changes since seq, post message/activity/comment/reaction, AI endpoints, cron), tested locally with `wrangler dev`. ✅ (`squad/test/api-test.mjs`, 68 checks)
4. **Squad client**: Squad tab as its own section (Home · Chat · Feed · Stats · Report · Crew), start/join, chat, feed, comments, scoreboard; outbox + polling sync. ✅
5. **Activity sharing**: automatic summaries after sync; personal bests; opt-in body & wellness. ✅
6. **AI**: ask/review/roast/monthly report, interruptions with the etiquette rules, daily/weekly/final recap, screenshot → workout. ✅
7. **Assad's web app**: same build served by the Worker, Safari install (manifest + icons), same sections (no sport filter), Strava with his own API app, screenshot import. ✅ (code); needs the deploy to be reachable
8. **Deploy** ✅ 2026-10-29 — https://training-partner-squad.training-partner-squad.workers.dev (live smoke test 15/15). Still open: first real challenge with Assad on both phones, and a real AI provider in the squad (tested only with a mock).

## 5.9 Decisions taken while building (3.5)
- **The AI never runs inside `waitUntil`** (30 s limit could leave the lock held): responses carry `ai_due`, the client calls `POST /ai/run` (the request stays open while the model writes), the cron covers closed phones. One run per challenge via a lease on `challenges.ai_lock`, renewed before each model call.
- **Shared code**: `www/js/app/squad-core.js` (fold, scoring, monthly numbers) is imported by the Worker, so app, PDF and AI always show the same numbers.
- **Wellness** is a separate opt-in event kind (`daily`, validated ranges); **weight is only ever shown or sent as a change** — absolute weights of different bodies are never put side by side.
- **Stats/Report** charts: per-person volumes, but every score/comparison line is against the person's own usual (dashed "own usual" lines, % vs own pace).
- One membership per challenge per device; exported backups never contain squad tokens.

## 5.8 What only the people can do
- Athlete: create a free Cloudflare account and run one login command (Claude can't create accounts).
- Assad: link Huawei Health → Strava, create his own Strava API app, open the web link in Safari and add it to the home screen.

## Not verified yet
- Real Strava sync and Gemini calls (no credentials here) — logic reviewed, demo data used for everything else.
- On-device behaviour (back button, share sheet, deep link) — needs a phone test.
