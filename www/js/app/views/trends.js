'use strict';
// --------------------------------------------------------
// TRENDS: fitness/fatigue/form, weekly volume, ride progression, AI audit
// --------------------------------------------------------
let loadRangeDays = 180;
let weeklyMetric = 'dist';
let globalSelectedMetrics = ['Speed (km/h)', 'Heart Rate (bpm)', 'Distance (km)'];
let graphAiBusy = false;

const GLOBAL_METRICS = {
  'Power Output (Watts)': { color: '#fc5200', val: w => w.avg_power_w || null, fmt: w => `${w.avg_power_w || '--'} W${w.device_watts ? '' : ' (est)'}`, floor: 250 },
  'Speed (km/h)': { color: '#2563eb', val: w => w.avg_speed_kmh || null, fmt: w => `${fmtNum(w.avg_speed_kmh, 1)} km/h`, floor: 25 },
  'Heart Rate (bpm)': { color: '#ef4444', val: w => w.avg_hr || null, fmt: w => `${w.avg_hr || '--'} bpm`, hr: true },
  'Distance (km)': { color: '#8b5cf6', val: w => w.distance_km || null, fmt: w => `${fmtNum(w.distance_km, 1)} km`, floor: 30 },
  'Elevation Ascent (m)': { color: '#64748b', val: w => w.elevation_gain_m || null, fmt: w => `${Math.round(num(w.elevation_gain_m))} m`, floor: 150 },
  'Work (kJ)': { color: '#10b981', val: w => w.kilojoules || null, fmt: w => `${w.kilojoules || '--'} kJ`, floor: 800 },
  'Load (TRIMP)': { color: '#db2777', val: w => (hasVal(w.trimp) ? w.trimp : null), fmt: w => `${hasVal(w.trimp) ? Math.round(w.trimp) : '--'} TRIMP`, floor: 80 }
};

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
  const workouts = await db.workouts.orderBy('date').toArray();
  trendsCache = { workouts, series: computeLoadSeries(workouts) };
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
  const start = loadRangeDays ? Math.max(0, s.dates.length - loadRangeDays) : 0;
  const x = s.dates.slice(start);
  const tsb = s.tsb.slice(start);
  el.innerHTML = '';
  Plotly.react(el, [
    { x, y: tsb, type: 'bar', name: 'Form', marker: { color: tsb.map(v => (v >= 0 ? 'rgba(22,163,74,0.45)' : 'rgba(239,68,68,0.35)')) }, hovertemplate: 'Form %{y}<extra></extra>' },
    { x, y: s.ctl.slice(start), type: 'scatter', mode: 'lines', name: 'Fitness', line: { color: '#2563eb', width: 2.6, shape: 'spline' }, hovertemplate: 'Fitness %{y}<extra></extra>' },
    { x, y: s.atl.slice(start), type: 'scatter', mode: 'lines', name: 'Fatigue', line: { color: '#db2777', width: 1.6, shape: 'spline' }, hovertemplate: 'Fatigue %{y}<extra></extra>' }
  ], plotLayout({ bargap: 0.1, xaxis: { type: 'date', tickformat: '%d %b' } }), PLOT_CONFIG);
}

