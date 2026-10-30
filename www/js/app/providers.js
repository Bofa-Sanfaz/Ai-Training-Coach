'use strict';
// --------------------------------------------------------
// AI PROVIDERS
// One client for Google Gemini, Anthropic Claude and any OpenAI-compatible API
// (Groq, OpenRouter, Mistral, OpenAI, DeepSeek, local Ollama/LM Studio, …).
// - Per-provider key, model (loaded live from the provider), free/paid flag, prices
// - Monthly spend cap for paid providers, real token-based cost tracking
// - Streaming replies; automatic fallback (free providers first)
// - Native HTTP (no CORS) fallback on Android when a provider blocks browser calls
// --------------------------------------------------------
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const ANTHROPIC_VERSION = '2026-10-21';
// Timeouts: wait up to 75 s for the first byte, then only fail if the stream goes silent
// for 45 s (long answers keep streaming as long as text arrives). Non-streaming: 150 s.
const AI_TIMEOUT_MS = 150000;
const AI_FIRST_BYTE_MS = 75000;
const AI_IDLE_MS = 45000;

// Verified against ai.google.dev/gemini-api/docs/models (Oct 2026)
const GEMINI_MODELS = [
  ['gemini-3.8-flash', 'Gemini 3.8 Flash (recommended)'],
  ['gemini-4-argon', 'Gemini 4 Argon'],
  ['gemini-3.6-flash', 'Gemini 3.6 Flash'],
  ['gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite (fastest)'],
  ['gemini-3.1-flash-lite', 'Gemini 3.1 Flash-Lite'],
  ['gemini-2.5-flash', 'Gemini 2.5 Flash']
];
// IDs used by v2 or shut down by Google → replaced by the default automatically
const RETIRED_MODELS = ['gemini-3.7-flash', 'gemini-3.5-flash', 'gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-3-pro-preview', 'gemini-3.1-flash-lite-preview'];
const NON_CHAT_MODEL = /(tts|image|embedding|embed|live|transcribe|robotics|audio|banana|lyria|imagen|veo|aqa|research|antigravity|omni|whisper|moderation|guard|rerank|ocr)/i;

// Anthropic first-party prices, $ per 1M tokens (input, output)
const CLAUDE_PRICES = {
  'claude-fable-5-1': [10, 50], 'claude-fable-5': [10, 50], 'claude-opus-5-5': [4, 20], 'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25], 'claude-opus-4-7': [5, 25], 'claude-opus-4-6': [5, 25], 'claude-sonnet-5-5': [2, 10],
  'claude-sonnet-5': [2, 10], 'claude-sonnet-4-6': [3, 15], 'claude-haiku-5-5': [0.1, 0.5], 'claude-haiku-4-5': [1, 5]
};
// Models that support Anthropic's server-side refusal fallback ("default" routing)
const CLAUDE_FALLBACK_MODELS = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'];

