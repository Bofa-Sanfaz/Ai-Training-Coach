'use strict';
// --------------------------------------------------------
// HUAWEI HEALTH — import from Huawei's own data export
// (Huawei Health → Me → account → Privacy Center → Request your data → Health, or
// privacy.consumer.huawei.com/tool → an e-mailed ZIP, AES-encrypted with the password
// chosen when requesting it). Every exercise record becomes a workout with the same
// detail as the Galaxy Watch import: heart-rate stream (zones, load), GPS route,
// speed, cadence/steps, calories and — for pool swims — every length (time, strokes,
// SWOLF). Re-importing a newer export only adds the new sessions.
//
// Format (from the export JSON; cross-checked with the open-source Hitrava converter):
//   record: sportType, startTime (ms UTC), totalTime (ms), timeZone ("+0400"),
//           sportDataSource (2 = added by hand), attribute =
//           "HW_EXT_TRACK_DETAIL@is<sample lines>&&HW_EXT_TRACK_SIMPLIFY@is<summary JSON>"
//   summary JSON: totalDistance (m), totalCalories (cal), wearSportData.swim_pool_length (cm),
//           mSwimSegments [{ mSegmentIndex, mDistance (m), mDuration (s), mSwolf, mPullTimes }]
//   sample lines "tp=<type>;k=<time>;v=<value>": h-r heart rate, s-r step rate (/min),
//           rs speed (dm/s), alt altitude, cad cadence; "tp=lbs;…;lat=;lon=;alt=;t=" GPS.
//   Times: 10 digits = s, 13 = ms, < 1 week = seconds after the start.
// --------------------------------------------------------
const HUAWEI_SPORTS = {
  5: ['walk', 'Walk'], 282: ['walk', 'Hike'], 2: ['walk', 'Mountain hike'],
  4: ['run', 'Run'], 118: ['run', 'Cross-country run'], 101: ['run', 'Indoor run', true],
  3: ['ride', 'Ride'], 103: ['ride', 'Indoor cycle', true],
  102: ['swim', 'Pool swim', true], 104: ['swim', 'Open water swim'],
  111: ['other', 'Cross trainer', true], 145: ['other', 'CrossFit', true], 117: ['other', 'Workout', true]
};
const HUAWEI_SID_OFFSET = 3; // own negative id range (watch import uses -start, screenshots -start-7)
const HUAWEI_STEP = 5;       // seconds per stream point

function huaweiZipReady() {
  return !!(window.zip && zip.ZipReader);
}

// Seconds (epoch) from a Huawei time value; relative values are seconds after the start
function huaweiSec(v, startSec) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 604800) return startSec + n;
  const digits = Math.floor(Math.log10(n)) + 1;
  return digits <= 10 ? n * Math.pow(10, 10 - digits) : n / Math.pow(10, digits - 10);
}

