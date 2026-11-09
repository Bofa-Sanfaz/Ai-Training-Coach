'use strict';
// --------------------------------------------------------
// PROGRESS PHOTOS — private by default, shared with the squad only by choice
// Stored in their own IndexedDB ("RidePartnerPhotos": the main DB's schema is fixed);
// on the web app they also travel in the encrypted account backup.
//   mine   : { pid, date, pose, note, data (JPEG data URL), created_at, shared: { cid: eventId } }
//   theirs : { pid, data } — friends' shared photos, cached after the first download
// Sharing uploads a smaller copy to the squad server (PUT /photos/:pid) and announces it with
// a 'photo' event; unsharing deletes both. Compare shows two photos with a slider; the AI
// review / roast runs on this device with the person's own key (a vision model, Gemini first).
// --------------------------------------------------------
const photoDb = new Dexie('RidePartnerPhotos');
photoDb.version(1).stores({ mine: 'pid, date, pose', theirs: 'pid' });

const PHOTO_POSES = [['front', 'Front'], ['side', 'Side'], ['back', 'Back'], ['other', 'Other']];
const PHOTO_SIDE = 1280;       // kept on the phone
const PHOTO_SHARE_SIDE = 1080; // copy for the squad (server limit ≈ 500 kB)
const Photos = { tab: 'mine', draft: null, view: null, a: null, b: null, ai: '', aiBusy: false, cache: new Map() };

const photoPoseLabel = p => (PHOTO_POSES.find(x => x[0] === p) || PHOTO_POSES[3])[1];
const photoKey = (who, pid) => `${who}:${pid}`;

// The squad challenge with a friend in it (photos are shared there)
function photoSquad() {
  if (typeof Squad === 'undefined' || !Squad.cur) return null;
  const S = squadState(Squad.cur);
  if (!S || !S.ch) return null;
  const friend = S.members.find(m => m.active && m.id !== S.me);
  return { S, friend, c: squadEntry(Squad.cur) };
}

async function photoMine() {
  return (await photoDb.mine.toArray()).sort((a, b) => `${b.date}${b.created_at}`.localeCompare(`${a.date}${a.created_at}`));
}

// The friend's shared photos (from the squad log), newest first
function photoTheirs() {
  const q = photoSquad();
  if (!q) return [];
  return Array.from(q.S.folded.photos.values()).filter(p => p.author !== q.S.me && !p.pending).sort((a, b) => `${b.date}${b.seq}`.localeCompare(`${a.date}${a.seq}`));
}

// A friend's photo: from the cache, else downloaded once
async function photoTheirData(pid) {
  if (Photos.cache.has(pid)) return Photos.cache.get(pid);
  const row = await photoDb.theirs.get(pid);
  if (row) { Photos.cache.set(pid, row.data); return row.data; }
  const q = photoSquad();
  if (!q) return null;
  const res = await fetch(`${String(q.c.server).replace(/\/$/, '')}/api/c/${q.c.id}/photos/${pid}`, { headers: { Authorization: `Bearer ${q.c.token}` } });
  if (!res.ok) return null;
  const data = `data:image/jpeg;base64,${await res.text()}`;
  Photos.cache.set(pid, data);
  await photoDb.theirs.put({ pid, data });
  return data;
}

// Fill every <img data-ph="theirs:pid"> in a container
async function photoHydrate(host) {
  for (const img of (host || document).querySelectorAll('img[data-ph]')) {
    const [who, pid] = img.dataset.ph.split(':');
    if (who !== 'theirs' || img.src) continue;
    try { const d = await photoTheirData(pid); if (d) img.src = d; } catch (e) { /* offline: stays blank */ }
  }
}

async function photoWeightOn(date) {
  const h = await getWeightHistory();
  if (!h.length) return null;
  const t = parseSafeDate(date).getTime();
  const near = h.map(e => ({ e, d: Math.abs(parseSafeDate(e.date).getTime() - t) })).sort((a, b) => a.d - b.d)[0];
  return near && near.d <= 7 * 86400000 ? num(near.e.weight) : null;
}

// ---------- the Photos screen ----------
async function openPhotos(tab) {
  Photos.tab = tab || Photos.tab || 'mine';
  openPanel('photosPanel');
  await renderPhotos();
}

