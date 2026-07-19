// providers.js — Universal API provider abstraction for The Sim
// Supports: Grok/xAI, OpenAI, Anthropic, OpenRouter, Groq, Google Gemini,
//           HuggingFace (Inference API), Mistral AI, Cerebras, GitHub Models, Cohere
'use strict';

// ─── PROVIDER CONFIGURATIONS ──────────────────────────────────────────────────
export const PROVIDER_ENDPOINTS = {
  grok: {
    chat:                   'https://api.x.ai/v1/chat/completions',
    models:                 'https://api.x.ai/v1/models',
    default_narrator_model: 'grok-4.20-non-reasoning',
    default_helper_model:   'grok-4.20-non-reasoning',
    format:                 'openai',
    auth: k => ({ 'Authorization': `Bearer ${k}` }),
  },
  openai: {
    chat:                   'https://api.openai.com/v1/chat/completions',
    models:                 'https://api.openai.com/v1/models',
    default_narrator_model: 'gpt-4o',
    default_helper_model:   'gpt-4o-mini',
    format:                 'openai',
    auth: k => ({ 'Authorization': `Bearer ${k}` }),
  },
  anthropic: {
    chat:                   'https://api.anthropic.com/v1/messages',
    models:                 'https://api.anthropic.com/v1/models',
    default_narrator_model: 'claude-sonnet-4-6',
    default_helper_model:   'claude-haiku-4-5-20251001',
    format:                 'anthropic',
    auth: k => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01' }),
  },
  openrouter: {
    chat:                   'https://openrouter.ai/api/v1/chat/completions',
    models:                 'https://openrouter.ai/api/v1/models',
    default_narrator_model: 'nousresearch/hermes-3-llama-3.1-405b:free',
    default_helper_model:   'meta-llama/llama-3.1-8b-instruct:free',
    format:                 'openai',
    auth: k => ({ 'Authorization': `Bearer ${k}` }),
  },
  groq: {
    chat:                   'https://api.groq.com/openai/v1/chat/completions',
    models:                 'https://api.groq.com/openai/v1/models',
    default_narrator_model: 'llama-3.3-70b-versatile',
    default_helper_model:   'llama-3.1-8b-instant',
    format:                 'openai',
    auth: k => ({ 'Authorization': `Bearer ${k}` }),
  },
  gemini: {
    chat:                   null,
    models:                 null,
    default_narrator_model: 'gemini-2.0-flash',
    default_helper_model:   'gemini-2.0-flash',
    format:                 'gemini',
    auth:                   null,
  },
  huggingface: {
    chat:                   'https://router.huggingface.co/v1/chat/completions',
    models:                 'https://router.huggingface.co/v1/models',
    default_narrator_model: 'meta-llama/Llama-3.1-8B-Instruct',
    default_helper_model:   'meta-llama/Llama-3.1-8B-Instruct',
    format:                 'openai',
    auth: k => ({ 'Authorization': `Bearer ${k}` }),
  },
  mistral: {
    chat:                   'https://api.mistral.ai/v1/chat/completions',
    models:                 'https://api.mistral.ai/v1/models',
    default_narrator_model: 'mistral-large-latest',
    default_helper_model:   'mistral-small-latest',
    format:                 'openai',
    auth: k => ({ 'Authorization': `Bearer ${k}` }),
  },
  cerebras: {
    chat:                   'https://api.cerebras.ai/v1/chat/completions',
    models:                 'https://api.cerebras.ai/v1/models',
    default_narrator_model: 'llama3.1-70b',
    default_helper_model:   'llama3.1-8b',
    format:                 'openai',
    auth: k => ({ 'Authorization': `Bearer ${k}` }),
  },
  github: {
    chat:                   'https://models.inference.ai.azure.com/chat/completions',
    models:                 null, // no standard list endpoint
    default_narrator_model: 'gpt-4o',
    default_helper_model:   'gpt-4o-mini',
    format:                 'openai',
    auth: k => ({ 'Authorization': `Bearer ${k}` }),
  },
  cohere: {
    chat:                   'https://api.cohere.com/v2/chat',
    models:                 'https://api.cohere.com/v1/models',
    default_narrator_model: 'command-r-plus',
    default_helper_model:   'command-r',
    format:                 'cohere',
    auth: k => ({ 'Authorization': `Bearer ${k}` }),
  },
  custom: {
    chat:                   null,
    models:                 null,
    default_narrator_model: 'gpt-4o',
    default_helper_model:   'gpt-4o-mini',
    format:                 'openai',
    auth: k => ({ 'Authorization': `Bearer ${k}` }),
  },
};

