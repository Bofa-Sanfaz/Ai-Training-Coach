'use strict';
// --------------------------------------------------------
// TRAINING PLAN
// - Weekly template (Mon…Sun) = the athlete's own preset plan, repeating every week
// - Date overrides = changes for specific days (manual, Aether, AI planner)
// - Weekly targets = default + per-week overrides (this / next week)
// - Done = ticked manually, or a ride exists on that date
// --------------------------------------------------------
const PLAN_TYPES = {
  rest: { label: 'Rest', color: '#94a3b8' },
  recovery: { label: 'Recovery', color: '#94a3b8' },
  endurance: { label: 'Endurance', color: '#16a34a' },
  long: { label: 'Long ride', color: '#16a34a' },
  tempo: { label: 'Tempo', color: '#eab308' },
  threshold: { label: 'Threshold', color: '#fc5200' },
  vo2: { label: 'VO2max', color: '#ef4444' },
  other: { label: 'Session', color: '#64748b' }
};
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
let planBusy = false;
let planWeekOffset = 0;
let editingPlanDay = null; // { mode: 'date'|'template', key: 'YYYY-MM-DD' | 0..6 }

function weekdayIndex(dateStr) {
  return (parseSafeDate(dateStr).getDay() + 6) % 7;
}

function cleanSession(s) {
  if (!s) return null;
  const type = PLAN_TYPES[s.type] ? s.type : 'other';
  return {
    title: String(s.title || PLAN_TYPES[type].label).slice(0, 60),
    type,
    duration_min: type === 'rest' ? 0 : Math.max(0, Math.min(600, Math.round(num(s.duration_min)))),
    zone: String(s.zone || '').slice(0, 20),
    details: String(s.details || '').slice(0, 400)
  };
}

// ---------- Storage ----------
async function getPlanTemplate() {
  const t = await getJsonConfig('plan_template', null);
  return t && Array.isArray(t.days) && t.days.length === 7 ? t : { days: [null, null, null, null, null, null, null] };
}

async function getPlanOverrides() {
  return (await getJsonConfig('plan_overrides', {})) || {};
}

async function getPlanDone() {
  return (await getJsonConfig('plan_done', {})) || {};
}

// One-time migration of the 3.1 "week_plan" into date overrides
async function migrateWeekPlan() {
  const old = await getJsonConfig('week_plan', null);
  if (!old || !Array.isArray(old.days)) return;
  const ov = await getPlanOverrides();
  const done = await getPlanDone();
  for (const d of old.days) {
    if (!d.date) continue;
    if (!ov[d.date]) ov[d.date] = Object.assign(cleanSession(d), { source: 'ai' });
    if (d.done) done[d.date] = true;
  }
  await setJsonConfig('plan_overrides', ov);
  await setJsonConfig('plan_done', done);
  await setConfig('week_plan', '');
}

async function planContext() {
  const [template, overrides, done] = await Promise.all([getPlanTemplate(), getPlanOverrides(), getPlanDone()]);
  const rideDates = new Set((await db.workouts.toArray()).map(w => String(w.date).slice(0, 10)));
  return { template, overrides, done, rideDates };
}

// Session for a date: override wins, else the weekly template
function sessionFor(ctx, dateStr) {
  const ov = ctx.overrides[dateStr];
  if (ov) return Object.assign({}, ov, { source: ov.source || 'manual', changed: true });
  const t = ctx.template.days[weekdayIndex(dateStr)];
  return t ? Object.assign({}, t, { source: 'template', changed: false }) : null;
}

function sessionDone(ctx, dateStr) {
  if (ctx.done[dateStr] === false) return false;
  return !!ctx.done[dateStr] || ctx.rideDates.has(dateStr);
}

function weekDates(offsetWeeks = 0) {
  const start = addDays(startOfWeek(new Date()), offsetWeeks * 7);
  return Array.from({ length: 7 }, (_, i) => formatLocalDate(addDays(start, i)));
}

async function todayPlanItem() {
  const ctx = await planContext();
  const today = formatLocalDate(new Date());
  const s = sessionFor(ctx, today);
  return s ? Object.assign(s, { done: sessionDone(ctx, today) }) : null;
}

