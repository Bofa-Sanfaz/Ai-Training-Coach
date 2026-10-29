'use strict';
// --------------------------------------------------------
// WELLNESS: Samsung Health → Health Connect → Training Partner (read-only)
// Galaxy Watch data reaches Health Connect when "Health Connect" sharing is
// enabled in Samsung Health. Rides still come from Strava; this adds daily
// readiness signals: sleep (+ stages), resting HR, HRV, weight, steps, VO2max.
// Stored locally in config "wellness" (last 120 days).
// --------------------------------------------------------
// "workouts" = exercise sessions (swims); distance + calories are needed for the session totals
const HEALTH_READ = ['sleep', 'restingHeartRate', 'heartRateVariability', 'weight', 'steps', 'vo2Max', 'heartRate', 'oxygenSaturation', 'respiratoryRate', 'workouts', 'distance', 'calories'];
// Health Connect exercise type → [sport, name, indoor]. Outdoor rides come from Strava, so
// only the gym bike is imported here; walking is left out (it would flood the log).
const HC_TYPES = {
  swimming: ['swim', 'Swim', false], swimmingPool: ['swim', 'Pool swim', true], swimmingOpenWater: ['swim', 'Open water swim', false],
  running: ['run', 'Run', false], runningTreadmill: ['run', 'Treadmill run', true], trackAndField: ['run', 'Track session', false],
  bikingStationary: ['ride', 'Stationary bike', true],
  elliptical: ['other', 'Elliptical', true], stairClimbing: ['other', 'Stair climbing', true], stairClimbingMachine: ['other', 'Stair stepper', true],
  stairs: ['other', 'Stairs', true], stepTraining: ['other', 'Step training', true], rowing: ['other', 'Rowing', false], rowingMachine: ['other', 'Rowing machine', true],
  strengthTraining: ['other', 'Strength training', true], traditionalStrengthTraining: ['other', 'Strength training', true],
  functionalStrengthTraining: ['other', 'Functional strength', true], weightlifting: ['other', 'Weightlifting', true],
  crossTraining: ['other', 'Cross training', true], highIntensityIntervalTraining: ['other', 'HIIT', true], bootCamp: ['other', 'Boot camp', true],
  calisthenics: ['other', 'Calisthenics', true], coreTraining: ['other', 'Core training', true], exerciseClass: ['other', 'Exercise class', true],
  mixedCardio: ['other', 'Mixed cardio', true], pilates: ['other', 'Pilates', true], yoga: ['other', 'Yoga', true], hiking: ['other', 'Hike', false],
  boxing: ['other', 'Boxing', true], kickboxing: ['other', 'Kickboxing', true], martialArts: ['other', 'Martial arts', true], jumpRope: ['other', 'Jump rope', true],
  other: ['other', 'Workout', true]
};
const WELLNESS_DAYS = 120;
let healthSyncing = false;

function healthPlugin() {
  return capPlugin('Health');
}

async function getWellness() {
  const w = await getJsonConfig('wellness', null);
  return w && w.days ? w : { updated_at: null, days: {}, vo2max: null };
}

const isoDay = d => formatLocalDate(new Date(d));

async function readAll(H, dataType, startISO, endISO) {
  const res = await H.readSamples({ dataType, startDate: startISO, endDate: endISO, limit: 1000, ascending: true });
  return (res && res.samples) || [];
}

async function connectHealth() {
  const H = healthPlugin();
  if (!H) { toast('Samsung Health import works in the Android app (via Health Connect).', 'info', 4500); return; }
  try {
    const av = await H.isAvailable();
    if (!av || !av.available) {
      const go = await uiConfirm('Health Connect needed', `${(av && av.reason) || 'Health Connect is not available.'}\n\nOpen Health Connect settings now? On Android 13 or older, install "Health Connect" from the Play Store first.`, { okText: 'Open settings' });
      if (go) await H.openHealthConnectSettings().catch(() => {});
      return;
    }
    const res = await H.requestAuthorization({ read: HEALTH_READ, write: [], requestHistoryAccess: true });
    const granted = (res && res.readAuthorized) || [];
    if (!granted.length) {
      toast('No permissions granted. You can allow them later in Health Connect.', 'warn', 5000);
      return;
    }
    await setConfig('health_enabled', '1');
    await setConfig('health_perm_ver', '2');
    toast(`Health Connect linked (${granted.length} data types)`, 'success');
    haptic('success');
    await syncWellness(true);
  } catch (e) {
    toast(`Health Connect error: ${e.message || e}`, 'error', 6000);
  } finally {
    if (Router.current === 'profile') renderHealthCard();
  }
}

async function disconnectHealth() {
  await setConfig('health_enabled', '0');
  toast('Wellness import paused. Revoke access any time in Health Connect.', 'info', 4500);
  renderHealthCard();
}

