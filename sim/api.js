// api.js — API calls
// Fix #3: Gemini autopilot style injection
// Fix #4: FALLBACK_ON_OUTAGE_ONLY — fallbacks only on HTTP failures, not load balancing
'use strict';

import {
  buildGrokNarrationPrompt, buildGeminiClassifyPrompt,
  buildGeminiNpcPrompt, buildGeminiAutopilotPrompt,
  buildMetaConsolePrompt,
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
const GROK_MODEL = 'grok-4.20-non-reasoning';
let _convId = null;
let _conversationHistory = []; // Store last 5 turns for narrative continuity
export function resetConvId() { _convId = null; _conversationHistory = []; }
export function setConversationHistory(h) { _conversationHistory = Array.isArray(h) ? [...h] : []; }

function buildGrokUserMessage(turnBrief, mode) {
  const instruction = {
    notable: 'Expand the scene. 2–4 paragraphs.',
    crisis:  'Write with urgency and weight. 3–5 paragraphs.',
    death:   'Write the death scene with gravity. 4–6 paragraphs.',
    init:    'This is the opening scene of a new game. Establish the character in their immediate physical environment — body state, location, sensory details. 3–4 paragraphs.',
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
    // Detect Grok refusal — reroute to fallback narrator
    const _rc = prose.toLowerCase();
    const _refused = prose.length < 90 || [
      "i can't assist","i cannot assist","i'm unable to","i am unable to",
      "i can't help","i cannot help","i don't feel comfortable","not able to",
      "against my","my guidelines","my policy","safety guidelines","content policy"
    ].some(p => _rc.includes(p));
    if (_refused) {
      console.warn('[Grok] Refusal detected — routing to fallback narrator');
      try {
        const _orKey = typeof localStorage !== 'undefined' ? localStorage.getItem('OPENROUTER_API_KEY') : null;
        if (_orKey) {
          const _fbProse = await callFallbackNarrator(sys, usr, mode);
          if (_fbProse && _fbProse.length > 80) {
            _conversationHistory.push({ role: 'user', content: usr });
            _conversationHistory.push({ role: 'assistant', content: _fbProse });
            return _fbProse;
          }
        }
      } catch (_fe) { console.warn('[Grok] Fallback also failed:', _fe.message); }
    }

    // Add this turn to conversation history for continuity
    _conversationHistory.push({ role: 'user', content: usr });
    _conversationHistory.push({ role: 'assistant', content: prose });
    if (_conversationHistory.length > 20) _conversationHistory = _conversationHistory.slice(-20);

    window._devlog?.api(`Grok narration OK`, { model: GROK_MODEL, chars: prose.length, refusal: _refused });
    return prose;
  } catch (err) {
    window._devlog?.error('callGrok error', { message: err.message });
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
  try {
    const result = await geminiRaw(buildGeminiClassifyPrompt(input, sanitizedState));
    window._devlog?.api('Gemini classify', { action_type: result.action_type, time_cost: result.time_cost_hours, risk: result.risk_class, deltas: result.stat_deltas });
    return result;
  } catch(e) {
    window._devlog?.error('Gemini classify failed — using fallback', { error: e.message });
    return { action_type: 'unknown', time_cost_hours: 0.5, stat_deltas: {}, risk_class: 'none', location_change: null, npc_ids_involved: [] };
  }
}

export async function evaluateNpcReaction(npcContext, actionDescription, playerStats) {
  try {
    const r = await geminiRaw(buildGeminiNpcPrompt(npcContext, actionDescription, playerStats));
    window._devlog?.npc(`${npcContext.name} NPC eval`, { rel_delta: r.relationship_delta, trust_delta: r.trust_delta, summary: r.reaction_summary, flags: r.flags_to_add });
    return r;
  } catch(e) {
    window._devlog?.error(`NPC eval failed for ${npcContext?.name}`, { error: e.message });
    return null;
  }
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
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
// Tried in order — prefers models with fewer content restrictions
const FALLBACK_NARRATOR_MODELS = [
  'nousresearch/hermes-3-llama-3.1-405b:free',
  'mistralai/mistral-7b-instruct:free',
  'openchat/openchat-7b:free',
  'meta-llama/llama-3.1-8b-instruct:free',
];

async function callFallbackNarrator(systemPrompt, userMessage, mode) {
  const key = getKey('OPENROUTER_API_KEY');
  for (const model of FALLBACK_NARRATOR_MODELS) {
    try {
      const fbController = new AbortController();
      const fbTimeout = setTimeout(() => fbController.abort(), 22000);
      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        signal: fbController.signal,
        body: JSON.stringify({
          model, max_tokens: 600,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userMessage  },
          ],
        }),
      });
      clearTimeout(fbTimeout);
      if (!res.ok) { console.warn('[fallback] model', model, 'HTTP', res.status); continue; }
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content?.trim();
      if (text && text.length > 60) { console.log('[fallback] succeeded with:', model); return text; }
    } catch (e) { console.warn('[fallback] model', model, 'failed:', e.message); }
  }
  throw new Error('All fallback narrators exhausted. Check OpenRouter API key and quota.');
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
  "player": {
    "location": "string or null",
    "cash": number_or_null,
    "initial_stats": {
      "health": number_0_to_100_or_null,
      "energy": number_0_to_100_or_null,
      "hygiene": number_0_to_100_or_null,
      "mood": number_0_to_100_or_null,
      "social": number_0_to_100_or_null,
      "reputation": number_0_to_100_or_null
    }
  },
  "start_date": { "year": number_or_null, "month": number_1_to_12_or_null },
  "job": null,
  "npcs": [],
  "possessions": []
}

