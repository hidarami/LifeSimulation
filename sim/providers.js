// providers.js — Universal API provider abstraction for The Sim
// Supports: Grok/xAI, OpenAI, Anthropic, OpenRouter, Groq, Google Gemini
'use strict';

// ─── PROVIDER CONFIGURATIONS ──────────────────────────────────────────────────
export const PROVIDER_ENDPOINTS = {
  grok: {
    chat:                   'https://api.x.ai/v1/chat/completions',
    default_narrator_model: 'grok-4.20-non-reasoning',
    default_helper_model:   'grok-4.20-non-reasoning',
    format:                 'openai',
    auth: k => ({ 'Authorization': `Bearer ${k}` }),
  },
  openai: {
    chat:                   'https://api.openai.com/v1/chat/completions',
    default_narrator_model: 'gpt-4o',
    default_helper_model:   'gpt-4o-mini',
    format:                 'openai',
    auth: k => ({ 'Authorization': `Bearer ${k}` }),
  },
  anthropic: {
    chat:                   'https://api.anthropic.com/v1/messages',
    default_narrator_model: 'claude-sonnet-4-6',
    default_helper_model:   'claude-haiku-4-5-20251001',
    format:                 'anthropic',
    auth: k => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01' }),
  },
  openrouter: {
    chat:                   'https://openrouter.ai/api/v1/chat/completions',
    default_narrator_model: 'nousresearch/hermes-3-llama-3.1-405b:free',
    default_helper_model:   'meta-llama/llama-3.1-8b-instruct:free',
    format:                 'openai',
    auth: k => ({ 'Authorization': `Bearer ${k}` }),
  },
  groq: {
    chat:                   'https://api.groq.com/openai/v1/chat/completions',
    default_narrator_model: 'llama-3.3-70b-versatile',
    default_helper_model:   'llama-3.1-8b-instant',
    format:                 'openai',
    auth: k => ({ 'Authorization': `Bearer ${k}` }),
  },
  gemini: {
    chat:                   null, // special URL construction
    default_narrator_model: 'gemini-2.0-flash',
    default_helper_model:   'gemini-2.0-flash',
    format:                 'gemini',
    auth:                   null,
  },
  custom: {
    chat:                   null, // resolved from CUSTOM_BASE_URL at dispatch time
    default_narrator_model: 'gpt-4o',
    default_helper_model:   'gpt-4o-mini',
    format:                 'openai',
    auth: k => ({ 'Authorization': `Bearer ${k}` }),
  },
};

// Base URL for a user-supplied OpenAI-compatible endpoint (localStorage CUSTOM_BASE_URL).
// e.g. 'https://my-host/v1' — dispatch appends '/chat/completions', discovery appends '/models'.
export function getCustomBaseUrl(baseUrl) {
  const raw = (baseUrl || (typeof localStorage !== 'undefined' ? localStorage.getItem('CUSTOM_BASE_URL') : '') || '').trim();
  return raw.replace(/\/+$/, '');
}

// ─── AUTO-DETECT PROVIDER FROM KEY PREFIX ─────────────────────────────────────
export function detectProvider(key) {
  if (!key || typeof key !== 'string') return null;
  const k = key.trim();
  if (k.startsWith('xai-'))    return 'grok';
  if (k.startsWith('AIza'))    return 'gemini';
  if (k.startsWith('sk-or-'))  return 'openrouter';
  if (k.startsWith('gsk_'))    return 'groq';
  if (k.startsWith('sk-ant-')) return 'anthropic';
  if (k.startsWith('sk-'))     return 'openai';
  return null; // unknown prefix — let the UI prompt for a provider (or Custom)
}

export function getProviderDisplayName(provider) {
  const MAP = { grok:'Grok/xAI', openai:'OpenAI', anthropic:'Anthropic', openrouter:'OpenRouter', groq:'Groq', gemini:'Google Gemini', custom:'Custom (OpenAI-compatible)' };
  return MAP[provider] ?? provider ?? 'Unknown';
}

