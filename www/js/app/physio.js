'use strict';
// --------------------------------------------------------
// PHYSIOLOGY ENGINE
// Zones, per-ride metrics, training load (TRIMP → fitness /
// fatigue / form), comparisons and records.
// --------------------------------------------------------

// Bump when a calculation changes so stored ride metrics are recomputed automatically.
const METRICS_VERSION = 'm3.1';

// Best-effort windows. Power curves use real power-meter data only (no app-side power estimate).
const BEST_DURATIONS = [5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600];
const BEST_LABELS = { 5: '5s', 15: '15s', 30: '30s', 60: '1m', 120: '2m', 300: '5m', 600: '10m', 1200: '20m', 1800: '30m', 3600: '60m' };

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
  ftp_user: 0,
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
  PHYSIO.ftp_user = num(await getConfig('ftp_w'), 0);
  rebuildZones();

  ATHLETE.name = (await getConfig('athlete_name')) || 'Mustafa';
  ATHLETE.bike = (await getConfig('bike_name')) || 'Kron XC150 Mountain Bike';
  ATHLETE.height = (await getConfig('athlete_height')) || '';
}

// Anything that changes stored ride metrics is part of the signature → stale rides get recomputed
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
// Resample a stream to 1 Hz (sample-and-hold); gaps > 10 s become 0 (or null with keepGaps)
function to1Hz(times, vals, keepGaps = false) {
  const last = Math.min(num(times[times.length - 1]), 12 * 3600);
  const out = new Array(Math.max(1, Math.floor(last) + 1)).fill(keepGaps ? null : 0);
  for (let i = 1; i < times.length; i++) {
    const t0 = Math.floor(num(times[i - 1])), t1 = Math.min(Math.floor(num(times[i])), out.length - 1);
    const gap = t1 - t0 > 10;
    const v = Number.isFinite(vals[i]) ? vals[i] : (keepGaps ? null : 0);
    for (let t = t0 + 1; t <= t1; t++) out[t] = gap ? (keepGaps ? null : 0) : v;
  }
  if (times.length) out[0] = Number.isFinite(vals[0]) ? vals[0] : out[0];
  return out;
}

// Best (maximal) average for each window length, sliding over a 1 Hz series; nulls break a window
function bestAverages(arr, durations, decimals) {
  const res = {};
  for (const d of durations) {
    if (arr.length < d) continue;
    let sum = 0, valid = 0, best = -Infinity;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v !== null && v !== undefined) { sum += v; valid++; }
      if (i >= d) {
        const o = arr[i - d];
        if (o !== null && o !== undefined) { sum -= o; valid--; }
      }
      if (i >= d - 1 && valid === d) best = Math.max(best, sum / d);
    }
    if (best > -Infinity) res[d] = round(best, decimals);
  }
  return Object.keys(res).length ? res : null;
}

// Coggan normalized power: 30 s rolling mean → ^4 → mean → ^¼ (as in GoldenCheetah)
function normalizedPower(p1Hz) {
  if (p1Hz.length < 60) return null;
  let sum = 0, total = 0, count = 0;
  for (let i = 0; i < p1Hz.length; i++) {
    sum += p1Hz[i];
    if (i >= 30) sum -= p1Hz[i - 30];
    if (i >= 29) { total += Math.pow(sum / 30, 4); count++; }
  }
  return count ? Math.round(Math.pow(total / count, 0.25)) : null;
}

// FTP: the value set in Profile, else 95% of the best measured 20-min power of the last 120 days
function currentFtp(workouts) {
  if (PHYSIO.ftp_user > 0) return { w: PHYSIO.ftp_user, source: 'set' };
  const cutoff = Date.now() - 120 * 86400000;
  let best = 0;
  for (const w of workouts) {
    const v = w.mmp && w.mmp[1200];
    if (v && w.power_source === 'meter' && parseSafeDate(w.date).getTime() >= cutoff && v > best) best = v;
  }
  return best ? { w: Math.round(best * 0.95), source: 'auto' } : null;
}