const PROVIDER_PRESETS = {
  gemini: { name: 'Google Gemini', type: 'gemini', baseUrl: GEMINI_BASE, model: 'gemini-3.8-flash', paid: false, keyUrl: 'https://aistudio.google.com/apikey', note: 'Free tier with daily limits. Becomes paid only if you enable billing on the key.' },
  groq: { name: 'Groq', type: 'openai', baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', paid: false, keyUrl: 'https://console.groq.com/keys', note: 'Free tier, very fast. Daily request limits apply.' },
  openrouter: { name: 'OpenRouter', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: '', paid: false, keyUrl: 'https://openrouter.ai/keys', note: 'Many models; ":free" models cost nothing (≈50 requests/day). Paid models are priced automatically.' },
  mistral: { name: 'Mistral', type: 'openai', baseUrl: 'https://api.mistral.ai/v1', model: '', paid: false, keyUrl: 'https://console.mistral.ai/api-keys', note: 'Free mode with account limits.' },
  anthropic: { name: 'Anthropic Claude', type: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-opus-5-5', paid: true, keyUrl: 'https://console.anthropic.com/settings/keys', note: 'Paid per token. Prices filled in automatically.' },
  openai: { name: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', model: '', paid: true, keyUrl: 'https://platform.openai.com/api-keys', note: 'Paid per token — enter the model prices for spend tracking.' },
  deepseek: { name: 'DeepSeek', type: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: '', paid: true, keyUrl: 'https://platform.deepseek.com/api_keys', note: 'Low-cost paid API — enter the model prices for spend tracking.' },
  custom: { name: 'Custom (OpenAI-compatible)', type: 'openai', baseUrl: '', model: '', paid: false, keyUrl: '', note: 'Any OpenAI-compatible endpoint, e.g. a local Ollama / LM Studio server (http://<pc-ip>:11434/v1).' }
};

let AI = null; // { active, fallback, capUsd, providers: [...], agentModels: { agent: { pid, model } } }

// A friend's web app (iPhone) uses Google Gemini only: one free key, no provider choices.
// "Use another provider" then means another Gemini model; "Keep retrying" is unchanged.
const geminiOnly = () => !isNative();
const geminiProvider = () => AI && AI.providers.find(p => p.type === 'gemini');
const aiRunning = new Set(); // agents with a request in flight (one per agent; different agents may run together)

// --------------------------------------------------------
// SETTINGS
// --------------------------------------------------------
function newProvider(preset, extra = {}) {
  const p = PROVIDER_PRESETS[preset] || PROVIDER_PRESETS.custom;
  return Object.assign({
    id: `${preset}-${Date.now().toString(36)}`, preset, name: p.name, type: p.type, baseUrl: p.baseUrl,
    apiKey: '', model: p.model, models: [], paid: p.paid, priceIn: 0, priceOut: 0, enabled: true
  }, extra);
}

async function loadAiSettings() {
  let s = await getJsonConfig('ai_providers', null);
  if (!s || !Array.isArray(s.providers)) {
    // First run of v3: migrate the v2 Gemini settings
    const legacyModel = String(await getConfig('selected_gemini_model') || '').trim();
    const custom = String(await getConfig('custom_gemini_model') || '').trim();
    const model = custom || (legacyModel && !RETIRED_MODELS.includes(legacyModel) ? legacyModel : PROVIDER_PRESETS.gemini.model);
    const cached = await getJsonConfig('gemini_models_cache', null);
    s = {
      active: 'gemini', fallback: true, capUsd: 5,
      providers: [newProvider('gemini', { id: 'gemini', apiKey: String(await getConfig('gemini_api_key') || ''), model, models: Array.isArray(cached) ? cached : [] })]
    };
    await setJsonConfig('ai_providers', s);
  }
  for (const p of s.providers) if (p.type === 'gemini' && RETIRED_MODELS.includes(p.model)) p.model = PROVIDER_PRESETS.gemini.model;
  if (geminiOnly()) {
    let g = s.providers.find(p => p.type === 'gemini');
    if (!g) { g = newProvider('gemini', { id: 'gemini' }); s.providers.unshift(g); }
    s.active = g.id;
  }
  if (!s.providers.some(p => p.id === s.active)) s.active = s.providers[0] ? s.providers[0].id : '';
  if (!(s.capUsd >= 0)) s.capUsd = 5;
  if (!s.agentModels || typeof s.agentModels !== 'object') s.agentModels = {};
  AI = s;
  return s;
}

async function saveAiSettings() {
  await setJsonConfig('ai_providers', AI);
  // Keep the v2 key in sync so the Classic interface keeps working
  const g = AI.providers.find(p => p.type === 'gemini');
  if (g) {
    await setConfig('gemini_api_key', g.apiKey || '');
    if (g.model) await setConfig('selected_gemini_model', g.model);
  }
}

function providerById(id) {
  return AI && AI.providers.find(p => p.id === id);
}

function activeProvider() {
  return AI && (providerById(AI.active) || AI.providers[0]);
}

function providerReady(p) {
  return p && p.enabled && p.model && (p.apiKey || p.preset === 'custom') && p.baseUrl;
}

function providerLabel(p) {
  return `${p.name} · ${p.model || 'no model'}${p.paid ? ' · paid' : ' · free'}`;
}

const shortProviderName = p => String(p.name || '').replace(/ \(.*\)$/, '').replace(/^Google /, '').replace(/^Anthropic /, '');

// Short, readable model name: "mistral-medium-latest" → "mistral-medium", "openai/gpt-oss-120b" → "gpt-oss-120b"
function shortModelName(id) {
  return String(id || '').replace(/^models\//, '').replace(/^[^/]+\//, '').replace(/-latest$/, '').replace(/:free$/, ' (free)');
}

// --------------------------------------------------------
// PER-AGENT MODEL CHOICE
// Each coach can use its own provider + model; "Automatic" = the default provider,
// then the fallback chain (free providers first).
// --------------------------------------------------------
// strict = "only this model": no fallback; retries with growing pauses until it answers
function agentChoice(agent) {
  const c = agent && AI && AI.agentModels[agent];
  const p = c && providerById(c.pid);
  return p && providerReady(p) ? { p, model: c.model || p.model, strict: !!c.strict } : null;
}

// Provider object used for a request (model override applied, prices from the model list when known)
function withModel(p, model) {
  if (!model || model === p.model) return p;
  const q = Object.assign({}, p, { model });
  const m = (p.models || []).find(x => x.id === model);
  if (p.type === 'anthropic' && CLAUDE_PRICES[model]) [q.priceIn, q.priceOut] = CLAUDE_PRICES[model];
  else if (m && m.price) { [q.priceIn, q.priceOut] = m.price; q.paid = m.price[0] > 0 || m.price[1] > 0; }
  return q;
}

function agentModelLabel(agent) {
  const c = agentChoice(agent);
  if (c) return `${shortProviderName(c.p)} · ${shortModelName(c.model)}${c.strict ? ' · only' : ''}`;
  const p = activeProvider();
  return p && providerReady(p) ? `Auto · ${shortProviderName(p)} · ${shortModelName(p.model)}` : 'No AI provider set up';
}

// Chips with data-agent="…" show the model each coach uses; tapping opens the picker
async function refreshModelSelectors() {
  if (!AI) await loadAiSettings();
  $$('.model-chip').forEach(ch => {
    const agent = ch.dataset.agent;
    const c = agentChoice(agent);
    ch.innerHTML = `<span class="mc-dot ${c ? (c.strict ? 'strict' : 'pinned') : ''}"></span><span class="grow">${escapeHtml(agentModelLabel(agent))}</span>${icon('chevron-down', 'ic-sm')}`;
    ch.classList.toggle('pinned', !!c);
  });
}

// ---------- Picker: level 1 = providers, level 2 = that provider's models ----------
let pick = null; // { agent, pid, model, strict, all, q }

const PROVIDER_COLORS = { gemini: '#1a73e8', groq: '#f55036', openrouter: '#6566f1', mistral: '#fa520f', anthropic: '#d97757', openai: '#10a37f', deepseek: '#4d6bfe', custom: '#64748b' };
const providerBadge = p => `<span class="prov-badge" style="--pc:${PROVIDER_COLORS[p.preset] || '#64748b'}">${escapeHtml(shortProviderName(p).slice(0, 2))}</span>`;

function openModelPicker(agent) {
  const cur = AI.agentModels[agent] || null;
  pick = { agent, pid: cur ? cur.pid : null, model: cur ? cur.model : null, strict: !!(cur && cur.strict), all: false, q: '' };
  $('#modelPickTitle').textContent = `Model · ${AI_AGENTS[agent] || agent}`;
  const g = geminiProvider();
  if (geminiOnly() && g) {
    if (!pick.pid || pick.pid !== g.id) { pick.pid = g.id; pick.model = g.model; }
    renderPickModels();
  } else renderPickProviders();
  openSheet('modelPickSheet', () => { pick = null; });
}

function renderPickProviders() {
  const auto = !pick.pid;
  const def = activeProvider();
  let html = `<button class="prov-card ${auto ? 'active' : ''}" onclick="pickAutomatic()">
      <span class="prov-badge auto">${icon('repeat', 'ic-sm')}</span>
      <span class="grow"><b>Automatic</b><span class="tiny muted">${def ? `${escapeHtml(shortProviderName(def))} · ${escapeHtml(shortModelName(def.model))} first, then the others (free first)` : 'Add a provider first'}</span></span>
      ${auto ? icon('check-circle', 'ic-sm') : ''}</button>
    <div class="pick-group">Providers</div>`;
  for (const p of AI.providers) {
    const ready = providerReady(p);
    const sel = pick.pid === p.id;
    const count = (p.models || []).length;
    html += `<button class="prov-card ${sel ? 'active' : ''} ${ready ? '' : 'disabled'}" onclick="${ready ? `pickProvider('${escapeHtml(p.id)}')` : "closeSheet('modelPickSheet'); switchTab('profile')"}">
      ${providerBadge(p)}
      <span class="grow"><b>${escapeHtml(p.name)}</b><span class="tiny muted">${ready ? `${escapeHtml(sel ? shortModelName(pick.model || p.model) : shortModelName(p.model))}${count ? ` · ${count} models` : ''} · ${p.paid ? 'paid' : 'free'}` : 'needs an API key — set up in Profile'}</span></span>
      ${icon('chevron', 'ic-sm muted')}</button>`;
  }
  $('#modelPickList').innerHTML = html;
  $('#modelPickFoot').classList.add('hidden');
}

async function pickAutomatic() {
  pick.pid = null; pick.model = null; pick.strict = false;
  await applyPick(false);
}

function pickProvider(pid) {
  const p = providerById(pid);
  if (pick.pid !== pid) { pick.pid = pid; pick.model = p.model; }
  pick.q = '';
  renderPickModels();
}

function renderPickModels() {
  const p = providerById(pick.pid);
  const gem = geminiOnly();
  // Web app: the known Gemini chat models, plus any loaded from Google
  const base = gem ? GEMINI_MODELS.map(([id, label]) => ({ id, label })) : [];
  const list = (gem ? base : [{ id: p.model, label: 'Provider default' }]).concat((p.models || []).filter(m => m.id !== p.model && !base.some(b => b.id === m.id) && (!gem || /^gemini/.test(m.id))));
  const q = pick.q.toLowerCase();
  const shown = list.filter(m => !q || `${m.id} ${m.label || ''}`.toLowerCase().includes(q)).slice(0, 60);
  const priceTag = m => m.free ? '<span class="tag free">free</span>' : m.price ? `<span class="tag">$${fmtNum(m.price[0], 2)}/$${fmtNum(m.price[1], 2)}</span>` : (p.type === 'anthropic' && CLAUDE_PRICES[m.id] ? `<span class="tag">$${CLAUDE_PRICES[m.id][0]}/$${CLAUDE_PRICES[m.id][1]}</span>` : '');
  $('#modelPickList').innerHTML = `
    ${gem ? '' : `<button class="pick-back" onclick="renderPickProviders()">${icon('back', 'ic-sm')}All providers</button>`}
    <div class="prov-head">${providerBadge(p)}<div class="grow"><b>${escapeHtml(p.name)}</b><div class="tiny muted">${p.paid ? 'Paid — counts toward your spend cap' : 'Free tier'}</div></div>
      <button class="btn btn-secondary btn-xs" onclick="refreshPickModels()">${icon('refresh', 'ic-sm')}Refresh</button></div>
    ${list.length > 8 ? `<input class="input pick-search" placeholder="Search ${list.length} models…" value="${escapeHtml(pick.q)}" oninput="pick.q=this.value; renderPickModelsKeepFocus()" />` : ''}
    <div class="pick-models">${shown.map(m => `
      <button class="pick-row ${pick.model === m.id ? 'active' : ''}" onclick="pick.model='${escapeHtml(m.id)}'; renderPickModels()">
        <span class="grow"><b>${escapeHtml(shortModelName(m.id))}</b><span class="tiny muted">${escapeHtml(m.label && m.label !== m.id ? m.label : m.id)}</span></span>${priceTag(m)}${pick.model === m.id ? icon('check-circle', 'ic-sm') : ''}</button>`).join('') || '<div class="small muted">No models match.</div>'}</div>`;
  $('#modelPickFoot').classList.remove('hidden');
  $$('#pickMode button').forEach(b => b.classList.toggle('active', (b.dataset.v === 'strict') === pick.strict));
  $('#pickMode button[data-v="fallback"]').textContent = gem ? 'Use another Gemini model' : 'Use another provider';
  $('#pickModeHint').textContent = pick.strict
    ? `Only ${shortModelName(pick.model)} answers. If it is busy or rate-limited, Training Partner waits and retries (10 s, 20 s, 40 s… up to 5 min apart) until it replies — your message is kept even if you leave the app.`
    : gem ? `${shortModelName(pick.model)} answers first; if it is busy or out of free quota, another Gemini model answers instead.`
      : `${shortModelName(pick.model)} answers first; if it fails, your other providers answer instead (free first).`;
}

function renderPickModelsKeepFocus() {
  const pos = $('.pick-search') ? $('.pick-search').selectionStart : 0;
  renderPickModels();
  const s = $('.pick-search');
  if (s) { s.focus(); s.setSelectionRange(pos, pos); }
}

function setPickMode(v) {
  pick.strict = v === 'strict';
  renderPickModels();
}

async function refreshPickModels() {
  const p = providerById(pick.pid);
  try {
    toast(`Loading ${p.name} models…`, 'info', 1500);
    await testProvider(p);
    await saveAiSettings();
    renderPickModels();
  } catch (e) {
    toast(`Could not load models: ${e.message}`, 'error', 4000);
  }
}

async function applyPick(all) {
  const agents = all ? Object.keys(AI_AGENTS) : [pick.agent];
  for (const a of agents) {
    if (pick.pid) AI.agentModels[a] = { pid: pick.pid, model: pick.model, strict: pick.strict };
    else delete AI.agentModels[a];
  }
  await saveAiSettings();
  const label = agentModelLabel(pick.agent);
  closeSheet('modelPickSheet');
  await refreshModelSelectors();
  if (Router.current === 'profile' && typeof renderAgentModels === 'function') renderAgentModels();
  haptic('light');
  toast(`${all ? 'All coaches' : AI_AGENTS[agents[0]] || agents[0]}: ${label}`, 'success', 2400);
}

// Who wrote a reply, for the small label under each AI message
function aiMetaLabel(m) {
  if (!m || !m.ai_model) return '';
  return `${m.ai_provider ? `${m.ai_provider} · ` : ''}${shortModelName(m.ai_model)}${m.ai_secs ? ` · ${m.ai_secs}s` : ''}`;
}

// --------------------------------------------------------
// SPEND TRACKING
// --------------------------------------------------------
function monthKey() {
  return formatLocalDate(new Date()).slice(0, 7);
}

async function getUsage() {
  const u = await getJsonConfig('ai_usage', null);
  if (!u || u.month !== monthKey()) return { month: monthKey(), total: 0, byProvider: {} };
  return u;
}

async function recordUsage(p, tokensIn, tokensOut) {
  const u = await getUsage();
  const cost = p.paid ? (tokensIn * num(p.priceIn) + tokensOut * num(p.priceOut)) / 1e6 : 0;
  const e = u.byProvider[p.id] || { name: p.name, in: 0, out: 0, cost: 0, calls: 0 };
  e.name = p.name; e.in += tokensIn; e.out += tokensOut; e.cost += cost; e.calls++;
  u.byProvider[p.id] = e;
  u.total += cost;
  await setJsonConfig('ai_usage', u);
  if (p.paid && AI.capUsd > 0 && u.total >= AI.capUsd * 0.8 && u.total - cost < AI.capUsd * 0.8) {
    toast(`AI spend this month: $${u.total.toFixed(2)} of your $${AI.capUsd.toFixed(2)} cap.`, 'warn', 5000);
  }
  return cost;
}

async function capReached() {
  if (!(AI.capUsd > 0)) return false;
  return (await getUsage()).total >= AI.capUsd;
}

// --------------------------------------------------------
// HTTP (fetch with streaming; native HTTP fallback for CORS-blocked providers)
// --------------------------------------------------------
async function nativeRequest(url, method, headers, body) {
  const H = capPlugin('CapacitorHttp');
  if (!H) throw new Error('Network request blocked (CORS) and native HTTP is not available.');
  const res = await H.request({ url, method, headers, data: body ? JSON.parse(body) : undefined, connectTimeout: AI_TIMEOUT_MS, readTimeout: AI_TIMEOUT_MS });
  const data = typeof res.data === 'string' ? (() => { try { return JSON.parse(res.data); } catch (e) { return { raw: res.data }; } })() : res.data;
  return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => data, body: null, native: true };
}

async function httpRequest(url, { method = 'GET', headers = {}, body, signal } = {}) {
  try {
    return await fetch(url, { method, headers, body, signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    if (isNative()) return nativeRequest(url, method, headers, body); // likely CORS
    throw e;
  }
}

async function readSse(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const handle = line => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    try { onEvent(JSON.parse(payload)); } catch (e) {}
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      handle(buf.slice(0, nl).trim());
      buf = buf.slice(nl + 1);
    }
  }
  if (buf.trim()) handle(buf.trim());
}

const estTokens = s => Math.ceil(String(s || '').length / 4);

// --------------------------------------------------------
// PER-TYPE REQUEST BUILDERS
// Each returns { url, headers, body, parse(json), onEvent(evt, acc) }
// --------------------------------------------------------
function buildRequest(p, prompt, imageB64, opts, stream) {
  // One image (data URL / base64) or several (array) — e.g. all screens of one workout
  const imgs = (Array.isArray(imageB64) ? imageB64 : imageB64 ? [imageB64] : []).map(x => (x.includes(',') ? x.split(',')[1] : x));
  const img = imgs[0] || null;

  if (p.type === 'gemini') {
    const parts = [{ text: prompt }];
    for (const im of imgs) parts.push({ inlineData: { mimeType: 'image/jpeg', data: im } });
    const generationConfig = { maxOutputTokens: opts.maxTokens || 8192 };
    if (opts.json) generationConfig.responseMimeType = 'application/json';
    const textOf = d => {
      const ps = d && d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts;
      return Array.isArray(ps) ? ps.filter(x => !x.thought).map(x => x.text || '').join('') : '';
    };
    const meta = (d, acc) => {
      const c = d.candidates && d.candidates[0];
      if (c && c.finishReason) acc.finish = c.finishReason;
      if (d.promptFeedback && d.promptFeedback.blockReason) acc.block = d.promptFeedback.blockReason;
      if (d.usageMetadata) { acc.in = num(d.usageMetadata.promptTokenCount); acc.out = num(d.usageMetadata.candidatesTokenCount) + num(d.usageMetadata.thoughtsTokenCount); }
    };
    return {
      url: `${p.baseUrl.replace(/\/$/, '')}/models/${encodeURIComponent(p.model)}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': p.apiKey },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig }),
      parse: (d, acc) => { acc.text = textOf(d); meta(d, acc); },
      onEvent: (d, acc) => { acc.text += textOf(d); meta(d, acc); },
      truncated: acc => acc.finish === 'MAX_TOKENS'
    };
  }

  if (p.type === 'anthropic') {
    const content = [];
    for (const im of imgs) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: im } });
    content.push({ type: 'text', text: opts.json ? `${prompt}\n\nReply with JSON only.` : prompt });
    const req = { model: p.model, max_tokens: stream ? 32000 : 16000, messages: [{ role: 'user', content }] };
    if (stream) req.stream = true;
    const headers = {
      'Content-Type': 'application/json', 'x-api-key': p.apiKey, 'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true'
    };
    if (CLAUDE_FALLBACK_MODELS.includes(p.model)) {
      headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
      req.fallbacks = 'default';
    }
    return {
      url: `${p.baseUrl.replace(/\/$/, '')}/messages`,
      headers,
      body: JSON.stringify(req),
      parse: (d, acc) => {
        acc.text = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
        acc.finish = d.stop_reason;
        if (d.usage) { acc.in = num(d.usage.input_tokens) + num(d.usage.cache_read_input_tokens); acc.out = num(d.usage.output_tokens); }
      },
      onEvent: (e, acc) => {
        if (e.type === 'message_start' && e.message && e.message.usage) acc.in = num(e.message.usage.input_tokens);
        if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') acc.text += e.delta.text;
        if (e.type === 'message_delta') {
          if (e.delta && e.delta.stop_reason) acc.finish = e.delta.stop_reason;
          if (e.usage) acc.out = num(e.usage.output_tokens);
        }
        if (e.type === 'error') acc.error = (e.error && e.error.message) || 'stream error';
      },
      truncated: acc => acc.finish === 'max_tokens'
    };
  }

  // OpenAI-compatible chat completions
  const official = /api\.openai\.com/.test(p.baseUrl);
  const msg = img
    ? { role: 'user', content: [{ type: 'text', text: prompt }].concat(imgs.map(im => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${im}` } }))) }
    : { role: 'user', content: opts.json ? `${prompt}\n\nReply with JSON only.` : prompt };
  const req = { model: p.model, messages: [msg] };
  req[official ? 'max_completion_tokens' : 'max_tokens'] = opts.maxTokens || 8192;
  if (opts.json) req.response_format = { type: 'json_object' };
  if (stream) {
    req.stream = true;
    // Only hosts known to accept it — strict servers (e.g. Mistral, older local servers) reject unknown fields
    if (/api\.openai\.com|api\.groq\.com|openrouter\.ai|api\.deepseek\.com/.test(p.baseUrl)) req.stream_options = { include_usage: true };
  }
  const headers = { 'Content-Type': 'application/json' };
  if (p.apiKey) headers.Authorization = `Bearer ${p.apiKey}`;
  if (/openrouter\.ai/.test(p.baseUrl)) { headers['HTTP-Referer'] = 'https://ridepartner.app'; headers['X-Title'] = 'Training Partner'; }
  return {
    url: `${p.baseUrl.replace(/\/$/, '')}/chat/completions`,
    headers,
    body: JSON.stringify(req),
    parse: (d, acc) => {
      const c = d.choices && d.choices[0];
      acc.text = (c && c.message && c.message.content) || '';
      acc.finish = c && c.finish_reason;
      if (d.usage) { acc.in = num(d.usage.prompt_tokens); acc.out = num(d.usage.completion_tokens); }
    },
    onEvent: (d, acc) => {
      const c = d.choices && d.choices[0];
      if (c && c.delta && c.delta.content) acc.text += c.delta.content;
      if (c && c.finish_reason) acc.finish = c.finish_reason;
      if (d.usage) { acc.in = num(d.usage.prompt_tokens); acc.out = num(d.usage.completion_tokens); }
      if (d.error) acc.error = d.error.message || 'stream error';
    },
    truncated: acc => acc.finish === 'length'
  };
}

