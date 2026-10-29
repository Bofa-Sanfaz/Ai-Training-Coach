'use strict';
// --------------------------------------------------------
// MOTION — motion that explains what changed, After-Effects style but quick
// (screens push in the direction you navigate, a tapped workout card grows into
// its detail screen, numbers roll up, the route draws itself, records get confetti).
// Built on the browser's View Transitions + Web Animations APIs; the only library
// is canvas-confetti (github.com/catdad/canvas-confetti, ISC). Everything is
// skipped when the phone asks for reduced motion.
// --------------------------------------------------------
const TAB_ORDER = ['rides', 'trends', 'compare', 'coach', 'squad', 'reports', 'profile'];
const SPRING = 'cubic-bezier(0.22, 1.2, 0.36, 1)';

function reducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

const canViewTransition = () => typeof document.startViewTransition === 'function' && !reducedMotion();

// Runs `update` inside a view transition; dir = 'fwd' | 'back' | 'morph'
// If the browser can't paint (app just resumed, page in the background) the transition
// never starts — after 300 ms it is skipped and the update runs anyway.
function viewSwap(update, dir = 'fwd') {
  let result = null;
  const run = () => { if (!result) result = Promise.resolve().then(update); return result; };
  if (!canViewTransition() || document.hidden) return run();
  const root = document.documentElement;
  root.dataset.vt = dir;
  let t;
  try { t = document.startViewTransition(run); } catch (e) { delete root.dataset.vt; return run(); }
  // A transition interrupted by the next tap rejects `ready`; that is expected, not an error
  t.ready.catch(() => {});
  t.finished.catch(() => {}).finally(() => { delete root.dataset.vt; });
  setTimeout(() => { if (!result) { try { t.skipTransition(); } catch (e) { /* already done */ } run(); } }, 300);
  return new Promise(res => { const wait = () => (result ? res(result) : setTimeout(wait, 25)); wait(); });
}

function tabDirection(from, to) {
  return TAB_ORDER.indexOf(to) >= TAB_ORDER.indexOf(from) ? 'fwd' : 'back';
}

// ---------- Numbers roll up (elements with data-count) ----------
function countUp(root = document) {
  if (reducedMotion()) return;
  $$('[data-count]', root).forEach(el => {
    if (el.dataset.counted) return;
    el.dataset.counted = '1';
    const target = parseFloat(el.dataset.count);
    if (!Number.isFinite(target) || target === 0) return;
    const final = el.textContent;
    const dec = (String(el.dataset.count).split('.')[1] || '').length;
    const t0 = performance.now(), dur = 900;
    const step = now => {
      const p = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(2, -10 * p); // easeOutExpo
      el.textContent = p < 1 ? (target * e).toFixed(dec) : final;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

// ---------- Staggered reveal for a list of elements (used once per screen visit) ----------
function stagger(els, { y = 14, delay = 40, max = 8 } = {}) {
  if (reducedMotion() || !Element.prototype.animate) return;
  [...els].slice(0, max).forEach((el, i) => {
    el.animate([{ opacity: 0, transform: `translateY(${y}px) scale(0.985)` }, { opacity: 1, transform: 'none' }],
      { duration: 460, delay: i * delay, easing: SPRING, fill: 'backwards' });
  });
}

// Called after a screen renders: roll numbers and grow bars
function animateIn(root) {
  if (!root) return;
  resizeChartsIn(root);
  countUp(root);
}

// ---------- The route draws itself ----------
function drawRoute(svg) {
  if (!svg || reducedMotion()) return;
  $$('path, polyline', svg).forEach((p, i) => {
    let len = 0;
    try { len = p.getTotalLength(); } catch (e) { return; }
    if (!(len > 0)) return;
    p.style.strokeDasharray = `${len}`;
    p.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 1400, delay: 120 + i * 6, easing: 'cubic-bezier(0.65, 0, 0.35, 1)', fill: 'backwards' })
      .finished.then(() => { p.style.strokeDasharray = ''; }).catch(() => {});
  });
}

// ---------- Sliding nav indicator ----------
function moveNavIndicator(tab, instant) {
  const nav = $('.bottom-nav') || ($('.nav-btn') && $('.nav-btn').parentElement);
  if (!nav) return;
  let ind = $('.nav-indicator', nav);
  if (!ind) { ind = document.createElement('span'); ind.className = 'nav-indicator'; nav.appendChild(ind); nav.classList.add('has-indicator'); }
  const btn = $(`.nav-btn[data-tab="${tab}"]`, nav);
  if (!btn) return;
  const nr = nav.getBoundingClientRect(), br = btn.getBoundingClientRect();
  ind.style.transition = instant || reducedMotion() ? 'none' : '';
  ind.style.transform = `translateX(${br.left - nr.left + br.width / 2 - 22}px)`;
}

// ---------- Press ripple on buttons, chips and cards ----------
function setupRipples() {
  if (reducedMotion()) return;
  document.addEventListener('pointerdown', e => {
    const el = e.target.closest('.btn, .chip, .ride-card, .thread-row, .record, .prov-card, .pick-row, .list-row');
    if (!el || el.disabled) return;
    const r = el.getBoundingClientRect();
    const d = Math.max(r.width, r.height) * 2;
    const s = document.createElement('span');
    s.className = 'ripple';
    s.style.cssText = `width:${d}px;height:${d}px;left:${e.clientX - r.left - d / 2}px;top:${e.clientY - r.top - d / 2}px`;
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    el.appendChild(s);
    setTimeout(() => s.remove(), 650);
  }, { passive: true });
}

// ---------- Cold-start intro: logo mark + wordmark, < 1 s ----------
function playIntro() {
  const el = $('#intro');
  if (!el) return;
  if (reducedMotion() || sessionStorage.getItem('rp_intro')) { el.remove(); return; }
  try { sessionStorage.setItem('rp_intro', '1'); } catch (e) {}
  el.classList.add('play');
  setTimeout(() => el.classList.add('out'), 820);
  setTimeout(() => el.remove(), 1250);
}

// ---------- Celebrations ----------
function celebrate(colors) {
  if (reducedMotion() || typeof window.confetti !== 'function') return;
  const c = colors || ['#fc5200', '#ff8a3d', '#2563eb', '#16a34a', '#facc15'];
  window.confetti({ particleCount: 90, spread: 75, startVelocity: 42, origin: { y: 0.75 }, colors: c, disableForReducedMotion: true, scalar: 0.9 });
  setTimeout(() => window.confetti({ particleCount: 50, angle: 60, spread: 60, origin: { x: 0, y: 0.8 }, colors: c, disableForReducedMotion: true }), 180);
  setTimeout(() => window.confetti({ particleCount: 50, angle: 120, spread: 60, origin: { x: 1, y: 0.8 }, colors: c, disableForReducedMotion: true }), 300);
}

// Records before vs after a sync → celebrate the new ones
function recordSignature(all) {
  const out = {};
  for (const s of Object.keys(SPORTS)) for (const r of computeRecords(all, s)) if (r.ride) out[`${s}:${r.label}`] = r.ride.id;
  return out;
}

async function announceNewRecords(before, addedIds) {
  if (!addedIds || !addedIds.length) return;
  const after = recordSignature(await db.workouts.toArray());
  const fresh = Object.entries(after).filter(([k, id]) => before[k] !== id && addedIds.includes(id)).map(([k]) => k.split(':')[1]);
  if (!fresh.length) return;
  haptic('success');
  celebrate();
  toast(`New personal record${fresh.length > 1 ? 's' : ''}: ${fresh.slice(0, 3).join(' · ')}`, 'success', 5000);
}
