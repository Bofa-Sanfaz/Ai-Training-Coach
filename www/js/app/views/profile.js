'use strict';
// --------------------------------------------------------
// PROFILE: athlete, weight, phases, zones, connections,
// appearance, backup & rollback, diagnostics
// --------------------------------------------------------
async function renderProfile() {
  $('#cfg_name').value = ATHLETE.name || '';
  $('#cfg_height').value = (await getConfig('athlete_height')) || '';
  $('#cfg_bike').value = ATHLETE.bike || '';
  $('#cfg_max_hr').value = PHYSIO.max_hr;
  $('#cfg_rest_hr').value = PHYSIO.resting_hr;
  $('#cfg_trimp_sex').value = PHYSIO.trimp_sex;
  PHYSIO.bounds.forEach((b, i) => { $(`#zb${i}`).value = b; });
  previewZones();

  $('#cfg_client_id').value = (await getConfig('strava_client_id')) || DEFAULT_STRAVA_CLIENT_ID;
  $('#cfg_client_secret').value = await getConfig('strava_client_secret');
  $('#cfg_gemini_key').value = await getConfig('gemini_api_key');
  $('#cfg_custom_model').value = await getConfig('custom_gemini_model');
  await refreshModelSelectors();

  const connected = !!(await getConfig('strava_refresh_token'));
  $('#stravaState').innerHTML = connected
    ? `<span class="pos">● Connected to Strava</span>`
    : `<span class="neu">Not connected — save your Client Secret, then sign in.</span>`;

  const today = formatLocalDate(new Date());
  if (!$('#cfg_weight_date').value) $('#cfg_weight_date').value = today;
  if (!$('#cfg_goal_date').value) $('#cfg_goal_date').value = today;
  applyTheme(currentThemeChoice());
  $('#versionTag').textContent = `Ride Partner v${APP_VERSION} · metrics ${METRICS_VERSION}`;

  await renderWeightHistoryUI();
  await renderGoalHistoryUI();
  await renderRestorePoints();
}

async function saveAthleteProfile() {
  await setConfig('athlete_name', $('#cfg_name').value.trim() || 'Athlete');
  await setConfig('athlete_height', $('#cfg_height').value.trim());
  await setConfig('bike_name', $('#cfg_bike').value.trim());
  await loadPhysioConfig();
  toast('Athlete profile saved', 'success');
}

async function saveConnections() {
  await setConfig('strava_client_id', $('#cfg_client_id').value.trim() || DEFAULT_STRAVA_CLIENT_ID);
  await setConfig('strava_client_secret', $('#cfg_client_secret').value.trim());
  await setConfig('gemini_api_key', $('#cfg_gemini_key').value.trim());
  const custom = $('#cfg_custom_model').value.trim();
  await setConfig('custom_gemini_model', custom);
  if (custom) await setConfig('selected_gemini_model', custom);
  else if ((await getActiveModel()) === (await getConfig('custom_gemini_model'))) await setConfig('selected_gemini_model', GEMINI_MODELS[0][0]);
  await refreshModelSelectors();
  toast('Connections saved', 'success');
}

// ---------- Weight ----------
async function logAthleteWeight() {
  const date = $('#cfg_weight_date').value || formatLocalDate(new Date());
  const kg = parseFloat($('#cfg_weight_input').value);
  if (!(kg > 25 && kg < 300)) { toast('Enter a valid weight in kg.', 'warn'); return; }
  const h = await getWeightHistory();
  const i = h.findIndex(e => e.date === date);
  if (i >= 0) h[i].weight = kg; else h.push({ date, weight: kg });
  await saveWeightHistory(h);
  $('#cfg_weight_input').value = '';
  await renderWeightHistoryUI();
  toast(`Logged ${kg} kg for ${date}`, 'success', 1800);
}

async function deleteWeightEntry(date) {
  if (!(await uiConfirm('Remove weight entry?', `Entry for ${date} will be deleted.`, { okText: 'Remove', danger: true }))) return;
  await saveWeightHistory((await getWeightHistory()).filter(e => e.date !== date));
  await renderWeightHistoryUI();
}

