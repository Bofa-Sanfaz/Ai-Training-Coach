'use strict';
// --------------------------------------------------------
// TRENDS: fitness/fatigue/form, weekly volume, ride progression, AI audit
// --------------------------------------------------------
let loadRangeDays = 180;
let weeklyMetric = 'dist';
let globalSelectedMetrics = ['Speed (km/h)', 'Heart Rate (bpm)', 'Distance'];
let graphAiBusy = false;

// Values come through mv(): anything marked as a data error is a gap in the line
// `sports` lists where a metric means something; a higher line is always "more" of it
// (for pace the line is speed, so higher = faster; SWOLF/strokes: higher = less efficient).
const GLOBAL_METRICS = {
  'Speed (km/h)': { sports: ['ride'], color: '#2563eb', val: w => mv(w, 'avg_speed_kmh') || null, fmt: w => speedText(w), floor: 25 },
  'Pace': { sports: ['run', 'swim'], color: '#16a34a', val: w => (sportOf(w) === 'swim' ? (swimPace100(w) ? 360 / swimPace100(w) : null) : mv(w, 'avg_speed_kmh') || null), fmt: w => (sportOf(w) === 'swim' ? `${fmtSec(swimPace100(w))} /100m` : speedText(w)), floor: 1 },
  'SWOLF': { sports: ['swim'], color: '#0891b2', val: w => (swimOf(w) && swimOf(w).swolf) || null, fmt: w => `SWOLF ${(swimOf(w) && swimOf(w).swolf) || '--'}`, floor: 40 },
  'Strokes / length': { sports: ['swim'], color: '#7c3aed', val: w => (swimOf(w) && swimOf(w).spl) || null, fmt: w => `${(swimOf(w) && swimOf(w).spl) || '--'} strokes/length`, floor: 12 },
  'Cadence (spm)': { sports: ['run'], color: '#8b5cf6', val: w => w.avg_cadence || null, fmt: w => `${w.avg_cadence || '--'} spm`, floor: 160 },
  'Power Output (Watts)': { sports: ['ride'], color: '#fc5200', val: w => mv(w, 'avg_power_w') || null, fmt: w => `${w.avg_power_w || '--'} W${w.device_watts ? '' : ' (est)'}`, floor: 250 },
  'Heart Rate (bpm)': { sports: ['ride', 'run', 'swim', 'other'], color: '#ef4444', val: w => mv(w, 'avg_hr') || null, fmt: w => `${w.avg_hr || '--'} bpm`, hr: true },
  'Efficiency': { sports: ['ride', 'run'], color: '#0d9488', val: w => (mv(w, 'avg_speed_kmh') > 0 && mv(w, 'avg_hr') > 0 ? (w.avg_speed_kmh / w.avg_hr) * 100 : null), fmt: w => (w.avg_hr ? `${fmtNum((w.avg_speed_kmh / w.avg_hr) * 100, 1)} speed/100 bpm` : '--'), floor: 15 },
  'Distance': { sports: ['ride', 'run', 'swim'], color: '#8b5cf6', val: w => mv(w, 'distance_km') || null, fmt: w => distText(w), floor: 1 },
  'Duration': { sports: ['ride', 'run', 'swim', 'other'], color: '#64748b', val: w => (num(w.moving_sec) / 60) || null, fmt: w => rideDuration(w), floor: 30 },
  'Elevation Ascent (m)': { sports: ['ride', 'run'], color: '#94a3b8', val: w => (isIndoor(w) ? null : mv(w, 'elevation_gain_m') || null), fmt: w => `${Math.round(num(w.elevation_gain_m))} m`, floor: 150 },
  'Work (kJ)': { sports: ['ride'], color: '#10b981', val: w => mv(w, 'kilojoules') || null, fmt: w => `${w.kilojoules || '--'} kJ`, floor: 800 },
  'Calories': { sports: ['other', 'swim'], color: '#f59e0b', val: w => w.calories || null, fmt: w => `${w.calories || '--'} kcal`, floor: 200 },
  'Load (TRIMP)': { sports: ['ride', 'run', 'swim', 'other'], color: '#db2777', val: w => (hasVal(mv(w, 'trimp')) ? w.trimp : null), fmt: w => `${hasVal(w.trimp) ? Math.round(w.trimp) : '--'} TRIMP`, floor: 80 }
};
const DEFAULT_PROGRESSION = { ride: ['Speed (km/h)', 'Heart Rate (bpm)', 'Distance'], run: ['Pace', 'Heart Rate (bpm)', 'Distance'], swim: ['Pace', 'SWOLF', 'Heart Rate (bpm)'], other: ['Duration', 'Heart Rate (bpm)', 'Load (TRIMP)'] };
let progressionSport = 'ride';