// One attempt against one provider. Returns { text } or throws { status, msg }.
async function requestProvider(p, prompt, imageB64, opts) {
  const wantStream = !!opts.onDelta && typeof TextDecoder !== 'undefined' && typeof ReadableStream !== 'undefined';
  const r = buildRequest(p, prompt, imageB64, opts, wantStream);
  const controller = new AbortController();
  let timer = null;
  let timedOutAfter = 0;
  const arm = ms => { clearTimeout(timer); timer = setTimeout(() => { timedOutAfter = ms; controller.abort(); }, ms); };
  arm(wantStream ? AI_FIRST_BYTE_MS : AI_TIMEOUT_MS);
  const acc = { text: '', in: 0, out: 0, finish: null, block: null, error: null };
  try {
    let res = await httpRequest(r.url, { method: 'POST', headers: r.headers, body: r.body, signal: controller.signal });
    if (res.ok && wantStream && !res.native && res.body && res.body.getReader) {
      arm(AI_IDLE_MS);
      await readSse(res, evt => { arm(AI_IDLE_MS); r.onEvent(evt, acc); if (acc.text) opts.onDelta(acc.text); });
    } else if (res.ok && res.native && wantStream) {
      // Native HTTP (CORS fallback) can't stream: repeat the request in non-streaming form
      const r2 = buildRequest(p, prompt, imageB64, opts, false);
      res = await nativeRequest(r2.url, 'POST', r2.headers, r2.body);
      if (!res.ok) throw { status: res.status, msg: '' };
      r2.parse(await res.json(), acc);
      if (acc.text) opts.onDelta(acc.text);
    } else if (res.ok) {
      r.parse(await res.json(), acc);
      if (opts.onDelta && acc.text) opts.onDelta(acc.text);
    } else {
      const err = await res.json().catch(() => ({}));
      const msg = (err.error && (err.error.message || err.error)) || err.message || err.raw || '';
      throw { status: res.status, msg: String(msg).slice(0, 220) };
    }
  } catch (e) {
    if (e && e.status !== undefined) throw e;
    if (e && e.name === 'AbortError') throw { status: 'timeout', msg: timedOutAfter === AI_IDLE_MS ? `stopped responding for ${AI_IDLE_MS / 1000}s` : `no response within ${Math.round((timedOutAfter || AI_TIMEOUT_MS) / 1000)}s` };
    throw { status: 'network', msg: (e && e.message) || 'network error' };
  } finally {
    clearTimeout(timer);
  }
  if (acc.error) throw { status: 'stream', msg: acc.error };
  const text = acc.text.trim();
  if (!text) throw { status: 'empty', msg: acc.finish === 'refusal' ? 'the model declined this request' : `empty reply (${acc.block || acc.finish || 'no content'})` };
  if (r.truncated(acc)) toast('Reply hit the length limit and may be cut off.', 'warn');
  await recordUsage(p, acc.in || estTokens(prompt), acc.out || estTokens(text));
  return text;
}