function huaweiOffsetMin(tz) {
  const m = String(tz || '').match(/^([+-])(\d{2}):?(\d{2})$/);
  if (!m) return null;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

// Huawei's JSON sometimes has an object with unquoted keys ("partTimeMap"); drop it before parsing
function huaweiJson(text) {
  try { return JSON.parse(text); } catch (e) { /* fall through */ }
  try { return JSON.parse(String(text).replace(/"partTimeMap"\s*:\s*\{.*?\},?/gs, '')); } catch (e) { return null; }
}

// All activity records in a parsed file, whatever the layout (list, {motionPathData}, nested)
function huaweiRecords(data, out = []) {
  if (Array.isArray(data)) { for (const x of data) huaweiRecords(x, out); return out; }
  if (!data || typeof data !== 'object') return out;
  if ('sportType' in data && 'startTime' in data) { out.push(data); return out; }
  for (const k of ['motionPathData', 'data', 'records', 'list']) if (data[k]) huaweiRecords(data[k], out);
  return out;
}

function huaweiParseAttribute(attr) {
  const s = String(attr || '');
  const i = s.indexOf('&&HW_EXT_TRACK_SIMPLIFY@is');
  const detail = (i >= 0 ? s.slice(0, i) : s).replace('HW_EXT_TRACK_DETAIL@is', '');
  const summary = i >= 0 ? huaweiJson(s.slice(i + '&&HW_EXT_TRACK_SIMPLIFY@is'.length)) : null;
  const lines = detail.includes('\n') ? detail.split(/\r?\n/) : detail.split(/(?=tp=)/);
  const samples = { hr: [], sr: [], rs: [], alt: [], cad: [], gps: [] };
  for (const line of lines) {
    if (!line.startsWith('tp=')) continue;
    const f = {};
    for (const part of line.split(';')) { const j = part.indexOf('='); if (j > 0) f[part.slice(0, j).trim()] = part.slice(j + 1).trim(); }
    const tp = f.tp;
    if (tp === 'lbs') samples.gps.push(f);
    else if (tp === 'h-r') samples.hr.push(f);
    else if (tp === 's-r') samples.sr.push(f);
    else if (tp === 'rs') samples.rs.push(f);
    else if (tp === 'alt' || tp === 'alti') samples.alt.push(f);
    else if (tp === 'cad') samples.cad.push(f);
  }
  return { summary: summary || {}, samples };
}

// Distance in metres between two GPS points
function huaweiMeters(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toR, dLon = (b[1] - a[1]) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toR) * Math.cos(b[0] * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** One Huawei record → { workout, stream } (not saved), or null when unusable */
function huaweiToWorkout(rec) {
  const startMs = Number(rec.startTime);
  const durSec = Math.round(Number(rec.totalTime) / 1000);
  if (!(startMs > 0) || !(durSec > 0)) return null;
  const startSec = startMs / 1000;
  const [sport, label, indoor] = HUAWEI_SPORTS[rec.sportType] || ['other', `Huawei workout ${rec.sportType}`, true];
  const { summary, samples } = huaweiParseAttribute(rec.attribute);
  // Local time of the session from the record's own time zone (falls back to this device's zone)
  let off = huaweiOffsetMin(rec.timeZone || summary.timeZone);
  if (off === null) off = -new Date(startMs).getTimezoneOffset();
  const local = new Date(startMs + off * 60000).toISOString();
  const date = `${local.slice(0, 10)} ${local.slice(11, 16)}`;

  // Samples → relative seconds
  const rel = (list, conv, valid) => list.map(f => {
    const t = huaweiSec(f.k, startSec);
    const v = conv(Number(f.v));
    return t !== null && valid(v) ? { t: Math.round(t - startSec), v } : null;
  }).filter(x => x && x.t >= 0 && x.t <= durSec + 60).sort((a, b) => a.t - b.t);
  const hr = rel(samples.hr, v => v, v => v > 25 && v < 250);
  const sr = rel(samples.sr, v => v, v => v > 0 && v < 400);
  const rs = rel(samples.rs, v => v / 10, v => v >= 0 && v < 40);
  const alt = rel(samples.alt, v => v, v => v > -500 && v < 9000);
  const cad = rel(samples.cad, v => v, v => v > 0 && v < 255);
  const gps = samples.gps.map(f => {
    const lat = Number(f.lat), lon = Number(f.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 90 && lon === -80) || (lat === 0 && lon === 0) || Math.abs(lat) > 90) return null;
    const t = huaweiSec(f.t, startSec);
    return t === null ? null : { t: Math.round(t - startSec), ll: [lat, lon], alt: Number.isFinite(Number(f.alt)) ? Number(f.alt) : null };
  }).filter(x => x && x.t >= 0 && x.t <= durSec + 60).sort((a, b) => a.t - b.t);

  // Distance: summary, else pool segments, else GPS
  const segs = Array.isArray(summary.mSwimSegments) ? summary.mSwimSegments : (Array.isArray(rec.mSwimSegments) ? rec.mSwimSegments : []);
  let distM = Number(summary.totalDistance || rec.totalDistance) || 0;
  if (!distM && segs.length) distM = segs.reduce((s, x) => s + (Number(x.mDistance) || 0), 0);
  if (!distM && gps.length > 1) for (let i = 1; i < gps.length; i++) distM += huaweiMeters(gps[i - 1].ll, gps[i].ll);
  const kcal = Math.round((Number(summary.totalCalories || rec.totalCalories) || 0) / 1000);

  // One 5-second timeline for all channels (what the rest of the app expects)
  const near = (list, t, maxGap) => {
    let lo = 0, hi = list.length - 1, best = null;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (list[mid].t <= t) { best = mid; lo = mid + 1; } else hi = mid - 1; }
    return best !== null && t - list[best].t <= maxGap ? list[best] : null;
  };
  let stream = null;
  if (hr.length > 5 || gps.length > 5 || rs.length > 5) {
    const time = [], hrs = [], ll = [], alts = [], vel = [], cads = [], dist = [];
    let cum = 0, prevLL = null;
    for (let t = 0; t <= durSec; t += HUAWEI_STEP) {
      time.push(t);
      const h = near(hr, t, 20); hrs.push(h ? Math.round(h.v) : null);
      const g = near(gps, t, 15);
      if (g) { if (prevLL) cum += huaweiMeters(prevLL, g.ll); prevLL = g.ll; }
      ll.push(g ? g.ll : null);
      const a = near(alt, t, 30); alts.push(g && g.alt !== null ? g.alt : a ? a.v : null);
      const s = near(rs, t, 15); vel.push(s ? round(s.v, 2) : null);
      const c = near(cad.length ? cad : sr, t, 70); cads.push(c ? Math.round(c.v) : null);
      dist.push(round(cum, 1));
    }
    stream = { time: { data: time } };
    if (hr.length > 5) stream.heartrate = { data: hrs };
    if (gps.length > 5) {
      // GPS distance scaled to Huawei's own total (its track is filtered on the watch)
      const k = cum > 0 && distM > 0 ? distM / cum : 1;
      stream.latlng = { data: ll };
      stream.distance = { data: dist.map(d => round(d * k, 1)) };
    }
    if (alts.some(v => v !== null)) stream.altitude = { data: alts };
    if (rs.length > 5) stream.velocity_smooth = { data: vel };
    if (cad.length + sr.length > 5) stream.cadence = { data: cads };
  }

  const hrv = hr.map(x => x.v);
  const steps = Number(summary.totalSteps || summary.steps || rec.totalSteps) ||
    (sr.length > 1 && (sport === 'walk' || sport === 'run') ? Math.round(sr.reduce((s, x, i) => s + (i ? x.v * (x.t - sr[i - 1].t) / 60 : 0), 0)) : 0);
  const srAvg = sr.length ? Math.round(mean(sr.map(x => x.v))) : 0;
  // Climbing with a 1 m hysteresis (counts real climbs, ignores barometer jitter)
  let elev = 0;
  const altSeries = gps.filter(g => g.alt !== null).map(g => g.alt).concat(gps.length ? [] : alt.map(a => a.v));
  let ref = altSeries.length ? altSeries[0] : 0;
  for (const a of altSeries) {
    if (a - ref >= 1) { elev += a - ref; ref = a; } else if (a < ref) ref = a;
  }

  const sid = -Math.round(startSec) - HUAWEI_SID_OFFSET;
  const w = {
    strava_id: sid, ride_number: 0, exercise_code: '', source: 'huawei', name: label, sport, sport_type: `huawei:${rec.sportType}`,
    indoor: !!indoor, date, distance_km: round(distM / 1000, 3), moving_sec: durSec, elapsed_sec: durSec, duration_str: formatDuration(durSec),
    avg_speed_kmh: distM > 0 ? round((distM / 1000) / (durSec / 3600), 2) : 0, max_speed_kmh: rs.length ? round(Math.max(...rs.map(x => x.v)) * 3.6, 1) : 0,
    avg_hr: hrv.length ? Math.round(mean(hrv)) : (Number(summary.avgHeartRate) || 0), max_hr: hrv.length ? Math.max(...hrv) : (Number(summary.maxHeartRate) || 0),
    elevation_gain_m: indoor ? 0 : Math.round(elev), kilojoules: 0, calories: kcal,
    avg_power_w: 0, max_power_w: 0, norm_power_w: 0, device_watts: false, map_polyline: '',
    source_name: `Huawei Health${Number(rec.sportDataSource) === 2 ? ' (added by hand)' : ''}`, debrief_stale: false, intent_type: null, zone_seconds: [0, 0, 0, 0, 0]
  };
  if (steps > 0) w.steps = steps;
  if ((sport === 'walk' || sport === 'run') && srAvg) w.avg_cadence = srAvg;
  if (sport === 'ride' && cad.length) w.avg_cadence = Math.round(mean(cad.map(x => x.v)));

  // Pool swim: every length, as the watch import does (a segment longer than the pool is split evenly)
  if (sport === 'swim' && segs.length) {
    const pool = (Number(summary.wearSportData && summary.wearSportData.swim_pool_length) || 0) / 100 ||
      Math.min(...segs.map(x => Number(x.mDistance)).filter(x => x > 0)) || 25;
    const laps = [];
    for (const sg of segs.slice().sort((a, b) => (a.mSegmentIndex || 0) - (b.mSegmentIndex || 0))) {
      const d = Number(sg.mDistance) || pool, sec = Number(sg.mDuration) || 0, strokes = Number(sg.mPullTimes) || 0;
      const n = Math.max(1, Math.round(d / pool));
      for (let i = 0; i < n; i++) laps.push({ sec: sec / n, strokes: Math.round(strokes / n), style: 'FREESTYLE' });
    }
    const sw = buildSwimDetail({ poolLength: pool, laps }, durSec);
    if (sw) w.swim = sw;
  }
  return { workout: w, stream };
}

