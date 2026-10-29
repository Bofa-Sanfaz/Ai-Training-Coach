'use strict';
// --------------------------------------------------------
// SPORTS (ride / run / swim), DATA-QUALITY FLAGS, DELETING WORKOUTS
// A workout's sport comes from Strava's sport_type unless the athlete corrected it
// (field "sport"). Flags never change the stored numbers: flagged values are just
// left out of records, best efforts, trends, totals and AI analysis.
// --------------------------------------------------------
const SPORTS = {
  ride: { key: 'ride', label: 'Ride', plural: 'Rides', code: 'Ride', icon: 'bike', color: '#fc5200' },
  run: { key: 'run', label: 'Run', plural: 'Runs', code: 'Run', icon: 'run', color: '#16a34a' },
  walk: { key: 'walk', label: 'Walk', plural: 'Walks', code: 'Walk', icon: 'walk', color: '#ca8a04' },
  swim: { key: 'swim', label: 'Swim', plural: 'Swims', code: 'Swim', icon: 'swim', color: '#0891b2' },
  other: { key: 'other', label: 'Gym & other', plural: 'Gym & other', code: 'Gym', icon: 'dumbbell', color: '#7c3aed' }
};
const RUN_TYPES = ['Run', 'TrailRun', 'VirtualRun'];
const SWIM_TYPES = ['Swim'];
const WALK_TYPES = ['Walk', 'Hike', 'walking', 'hiking', 'snowshoeing', 'Snowshoe', 'WALKING', 'HIKING'];
// Pace sports on foot share their metrics (pace /km, cadence, steps, splits per km)
const onFoot = sp => sp === 'run' || sp === 'walk';
// Strava activity types that land in "Gym & other" (elliptical, stepper, rowing, strength…)
const OTHER_TYPES = ['Elliptical', 'StairStepper', 'WeightTraining', 'Workout', 'Rowing', 'VirtualRow', 'Crossfit', 'HighIntensityIntervalTraining', 'Yoga', 'Pilates', 'Hike', 'RockClimbing'];

let sportFilter = 'all'; // shared by Rides and Trends

function sportOf(w) {
  if (!w) return 'ride';
  if (SPORTS[w.sport]) return w.sport;
  const t = w.sport_type || '';
  if (RUN_TYPES.includes(t)) return 'run';
  if (SWIM_TYPES.includes(t)) return 'swim';
  if (WALK_TYPES.includes(t)) return 'walk';
  if (OTHER_TYPES.includes(t)) return 'other';
  return 'ride';
}

const sportMeta = w => SPORTS[sportOf(w)];
const sportIcon = (w, cls = '') => icon(sportMeta(w).icon, cls);
const bySport = (list, sport) => (sport && sport !== 'all' ? list.filter(w => sportOf(w) === sport) : list);
const sportsPresent = list => Object.keys(SPORTS).filter(s => list.some(w => sportOf(w) === s));

// Indoor: corrected by the athlete, else Strava's "trainer" flag
function isIndoor(w) {
  return w && (w.indoor === true || (w.indoor === undefined && !!w.trainer));
}

// --------------------------------------------------------
// FLAGS
// --------------------------------------------------------
const DATA_FLAGS = {
  elevation: { label: 'Elevation & climbing', fields: ['elevation_gain_m', 'climbing_vam'] },
  distance: { label: 'Distance & speed', fields: ['distance_km', 'avg_speed_kmh', 'max_speed_kmh', 'best_spd'] },
  hr: { label: 'Heart rate', fields: ['avg_hr', 'max_hr', 'best_hr', 'trimp', 'zone_seconds', 'cardiac_drift_bpm', 'cardiac_decoupling_pct'] },
  power: { label: 'Power', fields: ['avg_power_w', 'max_power_w', 'norm_power_w', 'np_w', 'mmp', 'kilojoules'] }
};
const FIELD_FLAG = {};
for (const [k, f] of Object.entries(DATA_FLAGS)) for (const field of f.fields) FIELD_FLAG[field] = k;

const isExcluded = w => !!(w && w.data_flags && w.data_flags.exclude);