// --------------------------------------------------------
// PUBLIC: callAI(prompt, imageB64, { onDelta, json, maxTokens, agent, meta })
// agent: which coach is asking (uses its own model choice); meta: an object that
// receives { provider, model, secs } of the model that actually answered.
// Returns the reply text, or null after showing a clear error toast.
// --------------------------------------------------------
async function callAI(prompt, imageB64 = null, opts = {}) {
  if (!navigator.onLine) { toast('Connect to the internet to use the AI coach.', 'warn'); return null; }
  if (!AI) await loadAiSettings();
  const lane = opts.agent || 'default';
  if (aiRunning.has(lane)) { toast('This coach is still answering — please wait.', 'warn'); return null; }

  const pinnedRaw = agentChoice(opts.agent);
  const pinned = pinnedRaw && geminiOnly() && pinnedRaw.p.type !== 'gemini' ? null : pinnedRaw;
  const primary = pinned ? withModel(pinned.p, pinned.model) : geminiOnly() ? geminiProvider() : activeProvider();
  let others;
  if (geminiOnly()) {
    // Fallback = the other Gemini models (lighter ones have more free quota)
    const g = geminiProvider();
    others = AI.fallback && g ? GEMINI_MODELS.map(m => m[0]).filter(id => id !== (primary && primary.model)).map(id => withModel(g, id)) : [];
  } else {
    others = AI.fallback ? AI.providers.filter(p => p.id !== (primary && primary.id) && providerReady(p)).sort((a, b) => Number(a.paid) - Number(b.paid)) : [];
    if (pinned && AI.fallback && providerReady(activeProvider()) && activeProvider().id !== pinned.p.id) others.unshift(...others.splice(others.indexOf(activeProvider()), 1));
  }
  const chain = (providerReady(primary) ? [primary] : []).concat(others);
  if (!chain.length) {
    toast('Set up an AI provider first: Profile → AI providers (Gemini, Groq and OpenRouter have free tiers).', 'warn', 6000);
    return null;
  }

  aiRunning.add(lane);
  const failures = [];
  try {
    if (pinned && pinned.strict) return await callStrict(primary, prompt, imageB64, opts);
    const capHit = await capReached();
    for (const p of chain) {
      if (p.paid && capHit) { failures.push(`${p.name}: monthly spend cap reached`); continue; }
      if (p.paid && !(num(p.priceIn) > 0 || num(p.priceOut) > 0)) {
        failures.push(`${p.name}: set its prices in Profile so spending can be tracked`);
        continue;
      }
      const t0 = Date.now();
      try {
        const text = await requestProvider(p, prompt, imageB64, opts);
        if (opts.meta) Object.assign(opts.meta, { provider: shortProviderName(p), model: p.model, secs: Math.round((Date.now() - t0) / 1000) });
        if (p !== primary) toast(geminiOnly() ? `${shortModelName(primary.model)} busy — answered by ${shortModelName(p.model)}.` : `${primary ? primary.name : 'Primary provider'} unavailable — answered by ${p.name} (${shortModelName(p.model)}).`, 'info', 3500);
        return text;
      } catch (err) {
        failures.push(`${p.name}: ${describeAiError(err)}`);
        if (err.status === 400 || err.status === 401 || err.status === 403 || err.status === 'empty') {
          if (!AI.fallback) break;
        }
      }
    }
    toast(`AI request failed.\n${failures.slice(0, 3).join('\n')}`, 'error', 8000);
    return null;
  } finally {
    aiRunning.delete(lane);
  }
}

