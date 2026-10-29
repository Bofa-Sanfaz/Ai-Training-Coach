'use strict';
// --------------------------------------------------------
// COACH HUB: master season coach + list of ride conversations
// (ride threads open inside the ride detail so data and chat sit together)
// --------------------------------------------------------
let lastPendingHubPayload = null;
let hubAiBusy = false;

async function renderCoachList() {
  const host = $('#threadList');
  const workouts = await db.workouts.orderBy('date').reverse().toArray();
  const threads = await db.threads.toArray();
  const lastMaster = await db.master_chat.reverse().first();

  const byRide = new Map();
  for (const t of threads) {
    const k = Number(t.strava_id);
    const e = byRide.get(k) || { coach: false, last: null };
    if (t.role === 'coach') e.coach = true;
    if (!e.last || (t.created_at || '') >= (e.last.created_at || '')) e.last = t;
    byRide.set(k, e);
  }

  let html = `
    <div class="thread-row" onclick="openMasterThread()">
      <div class="avatar master">${icon('star')}</div>
      <div class="thread-body">
        <div class="thread-top"><span class="thread-name">Master season coach</span><span class="thread-time">${lastMaster ? escapeHtml(relativeTime(lastMaster.created_at)) : ''}</span></div>
        <div class="thread-snippet">${lastMaster ? escapeHtml(String(lastMaster.message).slice(0, 80)) : 'Remembers your whole season — ask about load, progress or what to ride next.'}</div>
      </div>
    </div>
    <div class="section-title"><span>Ride conversations</span><span class="tiny muted">${workouts.length}</span></div>`;

  if (!workouts.length) {
    html += `<div class="empty">${icon('chat')}<div><b>No rides yet</b></div><div class="small mt-8">Each synced ride gets its own coach thread.</div></div>`;
  }
  for (const w of workouts.slice(0, 300)) {
    const e = byRide.get(Number(w.strava_id));
    const badge = !e || !e.coach ? '<span class="badge badge-new">New</span>' : (w.debrief_stale ? '<span class="badge badge-stale">Update</span>' : '');
    const snippet = e && e.last ? String(e.last.message).slice(0, 70) : `${fmtNum(w.distance_km, 1)} km · ${fmtNum(w.avg_speed_kmh, 1)} km/h · ${w.avg_hr || '--'} bpm`;
    html += `
      <div class="thread-row" onclick="openRide(${w.id}, { scrollToCoach: true })">
        <div class="avatar" style="color:${intentAccent(w) === 'var(--border)' ? 'var(--muted)' : intentAccent(w)}">${icon('bike')}</div>
        <div class="thread-body">
          <div class="thread-top"><span class="thread-name">${escapeHtml(rideTitle(w))}</span><span class="row" style="gap:6px">${badge}<span class="thread-time">${escapeHtml(formatNiceDate(w.date, false))}</span></span></div>
          <div class="thread-snippet">${escapeHtml(snippet)}</div>
        </div>
      </div>`;
  }
  host.innerHTML = html;
}

async function openMasterThread() {
  openPanel('threadPanel', () => { if (Router.current === 'coach') renderCoachList(); });
  const count = await db.workouts.count();
  $('#masterSub').textContent = `Remembers all ${count} rides`;
  await renderHubChat();
  scrollMasterToEnd(false);
}

function scrollMasterToEnd(smooth = true) {
  const b = $('#masterBody');
  b.scrollTo({ top: b.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

async function renderHubChat(extra = '') {
  const msgs = await db.master_chat.toArray();
  let html;
  if (!msgs.length) {
    const wt = await getLatestWeight();
    html = `<div class="bubble bubble-coach"><div class="bubble-sender"><span>Master coach</span></div>
      Hello ${escapeHtml(ATHLETE.name)}. I keep your full season in view (${wt ? `${wt} kg` : 'weight not logged'}, ${escapeHtml(ATHLETE.bike)}).
      Ask me about adaptations, training load, recovery or what to ride next — you can attach a chart screenshot too.</div>`;
  } else {
    html = msgs.map(m => bubbleHtml(m, 'Master coach')).join('');
  }
  if (lastPendingHubPayload) {
    html += bubbleHtml({ role: 'athlete', message: lastPendingHubPayload.text, image_b64: lastPendingHubPayload.image_b64 });
    if (!hubAiBusy) html += `<div class="retry-card"><span>Message not answered.</span><button class="btn btn-primary btn-xs" onclick="retryHubMessage()">${icon('refresh', 'ic-sm')}Retry</button></div>`;
  }
  $('#hubChatContainer').innerHTML = html + extra;
}

async function sendHubReply() {
  if (hubAiBusy) return;
  const input = $('#hubReplyInput');
  const text = input.value.trim();
  const img = attachments.HUB;
  if (!text && !img) return;
  input.value = '';
  autoGrow(input);
  clearAttachment('HUB');
  lastPendingHubPayload = { text, image_b64: img };
  await executeHubMessageDispatch(lastPendingHubPayload);
}

async function retryHubMessage() {
  if (lastPendingHubPayload) await executeHubMessageDispatch(lastPendingHubPayload);
}

async function executeHubMessageDispatch(payload) {
  hubAiBusy = true;
  await renderHubChat(typingHtml('Reviewing your season'));
  scrollMasterToEnd();
  try {
    const reply = await callGemini(await buildMasterPrompt(payload.text, !!payload.image_b64), payload.image_b64);
    if (reply) {
      await db.master_chat.add({ role: 'athlete', message: payload.text, image_b64: payload.image_b64, created_at: new Date().toISOString() });
      await db.master_chat.add({ role: 'coach', message: reply, created_at: new Date().toISOString() });
      lastPendingHubPayload = null;
    }
  } catch (e) {
    toast(`Message failed: ${e.message}`, 'error');
  } finally {
    hubAiBusy = false;
    await renderHubChat();
    scrollMasterToEnd();
  }
}

async function resetMasterThread() {
  const ok = await uiConfirm('Reset season coach?', 'This deletes the whole master coach conversation. Ride threads are not affected.', { okText: 'Reset', danger: true });
  if (!ok) return;
  await db.master_chat.clear();
  lastPendingHubPayload = null;
  clearAttachment('HUB');
  await renderHubChat();
  toast('Conversation reset', 'success', 1600);
}
