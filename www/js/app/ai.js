'use strict';
// --------------------------------------------------------
// AI CONTEXT & PROMPTS
// Every AI role ("agent") gets its own context, sized to its job:
//   aether   – season coach: everything (profile, phase history, template + plan,
//              targets, adherence, load trend, weekly totals, bests, wellness,
//              detailed recent rides + monthly summaries, notes, dialogue)
//   ride     – one ride in depth: timeline, planned session that day, load & wellness
//              on that date, prior comparable rides, notes
//   compare  – the selected rides with their own date context
//   report   – one period vs the previous one, adherence, trend
//   trends   – season-level trends and bests
//   planner  – template, targets, form, adherence, recent rides, wellness
// Each role also receives the coaching skills assigned to it (skills.js).
// The provider client lives in providers.js.
// --------------------------------------------------------

// Small-context models get a compact version of the long sections. Detailed ride
// lines are capped for every model: they are the biggest part of a prompt and the
// main reason for slow replies; older rides are summarised by month instead.
function contextBudget(agent) {
  const c = agent && typeof agentChoice === 'function' ? agentChoice(agent) : null;
  const p = c ? c.p : (typeof activeProvider === 'function' ? activeProvider() : null);
  const model = c ? c.model : p && p.model;
  // Whole name parts only ("gemini" must not match "mini"); ≤14B open models count as small
  const small = p && (p.preset === 'groq' || p.preset === 'custom' || /(^|[-_/:.])(lite|mini|small|nano|tiny|(?:[1-9]|1[0-4])b)([-_/:.]|$)/i.test(model || ''));
  return small ? { detailedRides: 12, priorRides: 6, weeks: 8, timelineStep: 2 } : { detailedRides: 25, priorRides: 10, weeks: 12, timelineStep: 1 };
}

// Reply style. Written after reviewing the athlete's real conversations: replies were
// long (≈3,000 characters), repeated the same closing question, kept bringing up body
// weight and used hype words. Corrections the athlete gave were forgotten in other threads.
function formattingRules(kind = 'chat') {
  const len = { chat: 'Keep it short: answer the question in the first sentence, then at most ~150 words unless the athlete asks for detail.',
    debrief: 'At most ~300 words.',
    long: 'Be thorough but tight: no filler, no repetition.' }[kind] || '';
  return `STYLE: ${len}
- Plain English with units; short bullets are fine. No LaTeX, no dollar signs, no formula derivations, no pipe tables.
- Calm, factual, coach-to-athlete tone. No hype ("beast", "insane", "elite"), no flattery, no emojis.
- Only mention body weight when it changes the answer or the athlete asks.
- Don't end with a question unless you truly need an answer to continue; never repeat a question already asked in this conversation.
- If data is missing, flagged as an error or looks implausible, say so briefly instead of building conclusions on it. A readiness call needs sleep/HRV/resting HR — if they are missing, say the call is based on training load only.
- Use only numbers that appear in the context (max HR, zones, weights, distances…). Never restate a physiological value from memory or invent a session, symptom or event.
- Address the athlete by the name in the ATHLETE line.
- If you learn a lasting fact about the athlete or a correction (equipment, injuries, a workout's true type, schedule, goals), add it on its own line as <remember>one short fact</remember> — it is saved to the coach memory every coach reads.`;
}

function dataNotes() {
  return `DATA NOTES:
- Sports: rides, runs (incl. treadmill), swims (mostly pool — no GPS) and gym & other (elliptical, stepper, rowing, strength). Sources: Strava, or the Galaxy Watch via Samsung Health. Speeds of different sports are never comparable; load (TRIMP, from heart rate) and time are.
- Power/kJ are Strava estimates unless a ride is marked "power meter"; NP/IF/TSS appear only for power-meter rides.
- Values the athlete marked as data errors are shown as "flagged" and must not be used; "indoor" rides have no real distance/speed/climbing.
- Decoupling is Speed:HR on moving time (Power:HR with a power meter); MTB terrain adds noise.
- Load = Banister TRIMP from heart rate; Fitness CTL 42-day, Fatigue ATL 7-day, Form TSB = yesterday's CTL - ATL; ACWR = ATL/CTL.`;
}

// --------------------------------------------------------
// COACH MEMORY — facts every coach must keep in mind (shared by all agents)
// Added by the athlete in Profile or by a coach with <remember>…</remember>.
// --------------------------------------------------------
const REMEMBER_RE = /<remember>\s*([\s\S]*?)\s*<\/remember>/gi;

async function getCoachMemory() {
  const m = await getJsonConfig('coach_memory', []);
  return Array.isArray(m) ? m : [];
}

async function coachMemoryText() {
  const m = await getCoachMemory();
  return m.length ? `COACH MEMORY (facts and corrections from the athlete — always respect these):\n${m.map(x => `- ${x.text}`).join('\n')}` : '';
}

// Saves <remember> facts from a reply and returns the reply without the tags
async function captureMemory(text, source) {
  const facts = [];
  const clean = String(text || '').replace(REMEMBER_RE, (_, f) => { if (f.trim()) facts.push(f.trim().slice(0, 240)); return ''; }).replace(/\n{3,}/g, '\n\n').trim();
  if (facts.length) {
    const m = await getCoachMemory();
    const have = new Set(m.map(x => x.text.toLowerCase()));
    for (const f of facts) if (!have.has(f.toLowerCase())) m.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), text: f, source, created_at: new Date().toISOString() });
    await setJsonConfig('coach_memory', m.slice(-60));
    toast(`Saved to coach memory: ${facts[0]}${facts.length > 1 ? ` (+${facts.length - 1})` : ''}`, 'info', 3000);
  }
  return clean;
}

// While streaming, hide <remember> tags (complete or still arriving)
function hideMemoryTags(text) {
  return String(text || '').replace(REMEMBER_RE, '').replace(/<remember>[\s\S]*$/i, '').replace(/<rem[a-z]*$/i, '');
}

// ---------- Athlete ----------
async function athleteContext(dateStr, massOverride) {
  const mass = massOverride !== undefined ? massOverride : await getAthleteWeightForDate(dateStr);
  return {
    today: formatFullDateWithDay(formatLocalDate(new Date())) + ` ${new Date().toTimeString().slice(0, 5)}`,
    goal: await getActiveTrainingGoalForDate(dateStr || formatLocalDate(new Date())),
    weightSummary: await getWeightPromptSummary(),
    mass: mass ? `${mass} kg` : 'not logged',
    height: ATHLETE.height ? `${ATHLETE.height} cm` : 'not logged'
  };
}

