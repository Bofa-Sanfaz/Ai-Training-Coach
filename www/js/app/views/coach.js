'use strict';
// --------------------------------------------------------
// COACH HUB: training plan, Aether (season coach) and ride conversations
// (ride threads open inside the ride detail so data and chat sit together)
// --------------------------------------------------------
const AETHER = 'Aether';
let lastPendingHubPayload = null;
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
  $('#masterSub').textContent = `Season coach · knows all ${count} rides, your plan and targets`;
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

async function renderHubChat(extra = '') {
  const msgs = await db.master_chat.toArray();
  let html;
  if (!msgs.length) {
    const wt = await getLatestWeight();
    html = `<div class="bubble bubble-coach"><div class="bubble-sender"><span>${AETHER}</span></div>
      Hi ${escapeHtml(ATHLETE.name)}, I'm ${AETHER}. I keep your whole season in view${wt ? ` (${wt} kg, ${escapeHtml(ATHLETE.bike)})` : ''} — rides, load, your weekly plan and targets.
      <br><br>Ask me anything, paste your own training plan and I'll set it up, or tell me when life changes ("I can only ride twice this week") and I'll adjust the plan and targets for you to approve.</div>`;
  } else {
    html = msgs.map(m => bubbleHtml(m, AETHER) + (m.proposal ? proposalCardHtml(m) : '')).join('');
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

// Quick prompts under the composer
function aetherQuick(text) {
  $('#hubReplyInput').value = text;
  autoGrow($('#hubReplyInput'));
  sendHubReply();
}

async function executeHubMessageDispatch(payload) {
  hubAiBusy = true;
  await renderHubChat(typingHtml(`${AETHER} is reviewing your season`));
  scrollMasterToEnd();
  try {
    const live = liveBubble($('#hubChatContainer'), AETHER, scrollMasterToEnd);
    const reply = await callAI(await buildMasterPrompt(payload.text, !!payload.image_b64), payload.image_b64, { onDelta: t => live(hidePlanUpdate(t)) });
    if (reply) {
      haptic('success');
      const { text, proposal } = extractPlanUpdate(reply);
      await db.master_chat.add({ role: 'athlete', message: payload.text, image_b64: payload.image_b64, created_at: new Date().toISOString() });
      await db.master_chat.add({ role: 'coach', message: text || 'Here is the change I propose:', proposal: proposal || undefined, created_at: new Date().toISOString() });
      lastPendingHubPayload = null;
      if (proposal) toast(`${AETHER} proposed a plan change — review it below`, 'info', 3500);
    }
  } catch (e) {
    toast(`Message failed: ${e.message}`, 'error');
  } finally {
    hubAiBusy = false;
    await renderHubChat();
    scrollMasterToEnd();
  }
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
  lastPendingHubPayload = null;
  clearAttachment('HUB');
  await renderHubChat();
  toast('Conversation reset', 'success', 1600);
}
