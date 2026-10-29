'use strict';
// --------------------------------------------------------
// RIDES FEED + WEEK SUMMARY + INTENT SHEET
// --------------------------------------------------------
let rideFilter = 'all';
let rideQuery = '';
let intentModalQueue = [];
let activeIntentItem = null;
let modalSelectedType = 'TRAINING';
let modalSelectedFormat = 'STEADY';

function intentAccent(w) {
  if (w.intent_type === 'PLAY') return '#94a3b8';
  const it = parseIntent(w);
  if (!it) return 'var(--border)';
  const m = String(it.target_zone || '').match(/Zone\s*(\d)/i);
  const idx = m ? Math.min(4, Math.max(0, +m[1] - 1)) : 1;
  return PHYSIO.zones[idx].color;
}

function intentBadge(w, long = false) {
  if (w.intent_type === 'PLAY') return `<span class="badge badge-play">${long ? 'Play / Commute' : 'Play'}</span>`;
  const it = parseIntent(w);
  if (!it) return '';
  const tag = long ? `${it.target_zone || 'Structured training'}${it.format === 'INTERVAL' ? ` · Intervals ${it.interval_zones || ''} (${it.interval_freq || ''})` : ' · Steady'}` : `${parseZoneTag(it.target_zone) || 'Train'}${it.format === 'INTERVAL' ? ' · Int' : ''}`;
  return `<span class="badge badge-intent">${escapeHtml(tag)}</span>`;
}

function zoneStripHtml(z) {
  if (!Array.isArray(z)) return '';
  const tot = z.reduce((a, b) => a + num(b), 0);
  if (!tot) return '';
  return `<div class="zone-strip">${z.map((s, i) => `<span style="width:${(num(s) / tot) * 100}%;background:${PHYSIO.zones[i].color}"></span>`).join('')}</div>`;
}

function rideCode(w) {
  return w.exercise_code ? w.exercise_code.split(' - ')[0] : `${sportMeta(w).code} ${String(w.ride_number || '').padStart(3, '0')}`;
}

// Strava activity name when known (filled on the next sync for rides imported by v2), else "Ride 012"
function rideTitle(w) {
  return w.name && w.name.trim() ? w.name : rideCode(w);
}

function rideSubtitle(w) {
  const date = formatNiceDate(w.date);
  return w.name && w.name.trim() ? `${rideCode(w)} · ${date}` : date;
}

// One stat in the week card: value, label, optional goal progress, last week's value
function weekStatHtml(value, label, prevText, goalPct, goalText) {
  return `<div class="week-stat">
    <div class="v">${value}</div><div class="l">${label}${goalText ? ` <span class="of">/ ${goalText}</span>` : ''}</div>
    ${goalPct !== null ? `<div class="mini-track"><i style="width:${Math.min(100, goalPct)}%"></i></div>` : ''}
    ${prevText ? `<div class="d">last wk ${prevText}</div>` : ''}
  </div>`;
}

