// api.js — API calls
// Fix #3: Gemini autopilot style injection
// Fix #4: FALLBACK_ON_OUTAGE_ONLY — fallbacks only on HTTP failures, not load balancing
'use strict';

import {
  buildGrokNarrationPrompt, buildGeminiClassifyPrompt,
  buildGeminiNpcPrompt, buildGeminiAutopilotPrompt,
} from './prompt.js';

// ─── CONFIG ───────────────────────────────────────────────────────────────────
// Fix #4: true means fallback is only triggered on genuine outages
const FALLBACK_ON_OUTAGE_ONLY = true;

function getKey(name) {
  const k = localStorage.getItem(name);
  if (!k) throw new Error(`API key not set: ${name}. Open ⚙ Settings.`);
  return k;
}

// ─── GROK ─────────────────────────────────────────────────────────────────────
const GROK_URL   = 'https://api.x.ai/v1/chat/completions';
const GROK_MODEL = 'grok-beta';
let _convId = null;
export function resetConvId() { _convId = null; }

function buildGrokUserMessage(turnBrief, mode) {
  const instruction = {
    notable: 'Expand the scene. 2–4 paragraphs.',
    crisis:  'Write with urgency and weight. 3–5 paragraphs.',
    death:   'Write the death scene with gravity. 4–6 paragraphs.',
  }[mode] ?? '2–3 paragraphs.';
  return JSON.stringify({ ...turnBrief, narration_instruction: instruction });
}

export async function callGrok(turnBrief, mode) {
  const sys = buildGrokNarrationPrompt();
  const usr = buildGrokUserMessage(turnBrief, mode);
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${getKey('GROK_API_KEY')}`,
  };
  if (_convId) headers['x-grok-conv-id'] = _convId;

  const body = {
    model: GROK_MODEL,
    max_tokens: 600,
    messages: [
      { role: 'system', content: sys },
      { role: 'user',   content: usr },
    ],
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(GROK_URL, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Grok HTTP ${res.status}`);
    const data = await res.json();
    if (data.id && !_convId) _convId = data.id;
    return data.choices[0].message.content.trim();
  } catch (err) {
    const isOutage = !navigator.onLine
      || err.message?.includes('502')
      || err.message?.includes('503')
      || err.message === 'Failed to fetch';
    if (FALLBACK_ON_OUTAGE_ONLY && isOutage) {
      console.warn('[api] Grok outage — using fallback narrator:', err.message);
      return callFallbackNarrator(sys, usr, mode);
    }
    // Surface the real error so you can see what's actually wrong
    throw new Error(`Grok failed (${err.message}) — check your API key and model name.`);
  }
}

// ─── GEMINI ───────────────────────────────────────────────────────────────────
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

async function geminiRaw(prompt, maxTokens = 400) {
  const key = getKey('GEMINI_API_KEY');
  //temporary log for debugging//
  console.log('[gemini] key starts with:', key.slice(0, 8), 'length:', key.length);
  const res = await fetch(`${GEMINI_URL}?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: maxTokens,
        response_mime_type: 'application/json',
      },
    }),
  });
  if (!res.ok) {
    const msg = await res.text();
    // Fix #4: surface rate-limit distinctly so callers can choose to skip, not swap model
    if (res.status === 429) {
    const groqKey = localStorage.getItem('GROQ_API_KEY');
    if (groqKey) {
      const gr = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
        body: JSON.stringify({ model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: prompt }], temperature: 0.1, max_tokens: 400 }),
      });
      if (gr.ok) {
        const text = (await gr.json()).choices[0].message.content;
        try { return JSON.parse(text.replace(/```json|```/g, '').trim()); } catch { return {}; }
      }
    }
    throw new Error('GEMINI_RATE_LIMIT');
  }
    throw new Error(`Gemini HTTP ${res.status}: ${msg}`);
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
  try { return JSON.parse(text); } catch { return {}; }
}

export async function classifyAction(input, sanitizedState) {
  return geminiRaw(buildGeminiClassifyPrompt(input, sanitizedState)).catch(() => ({
    action_type: 'unknown', time_cost_hours: 0.5, stat_deltas: {}, risk_class: 'none',
    location_change: null, npc_ids_involved: [],
  }));
}

export async function evaluateNpcReaction(npcContext, actionDescription, playerStats) {
  return geminiRaw(buildGeminiNpcPrompt(npcContext, actionDescription, playerStats)).catch(() => null);
}

// Fix #3: autopilot narration — Gemini with strict style guide; prose mode (no JSON)
export async function callGeminiAutopilot(sanitizedState, hours, activityLabel) {
  const key    = getKey('GEMINI_API_KEY');
  const prompt = buildGeminiAutopilotPrompt(sanitizedState, hours, activityLabel);
  const res    = await fetch(`${GEMINI_URL}?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.5, maxOutputTokens: 120 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini autopilot HTTP ${res.status}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
}

// Fix #1: session compression is now optional flavor, not required continuity
export async function compressSessionContext(last10Events) {
  if (!last10Events?.length) return '';
  const prompt = `Summarize these simulation events in 1–2 sentences of atmospheric flavor only. Do not add facts not present in the events. Output only the summary:\n\n${last10Events.map((e, i) => `${i + 1}. ${e}`).join('\n')}`;
  const key = getKey('GEMINI_API_KEY');
  try {
    const res = await fetch(`${GEMINI_URL}?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 80 },
      }),
    });
    if (!res.ok) return '';
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
  } catch { return ''; }
}

// ─── FALLBACK NARRATOR ────────────────────────────────────────────────────────
// Fix #4: only reached on genuine Grok outage, not routine switching
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

async function callFallbackNarrator(systemPrompt, userMessage, mode) {
  const key = getKey('OPENROUTER_API_KEY');
  // Use a model with similar tone when possible; update as catalog evolves
  const model = 'meta-llama/llama-3.1-8b-instruct:free';
  const fbController = new AbortController();
  const fbTimeout = setTimeout(() => fbController.abort(), 20000);
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    signal: fbController.signal,
    body: JSON.stringify({
      model,
      max_tokens: 600,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMessage  },
      ],
    }),
  });
  clearTimeout(fbTimeout);
  if (!res.ok) throw new Error(`Fallback narrator HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content.trim();
}