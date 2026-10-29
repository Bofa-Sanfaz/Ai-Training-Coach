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
const AI_TIMEOUT_MS = 120000;

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

let isRequestInProgress = false;
let AI = null; // { active, fallback, capUsd, providers: [...] }

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
  if (!s.providers.some(p => p.id === s.active)) s.active = s.providers[0] ? s.providers[0].id : '';
  if (!(s.capUsd >= 0)) s.capUsd = 5;
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

// The compact selectors shown next to every AI button switch the active provider
async function refreshModelSelectors() {
  if (!AI) await loadAiSettings();
  const ready = AI.providers.filter(p => p.enabled);
  const html = ready.length
    ? ready.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(`${p.name.replace(/ \(.*\)$/, '')} · ${p.model || '—'}`)}</option>`).join('')
    : '<option value="">No AI provider — add one in Profile</option>';
  $$('.model-select').forEach(sel => { sel.innerHTML = html; sel.value = AI.active; });
}

async function syncModelSelection(providerId) {
  if (!providerId || !providerById(providerId)) return;
  AI.active = providerId;
  await saveAiSettings();
  $$('.model-select').forEach(sel => { sel.value = providerId; });
  const p = activeProvider();
  if (p && !providerReady(p)) toast(`${p.name} needs an API key and model — open Profile → AI providers.`, 'warn', 4500);
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
  const img = imageB64 ? (imageB64.includes(',') ? imageB64.split(',')[1] : imageB64) : null;

  if (p.type === 'gemini') {
    const parts = [{ text: prompt }];
    if (img) parts.push({ inlineData: { mimeType: 'image/jpeg', data: img } });
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
    if (img) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img } });
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
    ? { role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${img}` } }] }
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
  if (/openrouter\.ai/.test(p.baseUrl)) { headers['HTTP-Referer'] = 'https://ridepartner.app'; headers['X-Title'] = 'Ride Partner'; }
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
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  const acc = { text: '', in: 0, out: 0, finish: null, block: null, error: null };
  try {
    let res = await httpRequest(r.url, { method: 'POST', headers: r.headers, body: r.body, signal: controller.signal });
    if (res.ok && wantStream && !res.native && res.body && res.body.getReader) {
      await readSse(res, evt => { r.onEvent(evt, acc); if (acc.text) opts.onDelta(acc.text); });
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
    if (e && e.name === 'AbortError') throw { status: 'timeout', msg: `timed out after ${AI_TIMEOUT_MS / 1000}s` };
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
// PUBLIC: callAI(prompt, imageB64, { onDelta, json, maxTokens })
// Returns the reply text, or null after showing a clear error toast.
// --------------------------------------------------------
async function callAI(prompt, imageB64 = null, opts = {}) {
  if (isRequestInProgress) { toast('An AI request is already running — please wait.', 'warn'); return null; }
  if (!navigator.onLine) { toast('Connect to the internet to use the AI coach.', 'warn'); return null; }
  if (!AI) await loadAiSettings();

  const primary = activeProvider();
  const others = AI.fallback ? AI.providers.filter(p => p !== primary && providerReady(p)).sort((a, b) => Number(a.paid) - Number(b.paid)) : [];
  const chain = (providerReady(primary) ? [primary] : []).concat(others);
  if (!chain.length) {
    toast('Set up an AI provider first: Profile → AI providers (Gemini, Groq and OpenRouter have free tiers).', 'warn', 6000);
    return null;
  }

  isRequestInProgress = true;
  const failures = [];
  try {
    const capHit = await capReached();
    for (const p of chain) {
      if (p.paid && capHit) { failures.push(`${p.name}: monthly spend cap reached`); continue; }
      if (p.paid && !(num(p.priceIn) > 0 || num(p.priceOut) > 0)) {
        failures.push(`${p.name}: set its prices in Profile so spending can be tracked`);
        continue;
      }
      try {
        const text = await requestProvider(p, prompt, imageB64, opts);
        if (p !== primary) toast(`${primary ? primary.name : 'Primary provider'} unavailable — answered by ${p.name}.`, 'info', 3500);
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
    isRequestInProgress = false;
  }
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