function bioLine(ctx) {
  return `Athlete: ${ATHLETE.name} | Height ${ctx.height} | Mass ${ctx.mass} | Bike: ${ATHLETE.bike} | Max HR ${PHYSIO.max_hr} | Resting HR ${PHYSIO.resting_hr} | HR zones (all sports): ${zoneFrameworkText()}`;
}

// One weeklyTotals() entry, per sport: "3 rides 95 km, 1 run 8 km"
function weekSportsText(wk) {
  return Object.entries(wk.sports || {}).map(([s, e]) => `${e.count} ${(e.count > 1 ? SPORTS[s].plural : SPORTS[s].label).toLowerCase()} ${s === 'swim' ? `${Math.round(e.dist * 1000)} m` : `${fmtNum(e.dist, 0)} km`}`).join(', ') || `${wk.count} sessions`;
}

// Totals per sport, e.g. for the season header
function sportTotalsText(rides) {
  const a = aggregateRides(rides);
  return Object.entries(a.bySport).map(([s, e]) => `${e.count} ${SPORTS[s].plural.toLowerCase()} (${s === 'swim' ? `${Math.round(e.dist * 1000)} m` : `${fmtNum(e.dist, 0)} km`}, ${formatHours(e.sec)}, ${Math.round(e.trimp)} TRIMP)`).join('; ') || 'none';
}

async function ctxAthlete(dateStr, all, opts = {}) {
  const ctx = await athleteContext(dateStr);
  const lines = [`ATHLETE: ${bioLine(ctx)}`, `Weight log: ${ctx.weightSummary}`];
  const ftp = currentFtp(all);
  if (ftp) lines.push(`FTP: ${ftp.w} W (${ftp.source === 'set' ? 'set by athlete' : 'auto from best measured 20 min'})`);
  lines.push(`Active training phase on ${dateStr || 'today'}: "${ctx.goal}"`);
  if (opts.phaseHistory) {
    const h = await getTrainingGoalHistory();
    if (h.length > 1) lines.push(`Phase history: ${h.map(e => `${e.effective_date} "${e.goal}"`).join(' → ')}`);
  }
  return lines.join('\n');
}

// ---------- Load ----------
function loadAt(series, dateKey) {
  if (!series) return null;
  let i = series.dates.indexOf(dateKey);
  if (i < 0) {
    if (dateKey < series.dates[0]) return null;
    i = series.dates.length - 1;
  }
  const wk = Math.max(0, i - 7);
  const ctl = series.ctl[i], atl = series.atl[i];
  return { ctl, atl, tsb: series.tsb[i], ramp: round(ctl - series.ctl[wk], 1), acwr: ctl > 0 ? round(atl / ctl, 2) : null };
}

function loadLine(l, label) {
  if (!l) return `${label}: no heart-rate load data yet.`;
  return `${label}: Fitness ${l.ctl} | Fatigue ${l.atl} | Form ${signed(l.tsb, 1)} (${formStatus(l.tsb).label}) | 7-day fitness ramp ${signed(l.ramp, 1)} | ACWR ${l.acwr ?? '--'}`;
}

function loadTrendText(series, weeks) {
  if (!series) return '';
  const out = [];
  for (let k = weeks - 1; k >= 0; k--) {
    const i = series.dates.length - 1 - k * 7;
    if (i < 0) continue;
    out.push(`${series.dates[i]}: CTL ${series.ctl[i]}, ATL ${series.atl[i]}, TSB ${series.tsb[i]}`);
  }
  return out.length ? `LOAD TREND (weekly snapshots):\n${out.join('\n')}` : '';
}

async function loadContextText() {
  const all = await db.workouts.orderBy('date').toArray();
  return loadLine(loadAt(computeLoadSeries(all), formatLocalDate(new Date())), 'Training load today');
}

// ---------- Plan & targets ----------
function sessionText(s) {
  if (!s) return 'nothing planned';
  return s.type === 'rest' ? 'Rest' : `${s.sport && SPORTS[s.sport] ? `${SPORTS[s.sport].label.toUpperCase()}: ` : ''}${s.title} (${s.type}, ${s.duration_min} min${s.zone ? `, ${s.zone}` : ''})${s.details ? ` — ${s.details}` : ''}`;
}

async function ctxPlanWeek(offsetWeeks, label) {
  const pc = await planContext();
  const today = formatLocalDate(new Date());
  const rows = weekDates(offsetWeeks).map(d => {
    const s = sessionFor(pc, d);
    const status = !s || s.type === 'rest' ? '' : d < today ? (sessionDone(pc, d) ? ' [done]' : ' [missed]') : d === today ? (sessionDone(pc, d) ? ' [done today]' : ' [today]') : '';
    const src = s && s.changed ? ` {changed by ${s.source}}` : '';
    return `${d} ${parseSafeDate(d).toLocaleDateString('en-US', { weekday: 'short' })}: ${sessionText(s)}${status}${src}`;
  });
  return `${label}:\n${rows.join('\n')}`;
}

async function ctxTemplate() {
  const t = await getPlanTemplate();
  if (!t.days.some(Boolean)) return "ATHLETE'S WEEKLY TEMPLATE: not entered yet.";
  return `ATHLETE'S OWN WEEKLY TEMPLATE (repeats every week unless changed for a date):\n${WEEKDAYS.map((d, i) => `${d}: ${sessionText(t.days[i])}`).join('\n')}`;
}

async function ctxTargets(all, weekOffset = 0) {
  const ws = addDays(startOfWeek(new Date()), weekOffset * 7);
  const t = await getWeeklyGoals(formatLocalDate(ws));
  const week = ridesBetween(all, ws, addDays(ws, 7));
  const cur = aggregateRides(week);
  const rideKm = (cur.bySport.ride || { dist: 0 }).dist;
  const tgt = [t.km ? `${t.km} km riding` : '', t.hours ? `${t.hours} h (all sports)` : '', t.rides ? `${t.rides} sessions` : ''].filter(Boolean).join(', ') || 'none set';
  const def = await getWeeklyGoals();
  return `WEEKLY TARGETS (week of ${formatLocalDate(ws)}): ${tgt}${t.note ? ` — "${t.note}"` : ''}${t.scope === 'week' ? ' (override for this week)' : ''}. Default targets: ${[def.km ? `${def.km} km` : '', def.hours ? `${def.hours} h` : '', def.rides ? `${def.rides} sessions` : ''].filter(Boolean).join(', ') || 'none'}.
Progress so far that week: ${cur.count} sessions (${sportTotalsText(week)}), ${fmtNum(rideKm, 1)} km ridden, ${formatHours(cur.sec)}, ${Math.round(cur.asc)} m climbing, ${Math.round(cur.trimp)} TRIMP.`;
}

