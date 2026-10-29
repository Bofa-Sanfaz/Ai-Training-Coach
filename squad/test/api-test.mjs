// End-to-end test of the Squad server against `wrangler dev` (local D1) with a mock AI.
// Run:  npx wrangler d1 migrations apply squad --local
//       npx wrangler dev --port 8787 --var ALLOW_HTTP_AI:1 --var SQUAD_QUIET_MS:1500 --test-scheduled
//       node test/api-test.mjs
import http from 'node:http';
import '../../www/js/app/squad-core.js';

const API = process.env.SQUAD_URL || 'http://127.0.0.1:8787';
const SquadCore = globalThis.SquadCore;
let pass = 0, failed = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { failed++; console.log(`FAIL ${name}`, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const id = p => `${p}-${Math.random().toString(36).slice(2, 12)}`;

async function call(method, path, body, tok) {
  const res = await fetch(API + path, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, tok ? { Authorization: `Bearer ${tok}` } : {}), body: body ? JSON.stringify(body) : undefined });
  let d = null;
  try { d = await res.json(); } catch (e) { d = null; }
  return { status: res.status, d };
}

// ---------- mock OpenAI-compatible provider ----------
const prompts = [];
let slowMs = 0;
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', async () => {
    const b = JSON.parse(raw || '{}');
    const m = b.messages[0];
    const text = typeof m.content === 'string' ? m.content : m.content.map(c => c.text || '').join('');
    const hasImage = Array.isArray(m.content) && m.content.some(c => c.type === 'image_url');
    prompts.push({ text, hasImage, auth: req.headers.authorization });
    if (slowMs) await sleep(slowMs);
    let reply;
    if (hasImage) reply = JSON.stringify({ sport: 'swim', type: 'Pool swim', date: '2026-10-28', dur_s: 1800, dist_m: 1000, pace100_s: 160, swolf: 41, pool_m: 25 });
    else if (/reply exactly PASS/.test(text)) reply = 'PB alert! Mock interrupt.';
    else if (/DAILY RECAP|final recap/i.test(text)) reply = 'Mock recap of the day.';
    else reply = `Mock answer to: ${(text.match(/TASK: (.{0,40})/) || [])[1]}`;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: reply }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 100 } }));
  });
});
await new Promise(r => mock.listen(8799, '127.0.0.1', r));

