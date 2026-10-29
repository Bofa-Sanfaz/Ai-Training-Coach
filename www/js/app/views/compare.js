'use strict';
// --------------------------------------------------------
// COMPARE LAB — two (or three) sessions of the same sport
// Defaults: B = latest real session, A = the most similar earlier one (same intent,
// similar distance and duration). Accidental recordings (<5 min or <0.5 km) and
// excluded workouts are never picked automatically.
// --------------------------------------------------------
let compareAiBusy = false;
let compareSport = null;

const isRealSession = w => !isExcluded(w) && num(w.moving_sec) >= 300 && (sportOf(w) === 'other' || num(w.distance_km) >= (sportOf(w) === 'swim' ? 0.1 : 0.5));
const compareKey = sessions => sessions.map(s => s.id).sort((a, b) => a - b).join('-');

// Lower = more alike
function similarity(a, b) {
  const rel = (x, y) => { x = num(x); y = num(y); return x + y > 0 ? Math.abs(x - y) / Math.max(x, y) : 0; };
  let s = rel(a.distance_km, b.distance_km) * 1.2 + rel(a.moving_sec, b.moving_sec) + rel(a.elevation_gain_m, b.elevation_gain_m) * 0.4;
  if (comparableKey(a) !== comparableKey(b)) s += 0.6;
  if (isIndoor(a) !== isIndoor(b)) s += 0.5;
  return s;
}

function mostSimilar(target, pool) {
  return pool.filter(w => w.id !== target.id && w.date < target.date).sort((x, y) => similarity(target, x) - similarity(target, y))[0] || null;
}

async function setupComparison() {
  const all = await db.workouts.orderBy('date').reverse().toArray();
  const counts = {};
  for (const w of all) if (!isExcluded(w)) counts[sportOf(w)] = (counts[sportOf(w)] || 0) + 1;
  const sports = Object.keys(SPORTS).filter(s => counts[s] >= 2);
  const s1 = $('#comp_s1'), s2 = $('#comp_s2'), s3 = $('#comp_s3');
  if (!sports.length) {
    $('#compareSports').innerHTML = $('#comparePresets').innerHTML = $('#compareVerdict').innerHTML = '';
    $('#compareTableContainer').innerHTML = `<div class="empty">${icon('columns')}<div><b>Need at least 2 sessions of one sport</b></div><div class="small mt-8">Sync more workouts to compare them.</div></div>`;
    s1.innerHTML = s2.innerHTML = s3.innerHTML = '';
    chartEmpty($('#compareChart'), 'Nothing to overlay yet.');
    return;
  }
  const latest = all.find(isRealSession);
  if (!sports.includes(compareSport)) compareSport = latest && sports.includes(sportOf(latest)) ? sportOf(latest) : sports[0];
  $('#compareSports').innerHTML = sports.length > 1 ? sports.map(s => `<button class="chip ${s === compareSport ? 'active' : ''}" onclick="pickCompareSport('${s}')">${icon(SPORTS[s].icon, 'ic-sm')}${SPORTS[s].plural} <span class="tiny">${counts[s]}</span></button>`).join('') : '';
  $('#comparePresets').innerHTML = `
    <button class="chip" onclick="comparePreset('similar')">${icon('target', 'ic-sm')}Latest vs most similar</button>
    <button class="chip" onclick="comparePreset('previous')">${icon('history', 'ic-sm')}Latest vs previous</button>
    <button class="chip" onclick="comparePreset('best')">${icon('star', 'ic-sm')}Latest vs best similar</button>`;

  const pool = all.filter(w => sportOf(w) === compareSport && !isExcluded(w));
  const label = w => `${rideCode(w)} · ${formatNiceDate(w.date, false)} · ${distText(w)} · ${rideDuration(w)}${isRealSession(w) ? '' : ' · short'}`;
  const opts = pool.map(w => `<option value="${w.id}">${escapeHtml(label(w))}</option>`).join('');
  const keep = [s1.value, s2.value, s3.value];
  s1.innerHTML = opts; s2.innerHTML = opts; s3.innerHTML = '<option value="">None</option>' + opts;
  const ids = new Set(pool.map(w => String(w.id)));
  if (ids.has(keep[0]) && ids.has(keep[1])) {
    s1.value = keep[0]; s2.value = keep[1]; s3.value = ids.has(keep[2]) ? keep[2] : '';
    await renderComparison();
  } else {
    await comparePreset('similar', true);
  }
}

