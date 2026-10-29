'use strict';
// --------------------------------------------------------
// PHYSIOLOGY ENGINE
// Zones, per-ride metrics, training load (TRIMP → fitness /
// fatigue / form), comparisons and records.
// --------------------------------------------------------

// Bump when a calculation changes so stored ride metrics are recomputed automatically.
const METRICS_VERSION = 'm3.0';

const ZONE_META = [
  { key: 'Z1', name: 'Recovery', long: 'Active Recovery', color: '#94a3b8' },
  { key: 'Z2', name: 'Aerobic Base', long: 'Aerobic Base', color: '#16a34a' },
  { key: 'Z3', name: 'Tempo', long: 'Tempo Endurance', color: '#eab308' },
  { key: 'Z4', name: 'Threshold', long: 'Sub-Threshold', color: '#fc5200' },
  { key: 'Z5', name: 'VO2max', long: 'VO2max / Anaerobic', color: '#ef4444' }
];

// Defaults reproduce the original v2 zones exactly (max 207; Z2 starts 135, Z3 155, Z4 171, Z5 189).
const DEFAULT_PHYSIO = { max_hr: 207, resting_hr: 60, bounds: [135, 155, 171, 189], trimp_sex: 'M' };

const PHYSIO = {
  max_hr: 207,
  resting_hr: 60,
  bounds: [135, 155, 171, 189],
  trimp_sex: 'M',
  zones: [],
  getZoneIndex(hr) {
    if (!hr || hr <= 0) return -1;
    for (let i = 0; i < this.bounds.length; i++) if (hr < this.bounds[i]) return i;
    return 4;
  }
};

const ATHLETE = { name: 'Mustafa', bike: 'Kron XC150 Mountain Bike', height: '' };

function rebuildZones() {
  const b = PHYSIO.bounds;
  PHYSIO.zones = ZONE_META.map((z, i) => ({
    ...z,
    min: i === 0 ? 0 : b[i - 1],
    max: i === 4 ? PHYSIO.max_hr : b[i] - 1,
    label: `${z.key} ${z.name}`
  }));
}

function validateBounds(bounds, maxHr) {
  if (!Array.isArray(bounds) || bounds.length !== 4) return 'Enter four zone limits.';
  for (let i = 0; i < 4; i++) {
    if (!Number.isFinite(bounds[i]) || bounds[i] < 60) return `Zone ${i + 2} start must be a number above 60 bpm.`;
    if (i > 0 && bounds[i] <= bounds[i - 1]) return `Zone ${i + 2} must start above Zone ${i + 1}.`;
  }
  if (bounds[3] >= maxHr) return 'Zone 5 must start below your max heart rate.';
  return null;
}

// Same proportions as the original zones (65 / 75 / 83 / 91 % of max HR)
function suggestBoundsFromMax(maxHr) {
  return [0.652, 0.749, 0.826, 0.913].map(p => Math.round(maxHr * p));
}

async function loadPhysioConfig() {
  const max = num(await getConfig('max_hr'), DEFAULT_PHYSIO.max_hr) || DEFAULT_PHYSIO.max_hr;
  const rest = num(await getConfig('resting_hr'), DEFAULT_PHYSIO.resting_hr) || DEFAULT_PHYSIO.resting_hr;
  const bounds = await getJsonConfig('zone_bounds', DEFAULT_PHYSIO.bounds);
  PHYSIO.max_hr = max;
  PHYSIO.resting_hr = rest;
  PHYSIO.bounds = validateBounds(bounds, max) ? DEFAULT_PHYSIO.bounds.slice() : bounds.map(Number);
  PHYSIO.trimp_sex = (await getConfig('trimp_sex')) || 'M';
  rebuildZones();

  ATHLETE.name = (await getConfig('athlete_name')) || 'Mustafa';
  ATHLETE.bike = (await getConfig('bike_name')) || 'Kron XC150 Mountain Bike';
  ATHLETE.height = (await getConfig('athlete_height')) || '';
}

function physioSignature() {
  return `${METRICS_VERSION}|${PHYSIO.max_hr}|${PHYSIO.resting_hr}|${PHYSIO.bounds.join(',')}|${PHYSIO.trimp_sex}`;
}

function zoneFrameworkText() {
  return PHYSIO.zones.map((z, i) => i === 0 ? `Z1 (<${PHYSIO.bounds[0]} bpm)` : `${z.key} (${z.min}-${z.max} bpm)`).join(', ');
}

