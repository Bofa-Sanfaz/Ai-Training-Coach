# Squad server

The shared side of Training Partner: challenges, 3-way chat with the AI (Aether), feed,
scores, stats and monthly reports. It is a **Cloudflare Worker + D1 database** on the free plan:
serverless, so there is nothing that "goes to sleep" after hours without use.
The same Worker also serves the app itself as a **web app** (for friends on iPhone).

```
squad/
  src/index.js        HTTP API (challenges, members, events, sync, AI endpoints, cron)
  src/ai.js           Aether in the squad: provider calls, prompts, etiquette, recaps
  migrations/         D1 schema
  test/api-test.mjs   end-to-end test against `wrangler dev` with a mock AI
  wrangler.toml       Worker config (serves ../www as the web app)
../www/js/app/squad-core.js   shared by app and server: event folding, scoring, monthly numbers
```

**Live:** https://training-partner-squad.training-partner-squad.workers.dev (deployed 2026-10-29,
D1 `squad` in Western Europe, cron every 15 min). The Android app has this address built in
(`SQUAD_DEFAULT_SERVER`); the web app uses its own origin.

## Deploy (one time, ~5 minutes)

What you need: a free Cloudflare account (cloudflare.com → Sign up). Then, in this folder:

```bash
npm install
```

```bash
npx wrangler login
```

```bash
npx wrangler d1 create squad
```

Copy the `database_id` it prints into `wrangler.toml` (replacing the zeros), then:

```bash
npx wrangler d1 migrations apply squad --remote
```

```bash
npx wrangler deploy
```

It prints the address, e.g. `https://training-partner-squad.<your-subdomain>.workers.dev`.
Put that address into `SQUAD_DEFAULT_SERVER` in `www/js/app/views/squad.js` (so the Android
app knows it without typing) and rebuild the APK. The database id and the address are not
secrets, but the address is personal — it's fine either way in the public repo.

Updating later: `npx wrangler deploy` again (also re-publishes the web app from `www/`).

## Free-plan limits (more than enough for a few friends)

| Limit (free) | Squad use |
|---|---|
| 100 000 requests/day | ~4 s polling only while a chat is open, 15–60 s otherwise |
| D1: 5 M rows read, 100 k written per day | a few thousand per day |
| Cron: every 15 min | AI recaps and check-ins when nobody has the app open |
| CPU 10 ms per request | waiting for the AI does not count as CPU |

## Security & privacy

- No accounts. Creating/joining returns a random **member token**; only its SHA-256 is stored.
- The owner's **AI key** lives only in D1 (`challenges.ai_config`) and is never returned to any client.
  A monthly **spend cap** (paid providers) is enforced on the server.
- Only summaries are shared (numbers, PBs, feel/RPE/note and the coach's one-line verdict — the last
  three can be switched off). Body & wellness (weight, resting HR, HRV, sleep, steps) only for
  members who switch it on; weight is shown and given to the AI **only as a change**, never as
  absolute numbers between people.
- `www/.assetsignore` keeps temporary files (`_tmp*`) out of the published web app.

## Local test

```bash
npx wrangler d1 migrations apply squad --local
```

```bash
npx wrangler dev --port 8787 --var ALLOW_HTTP_AI:1 --var SQUAD_QUIET_MS:1500 --test-scheduled
```

```bash
node test/api-test.mjs
```

`ALLOW_HTTP_AI` lets the test use a mock AI on `http://127.0.0.1`; it is never set in production
(there the provider address must be https).

## The friend's side (iPhone, any phone)

1. Open the invite link (`https://…workers.dev/#join=ABCD-EFGH`) in **Safari** → Share → **Add to Home Screen**.
2. Join with the code and his name.
3. Workouts: link **Huawei Health → Strava** (Huawei Health app → Me → Data sharing → Strava), then in
   the web app: Profile → Strava → his **own** free Strava API app (strava.com/settings/api, callback
   domain = the workers.dev host) → Connect. New Strava API apps only work for their owner, so
   everyone needs his own.
4. Anything that doesn't reach Strava (e.g. pool swims with lengths): Squad → **Add from screenshot** —
   Aether reads the Huawei screen, he checks the numbers and saves.
5. Weight: Squad → **Log weight** (opt-in sharing).
