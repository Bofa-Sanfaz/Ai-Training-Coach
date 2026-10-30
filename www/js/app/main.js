'use strict';
// --------------------------------------------------------
// ROUTER, BOOT, DEEP LINKS, NETWORK, WHAT'S NEW
// --------------------------------------------------------
const Router = { current: 'rides' };
const TAB_ALIASES = { feed: 'rides', graphs: 'trends', chats: 'coach', settings: 'profile' };

// Screens push in the direction you move along the tab bar (view transition);
// the new screen is rendered inside the transition so it arrives complete.
function switchTab(tab) {
  tab = TAB_ALIASES[tab] || tab;
  ['rideDetail', 'threadPanel', 'squadChat'].forEach(closePanel);
  $$('.sheet.open').forEach(s => closeSheet(s.id));
  const from = Router.current;
  Router.current = tab;
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  moveNavIndicator(tab);
  const render = { rides: renderRides, trends: renderTrends, compare: setupComparison, coach: renderCoachList, squad: renderSquad, reports: renderReports, profile: renderProfile }[tab];
  if (tab === 'squad' || from === 'squad') setTimeout(() => squadSchedule(tab === 'squad' ? 200 : 0), 0);
  // Chart-heavy screens render after the transition so the tab never feels frozen
  const heavy = ['trends', 'compare', 'reports'].includes(tab);
  const show = async () => {
    $$('.screen').forEach(s => s.classList.toggle('active', s.id === `screen-${tab}`));
    window.scrollTo({ top: 0 });
    if (render && !heavy) await Promise.race([Promise.resolve(render()), new Promise(r => setTimeout(r, 350))]);
  };
  viewSwap(show, from === tab ? 'fade' : tabDirection(from, tab))
    .then(() => (heavy && render ? render() : null))
    .then(() => animateIn($(`#screen-${tab}`)))
    .catch(err => { console.error(err); toast(`Could not load ${tab}: ${err.message}`, 'error'); });
}

function checkNetwork() {
  const pill = $('#networkStatus');
  pill.textContent = navigator.onLine ? 'Online' : 'Offline';
  pill.classList.toggle('offline', !navigator.onLine);
}

