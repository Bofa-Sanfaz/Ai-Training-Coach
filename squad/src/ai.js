// --------------------------------------------------------
// SQUAD AI — the third member of the chat ("Aether"), running server side with the
// owner's provider/key so it works while both phones are off.
//
// Who may talk when (etiquette, enforced here, not by the model):
//   - Requests (@AI, Ask, Review, Roast) are answered in order, as soon as a run happens.
//   - Unprompted messages (personal bests, streaks, first workout, quiet member, lively
//     chat) only when nobody wrote for 90 s, at most 1 per 2 h and 4 per day; triggers
//     wait in `pending` and expire after 12 h. The model may answer PASS to stay silent.
//   - Daily recap at the challenge's recap hour; the last day of each challenge week also
//     announces the weekly duel; a final recap after the challenge ends.
//   - One run per challenge at a time: a lease on challenges.ai_lock, renewed before
//     every model call. Replies carry reply_to so late answers stay attached.
// --------------------------------------------------------
const SquadCore = globalThis.SquadCore;

const LEASE_MS = 150000;
const MODEL_TIMEOUT_MS = 100000;
const QUIET_MS = 90000;
const quietMs = env => +env.SQUAD_QUIET_MS || QUIET_MS; // shorter only in local tests
const FREE_GAP_MS = 2 * 3600000;
const FREE_PER_DAY = 4;
const TRIGGER_TTL_MS = 12 * 3600000;
const CHAT_TRIGGER_MSGS = 10;
const STREAK_MARKS = [3, 5, 7, 10, 14, 21, 30, 45, 60, 90];
const AI_NAME = 'Aether';
// Every column except the (large) ai_digest, which only AI runs read
export const CH_COLS = 'id, name, invite, owner, starts, ends, rules, tz_offset, seq, ai_config, ai_state, ai_lock, ai_month, ai_spend, created_at';

// ---------- small helpers ----------
const nowIso = () => new Date().toISOString();
const rid = (n = 12) => {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789';
  const b = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(b, x => a[x % a.length]).join('');
};
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch (e) { return d; } };
export const localNow = (ch, t = Date.now()) => new Date(t + (ch.tz_offset || 0) * 60000);
export const localToday = (ch, t) => localNow(ch, t).toISOString().slice(0, 10);
const monthKey = () => new Date().toISOString().slice(0, 7);
const mmss = s => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`; };
const weekday = d => new Date(`${d}T12:00:00Z`).toUTCString().slice(0, 11).replace(',', '');

export function publicAiConfig(ch) {
  const c = parse(ch.ai_config, null);
  if (!c) return { enabled: false };
  const spend = ch.ai_month === monthKey() ? ch.ai_spend : 0;
  return { enabled: true, name: c.name || '', type: c.type, model: c.model, has_key: !!c.apiKey, cap_usd: c.capUsd || 0, spend_usd: Math.round(spend * 1000) / 1000, paid: (c.priceIn || 0) + (c.priceOut || 0) > 0 };
}

// ---------- provider call (non-streaming; same request shapes as the app's providers.js) ----------
export async function callModel(cfg, prompt, opts = {}) {
  const base = String(cfg.baseUrl || '').replace(/\/$/, '');
  const img = opts.image ? (opts.image.includes(',') ? opts.image.split(',')[1] : opts.image) : null;
  const maxTokens = opts.maxTokens || 2000;
  let url, headers = { 'Content-Type': 'application/json' }, body, read;
  if (cfg.type === 'gemini') {
    const parts = [{ text: prompt }];
    if (img) parts.push({ inlineData: { mimeType: 'image/jpeg', data: img } });
    const generationConfig = { maxOutputTokens: maxTokens };
    if (opts.json) generationConfig.responseMimeType = 'application/json';
    url = `${base}/models/${encodeURIComponent(cfg.model)}:generateContent`;
    headers['x-goog-api-key'] = cfg.apiKey;
    body = { contents: [{ role: 'user', parts }], generationConfig };
    read = d => {
      const c = d.candidates && d.candidates[0];
      const ps = (c && c.content && c.content.parts) || [];
      const u = d.usageMetadata || {};
      return { text: ps.filter(x => !x.thought).map(x => x.text || '').join(''), in: u.promptTokenCount || 0, out: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) };
    };
  } else if (cfg.type === 'anthropic') {
    const content = [];
    if (img) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img } });
    content.push({ type: 'text', text: opts.json ? `${prompt}\n\nReply with JSON only.` : prompt });
    url = `${base}/messages`;
    headers['x-api-key'] = cfg.apiKey;
    headers['anthropic-version'] = cfg.version || '2023-06-01';
    body = { model: cfg.model, max_tokens: maxTokens, messages: [{ role: 'user', content }] };
    if (cfg.fallback) { headers['anthropic-beta'] = 'server-side-fallback-2026-07-01'; body.fallbacks = 'default'; }
    read = d => ({ text: (d.content || []).filter(b => b.type === 'text').map(b => b.text).join(''), in: (d.usage && (d.usage.input_tokens + (d.usage.cache_read_input_tokens || 0))) || 0, out: (d.usage && d.usage.output_tokens) || 0 });
  } else {
    const official = /api\.openai\.com/.test(base);
    const msg = img
      ? { role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${img}` } }] }
      : { role: 'user', content: opts.json ? `${prompt}\n\nReply with JSON only.` : prompt };
    url = `${base}/chat/completions`;
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
    if (/openrouter\.ai/.test(base)) { headers['HTTP-Referer'] = 'https://ridepartner.app'; headers['X-Title'] = 'Training Partner Squad'; }
    body = { model: cfg.model, messages: [msg] };
    body[official ? 'max_completion_tokens' : 'max_tokens'] = maxTokens;
    if (opts.json) body.response_format = { type: 'json_object' };
    read = d => { const c = d.choices && d.choices[0]; return { text: (c && c.message && c.message.content) || '', in: (d.usage && d.usage.prompt_tokens) || 0, out: (d.usage && d.usage.completion_tokens) || 0 }; };
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), MODEL_TIMEOUT_MS);
  let res, d;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
    d = await res.json().catch(() => ({}));
  } catch (e) {
    throw Object.assign(new Error(e.name === 'AbortError' ? 'the AI took too long' : 'could not reach the AI provider'), { status: 502 });
  } finally { clearTimeout(timer); }
  if (!res.ok) {
    const m = (d && d.error && (d.error.message || d.error.status)) || `HTTP ${res.status}`;
    throw Object.assign(new Error(String(m).slice(0, 200)), { status: res.status === 429 ? 429 : 502 });
  }
  const out = read(d);
  out.cost = ((out.in || 0) * (cfg.priceIn || 0) + (out.out || 0) * (cfg.priceOut || 0)) / 1e6;
  return out;
}