// Read every exercise record out of the export ZIP (or a JSON file picked directly)
async function huaweiReadExport(file, password) {
  if (/\.json$/i.test(file.name)) return huaweiRecords(huaweiJson(await file.text()));
  if (!huaweiZipReady()) throw new Error('ZIP support did not load');
  zip.configure({ useWebWorkers: false });
  const reader = new zip.ZipReader(new zip.BlobReader(file), password ? { password } : {});
  try {
    const entries = await reader.getEntries();
    const files = entries.filter(e => !e.directory && /\.json$/i.test(e.filename) && /motion ?path/i.test(e.filename));
    if (!files.length) {
      const names = entries.slice(0, 8).map(e => e.filename).join(', ');
      throw new Error(`no workout files in this ZIP (is it the Health export?)${names ? ` — found: ${names}` : ''}`);
    }
    const out = [];
    for (const e of files) {
      let text;
      try { text = await e.getData(new zip.TextWriter()); } catch (err) {
        if (/password|encrypt/i.test(err.message)) throw new Error(password ? 'wrong password for this ZIP' : 'this ZIP needs the password you chose when requesting the data');
        throw err;
      }
      huaweiRecords(huaweiJson(text), out);
    }
    return out;
  } finally { await reader.close(); }
}

/** Import an export; returns { found, added, skipped, bySport } */
async function importHuaweiExport(file, password, onProgress) {
  const recs = await huaweiReadExport(file, password);
  const all = await db.workouts.toArray();
  const deleted = await deletedWorkoutIds();
  const res = { found: recs.length, added: 0, skipped: 0, old: 0, bySport: {} };
  // Newest first is irrelevant for correctness; oldest first keeps numbering natural
  recs.sort((a, b) => Number(a.startTime) - Number(b.startTime));
  let i = 0;
  for (const rec of recs) {
    i++;
    if (onProgress && i % 10 === 0) onProgress(i, recs.length);
    const parsed = huaweiToWorkout(rec);
    if (!parsed) { res.skipped++; continue; }
    const { workout: w, stream } = parsed;
    if (w.date.slice(0, 10) < MIN_WORKOUT_DATE) { res.old++; continue; }
    if (all.some(x => Number(x.strava_id) === w.strava_id) || deleted.has(w.strava_id) || findSameWorkout(all, Number(rec.startTime), w.moving_sec)) { res.skipped++; continue; }
    w.id = await db.workouts.add(w);
    await db.streams.put({ strava_id: w.strava_id, stream_data: stream });
    await ensureRideMetrics(w, stream, true);
    all.push(w);
    res.added++;
    res.bySport[w.sport] = (res.bySport[w.sport] || 0) + 1;
  }
  if (res.added) await renumberRides();
  await setConfig('huawei_last_import', new Date().toISOString());
  return res;
}

