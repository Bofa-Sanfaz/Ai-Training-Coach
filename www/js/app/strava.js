'use strict';
// --------------------------------------------------------
// STRAVA: OAuth, token cache, paginated sync, stream backfill
// --------------------------------------------------------
const DEFAULT_STRAVA_CLIENT_ID = '277202';
const RIDE_TYPES = ['Ride', 'VirtualRide', 'EBikeRide', 'MountainBikeRide', 'GravelRide', 'EMountainBikeRide', 'Velomobile', 'Handcycle'];
const STREAM_KEYS = 'time,distance,altitude,heartrate,velocity_smooth,watts,cadence,grade_smooth,moving';

let isSyncInProgress = false;
let isOauthExchanging = false;

async function stravaCreds() {
  return {
    clientId: String((await getConfig('strava_client_id')) || DEFAULT_STRAVA_CLIENT_ID).trim(),
    clientSecret: String(await getConfig('strava_client_secret')).trim(),
    refreshToken: String(await getConfig('strava_refresh_token')).trim()
  };
}

// Reuses the 6-hour access token instead of refreshing on every call
async function getStravaAccessToken(force = false) {
  const { clientId, clientSecret, refreshToken } = await stravaCreds();
  if (!clientId || !clientSecret || !refreshToken) throw new Error('NOT_CONNECTED');

  const cached = String(await getConfig('strava_access_token'));
  const expires = num(await getConfig('strava_token_expires'));
  if (!force && cached && expires * 1000 > Date.now() + 120000) return cached;

  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Strava auth error (${res.status}): ${data.message || JSON.stringify(data).slice(0, 160)}`);
  }
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
  const { clientId, clientSecret } = await stravaCreds();
  if (!clientSecret) {
    isOauthExchanging = false;
    toast('Save your Strava Client Secret in Profile first, then sign in again.', 'warn', 5000);
    switchTab('profile');
    return;
  }

  try {
    const res = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, grant_type: 'authorization_code' })
    });
    const data = await res.json().catch(() => ({}));
    if (data.refresh_token) {
      await setConfig('strava_refresh_token', data.refresh_token);
      if (data.access_token) {
        await setConfig('strava_access_token', data.access_token);
        await setConfig('strava_token_expires', String(data.expires_at || 0));
      }
      if (data.athlete && data.athlete.firstname && !(await getConfig('athlete_name'))) {
        await setConfig('athlete_name', data.athlete.firstname);
        await loadPhysioConfig();
      }
      toast('Strava connected. Syncing rides…', 'success');
      switchTab('rides');
      syncStrava();
    } else if (box) {
      box.textContent += 'Exchange Error: ' + JSON.stringify(data, null, 2);
      toast('Strava sign-in failed — see Diagnostics in Profile.', 'error');
    }
  } catch (e) {
    if (box) box.textContent += 'Network exception: ' + e.message;
    toast('Network error during Strava sign-in.', 'error');
  } finally {
    isOauthExchanging = false;
  }
}

async function startAutomaticOAuth() {
  const clientId = ($('#cfg_client_id').value || '').trim() || DEFAULT_STRAVA_CLIENT_ID;
  const secret = ($('#cfg_client_secret').value || '').trim();
  if (secret) {
    await setConfig('strava_client_id', clientId);
    await setConfig('strava_client_secret', secret);
  }
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
    debrief_stale: false,
    intent_type: null,
    zone_seconds: [0, 0, 0, 0, 0],
    cardiac_drift_bpm: null,
    cardiac_decoupling_pct: null,
    climbing_vam: null,
    halves_profile: ''
  };
}

async function renumberRides() {
  const all = await db.workouts.toArray();
  all.sort((a, b) => parseSafeDate(a.date) - parseSafeDate(b.date));
  for (let i = 0; i < all.length; i++) {
    const w = all[i];
    const seq = i + 1;
    const code = `Ride ${String(seq).padStart(3, '0')} - ${String(w.date).split(' ')[0]}`;
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

async function syncStrava() {
  if (isSyncInProgress) return;
  if (!navigator.onLine) { toast('Connect to the internet to sync with Strava.', 'warn'); return; }

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
        toast('Sign in to Strava in Profile first.', 'warn');
        switchTab('profile');
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
      const res = await fetch(`https://www.strava.com/api/v3/athlete/activities?page=${page}&per_page=200`, { headers: { Authorization: `Bearer ${token}` } });
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

    // 2) Insert new rides
    const rideActs = acts.filter(a => RIDE_TYPES.includes(a.sport_type) || RIDE_TYPES.includes(a.type || 'Ride'));
    const known = new Set((await db.workouts.toArray()).map(w => Number(w.strava_id)));
    const added = [];
    for (const a of rideActs) {
      if (known.has(Number(a.id))) continue;
      const w = buildWorkoutFromActivity(a);
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
    parts.push(added.length ? `${added.length} new ride${added.length > 1 ? 's' : ''}` : 'No new rides');
    if (fetched) parts.push(`${fetched} stream${fetched > 1 ? 's' : ''} downloaded`);
    if (rateLimited) parts.push(`${missing} still pending (Strava limit — sync again in ~15 min)`);
    toast(parts.join(' · '), rateLimited ? 'warn' : 'success', rateLimited ? 6500 : 3800);
    await setConfig('last_sync_at', new Date().toISOString());

    if (added.length) {
      intentModalQueue = (await Promise.all(added.map(w => db.workouts.get(w.id)))).sort((a, b) => (a.date < b.date ? -1 : 1));
      openNextIntentModal();
    }
  } catch (err) {
    toast(`Sync failed: ${err.message}`, 'error', 6000);
  } finally {
    setSyncStatus('');
    setBusy(btn, false);
    isSyncInProgress = false;
  }
}