async function ctxAdherence(days) {
  const a = await planAdherence(days);
  if (!a.length) return `PLAN ADHERENCE (last ${days} days): no planned sessions.`;
  const done = a.filter(x => x.done).length;
  return `PLAN ADHERENCE (last ${days} days): ${done}/${a.length} planned sessions done. Missed: ${a.filter(x => !x.done).map(x => `${x.date} ${x.title}`).join(', ') || 'none'}.`;
}

// ---------- Rides ----------
const FLAGGED = 'flagged';
const codeOf = w => (w.exercise_code ? w.exercise_code.split(' - ')[0] : `R${w.ride_number}`);

function rideLedgerLine(w, mass, note, verdict) {
  if (isExcluded(w)) return `• ${codeOf(w)} [${String(w.date).slice(0, 10)}]: excluded by the athlete (not a real session) — ignore`;
  const sp = sportOf(w);
  const massTag = mass ? `${mass}kg | ` : '';
  const pm = w.device_watts ? ' | power meter' : '';
  const load = hasVal(mv(w, 'trimp')) ? ` | TRIMP ${Math.round(w.trimp)}` : '';
  const feel = w.rpe || w.feel ? ` | ${w.rpe ? `RPE ${w.rpe}/10` : ''}${w.rpe && w.feel ? ', ' : ''}${w.feel ? `felt ${w.feel}` : ''}` : '';
  const notes = [w.note, note].filter(Boolean).join(' / ');
  const noteStr = notes ? ` | athlete: "${String(notes).replace(/\s+/g, ' ').slice(0, 160)}"` : '';
  const pmTxt = w.power_source === 'meter' && w.np_w && !isFlagged(w, 'power') ? ` | NP ${w.np_w}W` : '';
  const flags = flagNotes(w);
  const sw = swimOf(w);
  const dist = hasVal(mv(w, 'distance_km')) ? `${distText(w)}, ${sp === 'swim' && swimPace100(w) ? `${fmtPace(swimPace100(w))}/100m` : speedText(w)}${sw && sw.swolf ? `, SWOLF ${sw.swolf}` : ''}${w.avg_cadence ? `, ${w.avg_cadence} spm` : ''}` : sp === 'other' ? `${w.name || 'gym'}${w.reps ? `, ${w.reps} reps` : ''}` : `distance/speed ${FLAGGED}`;
  const asc = sp === 'swim' ? '' : hasVal(mv(w, 'elevation_gain_m')) ? `, ${Math.round(num(w.elevation_gain_m))}m` : `, climbing ${FLAGGED}`;
  const hr = hasVal(mv(w, 'avg_hr')) ? `${w.avg_hr || '--'}bpm` : `HR ${FLAGGED}`;
  const extra = sp === 'ride' ? ` | ${isFlagged(w, 'elevation') ? 'VAM n/a' : vamText(w)} | ${driftText(w)}` : '';
  const when = `${parseSafeDate(w.date).toLocaleDateString('en-GB', { weekday: 'short' })} ${String(w.date).slice(0, 16)}`;
  const intent = getCleanIntentLabel(w).replace('No intent specified', 'no intent').replace(/ \((Aerobic Base|Recovery|Tempo|Threshold|VO2max)\)/, '');
  return `• ${codeOf(w)} [${when} | ${massTag}${intent} | ${rideDuration(w)}${pm}${pmTxt}${load}${feel}${extra} | ${zonesCompact(mv(w, 'zone_seconds'))}${flags.length ? ` | ${flags.join('; ')}` : ''}]: ${dist}, ${hr}${asc}${noteStr}${verdict ? ` | coach: "${verdict}"` : ''}`;
}

function monthSummaryLines(rides) {
  const byMonth = new Map();
  for (const w of rides) {
    const k = String(w.date).slice(0, 7);
    (byMonth.get(k) || byMonth.set(k, []).get(k)).push(w);
  }
  return [...byMonth.entries()].map(([m, rs]) => {
    const a = aggregateRides(rs);
    const z = sumZones(rs);
    const r = rs.filter(w => sportOf(w) === 'ride');
    const ra = aggregateRides(r);
    return `• ${m}: ${sportTotalsText(rs)}; total ${formatHours(a.sec)}, ${Math.round(a.asc)} m climbing${ra.speed ? `, ride avg ${fmtNum(ra.speed, 1)} km/h` : ''}, HR ${a.hr ? Math.round(a.hr) : '--'}, zones ${PHYSIO.zones.map((zz, i) => `${zz.key}:${Math.round(z[i] / 60)}m`).join(' ')}`;
  });
}

// Detailed lines for the newest N rides, monthly summaries for older ones
// Whole history in three resolutions, so nothing is silently dropped:
//   every workout of the last 6 weeks (at least `detailed`) → one line each, with the
//   athlete's note and the coach's verdict from that session's thread;
//   the 10 weeks before → one line per week; anything older → one line per month.
// Body mass is printed only when it changes, which keeps lines short.
async function ctxLedger(rides, detailed, title, opts = {}) {
  const weights = await getWeightHistory();
  const cut = formatLocalDate(addDays(new Date(), -42));
  let nDetail = Math.max(detailed, rides.filter(w => String(w.date) >= cut).length);
  nDetail = Math.min(nDetail, detailed + 15);
  const recent = rides.slice(-nDetail);
  const older = rides.slice(0, Math.max(0, rides.length - nDetail));
  const weekCut = older.length && opts.weekly !== false ? formatLocalDate(addDays(parseSafeDate(String(recent[0] ? recent[0].date : cut).slice(0, 10)), -70)) : '';
  const byWeek = weekCut ? older.filter(w => String(w.date) >= weekCut) : [];
  const byMonth = weekCut ? older.filter(w => String(w.date) < weekCut) : older;
  const lines = [];
  let lastMass = null;
  for (const w of recent) {
    const n = await firstAthleteNote(w.strava_id);
    const mass = await getAthleteWeightForDate(w.date, weights);
    const showMass = mass && (!lastMass || Math.abs(mass - lastMass) >= 1);
    if (mass) lastMass = mass;
    lines.push(rideLedgerLine(w, showMass ? mass : null, n && n.message, await coachVerdict(w.strava_id)));
  }
  let out = `${title} (${rides.length} workouts: ${recent.length} listed one by one${byWeek.length ? `, ${byWeek.length} as weekly totals` : ''}${byMonth.length ? `, ${byMonth.length} as monthly totals` : ''}):`;
  if (byMonth.length) out += `\nBY MONTH:\n${monthSummaryLines(byMonth).join('\n')}`;
  if (byWeek.length) out += `\nBY WEEK:\n${weeklyTotals(byWeek).map(e => `• wk ${e.week}: ${weekSportsText(e)}, ${formatHours(e.sec)}, ${Math.round(e.asc)} m, TRIMP ${Math.round(e.trimp)}`).join('\n')}`;
  out += `\nSESSIONS (format: code [date | intent | time | load | rating | climbing | drift | zone minutes Z1/Z2/Z3/Z4/Z5 | flags]: distance, speed or pace, HR, ascent | athlete note | coach verdict):\n${lines.join('\n') || 'none'}`;
  return out;
}

