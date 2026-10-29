'use strict';
// --------------------------------------------------------
// REPORTS: period KPIs per sport, zone strain, records, AI review, designed PDF
// --------------------------------------------------------
let reportTimeframe = '7d';
let reportAiBusy = false;
let recordSport = 'ride';
let reportSport = 'all'; // which activities the period KPIs, review and PDF cover

function setReportSport(s) {
  reportSport = s;
  haptic('light');
  renderReports();
}

const reportSportLabel = () => (reportSport === 'all' ? 'All activities' : SPORTS[reportSport].plural);

const TF_DAYS = { '7d': 7, '30d': 30, '365d': 365 };
const TF_LABEL = { '7d': 'Last 7 days', '30d': 'Last 30 days', '365d': 'Last 12 months', all: 'All time' };

function setupReportControls() {
  $$('#reportSeg button').forEach(b => b.addEventListener('click', () => {
    reportTimeframe = b.dataset.tf;
    $$('#reportSeg button').forEach(x => x.classList.toggle('active', x === b));
    haptic('light');
    renderReports();
  }));
}

// Half-open windows [start, end) so a workout is never counted in two periods
async function getScopedWorkouts(periodsBack = 0) {
  const all = bySport((await db.workouts.orderBy('date').toArray()).filter(w => !isExcluded(w)), reportSport);
  if (reportTimeframe === 'all') return periodsBack === 0 ? all : [];
  const days = TF_DAYS[reportTimeframe];
  const now = Date.now() + 1;
  const end = now - periodsBack * days * 86400000;
  const start = end - days * 86400000;
  return all.filter(w => { const t = parseSafeDate(w.date).getTime(); return t >= start && t < end; });
}

function reportCacheId(tf = reportTimeframe) {
  return reportSport === 'all' ? `tf_${tf}` : `tf_${tf}_${reportSport}`;
}

function scopeKey(rides) {
  if (!rides.length) return '';
  return `${String(rides[0].date).split(' ')[0]}_to_${String(rides[rides.length - 1].date).split(' ')[0]}`;
}

async function getCachedReport(rides) {
  const r = await db.reports.get(reportCacheId());
  if (r && r.analysis_text && r.ride_count === rides.length && r.date_range === scopeKey(rides)) return r;
  return null;
}

// Speed per heartbeat on steady rides — a power-free efficiency marker (km/h per 100 bpm)
function efficiencyIndex(rides) {
  const ok = rides.filter(w => sportOf(w) === 'ride' && mv(w, 'avg_speed_kmh') > 0 && mv(w, 'avg_hr') > 0 && w.moving_sec >= 1200);
  if (!ok.length) return null;
  return (sumBy(ok, w => (w.avg_speed_kmh / w.avg_hr) * w.moving_sec) / sumBy(ok, w => w.moving_sec)) * 100;
}

function intensitySplit(z) {
  const t = z.reduce((a, b) => a + b, 0) || 1;
  const low = (z[0] + z[1]) / t, mid = z[2] / t, high = (z[3] + z[4]) / t;
  return { low, mid, high, pi: mid > 0 ? (low + high) / mid : null };
}

function deltaChip(a, b, d, unit, lowerBetter = false) {
  if (!hasVal(b) || !Number.isFinite(a - b) || (a === 0 && b === 0)) return '';
  const r = round(a - b, d);
  const cls = r === 0 ? 'neu' : ((r > 0) !== lowerBetter ? 'pos' : 'neg');
  return `<span class="delta ${cls}">${r > 0 ? '▲' : r < 0 ? '▼' : '■'} ${signed(r, d, unit).replace(/^[+-]/, '')}</span>`;
}

