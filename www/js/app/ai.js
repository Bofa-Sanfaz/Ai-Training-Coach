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

// Small-context providers get a compact version of the long sections
function contextBudget() {
  const p = typeof activeProvider === 'function' ? activeProvider() : null;
  const small = p && (p.preset === 'groq' || p.preset === 'custom' || /lite|mini|small|8b|7b/i.test(p.model || ''));
  return small ? { detailedRides: 15, priorRides: 6, weeks: 8, timelineStep: 2 } : { detailedRides: 40, priorRides: 12, weeks: 12, timelineStep: 1 };
}

function formattingRules() {
  return 'FORMAT: plain English with units; short headed sections and bullets are fine; no LaTeX, no dollar signs, no formula derivations, no pipe tables.';
}

function dataNotes() {
  return `DATA NOTES:
- Power/kJ are Strava estimates unless a ride is marked "power meter"; NP/IF/TSS appear only for power-meter rides.
- Decoupling is Speed:HR on moving time (Power:HR with a power meter); MTB terrain adds noise.
- Load = Banister TRIMP from heart rate; Fitness CTL 42-day, Fatigue ATL 7-day, Form TSB = yesterday's CTL - ATL; ACWR = ATL/CTL.`;
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
  return `Athlete: ${ATHLETE.name} | Height ${ctx.height} | Mass ${ctx.mass} | Bike: ${ATHLETE.bike} | Max HR ${PHYSIO.max_hr} | Resting HR ${PHYSIO.resting_hr} | Zones: ${zoneFrameworkText()}`;
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
  return s.type === 'rest' ? 'Rest' : `${s.title} (${s.type}, ${s.duration_min} min${s.zone ? `, ${s.zone}` : ''})${s.details ? ` — ${s.details}` : ''}`;
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
  const cur = aggregateRides(ridesBetween(all, ws, addDays(ws, 7)));
  const tgt = [t.km ? `${t.km} km` : '', t.hours ? `${t.hours} h` : '', t.rides ? `${t.rides} rides` : ''].filter(Boolean).join(', ') || 'none set';
  const def = await getWeeklyGoals();
  return `WEEKLY TARGETS (week of ${formatLocalDate(ws)}): ${tgt}${t.note ? ` — "${t.note}"` : ''}${t.scope === 'week' ? ' (override for this week)' : ''}. Default targets: ${[def.km ? `${def.km} km` : '', def.hours ? `${def.hours} h` : '', def.rides ? `${def.rides} rides` : ''].filter(Boolean).join(', ') || 'none'}.
Progress so far that week: ${cur.count} rides, ${fmtNum(cur.dist, 1)} km, ${formatHours(cur.sec)}, ${Math.round(cur.asc)} m climbing, ${Math.round(cur.trimp)} TRIMP.`;
}

async function ctxAdherence(days) {
  const a = await planAdherence(days);
  if (!a.length) return `PLAN ADHERENCE (last ${days} days): no planned sessions.`;
  const done = a.filter(x => x.done).length;
  return `PLAN ADHERENCE (last ${days} days): ${done}/${a.length} planned sessions done. Missed: ${a.filter(x => !x.done).map(x => `${x.date} ${x.title}`).join(', ') || 'none'}.`;
}

// ---------- Rides ----------
function rideLedgerLine(w, mass, note) {
  const massTag = mass ? `${mass}kg` : 'mass n/a';
  const pm = w.device_watts ? ' | power meter' : '';
  const load = hasVal(w.trimp) ? ` | TRIMP ${Math.round(w.trimp)}` : '';
  const feel = w.rpe || w.feel ? ` | ${w.rpe ? `RPE ${w.rpe}/10` : ''}${w.rpe && w.feel ? ', ' : ''}${w.feel ? `felt ${w.feel}` : ''}` : '';
  const notes = [w.note, note].filter(Boolean).join(' / ');
  const noteStr = notes ? ` | Note: "${String(notes).slice(0, 80)}"` : '';
  const pmTxt = w.power_source === 'meter' && w.np_w ? ` | NP ${w.np_w}W` : '';
  return `• R${w.ride_number} [${formatFullDateWithDay(w.date)} | ${massTag} | ${getCleanIntentLabel(w)} | ${rideDuration(w)}${pm}${pmTxt}${load}${feel} | ${vamText(w)} | ${driftText(w)} | ${formatFullZoneSummary(w.zone_seconds)}]: ${fmtNum(w.distance_km, 1)}km, ${fmtNum(w.avg_speed_kmh, 1)}km/h, ${w.avg_hr || '--'}bpm, ${Math.round(num(w.elevation_gain_m))}m${noteStr}`;
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
    return `• ${m}: ${a.count} rides, ${fmtNum(a.dist, 0)} km, ${formatHours(a.sec)}, ${Math.round(a.asc)} m, avg ${fmtNum(a.speed, 1)} km/h, HR ${a.hr ? Math.round(a.hr) : '--'}, TRIMP ${Math.round(a.trimp)}, zones ${PHYSIO.zones.map((zz, i) => `${zz.key}:${Math.round(z[i] / 60)}m`).join(' ')}`;
  });
}

