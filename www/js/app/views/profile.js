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
  $('#cfg_ftp').value = PHYSIO.ftp_user || '';
  $('#cfg_autosync').checked = (await getConfig('auto_sync')) !== '0';
  let hapticsOn = true;
  try { hapticsOn = localStorage.getItem('rp_haptics') !== 'off'; } catch (e) {}
  $('#cfg_haptics').checked = hapticsOn;
  await renderGoalsForm();
  PHYSIO.bounds.forEach((b, i) => { $(`#zb${i}`).value = b; });
  previewZones();

  $('#cfg_client_id').value = (await getConfig('strava_client_id')) || DEFAULT_STRAVA_CLIENT_ID;
  $('#cfg_client_secret').value = await getConfig('strava_client_secret');
  await renderProviders();
  renderAgentModels();
  await renderMemory();
  await renderSpend();
  renderSkills();
  await renderHealthCard();

  const connected = !!(await getConfig('strava_refresh_token'));
  $('#stravaState').innerHTML = connected
    ? `<span class="pos">● Connected to Strava</span>`
    : `<span class="neu">Not connected — save your Client Secret, then sign in.</span>`;

  const today = formatLocalDate(new Date());
  if (!$('#cfg_weight_date').value) $('#cfg_weight_date').value = today;
  if (!$('#cfg_goal_date').value) $('#cfg_goal_date').value = today;
  applyTheme(currentThemeChoice());
  $('#versionTag').textContent = `Training Partner v${APP_VERSION} · metrics ${METRICS_VERSION}`;

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
  toast('Strava settings saved', 'success');
  haptic('success');
}

// ---------- AI providers ----------
let editingProviderId = null;

async function renderProviders() {
  if (!AI) await loadAiSettings();
  $('#cfg_ai_fallback').checked = !!AI.fallback;
  // Web app: Gemini only (see geminiOnly in providers.js)
  const gem = geminiOnly();
  $('#btnAddProvider').classList.toggle('hidden', gem);
  $('#aiProvSub').textContent = gem
    ? 'Your coaches run on Google Gemini — free. Tap Google Gemini to paste your key (aistudio.google.com/apikey) and choose the model.'
    : 'The coach can use free APIs (Gemini, Groq, OpenRouter, Mistral) or paid ones (Claude, OpenAI, DeepSeek). Tap a provider to set its key and model.';
  $('#aiFallbackHint').textContent = gem ? 'If the Gemini model is busy or out of free quota, another Gemini model answers.' : 'If the active provider fails or hits a limit, try the others (free ones first).';
  $('#providerList').innerHTML = AI.providers.filter(p => !gem || p.type === 'gemini').map(p => {
    const ready = providerReady(p);
    const active = p.id === AI.active;
    return `<div class="list-item prov-row" onclick="openProviderSheet('${escapeHtml(p.id)}')">
      <div class="avatar ${active ? 'master' : ''}">${escapeHtml(p.name.slice(0, 2).toUpperCase())}</div>
      <span class="grow"><b>${escapeHtml(p.name)}</b>${active ? ' <span class="badge badge-intent">Main</span>' : ''}<br>
        <span class="tiny muted"><span class="dot-status" style="background:${!p.enabled ? 'var(--muted)' : ready ? 'var(--good)' : 'var(--warn)'}"></span>${!p.enabled ? 'Disabled' : ready ? escapeHtml(p.model) : 'Needs key or model'}</span></span>
      <span class="badge ${p.paid ? 'badge-stale' : 'badge-ok'}">${p.paid ? 'Paid' : 'Free'}</span>
      ${icon('chevron', 'ic-sm muted')}
    </div>`;
  }).join('') || '<div class="small muted">No providers yet — tap Add.</div>';
  await refreshModelSelectors();
}

async function setAiFallback(on) {
  AI.fallback = !!on;
  await saveAiSettings();
  toast(on ? 'Fallback on' : 'Fallback off', 'info', 1400);
}

function openAddProvider() {
  $('#presetList').innerHTML = Object.entries(PROVIDER_PRESETS).map(([key, p]) => `
    <div class="list-item prov-row" onclick="addProvider('${key}')">
      <div class="avatar">${escapeHtml(p.name.slice(0, 2).toUpperCase())}</div>
      <span class="grow"><b>${escapeHtml(p.name)}</b><br><span class="tiny muted">${escapeHtml(p.note)}</span></span>
      <span class="badge ${p.paid ? 'badge-stale' : 'badge-ok'}">${p.paid ? 'Paid' : 'Free'}</span>
    </div>`).join('');
  openSheet('addProviderSheet');
}

