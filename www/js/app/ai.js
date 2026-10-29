'use strict';
// --------------------------------------------------------
// GEMINI CLIENT + PROMPT BUILDERS
// --------------------------------------------------------
const GEMINI_MODELS = [
  ['gemini-3.8-flash', 'Gemini 3.8 Flash (Latest)'],
  ['gemini-3.7-flash', 'Gemini 3.7 Flash'],
  ['gemini-3.6-flash', 'Gemini 3.6 Flash'],
  ['gemini-3.5-flash', 'Gemini 3.5 Flash'],
  ['gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite']
];
const AI_TIMEOUT_MS = 90000;

let isRequestInProgress = false;

async function getActiveModel() {
  const m = String(await getConfig('selected_gemini_model') || '');
  if (!m || m.includes('2.5')) return GEMINI_MODELS[0][0];
  return m;
}

async function modelOptionsHtml() {
  const custom = String(await getConfig('custom_gemini_model') || '').trim();
  const opts = GEMINI_MODELS.slice();
  if (custom && !opts.some(o => o[0] === custom)) opts.push([custom, `${custom} (custom)`]);
  return opts.map(([v, l]) => `<option value="${escapeHtml(v)}">${escapeHtml(l)}</option>`).join('');
}

async function refreshModelSelectors() {
  const html = await modelOptionsHtml();
  const active = await getActiveModel();
  $$('.model-select').forEach(sel => { sel.innerHTML = html; sel.value = active; });
}

async function syncModelSelection(modelName) {
  await setConfig('selected_gemini_model', modelName);
  $$('.model-select').forEach(sel => { sel.value = modelName; });
}

function extractText(data) {
  const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  if (!Array.isArray(parts)) return null;
  const text = parts.filter(p => !p.thought).map(p => p.text || '').join('').trim();
  return text || null;
}

async function postGemini(model, key, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body
    });
  } finally {
    clearTimeout(timer);
  }
}

// Returns the reply text, or null (an error toast has already been shown).
async function callGemini(prompt, imageB64 = null) {
  if (isRequestInProgress) { toast('An AI request is already running — please wait.', 'warn'); return null; }
  if (!navigator.onLine) { toast('Connect to the internet to use the AI coach.', 'warn'); return null; }
  const key = String(await getConfig('gemini_api_key') || '').trim();
  if (!key) { toast('Add your Gemini API key in Profile → Connections.', 'warn', 4500); return null; }

  isRequestInProgress = true;
  const model = await getActiveModel();
  const parts = [{ text: prompt }];
  if (imageB64) parts.push({ inlineData: { mimeType: 'image/jpeg', data: imageB64.includes(',') ? imageB64.split(',')[1] : imageB64 } });
  const body = JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { maxOutputTokens: 8192 } });

  try {
    let res = await postGemini(model, key, body, AI_TIMEOUT_MS);

    // Server-side errors: fall back to the next models in the list
    if (res.status >= 500) {
      const idx = GEMINI_MODELS.findIndex(m => m[0] === model);
      const fallbacks = GEMINI_MODELS.slice(idx + 1).concat(GEMINI_MODELS.slice(0, Math.max(idx, 0))).slice(0, 2).map(m => m[0]);
      for (const fb of fallbacks) {
        toast(`${model} is busy — trying ${fb}…`, 'info', 2500);
        const r2 = await postGemini(fb, key, body, AI_TIMEOUT_MS);
        if (r2.ok) { res = r2; break; }
      }
    }

    if (res.ok) {
      const data = await res.json();
      const text = extractText(data);
      if (!text) {
        const reason = (data.candidates && data.candidates[0] && data.candidates[0].finishReason) || (data.promptFeedback && data.promptFeedback.blockReason) || 'EMPTY';
        toast(`AI response blocked or empty (${reason}). Try rephrasing.`, 'error', 5000);
        return null;
      }
      if (data.candidates[0].finishReason === 'MAX_TOKENS') toast('Reply hit the length limit and may be cut off.', 'warn');
      return text;
    }

    const errData = await res.json().catch(() => ({}));
    const msg = (errData.error && errData.error.message) || '';
    if (res.status === 429) {
      const m = msg.match(/retry in (\d+(\.\d+)?)s/i);
      toast(`Gemini rate limit on ${model}. Switch model or wait ${m ? Math.ceil(parseFloat(m[1])) : 45}s.`, 'warn', 6000);
    } else if (res.status === 404) {
      toast(`Model "${model}" not found. Pick another model in Profile.`, 'error', 6000);
    } else if (res.status === 400 || res.status === 403) {
      toast(`Gemini rejected the request (${res.status}): ${msg.slice(0, 140) || 'check your API key'}`, 'error', 7000);
    } else {
      toast(`Gemini error (${res.status}): ${msg.slice(0, 140)}`, 'error', 6000);
    }
  } catch (e) {
    toast(e.name === 'AbortError' ? `Request timed out after ${AI_TIMEOUT_MS / 1000}s on ${model}. Retry or switch model.` : `Network error: ${e.message}`, 'error', 6000);
  } finally {
    isRequestInProgress = false;
  }
  return null;
}

