'use strict';
// --------------------------------------------------------
// RIDE DETAIL PANEL: metrics, zones, deltas, stream chart, AI chat
// --------------------------------------------------------
let currentWorkout = null;
let activeStream = null;
let selectedMetrics = ['Speed (km/h)', 'Heart Rate (bpm)', 'Elevation (m)'];
let lastPendingRidePayload = null;
let rideAiBusy = false;
const attachments = { RIDE: null, HUB: null };

async function openRide(id, { keepScroll = false, scrollToCoach = false } = {}) {
  const w = await db.workouts.get(id);
  if (!w) { toast('Ride not found.', 'error'); return; }
  const row = await db.streams.get(Number(w.strava_id));
  activeStream = row ? row.stream_data : null;
  currentWorkout = await ensureRideMetrics(w, activeStream);

  if (!$('#rideDetail').classList.contains('open')) {
    openPanel('rideDetail', () => { currentWorkout = null; activeStream = null; if (Router.current === 'rides') renderRides(); });
  }
  if (!keepScroll) $('#detBody').scrollTop = 0;
  await renderRideDetail();
  if (scrollToCoach) setTimeout(() => $('#coachSection').scrollIntoView({ behavior: 'smooth', block: 'start' }), 350);
}

async function renderRideDetail() {
  const w = currentWorkout;
  if (!w) return;
  $('#det_title').textContent = rideTitle(w);
  $('#det_sub').textContent = `${w.exercise_code || ''} · ${formatNiceDate(w.date)}`;

  const badges = [intentBadge(w, true)];
  if (w.trainer) badges.push('<span class="badge badge-play">Indoor</span>');
  if (w.device_watts) badges.push('<span class="badge badge-ok">Power meter</span>');
  if (w.sport_type && w.sport_type !== 'Ride') badges.push(`<span class="badge badge-play">${escapeHtml(w.sport_type)}</span>`);
  if (!parseIntent(w) && w.intent_type !== 'PLAY') badges.push(`<button class="btn btn-secondary btn-xs" onclick="editCurrentRideIntent()">${icon('target', 'ic-sm')}Set intent</button>`);
  $('#det_badges').innerHTML = badges.join('');

  const userW = await getAthleteWeightForDate(w.date);
  const wpk = userW && w.avg_power_w > 0 ? (w.avg_power_w / userW).toFixed(2) : null;
  $('#det_hero').innerHTML = `
    <div class="hero-box"><div class="hero-val">${fmtNum(w.distance_km, 2)}</div><div class="hero-lbl">km</div></div>
    <div class="hero-box"><div class="hero-val">${escapeHtml(rideDuration(w))}</div><div class="hero-lbl">Moving</div></div>
    <div class="hero-box"><div class="hero-val">${fmtNum(w.avg_speed_kmh, 1)}</div><div class="hero-lbl">Avg km/h</div></div>
    <div class="hero-box"><div class="hero-val">${w.avg_power_w > 0 ? w.avg_power_w + ' W' : '--'}</div><div class="hero-lbl">${w.device_watts ? 'Power' : 'Est. power'}${wpk ? ` · ${wpk} W/kg` : ''}</div></div>
    <div class="hero-box"><div class="hero-val">${w.avg_hr > 0 ? w.avg_hr : '--'}</div><div class="hero-lbl">Avg bpm</div></div>
    <div class="hero-box"><div class="hero-val">${Math.round(num(w.elevation_gain_m))} m</div><div class="hero-lbl">Ascent</div></div>`;

  const gross = grossAscentRate(w);
  const vam = w.climbing_vam ? `${w.climbing_vam} m/h <span class="tiny muted">(>3%)</span>` : (gross > 0 ? `${gross} m/h <span class="tiny muted">(gross)</span>` : '--');
  const pctMax = w.max_hr > 0 ? Math.round((w.max_hr / PHYSIO.max_hr) * 100) : null;
  $('#det_secondary').innerHTML = `
    <div class="kv"><span class="k">Athlete weight</span><span class="v">${userW ? `${userW} kg` : 'Not set'}</span></div>
    <div class="kv"><span class="k">Max speed</span><span class="v">${w.max_speed_kmh ? fmtNum(w.max_speed_kmh, 1) + ' km/h' : '--'}</span></div>
    <div class="kv"><span class="k">Peak heart rate</span><span class="v">${w.max_hr ? `${w.max_hr} bpm` : '--'}${pctMax ? ` <span class="tiny muted">${pctMax}%</span>` : ''}</span></div>
    <div class="kv"><span class="k">Training load</span><span class="v">${hasVal(w.trimp) ? `${Math.round(w.trimp)} TRIMP` : '--'}${w.trimp_source === 'avg' ? ' <span class="tiny muted">(avg HR)</span>' : ''}</span></div>
    <div class="kv"><span class="k">Work done</span><span class="v">${w.kilojoules > 0 ? `${w.kilojoules} kJ` : '--'}</span></div>
    <div class="kv"><span class="k">Climbing VAM</span><span class="v">${vam}</span></div>
    <div class="kv"><span class="k">Aerobic decoupling</span><span class="v">${escapeHtml(decouplingDisplay(w))}</span></div>
    <div class="kv"><span class="k">Elapsed time</span><span class="v">${w.elapsed_sec ? formatDuration(w.elapsed_sec) : '--'}</span></div>
    ${w.norm_power_w > 0 ? `<div class="kv"><span class="k">Normalized power</span><span class="v">${w.norm_power_w} W</span></div>` : ''}`;

  renderCardiacZones(w);
  await renderDeltaTable(w);

  $('#banner_line1_l').textContent = `⏱ ${rideDuration(w)}`;
  $('#banner_line1_r').textContent = `📏 ${fmtNum(w.distance_km, 2)} km`;
  $('#banner_line2_l').textContent = `⚡ Avg ${fmtNum(w.avg_speed_kmh, 1)} km/h`;
  $('#banner_line2_r').textContent = `❤️ ${w.avg_hr || '--'} bpm · ⛰ ${Math.round(num(w.elevation_gain_m))} m`;

  setupMetricPills();
  setTimeout(renderStreamPlot, 60);
  await refreshDebriefState();
  await renderChatThread();
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
    host.innerHTML = `<div class="card small muted">First ride recorded for this intent (${escapeHtml(getCleanIntentLabel(w))}) — it becomes the baseline.</div>`;
    return;
  }
  const p = aggregateRides(rides);
  const rows = [
    ['Distance', `${fmtNum(w.distance_km, 2)} km`, `${fmtNum(p.avgDist, 2)} km`, deltaCell(num(w.distance_km) - p.avgDist, 2, ' km')],
    ['Speed (weighted)', `${fmtNum(w.avg_speed_kmh, 1)} km/h`, `${fmtNum(p.speed, 1)} km/h`, deltaCell(num(w.avg_speed_kmh) - p.speed, 1, ' km/h')],
    ['HR (weighted)', w.avg_hr ? `${w.avg_hr} bpm` : '--', p.hr ? `${Math.round(p.hr)} bpm` : '--', w.avg_hr && p.hr ? deltaCell(w.avg_hr - p.hr, 0, ' bpm', true) : '<span class="neu">--</span>'],
    ['Ascent', `${Math.round(num(w.elevation_gain_m))} m`, `${Math.round(p.avgAsc)} m`, deltaCell(num(w.elevation_gain_m) - p.avgAsc, 0, ' m')]
  ];
  if (hasVal(w.trimp) && p.trimp > 0) {
    const avgLoad = p.trimp / rides.filter(r => hasVal(r.trimp)).length;
    rows.push(['Load', `${Math.round(w.trimp)}`, `${Math.round(avgLoad)}`, deltaCell(w.trimp - avgLoad, 0, '')]);
  }
  host.innerHTML = `
    <div class="table-wrap"><table class="dtable">
      <thead><tr><th>Metric</th><th>This ride</th><th>Prior ${rides.length} avg</th><th>Δ</th></tr></thead>
      <tbody>${rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td>${r[3]}</td></tr>`).join('')}</tbody>
    </table></div>
    <div class="hint mt-8">Compared with: ${escapeHtml(basis)}</div>`;
}

// --------------------------------------------------------
// STREAM CHART
// --------------------------------------------------------
function setupMetricPills() {
  const available = ['Speed (km/h)', 'Heart Rate (bpm)', 'Power (Watts)', 'Elevation (m)'];
  if (activeStream && activeStream.cadence) available.push('Cadence (RPM)');
  $('#metricPills').innerHTML = available.map(m => `<button class="chip ${selectedMetrics.includes(m) ? 'active' : ''}" onclick="toggleMetric('${m}')">${m}</button>`).join('');
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
  if (!activeStream || !activeStream.time) { chartEmpty(el, 'Route stream data is not available for this ride.'); return; }

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
  if (selectedMetrics.includes('Speed (km/h)') && speeds.length) {
    const peak = Math.max(safeMax(speeds, 0), 1);
    traces.push({ x: times, y: norm(speeds, 0, peak), name: 'Speed', text: speeds.map(s => `${s} km/h`), hovertemplate: '🚴 %{text}<extra></extra>', type: 'scatter', line: { color: '#2563eb', width: 1.8 } });
  }
  if (selectedMetrics.includes('Cadence (RPM)') && cad.length) {
    traces.push({ x: times, y: norm(cad, 0, Math.max(safeMax(cad, 0), 1)), name: 'Cadence', text: cad.map(c => `${c} rpm`), hovertemplate: '🔄 %{text}<extra></extra>', type: 'scatter', line: { color: '#8b5cf6', width: 1.2 } });
  }

  el.innerHTML = '';
  Plotly.react(el, traces, plotLayout({
    margin: { l: 8, r: 8, t: 8, b: 28 },
    xaxis: { ticksuffix: 'm', showgrid: false },
    yaxis: { range: [0, 105], showticklabels: false, dtick: 25 }
  }), PLOT_CONFIG);

  if (el.removeAllListeners) el.removeAllListeners('plotly_hover');
  el.on('plotly_hover', data => {
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
  return `<div class="bubble ${coach ? 'bubble-coach' : 'bubble-athlete'}">
    <div class="bubble-sender"><span>${coach ? escapeHtml(coachLabel) : escapeHtml(ATHLETE.name)}</span><span>${m.created_at ? escapeHtml(relativeTime(m.created_at)) : ''}</span></div>
    ${m.image_b64 ? `<img class="attach" src="${m.image_b64}" alt="attachment" />` : ''}
    <div class="md">${coach ? renderMarkdown(m.message) : escapeHtml(m.message || '').replace(/\n/g, '<br>')}</div>
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
  let html = msgs.length
    ? msgs.map(m => bubbleHtml(m)).join('')
    : `<div class="bubble bubble-coach"><div class="bubble-sender"><span>AI Coach</span></div>Tap <b>Analyze</b> above for a full debrief, or ask me anything about this ride below. You can attach a screenshot too.</div>`;
  if (lastPendingRidePayload && Number(lastPendingRidePayload.strava_id) === Number(w.strava_id)) {
    html += bubbleHtml({ role: 'athlete', message: lastPendingRidePayload.text, image_b64: lastPendingRidePayload.image_b64 });
    if (!rideAiBusy) html += `<div class="retry-card"><span>Message not answered.</span><button class="btn btn-primary btn-xs" onclick="retryRideMessage()">${icon('refresh', 'ic-sm')}Retry</button></div>`;
  }
  host.innerHTML = html + extraHtml;
}