async function renderPhotos() {
  const mine = await photoMine();
  const theirs = photoTheirs();
  const q = photoSquad();
  const friend = q && q.friend;
  if (Photos.tab === 'theirs' && !friend) Photos.tab = 'mine';
  const last = mine[0];
  const days = last ? Math.round((Date.now() - parseSafeDate(last.date).getTime()) / 86400000) : null;
  $('#ph_sub').textContent = last ? `${mine.length} photo${mine.length === 1 ? '' : 's'} · last ${days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`}` : 'Private until you share one';
  const tabs = [['mine', 'Mine'], friend ? ['theirs', escapeHtml(friend.name)] : null, ['compare', 'Compare']].filter(Boolean);
  const seg = `<div class="segmented mb-12">${tabs.map(([k, l]) => `<button class="${Photos.tab === k ? 'active' : ''}" onclick="Photos.tab='${k}'; renderPhotos()">${l}</button>`).join('')}</div>`;
  let html = '';
  if (Photos.tab === 'compare') html = await photoCompareHtml(mine, theirs);
  else {
    const list = Photos.tab === 'mine' ? mine : theirs;
    const nudge = Photos.tab === 'mine' && days !== null && days >= 21 ? `<div class="ph-nudge">${icon('camera', 'ic-sm')}<span>${days} days since your last photo — same spot, same light, same pose makes the best comparison.</span></div>` : '';
    if (!list.length) {
      html = Photos.tab === 'mine'
        ? `<div class="empty">${icon('camera')}<div><b>Your first progress photo</b></div><div class="small mt-8">Photos stay on this phone. Share one with your squad only when you want — and compare any two with a slider and an AI review.</div><button class="btn btn-primary mt-12" onclick="photoAdd()">${icon('camera')}Take or pick a photo</button></div>`
        : `<div class="empty">${icon('camera')}<div><b>${escapeHtml(friend.name)} hasn't shared a photo yet</b></div></div>`;
    } else {
      let month = '';
      html = `${nudge}${Photos.tab === 'mine' ? `<button class="btn btn-secondary mb-12" onclick="photoAdd()">${icon('camera')}Add a photo</button>` : ''}`;
      const grid = [];
      for (const p of list) {
        const m = String(p.date).slice(0, 7);
        if (m !== month) { if (grid.length) html += `<div class="ph-grid">${grid.splice(0).join('')}</div>`; month = m; html += `<div class="month-head"><span>${escapeHtml(parseSafeDate(`${m}-01`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }))}</span></div>`; }
        const who = Photos.tab === 'mine' ? 'mine' : 'theirs';
        const shared = who === 'mine' && p.shared && Object.keys(p.shared).length;
        grid.push(`<button class="ph-tile" onclick="openPhotoView('${who}', ${squadArg(p.pid)})"><img ${who === 'mine' ? `src="${p.data}"` : `data-ph="theirs:${escapeHtml(p.pid)}"`} alt="" loading="lazy" /><span class="ph-tag">${escapeHtml(formatNiceDate(p.date, false))} · ${photoPoseLabel(p.pose)}${shared ? ' · 👥' : ''}</span></button>`);
      }
      if (grid.length) html += `<div class="ph-grid">${grid.join('')}</div>`;
    }
  }
  $('#ph_body').innerHTML = seg + html;
  photoHydrate($('#ph_body'));
  if (Photos.tab === 'compare') photoSlider();
}

// ---------- adding ----------
function photoAdd() {
  $('#ph_file').value = '';
  $('#ph_file').click();
}

async function photoPicked(ev) {
  const f = ev.target.files && ev.target.files[0];
  if (!f) return;
  try {
    const data = await squadShrinkImage(f, PHOTO_SIDE);
    Photos.draft = { pid: squadId('ph'), data, date: formatLocalDate(new Date()), pose: 'front', note: '' };
    $('#pha_img').src = data;
    $('#pha_date').value = Photos.draft.date;
    $('#pha_note').value = '';
    photoPoseSeg('front');
    const q = photoSquad();
    $('#pha_shareRow').classList.toggle('hidden', !(q && q.friend));
    $('#pha_share').checked = false;
    if (q && q.friend) $('#pha_shareTxt').textContent = `Share with ${q.friend.name}`;
    openSheet('photoAddSheet');
  } catch (e) { toast(`Could not read the photo: ${e.message}`, 'error'); }
}