// Tells the coach what is missing so it doesn't mistake gaps for facts
async function dataCompletenessText(all) {
  const recent = all.filter(w => String(w.date) >= formatLocalDate(addDays(new Date(), -42)));
  const noHr = recent.filter(w => !(w.avg_hr > 0)).length;
  const flagged = all.filter(w => flagNotes(w).length).length;
  const wl = await getWellness();
  const k14 = Object.keys(wl.days).filter(k => k >= formatLocalDate(addDays(new Date(), -14)));
  const sleepN = k14.filter(k => wl.days[k].sleep_min > 0).length, rhrN = k14.filter(k => wl.days[k].rhr > 0).length;
  return `DATA COMPLETENESS: last 6 weeks ${recent.length} sessions, ${noHr} without heart rate; ${flagged} sessions have values marked as errors; watch data last 14 days: sleep on ${sleepN} nights, resting HR on ${rhrN} days, HRV not shared.`;
}

// First sentence of the latest coach message in a session's thread (continuity across chats)
async function coachVerdict(stravaId) {
  const t = (await rideThreads(stravaId).toArray()).filter(x => x.role === 'coach').pop();
  if (!t || !t.message) return '';
  const plain = String(t.message).replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim();
  const m = plain.match(/^(.{20,170}?[.!?])(\s|$)/);
  return (m ? m[1] : plain.slice(0, 150)).trim();
}

const zonesCompact = z => (Array.isArray(z) && z.some(v => v > 0) ? `Z ${z.map(v => Math.round(num(v) / 60)).join('/')}m` : 'no HR zones');

function driftPromptText(w) {
  if (!hasVal(w.cardiac_drift_bpm)) return 'n/a (intervals/play or <30 min moving — do not diagnose aerobic drift)';
  const basis = w.decoupling_basis === 'power' ? 'Power:HR' : 'Speed:HR';
  const pct = hasVal(w.cardiac_decoupling_pct) ? `, decoupling (${basis}) ${signed(w.cardiac_decoupling_pct, 1)}%` : '';
  return `${signed(w.cardiac_drift_bpm, 0)} bpm HR drift${pct} (moving time, first 12 min skipped)`;
}

