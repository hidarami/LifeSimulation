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
const GROK_MODEL = 'grok-4.3';
let _convId = null;
let _conversationHistory = []; // Store last 5 turns for narrative continuity
export function resetConvId() { _convId = null; _conversationHistory = []; }
export function setConversationHistory(h) { _conversationHistory = Array.isArray(h) ? [...h] : []; }

function buildGrokUserMessage(turnBrief, mode) {
  const instruction = {
    notable: 'Expand the scene. 2–4 paragraphs.',
    crisis:  'Write with urgency and weight. 3–5 paragraphs.',
    death:   'Write the death scene with gravity. 4–6 paragraphs.',
    init:    'This is the opening scene of a new game. Establish the character in their immediate physical environment — body state, location, sensory details. Do not introduce NPCs unless the lorebook names them. End with: "What do you do?" 3–4 paragraphs.',
  }[mode] ?? '2–3 paragraphs.';
  return JSON.stringify({ ...turnBrief, narration_instruction: instruction });
}

export async function callGrok(turnBrief, mode) {
  const lorebook = typeof localStorage !== 'undefined' ? (localStorage.getItem('LOREBOOK') ?? '') : '';
  const sys = buildGrokNarrationPrompt(lorebook);
  const usr = buildGrokUserMessage(turnBrief, mode);
  const grokKey = getKey('GROK_API_KEY');
  console.log('[Grok Debug] Key starts with:', grokKey.slice(0, 8), 'length:', grokKey.length);
  console.log('[Grok Debug] Model:', GROK_MODEL);
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${grokKey}`,
  };
  if (_convId) headers['x-grok-conv-id'] = _convId;

  // Build messages with conversation history for narrative continuity
  const messages = [
    { role: 'system', content: sys },
    ..._conversationHistory.slice(-4), // Last 4 turns for context
    { role: 'user', content: usr },
  ];

  const body = {
    model: GROK_MODEL,
    max_tokens: 600,
    messages,
    stream: false,
  };
  console.log('[Grok Debug] Request body:', JSON.stringify(body).slice(0, 300) + '...');

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // Increased to 30s for conversation history
    const res = await fetch(GROK_URL, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      const errText = await res.text();
      console.error('[Grok API Error]', res.status, errText);
      throw new Error(`Grok HTTP ${res.status}: ${errText}`);
    }
    const data = await res.json();
    if (data.id && !_convId) _convId = data.id;
    const prose = data.choices[0].message.content.trim();
    
    // Add this turn to conversation history for continuity
    _conversationHistory.push({ role: 'user', content: usr });
    _conversationHistory.push({ role: 'assistant', content: prose });
    
    return prose;
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
const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions';

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
  const prompt = buildGeminiAutopilotPrompt(sanitizedState, hours, activityLabel);

  // Try OpenRouter first — free quota, saves Gemini for classification
  const orKey = localStorage.getItem('OPENROUTER_API_KEY');
  if (orKey) {
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${orKey}` },
        body: JSON.stringify({
          model: 'openai/gpt-oss-120b:free',
          max_tokens: 150,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (res.ok) {
        const text = (await res.json()).choices?.[0]?.message?.content?.trim();
        if (text) return text;
      }
    } catch {}
  }

  // Try Groq second
  const groqKey = localStorage.getItem('GROQ_API_KEY');
  if (groqKey) {
    try {
      const res = await fetch(GROQ_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          max_tokens: 150,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.5,
        }),
      });
      if (res.ok) {
        const text = (await res.json()).choices?.[0]?.message?.content?.trim();
        if (text) return text;
      }
    } catch {}
  }

  // Fall back to Gemini
  const key = getKey('GEMINI_API_KEY');
  const res = await fetch(`${GEMINI_URL}?key=${key}`, {
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

  // Groq is fast and free for compression
  const groqKey = localStorage.getItem('GROQ_API_KEY');
  if (groqKey) {
    try {
      const res = await fetch(GROQ_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.4,
          max_tokens: 80,
        }),
      });
      if (res.ok) {
        const text = (await res.json()).choices?.[0]?.message?.content?.trim();
        if (text) return text;
      }
    } catch {}
  }

  const key = localStorage.getItem('GEMINI_API_KEY');
  if (!key) return '';
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