function photoPoseSeg(pose) {
  if (Photos.draft) Photos.draft.pose = pose;
  $('#pha_pose').innerHTML = PHOTO_POSES.map(([k, l]) => `<button class="${k === pose ? 'active' : ''}" onclick="photoPoseSeg('${k}')">${l}</button>`).join('');
}

async function savePhoto() {
  const d = Photos.draft;
  if (!d) return;
  d.date = $('#pha_date').value || formatLocalDate(new Date());
  d.note = $('#pha_note').value.trim().slice(0, 140);
  d.created_at = new Date().toISOString();
  d.shared = {};
  await photoDb.mine.put(d);
  closeSheet('photoAddSheet');
  haptic('success');
  if ($('#pha_share').checked) await photoShare(d.pid, true);
  else toast('Photo saved — only on this phone', 'success');
  Photos.draft = null;
  Photos.tab = 'mine';
  renderPhotos();
}

// ---------- sharing ----------
async function photoShare(pid, on) {
  const p = await photoDb.mine.get(pid);
  const q = photoSquad();
  if (!p || !q || !q.c) { toast('Join a squad challenge with your friend first', 'warn'); return; }
  const shared = p.shared || {};
  try {
    if (on) {
      if (!(await uiConfirm(`Share with ${q.friend ? q.friend.name : 'your squad'}?`, 'He can see and save this photo. You can unshare it any time — it is then deleted from the squad server.', { okText: 'Share' }))) return;
      let copy = await shotScale(p.data, PHOTO_SHARE_SIDE);
      if (copy.length > 680000) copy = await shotScale(p.data, 820);
      const res = await fetch(`${String(q.c.server).replace(/\/$/, '')}/api/c/${q.c.id}/photos/${p.pid}`, { method: 'PUT', headers: { Authorization: `Bearer ${q.c.token}`, 'Content-Type': 'text/plain' }, body: copy.split(',')[1] });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `HTTP ${res.status}`); }
      const ev = squadQueue(Squad.cur, 'photo', { pid: p.pid, date: p.date, pose: p.pose, note: p.note || '' });
      shared[q.c.id] = ev.id;
      toast(`Shared with ${q.friend ? q.friend.name : 'the squad'} 👥`, 'success');
    } else {
      const evId = shared[q.c.id];
      await fetch(`${String(q.c.server).replace(/\/$/, '')}/api/c/${q.c.id}/photos/${p.pid}`, { method: 'DELETE', headers: { Authorization: `Bearer ${q.c.token}` } });
      if (evId) squadQueue(Squad.cur, 'delete', {}, evId);
      delete shared[q.c.id];
      toast('Unshared — removed from the squad', 'info');
    }
    await photoDb.mine.update(pid, { shared });
  } catch (e) { toast(`Could not ${on ? 'share' : 'unshare'}: ${e.message}`, 'error', 5000); }
}

// ---------- one photo ----------
async function openPhotoView(who, pid) {
  const q = photoSquad();
  let p, data;
  if (who === 'mine') { p = await photoDb.mine.get(pid); data = p && p.data; }
  else { p = q && q.S.folded.photos.get(pid); data = await photoTheirData(pid); }
  if (!p) return;
  Photos.view = { who, pid };
  const weight = who === 'mine' ? await photoWeightOn(p.date) : null;
  const shared = who === 'mine' && q && q.c && p.shared && p.shared[q.c.id];
  $('#phv_img').src = data || '';
  $('#phv_title').textContent = `${who === 'mine' ? '' : `${squadName(q.S, p.author)} · `}${photoPoseLabel(p.pose)} · ${formatNiceDate(p.date, false)}`;
  $('#phv_meta').textContent = [weight ? `${fmtNum(weight, 1)} kg that week` : '', p.note ? `“${p.note}”` : ''].filter(Boolean).join(' · ');
  $('#phv_actions').innerHTML = `<button class="btn btn-secondary btn-sm" onclick="photoCompareWith('${who}', ${squadArg(pid)})">${icon('columns', 'ic-sm')}Compare</button>
    ${who === 'mine' && q && q.friend ? `<button class="btn btn-secondary btn-sm" onclick="closeSheet('photoViewSheet'); photoShare(${squadArg(pid)}, ${!shared}).then(renderPhotos)">${icon('share', 'ic-sm')}${shared ? 'Unshare' : `Share with ${escapeHtml(q.friend.name)}`}</button>` : ''}
    ${who === 'mine' ? `<button class="btn btn-ghost btn-sm danger" onclick="photoDelete(${squadArg(pid)})">${icon('trash', 'ic-sm')}Delete</button>` : ''}`;
  openSheet('photoViewSheet');
}