function isFlagged(w, flag) {
  if (!w) return false;
  const f = w.data_flags || {};
  if (f.exclude || f[flag]) return true;
  if (isIndoor(w)) {
    if (flag === 'elevation') return true;
    if (flag === 'distance' && sportOf(w) === 'ride') return true;
  }
  return false;
}

// Metric value, or null when the athlete marked it as a data error
function mv(w, field) {
  const flag = FIELD_FLAG[field];
  if (flag && isFlagged(w, flag)) return null;
  return w ? w[field] : null;
}

// Human-readable list for badges and AI context
function flagNotes(w) {
  const out = [];
  if (!w) return out;
  if (isExcluded(w)) return ['excluded from statistics (not a real session)'];
  if (isIndoor(w)) out.push(`indoor${sportOf(w) === 'ride' ? ' (stationary bike: distance/speed/climbing not real)' : ''}`);
  for (const [k, f] of Object.entries(DATA_FLAGS)) if (w.data_flags && w.data_flags[k]) out.push(`${f.label.toLowerCase()} marked as data error`);
  return out;
}

// --------------------------------------------------------
// UNITS PER SPORT
// --------------------------------------------------------
function fmtPace(sec) {
  if (!(sec > 0) || !Number.isFinite(sec)) return '--';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// { v, unit } of a speed shown the way each sport thinks about it
function speedParts(w, kmh = w && w.avg_speed_kmh) {
  const s = sportOf(w);
  if (!(kmh > 0) || s === 'other') return { v: '--', unit: '' };
  if (onFoot(s)) return { v: fmtPace(3600 / kmh), unit: '/km' };
  if (s === 'swim') return { v: fmtPace(360 / kmh), unit: '/100m' };
  return { v: fmtNum(kmh, 1), unit: 'km/h' };
}
const speedText = (w, kmh) => { const p = speedParts(w, kmh); return p.unit ? `${p.v} ${p.unit}` : p.v; };
const speedName = w => (sportOf(w) === 'ride' ? 'Speed' : 'Pace');

function distParts(w, km = w && w.distance_km) {
  if (sportOf(w) === 'swim') return { v: String(Math.round(num(km) * 1000)), unit: 'm' };
  return { v: fmtNum(km, num(km) >= 100 ? 0 : num(km) >= 10 ? 1 : 2), unit: 'km' };
}
const distText = (w, km) => { const p = distParts(w, km); return `${p.v} ${p.unit}`; };

// --------------------------------------------------------
// SWIM METRICS (from the watch's per-length log)
// Every Samsung interval is one pool length: time, stroke count, stroke style.
//   SWOLF = seconds + strokes for one length (lower = more efficient); kick-board
//   lengths (no strokes) are left out of SWOLF and strokes per length.
//   Best 50/100/200/400 m = fastest run of consecutive lengths covering that distance.
//   Pace and stroke rate use active swimming time (rest between sets excluded).
// --------------------------------------------------------
const STROKES = { FREESTYLE: 'Freestyle', BREASTSTROKE: 'Breaststroke', BACKSTROKE: 'Backstroke', BUTTERFLY: 'Butterfly', KICK_BOARD: 'Kick board', MIXED: 'Mixed', UNDEFINED: 'Unknown' };
const STROKE_COLORS = { FREESTYLE: '#0891b2', BREASTSTROKE: '#16a34a', BACKSTROKE: '#7c3aed', BUTTERFLY: '#db2777', KICK_BOARD: '#f59e0b', MIXED: '#64748b', UNDEFINED: '#94a3b8' };

function buildSwimDetail(s, totalSec) {
  const pool = num(s.poolLength) * (s.poolUnit === 'yard' ? 0.9144 : 1);
  const laps = (s.laps || []).map(l => ({ sec: round(num(l.sec), 1), strokes: Math.round(num(l.strokes)), style: STROKES[l.style] ? l.style : 'UNDEFINED' })).filter(l => l.sec > 0);
  if (!(pool > 0) || !laps.length) return null;
  const strokeLaps = laps.filter(l => l.strokes > 0);
  const active = sumBy(laps, l => l.sec);
  const strokes = sumBy(strokeLaps, l => l.strokes);
  const swolfs = strokeLaps.map(l => l.sec + l.strokes);
  const bestOver = meters => {
    const k = Math.round(meters / pool);
    if (k < 1 || k > laps.length || Math.abs(k * pool - meters) > pool / 2) return null;
    let sum = 0, best = Infinity;
    for (let i = 0; i < laps.length; i++) { sum += laps[i].sec; if (i >= k) sum -= laps[i - k].sec; if (i >= k - 1 && sum < best) best = sum; }
    return Number.isFinite(best) ? round(best, 1) : null;
  };
  const mix = {};
  for (const l of laps) mix[l.style] = (mix[l.style] || 0) + 1;
  return {
    v: 1, pool_m: round(pool, 1), lengths: laps.length, distance_m: round(laps.length * pool, 0), laps,
    active_sec: round(active, 0), rest_sec: totalSec ? Math.max(0, Math.round(totalSec - active)) : null,
    strokes, spl: strokeLaps.length ? round(strokes / strokeLaps.length, 1) : null,
    stroke_rate: strokeLaps.length ? round(strokes / (sumBy(strokeLaps, l => l.sec) / 60), 1) : null,
    swolf: swolfs.length ? round(mean(swolfs), 1) : null, swolf_best: swolfs.length ? Math.min(...swolfs) : null,
    best: { 50: bestOver(50), 100: bestOver(100), 200: bestOver(200), 400: bestOver(400) },
    best_len: round(Math.min(...laps.map(l => l.sec)), 1), mix
  };
}

const swimOf = w => (w && w.swim && w.swim.laps ? w.swim : null);
const fmtSec = s => (hasVal(s) && s > 0 ? fmtPace(s) : '--');
// Pace per 100 m from the per-length log (active time) or the session average
const swimPace100 = w => { const sw = swimOf(w); return sw ? (sw.active_sec / sw.distance_m) * 100 : (w.avg_speed_kmh > 0 ? 360 / w.avg_speed_kmh : null); };

// --------------------------------------------------------
// WORKOUT DATA SHEET (sport, indoor, flags, delete)
// --------------------------------------------------------
let qsWorkoutId = null;
let qsSport = 'ride';

function qsPickSport(v) {
  qsSport = v;
  $$('#qs_sport button').forEach(b => b.classList.toggle('active', b.dataset.v === v));
}

async function openQualitySheet(id, focus) {
  const w = await db.workouts.get(id);
  if (!w) return;
  qsWorkoutId = id;
  qsPickSport(sportOf(w));
  const f = w.data_flags || {};
  $('#qs_title').textContent = rideTitle(w);
  $('#qs_indoor').checked = isIndoor(w);
  for (const k of Object.keys(DATA_FLAGS)) $(`#qs_f_${k}`).checked = !!f[k];
  $('#qs_f_exclude').checked = !!f.exclude;
  $('#qs_v_elevation').textContent = `${Math.round(num(w.elevation_gain_m))} m${w.climbing_vam ? ` · VAM ${w.climbing_vam} m/h` : ''}`;
  $('#qs_v_distance').textContent = `${distText(w)} · ${speedText(w)} · max ${fmtNum(w.max_speed_kmh, 1)} km/h`;
  $('#qs_v_hr').textContent = w.avg_hr ? `avg ${w.avg_hr} · max ${w.max_hr || '--'} bpm` : 'no heart rate';
  $('#qs_v_power').textContent = w.avg_power_w ? `${w.avg_power_w} W${w.device_watts ? '' : ' (Strava estimate)'}` : 'no power';
  $$('#qualitySheet .check-row').forEach(r => r.classList.remove('focus'));
  if (focus && $(`#qs_f_${focus}`)) $(`#qs_f_${focus}`).closest('.check-row').classList.add('focus');
  openSheet('qualitySheet', () => { qsWorkoutId = null; });
}

async function saveQualitySheet() {
  const w = qsWorkoutId && await db.workouts.get(qsWorkoutId);
  if (!w) return;
  const flags = {};
  for (const k of Object.keys(DATA_FLAGS).concat('exclude')) if ($(`#qs_f_${k}`).checked) flags[k] = true;
  const sportChanged = sportOf(w) !== qsSport;
  const upd = { sport: qsSport, indoor: $('#qs_indoor').checked, data_flags: flags };
  if (await hasCoachDebrief(w.strava_id)) upd.debrief_stale = true;
  await db.workouts.update(w.id, upd);
  if (sportChanged) await renumberRides();
  closeSheet('qualitySheet');
  haptic('success');
  toast(Object.keys(flags).length || upd.indoor ? 'Saved — flagged values are left out of stats and AI' : 'Saved', 'success', 2600);
  await afterWorkoutsChanged(w.id);
}

async function deleteWorkoutFromSheet() {
  const id = qsWorkoutId;
  if (!id) return;
  closeSheet('qualitySheet');
  await deleteWorkout(id);
}

async function deletedWorkoutIds() {
  return new Set((await getJsonConfig('deleted_workouts', [])).map(Number));
}

async function deleteWorkout(id) {
  const w = await db.workouts.get(id);
  if (!w) return;
  const chats = await db.threads.where('strava_id').equals(Number(w.strava_id)).count();
  const ok = await uiConfirm(`Delete ${rideTitle(w)}?`, `${formatNiceDate(w.date)} · ${sportOf(w) === 'other' ? '' : `${distText(w)} · `}${rideDuration(w)}${chats ? `\n${chats} coach message${chats > 1 ? 's' : ''} will be deleted too.` : ''}\n\nA restore point is created first, and the workout won't be imported again by sync.`, { okText: 'Delete', danger: true });
  if (!ok) return;
  await createRestorePoint(`Before deleting ${rideTitle(w)}`, 'auto');
  const gone = await getJsonConfig('deleted_workouts', []);
  if (!gone.includes(Number(w.strava_id))) gone.push(Number(w.strava_id));
  await setJsonConfig('deleted_workouts', gone);
  await db.transaction('rw', db.workouts, db.streams, db.threads, async () => {
    await db.workouts.delete(id);
    await db.streams.delete(Number(w.strava_id));
    await db.threads.where('strava_id').equals(Number(w.strava_id)).delete();
  });
  await renumberRides();
  if (currentWorkout && currentWorkout.id === id) closePanel('rideDetail');
  haptic('success');
  toast(`${rideTitle(w)} deleted · undo with Profile → Restore points`, 'success', 4200);
  await afterWorkoutsChanged(null);
}

// Re-render whatever shows workouts
async function afterWorkoutsChanged(openId) {
  trendsCache = null;
  if (openId && currentWorkout && currentWorkout.id === openId && $('#rideDetail').classList.contains('open')) await openRide(openId, { keepScroll: true });
  const r = { rides: renderRides, trends: renderTrends, compare: setupComparison, coach: renderCoachList, reports: renderReports }[Router.current];
  if (r) await r();
}

// --------------------------------------------------------
// NEW ACTIVITY TYPES — INBOX
// Strava / Samsung Health activities of types the app doesn't import by default
// (walks, hikes, yoga, football…) wait in an inbox: include them (walks & hikes
// count as runs, everything else as Gym & other) or skip them. A choice can be
// remembered for that type. Nothing before 2026 is ever imported.
// --------------------------------------------------------
const MIN_WORKOUT_DATE = '2026-01-01';
const RUNLIKE_TYPES = ['Walk', 'Hike', 'Snowshoe', 'walking', 'hiking', 'snowshoeing'];
// Outdoor rides always come from Strava, so watch cycling sessions are never offered
const NEVER_ASK_TYPES = ['cycling', 'biking', 'mountainBiking', 'roadBiking', 'meditation', 'guidedBreathing', 'mindAndBody', 'preparationAndRecovery', 'cooldown', 'transition', 'fishing', 'hunting', 'stretching', 'flexibility', 'play', 'wheelchair'];
const inboxSport = type => (RUNLIKE_TYPES.includes(type) ? 'walk' : 'other');
const prettyType = t => String(t || 'Activity').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());