function zoneRangeText(i) {
  const z = PHYSIO.zones[i];
  return i === 0 ? `<${PHYSIO.bounds[0]} bpm` : `${z.min}–${z.max} bpm`;
}

function formatFullZoneSummary(zSecs) {
  if (!Array.isArray(zSecs) || !zSecs.some(v => v > 0)) return 'No zone data';
  return PHYSIO.zones.map((z, i) => `${z.key}:${Math.round(num(zSecs[i]) / 60)}m`).join(', ');
}

function parseIntent(w) {
  if (!w || !w.intent_target || w.intent_type === 'NONE' || w.intent_type === 'PLAY') return null;
  try { return JSON.parse(w.intent_target); } catch (e) { return null; }
}

function parseZoneTag(str) {
  if (!str) return '';
  const m = String(str).match(/Zone\s*\d+/i);
  return m ? m[0] : String(str).slice(0, 10);
}

function getCleanIntentLabel(w) {
  if (!w) return 'No intent specified';
  if (w.intent_type === 'PLAY') return 'Play / Commute (Free-form)';
  const it = parseIntent(w);
  if (!it) return 'No intent specified';
  if (it.format === 'INTERVAL') return `${it.target_zone || 'Intervals'}, Switching: ${it.interval_zones || 'N/A'} (${it.interval_freq || 'Interval Pattern'})`;
  return `${it.target_zone || 'Structured Training'}, Steady State`;
}

function driftText(w) {
  if (!w || !hasVal(w.cardiac_drift_bpm)) return 'n/a drift';
  return `${signed(w.cardiac_drift_bpm, 0)}bpm drift`;
}

function decouplingDisplay(w) {
  if (hasVal(w.cardiac_decoupling_pct)) {
    const basis = w.decoupling_basis === 'power' ? 'Pw:HR' : 'Spd:HR';
    return `${signed(w.cardiac_decoupling_pct, 1)}% (${basis})`;
  }
  if (hasVal(w.cardiac_drift_bpm)) return `${signed(w.cardiac_drift_bpm, 0)} bpm drift`;
  return '--';
}

function grossAscentRate(w) {
  return w.moving_sec > 0 ? Math.round(num(w.elevation_gain_m) / (w.moving_sec / 3600)) : 0;
}

function vamText(w, long = false) {
  if (w.climbing_vam) return long ? `${w.climbing_vam} m/h (Sustained Climb >3% grade)` : `${w.climbing_vam}m/h VAM(>3%)`;
  const g = grossAscentRate(w);
  return long ? `${g} m/h (Gross Ascent Rate - No qualifying >3% sustained climb)` : `${g}m/h grossVAM`;
}

// --------------------------------------------------------
// TRIMP (Banister): Σ minutes × HRr × a × e^(b × HRr)
// --------------------------------------------------------
function trimpCoeffs() {
  return PHYSIO.trimp_sex === 'F' ? { a: 0.86, b: 1.67 } : { a: 0.64, b: 1.92 };
}

function hrReserveFraction(hr) {
  const span = PHYSIO.max_hr - PHYSIO.resting_hr;
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (hr - PHYSIO.resting_hr) / span));
}

function trimpFromAverage(w) {
  if (!(w.avg_hr > 0) || !(w.moving_sec > 0)) return null;
  const { a, b } = trimpCoeffs();
  const x = hrReserveFraction(w.avg_hr);
  return round((w.moving_sec / 60) * x * a * Math.exp(b * x), 1);
}