function setupTrendsControls() {
  $$('#loadRange .chip').forEach(ch => ch.addEventListener('click', () => {
    loadRangeDays = +ch.dataset.range;
    $$('#loadRange .chip').forEach(c => c.classList.toggle('active', c === ch));
    renderLoadChart();
  }));
  $$('#weeklySeg button').forEach(b => b.addEventListener('click', () => {
    weeklyMetric = b.dataset.m;
    $$('#weeklySeg button').forEach(x => x.classList.toggle('active', x === b));
    renderWeeklyChart();
  }));
}

let trendsCache = null;

async function renderTrends() {
  const everything = (await db.workouts.orderBy('date').toArray()).filter(w => !isExcluded(w));
  if (sportFilter !== 'all' && !sportsPresent(everything).includes(sportFilter)) sportFilter = 'all';
  $('#sportSegTrends').innerHTML = sportSegHtml(everything, 'setSportFilter');
  const workouts = bySport(everything, sportFilter);
  trendsCache = { workouts, everything, series: computeLoadSeries(workouts) };
  renderLoadKpis();
  renderLoadChart();
  renderCalendar();
  renderWeeklyChart();
  renderBestEffortsTable();
  renderGlobalGraph();
  await renderGraphChatThread();
}

function renderLoadKpis() {
  const s = trendsCache.series;
  const host = $('#loadKpis');
  if (!s) {
    host.innerHTML = `<div class="kpi" style="grid-column:1/-1"><div class="l">Training load</div><div class="s mt-8">Needs rides with heart-rate data. Sync Strava or load demo rides.</div></div>`;
    return;
  }
  const i = s.dates.length - 1;
  const wk = Math.max(0, i - 7);
  const fs = formStatus(s.tsb[i]);
  host.innerHTML = `
    <div class="kpi"><div class="l">Fitness</div><div class="v" style="color:#2563eb">${Math.round(s.ctl[i])}</div><div class="s">${signed(s.ctl[i] - s.ctl[wk], 1)} in 7 days</div></div>
    <div class="kpi"><div class="l">Fatigue</div><div class="v" style="color:#db2777">${Math.round(s.atl[i])}</div><div class="s">${signed(s.atl[i] - s.atl[wk], 1)} in 7 days</div></div>
    <div class="kpi"><div class="l">Form</div><div class="v ${fs.tone}">${signed(s.tsb[i], 0)}</div><div class="s">${escapeHtml(fs.label)}</div></div>`;
}

function renderLoadChart() {
  const el = $('#loadChart');
  const s = trendsCache && trendsCache.series;
  if (!plotReady()) return chartEmpty(el, 'Charts unavailable.');
  if (!s) return chartEmpty(el, 'No heart-rate based training load yet.');
  // Ranges longer than the history would all look identical to "All": mark them as such
  const span = s.dates.length;
  $$('#loadRange .chip').forEach(ch => {
    const r = +ch.dataset.range;
    const covers = r > 0 && r >= span;
    ch.classList.toggle('dim', covers);
    ch.title = covers ? `Your history is ${span} days — same as All` : '';
  });
  $('#loadRangeNote').textContent = `History since ${formatNiceDate(s.dates[0], false)} · ${span} days`;
  const start = loadRangeDays ? Math.max(0, s.dates.length - loadRangeDays) : 0;
  const x = s.dates.slice(start);
  const tsb = s.tsb.slice(start);
  drawChart(el, [
    { x, y: tsb, type: 'bar', name: 'Form', marker: { color: tsb.map(v => (v >= 0 ? 'rgba(22,163,74,0.45)' : 'rgba(239,68,68,0.35)')) }, hovertemplate: 'Form %{y}<extra></extra>' },
    { x, y: s.ctl.slice(start), type: 'scatter', mode: 'lines', name: 'Fitness', line: { color: '#2563eb', width: 2.6, shape: 'spline' }, hovertemplate: 'Fitness %{y}<extra></extra>' },
    { x, y: s.atl.slice(start), type: 'scatter', mode: 'lines', name: 'Fatigue', line: { color: '#db2777', width: 1.6, shape: 'spline' }, hovertemplate: 'Fatigue %{y}<extra></extra>' }
  ], plotLayout({ bargap: 0.1, xaxis: { type: 'date', tickformat: '%d %b' } }));
}