// ─── SLOT CONFIGURATION ───────────────────────────────────────────────────────
// Narrator slot: creative prose generation
export function getNarratorSlot() {
  const key      = localStorage.getItem('NARRATOR_KEY')?.trim()      || localStorage.getItem('GROK_API_KEY')?.trim()   || null;
  const provider = localStorage.getItem('NARRATOR_PROVIDER')?.trim() || (key ? detectProvider(key) : null);
  const model    = localStorage.getItem('NARRATOR_MODEL')?.trim()    || null;
  return { key, provider, model };
}

// Classifier slot: JSON structured tasks
export function getClassifierSlot() {
  const key      = localStorage.getItem('CLASSIFIER_KEY')?.trim()      || localStorage.getItem('GEMINI_API_KEY')?.trim() || null;
  const provider = localStorage.getItem('CLASSIFIER_PROVIDER')?.trim() || (key ? detectProvider(key) : null);
  const model    = localStorage.getItem('CLASSIFIER_MODEL')?.trim()    || null;
  return { key, provider, model };
}

// Helper slot: cheapest available for background tasks
export function getHelperSlot() {
  const groqKey = localStorage.getItem('GROQ_API_KEY')?.trim();
  if (groqKey) return { key: groqKey, provider: 'groq', model: 'llama-3.1-8b-instant' };
  const cls = getClassifierSlot();
  if (cls.key && cls.provider) {
    const cfg = PROVIDER_ENDPOINTS[cls.provider];
    return { key: cls.key, provider: cls.provider, model: cls.model || cfg?.default_helper_model || null };
  }
  const nar = getNarratorSlot();
  if (nar.key && nar.provider) {
    const cfg = PROVIDER_ENDPOINTS[nar.provider];
    return { key: nar.key, provider: nar.provider, model: cfg?.default_helper_model || null };
  }
  return { key: null, provider: null, model: null };
}

// Content mode: 'filtered' suppresses explicit routing to PATH_1
export function isExplicitModeEnabled() {
  return localStorage.getItem('CONTENT_MODE') !== 'filtered';
}

// Ordered fallback list for narrator (used when primary refuses or fails)
export function getNarratorFallbacks() {
  const list = [];
  const orKey = localStorage.getItem('OPENROUTER_API_KEY')?.trim();
  if (orKey) {
    list.push({ key: orKey, provider: 'openrouter', model: 'nousresearch/hermes-3-llama-3.1-405b:free' });
    list.push({ key: orKey, provider: 'openrouter', model: 'mistralai/mistral-7b-instruct:free' });
    list.push({ key: orKey, provider: 'openrouter', model: 'openchat/openchat-7b:free' });
    list.push({ key: orKey, provider: 'openrouter', model: 'meta-llama/llama-3.1-8b-instruct:free' });
  }
  const groqKey = localStorage.getItem('GROQ_API_KEY')?.trim();
  if (groqKey) list.push({ key: groqKey, provider: 'groq', model: 'llama-3.3-70b-versatile' });
  return list;
}

// ─── ENRICHER SLOT ────────────────────────────────────────────────────────────
// Dedicated to world-building (enrichWorldDetails) — slower, smarter, independent of classifier
export function getEnricherSlot() {
  const key      = localStorage.getItem('ENRICHER_KEY')?.trim()      || null;
  const provider = localStorage.getItem('ENRICHER_PROVIDER')?.trim() || (key ? detectProvider(key) : null);
  const model    = localStorage.getItem('ENRICHER_MODEL')?.trim()    || null;
  if (key && provider) return { key, provider, model };
  return getClassifierSlot(); // fall through to classifier
}

// ─── CONFIGURABLE FALLBACK SLOTS ──────────────────────────────────────────────
// Returns enabled slots for the given role, sorted by slot number (slot 1 = highest priority)
export function getFallbackSlots(role) {
  try {
    const raw = localStorage.getItem('FALLBACK_SLOTS');
    if (!raw) return [];
    const slots = JSON.parse(raw);
    return slots
      .filter(s => s.enabled && s.key?.trim() && s.provider && (s.roles ?? []).includes(role))
      .map(s => ({ key: s.key.trim(), provider: s.provider, model: s.model?.trim() || null }));
  } catch { return []; }
}