function scrollDetailToEnd() {
  const body = $('#detBody');
  body.scrollTo({ top: body.scrollHeight, behavior: 'smooth' });
}

async function runSingleRideDebrief(targetRide) {
  const w = targetRide || currentWorkout;
  if (!w || rideAiBusy) return;
  rideAiBusy = true;
  const btn = $('#btnDebrief');
  setBusy(btn, true, 'Analyzing ride…');
  const viewing = () => currentWorkout && Number(currentWorkout.strava_id) === Number(w.strava_id);
  if (viewing()) { await renderChatThread(typingHtml('Coach is analysing your ride')); scrollDetailToEnd(); }
  try {
    const prompt = await buildRideDebriefPrompt(w);
    const reply = await callGemini(prompt, null);
    if (reply) {
      await db.threads.where('[strava_id+role]').equals([Number(w.strava_id), 'coach']).delete();
      await db.threads.add({ strava_id: Number(w.strava_id), ride_number: w.ride_number, role: 'coach', message: reply, created_at: new Date().toISOString() });
      await db.workouts.update(w.id, { debrief_stale: false });
      w.debrief_stale = false;
      if (viewing()) currentWorkout.debrief_stale = false;
      toast('Debrief ready', 'success', 1800);
    }
  } catch (e) {
    toast(`Debrief failed: ${e.message}`, 'error', 5000);
  } finally {
    rideAiBusy = false;
    setBusy(btn, false);
    if (viewing()) { await refreshDebriefState(); await renderChatThread(); }
  }
}

