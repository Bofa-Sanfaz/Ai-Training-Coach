'use strict';
// --------------------------------------------------------
// REPORTS: period KPIs, zone strain, records, AI review, PDF
// --------------------------------------------------------
let reportTimeframe = '7d';
let reportAiBusy = false;

const TF_DAYS = { '7d': 7, '30d': 30, '365d': 365 };

function setupReportControls() {
  $$('#reportSeg button').forEach(b => b.addEventListener('click', () => {
    reportTimeframe = b.dataset.tf;
    $$('#reportSeg button').forEach(x => x.classList.toggle('active', x === b));
    renderReports();
  }));
}

// Half-open windows [start, end) so a ride is never counted in two periods
async function getScopedWorkouts(periodsBack = 0) {
  const all = await db.workouts.orderBy('date').toArray();
  if (reportTimeframe === 'all') return periodsBack === 0 ? all : [];
  const days = TF_DAYS[reportTimeframe];
  const now = Date.now() + 1;
  const end = now - periodsBack * days * 86400000;
  const start = end - days * 86400000;
  return all.filter(w => { const t = parseSafeDate(w.date).getTime(); return t >= start && t < end; });
}

function reportCacheId() {
  return `tf_${reportTimeframe}`;
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

function efficiencyFactor(rides) {
  const ok = rides.filter(w => w.avg_power_w > 0 && w.avg_hr > 0);
  if (!ok.length) return null;
  return sumBy(ok, w => w.avg_power_w / w.avg_hr) / ok.length;
}

async function renderReports() {
  const all = await db.workouts.orderBy('date').toArray();
  const rides = await getScopedWorkouts(0);
  const prior = await getScopedWorkouts(1);
  const header = $('#reportScopeDateHeader');

  // Records (all-time)
  const recs = computeRecords(all);
  $('#recordGrid').innerHTML = recs.length
    ? recs.map(r => `<div class="record" ${r.ride ? `onclick="openRide(${r.ride.id})"` : ''}>
        <div class="l">${icon(r.icon)}${escapeHtml(r.label)}</div>
        <div class="v">${escapeHtml(r.value)}</div>
        <div class="s">${r.ride ? escapeHtml(formatNiceDate(r.ride.date, false)) : escapeHtml(r.sub || '')}</div>
      </div>`).join('')
    : '<div class="small muted">Records appear after your first ride.</div>';

  const box = $('#reportSummaryBox');
  if (!rides.length) {
    header.textContent = 'No rides in this period';
    $('#labDiagnosticGrid').innerHTML = `<div class="small lab-muted" style="grid-column:1/-1">No data for this timeframe.</div>`;
    $('#reportZoneBars').innerHTML = '';
    box.innerHTML = '';
    return;
  }
  const startDate = String(rides[0].date).split(' ')[0];
  const endDate = String(rides[rides.length - 1].date).split(' ')[0];
  header.textContent = `${formatNiceDate(startDate, false)} – ${formatNiceDate(endDate, false)} · ${rides.length} ride${rides.length > 1 ? 's' : ''}`;

  const cur = aggregateRides(rides);
  const pri = prior.length ? aggregateRides(prior) : null;
  const z = sumZones(rides);
  const zTot = z.reduce((a, b) => a + b, 0);
  const drifts = rides.map(w => w.cardiac_drift_bpm).filter(hasVal);
  const meanDrift = drifts.length ? mean(drifts) : null;
  const ef = efficiencyFactor(rides);
  const domIdx = zTot ? z.indexOf(safeMax(z)) : -1;
  const vsPrior = (a, b, d, unit) => (pri ? `<div class="tiny lab-muted">${signed(a - b, d, unit)} vs prior</div>` : '');

  $('#labDiagnosticGrid').innerHTML = `
    <div class="lab-item"><div class="l">Volume</div><div class="v" style="color:var(--lab-accent)">${fmtNum(cur.dist, 1)} km · ${formatHours(cur.sec)}</div>${pri ? vsPrior(cur.dist, pri.dist, 1, ' km') : ''}</div>
    <div class="lab-item"><div class="l">Training load</div><div class="v" style="color:var(--lab-pink)">${Math.round(cur.trimp)} TRIMP</div>${pri ? vsPrior(cur.trimp, pri.trimp, 0, '') : ''}</div>
    <div class="lab-item"><div class="l">Weighted speed / HR</div><div class="v">${fmtNum(cur.speed, 1)} km/h · ${cur.hr ? Math.round(cur.hr) : '--'} bpm</div>${pri ? vsPrior(cur.speed, pri.speed, 1, ' km/h') : ''}</div>
    <div class="lab-item"><div class="l">Mean drift (steady rides)</div><div class="v ${meanDrift === null ? '' : meanDrift <= 3 ? 'pos' : 'neg'}">${meanDrift === null ? '--' : signed(meanDrift, 1, ' bpm')}</div></div>
    <div class="lab-item"><div class="l">Efficiency (W/bpm)</div><div class="v" style="color:var(--lab-accent)">${ef ? ef.toFixed(2) : '--'}</div><div class="tiny lab-muted">Estimated power unless power meter</div></div>
    <div class="lab-item"><div class="l">Dominant zone</div><div class="v" style="color:${domIdx >= 0 ? PHYSIO.zones[domIdx].color : 'inherit'}">${domIdx >= 0 ? `${PHYSIO.zones[domIdx].key} ${escapeHtml(PHYSIO.zones[domIdx].name)}` : '--'}</div></div>`;

  $('#reportZoneBars').innerHTML = PHYSIO.zones.map((zz, i) => {
    const pct = zTot ? Math.round((z[i] / zTot) * 100) : 0;
    return `<div class="zone-row"><span class="zone-tag">${zz.key} ${escapeHtml(zz.name)}</span>
      <div class="zone-bar"><div class="zone-fill" data-w="${pct}" style="background:${zz.color}"></div></div>
      <span class="zone-val">${formatHours(z[i])} · ${pct}%</span></div>`;
  }).join('');
  requestAnimationFrame(() => $$('#reportZoneBars .zone-fill').forEach(el => { el.style.width = `${el.dataset.w}%`; }));

  if (!reportAiBusy) {
    const cached = await getCachedReport(rides);
    box.innerHTML = cached ? bubbleHtml({ role: 'coach', message: cached.analysis_text, created_at: cached.created_at }, `Review · ${reportTimeframe.toUpperCase()}`) : '';
  }
}

async function generateExecutiveReport() {
  if (reportAiBusy) return;
  const rides = await getScopedWorkouts(0);
  if (!rides.length) { toast('No rides in the selected timeframe.', 'warn'); return; }
  const prior = await getScopedWorkouts(1);
  const tf = reportTimeframe;
  const startDate = String(rides[0].date).split(' ')[0];
  const endDate = String(rides[rides.length - 1].date).split(' ')[0];

  reportAiBusy = true;
  const btn = $('#btnReport');
  setBusy(btn, true, 'Synthesizing review…');
  $('#reportSummaryBox').innerHTML = typingHtml('Writing your longitudinal review');
  try {
    const report = await callGemini(await buildReportPrompt(rides, prior, startDate, endDate, tf), null);
    if (report) {
      await db.reports.put({ id: `tf_${tf}`, ref_code: `REPORT_${tf}`, created_at: new Date().toISOString(), timeframe: tf, analysis_text: report, ride_count: rides.length, date_range: scopeKey(rides) });
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
// PDF EXPORT
// --------------------------------------------------------
async function triggerOfficialPdfDownload() {
  const status = $('#pdfStatus');
  const rides = await getScopedWorkouts(0);
  if (!rides.length) { toast('No rides in this timeframe.', 'warn'); return; }
  const cached = await getCachedReport(rides);
  if (!cached) {
    const go = await uiConfirm('No up-to-date review', `The PDF includes the AI review for ${reportTimeframe.toUpperCase()}. Export without it, or generate the review first?`, { okText: 'Export without review', cancelText: 'Cancel' });
    if (!go) return;
  }
  if (!window.jspdf) { toast('PDF engine failed to load.', 'error'); return; }

  const btn = $('#btnPdf');
  setBusy(btn, true, 'Building PDF…');
  status.textContent = '';
  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ format: 'a4', unit: 'mm' });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const M = 14;
    const CW = pageW - M * 2;
    const startDate = String(rides[0].date).split(' ')[0];
    const endDate = String(rides[rides.length - 1].date).split(' ')[0];
    const wt = await getLatestWeight();
    const agg = aggregateRides(rides);
    const z = sumZones(rides);
    const zTot = z.reduce((a, b) => a + b, 0);
    const ef = efficiencyFactor(rides);

    doc.setFillColor(15, 23, 42); doc.rect(0, 0, pageW, 28, 'F');
    doc.setFillColor(252, 82, 0); doc.rect(0, 0, pageW, 3.5, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.setTextColor(255, 255, 255);
    doc.text('RIDE PARTNER - PHYSIOLOGY REPORT', M, 14);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(148, 163, 184);
    doc.text(markdownToPlain(`ATHLETE: ${ATHLETE.name} (${ATHLETE.height ? ATHLETE.height + ' cm' : 'height n/a'} | ${wt ? wt + ' kg' : 'mass n/a'} | ${ATHLETE.bike})   PERIOD: ${startDate} to ${endDate} (${reportTimeframe.toUpperCase()})   ISSUED: ${formatLocalDate(new Date())}`), M, 21);

    let y = 35;
    const cards = [
      { label: 'PERIOD VOLUME', val: `${fmtNum(agg.dist, 1)} km / ${formatHours(agg.sec)}`, color: [15, 23, 42] },
      { label: 'TRAINING LOAD', val: `${Math.round(agg.trimp)} TRIMP`, color: [219, 39, 119] },
      { label: 'WEIGHTED MEAN HR', val: `${agg.hr ? Math.round(agg.hr) : '--'} bpm`, color: [22, 163, 74] },
      { label: 'EST. EFFICIENCY', val: ef ? `${ef.toFixed(2)} W/bpm` : '--', color: [37, 99, 235] }
    ];
    const cw = (CW - 9) / 4;
    cards.forEach((c, i) => {
      const cx = M + i * (cw + 3);
      doc.setFillColor(248, 250, 252); doc.setDrawColor(226, 232, 240); doc.roundedRect(cx, y, cw, 16, 2, 2, 'FD');
      doc.setFillColor(...c.color); doc.rect(cx, y, 2.5, 16, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(5.5); doc.setTextColor(100, 116, 139); doc.text(c.label, cx + 5, y + 5);
      doc.setFontSize(9); doc.setTextColor(15, 23, 42); doc.text(c.val, cx + 5, y + 12);
    });
    y += 24;

    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(15, 23, 42);
    doc.text(`MOVING TIME IN ZONE (MAX HR ${PHYSIO.max_hr} BPM)`, M, y);
    y += 4;
    const barW = CW - 85;
    PHYSIO.zones.forEach((zz, i) => {
      const pct = zTot ? z[i] / zTot : 0;
      const hex = zz.color.replace('#', '');
      const rgb = [0, 2, 4].map(o => parseInt(hex.substr(o, 2), 16));
      doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5); doc.setTextColor(71, 85, 105);
      doc.text(`${zz.key} ${zz.name} (${i === 0 ? '<' + PHYSIO.bounds[0] : zz.min + '-' + zz.max} bpm)`, M, y + 3);
      doc.setFillColor(241, 245, 249); doc.roundedRect(M + 60, y, barW, 4, 1.5, 1.5, 'F');
      doc.setFillColor(...rgb); doc.roundedRect(M + 60, y, Math.max(1, barW * pct), 4, 1.5, 1.5, 'F');
      doc.setFont('helvetica', 'bold'); doc.setTextColor(15, 23, 42);
      doc.text(`${Math.round(z[i] / 60)} min (${Math.round(pct * 100)}%)`, M + 63 + barW, y + 3);
      y += 5.5;
    });
    y += 4;
    doc.setFillColor(252, 82, 0); doc.rect(M, y, CW, 0.7, 'F');
    y += 6;

    if (cached) {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(15, 23, 42);
      doc.text('LONGITUDINAL PHYSIOLOGICAL ASSESSMENT', M, y);
      y += 5;
      for (let line of markdownToPlain(cached.analysis_text).split('\n')) {
        line = line.trim();
        if (!line) { y += 2.5; continue; }
        if (y > pageH - 22) { doc.addPage(); y = 20; }
        const isHeader = /^[1-9]\.\s+[A-Za-z][^.]{4,80}$/.test(line);
        doc.setFont('helvetica', isHeader ? 'bold' : 'normal');
        doc.setFontSize(isHeader ? 7.8 : 7.2);
        doc.setTextColor(...(isHeader ? [252, 82, 0] : [30, 41, 59]));
        if (isHeader) y += 2;
        for (const s of doc.splitTextToSize(line, CW - 4)) {
          if (y > pageH - 20) { doc.addPage(); y = 20; }
          doc.text(s, M + (isHeader ? 0 : 2), y);
          y += isHeader ? 3.8 : 3.4;
        }
      }
      y += 6;
    }

    if (y > pageH - 60) { doc.addPage(); y = 20; }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(15, 23, 42);
    doc.text('SESSION TELEMETRY LEDGER', M, y);
    doc.autoTable({
      head: [['Session', 'Date & start', 'Distance', 'Moving', 'Avg speed', 'Avg HR', 'Ascent', 'Load', 'Intent']],
      body: rides.map(w => [
        `Ride ${w.ride_number}`, String(w.date).slice(0, 16), `${fmtNum(w.distance_km, 1)} km`, rideDuration(w),
        `${fmtNum(w.avg_speed_kmh, 1)} km/h`, w.avg_hr ? `${w.avg_hr} bpm` : '--', `${Math.round(num(w.elevation_gain_m))} m`,
        hasVal(w.trimp) ? `${Math.round(w.trimp)}` : '--', markdownToPlain(getCleanIntentLabel(w)).slice(0, 34)
      ]),
      startY: y + 3,
      theme: 'grid',
      margin: { left: M, right: M },
      headStyles: { fillColor: [15, 23, 42], textColor: [255, 255, 255], fontSize: 6.6, fontStyle: 'bold', halign: 'center' },
      bodyStyles: { fontSize: 6.3, cellPadding: 1.6, textColor: [15, 23, 42], halign: 'center' },
      alternateRowStyles: { fillColor: [248, 250, 252] }
    });

    const pages = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i);
      doc.setDrawColor(226, 232, 240); doc.line(M, pageH - 12, pageW - M, pageH - 12);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5); doc.setTextColor(148, 163, 184);
      doc.text(`Ride Partner v${APP_VERSION} - performance record`, M, pageH - 7);
      doc.text(`Page ${i} of ${pages}`, pageW - M - 15, pageH - 7);
    }

    const safeName = String(ATHLETE.name || 'Athlete').replace(/[^A-Za-z0-9_-]+/g, '_');
    const fileName = `${safeName}_Physiology_Report_${startDate}_to_${endDate}.pdf`;
    const res = await saveOrShareFile(fileName, doc.output('datauristring').split(',')[1], { base64: true, mime: 'application/pdf', title: 'Ride Partner report' });
    if (res.ok) {
      status.textContent = `✓ ${fileName} → ${res.where}`;
      toast('PDF exported', 'success');
    } else if (!res.cancelled) {
      status.textContent = 'Export failed.';
    }
  } catch (err) {
    status.textContent = `Export failed: ${err.message}`;
    toast(`PDF failed: ${err.message}`, 'error');
  } finally {
    setBusy(btn, false);
  }
}