function renderWeeklyChart() {
  const el = $('#weeklyChart');
  if (!plotReady()) return chartEmpty(el, 'Charts unavailable.');
  const weeks = weeklyTotals(trendsCache.workouts);
  if (!weeks.length) return chartEmpty(el, 'No workouts yet.');
  const map = new Map(weeks.map(w => [w.week, w]));
  const thisWeek = startOfWeek(new Date());
  const keys = [];
  for (let k = 15; k >= 0; k--) keys.push(formatLocalDate(addDays(thisWeek, -7 * k)));
  const unit = { dist: 'km', sec: 'h', asc: 'm', trimp: 'TRIMP' }[weeklyMetric];
  const valOf = e => (weeklyMetric === 'dist' ? round(e.dist, 1) : weeklyMetric === 'sec' ? round(e.sec / 3600, 1) : weeklyMetric === 'asc' ? Math.round(e.asc || 0) : Math.round(e.trimp));
  // One stacked colour per sport when several sports are shown
  const sports = Object.keys(SPORTS).filter(s => weeks.some(wk => wk.sports[s]));
  const stacks = weeklyMetric === 'asc' || sports.length < 2 ? [null] : sports;
  const traces = stacks.map(s => {
    const base = s ? SPORTS[s].color : '#fc5200';
    return {
      x: keys,
      y: keys.map(k => { const e = map.get(k); return !e ? 0 : s ? valOf(e.sports[s] || { dist: 0, sec: 0, trimp: 0 }) : valOf(e); }),
      type: 'bar', name: s ? SPORTS[s].plural : '',
      text: keys.map(k => { const e = map.get(k); return e ? `${e.count} session${e.count === 1 ? '' : 's'} · ${formatHours(e.sec)} · ${Math.round(e.trimp)} TRIMP` : 'no training'; }),
      marker: { color: keys.map((_, i) => (i === keys.length - 1 ? base : `${base}80`)), line: { width: 0 } },
      hovertemplate: `${s ? `${SPORTS[s].plural} · ` : ''}week of %{x|%d %b}: <b>%{y} ${unit}</b><br>%{text}<extra></extra>`
    };
  });
  drawChart(el, traces, plotLayout({ barmode: 'stack', hovermode: 'closest', bargap: 0.25, xaxis: { type: 'date', tickformat: '%d %b' } }));
}

// --------------------------------------------------------
// TRAINING CALENDAR (month grid, colour = daily load)
// --------------------------------------------------------
let calMonthOffset = 0;

function shiftCalendar(delta) {
  calMonthOffset = Math.min(0, calMonthOffset + delta);
  haptic('light');
  renderCalendar();
}

function renderCalendar() {
  const host = $('#calendar');
  if (!trendsCache) return;
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() + calMonthOffset, 1);
  $('#calTitle').textContent = first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const byDay = new Map();
  for (const w of trendsCache.workouts) {
    const k = String(w.date).slice(0, 10);
    const e = byDay.get(k) || { load: 0, rides: [] };
    e.load += hasVal(w.trimp) ? num(w.trimp) : num(w.moving_sec) / 60;
    e.rides.push(w);
    byDay.set(k, e);
  }
  const maxLoad = Math.max(1, ...[...byDay.values()].map(e => e.load));
  const start = startOfWeek(first);
  const today = formatLocalDate(now);
  let html = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => `<div class="cal-head">${d[0]}</div>`).join('');
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    if (i >= 35 && d.getMonth() !== first.getMonth()) break;
    const k = formatLocalDate(d);
    const e = byDay.get(k);
    const inMonth = d.getMonth() === first.getMonth();
    const a = e ? 0.25 + 0.75 * Math.min(1, e.load / maxLoad) : 0;
    html += `<div class="cal-day ${e ? 'has' : ''} ${inMonth ? '' : 'out'} ${k === today ? 'today' : ''}" ${e ? `style="background:rgba(252,82,0,${a.toFixed(2)});color:${a < 0.6 ? '#7c2d12' : '#fff'}" onclick="openCalendarDay('${k}')"` : ''}>
      ${d.getDate()}${e && e.rides.length > 1 ? `<span class="n">×${e.rides.length}</span>` : ''}</div>`;
  }
  host.innerHTML = html;
}