function rideStress(w, ftp) {
  if (!ftp || !(w.np_w > 0) || !(w.moving_sec > 0)) return null;
  const IF = w.np_w / ftp.w;
  return { IF: round(IF, 2), TSS: Math.round((w.moving_sec / 3600) * IF * IF * 100) };
}

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
    power_source: null,
    np_w: null,
    mmp: null,
    best_spd: null,
    best_hr: null,
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

  // 3) Measured power only (power meter): NP and power best efforts; speed & HR best efforts for every ride
  try {
    if (watts) {
      const pw = watts.map(num);
      const pw1 = to1Hz(times, pw);
      out.power_source = 'meter';
      out.np_w = normalizedPower(pw1);
      out.mmp = bestAverages(pw1, BEST_DURATIONS, 0);
    }
    if (spds.length) out.best_spd = bestAverages(to1Hz(times, spds.map(v => num(v) * 3.6)), [60, 300, 1200, 3600], 1);
    if (hrs) out.best_hr = bestAverages(to1Hz(times, hrs.map(num), true), [60, 300, 1200, 3600], 0);
  } catch (e) {
    console.warn('Power/best-effort calc failed', e);
  }

  // 4) Halves profile & aerobic decoupling on moving time (first 12 min of moving time skipped)
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
async function build1MinuteTelemetryTimeline(stravaId, stepMin = 1) {
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

  const w = await db.workouts.where('strava_id').equals(Number(stravaId)).first();
  const flagSpd = w && isFlagged(w, 'distance'), flagHr = w && isFlagged(w, 'hr'), flagEl = w && isFlagged(w, 'elevation');
  const sport = { sport: w ? sportOf(w) : 'ride' };
  const buckets = new Map();
  for (let i = 0; i < times.length; i++) {
    if (moving && moving[i] === false) continue;
    const minute = Math.floor(times[i] / (60 * stepMin)) * stepMin + 1;
    let bk = buckets.get(minute);
    if (!bk) { bk = { spd: 0, n: 0, maxSpd: 0, hr: 0, hrN: 0, maxHr: 0, pw: 0, pwN: 0, maxPw: 0, first: i, last: i }; buckets.set(minute, bk); }
    const v = num(speeds[i]);
    bk.spd += v; bk.n++;
    if (v > bk.maxSpd) bk.maxSpd = v;
    if (hrs[i] > 0) { bk.hr += hrs[i]; bk.hrN++; if (hrs[i] > bk.maxHr) bk.maxHr = hrs[i]; }
    if (watts[i] > 0) { bk.pw += watts[i]; bk.pwN++; if (watts[i] > bk.maxPw) bk.maxPw = watts[i]; }
    bk.last = i;
  }

  // Averages hide surges, so every line also carries the peak inside that minute
  const lines = [];
  for (const [minute, bk] of [...buckets.entries()].sort((x, y) => x[0] - y[0])) {
    const avgSpd = bk.n ? (bk.spd / bk.n) * 3.6 : 0;
    const spd = flagSpd || !speeds.length ? '' : sport.sport === 'ride'
      ? `${fmtNum(avgSpd, 1)} km/h (peak ${fmtNum(bk.maxSpd * 3.6, 1)})`
      : `${speedText(sport, avgSpd)} (best ${speedText(sport, bk.maxSpd * 3.6)})`;
    const hr = flagHr || !bk.hrN ? '' : `HR ${Math.round(bk.hr / bk.hrN)} (peak ${bk.maxHr})`;
    const startAlt = num(alts[bk.first]);
    const endAlt = num(alts[bk.last]);
    const dEl = Math.round(endAlt - startAlt);
    const dist = !flagSpd && dists[bk.last] ? `[${fmtNum(dists[bk.last] / 1000, 2)}km] ` : '';
    const tag = dEl > 3 ? `+${dEl}m climb` : (dEl < -3 ? `${dEl}m desc` : 'flat');
    const el = flagEl || !alts.length ? '' : `Elev ${Math.round(endAlt)}m ${tag}`;
    const pw = bk.pwN ? `${Math.round(bk.pw / bk.pwN)}W (peak ${Math.round(bk.maxPw)})` : '';
    lines.push(`• Min ${minute} ${dist}${[spd, hr, pw, el].filter(Boolean).join(' | ')}`);
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
  const prior = allSorted.filter(w => w.date < current.date && w.id !== current.id && sportOf(w) === sportOf(current) && !isExcluded(w)).reverse();
  const type = current.intent_type || 'NONE';
  const exact = prior.filter(w => comparableKey(w) === comparableKey(current)).slice(0, max);
  if (exact.length) return { rides: exact, basis: getCleanIntentLabel(current) };
  return { rides: prior.filter(w => (w.intent_type || 'NONE') === type).slice(0, max), basis: type === 'NONE' ? 'No intent' : type };
}

// Totals for a set of workouts. Excluded workouts are ignored and flagged values
// (data errors) are left out. Speed is only meaningful within one sport, so it is
// computed from the most common sport in the set; bySport has per-sport totals.
function aggregateRides(rides) {
  rides = rides.filter(w => !isExcluded(w));
  const sports = {};
  for (const w of rides) {
    const s = sportOf(w);
    const e = sports[s] = sports[s] || { count: 0, dist: 0, sec: 0, asc: 0, trimp: 0 };
    e.count++; e.dist += num(mv(w, 'distance_km')); e.sec += num(w.moving_sec); e.asc += num(mv(w, 'elevation_gain_m')); e.trimp += num(mv(w, 'trimp'));
  }
  const main = Object.keys(sports).sort((a, b) => sports[b].sec - sports[a].sec)[0] || 'ride';
  const timed = rides.filter(w => w.moving_sec > 0 && sportOf(w) === main && hasVal(mv(w, 'distance_km')));
  const tDist = sumBy(timed, w => w.distance_km);
  const tSec = sumBy(timed, w => w.moving_sec);
  let hrW = 0, hrS = 0;
  for (const w of rides) if (mv(w, 'avg_hr') > 0 && w.moving_sec > 0) { hrW += w.avg_hr * w.moving_sec; hrS += w.moving_sec; }
  return {
    count: rides.length,
    dist: sumBy(rides, w => mv(w, 'distance_km')),
    sec: sumBy(rides, w => w.moving_sec),
    asc: sumBy(rides, w => mv(w, 'elevation_gain_m')),
    work: sumBy(rides, w => mv(w, 'kilojoules')),
    trimp: sumBy(rides, w => mv(w, 'trimp')),
    avgDist: rides.length ? sumBy(rides, w => mv(w, 'distance_km')) / rides.length : 0,
    avgAsc: rides.length ? sumBy(rides, w => mv(w, 'elevation_gain_m')) / rides.length : 0,
    // Duration-weighted speed: same rides in numerator and denominator
    speed: tSec > 0 ? tDist / (tSec / 3600) : 0,
    speedSport: main,
    hr: hrS > 0 ? hrW / hrS : 0,
    bySport: sports
  };
}

function sumZones(rides) {
  const z = [0, 0, 0, 0, 0];
  for (const w of rides) { const zs = mv(w, 'zone_seconds'); if (Array.isArray(zs)) for (let i = 0; i < 5; i++) z[i] += num(zs[i]); }
  return z;
}

// --------------------------------------------------------
// TRAINING LOAD MODEL: CTL (42 d), ATL (7 d), TSB = CTL−ATL (yesterday)
// --------------------------------------------------------
function computeLoadSeries(workouts, endDate = new Date()) {
  const withLoad = workouts.filter(w => hasVal(mv(w, 'trimp')) && w.trimp > 0);
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
    if (isExcluded(w)) continue;
    const ws = formatLocalDate(startOfWeek(parseSafeDate(w.date)));
    const e = map.get(ws) || { week: ws, dist: 0, sec: 0, asc: 0, trimp: 0, count: 0, sports: {} };
    e.dist += num(mv(w, 'distance_km')); e.sec += num(w.moving_sec); e.asc += num(mv(w, 'elevation_gain_m')); e.trimp += num(mv(w, 'trimp')); e.count++;
    const sp = sportOf(w);
    const s = e.sports[sp] = e.sports[sp] || { count: 0, dist: 0, sec: 0, trimp: 0 };
    s.count++; s.dist += num(mv(w, 'distance_km')); s.sec += num(w.moving_sec); s.trimp += num(mv(w, 'trimp'));
    map.set(ws, e);
  }
  return [...map.values()].sort((a, b) => (a.week < b.week ? -1 : 1));
}

