'use strict';
// --------------------------------------------------------
// SQUAD — shared challenges with friends (docs/PLAN.md, Phase 5)
// The personal side of the app is untouched; the squad only receives SUMMARIES of
// your workouts (numbers, personal bests, how it felt, the coach's one-line verdict).
//
// Sync: every change is an event with a server sequence number. Your own posts go
// into a persistent outbox first (survives closing the app / no signal) and are sent
// with client-made ids, so a retry can never duplicate anything. Polling: 4 s while
// the chat is open, 15 s on the Squad tab, 60 s elsewhere, at once on resume.
// The AI ("Aether") runs on the squad server with the owner's key; when the server
// says the AI is due, the app asks it to run (the server's cron covers closed phones).
// --------------------------------------------------------
const SQUAD_DEFAULT_SERVER = 'https://training-partner-squad.training-partner-squad.workers.dev'; // squad/ deployed 2026-10-29
const SQUAD_POLL = { chat: 4000, tab: 15000, idle: 60000 };
const SQUAD_REACTIONS = ['🔥', '💪', '👏', '😂', '😮', '🐢'];
const SQUAD_AI = 'Aether';
const Squad = {
  list: [],        // [{ id, server, token, member_id, name, auto_share, share_notes, shared: { key: hash } }]
  cur: null,       // current challenge id
  data: {},        // id → { seq, events, members, challenge, me, today, read_seq }
  outbox: [],      // [{ cid, ev }]
  timer: null, busy: {}, aiBusy: {}, lastShare: 0, lastAll: 0, offline: false, digestHash: {}, digestSeq: {},
  replyTo: null, actRef: null, msgId: null,
  view: 'home', feedFilter: 'all', month: null, statsRange: 'challenge', importDraft: null
};

// ---------- storage ----------
async function squadInit() {
  Squad.list = await getJsonConfig('squad_challenges', []);
  Squad.outbox = await getJsonConfig('squad_outbox', []);
  Squad.cur = (await getConfig('squad_current')) || (Squad.list[0] && Squad.list[0].id) || null;
  if (Squad.cur && !Squad.list.some(c => c.id === Squad.cur)) Squad.cur = Squad.list[0] ? Squad.list[0].id : null;
  for (const c of Squad.list) await squadStore(c.id);
  try { const v = localStorage.getItem('rp_squad_view'); if (SQUAD_VIEWS.some(x => x[0] === v) && v !== 'chat') Squad.view = v; } catch (e) {}
  squadBadge();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) squadTick(true); });
  window.addEventListener('online', () => squadTick(true));
  const hash = location.hash.match(/join=([A-Za-z0-9-]{8,9})/);
  if (hash && !window.__introPending) setTimeout(() => openSquadJoin(hash[1]), 900); // with the intro, its squad step offers the join
  squadSchedule(1500);
}

const squadEntry = cid => Squad.list.find(c => c.id === cid);
const squadSaveList = () => setJsonConfig('squad_challenges', Squad.list);
const squadSaveOutbox = () => setJsonConfig('squad_outbox', Squad.outbox);

async function squadStore(cid) {
  if (!Squad.data[cid]) Squad.data[cid] = await getJsonConfig(`squad_data_${cid}`, null) || { seq: 0, events: [], members: [], challenge: null, me: null, today: null, read_seq: 0 };
  return Squad.data[cid];
}
const squadPersist = cid => setJsonConfig(`squad_data_${cid}`, Squad.data[cid]);

function squadServerDefault() {
  if (!isNative() && /^https:$/.test(location.protocol) && !/localhost|127\.0\.0\.1/.test(location.hostname)) return location.origin;
  return SQUAD_DEFAULT_SERVER;
}

function squadId(prefix = 'e') {
  const a = crypto.getRandomValues(new Uint8Array(9));
  return `${prefix}${Date.now().toString(36)}${Array.from(a, b => (b % 36).toString(36)).join('')}`;
}

// ---------- API ----------
async function squadApi(server, method, path, body, token, timeoutMs = 20000, rawBody) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  let res, d;
  try {
    res = await fetch(String(server).replace(/\/$/, '') + path, {
      method, signal: ctl.signal,
      headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: `Bearer ${token}` } : {}),
      body: rawBody !== undefined ? rawBody : body ? JSON.stringify(body) : undefined
    });
    d = await res.json().catch(() => ({}));
  } catch (e) {
    throw Object.assign(new Error(e.name === 'AbortError' ? 'the squad server did not answer' : 'no connection to the squad server'), { offline: true });
  } finally { clearTimeout(t); }
  if (!res.ok) throw Object.assign(new Error(d.error || `HTTP ${res.status}`), { status: res.status });
  return d;
}
const squadCall = (c, method, path, body, timeoutMs) => squadApi(c.server, method, `/api/c/${c.id}${path}`, body, c.token, timeoutMs);

// ---------- sync ----------
function squadQueue(cid, kind, body, ref = null) {
  const st = Squad.data[cid];
  const ev = { id: squadId(kind[0]), kind, body, ref, author: st && st.me, created_at: new Date().toISOString() };
  Squad.outbox.push({ cid, ev });
  squadSaveOutbox();
  squadRenderLive(cid);
  squadSync(cid);
  return ev;
}

async function squadSync(cid) {
  const c = squadEntry(cid);
  if (!c || c.revoked) return;
  if (Squad.busy[cid]) { Squad.busy[cid] = 'again'; return; }
  Squad.busy[cid] = true;
  const st = await squadStore(cid);
  let aiDue = false, changed = false, arcFx = null;
  try {
    // 1. Send the outbox (in order, 50 at a time)
    for (;;) {
      const mine = Squad.outbox.filter(o => o.cid === cid).slice(0, 50);
      if (!mine.length) break;
      const r = await squadCall(c, 'POST', '/events', { events: mine.map(o => ({ id: o.ev.id, kind: o.ev.kind, ref: o.ev.ref, body: o.ev.body })) });
      const done = new Set(r.acks.filter(a => a.seq).map(a => a.id).concat(r.rejected.map(x => x.id)));
      if (r.rejected.length) toast(`Squad: ${r.rejected[0].error}`, 'warn');
      Squad.outbox = Squad.outbox.filter(o => !(o.cid === cid && done.has(o.ev.id)));
      await squadSaveOutbox();
      aiDue = aiDue || r.ai_due;
      if (!done.size) break;
    }
    // 2. Pull everything newer than what we have
    for (let guard = 0; guard < 20; guard++) {
      const d = await squadCall(c, 'GET', `/changes?since=${st.seq}`);
      const known = new Set(st.events.map(e => e.seq));
      const fresh = d.events.filter(e => !known.has(e.seq));
      if (fresh.length) { st.events.push(...fresh); changed = true; }
      if (JSON.stringify(st.members) !== JSON.stringify(d.members) || JSON.stringify(st.challenge) !== JSON.stringify(d.challenge)) changed = true;
      st.seq = d.seq; st.members = d.members; st.challenge = d.challenge; st.me = d.me; st.today = d.today;
      aiDue = aiDue || d.ai_due;
      if (!d.more) break;
    }
    if (st.events.length > 6000) st.events = st.events.slice(-5000);
    if (c.name !== st.challenge.name) { c.name = st.challenge.name; await squadSaveList(); }
    // A new arc started since we last looked: celebrate it once (a fresh device just takes note)
    const arc = st.challenge.arc || 0;
    if (st.arc_seen === undefined) st.arc_seen = arc;
    else if (arc > st.arc_seen) {
      const ev = st.events.filter(e => e.kind === 'system' && e.body && e.body.type === 'arc_started' && e.body.arc === arc).pop();
      arcFx = { arc, prev: ev && ev.body.prev ? ev.body.prev.n : null };
      st.arc_seen = arc;
      Squad.feedAll = false; Squad.chatAll = false;
    }
    await squadPersist(cid);
    Squad.offline = false;
    // 3. The AI's context, built here (the server stays within its free CPU budget)
    if (st.challenge.ai && st.challenge.ai.enabled && (changed || Squad.digestSeq[cid] !== st.seq)) await squadSendDigest(c, st);
  } catch (e) {
    if (e.status === 403 || e.status === 404) {
      c.revoked = true;
      await squadSaveList();
      toast(`You are no longer in "${c.name}"`, 'warn');
      changed = true;
    } else if (e.offline) Squad.offline = true;
    else console.warn('squad sync', e);
  } finally {
    const again = Squad.busy[cid] === 'again';
    Squad.busy[cid] = false;
    if (changed) squadRenderLive(cid);
    squadBadge();
    if (arcFx) squadArcCelebrate(cid, arcFx.arc, arcFx.prev);
    if (aiDue) squadRunAi(cid);
    if (again) setTimeout(() => squadSync(cid), 50);
  }
}

async function squadSendDigest(c, st) {
  try {
    const events = st.events;
    const folded = SquadCore.fold(events);
    const ch = st.challenge;
    const acts = Array.from(folded.activities.values());
    const score = SquadCore.compute({ starts: ch.starts, ends: ch.ends, rules: ch.rules }, (st.members || []).filter(m => m.active || acts.some(a => a.author === m.id)), acts, st.today);
    const body = JSON.stringify(SquadCore.digest(st.seq, st.today, folded, score));
    const h = squadHash(body);
    if (Squad.digestHash[c.id] !== h) {
      await squadApi(c.server, 'PUT', `/api/c/${c.id}/digest`, null, c.token, 20000, body);
      Squad.digestHash[c.id] = h;
    }
    Squad.digestSeq[c.id] = st.seq;
  } catch (e) { console.warn('squad digest', e.message); }
}

// Ask the server to let the AI work (answers, interruptions, recap). One at a time.
async function squadRunAi(cid) {
  const c = squadEntry(cid);
  if (!c || Squad.aiBusy[cid]) return;
  Squad.aiBusy[cid] = true;
  squadRenderLive(cid);
  try { await squadCall(c, 'POST', '/ai/run', {}, 150000); } catch (e) { console.warn('squad ai', e.message); }
  Squad.aiBusy[cid] = false;
  await squadSync(cid);
}

function squadSchedule(ms) {
  clearTimeout(Squad.timer);
  if (!Squad.list.length) return;
  const chat = $('#squadChat') && $('#squadChat').classList.contains('open');
  ms = ms || (chat ? SQUAD_POLL.chat : Router.current === 'squad' ? SQUAD_POLL.tab : SQUAD_POLL.idle);
  Squad.timer = setTimeout(() => squadTick(), ms);
}

async function squadTick(now) {
  clearTimeout(Squad.timer);
  if (document.hidden || !Squad.list.length) return;
  try {
    const all = now || Date.now() - Squad.lastAll > SQUAD_POLL.idle;
    const ids = Squad.list.filter(c => !c.revoked && (all || c.id === Squad.cur)).map(c => c.id);
    if (all) Squad.lastAll = Date.now();
    await Promise.all(ids.map(squadSync));
    // Share after syncing (a new challenge only knows its dates after the first sync)
    if (Date.now() - Squad.lastShare > SQUAD_POLL.idle) {
      Squad.lastShare = Date.now();
      if (await squadShareWorkouts()) await Promise.all(Squad.list.filter(c => !c.revoked).map(c => squadSync(c.id)));
    }
  } finally { squadSchedule(); }
}

// ---------- sharing your workouts (summaries only) ----------
function squadHash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }

function squadFirstSentence(text, max = 220) {
  const t = String(text || '').replace(/[#*_`>|]/g, '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.{20,}?[.!?])\s/);
  return (m ? m[1] : t).slice(0, max);
}

// Personal bests vs your own earlier workouts of the same sport (needs 3+ earlier ones)
function squadPbs(w, history) {
  const sp = sportOf(w);
  const prior = history.filter(h => sportOf(h) === sp && h.date < w.date && !isExcluded(h));
  if (prior.length < 3 || isExcluded(w)) return [];
  const out = [];
  const best = (fn, lower) => { const v = prior.map(fn).filter(x => x > 0); return v.length ? (lower ? Math.min(...v) : Math.max(...v)) : null; };
  const dist = h => num(mv(h, 'distance_km'));
  if (sp !== 'other' && dist(w) > 0 && dist(w) > (best(dist) || Infinity) * 1.0001 && best(dist)) out.push(`longest ${SPORTS[sp].label.toLowerCase()}`);
  if (sp === 'other' && num(w.moving_sec) > (best(h => num(h.moving_sec)) || Infinity)) out.push('longest session');
  const minKm = { run: 3, walk: 2, ride: 20, swim: 0.4 }[sp];
  if (minKm && dist(w) >= minKm) {
    const spd = h => (dist(h) >= minKm ? num(mv(h, 'avg_speed_kmh')) : 0);
    const b = best(spd);
    if (b && spd(w) > b * 1.0001 && sp !== 'swim') out.push(sp === 'ride' ? 'fastest average speed' : 'fastest pace');
  }
  if (sp === 'swim') {
    const sw = swimOf(w);
    const b100 = best(h => { const x = swimOf(h); return x && x.best[100]; }, true);
    if (sw && sw.best[100] && b100 && sw.best[100] < b100) out.push(`fastest 100 m (${fmtPace(sw.best[100])})`);
    const bsw = best(h => { const x = swimOf(h); return x && x.swolf; }, true);
    if (sw && sw.swolf && bsw && sw.swolf < bsw) out.push(`best SWOLF (${sw.swolf})`);
  }
  return out;
}

async function squadSummary(w, history, c) {
  const sp = sportOf(w);
  const sw = swimOf(w);
  const s = {
    key: String(w.strava_id), sport: sp, type: w.sport_type || SPORTS[sp].label, title: rideTitle(w),
    date: String(w.date).slice(0, 10), start: String(w.date).slice(11, 16), dur_s: Math.round(num(w.moving_sec)),
    indoor: isIndoor(w) || undefined
  };
  const km = num(mv(w, 'distance_km'));
  if (sp !== 'other' && km > 0) s.dist_m = Math.round(km * 1000);
  const kmh = num(mv(w, 'avg_speed_kmh'));
  if (onFoot(sp) && kmh > 0) s.pace_km = Math.round(3600 / kmh);
  if (sp === 'ride' && kmh > 0) s.speed_kmh = round(kmh, 1);
  if (sp === 'swim') {
    const p = swimPace100(w);
    if (p > 0) s.pace100 = Math.round(p);
    if (sw) {
      s.swolf = sw.swolf; s.pool_m = sw.pool_m; s.strokes = sw.strokes;
      s.best100 = sw.best[100] || undefined;
      // Every length, compact: "0:36/16" = seconds/strokes (the AI gets the whole set)
      s.laps_line = `${sw.pool_m} m pool: ${sw.laps.map(l => `${fmtPace(l.sec)}${l.strokes ? `/${l.strokes}` : ''}${l.style !== 'FREESTYLE' ? ` ${String(l.style).slice(0, 2).toLowerCase()}` : ''}`).join(' ')}`.slice(0, 2500);
    }
  }
  if (sp === 'swim' && !sw) {
    // Logged by hand: what was entered (no per-length detail)
    if (w.swolf_manual) s.swolf = w.swolf_manual;
    if (w.pool_m) s.pool_m = w.pool_m;
    if (w.strokes_total) s.strokes = w.strokes_total;
  }
  if (w.main_stroke && w.main_stroke !== 'FREESTYLE') s.stroke = w.main_stroke.toLowerCase();
  if (w.reps) s.reps = w.reps;
  if (num(mv(w, 'avg_hr')) > 0) s.avg_hr = w.avg_hr;
  if (num(mv(w, 'max_hr')) > 0) s.max_hr = w.max_hr;
  if (hasVal(mv(w, 'trimp'))) s.load = Math.round(w.trimp);
  if (w.avg_cadence) s.cadence = w.avg_cadence;
  if (w.steps) s.steps = w.steps;
  if (sp !== 'swim' && !isIndoor(w) && num(mv(w, 'elevation_gain_m')) > 5) s.elev_m = Math.round(w.elevation_gain_m);
  if (w.calories) s.kcal = w.calories;
  if (w.reps) s.reps = w.reps;
  const pb = squadPbs(w, history);
  if (pb.length) s.pb = pb;
  if (c.share_notes !== false) {
    if (w.rpe) s.rpe = w.rpe;
    if (w.feel) s.feel = w.feel;
    if (w.note) s.note = String(w.note).slice(0, 240);
    const debrief = await db.threads.where('[strava_id+role]').equals([Number(w.strava_id), 'coach']).first();
    if (debrief && debrief.message) s.verdict = squadFirstSentence(debrief.message);
  }
  return s;
}

async function squadShareWorkouts() {
  const live = Squad.list.filter(c => !c.revoked && c.auto_share !== false);
  if (!live.length) return false;
  const all = await db.workouts.toArray();
  const byKey = new Map(all.map(w => [String(w.strava_id), w]));
  let dirty = false;
  for (const c of live) {
    const st = await squadStore(c.id);
    if (!st.challenge || !st.me) continue;
    const from = st.challenge.starts, to = st.challenge.ends || '9999';
    c.shared = c.shared || {};
    for (const w of all) {
      const d = String(w.date).slice(0, 10);
      if (d < from || d > to || isExcluded(w)) continue;
      const s = await squadSummary(w, all, c);
      const h = squadHash(JSON.stringify(s));
      if (c.shared[s.key] === h) continue;
      squadQueueQuiet(c.id, 'activity', s);
      c.shared[s.key] = h;
      dirty = true;
    }
    // Deleted or excluded here → removed from the squad too. Before the start only while no arc
    // has begun (a moved start date); sessions of earlier arcs stay for their reports.
    const floor = st.challenge.arc ? '' : from;
    for (const key of Object.keys(c.shared)) {
      const w = byKey.get(key);
      if (w && !isExcluded(w) && String(w.date).slice(0, 10) >= floor) continue;
      squadQueueQuiet(c.id, 'delete', {}, SquadCore.actRef(st.me, key));
      delete c.shared[key];
      dirty = true;
    }
  }
  for (const c of Squad.list.filter(x => !x.revoked)) if (await squadShareWellness(c)) dirty = true;
  if (dirty) { await squadSaveList(); await squadSaveOutbox(); }
  return dirty;
}

// Body & wellness (opt-in per challenge): one 'daily' event per day with weight, resting HR,
// HRV, sleep and steps from the challenge start (max 120 days back). Turning it off clears them.
async function squadShareWellness(c) {
  const st = Squad.data[c.id];
  if (!st || !st.challenge || !st.me) return false;
  c.daily_shared = c.daily_shared || {};
  let dirty = false;
  if (!c.share_wellness) {
    for (const d of Object.keys(c.daily_shared)) { squadQueueQuiet(c.id, 'daily', { date: d, clear: true }); dirty = true; }
    c.daily_shared = {};
    return dirty;
  }
  const floor = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
  const from = st.challenge.starts > floor ? st.challenge.starts : floor;
  const to = st.challenge.ends || '9999';
  const days = {};
  const wel = typeof getWellness === 'function' ? await getWellness() : { days: {} };
  for (const [d, v] of Object.entries(wel.days || {})) {
    if (d < from || d > to) continue;
    const x = {};
    if (v.rhr > 0) x.rhr = v.rhr;
    if (v.hrv > 0) x.hrv = v.hrv;
    if (v.sleep_min > 0) x.sleep_min = v.sleep_min;
    if (v.steps > 0) x.steps = v.steps;
    if (Object.keys(x).length) days[d] = x;
  }
  for (const e of await getWeightHistory()) {
    const d = String(e.date).slice(0, 10);
    if (d >= from && d <= to) days[d] = Object.assign(days[d] || {}, { weight_kg: round(num(e.weight), 1) });
  }
  for (const [d, x] of Object.entries(days)) {
    const body = Object.assign({ date: d }, x);
    const h = squadHash(JSON.stringify(body));
    if (c.daily_shared[d] === h) continue;
    squadQueueQuiet(c.id, 'daily', body);
    c.daily_shared[d] = h;
    dirty = true;
  }
  return dirty;
}

// ---------- weight log (works on the web app too) ----------
async function openSquadWeight() {
  const h = await getWeightHistory();
  const last = h[h.length - 1];
  $('#sqw_kg').value = last ? String(last.weight) : '';
  $('#sqw_date').value = formatLocalDate(new Date());
  const c = squadEntry(Squad.cur);
  $('#sqw_share').checked = !!(c && c.share_wellness);
  $('#sqw_last').textContent = last ? `Last entry: ${last.weight} kg on ${String(last.date).slice(0, 10)}` : 'No weight logged yet.';
  openSheet('squadWeightSheet');
}

async function saveSquadWeight() {
  const kg = parseFloat(String($('#sqw_kg').value).replace(',', '.'));
  const date = $('#sqw_date').value;
  if (!(kg >= 25 && kg <= 300) || !date) { toast('Enter a weight between 25 and 300 kg', 'warn'); return; }
  const h = (await getWeightHistory()).filter(e => String(e.date).slice(0, 10) !== date);
  h.push({ date, weight: round(kg, 1) });
  await saveWeightHistory(h);
  const c = squadEntry(Squad.cur);
  if (c && $('#sqw_share').checked !== !!c.share_wellness) { c.share_wellness = $('#sqw_share').checked; await squadSaveList(); }
  closeSheet('squadWeightSheet');
  haptic('success');
  toast(c && c.share_wellness ? 'Weight saved and shared with the squad' : 'Weight saved (only on this phone)', 'success');
  Squad.lastShare = 0;
  squadTick(true);
}

// ---------- add workouts from screenshots (Huawei Health or any app) ----------
// The AI reads the numbers off the screen: the person's own AI key (personal coach) when one
// is set up, otherwise the squad's Aether on the server. Several screenshots can be picked at
// once; each opens the Log form pre-filled, one after the other, to check and save.
function squadPersonalAiReady() {
  return !!(typeof AI !== 'undefined' && AI && AI.providers.some(p => providerReady(p) && (!geminiOnly() || p.type === 'gemini')));
}

function squadSquadAiReady() {
  const S = Squad.cur && squadState(Squad.cur);
  return !!(S && S.ch && S.ch.ai && S.ch.ai.enabled);
}

function openSquadImport() {
  if (!squadPersonalAiReady() && !squadSquadAiReady()) {
    toast('Reading screenshots needs an AI key: add your free Google Gemini key in Profile → AI providers (aistudio.google.com/apikey).', 'warn', 6000);
    return;
  }
  $('#squadImportFile').value = '';
  $('#squadImportFile').click();
}

function squadShrinkImage(file, max = 1400) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(img.src);
      resolve(cv.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => reject(new Error('could not read the image'));
    img.src = URL.createObjectURL(file);
  });
}