// Detailed lines for the newest N rides, monthly summaries for older ones
async function ctxLedger(rides, detailed, title) {
  const weights = await getWeightHistory();
  const recent = rides.slice(-detailed);
  const older = rides.slice(0, Math.max(0, rides.length - detailed));
  const lines = [];
  for (const w of recent) {
    const n = await firstAthleteNote(w.strava_id);
    lines.push(rideLedgerLine(w, await getAthleteWeightForDate(w.date, weights), n && n.message));
  }
  let out = `${title} (${rides.length} rides${older.length ? `; newest ${recent.length} in detail, older by month` : ''}):`;
  if (older.length) out += `\nOLDER, BY MONTH:\n${monthSummaryLines(older).join('\n')}`;
  out += `\nRIDES:\n${lines.join('\n') || 'none'}`;
  return out;
}

function driftPromptText(w) {
  if (!hasVal(w.cardiac_drift_bpm)) return 'n/a (intervals/play or <30 min moving — do not diagnose aerobic drift)';
  const basis = w.decoupling_basis === 'power' ? 'Power:HR' : 'Speed:HR';
  const pct = hasVal(w.cardiac_decoupling_pct) ? `, decoupling (${basis}) ${signed(w.cardiac_decoupling_pct, 1)}%` : '';
  return `${signed(w.cardiac_drift_bpm, 0)} bpm HR drift${pct} (moving time, first 12 min skipped)`;
}