// Planned vs done over the last N days (rest days excluded)
async function planAdherence(days = 14) {
  const ctx = await planContext();
  const out = [];
  for (let i = days; i >= 1; i--) {
    const d = formatLocalDate(addDays(new Date(), -i));
    const s = sessionFor(ctx, d);
    if (!s || s.type === 'rest') continue;
    out.push({ date: d, title: s.title, type: s.type, done: sessionDone(ctx, d) });
  }
  return out;
}

// ---------- Weekly targets ----------
async function getWeeklyGoals(weekStart) {
  const def = (await getJsonConfig('weekly_goals', {})) || {};
  const base = { km: num(def.km), hours: num(def.hours), rides: num(def.rides), note: def.note || '', scope: 'default' };
  if (!weekStart) return base;
  const per = (await getJsonConfig('weekly_targets', {})) || {};
  const o = per[weekStart];
  return o ? { km: num(o.km), hours: num(o.hours), rides: num(o.rides), note: o.note || '', scope: 'week' } : base;
}

async function setTargets(scope, t) {
  const clean = { km: Math.max(0, num(t.km)), hours: Math.max(0, num(t.hours)), rides: Math.max(0, Math.round(num(t.rides))), note: String(t.note || '').slice(0, 120) };
  if (scope === 'default') {
    await setJsonConfig('weekly_goals', clean);
  } else {
    const ws = formatLocalDate(addDays(startOfWeek(new Date()), scope === 'next_week' ? 7 : 0));
    const per = (await getJsonConfig('weekly_targets', {})) || {};
    per[ws] = clean;
    await setJsonConfig('weekly_targets', per);
  }
}

async function saveWeeklyGoals() {
  await setTargets('default', { km: $('#goal_km').value, hours: $('#goal_hours').value, rides: $('#goal_rides').value, note: (await getWeeklyGoals()).note });
  toast('Default weekly targets saved', 'success');
  haptic('success');
}

async function renderGoalsForm() {
  const g = await getWeeklyGoals();
  $('#goal_km').value = g.km || '';
  $('#goal_hours').value = g.hours || '';
  $('#goal_rides').value = g.rides || '';
}

// ---------- Applying changes (manual editor, Aether proposals, AI planner) ----------
async function applyPlanChanges(change, source) {
  const applied = [];
  if (Array.isArray(change.days) && change.days.length) {
    const ov = await getPlanOverrides();
    for (const d of change.days) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d.date))) continue;
      ov[d.date] = Object.assign(cleanSession(d), { source });
      applied.push(`${formatNiceDate(d.date, false)}: ${ov[d.date].title}`);
    }
    await setJsonConfig('plan_overrides', ov);
  }
  if (Array.isArray(change.template) && change.template.length) {
    const t = await getPlanTemplate();
    for (const d of change.template) {
      const i = WEEKDAYS.findIndex(w => w.toLowerCase() === String(d.weekday || '').slice(0, 3).toLowerCase());
      if (i < 0) continue;
      t.days[i] = d.type === 'rest' && !d.title ? cleanSession({ type: 'rest', title: 'Rest' }) : cleanSession(d);
      applied.push(`Every ${WEEKDAYS[i]}: ${t.days[i].title}`);
    }
    await setJsonConfig('plan_template', t);
  }
  if (change.targets && typeof change.targets === 'object') {
    const scope = ['this_week', 'next_week', 'default'].includes(change.targets.scope) ? change.targets.scope : 'this_week';
    const cur = await getWeeklyGoals(scope === 'default' ? null : formatLocalDate(addDays(startOfWeek(new Date()), scope === 'next_week' ? 7 : 0)));
    await setTargets(scope, Object.assign({}, cur, change.targets));
    applied.push(`Targets (${scope.replace('_', ' ')}): ${[change.targets.km ? `${change.targets.km} km` : '', change.targets.hours ? `${change.targets.hours} h` : '', change.targets.rides ? `${change.targets.rides} rides` : ''].filter(Boolean).join(', ') || 'updated'}`);
  }
  return applied;
}

