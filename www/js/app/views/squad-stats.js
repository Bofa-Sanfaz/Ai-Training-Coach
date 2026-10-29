'use strict';
// --------------------------------------------------------
// SQUAD STATS & MONTHLY REPORT
// Every chart shows each person against HIMSELF where it matters (relative score,
// minutes vs own usual, pace vs own usual); raw volumes are shown per person, never
// ranked. Body & wellness graphs only contain what each member chose to share.
// The monthly numbers come from SquadCore.month — the same function the AI uses.
// --------------------------------------------------------
const SQ_DAY = 86400000;
const sqDate = n => new Date(n * SQ_DAY).toISOString().slice(0, 10);
const sqDayN = d => Math.floor(Date.parse(`${d}T00:00:00Z`) / SQ_DAY);

function sqRange(S) {
  const today = S.st.today;
  const end = S.ch.ends && S.ch.ends < today ? S.ch.ends : today;
  const from = Squad.statsRange === 'last4' ? sqDate(Math.max(sqDayN(S.ch.starts), sqDayN(end) - 27)) : S.ch.starts;
  return { from, to: end };
}

function sqActsIn(S, from, to) {
  return Array.from(S.folded.activities.values()).filter(a => a.date >= from && a.date <= to);
}

const sqMembers = S => S.members.filter(m => m.active || S.score.members[m.id]);

function sqLegend(ms) {
  return `<div class="legend-line">${ms.map(m => `<span><i class="sq-dot" style="background:${escapeHtml(m.color)}"></i>${escapeHtml(m.name)}</span>`).join('')}</div>`;
}

function sqChart(id, title, sub, height = 220) {
  return `<div class="chart-card sq-chart"><div class="story-title">${title}${sub ? ` <span class="tiny muted">${sub}</span>` : ''}</div><div id="${id}" class="chart" style="min-height:${height}px"></div></div>`;
}

