'use strict';
// --------------------------------------------------------
// FIRST-RUN INTRODUCTION
// Shown once on a fresh install / web app (no workouts and no name yet) — never on a
// phone that already has data. Collects what makes the numbers right for THIS person
// (name, sex, age → max HR, resting HR, weight → zones and load). On the web app (a friend with
// a Huawei watch) it starts with his account (any device, encrypted backup), then his Huawei
// history (export, or skip with a reminder), the squad and the AI coach — history before the
// squad, so his "own usual" baseline uses his real past. The step is remembered across reloads. Profile → "Introduction" reopens it.
// --------------------------------------------------------
const introSteps = () => (isNative()
  ? ['welcome', 'you', 'workouts', 'coach', 'squad', 'done']
  : ['welcome', 'account', 'you', 'history', 'squad', 'coach', 'done']);
// Zone limits as a share of max HR (same proportions as the app's defaults)
const INTRO_ZONE_SHARE = [0.652, 0.749, 0.826, 0.913];
const Intro = { step: 0, joinCode: null };

async function introNeeded() {
  if ((await getConfig('intro_done')) === '1') return false;
  if ((await getConfig('intro_step')) !== '') return true; // in the middle of it (e.g. after a reload)
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
      <p class="hint center">${isNative() ? 'Your training stays on this phone.' : 'Your training is backed up encrypted to your own account.'} Takes a few minutes.</p>`;
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
      <p class="intro-lead">Bring in your past sessions once. New ones: Training → <b>Screenshot</b> (the AI reads them) or <b>Log</b>.</p>
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
  } else if (step === 'account') {
    const acc = typeof accountGet === 'function' ? accountGet() : null;
    html = `<h2 class="intro-title">Your account</h2>
      <p class="intro-lead">A username and password let you open the app on <b>any device</b> — your training is backed up <b>encrypted</b>: only your password opens it.</p>
      ${acc ? `<div class="intro-ok">${icon('check-circle')}<span>Signed in as <b>${escapeHtml(acc.username)}</b>.</span></div>`
        : `<div class="btn-row"><button class="btn btn-primary" onclick="openAccountSheet('signup')">${icon('user')}Create account</button><button class="btn btn-secondary" onclick="openAccountSheet('signin')">I have one — sign in</button></div>`}
      <div class="hint mt-8">Signing in on a new device brings back everything: workouts, charts, chats, settings and the squad.</div>`;
    nextLabel = acc ? 'Next' : 'Create an account first';
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
  // The web app (a friend's phone) can't skip the account and "about you"
  $('#introSkip').classList.toggle('hidden', Intro.step === steps.length - 1 || (!isNative() && Intro.step <= steps.indexOf('you')));
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
  if (step === 'account' && !(typeof accountGet === 'function' && accountGet())) { openAccountSheet('signup'); return; }
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
