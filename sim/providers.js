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
};

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
  return 'openrouter'; // unknown — assume openrouter-compatible
}

export function getProviderDisplayName(provider) {
  const MAP = { grok:'Grok/xAI', openai:'OpenAI', anthropic:'Anthropic', openrouter:'OpenRouter', groq:'Groq', gemini:'Google Gemini' };
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

// ─── CORE DISPATCH: CHAT → string ────────────────────────────────────────────
// messages: [{role, content}] — system role supported for all providers
export async function dispatchChat(provider, key, model, messages, maxTokens = 600, timeoutMs = 30000) {
  const cfg = PROVIDER_ENDPOINTS[provider];
  if (!cfg) throw new Error(`Unknown provider: ${provider}`);

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
    return (await res.json()).content?.[0]?.text?.trim() ?? '';
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
    return (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
  }

  // OpenAI-compatible: Grok, OpenAI, OpenRouter, Groq
  const res = await _fetch(cfg.chat, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cfg.auth(key) },
    body: JSON.stringify({ model: model || cfg.default_narrator_model, max_tokens: maxTokens, messages, stream: false }),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`${getProviderDisplayName(provider)} HTTP ${res.status}: ${t.slice(0, 160)}`); }
  return (await res.json()).choices?.[0]?.message?.content?.trim() ?? '';
}

// ─── CORE DISPATCH: JSON → parsed object ─────────────────────────────────────
export async function dispatchJSON(provider, key, model, prompt, maxTokens = 400) {
  const cfg = PROVIDER_ENDPOINTS[provider];
  if (!cfg) throw new Error(`Unknown provider: ${provider}`);

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
    try { return JSON.parse(text); } catch { return {}; }
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
    try { return JSON.parse(text.replace(/```json|```/g, '').trim()); } catch { return {}; }
  }

  // OpenAI-compatible
  const res = await fetch(cfg.chat, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cfg.auth(key) },
    body: JSON.stringify({ model: model || cfg.default_helper_model, max_tokens: maxTokens, temperature: 0.1, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`${getProviderDisplayName(provider)} HTTP ${res.status}`);
  const text = (await res.json()).choices?.[0]?.message?.content ?? '{}';
  try { return JSON.parse(text.replace(/```json|```/g, '').trim()); } catch { return {}; }
}