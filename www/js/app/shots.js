'use strict';
// --------------------------------------------------------
// WORKOUTS FROM SCREENSHOTS (the friend's web app: Huawei Health has no open data path)
// The person picks all the screens of one or several workouts (summary, heart-rate chart,
// pace chart, splits, pool lengths, zone times). One AI call groups them per workout and
// reads every number, every table row and the chart curves. Then:
//   checks  — cross-checks that point at misread values (splits vs duration, lengths vs
//             distance, chart vs average heart rate…), shown on the approval screen;
//   stream  — the chart curves become a 10-s stream (heart rate, speed, distance,
//             altitude, cadence) so zones, load, charts, splits and the coaches work as
//             for any watch workout (marked as read from a screenshot);
//   swim    — the length table becomes the per-length swim model (SWOLF, best 100 m…).
// Nothing is saved until the person approves (and edits) it.
// --------------------------------------------------------
const SHOT_MAX_IMAGES = 8;
const SHOT_PROMPT_V2 = `You read screenshots from a fitness app (usually Huawei Health; also Apple Fitness, Samsung Health, Strava, Garmin).
The images (numbered from 0) may show one or several workouts. Several images can belong to the SAME workout (summary, heart-rate chart, pace chart, splits or lengths table, heart-rate zone times). Group them by workout (same date, time and type).

Rules:
- Copy numbers exactly as shown. Never invent a value: use null when it is not visible.
- Units: distances in metres; durations in seconds (1:02:03 = h:mm:ss, 25:13 = mm:ss); pace 7'45" or 7:45 /km = 465 s per km; swim pace per 100 m in seconds; calories in kcal.
- Charts: read the curve at regular points along the time axis (about one point per minute, at most 120) using the axis labels; be as precise as the chart allows.
- Tables: copy every row in order.
Return JSON only:
{"workouts":[{"screens":[image numbers used],
"sport":"walk|run|swim|ride|other","type":"name as shown, e.g. Outdoor walk, Indoor run, Pool swim, Strength","date":"YYYY-MM-DD or null","start_time":"HH:MM or null",
"dur_s":number,"moving_s":number|null,"dist_m":number|null,"calories":number|null,
"avg_hr":number|null,"max_hr":number|null,"min_hr":number|null,
"steps":number|null,"cadence":number|null,"max_cadence":number|null,"stride_cm":number|null,
"pace_km_s":number|null,"best_pace_km_s":number|null,"speed_kmh":number|null,"max_speed_kmh":number|null,
"elev_gain_m":number|null,"elev_loss_m":number|null,
"pool_m":number|null,"swolf":number|null,"strokes":number|null,"stroke_rate":number|null,"main_stroke":"free|breast|back|fly|mixed|null",
"training_effect":number|null,"training_load":number|null,"recovery_h":number|null,"vo2max":number|null,
"hr_zones":[{"name":"as shown","from_bpm":number|null,"to_bpm":number|null,"sec":number}],
"splits":[{"km":number,"sec":number,"avg_hr":number|null,"pace_s":number|null}],
"laps":[{"n":number,"dist_m":number|null,"sec":number,"strokes":number|null,"swolf":number|null,"stroke":"free|breast|back|fly|kick|mixed|null"}],
"hr_curve":[{"t_s":number,"bpm":number}],"pace_curve":[{"t_s":number,"pace_s_per_km":number}],
"elev_curve":[{"t_s":number,"m":number}],"cadence_curve":[{"t_s":number,"spm":number}],
"notes":"anything else useful that is visible, short"}]}`;