// Two recordings are the same session when they start within 2 minutes of each other or
// overlap for at least half of the shorter one (e.g. the watch started 12 min after Strava).
// Back-to-back bouts (a 4-min treadmill run, then an 11-min one) stay separate.
function sameSession(aStart, aSec, bStart, bSec) {
  const a0 = +aStart, b0 = +bStart;
  if (Math.abs(a0 - b0) <= 120000) return true;
  const a1 = a0 + Math.max(60, num(aSec)) * 1000, b1 = b0 + Math.max(60, num(bSec)) * 1000;
  const overlap = Math.min(a1, b1) - Math.max(a0, b0);
  return overlap > 0 && overlap >= 0.5 * Math.min(a1 - a0, b1 - b0);
}
const workoutStart = w => parseSafeDate(w.date).getTime();
const workoutSec = w => num(w.elapsed_sec) || num(w.moving_sec);
// Is this (start, duration) already a workout in `all`? Returns that workout.
const findSameWorkout = (all, start, sec, filter = () => true) => all.find(w => filter(w) && sameSession(workoutStart(w), workoutSec(w), start, sec));

async function activityRules() { return getJsonConfig('activity_rules', {}); }
async function getInbox() { return getJsonConfig('activity_inbox', []); }

// items: [{ key, src: 'strava'|'health', type, name, date, distance_km, moving_sec, raw }]
// Returns the items whose type the athlete always includes (to import now).
async function routeToInbox(items) {
  const rules = await activityRules();
  const inbox = await getInbox();
  const skipped = new Set(await getJsonConfig('activity_skipped', []));
  // Skipped / waiting items are also matched by time, so the same walk arriving from
  // another source (Strava, Health Connect, Samsung Health) isn't asked about twice
  const skippedAt = await getJsonConfig('activity_skipped_at', []);
  // Everything up to the last reviewed item has been seen: re-scans after an update never bring it back
  const reviewedUntil = (await getConfig('activity_reviewed_until')) || '';
  const have = new Set(inbox.map(i => i.key));
  const all = await db.workouts.toArray();
  const at = it => parseSafeDate(it.date).getTime();
  const seen = (it, list) => list.some(x => sameSession(at(x), x.moving_sec, at(it), it.moving_sec));
  const include = [];
  let queued = 0;
  for (const it of items) {
    if (it.date < MIN_WORKOUT_DATE || skipped.has(it.key) || have.has(it.key) || (reviewedUntil && it.date <= reviewedUntil)) continue;
    if (seen(it, inbox) || seen(it, skippedAt) || findSameWorkout(all, at(it), it.moving_sec)) continue;
    const rule = rules[`${it.src}:${it.type}`];
    if (rule === 'include') include.push(it);
    else if (rule !== 'skip') { inbox.push(it); queued++; }
  }
  if (queued) await setJsonConfig('activity_inbox', inbox.slice(-200));
  return include;
}

