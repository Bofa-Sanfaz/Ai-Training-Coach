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
  swim: { key: 'swim', label: 'Swim', plural: 'Swims', code: 'Swim', icon: 'swim', color: '#0891b2' },
  other: { key: 'other', label: 'Gym & other', plural: 'Gym & other', code: 'Gym', icon: 'dumbbell', color: '#7c3aed' }
};
const RUN_TYPES = ['Run', 'TrailRun', 'VirtualRun'];
const SWIM_TYPES = ['Swim'];
// Strava activity types that land in "Gym & other" (elliptical, stepper, rowing, strength…)
const OTHER_TYPES = ['Elliptical', 'StairStepper', 'WeightTraining', 'Workout', 'Rowing', 'VirtualRow', 'Crossfit', 'HighIntensityIntervalTraining', 'Yoga', 'Pilates', 'Hike', 'RockClimbing'];

let sportFilter = 'all'; // shared by Rides and Trends

function sportOf(w) {
  if (!w) return 'ride';
  if (SPORTS[w.sport]) return w.sport;
  const t = w.sport_type || '';
  if (RUN_TYPES.includes(t)) return 'run';
  if (SWIM_TYPES.includes(t)) return 'swim';
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
  if (s === 'run') return { v: fmtPace(3600 / kmh), unit: '/km' };
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
  const ok = await uiConfirm(`Delete ${rideTitle(w)}?`, `${formatNiceDate(w.date)} · ${distText(w)} · ${rideDuration(w)}${chats ? `\n${chats} coach message${chats > 1 ? 's' : ''} will be deleted too.` : ''}\n\nA restore point is created first, and the workout won't be imported again by sync.`, { okText: 'Delete', danger: true });
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
const NEVER_ASK_TYPES = ['meditation', 'guidedBreathing', 'mindAndBody', 'preparationAndRecovery', 'cooldown', 'transition', 'fishing', 'hunting', 'stretching', 'flexibility', 'play', 'wheelchair'];
const inboxSport = type => (RUNLIKE_TYPES.includes(type) ? 'run' : 'other');
const prettyType = t => String(t || 'Activity').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());

async function activityRules() { return getJsonConfig('activity_rules', {}); }
async function getInbox() { return getJsonConfig('activity_inbox', []); }

// items: [{ key, src: 'strava'|'health', type, name, date, distance_km, moving_sec, raw }]
// Returns the items whose type the athlete always includes (to import now).
async function routeToInbox(items) {
  const rules = await activityRules();
  const inbox = await getInbox();
  const skipped = new Set(await getJsonConfig('activity_skipped', []));
  const have = new Set(inbox.map(i => i.key));
  const include = [];
  let queued = 0;
  for (const it of items) {
    if (it.date < MIN_WORKOUT_DATE || skipped.has(it.key) || have.has(it.key)) continue;
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
    <label class="check-row"><input type="checkbox" data-n="${n}" ${inboxSport(i.type) === 'run' ? 'checked' : ''} />
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
  const skipped = inbox.filter((_, n) => !pickN.has(n)).map(i => i.key);
  await setJsonConfig('activity_skipped', (await getJsonConfig('activity_skipped', [])).concat(skipped).slice(-2000));
  await setJsonConfig('activity_inbox', []);
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
    } else if (it.src === 'health') {
      const H = healthPlugin();
      if (!H) continue;
      if (await addHealthSession(H, it.raw, sport, prettyType(it.type), false, all)) n++;
    }
  }
  if (n) await renumberRides();
  return n;
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