function shotParse(text) {
  const t = String(text || '').replace(/```(?:json)?/g, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { return null; }
}

const shotNum = v => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(+v) ? +v : null);
const shotPts = (list, tk, vk, lo, hi) => (Array.isArray(list) ? list : [])
  .map(p => ({ t: shotNum(p && p[tk]), v: shotNum(p && p[vk]) }))
  .filter(p => p.t !== null && p.v !== null && p.t >= 0 && p.v >= lo && p.v <= hi)
  .sort((a, b) => a.t - b.t);

// Images → [workout drafts] (own AI key first; the squad's Aether as fallback)
async function readShots(images) {
  let data = null;
  if (typeof squadPersonalAiReady === 'function' && squadPersonalAiReady()) {
    data = shotParse(await callAI(SHOT_PROMPT_V2, images, { json: true, maxTokens: 16000 }));
  }
  if (!data && typeof squadSquadAiReady === 'function' && squadSquadAiReady()) {
    const r = await squadCall(squadEntry(Squad.cur), 'POST', '/ai/extract', { images }, 180000);
    data = r && r.result;
  }
  const list = data && Array.isArray(data.workouts) ? data.workouts : data && data.sport ? [data] : [];
  if (!list.length) throw new Error('the AI could not read a workout from these images');
  return list.map(w => Object.assign({}, w, {
    images: (Array.isArray(w.screens) ? w.screens : []).map(i => images[i]).filter(Boolean),
    image: images[(Array.isArray(w.screens) && w.screens[0]) || 0]
  }));
}

// Cross-checks that point at misread values
function shotChecks(w) {
  const out = [];
  const dur = shotNum(w.moving_s) || shotNum(w.dur_s);
  const pct = (a, b) => Math.abs(a - b) / Math.max(1, b);
  const splits = (w.splits || []).filter(s => shotNum(s.sec));
  if (splits.length > 1 && dur) {
    const tot = splits.reduce((s, x) => s + shotNum(x.sec), 0);
    if (pct(tot, dur) > 0.04) out.push(`Splits add up to ${formatDuration(tot)}, the duration says ${formatDuration(dur)}.`);
  }
  if (splits.length && shotNum(w.dist_m)) {
    const km = shotNum(w.dist_m) / 1000;
    if (Math.abs(Math.ceil(km - 0.001) - splits.length) > 1) out.push(`${splits.length} splits for ${fmtNum(km, 2)} km.`);
  }
  const laps = (w.laps || []).filter(l => shotNum(l.sec));
  if (laps.length && shotNum(w.pool_m) && shotNum(w.dist_m)) {
    const d = laps.reduce((s, l) => s + (shotNum(l.dist_m) || shotNum(w.pool_m)), 0);
    if (pct(d, shotNum(w.dist_m)) > 0.05) out.push(`The lengths add up to ${Math.round(d)} m, the distance says ${Math.round(shotNum(w.dist_m))} m.`);
  }
  if (laps.length && dur) {
    const s = laps.reduce((a, l) => a + shotNum(l.sec), 0);
    if (s > dur * 1.05) out.push(`The lengths take ${formatDuration(s)} — longer than the session (${formatDuration(dur)}).`);
  }
  const avg = shotNum(w.avg_hr), max = shotNum(w.max_hr), min = shotNum(w.min_hr);
  if (avg && max && avg > max) out.push(`Average heart rate ${avg} is above the maximum ${max}.`);
  if (avg && min && avg < min) out.push(`Average heart rate ${avg} is below the minimum ${min}.`);
  const hr = shotPts(w.hr_curve, 't_s', 'bpm', 30, 240);
  if (hr.length > 4 && avg) {
    const m = mean(hr.map(p => p.v));
    if (Math.abs(m - avg) > 8) out.push(`The heart-rate graph averages ${Math.round(m)} bpm, the summary says ${avg} — the graph may be misread (you can leave it out).`);
  }
  if (shotNum(w.pace_km_s) && shotNum(w.dist_m) && dur && w.sport !== 'swim') {
    const p = dur / (shotNum(w.dist_m) / 1000);
    if (pct(p, shotNum(w.pace_km_s)) > 0.06) out.push(`Pace ${fmtPace(shotNum(w.pace_km_s))} /km doesn't match ${fmtNum(shotNum(w.dist_m) / 1000, 2)} km in ${formatDuration(dur)} (${fmtPace(p)} /km).`);
  }
  const zones = (w.hr_zones || []).filter(z => shotNum(z.sec));
  if (zones.length && dur) {
    const s = zones.reduce((a, z) => a + shotNum(z.sec), 0);
    if (s > dur * 1.05) out.push(`Zone times add up to ${formatDuration(s)}, more than the session.`);
  }
  return out;
}

// Linear interpolation of chart points onto a time
function shotAt(pts, t) {
  if (!pts.length || t < pts[0].t - 90 || t > pts[pts.length - 1].t + 90) return null;
  if (t <= pts[0].t) return pts[0].v;
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i].t) { const a = pts[i - 1], b = pts[i]; return a.v + (b.v - a.v) * ((t - a.t) / Math.max(1, b.t - a.t)); }
  }
  return pts[pts.length - 1].v;
}

