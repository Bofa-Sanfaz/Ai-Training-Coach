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

### New features
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

  $$('.nav-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
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
  refreshStaleMetrics();
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
