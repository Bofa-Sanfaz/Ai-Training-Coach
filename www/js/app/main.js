'use strict';
// --------------------------------------------------------
// ROUTER, BOOT, DEEP LINKS, NETWORK, WHAT'S NEW
// --------------------------------------------------------
const Router = { current: 'rides' };
const TAB_ALIASES = { feed: 'rides', graphs: 'trends', chats: 'coach', settings: 'profile' };

function switchTab(tab) {
  tab = TAB_ALIASES[tab] || tab;
  ['rideDetail', 'threadPanel'].forEach(closePanel);
  $$('.sheet.open').forEach(s => closeSheet(s.id));
  Router.current = tab;
  $$('.screen').forEach(s => s.classList.toggle('active', s.id === `screen-${tab}`));
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  window.scrollTo({ top: 0 });
  const render = { rides: renderRides, trends: renderTrends, compare: setupComparison, coach: renderCoachList, reports: renderReports, profile: renderProfile }[tab];
  if (render) Promise.resolve(render()).catch(err => { console.error(err); toast(`Could not load ${tab}: ${err.message}`, 'error'); });
}

function checkNetwork() {
  const pill = $('#networkStatus');
  pill.textContent = navigator.onLine ? 'Online' : 'Offline';
  pill.classList.toggle('offline', !navigator.onLine);
}

const WHATS_NEW = `
### Look & feel
- Redesigned app with bottom navigation, dark mode, new logo and race-number typography
- Ride detail opens as a full screen with a chat composer that stays at the bottom
- Toasts and in-app dialogs instead of pop-up alerts; Android **Back** button now works everywhere

### New in 3.2
- **Aether**, your season coach, knows everything and can change your plan and weekly targets when you ask — you approve each change
- **Your own plan**: a repeating weekly template, one-off day changes and weekly targets; done/missed tracking
- **Samsung Health** (Galaxy Watch) via Health Connect: sleep, resting HR, HRV, weight, steps — a readiness strip on Rides and better coaching
- **Coach skills**: each AI follows proven coaching methods; import more from GitHub
- Fixed: Android Back button, Strava sign-in link and file sharing now work natively

### Also new in v3
- **AI providers**: Gemini, Groq, OpenRouter, Mistral (free tiers) or Claude, OpenAI, DeepSeek (paid) — with a monthly spend cap, automatic fallback and replies that stream in as they're written
- **AI week plan**: a 7-day plan from your form, phase and goals, with a checklist and today's session on the Rides tab
- **Route map** coloured by heart-rate zone, and a **shareable ride card** image
- Rate each ride's **feel and effort (RPE)** and add private notes — the coach reads them
- **Weekly goals**, **training calendar** and **best efforts** (speed, heart rate, and power when you ride with a power meter)
- Pull down on Rides to sync; optional auto-sync when the app opens; haptic feedback
- **Fitness · Fatigue · Form** chart from heart-rate training load (TRIMP)
- Weekly summary with streak, weekly volume chart and all-time records
- Search and filter rides; month grouping
- Editable max/resting HR and zones (used everywhere, incl. AI prompts)
- Export backups and PDFs through the Android share sheet
- **Restore points** and a **Classic (v2) rollback** in Profile → Backup & rollback
- Demo rides to explore the app without Strava

### Fixes
- Works fully offline (libraries are now bundled)
- Fixed "undefined bpm drift", NaN kJ totals, inflated prior-speed averages and stale VAM values
- Climbing VAM no longer needs a heart-rate strap; recovery gaps account for ride duration
- Strava sync survives rate limits and finds all ride types`;

function showWhatsNew() {
  $('#whatsNewBody').innerHTML = renderMarkdown(WHATS_NEW);
  openSheet('whatsNewSheet');
}