// ─── LOREBOOK PARSER ──────────────────────────────────────────────────────────
export async function parseLorebookToWorldState(lorebook) {
  const key = localStorage.getItem('GEMINI_API_KEY');
  if (!key) return null;
  const prompt = `Parse this lorebook for a life simulation game. Return ONLY valid JSON, no prose, no markdown fences.

Lorebook:
"""
${lorebook}
"""

Return exactly this shape:
{
  "player": { "location": "string or null", "cash": number_or_null },
  "job": null,
  "npcs": [],
  "possessions": []
}

If employed, job shape:
{ "employer": "string", "position": "string", "salary_per_cycle": number, "pay_cycle": "daily|weekly|monthly", "schedule": "e.g. Mon-Fri 8AM-5PM" }

Each NPC shape:
{
  "id": "lowercase_first_name_underscore_last",
  "name": "Full Name",
  "age": number,
  "npc_class": "intimate|household|professional|institutional",
  "relationship_meter": number -100 to 100,
  "trust_meter": number -100 to 100,
  "traits": { "jealousy":50,"honesty":50,"patience":50,"warmth":50,"ambition":50,"impulsivity":50,"dominance":50,"openness":50 },
  "note": "one sentence about the relationship with the player"
}

Each possession shape: { "name": "string", "note": "string or null" }

NPC class rules: intimate=family/romantic/bestfriend, household=roommates/neighbors, professional=boss/coworker/teacher, institutional=gov/police/medical.
Relationship meter: close family/romantic=70, good friend=50, acquaintance=20, stranger=0, rival=-40, enemy=-70.
Traits default 50 if personality not described. Extract EVERY named person mentioned.
CRITICAL: Also extract clearly implied household members or close relationships even if only partially named. Examples: "I live with my two brothers Jay and Ray (20,21)" → extract Jay AND Ray as separate NPCs. "my parents" → extract as father/mother with ids parent_father/parent_mother. "my best friend Marco" → extract Marco. "my girlfriend" → extract with id girlfriend_unnamed and name "Girlfriend". Do not leave anyone the player clearly lives with or is emotionally close to unextracted.`;

  try {
    const res = await fetch(`${GEMINI_URL}?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 1200, response_mime_type: 'application/json' },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
    return JSON.parse(text);
  } catch (e) {
    console.warn('[lorebook] parse failed:', e.message);
    return null;
  }
}

// ─── MULTI-AI WORLD BUILDING ──────────────────────────────────────────────────
// Runs Gemini (structure) and Groq (trait depth) in parallel during init.

async function buildNpcDepthWithGroq(lorebook) {
  const groqKey = localStorage.getItem('GROQ_API_KEY');
  if (!groqKey) return null;
  const prompt = `From this lorebook, infer personality trait scores (0-100) for every named or implied NPC.

Lorebook: """${lorebook.slice(0, 2000)}"""

Return ONLY valid JSON, no markdown:
{
  "npc_traits": {
    "npc_first_name_lowercase": {
      "jealousy": 0-100,
      "honesty": 0-100,
      "patience": 0-100,
      "warmth": 0-100,
      "ambition": 0-100,
      "impulsivity": 0-100,
      "dominance": 0-100,
      "openness": 0-100
    }
  }
}

Use the person's first name in lowercase as the key. Infer traits from described personality and behavior. Default 50 if not described.`;

  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 500,
      }),
    });
    if (!res.ok) return null;
    const text = (await res.json()).choices?.[0]?.message?.content ?? '{}';
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch { return null; }
}