async function openCalendarDay(dateKey) {
  const rides = trendsCache.workouts.filter(w => String(w.date).startsWith(dateKey));
  if (rides.length === 1) { openRide(rides[0].id); return; }
  switchTab('rides');
  rideQuery = dateKey;
  $('#rideSearch').value = dateKey;
  renderRides();
}

// --------------------------------------------------------
// BEST EFFORTS (speed / HR always; power only from power meters)
// --------------------------------------------------------
// Flagged values (data errors) never count
function bestOf(workouts, field, d) {
  let best = null;
  // Swim distances: fastest time (lower is better), from the per-length log
  if (field === 'swim') {
    for (const w of workouts) { const t = swimOf(w) && swimOf(w).best[d]; if (t && !isExcluded(w) && (!best || t < best.v)) best = { v: t, w }; }
    return best;
  }
  for (const w of workouts) {
    if (field === 'mmp' && (w.power_source !== 'meter' || isFlagged(w, 'power'))) continue;
    const src = field === 'mmp' ? w.mmp : mv(w, field);
    const v = src && src[d];
    if (v && (!best || v > best.v)) best = { v, w };
  }
  return best;
}

function renderBestEffortsTable() {
  const host = $('#bestEfforts');
  const groups = [];
  for (const sp of sportsPresent(trendsCache.workouts)) {
    const pool = trendsCache.workouts.filter(w => sportOf(w) === sp);
    const probe = { sport: sp };
    const name = s => (sportsPresent(trendsCache.workouts).length > 1 ? `${SPORTS[sp].label} ${s}` : s);
    if (sp === 'swim') groups.push({ pool, name: name('fastest'), field: 'swim', durs: [50, 100, 200, 400], label: d => `${d} m`, fmt: v => fmtSec(v) });
    if (sp === 'ride' || sp === 'run') groups.push({ pool, name: name(sp === 'ride' ? 'speed' : 'pace'), field: 'best_spd', durs: [60, 300, 1200, 3600], fmt: v => speedText(probe, v) });
    groups.push({ pool, name: name('HR'), field: 'best_hr', durs: [60, 300, 1200, 3600], fmt: v => `${Math.round(v)} bpm` });
    if (sp === 'ride') groups.push({ pool, name: 'Power (meter)', field: 'mmp', durs: [5, 60, 300, 1200, 3600], fmt: v => `${Math.round(v)} W` });
  }
  const shown = groups.filter(g => g.durs.some(d => bestOf(g.pool, g.field, d)));
  if (!shown.length) { host.innerHTML = '<div class="card small muted">Best efforts appear once workouts with streams are synced.</div>'; return; }
  host.innerHTML = shown.map(g => {
    const recent = g.pool.filter(w => parseSafeDate(w.date) >= addDays(new Date(), -42));
    return `
    <div class="table-wrap mb-8"><table class="dtable">
      <thead><tr><th>${escapeHtml(g.name)}</th>${g.durs.map(d => `<th>${g.label ? g.label(d) : BEST_LABELS[d]}</th>`).join('')}</tr></thead>
      <tbody>
        <tr><td>All time</td>${g.durs.map(d => { const b = bestOf(g.pool, g.field, d); return `<td>${b ? `<a class="pb-link" onclick="openRide(${b.w.id})">${g.fmt(b.v)}</a>` : '--'}</td>`; }).join('')}</tr>
        <tr><td>6 weeks</td>${g.durs.map(d => { const b = bestOf(recent, g.field, d); return `<td>${b ? g.fmt(b.v) : '--'}</td>`; }).join('')}</tr>
      </tbody></table></div>`;
  }).join('') + '<div class="hint">Tap an all-time value to open that session. A wrong value? Open it, tap the flag and mark it as a data error.</div>';
}