// ─── CORE DISPATCH: CHAT → string ────────────────────────────────────────────
// messages: [{role, content}] — system role supported for all providers
export async function dispatchChat(provider, key, model, messages, maxTokens = 600, timeoutMs = 30000) {
  const cfg = PROVIDER_ENDPOINTS[provider];
  if (!cfg) throw new Error(`Unknown provider: ${provider}`);
  const _t0 = Date.now();

  const _fetch = async (url, opts) => {
    const ctrl = new AbortController();
    const id   = setTimeout(() => ctrl.abort(), timeoutMs);
    try   { return await fetch(url, { ...opts, signal: ctrl.signal }); }
    finally { clearTimeout(id); }
  };

  // Anthropic: system is a top-level field, not a message
  if (provider === 'anthropic') {
    const sysContent  = messages.find(m => m.role === 'system')?.content ?? '';
    const convMessages = messages.filter(m => m.role !== 'system');
    const res = await _fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cfg.auth(key) },
      body: JSON.stringify({ model: model || cfg.default_narrator_model, max_tokens: maxTokens, system: sysContent, messages: convMessages }),
    });
    if (!res.ok) { const t = await res.text(); throw new Error(`Anthropic HTTP ${res.status}: ${t.slice(0, 160)}`); }
    const _aOut = (await res.json()).content?.[0]?.text?.trim() ?? '';
    window._devlog?.api('dispatchChat OK', { provider, model: model||cfg.default_narrator_model, elapsed_ms: Date.now()-_t0, chars: _aOut.length });
    return _aOut;
  }

  // Gemini: system_instruction separate, only last user message used (no history in v1beta)
  if (provider === 'gemini') {
    const sysContent = messages.find(m => m.role === 'system')?.content ?? '';
    const lastUser   = [...messages].reverse().find(m => m.role === 'user')?.content ?? '';
    const gModel = model || cfg.default_narrator_model;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${gModel}:generateContent?key=${key}`;
    const body = { generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 }, contents: [{ parts: [{ text: lastUser }] }] };
    if (sysContent) body.system_instruction = { parts: [{ text: sysContent }] };
    const res = await _fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) { const t = await res.text(); throw new Error(`Gemini HTTP ${res.status}: ${t.slice(0, 160)}`); }
    const _gOut = (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
    window._devlog?.api('dispatchChat OK', { provider, model: gModel, elapsed_ms: Date.now()-_t0, chars: _gOut.length });
    return _gOut;
  }

  // OpenAI-compatible: Grok, OpenAI, OpenRouter, Groq, Custom
  let chatUrl = cfg.chat;
  if (provider === 'custom') {
    const base = getCustomBaseUrl();
    if (!base) throw new Error('Custom provider requires a base URL. Set it in ⚙ Settings.');
    chatUrl = `${base}/chat/completions`;
  }
  const res = await _fetch(chatUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cfg.auth(key) },
    body: JSON.stringify({ model: model || cfg.default_narrator_model, max_tokens: maxTokens, messages, stream: false }),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`${getProviderDisplayName(provider)} HTTP ${res.status}: ${t.slice(0, 160)}`); }
  const _oOut = (await res.json()).choices?.[0]?.message?.content?.trim() ?? '';
  window._devlog?.api('dispatchChat OK', { provider, model: model||cfg.default_narrator_model, elapsed_ms: Date.now()-_t0, chars: _oOut.length });
  return _oOut;
}

// ─── CORE DISPATCH: JSON → parsed object ─────────────────────────────────────
export async function dispatchJSON(provider, key, model, prompt, maxTokens = 400) {
  const cfg = PROVIDER_ENDPOINTS[provider];
  if (!cfg) throw new Error(`Unknown provider: ${provider}`);
  const _t0 = Date.now();

  // Gemini: native JSON mode
  if (provider === 'gemini') {
    const gModel = model || cfg.default_helper_model;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${gModel}:generateContent?key=${key}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens, response_mime_type: 'application/json' } }),
    });
    if (res.status === 429) throw new Error('GEMINI_RATE_LIMIT');
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
    const text = (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
    try { const _r = JSON.parse(text); window._devlog?.api('dispatchJSON OK', { provider, model: model||cfg.default_helper_model, elapsed_ms: Date.now()-_t0 }); return _r; } catch { return {}; }
  }

  // Anthropic
  if (provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cfg.auth(key) },
      body: JSON.stringify({ model: model || cfg.default_helper_model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}`);
    const text = (await res.json()).content?.[0]?.text ?? '{}';
    try { const _r = JSON.parse(text.replace(/```json|```/g, '').trim()); window._devlog?.api('dispatchJSON OK', { provider, model: model||cfg.default_helper_model, elapsed_ms: Date.now()-_t0 }); return _r; } catch { return {}; }
  }

  // OpenAI-compatible
  let chatUrl = cfg.chat;
  if (provider === 'custom') {
    const base = getCustomBaseUrl();
    if (!base) throw new Error('Custom provider requires a base URL. Set it in ⚙ Settings.');
    chatUrl = `${base}/chat/completions`;
  }
  const res = await fetch(chatUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cfg.auth(key) },
    body: JSON.stringify({ model: model || cfg.default_helper_model, max_tokens: maxTokens, temperature: 0.1, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) {
    const _eb = await res.text().catch(() => '');
    throw new Error(`${getProviderDisplayName(provider)} HTTP ${res.status}: ${_eb.slice(0, 160)}`);
  }
  const _djData = await res.json();
  const text = _djData.choices?.[0]?.message?.content ?? '{}';
  const _djClean = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim() || '{}';
  try {
    const _r = JSON.parse(_djClean);
    window._devlog?.api('dispatchJSON OK', { provider, model: model||cfg.default_helper_model, elapsed_ms: Date.now()-_t0 });
    return _r;
  } catch (e) {
    window._devlog?.error('dispatchJSON JSON parse error', { provider, model: model||cfg.default_helper_model, preview: _djClean.slice(0, 300), parse_error: e.message });
    return {};
  }
}