// --------------------------------------------------------
// SHARED PROMPT CONTEXT
// --------------------------------------------------------
async function athleteContext(dateStr, massOverride) {
  const mass = massOverride !== undefined ? massOverride : await getAthleteWeightForDate(dateStr);
  return {
    today: formatFullDateWithDay(formatLocalDate(new Date())),
    goal: await getActiveTrainingGoalForDate(dateStr || formatLocalDate(new Date())),
    weightSummary: await getWeightPromptSummary(),
    mass: mass ? `${mass} kg` : 'Not Logged / Unspecified',
    height: ATHLETE.height ? `${ATHLETE.height} cm` : 'Not Logged / Unspecified'
  };
}

function bioLine(ctx) {
  return `Athlete: ${ATHLETE.name} | Height: ${ctx.height} | Mass: ${ctx.mass} | Bike: ${ATHLETE.bike} | Max HR: ${PHYSIO.max_hr} bpm | Resting HR: ${PHYSIO.resting_hr} bpm`;
}

function sensorNotice() {
  return `ESTIMATED SENSORS & DECOUPLING METHODOLOGY:
- Unless a ride is marked "power meter", power and kJ are Strava estimates from speed, elevation and mass, NOT strain-gauge data.
- Decoupling uses Speed-to-HR on moving time (Power-to-HR only when a real power meter was used). On technical or undulating MTB terrain, gradient and surface friction add noise; account for terrain before diagnosing true cardiovascular drift.
- Training load is Banister TRIMP from heart rate; Fitness (CTL, 42-day) / Fatigue (ATL, 7-day) / Form (TSB = CTL - ATL).`;
}

function formattingRules() {
  return `FORMATTING RULES: Clean plain English with units. Short headed sections and bullet points are fine. NO LaTeX, NO dollar signs, NO formula derivations, NO ASCII/pipe tables.`;
}

function rideLedgerLine(w, mass, note) {
  const massTag = mass ? `${mass}kg` : 'Mass Unspecified';
  const pm = w.device_watts ? ' | power meter' : '';
  const load = hasVal(w.trimp) ? ` | TRIMP ${Math.round(w.trimp)}` : '';
  const noteStr = note ? ` | Note: "${String(note).slice(0, 60)}"` : '';
  return `• R${w.ride_number} [${formatFullDateWithDay(w.date)} | ${massTag} | ${getCleanIntentLabel(w)} | Dur: ${rideDuration(w)}${pm}${load} | ${vamText(w)} | ${driftText(w)} | ${formatFullZoneSummary(w.zone_seconds)}]: ${fmtNum(w.distance_km, 2)}km, ${fmtNum(w.avg_speed_kmh, 1)}km/h, ${w.avg_hr || '--'}bpm, ${Math.round(num(w.elevation_gain_m))}m asc${noteStr}`;
}

async function loadContextText() {
  const all = await db.workouts.orderBy('date').toArray();
  const snap = currentLoadSnapshot(computeLoadSeries(all));
  if (!snap) return 'Training load: no heart-rate data yet.';
  return `Current training load (${snap.date}): Fitness CTL ${snap.ctl}, Fatigue ATL ${snap.atl}, Form TSB ${snap.tsb} (${formStatus(snap.tsb).label}).`;
}