function inboxCardHtml(inbox) {
  if (!inbox.length) return '';
  const byType = {};
  for (const i of inbox) byType[prettyType(i.type)] = (byType[prettyType(i.type)] || 0) + 1;
  return `<button class="inbox-card" onclick="openInbox()">
    <span class="inbox-ic">${icon('plus', 'ic-sm')}</span>
    <span class="grow"><b>${inbox.length} new activit${inbox.length > 1 ? 'ies' : 'y'} to sort</b><span class="tiny muted">${escapeHtml(Object.entries(byType).map(([t, n]) => `${n} ${t.toLowerCase()}${n > 1 ? 's' : ''}`).join(' · '))} — include or skip</span></span>
    ${icon('chevron', 'ic-sm muted')}</button>`;
}

async function openInbox() {
  const inbox = await getInbox();
  if (!inbox.length) return;
  const types = [...new Set(inbox.map(i => `${i.src}:${i.type}`))];
  $('#inboxList').innerHTML = inbox.map((i, n) => `
    <label class="check-row"><input type="checkbox" data-n="${n}" ${inboxSport(i.type) === 'walk' ? 'checked' : ''} />
      <span><b>${escapeHtml(i.name || prettyType(i.type))}</b><span class="tiny muted">${escapeHtml(prettyType(i.type))} → ${SPORTS[inboxSport(i.type)].label} · ${escapeHtml(formatNiceDate(i.date))} · ${i.distance_km > 0 ? `${fmtNum(i.distance_km, 2)} km · ` : ''}${formatDuration(i.moving_sec)} · ${i.src === 'health' ? 'Galaxy Watch' : 'Strava'}</span></span></label>`).join('');
  $('#inboxRules').innerHTML = types.map(k => {
    const t = k.split(':')[1];
    return `<div class="rule-row"><span class="grow">Every <b>${escapeHtml(prettyType(t).toLowerCase())}</b> from now on</span>
      <select class="input input-sm" data-rule="${escapeHtml(k)}"><option value="">Ask me</option><option value="include">Include as ${SPORTS[inboxSport(t)].label.toLowerCase()}</option><option value="skip">Skip</option></select></div>`;
  }).join('');
  openSheet('inboxSheet');
}