// Picked screenshots (up to ${SHOT_MAX_IMAGES} per go) → one AI call groups them per workout → each
// workout opens the approval form in turn (saving or closing moves on to the next)
async function squadImportPicked(ev) {
  const files = Array.from((ev.target.files) || []).filter(f => /^image\//.test(f.type) || /\.(jpe?g|png|heic|webp)$/i.test(f.name));
  if (!files.length) return;
  if (files.length > SHOT_MAX_IMAGES) toast(`Reading the first ${SHOT_MAX_IMAGES} screenshots — add the rest in a second go.`, 'warn', 5000);
  toast(`Reading ${Math.min(files.length, SHOT_MAX_IMAGES)} screenshot${files.length > 1 ? 's' : ''}… (about ${files.length > 2 ? '30–60' : '15–30'} s)`, 'info', 9000);
  try {
    const images = [];
    for (const f of files.slice(0, SHOT_MAX_IMAGES)) images.push(await squadShrinkImage(f));
    const drafts = await readShots(images);
    Squad.shotQueue = drafts.map((w, i) => Object.assign(w, { shotN: i + 1, shotTotal: drafts.length }));
    if (drafts.length > 1) toast(`Found ${drafts.length} workouts — check each one and save.`, 'success', 4000);
    squadNextShot();
  } catch (e) {
    toast(`Could not read the screenshots: ${e.message}`, 'error', 6000);
  }
}

function squadNextShot() {
  const w = Squad.shotQueue && Squad.shotQueue.shift();
  if (!w) { Squad.shotQueue = null; return; }
  Squad.importDraft = w;
  squadFillImport();
  openSheet('squadImportSheet', () => { if (Squad.shotQueue && Squad.shotQueue.length) setTimeout(squadNextShot, 350); });
}

// Log a workout by hand (pool swims, gym…) — or check what the AI read from a screenshot.
// The fields follow the sport: swims by pool length × lengths (distance and pace follow),
// stroke, SWOLF and strokes; walks/runs with steps, cadence, climbing, treadmill; rides with
// climbing, power, cadence, indoor; gym by activity type with reps. All: HR, calories, RPE, note.
const MANUAL_FIELD_DEFS = {
  pool: { label: 'Pool', type: 'select', options: [['25', '25 m'], ['50', '50 m'], ['33', '33 m'], ['20', '20 m']] },
  lengths: { label: 'Lengths', type: 'int', ph: 'e.g. 40' },
  dist_m: { label: 'Distance (m)', type: 'int', ph: 'auto' },
  stroke: { label: 'Main stroke', type: 'select', options: [['FREESTYLE', 'Freestyle'], ['BREASTSTROKE', 'Breaststroke'], ['BACKSTROKE', 'Backstroke'], ['BUTTERFLY', 'Butterfly'], ['MIXED', 'Mixed']] },
  swolf: { label: 'Avg SWOLF', type: 'int', ph: 'optional' },
  strokes: { label: 'Total strokes', type: 'int', ph: 'optional' },
  dist: { label: 'Distance (km)', type: 'dec' },
  dist_opt: { label: 'Distance (km)', type: 'dec', ph: 'optional' },
  avg_hr: { label: 'Avg heart rate', type: 'int', ph: 'bpm' },
  max_hr: { label: 'Max heart rate', type: 'int', ph: 'bpm' },
  kcal: { label: 'Calories', type: 'int', ph: 'kcal' },
  steps: { label: 'Steps', type: 'int' },
  cadence_spm: { label: 'Cadence', type: 'int', ph: 'steps/min' },
  cadence_rpm: { label: 'Cadence', type: 'int', ph: 'rpm' },
  elev: { label: 'Climbing (m)', type: 'int' },
  power: { label: 'Avg power (W)', type: 'int', ph: 'optional' },
  reps: { label: 'Reps / sets', type: 'int', ph: 'optional' },
  gym: { label: 'Activity', type: 'select', options: [['WeightTraining', 'Strength'], ['Elliptical', 'Elliptical'], ['Rowing', 'Rowing'], ['StairStepper', 'Stair stepper'], ['HighIntensityIntervalTraining', 'HIIT'], ['Yoga', 'Yoga / Pilates'], ['Workout', 'Other']] },
  indoor: { label: 'Treadmill', type: 'check' },
  indoor_ride: { label: 'Indoor / trainer', type: 'check' }
};
const MANUAL_FIELDS = {
  swim: ['pool', 'lengths', 'dist_m', 'stroke', 'avg_hr', 'max_hr', 'kcal', 'swolf', 'strokes'],
  walk: ['dist', 'steps', 'avg_hr', 'max_hr', 'kcal', 'cadence_spm', 'elev', 'indoor'],
  run: ['dist', 'avg_hr', 'max_hr', 'kcal', 'cadence_spm', 'steps', 'elev', 'indoor'],
  ride: ['dist', 'avg_hr', 'max_hr', 'kcal', 'elev', 'power', 'cadence_rpm', 'indoor_ride'],
  other: ['gym', 'avg_hr', 'max_hr', 'kcal', 'reps', 'dist_opt']
};

function openManualWorkout(sport = 'swim') {
  Squad.importDraft = { manual: true, sport, date: formatLocalDate(new Date()), start_time: new Date().toTimeString().slice(0, 5) };
  squadFillImport();
  openSheet('squadImportSheet');
}

function squadPickSport(sport) {
  squadReadManualFields();
  $('#sqi_sport').value = sport;
  $$('#sqi_sportSeg button').forEach(b => b.classList.toggle('active', b.dataset.v === sport));
  const title = $('#sqi_title');
  if (!title.value || title.dataset.auto === '1') { title.value = SPORTS[sport].label; title.dataset.auto = '1'; }
  squadRenderManualFields();
}

// Values survive switching the sport back and forth
function squadReadManualFields() {
  const vals = Squad.manualVals || (Squad.manualVals = {});
  $$('#sqi_fields [data-k]').forEach(el => { vals[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value; });
}

function squadRenderManualFields() {
  const sport = $('#sqi_sport').value;
  const vals = Squad.manualVals || {};
  $('#sqi_fields').innerHTML = MANUAL_FIELDS[sport].map(k => {
    const d = MANUAL_FIELD_DEFS[k];
    const v = vals[k] === undefined || vals[k] === null ? '' : vals[k];
    if (d.type === 'select') return `<div class="field"><label>${d.label}</label><select class="input" data-k="${k}" onchange="squadManualChanged()">${d.options.map(([o, l]) => `<option value="${o}" ${String(v) === o ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`;
    if (d.type === 'check') return `<label class="sq-check"><input type="checkbox" data-k="${k}" ${v ? 'checked' : ''} /><span>${d.label}</span></label>`;
    return `<div class="field"><label>${d.label}</label><input class="input" data-k="${k}" inputmode="${d.type === 'dec' ? 'decimal' : 'numeric'}" placeholder="${d.ph || ''}" value="${escapeHtml(String(v))}" oninput="squadManualChanged(this)" /></div>`;
  }).join('');
  squadManualChanged();
}

// Swim: pool × lengths → distance; pace preview for every sport
function squadManualChanged(src) {
  const f = k => $(`#sqi_fields [data-k="${k}"]`);
  const sport = $('#sqi_sport').value;
  const dur = squadParseDuration($('#sqi_dur').value);
  let hint = '';
  if (sport === 'swim') {
    const n = parseInt(f('lengths').value, 10), pool = Number(f('pool').value);
    if (n > 0 && pool > 0 && (!src || src.dataset.k !== 'dist_m')) f('dist_m').value = String(n * pool);
    const m = parseInt(f('dist_m').value, 10);
    if (m > 0 && dur > 0) hint = `Pace ${fmtPace(dur / m * 100)} /100 m`;
  } else {
    const km = parseFloat(String((f('dist') || f('dist_opt') || {}).value || '').replace(',', '.'));
    if (km > 0 && dur > 0) hint = sport === 'ride' ? `Avg speed ${fmtNum(km / (dur / 3600), 1)} km/h` : sport === 'other' ? '' : `Pace ${fmtPace(dur / km)} /km`;
  }
  $('#sqi_extra').textContent = [hint, Squad.importDraft && Squad.importDraft.notes ? Squad.importDraft.notes : ''].filter(Boolean).join(' · ');
}

function squadRenderRpe(v) {
  $('#sqi_rpe').innerHTML = Array.from({ length: 10 }, (_, i) => i + 1).map(n => `<button type="button" class="rpe-btn ${v === n ? 'selected' : ''}" style="${v === n ? `background:${rpeColor(n)}` : ''}" onclick="Squad.manualRpe = Squad.manualRpe === ${n} ? null : ${n}; squadRenderRpe(Squad.manualRpe)">${n}</button>`).join('');
}

function squadFillImport() {
  const w = Squad.importDraft || {};
  const v = (id, x) => { $(id).value = x === null || x === undefined ? '' : String(x); };
  const manual = !!w.manual;
  $('#sqi_head').textContent = manual ? 'Log a workout' : `Workout from screenshot${w.shotTotal > 1 ? ` (${w.shotN} of ${w.shotTotal})` : ''}`;
  $('#sqiShotBtn').classList.toggle('hidden', !manual);
  $('#sqi_sub').textContent = manual ? 'For sessions that don\'t sync (e.g. pool swims, gym). It\'s added to your own workouts and shared with the squad.'
    : 'Read from your screenshots — check everything below, fix anything wrong, then save. Graphs, splits and lengths become your workout\'s charts.';
  $('#sqi_thumb').classList.add('hidden'); // screenshots are shown in the detail section
  const sport = SPORTS[w.sport] ? w.sport : 'other';
  const stroke = { free: 'FREESTYLE', breast: 'BREASTSTROKE', back: 'BACKSTROKE', fly: 'BUTTERFLY', mixed: 'MIXED' }[String(w.main_stroke || '').toLowerCase()];
  const pool = w.pool_m > 0 ? Math.round(w.pool_m) : 25;
  // Everything the AI read (or nothing, for a manual log) → the form's values
  Squad.manualVals = {
    pool: String([25, 50, 33, 20].includes(pool) ? pool : 25), lengths: w.pool_m && w.dist_m ? Math.round(w.dist_m / w.pool_m) : '',
    dist_m: sport === 'swim' && w.dist_m ? Math.round(w.dist_m) : '', stroke: stroke || 'FREESTYLE', swolf: w.swolf || '', strokes: w.strokes || '',
    dist: sport !== 'swim' && w.dist_m ? round(w.dist_m / 1000, 2) : '', dist_opt: '', avg_hr: w.avg_hr || '', max_hr: w.max_hr || '', kcal: w.calories || '',
    steps: w.steps || '', cadence_spm: w.cadence || '', cadence_rpm: w.cadence || '', elev: w.elev_gain_m || w.elev_m || '', power: '', reps: '', gym: 'WeightTraining',
    indoor: /treadmill|indoor/i.test(w.type || ''), indoor_ride: /indoor|trainer/i.test(w.type || '')
  };
  Squad.manualRpe = null;
  v('#sqi_title', w.type || SPORTS[sport].label);
  $('#sqi_title').dataset.auto = w.type ? '0' : '1';
  v('#sqi_date', w.date || formatLocalDate(new Date()));
  v('#sqi_time', w.start_time || '');
  v('#sqi_dur', w.dur_s ? formatDuration(w.dur_s) : '');
  v('#sqi_note', '');
  $('#sqi_dur').oninput = () => squadManualChanged();
  $('#sqi_sport').value = sport;
  $$('#sqi_sportSeg button').forEach(b => b.classList.toggle('active', b.dataset.v === sport));
  squadRenderManualFields();
  squadRenderRpe(null);
  // From screenshots: what else was read (checks, graphs, splits, lengths, zones) to approve
  $('#sqi_detail').innerHTML = manual ? '' : shotDetailHtml(w);
  if (!manual) setTimeout(shotRenderChart, 80);
}

function squadParseDuration(s) {
  const p = String(s || '').trim().split(':').map(Number);
  if (!p.length || p.some(x => !Number.isFinite(x))) return 0;
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : p[0] * 60;
}

async function saveSquadImport() {
  const d = Squad.importDraft || {};
  squadReadManualFields();
  const x = Squad.manualVals || {};
  const int = k => parseInt(x[k], 10) || 0;
  const dec = k => parseFloat(String(x[k] || '').replace(',', '.')) || 0;
  const sport = $('#sqi_sport').value;
  const date = $('#sqi_date').value;
  const time = $('#sqi_time').value || '12:00';
  const dur = squadParseDuration($('#sqi_dur').value);
  if (!date || !(dur > 0)) { toast('Date and duration are needed', 'warn'); return; }
  const km = sport === 'swim' ? int('dist_m') / 1000 : sport === 'other' ? dec('dist_opt') : dec('dist');
  if (sport !== 'other' && !(km > 0)) { toast(sport === 'swim' ? 'Enter the lengths (or the distance)' : 'Enter the distance', 'warn'); return; }
  const avgHr = int('avg_hr'), maxHr = int('max_hr');
  if ((avgHr && (avgHr < 30 || avgHr > 230)) || (maxHr && (maxHr < 40 || maxHr > 240))) { toast('Heart rate looks wrong (30–240 bpm)', 'warn'); return; }
  const start = new Date(`${date}T${time}:00`);
  const sid = -Math.round(start.getTime() / 1000) - 7; // own id range, never collides with the watch import
  const all = await db.workouts.toArray();
  const same = findSameWorkout(all, +start, dur, () => true);
  if (same) { toast(`Already in your workouts: ${rideTitle(same)}`, 'warn', 4500); closeSheet('squadImportSheet'); return; }
  const indoor = sport === 'swim' ? true : sport === 'ride' ? !!x.indoor_ride : sport === 'other' ? true : !!x.indoor;
  const sportType = sport === 'other' ? (x.gym || 'Workout') : sport === 'ride' && indoor ? 'VirtualRide' : SPORTS[sport].code;
  // A gym session without its own name is called after its activity ("Strength", "Rowing"…)
  const gymLabel = sport === 'other' ? (MANUAL_FIELD_DEFS.gym.options.find(o => o[0] === x.gym) || [])[1] : null;
  if (gymLabel && $('#sqi_title').dataset.auto === '1') $('#sqi_title').value = gymLabel;
  const w = {
    strava_id: sid, ride_number: 0, exercise_code: '', source: d.manual ? 'manual' : 'screenshot', name: $('#sqi_title').value.trim() || SPORTS[sport].label,
    sport, sport_type: sportType, indoor,
    date: `${date} ${time}`, distance_km: round(km, 3), moving_sec: dur, elapsed_sec: dur, duration_str: formatDuration(dur),
    avg_speed_kmh: km > 0 ? round(km / (dur / 3600), 2) : 0, max_speed_kmh: 0, avg_hr: avgHr, max_hr: maxHr,
    elevation_gain_m: indoor ? 0 : int('elev'), kilojoules: 0, calories: int('kcal'),
    avg_power_w: sport === 'ride' ? int('power') : 0, max_power_w: 0, norm_power_w: 0, device_watts: sport === 'ride' && int('power') > 0, map_polyline: '',
    source_name: d.manual ? 'Logged by hand' : 'Screenshot (read by AI)', debrief_stale: false, intent_type: null, zone_seconds: [0, 0, 0, 0, 0]
  };
  if (onFoot(sport) && int('steps')) w.steps = int('steps');
  if (onFoot(sport) && int('cadence_spm')) w.avg_cadence = int('cadence_spm');
  if (sport === 'ride' && int('cadence_rpm')) w.avg_cadence = int('cadence_rpm');
  if (sport === 'other' && int('reps')) w.reps = int('reps');
  if (sport === 'swim') {
    w.pool_m = Number(x.pool) || 25;
    w.main_stroke = x.stroke || 'FREESTYLE';
    if (int('swolf')) w.swolf_manual = int('swolf');
    if (int('strokes')) w.strokes_total = int('strokes');
  }
  if (Squad.manualRpe) w.rpe = Squad.manualRpe;
  const note = $('#sqi_note').value.trim();
  if (note) w.note = note;
  // From screenshots: graphs → stream, lengths → swim model, splits/zones/extras as read (and approved)
  const stream = d.manual ? null : shotApply(w, d, dur);
  w.id = await db.workouts.add(w);
  if (stream) await db.streams.put({ strava_id: w.strava_id, stream_data: stream });
  await ensureRideMetrics(w, stream, true);
  await renumberRides();
  closeSheet('squadImportSheet');
  Squad.importDraft = null;
  haptic('success');
  toast('Workout added — it is in your Training list and shared with the squad', 'success', 4000);
  Squad.lastShare = 0;
  await squadTick(true);
  if (typeof afterWorkoutsChanged === 'function') afterWorkoutsChanged(null);
}

function squadQueueQuiet(cid, kind, body, ref = null) {
  Squad.outbox.push({ cid, ev: { id: squadId(kind[0]), kind, body, ref, author: Squad.data[cid] && Squad.data[cid].me, created_at: new Date().toISOString() } });
}

// Your own numbers before the challenge (for scoring you against yourself)
async function squadBaseline(starts) {
  const end = starts, from = new Date(Date.parse(`${starts}T00:00:00Z`) - 28 * 86400000).toISOString().slice(0, 10);
  const ws = (await db.workouts.toArray()).filter(w => { const d = String(w.date).slice(0, 10); return d >= from && d < end && !isExcluded(w); });
  const metrics = {};
  const avg = (list, fn) => { let s = 0, t = 0; for (const w of list) { const v = fn(w); if (v > 0) { s += v * num(w.moving_sec); t += num(w.moving_sec); } } return t ? s / t : 0; };
  const of = sp => ws.filter(w => sportOf(w) === sp);
  const kmh = w => num(mv(w, 'avg_speed_kmh'));
  if (of('swim').length) metrics.swim = round(avg(of('swim'), w => swimPace100(w)), 1);
  if (of('walk').length) metrics.walk = round(avg(of('walk'), w => (kmh(w) ? 3600 / kmh(w) : 0)), 1);
  if (of('run').length) metrics.run = round(avg(of('run'), w => (kmh(w) ? 3600 / kmh(w) : 0)), 1);
  if (of('ride').length) metrics.ride = round(avg(of('ride').filter(w => !isIndoor(w)), kmh), 2);
  for (const k of Object.keys(metrics)) if (!(metrics[k] > 0)) delete metrics[k];
  const days = new Set(ws.map(w => String(w.date).slice(0, 10))).size;
  return {
    weekly_min: Math.round(sumBy(ws, w => num(w.moving_sec)) / 60 / 4), target_days: Math.max(2, Math.min(6, Math.round(days / 4) || 3)),
    metrics, from, to: end, sports: Object.keys(SPORTS).filter(s => of(s).length)
  };
}

// After importing history (e.g. Huawei): measure the person against his real past again
async function squadRefreshBaselines() {
  for (const c of Squad.list.filter(x => !x.revoked)) {
    const st = Squad.data[c.id];
    if (!st || !st.challenge || !st.me) continue;
    const b = await squadBaseline(st.challenge.starts);
    if (!(b.weekly_min > 0)) continue;
    const mine = (st.members || []).find(m => m.id === st.me);
    if (mine && mine.baseline && mine.baseline.target_days) b.target_days = mine.baseline.target_days;
    try { await squadCall(c, 'PATCH', '/me', { sports: b.sports, baseline: b }); } catch (e) { console.warn('baseline', e.message); }
  }
}

// ---------- state helpers ----------
function squadState(cid) {
  const st = Squad.data[cid];
  if (!st) return null;
  const pending = Squad.outbox.filter(o => o.cid === cid).map((o, i) => Object.assign({ seq: 1e12 + i, pending: true }, o.ev));
  const folded = SquadCore.fold(st.events.concat(pending));
  const members = st.members || [];
  const ch = st.challenge;
  const score = ch ? SquadCore.compute({ starts: ch.starts, ends: ch.ends, rules: ch.rules }, members.filter(m => m.active || Array.from(folded.activities.values()).some(a => a.author === m.id)), Array.from(folded.activities.values()), st.today || new Date().toISOString().slice(0, 10)) : null;
  return { st, ch, members, me: st.me, folded, score, member: id => members.find(m => m.id === id) };
}

function squadUnread(cid) {
  const st = Squad.data[cid];
  if (!st || !st.me) return 0;
  return st.events.filter(e => e.seq > (st.read_seq || 0) && e.author !== st.me && (e.kind === 'msg' || e.kind === 'comment')).length;
}

function squadBadge() {
  const btn = $('.nav-btn[data-tab="squad"]');
  if (!btn) return;
  const n = Squad.list.filter(c => !c.revoked).reduce((s, c) => s + squadUnread(c.id), 0);
  let dot = btn.querySelector('.dot-badge');
  if (n && !dot) { dot = document.createElement('span'); dot.className = 'dot-badge'; btn.appendChild(dot); }
  if (!n && dot) dot.remove();
}

function squadAvatar(m, size = '') {
  const name = m ? m.name : SQUAD_AI;
  const color = m ? m.color : null;
  return m ? `<span class="sq-av ${size}" style="background:${escapeHtml(color)}">${escapeHtml(name.slice(0, 1).toUpperCase())}</span>` : `<span class="sq-av ai ${size}">${icon('sparkle')}</span>`;
}

const squadName = (S, id) => (id === 'ai' ? SQUAD_AI : id === 'system' ? '' : (S.member(id) || { name: 'Someone' }).name);

function squadActStats(a) {
  const p = [];
  if (a.dist_m > 0) p.push(a.sport === 'swim' ? `${a.dist_m} m` : `${fmtNum(a.dist_m / 1000, 2)} km`);
  if (a.dur_s > 0) p.push(formatDuration(a.dur_s));
  if (a.pace100 > 0) p.push(`${fmtPace(a.pace100)} /100m`);
  if (a.pace_km > 0) p.push(`${fmtPace(a.pace_km)} /km`);
  if (a.speed_kmh > 0) p.push(`${fmtNum(a.speed_kmh, 1)} km/h`);
  if (a.swolf > 0) p.push(`SWOLF ${Math.round(a.swolf)}`);
  if (a.avg_hr > 0) p.push(`${a.avg_hr} bpm`);
  if (a.steps > 0) p.push(`${a.steps} steps`);
  return p;
}

// ---------- SQUAD TAB ----------
async function renderSquad() {
  const host = $('#squadBody');
  if (!host) return;
  const live = Squad.list.filter(c => !c.revoked);
  $('#squadSub').textContent = live.length ? `${live.length} challenge${live.length > 1 ? 's' : ''} · scored against yourself` : 'Train together, scored against yourself';
  if (!live.length) {
    $('#sqShell').classList.add('hidden');
    $('#squadHead').classList.remove('hidden');
    host.innerHTML = `
      <div class="sq-hero card">
        <div class="sq-hero-art">${icon('multi')}</div>
        <div class="card-title">Train together</div>
        <div class="card-sub">Start a challenge with a friend: a shared feed of your workouts, a 3-way chat with ${SQUAD_AI} (ask, review, roast — and it chimes in on its own), and a scoreboard where everyone is measured against his <b>own</b> usual numbers, not each other's.</div>
        <div class="btn-row mt-12">
          <button class="btn btn-primary" onclick="openSquadStart()">${icon('plus')}Start new challenge</button>
          <button class="btn btn-secondary" onclick="openSquadJoin()">${icon('link')}Join with a code</button>
        </div>
        <div class="tiny muted mt-8">Only summaries are shared: numbers, personal bests, how it felt and your coach's one-line verdict. Your streams, notes history and health data stay on your phone.</div>
      </div>`;
    return;
  }
  if (!live.some(c => c.id === Squad.cur)) Squad.cur = live[0].id;
  const S = squadState(Squad.cur);
  if (!S || !S.ch) {
    $('#sqShell').classList.add('hidden');
    host.innerHTML = `<div class="empty">${icon('refresh', 'spin')}<div><b>Loading the challenge…</b></div>${Squad.offline ? '<div class="small mt-8">No connection to the squad server yet.</div>' : ''}</div>`;
    squadSync(Squad.cur);
    return;
  }
  // The squad is its own little app: header with the challenge switcher + its own tab bar
  $('#sqShell').classList.remove('hidden');
  $('#squadHead').classList.add('hidden');
  document.documentElement.style.setProperty('--appbar-h', `${$('#appbar').offsetHeight}px`);
  $('#sqName').textContent = S.ch.name;
  $('#sqDay').textContent = `${S.ch.arc ? `Arc ${S.ch.arc} · ` : ''}${squadDayInfo(S)}${live.length > 1 ? ` · ${live.length} challenges` : ''}`;
  const unread = squadUnread(Squad.cur);
  $('#sqTabs').innerHTML = SQUAD_VIEWS.map(([v, label, ic]) => `<button class="${Squad.view === v ? 'active' : ''}" onclick="squadView('${v}')">${icon(ic, 'ic-sm')}<span>${label}</span>${v === 'chat' && unread ? `<b class="sq-tab-badge">${unread > 9 ? '9+' : unread}</b>` : ''}</button>`).join('');
  const views = { home: squadHomeHtml, feed: squadFeedHtml, stats: squadStatsHtml, report: squadReportHtml, crew: squadCrewHtml };
  host.innerHTML = (views[Squad.view] || squadHomeHtml)(S);
  if (Squad.view === 'stats') renderSquadStatsCharts(S);
  if (Squad.view === 'report') renderSquadReportCharts(S);
}

const SQUAD_VIEWS = [['home', 'Home', 'activity'], ['chat', 'Chat', 'chat'], ['feed', 'Feed', 'multi'], ['stats', 'Stats', 'trend'], ['report', 'Report', 'report'], ['crew', 'Crew', 'user']];

function squadView(v) {
  if (v === 'chat') { openSquadChat(); return; }
  if (Squad.view === v) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  Squad.view = v;
  try { localStorage.setItem('rp_squad_view', v); } catch (e) {}
  haptic('light');
  window.scrollTo({ top: 0 });
  renderSquad();
  animateIn($('#squadBody'));
}

async function squadSwitch(cid) {
  closeSheet('squadSwitchSheet');
  Squad.cur = cid;
  await setConfig('squad_current', cid);
  renderSquad();
  squadSync(cid);
}

function openSquadSwitcher() {
  const live = Squad.list.filter(c => !c.revoked);
  $('#squadSwitchList').innerHTML = live.map(c => {
    const st = Squad.data[c.id];
    const ch = st && st.challenge;
    const n = squadUnread(c.id);
    return `<button class="pick-row ${c.id === Squad.cur ? 'active' : ''}" onclick="squadSwitch('${c.id}')">${icon('multi')}<span class="grow"><b>${escapeHtml(c.name)}</b><span class="tiny muted">${ch ? `${escapeHtml(ch.starts)} → ${escapeHtml(ch.ends || 'open')} · ${(st.members || []).filter(m => m.active).length} people` : ''}</span></span>${n ? `<span class="badge badge-new">${n}</span>` : ''}</button>`;
  }).join('');
  openSheet('squadSwitchSheet');
}

// ---------- HOME ----------
function squadTodayHtml(S) {
  const today = S.st.today;
  const acts = Array.from(S.folded.activities.values());
  const ms = S.members.filter(m => m.active);
  return `<div class="sq-today">${ms.map(m => {
    const mine = acts.filter(a => a.author === m.id && a.date === today);
    return `<div class="sq-today-p ${mine.length ? 'done' : ''}">${squadAvatar(m, 'sm')}<div class="grow"><b>${escapeHtml(m.id === S.me ? 'You' : m.name)}</b><div class="tiny muted">${mine.length ? mine.map(a => `${(SPORTS[a.sport] || SPORTS.other).label} ${formatDuration(a.dur_s || 0)}`).join(' + ') : 'not yet today'}</div></div>${mine.length ? `<span class="sq-tick">${icon('check-circle', 'ic-sm')}</span>` : ''}</div>`;
  }).join('')}</div>`;
}

// ---------- ARCS (a new arc resets scores, feed and chat; everyone has to agree) ----------
const squadInArc = (S, a) => !S.ch.arc || a.date >= S.ch.starts;
const squadArcEvent = (S, e) => !S.ch.arc || e.seq >= (S.ch.arc_seq || 0);

function squadArcBannerHtml(S) {
  const v = S.ch.arc_vote;
  if (!v) return '';
  const ms = S.members.filter(m => m.active);
  const mine = v.by.includes(S.me);
  const waiting = ms.filter(m => !v.by.includes(m.id));
  return `<div class="card sq-arc-vote">
    <div class="sq-arc-vote-k">🏁 New arc proposed</div>
    <div class="sq-arc-vote-t">Start Arc ${v.arc}?</div>
    <div class="small">${escapeHtml(squadName(S, v.proposer))} wants a fresh start: scores, streaks, feed and chat reset${S.ch.arc ? `, and Arc ${S.ch.arc} gets its own report${S.ch.ai && S.ch.ai.enabled ? ` with ${SQUAD_AI}'s full analysis` : ''}` : ''}. Starts the moment everyone approves.</div>
    <div class="sq-arc-votes">${ms.map(m => `<span class="${v.by.includes(m.id) ? 'ok' : ''}">${squadAvatar(m, 'xs')}${escapeHtml(m.id === S.me ? 'You' : m.name)} ${v.by.includes(m.id) ? '✓' : '⏳'}</span>`).join('')}</div>
    <div class="${mine ? 'row between mt-8' : 'btn-row mt-8'}">${mine
      ? `<span class="tiny muted">Waiting for ${escapeHtml(waiting.map(m => m.name).join(', '))}…</span><button class="btn btn-ghost btn-sm" onclick="squadArc('cancel')">Call it off</button>`
      : `<button class="btn btn-primary btn-sm" onclick="squadArc('approve')">${icon('check')}Approve</button><button class="btn btn-ghost btn-sm" onclick="squadArc('cancel')">Not now</button>`}</div>
  </div>`;
}

async function squadArc(action) {
  const S = squadState(Squad.cur);
  const c = squadEntry(Squad.cur);
  if (!S || !S.ch || !c) return;
  const next = (S.ch.arc || 0) + 1;
  if (action === 'propose') {
    const solo = S.members.filter(m => m.active).length < 2;
    const ok = await uiConfirm(`Start Arc ${next}?`, `${S.ch.arc ? `Arc ${S.ch.arc} gets archived with its own report and ${SQUAD_AI}'s full analysis. ` : ''}Scores, streaks, the feed and the chat start fresh from today.${solo ? '' : ' Everyone in the challenge has to approve first.'}`, { okText: solo ? `Start Arc ${next}` : 'Ask for approval' });
    if (!ok) return;
  }
  try {
    const r = await squadCall(c, 'POST', '/arc', { action });
    haptic(r.started ? 'heavy' : 'light');
    if (!r.started) toast(action === 'cancel' ? 'Arc vote called off' : 'Waiting for the others to approve', 'info');
  } catch (e) { toast(`Arc: ${e.message}`, 'error'); }
  await squadSync(Squad.cur);
  renderSquad();
}

// Full-screen "ARC N" moment, shown once per device when a new arc starts
function squadArcCelebrate(cid, n, prev) {
  const S = squadState(cid);
  if (!S || !S.ch) return;
  const old = document.getElementById('arcFx');
  if (old) old.remove();
  const ms = S.members.filter(m => m.active);
  const el = document.createElement('div');
  el.id = 'arcFx';
  el.className = 'arc-fx';
  el.innerHTML = `<canvas></canvas><div class="arc-fx-flash"></div>
    <div class="arc-fx-in">
      <div class="arc-fx-kicker">${escapeHtml(S.ch.name)}${prev ? ` · Arc ${prev} is in the books` : ''}</div>
      <div class="arc-fx-word">ARC</div>
      <div class="arc-fx-num">${n}</div>
      <div class="arc-fx-duel">${ms.map((m, i) => `${i ? '<span class="arc-fx-vs">vs</span>' : ''}<div class="arc-fx-p" style="--d:${i}">${squadAvatar(m, 'lg')}<b>${escapeHtml(m.name)}</b><span>0 pts</span></div>`).join('')}</div>
      <div class="arc-fx-sub">${prev ? `Scores, streaks and the chat start fresh. ${S.ch.ai && S.ch.ai.enabled ? `${SQUAD_AI} is writing the full report of Arc ${prev}.` : `Arc ${prev}'s report waits in the Report tab.`}` : 'Scores, streaks and the chat start fresh. Everyone against his own usual. Go.'}</div>
      <div class="arc-fx-btns"><button class="btn btn-primary" data-go>Let's go</button>${prev ? `<button class="btn btn-secondary" data-report>Arc ${prev} report</button>` : ''}</div>
    </div>`;
  document.body.appendChild(el);
  haptic('heavy');
  const born = Date.now();
  let alive = true;
  const close = report => {
    if (!alive) return;
    alive = false;
    el.classList.add('out');
    setTimeout(() => el.remove(), 450);
    Squad.cur = cid;
    Squad.view = report ? 'report' : 'home';
    if (report) Squad.month = `arc:${prev}`;
    if (Router.current !== 'squad') switchTab('squad'); else renderSquad();
  };
  el.addEventListener('click', ev => {
    const b = ev.target.closest('button');
    if (b) close(b.hasAttribute('data-report'));
    else if (Date.now() - born > 2600) close(false);
  });
  // Particles: a shockwave of sparks in everyone's colours, then confetti rain
  const cv = el.querySelector('canvas');
  const ctx = cv.getContext('2d');
  if (!ctx || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const fit = () => { cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; };
  fit();
  const colors = ms.map(m => m.color).concat(['#fc5200', '#ffd166', '#ffffff']);
  const parts = [];
  const burst = (k, speed) => {
    const cx = cv.width / 2, cy = cv.height * 0.42;
    for (let i = 0; i < k; i++) {
      const a = Math.random() * Math.PI * 2, v = (speed * (0.35 + Math.random())) * dpr;
      parts.push({ x: cx, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v, r: (1.5 + Math.random() * 3.5) * dpr, c: colors[i % colors.length], life: 1, decay: 0.006 + Math.random() * 0.012, spin: Math.random() * 6, rect: Math.random() < 0.55 });
    }
  };
  const rain = () => {
    for (let i = 0; i < 2; i++) parts.push({ x: Math.random() * cv.width, y: -10 * dpr, vx: (Math.random() - 0.5) * 1.5 * dpr, vy: (1.5 + Math.random() * 2.5) * dpr, r: (2 + Math.random() * 3) * dpr, c: colors[Math.floor(Math.random() * colors.length)], life: 1, decay: 0.003, spin: Math.random() * 6, rect: true });
  };
  setTimeout(() => burst(160, 14), 650);
  setTimeout(() => burst(90, 9), 1250);
  let ring = 0;
  const frame = () => {
    if (!alive || !el.isConnected) return;
    if (cv.width !== innerWidth * dpr) fit();
    ctx.clearRect(0, 0, cv.width, cv.height);
    const t = Date.now() - born;
    // Shockwave ring when the number lands
    if (t > 600 && ring < 1) {
      ring = Math.min(1, (t - 600) / 900);
      ctx.beginPath();
      ctx.arc(cv.width / 2, cv.height * 0.42, ring * Math.max(cv.width, cv.height) * 0.75, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(252,82,0,${0.7 * (1 - ring)})`;
      ctx.lineWidth = 10 * dpr * (1 - ring) + 1;
      ctx.stroke();
    }
    if (t > 1400 && t < 5500 && Math.random() < 0.35) rain();
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.x += p.vx; p.y += p.vy; p.vx *= 0.985; p.vy = p.vy * 0.985 + 0.12 * dpr; p.life -= p.decay; p.spin += 0.15;
      if (p.life <= 0 || p.y > cv.height + 20) { parts.splice(i, 1); continue; }
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 1.4));
      ctx.fillStyle = p.c;
      if (p.rect) { ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.spin); ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r); ctx.restore(); }
      else { ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.globalAlpha = 1;
    if (t < 12000 || parts.length) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function squadHomeHtml(S) {
  const acts = Array.from(S.folded.activities.values()).filter(a => squadInArc(S, a)).sort((a, b) => `${b.date}${b.start || ''}`.localeCompare(`${a.date}${a.start || ''}`));
  const recap = S.folded.messages.filter(m => m.author === 'ai' && ['recap', 'final', 'report', 'arc'].includes(m.body.mode) && squadArcEvent(S, m)).pop();
  return `${squadArcBannerHtml(S)}${squadHeroHtml(S)}
    <div class="section-title"><span>Today</span><span class="tiny muted">${escapeHtml(formatNiceDate(S.st.today, false))}</span></div>
    ${squadTodayHtml(S)}
    ${squadChatRowHtml(S)}
    <div class="sq-quick">
      <button onclick="openManualWorkout()">${icon('plus')}<span>Log workout</span></button>
      <button onclick="openSquadImport()">${icon('camera')}<span>Screenshot</span></button>
      <button onclick="openSquadWeight()">${icon('scale')}<span>Log weight</span></button>
      <button onclick="squadAskQuick()">${icon('sparkle')}<span>Ask ${SQUAD_AI}</span></button>
    </div>
    ${squadBoardHtml(S)}
    ${recap ? `<div class="section-title"><span>${SQUAD_AI}'s latest ${recap.body.mode === 'report' ? 'monthly report' : recap.body.mode === 'arc' ? 'arc report' : 'recap'}</span><span class="tiny muted">${escapeHtml(relativeTime(recap.created_at))}</span></div><div class="card sq-recap" onclick="openSquadChat()"><div class="md">${renderMarkdown(recap.body.text)}</div></div>` : ''}
    <div class="section-title"><span>Latest workouts</span>${acts.length > 3 ? `<button class="btn btn-ghost btn-xs" onclick="squadView('feed')">See all ${acts.length}</button>` : ''}</div>
    ${acts.length ? acts.slice(0, 3).map(a => squadActCardHtml(S, a)).join('') : squadNoActsHtml()}`;
}

function squadNoActsHtml() {
  return `<div class="empty">${icon('activity')}<div><b>No workouts yet</b></div><div class="small mt-8">Workouts from the challenge start on appear here automatically after each sync — or add one from a screenshot.</div></div>`;
}

function squadAskQuick() {
  openSquadChat();
  setTimeout(() => squadQuick(`@${SQUAD_AI} `), 350);
}

function squadDayInfo(S) {
  const day = Math.round((Date.parse(`${S.st.today}T00:00:00Z`) - Date.parse(`${S.ch.starts}T00:00:00Z`)) / 86400000);
  const total = S.ch.ends ? Math.round((Date.parse(`${S.ch.ends}T00:00:00Z`) - Date.parse(`${S.ch.starts}T00:00:00Z`)) / 86400000) + 1 : null;
  if (day < 0) return `Starts in ${-day} day${day === -1 ? '' : 's'}`;
  if (total && day >= total) return 'Finished';
  return `Day ${day + 1}${total ? ` of ${total}` : ''} · week ${Math.floor(day / 7) + 1}`;
}

function squadHeroHtml(S) {
  const ms = S.members.filter(m => m.active);
  const sc = S.score;
  const leader = ms.slice().sort((a, b) => (sc.members[b.id] ? sc.members[b.id].total : 0) - (sc.members[a.id] ? sc.members[a.id].total : 0))[0];
  const duel = sc.duels[sc.duels.length - 1];
  const wk = duel && duel.winners.length === 1 ? `${squadName(S, duel.winners[0])} leads week ${duel.week}` : 'This week is level';
  return `<div class="card card-hero sq-top">
    <div class="sq-kicker">${S.ch.arc ? `<b class="sq-arc-tag">Arc ${S.ch.arc}</b> ` : ''}Total points · each against his own usual</div>
    <div class="sq-duel">${ms.map((m, i) => {
      const x = sc.members[m.id] || { total: 0, streak: 0 };
      return `${i ? '<span class="sq-vs">vs</span>' : ''}<div class="sq-duelist ${leader && leader.id === m.id && x.total > 0 ? 'lead' : ''}">${squadAvatar(m, 'lg')}<div class="sq-pts" data-count="${Math.round(x.total)}">${Math.round(x.total)}</div><div class="sq-who">${escapeHtml(m.name)}${m.id === S.me ? ' (you)' : ''}</div><div class="sq-mini">🏆 ${sc.wins[m.id] || 0} · 🔥 ${x.streak} d</div></div>`;
    }).join('')}</div>
    <div class="sq-week-note">${escapeHtml(wk)}</div>
  </div>`;
}

function squadChatRowHtml(S) {
  const last = S.folded.messages[S.folded.messages.length - 1];
  const unread = squadUnread(Squad.cur);
  const typing = Squad.aiBusy[Squad.cur] || (S.ch.ai && S.ch.ai.busy);
  const snippet = typing ? `${SQUAD_AI} is typing…` : last ? `${squadName(S, last.author)}: ${String(last.body.text || '').slice(0, 80)}` : `Say hi — mention @${SQUAD_AI} to bring the AI in`;
  return `<div class="thread-row sq-chat-row" onclick="openSquadChat()">
    <div class="avatar master">${icon('chat')}</div>
    <div class="thread-body"><div class="thread-top"><span class="thread-name">Squad chat <span class="tiny muted">· ${(() => { const o = S.members.filter(m => m.active && m.id !== S.me).map(m => m.name); return o.length ? `you, ${escapeHtml(o.join(', '))} &amp; ${SQUAD_AI}` : 'invite a friend (Crew → Invite)'; })()}</span></span>
    <span class="row" style="gap:6px">${unread ? `<span class="badge badge-new">${unread} new</span>` : ''}<span class="thread-time">${last ? escapeHtml(relativeTime(last.created_at)) : ''}</span></span></div>
    <div class="thread-snippet ${typing ? 'sq-typing' : ''}">${escapeHtml(snippet)}</div></div>
  </div>`;
}

function squadBoardHtml(S) {
  const ms = S.members.filter(m => m.active || S.score.members[m.id]);
  const sc = S.score;
  const cards = ms.map(m => {
    const x = sc.members[m.id];
    if (!x) return '';
    const t = x.this_week;
    const dots = Array.from({ length: Math.max(t.target, t.days) }, (_, i) => `<i class="${i < t.days ? 'on' : ''}"></i>`).join('');
    const imp = t.improvement.length ? t.improvement.map(i => `<span class="${i.pct >= 0 ? 'pos' : 'neg'}">${escapeHtml(i.sport)} ${i.pct >= 0 ? '+' : ''}${i.pct}%</span>`).join(' ') : '<span class="muted">no comparable session yet</span>';
    const bar = (v, max, label, val) => `<div class="sq-bar"><div class="sq-bar-l">${label}</div><div class="sq-bar-t"><i style="width:${Math.min(100, Math.round(v / max * 100))}%;background:${escapeHtml(m.color)}"></i></div><div class="sq-bar-v">${val}</div></div>`;
    return `<div class="card sq-score" style="--mc:${escapeHtml(m.color)}">
      <div class="row between"><div class="row" style="gap:8px">${squadAvatar(m)}<b>${escapeHtml(m.name)}</b></div><div class="sq-week-pts">${Math.round(t.total)}<small> pts this week</small></div></div>
      <div class="sq-days" title="active days vs own target">${dots}<span>${t.days}/${t.target} days</span></div>
      ${bar(t.points.consistency, 40, 'Consistency', `${Math.round(t.points.consistency)}/40`)}
      ${bar(t.points.volume, 30, 'Volume', `${t.volume_pct}% of usual`)}
      ${bar(t.points.improvement, 30, 'Improvement', `${Math.round(t.points.improvement)}/30`)}
      <div class="sq-imp">${imp}</div>
      <div class="sq-badges">${t.pbs ? `<span class="badge badge-intent">⭐ ${t.pbs} PB</span>` : ''}${x.streak >= 3 ? `<span class="badge badge-stale">🔥 ${x.streak}-day streak</span>` : ''}${t.points.bonus ? `<span class="badge badge-ok">+${Math.round(t.points.bonus)} bonus</span>` : ''}${x.baseline_from_challenge ? '<span class="badge badge-play">baseline: first week</span>' : ''}</div>
    </div>`;
  }).join('');
  return `<div class="section-title"><span>This week</span><button class="btn btn-ghost btn-xs" onclick="openSquadRules()">${icon('info', 'ic-sm')}How scoring works</button></div>
    <div class="sq-score-grid">${cards}</div>`;
}

// Week-by-week duel bars (Stats)
function squadDuelBarsHtml(S) {
  const sc = S.score;
  const ms = S.members.filter(m => sc.members[m.id]);
  const maxW = Math.max(1, ...ms.flatMap(m => sc.members[m.id].weeks.map(w => w.total)));
  return `<div class="card sq-weeks">${sc.duels.map((d, i) => `<div class="sq-wk"><div class="sq-wk-l">W${d.week}${d.complete && d.winners.length === 1 ? ` <span title="winner">${squadAvatar(S.member(d.winners[0]), 'xs')}</span>` : ''}</div><div class="sq-wk-bars">${ms.map(m => { const w = sc.members[m.id].weeks[i]; return `<div class="sq-wk-b"><i style="width:${w ? Math.round(w.total / maxW * 100) : 0}%;background:${escapeHtml(m.color)}"></i><span>${w ? Math.round(w.total) : 0}</span></div>`; }).join('')}</div></div>`).join('')}</div>`;
}

function squadReactionsHtml(S, ref) {
  const r = S.folded.reactions[ref] || {};
  const chips = Object.entries(r).map(([e, who]) => `<button class="sq-rx ${who.has(S.me) ? 'mine' : ''}" onclick="event.stopPropagation(); squadReact('${ref}', '${e}')" title="${escapeHtml(Array.from(who).map(id => squadName(S, id)).join(', '))}">${e} ${who.size}</button>`).join('');
  return chips;
}

function squadActCardHtml(S, a, compact) {
  const m = S.member(a.author);
  const sp = SPORTS[a.sport] || SPORTS.other;
  const stats = squadActStats(a);
  const comments = (S.folded.comments[a.ref] || []).length;
  return `<div class="sq-act ${compact ? 'compact' : ''} ${a.pending ? 'pending' : ''}" style="--sc:${sp.color}" onclick="openSquadActivity('${escapeHtml(a.ref)}')">
    <div class="sq-act-head">${squadAvatar(m, 'sm')}<div class="grow"><div class="sq-act-title">${icon(sp.icon, 'ic-sm')}${escapeHtml(a.title || sp.label)}</div><div class="tiny muted">${escapeHtml(m ? m.name : '')} · ${escapeHtml(formatNiceDate(`${a.date} ${a.start || ''}`.trim(), !!a.start))}</div></div>${a.load ? `<span class="sq-load">${a.load}<small>load</small></span>` : ''}</div>
    <div class="sq-act-stats">${stats.map(x => `<span>${escapeHtml(x)}</span>`).join('')}</div>
    ${a.pb && a.pb.length ? `<div class="sq-pb">⭐ Personal best: ${escapeHtml(a.pb.join(' · '))}</div>` : ''}
    ${!compact && a.verdict ? `<div class="sq-verdict">“${escapeHtml(a.verdict)}”</div>` : ''}
    ${!compact && (a.feel || a.rpe || a.note) ? `<div class="tiny muted mt-4">${escapeHtml([a.rpe ? `RPE ${a.rpe}/10` : '', a.feel ? `felt ${a.feel}` : '', a.note ? `“${a.note}”` : ''].filter(Boolean).join(' · '))}</div>` : ''}
    <div class="sq-act-foot">${squadReactionsHtml(S, a.ref)}<span class="grow"></span>${comments ? `<span class="tiny muted">${icon('chat', 'ic-xs')} ${comments}</span>` : ''}</div>
  </div>`;
}

// ---------- FEED ----------
function squadFeedHtml(S) {
  const every = Array.from(S.folded.activities.values());
  const older = every.filter(a => !squadInArc(S, a)).length;
  const all = every.filter(a => Squad.feedAll || squadInArc(S, a)).sort((a, b) => `${b.date}${b.start || ''}`.localeCompare(`${a.date}${a.start || ''}`));
  const f = Squad.feedFilter || 'all';
  const acts = all.filter(a => f === 'all' || a.author === f || a.sport === f);
  const people = S.members.filter(m => all.some(a => a.author === m.id));
  const sports = Object.keys(SPORTS).filter(s => all.some(a => a.sport === s));
  const chip = (v, label) => `<button class="chip ${f === v ? 'active' : ''}" onclick="Squad.feedFilter='${v}'; renderSquad()">${label}</button>`;
  // Group by day for a readable timeline
  let html = '', day = '';
  for (const a of acts.slice(0, 80)) {
    if (a.date !== day) { day = a.date; html += `<div class="month-head"><span>${escapeHtml(formatNiceDate(a.date, false))}</span></div>`; }
    html += squadActCardHtml(S, a);
  }
  return `<div class="row between mb-8"><div class="tiny muted">${acts.length} workout${acts.length === 1 ? '' : 's'}</div><button class="btn btn-secondary btn-xs" onclick="openSquadImport()">${icon('camera', 'ic-sm')}Add from screenshot</button></div>
    <div class="chip-rack mb-8">${chip('all', 'All')}${people.map(m => chip(m.id, escapeHtml(m.id === S.me ? 'Me' : m.name))).join('')}${sports.map(s => chip(s, `${icon(SPORTS[s].icon, 'ic-sm')}${SPORTS[s].plural}`)).join('')}</div>
    ${html || squadNoActsHtml()}
    ${older ? `<div class="center mt-12"><button class="btn btn-ghost btn-sm" onclick="Squad.feedAll=!Squad.feedAll; renderSquad()">${Squad.feedAll ? `Only Arc ${S.ch.arc}` : `Show ${older} from earlier arcs`}</button></div>` : ''}`;
}

// ---------- CREW ----------
function squadCrewHtml(S) {
  const sc = S.score;
  const acts = Array.from(S.folded.activities.values());
  const r = S.ch.rules || {};
  const ai = S.ch.ai || {};
  const metricText = (sp, v) => (sp === 'ride' ? `${fmtNum(v, 1)} km/h` : sp === 'swim' ? `${fmtPace(v)} /100 m` : `${fmtPace(v)} /km`);
  const people = S.members.map(m => {
    const x = sc.members[m.id];
    const b = m.baseline || {};
    const mine = acts.filter(a => a.author === m.id && squadInArc(S, a));
    const pbs = mine.flatMap(a => (a.pb || []).map(p => `${p} · ${formatNiceDate(a.date, false)}`));
    const sharesWellness = Object.keys(S.folded.daily[m.id] || {}).length > 0;
    return `<div class="card sq-crew ${m.active ? '' : 'left'}" style="--mc:${escapeHtml(m.color)}">
      <div class="row" style="gap:10px">${squadAvatar(m, 'lg')}<div class="grow"><div class="sq-crew-name">${escapeHtml(m.name)}${m.id === S.me ? ' <span class="tiny muted">(you)</span>' : ''}${m.id === S.ch.owner ? ' <span class="badge badge-intent">owner</span>' : ''}${m.active ? '' : ' <span class="badge badge-play">left</span>'}</div>
        <div class="tiny muted">${(m.sports || []).map(s => SPORTS[s] ? SPORTS[s].plural : s).join(' · ') || 'sports not set'}${m.last_seen && m.id !== S.me ? ` · seen ${escapeHtml(relativeTime(m.last_seen))}` : ''}</div></div></div>
      <div class="sq-crew-stats">
        <div><b>${x ? Math.round(x.total) : 0}</b><span>points</span></div><div><b>${sc.wins[m.id] || 0}</b><span>weeks won</span></div>
        <div><b>${mine.length}</b><span>workouts</span></div><div><b>${x ? x.best_streak : 0}</b><span>best streak</span></div>
      </div>
      <div class="sq-crew-base"><span class="tiny muted">Measured against his own usual:</span> ${b.target_days || r.days_per_week || 4} days/week${x && x.weekly_min ? ` · ${x.weekly_min} min/week` : ''}${Object.entries(b.metrics || {}).map(([sp, v]) => ` · ${SPORTS[sp] ? SPORTS[sp].label.toLowerCase() : sp} ${metricText(sp, v)}`).join('')}${x && x.baseline_from_challenge ? ' <span class="tiny muted">(from the first week)</span>' : ''}</div>
      ${pbs.length ? `<div class="sq-crew-pbs">${pbs.slice(-4).map(p => `<span>⭐ ${escapeHtml(p)}</span>`).join('')}</div>` : ''}
      ${sharesWellness ? `<div class="tiny muted mt-4">${icon('heart', 'ic-xs')} shares body &amp; wellness trends</div>` : ''}
    </div>`;
  }).join('');
  const next = (S.ch.arc || 0) + 1;
  const past = (S.ch.arcs || []).filter(a => a && a.n).slice().reverse();
  return `${squadArcBannerHtml(S)}${people}
    <div class="card sq-arc-card mt-12">
      <div class="card-title">🏁 Arcs</div>
      <div class="card-sub">${S.ch.arc ? `You're in <b>Arc ${S.ch.arc}</b> since ${escapeHtml(formatNiceDate(S.ch.starts, false))}.` : 'Kick off Arc 1 when you are all ready.'} A new arc resets scores, streaks, the feed and the chat${S.ch.arc ? `, and ${SQUAD_AI} writes a thorough report of the arc that ends` : ''}. Everyone has to approve.</div>
      ${past.length ? `<div class="sq-arc-list">${past.map(a => `<button class="pick-row" onclick="Squad.month='arc:${a.n}'; squadView('report')"><span class="sq-arc-n">${a.n}</span><span class="grow"><b>Arc ${a.n}</b><span class="tiny muted">${escapeHtml(formatNiceDate(a.from, false))} → ${escapeHtml(formatNiceDate(a.to, false))}</span></span>${icon('report', 'ic-sm')}</button>`).join('')}</div>` : ''}
      <div class="btn-row mt-12"><button class="btn btn-primary btn-sm" ${S.ch.arc_vote ? 'disabled' : ''} onclick="squadArc('propose')">${icon('flag', 'ic-sm')}Start Arc ${next}</button>${S.ch.arc_vote ? '<span class="tiny muted">vote running ↑</span>' : ''}</div>
    </div>
    <div class="card mt-12">
      <div class="card-title">${icon('flag')}The challenge</div>
      <div class="kv-grid mt-8">
        <div class="kv"><span class="k">Dates</span><span class="v">${escapeHtml(S.ch.starts)} → ${escapeHtml(S.ch.ends || 'open')}</span></div>
        <div class="kv"><span class="k">Default target</span><span class="v">${r.days_per_week || 4} days/week</span></div>
        <div class="kv"><span class="k">Roast level</span><span class="v">${{ off: 'Nice', mild: 'Mild 🌶', spicy: 'Spicy 🌶🌶🌶' }[r.roast || 'mild']}</span></div>
        <div class="kv"><span class="k">Daily recap</span><span class="v">${r.recap === false ? 'off' : `${r.recap_hour ?? 21}:00`}</span></div>
        <div class="kv"><span class="k">${SQUAD_AI}</span><span class="v">${ai.enabled ? escapeHtml(`${ai.model}`) : 'off'}</span></div>
        <div class="kv"><span class="k">Chimes in</span><span class="v">${r.interrupts === false ? 'only when asked' : 'max 4×/day'}</span></div>
      </div>
      <div class="btn-row mt-12"><button class="btn btn-secondary btn-sm" onclick="openSquadRules()">${icon('info', 'ic-sm')}Scoring</button><button class="btn btn-secondary btn-sm" onclick="openSquadSettings()">${icon('target', 'ic-sm')}Settings</button></div>
    </div>
    <div class="card sq-invite mt-12">
      <div class="card-title">${icon('link')}Invite</div>
      <div class="card-sub">Send this code (or the link) to a friend. Up to 6 people.</div>
      <div class="sq-code">${escapeHtml(S.ch.invite.slice(0, 4))}-${escapeHtml(S.ch.invite.slice(4))}</div>
      <div class="btn-row"><button class="btn btn-secondary btn-sm" onclick="squadShareInvite()">${icon('share')}Share invite</button><button class="btn btn-secondary btn-sm" onclick="openSquadStart()">${icon('plus')}New challenge</button></div>
    </div>
    <div class="tiny muted center mt-8">${Squad.offline ? 'Offline — your posts are kept and sent when the connection is back.' : 'Up to date'}</div>`;
}

// ---------- CHAT PANEL ----------
async function openSquadChat() {
  if (!Squad.cur) return;
  openPanel('squadChat', () => { Squad.replyTo = null; squadSchedule(); if (Router.current === 'squad') renderSquad(); });
  squadRenderChat(true);
  squadSchedule(300);
}

function squadDaySep(iso) {
  const d = parseSafeDate(iso);
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
}

function squadMsgHtml(S, e) {
  const b = e.body || {};
  if (e.kind === 'system') {
    const who = b.member ? squadName(S, b.member) : '';
    if (b.type === 'arc_started') return `<div class="sq-sys sq-sys-arc"><b>🏁 Arc ${b.arc} started</b><span>${b.prev ? `Arc ${b.prev.n} (${escapeHtml(b.prev.from)} → ${escapeHtml(b.prev.to)}) is archived · ` : ''}scores, streaks and chat start fresh</span></div>`;
    const text = b.type === 'joined' ? `${who} joined the challenge` : b.type === 'left' ? `${b.name || who} left` : b.type === 'created' ? `${who} started “${b.name || S.ch.name}”` : b.type === 'settings' ? `${who} changed the challenge settings` : b.type === 'ai' ? `${who} ${b.enabled ? 'set up' : 'switched off'} ${SQUAD_AI}`
      : b.type === 'arc_vote' ? `${who} ${b.by && b.by.length > 1 ? 'approved' : 'proposed'} Arc ${b.arc} (${(b.by || []).length}/${S.members.filter(m => m.active).length} approved)` : b.type === 'arc_cancel' ? `${who} called off the Arc ${b.arc} vote` : b.text || '';
    return text ? `<div class="sq-sys ${b.type === 'ai_error' ? 'err' : ''}">${escapeHtml(text)}</div>` : '';
  }
  const mine = e.author === S.me, ai = e.author === 'ai';
  const m = S.member(e.author);
  const replyId = b.reply_to || (e.ref && !String(e.ref).startsWith('act:') ? e.ref : null);
  const replied = replyId && S.folded.messages.find(x => x.id === replyId);
  const target = b.target || (b.ai && b.ai.ref) || (e.ref && String(e.ref).startsWith('act:') ? e.ref : null);
  const act = target && S.folded.activities.get(target);
  const modeChip = ai && b.mode ? `<span class="sq-mode m-${escapeHtml(b.mode)}">${{ roast: '🔥 Roast', review: '🔍 Review', recap: '📋 Daily recap', final: '🏁 Final recap', interrupt: '💬 Chimed in', report: '📊 Monthly report', arc: '🏁 Arc report', ask: '' }[b.mode] || ''}</span>` : '';
  const askChip = b.ai ? `<span class="sq-mode m-ask">${b.ai.mode === 'roast' ? '🔥 asked for a roast' : b.ai.mode === 'review' ? '🔍 asked for a review' : `@${SQUAD_AI}`}</span>` : '';
  return `<div class="sq-msg ${mine ? 'mine' : ai ? 'ai' : 'theirs'} ${e.pending ? 'pending' : ''}" onclick="openSquadMsg('${e.id}')">
    ${mine ? '' : squadAvatar(ai ? null : m, 'sm')}
    <div class="sq-bub">
      ${mine ? '' : `<div class="sq-from" style="color:${ai ? 'var(--brand)' : escapeHtml(m ? m.color : 'var(--muted)')}">${escapeHtml(squadName(S, e.author))}${modeChip}</div>`}
      ${replied ? `<div class="sq-quote"><b>${escapeHtml(squadName(S, replied.author))}</b> ${escapeHtml(String(replied.body.text || '').slice(0, 90))}</div>` : ''}
      ${act ? `<div class="sq-quote act">${icon((SPORTS[act.sport] || SPORTS.other).icon, 'ic-xs')} ${escapeHtml(squadName(S, act.author))}'s ${escapeHtml(act.title || act.sport)} · ${escapeHtml(squadActStats(act).slice(0, 2).join(' · '))}</div>` : ''}
      <div class="md">${ai ? renderMarkdown(b.text || '') : escapeHtml(b.text || '').replace(/\n/g, '<br>')}${mine && askChip ? ` ${askChip}` : ''}</div>
      <div class="sq-time">${escapeHtml(parseSafeDate(e.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))}${e.pending ? ' · sending' : ''}</div>
      ${S.folded.reactions[e.id] ? `<div class="sq-rx-row">${squadReactionsHtml(S, e.id)}</div>` : ''}
    </div>
  </div>`;
}

function squadRenderChat(forceBottom) {
  const panel = $('#squadChat');
  if (!panel || !panel.classList.contains('open')) return;
  const S = squadState(Squad.cur);
  if (!S || !S.ch) return;
  const body = $('#squadChatBody');
  const atBottom = forceBottom || body.scrollHeight - body.scrollTop - body.clientHeight < 80;
  $('#squadChatTitle').textContent = S.ch.name;
  const others = S.members.filter(m => m.active && m.id !== S.me);
  $('#squadChatSub').textContent = others.length ? others.map(m => `${m.name}${m.last_seen ? ` · seen ${relativeTime(m.last_seen)}` : ''}`).join(' · ') : 'Share the invite code to bring a friend in';
  // Chat timeline: messages, system notes and shared workouts, in server order
  const timeline = S.st.events.concat(Squad.outbox.filter(o => o.cid === Squad.cur).map((o, i) => Object.assign({ seq: 1e12 + i, pending: true }, o.ev)))
    .filter(e => e.kind === 'msg' || e.kind === 'system' || e.kind === 'activity')
    .sort((a, b) => a.seq - b.seq);
  // A new arc starts with a clean chat; earlier arcs stay one tap away
  const items = Squad.chatAll ? timeline : timeline.filter(e => squadArcEvent(S, e));
  const hidden = timeline.length - items.length;
  const shownActs = new Set();
  let html = hidden || Squad.chatAll && S.ch.arc ? `<div class="center"><button class="btn btn-ghost btn-xs" onclick="Squad.chatAll=!Squad.chatAll; squadRenderChat(false)">${Squad.chatAll ? `Hide earlier arcs` : `Show ${hidden} earlier message${hidden === 1 ? '' : 's'} (before Arc ${S.ch.arc})`}</button></div>` : '', lastDay = '';
  for (const e of items) {
    if (S.folded.deleted.has(e.id)) continue;
    const day = String(e.created_at).slice(0, 10);
    if (day !== lastDay) { html += `<div class="sq-day">${escapeHtml(squadDaySep(e.created_at))}</div>`; lastDay = day; }
    if (e.kind === 'activity') {
      const ref = SquadCore.actRef(e.author, e.body.key);
      const a = S.folded.activities.get(ref);
      if (!a || shownActs.has(ref) || a.seq !== e.seq && !e.pending) continue; // newest version only
      shownActs.add(ref);
      html += `<div class="sq-msg act-msg">${squadActCardHtml(S, a, true)}</div>`;
    } else html += squadMsgHtml(S, e);
  }
  if (!items.length) html = `<div class="empty">${icon('chat')}<div><b>Start the banter</b></div><div class="small mt-8">Mention @${SQUAD_AI} to ask the AI anything. Tap a message or a workout to react, reply, or ask for a review or a roast.</div></div>`;
  const typing = Squad.aiBusy[Squad.cur] || (S.ch.ai && S.ch.ai.busy);
  if (typing) html += `<div class="sq-msg ai">${squadAvatar(null, 'sm')}${typingHtml(`${SQUAD_AI} is typing`)}</div>`;
  $('#squadChatList').innerHTML = html;
  $('#squadReplyBar').classList.toggle('hidden', !Squad.replyTo);
  if (Squad.replyTo) {
    const r = S.folded.messages.find(x => x.id === Squad.replyTo);
    $('#squadReplyText').textContent = r ? `${squadName(S, r.author)}: ${String(r.body.text || '').slice(0, 80)}` : '';
  }
  $('#squadAiNote').classList.toggle('hidden', !!(S.ch.ai && S.ch.ai.enabled));
  if (atBottom) body.scrollTop = body.scrollHeight;
  // Everything visible counts as read
  if (S.st.seq > (S.st.read_seq || 0)) { S.st.read_seq = S.st.seq; squadPersist(Squad.cur); squadBadge(); }
}

function squadRenderLive(cid) {
  if (cid !== Squad.cur) { squadBadge(); return; }
  squadRenderChat(false);
  if (Router.current === 'squad' && !$('#squadChat').classList.contains('open')) renderSquad();
  if (Squad.actRef && $('#squadActSheet').classList.contains('open')) squadRenderActivity();
}

function sendSquadMessage(aiMode, aiRef) {
  const input = $('#squadInput');
  const text = input.value.trim();
  if (!text && !aiMode) return;
  const body = { text };
  if (Squad.replyTo) body.reply_to = Squad.replyTo;
  if (aiMode) body.ai = { mode: aiMode, ref: aiRef || null };
  else if (new RegExp(`(^|\\s)@(ai|${SQUAD_AI})\\b`, 'i').test(text)) body.ai = { mode: 'ask', ref: null };
  squadQueue(Squad.cur, 'msg', body, Squad.replyTo || null);
  input.value = '';
  autoGrow(input);
  Squad.replyTo = null;
  haptic('light');
  squadRenderChat(true);
}

function squadQuick(text) {
  const input = $('#squadInput');
  input.value = text;
  autoGrow(input);
  input.focus();
}

// ---------- message / activity actions ----------
function openSquadMsg(id) {
  const S = squadState(Squad.cur);
  const e = S && S.folded.messages.find(x => x.id === id);
  if (!e) return;
  Squad.msgId = id;
  const mine = e.author === S.me;
  $('#squadMsgPreview').innerHTML = `<b>${escapeHtml(squadName(S, e.author))}</b> ${escapeHtml(String(e.body.text || '').slice(0, 160))}`;
  $('#squadMsgReacts').innerHTML = SQUAD_REACTIONS.map(r => `<button class="sq-rx-pick" onclick="squadReact('${id}', '${r}'); closeSheet('squadMsgSheet')">${r}</button>`).join('');
  $('#squadMsgActions').innerHTML = `
    <button class="btn btn-secondary btn-sm" onclick="squadReplyTo('${id}')">${icon('chat', 'ic-sm')}Reply</button>
    ${e.author !== 'ai' ? `<button class="btn btn-secondary btn-sm" onclick="squadAskAbout('review', '${id}')">🔍 Ask ${SQUAD_AI} to review</button><button class="btn btn-secondary btn-sm" onclick="squadAskAbout('roast', '${id}')">🔥 Roast it</button>` : ''}
    ${mine || (e.author === 'ai' && S.ch.is_owner) ? `<button class="btn btn-danger btn-sm" onclick="squadDelete('${id}')">${icon('trash', 'ic-sm')}Delete</button>` : ''}`;
  openSheet('squadMsgSheet');
}

function squadReplyTo(id) {
  closeSheet('squadMsgSheet');
  Squad.replyTo = id;
  squadRenderChat(false);
  $('#squadInput').focus();
}

function squadAskAbout(mode, ref) {
  closeSheet('squadMsgSheet');
  closeSheet('squadActSheet');
  const S = squadState(Squad.cur);
  const act = ref.startsWith('act:') && S.folded.activities.get(ref);
  const who = act ? squadName(S, act.author) : '';
  const text = mode === 'roast' ? (act ? `🔥 Roast ${act.author === S.me ? 'my' : `${who}'s`} ${act.title || act.sport}` : '🔥 Roast this') : (act ? `🔍 Review ${act.author === S.me ? 'my' : `${who}'s`} ${act.title || act.sport}` : '🔍 Review this');
  squadQueue(Squad.cur, 'msg', { text, ai: { mode, ref } }, ref.startsWith('act:') ? null : ref);
  if (!$('#squadChat').classList.contains('open')) openSquadChat();
  haptic('light');
}

function squadReact(ref, emoji) {
  const S = squadState(Squad.cur);
  const on = !((S.folded.reactions[ref] || {})[emoji] || new Set()).has(S.me);
  squadQueue(Squad.cur, 'reaction', { emoji, on }, ref);
  haptic('light');
}

async function squadDelete(id) {
  closeSheet('squadMsgSheet');
  if (!(await uiConfirm('Delete message?', 'It disappears for everyone in the challenge.', { okText: 'Delete', danger: true }))) return;
  const pendingIdx = Squad.outbox.findIndex(o => o.ev.id === id);
  if (pendingIdx >= 0) { Squad.outbox.splice(pendingIdx, 1); await squadSaveOutbox(); squadRenderLive(Squad.cur); return; }
  squadQueue(Squad.cur, 'delete', {}, id);
}

function openSquadActivity(ref) {
  Squad.actRef = ref;
  squadRenderActivity();
  openSheet('squadActSheet', () => { Squad.actRef = null; });
}

function squadRenderActivity() {
  const S = squadState(Squad.cur);
  const a = S && S.folded.activities.get(Squad.actRef);
  if (!a) { closeSheet('squadActSheet'); return; }
  const m = S.member(a.author);
  const kv = (k, v) => (v ? `<div class="kv"><span class="k">${k}</span><span class="v">${escapeHtml(v)}</span></div>` : '');
  $('#squadActTitle').textContent = a.title || a.sport;
  $('#squadActSub').textContent = `${m ? m.name : ''} · ${formatNiceDate(`${a.date} ${a.start || ''}`.trim(), !!a.start)}`;
  const comments = (S.folded.comments[a.ref] || []).map(c => `<div class="sq-cmt">${squadAvatar(S.member(c.author), 'xs')}<div><b>${escapeHtml(squadName(S, c.author))}</b> ${escapeHtml(c.body.text)}<div class="tiny muted">${escapeHtml(relativeTime(c.created_at))}${c.pending ? ' · sending' : ''}</div></div></div>`).join('');
  $('#squadActBody').innerHTML = `
    <div class="kv-grid">
      ${kv('Distance', a.dist_m ? (a.sport === 'swim' ? `${a.dist_m} m` : `${fmtNum(a.dist_m / 1000, 2)} km`) : '')}
      ${kv('Time', a.dur_s ? formatDuration(a.dur_s) : '')}
      ${kv('Pace', a.pace100 ? `${fmtPace(a.pace100)} /100 m` : a.pace_km ? `${fmtPace(a.pace_km)} /km` : '')}
      ${kv('Speed', a.speed_kmh ? `${fmtNum(a.speed_kmh, 1)} km/h` : '')}
      ${kv('SWOLF', a.swolf ? String(a.swolf) : '')}
      ${kv('Best 100 m', a.best100 ? fmtPace(a.best100) : '')}
      ${kv('Heart rate', a.avg_hr ? `${a.avg_hr} avg${a.max_hr ? ` · ${a.max_hr} max` : ''}` : '')}
      ${kv('Load', a.load ? `${a.load} TRIMP` : '')}
      ${kv('Cadence', a.cadence ? `${a.cadence} spm` : '')}
      ${kv('Steps', a.steps ? String(a.steps) : '')}
      ${kv('Climbing', a.elev_m ? `${a.elev_m} m` : '')}
      ${kv('Felt', [a.rpe ? `RPE ${a.rpe}/10` : '', a.feel || ''].filter(Boolean).join(' · '))}
    </div>
    ${a.pb && a.pb.length ? `<div class="sq-pb mt-8">⭐ Personal best: ${escapeHtml(a.pb.join(' · '))}</div>` : ''}
    ${a.verdict ? `<div class="sq-verdict mt-8">${escapeHtml(m ? m.name : '')}'s coach: “${escapeHtml(a.verdict)}”</div>` : ''}
    ${a.note ? `<div class="small mt-8">Note: “${escapeHtml(a.note)}”</div>` : ''}
    ${a.laps_line ? `<details class="mt-8"><summary class="small">Every length</summary><div class="tiny muted mt-4">${escapeHtml(a.laps_line)}</div></details>` : ''}
    <div class="sq-rx-row mt-12">${SQUAD_REACTIONS.map(r => { const who = ((S.folded.reactions[a.ref] || {})[r]) || new Set(); return `<button class="sq-rx ${who.has(S.me) ? 'mine' : ''}" onclick="squadReact('${escapeHtml(a.ref)}', '${r}')">${r}${who.size ? ` ${who.size}` : ''}</button>`; }).join('')}</div>
    <div class="btn-row mt-12"><button class="btn btn-secondary btn-sm" onclick="squadAskAbout('review', '${escapeHtml(a.ref)}')">🔍 ${SQUAD_AI} review</button><button class="btn btn-secondary btn-sm" onclick="squadAskAbout('roast', '${escapeHtml(a.ref)}')">🔥 Roast</button></div>
    <div class="section-title"><span>Comments</span></div>
    ${comments || '<div class="tiny muted">No comments yet.</div>'}`;
}

function sendSquadComment() {
  const input = $('#squadCommentInput');
  const text = input.value.trim();
  if (!text || !Squad.actRef) return;
  squadQueue(Squad.cur, 'comment', { text }, Squad.actRef);
  input.value = '';
  squadRenderActivity();
}

// ---------- start / join ----------
function squadProviderOptions() {
  const ps = (AI && AI.providers || []).filter(p => p.enabled && p.apiKey && p.model && /^https:\/\//.test(p.baseUrl));
  return ps.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(providerLabel(p))}</option>`).join('');
}

function squadAiConfigFor(pid) {
  const p = providerById(pid);
  if (!p) return null;
  return {
    type: p.type, baseUrl: p.baseUrl, model: p.model, apiKey: p.apiKey, name: p.name,
    version: typeof ANTHROPIC_VERSION !== 'undefined' ? ANTHROPIC_VERSION : '', fallback: typeof CLAUDE_FALLBACK_MODELS !== 'undefined' && CLAUDE_FALLBACK_MODELS.includes(p.model),
    priceIn: num(p.priceIn), priceOut: num(p.priceOut), capUsd: p.paid ? num(AI.capUsd) : 0
  };
}

async function openSquadStart() {
  const today = new Date();
  const iso = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  $('#sqs_name').value = '';
  $('#sqs_me').value = (await getConfig('squad_name')) || ATHLETE.name || '';
  $('#sqs_start').value = iso(today);
  $('#sqs_end').value = iso(new Date(today.getTime() + 27 * 86400000));
  const b = await squadBaseline(iso(today));
  $('#sqs_days').value = String(b.target_days);
  $('#sqs_base').textContent = b.weekly_min ? `Your last 4 weeks: ${b.weekly_min} min/week on ${b.sports.map(s => SPORTS[s].plural.toLowerCase()).join(', ') || '—'}. That's the bar you're measured against.` : 'No workouts in the last 4 weeks: your first challenge week becomes your baseline.';
  $('#sqs_ai').innerHTML = `${squadProviderOptions()}<option value="">No AI for now</option>`;
  const active = activeProvider();
  if (active && $(`#sqs_ai option[value="${active.id}"]`)) $('#sqs_ai').value = active.id;
  $('#sqs_server').value = (await getConfig('squad_server')) || squadServerDefault();
  squadPickRoast('mild');
  openSheet('squadStartSheet');
}

function squadPickRoast(v) {
  $$('#sqs_roast button').forEach(b => b.classList.toggle('active', b.dataset.v === v));
}

async function createSquadChallenge() {
  const btn = $('#sqsCreate');
  const server = $('#sqs_server').value.trim().replace(/\/$/, '');
  const me = $('#sqs_me').value.trim();
  if (!/^https?:\/\//.test(server)) { toast('Enter the squad server address (Settings below)', 'warn'); return; }
  if (!me) { toast('Enter your name', 'warn'); return; }
  setBusy(btn, true, 'Creating…');
  try {
    const starts = $('#sqs_start').value;
    const baseline = await squadBaseline(starts);
    baseline.target_days = Number($('#sqs_days').value) || baseline.target_days;
    const roast = ($('#sqs_roast button.active') || {}).dataset ? $('#sqs_roast button.active').dataset.v : 'mild';
    const r = await squadApi(server, 'POST', '/api/challenges', {
      name: $('#sqs_name').value.trim() || `${me}'s challenge`, starts, ends: $('#sqs_end').value || null,
      tz_offset: -new Date().getTimezoneOffset(),
      rules: { days_per_week: baseline.target_days, roast },
      member: { name: me, sports: baseline.sports, baseline }
    });
    const entry = { id: r.challenge.id, server, token: r.token, member_id: r.member_id, name: r.challenge.name, auto_share: true, share_notes: true, shared: {} };
    Squad.list.push(entry);
    Squad.cur = entry.id;
    await squadSaveList();
    await setConfig('squad_current', entry.id);
    await setConfig('squad_server', server);
    await setConfig('squad_name', me);
    const pid = $('#sqs_ai').value;
    if (pid) {
      try { await squadCall(entry, 'PUT', '/ai', { config: squadAiConfigFor(pid) }); } catch (e) { toast(`Challenge created, but the AI setup failed: ${e.message}`, 'warn', 5000); }
    }
    closeSheet('squadStartSheet');
    haptic('success');
    if (typeof confetti === 'function') confetti({ particleCount: 90, spread: 70, origin: { y: 0.7 } });
    Squad.lastShare = 0;
    await squadTick(true);
    if (Router.current !== 'squad') switchTab('squad'); else renderSquad();
    setTimeout(squadShareInvite, 600);
  } catch (e) {
    toast(`Could not create the challenge: ${e.message}`, 'error', 5000);
  } finally { setBusy(btn, false); }
}

async function openSquadJoin(code) {
  $('#sqj_code').value = code ? String(code).toUpperCase() : '';
  $('#sqj_me').value = (await getConfig('squad_name')) || (isNative() ? ATHLETE.name : '') || '';
  $('#sqj_server').value = (await getConfig('squad_server')) || squadServerDefault();
  openSheet('squadJoinSheet');
}

async function joinSquadChallenge() {
  const btn = $('#sqjJoin');
  const server = $('#sqj_server').value.trim().replace(/\/$/, '');
  const me = $('#sqj_me').value.trim();
  const code = $('#sqj_code').value.trim();
  if (!/^https?:\/\//.test(server)) { toast('Enter the squad server address', 'warn'); return; }
  const plain = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!me || plain.length !== 8) { toast('Enter your name and the 8-character code', 'warn'); return; }
  // One membership per challenge on a device (two would share one local store)
  const already = Squad.list.find(c => !c.revoked && Squad.data[c.id] && Squad.data[c.id].challenge && Squad.data[c.id].challenge.invite === plain);
  if (already) { toast(`You're already in “${already.name}”`, 'warn'); closeSheet('squadJoinSheet'); squadSwitch(already.id); return; }
  setBusy(btn, true, 'Joining…');
  try {
    // Baseline from before the challenge start (fetched after joining, when we know the date)
    const r = await squadApi(server, 'POST', '/api/join', { invite: plain, member: { name: me } });
    const entry = { id: r.challenge.id, server, token: r.token, member_id: r.member_id, name: r.challenge.name, auto_share: true, share_notes: true, shared: {} };
    // Rejoining after leaving / being removed: start fresh
    Squad.list = Squad.list.filter(c => c.id !== entry.id);
    delete Squad.data[entry.id];
    await db.config.delete(`squad_data_${entry.id}`);
    Squad.list.push(entry);
    Squad.cur = entry.id;
    await squadSaveList();
    await setConfig('squad_current', entry.id);
    await setConfig('squad_server', server);
    await setConfig('squad_name', me);
    // A fresh web app gets its owner's name from joining (the personal coach uses it too)
    if (!(await getConfig('athlete_name'))) { await setConfig('athlete_name', me); await loadPhysioConfig(); $('#brandSub').textContent = `Coach for ${ATHLETE.name}`; }
    const baseline = await squadBaseline(r.challenge.starts);
    await squadCall(entry, 'PATCH', '/me', { sports: baseline.sports, baseline }).catch(() => {});
    if (location.hash.includes('join=')) history.replaceState(null, '', location.pathname + location.search);
    closeSheet('squadJoinSheet');
    haptic('success');
    toast(`You're in “${r.challenge.name}”`, 'success');
    Squad.lastShare = 0;
    await squadTick(true);
    if ($('#introPanel') && $('#introPanel').classList.contains('open')) renderIntro();
    else if (Router.current !== 'squad') switchTab('squad'); else renderSquad();
  } catch (e) {
    toast(`Could not join: ${e.message}`, 'error', 5000);
  } finally { setBusy(btn, false); }
}

async function squadShareInvite() {
  const S = squadState(Squad.cur);
  const c = squadEntry(Squad.cur);
  if (!S || !S.ch || !c) return;
  const code = `${S.ch.invite.slice(0, 4)}-${S.ch.invite.slice(4)}`;
  const link = `${c.server}/#join=${code}`;
  const text = `Join my training challenge “${S.ch.name}” on Training Partner!\n\nOn iPhone/any phone: open ${link} in Safari, then Share → Add to Home Screen.\nIn the Android app: Squad → Join with a code → ${code}`;
  const Share = capPlugin('Share');
  try {
    if (Share) await Share.share({ title: 'Training challenge', text });
    else if (navigator.share) await navigator.share({ title: 'Training challenge', text });
    else { await navigator.clipboard.writeText(text); toast('Invite copied', 'success'); }
  } catch (e) { /* share sheet closed */ }
}

// ---------- settings ----------
function openSquadRules() {
  const W = SquadCore.WEIGHTS;
  $('#squadRulesBody').innerHTML = renderMarkdown(`Everyone is scored **against himself** — different bodies, sports and starting points never decide the winner.

- **Consistency (${W.consistency})**: active days this week vs **your own** target days. Going over your target adds a small bonus.
- **Volume (${W.volume})**: minutes this week vs **your own** usual weekly minutes (from the 4 weeks before the challenge, or your first challenge week). 100 % = 20 points, 150 % = full points.
- **Improvement (${W.improvement})**: your pace vs **your own** usual — swim pace /100 m, walk and run pace /km, ride speed. 5 % better = full points, same as usual = half.
- **Bonuses**: personal bests +5 each (max 15/week), streak days of 3+ in a row +1 each (max 7).
- **Weekly duel**: the higher relative score wins the week; ${SQUAD_AI} announces it in the recap.`);
  openSheet('squadRulesSheet');
}

async function openSquadSettings() {
  const S = squadState(Squad.cur);
  const c = squadEntry(Squad.cur);
  if (!S || !S.ch || !c) return;
  const owner = S.ch.is_owner;
  const r = S.ch.rules || {};
  const meM = S.member(S.me) || {};
  $('#sqx_owner').classList.toggle('hidden', !owner);
  $('#sqx_name').value = S.ch.name;
  $('#sqx_end').value = S.ch.ends || '';
  $('#sqx_days').value = String(r.days_per_week || 4);
  $('#sqx_recap').value = String(r.recap_hour ?? 21);
  $('#sqx_interrupts').checked = r.interrupts !== false;
  $('#sqx_recap_on').checked = r.recap !== false;
  $$('#sqx_roast button').forEach(b => b.classList.toggle('active', b.dataset.v === (r.roast || 'mild')));
  const ai = S.ch.ai || {};
  $('#sqx_ai_state').textContent = ai.enabled ? `${SQUAD_AI} runs on ${ai.name || ai.type} · ${ai.model}${ai.paid ? ` · $${ai.spend_usd} this month${ai.cap_usd ? ` of $${ai.cap_usd}` : ''}` : ' · free'}` : `${SQUAD_AI} is off — pick a provider to bring the AI into the chat.`;
  $('#sqx_ai').innerHTML = `<option value="keep">${ai.enabled ? 'Keep current' : 'Choose…'}</option>${squadProviderOptions()}<option value="off">Switch the AI off</option>`;
  $('#sqx_target').value = String((meM.baseline && meM.baseline.target_days) || r.days_per_week || 4);
  $('#sqx_share').checked = c.auto_share !== false;
  $('#sqx_notes').checked = c.share_notes !== false;
  $('#sqx_wellness').checked = !!c.share_wellness;
  openSheet('squadSettingsSheet');
}

async function saveSquadSettings() {
  const S = squadState(Squad.cur);
  const c = squadEntry(Squad.cur);
  const btn = $('#sqxSave');
  setBusy(btn, true, 'Saving…');
  try {
    if (S.ch.is_owner) {
      await squadCall(c, 'PATCH', '', {
        name: $('#sqx_name').value.trim(), ends: $('#sqx_end').value || null,
        rules: { days_per_week: Number($('#sqx_days').value), recap_hour: Number($('#sqx_recap').value), interrupts: $('#sqx_interrupts').checked, recap: $('#sqx_recap_on').checked, roast: ($('#sqx_roast button.active') || { dataset: { v: 'mild' } }).dataset.v }
      });
      const pick = $('#sqx_ai').value;
      if (pick === 'off') await squadCall(c, 'PUT', '/ai', { config: null });
      else if (pick !== 'keep') await squadCall(c, 'PUT', '/ai', { config: squadAiConfigFor(pick) });
    }
    const meM = S.member(S.me) || {};
    const baseline = Object.assign({}, meM.baseline || {}, { target_days: Number($('#sqx_target').value) });
    await squadCall(c, 'PATCH', '/me', { baseline });
    const notesBefore = c.share_notes !== false;
    c.auto_share = $('#sqx_share').checked;
    c.share_notes = $('#sqx_notes').checked;
    c.share_wellness = $('#sqx_wellness').checked;
    if (notesBefore !== c.share_notes) c.shared = {}; // re-share with/without notes
    await squadSaveList();
    closeSheet('squadSettingsSheet');
    toast('Saved', 'success', 1600);
    Squad.lastShare = 0;
    await squadTick(true);
  } catch (e) {
    toast(`Could not save: ${e.message}`, 'error');
  } finally { setBusy(btn, false); }
}

async function leaveSquadChallenge() {
  const c = squadEntry(Squad.cur);
  if (!c) return;
  if (!(await uiConfirm(`Leave “${c.name}”?`, 'Your past posts stay visible to the others. You can be invited again with the code.', { okText: 'Leave', danger: true }))) return;
  try { await squadCall(c, 'DELETE', '/me'); } catch (e) { if (!e.status) { toast(`Could not leave: ${e.message}`, 'error'); return; } }
  Squad.list = Squad.list.filter(x => x.id !== c.id);
  Squad.outbox = Squad.outbox.filter(o => o.cid !== c.id);
  delete Squad.data[c.id];
  await db.config.delete(`squad_data_${c.id}`);
  await squadSaveList();
  await squadSaveOutbox();
  Squad.cur = Squad.list[0] ? Squad.list[0].id : null;
  await setConfig('squad_current', Squad.cur || '');
  closeSheet('squadSettingsSheet');
  renderSquad();
  squadBadge();
}