// Records per sport. Flagged values (marked as data errors) and excluded workouts never count.
// Each record carries `field` so the UI can offer "mark as data error" on it.
function computeRecords(workouts, sport = 'ride') {
  const pool = workouts.filter(w => sportOf(w) === sport && !isExcluded(w));
  if (!pool.length) return [];
  const best = (fn, arr = pool) => { const ok = arr.filter(w => num(fn(w)) > 0); return ok.length ? ok.reduce((p, c) => (num(fn(c)) > num(fn(p)) ? c : p), ok[0]) : null; };
  const label = SPORTS[sport].label.toLowerCase();
  const rec = [];
  const add = (r, w) => { if (w) rec.push(Object.assign({ ride: w }, r)); };
  const longest = best(w => mv(w, 'distance_km'));
  if (longest) add({ label: `Longest ${label}`, icon: 'route', value: distText(longest), field: 'distance' }, longest);
  const longTime = best(w => w.moving_sec);
  if (longTime) add({ label: 'Longest time', icon: 'clock', value: formatHours(longTime.moving_sec) }, longTime);
  if (sport === 'ride' || sport === 'run') {
    const climb = best(w => mv(w, 'elevation_gain_m'));
    if (climb) add({ label: 'Most climbing', icon: 'mountain', value: `${Math.round(num(climb.elevation_gain_m))} m`, field: 'elevation' }, climb);
  }
  const minDist = { ride: 10, run: 3, swim: 0.4 }[sport];
  const fast = minDist ? best(w => mv(w, 'avg_speed_kmh'), pool.filter(w => num(mv(w, 'distance_km')) >= minDist)) : null;
  if (fast) add({ label: `${sport === 'ride' ? 'Fastest avg' : 'Best avg pace'} (≥${sport === 'swim' ? `${minDist * 1000} m` : `${minDist} km`})`, icon: 'gauge', value: speedText(fast), field: 'distance' }, fast);
  if (sport === 'ride' || sport === 'run') {
    const v = best(w => mv(w, 'climbing_vam'));
    if (v) add({ label: 'Best climbing VAM', icon: 'trend', value: `${v.climbing_vam} m/h`, field: 'elevation' }, v);
  }
  if (sport === 'ride') {
    const peak = best(w => mv(w, 'max_speed_kmh'));
    if (peak) add({ label: 'Top speed', icon: 'zap', value: `${fmtNum(peak.max_speed_kmh, 1)} km/h`, field: 'distance' }, peak);
  }
  const l = best(w => mv(w, 'trimp'));
  if (l) add({ label: 'Hardest session', icon: 'flame', value: `${Math.round(l.trimp)} TRIMP`, field: 'hr' }, l);
  const weeks = weeklyTotals(pool);
  if (weeks.length) {
    const bw = weeks.reduce((p, c) => (c.dist > p.dist ? c : p), weeks[0]);
    rec.push({ label: 'Biggest week', icon: 'calendar', value: sport === 'swim' ? `${Math.round(bw.dist * 1000)} m` : `${fmtNum(bw.dist, 1)} km`, sub: `Week of ${formatNiceDate(bw.week, false)}` });
  }
  return rec;
}

rebuildZones();