async function renderWeekCard(all) {
  const host = $('#weekCard');
  if (!all.length) { host.innerHTML = ''; return; }
  const { cur, prev, streak } = weekSummary(all.filter(w => !isExcluded(w)));
  const multi = sportsPresent(all).length > 1;
  const rideKm = s => (s.bySport.ride || { dist: 0 }).dist;
  const goals = await getWeeklyGoals(formatLocalDate(startOfWeek(new Date())));
  const todayItem = await todayPlanItem();
  const readiness = await readinessChipHtml();
  const snap = currentLoadSnapshot(computeLoadSeries(all));
  const fs = snap ? formStatus(snap.tsb) : null;
  const ws = startOfWeek(new Date());
  host.innerHTML = `
    <div class="card card-hero">
      <div class="row between" style="position:relative; z-index:1">
        <div>
          <div class="card-title">This week</div>
          <div class="card-sub">${formatNiceDate(formatLocalDate(ws), false)} – ${formatNiceDate(formatLocalDate(addDays(ws, 6)), false)}${streak > 1 ? ` · 🔥 ${streak}-week streak` : ''}</div>
        </div>
        ${fs ? `<span class="form-chip" title="${escapeHtml(fs.label)}">${icon('activity', 'ic-sm')}Form ${signed(snap.tsb, 0)}</span>` : ''}
      </div>
      <div class="week-grid">
        ${weekStatHtml(`<span data-count="${cur.count}">${cur.count}</span>`, multi ? 'sessions' : 'rides', prev.count ? String(prev.count) : '', goals.rides ? (cur.count / goals.rides) * 100 : null, goals.rides ? String(goals.rides) : '')}
        ${weekStatHtml(`<span data-count="${round(rideKm(cur), 1)}">${fmtNum(rideKm(cur), rideKm(cur) >= 100 ? 0 : 1)}</span>`, multi ? 'ride km' : 'km', prev.dist ? fmtNum(rideKm(prev), 0) : '', goals.km ? (rideKm(cur) / goals.km) * 100 : null, goals.km ? String(goals.km) : '')}
        ${weekStatHtml(formatHours(cur.sec), 'time', prev.sec ? formatHours(prev.sec) : '', goals.hours ? (cur.sec / 3600 / goals.hours) * 100 : null, goals.hours ? `${goals.hours}h` : '')}
        ${weekStatHtml(Math.round(cur.asc), 'climb m', prev.asc ? String(Math.round(prev.asc)) : '', null, '')}
      </div>
      ${multi && cur.count ? `<div class="week-sports">${Object.entries(cur.bySport).map(([s, e]) => `<span style="--sc:${SPORTS[s].color}">${icon(SPORTS[s].icon, 'ic-xs')}${e.count} · ${formatHours(e.sec)}</span>`).join('')}</div>` : ''}
      ${fs ? `<div class="week-foot">${escapeHtml(fs.label)} · fitness ${Math.round(snap.ctl)} · fatigue ${Math.round(snap.atl)}</div>` : ''}
    </div>
    ${readiness}
    ${todayItem ? `<div class="today-plan ${todayItem.done ? 'done' : ''}" onclick="switchTab('coach')">
      <span class="plan-dot" style="background:${(PLAN_TYPES[todayItem.type] || PLAN_TYPES.other).color}"></span>
      <span class="grow"><b>Today: ${escapeHtml(todayItem.title)}</b><br><span class="tiny muted">${todayItem.type === 'rest' ? 'Rest day' : `${todayItem.duration_min} min${todayItem.zone ? ` · ${escapeHtml(todayItem.zone)}` : ''}`}${todayItem.done ? ' · done ✓' : ''}</span></span>
      ${icon('chevron', 'ic-sm muted')}</div>` : ''}`;
}

function rideMatches(w, coachIds) {
  if (sportFilter !== 'all' && sportOf(w) !== sportFilter) return false;
  if (rideFilter === 'TRAINING' && !(w.intent_type === 'TRAINING' && parseIntent(w))) return false;
  if (rideFilter === 'PLAY' && w.intent_type !== 'PLAY') return false;
  if (rideFilter === 'NONE' && (w.intent_type === 'PLAY' || parseIntent(w))) return false;
  if (rideFilter === 'REVIEW' && coachIds.has(Number(w.strava_id)) && !w.debrief_stale) return false;
  if (!rideQuery) return true;
  const hay = `${w.name || ''} ${w.exercise_code || ''} ${w.date} ${formatNiceDate(w.date)} ${getCleanIntentLabel(w)} ${w._note || ''}`.toLowerCase();
  return rideQuery.split(/\s+/).every(q => hay.includes(q));
}

