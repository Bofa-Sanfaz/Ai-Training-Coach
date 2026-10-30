'use strict';
// --------------------------------------------------------
// FIRST-RUN INTRODUCTION
// Shown once on a fresh install / web app (no workouts and no name yet) — never on a
// phone that already has data. Collects what makes the numbers right for THIS person
// (name, sex, age → max HR, resting HR, weight → zones and load), then on the web app
// (a friend with a Huawei watch): his Huawei history (export, or skip with a reminder),
// Strava for new sessions, the AI coach and the squad — history before the squad, so his
// "own usual" baseline uses his real past. The step is remembered, so the Strava sign-in
// (which leaves the page) comes back to the next step. Profile → "Introduction" reopens it.
// --------------------------------------------------------
const introSteps = () => (isNative()
  ? ['welcome', 'you', 'workouts', 'coach', 'squad', 'done']
  : ['welcome', 'you', 'history', 'strava', 'coach', 'squad', 'done']);
// Zone limits as a share of max HR (same proportions as the app's defaults)
const INTRO_ZONE_SHARE = [0.652, 0.749, 0.826, 0.913];
const Intro = { step: 0, joinCode: null };

async function introNeeded() {
  if ((await getConfig('intro_done')) === '1') return false;
  if ((await getConfig('intro_step')) !== '') return true; // in the middle of it (e.g. back from Strava)
  if ((await db.workouts.count()) > 0 || (await getConfig('athlete_name'))) { await setConfig('intro_done', '1'); return false; }
  return true;
}

async function openIntro(joinCode) {
  if (joinCode) { Intro.joinCode = joinCode; await setConfig('intro_join', joinCode); }
  else Intro.joinCode = (await getConfig('intro_join')) || null;
  const saved = (await getConfig('intro_done')) === '1' ? NaN : parseInt(await getConfig('intro_step'), 10);
  Intro.step = Number.isFinite(saved) ? Math.min(saved, introSteps().length - 1) : 0;
  openPanel('introPanel', async () => { await setConfig('intro_done', '1'); await setConfig('intro_step', ''); });
  await renderIntro();
}

function introDots() {
  return `<div class="intro-dots">${introSteps().map((s, i) => `<i class="${i === Intro.step ? 'on' : i < Intro.step ? 'done' : ''}"></i>`).join('')}</div>`;
}

const introCopy = (text, label) => `<button type="button" class="btn btn-ghost btn-xs" onclick="navigator.clipboard && navigator.clipboard.writeText('${escapeHtml(text)}').then(() => toast('Copied', 'success', 1200))">${icon('repeat', 'ic-sm')}${label || 'Copy'}</button>`;

