'use strict';
// --------------------------------------------------------
// RIDE DETAIL PANEL: metrics, zones, deltas, stream chart, AI chat
// --------------------------------------------------------
let currentWorkout = null;
let activeStream = null;
let selectedMetrics = ['Speed (km/h)', 'Heart Rate (bpm)', 'Elevation (m)'];
let rideAiBusy = false;
let rideBusyFor = null; // strava_id of the session the coach is answering
const attachments = { RIDE: null, HUB: null };

async function openRide(id, { keepScroll = false, scrollToCoach = false } = {}) {
  const w = await db.workouts.get(id);
  if (!w) { toast('Ride not found.', 'error'); return; }
  const row = await db.streams.get(Number(w.strava_id));
  activeStream = row ? row.stream_data : null;
  currentWorkout = await ensureRideMetrics(w, activeStream);

  const panel = $('#rideDetail');
  if (!panel.classList.contains('open')) {
    const onClose = () => { currentWorkout = null; activeStream = null; if (Router.current === 'rides') renderRides(); };
    // Container transform: the tapped card grows into the detail screen
    const card = $(`.ride-card[data-id="${id}"]`);
    if (card && canViewTransition() && card.getBoundingClientRect().bottom > 0) {
      card.style.viewTransitionName = 'ride-morph';
      await viewSwap(async () => {
        card.style.viewTransitionName = '';
        panel.classList.add('no-anim');
        panel.style.viewTransitionName = 'ride-morph';
        openPanel('rideDetail', onClose);
        $('#detBody').scrollTop = 0;
        await renderRideDetail();
      }, 'morph');
      setTimeout(() => { panel.style.viewTransitionName = ''; panel.classList.remove('no-anim'); }, 600);
      if (scrollToCoach) setTimeout(() => $('#coachSection').scrollIntoView({ behavior: 'smooth', block: 'start' }), 450);
      countUp($('#det_hero'));
      return;
    }
    openPanel('rideDetail', onClose);
  }
  if (!keepScroll) $('#detBody').scrollTop = 0;
  await renderRideDetail();
  countUp($('#det_hero'));
  if (scrollToCoach) setTimeout(() => $('#coachSection').scrollIntoView({ behavior: 'smooth', block: 'start' }), 350);
}