async function syncWellness(manual = false) {
  const H = healthPlugin();
  if (!H || healthSyncing || (await getConfig('health_enabled')) !== '1') return;
  healthSyncing = true;
  const btn = $('#btnHealthSync');
  if (manual) setBusy(btn, true, 'Importing…');
  try {
    // v3.3 added swims (exercise sessions + distance): ask once for the new permissions
    if (manual && (await getConfig('health_perm_ver')) !== '2') {
      try { await H.requestAuthorization({ read: HEALTH_READ, write: [], requestHistoryAccess: true }); } catch (err) { console.warn('health perms', err); }
      await setConfig('health_perm_ver', '2');
    }
    const store = await getWellness();
    const now = new Date();
    const first = !store.updated_at;
    const start = addDays(now, -(first ? 60 : 10));
    start.setHours(0, 0, 0, 0);
    const s = start.toISOString(), e = now.toISOString();
    const day = k => (store.days[k] = store.days[k] || {});

    // Sleep: attribute each session to the date you woke up; count only asleep stages
    try {
      const sleeps = await readAll(H, 'sleep', s, e);
      const nights = {};
      for (const smp of sleeps) {
        const k = isoDay(smp.endDate);
        const n = nights[k] = nights[k] || { total: 0, deep: 0, rem: 0, light: 0, awake: 0 };
        if (smp.hasStageData && Array.isArray(smp.stages) && smp.stages.length) {
          for (const st of smp.stages) {
            const m = num(st.durationMinutes);
            if (st.stage === 'awake' || st.stage === 'inBed') { n.awake += st.stage === 'awake' ? m : 0; continue; }
            n.total += m;
            if (st.stage === 'deep') n.deep += m;
            else if (st.stage === 'rem') n.rem += m;
            else n.light += m;
          }
        } else if (smp.sleepState !== 'awake') {
          n.total += num(smp.value);
        }
      }
      for (const [k, n] of Object.entries(nights)) {
        Object.assign(day(k), { sleep_min: Math.round(n.total), deep_min: Math.round(n.deep) || null, rem_min: Math.round(n.rem) || null, awake_min: Math.round(n.awake) || null });
      }
    } catch (err) { console.warn('sleep import', err); }

    // Resting HR & steps: daily aggregates
    for (const [type, field, agg] of [['restingHeartRate', 'rhr', 'average'], ['steps', 'steps', 'sum']]) {
      try {
        const r = await H.queryAggregated({ dataType: type, startDate: s, endDate: e, bucket: 'day', aggregation: agg });
        for (const b of (r && r.samples) || []) if (num(b.value) > 0) day(isoDay(b.startDate))[field] = Math.round(num(b.value));
      } catch (err) { console.warn(`${type} import`, err); }
    }

    // Samsung Health doesn't share a resting-HR value with Health Connect, so when a day has
    // none it is estimated as that day's lowest hourly average heart rate (usually during sleep).
    try {
      const r = await H.queryAggregated({ dataType: 'heartRate', startDate: s, endDate: e, bucket: 'hour', aggregation: 'average' });
      const low = {};
      for (const b of (r && r.samples) || []) {
        const v = num(b.value);
        if (v < 30 || v > 120) continue;
        const k = isoDay(b.startDate);
        if (!low[k] || v < low[k]) low[k] = v;
      }
      for (const [k, v] of Object.entries(low)) {
        const d = day(k);
        if (!d.rhr || d.rhr_src === 'hr') { d.rhr = Math.round(v); d.rhr_src = 'hr'; }
      }
    } catch (err) { console.warn('derived RHR', err); }

    // HRV (ms): daily mean of samples
    try {
      const hrv = await readAll(H, 'heartRateVariability', s, e);
      const byDay = {};
      for (const smp of hrv) { const k = isoDay(smp.startDate); (byDay[k] = byDay[k] || []).push(num(smp.value)); }
      for (const [k, arr] of Object.entries(byDay)) day(k).hrv = Math.round(mean(arr));
    } catch (err) { console.warn('hrv import', err); }

    // Weight: last reading of each day; optionally copied into the weight log
    try {
      const ws = await readAll(H, 'weight', s, e);
      for (const smp of ws) if (num(smp.value) > 25) day(isoDay(smp.startDate)).weight = round(num(smp.value), 1);
      if ((await getConfig('health_weight_to_log')) !== '0') {
        const hist = await getWeightHistory();
        let added = 0;
        for (const [k, d] of Object.entries(store.days)) {
          if (d.weight && !hist.some(x => x.date === k)) { hist.push({ date: k, weight: d.weight }); added++; }
        }
        if (added) { await saveWeightHistory(hist); await loadPhysioConfig(); }
      }
    } catch (err) { console.warn('weight import', err); }

    // VO2max: latest value
    try {
      const v = await readAll(H, 'vo2Max', addDays(now, -365).toISOString(), e);
      const last = v[v.length - 1];
      if (last) store.vo2max = { value: round(num(last.value), 1), date: isoDay(last.startDate) };
    } catch (err) { console.warn('vo2 import', err); }

    // Keep the last 120 days
    const cutoff = formatLocalDate(addDays(now, -WELLNESS_DAYS));
    for (const k of Object.keys(store.days)) if (k < cutoff) delete store.days[k];
    store.updated_at = new Date().toISOString();
    await setJsonConfig('wellness', store);

    // Workouts recorded on the watch: swims, treadmill & outdoor runs, gym bike, gym & other (Strava copies win)
    let got = 0;
    try {
      // scan v3: rescan from January once so walks etc. reach the new inbox
      const scanned = (await getConfig('health_scan_ver')) === '3' ? await getConfig('health_workouts_scanned') : '';
      await setConfig('health_scan_ver', '3');
      got = await importHealthWorkouts(H, scanned ? addDays(now, -21) : addDays(now, -365), now);
      got += await importSamsungSwims();
      await setConfig('health_workouts_scanned', new Date().toISOString());
    } catch (err) { console.warn('workout import', err); }
    if (manual) toast(`Wellness data imported${got ? ` · ${got} new workout${got > 1 ? 's' : ''}` : ''}`, 'success', 2600);
    else if (got) toast(`${got} new workout${got > 1 ? 's' : ''} from Samsung Health`, 'success', 3000);
  } catch (err) {
    if (manual) toast(`Import failed: ${err.message || err}`, 'error', 5000);
  } finally {
    healthSyncing = false;
    if (manual) setBusy(btn, false);
    if (Router.current === 'profile') renderHealthCard();
    if (Router.current === 'rides') renderRides();
  }
}

