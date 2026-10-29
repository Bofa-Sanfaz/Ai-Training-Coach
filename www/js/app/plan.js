'use strict';
// --------------------------------------------------------
// WEEKLY GOALS + AI 7-DAY PLAN
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
let planBusy = false;

// ---------- Goals ----------
async function getWeeklyGoals() {
  const g = await getJsonConfig('weekly_goals', {});
  return { km: num(g.km), hours: num(g.hours), rides: num(g.rides) };
}

async function saveWeeklyGoals() {
  const g = { km: num($('#goal_km').value), hours: num($('#goal_hours').value), rides: num($('#goal_rides').value) };
  if (g.km < 0 || g.hours < 0 || g.rides < 0) { toast('Goals must be 0 or more.', 'warn'); return; }
  await setJsonConfig('weekly_goals', g);
  toast('Weekly goals saved', 'success');
  haptic('success');
}

async function renderGoalsForm() {
  const g = await getWeeklyGoals();
  $('#goal_km').value = g.km || '';
  $('#goal_hours').value = g.hours || '';
  $('#goal_rides').value = g.rides || '';
}

// ---------- Plan ----------
async function getWeekPlan() {
  const p = await getJsonConfig('week_plan', null);
  return p && Array.isArray(p.days) ? p : null;
}

function todayPlanItem(plan) {
  if (!plan) return null;
  const today = formatLocalDate(new Date());
  return plan.days.find(d => d.date === today) || null;
}

function parsePlanJson(text) {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The AI did not return a plan.');
  const raw = JSON.parse(text.slice(start, end + 1));
  const days = (raw.days || []).slice(0, 7).map(d => ({
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(d.date)) ? d.date : '',
    title: String(d.title || 'Session').slice(0, 60),
    type: PLAN_TYPES[d.type] ? d.type : 'other',
    duration_min: Math.max(0, Math.round(num(d.duration_min))),
    zone: String(d.zone || '').slice(0, 20),
    details: String(d.details || '').slice(0, 400),
    done: false
  }));
  if (!days.length) throw new Error('The plan was empty.');
  // Make sure dates are consecutive from today even if the model skipped them
  const start0 = new Date();
  days.forEach((d, i) => { if (!d.date) d.date = formatLocalDate(addDays(start0, i)); });
  return { created_at: new Date().toISOString(), summary: String(raw.summary || '').slice(0, 400), days };
}

async function buildPlanPrompt() {
  const all = await db.workouts.orderBy('date').toArray();
  const since = addDays(new Date(), -21);
  const recent = all.filter(w => parseSafeDate(w.date) >= since);
  const weights = await getWeightHistory();
  const ledger = [];
  for (const w of recent) ledger.push(rideLedgerLine(w, await getAthleteWeightForDate(w.date, weights), w.note));
  const goals = await getWeeklyGoals();
  const ctx = await athleteContext(formatLocalDate(new Date()), await getLatestWeight());
  const { cur } = weekSummary(all);
  const days = Array.from({ length: 7 }, (_, i) => { const d = addDays(new Date(), i); return `${formatLocalDate(d)} (${d.toLocaleDateString('en-US', { weekday: 'long' })})`; });
  return `CURRENT DATE: ${ctx.today}
You are ${ATHLETE.name}'s cycling coach. Build the next 7 days of training.
${bioLine(ctx)}
CARDIAC ZONES: ${zoneFrameworkText()}
ACTIVE TRAINING PHASE: "${ctx.goal}"
WEEKLY GOALS: ${goals.km ? `${goals.km} km` : 'no distance goal'}, ${goals.hours ? `${goals.hours} h` : 'no time goal'}, ${goals.rides ? `${goals.rides} rides` : 'no ride-count goal'}. Already done this week (Mon–today): ${cur.count} rides, ${fmtNum(cur.dist, 0)} km, ${formatHours(cur.sec)}.
${await loadContextText()}

LAST 21 DAYS OF RIDES:
${ledger.join('\n') || 'No rides in the last 21 days.'}

RULES:
- Plan exactly these 7 days, in order: ${days.join(', ')}.
- Respect current form: if Form (TSB) is below -20, start with recovery; never schedule hard days back-to-back.
- Include at least one rest or recovery day. Fit the active phase and the weekly goals.
- Heart-rate zones only (no power targets unless a power meter is used).

Return ONLY a JSON object with this shape:
{"summary":"one or two sentences on the week's intent","days":[{"date":"YYYY-MM-DD","title":"short name","type":"rest|recovery|endurance|long|tempo|threshold|vo2|other","duration_min":60,"zone":"Z2","details":"structure of the session in one or two sentences"}]}`;
}