async function buildCompactPriorContinuum(target) {
  const prior = await db.workouts.where('date').below(target.date).sortBy('date');
  const weights = await getWeightHistory();
  const lines = [];
  for (let i = 0; i < prior.length; i++) {
    const p = prior[i];
    const note = await firstAthleteNote(p.strava_id);
    const gap = i > 0 ? ` (+${formatRecoveryGap(recoveryGapMs(prior[i - 1], p))})` : '';
    lines.push(rideLedgerLine(p, await getAthleteWeightForDate(p.date, weights), note && note.message).replace(']: ', `${gap}]: `));
  }
  let gapText = 'Baseline ride in series (no prior ride recorded).';
  if (prior.length) {
    const last = prior[prior.length - 1];
    gapText = `${formatRecoveryGap(recoveryGapMs(last, target))} since the end of the previous session (Ride ${last.ride_number} on ${formatFullDateWithDay(last.date)}).`;
  }
  return { continuumText: lines.join('\n'), targetRecoveryGapText: gapText };
}

function driftPromptText(w) {
  if (!hasVal(w.cardiac_drift_bpm)) return 'n/a (interval/play pacing or <30 min moving; do not diagnose aerobic drift from intervals)';
  const basis = w.decoupling_basis === 'power' ? 'Power:HR' : 'Speed:HR';
  const pct = hasVal(w.cardiac_decoupling_pct) ? `, Decoupling (${basis}): ${signed(w.cardiac_decoupling_pct, 1)}%` : '';
  return `${signed(w.cardiac_drift_bpm, 0)} bpm (HR Drift${pct} on moving time, first 12 min moving warmup skipped)`;
}

async function rideBlock(w) {
  const pm = w.device_watts ? `${w.avg_power_w} W avg / ${w.norm_power_w || '--'} W NP (power meter)` : `${w.avg_power_w || '--'} W (Strava estimate)`;
  return `- Session: ${w.exercise_code}${w.name ? ` "${w.name}"` : ''}
- Calendar Date & Time: ${formatFullDateWithDay(w.date)}
- Distance: ${fmtNum(w.distance_km, 2)} km | Moving: ${rideDuration(w)} | Elapsed: ${w.elapsed_sec ? formatDuration(w.elapsed_sec) : 'n/a'}
- Speed: Avg ${fmtNum(w.avg_speed_kmh, 1)} km/h, Max ${fmtNum(w.max_speed_kmh, 1)} km/h
- Heart Rate: Avg ${w.avg_hr || '--'} bpm, Peak ${w.max_hr || '--'} bpm
- Power: ${pm} | Work: ${w.kilojoules || '--'} kJ
- Ascent: ${Math.round(num(w.elevation_gain_m))} m | Climbing VAM: ${vamText(w, true)}
- Training load: ${hasVal(w.trimp) ? `${Math.round(w.trimp)} TRIMP${w.trimp_source === 'avg' ? ' (from average HR)' : ''}` : 'n/a'}
- Target Session Intent: ${getCleanIntentLabel(w)}
- Moving In-Zone Minutes (all 5 zones): ${formatFullZoneSummary(w.zone_seconds)}
- Halves Profile: ${w.halves_profile || 'N/A'}
- Intraday Drift / Decoupling: ${driftPromptText(w)}`;
}