// --------------------------------------------------------
// PER-RIDE METRICS FROM STREAMS
// --------------------------------------------------------
function computeRideMetrics(workout, s) {
  const out = {
    zone_seconds: [0, 0, 0, 0, 0],
    climbing_vam: null,
    cardiac_drift_bpm: null,
    cardiac_decoupling_pct: null,
    decoupling_basis: null,
    halves_profile: '',
    trimp: null,
    trimp_source: null,
    metrics_sig: physioSignature()
  };

  const times = s && s.time && Array.isArray(s.time.data) ? s.time.data : null;
  if (!times || times.length < 2) {
    out.trimp = trimpFromAverage(workout);
    out.trimp_source = hasVal(out.trimp) ? 'avg' : null;
    return out;
  }

  const n = times.length;
  const hrs = s.heartrate && Array.isArray(s.heartrate.data) ? s.heartrate.data : null;
  const moving = s.moving && Array.isArray(s.moving.data) ? s.moving.data : null;
  const grades = s.grade_smooth && Array.isArray(s.grade_smooth.data) ? s.grade_smooth.data : null;
  const alts = s.altitude && Array.isArray(s.altitude.data) ? s.altitude.data : null;
  const dists = s.distance && Array.isArray(s.distance.data) ? s.distance.data : null;
  const spds = s.velocity_smooth && Array.isArray(s.velocity_smooth.data) ? s.velocity_smooth.data : [];
  const watts = workout.device_watts && s.watts && Array.isArray(s.watts.data) ? s.watts.data : null;

  // Δt for the interval ending at sample i; gaps (auto-pause) capped at 10 s
  const dtAt = i => (i === 0 ? 0 : Math.min(Math.max(num(times[i]) - num(times[i - 1]), 0), 10));
  const isMoving = i => (moving ? moving[i] !== false : (spds[i] === undefined || spds[i] > 0.5));

  // 1) Time in zone (moving only) + TRIMP (all recorded time)
  const { a, b } = trimpCoeffs();
  let trimp = 0;
  let hrSec = 0;
  if (hrs) {
    for (let i = 1; i < n; i++) {
      const hr = hrs[i];
      if (!(hr > 0)) continue;
      const dt = dtAt(i);
      const x = hrReserveFraction(hr);
      trimp += (dt / 60) * x * a * Math.exp(b * x);
      hrSec += dt;
      if (!isMoving(i)) continue;
      const z = PHYSIO.getZoneIndex(hr);
      if (z >= 0) out.zone_seconds[z] += dt;
    }
  }
  if (hrSec > 60) {
    out.trimp = round(trimp, 1);
    out.trimp_source = 'stream';
  } else {
    out.trimp = trimpFromAverage(workout);
    out.trimp_source = hasVal(out.trimp) ? 'avg' : null;
  }

  // 2) Climbing VAM (>3% grade, moving) — independent of heart rate
  if (alts) {
    let climbSec = 0;
    let climbGain = 0;
    for (let i = 1; i < n; i++) {
      if (!isMoving(i)) continue;
      const dt = dtAt(i);
      if (!(dt > 0)) continue;
      let grade = grades ? grades[i] : null;
      if (grade === null || grade === undefined) {
        const dd = dists ? dists[i] - dists[i - 1] : 0;
        grade = dd > 0 ? ((alts[i] - alts[i - 1]) / dd) * 100 : 0;
      }
      if (grade > 3.0) {
        climbSec += dt;
        const dAlt = alts[i] - alts[i - 1];
        if (dAlt > 0) climbGain += dAlt;
      }
    }
    if (climbSec >= 120 && climbGain > 5) out.climbing_vam = Math.round(climbGain / (climbSec / 3600));
  }

  // 3) Halves profile & aerobic decoupling on moving time (first 12 min of moving time skipped)
  if (hrs) {
    let mSec = 0;
    const samples = [];
    for (let i = 0; i < n; i++) {
      if (!isMoving(i)) continue;
      mSec += dtAt(i);
      samples.push({ m: mSec, hr: hrs[i], spd: spds[i] !== undefined ? spds[i] * 3.6 : 0, pw: watts ? watts[i] : null });
    }
    const WARMUP = 720;
    if (mSec > WARMUP + 600) {
      const mid = WARMUP + (mSec - WARMUP) / 2;
      const h = [{ hr: [], spd: [], pw: [] }, { hr: [], spd: [], pw: [] }];
      for (const smp of samples) {
        if (smp.m < WARMUP) continue;
        const half = smp.m <= mid ? h[0] : h[1];
        if (smp.hr > 0) half.hr.push(smp.hr);
        if (smp.spd > 0) half.spd.push(smp.spd);
        if (smp.pw !== null && smp.pw !== undefined) half.pw.push(num(smp.pw));
      }
      const hr1 = mean(h[0].hr), hr2 = mean(h[1].hr);
      const sp1 = mean(h[0].spd), sp2 = mean(h[1].spd);
      const pw1 = mean(h[0].pw), pw2 = mean(h[1].pw);
      const hasPw = pw1 > 0 && pw2 > 0;
      out.halves_profile = `[H1: ${fmtNum(sp1, 1)}km/h, ${Math.round(num(hr1))}bpm${hasPw ? `, ${Math.round(pw1)}W` : ''} -> H2: ${fmtNum(sp2, 1)}km/h, ${Math.round(num(hr2))}bpm${hasPw ? `, ${Math.round(pw2)}W` : ''}]`;

      const it = parseIntent(workout);
      const isSteady = workout.intent_type === 'TRAINING' && it && it.format !== 'INTERVAL';
      if (isSteady && mSec >= 1800 && hr1 > 0 && hr2 > 0) {
        const usePower = pw1 > 0 && pw2 > 0;
        const ef1 = usePower ? pw1 / hr1 : sp1 / hr1;
        const ef2 = usePower ? pw2 / hr2 : sp2 / hr2;
        if (ef1 > 0 && Number.isFinite(ef2)) {
          out.cardiac_drift_bpm = Math.round(hr2 - hr1);
          out.cardiac_decoupling_pct = round(((ef1 - ef2) / ef1) * 100, 1);
          out.decoupling_basis = usePower ? 'power' : 'speed';
        }
      }
    }
  }
  return out;
}

