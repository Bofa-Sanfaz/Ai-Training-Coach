'use strict';
// --------------------------------------------------------
// STRAVA: OAuth, token cache, paginated sync, stream backfill
// --------------------------------------------------------
const DEFAULT_STRAVA_CLIENT_ID = '277202';
const RIDE_TYPES = ['Ride', 'VirtualRide', 'EBikeRide', 'MountainBikeRide', 'GravelRide', 'EMountainBikeRide', 'Velomobile', 'Handcycle'];
const SYNC_TYPES = RIDE_TYPES.concat(RUN_TYPES, SWIM_TYPES, OTHER_TYPES);
const STREAM_KEYS = 'time,distance,latlng,altitude,heartrate,velocity_smooth,watts,cadence,grade_smooth,moving,temp';

let isSyncInProgress = false;
let isOauthExchanging = false;

async function stravaCreds() {
  return {
    clientId: String((await getConfig('strava_client_id')) || DEFAULT_STRAVA_CLIENT_ID).trim(),
    clientSecret: String(await getConfig('strava_client_secret')).trim(),
    refreshToken: String(await getConfig('strava_refresh_token')).trim()
  };
}

// A friend's web app without his own Strava API app (new ones need a paid Strava plan) signs in
// through the squad server, which holds the owner's Strava app keys; returns the squad entry
// to use, or null when this app uses its own keys (the Android app always does).
async function stravaViaSquad() {
  if (isNative() || (await getConfig('strava_client_secret'))) return null;
  return (typeof Squad !== 'undefined' && Squad.list.find(c => !c.revoked)) || null;
}

async function stravaTokenExchange(body) {
  const sq = await stravaViaSquad();
  if (sq) return squadApi(sq.server, 'POST', '/api/strava/token', body, sq.token, 30000);
  const { clientId, clientSecret } = await stravaCreds();
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ client_id: clientId, client_secret: clientSecret }, body))
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`Strava auth error (${res.status}): ${data.message || JSON.stringify(data).slice(0, 160)}`);
  return data;
}

// Reuses the 6-hour access token instead of refreshing on every call
async function getStravaAccessToken(force = false) {
  const { clientId, clientSecret, refreshToken } = await stravaCreds();
  const viaSquad = !!(await stravaViaSquad());
  if (!refreshToken || (!viaSquad && (!clientId || !clientSecret))) throw new Error('NOT_CONNECTED');

  const cached = String(await getConfig('strava_access_token'));
  const expires = num(await getConfig('strava_token_expires'));
  if (!force && cached && expires * 1000 > Date.now() + 120000) return cached;

  const data = await stravaTokenExchange({ grant_type: 'refresh_token', refresh_token: refreshToken });
  if (data.refresh_token) await setConfig('strava_refresh_token', data.refresh_token);
  await setConfig('strava_access_token', data.access_token);
  await setConfig('strava_token_expires', String(data.expires_at || 0));
  return data.access_token;
}