// ─── RATE SPACING ─────────────────────────────────────────────────────────────
// Minimum ms between consecutive calls to the same provider.
// Smooths burst patterns that trigger RPS limits without blocking simulation.
const _SPACING_MS = {
  groq:        420,
  gemini:      320,
  huggingface: 520,
  cerebras:    320,
  cohere:      350,
  default:     160,
};
const _lastCallTs = new Map();

async function _enforceSpacing(provider) {
  const ms   = _SPACING_MS[provider] ?? _SPACING_MS.default;
  const last = _lastCallTs.get(provider) ?? 0;
  const wait = ms - (Date.now() - last);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastCallTs.set(provider, Date.now());
}

// ─── EXPONENTIAL BACKOFF ──────────────────────────────────────────────────────
// Retries on 429 with jittered exponential delay before giving up and failing over.
// maxRetries=2 + baseMs=900 means max ~3.2s added latency before failover.
export async function withBackoff(fn, provider, { maxRetries = 2, baseMs = 900, maxMs = 6000 } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const is429   = /429|rate.?limit|too.?many.?request|quota/i.test(err.message ?? '');
      const canRetry = is429 && attempt < maxRetries;
      if (!canRetry) throw err;
      const jitter = Math.random() * 400;
      const delay  = Math.min(baseMs * Math.pow(1.8, attempt) + jitter, maxMs);
      window._devlog?.system(`${provider} 429 — backoff ${Math.round(delay)}ms (retry ${attempt + 1}/${maxRetries})`, { err: err.message.slice(0, 80) });
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ─── CUSTOM BASE URL ──────────────────────────────────────────────────────────
export function getCustomBaseUrl(baseUrl) {
  const raw = (baseUrl || (typeof localStorage !== 'undefined' ? localStorage.getItem('CUSTOM_BASE_URL') : '') || '').trim();
  return raw.replace(/\/+$/, '');
}

// ─── AUTO-DETECT PROVIDER FROM KEY PREFIX ─────────────────────────────────────
export function detectProvider(key) {
  if (!key || typeof key !== 'string') return null;
  const k = key.trim();
  if (k.startsWith('xai-'))                              return 'grok';
  if (k.startsWith('AIza'))                              return 'gemini';
  if (k.startsWith('sk-or-'))                            return 'openrouter';
  if (k.startsWith('gsk_'))                              return 'groq';
  if (k.startsWith('sk-ant-'))                           return 'anthropic';
  if (k.startsWith('hf_'))                               return 'huggingface';
  if (k.startsWith('csk-'))                              return 'cerebras';
  if (k.startsWith('ghp_') || k.startsWith('github_pat_')) return 'github';
  // Mistral & Cohere have no standard prefix — requires manual provider selection
  if (k.startsWith('sk-'))                               return 'openai';
  return null;
}

export function getProviderDisplayName(provider) {
  const MAP = {
    grok:'Grok/xAI', openai:'OpenAI', anthropic:'Anthropic',
    openrouter:'OpenRouter', groq:'Groq', gemini:'Google Gemini',
    huggingface:'HuggingFace', mistral:'Mistral AI', cerebras:'Cerebras',
    github:'GitHub Models', cohere:'Cohere', custom:'Custom (OpenAI-compatible)',
  };
  return MAP[provider] ?? provider ?? 'Unknown';
}

// ─── SLOT CONFIGURATION ───────────────────────────────────────────────────────
export function getNarratorSlot() {
  const key      = localStorage.getItem('NARRATOR_KEY')?.trim()      || localStorage.getItem('GROK_API_KEY')?.trim()   || null;
  const provider = localStorage.getItem('NARRATOR_PROVIDER')?.trim() || (key ? detectProvider(key) : null);
  const model    = localStorage.getItem('NARRATOR_MODEL')?.trim()    || null;
  return { key, provider, model };
}

export function getClassifierSlot() {
  const key      = localStorage.getItem('CLASSIFIER_KEY')?.trim()      || localStorage.getItem('GEMINI_API_KEY')?.trim() || null;
  const provider = localStorage.getItem('CLASSIFIER_PROVIDER')?.trim() || (key ? detectProvider(key) : null);
  const model    = localStorage.getItem('CLASSIFIER_MODEL')?.trim()    || null;
  return { key, provider, model };
}

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

export function isExplicitModeEnabled() {
  return localStorage.getItem('CONTENT_MODE') !== 'filtered';
}

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

export function getEnricherSlot() {
  const key      = localStorage.getItem('ENRICHER_KEY')?.trim()      || null;
  const provider = localStorage.getItem('ENRICHER_PROVIDER')?.trim() || (key ? detectProvider(key) : null);
  const model    = localStorage.getItem('ENRICHER_MODEL')?.trim()    || null;
  if (key && provider) return { key, provider, model };
  return getClassifierSlot();
}

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

// ─── COHERE HELPERS ───────────────────────────────────────────────────────────
function _cohereBody(model, messages, maxTokens) {
  return { model: model || 'command-r-plus', messages, max_tokens: maxTokens };
}
function _cohereText(data) {
  // v2: data.message.content[0].text | v1 fallback: data.text
  return data?.message?.content?.[0]?.text?.trim() ?? data?.text?.trim() ?? '';
}

// ─── CORE DISPATCH: CHAT → string ────────────────────────────────────────────
export async function dispatchChat(provider, key, model, messages, maxTokens = 600, timeoutMs = 30000) {
  const cfg = PROVIDER_ENDPOINTS[provider];
  if (!cfg) throw new Error(`Unknown provider: ${provider}`);
  await _enforceSpacing(provider);
  const _t0 = Date.now();

  const _fetch = async (url, opts) => {
    const ctrl = new AbortController();
    const id   = setTimeout(() => ctrl.abort(), timeoutMs);
    try   { return await fetch(url, { ...opts, signal: ctrl.signal }); }
    finally { clearTimeout(id); }
  };

  const text = await withBackoff(async () => {
    // ── Anthropic ──────────────────────────────────────────────────────────
    if (provider === 'anthropic') {
      const sys  = messages.find(m => m.role === 'system')?.content ?? '';
      const conv = messages.filter(m => m.role !== 'system');
      const res  = await _fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cfg.auth(key) },
        body: JSON.stringify({ model: model || cfg.default_narrator_model, max_tokens: maxTokens, system: sys, messages: conv }),
      });
      if (!res.ok) { const t = await res.text(); throw new Error(`Anthropic HTTP ${res.status}: ${t.slice(0, 160)}`); }
      return (await res.json()).content?.[0]?.text?.trim() ?? '';
    }
    // ── Gemini ─────────────────────────────────────────────────────────────
    if (provider === 'gemini') {
      const sys      = messages.find(m => m.role === 'system')?.content ?? '';
      const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content ?? '';
      const gModel   = model || cfg.default_narrator_model;
      const url      = `https://generativelanguage.googleapis.com/v1beta/models/${gModel}:generateContent?key=${key}`;
      const body     = { generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 }, contents: [{ parts: [{ text: lastUser }] }] };
      if (sys) body.system_instruction = { parts: [{ text: sys }] };
      const res = await _fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) { const t = await res.text(); throw new Error(`Gemini HTTP ${res.status}: ${t.slice(0, 160)}`); }
      return (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
    }
    // ── Cohere ─────────────────────────────────────────────────────────────
    if (provider === 'cohere') {
      const res = await _fetch(cfg.chat, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cfg.auth(key) },
        body: JSON.stringify(_cohereBody(model || cfg.default_narrator_model, messages, maxTokens)),
      });
      if (!res.ok) { const t = await res.text(); throw new Error(`Cohere HTTP ${res.status}: ${t.slice(0, 160)}`); }
      return _cohereText(await res.json());
    }
    // ── OpenAI-compatible: Grok, OpenAI, OpenRouter, Groq, HuggingFace, Mistral, Cerebras, GitHub, Custom
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
    return (await res.json()).choices?.[0]?.message?.content?.trim() ?? '';
  }, provider);

  window._devlog?.api('dispatchChat OK', { provider, model: model || cfg?.default_narrator_model, elapsed_ms: Date.now() - _t0, chars: text.length });
  return text;
}