function needsMetrics(w) {
  return !w.metrics_sig || w.metrics_sig !== physioSignature();
}

// Compute (if needed) and persist metrics. Returns the updated workout object.
async function ensureRideMetrics(w, streamData, force = false) {
  if (!force && !needsMetrics(w)) return w;
  let s = streamData;
  if (s === undefined) {
    const row = await db.streams.get(Number(w.strava_id));
    s = row ? row.stream_data : null;
  }
  const m = computeRideMetrics(w, s);
  Object.assign(w, m);
  if (w.id) await db.workouts.update(w.id, m);
  return w;
}

async function recomputeAllMetrics(onProgress) {
  const all = await db.workouts.toArray();
  let i = 0;
  for (const w of all) {
    await ensureRideMetrics(w, undefined, true);
    i++;
    if (onProgress && i % 5 === 0) onProgress(i, all.length);
  }
  return all.length;
}

// --------------------------------------------------------
// 1-MINUTE TELEMETRY TIMELINE (single pass)
// --------------------------------------------------------
async function build1MinuteTelemetryTimeline(stravaId) {
  const cached = await db.streams.get(Number(stravaId));
  const s = cached && cached.stream_data;
  if (!s || !s.time || !Array.isArray(s.time.data)) return 'No granular stream recorded for this workout.';

  const times = s.time.data;
  const dists = s.distance ? s.distance.data : [];
  const speeds = s.velocity_smooth ? s.velocity_smooth.data : [];
  const hrs = s.heartrate ? s.heartrate.data : [];
  const alts = s.altitude ? s.altitude.data : [];
  const watts = s.watts ? s.watts.data : [];
  const moving = s.moving ? s.moving.data : null;

  const buckets = new Map();
  for (let i = 0; i < times.length; i++) {
    if (moving && moving[i] === false) continue;
    const minute = Math.floor(times[i] / 60) + 1;
    let bk = buckets.get(minute);
    if (!bk) { bk = { spd: 0, n: 0, hr: 0, hrN: 0, pw: 0, pwN: 0, first: i, last: i }; buckets.set(minute, bk); }
    bk.spd += num(speeds[i]); bk.n++;
    if (hrs[i] > 0) { bk.hr += hrs[i]; bk.hrN++; }
    if (watts[i] > 0) { bk.pw += watts[i]; bk.pwN++; }
    bk.last = i;
  }

  const lines = [];
  for (const [minute, bk] of [...buckets.entries()].sort((x, y) => x[0] - y[0])) {
    const avgSpd = fmtNum((bk.spd / bk.n) * 3.6, 1);
    const avgHR = bk.hrN ? Math.round(bk.hr / bk.hrN) : '--';
    const startAlt = num(alts[bk.first]);
    const endAlt = num(alts[bk.last]);
    const dEl = Math.round(endAlt - startAlt);
    const dist = dists[bk.last] ? fmtNum(dists[bk.last] / 1000, 2) : '--';
    const tag = dEl > 3 ? `(+${dEl}m climb)` : (dEl < -3 ? `(${dEl}m desc)` : '(flat)');
    const pw = bk.pwN ? ` | ${Math.round(bk.pw / bk.pwN)}W` : '';
    lines.push(`• Min ${minute} [${dist}km]: ${avgSpd} km/h | HR: ${avgHR} bpm${pw} | Elev: ${Math.round(endAlt)}m ${tag}`);
  }
  return lines.join('\n') || 'No moving samples recorded.';
}