async function renderWeightHistoryUI() {
  const h = await getWeightHistory();
  const host = $('#weightHistoryList');
  if (!h.length) { host.innerHTML = '<div class="small muted">No entries yet.</div>'; return; }
  const rev = h.slice().reverse();
  host.innerHTML = rev.map((e, i) => {
    const prev = rev[i + 1];
    const d = prev ? num(e.weight) - num(prev.weight) : null;
    return `<div class="list-item"><span>${escapeHtml(formatNiceDate(e.date, false))} <span class="tiny muted">${escapeHtml(e.date)}</span></span>
      <span class="row"><b>${escapeHtml(String(e.weight))} kg</b>${d !== null ? `<span class="tiny ${d <= 0 ? 'pos' : 'neg'}">${signed(d, 1)}</span>` : ''}
      <button class="x-btn" onclick="deleteWeightEntry('${escapeHtml(e.date)}')" aria-label="Delete">${icon('x')}</button></span></div>`;
  }).join('');
}

// ---------- Training phases ----------
async function saveTrainingGoal() {
  const goal = $('#cfg_goal_input').value.trim();
  const date = $('#cfg_goal_date').value || formatLocalDate(new Date());
  if (!goal) { toast('Type your training phase first.', 'warn'); return; }
  const h = await getTrainingGoalHistory();
  const i = h.findIndex(e => e.effective_date === date);
  if (i >= 0) h[i].goal = goal; else h.push({ effective_date: date, goal });
  await saveTrainingGoalHistory(h);
  $('#cfg_goal_input').value = '';
  await renderGoalHistoryUI();
  toast(`Phase active from ${date}`, 'success');
}

async function deleteTrainingGoalEntry(date) {
  if (!(await uiConfirm('Remove phase?', `The phase starting ${date} will be deleted.`, { okText: 'Remove', danger: true }))) return;
  await saveTrainingGoalHistory((await getTrainingGoalHistory()).filter(e => e.effective_date !== date));
  await renderGoalHistoryUI();
}

async function renderGoalHistoryUI() {
  const h = await getTrainingGoalHistory();
  const host = $('#goalHistoryList');
  if (!h.length) { host.innerHTML = '<div class="small muted">No phase defined yet.</div>'; return; }
  const today = Date.now();
  let activeDate = null;
  for (const e of h) if (parseSafeDate(e.effective_date).getTime() <= today) activeDate = e.effective_date;
  host.innerHTML = h.slice().reverse().map(e => `
    <div class="list-item"><span><b>${escapeHtml(e.goal)}</b><br><span class="tiny muted">from ${escapeHtml(e.effective_date)}</span>${e.effective_date === activeDate ? ' <span class="badge badge-ok">Active</span>' : ''}</span>
    <button class="x-btn" onclick="deleteTrainingGoalEntry('${escapeHtml(e.effective_date)}')" aria-label="Delete">${icon('x')}</button></div>`).join('');
}

// ---------- Zones ----------
function readZoneForm() {
  return {
    max: parseInt($('#cfg_max_hr').value, 10),
    rest: parseInt($('#cfg_rest_hr').value, 10),
    bounds: [0, 1, 2, 3].map(i => parseInt($(`#zb${i}`).value, 10))
  };
}

function previewZones() {
  const { max, bounds } = readZoneForm();
  const host = $('#zonePreview');
  if (validateBounds(bounds, max) || !(max > 0)) { host.innerHTML = '<span style="flex:1;background:var(--surface-3);color:var(--muted)">Check zone values</span>'; return; }
  const lo = Math.max(80, bounds[0] - 25);
  const edges = [lo, ...bounds, max];
  host.innerHTML = ZONE_META.map((z, i) => `<span style="flex:${Math.max(1, edges[i + 1] - edges[i])};background:${z.color}">${z.key}</span>`).join('');
}

function autoZonesFromMax() {
  const max = parseInt($('#cfg_max_hr').value, 10);
  if (!(max >= 120 && max <= 230)) { toast('Enter a max heart rate between 120 and 230 first.', 'warn'); return; }
  suggestBoundsFromMax(max).forEach((b, i) => { $(`#zb${i}`).value = b; });
  previewZones();
}

async function saveZones() {
  const { max, rest, bounds } = readZoneForm();
  if (!(max >= 120 && max <= 230)) { toast('Max HR must be between 120 and 230.', 'warn'); return; }
  if (!(rest >= 30 && rest < max - 40)) { toast('Resting HR must be between 30 and (max − 40).', 'warn'); return; }
  const err = validateBounds(bounds, max);
  if (err) { toast(err, 'warn'); return; }
  await createRestorePoint('Before changing heart-rate zones', 'auto');
  await setConfig('max_hr', String(max));
  await setConfig('resting_hr', String(rest));
  await setJsonConfig('zone_bounds', bounds);
  await setConfig('trimp_sex', $('#cfg_trimp_sex').value);
  await loadPhysioConfig();
  await recalculateAll(true);
}