async function addProvider(preset) {
  const p = newProvider(preset);
  if (preset === 'anthropic') applyModelPrice(p, p.model);
  AI.providers.push(p);
  await saveAiSettings();
  closeSheet('addProviderSheet');
  await renderProviders();
  setTimeout(() => openProviderSheet(p.id), 250);
}

function fillModelSelect(p) {
  const sel = $('#prov_model_sel');
  const models = (p.models || []).length ? p.models : (p.type === 'gemini' ? GEMINI_MODELS.map(([id, label]) => ({ id, label })) : []);
  const ids = new Set(models.map(m => m.id));
  const opts = models.map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.label || m.id)}</option>`);
  if (p.model && !ids.has(p.model)) opts.unshift(`<option value="${escapeHtml(p.model)}">${escapeHtml(p.model)}</option>`);
  sel.innerHTML = opts.length ? opts.join('') : '<option value="">Tap Load to list models</option>';
  sel.value = p.model || '';
}

function openProviderSheet(id) {
  const p = providerById(id);
  if (!p) return;
  editingProviderId = id;
  const preset = PROVIDER_PRESETS[p.preset] || PROVIDER_PRESETS.custom;
  $('#provTitle').textContent = p.name;
  $('#provNote').textContent = preset.note;
  $('#provBadge').innerHTML = `<span class="badge ${p.paid ? 'badge-stale' : 'badge-ok'}">${p.paid ? 'Paid' : 'Free'}</span>`;
  $('#prov_name').value = p.name;
  $('#prov_base').value = p.baseUrl;
  $('#provBaseRow').classList.toggle('hidden', p.preset !== 'custom' && p.preset !== 'openai' && p.preset !== 'deepseek');
  $('#prov_key').value = p.apiKey || '';
  $('#prov_key').type = 'password';
  const link = $('#provKeyLink');
  link.classList.toggle('hidden', !preset.keyUrl);
  link.href = preset.keyUrl || '#';
  link.textContent = preset.keyUrl ? `Get a key → ${preset.keyUrl.replace(/^https:\/\//, '').split('/')[0]}` : '';
  $('#prov_model').value = p.model || '';
  fillModelSelect(p);
  $('#prov_paid').checked = !!p.paid;
  $('#prov_pin').value = p.priceIn || '';
  $('#prov_pout').value = p.priceOut || '';
  $('#provPriceRow').classList.toggle('hidden', !p.paid);
  $('#prov_enabled').checked = p.enabled !== false;
  $('#provStatus').textContent = '';
  $('#btnDeleteProvider').classList.toggle('hidden', AI.providers.length <= 1);
  openSheet('providerSheet', () => { editingProviderId = null; });
}

function toggleKeyVisibility() {
  const k = $('#prov_key');
  k.type = k.type === 'password' ? 'text' : 'password';
}

function readProviderSheet(p) {
  p.name = $('#prov_name').value.trim() || p.name;
  p.baseUrl = $('#prov_base').value.trim().replace(/\/$/, '') || p.baseUrl;
  p.apiKey = $('#prov_key').value.trim();
  p.model = $('#prov_model').value.trim();
  p.paid = $('#prov_paid').checked;
  p.priceIn = num($('#prov_pin').value);
  p.priceOut = num($('#prov_pout').value);
  p.enabled = $('#prov_enabled').checked;
}

function pickProviderModel(id) {
  const p = providerById(editingProviderId);
  if (!p || !id) return;
  $('#prov_model').value = id;
  const tmp = Object.assign({}, p);
  applyModelPrice(tmp, id);
  if (tmp.priceIn || tmp.priceOut || tmp.paid !== p.paid) {
    $('#prov_paid').checked = !!tmp.paid;
    $('#prov_pin').value = tmp.priceIn || '';
    $('#prov_pout').value = tmp.priceOut || '';
    $('#provPriceRow').classList.toggle('hidden', !tmp.paid);
  }
}

async function loadProviderModels() {
  const p = providerById(editingProviderId);
  if (!p) return;
  readProviderSheet(p);
  if (!p.apiKey && p.preset !== 'custom') { toast('Paste the API key first.', 'warn'); return; }
  const btn = $('#btnLoadModels');
  setBusy(btn, true, '');
  try {
    const n = await testProvider(p);
    fillModelSelect(p);
    $('#prov_model').value = p.model;
    pickProviderModel(p.model);
    $('#provStatus').innerHTML = `<span class="pos">● Key works — ${n} models available</span>`;
    haptic('success');
  } catch (e) {
    $('#provStatus').innerHTML = `<span class="neg">● ${escapeHtml(String(e.message || e).slice(0, 160))}</span>`;
  } finally {
    setBusy(btn, false);
  }
}

async function testProviderFromSheet() {
  const p = providerById(editingProviderId);
  if (!p) return;
  readProviderSheet(p);
  if (!p.model) { toast('Choose or type a model first.', 'warn'); return; }
  const btn = $('#btnTestProvider');
  setBusy(btn, true, 'Testing…');
  $('#provStatus').textContent = '';
  try {
    const text = await requestProvider(p, 'Reply with exactly: OK, ready to coach.', null, { maxTokens: 300 });
    $('#provStatus').innerHTML = `<span class="pos">● Working — "${escapeHtml(text.slice(0, 60))}"</span>`;
    haptic('success');
  } catch (e) {
    $('#provStatus').innerHTML = `<span class="neg">● ${escapeHtml(describeAiError(e))}</span>`;
    haptic('error');
  } finally {
    setBusy(btn, false);
    await renderSpend();
  }
}

async function saveProviderSheet() {
  const p = providerById(editingProviderId);
  if (!p) return;
  readProviderSheet(p);
  if (p.paid && !(p.priceIn > 0 || p.priceOut > 0)) {
    toast('Enter the prices for this paid model so spending can be capped.', 'warn', 4500);
    return;
  }
  await saveAiSettings();
  closeSheet('providerSheet');
  await renderProviders();
  toast(`${p.name} saved`, 'success', 1600);
  haptic('success');
}

async function makeProviderActive() {
  const p = providerById(editingProviderId);
  if (!p) return;
  readProviderSheet(p);
  AI.active = p.id;
  await saveAiSettings();
  closeSheet('providerSheet');
  await renderProviders();
  toast(`${p.name} is now the main AI provider`, 'success');
}

async function deleteProviderFromSheet() {
  const p = providerById(editingProviderId);
  if (!p || AI.providers.length <= 1) return;
  if (!(await uiConfirm(`Remove ${p.name}?`, 'Its key and settings are deleted from this phone.', { okText: 'Remove', danger: true }))) return;
  AI.providers = AI.providers.filter(x => x.id !== p.id);
  if (AI.active === p.id) AI.active = AI.providers[0].id;
  await saveAiSettings();
  closeSheet('providerSheet');
  await renderProviders();
}

// ---------- Spending ----------
async function renderSpend() {
  if (!AI) await loadAiSettings();
  const u = await getUsage();
  $('#cfg_cap').value = AI.capUsd;
  $('#spendText').textContent = `$${u.total.toFixed(2)} spent in ${new Date().toLocaleDateString('en-GB', { month: 'long' })}`;
  $('#spendCapText').textContent = AI.capUsd > 0 ? `cap $${num(AI.capUsd).toFixed(2)}` : 'no cap';
  const pct = AI.capUsd > 0 ? Math.min(100, (u.total / AI.capUsd) * 100) : 0;
  const bar = $('#spendBar');
  bar.style.width = `${Math.max(pct, u.total > 0 ? 2 : 0)}%`;
  bar.style.background = pct >= 100 ? 'var(--bad)' : pct >= 80 ? 'var(--warn)' : '';
  const rows = Object.values(u.byProvider);
  $('#spendBreakdown').innerHTML = rows.length
    ? rows.map(e => `<div class="list-item"><span>${escapeHtml(e.name)}<br><span class="tiny muted">${e.calls} request${e.calls === 1 ? '' : 's'} · ${Math.round((e.in + e.out) / 1000)}k tokens</span></span><b>${e.cost > 0 ? `$${e.cost.toFixed(3)}` : 'free'}</b></div>`).join('')
    : '<div class="small muted">No AI requests yet this month.</div>';
}

async function saveSpendCap() {
  const v = parseFloat($('#cfg_cap').value);
  if (!(v >= 0)) { toast('Enter a cap of 0 or more (0 = no cap).', 'warn'); return; }
  AI.capUsd = v;
  await saveAiSettings();
  await renderSpend();
  toast(v > 0 ? `Monthly cap set to $${v.toFixed(2)}` : 'Spend cap removed', 'success');
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
  const ftp = parseInt($('#cfg_ftp').value, 10);
  await setConfig('ftp_w', ftp > 0 && ftp < 700 ? String(ftp) : '');
  await loadPhysioConfig();
  await recalculateAll(true);
}

async function setPref(key, on) {
  await setConfig(key, on ? '1' : '0');
  haptic('light');
}

function setHaptics(on) {
  try { localStorage.setItem('rp_haptics', on ? 'on' : 'off'); } catch (e) {}
  if (on) haptic('light');
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
    const res = await saveOrShareFile(name, JSON.stringify(dump), { mime: 'application/json', title: 'Training Partner backup' });
    if (res.ok) toast(`Backup exported → ${res.where}`, 'success');
  } catch (e) {
    toast(`Export failed: ${e.message}`, 'error');
  }
}