// --------------------------------------------------------
// WORKOUTS FROM SAMSUNG HEALTH (pool swims, treadmill runs, gym bike, gym & other)
// Each session becomes a workout (source "health") with a heart-rate stream built
// from the watch samples, so zones, load (TRIMP), best efforts and the AI coach work
// exactly like for Strava workouts. strava_id is negative (−start time in seconds)
// so it never collides with Strava. If the same session is on Strava it is skipped
// here (and a later Strava copy replaces it, see syncStrava).
// --------------------------------------------------------
async function importHealthWorkouts(H, from, to) {
  if (from < parseSafeDate(MIN_WORKOUT_DATE)) from = parseSafeDate(MIN_WORKOUT_DATE);
  const sessions = [], unknown = [];
  let anchor;
  for (let page = 0; page < 10; page++) {
    const r = await H.queryWorkouts({ startDate: from.toISOString(), endDate: to.toISOString(), limit: 100, ascending: true, anchor });
    for (const s of (r && r.workouts) || []) {
      if (HC_TYPES[s.workoutType] && num(s.duration) >= 180) sessions.push(s);
      else if (!HC_TYPES[s.workoutType] && !NEVER_ASK_TYPES.includes(s.workoutType) && num(s.duration) >= 600) unknown.push(s);
    }
    anchor = r && r.anchor;
    if (!anchor) break;
  }
  const all = await db.workouts.toArray();
  const recBefore = recordSignature(all);
  const onStrava = start => all.some(w => w.source !== 'health' && Math.abs(parseSafeDate(w.date) - start) <= 300000);
  // Strava often files watch treadmill / gym-bike sessions as a generic "Workout": take the watch's sport
  for (const s of sessions) {
    const [sport, label, indoor] = HC_TYPES[s.workoutType];
    if (sport === 'other') continue;
    const start = new Date(s.startDate);
    const twin = all.find(w => w.source !== 'health' && Math.abs(parseSafeDate(w.date) - start) <= 300000);
    if (twin && !twin.sport && sportOf(twin) === 'other' && ['Workout', 'WeightTraining'].includes(twin.sport_type)) {
      await db.workouts.update(twin.id, { sport, indoor, name: twin.name && !/workout/i.test(twin.name) ? twin.name : label });
      Object.assign(twin, { sport, indoor });
    }
  }
  // Walks, hikes, football… → inbox (or straight in, if the athlete chose "always include")
  const localDate = d => `${formatLocalDate(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const always = await routeToInbox(unknown.filter(s => !onStrava(new Date(s.startDate))).map(s => ({
    key: `health:${-Math.round(new Date(s.startDate).getTime() / 1000)}`, src: 'health', type: s.workoutType, name: prettyType(s.workoutType),
    date: localDate(new Date(s.startDate)), distance_km: round(num(s.totalDistance) / 1000, 2), moving_sec: num(s.duration), raw: s
  })));
  const added = [];
  for (const s of sessions) {
    const [sport, label, indoor] = HC_TYPES[s.workoutType];
    const w = await addHealthSession(H, s, sport, label, indoor, all);
    if (w) added.push(w);
  }
  for (const it of always) {
    const w = await addHealthSession(H, it.raw, inboxSport(it.type), prettyType(it.type), false, all);
    if (w) added.push(w);
  }  if (added.length) {
    await renumberRides();
    await announceNewRecords(recBefore, added.map(w => w.id));
  }
  return added.length;
}

// --------------------------------------------------------
// SWIMS STRAIGHT FROM SAMSUNG HEALTH (native SamsungSwims plugin, Samsung Health Data SDK)
// Runs with every wellness import. Uses the same negative id as Health Connect and the
// export importer (−start in seconds), so a swim is never added twice.
// --------------------------------------------------------
// Samsung Health exercise type → [sport, name, indoor]. Outdoor rides come from Strava (skipped);
// rest periods between sets ("BREAK") are skipped; walks, squash, "OTHER"… go to the inbox.
const SHD_TYPES = {
  POOL_SWIMMING: ['swim', 'Pool swim', true], OPEN_WATER_SWIMMING: ['swim', 'Open water swim', false],
  TREADMILL: ['run', 'Treadmill run', true], RUNNING: ['run', 'Run', false], TRACK_RUNNING: ['run', 'Track run', false],
  STATIONARY_BIKING: ['ride', 'Stationary bike', true],
  ELLIPTICAL: ['other', 'Elliptical', true], ROWING_MACHINE: ['other', 'Rowing machine', true], STAIR_CLIMBING: ['other', 'Stair climbing', true],
  STEP_MACHINE: ['other', 'Step machine', true], WEIGHT_MACHINE: ['other', 'Weight machine', true], BENCH_PRESS: ['other', 'Bench press', true],
  SQUATS: ['other', 'Squats', true], DEADLIFTS: ['other', 'Deadlifts', true], LEG_PRESSES: ['other', 'Leg press', true], LAT_PULLDOWNS: ['other', 'Lat pulldown', true],
  PUSH_UPS: ['other', 'Push-ups', true], PLANK: ['other', 'Plank', true], ARM_EXTENSIONS: ['other', 'Arm extensions', true], AEROBICS: ['other', 'Aerobics', true],
  CIRCUIT_TRAINING: ['other', 'Circuit training', true], YOGA: ['other', 'Yoga', true], PILATES: ['other', 'Pilates', true]
};
const SHD_SKIP = ['BIKING', 'MOUNTAIN_BIKING', 'BREAK'];
const swimPlugin = () => capPlugin('SamsungSwims');

async function samsungSwimStatus() {
  const P = swimPlugin();
  if (!P) return { present: false };
  try { return Object.assign({ present: true }, await P.status()); } catch (e) { return { present: true, available: false, error: String(e.message || e) }; }
}

async function connectSamsungSwims() {
  const P = swimPlugin();
  if (!P) return;
  const r = await P.requestAccess().catch(e => ({ granted: false, error: String(e.message || e) }));
  if (r.granted) {
    await setConfig('swims_sdk', '1');
    toast('Samsung Health connected — importing swims and gym sessions…', 'success');
    const n = await importSamsungSwims(true);
    toast(n ? `${n} workout${n > 1 ? 's' : ''} imported (swims, treadmill, gym)` : 'Connected · nothing new since January', 'success', 3500);
  } else {
    toast(`Samsung Health didn't allow access${r.error ? ` (${r.error.slice(0, 90)})` : ''}. Turn on Developer mode for data read (see the steps in this card), then try again.`, 'warn', 9000);
  }
  renderHealthCard();
}

