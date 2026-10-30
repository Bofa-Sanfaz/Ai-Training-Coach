// --------------------------------------------------------
// TRAINING PARTNER — SQUAD SERVER (Cloudflare Worker + D1)
// No accounts: creating a challenge returns an invite code; joining returns a secret
// member token (only its SHA-256 is stored). Every call sends `Authorization: Bearer`.
//
// Sync: everything in a challenge is an event with a per-challenge `seq`.
//   GET  /api/c/:id/changes?since=N   → events after N + members + challenge + AI status
//   POST /api/c/:id/events            → batch from the client outbox; ids are client-made,
//                                       so a retried batch never duplicates anything
// The AI never runs inside a request that someone else is waiting for: responses say
// `ai_due`, the client then calls POST /api/c/:id/ai/run, and the cron covers the rest.
// --------------------------------------------------------
import '../../www/js/app/squad-core.js';
import { accountRoute } from './account.js';
import { runAI, aiDue, extractWorkout, publicAiConfig, localToday, rid, parse, nowIso, AI_NAME, CH_COLS } from './ai.js';

const MAX_MEMBERS = 6;
const MAX_CHALLENGES = 40;
const COLORS = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed', '#0891b2'];
const SPORTS = ['ride', 'run', 'walk', 'swim', 'other'];
const KIND_LIMIT = { msg: 6000, activity: 12000, comment: 3000, reaction: 300, delete: 300, daily: 600 };
const AI_MODES = ['ask', 'review', 'roast', 'report', 'arc'];
// Daily wellness a member chose to share: field → [min, max]
const DAILY_FIELDS = { weight_kg: [25, 300], rhr: [25, 150], hrv: [5, 300], sleep_min: [0, 1000], steps: [0, 150000] };

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
function cors(res) {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', '*'); // bearer tokens only, no cookies
  h.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  h.set('Access-Control-Max-Age', '86400');
  return new Response(res.body, { status: res.status, headers: h });
}

async function readJson(req, max = 65536) {
  const t = await req.text();
  if (t.length > max) fail(413, 'request too large');
  try { return t ? JSON.parse(t) : {}; } catch (e) { fail(400, 'invalid JSON'); }
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const validDate = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : null);
const int = (v, a, b, d) => (Number.isFinite(+v) ? Math.max(a, Math.min(b, Math.round(+v))) : d);
const token = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const inviteCode = () => { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; return Array.from(crypto.getRandomValues(new Uint8Array(8)), x => a[x % a.length]).join(''); };
async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('');
}

function sanitizeRules(r = {}, old = {}) {
  const v = Object.assign({ days_per_week: 4, roast: 'mild', recap_hour: 21, interrupts: true, recap: true, goal: '' }, old);
  if (r.days_per_week !== undefined) v.days_per_week = int(r.days_per_week, 1, 7, 4);
  if (['off', 'mild', 'spicy'].includes(r.roast)) v.roast = r.roast;
  if (r.recap_hour !== undefined) v.recap_hour = int(r.recap_hour, 0, 23, 21);
  if (typeof r.interrupts === 'boolean') v.interrupts = r.interrupts;
  if (typeof r.recap === 'boolean') v.recap = r.recap;
  if (r.goal !== undefined) v.goal = str(r.goal, 300);
  return v;
}