// Sport-specific lines for the session block (swim lengths, run cadence, gym reps)
function sportDetailLines(w) {
  const sp = sportOf(w);
  const sw = swimOf(w);
  if (sp === 'swim' && sw) {
    const k = Math.max(1, Math.round(100 / sw.pool_m));
    const splits = [];
    for (let i = 0; i + k <= sw.laps.length; i += k) splits.push(fmtPace(sumBy(sw.laps.slice(i, i + k), l => l.sec)));
    const mix = Object.entries(sw.mix).map(([s, n]) => `${STROKES[s]} ${n}`).join(', ');
    return `- Swim: ${sw.pool_m} m pool, ${sw.lengths} lengths (${sw.distance_m} m) | swim time ${formatDuration(sw.active_sec)}${sw.rest_sec ? `, rest ${formatDuration(sw.rest_sec)}` : ''} | pace ${fmtPace(swimPace100(w))}/100m
- Technique: SWOLF avg ${sw.swolf || '--'} (best ${sw.swolf_best || '--'}) | ${sw.spl || '--'} strokes/length | stroke rate ${sw.stroke_rate || '--'}/min | ${sw.strokes} strokes | stroke mix: ${mix}
- Best: ${[50, 100, 200, 400].filter(m => sw.best[m]).map(m => `${m} m ${fmtPace(sw.best[m])}`).join(', ') || 'n/a'} | fastest length ${sw.best_len} s
- 100 m splits: ${splits.join(', ') || 'n/a'}
`;
  }
  if (sp === 'swim') return `- Swim: no per-length data (pace ${fmtSec(swimPace100(w))}/100m from totals)\n`;
  if (onFoot(sp)) return `${w.avg_cadence ? `- Cadence ${w.avg_cadence} spm${w.max_cadence ? ` (max ${w.max_cadence})` : ''}${w.steps ? ` | ${w.steps} steps` : ''}` : '- Cadence: not recorded'}${w.vo2max_watch ? ` | watch VO2max ${w.vo2max_watch}` : ''}${isIndoor(w) ? ' | treadmill (no GPS climbing)' : ''}\n`;
  if (sp === 'other') return `- Gym session: ${w.name || 'workout'}${w.reps ? ` | ${w.reps} reps` : ''}${w.calories ? ` | ${w.calories} kcal` : ''}${w.hr_min ? ` | HR min ${w.hr_min}` : ''}\n`;
  return '';
}
// Exact splits for the AI: every swim length; per-km (runs) or per-5-km (rides) splits from the streams
const STROKE_CODE = { FREESTYLE: 'fr', BREASTSTROKE: 'br', BACKSTROKE: 'bk', BUTTERFLY: 'fly', KICK_BOARD: 'kick', MIXED: 'mix', UNDEFINED: '?' };
async function splitLines(w) {
  const sp = sportOf(w);
  const sw = swimOf(w);
  if (sp === 'swim' && sw) return `- Every length (s/strokes/stroke): ${sw.laps.map((l, i) => `${i + 1}) ${l.sec}/${l.strokes || 0}${STROKE_CODE[l.style]}`).join(' ')}\n`;
  if ((!onFoot(sp) && sp !== 'ride') || isFlagged(w, 'distance')) return '';
  const row = await db.streams.get(Number(w.strava_id));
  const s = row && row.stream_data;
  if (!s || !s.time) return '';
  const T = s.time.data, D = s.distance ? s.distance.data : null, V = s.velocity_smooth ? s.velocity_smooth.data : null;
  const HR = s.heartrate ? s.heartrate.data : [], ALT = s.altitude ? s.altitude.data : [];
  if (!D && !V) return '';
  const step = onFoot(sp) ? 1000 : 5000;
  const out = [];
  let dist = 0, segStart = 0, hrSum = 0, hrN = 0, nextMark = step, altStart = num(ALT[0]);
  for (let i = 1; i < T.length; i++) {
    dist = D ? num(D[i]) : dist + num(V[i]) * Math.min(10, Math.max(0, T[i] - T[i - 1]));
    if (HR[i] > 0) { hrSum += HR[i]; hrN++; }
    if (dist >= nextMark) {
      const sec = T[i] - T[segStart];
      const climb = ALT.length && !isIndoor(w) ? Math.round(num(ALT[i]) - altStart) : null;
      out.push(`${nextMark / 1000}km ${onFoot(sp) ? fmtPace(sec / (step / 1000)) : `${fmtNum((step / 1000) / (sec / 3600), 1)}km/h`}${hrN ? ` HR${Math.round(hrSum / hrN)}` : ''}${climb !== null ? ` ${climb >= 0 ? '+' : ''}${climb}m` : ''}`);
      segStart = i; hrSum = 0; hrN = 0; altStart = num(ALT[i]); nextMark += step;
      if (out.length >= 60) break;
    }
  }
  return out.length ? `- ${onFoot(sp) ? 'Km' : '5-km'} splits (${onFoot(sp) ? 'pace' : 'speed'}, avg HR, climb): ${out.join(' | ')}\n` : '';
}
async function rideBlock(w, all) {
  const sp = sportOf(w);
  let pm = `${w.avg_power_w || '--'} W (Strava estimate)`;
  if (w.device_watts) {
    const ftp = currentFtp(all);
    const st = rideStress(w, ftp);
    pm = `${w.avg_power_w} W avg / ${w.np_w || w.norm_power_w || '--'} W NP (power meter)${st ? `, IF ${st.IF.toFixed(2)}, TSS ${st.TSS} (FTP ${ftp.w} W)` : ''}`;
  }
  if (isFlagged(w, 'power')) pm = FLAGGED;
  const best = [];
  const bs = mv(w, 'best_spd'), bh = mv(w, 'best_hr');
  if (bs) best.push(`${speedName(w).toLowerCase()} ${Object.entries(bs).map(([d, v]) => `${BEST_LABELS[d]} ${speedText(w, v)}`).join(', ')}`);
  if (bh) best.push(`HR ${Object.entries(bh).map(([d, v]) => `${BEST_LABELS[d]} ${Math.round(v)}bpm`).join(', ')}`);
  if (w.power_source === 'meter' && w.mmp && !isFlagged(w, 'power')) best.push(`power ${[5, 60, 300, 1200].filter(d => w.mmp[d]).map(d => `${BEST_LABELS[d]} ${Math.round(w.mmp[d])}W`).join(', ')}`);
  const flags = flagNotes(w).filter(n => sp === 'ride' || !n.startsWith('indoor'));
  const distLine = hasVal(mv(w, 'distance_km'))
    ? `- Distance ${distText(w)} | ${speedName(w)} avg ${speedText(w)}${sp === 'ride' ? ` / max ${fmtNum(w.max_speed_kmh, 1)} km/h` : ''}`
    : `- Distance/speed: ${FLAGGED} (not real — ignore)`;
  const hrLine = hasVal(mv(w, 'avg_hr')) ? `HR avg ${w.avg_hr || '--'} / max ${w.max_hr || '--'} bpm` : `HR ${FLAGGED}`;
  return `- Session: ${sp.toUpperCase()} ${w.exercise_code}${w.name ? ` "${w.name}"` : ''} — ${formatFullDateWithDay(w.date)}${w.source === 'health' ? ' (recorded by Galaxy Watch, via Samsung Health)' : ''}
${flags.length ? `- DATA QUALITY: ${flags.join('; ')}\n` : ''}${distLine} | Moving ${rideDuration(w)} | Elapsed ${w.elapsed_sec ? formatDuration(w.elapsed_sec) : 'n/a'}
- ${hrLine}${w.avg_cadence ? ` | Cadence ${w.avg_cadence} ${onFoot(sp) ? 'spm' : 'rpm'}` : ''}${w.calories ? ` | ${w.calories} kcal` : ''}
${sportDetailLines(w)}${await splitLines(w)}${sp === 'ride' ? `- Power: ${pm} | Work ${isFlagged(w, 'power') ? FLAGGED : `${w.kilojoules || '--'} kJ`}\n` : ''}${sp === 'ride' || (onFoot(sp) && !isIndoor(w)) ? `- Ascent ${isFlagged(w, 'elevation') ? FLAGGED : `${Math.round(num(w.elevation_gain_m))} m | VAM ${vamText(w, true)}`}\n` : ''}- Load ${hasVal(mv(w, 'trimp')) ? `${Math.round(w.trimp)} TRIMP${w.trimp_source === 'avg' ? ' (from average HR)' : ''}` : 'n/a'}${w.rpe ? ` | Session-RPE load ${Math.round(w.rpe * num(w.moving_sec) / 60)}` : ''}
- Intent set by athlete: ${getCleanIntentLabel(w)}
- Zone minutes (moving): ${formatFullZoneSummary(w.zone_seconds)}
${sp === 'ride' || onFoot(sp) ? `- Halves: ${w.halves_profile || 'n/a'} | Drift: ${driftPromptText(w)}` : '- Drift: not applicable to this sport'}
- Best efforts: ${best.join(' | ') || 'n/a'}
- Athlete rating: ${w.rpe ? `RPE ${w.rpe}/10` : 'no RPE'}${w.feel ? `, felt ${w.feel}` : ''}${w.note ? `, note: "${String(w.note).slice(0, 300)}"` : ''}`;
}

async function plannedForRide(w) {
  const pc = await planContext();
  const d = String(w.date).slice(0, 10);
  const s = sessionFor(pc, d);
  return `PLANNED FOR ${d}: ${sessionText(s)}${s && s.changed ? ` (changed by ${s.source})` : s ? ' (from weekly template)' : ''}`;
}

async function buildCompactPriorContinuum(target, limit) {
  const prior = await db.workouts.where('date').below(target.date).sortBy('date');
  const weights = await getWeightHistory();
  const recent = prior.slice(-limit);
  const lines = [];
  for (let i = 0; i < recent.length; i++) {
    const p = recent[i];
    const prev = i > 0 ? recent[i - 1] : prior[prior.length - recent.length - 1];
    const note = await firstAthleteNote(p.strava_id);
    const gap = prev ? ` (+${formatRecoveryGap(recoveryGapMs(prev, p))})` : '';
    lines.push(rideLedgerLine(p, await getAthleteWeightForDate(p.date, weights), note && note.message).replace(']: ', `${gap}]: `));
  }
  let gapText = 'First ride in the series.';
  if (prior.length) {
    const last = prior[prior.length - 1];
    gapText = `${formatRecoveryGap(recoveryGapMs(last, target))} since the end of the previous workout (${codeOf(last)}, ${formatFullDateWithDay(last.date)}).`;
  }
  const older = prior.length - recent.length;
  return { continuumText: (older > 0 ? `(${older} older rides not listed)\n` : '') + lines.join('\n'), targetRecoveryGapText: gapText };
}

