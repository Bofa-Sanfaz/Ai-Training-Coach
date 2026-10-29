'use strict';
// --------------------------------------------------------
// UI PRIMITIVES: icons, toasts, dialogs, sheets, panels,
// Android back button, theme, busy buttons
// --------------------------------------------------------
const UI = {
  backStack: [],   // [{ key, fn }] — most recent overlay closes first on Back
  dialogResolve: null
};

function icon(name, cls = '') {
  return `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

function capPlugin(name) {
  return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins[name]) || null;
}

function isNative() {
  return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
}

// ---------- Haptics (no-op in the browser) ----------
function haptic(kind = 'light') {
  try {
    if (localStorage.getItem('rp_haptics') === 'off') return;
  } catch (e) {}
  const H = capPlugin('Haptics');
  if (!H) return;
  if (kind === 'success' || kind === 'warning' || kind === 'error') {
    H.notification({ type: kind.toUpperCase() }).catch(() => {});
  } else {
    H.impact({ style: kind === 'medium' ? 'MEDIUM' : 'LIGHT' }).catch(() => {});
  }
}

// ---------- Streaming AI bubble ----------
// Returns an onDelta(text) callback that renders the growing reply into `host`,
// replacing the typing indicator. Throttled to one paint per frame.
function liveBubble(host, label, onPaint) {
  let el = null, pending = '', raf = 0;
  return text => {
    pending = text;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!el || !el.isConnected) {
        el = document.createElement('div');
        el.className = 'bubble bubble-coach fresh';
        el.innerHTML = `<div class="bubble-sender"><span>${escapeHtml(label)}</span><span>writing…</span></div><div class="md"></div>`;
        const typing = host.querySelector('.typing');
        if (typing) typing.replaceWith(el); else host.appendChild(el);
      }
      el.querySelector('.md').innerHTML = renderMarkdown(pending) + '<span class="caret"></span>';
      if (onPaint) onPaint();
    });
  };
}

// ---------- Toasts ----------
function toast(message, type = 'info', ms = 3400) {
  const host = $('#toasts');
  if (!host) return;
  const icons = { success: 'check-circle', error: 'alert', warn: 'alert', info: 'info' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${icon(icons[type] || 'info')}<div class="grow">${escapeHtml(message).replace(/\n/g, '<br>')}</div>`;
  el.addEventListener('click', () => dismiss());
  host.appendChild(el);
  while (host.children.length > 3) host.removeChild(host.firstChild);
  let gone = false;
  function dismiss() {
    if (gone) return;
    gone = true;
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
  }
  setTimeout(dismiss, ms);
}

// ---------- Back stack ----------
function pushBack(key, fn) {
  popBack(key);
  UI.backStack.push({ key, fn });
}

function popBack(key) {
  UI.backStack = UI.backStack.filter(b => b.key !== key);
}

function handleHardwareBack() {
  const top = UI.backStack[UI.backStack.length - 1];
  if (top) { top.fn(); return; }
  if (typeof Router !== 'undefined' && Router.current !== 'rides') { switchTab('rides'); return; }
  const App = capPlugin('App');
  if (App && App.exitApp) App.exitApp();
}

// ---------- Scrim ----------
function syncScrim() {
  const anyOpen = $$('.sheet.open, .dialog.open').length > 0;
  $('#scrim').classList.toggle('open', anyOpen);
}

// ---------- Dialog (replaces alert/confirm) ----------
function uiDialog({ title = '', message = '', okText = 'OK', cancelText = 'Cancel', danger = false, alertOnly = false } = {}) {
  if (UI.dialogResolve) { UI.dialogResolve(false); UI.dialogResolve = null; }
  const dlg = $('#dialog');
  $('#dialogTitle').textContent = title;
  $('#dialogMsg').textContent = message;
  const ok = $('#dialogOk');
  const cancel = $('#dialogCancel');
  ok.textContent = okText;
  ok.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
  cancel.textContent = cancelText;
  cancel.classList.toggle('hidden', alertOnly);
  dlg.classList.add('open');
  syncScrim();

  return new Promise(resolve => {
    const finish = val => {
      dlg.classList.remove('open');
      syncScrim();
      popBack('dialog');
      ok.onclick = cancel.onclick = null;
      UI.dialogResolve = null;
      resolve(val);
    };
    UI.dialogResolve = finish;
    ok.onclick = () => finish(true);
    cancel.onclick = () => finish(false);
    pushBack('dialog', () => finish(false));
    setTimeout(() => ok.focus(), 50);
  });
}