// Spend cap check + accounting (atomic, works outside the AI lease too)
async function spendAllowed(env, ch, cfg) {
  if (!(cfg.capUsd > 0) || !((cfg.priceIn || 0) + (cfg.priceOut || 0) > 0)) return true;
  const row = await env.DB.prepare('SELECT ai_month, ai_spend FROM challenges WHERE id=?').bind(ch.id).first();
  return !(row && row.ai_month === monthKey() && row.ai_spend >= cfg.capUsd);
}
async function addSpend(env, cid, cost) {
  if (!(cost > 0)) return;
  const m = monthKey();
  await env.DB.prepare('UPDATE challenges SET ai_spend = CASE WHEN ai_month=?1 THEN ai_spend + ?2 ELSE ?2 END, ai_month=?1 WHERE id=?3').bind(m, cost, cid).run();
}

export async function modelFor(env, ch, prompt, opts) {
  const cfg = parse(ch.ai_config, null);
  if (!cfg) throw Object.assign(new Error('the squad AI is not set up'), { status: 409 });
  if (!(await spendAllowed(env, ch, cfg))) throw Object.assign(new Error('the monthly AI spend cap is reached'), { status: 402 });
  const r = await callModel(cfg, prompt, opts);
  await addSpend(env, ch.id, r.cost);
  return r;
}