async function renderRideDetail() {
  const w = currentWorkout;
  if (!w) return;
  $('#det_title').textContent = rideTitle(w);
  $('#det_sub').textContent = rideSubtitle(w);

  const sp = sportOf(w);
  const meta = SPORTS[sp];
  const badges = [`<span class="badge badge-sport" style="--sc:${meta.color}">${icon(meta.icon, 'ic-xs')}${escapeHtml(meta.label)}</span>`, intentBadge(w, true)];
  if (isIndoor(w)) badges.push('<span class="badge badge-play">Indoor</span>');
  if (w.source === 'health') badges.push(`<span class="badge badge-play">Galaxy Watch</span>`);
  if (w.device_watts) badges.push('<span class="badge badge-ok">Power meter</span>');
  if (w.sport_type && !['Ride', 'Run', 'Swim'].includes(w.sport_type) && w.source !== 'health') {
    const pretty = w.sport_type.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/E Bike|E Mountain/g, m => m.replace(' ', '-')).toLowerCase().replace(/^./, c => c.toUpperCase());
    badges.push(`<span class="badge badge-play">${escapeHtml(pretty)}</span>`);
  }
  for (const n of flagNotes(w).filter(x => !x.startsWith('indoor'))) badges.push(`<button class="badge badge-flag" onclick="openQualitySheet(${w.id})">${icon('flag', 'ic-xs')}${escapeHtml(n)}</button>`);
  if (!parseIntent(w) && w.intent_type !== 'PLAY') badges.push(`<button class="btn btn-secondary btn-xs" onclick="editCurrentRideIntent()">${icon('target', 'ic-sm')}Set intent</button>`);
  $('#det_badges').innerHTML = badges.join('');

  const userW = await getAthleteWeightForDate(w.date);
  const wpk = userW && w.avg_power_w > 0 ? (w.avg_power_w / userW).toFixed(2) : null;
  const box = (v, l, flag, count) => `<div class="hero-box${flag ? ' flagged' : ''}"${flag ? ` onclick="openQualitySheet(${w.id}, '${flag}')"` : ''}><div class="hero-val"${count !== undefined ? ` data-count="${count}"` : ''}>${v}</div><div class="hero-lbl">${l}</div></div>`;
  const fl = k => (isFlagged(w, k) ? k : '');
  const ctx = { box, fl, wpk, userW, all: await db.workouts.toArray() };
  $('#det_hero').innerHTML = detailHeroBoxes(w, ctx).join('');
  $('#det_secondary').innerHTML = detailStatsHtml(w, ctx);
  applyDetailLabels(w);

  renderRouteCard(w, activeStream);
  renderFeel(w);
  renderCardiacZones(w);
  renderSwimSection(w);
  await renderDeltaTable(w);
  await renderBestEfforts(w);

  const hasDist = sp === 'ride' || sp === 'run';
  $('#banner_line1_l').textContent = `⏱ ${rideDuration(w)}`;
  $('#banner_line1_r').textContent = hasDist ? `📏 ${distText(w)}` : '';
  $('#banner_line2_l').textContent = hasDist ? `⚡ Avg ${speedText(w)}` : '';
  $('#banner_line2_r').textContent = `❤️ ${w.avg_hr || '--'} bpm${hasDist && !isIndoor(w) ? ` · ⛰ ${Math.round(num(w.elevation_gain_m))} m` : ''}`;

  setupMetricPills();
  setTimeout(renderStreamPlot, 60);
  await refreshDebriefState();
  await renderChatThread();
}

// Power-meter rides only: NP, IF, TSS (Coggan, as in GoldenCheetah)
function powerKvHtml(w, all) {
  if (w.power_source !== 'meter' || !(w.np_w > 0)) return '';
  const ftp = currentFtp(all);
  const st = rideStress(w, ftp);
  return `<div class="kv"><span class="k">Normalized power</span><span class="v">${w.np_w} W</span></div>
    <div class="kv"><span class="k">IF / TSS</span><span class="v">${st ? `${st.IF.toFixed(2)} / ${st.TSS}` : '--'} <span class="tiny muted">${ftp ? `FTP ${ftp.w}${ftp.source === 'set' ? '' : ' auto'}` : 'set FTP'}</span></span></div>`;
}

// ---------- Feel, RPE, note ----------
const FEELINGS = [['awful', '😫', 'Awful'], ['bad', '😕', 'Tough'], ['ok', '😐', 'OK'], ['good', '🙂', 'Good'], ['great', '😄', 'Great']];
const RPE_LABELS = ['', 'Very easy', 'Easy', 'Easy', 'Moderate', 'Moderate', 'Hard', 'Hard', 'Very hard', 'Very hard', 'Max'];

function rpeColor(n) {
  return n <= 3 ? '#16a34a' : n <= 5 ? '#eab308' : n <= 7 ? '#fc5200' : '#ef4444';
}

function renderFeel(w) {
  $('#det_feel').innerHTML = FEELINGS.map(([k, e, t]) => `<button class="feel-btn ${w.feel === k ? 'selected' : ''}" onclick="setFeel('${k}')"><span class="e">${e}</span><span class="t">${t}</span></button>`).join('');
  $('#det_rpe').innerHTML = Array.from({ length: 10 }, (_, i) => i + 1).map(n => `<button class="rpe-btn ${w.rpe === n ? 'selected' : ''}" style="${w.rpe === n ? `background:${rpeColor(n)}` : ''}" onclick="setRpe(${n})">${n}</button>`).join('');
  $('#det_rpe_label').textContent = w.rpe ? `RPE ${w.rpe} · ${RPE_LABELS[w.rpe]}` : 'not rated yet';
  const note = $('#det_note');
  note.value = w.note || '';
  note.oninput = debounce(() => saveRideField('note', note.value.trim().slice(0, 1000)), 600);
}