async function applyInbox() {
  const inbox = await getInbox();
  const pickN = new Set($$('#inboxList input[type=checkbox]').filter(c => c.checked).map(c => +c.dataset.n));
  const rules = await activityRules();
  $$('#inboxRules select').forEach(s => { if (s.value) rules[s.dataset.rule] = s.value; else delete rules[s.dataset.rule]; });
  await setJsonConfig('activity_rules', rules);
  const chosen = inbox.filter((_, n) => pickN.has(n));
  const skippedItems = inbox.filter((_, n) => !pickN.has(n));
  const skipped = skippedItems.map(i => i.key);
  await setJsonConfig('activity_skipped', (await getJsonConfig('activity_skipped', [])).concat(skipped).slice(-2000));
  await setJsonConfig('activity_skipped_at', (await getJsonConfig('activity_skipped_at', [])).concat(skippedItems.map(i => ({ date: i.date, moving_sec: i.moving_sec }))).slice(-2000));
  await setJsonConfig('activity_inbox', []);
  const newest = inbox.map(i => i.date).sort().pop();
  if (newest && newest > ((await getConfig('activity_reviewed_until')) || '')) await setConfig('activity_reviewed_until', newest);
  closeSheet('inboxSheet');
  const added = await importInboxItems(chosen);
  toast(`${added} added${skipped.length ? ` · ${skipped.length} skipped` : ''}`, 'success', 2600);
  if (added) syncStrava({ auto: true }); // fetch streams & compute metrics for Strava ones
  await afterWorkoutsChanged(null);
}