async function importSamsungSwims(full = false) {
  const P = swimPlugin();
  if (!P || (await getConfig('swims_sdk')) !== '1') return 0;
  const last = await getConfig('swims_sdk_scanned');
  const from = full || !last ? parseSafeDate(MIN_WORKOUT_DATE) : addDays(new Date(), -21);
  let res;
  try { res = await P.readSessions({ startDate: from.toISOString(), endDate: new Date().toISOString(), withLog: true }); } catch (e) { console.warn('swim read', e); return 0; }
  const all = await db.workouts.toArray();
  const recBefore = recordSignature(all);
  const deleted = await deletedWorkoutIds();
  const localDate = d => `${formatLocalDate(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const inboxItems = [];
  let added = 0;
  for (const s of (res && res.sessions) || []) {
    const start = new Date(s.start);
    const sid = -Math.round(start.getTime() / 1000);
    if (formatLocalDate(start) < MIN_WORKOUT_DATE || deleted.has(sid) || !(num(s.durationSec) >= 180) || SHD_SKIP.includes(s.type)) continue;
    const known = SHD_TYPES[s.type];
    if (!known) {
      if (!all.some(w => Math.abs(parseSafeDate(w.date) - start) <= 300000) && num(s.durationSec) >= 600) {
        const t = s.type.toLowerCase().replace(/_(\w)/g, (_, c) => c.toUpperCase());
        inboxItems.push({ key: `health:${sid}`, src: 'health', type: t, name: s.title || prettyType(t), date: localDate(start), distance_km: round(num(s.distance) / 1000, 2), moving_sec: Math.round(s.durationSec), raw: null,
          sh: { code: s.type, start: s.start, dur: Math.round(s.durationSec), dist: num(s.distance), hr: num(s.meanHr), max: num(s.maxHr), kcal: num(s.calories) } });
      }
      continue;
    }
    const kind = [known[1], known[2]];
    const sport = known[0];
    const twin = all.find(w => Number(w.strava_id) === sid || Math.abs(parseSafeDate(w.date) - start) <= 300000);
    if (twin) {
      // Strava filed a watch treadmill / gym-bike session as a generic "Workout": take the watch's sport
      if (twin.source !== 'health' && !twin.sport && sportOf(twin) === 'other' && sport !== 'other' && ['Workout', 'WeightTraining'].includes(twin.sport_type)) {
        await db.workouts.update(twin.id, { sport, indoor: kind[1] });
      }
      // A swim already here (e.g. from the export) gains the watch's distance / log if it lacked them
      if (twin.source === 'health' && !(twin.distance_km > 0) && (s.swimDistance || s.distance)) {
        const m = s.poolUnit === 'yard' ? num(s.swimDistance || s.distance) * 0.9144 : num(s.swimDistance || s.distance);
        await db.workouts.update(twin.id, { distance_km: round(m / 1000, 3), avg_speed_kmh: round((m / 1000) / (num(twin.moving_sec) / 3600), 2) });
      }
      continue;
    }
    const dur = Math.max(1, Math.round(num(s.swimDurationSec) || num(s.durationSec)));
    const meters = s.poolUnit === 'yard' ? num(s.swimDistance || s.distance) * 0.9144 : num(s.swimDistance || s.distance);
    const log = (s.log || []).map(p => ({ t: Math.round((p.t - start.getTime()) / 1000), hr: num(p.hr), sp: num(p.sp) })).filter(p => p.t >= 0 && p.t <= dur + 60);
    const hrPts = log.filter(p => p.hr > 30);
    const w = {
      strava_id: sid, ride_number: 0, exercise_code: '', source: 'health', hc_type: `shd:${s.type}`,
      name: s.title || kind[0], sport, sport_type: s.type, indoor: kind[1],
      date: `${formatLocalDate(start)} ${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`,
      distance_km: round(meters / 1000, 3), moving_sec: dur, elapsed_sec: Math.round(num(s.durationSec)) || dur, duration_str: formatDuration(dur),
      avg_speed_kmh: meters > 0 ? round((meters / 1000) / (dur / 3600), 2) : 0, max_speed_kmh: s.maxSpeed ? round(s.maxSpeed * 3.6, 2) : 0,
      avg_hr: Math.round(num(s.meanHr)) || (hrPts.length ? Math.round(mean(hrPts.map(p => p.hr))) : 0),
      max_hr: Math.round(num(s.maxHr)) || (hrPts.length ? Math.max(...hrPts.map(p => p.hr)) : 0),
      elevation_gain_m: 0, kilojoules: 0, calories: Math.round(num(s.calories)),
      avg_power_w: 0, max_power_w: 0, norm_power_w: 0, device_watts: false, map_polyline: '',
      pool_length_m: s.poolLength ? round(s.poolUnit === 'yard' ? s.poolLength * 0.9144 : s.poolLength, 1) : null,
      source_name: 'Samsung Health (watch)', debrief_stale: false, intent_type: null, zone_seconds: [0, 0, 0, 0, 0]
    };
    // Heart rate for zones/load; speed too for treadmill/runs (pace best efforts). Swim speed per sample isn't meaningful.
    const withSpeed = sport === 'run' && log.some(p => p.sp > 0);
    const pts = withSpeed ? log.filter(p => p.hr > 30 || p.sp > 0) : hrPts;
    const stream = pts.length > 5 ? Object.assign({ time: { data: pts.map(p => p.t) }, heartrate: { data: pts.map(p => Math.round(p.hr) || null) } }, withSpeed ? { velocity_smooth: { data: pts.map(p => p.sp) } } : {}) : null;
    w.id = await db.workouts.add(w);
    await db.streams.put({ strava_id: sid, stream_data: stream });
    await ensureRideMetrics(w, stream, true);
    all.push(w);
    added++;
  }
  // Walks, squash, "other"… → inbox (or straight in when the athlete chose "always include")
  if (inboxItems.length) for (const it of await routeToInbox(inboxItems)) if (await addSamsungSummary(it)) added++;
  await setConfig('swims_sdk_scanned', new Date().toISOString());
  if (added) {
    await renumberRides();
    await announceNewRecords(recBefore, all.slice(-added).map(w => w.id));
  }
  return added;
}

// --------------------------------------------------------
// SAMSUNG HEALTH EXPORT (Settings → Download personal data)
// Samsung Health does not share swims with Health Connect, but its own data export
// has every session. The athlete picks the exercise CSV
// (com.samsung.shealth.exercise.<date>.csv) and, optionally, the matching
// "…exercise.live_data.json" files for second-by-second heart rate.
// Codes: Samsung Health predefined exercise types.
// --------------------------------------------------------
const SH_TYPES = {
  14001: ['swim', 'Pool swim', true], 1002: ['run', 'Run', false], 15005: ['run', 'Treadmill run', true],
  11007: ['ride', 'Ride', false], 15003: ['ride', 'Exercise bike', true],
  15006: ['other', 'Elliptical', true], 15001: ['other', 'Step machine', true], 15004: ['other', 'Rowing machine', true],
  14010: ['other', 'Rowing machine', true], 15002: ['other', 'Weight machine', true], 10007: ['other', 'Circuit training', true],
  9002: ['other', 'Yoga', true], 9001: ['other', 'Pilates', true], 12001: ['other', 'Aerobics', true]
};
const SH_INBOX = { 1001: 'walking', 13001: 'hiking', 0: 'other' };

function parseCsvLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// "2026-10-20 05:30:00.000" (UTC) → Date
function shDate(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  return m ? new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null;
}

async function importSamsungExport(event) {
  const files = [...((event && event.target && event.target.files) || [])];
  if (event && event.target) event.target.value = '';
  const csv = files.find(f => /exercise/i.test(f.name) && /\.csv$/i.test(f.name)) || files.find(f => /\.csv$/i.test(f.name));
  if (!csv) { toast('Pick the com.samsung.shealth.exercise…csv file from the Samsung Health export.', 'warn', 6000); return; }
  const lines = (await csv.text()).split(/\r?\n/).filter(Boolean);
  const hi = lines.findIndex(l => /exercise_type/.test(l));
  if (hi < 0) { toast(`"${csv.name}" doesn't look like the Samsung Health exercise file.`, 'error', 6000); return; }
  const head = parseCsvLine(lines[hi]).map(h => h.trim());
  const col = name => head.findIndex(h => h === name || h.endsWith(`.${name}`));
  const C = { type: col('exercise_type'), start: col('start_time'), end: col('end_time'), dur: col('duration'), dist: col('distance'), hr: col('mean_heart_rate'), max: col('max_heart_rate'), kcal: col('calorie'), uuid: col('datauuid'), pool: col('pool_length') };
  // Heart-rate detail files, keyed by session id
  const live = {};
  for (const f of files.filter(x => /live_data\.json$/i.test(x.name))) {
    const id = f.name.split('.')[0];
    try { live[id] = JSON.parse(await f.text()); } catch (e) { /* skip unreadable file */ }
  }
  const all = await db.workouts.toArray();
  const recBefore = recordSignature(all);
  const deleted = await deletedWorkoutIds();
  const inboxItems = [];
  let added = 0, skipped = 0;
  await createRestorePoint('Before importing a Samsung Health export', 'auto');
  for (const line of lines.slice(hi + 1)) {
    const r = parseCsvLine(line);
    const code = parseInt(r[C.type], 10);
    const start = shDate(r[C.start]);
    if (!start || !Number.isFinite(code) || formatLocalDate(start) < MIN_WORKOUT_DATE) continue;
    const dur = Math.round(num(r[C.dur]) / 1000) || Math.round((shDate(r[C.end]) - start) / 1000);
    if (!(dur >= 180)) continue;
    const sid = -Math.round(start.getTime() / 1000);
    if (deleted.has(sid) || all.some(w => Number(w.strava_id) === sid || Math.abs(parseSafeDate(w.date) - start) <= 300000)) { skipped++; continue; }
    const dist = num(r[C.dist]);
    if (!SH_TYPES[code]) {
      if (code in SH_INBOX || code > 0) inboxItems.push({ key: `health:${sid}`, src: 'health', type: SH_INBOX[code] || `samsung${code}`, name: prettyType(SH_INBOX[code] || 'activity'), date: `${formatLocalDate(start)} ${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`, distance_km: round(dist / 1000, 2), moving_sec: dur, raw: null, sh: { code, start: start.toISOString(), dur, dist, hr: num(r[C.hr]), max: num(r[C.max]), kcal: num(r[C.kcal]) } });
      continue;
    }
    const [sport, label, indoor] = SH_TYPES[code];
    const pts = (live[r[C.uuid]] || []).filter(p => p && num(p.heart_rate) > 30 && p.start_time);
    const t0 = start.getTime();
    const hr = pts.map(p => ({ t: Math.round((num(p.start_time) - t0) / 1000), v: Math.round(num(p.heart_rate)) })).filter(p => p.t >= 0 && p.t <= dur).sort((a, b) => a.t - b.t);
    const w = {
      strava_id: sid, ride_number: 0, exercise_code: '', source: 'health', hc_type: `samsung:${code}`,
      name: code === 14001 && !(num(r[C.pool]) > 0) && dist > 0 && !indoor ? 'Swim' : label, sport, sport_type: `samsung${code}`, indoor,
      date: `${formatLocalDate(start)} ${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`,
      distance_km: round(dist / 1000, 3), moving_sec: dur, elapsed_sec: dur, duration_str: formatDuration(dur),
      avg_speed_kmh: dist > 0 ? round((dist / 1000) / (dur / 3600), 2) : 0, max_speed_kmh: 0,
      avg_hr: Math.round(num(r[C.hr])) || (hr.length ? Math.round(mean(hr.map(x => x.v))) : 0), max_hr: Math.round(num(r[C.max])) || (hr.length ? Math.max(...hr.map(x => x.v)) : 0),
      elevation_gain_m: 0, kilojoules: 0, calories: Math.round(num(r[C.kcal])),
      avg_power_w: 0, max_power_w: 0, norm_power_w: 0, device_watts: false, map_polyline: '', source_name: 'Samsung Health export',
      debrief_stale: false, intent_type: null, zone_seconds: [0, 0, 0, 0, 0]
    };
    const stream = hr.length > 5 ? { time: { data: hr.map(x => x.t) }, heartrate: { data: hr.map(x => x.v) } } : null;
    w.id = await db.workouts.add(w);
    await db.streams.put({ strava_id: sid, stream_data: stream });
    await ensureRideMetrics(w, stream, true);
    all.push(w);
    added++;
  }
  // Walks, hikes and custom types from the export → inbox (imported from the saved summary)
  if (inboxItems.length) {
    const always = await routeToInbox(inboxItems);
    for (const it of always) if (await addSamsungSummary(it)) added++;
  }
  if (added) { await renumberRides(); await announceNewRecords(recBefore, (await db.workouts.toArray()).filter(w => w.source_name === 'Samsung Health export').map(w => w.id)); }
  haptic(added ? 'success' : 'light');
  toast(`Samsung Health export: ${added} added${skipped ? `, ${skipped} already here` : ''}${inboxItems.length ? `, ${inboxItems.length} to sort in the inbox` : ''}`, added ? 'success' : 'info', 5000);
  await afterWorkoutsChanged(null);
}

// Inbox items that came from the export carry a summary instead of a Health Connect session
async function addSamsungSummary(it) {
  const s = it.sh;
  if (!s) return false;
  const start = new Date(s.start);
  const sid = -Math.round(start.getTime() / 1000);
  if (await db.workouts.where('strava_id').equals(sid).first()) return false;
  const w = {
    strava_id: sid, ride_number: 0, exercise_code: '', source: 'health', hc_type: `samsung:${s.code}`, name: it.name, sport: inboxSport(it.type), sport_type: it.type, indoor: false,
    date: it.date, distance_km: round(s.dist / 1000, 3), moving_sec: s.dur, elapsed_sec: s.dur, duration_str: formatDuration(s.dur),
    avg_speed_kmh: s.dist > 0 ? round((s.dist / 1000) / (s.dur / 3600), 2) : 0, max_speed_kmh: 0, avg_hr: Math.round(s.hr) || 0, max_hr: Math.round(s.max) || 0,
    elevation_gain_m: 0, kilojoules: 0, calories: Math.round(s.kcal), avg_power_w: 0, max_power_w: 0, norm_power_w: 0, device_watts: false, map_polyline: '',
    source_name: 'Samsung Health export', debrief_stale: false, intent_type: null, zone_seconds: [0, 0, 0, 0, 0]
  };
  w.id = await db.workouts.add(w);
  await db.streams.put({ strava_id: sid, stream_data: null });
  await ensureRideMetrics(w, null, true);
  return true;
}

// One Health Connect session → workout (+ heart-rate stream). Returns the workout, or null if it
// already exists, was deleted, or is on Strava.
async function addHealthSession(H, s, sport, label, indoor, all) {
  const start = new Date(s.startDate), end = new Date(s.endDate);
  const sid = -Math.round(start.getTime() / 1000);
  if (formatLocalDate(start) < MIN_WORKOUT_DATE) return null;
  if (all.some(w => Number(w.strava_id) === sid) || (await deletedWorkoutIds()).has(sid)) return null;
  if (all.some(w => w.source !== 'health' && Math.abs(parseSafeDate(w.date) - start) <= 300000)) return null;
  const dur = Math.max(1, num(s.duration) || Math.round((end - start) / 1000));
  let hr = [];
  try {
    const smp = await H.readSamples({ dataType: 'heartRate', startDate: start.toISOString(), endDate: end.toISOString(), limit: 20000, ascending: true });
    hr = ((smp && smp.samples) || []).map(x => ({ t: Math.round((new Date(x.startDate) - start) / 1000), v: Math.round(num(x.value)) })).filter(x => x.v > 30 && x.t >= 0 && x.t <= dur);
  } catch (err) { console.warn('session HR', err); }
  const dist = num(s.totalDistance);
  const hrs = hr.map(x => x.v);
  const w = {
    strava_id: sid, ride_number: 0, exercise_code: '', source: 'health', hc_id: s.platformId || '',
    name: label, sport, sport_type: s.workoutType, indoor, hc_type: s.workoutType,
    date: `${formatLocalDate(start)} ${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`,
    distance_km: round(dist / 1000, 3), moving_sec: dur, elapsed_sec: dur, duration_str: formatDuration(dur),
    avg_speed_kmh: dist > 0 ? round((dist / 1000) / (dur / 3600), 2) : 0, max_speed_kmh: 0,
    avg_hr: hrs.length ? Math.round(mean(hrs)) : 0, max_hr: hrs.length ? Math.max(...hrs) : 0,
    elevation_gain_m: 0, kilojoules: 0, calories: Math.round(num(s.totalEnergyBurned)),
    avg_power_w: 0, max_power_w: 0, norm_power_w: 0, device_watts: false, map_polyline: '',
    source_name: [s.sourceName, s.metadata && s.metadata.device].filter(Boolean).join(' · '),
    debrief_stale: false, intent_type: null, zone_seconds: [0, 0, 0, 0, 0]
  };
  const stream = hr.length > 5 ? { time: { data: hr.map(x => x.t) }, heartrate: { data: hrs } } : null;
  w.id = await db.workouts.add(w);
  await db.streams.put({ strava_id: sid, stream_data: stream });
  await ensureRideMetrics(w, stream, true);
  all.push(w);
  return w;
}
// --------------------------------------------------------
// READINESS SUMMARY (UI + prompts)
// --------------------------------------------------------
function baseline(days, field, n, endKey) {
  const keys = Object.keys(days).filter(k => k < endKey).sort().slice(-n);
  return mean(keys.map(k => days[k][field]).filter(v => v > 0));
}

async function wellnessSnapshot(dateKey = formatLocalDate(new Date())) {
  const w = await getWellness();
  const keys = Object.keys(w.days).filter(k => k <= dateKey).sort();
  if (!keys.length) return null;
  const d = w.days[dateKey] || {};
  const last = k => { for (let i = keys.length - 1; i >= 0; i--) if (w.days[keys[i]][k] > 0) return { v: w.days[keys[i]][k], date: keys[i] }; return null; };
  const sleep7 = mean(keys.slice(-7).map(k => w.days[k].sleep_min).filter(v => v > 0));
  return {
    date: dateKey,
    sleep: d.sleep_min || null, deep: d.deep_min || null, rem: d.rem_min || null,
    sleep7: sleep7 ? Math.round(sleep7) : null,
    sleep7n: keys.slice(-7).filter(k => w.days[k].sleep_min > 0).length,
    rhr: d.rhr || (last('rhr') || {}).v || null,
    rhrBase: baseline(w.days, 'rhr', 30, dateKey),
    hrv: d.hrv || (last('hrv') || {}).v || null,
    hrvBase: baseline(w.days, 'hrv', 30, dateKey),
    hrv7: mean(keys.slice(-7).map(k => w.days[k].hrv).filter(v => v > 0)),
    steps: d.steps || null,
    weight: (last('weight') || {}).v || null,
    vo2max: w.vo2max,
    updated_at: w.updated_at
  };
}

function fmtSleep(min) {
  return min ? `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, '0')}m` : '--';
}

// One line for the Rides tab
async function readinessChipHtml() {
  if ((await getConfig('health_enabled')) !== '1') return '';
  const s = await wellnessSnapshot();
  if (!s) return '';
  const parts = [];
  if (s.sleep) parts.push(`${icon('moon', 'ic-sm')}${fmtSleep(s.sleep)}`);
  if (s.rhr) parts.push(`${icon('heart', 'ic-sm')}${s.rhr} bpm${s.rhrBase ? ` <span class="${s.rhr - s.rhrBase > 3 ? 'neg' : 'pos'}">${signed(s.rhr - s.rhrBase, 0)}</span>` : ''}`);
  if (s.hrv) parts.push(`${icon('activity', 'ic-sm')}HRV ${s.hrv}${s.hrvBase ? ` <span class="${s.hrv < s.hrvBase * 0.85 ? 'neg' : 'pos'}">${signed(((s.hrv - s.hrvBase) / s.hrvBase) * 100, 0, '%')}</span>` : ''}`);
  return parts.length ? `<div class="readiness">${parts.map(p => `<span>${p}</span>`).join('')}</div>` : '';
}

// Text for AI prompts
async function wellnessContextText(dateKey, detail = 'short') {
  if ((await getConfig('health_enabled')) !== '1') return '';
  const s = await wellnessSnapshot(dateKey);
  if (!s) return 'WELLNESS (Samsung Health): linked, but no data for this period yet.';
  const lines = [`WELLNESS (Galaxy Watch via Samsung Health / Health Connect) for ${formatFullDateWithDay(s.date)}:`];
  lines.push(`- Sleep last night: ${fmtSleep(s.sleep)}${s.deep ? ` (deep ${s.deep}m, REM ${s.rem || '--'}m)` : ''} | 7-night average ${fmtSleep(s.sleep7)}${s.sleep7 ? ` (from ${s.sleep7n} recorded night${s.sleep7n === 1 ? '' : 's'})` : ''}`);
  if (s.rhr) lines.push(`- Resting HR: ${s.rhr} bpm${s.rhrBase ? ` (30-day baseline ${Math.round(s.rhrBase)}; ${signed(s.rhr - s.rhrBase, 0)} bpm)` : ''} (estimated from the lowest hourly heart rate when the watch gives no resting value)`);
  if (s.hrv) lines.push(`- HRV: ${s.hrv} ms${s.hrvBase ? ` (30-day baseline ${Math.round(s.hrvBase)} ms; 7-day avg ${s.hrv7 ? Math.round(s.hrv7) : '--'} ms)` : ''}`);
  else lines.push('- HRV: not shared by Samsung Health');
  const w14 = await getWellness();
  const k14 = Object.keys(w14.days).filter(k => k <= s.date).sort().slice(-14);
  const nights = k14.filter(k => w14.days[k].sleep_min > 0).length;
  if (k14.length >= 7 && nights < k14.length / 2) lines.push(`- Sleep was recorded on only ${nights} of the last ${k14.length} nights (watch not worn overnight?) — don't treat missing nights as poor sleep.`);
  if (s.steps) lines.push(`- Steps that day: ${s.steps}`);
  if (s.weight) lines.push(`- Latest scale weight: ${s.weight} kg`);
  if (s.vo2max) lines.push(`- Watch VO2max estimate: ${s.vo2max.value} (${s.vo2max.date})`);
  if (detail === 'long') {
    const w = await getWellness();
    const keys = Object.keys(w.days).filter(k => k <= s.date).sort().slice(-14);
    if (keys.length) {
      lines.push('- Last 14 days (date: sleep / RHR / HRV / steps):');
      for (const k of keys) {
        const d = w.days[k];
        lines.push(`  ${k}: ${fmtSleep(d.sleep_min)} / ${d.rhr || '--'} / ${d.hrv || '--'} / ${d.steps || '--'}`);
      }
    }
  }
  lines.push('Interpretation guide: RHR >5 bpm above baseline or HRV >15% below baseline, or <6 h sleep, suggests incomplete recovery.');
  return lines.join('\n');
}

async function renderHealthCard() {
  const host = $('#healthState');
  if (!host) return;
  const on = (await getConfig('health_enabled')) === '1';
  const s = on ? await wellnessSnapshot() : null;
  $('#btnHealthConnect').classList.toggle('hidden', on);
  $('#healthOnRow').classList.toggle('hidden', !on);
  $('#cfg_health_weight').checked = (await getConfig('health_weight_to_log')) !== '0';
  host.innerHTML = !on
    ? '<span class="neu">Not linked</span>'
    : s
      ? `<span class="pos">● Linked</span> · updated ${escapeHtml(relativeTime(s.updated_at))}<br>Sleep ${fmtSleep(s.sleep)} · RHR ${s.rhr || '--'} · HRV ${s.hrv || '--'} ms${s.vo2max ? ` · VO2max ${s.vo2max.value}` : ''}`
      : '<span class="pos">● Linked</span> · no data yet — tap Import now';
  await renderSwimSdkCard();
}

// Automatic swims: shown only in builds that include the Samsung Health swim reader
async function renderSwimSdkCard() {
  const box = $('#swimSdkBox');
  if (!box) return;
  const st = await samsungSwimStatus();
  box.classList.toggle('hidden', !st.present);
  if (!st.present) return;
  const on = (await getConfig('swims_sdk')) === '1' && st.granted;
  const last = await getConfig('swims_sdk_scanned');
  const mine = (await db.workouts.toArray()).filter(w => String(w.hc_type || '').startsWith('shd:'));
  const n = mine.filter(w => sportOf(w) === 'swim').length, g = mine.length - n;
  $('#swimSdkState').innerHTML = on
    ? `<span class="pos">● Automatic</span> · ${n} swim${n === 1 ? '' : 's'} + ${g} other watch session${g === 1 ? '' : 's'}${last ? ` · checked ${escapeHtml(relativeTime(last))}` : ''}`
    : st.available === false
      ? `<span class="neg">Samsung Health not reachable</span>${st.error ? `<br><span class="tiny">${escapeHtml(st.error.slice(0, 140))}</span>` : ''}`
      : '<span class="neu">Not connected</span>';
  $('#btnSwimSdk').textContent = on ? 'Import swims now' : 'Connect swims';
}

async function swimSdkButton() {
  if ((await getConfig('swims_sdk')) === '1' && (await samsungSwimStatus()).granted) {
    const n = await importSamsungSwims(true);
    toast(n ? `${n} new swim${n > 1 ? 's' : ''}` : 'No new swims', 'success', 2500);
    await afterWorkoutsChanged(null);
    renderSwimSdkCard();
  } else await connectSamsungSwims();
}