// ---------- screenshot → workout (Assad's Huawei screens) ----------
export async function extractWorkout(env, ch, image, hint) {
  const prompt = `Read this screenshot from a fitness app (often Huawei Health; may also be Apple Fitness, Strava, Samsung Health).
Extract ONE workout. Use only numbers that are visible — never guess; use null when a value is not shown.
${hint ? `The user says: ${String(hint).slice(0, 300)}\n` : ''}Return JSON:
{"sport":"walk|swim|run|ride|other","type":"e.g. Outdoor walk, Pool swim","date":"YYYY-MM-DD or null","start_time":"HH:MM or null",
"dur_s":number,"dist_m":number,"avg_hr":number,"max_hr":number,"calories":number,"steps":number,"cadence":number,
"pace_km_s":number (seconds per km, walk/run),"pace100_s":number (seconds per 100 m, swim),"speed_kmh":number,
"swolf":number,"pool_m":number,"strokes":number,"main_stroke":"free|breast|back|fly|mixed|null",
"laps":[{"n":1,"sec":number,"strokes":number,"swolf":number,"stroke":"free"}],"elev_m":number,"notes":"anything else useful, short"}
Durations like 1:02:03 are h:mm:ss; 7'45" pace means 7 min 45 s per km.`;
  const r = await modelFor(env, ch, prompt, { image, json: true, maxTokens: 3000 });
  const t = String(r.text || '').replace(/```(?:json)?/g, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  const w = a >= 0 && b > a ? parse(t.slice(a, b + 1), null) : null;
  if (!w) throw Object.assign(new Error('the AI could not read a workout from that image'), { status: 422 });
  return w;
}

// ---------- context for the model ----------
// CPU budget (free plan: 10 ms per request): the database extracts the few fields scoring needs
// from every activity (D1 time is not Worker CPU); full bodies (lap lines, verdicts…) are parsed
// only for the last ~2 months, wellness only for the last ~2 months, chat only the last 120 items.
const ACT_FIELDS = ['key', 'date', 'start', 'sport', 'title', 'type', 'dur_s', 'dist_m', 'pace_km', 'pace100', 'speed_kmh', 'load', 'pb'];
const DAILY_FIELDS = ['date', 'weight_kg', 'rhr', 'hrv', 'sleep_min', 'steps', 'clear'];
const FULL_DAYS = 62;

async function loadWorld(env, ch) {
  // Preferred: the phones' digest, when it already covers the newest shared sessions/wellness
  const [dg, newest] = await Promise.all([
    env.DB.prepare('SELECT ai_digest FROM challenges WHERE id=?').bind(ch.id).first(),
    env.DB.prepare("SELECT MAX(seq) AS s FROM events WHERE challenge_id=? AND kind IN ('activity','delete','daily')").bind(ch.id).first()
  ]);
  const digest = dg && dg.ai_digest ? parse(dg.ai_digest, null) : null;
  if (digest && digest.v === 1 && digest.score && digest.seq >= ((newest && newest.s) || 0)) return worldFromDigest(env, ch, digest);
  return fullWorld(env, ch);
}

async function worldFromDigest(env, ch, d) {
  const [members, chat] = await Promise.all([
    env.DB.prepare("SELECT id, name, sports, baseline, joined_at, token_hash != '' AS active FROM members WHERE challenge_id=? ORDER BY joined_at").bind(ch.id).all(),
    env.DB.prepare("SELECT seq, id, kind, author, ref, body, created_at FROM events WHERE challenge_id=? AND kind IN ('msg','comment','reaction') ORDER BY seq DESC LIMIT 120").bind(ch.id).all()
  ]);
  const ms = members.results.map(m => ({ id: m.id, name: m.name, active: !!m.active, sports: parse(m.sports, []), baseline: parse(m.baseline, {}), joined_at: m.joined_at }));
  const st = SquadCore.fold(chat.results.map(e => Object.assign(e, { body: parse(e.body, {}) })));
  const activities = Array.isArray(d.recent) ? d.recent : [];
  st.activities = new Map(activities.map(a => [a.ref, a]));
  st.daily = d.daily || {};
  return { ch, rules: parse(ch.rules, {}), today: localToday(ch), members: ms, st, activities, score: d.score, lastDates: d.last_dates || {}, fromDigest: true, nameOf: id => id === 'ai' ? AI_NAME : ((ms.find(m => m.id === id) || {}).name || 'someone') };
}

// Fallback (no digest yet, or it misses the newest events): read the history itself
async function fullWorld(env, ch) {
  const today = localToday(ch);
  const recent = new Date(Date.parse(`${today}T00:00:00Z`) - FULL_DAYS * 86400000).toISOString().slice(0, 10);
  const x = f => `json_extract(body,'$.${f}') AS ${f}`;
  const [members, acts, full, dels, daily, chat] = await Promise.all([
    env.DB.prepare("SELECT id, name, sports, baseline, joined_at, token_hash != '' AS active FROM members WHERE challenge_id=? ORDER BY joined_at").bind(ch.id).all(),
    env.DB.prepare(`SELECT seq, id, author, created_at, ${ACT_FIELDS.map(x).join(', ')} FROM events WHERE challenge_id=? AND kind='activity' ORDER BY seq`).bind(ch.id).all(),
    env.DB.prepare("SELECT seq, body FROM events WHERE challenge_id=? AND kind='activity' AND json_extract(body,'$.date') >= ?").bind(ch.id, recent).all(),
    env.DB.prepare("SELECT ref FROM events WHERE challenge_id=? AND kind='delete'").bind(ch.id).all(),
    env.DB.prepare(`SELECT seq, author, ${DAILY_FIELDS.map(x).join(', ')} FROM events WHERE challenge_id=? AND kind='daily' AND json_extract(body,'$.date') >= ? ORDER BY seq`).bind(ch.id, recent).all(),
    env.DB.prepare("SELECT seq, id, kind, author, ref, body, created_at FROM events WHERE challenge_id=? AND kind IN ('msg','comment','reaction') ORDER BY seq DESC LIMIT 120").bind(ch.id).all()
  ]);
  const ms = members.results.map(m => ({ id: m.id, name: m.name, active: !!m.active, sports: parse(m.sports, []), baseline: parse(m.baseline, {}), joined_at: m.joined_at }));
  const st = SquadCore.fold(chat.results.map(e => Object.assign(e, { body: parse(e.body, {}) })));
  for (const d of dels.results) if (d.ref) st.deleted.add(d.ref);
  // Activities: latest version per workout, deletes removed; full body for recent ones
  const fullBySeq = new Map(full.results.map(r => [r.seq, r.body]));
  for (const r of acts.results) {
    if (!r.key || st.deleted.has(r.id)) continue;
    const ref = SquadCore.actRef(r.author, r.key);
    if (st.deleted.has(ref)) { st.activities.delete(ref); continue; }
    const body = fullBySeq.has(r.seq) ? parse(fullBySeq.get(r.seq), {}) : Object.assign({}, r, { pb: r.pb ? parse(r.pb, []) : undefined });
    st.activities.set(ref, Object.assign(body, { ref, author: r.author, seq: r.seq, id: r.id, created_at: r.created_at }));
  }
  for (const d of daily.results) {
    if (!d.date) continue;
    const m = st.daily[d.author] = st.daily[d.author] || {};
    if (d.clear) delete m[d.date]; else m[d.date] = d;
  }
  const rules = parse(ch.rules, {});
  const activities = Array.from(st.activities.values());
  const score = SquadCore.compute({ starts: ch.starts, ends: ch.ends, rules }, ms.filter(m => m.active || activities.some(a => a.author === m.id)), activities, today);
  return { ch, rules, today, members: ms, st, activities, score, nameOf: id => id === 'ai' ? AI_NAME : ((ms.find(m => m.id === id) || {}).name || 'someone') };
}

export function activityLine(a, nameOf) {
  const p = [`${weekday(a.date)}${a.start ? ` ${a.start}` : ''}`, a.title || a.type || a.sport];
  if (a.dist_m > 0) p.push(a.dist_m >= 1000 ? `${(a.dist_m / 1000).toFixed(2)} km` : `${Math.round(a.dist_m)} m`);
  if (a.dur_s > 0) p.push(mmss(a.dur_s));
  if (a.pace100 > 0) p.push(`${mmss(a.pace100)}/100 m`);
  if (a.pace_km > 0) p.push(`${mmss(a.pace_km)}/km`);
  if (a.speed_kmh > 0) p.push(`${a.speed_kmh.toFixed(1)} km/h`);
  if (a.swolf > 0) p.push(`SWOLF ${Math.round(a.swolf)}`);
  if (a.avg_hr > 0) p.push(`HR ${Math.round(a.avg_hr)}`);
  if (a.cadence > 0) p.push(`cadence ${Math.round(a.cadence)}`);
  if (a.steps > 0) p.push(`${Math.round(a.steps)} steps`);
  if (a.elev_m > 0) p.push(`+${Math.round(a.elev_m)} m`);
  if (a.load > 0) p.push(`load ${Math.round(a.load)}`);
  if (a.laps_line) p.push(`lengths: ${a.laps_line}`);
  if (Array.isArray(a.pb) && a.pb.length) p.push(`PERSONAL BEST: ${a.pb.join(', ')}`);
  if (a.verdict) p.push(`own coach said: "${String(a.verdict).slice(0, 200)}"`);
  if (a.note) p.push(`note: "${String(a.note).slice(0, 200)}"`);
  return `[${nameOf(a.author)}] ${p.join(' · ')}`;
}

function scoreLines(w) {
  const out = [];
  for (const m of w.members) {
    const s = w.score.members[m.id];
    if (!s) continue;
    const t = s.this_week || {};
    const imp = (t.improvement || []).map(x => `${x.sport} ${x.pct >= 0 ? '+' : ''}${x.pct}% vs own usual ${x.label}`).join(', ');
    out.push(`${m.name}: total ${s.total} pts, ${w.score.wins[m.id] || 0} weekly duels won, streak ${s.streak} d (best ${s.best_streak}), PBs ${s.pbs}. This week (wk ${t.week}): ${t.days}/${t.target} target days, ${t.minutes} min = ${t.volume_pct}% of own usual ${s.weekly_min} min/wk${imp ? `, ${imp}` : ''}; points ${JSON.stringify(t.points)} = ${t.total}.${m.active ? '' : ' (left the challenge)'}`);
  }
  return out.join('\n');
}

// Wellness only for members who chose to share it (daily events); weight as a trend
function wellnessLines(w, days = 14) {
  const from = new Date(Date.parse(`${w.today}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
  const out = [];
  for (const m of w.members.filter(x => x.active)) {
    const all = Object.entries(w.st.daily[m.id] || {}).sort(([a], [b]) => a.localeCompare(b));
    if (!all.length) continue;
    const recent = all.filter(([d]) => d >= from).map(([, v]) => v);
    const avg = f => { const v = recent.map(x => x[f]).filter(x => x > 0); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
    const wt = all.map(([d, v]) => [d, v.weight_kg]).filter(([, v]) => v > 0);
    const parts = [];
    if (avg('sleep_min')) parts.push(`sleep ${(avg('sleep_min') / 60).toFixed(1)} h/night`);
    if (avg('rhr')) parts.push(`resting HR ${Math.round(avg('rhr'))}`);
    if (avg('hrv')) parts.push(`HRV ${Math.round(avg('hrv'))} ms`);
    if (avg('steps')) parts.push(`${Math.round(avg('steps'))} steps/day`);
    // Weight only as a change (never absolute numbers between different bodies)
    if (wt.length > 1) parts.push(`weight ${(wt[wt.length - 1][1] - wt[0][1] >= 0 ? '+' : '')}${(wt[wt.length - 1][1] - wt[0][1]).toFixed(1)} kg since ${wt[0][0]}`);
    if (parts.length) out.push(`${m.name} (last ${days} days avg): ${parts.join(', ')}`);
  }
  return out.join('\n');
}

function monthLines(w, ym) {
  const mo = SquadCore.month(w.members.filter(m => m.active || w.activities.some(a => a.author === m.id)), w.activities, w.st.daily, ym, w.score);
  return Object.values(mo.members).map(x => {
    const sports = Object.entries(x.by_sport).map(([s, v]) => `${s} ${v.n}× ${v.minutes} min${v.dist_m ? ` ${(v.dist_m / 1000).toFixed(1)} km` : ''}`).join(', ');
    return `${x.name}: ${x.sessions} sessions on ${x.active_days} days, ${x.minutes} min, load ${x.load}; ${sports || 'no sports'}; best streak ${x.best_streak} d; PBs: ${x.pbs.join('; ') || 'none'}; avg weekly score ${x.avg_week_points ?? '–'}${x.longest ? `; longest: ${x.longest.title} ${Math.round(x.longest.dur_s / 60)} min on ${x.longest.date}` : ''}${x.weight_start && x.weight_end !== x.weight_start ? `; weight ${x.weight_end - x.weight_start > 0 ? '+' : ''}${(x.weight_end - x.weight_start).toFixed(1)} kg this month` : ''}${x.avg_sleep_min ? `; sleep ${(x.avg_sleep_min / 60).toFixed(1)} h` : ''}${x.avg_rhr ? `; resting HR ${x.avg_rhr}` : ''}${x.avg_steps ? `; ${x.avg_steps} steps/day` : ''}`;
  }).join('\n');
}

function chatLines(w, limit = 40) {
  return w.st.messages.slice(-limit).map(e => {
    const t = localNow(w.ch, Date.parse(e.created_at)).toISOString();
    const reply = e.body.reply_to ? ' (reply)' : '';
    return `[${weekday(t.slice(0, 10))} ${t.slice(11, 16)}] ${w.nameOf(e.author)}${reply}: ${String(e.body.text || (e.body.ai ? `(asked you to ${e.body.ai.mode})` : '')).slice(0, 600)}`;
  }).join('\n');
}

function commentLines(w, ref) {
  return (w.st.comments[ref] || []).map(c => `${w.nameOf(c.author)}: ${String(c.body.text || '').slice(0, 300)}`).join('\n');
}

function basePrompt(w, sinceDays = 10) {
  const from = new Date(Date.parse(`${w.today}T00:00:00Z`) - sinceDays * 86400000).toISOString().slice(0, 10);
  const recent = w.activities.filter(a => a.date >= from).sort((a, b) => (a.date + (a.start || '')).localeCompare(b.date + (b.start || '')));
  const people = w.members.filter(m => m.active).map(m => {
    const b = m.baseline || {};
    const sp = (m.sports || []).join(', ') || 'not set';
    return `- ${m.name}: sports ${sp}; target ${b.target_days || w.rules.days_per_week || 4} days/week${b.weekly_min ? `; usual ${Math.round(b.weekly_min)} min/week` : ''}${b.about ? `; about: ${String(b.about).slice(0, 200)}` : ''}`;
  }).join('\n');
  const roast = w.rules.roast || 'mild';
  return `You are ${AI_NAME}, the AI coach and third member of a group chat between friends doing a fitness challenge together.
Challenge "${w.ch.name}" — ${w.ch.starts} to ${w.ch.ends || 'open-ended'}; today is ${weekday(w.today)} ${w.today}.${w.rules.goal ? ` Goal: ${w.rules.goal}.` : ''}
People:
${people}

HOW YOU TALK
- Like a witty, warm friend who knows training: short chat messages (1–4 sentences unless asked for more), names, a little competitive banter. Emojis sparingly. No headings, tables or long lists.
- FAIRNESS: they have different bodies, sports and starting points. Never compare raw numbers (pace, distance, HR, speed) between people. Judge each person only against his own usual numbers and his own score below.
- Only use facts and numbers given here. Never invent workouts or numbers; if something is unknown, say so.
- Roast level: ${roast === 'off' ? 'no roasting — keep it supportive' : roast === 'spicy' ? 'spicy — sharp teasing is welcome' : 'mild — light teasing'}. Never joke about bodies, weight, looks, health, family or anything personal.
- Reply in the language the people use in the chat.

SCOREBOARD (relative to self; consistency 40 + volume 30 + improvement 30 + bonuses per week)
${scoreLines(w) || 'no scores yet'}

${(() => { const wl = wellnessLines(w); return wl ? `WELLNESS (shared by choice — be supportive only, never tease about weight, sleep or health)\n${wl}\n\n` : ''; })()}ACTIVITIES, last ${sinceDays} days
${recent.map(a => activityLine(a, w.nameOf)).join('\n') || 'none'}

CHAT (latest at the bottom)
${chatLines(w) || '(empty)'}
`;
}

function targetText(w, ref) {
  if (!ref) return '';
  if (ref.startsWith('act:')) {
    const a = w.st.activities.get(ref);
    if (!a) return '';
    const c = commentLines(w, ref);
    return `THE ACTIVITY\n${activityLine(a, w.nameOf)}${a.detail ? `\nDetail: ${String(a.detail).slice(0, 1500)}` : ''}${c ? `\nComments:\n${c}` : ''}`;
  }
  const m = w.st.messages.find(e => e.id === ref);
  return m ? `THE MESSAGE\n${w.nameOf(m.author)}: ${String(m.body.text || '').slice(0, 1500)}` : '';
}

function requestPrompt(w, req) {
  const ai = req.body.ai || { mode: 'ask' };
  const who = w.nameOf(req.author);
  const target = targetText(w, ai.ref);
  const text = String(req.body.text || '').slice(0, 2000);
  let task;
  if (ai.mode === 'report') {
    const ym = ai.month || w.today.slice(0, 7);
    return `${basePrompt(w, 31)}
MONTH ${ym} IN NUMBERS
${monthLines(w, ym)}

${who}'s message${text ? `: "${text}"` : ''}

TASK: Write the squad's MONTHLY REPORT for ${ym}: a short headline, then for each person what he did and how it compares to HIS OWN usual (consistency, volume, improvement, personal bests, streaks${wellnessLines(w) ? ', and — supportively — the wellness he shared' : ''}), the duel result for the month, one funny award each, and one concrete goal per person for next month. Use **bold** for key numbers. 8–14 short lines; this one may be longer than a chat message.
Write only your chat message.`;
  }
  if (ai.mode === 'review') task = `${who} asked you to REVIEW ${target ? 'this' : 'the latest activity'}. Give a short, useful review: what went well (relative to the person's own usual), one thing to improve, one concrete next step. 3–6 sentences.`;
  else if (ai.mode === 'roast') task = `${who} asked you to ROAST ${target ? 'this' : 'somebody'}. Playful roast of the workout, the data or the choices — punch at the effort, never at the person. 2–4 sentences, end with one genuine compliment or tip.${w.rules.roast === 'off' ? ' Roasting is switched off in this challenge: give a friendly, gently teasing comment instead.' : ''}`;
  else task = `${who} is talking to you. Answer the message directly and helpfully.`;
  return `${basePrompt(w)}
${target ? `${target}\n` : ''}
${who}'s message${text ? `: "${text}"` : ' (no text)'}

TASK: ${task}
Write only your chat message.`;
}

// ---------- triggers for unprompted messages ----------
function scanTriggers(w, state, newEvents) {
  const now = Date.now();
  const list = (state.pending || []).filter(t => now - t.at < TRIGGER_TTL_MS);
  const seenFirst = new Set(state.first_done || []);
  for (const e of newEvents) {
    if (e.kind !== 'activity' || e.author === 'ai') continue;
    const a = w.st.activities.get(SquadCore.actRef(e.author, e.body.key));
    if (!a || a.seq !== e.seq) continue; // superseded/deleted
    const name = w.nameOf(e.author);
    const at = Date.parse(e.created_at) || now;
    if (Array.isArray(a.pb) && a.pb.length) list.push({ type: 'pb', at, ref: a.ref, text: `${name} just set a personal best (${a.pb.join(', ')}) in: ${activityLine(a, w.nameOf)}` });
    if (!seenFirst.has(e.author)) { seenFirst.add(e.author); list.push({ type: 'first', at, ref: a.ref, text: `${name}'s first workout in the challenge: ${activityLine(a, w.nameOf)}` }); }
    const s = w.score.members[e.author];
    if (s && a.date === w.today && STREAK_MARKS.includes(s.streak) && !(state.streaks || {})[`${e.author}:${s.streak}:${w.today}`]) {
      state.streaks = Object.assign({}, state.streaks, { [`${e.author}:${s.streak}:${w.today}`]: 1 });
      list.push({ type: 'streak', at, ref: a.ref, text: `${name} reached a ${s.streak}-day streak today.` });
    }
  }
  state.first_done = Array.from(seenFirst);
  // Lively chat: many human messages since the AI last spoke or last considered it
  const lastAi = Math.max(state.chat_mark || 0, ...w.st.messages.filter(m => m.author === 'ai').map(m => m.seq), 0);
  const humans = w.st.messages.filter(m => m.author !== 'ai' && m.seq > lastAi);
  if (humans.length >= CHAT_TRIGGER_MSGS && !list.some(t => t.type === 'chat')) {
    list.push({ type: 'chat', at: now, text: 'The two of them have been chatting for a while without you.' });
    state.chat_mark = humans[humans.length - 1].seq;
  }
  // Quiet member: no activity for 3+ days (nudged at most every 3 days)
  const todayN = Date.parse(`${w.today}T00:00:00Z`) / 86400000;
  state.nudged = state.nudged || {};
  for (const m of w.members.filter(x => x.active)) {
    const mine = w.activities.filter(a => a.author === m.id).map(a => a.date).sort();
    const lastDay = (w.lastDates && w.lastDates[m.id]) || mine[mine.length - 1] || '';
    const from = [lastDay, w.ch.starts, String(m.joined_at || '').slice(0, 10)].sort().pop();
    const quietDays = todayN - Date.parse(`${from}T00:00:00Z`) / 86400000;
    if (quietDays >= 3 && w.today >= w.ch.starts && (!state.nudged[m.id] || now - state.nudged[m.id] > 3 * 86400000) && !list.some(t => t.type === 'quiet' && t.member === m.id)) {
      list.push({ type: 'quiet', at: now, member: m.id, text: `${m.name} has not logged a workout for ${Math.floor(quietDays)} days.` });
    }
  }
  const prio = { pb: 0, streak: 1, first: 2, quiet: 3, chat: 4 };
  state.pending = list.filter(t => now - t.at < TRIGGER_TTL_MS).sort((a, b) => prio[a.type] - prio[b.type]).slice(0, 6);
}

function freeBudgetOk(state, ch) {
  const now = Date.now();
  const day = localToday(ch);
  const used = state.day === day ? state.day_n || 0 : 0;
  // After a provider error wait 15 min, so polling clients don't hammer a failing key
  return now - (state.free_at || 0) >= FREE_GAP_MS && used < FREE_PER_DAY && now - (state.err_at || 0) >= 15 * 60000;
}

function interruptPrompt(w, triggers) {
  return `${basePrompt(w)}
You may chime in on your own (nobody asked) because:
${triggers.map(t => `- ${t.text}`).join('\n')}

TASK: If you have something genuinely fun or useful to say, write ONE short chat message (1–3 sentences) — celebrate, tease, nudge or challenge. If it would just be noise, reply exactly PASS.`;
}

function recapPrompt(w, kind) {
  const week = w.score.duels[w.score.duels.length - 1];
  const todays = w.activities.filter(a => a.date === w.today);
  let task = `Write the DAILY RECAP for ${weekday(w.today)} ${w.today}: who trained today and how it compares to his own usual, scoreboard movement, streaks, and one small challenge for tomorrow. 3–6 short lines, chat style.${todays.length ? '' : ' Nobody logged a workout today — keep it short and motivating.'}`;
  if (kind === 'week' && week) task += ` Today is the last day of week ${week.week}: also announce the weekly duel result (higher relative score wins; ${week.winners.length === 1 ? `${w.nameOf(week.winners[0])} leads` : 'it is a tie so far'}).`;
  if (kind === 'final') task = `The challenge has ENDED. Write the final recap: overall winner by total relative points, weekly duels won, best streaks, personal bests, a funny award for each person, and a suggestion for the next challenge. 5–9 short lines.`;
  return `${basePrompt(w, kind === 'final' ? 60 : 3)}\nTASK: ${task}\nWrite only your chat message.`;
}

// ---------- the run ----------
async function lease(env, cid) {
  const now = Date.now();
  const until = now + LEASE_MS;
  const r = await env.DB.prepare('UPDATE challenges SET ai_lock=? WHERE id=? AND ai_lock < ? AND ai_config IS NOT NULL').bind(until, cid, now).run();
  if (!r.meta.changes) return null;
  const l = { until, cid };
  l.renew = async () => {
    const next = Date.now() + LEASE_MS;
    const x = await env.DB.prepare('UPDATE challenges SET ai_lock=? WHERE id=? AND ai_lock=?').bind(next, cid, l.until).run();
    if (!x.meta.changes) throw new Error('lease lost');
    l.until = next;
  };
  l.release = () => env.DB.prepare('UPDATE challenges SET ai_lock=0 WHERE id=? AND ai_lock=?').bind(cid, l.until).run();
  return l;
}

async function saveState(env, l, state) {
  await env.DB.prepare('UPDATE challenges SET ai_state=? WHERE id=? AND ai_lock=?').bind(JSON.stringify(state), l.cid, l.until).run();
}

/** Cheap check (no model call): should somebody call runAI now? */
export async function aiDue(env, ch, opts = {}) {
  if (!ch.ai_config || ch.ai_lock > Date.now()) return false;
  const state = parse(ch.ai_state, {});
  const req = await env.DB.prepare("SELECT 1 FROM events WHERE challenge_id=? AND seq > ? AND kind='msg' AND json_extract(body,'$.ai') IS NOT NULL LIMIT 1").bind(ch.id, state.done_seq || 0).first();
  if (req) return true;
  if (recapKind(ch, state)) return true;
  const rules = parse(ch.rules, {});
  if (rules.interrupts === false || !freeBudgetOk(state, ch)) return false;
  const last = await env.DB.prepare("SELECT created_at FROM events WHERE challenge_id=? AND kind='msg' AND author != 'ai' ORDER BY seq DESC LIMIT 1").bind(ch.id).first();
  if (last && Date.now() - Date.parse(last.created_at) < quietMs(env)) return false;
  // New events to scan, waiting triggers, or the periodic quiet-member check (cron)
  return ch.seq > (state.seen_seq || 0) || (state.pending || []).length > 0 || (opts.cron && Date.now() - (state.scan_at || 0) > 6 * 3600000);
}

function recapKind(ch, state) {
  const rules = parse(ch.rules, {});
  if (rules.recap === false) return null;
  const today = localToday(ch);
  if (today < ch.starts) return null;
  if (ch.ends && today > ch.ends) return state.final_done ? null : 'final';
  if (state.recap_day === today || localNow(ch).getUTCHours() < (rules.recap_hour ?? 21)) return null;
  const dayIdx = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${ch.starts}T00:00:00Z`)) / 86400000);
  return dayIdx % 7 === 6 ? 'week' : 'day';
}

/**
 * Runs everything that is due for one challenge. Safe to call from several clients and
 * the cron at the same time — only the lease holder works, the others return busy.
 * post(ch, event) appends an AI event and returns its seq.
 */
export async function runAI(env, cid, post, opts = {}) {
  const l = await lease(env, cid);
  if (!l) return { ran: false, busy: true };
  const posted = [];
  // The context is built once per run (CPU budget); messages posted during the run are appended
  let world = null;
  const getWorld = async ch => world || (world = await loadWorld(env, ch));
  const remember = (seq, body) => { if (world && seq) world.st.messages.push({ seq, id: `ai-${seq}`, kind: 'msg', author: 'ai', body, created_at: nowIso() }); };
  try {
    for (let round = 0; round < 4; round++) {
      const ch = await env.DB.prepare(`SELECT ${CH_COLS} FROM challenges WHERE id=?`).bind(cid).first();
      if (!ch || !ch.ai_config) break;
      const state = parse(ch.ai_state, {});
      const rules = parse(ch.rules, {});

      // 1. Requests, oldest first
      const reqs = (await env.DB.prepare("SELECT seq, id, kind, author, ref, body, created_at FROM events WHERE challenge_id=? AND seq > ? AND kind='msg' AND json_extract(body,'$.ai') IS NOT NULL ORDER BY seq LIMIT 3").bind(cid, state.done_seq || 0).all()).results;
      if (reqs.length) {
        for (const r of reqs) {
          r.body = parse(r.body, {});
          const w = await getWorld(ch);
          if (!w.st.messages.some(m => m.id === r.id)) w.st.messages.push(r);
          await l.renew();
          try {
            const out = await modelFor(env, ch, requestPrompt(w, r), { maxTokens: { report: 3000, review: 1500 }[r.body.ai.mode] || 800 });
            const text = String(out.text || '').trim();
            const body = { text, mode: r.body.ai.mode, reply_to: r.id, target: r.body.ai.ref || null };
            if (text) { const seq = await post(ch, { kind: 'msg', ref: r.id, body }); posted.push(seq); remember(seq, body); }
          } catch (e) {
            posted.push(await post(ch, { kind: 'system', ref: r.id, body: { type: 'ai_error', text: `${AI_NAME} could not answer: ${e.message}` } }));
          }
          state.done_seq = r.seq;
          await saveState(env, l, state);
        }
        continue; // new requests may have arrived meanwhile
      }

      // 2. Recap
      const rk = recapKind(ch, state);
      if (rk) {
        const w = await getWorld(ch);
        const today = localToday(ch);
        const quietDay = rk === 'day' && !w.activities.some(a => a.date === today) && !w.st.messages.some(m => m.author !== 'ai' && localToday(ch, Date.parse(m.created_at)) === today);
        if (!quietDay) {
          await l.renew();
          try {
            const out = await modelFor(env, ch, recapPrompt(w, rk), { maxTokens: rk === 'final' ? 1500 : 900 });
            const text = String(out.text || '').trim();
            if (text) posted.push(await post(ch, { kind: 'msg', body: { text, mode: rk === 'final' ? 'final' : 'recap', day: today } }));
          } catch (e) { console.warn('recap', e.message); }
        }
        state.recap_day = today;
        if (rk === 'final') state.final_done = true;
        await saveState(env, l, state);
        continue;
      }

      // 3. Unprompted messages
      if (rules.interrupts !== false && freeBudgetOk(state, ch)) {
        const last = await env.DB.prepare("SELECT created_at FROM events WHERE challenge_id=? AND kind='msg' AND author != 'ai' ORDER BY seq DESC LIMIT 1").bind(cid).first();
        if (!last || Date.now() - Date.parse(last.created_at) >= quietMs(env)) {
          const w = await getWorld(ch);
          const fresh = (await env.DB.prepare("SELECT seq, id, kind, author, ref, body, created_at FROM events WHERE challenge_id=? AND seq > ? AND kind='activity' ORDER BY seq LIMIT 200").bind(cid, state.seen_seq || 0).all()).results.map(e => Object.assign(e, { body: parse(e.body, {}) }));
          scanTriggers(w, state, fresh);
          state.seen_seq = ch.seq;
          state.scan_at = Date.now();
          if (state.pending.length) {
            const use = state.pending.slice(0, 3);
            await l.renew();
            try {
              const out = await modelFor(env, ch, interruptPrompt(w, use), { maxTokens: 500 });
              const text = String(out.text || '').trim();
              if (text && !/^PASS\b/i.test(text)) {
                posted.push(await post(ch, { kind: 'msg', ref: use[0].ref || null, body: { text, mode: 'interrupt', reasons: use.map(t => t.type), target: use[0].ref || null } }));
                const day = localToday(ch);
                state.day_n = (state.day === day ? state.day_n || 0 : 0) + 1;
                state.day = day;
                state.free_at = Date.now();
              }
              for (const t of use) if (t.type === 'quiet') state.nudged = Object.assign({}, state.nudged, { [t.member]: Date.now() });
              state.pending = state.pending.slice(use.length);
            } catch (e) { console.warn('interrupt', e.message); state.err_at = Date.now(); }
          }
          await saveState(env, l, state);
        }
      }
      break;
    }
  } catch (e) {
    console.warn('runAI', e.message);
  } finally {
    await l.release();
  }
  return { ran: true, posted: posted.filter(Boolean) };
}

export { rid, parse, nowIso, AI_NAME };