// Turns inbox items into workouts (Strava summaries or Health Connect sessions)
async function importInboxItems(items) {
  let n = 0;
  const all = await db.workouts.toArray();
  const ids = new Set(all.map(w => Number(w.strava_id)));
  for (const it of items) {
    const sport = inboxSport(it.type);
    if (it.src === 'strava') {
      if (ids.has(Number(it.raw.id))) continue;
      const w = buildWorkoutFromActivity(it.raw);
      w.sport = sport;
      w.id = await db.workouts.add(w);
      n++;
    } else if (it.src === 'health' && it.sh) {
      if (await addSamsungSummary(it)) n++;
    } else if (it.src === 'health') {
      const H = healthPlugin();
      if (!H) continue;
      if (await addHealthSession(H, it.raw, sport, prettyType(it.type), false, all)) n++;
    }
  }
  if (n) await renumberRides();
  return n;
}

// --------------------------------------------------------
// DUPLICATE CLEAN-UP (runs once per DEDUPE_VER at start-up)
// The same session recorded twice (Strava + watch, or two watch sources) is merged:
// the Strava copy wins, otherwise the copy with more detail. The athlete's intent,
// rating, note, sport and flags carry over; chats move to the kept copy.
// --------------------------------------------------------
const DEDUPE_VER = '2';