// "Keep retrying this one": a single model, retried with growing pauses (10 s → 5 min)
// for up to ~2 hours. Waits for the network to come back instead of failing. Errors that
// retrying can't fix (bad key, unknown model, bad request) stop at once.
const STRICT_DELAYS = [10, 20, 40, 60, 120, 180, 300];
const STRICT_MAX_MS = 2 * 3600 * 1000;

async function callStrict(p, prompt, imageB64, opts) {
  const status = opts.onStatus || (() => {});
  const t0 = Date.now();
  for (let attempt = 1; ; attempt++) {
    if (!navigator.onLine) {
      status('waiting for a connection…');
      await new Promise(r => { const on = () => { window.removeEventListener('online', on); r(); }; window.addEventListener('online', on); setTimeout(on, 60000); });
      continue;
    }
    if (p.paid && await capReached()) { toast(`${p.name}: monthly spend cap reached.`, 'error', 6000); return null; }
    const ta = Date.now();
    try {
      status(attempt > 1 ? `attempt ${attempt}…` : '');
      const text = await requestProvider(p, prompt, imageB64, opts);
      if (opts.meta) Object.assign(opts.meta, { provider: shortProviderName(p), model: p.model, secs: Math.round((Date.now() - ta) / 1000) });
      status('');
      return text;
    } catch (err) {
      const fatal = [400, 401, 403, 404].includes(err.status);
      if (fatal || Date.now() - t0 > STRICT_MAX_MS) {
        toast(`${p.name} (${shortModelName(p.model)}): ${describeAiError(err)}${fatal ? '' : ' — gave up after 2 hours'}`, 'error', 8000);
        return null;
      }
      const wait = STRICT_DELAYS[Math.min(attempt - 1, STRICT_DELAYS.length - 1)];
      for (let s = wait; s > 0; s--) {
        status(`${shortModelName(p.model)}: ${describeAiError(err).slice(0, 60)} — retrying in ${s} s (attempt ${attempt + 1})`);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }
}

// Fields stored with every AI message so the app can show who wrote it
function aiMetaFields(meta) {
  return meta && meta.model ? { ai_provider: meta.provider, ai_model: meta.model, ai_secs: meta.secs } : {};
}

function describeAiError(err) {
  const s = err.status;
  if (s === 401 || s === 403) return `key rejected (${s})${err.msg ? ` — ${err.msg}` : ''}`;
  if (s === 404) return `model not found${err.msg ? ` — ${err.msg}` : ''}`;
  if (s === 429) return `rate limit / quota reached${err.msg ? ` — ${err.msg.slice(0, 90)}` : ''}`;
  if (s === 402) return 'out of credit';
  if (typeof s === 'number' && s >= 500) return `service busy (${s})`;
  return err.msg || String(s);
}

// --------------------------------------------------------
// MODEL DISCOVERY & KEY TEST
// --------------------------------------------------------
async function listProviderModels(p) {
  const base = p.baseUrl.replace(/\/$/, '');
  if (p.type === 'gemini') {
    const out = [];
    let token = '';
    for (let page = 0; page < 5; page++) {
      const res = await httpRequest(`${base}/models?pageSize=200${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`, { headers: { 'x-goog-api-key': p.apiKey } });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((d.error && d.error.message) || `HTTP ${res.status}`);
      for (const m of d.models || []) {
        const id = String(m.name || '').replace(/^models\//, '');
        if (!id.startsWith('gemini') || NON_CHAT_MODEL.test(id) || !(m.supportedGenerationMethods || []).includes('generateContent')) continue;
        out.push({ id, label: m.displayName || id });
      }
      token = d.nextPageToken;
      if (!token) break;
    }
    const rank = id => { const i = GEMINI_MODELS.findIndex(x => x[0] === id); return i < 0 ? 99 : i; };
    return out.sort((a, b) => rank(a.id) - rank(b.id) || (a.id < b.id ? 1 : -1));
  }
  if (p.type === 'anthropic') {
    const res = await httpRequest(`${base}/models?limit=100`, { headers: { 'x-api-key': p.apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'anthropic-dangerous-direct-browser-access': 'true' } });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((d.error && d.error.message) || `HTTP ${res.status}`);
    return (d.data || []).map(m => ({ id: m.id, label: m.display_name || m.id, price: CLAUDE_PRICES[m.id] || null }));
  }
  const headers = p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {};
  const res = await httpRequest(`${base}/models`, { headers });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((d.error && (d.error.message || d.error)) || `HTTP ${res.status}`);
  const list = (d.data || d.models || []).filter(m => m && m.id && !NON_CHAT_MODEL.test(m.id));
  return list.map(m => {
    const pr = m.pricing && (m.pricing.prompt !== undefined) ? [num(m.pricing.prompt) * 1e6, num(m.pricing.completion) * 1e6] : null;
    const free = /:free$/.test(m.id) || (pr && pr[0] === 0 && pr[1] === 0);
    return { id: m.id, label: `${m.name || m.id}${free ? ' — free' : ''}`, price: pr, free };
  }).sort((a, b) => Number(!!b.free) - Number(!!a.free) || (a.id < b.id ? -1 : 1));
}

// Applies price info that comes with a model (Claude table, OpenRouter pricing)
function applyModelPrice(p, modelId) {
  if (p.type === 'anthropic' && CLAUDE_PRICES[modelId]) {
    [p.priceIn, p.priceOut] = CLAUDE_PRICES[modelId];
    p.paid = true;
    return;
  }
  const m = (p.models || []).find(x => x.id === modelId);
  if (m && m.price) {
    [p.priceIn, p.priceOut] = m.price;
    p.paid = m.price[0] > 0 || m.price[1] > 0;
  }
}

async function testProvider(p) {
  const models = await listProviderModels(p);
  p.models = models.slice(0, 300);
  if (!p.model && models.length) p.model = models[0].id;
  if (p.model) applyModelPrice(p, p.model);
  return models.length;
}

// Back-compat name used throughout the views
const callGemini = callAI;