async function saveRideField(field, value) {
  if (!currentWorkout) return;
  currentWorkout[field] = value;
  await db.workouts.update(currentWorkout.id, { [field]: value });
}

async function setFeel(k) {
  const v = currentWorkout && currentWorkout.feel === k ? null : k;
  await saveRideField('feel', v);
  haptic('light');
  renderFeel(currentWorkout);
}

async function setRpe(n) {
  const v = currentWorkout && currentWorkout.rpe === n ? null : n;
  await saveRideField('rpe', v);
  haptic('light');
  renderFeel(currentWorkout);
}

// ---------- Best efforts in this ride ----------
async function renderBestEfforts(w) {
  const wrap = $('#det_best_wrap');
  const rows = bestEffortRows(w);
  if (!rows.length) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  $('#det_best').innerHTML = rows.map(([name, cells]) => `
    <div class="table-wrap mb-8"><table class="dtable"><thead><tr><th>${name}</th>${cells.map(c => `<th>${c[0]}</th>`).join('')}</tr></thead>
    <tbody><tr><td>Best</td>${cells.map(c => `<td>${c[1]}</td>`).join('')}</tr></tbody></table></div>`).join('');
}

function renderCardiacZones(w) {
  const box = $('#det_zone_bars');
  $('#det_zone_note').textContent = `max ${PHYSIO.max_hr} bpm`;
  const z = Array.isArray(w.zone_seconds) ? w.zone_seconds : [];
  const tot = z.reduce((a, b) => a + num(b), 0);
  if (!tot) {
    box.innerHTML = `<div class="small muted">No heart-rate stream for this ride, so zone time can't be measured.</div>`;
    return;
  }
  box.innerHTML = PHYSIO.zones.map((zz, i) => {
    const sec = num(z[i]);
    const pct = Math.round((sec / tot) * 100);
    return `<div class="zone-row">
      <span class="zone-tag">${zz.key} ${escapeHtml(zz.name)}<small>${zoneRangeText(i)}</small></span>
      <div class="zone-bar"><div class="zone-fill" data-w="${pct}" style="background:${zz.color}"></div></div>
      <span class="zone-val">${formatDuration(sec)} · ${pct}%</span>
    </div>`;
  }).join('');
  requestAnimationFrame(() => $$('.zone-fill', box).forEach(el => { el.style.width = `${el.dataset.w}%`; }));
}

function deltaCell(diff, d, unit, lowerIsBetter = false) {
  if (!Number.isFinite(diff)) return '<span class="neu">--</span>';
  const r = round(diff, d);
  const cls = r === 0 ? 'neu' : ((r > 0) !== lowerIsBetter ? 'pos' : 'neg');
  return `<span class="${cls}">${signed(r, d, unit)}</span>`;
}