async function sendAthleteReply() {
  if (!currentWorkout || rideAiBusy) return;
  const input = $('#replyInput');
  const text = input.value.trim();
  const img = attachments.RIDE;
  if (!text && !img) return;
  input.value = '';
  autoGrow(input);
  clearAttachment('RIDE');
  lastPendingRidePayload = { text, image_b64: img, strava_id: Number(currentWorkout.strava_id), ride_number: currentWorkout.ride_number };
  await executeRideMessageDispatch(lastPendingRidePayload);
}

async function retryRideMessage() {
  if (lastPendingRidePayload) await executeRideMessageDispatch(lastPendingRidePayload);
}

async function executeRideMessageDispatch(payload) {
  rideAiBusy = true;
  await renderChatThread(typingHtml());
  scrollDetailToEnd();
  try {
    const w = await db.workouts.where('strava_id').equals(Number(payload.strava_id)).first();
    if (!w) throw new Error('Ride no longer exists.');
    const prompt = await buildRideChatPrompt(w, payload.text, !!payload.image_b64);
    const reply = await callGemini(prompt, payload.image_b64);
    if (reply) {
      const now = new Date().toISOString();
      await db.threads.add({ strava_id: Number(payload.strava_id), ride_number: payload.ride_number, role: 'athlete', message: payload.text, image_b64: payload.image_b64, created_at: now });
      await db.threads.add({ strava_id: Number(payload.strava_id), ride_number: payload.ride_number, role: 'coach', message: reply, created_at: new Date().toISOString() });
      lastPendingRidePayload = null;
    }
  } catch (e) {
    toast(`Message failed: ${e.message}`, 'error');
  } finally {
    rideAiBusy = false;
    await renderChatThread();
    scrollDetailToEnd();
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
  lastPendingRidePayload = null;
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
