'use strict';
// --------------------------------------------------------
// ACCOUNT (web app): username sign-in so the same person can use the app on several devices.
// From the password the app derives (PBKDF2-SHA256, 210 000 rounds, salted with the username):
//   - an auth key → sent to the squad server, which stores only its SHA-256;
//   - an encryption key → stays on the device; the server can't read the data.
// The whole app data (workouts, streams, chats, settings incl. keys and squad memberships) is
// gzipped, AES-GCM encrypted and uploaded in ≤ 900 kB parts as a new version after changes
// (at most every 2 minutes). Another device signing in downloads and restores it; a device that
// is behind pulls the newer copy on start (a restore point is made first).
// --------------------------------------------------------
const ACCT_KEY = 'rp_account';           // localStorage: { server, username, token, key, version, dirty, at }
const ACCT_ROUNDS = 210000;
const ACCT_PART = 900000;
const Account = { busy: false, timer: null };

function accountGet() {
  try { return JSON.parse(localStorage.getItem(ACCT_KEY) || 'null'); } catch (e) { return null; }
}
function accountSet(a) {
  try { a ? localStorage.setItem(ACCT_KEY, JSON.stringify(a)) : localStorage.removeItem(ACCT_KEY); } catch (e) { /* private mode */ }
}
const accountServer = () => (typeof squadServerDefault === 'function' && squadServerDefault()) || (typeof SQUAD_DEFAULT_SERVER !== 'undefined' ? SQUAD_DEFAULT_SERVER : '');
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const hex = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');

async function accountDerive(username, password) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = salt => crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: ACCT_ROUNDS }, base, 256);
  const [auth, enc] = await Promise.all([bits(`tp-auth:${username}`), bits(`tp-enc:${username}`)]);
  return { auth: hex(auth), key: b64(enc) };
}