start_date: Extract the in-world year and month (e.g. "summer of 2018" → year:2018, month:7; "February 2020" → year:2020, month:2; "2024" → year:2024, month:null). If no date context is mentioned, return null for both fields.
initial_stats: Infer from character description ONLY — sick/injured→low health, depressed/grieving→low mood, isolated/alone→low social, filthy/homeless→low hygiene, well-rested→high energy, charismatic/popular→high reputation. Return null for any stat the lorebook does not imply. hunger and arousal are NOT included (always initialized separately). Never invent values — null is correct when unspecified.

If employed, job shape:
{ "employer": "string", "position": "string", "salary_per_cycle": number, "pay_cycle": "daily|weekly|monthly", "schedule": "e.g. Mon-Fri 8AM-5PM" }

Each NPC shape:
{
  "id": "lowercase_first_name_underscore_last",
  "name": "Full Name",
  "age": number,
  "npc_class": "intimate|household|professional|institutional",
  "relationship_type": "one of: brother|sister|mother|father|uncle|aunt|cousin|friend|best_friend|boyfriend|girlfriend|roommate|neighbor|classmate|boss|coworker|teacher|mentor|enemy|rival — use the most specific label that fits",
  "relationship_meter": number -100 to 100,
  "trust_meter": number -100 to 100,
  "traits": { "jealousy":50,"honesty":50,"patience":50,"warmth":50,"ambition":50,"impulsivity":50,"dominance":50,"openness":50 },
  "note": "one sentence about the relationship with the player"
}

Each possession shape: { "name": "string", "note": "string or null" }

NPC class rules: intimate=family/romantic/bestfriend, household=roommates/neighbors, professional=boss/coworker/teacher, institutional=gov/police/medical.
Relationship meter — use ranges, NOT fixed values. ALWAYS vary between NPCs:
  Parent positive: 55–80 | Sibling: 35–75 | Romantic: 65–90 | Close friend: 45–70 | Acquaintance: 10–30 | Stranger: 0–15 | Rival: -40 to -70