function describePlanChange(change) {
  const lines = [];
  for (const d of change.days || []) lines.push(`${d.date ? formatNiceDate(d.date, false) : '?'} → ${d.title || d.type}${d.duration_min ? ` · ${d.duration_min} min` : ''}${d.zone ? ` · ${d.zone}` : ''}`);
  for (const d of change.template || []) lines.push(`Every ${d.weekday} → ${d.title || d.type}${d.duration_min ? ` · ${d.duration_min} min` : ''}${d.zone ? ` · ${d.zone}` : ''}`);
  if (change.targets) {
    const t = change.targets;
    lines.push(`Weekly targets (${String(t.scope || 'this_week').replace('_', ' ')}) → ${[t.km ? `${t.km} km` : '', t.hours ? `${t.hours} h` : '', t.rides ? `${t.rides} rides` : '', t.note || ''].filter(Boolean).join(' · ')}`);
  }
  return lines;
}

// ---------- AI planner ("Plan with AI") ----------
function parsePlanJson(text) {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The AI did not return a plan.');
  const raw = JSON.parse(text.slice(start, end + 1));
  const days = (raw.days || []).slice(0, 7).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(String(d.date)));
  if (!days.length) throw new Error('The plan was empty.');
  return { summary: String(raw.summary || '').slice(0, 400), days, targets: raw.targets };
}

async function generateWeekPlan() {
  if (planBusy) return;
  const ok = await uiConfirm('Re-plan the next 7 days?', 'The AI adapts your weekly template to your current form, targets and recent rides. Your template itself is not changed — only these 7 days. You can reset any day back to your template.', { okText: 'Plan with AI' });
  if (!ok) return;
  planBusy = true;
  const btn = $('#btnPlan');
  setBusy(btn, true, 'Planning…');
  try {
    const text = await callAI(await buildPlannerPrompt(), null, { json: true, maxTokens: 4000 });
    if (!text) return;
    const plan = parsePlanJson(text);
    await applyPlanChanges({ days: plan.days }, 'ai');
    if (plan.summary) await setConfig('plan_summary', plan.summary);
    toast('Next 7 days planned', 'success');
    haptic('success');
  } catch (e) {
    toast(`Could not build a plan: ${e.message}`, 'error', 5000);
  } finally {
    planBusy = false;
    setBusy(btn, false);
    if (Router.current === 'coach') renderCoachList();
  }
}