// Chart curves (and splits) → a 10-s stream like a watch's
function shotStream(w, use, durSec, distM) {
  const STEP = 10;
  const hr = use.hr ? shotPts(w.hr_curve, 't_s', 'bpm', 30, 240) : [];
  const pace = use.pace ? shotPts(w.pace_curve, 't_s', 'pace_s_per_km', 90, 3600) : [];
  const elev = use.pace ? shotPts(w.elev_curve, 't_s', 'm', -400, 8000) : [];
  const cad = use.pace ? shotPts(w.cadence_curve, 't_s', 'spm', 10, 260) : [];
  // Speed from the pace chart, else from the splits (constant within each km)
  let speedAt = null;
  if (pace.length > 3) speedAt = t => { const p = shotAt(pace, t); return p ? 1000 / p : null; };
  else if (use.splits && (w.splits || []).length) {
    const segs = []; let t0 = 0, km0 = 0;
    for (const s of w.splits) {
      const sec = shotNum(s.sec), km = shotNum(s.km);
      if (!sec) continue;
      const len = km && km > km0 ? (km - km0) * 1000 : 1000;
      segs.push({ from: t0, to: t0 + sec, v: len / sec });
      t0 += sec; km0 = km && km > km0 ? km : km0 + 1;
    }
    if (segs.length) speedAt = t => { const s = segs.find(x => t >= x.from && t < x.to) || segs[segs.length - 1]; return s.v; };
  }
  if (hr.length < 4 && !speedAt && elev.length < 4) return null;
  const time = [], hrs = [], vel = [], dist = [], alts = [], cads = [];
  let cum = 0;
  for (let t = 0; t <= durSec; t += STEP) {
    time.push(t);
    const h = hr.length > 3 ? shotAt(hr, t) : null; hrs.push(h ? Math.round(h) : null);
    const v = speedAt ? speedAt(t) : null; vel.push(v ? round(v, 2) : null);
    if (v) cum += v * STEP;
    dist.push(round(cum, 1));
    const a = elev.length > 3 ? shotAt(elev, t) : null; alts.push(a !== null ? round(a, 1) : null);
    const c = cad.length > 3 ? shotAt(cad, t) : null; cads.push(c ? Math.round(c) : null);
  }
  const s = { time: { data: time } };
  if (hr.length > 3) s.heartrate = { data: hrs };
  if (speedAt) {
    const k = distM > 0 && cum > 0 ? distM / cum : 1; // scaled to the summary's distance
    s.velocity_smooth = { data: vel.map(v => (v === null ? null : round(v * k, 2))) };
    s.distance = { data: dist.map(d => round(d * k, 1)) };
  }
  if (alts.some(a => a !== null)) s.altitude = { data: alts };
  if (cads.some(c => c !== null)) s.cadence = { data: cads };
  return s;
}

// What the approval screen can include (defaults: everything that was read)
function shotUseDefaults(w) {
  return {
    hr: shotPts(w.hr_curve, 't_s', 'bpm', 30, 240).length > 3,
    pace: shotPts(w.pace_curve, 't_s', 'pace_s_per_km', 90, 3600).length > 3 || shotPts(w.elev_curve, 't_s', 'm', -400, 8000).length > 3,
    splits: (w.splits || []).length > 0,
    laps: (w.laps || []).length > 0,
    zones: (w.hr_zones || []).length > 0
  };
}