DO NOT assign the same relationship_meter to multiple NPCs. Vary based on any context clue, even small ones (older/younger, closer/distant, mentioned positively/negatively).
Traits: NEVER return all-50 traits for any NPC. Vary each meaningfully — infer from age, role, implied personality. An older brother ≠ a younger one. A mother ≠ a father. Each trait must differ across NPCs.
Extract EVERY named person mentioned.
CRITICAL: Also extract clearly implied household members or close relationships even if only partially named. Examples: "I live with my two brothers Jay and Ray (20,21)" → extract Jay AND Ray as separate NPCs. "my parents" → extract as father/mother with ids parent_father/parent_mother. "my best friend Marco" → extract Marco. "my girlfriend" → extract with id girlfriend_unnamed and name "Girlfriend". Do not leave anyone the player clearly lives with or is emotionally close to unextracted.
CRITICAL: Do NOT extract the player character themselves (the "you" / protagonist / main character) as an NPC. Only extract OTHER people.`;

  // Try Gemini first
  try {
    const res = await fetch(`${GEMINI_URL}?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 1200, response_mime_type: 'application/json' },
      }),
    });
    if (res.ok) {
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
      const parsed = JSON.parse(text);
      if (parsed?.player || parsed?.npcs?.length) {
        console.log('[lorebook] Gemini parsed OK:', parsed?.npcs?.length ?? 0, 'NPCs');
        return parsed;
      }
    } else {
      console.warn('[lorebook] Gemini HTTP', res.status);
    }
  } catch (e) {
    console.warn('[lorebook] Gemini failed:', e.message);
  }

  // Groq fallback — if Gemini fails or returns empty
  const groqKey = localStorage.getItem('GROQ_API_KEY');
  if (groqKey) {
    try {
      console.log('[lorebook] trying Groq fallback...');
      const gr = await fetch(GROQ_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          max_tokens: 1200,
        }),
      });
      if (gr.ok) {
        const text = (await gr.json()).choices?.[0]?.message?.content ?? '{}';
        const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
        if (parsed?.player || parsed?.npcs?.length) {
          console.log('[lorebook] Groq fallback parsed OK:', parsed?.npcs?.length ?? 0, 'NPCs');
          return parsed;
        }
      }
    } catch (e) {
      console.warn('[lorebook] Groq fallback failed:', e.message);
    }
  }

  console.warn('[lorebook] all parsers failed — world starts empty');
  return null;
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

Use the person's first name in lowercase as the key. Infer traits CREATIVELY — never return all-50 for any NPC. Even without explicit personality clues, infer from age (younger = higher impulsivity), role (older sibling = higher dominance/ambition), relationship dynamics (close but tense = lower patience), and implied character. Each NPC must be meaningfully different from all others in at least 3 traits.`;

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

HARD GATES — return has_initiative:false if ANY apply:
- NPC's current_task is "sleeping" or "morning_prep" — they are asleep, cannot message
- NPC's available is false AND interruptible is false — they are occupied
- NPC's relationship_meter is below 20
- The player and NPC are in the same physical location (they interact in person, not by message)

Soft rules (only if hard gates all pass):
- Remote contact (text/call) only if current_task is "leisure" or "winding_down"
- The brief must be specific to THIS NPC's personality and relationship — NEVER generic ("hey just checking in", "what's up" = forbidden)
- A concrete, scene-grounded reason must exist for the NPC to reach out NOW specifically

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

  const prompt = `Analyze this text and determine whether a specific human person had a meaningful interaction worth tracking as an ongoing character.

Text: "${playerInput.slice(0, 400)}"

SIGNIFICANCE LEVELS — assign one:
"significant" — Had real back-and-forth conversation, physical contact, emotional exchange, or will clearly appear again. Worth creating an ongoing record.
"passing" — Was briefly present, said hello, walked by, or was mentioned without direct sustained interaction.
"none" — No distinct person, or the entity is non-human.

HARD FILTERS — return found:false immediately if any apply:
- Animals of any kind (insects, pets, wildlife — including flies, mosquitoes, dogs, cats)
- Objects, furniture, appliances, fixtures, or any inanimate thing
- An unnamed crowd, group, or collection of people without individual distinction
- A person only seen or mentioned without any interaction beyond a glance or passing

FAMILY TERMS always refer to humans — extract mother, father, brother, sister, etc. even if lowercase.

Return ONLY valid JSON, no markdown:
{
  "found": boolean,
  "significance": "significant" | "passing" | "none",
  "id": "unique lowercase identifier using name or specific role",
  "name": "their name if given, otherwise their specific role — never a generic label",
  "age": estimated_number_or_null,
  "npc_class": "intimate|household|professional|institutional",
  "traits": {
    "jealousy": number,
    "honesty": number,
    "patience": number,
    "warmth": number,
    "ambition": number,
    "impulsivity": number,
    "dominance": number,
    "openness": number
  },
  "relationship_meter": number,
  "trust_meter": number
}

TRAIT RULES — inference only, no defaults or templates:
- Each trait must be inferred independently from how the person spoke, acted, or was described
- Age, role, and the tone of the interaction all imply different trait values — use them
- Every trait must fall between 10 and 90; values outside that range only when context is extreme
- At least four traits must differ from each other by more than 15 points — if they all look similar, you have not inferred enough
- relationship_meter: infer from the interaction's emotional tone — fresh stranger contacts near 0, warmly received interactions toward low positives, hostile toward negatives
- trust_meter: typically slightly lower than relationship_meter for new contacts

If significance is not "significant", return found:false rather than creating a low-value record.`;

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