async function renderIntro() {
  const steps = introSteps();
  const step = steps[Intro.step];
  await setConfig('intro_step', String(Intro.step));
  const body = $('#introBody');
  const name = (await getConfig('athlete_name')) || (await getConfig('squad_name')) || '';
  let html = '';
  let nextLabel = 'Next';
  if (step === 'welcome') {
    html = `<div class="intro-hero"><img src="img/logo.svg" alt="" /></div>
      <h2 class="intro-title">Welcome to Training Partner</h2>
      <p class="intro-lead">Your own AI training coach — and a squad to train with.</p>
      <div class="intro-list">
        <div>${icon('activity')}<span><b>Training</b> — every session with heart-rate zones, load, pace, routes, swim lengths and SWOLF</span></div>
        <div>${icon('trend')}<span><b>Trends &amp; Reports</b> — fitness, fatigue, records and monthly PDFs</span></div>
        <div>${icon('chat')}<span><b>Coach</b> — Aether and session coaches that know all your training</span></div>
        <div>${icon('multi')}<span><b>Squad</b> — challenges with friends, scored against <b>your own</b> usual numbers</span></div>
      </div>
      <p class="hint center">Your training stays on this phone. Takes a few minutes.</p>`;
    nextLabel = 'Let\'s go';
  } else if (step === 'you') {
    const sex = (await getConfig('trimp_sex')) || 'M';
    const max = await getConfig('max_hr');
    const rest = await getConfig('resting_hr');
    const h = await getWeightHistory();
    html = `<h2 class="intro-title">About you</h2>
      <p class="intro-lead">These make your heart-rate zones, training load and coaching right for <b>your</b> body.</p>
      <div class="field"><label for="in_name">Your first name</label><input id="in_name" class="input" maxlength="30" value="${escapeHtml(name)}" /></div>
      <div class="row mt-8" style="gap:8px">
        <div class="field grow"><label for="in_sex">Sex</label><select id="in_sex" class="input"><option value="M" ${sex === 'M' ? 'selected' : ''}>Male</option><option value="F" ${sex === 'F' ? 'selected' : ''}>Female</option></select></div>
        <div class="field grow"><label for="in_age">Age</label><input id="in_age" class="input" inputmode="numeric" maxlength="3" value="${escapeHtml(await getConfig('athlete_age') || '')}" oninput="introAgeChanged()" /></div>
        <div class="field grow"><label for="in_kg">Weight (kg)</label><input id="in_kg" class="input" inputmode="decimal" value="${h.length ? h[h.length - 1].weight : ''}" /></div>
      </div>
      <div class="row mt-8" style="gap:8px">
        <div class="field grow"><label for="in_max">Max heart rate</label><input id="in_max" class="input" inputmode="numeric" value="${escapeHtml(max || '')}" placeholder="from your age" /></div>
        <div class="field grow"><label for="in_rest">Resting heart rate</label><input id="in_rest" class="input" inputmode="numeric" value="${escapeHtml(rest || '60')}" /></div>
      </div>
      <div class="hint mt-4">Don't know your max HR? Leave it — it's estimated from your age (208 − 0.7 × age). Your watch's highest reading in a hard effort is better; you can change it any time in Profile.</div>`;
  } else if (step === 'history') {
    const last = await getConfig('huawei_last_import');
    const n = (await db.workouts.toArray()).filter(w => w.source === 'huawei').length;
    html = `<h2 class="intro-title">Your Huawei history</h2>
      <p class="intro-lead">Bring in your past sessions once — Strava only sends <b>new</b> ones from now on.</p>
      ${last ? `<div class="intro-ok">${icon('check-circle')}<span>Imported: ${n} Huawei session${n === 1 ? '' : 's'}.</span></div>` : ''}
      <ol class="hw-steps">
        <li><b>Huawei Health</b> → <b>Me</b> → tap your name → <b>Privacy Center</b> → <b>Request your data</b> → tick <b>Health</b> → set a password → Send.</li>
        <li>Huawei e-mails a link (minutes to a few hours) → download the ZIP (Files → Downloads).</li>
        <li>Pick it here with the password:</li>
      </ol>
      <div class="field"><input id="in_hw_file" type="file" class="input" accept=".zip,application/zip,.json" /></div>
      <div class="row mt-8" style="gap:8px">
        <input id="in_hw_pw" type="password" class="input grow" autocomplete="off" placeholder="ZIP password" value="${escapeHtml((await getConfig('huawei_zip_pw')) || '')}" />
        <button class="btn btn-primary btn-sm" id="inHwBtn" style="flex:0 0 auto" onclick="introHuaweiImport()">${icon('download')}Import</button>
      </div>
      <div class="small mt-8" id="in_hw_status" role="status"></div>
      <div class="hint mt-8">Waiting for Huawei's e-mail? Tap <b>Skip for now</b> — a reminder stays on the Training screen until it's imported.</div>`;
    nextLabel = last ? 'Next' : 'Skip for now';
  } else if (step === 'strava') {
    const connected = !!(await getConfig('strava_refresh_token'));
    html = `<h2 class="intro-title">New sessions automatically</h2>
      <p class="intro-lead">Huawei Health → Strava → this app: walks, runs and rides arrive by themselves. Free.</p>
      ${connected ? `<div class="intro-ok">${icon('check-circle')}<span>Strava is connected.</span></div>` : `
      <ol class="hw-steps">
        <li><b>Huawei Health</b> → <b>Me</b> → <b>Third-party services</b> → <b>Strava</b> → link (create a free Strava account if needed).</li>
        <li>Open <a href="https://www.strava.com/settings/api" target="_blank" rel="noopener">strava.com/settings/api</a> and create an app:
          <div class="intro-kv"><span>Name</span><b>Training Partner</b></div>
          <div class="intro-kv"><span>Category</span><b>Training</b></div>
          <div class="intro-kv"><span>Website</span><b>${escapeHtml(location.origin)}</b>${introCopy(location.origin)}</div>
          <div class="intro-kv"><span>Authorization Callback Domain</span><b>${escapeHtml(location.host)}</b>${introCopy(location.host)}</div>
        </li>
        <li>Copy its Client ID and Client Secret here and tap <b>Connect</b> → Authorize:</li>
      </ol>
      <div class="row" style="gap:8px">
        <input id="in_sv_id" class="input grow" inputmode="numeric" placeholder="Client ID" value="${escapeHtml((await getConfig('strava_client_id')) || '')}" />
        <input id="in_sv_secret" type="password" class="input grow" autocomplete="off" placeholder="Client Secret" />
      </div>
      <button class="btn btn-primary mt-8" onclick="introStravaConnect()"><svg width="18" height="18" viewBox="0 0 24 24" fill="#ffffff"><path d="M15.387 17.944l-2.089-4.116h-3.065L15.387 24l5.15-10.172h-3.066m-7.008-5.599l2.836 5.598h4.172L10.463 0l-7.2 13.828h4.172"/></svg>Connect Strava</button>
      <div class="hint mt-8">Swims and gym that don't reach Strava: Training → <b>Log</b>, or the camera button to read a screenshot.</div>`}`;
    nextLabel = connected ? 'Next' : 'Skip for now';
  } else if (step === 'workouts') {
    html = `<h2 class="intro-title">Where do your workouts come from?</h2>
      <p class="intro-lead">Pick what you use — you can add more later in Profile.</p>
      <div class="intro-cards">
        <button class="intro-card" onclick="closePanel('introPanel'); switchTab('profile')">${icon('heart')}<span><b>Samsung Health / Galaxy Watch</b><small>Swims, treadmill, gym, sleep and heart rate, automatic.</small></span></button>
        <div class="intro-card static">${icon('link')}<span><b>Strava</b><small>Profile → Connections.</small></span></div>
        <div class="intro-card static">${icon('camera')}<span><b>From a screenshot</b><small>Training → camera button: the AI reads every number; you check and save.</small></span></div>
        <div class="intro-card static">${icon('plus')}<span><b>Log by hand</b><small>Training → Log.</small></span></div>
      </div>`;
  } else if (step === 'coach') {
    const g = (AI.providers || []).find(p => p.type === 'gemini');
    const ready = (AI.providers || []).some(p => providerReady(p));
    html = `<h2 class="intro-title">Your AI coach</h2>
      <p class="intro-lead"><b>Aether</b> knows your whole season; every session also gets its own coach, and it reads workout screenshots for you. It needs an AI key — Google's is <b>free</b>.</p>
      ${ready ? `<div class="intro-ok">${icon('check-circle')}<span>An AI provider is already set up${g && g.apiKey ? ' (Google Gemini)' : ''}.</span></div>` : ''}
      <ol class="hw-steps">
        <li>Open <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> and sign in with a Google account.</li>
        <li>Tap <b>Create API key</b> and copy it.</li>
        <li>Paste it here:</li>
      </ol>
      <div class="field"><input id="in_gemini" class="input" placeholder="AIza…" autocomplete="off" value="" /></div>
      <div class="hint mt-4">The key stays on this phone. In the Squad, Aether runs on the challenge owner's key, so the squad chat works even without one.</div>`;
  } else if (step === 'squad') {
    const live = typeof Squad !== 'undefined' ? Squad.list.filter(c => !c.revoked) : [];
    html = `<h2 class="intro-title">Train with friends</h2>
      <p class="intro-lead">A shared feed, a 3-way chat with Aether (ask, review, roast) and a scoreboard where everyone is measured against <b>himself</b>.</p>
      ${live.length ? `<div class="intro-ok">${icon('check-circle')}<span>You're in <b>${escapeHtml(live.map(c => c.name).join(', '))}</b>.</span></div>`
        : Intro.joinCode ? `<button class="btn btn-primary" onclick="introJoin()">${icon('link')}Join the challenge ${escapeHtml(Intro.joinCode.toUpperCase())}</button>`
        : `<div class="btn-row"><button class="btn btn-secondary" onclick="introJoin()">${icon('link')}Join with a code</button><button class="btn btn-secondary" onclick="closePanel('introPanel'); openSquadStart()">${icon('plus')}Start one</button></div>`}
      <div class="hint mt-8">Only summaries are shared (numbers, personal bests, how it felt). Weight, sleep and heart-rate trends only if you switch them on.</div>`;
  } else {
    html = `<div class="intro-hero done">${icon('check-circle')}</div>
      <h2 class="intro-title">You're set${name ? `, ${escapeHtml(name)}` : ''}!</h2>
      <p class="intro-lead">Tips: pull down on Training to sync · <b>Log</b> or the <b>camera</b> on Training for swims and gym · tap any session for the full analysis and its coach · the Squad tab has its own sections at the top.</p>`;
    nextLabel = `${icon('check-circle')}Start training`;
  }
  body.innerHTML = introDots() + `<div class="intro-step">${html}</div>`;
  $('#introBack').classList.toggle('hidden', Intro.step === 0);
  $('#introNext').innerHTML = nextLabel;
  $('#introSkip').classList.toggle('hidden', Intro.step === steps.length - 1);
  if (step === 'you' && !$('#in_max').value) introAgeChanged();
  animateIn(body);
}

function introAgeChanged() {
  const age = parseInt($('#in_age').value, 10);
  const max = $('#in_max');
  if (age >= 10 && age <= 99 && (!max.value || max.dataset.auto === '1')) { max.value = String(Math.round(208 - 0.7 * age)); max.dataset.auto = '1'; }
}

async function introSaveYou() {
  const name = $('#in_name').value.trim();
  const max = parseInt($('#in_max').value, 10), rest = parseInt($('#in_rest').value, 10), age = parseInt($('#in_age').value, 10);
  const kg = parseFloat(String($('#in_kg').value).replace(',', '.'));
  if (!name) { toast('Enter your name', 'warn'); return false; }
  if (!(max >= 120 && max <= 230)) { toast('Max heart rate must be between 120 and 230 (or enter your age)', 'warn'); return false; }
  if (!(rest >= 30 && rest < max - 40)) { toast('Resting heart rate must be between 30 and max − 40', 'warn'); return false; }
  await setConfig('athlete_name', name);
  if (!(await getConfig('squad_name'))) await setConfig('squad_name', name);
  if (age > 0) await setConfig('athlete_age', String(age));
  const changedHr = String(max) !== (await getConfig('max_hr')) || String(rest) !== (await getConfig('resting_hr'));
  await setConfig('trimp_sex', $('#in_sex').value);
  await setConfig('max_hr', String(max));
  await setConfig('resting_hr', String(rest));
  await setJsonConfig('zone_bounds', INTRO_ZONE_SHARE.map(s => Math.round(max * s)));
  if (kg >= 25 && kg <= 300) {
    const today = formatLocalDate(new Date());
    const h = (await getWeightHistory()).filter(e => String(e.date).slice(0, 10) !== today);
    h.push({ date: today, weight: round(kg, 1) });
    await saveWeightHistory(h);
  }
  await loadPhysioConfig();
  $('#brandSub').textContent = `Coach for ${ATHLETE.name}`;
  if (changedHr && (await db.workouts.count())) await recalculateAll(true);
  return true;
}

async function introHuaweiImport() {
  const file = $('#in_hw_file').files && $('#in_hw_file').files[0];
  const pw = $('#in_hw_pw').value;
  const status = $('#in_hw_status');
  if (!file) { toast('Pick the ZIP from Huawei\'s e-mail first', 'warn'); return; }
  const btn = $('#inHwBtn');
  setBusy(btn, true, 'Reading…');
  status.textContent = 'Opening the export…';
  try {
    const r = await importHuaweiExport(file, pw, (i, n) => { status.textContent = `Reading session ${i} of ${n}…`; });
    await setConfig('huawei_zip_pw', pw);
    await huaweiImportDone(r);
    status.textContent = r.added ? `✓ Added ${r.added} session${r.added === 1 ? '' : 's'}.` : `Nothing new (${r.found} sessions in the export${r.skipped ? `, ${r.skipped} already here` : ''}).`;
    haptic('success');
    await renderIntro();
  } catch (e) {
    status.textContent = `Could not import: ${e.message}`;
  } finally { if ($('#inHwBtn')) setBusy($('#inHwBtn'), false); }
}

// Saves the Strava app keys and signs in; the page comes back to the next step
async function introStravaConnect() {
  const id = $('#in_sv_id').value.trim(), secret = $('#in_sv_secret').value.trim();
  if (!/^\d{3,}$/.test(id) || secret.length < 10) { toast('Paste the Client ID (a number) and the Client Secret from strava.com/settings/api', 'warn', 5000); return; }
  $('#cfg_client_id').value = id;
  $('#cfg_client_secret').value = secret;
  await setConfig('intro_step', String(Intro.step + 1));
  await startAutomaticOAuth();
}

async function introSaveCoach() {
  const key = ($('#in_gemini') && $('#in_gemini').value || '').trim();
  if (!key) return true;
  if (!/^AIza[0-9A-Za-z_-]{20,}$/.test(key)) { toast('That doesn\'t look like a Google AI key (it starts with AIza…)', 'warn'); return false; }
  let g = AI.providers.find(p => p.type === 'gemini');
  if (!g) { g = newProvider('gemini', { id: 'gemini' }); AI.providers.push(g); }
  g.apiKey = key;
  g.enabled = true;
  AI.active = g.id;
  await saveAiSettings();
  await refreshModelSelectors();
  toast('AI coach ready', 'success');
  return true;
}

async function introNext() {
  const steps = introSteps();
  const step = steps[Intro.step];
  if (step === 'you' && !(await introSaveYou())) return;
  if (step === 'coach' && !(await introSaveCoach())) return;
  // Skipped the history: keep a reminder on the Training screen until it's imported
  if (step === 'history' && !(await getConfig('huawei_last_import'))) await setConfig('huawei_import_pending', '1');
  if (Intro.step === steps.length - 1) { await introFinish(); return; }
  Intro.step++;
  haptic('light');
  await renderIntro();
}

async function introBack() {
  if (Intro.step > 0) { Intro.step--; await renderIntro(); }
}

async function introFinish() {
  await setConfig('intro_done', '1');
  await setConfig('intro_step', '');
  closePanel('introPanel');
  if (typeof confetti === 'function') confetti({ particleCount: 70, spread: 60, origin: { y: 0.75 } });
  switchTab((typeof Squad !== 'undefined' && Squad.list.some(c => !c.revoked) && !(await db.workouts.count())) ? 'squad' : 'rides');
}

function introJoin() {
  openSquadJoin(Intro.joinCode || undefined);
}