async function renderRides() {
  const list = $('#rideList');
  const all = await db.workouts.orderBy('date').reverse().toArray();
  const lastSync = await getConfig('last_sync_at');
  $('#ridesSub').textContent = all.length
    ? `${all.length} workout${all.length > 1 ? 's' : ''}${lastSync ? ` · synced ${relativeTime(lastSync)}` : ''}`
    : 'Connect Strava to get started';
  $('#inboxCard').innerHTML = inboxCardHtml(await getInbox());
  await renderWeekCard(all);
  $('#sportSegRides').innerHTML = sportSegHtml(all, 'setSportFilter');

  if (!all.length) {
    list.innerHTML = `<div class="empty mt-16">${icon('bike')}<div><b>No rides stored yet</b></div>
      <div class="small mt-8">Sign in to Strava in <b>Profile</b>, then tap <b>Sync Strava</b>.<br/>Want to look around first? Load demo rides in Profile → Diagnostics.</div>
      <button class="btn btn-primary btn-sm mt-12" onclick="switchTab('profile')">Open Profile</button></div>`;
    return;
  }

  const threads = await db.threads.toArray();
  const coachIds = new Set(threads.filter(t => t.role === 'coach').map(t => Number(t.strava_id)));
  if (rideQuery) {
    const notes = new Map();
    for (const t of threads) if (t.role === 'athlete') notes.set(Number(t.strava_id), `${notes.get(Number(t.strava_id)) || ''} ${t.message || ''}`);
    all.forEach(w => { w._note = notes.get(Number(w.strava_id)) || ''; });
  }

  const shown = all.filter(w => rideMatches(w, coachIds));
  if (!shown.length) {
    list.innerHTML = `<div class="empty mt-16">${icon('search')}<div><b>No rides match</b></div><div class="small mt-8">Try another filter or search term.</div></div>`;
    return;
  }

  let html = '';
  let month = '';
  let monthRides = [];
  const flush = () => {
    if (!monthRides.length) return;
    const agg = aggregateRides(monthRides);
    html += `<div class="month-head"><span>${escapeHtml(month)}</span><span>${monthRides.length} · ${formatHours(agg.sec)}${agg.bySport.ride ? ` · ${fmtNum(agg.bySport.ride.dist, 0)} km ridden` : ''}</span></div><div>${monthRides.map(w => rideCardHtml(w, coachIds)).join('')}</div>`;
  };
  for (const w of shown.slice(0, 400)) {
    const m = monthLabel(w.date);
    if (m !== month) { flush(); month = m; monthRides = []; }
    monthRides.push(w);
  }
  flush();
  list.innerHTML = html;
}