// ---------- Plan card (Coach tab) ----------
async function planCardHtml() {
  const ctx = await planContext();
  const dates = weekDates(planWeekOffset);
  const today = formatLocalDate(new Date());
  const hasTemplate = ctx.template.days.some(Boolean);
  const targets = await getWeeklyGoals(dates[0]);
  const summary = planWeekOffset === 0 ? await getConfig('plan_summary') : '';
  const label = planWeekOffset === 0 ? 'This week' : planWeekOffset === 1 ? 'Next week' : planWeekOffset === -1 ? 'Last week' : `Week of ${formatNiceDate(dates[0], false)}`;

  const rows = dates.map(d => {
    const s = sessionFor(ctx, d);
    const t = s ? PLAN_TYPES[s.type] || PLAN_TYPES.other : null;
    const dt = parseSafeDate(d);
    const done = s && s.type !== 'rest' && sessionDone(ctx, d);
    const missed = s && s.type !== 'rest' && d < today && !done;
    const src = s && s.changed ? `<span class="src-tag">${s.source === 'aether' ? 'Aether' : s.source === 'ai' ? 'AI' : 'changed'}</span>` : '';
    return `<div class="plan-day ${done ? 'done' : ''} ${missed ? 'missed' : ''} ${d === today ? 'today' : ''}">
      <button class="plan-check" onclick="togglePlanDone('${d}')" aria-label="Mark done" ${!s || s.type === 'rest' ? 'disabled' : ''}>${icon(missed ? 'x' : 'check-circle')}</button>
      <div class="plan-date"><b>${dt.toLocaleDateString('en-GB', { weekday: 'short' })}</b><span>${dt.getDate()}</span></div>
      <div class="grow plan-body" onclick="openPlanDayEditor('date','${d}')">
        ${s ? `<div class="plan-title"><span class="plan-dot" style="background:${t.color}"></span>${escapeHtml(s.title)}${src}</div>
          <div class="tiny muted">${s.type === 'rest' ? 'Rest day' : `${s.duration_min} min${s.zone ? ` · ${escapeHtml(s.zone)}` : ''}`}</div>
          ${s.details ? `<div class="plan-details">${escapeHtml(s.details)}</div>` : ''}`
          : '<div class="plan-title muted">Nothing planned <span class="tiny">— tap to add</span></div>'}
      </div>
    </div>`;
  }).join('');

  const tgt = [targets.km ? `${targets.km} km` : '', targets.hours ? `${targets.hours} h` : '', targets.rides ? `${targets.rides} rides` : ''].filter(Boolean).join(' · ');
  return `<div class="card plan-card">
    <div class="row between">
      <div class="card-title">${icon('calendar')}Training plan</div>
      <span class="row" style="gap:4px">
        <button class="icon-btn sm" onclick="shiftPlanWeek(-1)" aria-label="Previous week">${icon('back', 'ic-sm')}</button>
        <span class="small" style="min-width:76px;text-align:center;font-weight:600">${label}</span>
        <button class="icon-btn sm" onclick="shiftPlanWeek(1)" aria-label="Next week">${icon('chevron', 'ic-sm')}</button>
      </span>
    </div>
    <div class="target-line" onclick="openTargetsEditor()">${icon('flame', 'ic-sm')}<span class="grow">${tgt ? `Targets: ${tgt}${targets.scope === 'week' ? ' <span class="src-tag">this week only</span>' : ''}` : 'No weekly targets — tap to set'}${targets.note ? ` · ${escapeHtml(targets.note)}` : ''}</span>${icon('chevron', 'ic-sm muted')}</div>
    ${summary ? `<div class="card-sub">${escapeHtml(summary)}</div>` : ''}
    ${!hasTemplate ? `<div class="callout mt-8">${icon('info')}<div>Add your own weekly plan once with <b>Edit my template</b>, or paste it to Aether ("here is my plan…").</div></div>` : ''}
    <div class="plan-days mt-8">${rows}</div>
    <div class="btn-row mt-12">
      <button class="btn btn-secondary btn-sm" onclick="openTemplateEditor()">${icon('repeat', 'ic-sm')}Edit my template</button>
      <button id="btnPlan" class="btn btn-secondary btn-sm" onclick="generateWeekPlan()">${icon('sparkle', 'ic-sm')}Adapt with AI</button>
    </div>
  </div>`;
}

function shiftPlanWeek(delta) {
  planWeekOffset = Math.max(-4, Math.min(4, planWeekOffset + delta));
  haptic('light');
  renderCoachList();
}

async function togglePlanDone(dateStr) {
  const done = await getPlanDone();
  const ctx = await planContext();
  done[dateStr] = !sessionDone(ctx, dateStr);
  await setJsonConfig('plan_done', done);
  haptic('light');
  renderCoachList();
  if (dateStr === formatLocalDate(new Date())) renderRides();
}