const WHATS_NEW = `
### New in 3.6 — Huawei watches, an introduction, a faster squad
- **Huawei Health import** (Profile → Huawei Health): your whole history from Huawei's own data export — heart rate, GPS route, steps, calories and every pool length with strokes and SWOLF; later imports only add what's new
- **Introduction** for new users (Profile → Introduction): name, heart rate and weight so zones and load fit your body, where workouts come from, the AI coach and the squad
- **Squad server** stays inside the free plan even after months of training: your phone prepares the AI's context, so Aether answers quickly
- The iPhone web app uses Google Gemini only ("use another Gemini model" or "keep retrying this one")

### New in 3.5 — Squad: train together
- **Squad tab**, its own little app: **Home · Chat · Feed · Stats · Report · Crew**. Start a challenge, send the invite code — friends on iPhone use the same app from Safari (Add to Home Screen)
- **Scored against yourself**: consistency vs your own target days, minutes vs your own usual, pace vs your own usual pace, personal bests and streaks — different bodies never decide the winner. Weekly duels and a monthly winner
- **3-way chat with Aether**: ask with @Aether, tap any message or workout for a **review** or a **roast**; Aether also chimes in on its own (PBs, streaks, quiet days — never while you're talking) and writes a daily recap
- **Stats**: points, minutes and pace vs own usual, sport mix, time of day, training calendar, and — if you choose to share — weight change, steps, resting HR and sleep
- **Monthly report** with graphs, Aether's write-up and a PDF
- Your workouts are shared automatically as **summaries** (numbers, PBs, how it felt, your coach's one-line verdict); **add from screenshot** reads Huawei/other app screens
- **Walks are their own sport** (pace /km, steps, cadence) instead of counting as runs
- Reports: training story graphs, a radar of your training balance and a redesigned PDF

### New in 3.4 — every sport its own numbers
- **Swims**: pace per 100 m (swimming time), **SWOLF**, strokes per length, stroke rate, stroke mix, rest time, fastest length and **best 50/100/200/400 m**, a per-length chart (coloured by stroke, with SWOLF) and 100 m splits — straight from your Galaxy Watch
- **Runs**: pace, **cadence**, steps, watch VO2max; treadmill runs drop GPS climbing
- **Gym**: time, heart rate, peak/lowest HR, load, calories and reps — no distance or speed
- Trends, records, best efforts, Compare, Reports, the PDF and the AI coaches all use the right metrics per sport
- Swims, treadmill, gym bike and gym sessions now come **automatically from Samsung Health**; workouts recorded twice (Strava + watch) are merged; skipped walks are never offered again

### New in 3.3 — Training Partner
- **Rides, runs, swims and gym**: runs from Strava, plus **pool swims, treadmill runs, the gym bike, elliptical, stepper, rowing and strength sessions straight from your Galaxy Watch** (Samsung Health). Every screen and every coach looks at all sports together and each on its own
- **New activities inbox**: walks, hikes, yoga and other types wait for you — include (walks & hikes count as runs) or skip, and remember the choice. Only workouts from 2026 on are imported
- **Reports per sport**: choose All, Rides, Runs, Swims or Gym; the PDF is now a full report (week-by-week table, a page per sport, highlights, plan adherence, recovery log)
- **The full guide** to every function, coach context and calculation is in the project docs (Training-Partner-Guide.pdf)
- **Mark wrong data**: tap the flag on any workout (or on a record) to mark climbing, distance/speed, heart rate or power as a data error, set the sport, mark it indoor — or delete it (sync never brings it back)
- **Compare really compares**: same-sport sessions, \
- Redesigned app with bottom navigation, dark mode, new logo and race-number typography
- Ride detail opens as a full screen with a chat composer that stays at the bottom
- Toasts and in-app dialogs instead of pop-up alerts; Android **Back** button now works everywhere

### 3.2
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
    window.__rpShowRecovery('Training Partner failed to start twice in a row.');
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
    App.addListener('resume', () => { resumedIds.clear(); setTimeout(resumePendingChats, 800); squadTick(true); });
  }
  window.addEventListener('online', () => setTimeout(resumePendingChats, 1500));
  if (location.search && location.search.includes('code=')) processIncomingUrl(location.href);

  await renderRides();
  window.__rpBootOk();
  playIntro();
  setupRipples();
  moveNavIndicator(Router.current, true);
  window.addEventListener('resize', debounce(() => moveNavIndicator(Router.current, true), 150));
  setTimeout(() => { countUp($('#screen-rides')); stagger($$('#rideList .ride-card'), { max: 6 }); }, sessionStorage.getItem('rp_intro_seen') ? 0 : 700);
  try { sessionStorage.setItem('rp_intro_seen', '1'); } catch (e) {}

  if (seen && seen !== APP_VERSION) setTimeout(showWhatsNew, 600); // a brand-new user gets the introduction instead
  setupPullToRefresh();
  await refreshStaleMetrics();
  try { if ((await dedupeWorkouts()) + (await migrateWalks())) await renderRides(); } catch (e) { console.warn('dedupe/walks', e); }
  maybeAutoSync();
  setTimeout(resumePendingChats, 2000);
  // Web app (the friend's): no Strava (a new Strava API app needs a paid plan) — workouts come from
  // screenshots, Log and the Huawei export; his account keeps the data on all his devices
  if (!isNative()) {
    const conn = $('#cfg_client_id') && $('#cfg_client_id').closest('.card');
    if (conn) conn.classList.add('hidden');
    $('#btnSync').classList.add('hidden');
    const shot = $('#btnShot');
    if (shot) { shot.className = 'btn btn-primary btn-sm'; shot.innerHTML = `${icon('camera')}<span>Screenshot</span>`; }
    try { await accountBoot(); } catch (e) { console.warn('account', e); }
  }
  // First run (fresh install / friend's web app): the introduction, which also handles an invite link
  let intro = false;
  try { intro = await introNeeded(); } catch (e) { console.warn('intro', e); }
  const joinHash = (location.hash.match(/join=([A-Za-z0-9-]{8,9})/) || [])[1];
  if (intro) { window.__introPending = true; setTimeout(() => openIntro(joinHash), 900); }
  try { await squadInit(); } catch (e) { console.warn('squad', e); }
}

// Sync button / pull-to-refresh: Strava plus the watch (Samsung Health workouts & wellness)
async function syncAll() {
  // The web app has no Strava: pulling down refreshes the squad and backs up the account instead
  if (!isNative() && !(await getConfig('strava_refresh_token'))) {
    if (typeof Squad !== 'undefined' && Squad.list.length) await squadTick(true);
    if (typeof accountGet === 'function' && accountGet()) await accountUpload('pull to refresh');
    return;
  }
  const jobs = [syncStrava()];
  if ((await getConfig('health_enabled')) === '1') jobs.push(syncWellness(true));
  await Promise.all(jobs);
  // New workouts go to the squad right away (summaries)
  if (Squad.list.length) { Squad.lastShare = 0; squadTick(true); }
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
    try { await syncAll(); } finally {
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
    window.__rpShowRecovery('Training Partner hit an error while starting.');
  });
});