async function renderDeltaTable(w) {
  const all = await db.workouts.orderBy('date').toArray();
  const { rides, basis } = priorComparable(w, all);
  const host = $('#det_delta');
  if (!rides.length) {
    host.innerHTML = `<div class="card small muted">First ${escapeHtml(sportMeta(w).label.toLowerCase())} recorded for this intent (${escapeHtml(getCleanIntentLabel(w))}) — it becomes the baseline.</div>`;
    return;
  }
  const p = aggregateRides(rides);
  const sp = sportOf(w);
  const na = '<span class="neu">--</span>';
  const okD = hasVal(mv(w, 'distance_km'));
  const rows = [];
  if (sp === 'swim') {
    const avgOf = fn => { const v = rides.map(fn).filter(x => x > 0); return v.length ? mean(v) : null; };
    const pace = swimPace100(w), pPace = avgOf(swimPace100);
    const sw = swimOf(w), pSwolf = avgOf(r => swimOf(r) && swimOf(r).swolf), pSpl = avgOf(r => swimOf(r) && swimOf(r).spl);
    rows.push(['Distance', distText(w), `${Math.round(p.avgDist * 1000)} m`, deltaCell((num(w.distance_km) - p.avgDist) * 1000, 0, ' m')]);
    rows.push(['Pace /100 m', pace ? fmtPace(pace) : '--', pPace ? fmtPace(pPace) : '--', pace && pPace ? deltaCell(pace - pPace, 0, ' s', true) : na]);
    if (sw && sw.swolf) rows.push(['SWOLF', String(sw.swolf), pSwolf ? fmtNum(pSwolf, 1) : '--', pSwolf ? deltaCell(sw.swolf - pSwolf, 1, '', true) : na]);
    if (sw && sw.spl) rows.push(['Strokes / length', String(sw.spl), pSpl ? fmtNum(pSpl, 1) : '--', pSpl ? deltaCell(sw.spl - pSpl, 1, '', true) : na]);
  } else if (sp !== 'other') {
    rows.push(['Distance', okD ? distText(w) : 'flagged', distText(w, p.avgDist), okD ? deltaCell(num(w.distance_km) - p.avgDist, 2, ' km') : na]);
    rows.push([`${speedName(w)} (weighted)`, okD ? speedText(w) : 'flagged', p.speed ? speedText(w, p.speed) : '--', okD && p.speed ? (sp === 'ride' ? deltaCell(num(w.avg_speed_kmh) - p.speed, 1, ' km/h') : `<span class="${w.avg_speed_kmh > p.speed ? 'pos' : 'neg'}">${w.avg_speed_kmh > p.speed ? 'faster' : 'slower'}</span>`) : na]);
    if (sp === 'run' && w.avg_cadence) { const c = rides.map(r => r.avg_cadence).filter(Boolean); if (c.length) rows.push(['Cadence', `${w.avg_cadence} spm`, `${Math.round(mean(c))} spm`, deltaCell(w.avg_cadence - mean(c), 0, ' spm')]); }
  } else {
    rows.push(['Time', rideDuration(w), formatDuration(p.sec / rides.length), deltaCell((num(w.moving_sec) - p.sec / rides.length) / 60, 0, ' min')]);
  }
  rows.push(['HR (weighted)', mv(w, 'avg_hr') ? `${w.avg_hr} bpm` : '--', p.hr ? `${Math.round(p.hr)} bpm` : '--', mv(w, 'avg_hr') && p.hr ? deltaCell(w.avg_hr - p.hr, 0, ' bpm', true) : na]);
  if (sp === 'ride' || (sp === 'run' && !isIndoor(w))) rows.push(['Ascent', hasVal(mv(w, 'elevation_gain_m')) ? `${Math.round(num(w.elevation_gain_m))} m` : 'flagged', `${Math.round(p.avgAsc)} m`, hasVal(mv(w, 'elevation_gain_m')) ? deltaCell(num(w.elevation_gain_m) - p.avgAsc, 0, ' m') : na]);
  if (hasVal(w.trimp) && p.trimp > 0) {
    const avgLoad = p.trimp / rides.filter(r => hasVal(r.trimp)).length;
    rows.push(['Load', `${Math.round(w.trimp)}`, `${Math.round(avgLoad)}`, deltaCell(w.trimp - avgLoad, 0, '')]);
  }
  host.innerHTML = `
    <div class="table-wrap"><table class="dtable">
      <thead><tr><th>Metric</th><th>This ${escapeHtml(SPORTS[sp].label.toLowerCase())}</th><th>Prior ${rides.length} avg</th><th>Δ</th></tr></thead>
      <tbody>${rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td>${r[3]}</td></tr>`).join('')}</tbody>
    </table></div>
    <div class="hint mt-8">Compared with: ${escapeHtml(basis)}</div>`;
}

// --------------------------------------------------------
// STREAM CHART
// --------------------------------------------------------
function setupMetricPills() {
  const available = currentWorkout ? streamMetricsFor(currentWorkout, activeStream) : [];
  // Keep the athlete's choice where it fits this sport; otherwise sensible defaults
  const kept = selectedMetrics.filter(m => available.includes(m));
  if (!kept.length) selectedMetrics = available.filter(m => /Speed|Pace|Heart|Elevation/.test(m)).slice(0, 3);
  else selectedMetrics = kept;
  $('#metricPills').innerHTML = available.length > 1 ? available.map(m => `<button class="chip ${selectedMetrics.includes(m) ? 'active' : ''}" onclick="toggleMetric('${m}')">${m}</button>`).join('') : '';
}

function toggleMetric(m) {
  if (selectedMetrics.includes(m)) {
    if (selectedMetrics.length > 1) selectedMetrics = selectedMetrics.filter(x => x !== m);
  } else {
    selectedMetrics.push(m);
  }
  setupMetricPills();
  renderStreamPlot();
}

function renderStreamPlot() {
  const el = $('#detailChart');
  const w = currentWorkout;
  if (!el || !w) return;
  if (!plotReady()) { chartEmpty(el, 'Charts unavailable.'); return; }
  if (!activeStream || !activeStream.time) { chartEmpty(el, 'No second-by-second data was recorded for this workout.'); return; }

  const n = activeStream.time.data.length;
  const idx = strideIndices(n, 1400);
  const pick = (arr, f = v => v) => (arr ? idx.map(i => f(arr[i])) : []);
  const times = pick(activeStream.time.data, t => round(t / 60, 1));
  const dists = pick(activeStream.distance && activeStream.distance.data, d => round(d / 1000, 2));
  const speedsFull = activeStream.velocity_smooth ? smoothStreamArray(activeStream.velocity_smooth.data.map(v => num(v) * 3.6), 5) : null;
  const speeds = pick(speedsFull, v => round(v, 1));
  const hrs = pick(activeStream.heartrate && activeStream.heartrate.data);
  const alts = pick(activeStream.altitude && activeStream.altitude.data);
  const watts = pick(activeStream.watts && activeStream.watts.data);
  const cad = pick(activeStream.cadence && activeStream.cadence.data);

  const traces = [];
  const norm = (arr, lo, hi) => arr.map(v => (hasVal(v) ? Math.max(0, Math.min(100, ((v - lo) / (hi - lo || 1)) * 100)) : null));

  if (selectedMetrics.includes('Elevation (m)') && alts.length) {
    const lo = safeMin(alts), hi = safeMax(alts, 1);
    traces.push({ x: times, y: alts.map(a => ((a - lo) / (hi - lo || 1)) * 40), name: 'Elevation', text: alts.map(a => `${Math.round(a)} m`), hovertemplate: '⛰ %{text}<extra></extra>', type: 'scatter', fill: 'tozeroy', fillcolor: 'rgba(148,163,184,0.18)', line: { color: '#94a3b8', width: 1.2 } });
  }
  if (selectedMetrics.includes('Heart Rate (bpm)') && hrs.length) {
    traces.push({ x: times, y: norm(hrs, Math.max(60, PHYSIO.resting_hr), PHYSIO.max_hr), name: 'Heart rate', text: hrs.map(h => `${h} bpm`), hovertemplate: '❤️ %{text}<extra></extra>', type: 'scatter', line: { color: '#ef4444', width: 1.8 } });
  }
  if (selectedMetrics.includes('Power (Watts)') && (watts.length || w.avg_power_w > 0)) {
    const src = watts.length ? smoothStreamArray(watts.map(num), 5) : times.map(() => w.avg_power_w);
    const peak = Math.max(safeMax(src, 0), w.max_power_w || 0, 300);
    traces.push({ x: times, y: norm(src, 0, peak), name: 'Power', text: src.map(v => `${Math.round(v)} W${watts.length ? '' : ' (avg est)'}`), hovertemplate: '⚡ %{text}<extra></extra>', type: 'scatter', line: { color: '#fc5200', width: 1.6, dash: watts.length ? 'solid' : 'dot' } });
  }
  if ((selectedMetrics.includes('Speed (km/h)') || selectedMetrics.includes('Pace')) && speeds.length) {
    const peak = Math.max(safeMax(speeds, 0), 1);
    const isRun = sportOf(w) === 'run';
    traces.push({ x: times, y: norm(speeds, 0, peak), name: isRun ? 'Pace' : 'Speed', text: speeds.map(s => (isRun ? speedText(w, s) : `${s} km/h`)), hovertemplate: `${isRun ? '🏃' : '🚴'} %{text}<extra></extra>`, type: 'scatter', line: { color: isRun ? '#16a34a' : '#2563eb', width: 1.8 } });
  }
  if ((selectedMetrics.includes('Cadence (RPM)') || selectedMetrics.includes('Cadence (spm)')) && cad.length) {
    const unit = sportOf(w) === 'run' ? 'spm' : 'rpm';
    traces.push({ x: times, y: norm(cad, 0, Math.max(safeMax(cad, 0), 1)), name: 'Cadence', text: cad.map(c => `${c} ${unit}`), hovertemplate: '🔄 %{text}<extra></extra>', type: 'scatter', line: { color: '#8b5cf6', width: 1.2 } });
  }
  if (!traces.length) return chartEmpty(el, 'No samples for the selected metrics.');

  drawChart(el, traces, plotLayout({
    margin: { l: 8, r: 8, t: 8, b: 28 },
    xaxis: { ticksuffix: 'm', showgrid: false },
    yaxis: { range: [0, 105], showticklabels: false, dtick: 25 }
  }));

  if (el.on) el.on('plotly_hover', data => {
    const pt = data.points && data.points[0];
    if (!pt) return;
    const i = pt.pointIndex;
    $('#banner_line1_l').textContent = `⏱ ${times[i]} min`;
    $('#banner_line1_r').textContent = `📏 ${dists[i] !== undefined ? dists[i] + ' km' : '--'}`;
    $('#banner_line2_l').textContent = `⚡ ${speeds[i] !== undefined ? speeds[i] + ' km/h' : '--'}${watts[i] !== undefined ? ` · ${Math.round(watts[i])} W` : ''}`;
    $('#banner_line2_r').textContent = `❤️ ${hrs[i] || '--'} bpm · ⛰ ${alts[i] !== undefined ? Math.round(alts[i]) + ' m' : '--'}`;
  });
}

// --------------------------------------------------------
// AI DEBRIEF + CHAT
// --------------------------------------------------------
function bubbleHtml(m, coachLabel = 'AI Coach') {
  const coach = m.role === 'coach';
  const meta = coach ? aiMetaLabel(m) : '';
  return `<div class="bubble ${coach ? 'bubble-coach' : 'bubble-athlete'}${m.pending ? ' pending' : ''}">
    <div class="bubble-sender"><span>${coach ? escapeHtml(coachLabel) : escapeHtml(ATHLETE.name)}</span><span>${m.created_at ? escapeHtml(relativeTime(m.created_at)) : ''}</span></div>
    ${m.image_b64 ? `<img class="attach" src="${m.image_b64}" alt="attachment" />` : ''}
    <div class="md">${coach ? renderMarkdown(m.message) : escapeHtml(m.message || '').replace(/\n/g, '<br>')}</div>
    ${meta ? `<div class="bubble-meta">${icon('sparkle', 'ic-xs')}${escapeHtml(meta)}</div>` : ''}
  </div>`;
}

async function refreshDebriefState() {
  const w = currentWorkout;
  if (!w) return;
  const has = await hasCoachDebrief(w.strava_id);
  const badge = $('#det_status_badge');
  const box = $('#sessionActionBox');
  if (!has) {
    badge.innerHTML = '<span class="badge badge-new">Needs analysis</span>';
    box.innerHTML = `<button class="btn btn-primary" id="btnDebrief" onclick="runSingleRideDebrief()">${icon('sparkle')}Analyze this ride with the AI coach</button>`;
  } else if (w.debrief_stale) {
    badge.innerHTML = '<span class="badge badge-stale">Context changed</span>';
    box.innerHTML = `<button class="btn btn-secondary" id="btnDebrief" onclick="runSingleRideDebrief()">${icon('refresh')}Re-evaluate with updated intent</button>`;
  } else {
    badge.innerHTML = '<span class="badge badge-ok">Up to date</span>';
    box.innerHTML = '';
  }
}

async function renderChatThread(extraHtml = '') {
  const host = $('#chatThread');
  const w = currentWorkout;
  if (!w) { host.innerHTML = ''; return; }
  const msgs = await rideThreads(w.strava_id).toArray();
  const busyHere = rideAiBusy && rideBusyFor === Number(w.strava_id);
  let html = msgs.length
    ? msgs.map(m => bubbleHtml(m) + (m.pending && !busyHere ? `<div class="retry-card"><span>Not answered yet.</span><button class="btn btn-primary btn-xs" onclick="executeRideMessageDispatch(${m.id})">${icon('refresh', 'ic-sm')}Retry</button></div>` : '')).join('')
    : `<div class="bubble bubble-coach"><div class="bubble-sender"><span>AI Coach</span></div>Tap <b>Analyze</b> above for a full debrief, or ask me anything about this ${escapeHtml(sportMeta(w).label.toLowerCase())} below. You can attach a screenshot too.</div>`;
  if (busyHere && !extraHtml) extraHtml = typingHtml('Coach is still writing');
  host.innerHTML = html + extraHtml;
}

function scrollDetailToEnd() {
  const body = $('#detBody');
  body.scrollTo({ top: body.scrollHeight, behavior: 'smooth' });
}

async function runSingleRideDebrief(targetRide) {
  const w = targetRide || currentWorkout;
  if (!w) return;
  if (rideAiBusy) { toast('The coach is still answering — please wait.', 'warn'); return; }
  rideAiBusy = true;
  rideBusyFor = Number(w.strava_id);
  const btn = $('#btnDebrief');
  setBusy(btn, true, 'Analyzing…');
  const viewing = () => currentWorkout && Number(currentWorkout.strava_id) === Number(w.strava_id);
  if (viewing()) { await renderChatThread(typingHtml('Coach is analysing this session')); scrollDetailToEnd(); }
  try {
    const prompt = await buildRideDebriefPrompt(w);
    const meta = {};
    const live = liveBubble($('#chatThread'), 'AI Coach', scrollDetailToEnd);
    const reply = await callAI(prompt, null, { agent: 'ride', meta, onStatus: aiStatusIn($('#chatThread')), onDelta: t => { if (viewing()) live(hideMemoryTags(t)); } });
    if (reply) {
      const text = await captureMemory(reply, rideCode(w));
      // Only the previous debrief is replaced; follow-up questions and answers stay
      const old = (await rideThreads(w.strava_id).toArray()).filter(t => t.role === 'coach' && t.kind !== 'chat');
      await db.threads.bulkDelete(old.filter((t, i) => i === 0).map(t => t.id));
      await db.threads.add(Object.assign({ strava_id: Number(w.strava_id), ride_number: w.ride_number, role: 'coach', kind: 'debrief', message: text, created_at: new Date().toISOString() }, aiMetaFields(meta)));
      await db.workouts.update(w.id, { debrief_stale: false });
      w.debrief_stale = false;
      if (viewing()) currentWorkout.debrief_stale = false;
      toast('Debrief ready', 'success', 1800);
    }
  } catch (e) {
    toast(`Debrief failed: ${e.message}`, 'error', 5000);
  } finally {
    rideAiBusy = false;
    rideBusyFor = null;
    setBusy(btn, false);
    if (viewing()) { await refreshDebriefState(); await renderChatThread(); }
  }
}

// Messages are saved immediately (pending until answered) — see resumePendingChats
async function sendAthleteReply() {
  if (!currentWorkout) return;
  if (rideAiBusy) { toast('The coach is still answering — please wait.', 'warn'); return; }
  const input = $('#replyInput');
  const text = input.value.trim();
  const img = attachments.RIDE;
  if (!text && !img) return;
  input.value = '';
  autoGrow(input);
  clearAttachment('RIDE');
  const id = await db.threads.add({ strava_id: Number(currentWorkout.strava_id), ride_number: currentWorkout.ride_number, role: 'athlete', message: text, image_b64: img, created_at: new Date().toISOString(), pending: true });
  await executeRideMessageDispatch(id);
}

async function executeRideMessageDispatch(id) {
  const msg = await db.threads.get(id);
  if (!msg || rideAiBusy) return;
  rideAiBusy = true;
  rideBusyFor = Number(msg.strava_id);
  const viewing = () => currentWorkout && Number(currentWorkout.strava_id) === rideBusyFor;
  if (viewing()) { await renderChatThread(typingHtml()); scrollDetailToEnd(); }
  try {
    const w = await db.workouts.where('strava_id').equals(Number(msg.strava_id)).first();
    if (!w) throw new Error('Workout no longer exists.');
    const prompt = await buildRideChatPrompt(w, msg.message, !!msg.image_b64, id);
    const meta = {};
    const live = liveBubble($('#chatThread'), 'AI Coach', scrollDetailToEnd);
    const reply = await callAI(prompt, msg.image_b64, { agent: 'ride', meta, onStatus: aiStatusIn($('#chatThread')), onDelta: t => { if (viewing()) live(hideMemoryTags(t)); } });
    if (reply) {
      haptic('success');
      const text = await captureMemory(reply, rideCode(w));
      await db.threads.update(id, { pending: false });
      await db.threads.add(Object.assign({ strava_id: Number(msg.strava_id), ride_number: w.ride_number, role: 'coach', kind: 'chat', message: text, created_at: new Date().toISOString() }, aiMetaFields(meta)));
      if (!viewing()) toast(`Coach replied about ${rideTitle(w)}`, 'success', 3500);
    }
  } catch (e) {
    toast(`Message failed: ${e.message}`, 'error');
  } finally {
    rideAiBusy = false;
    rideBusyFor = null;
    if (viewing() || (currentWorkout && Number(currentWorkout.strava_id) === Number(msg.strava_id))) { await renderChatThread(); scrollDetailToEnd(); }
  }
}

async function resetActiveRideThread() {
  const w = currentWorkout;
  if (!w) return;
  const ok = await uiConfirm('Reset coach thread?', `This deletes the debrief and all messages for ${rideTitle(w)}.`, { okText: 'Reset', danger: true });
  if (!ok) return;
  await rideThreads(w.strava_id).delete();
  await db.workouts.update(w.id, { debrief_stale: false });
  w.debrief_stale = false;
  clearAttachment('RIDE');
  await refreshDebriefState();
  await renderChatThread();
  toast('Thread reset', 'success', 1600);
}

// --------------------------------------------------------
// IMAGE ATTACHMENTS (compressed to ≤1024 px JPEG)
// --------------------------------------------------------
function handleImageSelection(event, ctx) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      const maxDim = 1024;
      if (width > maxDim || height > maxDim) {
        if (width > height) { height = Math.round((height * maxDim) / width); width = maxDim; }
        else { width = Math.round((width * maxDim) / height); height = maxDim; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      const b64 = canvas.toDataURL('image/jpeg', 0.85);
      attachments[ctx] = b64;
      const pre = ctx === 'RIDE' ? 'ride' : 'hub';
      $(`#${pre}PreviewThumb`).src = b64;
      $(`#${pre}AttachPreview`).classList.remove('hidden');
    };
    img.onerror = () => toast('Could not read that image.', 'error');
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function clearAttachment(ctx) {
  attachments[ctx] = null;
  const pre = ctx === 'RIDE' ? 'ride' : 'hub';
  $(`#${pre}AttachPreview`).classList.add('hidden');
}