async function photoDelete(pid) {
  const p = await photoDb.mine.get(pid);
  if (!p) return;
  if (!(await uiConfirm('Delete this photo?', `It is removed from this phone${p.shared && Object.keys(p.shared).length ? ' and from the squad' : ''}. This can't be undone.`, { okText: 'Delete', danger: true }))) return;
  if (p.shared && Object.keys(p.shared).length) await photoShare(pid, false);
  await photoDb.mine.delete(pid);
  const gone = await getJsonConfig('photos_deleted', []);
  await setJsonConfig('photos_deleted', gone.concat(pid).slice(-500)); // other devices drop it too
  closeSheet('photoViewSheet');
  if (Photos.a === photoKey('mine', pid)) Photos.a = null;
  if (Photos.b === photoKey('mine', pid)) Photos.b = null;
  toast('Photo deleted', 'info');
  renderPhotos();
}

// ---------- compare ----------
function photoCompareWith(who, pid) {
  closeSheet('photoViewSheet');
  const k = photoKey(who, pid);
  if (!Photos.a || Photos.a === k) Photos.a = k; else Photos.b = k;
  Photos.ai = '';
  Photos.tab = 'compare';
  renderPhotos();
}

async function photoResolve(k, mine, theirs) {
  if (!k) return null;
  const [who, pid] = k.split(':');
  const p = who === 'mine' ? mine.find(x => x.pid === pid) : theirs.find(x => x.pid === pid);
  if (!p) return null;
  return Object.assign({}, p, { who, key: k, data: who === 'mine' ? p.data : await photoTheirData(pid).catch(() => null) });
}

// Training between two dates (own workouts, or the friend's shared ones)
async function photoBetween(A, B) {
  const from = A.date < B.date ? A.date : B.date, to = A.date < B.date ? B.date : A.date;
  if (A.who === 'mine') {
    const ws = (await db.workouts.toArray()).filter(w => !isExcluded(w) && String(w.date).slice(0, 10) > from && String(w.date).slice(0, 10) <= to);
    return { n: ws.length, sec: ws.reduce((s, w) => s + num(w.moving_sec), 0) };
  }
  const q = photoSquad();
  const acts = q ? Array.from(q.S.folded.activities.values()).filter(a => a.author === A.author && a.date > from && a.date <= to) : [];
  return { n: acts.length, sec: acts.reduce((s, a) => s + num(a.dur_s), 0) };
}