function setupGlobalMetricPills() {
  const valid = Object.keys(GLOBAL_METRICS).filter(m => GLOBAL_METRICS[m].sports.includes(progressionSport));
  // A different sport starts from its own defaults
  if (setupGlobalMetricPills.sport !== progressionSport) { setupGlobalMetricPills.sport = progressionSport; globalSelectedMetrics = DEFAULT_PROGRESSION[progressionSport].slice(); }
  globalSelectedMetrics = globalSelectedMetrics.filter(m => valid.includes(m));
  if (!globalSelectedMetrics.length) globalSelectedMetrics = DEFAULT_PROGRESSION[progressionSport].slice();
  $('#globalMetricPills').innerHTML = valid.map(m =>
    `<button class="chip ${globalSelectedMetrics.includes(m) ? 'active' : ''}" onclick="toggleGlobalMetric('${m}')"><span class="dot" style="background:${GLOBAL_METRICS[m].color}"></span>${m}</button>`).join('');
}

function toggleGlobalMetric(m) {
  if (globalSelectedMetrics.includes(m)) {
    if (globalSelectedMetrics.length > 1) globalSelectedMetrics = globalSelectedMetrics.filter(x => x !== m);
  } else {
    globalSelectedMetrics.push(m);
  }
  setupGlobalMetricPills();
  renderGlobalGraph();
  renderGraphChatThread();
}

function renderGlobalGraph() {
  const el = $('#globalChart');
  // Progression only makes sense within one sport: "All" shows rides (or the main sport)
  const present = sportsPresent(trendsCache.workouts);
  const sp = sportFilter !== 'all' ? sportFilter : present.includes('ride') ? 'ride' : present[0];
  progressionSport = sp || 'ride';
  setupGlobalMetricPills();
  const workouts = trendsCache.workouts.filter(w => sportOf(w) === sp);
  $('#globalSportNote').textContent = present.length > 1 || sportFilter !== 'all' ? `${SPORTS[sp || 'ride'].plural} only${sportFilter === 'all' ? ' — pick a sport above to switch' : ''}` : '';
  if (!plotReady()) return chartEmpty(el, 'Charts unavailable.');
  if (workouts.length < 2) return chartEmpty(el, 'Log at least 2 sessions of this sport to plot progression.');

  const x = workouts.map(w => rideCode(w).replace(/^(\w)\w* 0*/, '$1'));
  const traces = globalSelectedMetrics.map(m => {
    const cfg = GLOBAL_METRICS[m];
    const vals = workouts.map(cfg.val);
    let y;
    if (cfg.hr) {
      const lo = Math.max(60, PHYSIO.resting_hr);
      y = vals.map(v => (v ? Math.max(0, Math.min(100, ((v - lo) / (PHYSIO.max_hr - lo)) * 100)) : null));
    } else {
      const peak = Math.max(safeMax(vals.map(num), 0), cfg.floor || 1);
      y = vals.map(v => (v ? Math.min(100, (v / peak) * 100) : null));
    }
    return { x, y, name: m, text: workouts.map(cfg.fmt), hovertemplate: '%{text}<extra></extra>', type: 'scatter', mode: 'lines+markers', connectgaps: true, line: { color: cfg.color, width: 2.4, shape: 'spline' }, marker: { size: 6 } };
  });
  // Trend of the first selected metric: compare last 5 with the 5 before
  const first = GLOBAL_METRICS[globalSelectedMetrics[0]];
  const vals = workouts.map(first.val).filter(hasVal);
  if (vals.length >= 6) {
    const a = mean(vals.slice(-5)), b = mean(vals.slice(-10, -5));
    $('#global_banner_l').textContent = `${globalSelectedMetrics[0].split(' (')[0]}: last 5 vs previous 5`;
    $('#global_banner_r').textContent = b ? signed(((a - b) / b) * 100, 1, '%') : '--';
  } else {
    $('#global_banner_l').textContent = 'Macro trajectory';
    $('#global_banner_r').textContent = `${workouts.length} rides`;
  }

  const width = Math.max(el.parentElement.clientWidth - 12, workouts.length * 46);
  drawChart(el, traces, plotLayout({
    width,
    margin: { l: 10, r: 10, t: 10, b: 30 },
    yaxis: { range: [0, 105], showticklabels: false, dtick: 25 },
    xaxis: { type: 'category' }
  }), Object.assign({}, PLOT_CONFIG, { responsive: false }));
  if (el.on) el.on('plotly_hover', data => {
    const pt = data.points && data.points[0];
    const w = pt && workouts[pt.pointIndex];
    if (w) $('#global_banner_sub').textContent = `${rideTitle(w)} — ${formatFullDateWithDay(w.date)}: ${distText(w)}, ${speedText(w)}, ${w.avg_hr || '--'} bpm${sportOf(w) === 'ride' || sportOf(w) === 'run' ? `, ${Math.round(num(w.elevation_gain_m))} m` : ''}`;
  });
  if (el.on) el.on('plotly_click', data => {
    const pt = data.points && data.points[0];
    const w = pt && workouts[pt.pointIndex];
    if (w) openRide(w.id);
  });
}