async function buildRideDebriefPrompt(w) {
  const ctx = await athleteContext(w.date);
  const cont = await buildCompactPriorContinuum(w);
  const notes = (await rideThreads(w.strava_id).toArray()).filter(t => t.role === 'athlete').map(t => t.message).join(' | ');
  return `CURRENT SYSTEM DATE: ${ctx.today}
You are a cycling physiologist coaching ${ATHLETE.name}.
${bioLine(ctx)}
CARDIAC FRAMEWORK: ${zoneFrameworkText()}
OVERARCHING TRAINING OBJECTIVE (ACTIVE PHASE): "${ctx.goal}"
ATHLETE MASS PROGRESSION: [${ctx.weightSummary}]. Speed shifts must be contextualised with body-mass changes rather than assuming VO2 gains alone.
${await loadContextText()}

${sensorNotice()}

RECOVERY GAP STATUS:
${cont.targetRecoveryGapText}

WORKOUT UNDER EVALUATION:
${await rideBlock(w)}

IN-RIDE 1-MINUTE TELEMETRY TIMELINE:
${await build1MinuteTelemetryTimeline(w.strava_id)}

PRIOR RIDES IN THIS SERIES (CHRONOLOGICAL WITH RECOVERY GAPS):
${cont.continuumText || 'First baseline ride recorded.'}

ATHLETE SENSATIONS/NOTES:
${notes || 'None recorded.'}

DIRECTIVES:
- Factor in the calendar date, start time and the exact recovery gap (${cont.targetRecoveryGapText}).
- Evaluate execution strictly against the session intent and the active goal phase.
- Use the precomputed in-zone minutes and drift. If drift is n/a because of intervals, analyse interval repeatability instead.
- End with 2-3 concrete recommendations for the next session.
- ${formattingRules()}`;
}

async function buildRideChatPrompt(w, athleteMessage, hasImage) {
  const ctx = await athleteContext(w.date);
  const cont = await buildCompactPriorContinuum(w);
  const past = await rideThreads(w.strava_id).toArray();
  const turns = [];
  if (past.length) {
    turns.push(`${past[0].role.toUpperCase()}: ${past[0].message}`);
    past.slice(1).slice(-7).forEach(t => turns.push(`${t.role.toUpperCase()}: ${t.message}`));
  }
  return `CURRENT SYSTEM DATE: ${ctx.today}
You are ${ATHLETE.name}'s personal cycling sports scientist.
${bioLine(ctx)}
Logged mass trajectory: [${ctx.weightSummary}]
CARDIAC FRAMEWORK: ${zoneFrameworkText()}
OVERARCHING TRAINING OBJECTIVE (ACTIVE PHASE): "${ctx.goal}"
${await loadContextText()}

${sensorNotice()}

SESSION TELEMETRY & RECOVERY STATUS:
- Recovery Status: ${cont.targetRecoveryGapText}
${await rideBlock(w)}

IN-RIDE 1-MINUTE TELEMETRY TIMELINE:
${await build1MinuteTelemetryTimeline(w.strava_id)}

PRIOR RIDES IN BLOCK (CHRONOLOGICAL WITH RECOVERY GAPS):
${cont.continuumText || 'Baseline session.'}

CONVERSATION HISTORY:
${turns.join('\n') || 'None'}

ATHLETE MESSAGE:
${athleteMessage || '(no text)'}
${hasImage ? '(The athlete attached a screenshot. Examine the visual data directly.)' : ''}

DIRECTIVES:
- Answer the athlete's message directly; reference minute-level timeline specifics and prior-ride comparisons where relevant.
- Factor in date, start time, recovery gap and logged weight progression.
- ${formattingRules()}`;
}

async function seasonLedger(workouts) {
  const weights = await getWeightHistory();
  const lines = [];
  for (const w of workouts) {
    const note = await firstAthleteNote(w.strava_id);
    lines.push(rideLedgerLine(w, await getAthleteWeightForDate(w.date, weights), note && note.message));
  }
  return lines.join('\n');
}

async function buildGraphPrompt(workouts, metrics) {
  const ctx = await athleteContext(formatLocalDate(new Date()), await getLatestWeight());
  return `CURRENT SYSTEM DATE: ${ctx.today}
You are an executive sports scientist reviewing ${ATHLETE.name}'s season.
${bioLine(ctx)}
ACTIVE TRAINING GOAL PHASE: "${ctx.goal}"
ATHLETE MASS DYNAMICS: [${ctx.weightSummary}]
${await loadContextText()}
${sensorNotice()}

WORKOUT LOG (DATES, START TIMES, INTENT, ZONE MINUTES, VAM, DRIFT, LOAD):
${await seasonLedger(workouts)}

ANALYTICAL DIRECTIVE:
Analyse macro progression trends across: ${metrics.join(', ')}.
Address whether speed improvements coincide with mass change rather than cardiac efficiency alone, and comment on the fitness/fatigue trend. Note terrain friction and elevation for an XC mountain bike.
${formattingRules()}`;
}