async function boot() {
  if (window.__rpSafeStart) {
    window.__rpShowRecovery('Ride Partner failed to start twice in a row.');
    return;
  }
  if (!window.Dexie) throw new Error('Database library failed to load.');

  await db.open();

  // Version upgrade: snapshot data before this version touches it
  const seen = await getConfig('app_version_seen');
  if (seen !== APP_VERSION) {
    if ((await db.workouts.count()) > 0) await createRestorePoint(`Before update to v${APP_VERSION}${seen ? ` (from v${seen})` : ''}`, 'auto');
    await setConfig('app_version_seen', APP_VERSION);
  }

  await loadPhysioConfig();
  await loadAiSettings();
  await migrateWeekPlan();
  await loadSkills();
  applyTheme(currentThemeChoice());
  checkNetwork();
  window.addEventListener('online', checkNetwork);
  window.addEventListener('offline', checkNetwork);
  window.addEventListener('scroll', () => $('#appbar').classList.toggle('scrolled', window.scrollY > 4), { passive: true });
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (currentThemeChoice() === 'system') { applyTheme('system'); rerenderCharts(); }
    });
  }

  $$('.nav-btn').forEach(b => b.addEventListener('click', () => { if (Router.current !== b.dataset.tab) haptic('light'); switchTab(b.dataset.tab); }));
  setupRideFilters();
  setupTrendsControls();
  setupReportControls();
  setupThemeSeg();
  populateZoneSelect();
  await refreshModelSelectors();
  $('#brandSub').textContent = `Coach for ${ATHLETE.name}`;

  const App = capPlugin('App');
  if (App) {
    App.addListener('appUrlOpen', data => { if (data && data.url) processIncomingUrl(data.url); });
    App.addListener('backButton', handleHardwareBack);
  }
  if (location.search && location.search.includes('code=')) processIncomingUrl(location.href);

  await renderRides();
  window.__rpBootOk();

  if (seen !== APP_VERSION) setTimeout(showWhatsNew, 600);
  setupPullToRefresh();
  await refreshStaleMetrics();
  maybeAutoSync();
}

// Auto-sync on open: Strava connected, online, enabled, last sync > 3 h ago
async function maybeAutoSync() {
  try {
    const w = await getWellness();
    if ((await getConfig('health_enabled')) === '1' && (!w.updated_at || Date.now() - parseSafeDate(w.updated_at).getTime() > 3 * 3600000)) {
      setTimeout(() => syncWellness(false), 2500);
    }
    if ((await getConfig('auto_sync')) === '0' || !navigator.onLine) return;
    if (!(await getConfig('strava_refresh_token'))) return;
    const last = await getConfig('last_sync_at');
    if (last && Date.now() - parseSafeDate(last).getTime() < 3 * 3600000) return;
    setTimeout(() => syncStrava({ auto: true }), 1200);
  } catch (e) {
    console.warn('Auto-sync check failed', e);
  }
}

// Pull down on the Rides list to sync
function setupPullToRefresh() {
  const ptr = $('#ptr');
  let startY = null, dy = 0;
  const THRESHOLD = 80;
  window.addEventListener('touchstart', e => {
    if (Router.current !== 'rides' || window.scrollY > 0 || $$('.panel.open, .sheet.open').length || isSyncInProgress) { startY = null; return; }
    startY = e.touches[0].clientY;
    dy = 0;
  }, { passive: true });
  window.addEventListener('touchmove', e => {
    if (startY === null) return;
    dy = Math.max(0, e.touches[0].clientY - startY);
    if (!dy) return;
    const p = Math.min(1, dy / THRESHOLD);
    ptr.style.opacity = String(p);
    ptr.style.transform = `translateY(${Math.min(dy, THRESHOLD + 20) * 0.6 - 40}px) rotate(${p * 270}deg) scale(${0.6 + p * 0.4})`;
    const ready = dy >= THRESHOLD;
    if (ready && !ptr.classList.contains('ready')) haptic('light');
    ptr.classList.toggle('ready', ready);
  }, { passive: true });
  window.addEventListener('touchend', async () => {
    if (startY === null) return;
    const go = dy >= THRESHOLD;
    startY = null;
    if (!go) { ptr.style.opacity = '0'; ptr.classList.remove('ready'); return; }
    ptr.classList.add('spin');
    ptr.style.transform = 'translateY(8px)';
    try { await syncStrava(); } finally {
      ptr.classList.remove('spin', 'ready');
      ptr.style.opacity = '0';
      ptr.style.transform = '';
    }
  });
}

// After an update or a zone change, rides carry metrics from older formulas.
// Recompute them in the background (only derived fields change; rides, intents and chats are untouched).
async function refreshStaleMetrics() {
  try {
    const stale = (await db.workouts.toArray()).filter(needsMetrics);
    if (!stale.length) return;
    for (const w of stale) await ensureRideMetrics(w, undefined, true);
    if (Router.current === 'rides' && !$$('.panel.open').length) await renderRides();
    if (stale.length > 2) toast(`Updated metrics for ${stale.length} rides`, 'success', 2200);
  } catch (e) {
    console.warn('Background metric refresh failed', e);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  boot().catch(err => {
    console.error(err);
    if (window.__rpErrors) window.__rpErrors.push(err && err.message ? err.message : String(err));
    window.__rpShowRecovery('Ride Partner hit an error while starting.');
  });
});
