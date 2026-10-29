#!/usr/bin/env node
// --------------------------------------------------------
// Copies all Ride Partner data out of the app installed on a USB-connected phone,
// through the WebView DevTools socket (works because GitHub-built v2 APKs are debug builds).
// Usage: node scripts/phone-rescue.js <forwarded-port> <output.json>
// Nothing on the phone is changed. API keys and Strava tokens are NOT copied.
// --------------------------------------------------------
const fs = require('fs');

const port = process.argv[2] || '9333';
const outFile = process.argv[3] || 'phone-data.json';
const CHUNK = 4 * 1024 * 1024;

// Runs inside the old app: raw IndexedDB dump of every table, secrets removed
const DUMP_JS = `(async () => {
  const open = n => new Promise((res, rej) => { const r = indexedDB.open(n); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const all = (d, s) => new Promise((res, rej) => { if (!d.objectStoreNames.contains(s)) return res([]); const q = d.transaction(s, 'readonly').objectStore(s).getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => rej(q.error); });
  const d = await open('RidePartnerDB');
  const out = { app: 'RidePartner', version: 3, rescue: true, exported_at: new Date().toISOString() };
  for (const t of ['workouts', 'streams', 'threads', 'master_chat', 'graph_threads', 'reports', 'config']) out[t] = await all(d, t);
  const secret = ['gemini_api_key', 'strava_client_secret', 'strava_refresh_token', 'strava_access_token', 'strava_token_expires'];
  out.config = out.config.filter(c => !secret.includes(c.key)).map(c => {
    if (c.key !== 'ai_providers') return c;
    try { const s = JSON.parse(c.val); (s.providers || []).forEach(p => { p.apiKey = ''; }); return { key: c.key, val: JSON.stringify(s) }; } catch (e) { return null; }
  }).filter(Boolean);
  window.__rpRescue = JSON.stringify(out);
  return JSON.stringify({ length: window.__rpRescue.length, counts: Object.fromEntries(Object.entries(out).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length])) });
})()`;

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find(t => t.type === 'page' && /localhost/.test(t.url)) || targets.find(t => t.type === 'page');
  if (!page) throw new Error('No Ride Partner page found — open the app on the phone and try again.');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('Could not connect to the app WebView.')); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const evaluate = expression => new Promise((res, rej) => {
    const myId = ++id;
    pending.set(myId, m => (m.error || (m.result && m.result.exceptionDetails)) ? rej(new Error(JSON.stringify(m.error || m.result.exceptionDetails).slice(0, 300))) : res(m.result.result.value));
    ws.send(JSON.stringify({ id: myId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });

  console.log(`Connected to: ${page.url}`);
  const info = JSON.parse(await evaluate(DUMP_JS));
  console.log('Tables:', JSON.stringify(info.counts));
  let json = '';
  for (let i = 0; i < info.length; i += CHUNK) {
    json += await evaluate(`window.__rpRescue.slice(${i}, ${i + CHUNK})`);
    process.stdout.write(`\rCopied ${Math.min(100, Math.round(((i + CHUNK) / info.length) * 100))}%`);
  }
  await evaluate('delete window.__rpRescue; true');
  ws.close();
  if (json.length !== info.length) throw new Error(`Incomplete copy (${json.length}/${info.length} chars).`);
  JSON.parse(json); // validate
  fs.writeFileSync(outFile, json, 'utf8');
  console.log(`\nSaved ${outFile} (${(json.length / 1048576).toFixed(1)} MB)`);
}

main().catch(e => { console.error(`\nRESCUE FAILED: ${e.message}`); process.exit(1); });