function pickCompareSport(s) {
  compareSport = s;
  $('#comp_s1').innerHTML = '';
  haptic('light');
  setupComparison();
}

async function comparePreset(kind, silent) {
  const sorted = (await db.workouts.orderBy('date').reverse().toArray()).filter(w => sportOf(w) === compareSport && !isExcluded(w));
  const pool = sorted.filter(isRealSession);
  if (pool.length < 2) {
    if (sorted.length >= 2) { $('#comp_s2').value = String(sorted[0].id); $('#comp_s1').value = String(sorted[1].id); }
    return renderComparison();
  }
  const b = pool[0];
  let a = null;
  if (kind === 'previous') a = pool[1];
  else if (kind === 'best') {
    const similar = pool.slice(1).filter(w => similarity(b, w) < 0.9);
    a = (similar.length ? similar : pool.slice(1)).filter(w => hasVal(mv(w, 'avg_speed_kmh'))).sort((x, y) => num(y.avg_speed_kmh) - num(x.avg_speed_kmh))[0] || pool[1];
  } else a = mostSimilar(b, pool) || pool[1];
  $('#comp_s1').value = String(a.id);
  $('#comp_s2').value = String(b.id);
  $('#comp_s3').value = '';
  if (!silent) haptic('light');
  await renderComparison();
}

function swapComparison() {
  const a = $('#comp_s1').value;
  $('#comp_s1').value = $('#comp_s2').value;
  $('#comp_s2').value = a;
  haptic('light');
  renderComparison();
}

async function selectedComparisonRides() {
  const v = [$('#comp_s1').value, $('#comp_s2').value, $('#comp_s3').value];
  if (!v[0] || !v[1]) return null;
  const w1 = await db.workouts.get(+v[0]);
  const w2 = await db.workouts.get(+v[1]);
  const w3 = v[2] ? await db.workouts.get(+v[2]) : null;
  return w1 && w2 ? { w1, w2, w3 } : null;
}

// Speed per 100 heartbeats — the core "am I fitter?" number without a power meter
const effOf = w => (mv(w, 'avg_speed_kmh') > 0 && mv(w, 'avg_hr') > 0 ? (w.avg_speed_kmh / w.avg_hr) * 100 : null);

function compareVerdictHtml(a, b) {
  const sp = sportOf(b);
  const parts = [];
  let tone = 'neu';
  const ea = effOf(a), eb = effOf(b);
  const dHr = mv(a, 'avg_hr') && mv(b, 'avg_hr') ? b.avg_hr - a.avg_hr : null;
  const dSpd = hasVal(mv(a, 'avg_speed_kmh')) && hasVal(mv(b, 'avg_speed_kmh')) ? b.avg_speed_kmh - a.avg_speed_kmh : null;
  if (sp !== 'other' && dSpd !== null) {
    const faster = dSpd > 0;
    const sTxt = sp === 'ride' ? `${fmtNum(Math.abs(dSpd), 1)} km/h ${faster ? 'faster' : 'slower'}` : `${faster ? 'faster' : 'slower'} (${speedText(b)} vs ${speedText(a)})`;
    parts.push(`B was ${sTxt}${dHr !== null ? (dHr === 0 ? ' at the same heart rate' : ` at ${Math.abs(dHr)} bpm ${dHr < 0 ? 'lower' : 'higher'} heart rate`) : ''}`);
  } else if (dHr !== null) parts.push(`B's average heart rate was ${Math.abs(dHr)} bpm ${dHr <= 0 ? 'lower' : 'higher'}`);
  const sa = swimOf(a), sb = swimOf(b);
  if (sp === 'swim' && sa && sb && sa.swolf && sb.swolf) {
    const dS = sb.swolf - sa.swolf;
    tone = dS < -1 ? 'pos' : dS > 1 ? 'neg' : 'neu';
    parts.push(`SWOLF ${sb.swolf} vs ${sa.swolf} (${dS < 0 ? 'more efficient' : dS > 0 ? 'less efficient' : 'same'})${sb.spl && sa.spl ? `, ${sb.spl} vs ${sa.spl} strokes per length` : ''}`);
  } else if (ea && eb) {
    const pct = ((eb - ea) / ea) * 100;
    tone = pct > 2 ? 'pos' : pct < -2 ? 'neg' : 'neu';
    parts.push(tone === 'pos' ? `efficiency up ${fmtNum(pct, 1)}% — more speed for every heartbeat` : tone === 'neg' ? `efficiency down ${fmtNum(Math.abs(pct), 1)}% — check terrain, heat or fatigue` : 'efficiency about the same');
  }
  if (!parts.length) return '';
  const sim = similarity(a, b);
  const fair = sim < 0.5 ? 'Very similar sessions — a fair comparison.' : sim < 1 ? 'Reasonably similar sessions.' : 'These sessions differ a lot (distance, duration, terrain or intent) — read the numbers with care.';
  return `<div class="verdict ${tone}">
    <div class="vd-icon">${icon(tone === 'pos' ? 'trend' : tone === 'neg' ? 'alert' : 'activity')}</div>
    <div class="grow"><div class="vd-text">${escapeHtml(parts.join('; '))}.</div><div class="tiny muted mt-4">${escapeHtml(fair)}</div></div></div>`;
}

