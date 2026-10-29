'use strict';
// --------------------------------------------------------
// COACH HUB: training plan, Aether (season coach) and ride conversations
// (ride threads open inside the ride detail so data and chat sit together)
// --------------------------------------------------------
const AETHER = 'Aether';
let hubAiBusy = false;

async function renderCoachList() {
  const host = $('#threadList');
  const workouts = await db.workouts.orderBy('date').reverse().toArray();
  const threads = await db.threads.toArray();
  const lastMaster = await db.master_chat.reverse().first();
  const pending = (await db.master_chat.toArray()).filter(m => m.proposal && !m.proposal_status).length;

  const byRide = new Map();
  for (const t of threads) {
    const k = Number(t.strava_id);
    const e = byRide.get(k) || { coach: false, last: null };
    if (t.role === 'coach') e.coach = true;
    if (!e.last || (t.created_at || '') >= (e.last.created_at || '')) e.last = t;
    byRide.set(k, e);
  }

  let html = `
    <div class="thread-row aether-row" onclick="openMasterThread()">
      <div class="avatar master">${icon('sparkle')}</div>
      <div class="thread-body">
        <div class="thread-top"><span class="thread-name">${AETHER} <span class="tiny muted">· season coach</span></span><span class="row" style="gap:6px">${pending ? '<span class="badge badge-stale">Plan change</span>' : ''}<span class="thread-time">${lastMaster ? escapeHtml(relativeTime(lastMaster.created_at)) : ''}</span></span></div>
        <div class="thread-snippet">${lastMaster ? escapeHtml(String(lastMaster.message).slice(0, 80)) : 'Knows your whole season, your plan and targets — and can change them when you ask.'}</div>
      </div>
    </div>
    ${await planCardHtml()}
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
  $('#masterSub').textContent = `Season coach · knows all ${count} workouts, your plan and targets`;
  refreshModelSelectors();
  await renderHubChat();
  scrollMasterToEnd(false);
}

function scrollMasterToEnd(smooth = true) {
  const b = $('#masterBody');
  b.scrollTo({ top: b.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

function proposalCardHtml(m) {
  const lines = describePlanChange(m.proposal);
  const status = m.proposal_status;
  return `<div class="proposal ${status ? 'resolved' : ''}">
    <div class="proposal-head">${icon('calendar', 'ic-sm')}<b>${escapeHtml(m.proposal.summary || 'Plan change')}</b></div>
    <ul>${lines.map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
    ${status
      ? `<div class="tiny muted">${status === 'applied' ? '✓ Applied' : 'Dismissed'}</div>`
      : `<div class="btn-row"><button class="btn btn-secondary btn-sm" onclick="resolveProposal(${m.id}, false)">Dismiss</button><button class="btn btn-primary btn-sm" onclick="resolveProposal(${m.id}, true)">${icon('check-circle', 'ic-sm')}Apply</button></div>`}
  </div>`;
}

// Your messages are saved the moment you send them (pending until answered), so
// closing the chat, leaving the app or losing signal never loses them: the reply
// keeps generating in the background and unanswered messages are retried when the
// app comes back (see resumePendingChats).
async function renderHubChat(extra = '') {
  const msgs = await db.master_chat.toArray();
  let html;
  if (!msgs.length) {
    const wt = await getLatestWeight();
    html = `<div class="bubble bubble-coach"><div class="bubble-sender"><span>${AETHER}</span></div>
      Hi ${escapeHtml(ATHLETE.name)}, I'm ${AETHER}. I keep your whole season in view${wt ? ` (${wt} kg, ${escapeHtml(ATHLETE.bike)})` : ''} — rides, runs, swims, load, your weekly plan and targets.
      <br><br>Ask me anything, paste your own training plan and I'll set it up, or tell me when life changes ("I can only ride twice this week") and I'll adjust the plan and targets for you to approve.</div>`;
  } else {
    html = msgs.map(m => bubbleHtml(m, AETHER) + (m.proposal ? proposalCardHtml(m) : '') +
      (m.pending && !hubAiBusy ? `<div class="retry-card"><span>Not answered yet.</span><button class="btn btn-primary btn-xs" onclick="executeHubMessageDispatch(${m.id})">${icon('refresh', 'ic-sm')}Retry</button></div>` : '')).join('');
  }
  if (hubAiBusy && !extra) extra = typingHtml(`${AETHER} is still writing`);
  $('#hubChatContainer').innerHTML = html + extra;
}

async function sendHubReply() {
  if (hubAiBusy) { toast(`${AETHER} is still answering your last message.`, 'warn'); return; }
  const input = $('#hubReplyInput');
  const text = input.value.trim();
  const img = attachments.HUB;
  if (!text && !img) return;
  input.value = '';
  autoGrow(input);
  clearAttachment('HUB');
  const id = await db.master_chat.add({ role: 'athlete', message: text, image_b64: img, created_at: new Date().toISOString(), pending: true });
  await executeHubMessageDispatch(id);
}

// Quick prompts under the composer
function aetherQuick(text) {
  $('#hubReplyInput').value = text;
  autoGrow($('#hubReplyInput'));
  sendHubReply();
}

const hubOpen = () => $('#threadPanel').classList.contains('open');

async function executeHubMessageDispatch(id) {
  const msg = await db.master_chat.get(id);
  if (!msg || hubAiBusy) return;
  hubAiBusy = true;
  await renderHubChat(typingHtml(`${AETHER} is reviewing your season`));
  scrollMasterToEnd();
  try {
    const host = $('#hubChatContainer');
    const live = liveBubble(host, AETHER, () => { if (hubOpen()) scrollMasterToEnd(); });
    const meta = {};
    const reply = await callAI(await buildMasterPrompt(msg.message, !!msg.image_b64, id), msg.image_b64, {
      agent: 'aether', meta, onStatus: aiStatusIn(host),
      onDelta: t => live(hideMemoryTags(hidePlanUpdate(t)))
    });
    if (reply) {
      haptic('success');
      const { text, proposal } = extractPlanUpdate(await captureMemory(reply, AETHER));
      await db.master_chat.update(id, { pending: false });
      await db.master_chat.add(Object.assign({ role: 'coach', message: text || 'Here is the change I propose:', proposal: proposal || undefined, created_at: new Date().toISOString() }, aiMetaFields(meta)));
      if (proposal) toast(`${AETHER} proposed a plan change — review it in the chat`, 'info', 3500);
      else if (!hubOpen()) toast(`${AETHER} replied — open Coach to read it`, 'success', 3500);
    }
  } catch (e) {
    toast(`Message failed: ${e.message}`, 'error');
  } finally {
    hubAiBusy = false;
    await renderHubChat();
    if (hubOpen()) scrollMasterToEnd();
    if (Router.current === 'coach' && !hubOpen()) renderCoachList();
  }
}

// Unanswered messages (app closed, phone asleep, no signal…) are answered when the
// app is opened again or the connection returns. Only the newest per chat, once per run.
const resumedIds = new Set();
async function resumePendingChats() {
  if (!navigator.onLine) return;
  const cutoff = new Date(Date.now() - 3 * 86400000).toISOString();
  const hub = (await db.master_chat.toArray()).filter(m => m.pending && m.created_at > cutoff && !resumedIds.has(`m${m.id}`)).pop();
  if (hub && !hubAiBusy) { resumedIds.add(`m${hub.id}`); executeHubMessageDispatch(hub.id); }
  const ride = (await db.threads.toArray()).filter(t => t.pending && t.created_at > cutoff && !resumedIds.has(`t${t.id}`)).pop();
  if (ride && typeof executeRideMessageDispatch === 'function' && !rideAiBusy) { resumedIds.add(`t${ride.id}`); executeRideMessageDispatch(ride.id); }
}

async function resolveProposal(id, apply) {
  const m = await db.master_chat.get(id);
  if (!m || !m.proposal || m.proposal_status) return;
  if (apply) {
    await createRestorePoint('Before applying a plan change from Aether', 'auto');
    const applied = await applyPlanChanges(m.proposal, 'aether');
    await db.master_chat.update(id, { proposal_status: 'applied', applied_at: new Date().toISOString() });
    toast(applied.length ? `Applied: ${applied.slice(0, 3).join(' · ')}${applied.length > 3 ? '…' : ''}` : 'Nothing to apply', applied.length ? 'success' : 'warn', 4000);
    haptic('success');
  } else {
    await db.master_chat.update(id, { proposal_status: 'dismissed' });
  }
  await renderHubChat();
}

async function resetMasterThread() {
  const ok = await uiConfirm(`Reset ${AETHER}?`, `This deletes the whole conversation with ${AETHER}. Your plan, targets and ride threads are not affected.`, { okText: 'Reset', danger: true });
  if (!ok) return;
  await db.master_chat.clear();
  clearAttachment('HUB');
  await renderHubChat();
  toast('Conversation reset', 'success', 1600);
}