function buildGraphReplyPrompt(metrics, dialogue) {
  return `CURRENT SYSTEM DATE: ${formatFullDateWithDay(formatLocalDate(new Date()))}
You are ${ATHLETE.name}'s sports scientist discussing macro progression (${metrics.join(', ')}).
CONVERSATION:
${dialogue}

${formattingRules()}`;
}

async function buildComparePrompt(sessions) {
  const ctx = await athleteContext(formatLocalDate(new Date()));
  const weights = await getWeightHistory();
  const lines = [];
  for (const s of sessions) {
    const notes = (await rideThreads(s.strava_id).toArray()).filter(t => t.role === 'athlete').map(t => t.message).join(' | ');
    lines.push(rideLedgerLine(s, await getAthleteWeightForDate(s.date, weights), notes));
  }
  return `CURRENT SYSTEM DATE: ${ctx.today}
You are an expert sports physiologist analysing ${ATHLETE.name} (Height: ${ctx.height}, Bike: ${ATHLETE.bike}, Max HR ${PHYSIO.max_hr} bpm).
CARDIAC FRAMEWORK: ${zoneFrameworkText()}
${sensorNotice()}

Compare these rides considering their exact dates, start times, duration, mass differences, intended targets, climbing VAM (>3% grade) vs gross ascent rate, cardiac drift, training load and moving zone minutes:
${lines.join('\n')}

Contrast execution vs intent and physiological responses. Analyse whether speed gains are influenced by changing body mass and terrain gradients. Finish with a one-line verdict.
${formattingRules()}`;
}

async function buildMasterPrompt(payloadText, hasImage) {
  const workouts = await db.workouts.orderBy('date').toArray();
  const ctx = await athleteContext(formatLocalDate(new Date()), await getLatestWeight());
  const past = await db.master_chat.toArray();

  let elapsed = 'First conversation initiated today.';
  let since = [];
  if (past.length) {
    const lastT = parseSafeDate(past[past.length - 1].created_at).getTime();
    const h = Math.round((Date.now() - lastT) / 3600000);
    elapsed = `It has been ${(h / 24).toFixed(1)} days (${h} hours) since your last conversation with ${ATHLETE.name}.`;
    since = workouts.filter(w => parseSafeDate(w.date).getTime() > lastT);
  }
  const agg = aggregateRides(workouts);
  const z = sumZones(workouts);

  return `CURRENT SYSTEM DATE: ${ctx.today}
You are ${ATHLETE.name}'s head cycling sports director and exercise physiologist.
${bioLine(ctx)}
CARDIAC FRAMEWORK: ${zoneFrameworkText()}
OVERARCHING TRAINING OBJECTIVE (ACTIVE PHASE): "${ctx.goal}"
ATHLETE MASS DYNAMICS: [${ctx.weightSummary}]
${await loadContextText()}
${sensorNotice()}

CHRONOLOGICAL CONTEXT & TIME ELAPSED:
${elapsed}
Rides completed since last conversation: ${since.length ? since.map(r => `Ride ${r.ride_number} (${fmtNum(r.distance_km, 1)}km on ${formatFullDateWithDay(r.date)})`).join(', ') : 'None.'}

SEASON ACCUMULATION (${workouts.length} TOTAL RIDES RETAINED):
- Total Distance: ${fmtNum(agg.dist, 1)} km | Moving Time: ${formatHours(agg.sec)}
- Total Vertical Ascent: ${Math.round(agg.asc)} m
- Total Estimated Work: ${Math.round(agg.work)} kJ | Total TRIMP: ${Math.round(agg.trimp)}
- Moving Time-In-Zone: ${PHYSIO.zones.map((zz, i) => `${zz.key}: ${Math.round(z[i] / 60)}m`).join(' | ')}

SEASON WORKOUT LEDGER:
${await seasonLedger(workouts)}

CONVERSATION HISTORY:
${past.slice(-8).map(t => `${t.role.toUpperCase()}: ${t.message}`).join('\n') || 'None'}

CURRENT ATHLETE INQUIRY:
${payloadText || '(no text)'}
${hasImage ? '(Athlete attached a screenshot. Examine visual data directly.)' : ''}

DIRECTIVES:
- Maintain full longitudinal memory of all recorded rides; note dates, start times and recovery gaps.
- Factor in changing body mass when assessing sustained speed and power, and use Form (TSB) when advising on intensity.
- ${formattingRules()}`;
}

