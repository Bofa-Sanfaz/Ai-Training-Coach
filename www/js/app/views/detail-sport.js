'use strict';
// --------------------------------------------------------
// WORKOUT DETAIL PER SPORT
// Each sport shows only what means something for it:
//   ride  – speed, power, climbing, VAM, decoupling, NP/IF/TSS (power meter)
//   run   – pace, cadence, steps, climbing, decoupling, watch VO2max
//   swim  – pace /100 m, SWOLF, lengths, strokes, stroke rate, rest, best 50–400 m, per-length chart
//   other – time, heart rate, load, calories, reps
// --------------------------------------------------------
const kv = (k, v, sub = '') => `<div class="kv"><span class="k">${k}</span><span class="v">${v}${sub ? ` <span class="tiny muted">${sub}</span>` : ''}</span></div>`;

function detailHeroBoxes(w, ctx) {
  const { box, fl, wpk } = ctx;
  const sp = sportOf(w);
  const d = distParts(w), s = speedParts(w);
  const hrBox = box(w.avg_hr > 0 ? String(w.avg_hr) : '--', 'Avg bpm', fl('hr'), w.avg_hr || undefined);
  const loadBox = box(hasVal(w.trimp) ? String(Math.round(w.trimp)) : '--', 'Load (TRIMP)', fl('hr'));
  if (sp === 'swim') {
    const sw = swimOf(w);
    const pace = swimPace100(w);
    return [
      box(d.v, d.unit, fl('distance'), num(d.v)),
      box(escapeHtml(formatDuration(w.moving_sec)), sw ? 'Swim time' : 'Time'),
      box(pace ? fmtPace(pace) : '--', 'Pace /100 m', fl('distance')),
      sw && sw.swolf ? box(String(sw.swolf), 'Avg SWOLF') : loadBox,
      hrBox,
      sw ? box(String(sw.lengths), `Lengths × ${sw.pool_m} m`, '', sw.lengths) : box(w.calories ? String(w.calories) : '--', 'kcal')
    ];
  }
  if (sp === 'run') {
    return [
      box(d.v, d.unit, fl('distance'), num(d.v)),
      box(escapeHtml(rideDuration(w)), 'Moving'),
      box(s.v, `Pace ${s.unit}`, fl('distance')),
      hrBox,
      w.avg_cadence > 0 ? box(String(w.avg_cadence), 'Cadence spm', '', w.avg_cadence) : loadBox,
      isIndoor(w) ? box(w.calories ? String(w.calories) : '--', 'kcal') : box(`${Math.round(num(w.elevation_gain_m))} m`, 'Ascent', fl('elevation'))
    ];
  }
  if (sp === 'other') {
    return [
      box(escapeHtml(rideDuration(w)), 'Time'),
      hrBox,
      box(w.max_hr > 0 ? String(w.max_hr) : '--', 'Peak bpm', fl('hr')),
      loadBox,
      box(w.calories ? String(w.calories) : '--', 'kcal', '', w.calories || undefined),
      w.reps ? box(String(w.reps), 'Reps', '', w.reps) : box(w.hr_min ? String(w.hr_min) : '--', 'Min bpm')
    ];
  }
  return [
    box(d.v, d.unit, fl('distance'), num(d.v)),
    box(escapeHtml(rideDuration(w)), 'Moving'),
    box(s.v, `Avg ${s.unit}`, fl('distance')),
    box(w.avg_power_w > 0 ? `${w.avg_power_w} W` : '--', `${w.device_watts ? 'Power' : 'Est. power'}${wpk ? ` · ${wpk} W/kg` : ''}`, fl('power')),
    hrBox,
    box(`${Math.round(num(w.elevation_gain_m))} m`, 'Ascent', fl('elevation'))
  ];
}