// ---------- Day / template editor sheet ----------
async function openPlanDayEditor(mode, key) {
  editingPlanDay = { mode, key };
  let s;
  if (mode === 'date') {
    const ctx = await planContext();
    s = sessionFor(ctx, key);
    $('#pdTitle').textContent = formatNiceDate(key, false);
    $('#pdSub').textContent = s && s.changed ? `Changed from your template (${s.source})` : 'From your weekly template';
  } else {
    s = (await getPlanTemplate()).days[key];
    $('#pdTitle').textContent = `Every ${WEEKDAYS[key]}`;
    $('#pdSub').textContent = 'Your repeating weekly template';
  }
  $('#pd_type').innerHTML = Object.entries(PLAN_TYPES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  $('#pd_type').value = s ? s.type : 'endurance';
  $('#pd_title').value = s ? s.title : '';
  $('#pd_dur').value = s && s.type !== 'rest' ? s.duration_min : '';
  $('#pd_zone').value = s ? s.zone : '';
  $('#pd_details').value = s ? s.details : '';
  $('#pdDateActions').classList.toggle('hidden', mode !== 'date');
  $$('#planDaySheet .template-only').forEach(el => el.classList.toggle('hidden', mode !== 'template'));
  $('#pdResetBtn').classList.toggle('hidden', !(mode === 'date' && s && s.changed));
  openSheet('planDaySheet', () => { editingPlanDay = null; });
}

function readPlanDayForm() {
  const type = $('#pd_type').value;
  return cleanSession({ type, title: $('#pd_title').value.trim() || PLAN_TYPES[type].label, duration_min: $('#pd_dur').value, zone: $('#pd_zone').value.trim(), details: $('#pd_details').value.trim() });
}

async function savePlanDay(alsoTemplate) {
  if (!editingPlanDay) return;
  const s = readPlanDayForm();
  const { mode, key } = editingPlanDay;
  if (mode === 'template' || alsoTemplate) {
    const t = await getPlanTemplate();
    t.days[mode === 'template' ? key : weekdayIndex(key)] = s;
    await setJsonConfig('plan_template', t);
  }
  if (mode === 'date') {
    const ov = await getPlanOverrides();
    if (alsoTemplate) delete ov[key];
    else ov[key] = Object.assign({}, s, { source: 'manual' });
    await setJsonConfig('plan_overrides', ov);
  }
  closeSheet('planDaySheet');
  toast('Plan updated', 'success', 1500);
  haptic('success');
  afterPlanChange();
}

async function clearPlanDay() {
  if (!editingPlanDay) return;
  const { mode, key } = editingPlanDay;
  if (mode === 'template') {
    const t = await getPlanTemplate();
    t.days[key] = null;
    await setJsonConfig('plan_template', t);
  } else {
    const ov = await getPlanOverrides();
    ov[key] = cleanSession({ type: 'rest', title: 'Rest' });
    ov[key].source = 'manual';
    await setJsonConfig('plan_overrides', ov);
  }
  closeSheet('planDaySheet');
  afterPlanChange();
}

async function resetPlanDay() {
  if (!editingPlanDay || editingPlanDay.mode !== 'date') return;
  const ov = await getPlanOverrides();
  delete ov[editingPlanDay.key];
  await setJsonConfig('plan_overrides', ov);
  closeSheet('planDaySheet');
  toast('Back to your template', 'success', 1500);
  afterPlanChange();
}

async function openTemplateEditor() {
  const t = await getPlanTemplate();
  $('#templateRows').innerHTML = WEEKDAYS.map((d, i) => {
    const s = t.days[i];
    const ty = s ? PLAN_TYPES[s.type] || PLAN_TYPES.other : null;
    return `<div class="list-item prov-row" onclick="closeSheet('templateSheet'); setTimeout(() => openPlanDayEditor('template', ${i}), 260)">
      <b style="width:40px">${d}</b>
      <span class="grow">${s ? `<span class="plan-dot" style="background:${ty.color}"></span> ${escapeHtml(s.title)}<br><span class="tiny muted">${s.type === 'rest' ? 'Rest' : `${s.duration_min} min${s.zone ? ` · ${escapeHtml(s.zone)}` : ''}`}</span>` : '<span class="muted">Empty</span>'}</span>
      ${icon('chevron', 'ic-sm muted')}</div>`;
  }).join('');
  openSheet('templateSheet');
}

async function openTargetsEditor() {
  const ws = weekDates(Math.max(0, Math.min(1, planWeekOffset)))[0];
  const cur = await getWeeklyGoals(ws);
  $('#tg_km').value = cur.km || '';
  $('#tg_hours').value = cur.hours || '';
  $('#tg_rides').value = cur.rides || '';
  $('#tg_note').value = cur.note || '';
  $('#tg_scope').value = planWeekOffset === 1 ? 'next_week' : (cur.scope === 'week' ? 'this_week' : 'default');
  openSheet('targetsSheet');
}

async function saveTargetsSheet() {
  await setTargets($('#tg_scope').value, { km: $('#tg_km').value, hours: $('#tg_hours').value, rides: $('#tg_rides').value, note: $('#tg_note').value.trim() });
  closeSheet('targetsSheet');
  toast('Targets saved', 'success', 1500);
  haptic('success');
  afterPlanChange();
}

function afterPlanChange() {
  if (Router.current === 'coach') renderCoachList();
  if (Router.current === 'rides') renderRides();
}