async function buildReportPrompt(current, prior, startDate, endDate, timeframe) {
  const ctx = await athleteContext(formatLocalDate(new Date()), await getLatestWeight());
  const cur = aggregateRides(current);
  let pop = 'PRIOR PERIOD COMPARISON: No prior baseline period of equal length recorded.';
  if (prior.length) {
    const pri = aggregateRides(prior);
    pop = `PERIOD-OVER-PERIOD PROGRESSION (duration-weighted, current vs immediately preceding window of equal length):
- Rides: ${cur.count} (vs ${pri.count})
- Distance Volume: ${fmtNum(cur.dist, 1)} km (vs ${fmtNum(pri.dist, 1)} km | ${signed(cur.dist - pri.dist, 1)} km)
- Moving Time: ${formatHours(cur.sec)} (vs ${formatHours(pri.sec)})
- Estimated Work: ${Math.round(cur.work)} kJ (vs ${Math.round(pri.work)} kJ | ${signed(cur.work - pri.work, 0)} kJ)
- Training Load: ${Math.round(cur.trimp)} TRIMP (vs ${Math.round(pri.trimp)})
- Weighted Average Speed: ${fmtNum(cur.speed, 1)} km/h (vs ${fmtNum(pri.speed, 1)} km/h | ${signed(cur.speed - pri.speed, 1)} km/h)
- Weighted Mean Heart Rate: ${cur.hr ? Math.round(cur.hr) : '--'} bpm (vs ${pri.hr ? Math.round(pri.hr) : '--'} bpm)`;
  }
  const z = sumZones(current);
  const drifts = current.map(w => w.cardiac_drift_bpm).filter(hasVal);
  const meanDrift = drifts.length ? fmtNum(mean(drifts), 1) : null;
  const ids = new Set(current.map(w => Number(w.strava_id)));
  const notes = (await db.threads.where('role').equals('athlete').toArray()).filter(t => ids.has(Number(t.strava_id)))
    .map(t => `- R${t.ride_number}: "${t.message}"`).join('\n');

  return `CURRENT SYSTEM DATE: ${ctx.today}
You are an executive sports scientist reviewing ${ATHLETE.name}.
${bioLine(ctx)}
CARDIAC FRAMEWORK: ${zoneFrameworkText()}
EVALUATION WINDOW: ${formatFullDateWithDay(startDate)} to ${formatFullDateWithDay(endDate)} (${timeframe.toUpperCase()}).
ACTIVE TRAINING GOAL PHASE: "${ctx.goal}"
LOGGED MASS PROGRESSION: [${ctx.weightSummary}]
${await loadContextText()}
${sensorNotice()}

MOVING TIME-IN-ZONE FOR THIS PERIOD:
${PHYSIO.zones.map((zz, i) => `${zz.key}: ${Math.round(z[i] / 60)}m`).join(' | ')}
Mean Intraday Cardiac Drift: ${meanDrift !== null ? `${meanDrift} bpm (steady-state rides, moving time)` : 'n/a (no steady efforts >= 30 min moving with valid HR)'}

${pop}

CURRENT PERIOD SESSION LEDGER:
${await seasonLedger(current)}

ATHLETE QUALITATIVE NOTES (THIS WINDOW):
${notes || 'No specific notes recorded.'}

REPORT REQUIREMENTS:
Structure into four sections with these exact numbered headings:
1. Aerobic Base & Sub-Threshold Dynamics
2. Intraday Cardiac Drift & Decoupling Under Current Body Mass & Terrain
3. Climbing VAM & Terrain Ascent Adaptation
4. Period-Over-Period Progress, Load & Recovery Synthesis
- Evaluate the period-over-period deltas, the active goal phase, the mass progression and the fitness/fatigue/form state.
- ${formattingRules()} Use plain ASCII characters.`;
}
