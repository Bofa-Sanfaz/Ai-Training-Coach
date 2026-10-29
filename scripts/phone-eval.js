#!/usr/bin/env node
// --------------------------------------------------------
// Developer diagnostics: evaluates a JavaScript expression inside the Training Partner
// app on a USB-connected phone (WebView DevTools; the app enables it for USB debugging)
// and prints the JSON result. Use read-only expressions — this runs in the live app.
// Usage: adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>
//        node scripts/phone-eval.js 9333 "<expression>"   (or a .js file path)
// --------------------------------------------------------
const fs = require('fs');

const port = process.argv[2] || '9333';
let expr = process.argv[3] || 'document.title';
if (fs.existsSync(expr)) expr = fs.readFileSync(expr, 'utf8');

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find(t => t.type === 'page' && /localhost/.test(t.url)) || targets.find(t => t.type === 'page');
  if (!page) throw new Error('No app page found — open the app on the phone.');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('Could not connect to the app WebView.')); });
  const result = await new Promise((res, rej) => {
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id !== 1) return;
      if (m.error || (m.result && m.result.exceptionDetails)) rej(new Error(JSON.stringify(m.error || m.result.exceptionDetails).slice(0, 600)));
      else res(m.result.result.value);
    };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `(async () => { return JSON.stringify(await (async () => (${expr}))()); })()`, awaitPromise: true, returnByValue: true } }));
  });
  ws.close();
  console.log(JSON.stringify(JSON.parse(result), null, 2));
}

main().catch(e => { console.error(`EVAL FAILED: ${e.message}`); process.exit(1); });