async function dedupeWorkouts() {
  if ((await getConfig('dedupe_ver')) === DEDUPE_VER) return 0;
  const all = (await db.workouts.toArray()).sort((a, b) => workoutStart(a) - workoutStart(b));
  const score = w => (w.source !== 'health' ? 100 : 0) + (w.swim && w.swim.laps ? 20 : 0) + (w.avg_hr > 0 ? 5 : 0) + (w.distance_km > 0 ? 5 : 0) + (w.zone_seconds || []).reduce((a, b) => a + num(b), 0) / 1e6;
  const gone = new Set();
  const pairs = [];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length && workoutStart(all[j]) - workoutStart(all[i]) < 6 * 3600000; j++) {
      const a = all[i], b = all[j];
      if (gone.has(a.id) || gone.has(b.id)) continue;
      if (!sameSession(workoutStart(a), workoutSec(a), workoutStart(b), workoutSec(b))) continue;
      const [keep, drop] = score(a) >= score(b) ? [a, b] : [b, a];
      pairs.push([keep, drop]);
      gone.add(drop.id);
    }
  }
  if (pairs.length) {
    await createRestorePoint(`Before merging ${pairs.length} duplicate workout${pairs.length > 1 ? 's' : ''}`, 'auto');
    const deletedIds = await getJsonConfig('deleted_workouts', []);
    for (const [keep, drop] of pairs) {
      const carry = {};
      for (const k of ['intent_type', 'intent_target', 'rpe', 'feel', 'note', 'data_flags']) if (!hasVal(keep[k]) && hasVal(drop[k])) carry[k] = drop[k];
      if (Object.keys(carry).length) await db.workouts.update(keep.id, carry);
      await db.threads.where('strava_id').equals(Number(drop.strava_id)).modify({ strava_id: Number(keep.strava_id) });
      await db.workouts.delete(drop.id);
      await db.streams.delete(Number(drop.strava_id));
      deletedIds.push(Number(drop.strava_id));
    }
    await setJsonConfig('deleted_workouts', deletedIds);
    await renumberRides();
  }
  // Skipped watch items carry their start time in the key: remember them by time too
  const skippedAt = await getJsonConfig('activity_skipped_at', []);
  for (const k of await getJsonConfig('activity_skipped', [])) {
    const m = String(k).match(/^health:-(\d+)$/);
    if (m) { const d = new Date(+m[1] * 1000); skippedAt.push({ date: `${formatLocalDate(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`, moving_sec: 600 }); }
  }
  await setJsonConfig('activity_skipped_at', skippedAt.slice(-2000));
  // Drop inbox items that are already workouts or were skipped from another source
  const after = await db.workouts.toArray();
  const at = it => parseSafeDate(it.date).getTime();
  const inbox = (await getInbox()).filter(it => !findSameWorkout(after, at(it), it.moving_sec) && !skippedAt.some(x => sameSession(at(x), x.moving_sec, at(it), it.moving_sec)));
  await setJsonConfig('activity_inbox', inbox);
  // Seed the review mark from what was already skipped, so older items never return
  const lastSkipped = skippedAt.map(x => x.date).sort().pop();
  if (lastSkipped && !inbox.length && lastSkipped > ((await getConfig('activity_reviewed_until')) || '')) await setConfig('activity_reviewed_until', lastSkipped);
  await setConfig('dedupe_ver', DEDUPE_VER);
  if (pairs.length) toast(`Merged ${pairs.length} duplicate workout${pairs.length > 1 ? 's' : ''} (recorded by Strava and the watch)`, 'info', 4500);
  return pairs.length;
}

// Walks included before Walk became its own sport (3.5) were stored as runs: move them over once
async function migrateWalks() {
  if ((await getConfig('walk_ver')) === '1') return 0;
  const walks = (await db.workouts.toArray()).filter(w => w.sport === 'run' && WALK_TYPES.includes(w.sport_type));
  for (const w of walks) await db.workouts.update(w.id, { sport: 'walk' });
  if (walks.length) await renumberRides();
  await setConfig('walk_ver', '1');
  return walks.length;
}

// Sport chips (All · Ride · Run · Swim) — shown only when more than one sport exists
function sportSegHtml(list, onPick) {
  const present = sportsPresent(list);
  if (present.length < 2) return '';
  const opts = [['all', 'All', 'multi']].concat(present.map(s => [s, SPORTS[s].plural, SPORTS[s].icon]));
  return `<div class="sport-seg">${opts.map(([k, l, ic]) => `<button class="${sportFilter === k ? 'active' : ''}" onclick="${onPick}('${k}')">${icon(ic, 'ic-sm')}${l}</button>`).join('')}</div>`;
}

function setSportFilter(s) {
  sportFilter = s;
  haptic('light');
  if (Router.current === 'rides') renderRides();
  if (Router.current === 'trends') renderTrends();
}