async function renderReports() {
  const all = await db.workouts.orderBy('date').toArray();
  const rides = await getScopedWorkouts(0);
  const prior = await getScopedWorkouts(1);
  const header = $('#reportScopeDateHeader');
  renderRecords(all);
  const present = sportsPresent(all.filter(w => !isExcluded(w)));
  if (reportSport !== 'all' && !present.includes(reportSport)) reportSport = 'all';
  $('#reportSportSeg').innerHTML = present.length > 1 ? [['all', 'All', 'multi']].concat(present.map(s => [s, SPORTS[s].plural, SPORTS[s].icon])).map(([k, l, ic]) => `<button class="${reportSport === k ? 'active' : ''}" onclick="setReportSport('${k}')">${icon(ic, 'ic-sm')}${l}</button>`).join('') : '';

  const box = $('#reportSummaryBox');
  if (!rides.length) {
    header.textContent = `${TF_LABEL[reportTimeframe]} · no workouts`;
    $('#reportSports').innerHTML = '';
    $('#labDiagnosticGrid').innerHTML = `<div class="small lab-muted" style="grid-column:1/-1">No data for this timeframe.</div>`;
    $('#reportZoneBars').innerHTML = '';
    box.innerHTML = '';
    return;
  }
  const startDate = String(rides[0].date).split(' ')[0];
  const endDate = String(rides[rides.length - 1].date).split(' ')[0];
  header.textContent = `${formatNiceDate(startDate, false)} – ${formatNiceDate(endDate, false)} · ${rides.length} session${rides.length > 1 ? 's' : ''}`;

  const cur = aggregateRides(rides);
  const pri = prior.length ? aggregateRides(prior) : null;

  // Per-sport tiles
  $('#reportSports').innerHTML = Object.keys(SPORTS).filter(s => cur.bySport[s]).map(s => {
    const e = cur.bySport[s];
    const p = pri && pri.bySport[s];
    const sub = aggregateRides(rides.filter(w => sportOf(w) === s));
    const probe = { sport: s };
    return `<div class="sport-tile" style="--sc:${SPORTS[s].color}">
      <div class="st-head">${icon(SPORTS[s].icon, 'ic-sm')}<b>${SPORTS[s].plural}</b><span class="grow"></span><span class="tiny">${e.count}×</span></div>
      ${s === 'other'
        ? `<div class="st-big" data-count="${round(e.sec / 3600, 1)}">${fmtNum(e.sec / 3600, 1)}</div><div class="st-unit">hours ${p ? deltaChip(e.sec / 3600, p.sec / 3600, 1, ' h') : ''}</div>`
        : `<div class="st-big" data-count="${s === 'swim' ? Math.round(e.dist * 1000) : round(e.dist, 1)}">${s === 'swim' ? `${Math.round(e.dist * 1000)}` : fmtNum(e.dist, e.dist >= 100 ? 0 : 1)}</div>
      <div class="st-unit">${s === 'swim' ? 'metres' : 'km'} ${p ? deltaChip(s === 'swim' ? e.dist * 1000 : e.dist, s === 'swim' ? p.dist * 1000 : p.dist, s === 'swim' ? 0 : 1, s === 'swim' ? ' m' : ' km') : ''}</div>`}
      <div class="st-row"><span>${formatHours(e.sec)}</span><span>${s !== 'other' && sub.speed ? speedText(probe, sub.speed) : `${Math.round(e.trimp)} TRIMP`}</span></div>
    </div>`;
  }).join('');

  const z = sumZones(rides);
  const zTot = z.reduce((a, b) => a + b, 0);
  const drifts = rides.map(w => mv(w, 'cardiac_drift_bpm')).filter(hasVal);
  const meanDrift = drifts.length ? mean(drifts) : null;
  const ei = efficiencyIndex(rides), eiP = prior.length ? efficiencyIndex(prior) : null;
  const split = intensitySplit(z);
  const series = computeLoadSeries(all);
  const l = loadAt(series, endDate);

  $('#labDiagnosticGrid').innerHTML = `
    <div class="lab-item"><div class="l">Training time</div><div class="v" style="color:var(--lab-accent)">${formatHours(cur.sec)}</div>${pri ? deltaChip(cur.sec / 3600, pri.sec / 3600, 1, ' h') : ''}</div>
    <div class="lab-item"><div class="l">Training load</div><div class="v" style="color:var(--lab-pink)">${Math.round(cur.trimp)} <small>TRIMP</small></div>${pri ? deltaChip(cur.trimp, pri.trimp, 0, '') : ''}</div>
    <div class="lab-item"><div class="l">Fitness · Form (end)</div><div class="v">${l ? `${Math.round(l.ctl)} · ${signed(l.tsb, 0)}` : '--'}</div><div class="tiny lab-muted">${l ? escapeHtml(formStatus(l.tsb).label) : 'needs HR data'}</div></div>
    <div class="lab-item"><div class="l">Weighted HR</div><div class="v">${cur.hr ? Math.round(cur.hr) : '--'} <small>bpm</small></div>${pri && pri.hr ? deltaChip(cur.hr, pri.hr, 0, ' bpm', true) : ''}</div>
    <div class="lab-item"><div class="l">Ride efficiency</div><div class="v" style="color:var(--lab-accent)">${ei ? ei.toFixed(1) : '--'}</div><div class="tiny lab-muted">km/h per 100 bpm${eiP && ei ? ` · ${signed(ei - eiP, 1)}` : ''}</div></div>
    <div class="lab-item"><div class="l">Mean drift (steady)</div><div class="v ${meanDrift === null ? '' : meanDrift <= 3 ? 'pos' : 'neg'}">${meanDrift === null ? '--' : signed(meanDrift, 1, ' bpm')}</div></div>
    <div class="lab-item" style="grid-column:1/-1"><div class="l">Intensity split · low / middle / high</div>
      <div class="split-bar"><i style="flex:${split.low};background:#16a34a"></i><i style="flex:${split.mid};background:#eab308"></i><i style="flex:${split.high};background:#ef4444"></i></div>
      <div class="tiny lab-muted">${Math.round(split.low * 100)}% · ${Math.round(split.mid * 100)}% · ${Math.round(split.high * 100)}%${split.pi ? ` · polarization ${split.pi.toFixed(1)}` : ''}</div></div>`;

  $('#reportZoneBars').innerHTML = PHYSIO.zones.map((zz, i) => {
    const pct = zTot ? Math.round((z[i] / zTot) * 100) : 0;
    return `<div class="zone-row"><span class="zone-tag">${zz.key} ${escapeHtml(zz.name)}</span>
      <div class="zone-bar"><div class="zone-fill" data-w="${pct}" style="background:${zz.color}"></div></div>
      <span class="zone-val">${formatHours(z[i])} · ${pct}%</span></div>`;
  }).join('');
  requestAnimationFrame(() => $$('#reportZoneBars .zone-fill').forEach(el => { el.style.width = `${el.dataset.w}%`; }));
  if (typeof animateIn === 'function') animateIn($('#screen-reports'));

  if (!reportAiBusy) {
    const cached = await getCachedReport(rides);
    box.innerHTML = cached ? bubbleHtml(Object.assign({ role: 'coach', message: cached.analysis_text, created_at: cached.created_at }, cached), `Review · ${reportTimeframe.toUpperCase()}`) : '';
  }
}

// All-time records per sport; each can be flagged as a data error
function renderRecords(all) {
  _recAll = all;
  const present = sportsPresent(all.filter(w => !isExcluded(w)));
  if (!present.includes(recordSport)) recordSport = present[0] || 'ride';
  $('#recordSportSeg').innerHTML = present.length > 1 ? present.map(s => `<button class="chip ${s === recordSport ? 'active' : ''}" onclick="recordSport='${s}'; renderRecords(trendsCacheAll())">${icon(SPORTS[s].icon, 'ic-sm')}${SPORTS[s].plural}</button>`).join('') : '';
  const recs = computeRecords(all, recordSport);
  $('#recordGrid').innerHTML = recs.length
    ? recs.map(r => `<div class="record" ${r.ride ? `onclick="openRide(${r.ride.id})"` : ''}>
        <div class="l">${icon(r.icon)}${escapeHtml(r.label)}</div>
        <div class="v">${escapeHtml(r.value)}</div>
        <div class="s">${r.ride ? escapeHtml(`${rideCode(r.ride)} · ${formatNiceDate(r.ride.date, false)}`) : escapeHtml(r.sub || '')}</div>
        ${r.ride && r.field ? `<button class="rec-flag" title="Mark as data error" onclick="event.stopPropagation(); openQualitySheet(${r.ride.id}, '${r.field}')">${icon('flag', 'ic-xs')}</button>` : ''}
      </div>`).join('') + '<div class="hint" style="grid-column:1/-1">Wrong record (GPS glitch, bad climb)? Tap the flag to mark that value as a data error — the next best one takes its place.</div>'
    : '<div class="small muted">Records appear after your first workout.</div>';
}
let _recAll = [];
const trendsCacheAll = () => _recAll;

