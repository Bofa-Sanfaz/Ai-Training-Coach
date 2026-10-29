'use strict';
// --------------------------------------------------------
// ROUTE TRACE (offline SVG, coloured by heart-rate zone)
// + SHAREABLE RIDE CARD (PNG via the share sheet)
// --------------------------------------------------------

// Route points from the GPS stream (aligned with HR) or the Strava summary polyline
function routeData(w, stream) {
  const ll = stream && stream.latlng && Array.isArray(stream.latlng.data) ? stream.latlng.data : null;
  if (ll && ll.length > 5) {
    const hr = stream.heartrate && Array.isArray(stream.heartrate.data) ? stream.heartrate.data : null;
    return { pts: ll, hr };
  }
  if (w.map_polyline) {
    const pts = decodePolyline(w.map_polyline);
    if (pts.length > 2) return { pts, hr: null };
  }
  return null;
}

// Projects lat/lng into a box (equirectangular, cos(lat) corrected), keeping aspect ratio
function projectRoute(pts, width, height, pad) {
  const step = Math.max(1, Math.ceil(pts.length / 700));
  const idx = [];
  for (let i = 0; i < pts.length; i += step) idx.push(i);
  if (idx[idx.length - 1] !== pts.length - 1) idx.push(pts.length - 1);
  const midLat = idx.reduce((a, i) => a + pts[i][0], 0) / idx.length;
  const k = Math.cos((midLat * Math.PI) / 180);
  const xs = idx.map(i => pts[i][1] * k), ys = idx.map(i => -pts[i][0]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const s = Math.min((width - pad * 2) / (maxX - minX || 1e-9), (height - pad * 2) / (maxY - minY || 1e-9));
  const ox = (width - (maxX - minX) * s) / 2, oy = (height - (maxY - minY) * s) / 2;
  return idx.map((i, j) => ({ x: ox + (xs[j] - minX) * s, y: oy + (ys[j] - minY) * s, i }));
}

// Splits the projected route into runs of the same HR zone
function zoneRuns(proj, hr) {
  const runs = [];
  let cur = null;
  for (const p of proj) {
    const z = hr ? PHYSIO.getZoneIndex(hr[p.i]) : -1;
    const color = z >= 0 ? PHYSIO.zones[z].color : '#fc5200';
    if (!cur || cur.color !== color) {
      if (cur) cur.pts.push(p);
      cur = { color, pts: [p] };
      runs.push(cur);
    } else {
      cur.pts.push(p);
    }
  }
  return runs;
}

function routeSvg(data, width = 340, height = 210) {
  const proj = projectRoute(data.pts, width, height, 14);
  const line = pts => pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const runs = zoneRuns(proj, data.hr);
  const a = proj[0], b = proj[proj.length - 1];
  return `<svg viewBox="0 0 ${width} ${height}" class="route-svg" role="img" aria-label="Route map">
    <polyline points="${line(proj)}" fill="none" stroke="var(--route-casing)" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
    ${runs.map(r => `<polyline points="${line(r.pts)}" fill="none" stroke="${r.color}" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>`).join('')}
    <circle cx="${b.x.toFixed(1)}" cy="${b.y.toFixed(1)}" r="5.5" fill="#0f172a" stroke="#fff" stroke-width="2"/>
    <circle cx="${a.x.toFixed(1)}" cy="${a.y.toFixed(1)}" r="5.5" fill="#16a34a" stroke="#fff" stroke-width="2"/>
  </svg>`;
}

function renderRouteCard(w, stream) {
  const host = $('#det_route');
  const data = routeData(w, stream);
  if (!data) { host.innerHTML = ''; host.classList.add('hidden'); return; }
  host.classList.remove('hidden');
  host.innerHTML = `${routeSvg(data)}
    <div class="route-legend">${data.hr ? PHYSIO.zones.map(z => `<span><i style="background:${z.color}"></i>${z.key}</span>`).join('') : '<span>Route</span>'}
    <span class="grow"></span><span><i style="background:#16a34a"></i>Start</span><span><i style="background:#0f172a"></i>Finish</span></div>`;
  drawRoute($('svg', host));
}

// --------------------------------------------------------
// SHARE CARD (1080 × 1350 PNG)
// --------------------------------------------------------
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function shareRideCard() {
  const w = currentWorkout;
  if (!w) return;
  haptic('light');
  try {
    if (document.fonts && document.fonts.load) {
      await Promise.all([document.fonts.load('700 64px "Barlow Semi Condensed"'), document.fonts.load('500 32px "Barlow"')]);
    }
    const W = 1080, H = 1350;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');

    const bg = g.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#1c2a48'); bg.addColorStop(1, '#0a101d');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    g.fillStyle = '#fc5200'; g.fillRect(0, 0, W, 14);

    try { g.drawImage(await loadImage('img/logo.svg'), 72, 72, 96, 96); } catch (e) {}
    g.fillStyle = '#ffffff';
    g.font = '700 46px "Barlow Semi Condensed", sans-serif';
    g.fillText('Training Partner', 190, 118);
    g.fillStyle = '#9fb0cf';
    g.font = '500 30px "Barlow", sans-serif';
    g.fillText(formatNiceDate(w.date), 190, 158);

    g.fillStyle = '#ffffff';
    g.font = '700 74px "Barlow Semi Condensed", sans-serif';
    const title = rideTitle(w);
    g.fillText(title.length > 26 ? `${title.slice(0, 25)}…` : title, 72, 290);

    // Route
    const row = await db.streams.get(Number(w.strava_id));
    const data = routeData(w, row ? row.stream_data : null);
    if (data) {
      const proj = projectRoute(data.pts, W - 144, 520, 20);
      g.save();
      g.translate(72, 340);
      g.lineCap = 'round'; g.lineJoin = 'round';
      g.strokeStyle = 'rgba(255,255,255,0.18)'; g.lineWidth = 22;
      g.beginPath(); proj.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.stroke();
      g.lineWidth = 10;
      for (const r of zoneRuns(proj, data.hr)) {
        g.strokeStyle = r.color;
        g.beginPath(); r.pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.stroke();
      }
      g.restore();
    }

    // Stats grid
    const stats = [
      [`${fmtNum(w.distance_km, 1)}`, 'km'],
      [rideDuration(w), 'moving'],
      [`${fmtNum(w.avg_speed_kmh, 1)}`, 'km/h avg'],
      [`${Math.round(num(w.elevation_gain_m))}`, 'm climbed'],
      [w.avg_hr ? `${w.avg_hr}` : '--', 'bpm avg'],
      [hasVal(w.trimp) ? `${Math.round(w.trimp)}` : (w.np_w ? `${w.np_w}` : '--'), hasVal(w.trimp) ? 'load (TRIMP)' : 'W NP']
    ];
    const top = data ? 900 : 380;
    stats.forEach(([v, l], i) => {
      const x = 72 + (i % 3) * 312, y = top + Math.floor(i / 3) * 170;
      g.fillStyle = '#ffffff'; g.font = '700 84px "Barlow Semi Condensed", sans-serif'; g.fillText(v, x, y + 80);
      g.fillStyle = '#9fb0cf'; g.font = '500 30px "Barlow", sans-serif'; g.fillText(l, x, y + 122);
    });

    // Zone strip
    const z = Array.isArray(w.zone_seconds) ? w.zone_seconds : [];
    const tot = z.reduce((a, b) => a + num(b), 0);
    if (tot) {
      let x = 72;
      PHYSIO.zones.forEach((zz, i) => {
        const wd = ((W - 144) * num(z[i])) / tot;
        g.fillStyle = zz.color; g.fillRect(x, H - 120, wd, 18); x += wd;
      });
    }
    g.fillStyle = '#9fb0cf'; g.font = '500 26px "Barlow", sans-serif';
    g.fillText(`${getCleanIntentLabel(w)}`.slice(0, 70), 72, H - 60);

    const b64 = c.toDataURL('image/png').split(',')[1];
    const res = await saveOrShareFile(`RidePartner_${(w.exercise_code || 'ride').replace(/[^A-Za-z0-9]+/g, '_')}.png`, b64, { base64: true, mime: 'image/png', title: rideTitle(w) });
    if (res.ok) toast(`Ride card ready → ${res.where}`, 'success');
  } catch (e) {
    toast(`Could not create the ride card: ${e.message}`, 'error');
  }
}
