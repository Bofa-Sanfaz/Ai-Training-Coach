// --------------------------------------------------------
// ACCOUNTS — username sign-in so a person's app works on several devices.
// The app derives two keys from the password (PBKDF2): an auth key (sent here, stored only as
// SHA-256) and an encryption key (never leaves the device). The person's whole app data is
// uploaded as an encrypted "vault" in ≤ 1 MB parts; this server can't read it.
// Versioning: a new vault is version + 1; it becomes current when its last part arrives, and
// only if nobody else committed in between (409 → the app pulls first).
// --------------------------------------------------------
const USER_RE = /^[a-z0-9][a-z0-9_.-]{2,23}$/;
const PART_MAX = 1400000;   // base64 characters (≈ 1 MB of data)
const MAX_PARTS = 40;
// A private two-person app: keeps the free storage from being filled by strangers (local tests: --var SQUAD_MAX_ACCOUNTS)
const maxAccounts = env => { const n = Math.round(+env.SQUAD_MAX_ACCOUNTS); return n >= 1 && n <= 1000 ? n : 2; };
const LOCK_AFTER = 8, LOCK_MS = 15 * 60000;

async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('');
}
const newToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const now = () => new Date().toISOString();

async function session(env, req, fail) {
  const h = req.headers.get('Authorization') || '';
  const t = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (t.length < 20) fail(401, 'sign in first');
  const s = await env.DB.prepare('SELECT username FROM sessions WHERE token_hash=?').bind(await sha256(`acct:${t}`)).first();
  if (!s) fail(401, 'signed out — sign in again');
  return s.username;
}

async function issue(env, username, device) {
  const t = newToken();
  await env.DB.prepare('INSERT INTO sessions (token_hash, username, created_at, device) VALUES (?,?,?,?)').bind(await sha256(`acct:${t}`), username, now(), String(device || '').slice(0, 60)).run();
  return t;
}

export async function accountRoute(env, req, url, { json, fail, readJson }) {
  const p = url.pathname.replace(/\/+$/, '');
  const m = req.method;
  if (p === '/api/account/signup' && m === 'POST') {
    const b = await readJson(req, 4096);
    const username = String(b.username || '').trim().toLowerCase();
    if (!USER_RE.test(username)) fail(400, 'username: 3–24 letters, numbers, . _ -');
    if (!/^[0-9a-f]{64}$/.test(String(b.auth || ''))) fail(400, 'bad auth key');
    const exists = await env.DB.prepare('SELECT 1 FROM accounts WHERE username=?').bind(username).first();
    if (exists) fail(409, 'this username is taken');
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM accounts').first();
    if (count.n >= maxAccounts(env)) fail(403, 'this server is not taking new accounts');
    await env.DB.prepare('INSERT INTO accounts (username, auth_hash, created_at) VALUES (?,?,?)').bind(username, await sha256(b.auth), now()).run();
    return json({ username, token: await issue(env, username, b.device), vault_version: 0 }, 201);
  }
  if (p === '/api/account/login' && m === 'POST') {
    const b = await readJson(req, 4096);
    const username = String(b.username || '').trim().toLowerCase();
    const a = USER_RE.test(username) ? await env.DB.prepare('SELECT * FROM accounts WHERE username=?').bind(username).first() : null;
    if (!a) fail(401, 'wrong username or password');
    if (a.locked_until > Date.now()) fail(429, 'too many wrong passwords — try again in 15 minutes');
    if (a.auth_hash !== await sha256(String(b.auth || ''))) {
      const f = a.failed + 1;
      await env.DB.prepare('UPDATE accounts SET failed=?, locked_until=? WHERE username=?').bind(f >= LOCK_AFTER ? 0 : f, f >= LOCK_AFTER ? Date.now() + LOCK_MS : 0, username).run();
      fail(401, 'wrong username or password');
    }
    if (a.failed) await env.DB.prepare('UPDATE accounts SET failed=0 WHERE username=?').bind(username).run();
    return json({ username, token: await issue(env, username, b.device), vault_version: a.vault_version });
  }
  if (p === '/api/account/logout' && m === 'POST') {
    const h = (req.headers.get('Authorization') || '').slice(7).trim();
    if (h) await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256(`acct:${h}`)).run();
    return json({ ok: true });
  }
  if (p === '/api/account/vault' && m === 'GET') {
    const u = await session(env, req, fail);
    const a = await env.DB.prepare('SELECT vault_version, vault_parts, vault_size, vault_at FROM accounts WHERE username=?').bind(u).first();
    return json({ version: a.vault_version, parts: a.vault_parts, size: a.vault_size, at: a.vault_at });
  }
  const part = p.match(/^\/api\/account\/vault\/(\d{1,3})$/);
  // Parts travel and rest as base64 text: the server only passes them through (no byte
  // conversion — the free plan has 10 ms of CPU per request)
  if (part && m === 'GET') {
    const u = await session(env, req, fail);
    const v = Number(url.searchParams.get('version'));
    const r = await env.DB.prepare('SELECT data FROM vault_parts WHERE username=? AND version=? AND part=?').bind(u, v, Number(part[1])).first();
    if (!r || typeof r.data !== 'string') fail(404, 'no such part');
    return new Response(r.data, { headers: { 'Content-Type': 'text/plain; charset=us-ascii', 'Cache-Control': 'no-store' } });
  }
  if (part && m === 'PUT') {
    const u = await session(env, req, fail);
    const v = Number(url.searchParams.get('version')), n = Number(url.searchParams.get('parts')), i = Number(part[1]);
    if (!(v > 0) || !(n > 0) || n > MAX_PARTS || i >= n) fail(400, 'bad version/part');
    const data = await req.text();
    if (!data.length || data.length > PART_MAX) fail(413, 'part too large');
    if (!/^[A-Za-z0-9+/]/.test(data) || !/[A-Za-z0-9+/=]$/.test(data)) fail(400, 'part must be base64');
    const a = await env.DB.prepare('SELECT vault_version FROM accounts WHERE username=?').bind(u).first();
    if (v !== a.vault_version + 1) fail(409, 'a newer copy exists — pull first');
    await env.DB.prepare('INSERT OR REPLACE INTO vault_parts (username, version, part, data) VALUES (?,?,?,?)').bind(u, v, i, data).run();
    if (i < n - 1) return json({ stored: i });
    // Last part: commit if every part is there and nobody committed meanwhile
    const have = await env.DB.prepare('SELECT COUNT(*) AS c, SUM(LENGTH(data)) AS s FROM vault_parts WHERE username=? AND version=?').bind(u, v).first();
    if (have.c !== n) fail(400, `missing parts (${have.c}/${n})`);
    const r = await env.DB.prepare('UPDATE accounts SET vault_version=?, vault_parts=?, vault_size=?, vault_at=? WHERE username=? AND vault_version=?').bind(v, n, have.s, now(), u, v - 1).run();
    if (!r.meta.changes) fail(409, 'a newer copy exists — pull first');
    await env.DB.prepare('DELETE FROM vault_parts WHERE username=? AND version < ?').bind(u, v).run();
    return json({ committed: v, size: have.s });
  }
  fail(404, 'not found');
}