try {
  // ---------- basics ----------
  let r = await call('GET', '/api/health');
  ok(r.status === 200 && r.d.ok, 'health');
  const page = await fetch(`${API}/index.html`);
  ok(page.status === 200 && /<html/i.test(await page.text()), 'web app served from www');
  r = await call('GET', '/_tmp_test.html');
  ok(r.status === 404, 'www/_tmp* not published');

  // ---------- create / join ----------
  const tz = 240; // UTC+4
  const today = new Date(Date.now() + tz * 60000).toISOString().slice(0, 10);
  const minus = n => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
  r = await call('POST', '/api/challenges', { name: 'Test duel', starts: minus(9), tz_offset: tz, rules: { days_per_week: 4, recap: false, roast: 'spicy' }, member: { name: 'Mustafa', sports: ['ride', 'run', 'swim'], baseline: { weekly_min: 300, metrics: { swim: 150, run: 330 } } } });
  ok(r.status === 201 && r.d.token && r.d.challenge.invite.length === 8, 'create challenge', r.d);
  const cid = r.d.challenge.id, invite = r.d.challenge.invite, A = r.d.token, aId = r.d.member_id;
  ok(r.d.challenge.is_owner === true && !('ai_config' in r.d.challenge), 'creator is owner, no secrets in challenge');

  r = await call('POST', '/api/join', { invite: 'zzzz-zzzz', member: { name: 'X' } });
  ok(r.status === 404, 'wrong invite → 404');
  r = await call('POST', '/api/join', { invite: `${invite.slice(0, 4).toLowerCase()}-${invite.slice(4)}`, member: { name: 'Assad', sports: ['walk', 'swim'] } });
  ok(r.status === 201 && r.d.token && r.d.challenge.is_owner === false, 'join with lowercase + dash', r.d);
  const B = r.d.token, bId = r.d.member_id;

  r = await call('GET', `/api/c/${cid}/changes?since=0`);
  ok(r.status === 401, 'no token → 401');
  r = await call('GET', `/api/c/${cid}/changes?since=0`, null, 'x'.repeat(43));
  ok(r.status === 403, 'wrong token → 403');

  // ---------- events ----------
  const m1 = id('msg');
  r = await call('POST', `/api/c/${cid}/events`, { events: [{ id: m1, kind: 'msg', body: { text: 'Ready to lose, Assad?' } }] }, A);
  ok(r.status === 200 && r.d.acks[0].seq > 0, 'post message', r.d);
  const s1 = r.d.acks[0].seq;
  r = await call('POST', `/api/c/${cid}/events`, { events: [{ id: m1, kind: 'msg', body: { text: 'Ready to lose, Assad?' } }] }, A);
  ok(r.d.acks[0].seq === s1, 'retry of the same event id is idempotent (same seq)', r.d);

  const acts = [
    { key: 'w1', sport: 'walk', type: 'Outdoor walk', date: minus(8), dur_s: 3600, dist_m: 5200, pace_km: 692, steps: 7000 },
    { key: 'w2', sport: 'walk', type: 'Outdoor walk', date: minus(6), dur_s: 3000, dist_m: 4500, pace_km: 667 },
    { key: 's1', sport: 'swim', type: 'Pool swim', date: minus(5), dur_s: 2400, dist_m: 1200, pace100: 175, swolf: 44 },
    { key: 'w3', sport: 'walk', type: 'Outdoor walk', date: minus(1), dur_s: 3300, dist_m: 5000, pace_km: 640 }
  ];
  r = await call('POST', `/api/c/${cid}/events`, { events: acts.map(a => ({ id: id('act'), kind: 'activity', body: a })) }, B);
  ok(r.d.acks.length === 4 && r.d.acks.every(x => x.seq), 'Assad posts 4 activities in one batch', r.d);
  const mine = [
    { key: 'r1', sport: 'run', type: 'Run', date: minus(9), dur_s: 2400, dist_m: 7000, pace_km: 343 },
    { key: 'r2', sport: 'run', type: 'Run', date: minus(7), dur_s: 2700, dist_m: 8200, pace_km: 329 },
    { key: 'sw', sport: 'swim', type: 'Pool swim', date: minus(2), dur_s: 2000, dist_m: 1400, pace100: 143, swolf: 36, laps_line: '25 m: 0:36 (16 str) 0:35 (15 str)' }
  ];
  r = await call('POST', `/api/c/${cid}/events`, { events: mine.map(a => ({ id: id('act'), kind: 'activity', body: a })) }, A);
  ok(r.d.acks.length === 3, 'Mustafa posts 3 activities');
  // A re-share of the same workout (e.g. after the coach debrief) replaces the old version
  r = await call('POST', `/api/c/${cid}/events`, { events: [{ id: id('act'), kind: 'activity', body: Object.assign({}, mine[2], { verdict: 'Smooth and controlled.' }) }] }, A);
  const actRefB = SquadCore.actRef(bId, 'w3'), actRefA = SquadCore.actRef(aId, 'sw');

  const c1 = id('cmt');
  r = await call('POST', `/api/c/${cid}/events`, { events: [
    { id: c1, kind: 'comment', ref: actRefB, body: { text: 'Is that a walk or a nap?' } },
    { id: id('rx'), kind: 'reaction', ref: actRefB, body: { emoji: '🔥' } },
    { id: id('rx'), kind: 'reaction', ref: m1, body: { emoji: '😂' } },
    { id: id('bad'), kind: 'system', body: {} },
    { id: id('bad'), kind: 'msg', body: { text: '' } },
    { id: 'short', kind: 'msg', body: { text: 'bad id' } },
    { id: id('big'), kind: 'activity', body: { key: 'x', date: today, blob: 'x'.repeat(20000) } }
  ] }, A);
  ok(r.d.acks.length === 3 && r.d.rejected.length === 4, 'valid events accepted, 4 invalid rejected', r.d);
  r = await call('POST', `/api/c/${cid}/events`, { events: [{ id: id('rx'), kind: 'reaction', ref: m1, body: { emoji: '😂' } }, { id: id('rx'), kind: 'reaction', ref: m1, body: { emoji: '😂', on: false } }] }, B);
  r = await call('POST', `/api/c/${cid}/events`, { events: [{ id: id('del'), kind: 'delete', ref: m1 }, { id: id('del'), kind: 'delete', ref: actRefA }] }, B);
  ok(r.d.acks.length === 0 && r.d.rejected.length === 2, 'cannot delete someone else\'s message or activity', r.d);
  const tmp = id('msg');
  await call('POST', `/api/c/${cid}/events`, { events: [{ id: tmp, kind: 'msg', body: { text: 'typo' } }] }, B);
  r = await call('POST', `/api/c/${cid}/events`, { events: [{ id: id('del'), kind: 'delete', ref: tmp }] }, B);
  ok(r.d.acks.length === 1, 'can delete own message');

  // ---------- sync ----------
  r = await call('GET', `/api/c/${cid}/changes?since=0`, null, B);
  ok(r.status === 200 && r.d.events.length > 10 && r.d.members.length === 2 && r.d.me === bId, 'changes since 0', { n: r.d.events.length });
  ok(r.d.events.every((e, i, a) => i === 0 || e.seq > a[i - 1].seq), 'events ordered by seq');
  ok(!JSON.stringify(r.d).includes('token_hash') && !JSON.stringify(r.d).includes('apiKey'), 'no secrets in changes');
  const all = r.d.events;
  const head = r.d.seq;
  r = await call('GET', `/api/c/${cid}/changes?since=${head}`, null, A);
  ok(r.d.events.length === 0 && r.d.seq === head, 'changes since head → nothing');
  r = await call('GET', `/api/c/${cid}/changes?since=${head - 3}`, null, A);
  ok(r.d.events.length === 3, 'incremental sync returns exactly the newer events');

  const st = SquadCore.fold(all);
  ok(st.messages.length === 1 && st.messages[0].id === m1, 'fold: deleted message removed', st.messages.map(m => m.body.text));
  ok(st.activities.size === 7 && st.activities.get(actRefA).verdict === 'Smooth and controlled.', 'fold: 7 activities, re-share replaced the old version');
  ok(st.comments[actRefB] && st.comments[actRefB].length === 1, 'fold: comment attached to activity');
  ok(st.reactions[actRefB]['🔥'].has(aId) && st.reactions[m1]['😂'].has(aId) && !st.reactions[m1]['😂'].has(bId), 'fold: reactions incl. toggle off');

  const members = r.d.members;
  const score = SquadCore.compute({ starts: minus(9), ends: null, rules: { days_per_week: 4 } }, members, Array.from(st.activities.values()), today);
  const sa = score.members[aId], sb = score.members[bId];
  ok(score.weeks === 2 && sa.weeks.length === 2 && sb.weeks.length === 2, 'score: 2 challenge weeks', score.weeks);
  ok(sb.baseline_from_challenge === true && sa.baseline_from_challenge === false, 'score: Assad baseline from first week, Mustafa from his history');
  ok(sb.weeks[1].improvement.some(x => x.sport === 'walk' && x.pct > 0), 'score: Assad walking faster than his own first week counts as improvement', sb.weeks[1]);
  ok(sa.weeks[1].improvement.some(x => x.sport === 'swim' && x.pct > 0), 'score: Mustafa swim pace better than his baseline', sa.weeks[1]);
  ok(sa.total > 0 && sb.total > 0 && score.duels.length === 2, 'score: totals and duels', { a: sa.total, b: sb.total });

  // ---------- profile / settings ----------
  r = await call('PATCH', `/api/c/${cid}/me`, { sports: ['walk', 'swim'], baseline: { weekly_min: 180, target_days: 3 } }, B);
  ok(r.status === 200 && r.d.members.find(m => m.id === bId).baseline.target_days === 3, 'member updates own baseline');
  r = await call('PATCH', `/api/c/${cid}`, { rules: { days_per_week: 5 } }, B);
  ok(r.status === 403, 'non-owner cannot change settings');
  r = await call('PATCH', `/api/c/${cid}`, { name: 'Autumn duel', rules: { days_per_week: 5 } }, A);
  ok(r.status === 200 && r.d.challenge.name === 'Autumn duel' && r.d.challenge.rules.days_per_week === 5 && r.d.challenge.rules.roast === 'spicy', 'owner changes settings, other rules kept', r.d);

  // ---------- AI ----------
  r = await call('PUT', `/api/c/${cid}/ai`, { config: { type: 'openai', baseUrl: 'http://127.0.0.1:8799/v1', model: 'mock', apiKey: 'sk-test-123' } }, B);
  ok(r.status === 403, 'non-owner cannot set the AI');
  r = await call('PUT', `/api/c/${cid}/ai`, { config: { type: 'openai', baseUrl: 'http://evil.example/v1', model: 'mock', apiKey: 'k' } }, A);
  ok(r.status === 400, 'plain http provider refused');
  r = await call('PUT', `/api/c/${cid}/ai`, { config: { type: 'openai', baseUrl: 'http://127.0.0.1:8799/v1', model: 'mock', apiKey: 'sk-test-123', priceIn: 1, priceOut: 5, capUsd: 1 } }, A);
  ok(r.status === 200 && r.d.ai.enabled && r.d.ai.has_key && !('apiKey' in r.d.ai), 'owner sets AI, key never returned', r.d);
  r = await call('PUT', `/api/c/${cid}/ai`, { config: { type: 'openai', baseUrl: 'http://127.0.0.1:8799/v1', model: 'mock2', apiKey: '', priceIn: 1, priceOut: 5, capUsd: 1 } }, A);
  ok(r.d.ai.has_key && r.d.ai.model === 'mock2', 'changing the model keeps the stored key');

  const ask = id('msg');
  r = await call('POST', `/api/c/${cid}/events`, { events: [{ id: ask, kind: 'msg', body: { text: '@AI who is doing better relative to himself?' } }] }, B);
  ok(r.d.ai_due === true, '@AI mention makes the AI due', r.d);
  prompts.length = 0;
  slowMs = 1200;
  const [run1, run2] = await Promise.all([call('POST', `/api/c/${cid}/ai/run`, {}, B), sleep(200).then(() => call('POST', `/api/c/${cid}/ai/run`, {}, A))]);
  slowMs = 0;
  ok(run1.d.ran === true && run1.d.posted.length >= 1, 'AI run answers', run1.d);
  ok(run2.d.busy === true, 'second simultaneous run is refused (one AI at a time)', run2.d);
  ok(prompts.length >= 1 && prompts[0].auth === 'Bearer sk-test-123', 'server used the stored key');
  const p0 = prompts[0] ? prompts[0].text : '';
  ok(/SCOREBOARD/.test(p0) && /Assad/.test(p0) && /Mustafa/.test(p0) && /Never compare raw numbers/.test(p0), 'prompt has scoreboard, both people, fairness rule');
  ok(/lengths: 25 m: 0:36/.test(p0) && /own coach said: "Smooth and controlled."/.test(p0), 'prompt has lap detail and coach verdict');
  ok(/Assad's message: "@AI who is doing better relative to himself\?"/.test(p0), 'prompt has the question and who asked');
  ok(/Roast level: spicy/.test(p0), 'prompt carries roast level');

  r = await call('GET', `/api/c/${cid}/changes?since=${head}`, null, A);
  const aiMsg = r.d.events.find(e => e.author === 'ai' && e.kind === 'msg');
  ok(aiMsg && aiMsg.body.reply_to === ask && /^Mock answer/.test(aiMsg.body.text), 'AI reply posted with reply_to', aiMsg);

  // Roast an activity
  prompts.length = 0;
  await call('POST', `/api/c/${cid}/events`, { events: [{ id: id('msg'), kind: 'msg', body: { text: 'Roast this walk', ai: { mode: 'roast', ref: actRefB } } }] }, A);
  r = await call('POST', `/api/c/${cid}/ai/run`, {}, A);
  ok(prompts.length === 1 && /THE ACTIVITY/.test(prompts[0].text) && /Is that a walk or a nap\?/.test(prompts[0].text) && /ROAST/.test(prompts[0].text), 'roast prompt contains the activity and its comments');
  ok(/never at the person/.test(prompts[0].text) && /Never joke about bodies/.test(prompts[0].text), 'roast safety rules present');

  // Interruption: a personal best, then quiet → AI chimes in once; budget then blocks a second one
  await sleep(1700);
  prompts.length = 0;
  r = await call('POST', `/api/c/${cid}/events`, { events: [{ id: id('act'), kind: 'activity', body: { key: 'w4', sport: 'walk', type: 'Outdoor walk', date: today, dur_s: 3000, dist_m: 5000, pace_km: 600, pb: ['fastest 5 km walk'] } }] }, B);
  ok(r.d.ai_due === true, 'new PB activity makes the AI due once things are quiet', r.d);
  r = await call('POST', `/api/c/${cid}/ai/run`, {}, B);
  ok(prompts.length === 1 && /personal best \(fastest 5 km walk\)/.test(prompts[0].text) && /reply exactly PASS/.test(prompts[0].text), 'interrupt prompt explains the trigger', prompts.map(p => p.text.slice(-400)));
  r = await call('GET', `/api/c/${cid}/changes?since=${head}`, null, A);
  const intr = r.d.events.filter(e => e.author === 'ai' && e.body.mode === 'interrupt');
  ok(intr.length === 1 && intr[0].body.reasons.includes('pb'), 'one unprompted AI message posted', intr.map(e => e.body));
  await call('POST', `/api/c/${cid}/events`, { events: [{ id: id('act'), kind: 'activity', body: { key: 'w5', sport: 'walk', date: today, dur_s: 1200, dist_m: 2000, pace_km: 600, pb: ['longest streak'] } }] }, B);
  await sleep(1700);
  r = await call('GET', `/api/c/${cid}/changes?since=${head}`, null, A);
  ok(r.d.ai_due === false, 'no second unprompted message within 2 hours', r.d.ai_due);

  // Human talking recently blocks interruptions (90 s rule, 1.5 s in this test)
  // Recap: enable with recap hour 0 → due right away
  await call('PATCH', `/api/c/${cid}`, { rules: { recap: true, recap_hour: 0 } }, A);
  prompts.length = 0;
  r = await call('POST', `/api/c/${cid}/ai/run`, {}, A);
  ok(prompts.some(p => /DAILY RECAP/.test(p.text)), 'daily recap written when due', prompts.map(p => p.text.slice(-200)));
  r = await call('POST', `/api/c/${cid}/ai/run`, {}, A);
  ok(!(r.d.posted || []).length, 'recap only once per day', r.d);

  // Wellness (opt-in 'daily' events): validated ranges, weight only as a change in the AI context
  r = await call('POST', `/api/c/${cid}/events`, { events: [
    { id: id('day'), kind: 'daily', body: { date: minus(5), weight_kg: 92.4, steps: 8000, rhr: 62, sleep_min: 410, junk: 'x' } },
    { id: id('day'), kind: 'daily', body: { date: minus(1), weight_kg: 91.6, steps: 999999, rhr: 5 } },
    { id: id('day'), kind: 'daily', body: { weight_kg: 90 } }
  ] }, B);
  ok(r.d.acks.length === 2 && r.d.rejected.length === 1, 'daily events: dated ones accepted, undated rejected', r.d);
  r = await call('GET', `/api/c/${cid}/changes?since=0`, null, A);
  const days = SquadCore.fold(r.d.events).daily[bId] || {};
  ok(days[minus(5)] && days[minus(5)].steps === 8000 && !('junk' in days[minus(5)]) && days[minus(1)] && !('steps' in days[minus(1)]) && !('rhr' in days[minus(1)]), 'daily: unknown fields and out-of-range values dropped', days);
  prompts.length = 0;
  const repAsk = id('msg');
  await call('POST', `/api/c/${cid}/events`, { events: [{ id: repAsk, kind: 'msg', body: { text: 'Monthly report please', ai: { mode: 'report', month: today.slice(0, 7) } } }] }, B);
  r = await call('POST', `/api/c/${cid}/ai/run`, {}, B);
  const rp = prompts[0] ? prompts[0].text : '';
  ok(/MONTH \d{4}-\d{2} IN NUMBERS/.test(rp) && /MONTHLY REPORT/.test(rp), 'report prompt has the month in numbers', rp.slice(-600));
  ok(/weight -0\.8 kg since/.test(rp) && !/91\.6|92\.4/.test(rp), 'weight only as a change, never absolute', rp.match(/WELLNESS[\s\S]{0,300}/));
  ok(/never tease about weight/.test(rp), 'wellness rule present');
  r = await call('GET', `/api/c/${cid}/changes?since=0`, null, A);
  ok(r.d.events.some(e => e.author === 'ai' && e.body.mode === 'report' && e.body.reply_to === repAsk), 'monthly report posted as a reply');

  // AI context digest from the phones: used when fresh, ignored when it misses newer events
  const putDigest = async (tok, body) => { const res = await fetch(`${API}/api/c/${cid}/digest`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body }); return { status: res.status, d: await res.json().catch(() => null) }; };
  r = await call('GET', `/api/c/${cid}/changes?since=0`, null, A);
  const fold2 = SquadCore.fold(r.d.events);
  for (const a of fold2.activities.values()) a.title = `${a.title || a.sport} DIGEST-MARKER`;
  const sc2 = SquadCore.compute({ starts: r.d.challenge.starts, ends: r.d.challenge.ends, rules: r.d.challenge.rules }, r.d.members, Array.from(fold2.activities.values()), r.d.today);
  const dg = JSON.stringify(SquadCore.digest(r.d.seq, r.d.today, fold2, sc2));
  let pr = await putDigest(A, dg);
  ok(pr.status === 200 && pr.d.stored === true, 'digest stored', pr);
  pr = await putDigest(A, JSON.stringify(SquadCore.digest(r.d.seq - 5, r.d.today, fold2, sc2)));
  ok(pr.d.stored === false, 'older digest does not replace a newer one', pr);
  pr = await putDigest(A, '{"v":1,"seq":999999999,"x":1}');
  ok(pr.status === 400, 'digest from the future refused', pr);
  pr = await putDigest(A, 'x'.repeat(800000));
  ok(pr.status === 413, 'oversized digest refused', pr.status);
  prompts.length = 0;
  await call('POST', `/api/c/${cid}/events`, { events: [{ id: id('msg'), kind: 'msg', body: { text: '@Aether how are we doing?' } }] }, A);
  await call('POST', `/api/c/${cid}/ai/run`, {}, A);
  ok(prompts.length === 1 && /DIGEST-MARKER/.test(prompts[0].text) && /SCOREBOARD/.test(prompts[0].text) && /lengths: 25 m: 0:36/.test(prompts[0].text), 'AI used the fresh digest (scoreboard, lap detail)', prompts.map(p => p.text.slice(0, 200)));
  await call('POST', `/api/c/${cid}/events`, { events: [{ id: id('act'), kind: 'activity', body: { key: 'late', sport: 'walk', date: today, dur_s: 600, dist_m: 900 } }] }, B);
  prompts.length = 0;
  await call('POST', `/api/c/${cid}/events`, { events: [{ id: id('msg'), kind: 'msg', body: { text: '@Aether and now?' } }] }, A);
  await call('POST', `/api/c/${cid}/ai/run`, {}, A);
  ok(prompts.length === 1 && !/DIGEST-MARKER/.test(prompts[0].text) && /SCOREBOARD/.test(prompts[0].text), 'stale digest ignored → full history used', prompts.map(p => p.text.slice(0, 200)));

  // Screenshot import
  prompts.length = 0;
  r = await call('POST', `/api/c/${cid}/ai/extract`, { image: 'A'.repeat(500), hint: 'Huawei pool swim' }, B);
  ok(r.status === 200 && r.d.workout.sport === 'swim' && r.d.workout.swolf === 41 && prompts[0].hasImage, 'screenshot → workout JSON', r.d);

  // Spend cap: 1000 in + 100 out at $1/$5 per M ≈ $0.0015 per call; set cap tiny → refused
  await call('PUT', `/api/c/${cid}/ai`, { config: { type: 'openai', baseUrl: 'http://127.0.0.1:8799/v1', model: 'mock2', priceIn: 1, priceOut: 5, capUsd: 0.001 } }, A);
  r = await call('GET', `/api/c/${cid}/ai`, null, B);
  ok(r.d.ai.spend_usd > 0, 'spend is tracked', r.d);
  const capAsk = id('msg');
  await call('POST', `/api/c/${cid}/events`, { events: [{ id: capAsk, kind: 'msg', body: { text: '@aether still there?' } }] }, B);
  r = await call('POST', `/api/c/${cid}/ai/run`, {}, B);
  r = await call('GET', `/api/c/${cid}/changes?since=${head}`, null, B);
  const capErr = r.d.events.find(e => e.kind === 'system' && e.ref === capAsk);
  ok(capErr && /spend cap/.test(capErr.body.text), 'spend cap stops the AI with a visible notice', capErr);

  // Cron handler runs without errors
  const cron = await fetch(`${API}/__scheduled?cron=*/15+*+*+*+*`);
  ok(cron.status === 200, 'cron handler runs', cron.status);

  // ---------- leaving ----------
  r = await call('DELETE', `/api/c/${cid}/me`, null, B);
  ok(r.status === 200, 'Assad leaves');
  r = await call('GET', `/api/c/${cid}/changes?since=0`, null, B);
  ok(r.status === 403, 'token stops working after leaving');
  r = await call('GET', `/api/c/${cid}/changes?since=0`, null, A);
  ok(r.d.members.find(m => m.id === bId).active === false && r.d.events.some(e => e.body.type === 'left'), 'others see that he left');

  // ---------- member cap ----------
  r = await call('POST', '/api/challenges', { name: 'Big', member: { name: 'P1' } });
  const inv2 = r.d.challenge.invite;
  let last;
  for (let i = 2; i <= 7; i++) last = await call('POST', '/api/join', { invite: inv2, member: { name: `P${i}` } });
  ok(last.status === 409, 'max 6 members', last.d);
} catch (e) {
  failed++;
  console.log('CRASH', e.stack);
} finally {
  mock.close();
}
console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