async function rideBlock(w, all) {
  let pm = `${w.avg_power_w || '--'} W (Strava estimate)`;
  if (w.device_watts) {
    const ftp = currentFtp(all);
    const st = rideStress(w, ftp);
    pm = `${w.avg_power_w} W avg / ${w.np_w || w.norm_power_w || '--'} W NP (power meter)${st ? `, IF ${st.IF.toFixed(2)}, TSS ${st.TSS} (FTP ${ftp.w} W)` : ''}`;
  }
  const best = [];
  if (w.best_spd) best.push(`speed ${Object.entries(w.best_spd).map(([d, v]) => `${BEST_LABELS[d]} ${fmtNum(v, 1)}km/h`).join(', ')}`);
  if (w.best_hr) best.push(`HR ${Object.entries(w.best_hr).map(([d, v]) => `${BEST_LABELS[d]} ${Math.round(v)}bpm`).join(', ')}`);
  if (w.power_source === 'meter' && w.mmp) best.push(`power ${[5, 60, 300, 1200].filter(d => w.mmp[d]).map(d => `${BEST_LABELS[d]} ${Math.round(w.mmp[d])}W`).join(', ')}`);
  return `- Session: ${w.exercise_code}${w.name ? ` "${w.name}"` : ''} — ${formatFullDateWithDay(w.date)}${w.trainer ? ' (indoor)' : ''}
- Distance ${fmtNum(w.distance_km, 2)} km | Moving ${rideDuration(w)} | Elapsed ${w.elapsed_sec ? formatDuration(w.elapsed_sec) : 'n/a'}
- Speed avg ${fmtNum(w.avg_speed_kmh, 1)} / max ${fmtNum(w.max_speed_kmh, 1)} km/h | HR avg ${w.avg_hr || '--'} / max ${w.max_hr || '--'} bpm${w.avg_cadence ? ` | Cadence ${w.avg_cadence} rpm` : ''}
- Power: ${pm} | Work ${w.kilojoules || '--'} kJ
- Ascent ${Math.round(num(w.elevation_gain_m))} m | VAM ${vamText(w, true)}
- Load ${hasVal(w.trimp) ? `${Math.round(w.trimp)} TRIMP${w.trimp_source === 'avg' ? ' (from average HR)' : ''}` : 'n/a'}${w.rpe ? ` | Session-RPE load ${Math.round(w.rpe * num(w.moving_sec) / 60)}` : ''}
- Intent set by athlete: ${getCleanIntentLabel(w)}
- Zone minutes (moving): ${formatFullZoneSummary(w.zone_seconds)}
- Halves: ${w.halves_profile || 'n/a'} | Drift: ${driftPromptText(w)}
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
    gapText = `${formatRecoveryGap(recoveryGapMs(last, target))} since the end of the previous ride (Ride ${last.ride_number}, ${formatFullDateWithDay(last.date)}).`;
  }
  const older = prior.length - recent.length;
  return { continuumText: (older > 0 ? `(${older} older rides not listed)\n` : '') + lines.join('\n'), targetRecoveryGapText: gapText };
}

function header(agent, roleLine, ctx) {
  return `CURRENT DATE/TIME: ${ctx.today}
ROLE: ${roleLine}
${skillsFor(agent)}`;
}

// --------------------------------------------------------
// RIDE COACH (debrief + chat about one ride)
// --------------------------------------------------------
async function rideCoachContext(w) {
  const all = await db.workouts.orderBy('date').toArray();
  const B = contextBudget();
  const day = String(w.date).slice(0, 10);
  const series = computeLoadSeries(all);
  const cont = await buildCompactPriorContinuum(w, B.priorRides);
  const timeline = await build1MinuteTelemetryTimeline(w.strava_id, B.timelineStep);
  const ws = startOfWeek(parseSafeDate(day));
  const weekRides = ridesBetween(all, ws, addDays(ws, 7));
  const t = await getWeeklyGoals(formatLocalDate(ws));
  return { all, series, cont, timeline, day, text: `${await ctxAthlete(day, all)}
${await plannedForRide(w)}
${loadLine(loadAt(series, formatLocalDate(addDays(parseSafeDate(day), -1))), `Load going into this ride (${day})`)}
${await wellnessContextText(day)}
That week: ${weekRides.length} rides, ${fmtNum(aggregateRides(weekRides).dist, 0)} km so far; targets ${[t.km ? `${t.km} km` : '', t.hours ? `${t.hours} h` : '', t.rides ? `${t.rides} rides` : ''].filter(Boolean).join(', ') || 'none'}.
Recovery: ${cont.targetRecoveryGapText}
${dataNotes()}

RIDE:
${await rideBlock(w, all)}

1-MINUTE TIMELINE (moving):
${timeline}

PREVIOUS RIDES (with recovery gaps):
${cont.continuumText || 'none'}` };
}

async function buildRideDebriefPrompt(w) {
  const c = await rideCoachContext(w);
  const ctx = await athleteContext(c.day);
  const notes = (await rideThreads(w.strava_id).toArray()).filter(t => t.role === 'athlete').map(t => t.message).join(' | ');
  return `${header('ride', `You are ${ATHLETE.name}'s cycling coach, debriefing one ride.`, ctx)}

${c.text}

ATHLETE MESSAGES ABOUT THIS RIDE: ${notes || 'none'}

TASK: Debrief this ride. Compare it with what was planned and with the athlete's intent, use the timeline for specifics, judge drift only if valid, factor in recovery, load and wellness on that date, and finish with 2–3 concrete recommendations for the next sessions.
${formattingRules()}`;
}

async function buildRideChatPrompt(w, athleteMessage, hasImage) {
  const c = await rideCoachContext(w);
  const ctx = await athleteContext(c.day);
  const past = await rideThreads(w.strava_id).toArray();
  const turns = past.slice(-10).map(t => `${t.role === 'coach' ? 'COACH' : 'ATHLETE'}: ${t.message}`);
  return `${header('ride', `You are ${ATHLETE.name}'s cycling coach, discussing one ride.`, ctx)}

${c.text}

CONVERSATION SO FAR:
${turns.join('\n') || 'none'}

ATHLETE: ${athleteMessage || '(no text)'}${hasImage ? '\n(The athlete attached a screenshot — read it directly.)' : ''}

Answer the athlete directly, using the data above. ${formattingRules()}`;
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
  return `${header('compare', `You are ${ATHLETE.name}'s cycling physiologist comparing rides.`, ctx)}

${await ctxAthlete(formatLocalDate(new Date()), all)}
${dataNotes()}

${blocks.join('\n\n')}

TASK: Compare these rides like-for-like: execution vs plan and intent, physiological response (HR, drift, zones), climbing, load and the athlete's own ratings, accounting for mass, terrain, recovery and wellness on each date. Finish with a one-line verdict and what to do next.
${formattingRules()}`;
}

// --------------------------------------------------------
// TRENDS AUDIT
// --------------------------------------------------------
async function buildGraphPrompt(workouts, metrics) {
  const B = contextBudget();
  const series = computeLoadSeries(workouts);
  const ctx = await athleteContext(formatLocalDate(new Date()), await getLatestWeight());
  const weeks = weeklyTotals(workouts).slice(-B.weeks).map(w => `${w.week}: ${w.count} rides, ${fmtNum(w.dist, 0)} km, ${formatHours(w.sec)}, ${Math.round(w.asc)} m, TRIMP ${Math.round(w.trimp)}`);
  return `${header('trends', `You are ${ATHLETE.name}'s sports scientist auditing season progression.`, ctx)}

${await ctxAthlete(formatLocalDate(new Date()), workouts, { phaseHistory: true })}
${loadLine(loadAt(series, formatLocalDate(new Date())), 'Load today')}
${loadTrendText(series, B.weeks)}
WEEKLY TOTALS:
${weeks.join('\n') || 'none'}
${bestEffortsText(workouts)}
${dataNotes()}

${await ctxLedger(workouts, B.detailedRides, 'SEASON')}

TASK: Analyse progression in ${metrics.join(', ')}. Separate fitness gains from mass, terrain and intensity-mix effects; comment on the load trend, intensity distribution and consistency; name the 2–3 most useful changes.
${formattingRules()}`;
}

function buildGraphReplyPrompt(metrics, dialogue) {
  return `CURRENT DATE: ${formatFullDateWithDay(formatLocalDate(new Date()))}
ROLE: ${ATHLETE.name}'s sports scientist discussing season progression (${metrics.join(', ')}).
${skillsFor('trends')}

CONVERSATION:
${dialogue}

${formattingRules()}`;
}

function bestEffortsText(workouts) {
  const groups = [['best_spd', 'Speed', v => `${fmtNum(v, 1)} km/h`], ['best_hr', 'HR', v => `${Math.round(v)} bpm`], ['mmp', 'Power (meter)', v => `${Math.round(v)} W`]];
  const lines = [];
  for (const [f, name, fmt] of groups) {
    const durs = f === 'mmp' ? [5, 60, 300, 1200, 3600] : [60, 300, 1200, 3600];
    const cells = durs.map(d => {
      let best = null;
      for (const w of workouts) {
        if (f === 'mmp' && w.power_source !== 'meter') continue;
        const v = w[f] && w[f][d];
        if (v && (!best || v > best.v)) best = { v, date: String(w.date).slice(0, 10) };
      }
      return best ? `${BEST_LABELS[d]} ${fmt(best.v)} (${best.date})` : null;
    }).filter(Boolean);
    if (cells.length) lines.push(`${name}: ${cells.join(', ')}`);
  }
  return lines.length ? `ALL-TIME BEST EFFORTS:\n${lines.join('\n')}` : '';
}

// --------------------------------------------------------
// REPORTS
// --------------------------------------------------------
async function buildReportPrompt(current, prior, startDate, endDate, timeframe) {
  const all = await db.workouts.orderBy('date').toArray();
  const B = contextBudget();
  const series = computeLoadSeries(all);
  const ctx = await athleteContext(formatLocalDate(new Date()), await getLatestWeight());
  const cur = aggregateRides(current);
  let pop = 'PREVIOUS PERIOD: no rides in the preceding window of equal length.';
  if (prior.length) {
    const pri = aggregateRides(prior);
    pop = `PERIOD vs PREVIOUS PERIOD (duration-weighted):
- Rides ${cur.count} vs ${pri.count} | Distance ${fmtNum(cur.dist, 1)} vs ${fmtNum(pri.dist, 1)} km | Time ${formatHours(cur.sec)} vs ${formatHours(pri.sec)}
- TRIMP ${Math.round(cur.trimp)} vs ${Math.round(pri.trimp)} | Work ${Math.round(cur.work)} vs ${Math.round(pri.work)} kJ
- Speed ${fmtNum(cur.speed, 1)} vs ${fmtNum(pri.speed, 1)} km/h | HR ${cur.hr ? Math.round(cur.hr) : '--'} vs ${pri.hr ? Math.round(pri.hr) : '--'} bpm`;
  }
  const z = sumZones(current);
  const zt = z.reduce((a, b) => a + b, 0) || 1;
  const low = (z[0] + z[1]) / zt, mid = z[2] / zt, high = (z[3] + z[4]) / zt;
  const days = Math.max(1, Math.round((parseSafeDate(endDate) - parseSafeDate(startDate)) / 86400000) + 1);
  return `${header('report', `You are ${ATHLETE.name}'s sports scientist writing a period review.`, ctx)}

${await ctxAthlete(endDate, all, { phaseHistory: true })}
PERIOD: ${formatFullDateWithDay(startDate)} to ${formatFullDateWithDay(endDate)} (${timeframe.toUpperCase()})
${loadLine(loadAt(series, endDate), 'Load at period end')}
${loadTrendText(series, Math.min(B.weeks, Math.ceil(days / 7) + 1))}
${await ctxTargets(all)}
${await ctxAdherence(Math.min(days, 60))}
INTENSITY DISTRIBUTION: low (Z1-2) ${Math.round(low * 100)}% | middle (Z3) ${Math.round(mid * 100)}% | high (Z4-5) ${Math.round(high * 100)}% | polarization index ${mid > 0 ? round((low + high) / mid, 2) : 'n/a'}
${pop}
${await wellnessContextText(endDate, 'long')}
${dataNotes()}

${await ctxLedger(current, B.detailedRides, 'RIDES IN THIS PERIOD')}

TASK: Write the review in four numbered sections:
1. Aerobic base & intensity distribution
2. Drift, decoupling and recovery (including wellness data if present)
3. Climbing & terrain
4. Progress vs previous period, plan adherence and next steps
${formattingRules()} Use plain ASCII characters.`;
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
  return `${header('planner', `You are ${ATHLETE.name}'s coach adapting the next 7 days of the athlete's own plan.`, ctx)}

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
async function buildMasterPrompt(payloadText, hasImage) {
  const all = await db.workouts.orderBy('date').toArray();
  const B = contextBudget();
  const series = computeLoadSeries(all);
  const today = formatLocalDate(new Date());
  const ctx = await athleteContext(today, await getLatestWeight());
  const past = await db.master_chat.toArray();
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
  const weeks = weeklyTotals(all).slice(-B.weeks).map(w => `${w.week}: ${w.count} rides, ${fmtNum(w.dist, 0)} km, ${formatHours(w.sec)}, ${Math.round(w.asc)} m, TRIMP ${Math.round(w.trimp)}`);
  const pending = past.filter(m => m.proposal && !m.proposal_status).length;

  return `${header('aether', `You are Aether, ${ATHLETE.name}'s head coach and exercise physiologist. You remember the whole season, you manage the athlete's training plan and weekly targets, and you speak as Aether.`, ctx)}

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

SEASON: ${all.length} rides, ${fmtNum(agg.dist, 0)} km, ${formatHours(agg.sec)}, ${Math.round(agg.asc)} m, ${Math.round(agg.trimp)} TRIMP; zone minutes ${PHYSIO.zones.map((zz, i) => `${zz.key}:${Math.round(z[i] / 60)}`).join(' ')}
WEEKLY TOTALS:
${weeks.join('\n') || 'none'}
${bestEffortsText(all)}
${elapsed} Rides since then: ${since.length ? since.map(r => `R${r.ride_number} ${fmtNum(r.distance_km, 1)} km (${formatFullDateWithDay(r.date)})`).join(', ') : 'none'}.
${dataNotes()}

${await ctxLedger(all, B.detailedRides, 'SEASON LEDGER')}

CONVERSATION SO FAR:
${past.slice(-12).map(t => `${t.role === 'coach' ? 'AETHER' : 'ATHLETE'}: ${t.message}`).join('\n') || 'none'}

ATHLETE: ${payloadText || '(no text)'}${hasImage ? '\n(The athlete attached a screenshot — read it directly.)' : ''}

Answer as Aether. If the athlete asks to change the plan or targets (or pastes their plan), follow the plan-actions skill and include the <plan-update> block. ${formattingRules()}`;
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