function rideCardHtml(w, coachIds) {
  const reviewed = coachIds.has(Number(w.strava_id));
  const sp = sportOf(w), meta = SPORTS[sp];
  const d = distParts(w), s = speedParts(w);
  const flagged = k => isFlagged(w, k);
  const stat = (v, l, bad) => `<div class="ride-stat${bad ? ' flagged' : ''}"><div class="v">${v}</div><div class="l">${l}</div></div>`;
  const hrStat = stat(w.avg_hr > 0 ? `${w.avg_hr}<small>bpm</small>` : '--', 'Avg HR', flagged('hr'));
  const loadStat = stat(hasVal(w.trimp) ? Math.round(w.trimp) : '--', 'Load', flagged('hr'));
  const sw = swimOf(w);
  // Six numbers that matter for each sport
  const stats = sp === 'swim' ? [
    stat(`${d.v}<small>${d.unit}</small>`, 'Distance', flagged('distance')),
    stat(escapeHtml(formatDuration(w.moving_sec)), sw ? 'Swim time' : 'Time'),
    stat(swimPace100(w) ? `${fmtPace(swimPace100(w))}<small>/100m</small>` : '--', 'Pace', flagged('distance')),
    hrStat,
    stat(sw && sw.swolf ? String(sw.swolf) : '--', 'SWOLF'),
    loadStat
  ] : sp === 'run' ? [
    stat(`${d.v}<small>${d.unit}</small>`, 'Distance', flagged('distance')),
    stat(escapeHtml(rideDuration(w)), 'Moving'),
    stat(`${s.v}<small>${s.unit}</small>`, 'Pace', flagged('distance')),
    hrStat,
    w.avg_cadence ? stat(`${w.avg_cadence}<small>spm</small>`, 'Cadence') : isIndoor(w) ? stat(w.calories ? `${w.calories}<small>kcal</small>` : '--', 'Energy') : stat(`${Math.round(num(w.elevation_gain_m))}<small>m</small>`, 'Ascent', flagged('elevation')),
    loadStat
  ] : sp === 'other' ? [
    stat(escapeHtml(rideDuration(w)), 'Time'),
    hrStat,
    stat(w.max_hr > 0 ? `${w.max_hr}<small>bpm</small>` : '--', 'Peak HR', flagged('hr')),
    loadStat,
    stat(w.calories ? `${w.calories}<small>kcal</small>` : '--', 'Energy'),
    w.reps ? stat(String(w.reps), 'Reps') : stat(escapeHtml(String(w.name || '').slice(0, 14)) || '--', 'Type')
  ] : [
    stat(`${d.v}<small>${d.unit}</small>`, 'Distance', flagged('distance')),
    stat(escapeHtml(rideDuration(w)), 'Moving'),
    stat(`${s.v}<small>${s.unit}</small>`, 'Speed', flagged('distance')),
    hrStat,
    stat(`${Math.round(num(w.elevation_gain_m))}<small>m</small>`, 'Ascent', flagged('elevation')),
    loadStat
  ];
  const status = !reviewed ? '<span class="badge badge-new">Review</span>' : (w.debrief_stale ? '<span class="badge badge-stale">Update</span>' : '');
  return `
    <div class="ride-card${isExcluded(w) ? ' excluded' : ''}" data-id="${w.id}" style="--accent:${intentAccent(w)};--sc:${meta.color}" onclick="openRide(${w.id})">
      <div class="ride-top">
        <div class="grow">
          <div class="ride-name"><span class="sport-ic">${icon(meta.icon, 'ic-sm')}</span>${escapeHtml(rideTitle(w))}</div>
          <div class="ride-date">${escapeHtml(rideSubtitle(w))}${isIndoor(w) ? ' · indoor' : ''}${w.source === 'health' ? ' · watch' : ''}${w.demo ? ' · demo' : ''}</div>
        </div>
        <div class="ride-badges">${intentBadge(w)}${status}</div>
      </div>
      <div class="ride-stats">${stats.join('')}</div>
      ${zoneStripHtml(w.zone_seconds)}
    </div>`;
}

function setupRideFilters() {
  $$('#rideFilters .chip').forEach(ch => ch.addEventListener('click', () => {
    rideFilter = ch.dataset.filter;
    $$('#rideFilters .chip').forEach(c => c.classList.toggle('active', c === ch));
    renderRides();
  }));
  $('#rideSearch').addEventListener('input', debounce(e => {
    rideQuery = e.target.value.trim().toLowerCase();
    renderRides();
  }, 180));
}

// --------------------------------------------------------
// INTENT SHEET
// --------------------------------------------------------
function zoneIntentValue(i) {
  return `Zone ${i + 1} (${ZONE_META[i].name})`;
}

function populateZoneSelect() {
  const sel = $('#modalTargetZone');
  const prev = sel.value;
  sel.innerHTML = PHYSIO.zones.map((z, i) => `<option value="${zoneIntentValue(i)}">Zone ${i + 1} (${zoneRangeText(i)}) — ${z.long}</option>`).join('');
  if (prev) setZoneSelect(prev);
}

// Map stored values (incl. older label variants) onto the current options
function setZoneSelect(val) {
  const sel = $('#modalTargetZone');
  const m = String(val || '').match(/Zone\s*(\d)/i);
  sel.value = m ? zoneIntentValue(Math.min(4, Math.max(0, +m[1] - 1))) : zoneIntentValue(1);
}

function selectRideType(type) {
  modalSelectedType = type;
  $('#pillTypePlay').classList.toggle('selected', type === 'PLAY');
  $('#pillTypeTraining').classList.toggle('selected', type === 'TRAINING');
  $('#trainingIntentFields').classList.toggle('hidden', type !== 'TRAINING');
}