function sanitizeMember(m = {}, partial = false) {
  const out = {};
  if (!partial || m.name !== undefined) { out.name = str(m.name, 30); if (!out.name) fail(400, 'name is required'); }
  if (!partial || m.sports !== undefined) out.sports = Array.isArray(m.sports) ? m.sports.filter(s => SPORTS.includes(s)).slice(0, 5) : [];
  if (!partial || m.baseline !== undefined) {
    const b = m.baseline && typeof m.baseline === 'object' ? m.baseline : {};
    const metrics = {};
    for (const sp of SPORTS) if (b.metrics && +b.metrics[sp] > 0) metrics[sp] = +b.metrics[sp];
    out.baseline = { weekly_min: +b.weekly_min > 0 ? Math.round(+b.weekly_min) : 0, target_days: int(b.target_days, 0, 7, 0), metrics, about: str(b.about, 300), from: validDate(b.from), to: validDate(b.to) };
  }
  if (m.color !== undefined && /^#[0-9a-f]{6}$/i.test(m.color)) out.color = m.color;
  return out;
}

const publicChallenge = (ch, me) => ({
  id: ch.id, name: ch.name, invite: ch.invite, owner: ch.owner, starts: ch.starts, ends: ch.ends,
  rules: parse(ch.rules, {}), tz_offset: ch.tz_offset, seq: ch.seq, created_at: ch.created_at,
  ai: Object.assign(publicAiConfig(ch), { busy: ch.ai_lock > Date.now() }), is_owner: !!me && me.id === ch.owner,
  arc: ch.arc || 0, arc_seq: ch.arc_seq || 0, arc_vote: parse(ch.arc_vote, null), arcs: parse(ch.arcs, [])
});

async function membersOf(env, cid) {
  const r = await env.DB.prepare("SELECT id, name, color, sports, baseline, joined_at, last_seen, token_hash != '' AS active FROM members WHERE challenge_id=? ORDER BY joined_at").bind(cid).all();
  return r.results.map(m => ({ id: m.id, name: m.name, color: m.color, sports: parse(m.sports, []), baseline: parse(m.baseline, {}), joined_at: m.joined_at, last_seen: m.last_seen, active: !!m.active }));
}

async function auth(env, req, cid) {
  const h = req.headers.get('Authorization') || '';
  const t = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (t.length < 20) fail(401, 'missing member token');
  const me = await env.DB.prepare("SELECT * FROM members WHERE token_hash=? AND challenge_id=? AND token_hash != ''").bind(await sha256(t), cid).first();
  if (!me) fail(403, 'not a member of this challenge');
  const ch = await env.DB.prepare(`SELECT ${CH_COLS} FROM challenges WHERE id=?`).bind(cid).first();
  if (!ch) fail(404, 'challenge not found');
  return { me, ch };
}

// Append events atomically: seq = challenge.seq + 1, skipped when the id already exists.
// Returns [{ id, seq }] in input order.
async function append(env, cid, list) {
  if (!list.length) return [];
  const now = nowIso();
  const stmts = [];
  for (const e of list) {
    const dup = 'NOT EXISTS (SELECT 1 FROM events WHERE challenge_id=?1 AND id=?2)';
    stmts.push(env.DB.prepare(`UPDATE challenges SET seq = seq + 1 WHERE id=?1 AND ${dup}`).bind(cid, e.id));
    stmts.push(env.DB.prepare(`INSERT INTO events (challenge_id, seq, id, kind, author, ref, body, created_at)
      SELECT ?1, seq, ?2, ?3, ?4, ?5, ?6, ?7 FROM challenges WHERE id=?1 AND ${dup}`)
      .bind(cid, e.id, e.kind, e.author, e.ref || null, JSON.stringify(e.body || {}), now));
  }
  await env.DB.batch(stmts);
  const ids = list.map(e => e.id);
  const r = await env.DB.prepare(`SELECT id, seq FROM events WHERE challenge_id=? AND id IN (${ids.map(() => '?').join(',')})`).bind(cid, ...ids).all();
  const m = new Map(r.results.map(x => [x.id, x.seq]));
  return ids.map(id => ({ id, seq: m.get(id) || null }));
}

const systemEvent = (body, ref = null) => ({ id: `sys-${rid(14)}`, kind: 'system', author: 'system', ref, body });

// Validate one client event (author = the caller)
async function checkEvent(env, ch, me, e) {
  if (!e || typeof e !== 'object') fail(400, 'bad event');
  const id = str(e.id, 48);
  if (!/^[A-Za-z0-9_-]{8,48}$/.test(id)) fail(400, 'bad event id');
  if (!KIND_LIMIT[e.kind]) fail(400, `unknown kind ${e.kind}`);
  const body = e.body && typeof e.body === 'object' && !Array.isArray(e.body) ? e.body : {};
  if (JSON.stringify(body).length > KIND_LIMIT[e.kind]) fail(413, `${e.kind} too large`);
  const ref = e.ref == null ? null : str(e.ref, 140);
  const out = { id, kind: e.kind, author: me.id, ref, body };
  if (e.kind === 'msg') {
    body.text = str(body.text, 4000);
    if (body.ai) {
      const src = body.ai; // read the request's own fields before replacing the object
      const mode = AI_MODES.includes(src.mode) ? src.mode : 'ask';
      body.ai = { mode, ref: src.ref ? str(src.ref, 140) : null };
      if (mode === 'report') body.ai.month = /^\d{4}-\d{2}$/.test(src.month || '') ? src.month : null;
      if (mode === 'arc') Object.assign(body.ai, { from: validDate(src.from), to: validDate(src.to), arc: int(src.arc, 0, 9999, 0) });
    } else if (new RegExp(`(^|\\s)@(ai|${AI_NAME})\\b`, 'i').test(body.text)) body.ai = { mode: 'ask', ref: null };
    if (!body.text && !body.ai) fail(400, 'empty message');
  } else if (e.kind === 'activity') {
    body.key = str(body.key, 80);
    if (!body.key || !validDate(body.date)) fail(400, 'activity needs key and date');
    if (!SPORTS.includes(body.sport)) body.sport = 'other';
  } else if (e.kind === 'daily') {
    if (!validDate(body.date)) fail(400, 'daily needs a date');
    const clean = { date: body.date };
    if (body.clear === true) clean.clear = true;
    for (const [f, [lo, hi]] of Object.entries(DAILY_FIELDS)) if (Number.isFinite(+body[f]) && +body[f] >= lo && +body[f] <= hi) clean[f] = Math.round(+body[f] * 10) / 10;
    out.body = clean;
  } else if (e.kind === 'comment') {
    body.text = str(body.text, 2000);
    if (!ref || !body.text) fail(400, 'comment needs ref and text');
  } else if (e.kind === 'reaction') {
    body.emoji = str(body.emoji, 16);
    body.on = body.on !== false;
    if (!ref || !body.emoji) fail(400, 'reaction needs ref and emoji');
  } else if (e.kind === 'delete') {
    if (!ref) fail(400, 'delete needs ref');
    if (ref.startsWith('act:')) {
      if (ref.split(':')[1] !== me.id) fail(403, 'you can only delete your own activities');
    } else {
      const t = await env.DB.prepare('SELECT author FROM events WHERE challenge_id=? AND id=?').bind(ch.id, ref).first();
      const mine = t && (t.author === me.id || (t.author === 'ai' && me.id === ch.owner));
      if (t && !mine) fail(403, 'you can only delete your own posts');
    }
  }
  return out;
}

// ---------- routes ----------
async function createChallenge(env, req) {
  const b = await readJson(req);
  const me = sanitizeMember(b.member);
  const tz = int(b.tz_offset, -840, 840, 0);
  const today = new Date(Date.now() + tz * 60000).toISOString().slice(0, 10);
  const starts = validDate(b.starts) || today;
  const ends = validDate(b.ends);
  if (ends && ends < starts) fail(400, 'the end date is before the start');
  const name = str(b.name, 60) || 'Our challenge';
  // A private server: strangers can't fill the free database (or the cron's time) with challenges
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM challenges').first();
  if (count.n >= MAX_CHALLENGES) fail(403, 'this server is not taking new challenges');
  const memberId = rid(12), cid = rid(14), t = token(), now = nowIso();
  for (let attempt = 0; attempt < 4; attempt++) {
    const invite = inviteCode();
    try {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO challenges (id, name, invite, owner, starts, ends, rules, tz_offset, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
          .bind(cid, name, invite, memberId, starts, ends, JSON.stringify(sanitizeRules(b.rules)), tz, now),
        env.DB.prepare('INSERT INTO members (id, challenge_id, name, color, token_hash, sports, baseline, joined_at, last_seen) VALUES (?,?,?,?,?,?,?,?,?)')
          .bind(memberId, cid, me.name, me.color || COLORS[0], await sha256(t), JSON.stringify(me.sports), JSON.stringify(me.baseline), now, now)
      ]);
      await append(env, cid, [systemEvent({ type: 'created', member: memberId, name })]);
      const ch = await env.DB.prepare(`SELECT ${CH_COLS} FROM challenges WHERE id=?`).bind(cid).first();
      return json({ challenge: publicChallenge(ch, { id: memberId }), member_id: memberId, token: t }, 201);
    } catch (e) {
      if (!/UNIQUE/i.test(String(e.message))) throw e;
    }
  }
  fail(500, 'could not create an invite code, try again');
}