function graphMetricKey() {
  return globalSelectedMetrics.slice().sort().join('+');
}

async function renderGraphChatThread(extra = '') {
  const msgs = await db.graph_threads.where('metric_key').equals(graphMetricKey()).toArray();
  $('#graphChatThread').innerHTML = msgs.map(m => bubbleHtml(m, 'Season analyst')).join('') + extra;
  $('#graphReplyBox').classList.toggle('hidden', !msgs.length);
}

async function generateGraphDebrief() {
  if (graphAiBusy) return;
  const workouts = await db.workouts.orderBy('date').toArray();
  if (workouts.length < 2) { toast('Log at least 2 rides first.', 'warn'); return; }
  graphAiBusy = true;
  const btn = $('#btnGraphAI');
  setBusy(btn, true, 'Auditing season…');
  await renderGraphChatThread(typingHtml('Auditing progression curves'));
  try {
    const meta = {};
    const live = liveBubble($('#graphChatThread'), 'Season analyst');
    const reply = await callAI(await buildGraphPrompt(workouts, globalSelectedMetrics), null, { agent: 'trends', meta, onStatus: aiStatusIn($('#graphChatThread')), onDelta: t => live(hideMemoryTags(t)) });
    if (reply) await db.graph_threads.add(Object.assign({ metric_key: graphMetricKey(), role: 'coach', message: await captureMemory(reply, 'Trends'), created_at: new Date().toISOString() }, aiMetaFields(meta)));
  } catch (e) {
    toast(`Audit failed: ${e.message}`, 'error');
  } finally {
    graphAiBusy = false;
    setBusy(btn, false);
    await renderGraphChatThread();
  }
}

async function sendGraphAthleteReply() {
  const input = $('#graphReplyInput');
  const text = input.value.trim();
  if (!text || graphAiBusy) return;
  const key = graphMetricKey();
  input.value = '';
  await db.graph_threads.add({ metric_key: key, role: 'athlete', message: text, created_at: new Date().toISOString() });
  graphAiBusy = true;
  await renderGraphChatThread(typingHtml());
  try {
    const past = await db.graph_threads.where('metric_key').equals(key).toArray();
    const dialogue = past.slice(-8).map(t => `${t.role.toUpperCase()}: ${t.message}`).join('\n');
    const meta = {};
    const live = liveBubble($('#graphChatThread'), 'Season analyst');
    const reply = await callAI(await buildGraphReplyPrompt(globalSelectedMetrics, dialogue), null, { agent: 'trends', meta, onStatus: aiStatusIn($('#graphChatThread')), onDelta: t => live(hideMemoryTags(t)) });
    if (reply) await db.graph_threads.add(Object.assign({ metric_key: key, role: 'coach', message: await captureMemory(reply, 'Trends'), created_at: new Date().toISOString() }, aiMetaFields(meta)));
  } finally {
    graphAiBusy = false;
    await renderGraphChatThread();
  }
}