async function header(agent, roleLine, ctx) {
  const mem = await coachMemoryText();
  return `CURRENT DATE/TIME: ${ctx.today}
ROLE: ${roleLine}
${skillsFor(agent)}${mem ? `\n${mem}` : ''}`;
}

// --------------------------------------------------------
// RIDE COACH (debrief + chat about one ride)
// --------------------------------------------------------
async function rideCoachContext(w) {
  const all = await db.workouts.orderBy('date').toArray();
  const B = contextBudget('ride');
  const day = String(w.date).slice(0, 10);
  const series = computeLoadSeries(all);
  const cont = await buildCompactPriorContinuum(w, B.priorRides);
  // Swims and gym: heart rate is the only stream, so a coarser timeline is enough (lengths/splits carry the detail)
  const step = sportOf(w) === 'swim' || sportOf(w) === 'other' ? Math.max(3, B.timelineStep) : B.timelineStep;
  const timeline = await build1MinuteTelemetryTimeline(w.strava_id, step);
  const ws = startOfWeek(parseSafeDate(day));
  const weekRides = ridesBetween(all, ws, addDays(ws, 7));
  const t = await getWeeklyGoals(formatLocalDate(ws));
  return { all, series, cont, timeline, day, step, text: `${await ctxAthlete(day, all)}
${await plannedForRide(w)}
${loadLine(loadAt(series, formatLocalDate(addDays(parseSafeDate(day), -1))), `Load going into this session (${day})`)}
${await wellnessContextText(day)}
That week: ${sportTotalsText(weekRides)}; targets ${[t.km ? `${t.km} km riding` : '', t.hours ? `${t.hours} h` : '', t.rides ? `${t.rides} sessions` : ''].filter(Boolean).join(', ') || 'none'}.
Recovery: ${cont.targetRecoveryGapText}
${dataNotes()}

THIS SESSION:
${await rideBlock(w, all)}

TIMELINE (moving time; each line = ${step} min; avg and peak values):
${timeline}

PREVIOUS WORKOUTS (all sports, with recovery gaps):
${cont.continuumText || 'none'}` };
}

const coachRole = w => ({ ride: 'cycling', run: 'running', walk: 'walking', swim: 'swimming', other: 'strength & conditioning' })[sportOf(w)];