const uiConfirm = (title, message, opts = {}) => uiDialog({ title, message, okText: opts.okText || 'Confirm', danger: !!opts.danger, cancelText: opts.cancelText || 'Cancel' });
const uiAlert = (title, message) => uiDialog({ title, message, alertOnly: true });

// ---------- Bottom sheets ----------
function openSheet(id, onClose) {
  const el = document.getElementById(id);
  el.classList.add('open');
  el._onClose = onClose || null;
  syncScrim();
  pushBack(`sheet:${id}`, () => closeSheet(id));
}

function closeSheet(id) {
  const el = document.getElementById(id);
  if (!el || !el.classList.contains('open')) return;
  el.classList.remove('open');
  syncScrim();
  popBack(`sheet:${id}`);
  if (el._onClose) { const fn = el._onClose; el._onClose = null; fn(); }
}

function scrimClicked() {
  if (UI.dialogResolve) { UI.dialogResolve(false); return; }
  const open = $$('.sheet.open');
  if (open.length) closeSheet(open[open.length - 1].id);
}

// ---------- Full-screen panels ----------
function openPanel(id, onClose) {
  const el = document.getElementById(id);
  el.classList.add('open');
  el._onClose = onClose || null;
  document.body.style.overflow = 'hidden';
  pushBack(`panel:${id}`, () => closePanel(id));
}

function closePanel(id) {
  const el = document.getElementById(id);
  if (!el || !el.classList.contains('open')) return;
  el.classList.remove('open');
  popBack(`panel:${id}`);
  if (!$$('.panel.open').length) document.body.style.overflow = '';
  if (el._onClose) { const fn = el._onClose; el._onClose = null; fn(); }
}

// ---------- Busy buttons ----------
function setBusy(btn, busy, busyText) {
  if (!btn) return;
  if (busy) {
    if (!btn.dataset.label) btn.dataset.label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `${icon('refresh', 'spin')}<span>${escapeHtml(busyText || 'Working…')}</span>`;
  } else {
    btn.disabled = false;
    if (btn.dataset.label) { btn.innerHTML = btn.dataset.label; delete btn.dataset.label; }
  }
}

function typingHtml(text = 'Coach is thinking') {
  return `<div class="typing"><span class="dots"><i></i><i></i><i></i></span>${escapeHtml(text)}…</div>`;
}

// ---------- Theme ----------
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');
  try { localStorage.setItem('rp_theme', theme || 'system'); } catch (e) {}
  const dark = theme === 'dark' || (theme !== 'light' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#0a101d' : '#f3f5fa');
  const btn = $('#themeBtn');
  if (btn) btn.innerHTML = icon(dark ? 'sun' : 'moon');
  $$('[data-theme-choice]').forEach(b => b.classList.toggle('active', b.dataset.themeChoice === (theme || 'system')));
}

function currentThemeChoice() {
  try { return localStorage.getItem('rp_theme') || 'light'; } catch (e) { return 'light'; }
}

function toggleTheme() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark' ||
    (!document.documentElement.getAttribute('data-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches);
  applyTheme(dark ? 'light' : 'dark');
  if (typeof rerenderCharts === 'function') rerenderCharts();
}

// Auto-growing textarea for chat composers
function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function composerKey(event, sendFn) {
  if (event.key === 'Enter' && !event.shiftKey && !isNative()) {
    event.preventDefault();
    sendFn();
  }
}