async function photoCompareHtml(mine, theirs) {
  const pool = mine.map(p => ({ k: photoKey('mine', p.pid), p, who: 'Me' })).concat(theirs.map(p => ({ k: photoKey('theirs', p.pid), p, who: squadName(photoSquad().S, p.author) })));
  if (pool.length < 2) return `<div class="empty">${icon('columns')}<div><b>Two photos to compare</b></div><div class="small mt-8">Add another photo (same pose, same spot) and slide between then and now.</div><button class="btn btn-primary mt-12" onclick="photoAdd()">${icon('camera')}Add a photo</button></div>`;
  // Defaults: the latest photo vs the first one of the same pose (my own when I have two)
  if (!pool.some(x => x.k === Photos.a) || !pool.some(x => x.k === Photos.b) || Photos.a === Photos.b) {
    const base = mine.length >= 2 ? pool.filter(x => x.k.startsWith('mine:')) : pool; // newest first
    const latest = base[0];
    const firstSame = base.slice(1).reverse().find(x => x.p.pose === latest.p.pose);
    Photos.b = latest.k;
    Photos.a = (firstSame || base[base.length - 1]).k;
  }
  const A = await photoResolve(Photos.a, mine, theirs), B = await photoResolve(Photos.b, mine, theirs);
  if (!A || !B) return '';
  const opt = sel => pool.map(x => `<option value="${escapeHtml(x.k)}" ${x.k === sel ? 'selected' : ''}>${escapeHtml(`${x.who} · ${formatNiceDate(x.p.date, false)} · ${photoPoseLabel(x.p.pose)}`)}</option>`).join('');
  const days = Math.round(Math.abs(parseSafeDate(B.date) - parseSafeDate(A.date)) / 86400000);
  const sameOwner = A.who === B.who && (A.who === 'mine' || A.author === B.author);
  const wa = A.who === 'mine' ? await photoWeightOn(A.date) : null, wb = B.who === 'mine' ? await photoWeightOn(B.date) : null;
  const tr = sameOwner ? await photoBetween(A, B) : null;
  const facts = [
    `${days} day${days === 1 ? '' : 's'} apart`,
    wa && wb ? `weight ${wb - wa >= 0 ? '+' : ''}${fmtNum(wb - wa, 1)} kg` : '',
    tr && tr.n ? `${tr.n} workout${tr.n === 1 ? '' : 's'} · ${formatHours(tr.sec)} in between` : ''
  ].filter(Boolean);
  return `<div class="sq-form-grid">
      <div class="field"><label>Before</label><select class="input" onchange="Photos.a=this.value; Photos.ai=''; renderPhotos()">${opt(Photos.a)}</select></div>
      <div class="field"><label>After</label><select class="input" onchange="Photos.b=this.value; Photos.ai=''; renderPhotos()">${opt(Photos.b)}</select></div>
    </div>
    <div class="ph-cmp mt-8" id="ph_cmp">
      <img src="${A.data || ''}" alt="before" />
      <div class="ph-cmp-top" id="ph_cmpTop"><img src="${B.data || ''}" alt="after" /></div>
      <div class="ph-cmp-line" id="ph_cmpLine"><span>⇆</span></div>
      <span class="ph-cmp-l">${escapeHtml(formatNiceDate(A.date, false))}</span><span class="ph-cmp-r">${escapeHtml(formatNiceDate(B.date, false))}</span>
    </div>
    <input type="range" min="0" max="100" value="50" class="ph-range" id="ph_range" oninput="photoSlider(this.value)" aria-label="Slide between before and after" />
    <div class="ph-facts">${facts.map(f => `<span>${escapeHtml(f)}</span>`).join('')}</div>
    <div class="btn-row mt-12">
      <button class="btn btn-primary btn-sm" onclick="photoAi('review')" ${Photos.aiBusy ? 'disabled' : ''}>${icon('sparkle', 'ic-sm')}AI review</button>
      <button class="btn btn-secondary btn-sm" onclick="photoAi('roast')" ${Photos.aiBusy ? 'disabled' : ''}>🔥 Roast</button>
    </div>
    <div id="ph_ai" class="mt-12">${Photos.aiBusy ? typingHtml('Looking at both photos') : Photos.ai ? `<div class="card ph-ai"><div class="md">${renderMarkdown(Photos.ai)}</div>${photoSquad() && photoSquad().friend ? `<button class="btn btn-ghost btn-xs mt-8" onclick="photoAiPost()">${icon('send', 'ic-sm')}Post to the squad chat</button>` : ''}</div>` : ''}</div>`;
}

// The slider reveals "after" over "before"
function photoSlider(v) {
  const r = $('#ph_range');
  if (!r) return;
  const x = v === undefined ? r.value : v;
  const top = $('#ph_cmpTop'), line = $('#ph_cmpLine');
  if (top) top.style.clipPath = `inset(0 0 0 ${x}%)`;
  if (line) line.style.left = `${x}%`;
}

