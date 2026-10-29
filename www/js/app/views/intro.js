'use strict';
// --------------------------------------------------------
// FIRST-RUN INTRODUCTION
// Shown once on a fresh install / web app (no workouts and no name yet) — never on a
// phone that already has data. Collects what makes the numbers right for THIS person
// (name, sex, age → max HR, resting HR, weight → zones and load), connects a workout
// source, the AI coach and the squad. Skippable; Profile → "Show introduction" reopens it.
// --------------------------------------------------------
const INTRO_STEPS = ['welcome', 'you', 'workouts', 'coach', 'squad', 'done'];
// Zone limits as a share of max HR (same proportions as the app's defaults)
const INTRO_ZONE_SHARE = [0.652, 0.749, 0.826, 0.913];
const Intro = { step: 0, joinCode: null };

async function introNeeded() {
  if ((await getConfig('intro_done')) === '1') return false;
  if ((await db.workouts.count()) > 0 || (await getConfig('athlete_name'))) { await setConfig('intro_done', '1'); return false; }
  return true;
}

async function openIntro(joinCode) {
  if (joinCode) Intro.joinCode = joinCode;
  Intro.step = 0;
  openPanel('introPanel', () => setConfig('intro_done', '1'));
  await renderIntro();
}

function introDots() {
  return `<div class="intro-dots">${INTRO_STEPS.map((s, i) => `<i class="${i === Intro.step ? 'on' : i < Intro.step ? 'done' : ''}"></i>`).join('')}</div>`;
}

async function renderIntro() {
  const step = INTRO_STEPS[Intro.step];
  const body = $('#introBody');
  const name = (await getConfig('athlete_name')) || (await getConfig('squad_name')) || '';
  let html = '';
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
      <p class="hint center">Your training stays on this phone. Takes about 2 minutes.</p>`;
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
  } else if (step === 'workouts') {
    const native = isNative();
    html = `<h2 class="intro-title">Where do your workouts come from?</h2>
      <p class="intro-lead">Pick what you use — you can add more later in Profile.</p>
      <div class="intro-cards">
        <button class="intro-card ${native ? '' : 'primary'}" onclick="openHuaweiImport()">${icon('download')}<span><b>Huawei Health</b> (Huawei watch / band)<small>Imports your whole history: heart rate, routes, steps and every pool length.</small></span></button>
        <button class="intro-card" onclick="closePanel('introPanel'); switchTab('profile'); setTimeout(() => $('#cfg_client_id') && $('#cfg_client_id').scrollIntoView({ block: 'center' }), 600)">${icon('link')}<span><b>Strava</b><small>Automatic sync of everything you record on Strava.</small></span></button>
        ${native ? `<button class="intro-card" onclick="closePanel('introPanel'); switchTab('profile')">${icon('heart')}<span><b>Samsung Health / Galaxy Watch</b><small>Swims, treadmill, gym, sleep and heart rate, automatic.</small></span></button>` : ''}
        <div class="intro-card static">${icon('camera')}<span><b>Anything else</b><small>Squad → Add from screenshot: the AI reads the numbers off any app's screen.</small></span></div>
      </div>
      <div class="small mt-8" id="introWorkoutCount"></div>`;
  } else if (step === 'coach') {
    const g = (AI.providers || []).find(p => p.type === 'gemini');
    const ready = (AI.providers || []).some(p => providerReady(p));
    html = `<h2 class="intro-title">Your AI coach</h2>
      <p class="intro-lead"><b>Aether</b> knows your whole season; every session also gets its own coach. They need an AI key — Google's is <b>free</b>.</p>
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
      <p class="intro-lead">Tips: pull down on Training to sync · tap any session for the full analysis and its coach · the Squad tab has its own sections at the top.</p>`;
  }
  body.innerHTML = introDots() + `<div class="intro-step">${html}</div>`;
  $('#introBack').classList.toggle('hidden', Intro.step === 0);
  $('#introNext').innerHTML = Intro.step === INTRO_STEPS.length - 1 ? `${icon('check-circle')}Start training` : step === 'welcome' ? 'Let\'s go' : 'Next';
  $('#introSkip').classList.toggle('hidden', Intro.step === INTRO_STEPS.length - 1);
  if (step === 'you' && !$('#in_max').value) introAgeChanged();
  if (step === 'workouts') introWorkoutCount();
  animateIn(body);
}

function introAgeChanged() {
  const age = parseInt($('#in_age').value, 10);
  const max = $('#in_max');
  if (age >= 10 && age <= 99 && (!max.value || max.dataset.auto === '1')) { max.value = String(Math.round(208 - 0.7 * age)); max.dataset.auto = '1'; }
}

async function introWorkoutCount() {
  const n = await db.workouts.count();
  const el = $('#introWorkoutCount');
  if (el) el.textContent = n ? `✓ ${n} workout${n === 1 ? '' : 's'} on this phone so far.` : '';
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
  const step = INTRO_STEPS[Intro.step];
  if (step === 'you' && !(await introSaveYou())) return;
  if (step === 'coach' && !(await introSaveCoach())) return;
  if (Intro.step === INTRO_STEPS.length - 1) { await introFinish(); return; }
  Intro.step++;
  haptic('light');
  await renderIntro();
}

async function introBack() {
  if (Intro.step > 0) { Intro.step--; await renderIntro(); }
}

async function introFinish() {
  await setConfig('intro_done', '1');
  closePanel('introPanel');
  if (typeof confetti === 'function') confetti({ particleCount: 70, spread: 60, origin: { y: 0.75 } });
  switchTab((typeof Squad !== 'undefined' && Squad.list.some(c => !c.revoked) && !(await db.workouts.count())) ? 'squad' : 'rides');
}

function introJoin() {
  openSquadJoin(Intro.joinCode || undefined);
}