// --------------------------------------------------------
// RECOVERY GAP: end of the previous ride → start of this one
// --------------------------------------------------------
function rideEndTime(w) {
  const dur = num(w.elapsed_sec) || num(w.moving_sec);
  return parseSafeDate(w.date).getTime() + dur * 1000;
}

function recoveryGapMs(prev, cur) {
  return Math.max(0, parseSafeDate(cur.date).getTime() - rideEndTime(prev));
}

// --------------------------------------------------------
// PRIOR COMPARABLE RIDES (delta table)
// --------------------------------------------------------
function comparableKey(w) {
  const it = parseIntent(w);
  return `${w.intent_type || 'NONE'}|${it ? parseZoneTag(it.target_zone) : ''}|${it ? it.format || '' : ''}`;
}

function priorComparable(current, allSorted, max = 5) {
  const prior = allSorted.filter(w => w.date < current.date && w.id !== current.id).reverse();
  const type = current.intent_type || 'NONE';
  const exact = prior.filter(w => comparableKey(w) === comparableKey(current)).slice(0, max);
  if (exact.length) return { rides: exact, basis: getCleanIntentLabel(current) };
  return { rides: prior.filter(w => (w.intent_type || 'NONE') === type).slice(0, max), basis: type === 'NONE' ? 'No intent' : type };
}

function aggregateRides(rides) {
  const timed = rides.filter(w => w.moving_sec > 0);
  const tDist = sumBy(timed, w => w.distance_km);
  const tSec = sumBy(timed, w => w.moving_sec);
  let hrW = 0, hrS = 0;
  for (const w of rides) if (w.avg_hr > 0 && w.moving_sec > 0) { hrW += w.avg_hr * w.moving_sec; hrS += w.moving_sec; }
  return {
    count: rides.length,
    dist: sumBy(rides, w => w.distance_km),
    sec: sumBy(rides, w => w.moving_sec),
    asc: sumBy(rides, w => w.elevation_gain_m),
    work: sumBy(rides, w => w.kilojoules),
    trimp: sumBy(rides, w => w.trimp),
    avgDist: rides.length ? sumBy(rides, w => w.distance_km) / rides.length : 0,
    avgAsc: rides.length ? sumBy(rides, w => w.elevation_gain_m) / rides.length : 0,
    // Duration-weighted speed: same rides in numerator and denominator
    speed: tSec > 0 ? tDist / (tSec / 3600) : (rides.length ? sumBy(rides, w => w.avg_speed_kmh) / rides.length : 0),
    hr: hrS > 0 ? hrW / hrS : 0
  };
}

function sumZones(rides) {
  const z = [0, 0, 0, 0, 0];
  for (const w of rides) if (Array.isArray(w.zone_seconds)) for (let i = 0; i < 5; i++) z[i] += num(w.zone_seconds[i]);
  return z;
}

// --------------------------------------------------------
// TRAINING LOAD MODEL: CTL (42 d), ATL (7 d), TSB = CTL−ATL (yesterday)
// --------------------------------------------------------
function computeLoadSeries(workouts, endDate = new Date()) {
  const withLoad = workouts.filter(w => hasVal(w.trimp) && w.trimp > 0);
  if (!withLoad.length) return null;
  const daily = new Map();
  for (const w of withLoad) {
    const k = String(w.date).slice(0, 10);
    daily.set(k, (daily.get(k) || 0) + num(w.trimp));
  }
  const first = parseSafeDate(String(withLoad.reduce((m, w) => (w.date < m ? w.date : m), withLoad[0].date)).slice(0, 10));
  const end = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
  const out = { dates: [], load: [], ctl: [], atl: [], tsb: [] };
  let ctl = 0, atl = 0;
  for (let d = new Date(first); d <= end; d = addDays(d, 1)) {
    const key = formatLocalDate(d);
    const load = daily.get(key) || 0;
    out.tsb.push(round(ctl - atl, 1));
    ctl += (load - ctl) / 42;
    atl += (load - atl) / 7;
    out.dates.push(key);
    out.load.push(round(load, 1));
    out.ctl.push(round(ctl, 1));
    out.atl.push(round(atl, 1));
  }
  return out;
}

function formStatus(tsb) {
  if (!hasVal(tsb)) return { label: 'No data', tone: 'neu' };
  if (tsb > 15) return { label: 'Very fresh / detraining', tone: 'neu' };
  if (tsb > 5) return { label: 'Fresh', tone: 'pos' };
  if (tsb >= -10) return { label: 'Balanced', tone: 'pos' };
  if (tsb >= -30) return { label: 'Productive fatigue', tone: 'neu' };
  return { label: 'High fatigue — recover', tone: 'neg' };
}