async function buildRideDebriefPrompt(w) {
  const c = await rideCoachContext(w);
  const ctx = await athleteContext(c.day);
  const notes = (await rideThreads(w.strava_id).toArray()).filter(t => t.role === 'athlete').map(t => t.message).join(' | ');
  return `${await header('ride', `You are ${ATHLETE.name}'s ${coachRole(w)} coach (the athlete rides, runs, swims and does gym work), debriefing one session.`, ctx)}

${c.text}

ATHLETE MESSAGES ABOUT THIS SESSION: ${notes || 'none'}

TASK: Debrief this session. Lead with a one-line verdict. Then: execution vs plan and intent (use timeline peaks for specifics), physiological response (judge drift only if valid), recovery/load/wellness context, and 2–3 concrete actions for the next sessions.
${formattingRules('debrief')}`;
}

// excludeId: the athlete's message being answered (already saved, so not repeated in the history)
async function buildRideChatPrompt(w, athleteMessage, hasImage, excludeId) {
  const c = await rideCoachContext(w);
  const ctx = await athleteContext(c.day);
  const past = (await rideThreads(w.strava_id).toArray()).filter(t => t.id !== excludeId && !t.pending);
  const turns = past.slice(-10).map(t => `${t.role === 'coach' ? 'COACH' : 'ATHLETE'}: ${t.message}`);
  return `${await header('ride', `You are ${ATHLETE.name}'s ${coachRole(w)} coach (the athlete rides, runs, swims and does gym work), discussing one session.`, ctx)}

${c.text}

CONVERSATION SO FAR:
${turns.join('\n') || 'none'}

ATHLETE: ${athleteMessage || '(no text)'}${hasImage ? '\n(The athlete attached a screenshot — read it directly.)' : ''}

Answer the athlete directly, using the data above. If the athlete corrects a fact (e.g. the session type or equipment), accept it, use it from now on and save it with <remember>. ${formattingRules()}`;
}

// --------------------------------------------------------
// COMPARE
// --------------------------------------------------------
async function buildComparePrompt(sessions) {
  const all = await db.workouts.orderBy('date').toArray();
  const series = computeLoadSeries(all);
  const ctx = await athleteContext(formatLocalDate(new Date()));
  const blocks = [];
  for (const s of sessions) {
    const day = String(s.date).slice(0, 10);
    const notes = (await rideThreads(s.strava_id).toArray()).filter(t => t.role === 'athlete').map(t => t.message).join(' | ');
    blocks.push(`=== ${s.exercise_code} ===
${await plannedForRide(s)}
${loadLine(loadAt(series, formatLocalDate(addDays(parseSafeDate(day), -1))), 'Load going in')}
${await wellnessContextText(day)}
Mass that day: ${(await getAthleteWeightForDate(s.date)) || 'n/a'} kg
${await rideBlock(s, all)}
Athlete messages: ${notes || 'none'}`);
  }
  return `${await header('compare', `You are ${ATHLETE.name}'s endurance physiologist comparing sessions of the same sport.`, ctx)}

${await ctxAthlete(formatLocalDate(new Date()), all)}
${dataNotes()}

${blocks.join('\n\n')}

TASK: Start with a one-line verdict (which session shows better fitness and why). Then compare like-for-like: pace/speed at what heart rate (efficiency), zones, drift, climbing, load and the athlete's own ratings, accounting for terrain, recovery and wellness on each date. Ignore flagged values. End with what to do next.
${formattingRules('debrief')}`;
}

// --------------------------------------------------------
// TRENDS AUDIT
// --------------------------------------------------------
async function buildGraphPrompt(workouts, metrics) {
  const B = contextBudget('trends');
  const series = computeLoadSeries(workouts);
  const ctx = await athleteContext(formatLocalDate(new Date()), await getLatestWeight());
  const weeks = weeklyTotals(workouts).slice(-B.weeks).map(w => `${w.week}: ${weekSportsText(w)}, ${formatHours(w.sec)}, ${Math.round(w.asc)} m, TRIMP ${Math.round(w.trimp)}`);
  return `${await header('trends', `You are ${ATHLETE.name}'s sports scientist auditing season progression.`, ctx)}

${await ctxAthlete(formatLocalDate(new Date()), workouts, { phaseHistory: true })}
${loadLine(loadAt(series, formatLocalDate(new Date())), 'Load today')}
${loadTrendText(series, B.weeks)}
WEEKLY TOTALS:
${weeks.join('\n') || 'none'}
${bestEffortsText(workouts)}
${dataNotes()}

${await ctxLedger(workouts, B.detailedRides, 'SEASON')}

TASK: Analyse progression in ${metrics.join(', ')}. Separate fitness gains from mass, terrain and intensity-mix effects; comment on the load trend, intensity distribution and consistency; name the 2–3 most useful changes.
${formattingRules('long')}`;
}

async function buildGraphReplyPrompt(metrics, dialogue) {
  const mem = await coachMemoryText();
  return `CURRENT DATE: ${formatFullDateWithDay(formatLocalDate(new Date()))}
ROLE: ${ATHLETE.name}'s sports scientist discussing season progression (${metrics.join(', ')}).
${skillsFor('trends')}
${mem}

CONVERSATION:
${dialogue}

${formattingRules()}`;
}

// Best efforts per sport (flagged values never count)
function bestEffortsText(workouts) {
  const lines = [];
  for (const sp of sportsPresent(workouts)) {
    const pool = workouts.filter(w => sportOf(w) === sp);
    const probe = { sport: sp };
    const groups = [['best_hr', `${SPORTS[sp].label} HR`, v => `${Math.round(v)} bpm`]];
    if (sp !== 'other') groups.unshift(['best_spd', SPORTS[sp].label + (sp === 'ride' ? ' speed' : ' pace'), v => speedText(probe, v)]);
    if (sp === 'ride') groups.push(['mmp', 'Power (meter)', v => `${Math.round(v)} W`]);
    for (const [f, name, fmt] of groups) {
      const durs = f === 'mmp' ? [5, 60, 300, 1200, 3600] : [60, 300, 1200, 3600];
      const cells = durs.map(d => {
        let best = null;
        for (const w of pool) {
          if (f === 'mmp' && (w.power_source !== 'meter' || isFlagged(w, 'power'))) continue;
          const src = f === 'mmp' ? w.mmp : mv(w, f);
          const v = src && src[d];
          if (v && (!best || v > best.v)) best = { v, date: String(w.date).slice(0, 10) };
        }
        return best ? `${BEST_LABELS[d]} ${fmt(best.v)} (${best.date})` : null;
      }).filter(Boolean);
      if (cells.length) lines.push(`${name}: ${cells.join(', ')}`);
    }
  }
  return lines.length ? `ALL-TIME BEST EFFORTS:\n${lines.join('\n')}` : '';
}

// --------------------------------------------------------
// REPORTS
// --------------------------------------------------------
async function buildReportPrompt(current, prior, startDate, endDate, timeframe, scopeLabel = 'All activities') {
  const all = await db.workouts.orderBy('date').toArray();
  const B = contextBudget('report');
  const series = computeLoadSeries(all);
  const ctx = await athleteContext(formatLocalDate(new Date()), await getLatestWeight());
  const cur = aggregateRides(current);
  let pop = 'PREVIOUS PERIOD: no workouts in the preceding window of equal length.';
  if (prior.length) {
    const pri = aggregateRides(prior);
    const perSport = sportsPresent(current.concat(prior)).map(sp => {
      const a = aggregateRides(current.filter(w => sportOf(w) === sp)), b = aggregateRides(prior.filter(w => sportOf(w) === sp));
      const probe = { sport: sp };
      return `- ${SPORTS[sp].plural}: ${a.count} vs ${b.count} | ${sp === 'swim' ? `${Math.round(a.dist * 1000)} vs ${Math.round(b.dist * 1000)} m` : `${fmtNum(a.dist, 1)} vs ${fmtNum(b.dist, 1)} km`} | ${formatHours(a.sec)} vs ${formatHours(b.sec)} | ${speedName(probe).toLowerCase()} ${a.speed ? speedText(probe, a.speed) : '--'} vs ${b.speed ? speedText(probe, b.speed) : '--'} | HR ${a.hr ? Math.round(a.hr) : '--'} vs ${b.hr ? Math.round(b.hr) : '--'} bpm`;
    });
    pop = `PERIOD vs PREVIOUS PERIOD (duration-weighted):
- All sports: ${cur.count} vs ${pri.count} sessions | Time ${formatHours(cur.sec)} vs ${formatHours(pri.sec)} | TRIMP ${Math.round(cur.trimp)} vs ${Math.round(pri.trimp)} | Climbing ${Math.round(cur.asc)} vs ${Math.round(pri.asc)} m
${perSport.join('\n')}`;
  }
  const z = sumZones(current);
  const zt = z.reduce((a, b) => a + b, 0) || 1;
  const low = (z[0] + z[1]) / zt, mid = z[2] / zt, high = (z[3] + z[4]) / zt;
  const days = Math.max(1, Math.round((parseSafeDate(endDate) - parseSafeDate(startDate)) / 86400000) + 1);
  return `${await header('report', `You are ${ATHLETE.name}'s sports scientist writing a period review.`, ctx)}

${await ctxAthlete(endDate, all, { phaseHistory: true })}
PERIOD: ${formatFullDateWithDay(startDate)} to ${formatFullDateWithDay(endDate)} (${timeframe.toUpperCase()}) · SCOPE: ${scopeLabel}${scopeLabel === 'All activities' ? '' : ' only (load figures still include every sport)'}
${loadLine(loadAt(series, endDate), 'Load at period end')}
${loadTrendText(series, Math.min(B.weeks, Math.ceil(days / 7) + 1))}
${await ctxTargets(all)}
${await ctxAdherence(Math.min(days, 60))}
INTENSITY DISTRIBUTION: low (Z1-2) ${Math.round(low * 100)}% | middle (Z3) ${Math.round(mid * 100)}% | high (Z4-5) ${Math.round(high * 100)}% | polarization index ${mid > 0 ? round((low + high) / mid, 2) : 'n/a'}
${pop}
${await wellnessContextText(endDate, 'long')}
${dataNotes()}

${await ctxLedger(current, B.detailedRides, 'WORKOUTS IN THIS PERIOD')}

TASK: Start with a 2-sentence summary. Then four numbered sections:
1. Aerobic base & intensity distribution (all sports together, then any sport-specific note)
2. Drift, decoupling and recovery (including wellness data if present)
3. ${current.some(w => sportOf(w) !== 'ride') ? 'Each sport on its own: rides (climbing & terrain), runs, swims — only the sports present' : 'Climbing & terrain'}
4. Progress vs previous period, plan adherence and the 3 next steps
${formattingRules('long')} Use plain ASCII characters.`;
}

// --------------------------------------------------------
// WEEK PLANNER
// --------------------------------------------------------
async function buildPlannerPrompt() {
  const all = await db.workouts.orderBy('date').toArray();
  const series = computeLoadSeries(all);
  const ctx = await athleteContext(formatLocalDate(new Date()), await getLatestWeight());
  const recent = all.filter(w => parseSafeDate(w.date) >= addDays(new Date(), -21));
  const days = Array.from({ length: 7 }, (_, i) => formatLocalDate(addDays(new Date(), i)));
  const pc = await planContext();
  return `${await header('planner', `You are ${ATHLETE.name}'s coach adapting the next 7 days of the athlete's own plan.`, ctx)}

${await ctxAthlete(formatLocalDate(new Date()), all)}
${loadLine(loadAt(series, formatLocalDate(new Date())), 'Load today')}
${await wellnessContextText(formatLocalDate(new Date()), 'long')}
${await ctxTemplate()}
CURRENTLY PLANNED FOR THE NEXT 7 DAYS:
${days.map(d => `${d}: ${sessionText(sessionFor(pc, d))}`).join('\n')}
${await ctxTargets(all)}
${await ctxAdherence(14)}

${await ctxLedger(recent, 21, 'LAST 21 DAYS')}

TASK: Return the next 7 days (${days.join(', ')}), keeping the athlete's template wherever it still fits and changing only what form, wellness, missed sessions or targets require.
Return ONLY JSON:
{"summary":"one or two sentences on what you kept and what you changed","days":[{"date":"YYYY-MM-DD","title":"short name","type":"rest|recovery|endurance|long|tempo|threshold|vo2|other","duration_min":60,"zone":"Z2","details":"one sentence"}]}`;
}

// --------------------------------------------------------
// AETHER — the season coach (fullest context; can change the plan and targets)
// --------------------------------------------------------
async function buildMasterPrompt(payloadText, hasImage, excludeId) {
  const all = await db.workouts.orderBy('date').toArray();
  const B = contextBudget('aether');
  const series = computeLoadSeries(all);
  const today = formatLocalDate(new Date());
  const ctx = await athleteContext(today, await getLatestWeight());
  const past = (await db.master_chat.toArray()).filter(m => m.id !== excludeId && !m.pending);
  let elapsed = 'First conversation.';
  let since = [];
  if (past.length) {
    const lastT = parseSafeDate(past[past.length - 1].created_at).getTime();
    const h = Math.round((Date.now() - lastT) / 3600000);
    elapsed = `${(h / 24).toFixed(1)} days (${h} h) since the last conversation.`;
    since = all.filter(w => parseSafeDate(w.date).getTime() > lastT);
  }
  const agg = aggregateRides(all);
  const z = sumZones(all);
  const weeks = weeklyTotals(all).slice(-B.weeks).map(w => `${w.week}: ${weekSportsText(w)}, ${formatHours(w.sec)}, ${Math.round(w.asc)} m, TRIMP ${Math.round(w.trimp)}`);
  const pending = past.filter(m => m.proposal && !m.proposal_status).length;

  return `${await header('aether', `You are Aether, ${ATHLETE.name}'s head coach and exercise physiologist for cycling, running and swimming. You remember the whole season, you manage the athlete's training plan and weekly targets, and you speak as Aether. Judge the sports together (total load, recovery, fatigue) and each on its own (sport-specific fitness).`, ctx)}

${await ctxAthlete(today, all, { phaseHistory: true })}
${loadLine(loadAt(series, today), 'Load today')}
${loadTrendText(series, B.weeks)}
${await wellnessContextText(today, 'long')}

${await ctxTemplate()}
${await ctxPlanWeek(0, 'THIS WEEK')}
${await ctxPlanWeek(1, 'NEXT WEEK')}
${await ctxTargets(all, 0)}
${await ctxAdherence(14)}
${pending ? `NOTE: ${pending} earlier plan change(s) you proposed are still waiting for the athlete to apply or dismiss.` : ''}

SEASON: ${sportTotalsText(all)}; total ${formatHours(agg.sec)}, ${Math.round(agg.asc)} m climbing, ${Math.round(agg.trimp)} TRIMP; zone minutes ${PHYSIO.zones.map((zz, i) => `${zz.key}:${Math.round(z[i] / 60)}`).join(' ')}
WEEKLY TOTALS:
${weeks.join('\n') || 'none'}
${bestEffortsText(all)}
${await dataCompletenessText(all)}
${elapsed} Workouts since then: ${since.length ? since.map(r => `${codeOf(r)} ${distText(r)} (${formatFullDateWithDay(r.date)})`).join(', ') : 'none'}.
${dataNotes()}

${await ctxLedger(all, B.detailedRides, 'SEASON LEDGER', { weekly: false })}

CONVERSATION SO FAR:
${past.slice(-12).map(t => `${t.role === 'coach' ? 'AETHER' : 'ATHLETE'}: ${t.message}`).join('\n') || 'none'}

ATHLETE: ${payloadText || '(no text)'}${hasImage ? '\n(The athlete attached a screenshot — read it directly.)' : ''}

Answer as Aether. If the athlete asks to change the plan or targets (or pastes their plan), follow the plan-actions skill and include the <plan-update> block. ${formattingRules(/plan|week|review|report|analy|explain|detail/i.test(payloadText || '') ? 'debrief' : 'chat')}`;
}

// --------------------------------------------------------
// AETHER PLAN PROPOSALS — extracted from replies, applied only on approval
// --------------------------------------------------------
const PLAN_UPDATE_RE = /<plan-update>\s*([\s\S]*?)\s*<\/plan-update>/i;

function extractPlanUpdate(text) {
  const m = String(text || '').match(PLAN_UPDATE_RE);
  if (!m) return { text, proposal: null };
  let proposal = null;
  try {
    const raw = m[1].replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    proposal = JSON.parse(raw);
    if (!proposal || (!proposal.days && !proposal.template && !proposal.targets)) proposal = null;
  } catch (e) {
    proposal = null;
  }
  return { text: String(text).replace(PLAN_UPDATE_RE, '').trim(), proposal };
}

// While streaming, hide the machine-readable block (even when only partly received)
function hidePlanUpdate(text) {
  const i = String(text).search(/<plan-up/i);
  return i >= 0 ? String(text).slice(0, i).trim() : text;
}