// ─── DYNAMIC MODEL DISCOVERY ─────────────────────────────────────────────────
// Queries the provider's model-list endpoint and returns an array of model id strings.
// Model names churn constantly, so discovery is the source of truth; default_*_model
// values are only a last-resort fallback. Returns [] on any error/CORS/non-200 so the
// UI can gracefully fall back to a free-text input.
export async function fetchModels(provider, key, baseUrl) {
  if (!provider || !key) return [];
  try {
    // Gemini: models[].name, strip the "models/" prefix
    if (provider === 'gemini') {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
      if (!res.ok) return [];
      const data = await res.json();
      return (data.models ?? []).map(m => (m.name ?? '').replace(/^models\//, '')).filter(Boolean);
    }

    // Anthropic: data[].id, x-api-key + anthropic-version headers
    if (provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      });
      if (!res.ok) return [];
      const data = await res.json();
      return (data.data ?? []).map(m => m.id).filter(Boolean);
    }

    // OpenAI-compatible: Grok, OpenAI, OpenRouter, Groq, Custom — GET {chatBase}/models
    const cfg = PROVIDER_ENDPOINTS[provider];
    let base;
    if (provider === 'custom') {
      base = getCustomBaseUrl(baseUrl);
    } else {
      base = (cfg?.chat ?? '').replace(/\/chat\/completions$/, '');
    }
    if (!base) return [];
    const res = await fetch(`${base}/models`, { headers: { 'Authorization': `Bearer ${key}` } });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data ?? []).map(m => m.id).filter(Boolean);
  } catch { return []; }
}

// ─── CURRENCY HELPER ──────────────────────────────────────────────────────────
export function getCurrencySymbol() {
  return (typeof localStorage !== 'undefined' ? localStorage.getItem('CURRENCY_SYMBOL') : null) || '₱';
}