async function processIncomingUrl(urlStr) {
  if (!urlStr || !urlStr.includes('code=')) return;
  const match = urlStr.match(/[?&]code=([^&#]+)/);
  if (!match || isOauthExchanging) return;
  const code = decodeURIComponent(match[1]);
  isOauthExchanging = true;

  const box = $('#stravaDiagBox');
  if (box) {
    box.classList.remove('hidden');
    box.textContent = `Deep link detected: code=${code.substring(0, 6)}…\nExchanging token with Strava API…\n`;
  }
  const { clientSecret } = await stravaCreds();
  if (!clientSecret && !(await stravaViaSquad())) {
    isOauthExchanging = false;
    toast('Save your Strava Client Secret in Profile first, then sign in again.', 'warn', 5000);
    switchTab('profile');
    return;
  }

  try {
    const data = await stravaTokenExchange({ code, grant_type: 'authorization_code' });
    await setConfig('strava_refresh_token', data.refresh_token);
    await setConfig('strava_access_token', data.access_token);
    await setConfig('strava_token_expires', String(data.expires_at || 0));
    if (data.athlete && data.athlete.firstname && !(await getConfig('athlete_name'))) {
      await setConfig('athlete_name', data.athlete.firstname);
      await loadPhysioConfig();
    }
    toast('Strava connected. Syncing your workouts…', 'success');
    switchTab('rides');
    syncStrava();
  } catch (e) {
    if (box) box.textContent += `Exchange error: ${e.message}`;
    toast(/limit|capacity|exceed/i.test(e.message)
      ? 'Strava refused: the Strava app connected to this squad only allows its owner. Use Training → camera / Log for now.'
      : `Strava sign-in failed: ${e.message}`, 'error', 8000);
  } finally {
    isOauthExchanging = false;
    // Web app: drop ?code=… from the address so a reload never re-uses the one-time code
    if (!isNative() && /[?&]code=/.test(location.search)) history.replaceState(null, '', location.pathname);
  }
}

async function startAutomaticOAuth() {
  const ownId = ($('#cfg_client_id').value || '').trim();
  const secret = ($('#cfg_client_secret').value || '').trim();
  if (secret) {
    await setConfig('strava_client_id', ownId || DEFAULT_STRAVA_CLIENT_ID);
    await setConfig('strava_client_secret', secret);
  }
  // Web app (e.g. iPhone home-screen app): Strava sends the browser back to this page with ?code=…
  if (!isNative()) {
    let clientId = ownId;
    if (!secret) {
      // No own Strava API app: sign in through the squad's Strava app (keys stay on the server)
      const sq = Squad.list.find(c => !c.revoked);
      if (!sq) { toast('Join your friend\'s challenge first (Squad → Join) — Strava connects through it.', 'warn', 6000); return; }
      try { clientId = (await squadApi(sq.server, 'GET', '/api/strava/client')).client_id; } catch (e) { clientId = null; }
      if (!clientId) { toast('Strava isn\'t set up on the squad server yet — ask the challenge owner.', 'warn', 6000); return; }
    }
    const back = encodeURIComponent(`${location.origin}${location.pathname}`);
    location.href = `https://www.strava.com/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${back}&response_type=code&approval_prompt=auto&scope=read,activity:read_all,profile:read_all`;
    return;
  }
  const clientId = ownId || DEFAULT_STRAVA_CLIENT_ID;
  const redirectUri = encodeURIComponent('aicoachv2://aicoach.app');
  const authUrl = `https://www.strava.com/oauth/mobile/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${redirectUri}&response_type=code&approval_prompt=force&scope=read,activity:read_all,profile:read_all`;
  window.open(authUrl, '_system');
}

function manualExchangeCode() {
  const val = $('#cfg_manual_code').value.trim();
  if (!val) { toast('Paste the redirect URL or code first.', 'warn'); return; }
  processIncomingUrl(val.includes('code=') ? val : `?code=${val}`);
}

async function testStravaConnection() {
  const box = $('#stravaDiagBox');
  box.classList.remove('hidden');
  box.textContent = 'Testing token exchange with Strava API…';
  try {
    const token = await getStravaAccessToken(true);
    box.textContent = `[1] Token refresh OK (expires ${new Date(num(await getConfig('strava_token_expires')) * 1000).toLocaleString()})\n\n`;
    const actRes = await fetch('https://www.strava.com/api/v3/athlete/activities?per_page=5', { headers: { Authorization: `Bearer ${token}` } });
    const actData = await actRes.json().catch(() => ({}));
    box.textContent += `[2] Activities API HTTP ${actRes.status}:\n`;
    box.textContent += Array.isArray(actData)
      ? `SUCCESS: Found ${actData.length} recent activities. Read permissions active.\nRate limit usage: ${actRes.headers.get('X-RateLimit-Usage') || 'n/a'}`
      : JSON.stringify(actData, null, 2);
  } catch (err) {
    box.textContent += err.message === 'NOT_CONNECTED'
      ? 'ERROR: Missing Client ID, Client Secret, or Refresh Token. Sign in to Strava first.'
      : `\nERROR: ${err.message}`;
  }
}

function buildWorkoutFromActivity(a) {
  const localDateStr = a.start_date_local ? a.start_date_local.slice(0, 10) : formatLocalDate(new Date());
  const localDateTime = a.start_date_local ? a.start_date_local.replace('T', ' ').slice(0, 16) : localDateStr;
  return {
    strava_id: Number(a.id),
    ride_number: 0,
    exercise_code: '',
    name: a.name || '',
    sport_type: a.sport_type || a.type || 'Ride',
    date: localDateTime,
    distance_km: round(num(a.distance) / 1000, 2),
    duration_str: formatDuration(a.moving_time),
    moving_sec: num(a.moving_time),
    elapsed_sec: num(a.elapsed_time),
    avg_speed_kmh: round(num(a.average_speed) * 3.6, 1),
    max_speed_kmh: round(num(a.max_speed) * 3.6, 1),
    avg_power_w: a.average_watts ? Math.round(a.average_watts) : 0,
    max_power_w: a.max_watts ? Math.round(a.max_watts) : 0,
    norm_power_w: a.weighted_average_watts ? Math.round(a.weighted_average_watts) : 0,
    device_watts: !!a.device_watts,
    avg_hr: a.average_heartrate ? Math.round(a.average_heartrate) : 0,
    max_hr: a.max_heartrate ? Math.round(a.max_heartrate) : 0,
    avg_cadence: a.average_cadence ? round(a.average_cadence, 0) : 0,
    elevation_gain_m: Math.round(num(a.total_elevation_gain)),
    kilojoules: Math.round(num(a.kilojoules)),
    calories: a.calories || Math.round(num(a.kilojoules) * 1.05),
    trainer: !!a.trainer,
    map_polyline: (a.map && a.map.summary_polyline) || '',
    gear_id: a.gear_id || '',
    debrief_stale: false,
    intent_type: null,
    zone_seconds: [0, 0, 0, 0, 0],
    cardiac_drift_bpm: null,
    cardiac_decoupling_pct: null,
    climbing_vam: null,
    halves_profile: ''
  };
}

// Numbered per sport: "Ride 42", "Run 3", "Swim 1"; gym & other per exercise: "Strength 3"
async function renumberRides() {
  const all = await db.workouts.toArray();
  all.sort((a, b) => parseSafeDate(a.date) - parseSafeDate(b.date));
  const counters = {};
  for (let i = 0; i < all.length; i++) {
    const w = all[i];
    const label = numberLabel(w);
    const seq = counters[label] = (counters[label] || 0) + 1;
    const code = `${label} ${seq} - ${String(w.date).split(' ')[0]}`;
    if (w.ride_number !== seq || w.exercise_code !== code) {
      w.ride_number = seq;
      w.exercise_code = code;
      await db.workouts.update(w.id, { ride_number: seq, exercise_code: code });
    }
  }
  return all;
}

function setSyncStatus(text, pct) {
  const box = $('#syncStatus');
  if (!box) return;
  if (!text) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  $('#syncStatusText').textContent = text;
  $('#syncProgress').style.width = `${Math.max(3, Math.min(100, pct || 0))}%`;
}

async function syncStrava(opts = {}) {
  const auto = !!(opts && opts.auto);
  if (isSyncInProgress) return;
  if (!navigator.onLine) { if (!auto) toast('Connect to the internet to sync with Strava.', 'warn'); return; }

  const btn = $('#btnSync');
  isSyncInProgress = true;
  setBusy(btn, true, 'Syncing…');
  setSyncStatus('Connecting to Strava…', 5);

  try {
    let token;
    try {
      token = await getStravaAccessToken();
    } catch (e) {
      if (e.message === 'NOT_CONNECTED') {
        if (!auto) {
          toast('Sign in to Strava in Profile first.', 'warn');
          switchTab('profile');
        }
        return;
      }
      throw e;
    }

    await createRestorePoint('Before Strava sync', 'auto');

    // 1) Activity list (no "after" filter so back-dated rides are found)
    const acts = [];
    let reauthed = false;
    for (let page = 1; page <= 20; page++) {
      setSyncStatus(`Reading activity list (page ${page})…`, 5 + page * 2);
      const after = Math.floor(parseSafeDate(MIN_WORKOUT_DATE).getTime() / 1000);
      const res = await fetch(`https://www.strava.com/api/v3/athlete/activities?page=${page}&per_page=200&after=${after}`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 429) { toast('Strava rate limit reached. Try again in 15 minutes.', 'warn', 5000); break; }
      if (res.status === 401) {
        if (reauthed) throw new Error('Strava rejected the token (401). Sign in again in Profile.');
        reauthed = true;
        token = await getStravaAccessToken(true);
        page--;
        continue;
      }
      const pageActs = await res.json().catch(() => []);
      if (!Array.isArray(pageActs) || !pageActs.length) break;
      acts.push(...pageActs);
      if (pageActs.length < 200) break;
    }

    // 2) Insert new rides, runs, swims and gym sessions (2026 onwards; deleted workouts are never re-imported).
    //    Other types (walks, hikes, yoga…) go to the inbox unless the athlete set a rule for that type.
    const recent = acts.filter(a => String(a.start_date_local || '') >= MIN_WORKOUT_DATE);
    // Web app (a friend's iPhone): walks are a main sport there, so they import directly
    const isSyncType = a => SYNC_TYPES.includes(a.sport_type) || SYNC_TYPES.includes(a.type || 'Ride') ||
      (!isNative() && WALK_TYPES.includes(a.sport_type || a.type));
    const alwaysInclude = await routeToInbox(recent.filter(a => !isSyncType(a)).map(a => ({
      key: `strava:${a.id}`, src: 'strava', type: a.sport_type || a.type, name: a.name || '', date: String(a.start_date_local || '').replace('T', ' ').slice(0, 16),
      distance_km: round(num(a.distance) / 1000, 2), moving_sec: num(a.moving_time), raw: a
    })));
    const rideActs = recent.filter(isSyncType);
    for (const it of alwaysInclude) { it.raw.__sport = inboxSport(it.type); rideActs.push(it.raw); }
    const existing = await db.workouts.toArray();
    const recordsBefore = recordSignature(existing);
    const known = new Set(existing.map(w => Number(w.strava_id)));
    const deleted = await deletedWorkoutIds();
    const added = [];
    for (const a of rideActs) {
      if (known.has(Number(a.id)) || deleted.has(Number(a.id))) continue;
      const w = buildWorkoutFromActivity(a);
      if (a.__sport) w.sport = a.__sport;
      // A workout imported earlier from Samsung Health is replaced by the Strava copy (same start ±5 min);
      // the athlete's corrections and flags carry over
      const twin = findSameWorkout(existing, workoutStart(w), workoutSec(w), x => x.source === 'health');
      if (twin) {
        for (const k of ['intent_type', 'intent_target', 'rpe', 'feel', 'note', 'data_flags', 'sport']) if (twin[k] !== undefined && twin[k] !== null) w[k] = twin[k];
        await db.workouts.delete(twin.id);
        await db.streams.delete(Number(twin.strava_id));
        await db.threads.where('strava_id').equals(Number(twin.strava_id)).modify({ strava_id: Number(a.id) });
      }
      w.id = await db.workouts.add(w);
      added.push(w);
    }
    // Refresh fields missing on rides imported by older versions
    const byId = new Map(rideActs.map(a => [Number(a.id), a]));
    await db.workouts.toCollection().modify(w => {
      const a = byId.get(Number(w.strava_id));
      if (!a) return;
      if (w.elapsed_sec === undefined) w.elapsed_sec = num(a.elapsed_time);
      if (w.device_watts === undefined) w.device_watts = !!a.device_watts;
      if (!w.name) w.name = a.name || '';
      if (!w.sport_type) w.sport_type = a.sport_type || a.type || 'Ride';
      if (w.trainer === undefined) w.trainer = !!a.trainer;
      if (!w.map_polyline && a.map && a.map.summary_polyline) w.map_polyline = a.map.summary_polyline;
    });

    const all = await renumberRides();

    // 3) Streams + metrics. A 429 stops downloading but metrics are still computed for everything else.
    let rateLimited = false;
    let fetched = 0;
    let missing = 0;
    for (let i = 0; i < all.length; i++) {
      const w = all[i];
      setSyncStatus(`Telemetry streams ${i + 1}/${all.length}${fetched ? ` · ${fetched} downloaded` : ''}`, 20 + (i / all.length) * 78);
      let stream;
      let justFetched = false;
      const row = await db.streams.get(Number(w.strava_id));
      if (row) {
        stream = row.stream_data;
      } else if (Number(w.strava_id) < 0) {
        stream = null; // imported from Samsung Health, not on Strava
      } else if (!rateLimited) {
        try {
          const res = await fetch(`https://www.strava.com/api/v3/activities/${w.strava_id}/streams?keys=${STREAM_KEYS}&key_by_type=true`, { headers: { Authorization: `Bearer ${token}` } });
          if (res.status === 429) {
            rateLimited = true;
            missing++;
          } else if (res.ok) {
            stream = await res.json();
            await db.streams.put({ strava_id: Number(w.strava_id), stream_data: stream });
            fetched++;
            justFetched = true;
          } else if (res.status === 404) {
            stream = null;
            await db.streams.put({ strava_id: Number(w.strava_id), stream_data: null });
          } else {
            missing++;
          }
          await new Promise(r => setTimeout(r, 220));
        } catch (e) {
          missing++;
          console.warn('Stream backfill error:', e.message);
        }
      } else {
        missing++;
      }
      if (needsMetrics(w) || justFetched) await ensureRideMetrics(w, stream === undefined ? null : stream, true);
    }

    setSyncStatus('', 100);
    await renderRides();

    const parts = [];
    const kinds = Object.keys(SPORTS).map(s => [s, added.filter(w => sportOf(w) === s).length]).filter(x => x[1]);
    parts.push(added.length ? kinds.map(([s, n]) => `${n} new ${n > 1 ? SPORTS[s].plural.toLowerCase() : SPORTS[s].label.toLowerCase()}`).join(', ') : 'No new workouts');
    if (fetched) parts.push(`${fetched} stream${fetched > 1 ? 's' : ''} downloaded`);
    if (rateLimited) parts.push(`${missing} still pending (Strava limit — sync again in ~15 min)`);
    if (!auto || added.length || rateLimited) toast(parts.join(' · '), rateLimited ? 'warn' : 'success', rateLimited ? 6500 : 3800);
    if (added.length) haptic('success');
    await setConfig('last_sync_at', new Date().toISOString());
    await announceNewRecords(recordsBefore, added.map(w => w.id));

    if (added.length) {
      intentModalQueue = (await Promise.all(added.map(w => db.workouts.get(w.id)))).sort((a, b) => (a.date < b.date ? -1 : 1));
      openNextIntentModal();
    }
  } catch (err) {
    if (!auto) toast(`Sync failed: ${err.message}`, 'error', 6000);
    else console.warn('Auto-sync failed', err);
  } finally {
    setSyncStatus('');
    setBusy(btn, false);
    isSyncInProgress = false;
  }
}