export async function buildWorldWithMultipleAIs(lorebook) {
  if (!lorebook?.trim()) return null;

  // Run Gemini (structure) and Groq (NPC trait depth) in parallel
  const [geminiResult, groqResult] = await Promise.allSettled([
    parseLorebookToWorldState(lorebook),
    buildNpcDepthWithGroq(lorebook),
  ]);

  const base  = geminiResult.status === 'fulfilled' ? geminiResult.value : null;
  const depth = groqResult.status  === 'fulfilled'  ? groqResult.value  : null;

  if (!base) return null;

  // Merge: apply Groq trait overrides to Gemini's NPC list
  if (depth?.npc_traits && Array.isArray(base.npcs)) {
    for (const npc of base.npcs) {
      // Match on first segment of id (first name)
      const firstName = npc.id?.split('_')[0];
      const traitData = depth.npc_traits[firstName] ?? depth.npc_traits[npc.id];
      if (traitData) {
        npc.traits = { ...(npc.traits ?? {}), ...traitData };
      }
    }
  }

  return base;
}

// ─── NPC INITIATIVE ────────────────────────────────────────────────────────────
// Called async every 3rd turn. Groq decides if any NPC would naturally reach out.

export async function checkNpcInitiative(npcContextArray, playerStats, turnNumber) {
  const groqKey = localStorage.getItem('GROQ_API_KEY');
  if (!groqKey || !npcContextArray?.length) return [];

  const prompt = `You are an NPC behavior engine for a life simulation. Decide if any NPC would naturally initiate contact with the player right now.

NPCs: ${JSON.stringify(npcContextArray.slice(0, 5), null, 2)}
Player mood: ${playerStats?.mood ?? 50}, social: ${playerStats?.social ?? 50}
Turn: ${turnNumber}

Rules:
- Only trigger if relationship_meter > 20 OR a special circumstance warrants it
- NPC must be available OR reaching out remotely (text, call) is plausible given their schedule
- Maximum 1 NPC may initiate per call
- Must be natural, in-character, specific to this NPC's traits and relationship
- Do NOT trigger for NPCs with relationship_meter < 0

Return ONLY valid JSON:
{
  "has_initiative": boolean,
  "npc_id": "string or null",
  "type": "text|call|visit|message or null",
  "brief": "one concrete sentence describing exactly what the NPC does or says, present tense, no internal states"
}`;

  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.4,
        max_tokens: 150,
      }),
    });
    if (!res.ok) return [];
    const text = (await res.json()).choices?.[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    return (parsed.has_initiative && parsed.npc_id && parsed.brief)
      ? [{ npc_id: parsed.npc_id, type: parsed.type ?? 'message', brief: parsed.brief }]
      : [];
  } catch { return []; }
}

// ─── DESCRIBED NPC EXTRACTOR ──────────────────────────────────────────────────
// When player describes a third party in explicit content who isn't in the NPC system,
// Groq quickly extracts enough info to register them.

export async function evaluateDescribedNpc(playerInput) {
  const groqKey = localStorage.getItem('GROQ_API_KEY');
  if (!groqKey) return null;

  const prompt = `From this player action, extract the described third party person.

Player action: "${playerInput.slice(0, 300)}"

Return ONLY valid JSON:
{
  "found": boolean,
  "id": "lowercase_descriptor e.g. brothers_friend or jay or maria",
  "name": "descriptive name if none given e.g. \"Brother's Friend\", otherwise their name",
  "age": estimated_age_as_number,
  "npc_class": "intimate|household|professional|institutional",
  "traits": { "jealousy":50,"honesty":50,"patience":50,"warmth":50,"ambition":50,"impulsivity":50,"dominance":50,"openness":50 },
  "relationship_meter": 20,
  "trust_meter": 10
}

If no clear third party is physically present and acting, return { "found": false }.`;

  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 250,
      }),
    });
    if (!res.ok) return null;
    const text = (await res.json()).choices?.[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    return parsed.found ? parsed : null;
  } catch { return null; }
}