// After any import: reminder off, the squad baseline from the real history, everything refreshed
async function huaweiImportDone(r) {
  await setConfig('huawei_import_pending', '0');
  if (r.added) {
    if (typeof afterWorkoutsChanged === 'function') await afterWorkoutsChanged(null);
    if (typeof squadRefreshBaselines === 'function') await squadRefreshBaselines();
    if (typeof Squad !== 'undefined' && Squad.list.length) { Squad.lastShare = 0; squadTick(true); }
  }
  renderHuaweiReminder();
}

// Training screen card while the Huawei history is still to be imported (skipped in the intro)
async function renderHuaweiReminder() {
  const host = $('#huaweiReminder');
  if (!host) return;
  if ((await getConfig('huawei_import_pending')) !== '1') { host.innerHTML = ''; return; }
  host.innerHTML = `<div class="card hw-reminder">
    <div class="row" style="gap:10px; align-items:flex-start">${icon('download')}<div class="grow">
      <b>Import your Huawei history</b>
      <div class="small muted">When Huawei's e-mail arrives: download the ZIP, then import it here — your past sessions, heart rate and pool lengths.</div>
      <div class="btn-row mt-8"><button class="btn btn-primary btn-sm" onclick="openHuaweiImport()">Import now</button><button class="btn btn-ghost btn-sm" onclick="setConfig('huawei_import_pending', '0').then(renderHuaweiReminder)">Not needed</button></div>
    </div></div></div>`;
}