// ─── WORLD ENRICHMENT ─────────────────────────────────────────────────────────
// Always called during init. Generates creative world details even from empty lorebook.

export async function enrichWorldDetails(lorebook, ws) {
  const groqKey = localStorage.getItem('GROQ_API_KEY');
  if (!groqKey) return null;

  const npcNames  = Object.values(ws.npcs ?? {}).map(n => `${n.name} (${n.relationship_type ?? n.npc_class}, age ${n.age})`).join(', ') || 'none';
  const startYear = ws.sim_time ? new Date(ws.sim_time).getFullYear() : new Date().getFullYear();
  const hasJob    = !!ws.job;
  const hasSchool = !!ws.school;
  const lbText    = lorebook?.trim() || '';

  const prompt = `You are a world-building AI for a Filipino life simulation game. Generate complete, vivid details for this character. Fill ALL required fields — never skip or return null for required fields.

CHARACTER: ${ws.player?.name ?? 'Character'}, age ${ws.player?.age ?? 18}
YEAR: ${startYear}
${lbText ? `LOREBOOK:\n"""\n${lbText.slice(0, 1400)}\n"""` : 'NO LOREBOOK PROVIDED — invent a complete, believable Filipino life based on the name and age alone. Be creative and specific.'}
KNOWN NPCs: ${npcNames}
JOB ALREADY PARSED: ${hasJob ? 'YES — ' + (ws.job?.position ?? '') + ' at ' + (ws.job?.employer ?? '') : 'NO'}
SCHOOL ALREADY PARSED: ${hasSchool ? 'YES — ' + (ws.school?.name ?? '') : 'NO'}

Return ONLY valid JSON. No markdown. Fill every required field — never return null for required fields.

{
  "location_name": "REQUIRED: specific Philippine address — sitio/street, barangay, municipality, province. Always generate, never null.",
  "setting_description": "REQUIRED: 3-4 vivid sentences describing the home — layout, furniture, sounds, smells, economic class markers. Always generate, never null.",
  "school": null,
  "job_enrichment": null,
  "starting_possessions": [],
  "npc_descriptions": {},
  "npc_schedules": {}
}

GENERATION RULES — read carefully:

LOCATION: Always generate a specific Philippine address. If lorebook names a place, expand it with street/sitio-level detail. If no place mentioned, invent one plausibly matching the character's name and cultural background.

SETTING_DESCRIPTION: Always describe the home vividly. Match the economic class implied by the lorebook (or default to modest lower-middle class). Never return null or empty string.

SCHOOL — decide based on age and lorebook:
  - Generate IF: character is age 14–22 AND lorebook does NOT say dropped out / no school / graduated / finished school
  - When NO lorebook: age 18 → default to Grade 12 or 1st year college (most common in Philippines for this age)
  - When SCHOOL ALREADY PARSED = YES: return null (don't override)
  - Schema: { "name": "realistic Philippine school name", "grade_level": "e.g. Grade 12 - HUMSS Strand OR 1st Year - BS Criminology", "schedule": "Mon-Fri 7:00 AM – 4:30 PM", "status": "active" }

JOB_ENRICHMENT — reason about it:
  - When JOB ALREADY PARSED = YES: return enrichment details to fill missing gaps — { "platform_or_employer": "...", "position": "specific job title", "description": "day-to-day work in 1-2 sentences", "schedule": "work schedule", "earnings": "e.g. ₱550/day", "days_active": realistic_number }
  - When JOB ALREADY PARSED = NO AND lorebook says 'no job/unemployed/not working': return null
  - When JOB ALREADY PARSED = NO AND character is full-time student (school generated above or from lorebook): REASON — does this student have a small side income? (part-time, tutoring, online selling, sari-sari store help, gigs). For most Filipino students age 16-19, maybe a small gig or none. For age 20-22, more likely a part-time job. Use judgment. Generate a small job OR return null if genuinely student-only.
  - When JOB ALREADY PARSED = NO AND character is NOT a full-time student AND lorebook doesn't say unemployed: Generate a plausible entry-level or informal job matching their age and setting.
  - days_active: be realistic — a fresh 18-year-old cannot have 500 days of employment history. Max 60-180 days for first jobs.

STARTING_POSSESSIONS — REQUIRED, never empty:
  - Generate 5-7 items matching the economic class
  - Include: a phone (specify model/condition), a bag, at least one clothing item, one hygiene item, and 2-3 items specific to their lifestyle (student: notebooks, lunchbox; worker: work shoes, ID lanyard; gamer: specific device)
  - Schema: [{ "name": "item", "condition": "physical state in one phrase", "note": "what it is for or its story", "value_peso": null, "acquired_method": "bought|gifted|inherited|found" }]

NPC_DESCRIPTIONS — REQUIRED if NPCs exist, never empty:
  - Generate for EVERY NPC listed in KNOWN NPCs
  - Key: first name in lowercase only (e.g. "mark", "jenny", "mama", "papa")
  - Value: 2-3 sentences covering: (1) physical appearance, (2) a specific habit or mannerism, (3) their specific role in the character's life
  - Add concrete detail not in the lorebook — physical features, how they speak, what they always do
  - Never restate the lorebook verbatim

NPC_SCHEDULES — REQUIRED if NPCs exist, never empty object when NPCs are listed:
  - Generate a PERSONALIZED weekly schedule for EVERY NPC in KNOWN NPCs
  - Key: first name in lowercase (same as npc_descriptions keys)
  - Value: { "weekday_routine": [...blocks], "weekend_routine": [...blocks] }
  - Each block: { "start_hour": number, "end_hour": number, "task": string, "interruptible": boolean, "location": string }
  - Blocks MUST be contiguous and cover ALL 24 hours exactly (start at 0, end at 24, no gaps, no overlaps)
  - location values: "home" (their own home), "workplace", "school", "transit", "outside"
  - REASON from each NPC's actual role — never use a generic template:
    * Construction/manual worker: up 5am, work 6am-5pm at workplace, commute 5-6pm, leisure/home 6-10pm, sleep 10pm
    * Housewife managing home store: up 5am, home duties + store all day at "home" (NEVER "workplace"), wind down 9pm, sleep 10pm
    * Student only: up 5-6am, school 7am-4pm at school, commute 4-5pm, leisure home 5-10pm, sleep 10pm
    * Student + part-time job: school block + commute + part_time_work block (3-4 hrs at workplace or outside), home, sleep
    * Unemployed/at-home: up 7-8am, home leisure, errands 9-11am outside, home the rest, sleep 10-11pm
    * Office worker: up 6am, commute 7-8am, work 8-5pm at workplace, commute 5-6pm, home leisure, sleep 10pm
  - Weekend routines should differ: no school/work blocks unless role requires (e.g. retail, construction sometimes Sat)
  - interruptible: false for sleeping, morning_prep, work, school, commuting. true for leisure, errands, winding_down, studying, store_duty`;

  const tryGroq = async (model) => {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.72,
        max_tokens: 2000,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = (await res.json()).choices?.[0]?.message?.content ?? '{}';
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  };

  // Try smarter model first, fall back to fast model
  for (const model of ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant']) {
    try {
      const parsed = await tryGroq(model);
      if (parsed.location_name || parsed.setting_description || parsed.starting_possessions?.length) {
        console.log(`[enrich] ${model} OK — loc: ${parsed.location_name?.slice(0,40)} | poss: ${parsed.starting_possessions?.length} | school: ${parsed.school?.name}`);
        return parsed;
      }
    } catch (e) { console.warn(`[enrich] ${model} failed:`, e.message); }
  }

  // Gemini fallback
  const gemKey = localStorage.getItem('GEMINI_API_KEY');
  if (gemKey) {
    try {
      const res = await fetch(`${GEMINI_URL}?key=${gemKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.72, maxOutputTokens: 1400, response_mime_type: 'application/json' },
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
        const parsed = JSON.parse(text);
        console.log('[enrich] Gemini fallback OK — loc:', parsed.location_name?.slice(0,40));
        return parsed;
      }
    } catch (e) { console.warn('[enrich] Gemini fallback failed:', e.message); }
  }

  console.warn('[enrich] all models failed');
  return null;
}

// ─── NARRATIVE STATE EXTRACTOR ────────────────────────────────────────────────
// After Grok generates prose, Groq checks for implied state changes
// (NPC quits job, player moves, NPC enrolls in school, etc.)
export async function extractNarrativeStateChanges(prose, worldState) {
  const groqKey = localStorage.getItem('GROQ_API_KEY');
  if (!groqKey || !prose || prose.length < 80) return null;
  const npcList = Object.values(worldState.npcs ?? {})
    .filter(n => n.status === 'active')
    .map(n => `${n.id}: ${n.name} (${n.relationship_type ?? n.npc_class})`)
    .join('\n');
  const prompt = `Analyze this simulation narration for DEFINITIVELY STATED changes only.

Narration: "${prose.slice(0, 800)}"

Current context:
- Player job: ${worldState.job ? `${worldState.job.position ?? 'worker'} at ${worldState.job.employer ?? 'unknown'}` : 'unemployed'}
- Player school: ${worldState.school?.name ?? 'none'} (${worldState.school?.status ?? 'n/a'})
- Player location: ${worldState.player?.location ?? 'unknown'}
- Active NPCs:
${npcList || 'none'}

RULES: Only extract if EXPLICITLY AND DEFINITIVELY stated in the narration. "might leave" = NO. "decides to quit" = YES. "moves to Manila" = YES.

Return ONLY valid JSON:
{
  "has_changes": boolean,
  "player_changes": {
    "location": string_or_null,
    "job_lost": boolean,
    "job_new_employer": string_or_null,
    "school_quit": boolean,
    "school_enrolled": string_or_null
  },
  "npc_changes": [
    {
      "npc_id": "exact_id_from_list_above",
      "job_lost": boolean,
      "job_new_employer": string_or_null,
      "school_quit": boolean,
      "school_enrolled": string_or_null,
      "status": "active|deceased|moved_away|null"
    }
  ]
}

Set has_changes: true ONLY if you found at least one definitive change.`;
  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
      body: JSON.stringify({ model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: prompt }], temperature: 0.0, max_tokens: 350 }),
    });
    if (!res.ok) return null;
    const text = (await res.json()).choices?.[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    return parsed.has_changes ? parsed : null;
  } catch { return null; }
}

// ─── CONTEXT-AWARE NPC FLAG EVALUATION ────────────────────────────────────────
export async function evaluateNpcFlagsInContext(npc, prose, hoursElapsed) {
  const groqKey = localStorage.getItem('GROQ_API_KEY');
  if (!groqKey || !npc.active_flags?.length) return [];
  const prompt = `You evaluate whether NPC behavioral flags remain contextually valid after a new scene.

NPC: ${npc.name} (${npc.relationship_type ?? npc.npc_class ?? 'person'})
Active flags: ${npc.active_flags.join(', ')}
Hours elapsed this turn: ${hoursElapsed.toFixed(1)}
Scene just narrated: "${prose.slice(0, 500)}"

Remove a flag if: the scene resolves the state (reconciliation removes "uncomfortable"), the underlying cause is clearly gone, or enough time passed and nothing reinforces it.
Keep a flag if: the scene reinforces the emotional state, cause is unresolved, or too little time has passed.

Return ONLY valid JSON:
{ "flags_to_remove": ["flag1", "flag2"] }

Empty array if nothing should be removed.`;

  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 80,
      }),
    });
    if (!res.ok) return [];
    const text = (await res.json()).choices?.[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    return Array.isArray(parsed.flags_to_remove) ? parsed.flags_to_remove : [];
  } catch { return []; }
}

// ─── META CONSOLE ─────────────────────────────────────────────────────────────
const GROQ_CONSOLE_MODELS = ['llama-3.3-70b-versatile', 'llama-3.1-70b-versatile', 'llama-3.1-8b-instant'];

export async function callMetaConsole(messages, gameState) {
  const systemPrompt = buildMetaConsolePrompt(gameState);
  window._devlog?.patch('Console API call', { models: 'grok→groq→gemini', msgs: messages.length });

  // Try Grok FIRST — far better instruction-following for SIM_PATCH format
  const grokKey = localStorage.getItem('GROK_API_KEY');
  if (grokKey) {
    try {
      const res = await fetch(GROK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${grokKey}` },
        body: JSON.stringify({
          model: GROK_MODEL,
          max_tokens: 800,
          messages: [{ role: 'system', content: systemPrompt }, ...messages.slice(-20)],
          stream: false,
        }),
      });
      if (res.ok) {
        const text = (await res.json()).choices?.[0]?.message?.content?.trim();
        if (text && text.length > 20) {
          window._devlog?.patch('Console: Grok responded', { chars: text.length, hasPatch: /<SIM_PATCH>/i.test(text) });
          return text;
        }
      } else {
        window._devlog?.error('Console: Grok HTTP error', { status: res.status });
      }
    } catch (e) {
      window._devlog?.error('Console: Grok exception', { error: e.message });
    }
  }

  // Groq fallback
  const groqKey = localStorage.getItem('GROQ_API_KEY');
  if (groqKey) {
    for (const model of GROQ_CONSOLE_MODELS) {
      try {
        const res = await fetch(GROQ_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
          body: JSON.stringify({
            model,
            messages: [{ role: 'system', content: systemPrompt }, ...messages.slice(-20)],
            temperature: 0.65,
            max_tokens: 800,
          }),
        });
        if (res.ok) {
          const text = (await res.json()).choices?.[0]?.message?.content?.trim();
          if (text) {
            window._devlog?.patch(`Console: Groq(${model}) responded`, { chars: text.length, hasPatch: /<SIM_PATCH>/i.test(text) });
            return text;
          }
        }
      } catch (e) {
        window._devlog?.error(`Console: Groq(${model}) failed`, { error: e.message });
      }
    }
  }

  // Gemini last resort
  const gemKey = localStorage.getItem('GEMINI_API_KEY');
  if (gemKey) {
    try {
      const conversation = messages.slice(-10).map(m => `${m.role === 'user' ? 'Player' : 'Assistant'}: ${m.content}`).join('\n\n');
      const res = await fetch(`${GEMINI_URL}?key=${gemKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${systemPrompt}\n\n${conversation}\n\nAssistant:` }] }],
          generationConfig: { temperature: 0.65, maxOutputTokens: 800 },
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (text) {
          window._devlog?.patch('Console: Gemini responded', { chars: text.length });
          return text;
        }
      }
    } catch (e) {
      window._devlog?.error('Console: Gemini failed', { error: e.message });
    }
  }

  throw new Error('No API available for console. Add a Grok, Groq, or Gemini key in Settings.');
}
      try {
        const res = await fetch(GROQ_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
          body: JSON.stringify({
            model,
            messages: [{ role: 'system', content: systemPrompt }, ...messages.slice(-20)],
            temperature: 0.65,
            max_tokens: 700,
          }),
        });
        if (res.ok) {
          const text = (await res.json()).choices?.[0]?.message?.content?.trim();
          if (text) return text;
        }
      } catch {}
    }
  }

  const gemKey = localStorage.getItem('GEMINI_API_KEY');
  if (gemKey) {
    try {
      const conversation = messages.slice(-10).map(m => `${m.role === 'user' ? 'Player' : 'Assistant'}: ${m.content}`).join('\n\n');
      const res = await fetch(`${GEMINI_URL}?key=${gemKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${systemPrompt}\n\n${conversation}\n\nAssistant:` }] }],
          generationConfig: { temperature: 0.65, maxOutputTokens: 700 },
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (text) return text;
      }
    } catch {}
  }

  const grokKey = localStorage.getItem('GROK_API_KEY');
  if (grokKey) {
    try {
      const res = await fetch(GROK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${grokKey}` },
        body: JSON.stringify({
          model: GROK_MODEL,
          max_tokens: 700,
          messages: [{ role: 'system', content: systemPrompt }, ...messages.slice(-20)],
          stream: false,
        }),
      });
      if (res.ok) return (await res.json()).choices?.[0]?.message?.content?.trim() ?? '';
    } catch {}
  }

  throw new Error('No API available. Add a Groq, Gemini, or Grok key in Settings.');
}