async function joinChallenge(env, req) {
  const b = await readJson(req);
  const code = str(b.invite, 20).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 8) fail(400, 'the invite code has 8 characters');
  const ch = await env.DB.prepare(`SELECT ${CH_COLS} FROM challenges WHERE invite=?`).bind(code).first();
  if (!ch) fail(404, 'no challenge with this invite code');
  const members = await membersOf(env, ch.id);
  const active = members.filter(m => m.active);
  if (active.length >= MAX_MEMBERS) fail(409, 'this challenge is full');
  const me = sanitizeMember(b.member);
  const used = new Set(members.map(m => m.color));
  const color = me.color && !used.has(me.color) ? me.color : (COLORS.find(c => !used.has(c)) || COLORS[members.length % COLORS.length]);
  const memberId = rid(12), t = token(), now = nowIso();
  await env.DB.prepare('INSERT INTO members (id, challenge_id, name, color, token_hash, sports, baseline, joined_at, last_seen) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(memberId, ch.id, me.name, color, await sha256(t), JSON.stringify(me.sports), JSON.stringify(me.baseline), now, now).run();
  await append(env, ch.id, [systemEvent({ type: 'joined', member: memberId, name: me.name })]);
  const fresh = await env.DB.prepare(`SELECT ${CH_COLS} FROM challenges WHERE id=?`).bind(ch.id).first();
  return json({ challenge: publicChallenge(fresh, { id: memberId }), member_id: memberId, token: t }, 201);
}