async function accountCryptoKey(a) {
  return crypto.subtle.importKey('raw', unb64(a.key), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function gz(bytes, mode) {
  const s = new Blob([bytes]).stream().pipeThrough(mode === 'zip' ? new CompressionStream('gzip') : new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

async function accountApi(method, path, body, token, raw) {
  const res = await fetch(accountServer() + path, {
    method, headers: Object.assign(raw ? { 'Content-Type': 'application/octet-stream' } : { 'Content-Type': 'application/json' }, token ? { Authorization: `Bearer ${token}` } : {}),
    body: raw || (body ? JSON.stringify(body) : undefined)
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw Object.assign(new Error(d.error || `HTTP ${res.status}`), { status: res.status });
  }
  return res;
}

// Everything that makes this app "his" — the squad's event cache is left out (it re-syncs)
async function accountVaultBytes() {
  const dump = await buildDump({ includeSecrets: true });
  dump.config = (dump.config || []).filter(c => !/^squad_data_|^intro_step$/.test(c.key));
  // His streams come from Huawei exports and screenshots — they can't be downloaded again, so they travel too
  dump.streams = await db.streams.toArray();
  const prefs = {};
  for (const k of ['rp_theme', 'rp_squad_view', 'rp_haptics']) { try { const v = localStorage.getItem(k); if (v !== null) prefs[k] = v; } catch (e) {} }
  dump.local_prefs = prefs;
  return new TextEncoder().encode(JSON.stringify(dump));
}

async function accountUpload(reason) {
  const a = accountGet();
  if (!a || Account.busy) return false;
  Account.busy = true;
  try {
    const key = await accountCryptoKey(a);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = await gz(await accountVaultBytes(), 'zip');
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
    const blob = new Uint8Array(12 + sealed.length); blob.set(iv); blob.set(sealed, 12);
    const meta = await (await accountApi('GET', '/api/account/vault', null, a.token)).json();
    if (meta.version > (a.version || 0)) { await accountPull(); return false; } // another device was first
    const v = meta.version + 1, parts = Math.max(1, Math.ceil(blob.length / ACCT_PART));
    for (let i = 0; i < parts; i++) {
      await accountApi('PUT', `/api/account/vault/${i}?version=${v}&parts=${parts}`, null, a.token, blob.slice(i * ACCT_PART, (i + 1) * ACCT_PART));
    }
    accountSet(Object.assign(a, { version: v, dirty: false, at: new Date().toISOString() }));
    accountRenderCard();
    return true;
  } catch (e) {
    if (e.status === 401) { toast('Signed out of your account — sign in again in Profile', 'warn', 6000); }
    else if (e.status === 409) await accountPull();
    else console.warn('account upload', reason, e.message);
    return false;
  } finally { Account.busy = false; }
}

// Download the newest copy and restore it (used on a new device and when this one is behind)
async function accountPull(opts = {}) {
  const a = accountGet();
  if (!a) return false;
  const meta = await (await accountApi('GET', '/api/account/vault', null, a.token)).json();
  if (!meta.version) return false;
  if (!opts.force && meta.version <= (a.version || 0)) return false;
  const chunks = [];
  for (let i = 0; i < meta.parts; i++) chunks.push(new Uint8Array(await (await accountApi('GET', `/api/account/vault/${i}?version=${meta.version}`, null, a.token)).arrayBuffer()));
  const all = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  const key = await accountCryptoKey(a);
  let plain;
  try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, key, all.slice(12)); } catch (e) { throw new Error('could not unlock your data — wrong password?'); }
  const data = JSON.parse(new TextDecoder().decode(await gz(new Uint8Array(plain), 'unzip')));
  if ((await db.workouts.count()) > 0) await createRestorePoint('Before loading your account from another device', 'auto');
  await restoreDump(data, { preserveSecrets: false });
  for (const [k, v] of Object.entries(data.local_prefs || {})) { try { localStorage.setItem(k, v); } catch (e) {} }
  accountSet(Object.assign(a, { version: meta.version, dirty: false, at: meta.at }));
  return true;
}

async function accountSignUp(username, password) {
  const u = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{2,23}$/.test(u)) throw new Error('Username: 3–24 letters or numbers (. _ - allowed)');
  if (String(password || '').length < 8) throw new Error('Password: at least 8 characters');
  const k = await accountDerive(u, password);
  const r = await (await accountApi('POST', '/api/account/signup', { username: u, auth: k.auth, device: navigator.platform || '' })).json();
  accountSet({ server: accountServer(), username: r.username, token: r.token, key: k.key, version: 0, dirty: true });
  await accountUpload('signup');
  return r;
}

async function accountSignIn(username, password) {
  const u = String(username || '').trim().toLowerCase();
  const k = await accountDerive(u, password);
  const r = await (await accountApi('POST', '/api/account/login', { username: u, auth: k.auth, device: navigator.platform || '' })).json();
  accountSet({ server: accountServer(), username: r.username, token: r.token, key: k.key, version: 0, dirty: false });
  const restored = r.vault_version ? await accountPull({ force: true }) : false;
  if (!restored) { const a = accountGet(); a.dirty = true; accountSet(a); await accountUpload('first sign-in'); }
  return { restored };
}

async function accountSignOut() {
  const a = accountGet();
  if (!a) return;
  if (a.dirty) await accountUpload('sign out');
  try { await accountApi('POST', '/api/account/logout', null, a.token); } catch (e) {}
  accountSet(null);
  accountRenderCard();
  toast('Signed out — your data stays on this device', 'info');
}

// Any change to the app data marks the account dirty; uploads follow within ~2 minutes
function accountWatch() {
  const mark = () => {
    const a = accountGet();
    if (!a) return;
    if (!a.dirty) { a.dirty = true; accountSet(a); }
    clearTimeout(Account.timer);
    Account.timer = setTimeout(() => accountUpload('changes'), 120000);
  };
  for (const t of ['workouts', 'streams', 'threads', 'master_chat', 'graph_threads', 'reports', 'config']) {
    const table = db[t];
    if (!table) continue;
    table.hook('creating', function (pk, obj) { if (t !== 'config' || !/^squad_data_/.test(obj && obj.key)) mark(); });
    table.hook('updating', function () { mark(); });
    table.hook('deleting', function () { mark(); });
  }
  document.addEventListener('visibilitychange', () => { const a = accountGet(); if (document.hidden && a && a.dirty) accountUpload('app hidden'); });
}

// On start: a device that is behind pulls the newer copy (once), then reloads
async function accountBoot() {
  if (isNative()) return;
  accountWatch();
  const a = accountGet();
  if (!a || !navigator.onLine) return;
  try {
    if (a.dirty) { await accountUpload('start'); return; }
    if (await accountPull()) { toast('Loaded your latest data from your account', 'success'); setTimeout(() => location.reload(), 900); }
  } catch (e) { console.warn('account boot', e.message); }
}

function accountRenderCard() {
  const host = $('#accountCard');
  if (!host) return;
  if (isNative()) { host.classList.add('hidden'); return; }
  host.classList.remove('hidden');
  const a = accountGet();
  $('#accountBody').innerHTML = a
    ? `<div class="row between"><div><b>${escapeHtml(a.username)}</b><div class="tiny muted">${a.dirty ? 'Changes waiting to back up…' : a.at ? `Backed up ${escapeHtml(relativeTime(a.at))}` : 'Backed up'} · encrypted, only your password opens it</div></div>
        <span class="badge badge-ok">signed in</span></div>
       <div class="btn-row mt-12"><button class="btn btn-secondary btn-sm" onclick="accountUploadNow()">${icon('upload', 'ic-sm')}Back up now</button><button class="btn btn-ghost btn-sm" onclick="accountSignOut()">Sign out</button></div>`
    : `<div class="small muted">Sign in to use the app on several devices — your data is backed up encrypted.</div>
       <button class="btn btn-primary btn-sm mt-8" onclick="openAccountSheet()">${icon('user', 'ic-sm')}Sign in or create an account</button>`;
}

async function accountUploadNow() {
  toast('Backing up…', 'info', 1500);
  const a = accountGet(); if (a) { a.dirty = true; accountSet(a); }
  toast((await accountUpload('manual')) ? 'Backed up' : 'Backup failed — check your connection', (accountGet() || {}).dirty ? 'error' : 'success');
}

// ---------- sign-in sheet (Profile, and the introduction) ----------
let accountMode = 'signup';
function openAccountSheet(mode = 'signup') {
  accountMode = mode;
  accountRenderSheet();
  openSheet('accountSheet');
}

function accountRenderSheet() {
  const up = accountMode === 'signup';
  $('#acc_title').textContent = up ? 'Create your account' : 'Sign in';
  $('#acc_sub').textContent = up ? 'So you can open the app on any device. Your data is encrypted with your password — keep it safe: without it nobody (not even the app) can open your data.'
    : 'Your data comes back on this device.';
  $('#acc_pw2_row').classList.toggle('hidden', !up);
  $('#accSubmit').innerHTML = up ? `${icon('check-circle')}Create account` : `${icon('user')}Sign in`;
  $('#acc_switch').innerHTML = up ? 'I already have an account — <b>sign in</b>' : 'New here — <b>create an account</b>';
  $('#acc_status').textContent = '';
}

async function accountSubmit(fromIntro) {
  const u = $('#acc_user').value, p = $('#acc_pw').value;
  if (accountMode === 'signup' && p !== $('#acc_pw2').value) { toast('The passwords don\'t match', 'warn'); return; }
  const btn = $('#accSubmit');
  setBusy(btn, true, accountMode === 'signup' ? 'Creating…' : 'Signing in…');
  $('#acc_status').textContent = 'Securing your password (a few seconds)…';
  try {
    if (accountMode === 'signup') {
      await accountSignUp(u, p);
      closeSheet('accountSheet');
      toast(`Account “${u.trim().toLowerCase()}” created`, 'success');
      accountRenderCard();
      if ($('#introPanel').classList.contains('open')) renderIntro();
    } else {
      const r = await accountSignIn(u, p);
      closeSheet('accountSheet');
      if (r.restored) { toast('Welcome back — your data is here', 'success'); setTimeout(() => location.reload(), 800); }
      else { toast('Signed in', 'success'); accountRenderCard(); if ($('#introPanel').classList.contains('open')) renderIntro(); }
    }
  } catch (e) {
    $('#acc_status').textContent = e.message;
  } finally { setBusy(btn, false); }
}