async function generateExecutiveReport() {
  if (reportAiBusy) return;
  const rides = await getScopedWorkouts(0);
  if (!rides.length) { toast('No workouts in the selected timeframe.', 'warn'); return; }
  const prior = await getScopedWorkouts(1);
  const tf = reportTimeframe;
  const startDate = String(rides[0].date).split(' ')[0];
  const endDate = String(rides[rides.length - 1].date).split(' ')[0];

  reportAiBusy = true;
  const btn = $('#btnReport');
  setBusy(btn, true, 'Writing review…');
  $('#reportSummaryBox').innerHTML = typingHtml('Writing your period review');
  try {
    const meta = {};
    const live = liveBubble($('#reportSummaryBox'), `Review · ${tf.toUpperCase()}`);
    const report = await callAI(await buildReportPrompt(rides, prior, startDate, endDate, tf, reportSportLabel()), null, { agent: 'report', meta, onStatus: aiStatusIn($('#reportSummaryBox')), onDelta: t => live(hideMemoryTags(t)) });
    if (report) {
      const text = await captureMemory(report, 'Reports');
      await db.reports.put(Object.assign({ id: reportCacheId(tf), ref_code: `REPORT_${tf}_${reportSport}`, created_at: new Date().toISOString(), timeframe: tf, analysis_text: text, ride_count: rides.length, date_range: scopeKey(rides) }, aiMetaFields(meta)));
      toast('Review ready', 'success', 1800);
    }
  } catch (e) {
    toast(`Review failed: ${e.message}`, 'error');
  } finally {
    reportAiBusy = false;
    setBusy(btn, false);
    if (reportTimeframe === tf) await renderReports();
  }
}

// --------------------------------------------------------
// PDF EXPORT — a designed report: cover dashboard, charts, review, ledger
// --------------------------------------------------------
const PDF = {
  ink: [15, 23, 42], sub: [100, 116, 139], line: [226, 232, 240], soft: [248, 250, 252],
  brand: [252, 82, 0], pink: [219, 39, 119], blue: [37, 99, 235], green: [22, 163, 74], red: [220, 38, 38]
};
const hexRgb = h => { const x = String(h).replace('#', ''); return [0, 2, 4].map(o => parseInt(x.substr(o, 2), 16)); };

// Renders a Plotly chart off-screen to a JPEG data URL (light theme, fixed size; JPEG keeps the PDF small)
async function chartPng(traces, layout, w = 900, h = 360) {
  if (!window.Plotly) return null;
  const el = document.createElement('div');
  el.style.cssText = `position:fixed;left:-10000px;top:0;width:${w}px;height:${h}px`;
  document.body.appendChild(el);
  try {
    await Plotly.newPlot(el, traces, Object.assign({
      width: w, height: h, paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff',
      font: { family: 'Helvetica, Arial, sans-serif', size: 13, color: '#475569' },
      margin: { l: 44, r: 16, t: 16, b: 40 }, showlegend: true,
      legend: { orientation: 'h', y: -0.18, x: 0, font: { size: 12 } },
      xaxis: { showgrid: false, linecolor: '#e2e8f0' }, yaxis: { gridcolor: '#eef2f7', zeroline: false }
    }, layout), { staticPlot: true, displayModeBar: false });
    return await Plotly.toImage(el, { format: 'jpeg', width: w, height: h, scale: 2 });
  } catch (e) {
    console.warn('chart render failed', e);
    return null;
  } finally {
    Plotly.purge(el);
    el.remove();
  }
}