// ---------- AI review / roast (on this device, own key; vision model) ----------
async function photoAi(mode) {
  const mine = await photoMine(), theirs = photoTheirs();
  const A = await photoResolve(Photos.a, mine, theirs), B = await photoResolve(Photos.b, mine, theirs);
  if (!A || !B || !A.data || !B.data) { toast('Both photos need to be loaded first', 'warn'); return; }
  const days = Math.round(Math.abs(parseSafeDate(B.date) - parseSafeDate(A.date)) / 86400000);
  const wa = A.who === 'mine' ? await photoWeightOn(A.date) : null, wb = B.who === 'mine' ? await photoWeightOn(B.date) : null;
  const same = A.who === B.who && (A.who === 'mine' || A.author === B.author);
  const tr = same ? await photoBetween(A, B) : null;
  const ctx = [`Image 0 = ${A.date} (${A.pose})`, `Image 1 = ${B.date} (${B.pose})`, `${days} days apart`,
    wa && wb ? `weight change ${fmtNum(wb - wa, 1)} kg` : '', tr ? `training in between: ${tr.n} workouts, ${formatHours(tr.sec)}` : '',
    same ? 'Same person in both photos.' : 'Two different people (friends comparing).'].filter(Boolean).join('; ');
  const rules = 'Never comment on attractiveness, never guess body-fat percentage, health conditions or medical issues, never shame weight or body size. Only describe what is actually visible; say plainly when lighting, angle, distance or clothing make the comparison unreliable.';
  const prompt = mode === 'roast'
    ? `You are a gym buddy roasting two progress photos, affectionately. Context: ${ctx}.\nRoast the photos themselves — the pose, the mirror, the lighting, the outfit, the face being pulled, the effort (or lack of it) since last time. Funny, short, never mean about the body. ${rules}\nEnd with one genuine compliment about the progress or the consistency. At most 90 words.`
    : `You are a supportive strength and fitness coach comparing two progress photos. Context: ${ctx}.\nDescribe the visible changes honestly and kindly: posture, shoulders, arms, back, waist, legs, overall shape and definition. ${rules}\nThen give 2 tips to make the next photo comparable (same light, distance, pose, time of day) and 1 training focus for the coming weeks. Use **bold** for the key change. At most 160 words.`;
  Photos.aiBusy = true; Photos.ai = '';
  await renderPhotos();
  try {
    const imgs = [A.data, B.data];
    let text = null;
    // Vision first: Gemini when set up (free), else the normal chain (it falls back by itself)
    const g = typeof geminiProvider === 'function' ? geminiProvider() : null;
    if (g && providerReady(g)) { try { text = await requestProvider(g, prompt, imgs, { maxTokens: 2048 }); } catch (e) { console.warn('photo AI gemini', e); } }
    if (!text) text = await callAI(prompt, imgs, { maxTokens: 2048 });
    Photos.ai = text ? String(text).trim() : '';
    if (!text) toast('The AI could not look at the photos — a model that reads images is needed (Google Gemini is free).', 'warn', 6000);
  } finally {
    Photos.aiBusy = false;
    renderPhotos();
  }
}

function photoAiPost() {
  if (!Photos.ai || !photoSquad()) return;
  squadQueue(Squad.cur, 'msg', { text: `📸 Progress photo AI:\n${Photos.ai}`.slice(0, 3900) });
  toast('Posted to the squad chat', 'success');
}

// ---------- in the squad chat ----------
function photoMsgHtml(S, e) {
  const p = S.folded.photos.get(e.body && e.body.pid);
  if (!p) return '';
  const mine = e.author === S.me;
  return `<div class="sq-msg ${mine ? 'mine' : 'theirs'}">${mine ? '' : squadAvatar(S.member(e.author), 'sm')}<div class="sq-bub ph-bub" onclick="openPhotos('${mine ? 'mine' : 'theirs'}')">
    <div class="tiny muted">📸 ${escapeHtml(squadName(S, e.author))} shared a progress photo · ${escapeHtml(photoPoseLabel(p.pose))}</div>
    <img ${mine ? '' : `data-ph="theirs:${escapeHtml(p.pid)}"`} data-mine="${mine ? escapeHtml(p.pid) : ''}" alt="" />
    ${p.note ? `<div class="small">${escapeHtml(p.note)}</div>` : ''}</div></div>`;
}

async function photoHydrateChat(host) {
  for (const img of host.querySelectorAll('img[data-mine]')) {
    if (!img.dataset.mine || img.src) continue;
    const p = await photoDb.mine.get(img.dataset.mine);
    if (p) img.src = p.data;
  }
  photoHydrate(host);
}

// ---------- account backup (web app) ----------
async function photoDumpForVault() {
  return photoDb.mine.toArray();
}

// Restore: the backup's photos, plus photos only on this device (unless deleted on either)
async function photoRestoreFromVault(list, keepLocal) {
  if (!Array.isArray(list)) return false; // a backup from before photos: leave this device's photos alone
  const gone = new Set(await getJsonConfig('photos_deleted', []));
  const local = keepLocal ? await photoDb.mine.toArray() : [];
  await photoDb.mine.clear();
  const byId = new Map();
  for (const p of (Array.isArray(list) ? list : []).concat(local)) if (p && p.pid && !gone.has(p.pid) && !byId.has(p.pid)) byId.set(p.pid, p);
  if (byId.size) await photoDb.mine.bulkPut(Array.from(byId.values()));
  return local.some(p => !(list || []).some(x => x.pid === p.pid));
}