function shotDetailHtml(w) {
  const use = w.use || (w.use = shotUseDefaults(w));
  const checks = shotChecks(w);
  const tog = (k, label) => `<label class="sq-check"><input type="checkbox" ${use[k] ? 'checked' : ''} onchange="Squad.importDraft.use.${k} = this.checked; shotRenderChart()" /><span>${label}</span></label>`;
  const hrN = shotPts(w.hr_curve, 't_s', 'bpm', 30, 240).length, paceN = shotPts(w.pace_curve, 't_s', 'pace_s_per_km', 90, 3600).length;
  const extra = [
    shotNum(w.min_hr) ? `min HR ${w.min_hr}` : '', shotNum(w.max_cadence) ? `max cadence ${w.max_cadence}` : '', shotNum(w.stride_cm) ? `stride ${w.stride_cm} cm` : '',
    shotNum(w.best_pace_km_s) ? `best pace ${fmtPace(w.best_pace_km_s)} /km` : '', shotNum(w.elev_loss_m) ? `descent ${w.elev_loss_m} m` : '',
    shotNum(w.training_effect) ? `training effect ${w.training_effect}` : '', shotNum(w.training_load) ? `training load ${w.training_load}` : '',
    shotNum(w.recovery_h) ? `recovery ${w.recovery_h} h` : '', shotNum(w.vo2max) ? `VO2max ${w.vo2max}` : '', shotNum(w.stroke_rate) ? `stroke rate ${w.stroke_rate}/min` : ''
  ].filter(Boolean);
  const splits = (w.splits || []).filter(s => shotNum(s.sec));
  const laps = (w.laps || []).filter(l => shotNum(l.sec));
  const zones = (w.hr_zones || []).filter(z => shotNum(z.sec));
  return `${checks.length ? `<div class="shot-checks">${icon('alert', 'ic-sm')}<div><b>Please check</b>${checks.map(c => `<div>${escapeHtml(c)}</div>`).join('')}</div></div>` : `<div class="shot-ok">${icon('check-circle', 'ic-sm')}All numbers are consistent with each other.</div>`}
    ${w.images && w.images.length ? `<div class="shot-thumbs">${w.images.map(src => `<img src="${src}" alt="" />`).join('')}</div>` : ''}
    ${hrN > 3 || paceN > 3 || splits.length ? `<div class="chart-card mt-8"><div id="sqi_chart" class="chart" style="min-height:170px"></div></div>` : ''}
    <div class="shot-toggles">
      ${hrN > 3 ? tog('hr', `Heart-rate graph (${hrN} points) → zones, load, chart`) : ''}
      ${paceN > 3 || shotPts(w.elev_curve, 't_s', 'm', -400, 8000).length > 3 ? tog('pace', 'Pace / elevation graph → speed, distance, climbing') : ''}
      ${splits.length ? tog('splits', `Splits (${splits.length})`) : ''}
      ${laps.length ? tog('laps', `Pool lengths (${laps.length})`) : ''}
      ${zones.length ? tog('zones', `Heart-rate zone times (${zones.length})`) : ''}
    </div>
    ${splits.length ? `<details class="mt-8"><summary class="small">Splits read</summary><table class="dtable shot-table"><tr><th>km</th><th>time</th><th>pace</th><th>HR</th></tr>${splits.map(s => `<tr><td>${escapeHtml(String(s.km ?? ''))}</td><td>${formatDuration(shotNum(s.sec))}</td><td>${shotNum(s.pace_s) ? fmtPace(s.pace_s) : '–'}</td><td>${shotNum(s.avg_hr) || '–'}</td></tr>`).join('')}</table></details>` : ''}
    ${laps.length ? `<details class="mt-8"><summary class="small">Lengths read</summary><table class="dtable shot-table"><tr><th>#</th><th>m</th><th>time</th><th>strokes</th><th>SWOLF</th></tr>${laps.map(l => `<tr><td>${shotNum(l.n) || ''}</td><td>${shotNum(l.dist_m) || shotNum(w.pool_m) || '–'}</td><td>${fmtPace(shotNum(l.sec))}</td><td>${shotNum(l.strokes) ?? '–'}</td><td>${shotNum(l.swolf) ?? '–'}</td></tr>`).join('')}</table></details>` : ''}
    ${zones.length ? `<details class="mt-8"><summary class="small">Zone times read</summary><table class="dtable shot-table"><tr><th>zone</th><th>bpm</th><th>time</th></tr>${zones.map(z => `<tr><td>${escapeHtml(z.name || '')}</td><td>${shotNum(z.from_bpm) || ''}${shotNum(z.to_bpm) ? `–${z.to_bpm}` : ''}</td><td>${formatDuration(shotNum(z.sec))}</td></tr>`).join('')}</table></details>` : ''}
    ${extra.length ? `<div class="hint mt-8">Also read: ${escapeHtml(extra.join(' · '))}</div>` : ''}`;
}

function shotRenderChart() {
  const w = Squad.importDraft;
  const el = $('#sqi_chart');
  if (!w || !el || !plotReady()) return;
  const use = w.use || {};
  const hr = use.hr ? shotPts(w.hr_curve, 't_s', 'bpm', 30, 240) : [];
  const pace = use.pace ? shotPts(w.pace_curve, 't_s', 'pace_s_per_km', 90, 3600) : [];
  const traces = [];
  if (hr.length) traces.push({ x: hr.map(p => p.t / 60), y: hr.map(p => p.v), name: 'heart rate', type: 'scatter', mode: 'lines', line: { color: '#e11d48', width: 2 }, hovertemplate: '%{x:.0f} min: %{y:.0f} bpm<extra></extra>' });
  if (pace.length) traces.push({ x: pace.map(p => p.t / 60), y: pace.map(p => p.v), customdata: pace.map(p => fmtPace(p.v)), name: 'pace', yaxis: 'y2', type: 'scatter', mode: 'lines', line: { color: '#0891b2', width: 2 }, hovertemplate: '%{x:.0f} min: %{customdata} /km<extra></extra>' });
  let bars = null;
  if (!traces.length && use.splits) {
    const sp = (w.splits || []).filter(s => shotNum(s.sec));
    bars = sp.map(s => shotNum(s.sec));
    traces.push({ x: sp.map((s, i) => `km ${s.km ?? i + 1}`), y: bars, customdata: bars.map(formatDuration), type: 'bar', marker: { color: '#ca8a04' }, hovertemplate: '%{x}: %{customdata}<extra></extra>' });
  }
  if (!traces.length) { el.closest('.chart-card') && el.closest('.chart-card').classList.add('hidden'); return; }
  drawChart(el, traces, plotLayout({ showlegend: traces.length > 1, legend: { orientation: 'h', y: 1.15, x: 0 }, margin: { l: bars ? 42 : 34, r: pace.length ? 40 : 8, t: 20, b: 26 },
    xaxis: { title: { text: bars ? '' : 'min', font: { size: 10 } } },
    yaxis: bars ? shotTimeAxis(bars, true) : {},
    yaxis2: Object.assign({ overlaying: 'y', side: 'right', autorange: 'reversed', showgrid: false }, pace.length ? shotTimeAxis(pace.map(p => p.v)) : {}) }));
}

// Seconds on an axis, labelled m:ss (pace /km, split times)
function shotTimeAxis(vals, fromZero) {
  const lo = fromZero ? 0 : Math.min(...vals), hi = Math.max(...vals);
  const step = [5, 10, 15, 30, 60, 120, 300, 600].find(s => (hi - lo) / s <= 5) || 900;
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push(v);
  return { tickvals: ticks, ticktext: ticks.map(v => fmtPace(v)) };
}

// The approved draft → extra fields + stream + swim detail on the workout
function shotApply(w, d, durSec) {
  const use = d.use || shotUseDefaults(d);
  const n = k => shotNum(d[k]);
  if (n('min_hr')) w.min_hr = n('min_hr');
  if (n('max_cadence')) w.max_cadence = n('max_cadence');
  if (n('stride_cm')) w.stride_cm = n('stride_cm');
  if (n('elev_loss_m')) w.elev_loss_m = n('elev_loss_m');
  if (n('max_speed_kmh')) w.max_speed_kmh = n('max_speed_kmh');
  if (n('vo2max')) w.vo2max_watch = n('vo2max');
  if (n('training_effect')) w.training_effect_device = n('training_effect');
  if (n('recovery_h')) w.recovery_h_device = n('recovery_h');
  if (use.zones && (d.hr_zones || []).length) w.zones_device = d.hr_zones.filter(z => shotNum(z.sec)).map(z => ({ name: z.name, from: shotNum(z.from_bpm), to: shotNum(z.to_bpm), sec: shotNum(z.sec) }));
  if (use.splits && (d.splits || []).length) w.splits_device = d.splits.filter(s => shotNum(s.sec)).map(s => ({ km: shotNum(s.km), sec: shotNum(s.sec), avg_hr: shotNum(s.avg_hr) }));
  // Pool lengths → the per-length swim model (a lap longer than the pool is split evenly)
  if (w.sport === 'swim' && use.laps && (d.laps || []).length) {
    const pool = n('pool_m') || w.pool_m || 25;
    const style = s => ({ free: 'FREESTYLE', breast: 'BREASTSTROKE', back: 'BACKSTROKE', fly: 'BUTTERFLY', kick: 'KICK_BOARD', mixed: 'MIXED' })[String(s || '').toLowerCase()] || w.main_stroke || 'FREESTYLE';
    const laps = [];
    for (const l of d.laps) {
      const sec = shotNum(l.sec); if (!sec) continue;
      const k = Math.max(1, Math.round((shotNum(l.dist_m) || pool) / pool));
      for (let i = 0; i < k; i++) laps.push({ sec: sec / k, strokes: Math.round((shotNum(l.strokes) || 0) / k), style: style(l.stroke) });
    }
    const sw = buildSwimDetail({ poolLength: pool, laps }, durSec);
    if (sw) w.swim = sw;
  }
  const stream = shotStream(d, use, durSec, num(w.distance_km) * 1000);
  if (stream) {
    w.stream_source = 'screenshot charts';
    if (stream.velocity_smooth) {
      const v = stream.velocity_smooth.data.filter(x => x > 0);
      if (v.length && !w.max_speed_kmh) w.max_speed_kmh = round(Math.max(...v) * 3.6, 1);
    }
    if (stream.altitude && !w.elevation_gain_m) {
      let gain = 0, ref = null;
      for (const a of stream.altitude.data) { if (a === null) continue; if (ref === null) ref = a; if (a - ref >= 1) { gain += a - ref; ref = a; } else if (a < ref) ref = a; }
      w.elevation_gain_m = Math.round(gain);
    }
  }
  return stream;
}