function renderWeeklyChart() {
  const el = $('#weeklyChart');
  if (!plotReady()) return chartEmpty(el, 'Charts unavailable.');
  const weeks = weeklyTotals(trendsCache.workouts);
  if (!weeks.length) return chartEmpty(el, 'No rides yet.');
  const map = new Map(weeks.map(w => [w.week, w]));
  const thisWeek = startOfWeek(new Date());
  const xs = [], ys = [], txt = [];
  for (let k = 15; k >= 0; k--) {
    const key = formatLocalDate(addDays(thisWeek, -7 * k));
    const e = map.get(key) || { dist: 0, sec: 0, asc: 0, trimp: 0, count: 0 };
    const v = weeklyMetric === 'dist' ? round(e.dist, 1) : weeklyMetric === 'sec' ? round(e.sec / 3600, 1) : weeklyMetric === 'asc' ? Math.round(e.asc) : Math.round(e.trimp);
    xs.push(key);
    ys.push(v);
    txt.push(`${e.count} ride${e.count === 1 ? '' : 's'} · ${fmtNum(e.dist, 1)} km · ${formatHours(e.sec)} · ${Math.round(e.asc)} m`);
  }
  const unit = { dist: 'km', sec: 'h', asc: 'm', trimp: 'TRIMP' }[weeklyMetric];
  el.innerHTML = '';
  Plotly.react(el, [{
    x: xs, y: ys, type: 'bar', text: txt,
    marker: { color: xs.map((_, i) => (i === xs.length - 1 ? '#fc5200' : 'rgba(252,82,0,0.45)')), line: { width: 0 } },
    hovertemplate: `Week of %{x|%d %b}: <b>%{y} ${unit}</b><br>%{text}<extra></extra>`
  }], plotLayout({ hovermode: 'closest', bargap: 0.25, xaxis: { type: 'date', tickformat: '%d %b' } }), PLOT_CONFIG);
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
function bestOf(workouts, field, d) {
  let best = null;
  for (const w of workouts) {
    if (field === 'mmp' && w.power_source !== 'meter') continue;
    const v = w[field] && w[field][d];
    if (v && (!best || v > best.v)) best = { v, w };
  }
  return best;
}

function renderBestEffortsTable() {
  const host = $('#bestEfforts');
  const all = trendsCache.workouts;
  const recent = all.filter(w => parseSafeDate(w.date) >= addDays(new Date(), -42));
  const groups = [
    { name: 'Speed', field: 'best_spd', durs: [60, 300, 1200, 3600], fmt: v => `${fmtNum(v, 1)} km/h` },
    { name: 'Heart rate', field: 'best_hr', durs: [60, 300, 1200, 3600], fmt: v => `${Math.round(v)} bpm` },
    { name: 'Power (meter)', field: 'mmp', durs: [5, 60, 300, 1200, 3600], fmt: v => `${Math.round(v)} W` }
  ].filter(g => all.some(w => w[g.field] && (g.field !== 'mmp' || w.power_source === 'meter')));
  if (!groups.length) { host.innerHTML = '<div class="card small muted">Best efforts appear once rides with streams are synced.</div>'; return; }
  host.innerHTML = groups.map(g => `
    <div class="table-wrap mb-8"><table class="dtable">
      <thead><tr><th>${g.name}</th>${g.durs.map(d => `<th>${BEST_LABELS[d]}</th>`).join('')}</tr></thead>
      <tbody>
        <tr><td>All time</td>${g.durs.map(d => { const b = bestOf(all, g.field, d); return `<td>${b ? `<a class="pb-link" onclick="openRide(${b.w.id})">${g.fmt(b.v)}</a>` : '--'}</td>`; }).join('')}</tr>
        <tr><td>6 weeks</td>${g.durs.map(d => { const b = bestOf(recent, g.field, d); return `<td>${b ? g.fmt(b.v) : '--'}</td>`; }).join('')}</tr>
      </tbody></table></div>`).join('') + '<div class="hint">Tap an all-time value to open that ride.</div>';
}

function setupGlobalMetricPills() {
  $('#globalMetricPills').innerHTML = Object.keys(GLOBAL_METRICS).map(m =>
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
  setupGlobalMetricPills();
  const el = $('#globalChart');
  const workouts = trendsCache.workouts;
  if (!plotReady()) return chartEmpty(el, 'Charts unavailable.');
  if (workouts.length < 2) return chartEmpty(el, 'Log at least 2 rides to plot progression.');

  const x = workouts.map(w => `R${w.ride_number}`);
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
  el.innerHTML = '';
  Plotly.react(el, traces, plotLayout({
    width,
    margin: { l: 10, r: 10, t: 10, b: 30 },
    yaxis: { range: [0, 105], showticklabels: false, dtick: 25 },
    xaxis: { type: 'category' }
  }), Object.assign({}, PLOT_CONFIG, { responsive: false }));
  if (el.removeAllListeners) el.removeAllListeners('plotly_hover');
  el.on('plotly_hover', data => {
    const pt = data.points && data.points[0];
    const w = pt && workouts[pt.pointIndex];
    if (w) $('#global_banner_sub').textContent = `${rideTitle(w)} — ${formatFullDateWithDay(w.date)}: ${fmtNum(w.distance_km, 1)} km, ${fmtNum(w.avg_speed_kmh, 1)} km/h, ${w.avg_hr || '--'} bpm, ${Math.round(num(w.elevation_gain_m))} m`;
  });
  el.on('plotly_click', data => {
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
    const reply = await callGemini(await buildGraphPrompt(workouts, globalSelectedMetrics), null, { onDelta: liveBubble($('#graphChatThread'), 'Season analyst') });
    if (reply) await db.graph_threads.add({ metric_key: graphMetricKey(), role: 'coach', message: reply, created_at: new Date().toISOString() });
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
    const reply = await callGemini(buildGraphReplyPrompt(globalSelectedMetrics, dialogue), null, { onDelta: liveBubble($('#graphChatThread'), 'Season analyst') });
    if (reply) await db.graph_threads.add({ metric_key: key, role: 'coach', message: reply, created_at: new Date().toISOString() });
  } finally {
    graphAiBusy = false;
    await renderGraphChatThread();
  }
}