// ─── CORE DISPATCH: JSON → parsed object ─────────────────────────────────────
export async function dispatchJSON(provider, key, model, prompt, maxTokens = 400) {
  const cfg = PROVIDER_ENDPOINTS[provider];
  if (!cfg) throw new Error(`Unknown provider: ${provider}`);
  await _enforceSpacing(provider);
  const _t0 = Date.now();

  const parsed = await withBackoff(async () => {
    // ── Gemini native JSON ─────────────────────────────────────────────────
    if (provider === 'gemini') {
      const gModel = model || cfg.default_helper_model;
      const url    = `https://generativelanguage.googleapis.com/v1beta/models/${gModel}:generateContent?key=${key}`;
      const res    = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens, response_mime_type: 'application/json' } }),
      });
      if (res.status === 429) throw new Error('Gemini HTTP 429: rate limit');
      if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
      const raw = (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
      try { return JSON.parse(raw); } catch { return {}; }
    }
    // ── Anthropic ──────────────────────────────────────────────────────────
    if (provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...cfg.auth(key) },
        body: JSON.stringify({ model: model || cfg.default_helper_model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}`);
      const raw = (await res.json()).content?.[0]?.text ?? '{}';
      try { return JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch { return {}; }
    }
    // ── Cohere ─────────────────────────────────────────────────────────────
    if (provider === 'cohere') {
      const res = await fetch(cfg.chat, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...cfg.auth(key) },
        body: JSON.stringify(_cohereBody(model || cfg.default_helper_model, [{ role: 'user', content: prompt }], maxTokens)),
      });
      if (!res.ok) throw new Error(`Cohere HTTP ${res.status}`);
      const raw = _cohereText(await res.json());
      try { return JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch { return {}; }
    }
    // ── OpenAI-compatible ──────────────────────────────────────────────────
    let chatUrl = cfg.chat;
    if (provider === 'custom') {
      const base = getCustomBaseUrl();
      if (!base) throw new Error('Custom provider requires a base URL. Set it in ⚙ Settings.');
      chatUrl = `${base}/chat/completions`;
    }
    const res = await fetch(chatUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...cfg.auth(key) },
      body: JSON.stringify({ model: model || cfg.default_helper_model, max_tokens: maxTokens, temperature: 0.1, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) {
      const eb = await res.text().catch(() => '');
      throw new Error(`${getProviderDisplayName(provider)} HTTP ${res.status}: ${eb.slice(0, 160)}`);
    }
  const raw = (await res.json()).choices?.[0]?.message?.content ?? '{}';
    // Strip DeepSeek/HuggingFace reasoning tags and markdown fences
    const clean = raw
      .replace(/<\/?thought>[\s\S]*?<\/?\/thought>/gi, '') // DeepSeek thought tags
      .replace(/<\/?thinking>[\s\S]*?<\/?\/thinking>/gi, '') // Alternative thinking tags
      .replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim() || '{}';
    try { return JSON.parse(clean); } catch { return {}; }
  }, provider);

  window._devlog?.api('dispatchJSON OK', { provider, model: model || cfg?.default_helper_model, elapsed_ms: Date.now() - _t0 });
  return parsed;
}

// ─── DYNAMIC MODEL DISCOVERY ─────────────────────────────────────────────────
export async function fetchModels(provider, key, baseUrl) {
  if (!provider || !key) return [];
  try {
    if (provider === 'gemini') {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
      if (!res.ok) return [];
      return ((await res.json()).models ?? []).map(m => (m.name ?? '').replace(/^models\//, '')).filter(Boolean);
    }
    if (provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      });
      if (!res.ok) return [];
      return ((await res.json()).data ?? []).map(m => m.id).filter(Boolean);
    }
    if (provider === 'cohere') {
      const res = await fetch('https://api.cohere.com/v1/models', {
        headers: { 'Authorization': `Bearer ${key}` },
      });
      if (!res.ok) return [];
      const data = await res.json();
      return (data.models ?? data.data ?? []).map(m => m.name ?? m.id).filter(Boolean);
    }
    if (provider === 'github') {
      // No standard list endpoint — return curated set of available GitHub Models
      return ['gpt-4o', 'gpt-4o-mini', 'meta-llama-3.1-70b-instruct', 'meta-llama-3.1-8b-instruct', 'phi-3.5-mini-instruct', 'mistral-nemo'];
    }
    if (provider === 'huggingface') {
      const res = await fetch('https://router.huggingface.co/v1/models', {
        headers: { 'Authorization': `Bearer ${key}` },
      });
      if (!res.ok) return [];
      return ((await res.json()).data ?? []).map(m => m.id).filter(Boolean).slice(0, 120);
    }
    // OpenAI-compatible: Grok, OpenAI, OpenRouter, Groq, Mistral, Cerebras, Custom
    const cfg = PROVIDER_ENDPOINTS[provider];
    let modelsUrl = cfg?.models;
    if (provider === 'custom') {
      const base = getCustomBaseUrl(baseUrl);
      if (!base) return [];
      modelsUrl = `${base}/models`;
    }
    if (!modelsUrl) return [];
    const res = await fetch(modelsUrl, { headers: { 'Authorization': `Bearer ${key}` } });
    if (!res.ok) return [];
    return ((await res.json()).data ?? []).map(m => m.id).filter(Boolean);
  } catch { return []; }
}

// ─── CURRENCY HELPER ──────────────────────────────────────────────────────────
export function getCurrencySymbol() {
  return (typeof localStorage !== 'undefined' ? localStorage.getItem('CURRENCY_SYMBOL') : null) || '₱';
}