async function renderComparison() {
  const sel = await selectedComparisonRides();
  if (!sel) return;
  const { w1, w2, w3 } = sel;
  const list = [w1, w2].concat(w3 ? [w3] : []);
  const sp = sportOf(w2);
  const weights = await getWeightHistory();
  const m = await Promise.all(list.map(w => getAthleteWeightForDate(w.date, weights)));
  $('#compareSub').textContent = `${SPORTS[sp].plural} · ${rideCode(w1)} vs ${rideCode(w2)}${w3 ? ` vs ${rideCode(w3)}` : ''}`;
  $('#compareVerdict').innerHTML = compareVerdictHtml(w1, w2);

  // [label, value, display, lowerIsBetter, decimals, unit]
  const rows = [
    ['Distance', w => mv(w, 'distance_km'), w => (hasVal(mv(w, 'distance_km')) ? distText(w) : 'flagged'), false, sp === 'swim' ? 3 : 2, ' km'],
    ['Moving time', w => num(w.moving_sec) / 60, w => rideDuration(w), false, 0, ' min'],
    [speedName(w2), w => mv(w, 'avg_speed_kmh'), w => (hasVal(mv(w, 'avg_speed_kmh')) ? speedText(w) : '--'), false, 1, ' km/h'],
    ['Efficiency', w => effOf(w), w => (effOf(w) ? fmtNum(effOf(w), 1) : '--'), false, 1, ''],
    ['Avg HR', w => mv(w, 'avg_hr') || null, w => (mv(w, 'avg_hr') ? `${w.avg_hr} bpm` : '--'), true, 0, ' bpm'],
    ['Peak HR', w => mv(w, 'max_hr') || null, w => (mv(w, 'max_hr') ? `${w.max_hr} bpm` : '--'), true, 0, ' bpm'],
    ['Load', w => mv(w, 'trimp'), w => (hasVal(mv(w, 'trimp')) ? `${Math.round(w.trimp)} TRIMP` : '--'), false, 0, '']
  ];
  if (sp === 'other') {
    rows.splice(0, 4, ['Time', w => num(w.moving_sec) / 60, w => rideDuration(w), false, 0, ' min']);
    rows.push(['Energy', w => w.calories || null, w => (w.calories ? `${w.calories} kcal` : '--'), false, 0, ' kcal']);
  }
  if (sp === 'swim') {
    // Swims: per-length metrics replace speed and efficiency (lower pace / SWOLF / strokes = better)
    const sw = w => swimOf(w);
    rows.splice(0, 4,
      ['Distance', w => num(w.distance_km) * 1000, w => distText(w), false, 0, ' m'],
      ['Swim time', w => num(w.moving_sec) / 60, w => formatDuration(w.moving_sec), false, 0, ' min'],
      ['Pace /100 m', w => swimPace100(w), w => fmtSec(swimPace100(w)), true, 0, ' s'],
      ['SWOLF', w => sw(w) && sw(w).swolf, w => (sw(w) && sw(w).swolf ? String(sw(w).swolf) : '--'), true, 1, ''],
      ['Strokes / length', w => sw(w) && sw(w).spl, w => (sw(w) && sw(w).spl ? String(sw(w).spl) : '--'), true, 1, ''],
      ['Fastest 100 m', w => sw(w) && sw(w).best[100], w => fmtSec(sw(w) && sw(w).best[100]), true, 0, ' s'],
      ['Stroke rate', w => sw(w) && sw(w).stroke_rate, w => (sw(w) && sw(w).stroke_rate ? `${sw(w).stroke_rate} /min` : '--'), false, 1, '/min']);
  }
  if (onFoot(sp)) rows.splice(4, 0, ['Cadence', w => w.avg_cadence || null, w => (w.avg_cadence ? `${w.avg_cadence} spm` : '--'), false, 0, ' spm']);
  if (sp === 'ride' || (onFoot(sp) && !isIndoor(w1) && !isIndoor(w2))) rows.splice(4, 0, ['Ascent', w => mv(w, 'elevation_gain_m'), w => (hasVal(mv(w, 'elevation_gain_m')) ? `${Math.round(num(w.elevation_gain_m))} m` : 'flagged'), false, 0, ' m']);
  if (sp === 'ride') {
    rows.push(['Climbing VAM', w => mv(w, 'climbing_vam'), w => (mv(w, 'climbing_vam') ? `${w.climbing_vam} m/h` : '--'), false, 0, ' m/h']);
    rows.push(['Max speed', w => mv(w, 'max_speed_kmh'), w => (mv(w, 'max_speed_kmh') ? `${fmtNum(w.max_speed_kmh, 1)} km/h` : '--'), false, 1, ' km/h']);
  }
  if (sp === 'ride' && m[0] && m[1]) rows.push(['Body weight', (w, i) => m[i], (w, i) => (m[i] ? `${m[i]} kg` : '--'), true, 1, ' kg']);

  const color = SPORTS[sp].color;
  const cells = rows.map(([name, val, disp, lower, d, unit]) => {
    const a = val(w1, 0), b = val(w2, 1);
    const c = w3 ? val(w3, 2) : null;
    const max = Math.max(num(a), num(b), num(c)) || 1;
    const both = hasVal(a) && hasVal(b) && a !== 0 && b !== 0;
    const paceRow = name === speedName(w2) && sp !== 'ride';
    const delta = !both ? '<span class="neu">--</span>' : paceRow
      ? `<span class="${b > a ? 'pos' : b < a ? 'neg' : 'neu'}">${b > a ? 'faster' : b < a ? 'slower' : 'same'}</span>`
      : deltaCell(b - a, d, unit, lower);
    const bar = (v, cls, txt, style = '') => `<div class="cmp-bar ${cls}" ${style}><i style="--w:${hasVal(v) ? (num(v) / max) * 100 : 0}%"></i><span>${escapeHtml(txt)}</span></div>`;
    return `<div class="cmp-row">
      <div class="cmp-head"><span>${escapeHtml(name)}</span>${delta}</div>
      ${bar(a, 'a', disp(w1, 0))}${bar(b, 'b', disp(w2, 1), `style="--c:${color}"`)}${w3 ? bar(c, 'c', disp(w3, 2)) : ''}
    </div>`;
  }).join('');

  const zoneRow = (w, tag) => {
    const z = mv(w, 'zone_seconds');
    const tot = Array.isArray(z) ? z.reduce((x, y) => x + num(y), 0) : 0;
    return `<div class="cmp-zone"><span class="cp-tag ${tag}">${tag.toUpperCase()}</span>${tot ? `<div class="zone-strip grow">${z.map((s, i) => `<span style="width:${(num(s) / tot) * 100}%;background:${PHYSIO.zones[i].color}"></span>`).join('')}</div>` : '<span class="tiny muted grow">no heart-rate zones</span>'}</div>`;
  };

  $('#compareTableContainer').innerHTML = `
    <div class="card cmp-card">
      <div class="cmp-legend"><span><i class="lg a"></i>A · ${escapeHtml(rideCode(w1))} · ${escapeHtml(formatNiceDate(w1.date, false))}</span><span><i class="lg b" style="background:${color}"></i>B · ${escapeHtml(rideCode(w2))} · ${escapeHtml(formatNiceDate(w2.date, false))}</span>${w3 ? `<span><i class="lg c"></i>C · ${escapeHtml(rideCode(w3))}</span>` : ''}</div>
      ${cells}
      <div class="cmp-head mt-12"><span>Time in heart-rate zones</span></div>
      ${zoneRow(w1, 'a')}${zoneRow(w2, 'b')}${w3 ? zoneRow(w3, 'c') : ''}
      <div class="hint mt-8">Green = better for B. Efficiency = speed per 100 heartbeats. Values marked as data errors are left out.</div>
    </div>`;
  requestAnimationFrame(() => $$('#compareTableContainer .cmp-bar i').forEach((el, i) => setTimeout(() => el.classList.add('go'), 25 * i)));

  renderCompareChart(list);
  const saved = await getJsonConfig(`compare_ai_${compareKey(list)}`, null);
  if (!compareAiBusy) $('#compareAIBox').innerHTML = saved ? bubbleHtml(saved, 'Comparative breakdown') : '';
}