async function triggerOfficialPdfDownload() {
  const status = $('#pdfStatus');
  const rides = await getScopedWorkouts(0);
  if (!rides.length) { toast('No workouts in this timeframe.', 'warn'); return; }
  const cached = await getCachedReport(rides);
  if (!cached) {
    const go = await uiConfirm('No up-to-date review', `The PDF includes the AI review for ${TF_LABEL[reportTimeframe]}. Export without it, or write the review first?`, { okText: 'Export without review', cancelText: 'Cancel' });
    if (!go) return;
  }
  if (!window.jspdf) { toast('PDF engine failed to load.', 'error'); return; }

  const btn = $('#btnPdf');
  setBusy(btn, true, 'Designing PDF…');
  status.textContent = '';
  try {
    const all = await db.workouts.orderBy('date').toArray();
    const prior = await getScopedWorkouts(1);
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ format: 'a4', unit: 'mm' });
    const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
    const M = 14, CW = W - M * 2;
    const startDate = String(rides[0].date).split(' ')[0];
    const endDate = String(rides[rides.length - 1].date).split(' ')[0];
    const cur = aggregateRides(rides);
    const pri = prior.length ? aggregateRides(prior) : null;
    const series = computeLoadSeries(all);
    const lEnd = loadAt(series, endDate);
    const z = sumZones(rides);
    const split = intensitySplit(z);
    const wt = await getLatestWeight();
    const txt = s => markdownToPlain(String(s));
    const font = (style, size, color) => { doc.setFont('helvetica', style); doc.setFontSize(size); doc.setTextColor(...color); };
    let y = 0;
    const ensure = need => { if (y + need > H - 18) { doc.addPage(); y = 18; } };
    const sectionTitle = (t, kicker) => {
      ensure(16);
      font('bold', 6.5, PDF.brand); doc.text(String(kicker || '').toUpperCase(), M, y);
      font('bold', 12, PDF.ink); doc.text(t, M, y + 5.5);
      y += 10;
    };

    // ---------- Cover band ----------
    doc.setFillColor(...PDF.ink); doc.rect(0, 0, W, 46, 'F');
    for (let i = 0; i < 26; i++) { doc.setFillColor(252, 82 + i * 2, i * 3); doc.rect(W - 70 + i * 2.7, 0, 2.8, 46, 'F'); }
    doc.setFillColor(...PDF.brand); doc.rect(0, 46, W, 1.2, 'F');
    font('bold', 7, [251, 146, 60]); doc.text('TRAINING PARTNER · PERFORMANCE REPORT', M, 13);
    font('bold', 22, [255, 255, 255]); doc.text(`${TF_LABEL[reportTimeframe]}${reportSport === 'all' ? '' : ` · ${SPORTS[reportSport].plural}`}`, M, 25);
    font('normal', 9, [203, 213, 225]); doc.text(`${formatNiceDate(startDate, false)} – ${formatNiceDate(endDate, false)}  ·  ${rides.length} sessions  ·  ${formatHours(cur.sec)}`, M, 32);
    font('normal', 7.5, [148, 163, 184]);
    doc.text(txt(`${ATHLETE.name}${ATHLETE.height ? ` · ${ATHLETE.height} cm` : ''}${wt ? ` · ${wt} kg` : ''} · ${ATHLETE.bike} · max HR ${PHYSIO.max_hr}`), M, 39);
    font('bold', 7.5, [255, 255, 255]); doc.text(`Issued ${formatLocalDate(new Date())}`, W - M, 13, { align: 'right' });
    y = 56;

    // ---------- Headline (first sentences of the AI review) ----------
    if (cached) {
      const plain = txt(cached.analysis_text).replace(/\s+/g, ' ').trim();
      const head = (plain.match(/^(.{40,260}?[.!?])(\s|$)/) || [null, plain.slice(0, 220)])[1];
      const lines = doc.splitTextToSize(head, CW - 14);
      const bh = 8 + lines.length * 4.6;
      doc.setFillColor(255, 247, 237); doc.setDrawColor(254, 215, 170); doc.roundedRect(M, y, CW, bh, 2.5, 2.5, 'FD');
      doc.setFillColor(...PDF.brand); doc.roundedRect(M, y, 2.2, bh, 1, 1, 'F');
      font('bold', 6.5, PDF.brand); doc.text('COACH VERDICT', M + 6, y + 5);
      font('bold', 9.5, PDF.ink); doc.text(lines, M + 6, y + 10);
      y += bh + 6;
    }

    // ---------- KPI tiles ----------
    const kpis = [
      { l: 'Sessions', v: String(cur.count), d: pri ? cur.count - pri.count : null, dp: 0, c: PDF.ink },
      { l: 'Training time', v: formatHours(cur.sec), d: pri ? (cur.sec - pri.sec) / 3600 : null, dp: 1, u: ' h', c: PDF.blue },
      { l: 'Training load', v: `${Math.round(cur.trimp)} TRIMP`, d: pri ? cur.trimp - pri.trimp : null, dp: 0, c: PDF.pink },
      { l: 'Fitness (CTL)', v: lEnd ? String(Math.round(lEnd.ctl)) : '--', s: lEnd ? `ramp ${signed(lEnd.ramp, 1)}/wk` : '', c: PDF.blue },
      { l: 'Form (TSB)', v: lEnd ? signed(lEnd.tsb, 0) : '--', s: lEnd ? formStatus(lEnd.tsb).label : '', c: lEnd && lEnd.tsb < -30 ? PDF.red : PDF.green },
      { l: 'Weighted HR', v: cur.hr ? `${Math.round(cur.hr)} bpm` : '--', d: pri && pri.hr && cur.hr ? cur.hr - pri.hr : null, dp: 0, u: ' bpm', lower: true, c: PDF.red }
    ];
    const tw = (CW - 3 * 2) / 3, th = 19;
    kpis.forEach((k, i) => {
      const x = M + (i % 3) * (tw + 3), ty = y + Math.floor(i / 3) * (th + 3);
      doc.setFillColor(...PDF.soft); doc.setDrawColor(...PDF.line); doc.roundedRect(x, ty, tw, th, 2.5, 2.5, 'FD');
      doc.setFillColor(...k.c); doc.circle(x + 5, ty + 5.2, 1.3, 'F');
      font('bold', 6.3, PDF.sub); doc.text(k.l.toUpperCase(), x + 8, ty + 6);
      font('bold', 13, PDF.ink); doc.text(txt(k.v), x + 4, ty + 13.5);
      if (k.d !== null && k.d !== undefined && Number.isFinite(k.d)) {
        const good = k.d === 0 ? null : (k.d > 0) !== !!k.lower;
        font('bold', 6.8, good === null ? PDF.sub : good ? PDF.green : PDF.red);
        doc.text(`${k.d > 0 ? '+' : ''}${fmtNum(k.d, k.dp)}${k.u || ''} vs prev`, x + 4, ty + 17.3);
      } else if (k.s) { font('normal', 6.8, PDF.sub); doc.text(txt(k.s).slice(0, 34), x + 4, ty + 17.3); }
    });
    y += th * 2 + 3 + 8;

    // ---------- Per-sport breakdown ----------
    sectionTitle('Each sport', 'Breakdown');
    const sp = Object.keys(SPORTS).filter(s => cur.bySport[s]);
    const totSec = cur.sec || 1;
    sp.forEach(s => {
      ensure(11);
      const e = cur.bySport[s];
      const a = aggregateRides(rides.filter(w => sportOf(w) === s));
      const probe = { sport: s };
      const col = hexRgb(SPORTS[s].color);
      doc.setFillColor(...col); doc.roundedRect(M, y - 3.6, 3, 8, 1, 1, 'F');
      font('bold', 9, PDF.ink); doc.text(SPORTS[s].plural, M + 6, y + 1.5);
      font('normal', 8, PDF.sub);
      const dist = s === 'swim' ? `${Math.round(e.dist * 1000)} m` : `${fmtNum(e.dist, 1)} km`;
      doc.text(txt(`${e.count} × · ${formatHours(e.sec)}${s === 'other' && !(e.dist > 0) ? '' : ` · ${dist}`}${s !== 'other' && a.speed ? ` · ${speedText(probe, a.speed)}` : ''}${a.hr ? ` · ${Math.round(a.hr)} bpm` : ''}`), M + 36, y + 1.5);
      const bx = M + CW - 40, bw = 40;
      doc.setFillColor(241, 245, 249); doc.roundedRect(bx, y - 1.2, bw, 3.2, 1.4, 1.4, 'F');
      doc.setFillColor(...col); doc.roundedRect(bx, y - 1.2, Math.max(1.5, bw * e.sec / totSec), 3.2, 1.4, 1.4, 'F');
      font('bold', 6.5, PDF.sub); doc.text(`${Math.round((e.sec / totSec) * 100)}% of time`, bx, y - 2.6);
      y += 10;
    });
    y += 2;

    // ---------- Charts ----------
    setBusy(btn, true, 'Drawing charts…');
    const from = formatLocalDate(addDays(parseSafeDate(startDate), -Math.max(14, Math.round((parseSafeDate(endDate) - parseSafeDate(startDate)) / 86400000) * 0.5)));
    if (series) {
      const i0 = Math.max(0, series.dates.findIndex(d => d >= from));
      const x = series.dates.slice(i0);
      const img = await chartPng([
        { x, y: series.tsb.slice(i0), type: 'bar', name: 'Form', marker: { color: series.tsb.slice(i0).map(v => (v >= 0 ? 'rgba(22,163,74,0.45)' : 'rgba(239,68,68,0.35)')) } },
        { x, y: series.ctl.slice(i0), type: 'scatter', mode: 'lines', name: 'Fitness', line: { color: '#2563eb', width: 3.5, shape: 'spline' } },
        { x, y: series.atl.slice(i0), type: 'scatter', mode: 'lines', name: 'Fatigue', line: { color: '#db2777', width: 2.2, shape: 'spline' } }
      ], { bargap: 0.15, xaxis: { type: 'date', tickformat: '%d %b', showgrid: false } });
      if (img) { sectionTitle('Fitness, fatigue & form', 'Training load'); ensure(72); doc.addImage(img, 'JPEG', M, y, CW, CW * 0.4); y += CW * 0.4 + 6; }
    }
    // Weekly time by sport (stacked)
    const weeks = weeklyTotals(rides.length > 3 ? all.filter(w => String(w.date) >= from) : rides);
    if (weeks.length > 1) {
      const traces = Object.keys(SPORTS).filter(s => weeks.some(wk => wk.sports[s])).map(s => ({
        x: weeks.map(wk => wk.week), y: weeks.map(wk => round(((wk.sports[s] || {}).sec || 0) / 3600, 1)), type: 'bar', name: SPORTS[s].plural, marker: { color: SPORTS[s].color }
      }));
      const img = await chartPng(traces, { barmode: 'stack', bargap: 0.3, yaxis: { title: { text: 'hours', font: { size: 12 } }, gridcolor: '#eef2f7' }, xaxis: { type: 'date', tickformat: '%d %b', showgrid: false } }, 900, 320);
      if (img) { sectionTitle('Weekly training time by sport', 'Volume'); ensure(66); doc.addImage(img, 'JPEG', M, y, CW, CW * 0.356); y += CW * 0.356 + 6; }
    }

    // ---------- Intensity ----------
    const zTot = z.reduce((a, b) => a + b, 0);
    if (zTot) {
      sectionTitle('Where the time went', 'Intensity');
      ensure(48);
      const donut = await chartPng([{ type: 'pie', hole: 0.62, values: z.map(v => Math.round(v / 60)), labels: PHYSIO.zones.map(zz => `${zz.key} ${zz.name}`), marker: { colors: PHYSIO.zones.map(zz => zz.color) }, textinfo: 'none', sort: false }],
        { showlegend: false, margin: { l: 0, r: 0, t: 0, b: 0 }, annotations: [{ text: `<b>${Math.round(split.low * 100)}%</b><br>easy`, showarrow: false, font: { size: 28, color: '#0f172a' } }] }, 420, 420);
      if (donut) doc.addImage(donut, 'JPEG', M, y, 42, 42);
      let zy = y + 4;
      const bx = M + 50, bw = CW - 50 - 34;
      PHYSIO.zones.forEach((zz, i) => {
        const pct = z[i] / zTot;
        font('bold', 7.5, PDF.ink); doc.text(`${zz.key} ${zz.name}`, bx, zy + 2.6);
        doc.setFillColor(241, 245, 249); doc.roundedRect(bx + 30, zy, bw - 30, 3.6, 1.6, 1.6, 'F');
        doc.setFillColor(...hexRgb(zz.color)); doc.roundedRect(bx + 30, zy, Math.max(1.2, (bw - 30) * pct), 3.6, 1.6, 1.6, 'F');
        font('normal', 7, PDF.sub); doc.text(`${formatHours(z[i])} · ${Math.round(pct * 100)}%`, bx + bw + 2, zy + 2.8);
        zy += 7.2;
      });
      font('normal', 7, PDF.sub);
      doc.text(txt(`Low ${Math.round(split.low * 100)}% · middle ${Math.round(split.mid * 100)}% · high ${Math.round(split.high * 100)}%${split.pi ? ` · polarization index ${split.pi.toFixed(2)} (>2 = polarized)` : ''}`), bx, zy + 2);
      y += 48;
    }

    // ---------- Wellness & best efforts ----------
    const wsnap = await wellnessSnapshot(endDate);
    const bests = bestEffortsText(rides).split('\n').slice(1).filter(Boolean);
    if (wsnap || bests.length) {
      sectionTitle('Recovery & best efforts', 'Body');
      const colW = (CW - 6) / 2;
      const yStart = y;
      if (wsnap) {
        const rows = [['Sleep (7-night avg)', fmtSleep(wsnap.sleep7)], ['Resting HR', wsnap.rhr ? `${wsnap.rhr} bpm${wsnap.rhrBase ? ` (base ${Math.round(wsnap.rhrBase)})` : ''}` : '--'], ['HRV', wsnap.hrv ? `${wsnap.hrv} ms${wsnap.hrvBase ? ` (base ${Math.round(wsnap.hrvBase)})` : ''}` : '--'], ['VO2max (watch)', wsnap.vo2max ? String(wsnap.vo2max.value) : '--']];
        doc.setFillColor(...PDF.soft); doc.roundedRect(M, y, colW, 6 + rows.length * 6, 2, 2, 'F');
        rows.forEach(([k, v], i) => { font('normal', 7.5, PDF.sub); doc.text(k, M + 4, y + 6 + i * 6); font('bold', 7.5, PDF.ink); doc.text(txt(v), M + colW - 4, y + 6 + i * 6, { align: 'right' }); });
      }
      let by = yStart;
      const bx = wsnap ? M + colW + 6 : M, bwid = wsnap ? colW : CW;
      for (const b of bests.slice(0, 7)) {
        const [name, rest] = b.split(': ');
        font('bold', 7, PDF.ink); doc.text(txt(name), bx, by + 5);
        font('normal', 6.6, PDF.sub);
        const ls = doc.splitTextToSize(txt(rest || ''), bwid - 2);
        doc.text(ls.slice(0, 2), bx, by + 8.5);
        by += 5 + Math.min(2, ls.length) * 3.4;
      }
      y = Math.max(y + (wsnap ? 32 : 0), by) + 6;
    }

    const table = (head, body, opts = {}) => {
      ensure(20);
      doc.autoTable(Object.assign({
        head: [head], body, startY: y, theme: 'plain', margin: { left: M, right: M },
        headStyles: { fillColor: PDF.ink, textColor: [255, 255, 255], fontSize: 6.8, fontStyle: 'bold', cellPadding: 1.8 },
        bodyStyles: { fontSize: 6.8, cellPadding: 1.7, textColor: PDF.ink }, alternateRowStyles: { fillColor: PDF.soft }
      }, opts));
      y = doc.lastAutoTable.finalY + 8;
    };

    // ---------- Week by week ----------
    {
      const wk = weeklyTotals(rides);
      if (wk.length) {
        sectionTitle('Week by week', 'Consistency');
        const rowsW = [];
        for (const e of wk) {
          const end = formatLocalDate(addDays(parseSafeDate(e.week), 6));
          const l = loadAt(series, end > formatLocalDate(new Date()) ? formatLocalDate(new Date()) : end);
          const g = await getWeeklyGoals(e.week);
          const sp = k => e.sports[k] || { count: 0, dist: 0, sec: 0 };
          rowsW.push([formatNiceDate(e.week, false), `${e.count} (${Object.keys(SPORTS).filter(k => e.sports[k]).map(k => `${SPORTS[k].code[0]}${e.sports[k].count}`).join(' ')})`, formatHours(e.sec),
            sp('ride').dist ? fmtNum(sp('ride').dist, 0) : '-', sp('run').dist ? fmtNum(sp('run').dist, 1) : '-', sp('swim').dist ? String(Math.round(sp('swim').dist * 1000)) : '-',
            String(Math.round(e.trimp)), l ? `${Math.round(l.ctl)} / ${signed(l.tsb, 0)}` : '-', g.hours ? `${fmtNum(e.sec / 3600, 1)}/${g.hours} h` : g.km ? `${fmtNum(sp('ride').dist, 0)}/${g.km} km` : '-']);
        }
        table(['Week of', 'Sessions', 'Time', 'Ride km', 'Run km', 'Swim m', 'TRIMP', 'Fitness / Form', 'vs target'], rowsW);
      }
    }

    // ---------- Each sport in depth ----------
    for (const s of Object.keys(SPORTS).filter(k => cur.bySport[k])) {
      const list = rides.filter(w => sportOf(w) === s);
      const probe = { sport: s };
      const a = aggregateRides(list);
      const pa = prior.length ? aggregateRides(prior.filter(w => sportOf(w) === s)) : null;
      doc.addPage(); y = 18;
      sectionTitle(`${SPORTS[s].plural} in depth`, 'Sport');
      font('normal', 8, PDF.sub);
      const line = [`${a.count} sessions`, formatHours(a.sec), s === 'swim' ? `${Math.round(a.dist * 1000)} m` : s === 'other' ? '' : `${fmtNum(a.dist, 1)} km`,
        s !== 'other' && a.speed ? `avg ${speedText(probe, a.speed)}` : '', a.hr ? `${Math.round(a.hr)} bpm` : '', `${Math.round(a.trimp)} TRIMP`,
        s === 'ride' || s === 'run' ? `${Math.round(a.asc)} m climbing` : '', pa && pa.count ? `previous period: ${pa.count} sessions, ${formatHours(pa.sec)}` : ''].filter(Boolean).join('  ·  ');
      doc.text(doc.splitTextToSize(txt(line), CW), M, y); y += 8;
      // Speed / pace and HR per session → is the same effort getting cheaper?
      const pts = list.filter(w => mv(w, 'avg_hr') > 0);
      if (pts.length >= 2) {
        const tr = [];
        if (s !== 'other' && pts.some(w => mv(w, 'avg_speed_kmh') > 0)) tr.push({ x: pts.map(w => String(w.date).slice(0, 10)), y: pts.map(w => mv(w, 'avg_speed_kmh') || null), name: 'Speed (km/h)', type: 'scatter', mode: 'lines+markers', line: { color: SPORTS[s].color, width: 3 }, marker: { size: 8 } });
        tr.push({ x: pts.map(w => String(w.date).slice(0, 10)), y: pts.map(w => w.avg_hr), name: 'Avg HR (bpm)', yaxis: 'y2', type: 'scatter', mode: 'lines+markers', line: { color: '#ef4444', width: 2, dash: 'dot' }, marker: { size: 7 } });
        const img = await chartPng(tr, { xaxis: { type: 'date', tickformat: '%d %b', showgrid: false }, yaxis: { title: { text: tr.length > 1 ? 'km/h' : 'bpm', font: { size: 12 } }, gridcolor: '#eef2f7' }, yaxis2: { overlaying: 'y', side: 'right', showgrid: false, title: { text: 'bpm', font: { size: 12 } } } }, 900, 300);
        if (img) { ensure(60); doc.addImage(img, 'JPEG', M, y, CW, CW / 3); y += CW / 3 + 4; }
      }
      // Zone split for this sport
      const zs = sumZones(list), zt = zs.reduce((p, q) => p + q, 0);
      if (zt) {
        font('bold', 7.5, PDF.ink); doc.text('Heart-rate zones', M, y); y += 3;
        let x = M;
        zs.forEach((v, i) => { const wdt = CW * v / zt; if (wdt > 0) { doc.setFillColor(...hexRgb(PHYSIO.zones[i].color)); doc.rect(x, y, wdt, 5, 'F'); if (wdt > 12) { font('bold', 6, [255, 255, 255]); doc.text(`${PHYSIO.zones[i].key} ${Math.round(v / zt * 100)}%`, x + 1.5, y + 3.6); } x += wdt; } });
        y += 11;
      }
      // Top sessions
      const top = list.slice().sort((p, q) => num(mv(q, 'trimp')) - num(mv(p, 'trimp'))).slice(0, 8);
      table(['Session', 'Date', s === 'other' ? 'Type' : 'Distance', 'Time', s === 'other' ? 'kcal' : speedName(probe), 'HR avg/max', 'Load', 'Intent / notes'],
        top.map(w => [rideCode(w), formatNiceDate(w.date, false), s === 'other' ? txt(w.name || '') : hasVal(mv(w, 'distance_km')) ? distText(w) : 'flagged', rideDuration(w),
          s === 'other' ? String(w.calories || '-') : hasVal(mv(w, 'avg_speed_kmh')) ? txt(speedText(w)) : '-', mv(w, 'avg_hr') ? `${w.avg_hr}/${w.max_hr || '-'}` : '-',
          hasVal(mv(w, 'trimp')) ? String(Math.round(w.trimp)) : '-', txt([getCleanIntentLabel(w), w.rpe ? `RPE ${w.rpe}` : '', w.note || ''].filter(Boolean).join(' · ')).slice(0, 60)]),
        { columnStyles: { 0: { fontStyle: 'bold' }, 7: { textColor: PDF.sub } } });
    }

    // ---------- Highlights, records, plan, recovery, data quality ----------
    doc.addPage(); y = 18;
    sectionTitle('Highlights of the period', 'Highlights');
    {
      const inPeriod = new Set(rides.map(w => w.id));
      const allW = await db.workouts.toArray();
      const hl = [];
      for (const s of Object.keys(SPORTS)) for (const r of computeRecords(allW, s)) if (r.ride && inPeriod.has(r.ride.id)) hl.push([`${SPORTS[s].label} · all-time ${r.label.toLowerCase()}`, `${r.value} — ${rideCode(r.ride)}, ${formatNiceDate(r.ride.date, false)}`]);
      const best = (fn, label, fmt) => { const ok = rides.filter(w => num(fn(w)) > 0); if (!ok.length) return; const w = ok.reduce((p, q) => (num(fn(q)) > num(fn(p)) ? q : p)); hl.push([label, `${fmt(w)} — ${rideCode(w)}, ${formatNiceDate(w.date, false)}`]); };
      best(w => mv(w, 'trimp'), 'Hardest session', w => `${Math.round(w.trimp)} TRIMP`);
      best(w => w.moving_sec, 'Longest session', w => rideDuration(w));
      best(w => (sportOf(w) === 'ride' && w.moving_sec >= 1200 && mv(w, 'avg_hr') > 0 && mv(w, 'avg_speed_kmh') > 0 ? (w.avg_speed_kmh / w.avg_hr) * 100 : 0), 'Most efficient ride', w => `${fmtNum((w.avg_speed_kmh / w.avg_hr) * 100, 1)} km/h per 100 bpm`);
      best(w => (w.rpe ? 11 - w.rpe : 0) * (w.moving_sec > 1800 ? 1 : 0), 'Easiest-feeling long session', w => `RPE ${w.rpe}`);
      if (hl.length) table(['', ''], hl.map(r => r.map(txt)), { showHead: 'never', columnStyles: { 0: { fontStyle: 'bold', cellWidth: 62 } } });
      else { font('normal', 8, PDF.sub); doc.text('No records in this period.', M, y); y += 8; }
    }

    {
      const days = Math.min(60, Math.max(7, Math.round((parseSafeDate(endDate) - parseSafeDate(startDate)) / 86400000) + 1));
      const adh = await planAdherence(days);
      sectionTitle('Plan & targets', 'Plan');
      if (adh.length) {
        const done = adh.filter(x => x.done).length;
        font('bold', 10, done / adh.length >= 0.8 ? PDF.green : done / adh.length >= 0.5 ? PDF.ink : PDF.red);
        doc.text(`${done} of ${adh.length} planned sessions done (${Math.round((done / adh.length) * 100)}%) in the last ${days} days`, M, y); y += 6;
        const missed = adh.filter(x => !x.done);
        if (missed.length) { font('normal', 7.5, PDF.sub); doc.text(doc.splitTextToSize(txt(`Missed: ${missed.map(x => `${formatNiceDate(x.date, false)} ${x.title}`).join(', ')}`), CW), M, y); y += 4 + Math.ceil(missed.length / 4) * 3.5; }
      } else { font('normal', 8, PDF.sub); doc.text('No planned sessions in this period — set up your weekly template in Coach.', M, y); y += 7; }
      y += 3;
    }

    {
      const wl = await getWellness();
      const keys = Object.keys(wl.days).filter(k => k >= startDate && k <= endDate).sort().slice(-21);
      const weights = (await getWeightHistory()).filter(x => x.date >= formatLocalDate(addDays(parseSafeDate(startDate), -30)) && x.date <= endDate);
      if (keys.length || weights.length) {
        sectionTitle('Recovery log', 'Galaxy Watch');
        if (keys.length) table(['Date', 'Sleep', 'Deep', 'REM', 'Resting HR', 'HRV', 'Steps', 'Weight'], keys.map(k => { const d = wl.days[k]; return [formatNiceDate(k, false), d.sleep_min ? fmtSleep(d.sleep_min) : '-', d.deep_min ? `${d.deep_min}m` : '-', d.rem_min ? `${d.rem_min}m` : '-', d.rhr ? `${d.rhr}${d.rhr_src === 'hr' ? '*' : ''}` : '-', d.hrv || '-', d.steps || '-', d.weight || '-']; }));
        if (weights.length >= 2) { font('normal', 7.5, PDF.sub); doc.text(txt(`Weight: ${weights[0].weight} kg (${formatNiceDate(weights[0].date, false)}) → ${weights[weights.length - 1].weight} kg (${formatNiceDate(weights[weights.length - 1].date, false)}), ${signed(weights[weights.length - 1].weight - weights[0].weight, 1)} kg`), M, y - 3); y += 4; }
        font('normal', 6.5, PDF.sub); doc.text('* resting HR estimated from the lowest hourly heart rate (Samsung Health does not share a resting value).', M, y - 3); y += 3;
      }
    }

    {
      const flagged = rides.filter(w => flagNotes(w).length);
      const mem = await getCoachMemory();
      if (flagged.length || mem.length) {
        sectionTitle('Data quality & coach memory', 'Context');
        if (flagged.length) table(['Session', 'What was excluded'], flagged.map(w => [rideCode(w), txt(flagNotes(w).join('; '))]), { columnStyles: { 0: { fontStyle: 'bold', cellWidth: 30 } } });
        if (mem.length) { ensure(10); font('normal', 7.5, PDF.ink); for (const m of mem.slice(-12)) { const ls = doc.splitTextToSize(txt(`• ${m.text}`), CW); ensure(ls.length * 3.6); doc.text(ls, M, y); y += ls.length * 3.6 + 0.6; } y += 4; }
      }
    }

    // ---------- AI review ----------
    if (cached) {
      doc.addPage(); y = 18;
      sectionTitle('Coach review', aiMetaLabel(cached) ? `Written by ${aiMetaLabel(cached)}` : 'AI review');
      for (let line of txt(cached.analysis_text).split('\n')) {
        line = line.trim();
        if (!line) { y += 2; continue; }
        const num1 = line.match(/^(\d)[.)]\s+(.{3,90})$/);
        const bullet = /^[-•*]\s+/.test(line);
        if (num1 && !/[.!?]$/.test(num1[2])) {
          ensure(14); y += 3;
          doc.setFillColor(...PDF.brand); doc.circle(M + 3, y - 1.3, 3, 'F');
          font('bold', 7.5, [255, 255, 255]); doc.text(num1[1], M + 3, y, { align: 'center' });
          font('bold', 10, PDF.ink); doc.text(num1[2], M + 9, y);
          y += 6;
          continue;
        }
        const body = bullet ? line.replace(/^[-•*]\s+/, '') : line;
        const ls = doc.splitTextToSize(body, CW - (bullet ? 8 : 2));
        for (let i = 0; i < ls.length; i++) {
          ensure(5);
          if (bullet && i === 0) { doc.setFillColor(...PDF.brand); doc.circle(M + 3, y - 1.1, 0.8, 'F'); }
          font('normal', 8.4, [30, 41, 59]); doc.text(ls[i], M + (bullet ? 7 : 1), y);
          y += 4.1;
        }
        y += 0.8;
      }
    }

    // ---------- Session ledger ----------
    doc.addPage(); y = 18;
    sectionTitle('Every session', 'Ledger');
    doc.autoTable({
      head: [['', 'Session', 'Date', 'Distance', 'Time', 'Pace / speed', 'HR', 'Load', 'Notes']],
      body: rides.map(w => ['', rideCode(w), String(w.date).slice(0, 16), hasVal(mv(w, 'distance_km')) ? distText(w) : 'flagged', rideDuration(w),
        hasVal(mv(w, 'avg_speed_kmh')) ? txt(speedText(w)) : '--', mv(w, 'avg_hr') ? `${w.avg_hr}` : '--', hasVal(mv(w, 'trimp')) ? `${Math.round(w.trimp)}` : '--',
        txt([getCleanIntentLabel(w), ...flagNotes(w)].filter(Boolean).join(' · ')).slice(0, 46)]),
      startY: y,
      theme: 'plain',
      margin: { left: M, right: M },
      headStyles: { fillColor: PDF.ink, textColor: [255, 255, 255], fontSize: 6.8, fontStyle: 'bold', cellPadding: 2 },
      bodyStyles: { fontSize: 6.8, cellPadding: 1.9, textColor: PDF.ink },
      alternateRowStyles: { fillColor: PDF.soft },
      columnStyles: { 0: { cellWidth: 2.2 }, 1: { fontStyle: 'bold' }, 8: { textColor: PDF.sub } },
      didDrawCell: d => {
        if (d.section === 'body' && d.column.index === 0) {
          doc.setFillColor(...hexRgb(sportMeta(rides[d.row.index]).color));
          doc.rect(d.cell.x, d.cell.y, 1.6, d.cell.height, 'F');
        }
      }
    });

    // ---------- Footer ----------
    const pages = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i);
      doc.setDrawColor(...PDF.line); doc.line(M, H - 11, W - M, H - 11);
      font('normal', 6.5, [148, 163, 184]);
      doc.text(`Training Partner v${APP_VERSION} · ${ATHLETE.name} · ${TF_LABEL[reportTimeframe]}`, M, H - 6.5);
      doc.text(`${i} / ${pages}`, W - M, H - 6.5, { align: 'right' });
    }

    const safeName = String(ATHLETE.name || 'Athlete').replace(/[^A-Za-z0-9_-]+/g, '_');
    const fileName = `${safeName}_${reportSport === 'all' ? 'Training' : SPORTS[reportSport].plural.replace(/\W+/g, '')}_Report_${startDate}_to_${endDate}.pdf`;
    const res = await saveOrShareFile(fileName, doc.output('datauristring').split(',')[1], { base64: true, mime: 'application/pdf', title: 'Training Partner report' });
    if (res.ok) {
      status.textContent = `✓ ${fileName} → ${res.where}`;
      toast('PDF exported', 'success');
      haptic('success');
    } else if (!res.cancelled) {
      status.textContent = 'Export failed.';
    }
  } catch (err) {
    console.error(err);
    status.textContent = `Export failed: ${err.message}`;
    toast(`PDF failed: ${err.message}`, 'error');
  } finally {
    setBusy(btn, false);
  }
}