async function generateWeekPlan() {
  if (planBusy) return;
  planBusy = true;
  const btn = $('#btnPlan');
  setBusy(btn, true, 'Planning your week…');
  try {
    const text = await callAI(await buildPlanPrompt(), null, { json: true, maxTokens: 4000 });
    if (!text) return;
    const plan = parsePlanJson(text);
    await setJsonConfig('week_plan', plan);
    toast('New 7-day plan ready', 'success');
    haptic('success');
  } catch (e) {
    toast(`Could not build a plan: ${e.message}`, 'error', 5000);
  } finally {
    planBusy = false;
    setBusy(btn, false);
    if (Router.current === 'coach') renderCoachList();
  }
}

async function togglePlanDay(i) {
  const plan = await getWeekPlan();
  if (!plan || !plan.days[i]) return;
  plan.days[i].done = !plan.days[i].done;
  await setJsonConfig('week_plan', plan);
  haptic('light');
  const row = document.querySelector(`[data-plan-row="${i}"]`);
  if (row) row.classList.toggle('done', plan.days[i].done);
}

async function planCardHtml() {
  const plan = await getWeekPlan();
  const today = formatLocalDate(new Date());
  const stale = plan && plan.days.every(d => d.date < today);
  if (!plan || stale) {
    return `<div class="card plan-card">
      <div class="card-title">${icon('calendar')}Your next 7 days</div>
      <div class="card-sub">Let the coach plan the week from your form, phase, goals and recent rides.</div>
      <button id="btnPlan" class="btn btn-primary mt-12" onclick="generateWeekPlan()">${icon('sparkle')}Plan my week</button>
    </div>`;
  }
  return `<div class="card plan-card">
    <div class="row between"><div class="card-title">${icon('calendar')}Week plan</div>
      <button id="btnPlan" class="btn btn-ghost btn-xs" onclick="generateWeekPlan()">${icon('refresh', 'ic-sm')}Re-plan</button></div>
    ${plan.summary ? `<div class="card-sub">${escapeHtml(plan.summary)}</div>` : ''}
    <div class="plan-days mt-8">${plan.days.map((d, i) => {
      const t = PLAN_TYPES[d.type] || PLAN_TYPES.other;
      const dt = parseSafeDate(d.date);
      return `<div class="plan-day ${d.done ? 'done' : ''} ${d.date === today ? 'today' : ''} ${i >= 3 ? 'plan-more hidden' : ''}" data-plan-row="${i}">
        <button class="plan-check" onclick="togglePlanDay(${i})" aria-label="Mark done">${icon('check-circle')}</button>
        <div class="plan-date"><b>${dt.toLocaleDateString('en-GB', { weekday: 'short' })}</b><span>${dt.getDate()}</span></div>
        <div class="grow"><div class="plan-title"><span class="plan-dot" style="background:${t.color}"></span>${escapeHtml(d.title)}</div>
          <div class="tiny muted">${d.type === 'rest' ? 'Rest day' : `${d.duration_min} min${d.zone ? ` · ${escapeHtml(d.zone)}` : ''}`}</div>
          ${d.details ? `<div class="plan-details">${escapeHtml(d.details)}</div>` : ''}</div>
      </div>`;
    }).join('')}</div>
    ${plan.days.length > 3 ? `<button class="btn btn-ghost btn-sm mt-8" style="width:100%" onclick="togglePlanMore(this)">Show full week</button>` : ''}
  </div>`;
}

function togglePlanMore(btn) {
  const rows = $$('.plan-more');
  const show = rows.some(r => r.classList.contains('hidden'));
  rows.forEach(r => r.classList.toggle('hidden', !show));
  btn.textContent = show ? 'Show less' : 'Show full week';
}