// ---------- STATS VIEW ----------
function squadStatsHtml(S) {
  const { from, to } = sqRange(S);
  const ms = sqMembers(S);
  const acts = sqActsIn(S, from, to);
  const weeks = Math.max(1, (sqDayN(to) - sqDayN(from) + 1) / 7);
  const stat = (m, fn) => fn(acts.filter(a => a.author === m.id));
  const rows = [
    ['Workouts', l => String(l.length)],
    ['Active days', l => String(new Set(l.map(a => a.date)).size)],
    ['Time', l => formatHours(sumBy(l, a => num(a.dur_s)))],
    ['Per week vs own usual', (l, m) => { const x = S.score.members[m.id]; return x && x.weekly_min ? `${Math.round(sumBy(l, a => num(a.dur_s)) / 60 / weeks / x.weekly_min * 100)}%` : '–'; }],
    ['Distance', l => { const d = sumBy(l, a => num(a.dist_m)); return d ? `${fmtNum(d / 1000, 1)} km` : '–'; }],
    ['Training load', l => { const v = Math.round(sumBy(l, a => num(a.load))); return v ? String(v) : '–'; }],
    ['Personal bests', l => String(sumBy(l, a => (a.pb ? a.pb.length : 0)))]
  ];
  const wellness = ms.some(m => Object.keys(S.folded.daily[m.id] || {}).length);
  const c = squadEntry(Squad.cur);
  const pbs = acts.filter(a => a.pb && a.pb.length).sort((a, b) => b.date.localeCompare(a.date));
  return `<div class="segmented mb-8" id="sqRangeSeg">
      <button class="${Squad.statsRange === 'last4' ? 'active' : ''}" onclick="Squad.statsRange='last4'; renderSquad()">Last 4 weeks</button>
      <button class="${Squad.statsRange !== 'last4' ? 'active' : ''}" onclick="Squad.statsRange='challenge'; renderSquad()">Whole challenge</button>
    </div>
    <div class="table-wrap"><table class="dtable sq-vs-table"><thead><tr><th></th>${ms.map(m => `<th style="color:${escapeHtml(m.color)}">${escapeHtml(m.name)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(([label, fn]) => `<tr><td>${label}</td>${ms.map(m => `<td>${escapeHtml(stat(m, l => fn(l, m)))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    <div class="tiny muted mt-4">${escapeHtml(formatNiceDate(from, false))} – ${escapeHtml(formatNiceDate(to, false))} · volumes are per person, the scores below are relative to each person's own usual</div>

    <div class="section-title"><span>Relative score</span></div>
    ${sqChart('sqStScore', 'Points per week', 'consistency + volume + improvement + bonus')}
    ${sqChart('sqStMin', 'Minutes per week', 'dashed = own usual')}
    ${sqChart('sqStImp', 'Pace vs own usual', '% better (+) or slower (−)', 200)}
    <div class="section-title"><span>Weekly duels</span><span class="tiny muted">higher relative score wins the week</span></div>
    ${squadDuelBarsHtml(S)}

    <div class="section-title"><span>How we train</span></div>
    ${sqChart('sqStMix', 'Sport mix', 'minutes', 60 + ms.length * 46)}
    ${sqChart('sqStTime', 'Time of day', 'number of workouts', 190)}
    <div class="card sq-cal-card"><div class="story-title">Training calendar <span class="tiny muted">darker = more minutes</span></div>${sqCalendarHtml(S, from, to, ms)}</div>

    <div class="section-title"><span>Body &amp; wellness</span>${c && !c.share_wellness ? `<button class="btn btn-ghost btn-xs" onclick="openSquadWeight()">${icon('scale', 'ic-sm')}Share mine</button>` : `<button class="btn btn-ghost btn-xs" onclick="openSquadWeight()">${icon('scale', 'ic-sm')}Log weight</button>`}</div>
    ${wellness ? `${sqChart('sqStWeight', 'Weight change', 'kg since each person\'s first entry in this period', 200)}${sqChart('sqStSteps', 'Daily steps', '', 190)}${sqChart('sqStRhr', 'Resting heart rate', 'bpm · lower is usually fitter', 190)}${sqChart('sqStSleep', 'Sleep', 'hours per night', 190)}`
      : `<div class="empty">${icon('heart')}<div><b>Nobody shares body &amp; wellness yet</b></div><div class="small mt-8">Weight, resting HR, sleep and steps graphs appear here for everyone who switches on sharing (Settings or Log weight). It's opt-in per person.</div></div>`}

    <div class="section-title"><span>Personal bests</span><span class="tiny muted">${pbs.length}</span></div>
    ${pbs.length ? `<div class="card sq-pb-list">${pbs.slice(0, 20).map(a => `<div class="sq-pb-row">${squadAvatar(S.member(a.author), 'xs')}<span class="grow"><b>${escapeHtml(a.pb.join(' · '))}</b><span class="tiny muted"> · ${escapeHtml(a.title || a.sport)} · ${escapeHtml(formatNiceDate(a.date, false))}</span></span></div>`).join('')}</div>` : '<div class="tiny muted">No personal bests in this period yet.</div>'}`;
}

function sqCalendarHtml(S, from, to, ms) {
  const n0 = sqDayN(from), n1 = sqDayN(to);
  const acts = sqActsIn(S, from, to);
  const max = Math.max(30, ...ms.map(m => Math.max(0, ...Array.from({ length: n1 - n0 + 1 }, (_, i) => sumBy(acts.filter(a => a.author === m.id && a.date === sqDate(n0 + i)), a => num(a.dur_s) / 60)))));
  return ms.map(m => {
    const cells = [];
    for (let n = n0; n <= n1; n++) {
      const d = sqDate(n);
      const min = sumBy(acts.filter(a => a.author === m.id && a.date === d), a => num(a.dur_s) / 60);
      const op = min ? 0.25 + 0.75 * Math.min(1, min / max) : 0;
      cells.push(`<i title="${d}: ${Math.round(min)} min" style="${min ? `background:${escapeHtml(m.color)};opacity:${op.toFixed(2)}` : ''}"></i>`);
    }
    return `<div class="sq-cal-row"><span class="sq-cal-name">${squadAvatar(m, 'xs')}</span><div class="sq-cal">${cells.join('')}</div></div>`;
  }).join('') + `<div class="tiny muted mt-4">${escapeHtml(formatNiceDate(from, false))} → ${escapeHtml(formatNiceDate(to, false))}</div>`;
}

function renderSquadStatsCharts(S) {
  if (!plotReady()) return;
  const ms = sqMembers(S);
  const sc = S.score;
  const { from, to } = sqRange(S);
  const acts = sqActsIn(S, from, to);
  const legend = { showlegend: true, legend: { orientation: 'h', y: 1.02, yanchor: 'bottom', x: 0, font: { size: 11 } }, margin: { l: 38, r: 10, t: 40, b: 30 } };
  const weekIdx = sc.duels.map((d, i) => i).filter(i => { const w = sc.members[ms[0].id] && sc.members[ms[0].id].weeks[i]; return w && w.to >= from; });
  const wkLabel = i => `W${i + 1}`;
  // 1. Relative score per week
  drawChart($('#sqStScore'), ms.filter(m => sc.members[m.id]).map(m => ({
    x: weekIdx.map(wkLabel), y: weekIdx.map(i => sc.members[m.id].weeks[i].total), name: m.name, type: 'scatter', mode: 'lines+markers+text',
    text: weekIdx.map(i => Math.round(sc.members[m.id].weeks[i].total)), textposition: 'top center', textfont: { size: 10, color: m.color },
    line: { color: m.color, width: 3, shape: 'spline' }, marker: { size: 8 }, hovertemplate: `${m.name}: %{y:.0f} pts<extra></extra>`
  })), plotLayout(Object.assign({}, legend, { yaxis: { rangemode: 'tozero' } })));
  // 2. Minutes per week vs own usual
  const minTraces = [];
  for (const m of ms.filter(x => sc.members[x.id])) {
    const x = sc.members[m.id];
    minTraces.push({ x: weekIdx.map(wkLabel), y: weekIdx.map(i => x.weeks[i].minutes), name: m.name, type: 'bar', marker: { color: m.color, line: { width: 0 } }, hovertemplate: `${m.name}: %{y} min<extra></extra>` });
    if (x.weekly_min) minTraces.push({ x: weekIdx.map(wkLabel), y: weekIdx.map(() => x.weekly_min), name: `${m.name} usual`, type: 'scatter', mode: 'lines', line: { color: m.color, dash: 'dash', width: 2 }, showlegend: false, hovertemplate: `${m.name} usual: %{y} min<extra></extra>` });
  }
  drawChart($('#sqStMin'), minTraces, plotLayout(Object.assign({}, legend, { barmode: 'group', bargap: 0.3 })));
  // 3. Improvement (% vs own usual pace, minutes-weighted over sports)
  drawChart($('#sqStImp'), ms.filter(m => sc.members[m.id]).map(m => ({
    x: weekIdx.map(wkLabel), y: weekIdx.map(i => { const p = sc.members[m.id].weeks[i].improvement; return p.length ? round(mean(p.map(z => z.pct)), 1) : null; }),
    name: m.name, type: 'scatter', mode: 'lines+markers', connectgaps: true, line: { color: m.color, width: 3 }, marker: { size: 8 }, hovertemplate: `${m.name}: %{y:+.1f}%<extra></extra>`
  })), plotLayout(Object.assign({}, legend, { yaxis: { zeroline: true, zerolinecolor: cssVar('--border-strong') || '#cfd8e5', ticksuffix: '%' } })));
  // 4. Sport mix (minutes, stacked per person)
  const sports = Object.keys(SPORTS).filter(s => acts.some(a => a.sport === s));
  drawChart($('#sqStMix'), sports.map(s => ({
    y: ms.map(m => m.name), x: ms.map(m => Math.round(sumBy(acts.filter(a => a.author === m.id && a.sport === s), a => num(a.dur_s)) / 60)),
    name: SPORTS[s].plural, type: 'bar', orientation: 'h', marker: { color: SPORTS[s].color }, hovertemplate: `${SPORTS[s].plural}: %{x} min<extra></extra>`
  })), plotLayout(Object.assign({}, legend, { barmode: 'stack', margin: { l: 70, r: 10, t: 26, b: 26 }, hovermode: 'closest', yaxis: { showgrid: false } })));
  // 5. Time of day
  const buckets = [['Early', 4, 8], ['Morning', 8, 12], ['Afternoon', 12, 17], ['Evening', 17, 21], ['Night', 21, 28]];
  const hourOf = a => { const h = parseInt(String(a.start || '').slice(0, 2), 10); return Number.isFinite(h) ? (h < 4 ? h + 24 : h) : null; };
  drawChart($('#sqStTime'), ms.map(m => ({
    x: buckets.map(b => b[0]), y: buckets.map(([, lo, hi]) => acts.filter(a => a.author === m.id && hourOf(a) !== null && hourOf(a) >= lo && hourOf(a) < hi).length),
    name: m.name, type: 'bar', marker: { color: m.color }, hovertemplate: `${m.name}: %{y}<extra></extra>`
  })), plotLayout(Object.assign({}, legend, { barmode: 'group', bargap: 0.3 })));
  // 6. Wellness
  if ($('#sqStWeight')) {
    const series = (f, scale = 1) => ms.map(m => {
      const e = Object.entries(S.folded.daily[m.id] || {}).filter(([d, v]) => d >= from && d <= to && v[f] > 0).sort(([a], [b]) => a.localeCompare(b));
      return { m, x: e.map(([d]) => d), y: e.map(([, v]) => round(v[f] * scale, 1)) };
    }).filter(s => s.x.length);
    // relative: plot the change from each person's own first value (weight is never compared between bodies)
    const line = (el, f, unit, scale, relative) => {
      const s = series(f, scale);
      if (!s.length) { chartEmpty(el, 'Nobody shared this yet'); return; }
      drawChart(el, s.map(({ m, x, y }) => ({
        x, y: relative ? y.map(v => round(v - y[0], 1)) : y, customdata: y, name: m.name, type: 'scatter', mode: 'lines+markers', connectgaps: true,
        line: { color: m.color, width: 2.5 }, marker: { size: 5 },
        hovertemplate: relative ? `${m.name}: %{y:+.1f} ${unit} (%{customdata} ${unit})<extra></extra>` : `${m.name}: %{y} ${unit}<extra></extra>`
      })), plotLayout(Object.assign({}, legend, { xaxis: { type: 'date', tickformat: '%d %b' }, yaxis: relative ? { ticksuffix: ` ${unit}`, zeroline: true, zerolinecolor: cssVar('--border-strong') || '#cfd8e5' } : {} })));
    };
    const bars = (el, f, unit, scale) => { const s = series(f, scale); if (!s.length) { chartEmpty(el, 'Nobody shared this yet'); return; } drawChart(el, s.map(({ m, x, y }) => ({ x, y, name: m.name, type: 'bar', marker: { color: m.color }, hovertemplate: `${m.name}: %{y} ${unit}<extra></extra>` })), plotLayout(Object.assign({}, legend, { barmode: 'group', xaxis: { type: 'date', tickformat: '%d %b' } }))); };
    line($('#sqStWeight'), 'weight_kg', 'kg', 1, true);
    bars($('#sqStSteps'), 'steps', 'steps');
    line($('#sqStRhr'), 'rhr', 'bpm');
    bars($('#sqStSleep'), 'sleep_min', 'h', 1 / 60);
  }
}

// ---------- MONTHLY REPORT ----------
function sqMonths(S) {
  const out = [];
  const last = (S.ch.ends && S.ch.ends < S.st.today ? S.ch.ends : S.st.today).slice(0, 7);
  let y = +S.ch.starts.slice(0, 4), mo = +S.ch.starts.slice(5, 7);
  for (let guard = 0; guard < 60; guard++) {
    const ym = `${y}-${String(mo).padStart(2, '0')}`;
    out.push(ym);
    if (ym >= last) break;
    mo++; if (mo > 12) { mo = 1; y++; }
  }
  return out;
}

const sqMonthName = ym => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

function sqMonthData(S, ym) {
  return SquadCore.month(sqMembers(S), Array.from(S.folded.activities.values()), S.folded.daily, ym, S.score);
}

// The AI's latest monthly report for this month (answer to a 'report' request)
function sqMonthAiReport(S, ym) {
  const reqs = new Map(S.folded.messages.filter(m => m.body.ai && m.body.ai.mode === 'report').map(m => [m.id, m]));
  return S.folded.messages.filter(m => m.author === 'ai' && m.body.mode === 'report' && reqs.has(m.body.reply_to) && (reqs.get(m.body.reply_to).body.ai.month || ym) === ym).pop() || null;
}

function squadReportHtml(S) {
  const months = sqMonths(S);
  if (!Squad.month || !months.includes(Squad.month)) Squad.month = months[months.length - 1];
  const ym = Squad.month;
  const mo = sqMonthData(S, ym);
  const ms = sqMembers(S);
  const ai = sqMonthAiReport(S, ym);
  const asked = S.folded.messages.some(m => m.body.ai && m.body.ai.mode === 'report' && m.body.ai.month === ym && !S.folded.messages.some(r => r.body.reply_to === m.id));
  const best = ms.map(m => ({ m, v: mo.members[m.id] && mo.members[m.id].avg_week_points })).filter(x => x.v !== null && x.v !== undefined).sort((a, b) => b.v - a.v);
  const winner = best.length > 1 && best[0].v > best[1].v ? best[0].m : null;
  const tile = (v, l) => `<div class="sq-tile"><b>${v}</b><span>${l}</span></div>`;
  const cards = ms.map(m => {
    const x = mo.members[m.id];
    if (!x) return '';
    const wd = x.weight_start && x.weight_end ? round(x.weight_end - x.weight_start, 1) : null;
    const sportBars = Object.entries(x.by_sport).sort((a, b) => b[1].minutes - a[1].minutes);
    const maxMin = Math.max(1, ...sportBars.map(([, v]) => v.minutes));
    return `<div class="card sq-month-card" style="--mc:${escapeHtml(m.color)}">
      <div class="row between"><div class="row" style="gap:8px">${squadAvatar(m)}<b>${escapeHtml(m.name)}</b></div>${x.avg_week_points !== null ? `<div class="sq-week-pts">${Math.round(x.avg_week_points)}<small> avg pts/week</small></div>` : ''}</div>
      <div class="sq-tiles">
        ${tile(x.sessions, 'workouts')}${tile(x.active_days, 'active days')}${tile(formatHours(x.minutes * 60), 'time')}
        ${tile(x.dist_m ? `${fmtNum(x.dist_m / 1000, 1)}<small>km</small>` : '–', 'distance')}${tile(x.load || '–', 'load')}${tile(x.best_streak ? `${x.best_streak}<small>d</small>` : '–', 'best streak')}
        ${wd !== null ? tile(`${wd > 0 ? '+' : ''}${fmtNum(wd, 1)}<small>kg</small>`, 'weight change') : ''}
        ${x.avg_sleep_min ? tile(`${fmtNum(x.avg_sleep_min / 60, 1)}<small>h</small>`, 'sleep / night') : ''}
        ${x.avg_steps ? tile(fmtNum(x.avg_steps / 1000, 1) + '<small>k</small>', 'steps / day') : ''}
        ${x.avg_rhr ? tile(`${Math.round(x.avg_rhr)}<small>bpm</small>`, 'resting HR') : ''}
      </div>
      ${sportBars.length ? `<div class="sq-sport-bars">${sportBars.map(([s, v]) => `<div class="sq-bar"><div class="sq-bar-l">${icon((SPORTS[s] || SPORTS.other).icon, 'ic-xs')} ${(SPORTS[s] || SPORTS.other).plural}</div><div class="sq-bar-t"><i style="width:${Math.round(v.minutes / maxMin * 100)}%;background:${(SPORTS[s] || SPORTS.other).color}"></i></div><div class="sq-bar-v">${v.n}× · ${formatHours(v.minutes * 60)}</div></div>`).join('')}</div>` : ''}
      ${x.pbs.length ? `<div class="sq-crew-pbs">${x.pbs.slice(0, 5).map(p => `<span>⭐ ${escapeHtml(p)}</span>`).join('')}</div>` : ''}
      ${x.longest ? `<div class="tiny muted mt-8">Longest: ${escapeHtml(x.longest.title)} · ${formatDuration(x.longest.dur_s)}${x.longest.dist_m ? ` · ${fmtNum(x.longest.dist_m / 1000, 1)} km` : ''} · ${escapeHtml(formatNiceDate(x.longest.date, false))}</div>` : ''}
    </div>`;
  }).join('');
  return `<div class="chip-rack mb-8">${months.map(m => `<button class="chip ${m === ym ? 'active' : ''}" onclick="Squad.month='${m}'; renderSquad()">${escapeHtml(sqMonthName(m))}</button>`).join('')}</div>
    <div class="card card-hero sq-top sq-month-hero">
      <div class="sq-kicker">Monthly report · ${escapeHtml(S.ch.name)}</div>
      <div class="sq-title">${escapeHtml(sqMonthName(ym))}</div>
      <div class="sq-week-note">${winner ? `🏆 ${escapeHtml(winner.name)} wins the month on relative points` : best.length > 1 ? 'Dead level on relative points' : 'Relative points per week, averaged over the month'}</div>
    </div>
    <div class="sq-score-grid mt-12">${cards}</div>
    <div class="section-title"><span>The month in graphs</span></div>
    ${sqChart('sqRpDaily', 'Minutes per day', 'stacked per person')}
    ${sqChart('sqRpCum', 'On track vs own usual', 'cumulative minutes · dashed = own usual pace', 220)}
    ${sqChart('sqRpWeeks', 'Points per week', 'relative score', 200)}
    <div class="section-title"><span>${SQUAD_AI}'s monthly report</span>${ai ? `<span class="tiny muted">${escapeHtml(relativeTime(ai.created_at))}</span>` : ''}</div>
    ${ai ? `<div class="card sq-recap"><div class="md">${renderMarkdown(ai.body.text)}</div></div>` : `<div class="tiny muted mb-8">${asked ? `${SQUAD_AI} is writing it — it appears here and in the chat.` : `${SQUAD_AI} reads both of your months (and the wellness you share) and writes the report into the chat.`}</div>`}
    <div class="btn-row mt-8">
      <button class="btn btn-primary btn-sm" ${asked || !(S.ch.ai && S.ch.ai.enabled) ? 'disabled' : ''} onclick="squadAskMonthReport('${ym}')">${icon('sparkle')}${ai ? 'Write it again' : 'Write the report'}</button>
      <button class="btn btn-dark btn-sm" id="sqPdfBtn" onclick="exportSquadMonthPdf('${ym}')">${icon('download')}Export PDF</button>
    </div>`;
}

function squadAskMonthReport(ym) {
  squadQueue(Squad.cur, 'msg', { text: `📊 Monthly report for ${sqMonthName(ym)}, please`, ai: { mode: 'report', month: ym } });
  toast(`${SQUAD_AI} is writing the ${sqMonthName(ym)} report`, 'info');
  renderSquad();
}

function renderSquadReportCharts(S) {
  if (!plotReady()) return;
  const ym = Squad.month;
  const ms = sqMembers(S);
  const mo = sqMonthData(S, ym);
  const today = S.st.today;
  const lastDay = mo.to < today ? mo.to : today;
  const days = [];
  // From the challenge start (an "own usual pace" line before it would be meaningless)
  for (let n = sqDayN(mo.from > S.ch.starts ? mo.from : S.ch.starts); n <= sqDayN(lastDay); n++) days.push(sqDate(n));
  const acts = Array.from(S.folded.activities.values());
  const legend = { showlegend: true, legend: { orientation: 'h', y: 1.02, yanchor: 'bottom', x: 0, font: { size: 11 } }, margin: { l: 38, r: 10, t: 40, b: 30 } };
  const perDay = m => days.map(d => Math.round(sumBy(acts.filter(a => a.author === m.id && a.date === d), a => num(a.dur_s)) / 60));
  drawChart($('#sqRpDaily'), ms.map(m => ({ x: days, y: perDay(m), name: m.name, type: 'bar', marker: { color: m.color }, hovertemplate: `${m.name}: %{y} min<extra></extra>` })),
    plotLayout(Object.assign({}, legend, { barmode: 'stack', bargap: 0.25, xaxis: { type: 'date', tickformat: '%d' } })));
  const cum = [];
  for (const m of ms) {
    let s = 0;
    cum.push({ x: days, y: perDay(m).map(v => (s += v)), name: m.name, type: 'scatter', mode: 'lines', line: { color: m.color, width: 3 }, fill: 'none', hovertemplate: `${m.name}: %{y} min<extra></extra>` });
    const usual = S.score.members[m.id] && S.score.members[m.id].weekly_min;
    if (usual) cum.push({ x: days, y: days.map((d, i) => Math.round(usual / 7 * (i + 1))), name: `${m.name} usual`, type: 'scatter', mode: 'lines', line: { color: m.color, dash: 'dash', width: 1.5 }, showlegend: false, hovertemplate: `${m.name} usual pace: %{y} min<extra></extra>` });
  }
  drawChart($('#sqRpCum'), cum, plotLayout(Object.assign({}, legend, { xaxis: { type: 'date', tickformat: '%d %b' }, yaxis: { rangemode: 'tozero' } })));
  drawChart($('#sqRpWeeks'), ms.filter(m => mo.members[m.id]).map(m => ({
    x: mo.members[m.id].week_points.map(w => `W${w.week}`), y: mo.members[m.id].week_points.map(w => w.total), name: m.name, type: 'bar',
    marker: { color: m.color }, text: mo.members[m.id].week_points.map(w => Math.round(w.total)), textposition: 'outside', hovertemplate: `${m.name}: %{y:.0f} pts<extra></extra>`
  })), plotLayout(Object.assign({}, legend, { barmode: 'group', bargap: 0.3, yaxis: { rangemode: 'tozero' } })));
}

// ---------- PDF ----------
async function exportSquadMonthPdf(ym) {
  const S = squadState(Squad.cur);
  if (!S || !window.jspdf) return;
  const btn = $('#sqPdfBtn');
  setBusy(btn, true, 'Building PDF…');
  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const W = 210, H = 297, M = 14;
    const fam = await pdfFonts(doc);
    const font = (style, size, color, numbers = false) => { doc.setFont(numbers && fam.num ? fam.num : fam.text, numbers && fam.num ? 'bold' : style); doc.setFontSize(size); doc.setTextColor(...color); };
    const hex = c => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
    const ms = sqMembers(S);
    const mo = sqMonthData(S, ym);
    let y = 0;
    const ensure = need => { if (y + need > H - 16) { doc.addPage(); y = 18; } };
    // Header band
    doc.setFillColor(252, 82, 0); doc.rect(0, 0, W, 38, 'F');
    font('bold', 9, [255, 255, 255]); doc.text(`SQUAD MONTHLY REPORT · ${S.ch.name.toUpperCase()}`, M, 13);
    font('bold', 24, [255, 255, 255], true); doc.text(sqMonthName(ym), M, 26);
    font('normal', 9, [255, 236, 224]); doc.text(`${ms.map(m => m.name).join(' vs ')} · everyone scored against his own usual numbers`, M, 33);
    y = 48;
    // One summary table, a column per person
    const rows = [
      ['Workouts', x => x.sessions], ['Active days', x => x.active_days], ['Time', x => formatHours(x.minutes * 60)],
      ['Distance', x => (x.dist_m ? `${fmtNum(x.dist_m / 1000, 1)} km` : '–')], ['Training load', x => x.load || '–'],
      ['Best streak', x => (x.best_streak ? `${x.best_streak} days` : '–')], ['Avg points / week', x => (x.avg_week_points ?? '–')],
      ['Personal bests', x => x.pbs.length], ['Weight change', x => (x.weight_end ? `${x.weight_end - x.weight_start > 0 ? '+' : ''}${fmtNum(x.weight_end - x.weight_start, 1)} kg` : '–')],
      ['Sleep / night', x => (x.avg_sleep_min ? `${fmtNum(x.avg_sleep_min / 60, 1)} h` : '–')], ['Steps / day', x => (x.avg_steps || '–')],
      ['Sports', x => Object.entries(x.by_sport).map(([s, v]) => `${(SPORTS[s] || SPORTS.other).plural} ${v.n}×`).join(', ') || '–']
    ];
    doc.autoTable({
      startY: y, margin: { left: M, right: M }, theme: 'grid',
      head: [['', ...ms.map(m => m.name)]],
      body: rows.map(([l, f]) => [l, ...ms.map(m => String(mo.members[m.id] ? f(mo.members[m.id]) : '–'))]),
      styles: { font: fam.text, fontSize: 9, cellPadding: 2.4, lineColor: [227, 232, 240], textColor: [15, 23, 42] },
      headStyles: { fillColor: [15, 23, 42], textColor: [255, 255, 255], fontStyle: 'bold' },
      columnStyles: { 0: { fontStyle: 'bold', textColor: [51, 65, 85], cellWidth: 38 } },
      didParseCell: d => { if (d.section === 'head' && d.column.index > 0) d.cell.styles.fillColor = hex(ms[d.column.index - 1].color); }
    });
    y = doc.lastAutoTable.finalY + 8;
    // Charts from the screen (rendered off the current Report view)
    for (const [id, title] of [['sqRpDaily', 'Minutes per day'], ['sqRpCum', 'On track vs own usual (dashed = own usual pace)'], ['sqRpWeeks', 'Relative points per week']]) {
      const el = document.getElementById(id);
      if (!el || !el._fullLayout) continue;
      // Always a light chart on paper, whatever the app theme
      const ink = { color: '#334155' };
      const layout = Object.assign({}, el.layout, {
        paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff', font: Object.assign({}, el.layout.font, ink), width: 900, height: 360,
        xaxis: Object.assign({}, el.layout.xaxis, { gridcolor: '#eef2f7', linecolor: '#cfd8e5', tickfont: ink }),
        yaxis: Object.assign({}, el.layout.yaxis, { gridcolor: '#eef2f7', tickfont: ink }),
        legend: Object.assign({}, el.layout.legend, { font: { color: '#334155', size: 12 } })
      });
      const img = await Plotly.toImage({ data: el.data, layout }, { format: 'jpeg', width: 900, height: 360, scale: 1.5 });
      ensure(78);
      font('bold', 11, [15, 23, 42]); doc.text(title, M, y); y += 3;
      doc.addImage(img, 'JPEG', M, y, W - 2 * M, (W - 2 * M) * 0.4); y += (W - 2 * M) * 0.4 + 7;
    }
    // Personal bests
    const pbs = ms.flatMap(m => (mo.members[m.id] ? mo.members[m.id].pbs.map(p => `${m.name}: ${p}`) : []));
    if (pbs.length) {
      ensure(12 + pbs.length * 5);
      font('bold', 11, [15, 23, 42]); doc.text('Personal bests', M, y); y += 6;
      font('normal', 9, [51, 65, 85]);
      for (const p of pbs) { ensure(6); doc.text(`• ${p}`, M + 2, y); y += 5; }
      y += 3;
    }
    // Aether's report
    const ai = sqMonthAiReport(S, ym);
    if (ai) {
      ensure(20);
      font('bold', 11, [252, 82, 0]); doc.text(`${SQUAD_AI}'s monthly report`, M, y); y += 6;
      font('normal', 9.5, [15, 23, 42]);
      const plain = String(ai.body.text).replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#+\s*/gm, '').replace(/[`_]/g, '');
      for (const line of doc.splitTextToSize(plain, W - 2 * M)) { ensure(5.5); doc.text(line, M, y); y += 4.8; }
    }
    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i);
      font('normal', 7.5, [148, 163, 184]);
      doc.text(`Training Partner · Squad · ${S.ch.name} · ${sqMonthName(ym)}`, M, H - 8);
      doc.text(`${i} / ${pages}`, W - M, H - 8, { align: 'right' });
    }
    const name = `Squad_${S.ch.name.replace(/\W+/g, '_')}_${ym}.pdf`;
    const res = await saveOrShareFile(name, doc.output('datauristring').split(',')[1], { base64: true, mime: 'application/pdf', title: 'Squad monthly report' });
    if (res && res.ok) toast(`PDF ready → ${res.where}`, 'success');
  } catch (e) {
    console.error(e);
    toast(`PDF failed: ${e.message}`, 'error');
  } finally { setBusy(btn, false); }
}
