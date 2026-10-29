'use strict';
// --------------------------------------------------------
// COMPARE LAB
// --------------------------------------------------------
let compareAiBusy = false;

async function setupComparison() {
  const workouts = await db.workouts.orderBy('date').reverse().toArray();
  const s1 = $('#comp_s1'), s2 = $('#comp_s2'), s3 = $('#comp_s3');
  if (workouts.length < 2) {
    $('#compareTableContainer').innerHTML = `<div class="empty">${icon('columns')}<div><b>Need at least 2 rides</b></div><div class="small mt-8">Sync more rides to compare them.</div></div>`;
    s1.innerHTML = s2.innerHTML = s3.innerHTML = '';
    return;
  }
  const keep = [s1.value, s2.value, s3.value];
  const opts = workouts.map(w => `<option value="${w.id}">${escapeHtml(rideTitle(w))} · ${escapeHtml(formatNiceDate(w.date, false))} · ${fmtNum(w.distance_km, 1)} km</option>`).join('');
  s1.innerHTML = opts;
  s2.innerHTML = opts;
  s3.innerHTML = '<option value="">None</option>' + opts;
  const ids = new Set(workouts.map(w => String(w.id)));
  // Default: B = latest ride, A = the previous ride
  s1.value = ids.has(keep[0]) ? keep[0] : String(workouts[1].id);
  s2.value = ids.has(keep[1]) ? keep[1] : String(workouts[0].id);
  s3.value = ids.has(keep[2]) ? keep[2] : '';
  renderComparison();
}

function swapComparison() {
  const a = $('#comp_s1').value;
  $('#comp_s1').value = $('#comp_s2').value;
  $('#comp_s2').value = a;
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

async function renderComparison() {
  const sel = await selectedComparisonRides();
  if (!sel) return;
  const { w1, w2, w3 } = sel;
  const weights = await getWeightHistory();
  const m = await Promise.all([w1, w2, w3].map(w => (w ? getAthleteWeightForDate(w.date, weights) : null)));

  const d = (a, b, dp, unit, lower = false) => (hasVal(a) && hasVal(b) && a !== 0 && b !== 0 ? deltaCell(b - a, dp, unit, lower) : '<span class="neu">--</span>');
  const rows = [
    ['Date', w => formatNiceDate(w.date), null],
    ['Weight', (w, i) => (m[i] ? `${m[i]} kg` : '--'), () => d(m[0], m[1], 1, ' kg', true)],
    ['Intent', w => escapeHtml(getCleanIntentLabel(w)), null],
    ['Distance', w => `${fmtNum(w.distance_km, 2)} km`, () => d(w1.distance_km, w2.distance_km, 2, ' km')],
    ['Moving time', w => rideDuration(w), () => d(w1.moving_sec / 60, w2.moving_sec / 60, 0, ' min')],
    ['Avg speed', w => `${fmtNum(w.avg_speed_kmh, 1)} km/h`, () => d(w1.avg_speed_kmh, w2.avg_speed_kmh, 1, ' km/h')],
    ['Max speed', w => `${fmtNum(w.max_speed_kmh, 1)} km/h`, () => d(w1.max_speed_kmh, w2.max_speed_kmh, 1, ' km/h')],
    ['Avg HR', w => (w.avg_hr ? `${w.avg_hr} bpm` : '--'), () => d(w1.avg_hr, w2.avg_hr, 0, ' bpm', true)],
    ['Peak HR', w => (w.max_hr ? `${w.max_hr} bpm` : '--'), () => d(w1.max_hr, w2.max_hr, 0, ' bpm', true)],
    ['Avg power', w => (w.avg_power_w ? `${w.avg_power_w} W${w.device_watts ? '' : '*'}` : '--'), () => d(w1.avg_power_w, w2.avg_power_w, 0, ' W')],
    ['Ascent', w => `${Math.round(num(w.elevation_gain_m))} m`, () => d(w1.elevation_gain_m, w2.elevation_gain_m, 0, ' m')],
    ['Climbing VAM', w => (w.climbing_vam ? `${w.climbing_vam} m/h` : `${grossAscentRate(w)} m/h gross`), () => d(w1.climbing_vam, w2.climbing_vam, 0, ' m/h')],
    ['Work', w => (w.kilojoules ? `${w.kilojoules} kJ` : '--'), () => d(w1.kilojoules, w2.kilojoules, 0, ' kJ')],
    ['Load', w => (hasVal(w.trimp) ? `${Math.round(w.trimp)} TRIMP` : '--'), () => d(w1.trimp, w2.trimp, 0, '')],
    ['Drift', w => escapeHtml(decouplingDisplay(w)), null]
  ];
  const short = w => escapeHtml(w.exercise_code ? w.exercise_code.split(' - ')[0] : rideTitle(w));
  $('#compareTableContainer').innerHTML = `
    <div class="table-wrap"><table class="dtable">
      <thead><tr><th>Metric</th><th>A · ${short(w1)}</th><th>B · ${short(w2)}</th><th>B vs A</th>${w3 ? `<th>C · ${short(w3)}</th>` : ''}</tr></thead>
      <tbody>${rows.map(([name, fmt, delta]) => `<tr><td>${name}</td><td>${fmt(w1, 0)}</td><td>${fmt(w2, 1)}</td><td>${delta ? delta() : '<span class="neu">--</span>'}</td>${w3 ? `<td>${fmt(w3, 2)}</td>` : ''}</tr>`).join('')}</tbody>
    </table></div>
    <div class="hint mt-8">Green = better for B (lower is better for heart rate and weight). * = Strava power estimate.</div>`;
}

async function generateAIComparison() {
  if (compareAiBusy) return;
  const sel = await selectedComparisonRides();
  if (!sel) { toast('Pick at least two rides.', 'warn'); return; }
  const sessions = [sel.w1, sel.w2].concat(sel.w3 ? [sel.w3] : []);
  compareAiBusy = true;
  const btn = $('#btnCompareAI');
  setBusy(btn, true, 'Comparing rides…');
  $('#compareAIBox').innerHTML = typingHtml('Computing physiological differences');
  try {
    const reply = await callGemini(await buildComparePrompt(sessions), null);
    $('#compareAIBox').innerHTML = reply ? bubbleHtml({ role: 'coach', message: reply, created_at: new Date().toISOString() }, 'Comparative breakdown') : '';
  } catch (e) {
    $('#compareAIBox').innerHTML = '';
    toast(`Comparison failed: ${e.message}`, 'error');
  } finally {
    compareAiBusy = false;
    setBusy(btn, false);
  }
}