async function changes(env, req, url, cid) {
  const { me, ch } = await auth(env, req, cid);
  const since = int(url.searchParams.get('since'), 0, 1e12, 0);
  const limit = 300;
  const now = nowIso();
  const [rows, members] = await Promise.all([
    env.DB.prepare('SELECT seq, id, kind, author, ref, body, created_at FROM events WHERE challenge_id=? AND seq > ? ORDER BY seq LIMIT ?').bind(cid, since, limit).all(),
    membersOf(env, cid),
    // last_seen at most once a minute (keeps D1 writes tiny)
    env.DB.prepare('UPDATE members SET last_seen=? WHERE id=? AND (last_seen IS NULL OR last_seen < ?)').bind(now, me.id, new Date(Date.now() - 60000).toISOString()).run()
  ]);
  // CPU budget: bodies are stored as JSON already, so they are passed through without parse/stringify
  const ev = rows.results;
  const eventsJson = ev.map(e => `{"seq":${e.seq},"id":${JSON.stringify(e.id)},"kind":${JSON.stringify(e.kind)},"author":${JSON.stringify(e.author)},"ref":${JSON.stringify(e.ref)},"body":${e.body || '{}'},"created_at":${JSON.stringify(e.created_at)}}`).join(',');
  const rest = JSON.stringify({
    seq: ev.length ? ev[ev.length - 1].seq : Math.max(since, 0), head: ch.seq, more: ev.length === limit,
    members, me: me.id, challenge: publicChallenge(ch, me), today: localToday(ch), ai_due: await aiDue(env, ch)
  });
  return new Response(`${rest.slice(0, -1)},"events":[${eventsJson}]}`, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

async function postEvents(env, req, cid) {
  const { me, ch } = await auth(env, req, cid);
  const b = await readJson(req, 400000);
  const list = Array.isArray(b.events) ? b.events.slice(0, 50) : [];
  const ok = [], rejected = [];
  for (const e of list) {
    try { ok.push(await checkEvent(env, ch, me, e)); } catch (err) { rejected.push({ id: e && e.id, error: err.message }); }
  }
  const acks = await append(env, cid, ok);
  const fresh = await env.DB.prepare(`SELECT ${CH_COLS} FROM challenges WHERE id=?`).bind(cid).first();
  return json({ acks, rejected, head: fresh.seq, ai_due: await aiDue(env, fresh) });
}

async function updateMe(env, req, cid) {
  const { me } = await auth(env, req, cid);
  const m = sanitizeMember(await readJson(req), true);
  const sets = [], vals = [];
  if (m.name) { sets.push('name=?'); vals.push(m.name); }
  if (m.color) { sets.push('color=?'); vals.push(m.color); }
  if (m.sports) { sets.push('sports=?'); vals.push(JSON.stringify(m.sports)); }
  if (m.baseline) { sets.push('baseline=?'); vals.push(JSON.stringify(m.baseline)); }
  if (sets.length) await env.DB.prepare(`UPDATE members SET ${sets.join(', ')} WHERE id=?`).bind(...vals, me.id).run();
  return json({ members: await membersOf(env, cid) });
}

async function leave(env, req, cid) {
  const { me, ch } = await auth(env, req, cid);
  await env.DB.prepare("UPDATE members SET token_hash='' WHERE id=?").bind(me.id).run();
  if (ch.owner === me.id) {
    const next = (await membersOf(env, cid)).find(m => m.active);
    // The AI key belongs to the owner: it leaves with him
    if (next) await env.DB.prepare('UPDATE challenges SET owner=?, ai_config=NULL WHERE id=?').bind(next.id, cid).run();
  }
  await append(env, cid, [systemEvent({ type: 'left', member: me.id, name: me.name })]);
  return json({ ok: true });
}

async function updateChallenge(env, req, cid) {
  const { me, ch } = await auth(env, req, cid);
  if (me.id !== ch.owner) fail(403, 'only the challenge owner can change the settings');
  const b = await readJson(req);
  const name = b.name !== undefined ? (str(b.name, 60) || ch.name) : ch.name;
  const ends = b.ends !== undefined ? (b.ends ? validDate(b.ends) : null) : ch.ends;
  if (ends && ends < ch.starts) fail(400, 'the end date is before the start');
  const rules = sanitizeRules(b.rules || {}, parse(ch.rules, {}));
  const tz = b.tz_offset !== undefined ? int(b.tz_offset, -840, 840, 0) : ch.tz_offset;
  await env.DB.prepare('UPDATE challenges SET name=?, ends=?, rules=?, tz_offset=? WHERE id=?').bind(name, ends, JSON.stringify(rules), tz, cid).run();
  await append(env, cid, [systemEvent({ type: 'settings', member: me.id })]);
  const fresh = await env.DB.prepare(`SELECT ${CH_COLS} FROM challenges WHERE id=?`).bind(cid).first();
  return json({ challenge: publicChallenge(fresh, me) });
}

async function setAi(env, req, cid) {
  const { me, ch } = await auth(env, req, cid);
  if (me.id !== ch.owner) fail(403, 'only the challenge owner can set up the AI');
  const b = await readJson(req);
  if (b.config === null) {
    await env.DB.prepare('UPDATE challenges SET ai_config=NULL WHERE id=?').bind(cid).run();
  } else {
    const c = b.config || {};
    const old = parse(ch.ai_config, {}) || {};
    const type = ['gemini', 'anthropic', 'openai'].includes(c.type) ? c.type : fail(400, 'unknown provider type');
    const baseUrl = str(c.baseUrl, 300).replace(/\/$/, '');
    // Local tests only (wrangler dev --var ALLOW_HTTP_AI:1) may use a mock provider on localhost
    const devMock = env.ALLOW_HTTP_AI === '1' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(`${baseUrl}/`);
    if (!/^https:\/\/[^/\s]+/i.test(baseUrl) && !devMock) fail(400, 'the provider URL must be a public https address');
    const model = str(c.model, 120) || fail(400, 'model is required');
    const apiKey = str(c.apiKey, 400) || (old.baseUrl === baseUrl ? old.apiKey : '');
    const cfg = {
      type, baseUrl, model, apiKey, name: str(c.name, 60), version: str(c.version, 20), fallback: !!c.fallback,
      priceIn: Math.max(0, +c.priceIn || 0), priceOut: Math.max(0, +c.priceOut || 0), capUsd: Math.max(0, +c.capUsd || 0)
    };
    await env.DB.prepare('UPDATE challenges SET ai_config=? WHERE id=?').bind(JSON.stringify(cfg), cid).run();
  }
  await append(env, cid, [systemEvent({ type: 'ai', member: me.id, enabled: b.config !== null })]);
  const fresh = await env.DB.prepare(`SELECT ${CH_COLS} FROM challenges WHERE id=?`).bind(cid).first();
  return json({ ai: publicAiConfig(fresh) });
}

// Strava for squad members without their own Strava API app (new ones need a paid Strava
// plan): the owner's app keys live only here as Worker secrets (STRAVA_CLIENT_ID /
// STRAVA_CLIENT_SECRET); members sign in with that client id and the code/refresh exchange
// happens on the server. Only members of a challenge may use it.
async function stravaToken(env, req) {
  if (!env.STRAVA_CLIENT_ID || !env.STRAVA_CLIENT_SECRET) fail(503, 'Strava is not set up on the squad server');
  const h = req.headers.get('Authorization') || '';
  const t = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (t.length < 20) fail(401, 'join a challenge first');
  const member = await env.DB.prepare("SELECT id FROM members WHERE token_hash=? AND token_hash != ''").bind(await sha256(t)).first();
  if (!member) fail(403, 'join a challenge first');
  const b = await readJson(req, 4096);
  const body = { client_id: env.STRAVA_CLIENT_ID, client_secret: env.STRAVA_CLIENT_SECRET };
  if (typeof b.code === 'string' && b.code.length < 200) Object.assign(body, { code: b.code, grant_type: 'authorization_code' });
  else if (typeof b.refresh_token === 'string' && b.refresh_token.length < 200) Object.assign(body, { refresh_token: b.refresh_token, grant_type: 'refresh_token' });
  else fail(400, 'code or refresh_token required');
  const res = await fetch('https://www.strava.com/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.access_token) {
    const why = (d.errors && d.errors.map(e => `${e.resource || ''} ${e.field || ''} ${e.code || ''}`.trim()).join(', ')) || d.message || `HTTP ${res.status}`;
    fail(res.status === 401 || res.status === 403 ? 403 : 502, `Strava: ${String(why).slice(0, 200)}`);
  }
  return json({ access_token: d.access_token, refresh_token: d.refresh_token, expires_at: d.expires_at, athlete: d.athlete ? { firstname: d.athlete.firstname } : null });
}

// ---------- arcs ("Start new arc"): every active member approves, then the squad starts over ----------
const dayShift = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
async function arcAction(env, req, cid) {
  const { me, ch } = await auth(env, req, cid);
  const b = await readJson(req);
  const everyone = await membersOf(env, cid);
  const active = everyone.filter(m => m.active);
  const next = (ch.arc || 0) + 1;
  let vote = parse(ch.arc_vote, null);
  if (b.action === 'cancel') {
    if (vote) {
      await env.DB.prepare('UPDATE challenges SET arc_vote=NULL WHERE id=?').bind(cid).run();
      await append(env, cid, [systemEvent({ type: 'arc_cancel', arc: vote.arc, member: me.id })]);
    }
    return json({ arc_vote: null });
  }
  if (b.action !== 'propose' && b.action !== 'approve') fail(400, 'action: propose, approve or cancel');
  if (!vote || vote.arc !== next) vote = { arc: next, by: [], at: nowIso(), proposer: me.id };
  if (!vote.by.includes(me.id)) vote.by.push(me.id);
  if (!active.every(m => vote.by.includes(m.id))) {
    await env.DB.prepare('UPDATE challenges SET arc_vote=? WHERE id=? AND arc=?').bind(JSON.stringify(vote), cid, ch.arc || 0).run();
    await append(env, cid, [systemEvent({ type: 'arc_vote', arc: next, by: vote.by, member: me.id })]);
    return json({ arc_vote: vote, started: false });
  }
  // Everyone approved: archive the arc that ends, start the next one today
  const today = localToday(ch);
  const arcs = parse(ch.arcs, []);
  // The arc that ends keeps everyone's "own usual" of that time, so its report never re-scores
  const prev = (ch.arc || 0) >= 1 ? { n: ch.arc, from: ch.starts, to: today > ch.starts ? dayShift(today, -1) : today, seq_from: ch.arc_seq || 0, seq_to: ch.seq, baselines: Object.fromEntries(everyone.map(m => [m.id, m.baseline || {}])) } : null;
  if (prev) arcs.push(prev);
  const len = ch.ends ? Math.round((Date.parse(`${ch.ends}T00:00:00Z`) - Date.parse(`${ch.starts}T00:00:00Z`)) / 86400000) : null;
  const ends = len !== null && len > 0 ? dayShift(today, len) : null;
  const r = await env.DB.prepare('UPDATE challenges SET arc=?, arc_seq=?, arc_vote=NULL, arcs=?, starts=?, ends=? WHERE id=? AND arc=?')
    .bind(next, ch.seq + 1, JSON.stringify(arcs), today, ends, cid, ch.arc || 0).run();
  if (!r.meta.changes) fail(409, 'the arc just changed — refresh');
  const brief = prev && Object.assign({}, prev, { baselines: undefined }); // the event stays small
  const evs = [systemEvent({ type: 'arc_started', arc: next, prev: brief, by: vote.by })];
  // From the second arc on: the thorough report of the arc that just ended
  if (prev && ch.ai_config) evs.push({ id: `arc-${cid.slice(0, 6)}-${prev.n}-${rid(6)}`, kind: 'msg', author: me.id, ref: null, body: { text: `📊 Arc ${prev.n} report, please`, ai: { mode: 'arc', from: prev.from, to: prev.to, arc: prev.n } } });
  await append(env, cid, evs);
  return json({ started: true, arc: next, prev: brief });
}

function poster(env) {
  return async (ch, e) => {
    const ev = Object.assign({ id: `ai-${rid(14)}`, author: e.kind === 'system' ? 'system' : 'ai' }, e);
    const [ack] = await append(env, ch.id, [ev]);
    return ack && ack.seq;
  };
}

async function route(req, env, url) {
  const p = url.pathname.replace(/\/+$/, '');
  const m = req.method;
  if (p === '/api/health') return json({ ok: true, time: nowIso() });
  if (p.startsWith('/api/account/')) return accountRoute(env, req, url, { json, fail, readJson });
  if (p === '/api/challenges' && m === 'POST') return createChallenge(env, req);
  if (p === '/api/join' && m === 'POST') return joinChallenge(env, req);
  if (p === '/api/strava/client' && m === 'GET') return json({ client_id: env.STRAVA_CLIENT_ID || null });
  if (p === '/api/strava/token' && m === 'POST') return stravaToken(env, req);
  const r = p.match(/^\/api\/c\/([a-z0-9]{8,32})(\/.*)?$/);
  if (!r) fail(404, 'not found');
  const cid = r[1], sub = r[2] || '';
  if (sub === '' && m === 'PATCH') return updateChallenge(env, req, cid);
  if (sub === '/changes' && m === 'GET') return changes(env, req, url, cid);
  if (sub === '/events' && m === 'POST') return postEvents(env, req, cid);
  if (sub === '/me' && m === 'PATCH') return updateMe(env, req, cid);
  if (sub === '/me' && m === 'DELETE') return leave(env, req, cid);
  if (sub === '/arc' && m === 'POST') return arcAction(env, req, cid);
  if (sub === '/ai' && m === 'GET') { const { ch } = await auth(env, req, cid); return json({ ai: publicAiConfig(ch) }); }
  if (sub === '/ai' && m === 'PUT') return setAi(env, req, cid);
  if (sub === '/digest' && m === 'PUT') {
    // The AI context built on a phone (see SquadCore.digest); newer digests replace older ones
    const { ch } = await auth(env, req, cid);
    const text = await req.text();
    if (text.length > 700000) fail(413, 'digest too large');
    const s = (text.match(/^\{"v":1,"seq":(\d+),/) || [])[1];
    if (!s || Number(s) > ch.seq) fail(400, 'bad digest');
    const r = await env.DB.prepare("UPDATE challenges SET ai_digest=? WHERE id=? AND (ai_digest IS NULL OR json_extract(ai_digest,'$.seq') <= ?)").bind(text, cid, Number(s)).run();
    return json({ stored: !!r.meta.changes });
  }
  if (sub === '/ai/run' && m === 'POST') {
    await auth(env, req, cid);
    return json(await runAI(env, cid, poster(env)));
  }
  if (sub === '/ai/extract' && m === 'POST') {
    const { ch } = await auth(env, req, cid);
    const b = await readJson(req, 12000000);
    const images = (Array.isArray(b.images) ? b.images : typeof b.image === 'string' ? [b.image] : []).filter(x => typeof x === 'string' && x.length > 100).slice(0, 8);
    if (!images.length) fail(400, 'images (base64 JPEG) are required');
    return json({ result: await extractWorkout(env, ch, images, b.today || localToday(ch)) });
  }
  fail(404, 'not found');
}

async function cron(env) {
  const today = new Date().toISOString().slice(0, 10);
  const r = await env.DB.prepare(`SELECT ${CH_COLS} FROM challenges WHERE ai_config IS NOT NULL AND (ends IS NULL OR ends >= date(?, '-3 days'))`).bind(today).all();
  for (const ch of r.results) {
    try { if (await aiDue(env, ch, { cron: true })) await runAI(env, ch.id, poster(env), { cron: true }); } catch (e) { console.warn('cron', ch.id, e.message); }
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    if (req.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    try {
      return cors(await route(req, env, url));
    } catch (e) {
      if (!(e instanceof HttpError) && !e.status) console.error(e && e.stack || e);
      return cors(json({ error: e.status ? e.message : 'server error' }, e.status || 500));
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cron(env));
  }
};