// Speed and heart rate along distance (time for swims / gym), smoothed
async function renderCompareChart(list) {
  const el = $('#compareChart');
  if (!plotReady()) return chartEmpty(el, 'Charts unavailable.');
  const sp = sportOf(list[1]);
  const byDist = sp === 'ride' || onFoot(sp);
  const colors = ['#94a3b8', SPORTS[sp].color, '#8b5cf6'];
  const traces = [];
  for (let k = 0; k < list.length; k++) {
    const w = list[k];
    const row = await db.streams.get(Number(w.strava_id));
    const s = row && row.stream_data;
    if (!s || !s.time) continue;
    const idx = strideIndices(s.time.data.length, 700);
    const useDist = byDist && s.distance && !isFlagged(w, 'distance');
    const x = idx.map(i => (useDist ? round(num(s.distance.data[i]) / 1000, 2) : round(num(s.time.data[i]) / 60, 1)));
    const tag = 'ABC'[k];
    if (s.velocity_smooth && !isFlagged(w, 'distance') && sp !== 'other') {
      const v = smoothStreamArray(s.velocity_smooth.data.map(q => num(q) * 3.6), 15);
      traces.push({ x, y: idx.map(i => round(v[i], 1)), name: `${tag} speed`, type: 'scatter', mode: 'lines', line: { color: colors[k], width: k === 1 ? 2.4 : 1.8 }, hovertemplate: `${tag} %{y} km/h<extra></extra>` });
    }
    if (s.heartrate && !isFlagged(w, 'hr')) {
      const h = smoothStreamArray(s.heartrate.data.map(num), 9);
      traces.push({ x, y: idx.map(i => Math.round(h[i])), name: `${tag} HR`, yaxis: 'y2', type: 'scatter', mode: 'lines', line: { color: colors[k], width: 1.4, dash: 'dot' }, hovertemplate: `${tag} %{y} bpm<extra></extra>` });
    }
  }
  if (!traces.length) { $('#compareOverlayNote').textContent = ''; return chartEmpty(el, 'No telemetry streams for these sessions.'); }
  $('#compareOverlayNote').textContent = `${byDist ? 'by distance' : 'by time'} · solid speed · dotted HR`;
  drawChart(el, traces, plotLayout({
    showlegend: true, legend: { orientation: 'h', y: -0.24, font: { size: 10 } },
    margin: { l: 34, r: 36, t: 8, b: 46 },
    xaxis: { ticksuffix: byDist ? ' km' : 'm' },
    yaxis: { title: { text: 'km/h', font: { size: 10 } } },
    yaxis2: { overlaying: 'y', side: 'right', showgrid: false, fixedrange: true, title: { text: 'bpm', font: { size: 10 } } }
  }));
}

