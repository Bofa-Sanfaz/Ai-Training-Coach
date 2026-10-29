'use strict';
// --------------------------------------------------------
// DEMO DATA: realistic synthetic rides with full streams,
// so the app can be explored (and tested) without Strava.
// All demo rides carry demo:true and can be removed in one tap.
// --------------------------------------------------------
const DEMO_ID_BASE = 9000000000;

function seededRandom(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

function makeDemoRide(i, date, kind, rnd) {
  const durMin = kind === 'long' ? 110 + rnd() * 50 : kind === 'interval' ? 55 + rnd() * 15 : kind === 'play' ? 30 + rnd() * 25 : 60 + rnd() * 35;
  const step = 2;
  const n = Math.round((durMin * 60) / step);
  const time = [], dist = [], alt = [], hr = [], vel = [], grade = [], moving = [], cad = [];
  const rest = PHYSIO.resting_hr, max = PHYSIO.max_hr;
  const baseAlt = 300 + rnd() * 400;
  const hilliness = kind === 'long' ? 130 : 55 + rnd() * 55;
  const p1 = 300 + rnd() * 400, p2 = 90 + rnd() * 120;
  const stopAt = [Math.floor(n * 0.37), Math.floor(n * 0.71)];
  let d = 0, h = rest + 20;
  const fitness = 0.92 + i * 0.004; // slow improvement across the block

  for (let k = 0; k < n; k++) {
    const t = k * step;
    const a = baseAlt + hilliness * Math.sin(t / p1) + (hilliness / 3) * Math.sin(t / p2 + i);
    const aPrev = alt.length ? alt[alt.length - 1] : a;
    const stopped = stopAt.some(s => k >= s && k < s + 30) && kind !== 'interval';
    let intensity;
    if (kind === 'interval') intensity = (Math.floor(t / 180) % 2 === 0 || t < 600) ? 0.55 : 0.88;
    else if (kind === 'play') intensity = 0.5 + 0.2 * Math.sin(t / 200);
    else intensity = kind === 'long' ? 0.6 : 0.63;
    if (t < 480) intensity = Math.min(intensity, 0.45 + (t / 480) * 0.15);

    let v = stopped ? 0 : Math.max(1.5, (4.9 + intensity * 2.8) * fitness - Math.max(-3, Math.min(6, ((a - aPrev) / Math.max(1, 7 * step)) * 100)) * 0.55 + (rnd() - 0.5) * 0.6);
    const g = v > 0 ? ((a - aPrev) / Math.max(1, v * step)) * 100 : 0;
    const climbBoost = Math.max(0, g) * 0.025;
    const drift = (t / 3600) * 0.035;
    const targetHr = stopped ? rest + 35 : rest + (max - rest) * Math.min(0.97, intensity + climbBoost + drift) / fitness;
    h += (targetHr - h) * 0.035 * step;

    d += v * step;
    time.push(t);
    dist.push(round(d, 1));
    alt.push(round(a, 1));
    vel.push(round(v, 2));
    grade.push(round(Math.max(-15, Math.min(15, g)), 1));
    hr.push(Math.round(h + (rnd() - 0.5) * 2));
    moving.push(!stopped);
    cad.push(stopped ? 0 : Math.round(78 + intensity * 15 + (rnd() - 0.5) * 6));
  }

  // A wobbly GPS loop so the route map and share card can be tried out
  const loopM = Math.max(1, d);
  const r = loopM / (2 * Math.PI);
  const c0 = { lat: 39.92 + (i % 4) * 0.01, lon: 32.85 + (i % 3) * 0.012 };
  const latlng = dist.map(m => {
    const th = (m / loopM) * 2 * Math.PI;
    const rr = r * (1 + 0.18 * Math.sin(th * 5 + i));
    return [round(c0.lat + (rr * Math.sin(th)) / 111320, 6), round(c0.lon + (rr * (1 - Math.cos(th))) / (111320 * Math.cos((c0.lat * Math.PI) / 180)), 6)];
  });

  const movingSec = moving.filter(Boolean).length * step;
  let gain = 0;
  for (let k = 1; k < n; k++) if (alt[k] > alt[k - 1]) gain += alt[k] - alt[k - 1];
  const hrMoving = hr.filter((_, k) => moving[k]);
  const avgHr = Math.round(hrMoving.reduce((x, y) => x + y, 0) / hrMoving.length);
  const distKm = round(d / 1000, 2);
  const estW = Math.round(110 + 70 * (avgHr - rest) / (max - rest));

  const zone = kind === 'interval' ? 'Zone 4 (Threshold)' : kind === 'long' || kind === 'steady' ? 'Zone 2 (Aerobic Base)' : null;
  const intent = kind === 'play'
    ? { intent_type: 'PLAY', intent_target: JSON.stringify({ intent_type: 'PLAY' }) }
    : { intent_type: 'TRAINING', intent_target: JSON.stringify(Object.assign({ intent_type: 'TRAINING', target_zone: zone, format: kind === 'interval' ? 'INTERVAL' : 'STEADY' }, kind === 'interval' ? { interval_zones: 'Z2 <-> Z4', interval_freq: '3m on / 3m off' } : {})) };
  const names = { long: 'Long weekend endurance', interval: 'Threshold intervals', play: 'Evening spin', steady: 'Aerobic base ride' };

  const workout = Object.assign({
    strava_id: DEMO_ID_BASE + i,
    ride_number: 0,
    exercise_code: '',
    name: `${names[kind]} (demo)`,
    sport_type: 'MountainBikeRide',
    date: `${formatLocalDate(date)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`,
    distance_km: distKm,
    duration_str: formatDuration(movingSec),
    moving_sec: movingSec,
    elapsed_sec: n * step,
    avg_speed_kmh: round((distKm / movingSec) * 3600, 1),
    max_speed_kmh: round(safeMax(vel) * 3.6, 1),
    avg_power_w: estW,
    max_power_w: estW * 3,
    norm_power_w: 0,
    device_watts: false,
    avg_hr: avgHr,
    max_hr: safeMax(hr),
    elevation_gain_m: Math.round(gain),
    kilojoules: Math.round((estW * movingSec) / 1000),
    calories: Math.round((estW * movingSec) / 1000 * 1.05),
    trainer: false,
    debrief_stale: false,
    demo: true
  }, intent);

  const stream = {
    time: { data: time }, distance: { data: dist }, latlng: { data: latlng }, altitude: { data: alt }, heartrate: { data: hr },
    velocity_smooth: { data: vel }, grade_smooth: { data: grade }, moving: { data: moving }, cadence: { data: cad }
  };
  return { workout, stream };
}

async function loadDemoData() {
  if (!(await uiConfirm('Load demo rides?', 'Adds 24 realistic sample rides (marked "demo") so you can explore every screen. Remove them any time.', { okText: 'Load demo' }))) return;
  await createRestorePoint('Before loading demo rides', 'auto');
  const rnd = seededRandom(42);
  const kinds = ['steady', 'interval', 'play', 'steady', 'long', 'steady'];
  const start = addDays(startOfWeek(new Date()), -7 * 9);
  let made = 0;
  for (let i = 0; i < 24; i++) {
    const day = addDays(start, Math.floor(i * 2.7));
    if (day > new Date()) break;
    const kind = kinds[i % kinds.length];
    day.setHours(kind === 'long' ? 8 : 18, Math.floor(rnd() * 50));
    const { workout, stream } = makeDemoRide(i, day, kind, rnd);
    if (await db.workouts.where('strava_id').equals(workout.strava_id).first()) continue;
    const id = await db.workouts.add(workout);
    await db.streams.put({ strava_id: workout.strava_id, stream_data: stream });
    await ensureRideMetrics(Object.assign(workout, { id }), stream, true);
    made++;
  }
  if (!(await getWeightHistory()).length) {
    await saveWeightHistory([{ date: formatLocalDate(start), weight: 84.5 }, { date: formatLocalDate(addDays(start, 35)), weight: 83.1 }]);
  }
  await renumberRides();
  toast(`Added ${made} demo rides`, 'success');
  switchTab('rides');
}

async function removeDemoData() {
  const demo = (await db.workouts.toArray()).filter(w => w.demo || Number(w.strava_id) >= DEMO_ID_BASE);
  if (!demo.length) { toast('No demo rides to remove.', 'info'); return; }
  if (!(await uiConfirm('Remove demo rides?', `${demo.length} demo rides and their chats will be deleted.`, { okText: 'Remove', danger: true }))) return;
  for (const w of demo) {
    await db.workouts.delete(w.id);
    await db.streams.delete(Number(w.strava_id));
    await rideThreads(w.strava_id).delete();
  }
  await renumberRides();
  toast('Demo rides removed', 'success');
  if (Router.current === 'rides') renderRides();
}