function detailStatsHtml(w, ctx) {
  const sp = sportOf(w);
  const pctMax = w.max_hr > 0 ? Math.round((w.max_hr / PHYSIO.max_hr) * 100) : null;
  const peak = kv('Peak heart rate', w.max_hr ? `${w.max_hr} bpm` : '--', pctMax ? `${pctMax}% of max` : '');
  const load = kv('Training load', hasVal(w.trimp) ? `${Math.round(w.trimp)} TRIMP` : '--', w.trimp_source === 'avg' ? '(avg HR)' : '');
  const rpe = w.rpe ? kv('Session RPE load', String(Math.round(w.rpe * num(w.moving_sec) / 60)), 'RPE × min') : '';
  const kcal = w.calories ? kv('Energy', `${w.calories} kcal`, w.kcal_per_h ? `${w.kcal_per_h}/h` : '') : '';
  const elapsed = kv('Elapsed time', w.elapsed_sec ? formatDuration(w.elapsed_sec) : '--');
  const minHr = w.hr_min ? kv('Lowest heart rate', `${w.hr_min} bpm`) : '';
  if (sp === 'swim') {
    const sw = swimOf(w);
    if (!sw) return [kv('Pool', w.pool_length_m ? `${w.pool_length_m} m` : '--'), peak, minHr, load, kcal, elapsed, rpe, kv('Lap detail', 'not recorded', 'only watch swims have lengths')].join('');
    const mix = Object.entries(sw.mix).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${STROKES[k]} ${n}`).join(' · ');
    return [
      kv('Pool length', `${sw.pool_m} m`),
      kv('Total time', formatDuration(num(w.elapsed_sec) || sw.active_sec), sw.rest_sec ? `${formatDuration(sw.rest_sec)} rest` : ''),
      kv('Strokes', String(sw.strokes), sw.spl ? `${sw.spl} per length` : ''),
      kv('Stroke rate', sw.stroke_rate ? `${sw.stroke_rate} /min` : '--'),
      kv('SWOLF', sw.swolf ? String(sw.swolf) : '--', sw.swolf_best ? `best ${sw.swolf_best}` : ''),
      kv('Best 100 m', fmtSec(sw.best[100]), sw.best[50] ? `50 m ${fmtSec(sw.best[50])}` : ''),
      kv('Fastest length', `${sw.best_len} s`),
      kv('Stroke mix', escapeHtml(mix) || '--'),
      peak, minHr, load, kcal, rpe
    ].join('');
  }
  if (sp === 'run') {
    return [
      ctx.userW ? kv('Body weight', `${ctx.userW} kg`) : '',
      kv('Fastest pace', w.max_speed_kmh > 0 ? speedText(w, w.max_speed_kmh) : '--'),
      w.avg_cadence ? kv('Cadence', `${w.avg_cadence} spm`, w.max_cadence ? `max ${w.max_cadence}` : '') : '',
      w.steps ? kv('Steps', String(w.steps)) : '',
      peak, minHr, load,
      isIndoor(w) ? '' : kv('Climbing', `${Math.round(num(w.elevation_gain_m))} m`),
      kv('Aerobic decoupling', escapeHtml(decouplingDisplay(w))),
      w.vo2max_watch ? kv('Watch VO2max', String(w.vo2max_watch)) : '',
      kcal, elapsed, rpe
    ].join('');
  }
  if (sp === 'other') {
    return [peak, minHr, load, kcal, w.reps ? kv('Repetitions', String(w.reps)) : '', elapsed, rpe, w.distance_km > 0 ? kv('Distance', distText(w)) : ''].join('');
  }
  const gross = grossAscentRate(w);
  const vam = w.climbing_vam ? `${w.climbing_vam} m/h` : (gross > 0 ? `${gross} m/h` : '--');
  return [
    kv('Athlete weight', ctx.userW ? `${ctx.userW} kg` : 'Not set'),
    kv('Max speed', w.max_speed_kmh ? `${fmtNum(w.max_speed_kmh, 1)} km/h` : '--'),
    peak, load,
    kv('Work done', w.kilojoules > 0 ? `${w.kilojoules} kJ` : '--'),
    kv('Climbing VAM', vam, w.climbing_vam ? '(>3%)' : gross > 0 ? '(gross)' : ''),
    kv('Aerobic decoupling', escapeHtml(decouplingDisplay(w))),
    elapsed, rpe, powerKvHtml(w, ctx.all)
  ].join('');
}

// Section titles that depend on the sport
function applyDetailLabels(w) {
  const sp = sportOf(w);
  const plural = SPORTS[sp].plural.toLowerCase();
  $('#det_delta_title').textContent = `Vs prior comparable ${sp === 'other' ? 'gym sessions' : plural}`;
  $('#det_best_title').textContent = sp === 'swim' ? 'Best efforts in this swim' : `Best efforts in this ${SPORTS[sp].label.toLowerCase()}`;
  $('#det_stream_title').textContent = { ride: 'Ride stream studio', run: 'Run stream', swim: 'Heart rate through the swim', other: 'Heart rate through the session' }[sp];
}

// ---------- Swim: per-length chart, 100 m splits, length table ----------
function renderSwimSection(w) {
  const wrap = $('#det_swim_wrap');
  const sw = sportOf(w) === 'swim' ? swimOf(w) : null;
  wrap.classList.toggle('hidden', !sw);
  if (!sw) return;
  const k = Math.max(1, Math.round(100 / sw.pool_m));
  const splits = [];
  for (let i = 0; i + k <= sw.laps.length; i += k) splits.push(sumBy(sw.laps.slice(i, i + k), l => l.sec));
  const bestSplit = splits.length ? Math.min(...splits) : null;
  $('#det_swim_summary').innerHTML = `
    <div class="swim-mix">${Object.entries(sw.mix).sort((a, b) => b[1] - a[1]).map(([s, n]) => `<span style="--sc:${STROKE_COLORS[s]}"><i></i>${STROKES[s]} · ${n} × ${sw.pool_m} m</span>`).join('')}</div>
    ${splits.length ? `<div class="field-label mt-12">100 m splits</div><div class="splits">${splits.map((t, i) => `<span class="${t === bestSplit ? 'best' : ''}"><b>${fmtPace(t)}</b><small>${(i + 1) * 100} m</small></span>`).join('')}</div>` : ''}
    <details class="mt-12"><summary class="small">All ${sw.lengths} lengths</summary>
      <div class="table-wrap mt-8"><table class="dtable"><thead><tr><th>#</th><th>Stroke</th><th>Time</th><th>Strokes</th><th>SWOLF</th></tr></thead><tbody>
      ${sw.laps.map((l, i) => `<tr><td>${i + 1}</td><td><span class="dot" style="background:${STROKE_COLORS[l.style]}"></span> ${STROKES[l.style]}</td><td>${l.sec} s</td><td>${l.strokes || '--'}</td><td>${l.strokes ? round(l.sec + l.strokes, 1) : '--'}</td></tr>`).join('')}
      </tbody></table></div></details>`;
  const el = $('#swimChart');
  if (!plotReady()) return chartEmpty(el, 'Charts unavailable.');
  const x = sw.laps.map((_, i) => i + 1);
  drawChart(el, [
    { x, y: sw.laps.map(l => l.sec), type: 'bar', name: 'Length time', marker: { color: sw.laps.map(l => STROKE_COLORS[l.style]) }, text: sw.laps.map(l => STROKES[l.style]), textposition: 'none', hovertemplate: 'Length %{x}: <b>%{y} s</b> · %{text}<extra></extra>' },
    { x, y: sw.laps.map(l => (l.strokes ? round(l.sec + l.strokes, 1) : null)), type: 'scatter', mode: 'lines+markers', name: 'SWOLF', yaxis: 'y2', connectgaps: false, line: { color: '#0f172a', width: 1.6 }, marker: { size: 4 }, hovertemplate: 'SWOLF %{y}<extra></extra>' }
  ], plotLayout({
    hovermode: 'closest', bargap: 0.15, margin: { l: 32, r: 32, t: 8, b: 28 },
    xaxis: { title: { text: 'length', font: { size: 10 } }, dtick: sw.lengths > 30 ? 5 : 2 },
    yaxis: { title: { text: 'seconds', font: { size: 10 } } },
    yaxis2: { overlaying: 'y', side: 'right', showgrid: false, fixedrange: true, title: { text: 'SWOLF', font: { size: 10 } } }
  }));
}

// ---------- Best efforts per sport ----------
function bestEffortRows(w) {
  const rows = [];
  const dur = d => BEST_LABELS[d] || `${d}s`;
  const sp = sportOf(w);
  const sw = swimOf(w);
  if (sp === 'swim' && sw) {
    const cells = [50, 100, 200, 400].filter(m => sw.best[m]).map(m => [`${m} m`, fmtSec(sw.best[m])]);
    if (cells.length) rows.push(['Fastest', cells]);
  }
  if (mv(w, 'best_spd') && (sp === 'ride' || sp === 'run')) rows.push([speedName(w), Object.entries(w.best_spd).map(([d, v]) => [dur(d), speedText(w, v)])]);
  if (mv(w, 'best_hr')) rows.push(['Heart rate', Object.entries(w.best_hr).map(([d, v]) => [dur(d), `${Math.round(v)} bpm`])]);
  if (sp === 'ride' && w.power_source === 'meter' && w.mmp) rows.push(['Power', Object.entries(w.mmp).filter(([d]) => [5, 60, 300, 1200, 3600].includes(+d)).map(([d, v]) => [dur(d), `${Math.round(v)} W`])]);
  return rows;
}

// ---------- Stream chart metrics per sport ----------
function streamMetricsFor(w, stream) {
  const sp = sportOf(w);
  if (sp === 'swim' || sp === 'other') return ['Heart Rate (bpm)'];
  if (sp === 'run') {
    const m = ['Pace', 'Heart Rate (bpm)'];
    if (stream && stream.altitude) m.push('Elevation (m)');
    if (stream && stream.cadence) m.push('Cadence (spm)');
    return m;
  }
  const m = ['Speed (km/h)', 'Heart Rate (bpm)', 'Power (Watts)', 'Elevation (m)'];
  if (stream && stream.cadence) m.push('Cadence (RPM)');
  return m;
}