async function recalculateAll(silentConfirm = false) {
  if (!silentConfirm && !(await uiConfirm('Recalculate all rides?', 'Zone time, VAM, drift and training load are recomputed from the stored streams.', { okText: 'Recalculate' }))) return;
  toast('Recalculating ride metrics…', 'info', 1500);
  const n = await recomputeAllMetrics();
  populateZoneSelect();
  toast(`Recalculated ${n} ride${n === 1 ? '' : 's'}`, 'success');
}

// ---------- Appearance ----------
function setupThemeSeg() {
  $$('#themeSeg button').forEach(b => b.addEventListener('click', () => {
    applyTheme(b.dataset.themeChoice);
    rerenderCharts();
  }));
}

// ---------- Backup & rollback ----------
async function exportDatabaseJson() {
  try {
    const dump = await buildDump({ includeSecrets: false });
    const name = `RidePartner_Backup_${formatLocalDate(new Date())}.json`;
    const res = await saveOrShareFile(name, JSON.stringify(dump), { mime: 'application/json', title: 'Ride Partner backup' });
    if (res.ok) toast(`Backup exported → ${res.where}`, 'success');
  } catch (e) {
    toast(`Export failed: ${e.message}`, 'error');
  }
}

async function importDatabaseJson(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;
  const ok = await uiConfirm('Restore backup?', 'Rides, coach chats and settings are replaced by the backup. API keys and your Strava login stay. A restore point is created first so you can undo this.', { okText: 'Restore' });
  if (!ok) return;
  try {
    const data = JSON.parse(await file.text());
    await createRestorePoint('Before importing a backup file', 'auto');
    await restoreDump(data, { preserveSecrets: true });
    await afterDataReplaced('Backup restored');
  } catch (e) {
    toast(`Import failed: ${e.message}`, 'error', 6000);
  }
}

async function afterDataReplaced(msg) {
  await loadPhysioConfig();
  await recomputeAllMetrics();
  await renderProfile();
  toast(msg, 'success');
}

async function renderRestorePoints() {
  const list = await listRestorePoints();
  const host = $('#restorePointList');
  if (!list.length) { host.innerHTML = '<div class="small muted">No restore points yet. One is created automatically before the next sync.</div>'; return; }
  host.innerHTML = list.map(r => `
    <div class="list-item">
      <span class="grow"><b>${escapeHtml(r.reason)}</b><br>
        <span class="tiny muted">${escapeHtml(new Date(r.created_at).toLocaleString())} · ${r.ride_count} rides · v${escapeHtml(r.app_version || '?')} · ${Math.max(1, Math.round(r.size / 1024))} KB${r.kind === 'manual' ? ' · manual' : ''}</span></span>
      <button class="btn btn-secondary btn-xs" onclick="rollbackTo(${r.id})">Restore</button>
      <button class="x-btn" onclick="removeRestorePoint(${r.id})" aria-label="Delete">${icon('x')}</button>
    </div>`).join('');
}

async function createManualRestorePoint() {
  const ok = await createRestorePoint('Manual restore point', 'manual');
  toast(ok ? 'Restore point created' : 'Could not create restore point', ok ? 'success' : 'error');
  await renderRestorePoints();
}

async function rollbackTo(id) {
  const ok = await uiConfirm('Roll back data?', 'Rides, chats and settings return to this restore point. Your current state is saved as a new restore point first, so this can be undone.', { okText: 'Roll back' });
  if (!ok) return;
  try {
    await rollbackToRestorePoint(id);
    await afterDataReplaced('Rolled back');
  } catch (e) {
    toast(`Rollback failed: ${e.message}`, 'error');
  }
}

async function removeRestorePoint(id) {
  if (!(await uiConfirm('Delete restore point?', 'This cannot be undone.', { okText: 'Delete', danger: true }))) return;
  await deleteRestorePoint(id);
  await renderRestorePoints();
}

async function switchToClassic() {
  const ok = await uiConfirm('Open Classic version?', 'Switches to the previous v2 interface. Your rides and chats are shared. Use the "Use v3" button at the top of Classic to come back.', { okText: 'Switch' });
  if (!ok) return;
  await createRestorePoint('Before switching to Classic v2', 'auto');
  try { localStorage.setItem('rp_ui', 'classic'); } catch (e) {}
  location.href = 'classic.html';
}