function currentLoadSnapshot(series) {
  if (!series) return null;
  const i = series.dates.length - 1;
  return { ctl: series.ctl[i], atl: series.atl[i], tsb: series.tsb[i], date: series.dates[i] };
}

// --------------------------------------------------------
// WEEK SUMMARY & RECORDS
// --------------------------------------------------------
function ridesBetween(workouts, start, end) {
  const a = start.getTime(), b = end.getTime();
  return workouts.filter(w => { const t = parseSafeDate(w.date).getTime(); return t >= a && t < b; });
}

function weekSummary(workouts, now = new Date()) {
  const thisStart = startOfWeek(now);
  const nextStart = addDays(thisStart, 7);
  const lastStart = addDays(thisStart, -7);
  const cur = aggregateRides(ridesBetween(workouts, thisStart, nextStart));
  const prev = aggregateRides(ridesBetween(workouts, lastStart, thisStart));
  // Consecutive weeks with at least one ride (an empty current week doesn't break the streak yet)
  let streak = 0;
  let ws = cur.count ? thisStart : lastStart;
  while (streak < 520 && ridesBetween(workouts, ws, addDays(ws, 7)).length) {
    streak++;
    ws = addDays(ws, -7);
  }
  return { cur, prev, streak };
}

function weeklyTotals(workouts) {
  const map = new Map();
  for (const w of workouts) {
    const ws = formatLocalDate(startOfWeek(parseSafeDate(w.date)));
    const e = map.get(ws) || { week: ws, dist: 0, sec: 0, asc: 0, trimp: 0, count: 0 };
    e.dist += num(w.distance_km); e.sec += num(w.moving_sec); e.asc += num(w.elevation_gain_m); e.trimp += num(w.trimp); e.count++;
    map.set(ws, e);
  }
  return [...map.values()].sort((a, b) => (a.week < b.week ? -1 : 1));
}

function computeRecords(workouts) {
  if (!workouts.length) return [];
  const best = (arr, fn) => arr.reduce((p, c) => (num(fn(c)) > num(fn(p)) ? c : p), arr[0]);
  const rec = [];
  const longest = best(workouts, w => w.distance_km);
  rec.push({ label: 'Longest ride', icon: 'route', value: `${fmtNum(longest.distance_km, 1)} km`, ride: longest });
  const longTime = best(workouts, w => w.moving_sec);
  rec.push({ label: 'Longest time', icon: 'clock', value: formatHours(longTime.moving_sec), ride: longTime });
  const climb = best(workouts, w => w.elevation_gain_m);
  rec.push({ label: 'Most climbing', icon: 'mountain', value: `${Math.round(num(climb.elevation_gain_m))} m`, ride: climb });
  const fastPool = workouts.filter(w => w.distance_km >= 10);
  if (fastPool.length) {
    const fast = best(fastPool, w => w.avg_speed_kmh);
    rec.push({ label: 'Fastest avg (≥10 km)', icon: 'gauge', value: `${fmtNum(fast.avg_speed_kmh, 1)} km/h`, ride: fast });
  }
  const vamPool = workouts.filter(w => w.climbing_vam > 0);
  if (vamPool.length) {
    const v = best(vamPool, w => w.climbing_vam);
    rec.push({ label: 'Best climbing VAM', icon: 'trend', value: `${v.climbing_vam} m/h`, ride: v });
  }
  const peak = best(workouts, w => w.max_speed_kmh);
  rec.push({ label: 'Top speed', icon: 'zap', value: `${fmtNum(peak.max_speed_kmh, 1)} km/h`, ride: peak });
  const loadPool = workouts.filter(w => w.trimp > 0);
  if (loadPool.length) {
    const l = best(loadPool, w => w.trimp);
    rec.push({ label: 'Hardest session', icon: 'flame', value: `${Math.round(l.trimp)} TRIMP`, ride: l });
  }
  const weeks = weeklyTotals(workouts);
  if (weeks.length) {
    const bw = weeks.reduce((p, c) => (c.dist > p.dist ? c : p), weeks[0]);
    rec.push({ label: 'Biggest week', icon: 'calendar', value: `${fmtNum(bw.dist, 1)} km`, sub: `Week of ${formatNiceDate(bw.week, false)}` });
  }
  return rec;
}

rebuildZones();