function selectRideFormat(fmt) {
  modalSelectedFormat = fmt;
  $('#pillFormatSteady').classList.toggle('selected', fmt === 'STEADY');
  $('#pillFormatInterval').classList.toggle('selected', fmt === 'INTERVAL');
  $('#intervalConfigFields').classList.toggle('hidden', fmt !== 'INTERVAL');
}

function fillIntentSheet(w, title) {
  populateZoneSelect();
  $('#intentModalTitle').textContent = title;
  $('#intentModalSub').textContent = `${rideTitle(w)} · ${distText(w)} · ${rideDuration(w)} · ${speedText(w)}${w.avg_hr ? ` · ${w.avg_hr} bpm` : ''}`;
  $('#intentQueueCount').textContent = intentModalQueue.length ? `+${intentModalQueue.length} more` : '';
  const it = parseIntent(w);
  if (w.intent_type === 'PLAY') {
    selectRideType('PLAY');
  } else {
    selectRideType('TRAINING');
    setZoneSelect(it ? it.target_zone : null);
    selectRideFormat(it && it.format === 'INTERVAL' ? 'INTERVAL' : 'STEADY');
  }
  $('#modalIntervalZones').value = (it && it.interval_zones) || 'Z2 <-> Z4';
  $('#modalIntervalFreq').value = (it && it.interval_freq) || '4m on / 2m off';
}

function openNextIntentModal() {
  if (!intentModalQueue.length) {
    activeIntentItem = null;
    closeSheet('intentSheet');
    renderRides();
    return;
  }
  activeIntentItem = intentModalQueue.shift();
  fillIntentSheet(activeIntentItem, `What was this ${sportMeta(activeIntentItem).label.toLowerCase()} for?`);
  if (!$('#intentSheet').classList.contains('open')) openSheet('intentSheet', () => { intentModalQueue = []; activeIntentItem = null; });
}

function closeIntentModalQueue() {
  intentModalQueue = [];
  activeIntentItem = null;
  closeSheet('intentSheet');
  renderRides();
}

function editCurrentRideIntent() {
  if (!currentWorkout) return;
  intentModalQueue = [];
  activeIntentItem = currentWorkout;
  fillIntentSheet(currentWorkout, 'Edit ride intent');
  openSheet('intentSheet', () => { activeIntentItem = null; });
}

async function applyIntent(w, fields) {
  const isStaleNow = await hasCoachDebrief(w.strava_id);
  await db.workouts.update(w.id, Object.assign({}, fields, { debrief_stale: isStaleNow }));
  let fresh = await db.workouts.get(w.id);
  fresh = await ensureRideMetrics(fresh, undefined, true); // intent changes the drift/decoupling diagnosis
  if (currentWorkout && currentWorkout.id === w.id && $('#rideDetail').classList.contains('open')) {
    await openRide(w.id, { keepScroll: true });
  }
}

async function skipIntentModal() {
  const w = activeIntentItem;
  if (w) await applyIntent(w, { intent_type: 'NONE', intent_target: null });
  advanceIntentQueue();
}

async function saveActiveIntentAndNext() {
  const w = activeIntentItem;
  if (!w) return;
  const data = { intent_type: modalSelectedType };
  if (modalSelectedType === 'TRAINING') {
    data.target_zone = $('#modalTargetZone').value;
    data.format = modalSelectedFormat;
    if (modalSelectedFormat === 'INTERVAL') {
      data.interval_zones = $('#modalIntervalZones').value.trim();
      data.interval_freq = $('#modalIntervalFreq').value.trim();
    }
  }
  await applyIntent(w, { intent_type: modalSelectedType, intent_target: JSON.stringify(data) });
  toast('Intent saved', 'success', 1600);
  advanceIntentQueue();
}

function advanceIntentQueue() {
  if (intentModalQueue.length) {
    openNextIntentModal();
  } else {
    activeIntentItem = null;
    closeSheet('intentSheet');
    if (Router.current === 'rides') renderRides();
  }
}