async function importDatabaseJson(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) { toast('No file was selected.', 'warn'); return; }
  let data;
  try {
    data = JSON.parse(await file.text());
    if (!data || !Array.isArray(data.workouts)) throw new Error('this is not a Training Partner backup');
  } catch (e) {
    toast(`Can't read "${file.name}": ${e.message}`, 'error', 6000);
    return;
  }
  const ok = await uiConfirm('Restore backup?', `"${file.name}" contains ${data.workouts.length} rides${Array.isArray(data.streams) ? `, ${data.streams.length} telemetry streams` : ''} and ${(data.threads || []).length + (data.master_chat || []).length} coach messages.\n\nYour current rides, chats and settings are replaced. API keys and your Strava login stay. A restore point is created first so you can undo this.`, { okText: 'Restore' });
  if (!ok) return;
  try {
    toast('Restoring backup…', 'info', 2500);
    await createRestorePoint('Before importing a backup file', 'auto');
    await restoreDump(data, { preserveSecrets: true });
    await afterDataReplaced(`Restored ${data.workouts.length} rides`);
    haptic('success');
    switchTab('rides');
  } catch (e) {
    toast(`Restore failed: ${e.message}`, 'error', 6000);
  }
}

async function afterDataReplaced(msg) {
  await loadPhysioConfig();
  await loadAiSettings();
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

// --------------------------------------------------------
// MODEL PER COACH + COACH MEMORY
// --------------------------------------------------------
function renderAgentModels() {
  const host = $('#agentModelList');
  if (!host || !AI) return;
  host.innerHTML = Object.entries(AI_AGENTS).map(([k, label]) => {
    const c = agentChoice(k);
    return `<button class="list-row" onclick="openModelPicker('${k}')">
      <span class="grow"><b>${escapeHtml(label)}</b><br><span class="tiny muted">${escapeHtml(agentModelLabel(k))}${c && c.strict ? ' · keeps retrying' : ''}</span></span>${icon('chevron', 'ic-sm muted')}</button>`;
  }).join('');
}

async function renderMemory() {
  const host = $('#memoryList');
  if (!host) return;
  const m = await getCoachMemory();
  host.innerHTML = m.length
    ? m.map(x => `<div class="list-row"><span class="grow">${escapeHtml(x.text)}<br><span class="tiny muted">${escapeHtml(x.source || 'you')} · ${escapeHtml(relativeTime(x.created_at))}</span></span>
        <button class="x-btn" onclick="removeMemoryFact('${escapeHtml(x.id)}')" aria-label="Delete">${icon('x', 'ic-sm')}</button></div>`).join('')
    : '<div class="small muted">Nothing yet.</div>';
}

async function addMemoryFact() {
  const input = $('#memory_new');
  const text = input.value.trim().slice(0, 240);
  if (!text) return;
  const m = await getCoachMemory();
  m.push({ id: Date.now().toString(36), text, source: 'you', created_at: new Date().toISOString() });
  await setJsonConfig('coach_memory', m.slice(-60));
  input.value = '';
  haptic('light');
  await renderMemory();
}

async function removeMemoryFact(id) {
  await setJsonConfig('coach_memory', (await getCoachMemory()).filter(x => x.id !== id));
  await renderMemory();
}