async function generateAIComparison() {
  if (compareAiBusy) return;
  const sel = await selectedComparisonRides();
  if (!sel) { toast('Pick at least two sessions.', 'warn'); return; }
  const sessions = [sel.w1, sel.w2].concat(sel.w3 ? [sel.w3] : []);
  compareAiBusy = true;
  const btn = $('#btnCompareAI');
  setBusy(btn, true, 'Comparing…');
  $('#compareAIBox').innerHTML = typingHtml('Comparing the sessions');
  try {
    const meta = {};
    const live = liveBubble($('#compareAIBox'), 'Comparative breakdown');
    const reply = await callAI(await buildComparePrompt(sessions), null, { agent: 'compare', meta, onStatus: aiStatusIn($('#compareAIBox')), onDelta: t => live(hideMemoryTags(t)) });
    if (reply) {
      const saved = Object.assign({ role: 'coach', message: await captureMemory(reply, 'Compare'), created_at: new Date().toISOString() }, aiMetaFields(meta));
      await setJsonConfig(`compare_ai_${compareKey(sessions)}`, saved);
      $('#compareAIBox').innerHTML = bubbleHtml(saved, 'Comparative breakdown');
    } else $('#compareAIBox').innerHTML = '';
  } catch (e) {
    $('#compareAIBox').innerHTML = '';
    toast(`Comparison failed: ${e.message}`, 'error');
  } finally {
    compareAiBusy = false;
    setBusy(btn, false);
  }
}