// ---------- UI ----------
async function openHuaweiImport() {
  $('#hw_pw').value = (await getConfig('huawei_zip_pw')) || '';
  $('#hw_file').value = '';
  $('#hw_status').textContent = '';
  const last = await getConfig('huawei_last_import');
  $('#hw_last').textContent = last ? `Last import: ${formatNiceDate(last.slice(0, 10), false)}` : 'No Huawei import yet.';
  openSheet('huaweiSheet');
}

async function runHuaweiImport() {
  const file = $('#hw_file').files && $('#hw_file').files[0];
  if (!file) { toast('Pick the ZIP from the Huawei e-mail first', 'warn'); return; }
  const pw = $('#hw_pw').value;
  const btn = $('#hwImportBtn');
  const status = $('#hw_status');
  setBusy(btn, true, 'Reading…');
  status.textContent = 'Opening the export…';
  try {
    const r = await importHuaweiExport(file, pw, (i, n) => { status.textContent = `Reading session ${i} of ${n}…`; });
    if ($('#hw_remember').checked) await setConfig('huawei_zip_pw', pw); else await setConfig('huawei_zip_pw', '');
    const parts = Object.entries(r.bySport).map(([s, n]) => `${n} ${n === 1 ? SPORTS[s].label.toLowerCase() : SPORTS[s].plural.toLowerCase()}`);
    status.textContent = r.added
      ? `✓ Added ${r.added} session${r.added === 1 ? '' : 's'} (${parts.join(', ')}). ${r.skipped ? `${r.skipped} already here.` : ''}`
      : `Nothing new: ${r.found} sessions in the export${r.skipped ? `, ${r.skipped} already here` : ''}${r.old ? `, ${r.old} from before ${MIN_WORKOUT_DATE.slice(0, 4)}` : ''}.`;
    haptic(r.added ? 'success' : 'light');
    if (r.added) toast(`Huawei: ${r.added} session${r.added === 1 ? '' : 's'} added`, 'success');
    await huaweiImportDone(r);
  } catch (e) {
    console.error(e);
    status.textContent = `Could not import: ${e.message}`;
    toast(`Huawei import: ${e.message}`, 'error', 5000);
  } finally { setBusy(btn, false); }
}
