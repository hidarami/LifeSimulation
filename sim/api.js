// api.js — API calls
// Fix #3: Gemini autopilot style injection
// Fix #4: FALLBACK_ON_OUTAGE_ONLY — fallbacks only on HTTP failures, not load balancing
'use strict';

import {
  buildGrokNarrationPrompt, buildGeminiClassifyPrompt,
  buildGeminiNpcPrompt, buildGeminiAutopilotPrompt,
  buildMetaConsolePrompt, buildSceneContextPrompt, buildLorebookCompressionPrompt,
} from './prompt.js';
import {
  detectProvider, dispatchChat, dispatchJSON,
  getNarratorSlot, getClassifierSlot, getHelperSlot,
  getNarratorFallbacks, getFallbackSlots, getEnricherSlot,
  PROVIDER_ENDPOINTS, getProviderDisplayName,
} from './providers.js';

// ─── BACKGROUND MODEL CONSTANTS ──────────────────────────────────────────────
// Single place to update when providers rename or retire models.
// Narrator / classifier use the slot system; these are for lightweight background tasks only.
const BG_GROQ_FAST   = 'llama-3.1-8b-instant';     // compression, flag checks, NPC extraction
const BG_GROQ_SMART  = 'llama-3.3-70b-versatile';  // console chat, NPC trait depth, enrichment
const BG_GEMINI_FAST = 'gemini-2.0-flash';          // Gemini JSON tasks and autopilot

// ─── CONFIG ───────────────────────────────────────────────────────────────────
// Fix #4: true means fallback is only triggered on genuine outages
const FALLBACK_ON_OUTAGE_ONLY = true;

// ─── PROVIDER COOLDOWN (session-level, resets on page reload) ────────────────
const _COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const _providerCooldowns = new Map();
function _markCooling(provider, reason) {
  const _until = Date.now() + _COOLDOWN_MS;
  _providerCooldowns.set(provider, { until: _until, reason });
  window._devlog?.system(`${provider} in cooldown 5min after ${reason}. Retry after ${new Date(_until).toLocaleTimeString()}.`);
}
function _isCooling(provider) {
  const c = _providerCooldowns.get(provider);
  if (!c) return false;
  if (Date.now() >= c.until) { _providerCooldowns.delete(provider); return false; }
  window._devlog?.system(`${provider} still in cooldown — routing to next slot.`);
  return true;
}
function _shouldCool(errMsg) {
  return /HTTP\s*(404|503)\b/.test(errMsg ?? '');
}

function getKey(name) {
  const k = localStorage.getItem(name);
  if (!k) throw new Error(`API key not set: ${name}. Open ⚙ Settings.`);
  return k;
}

// ─── GROK ─────────────────────────────────────────────────────────────────────
let _convId = null;
let _conversationHistory = []; // Store last 5 turns for narrative continuity
export function resetConvId() { _convId = null; _conversationHistory = []; }
export function setConversationHistory(h) { _conversationHistory = Array.isArray(h) ? [...h] : []; }

function buildGrokUserMessage(turnBrief, mode) {
  const instruction = {
    notable:   'Expand the scene. 1–3 paragraphs.',
    crisis:    'Write with urgency and weight. 2–3 paragraphs.',
    death:     'Write the death scene with gravity. 4–5 paragraphs.',
    legacy:    'Write a post-death reflection from the world\'s perspective: how the death of the player character ripples outward. Show the successor NPC\'s immediate reaction and the weight they now carry. Do NOT resurrect the deceased. 3–5 paragraphs.',
    pov_shift: 'This is the first scene from a new player POV after the previous character died. Establish the new POV character — their location, body, and the immediate emotional weight of what they know happened. Do not rush past the loss. 2–3 paragraphs.',
    init:      'This is the opening scene of a new game. Establish the character in their immediate physical environment at the exact time shown in sim_time_formatted. CRITICAL: Do NOT default to waking up or morning scenes unless sim_time_formatted shows a time before 9:00 AM. If it shows afternoon, noon, or evening, the character is already mid-day — scene must reflect that hour with appropriate ambient sounds, light, activity, and body state. Never open with the character just having woken up unless the sim time genuinely warrants it. 2–3 paragraphs.',
  }[mode] ?? '1–2 paragraphs.';
  return JSON.stringify({ ...turnBrief, narration_instruction: instruction });
}

export async function callGrok(turnBrief, mode, flags = {}) {
  // Fix 3: Use compressed lorebook if available, fall back to raw
  const lorebook  = typeof localStorage !== 'undefined'
    ? (localStorage.getItem('LOREBOOK_COMPRESSED') || localStorage.getItem('LOREBOOK') || '')
    : '';
  const locale    = typeof localStorage !== 'undefined' ? (localStorage.getItem('LOCALE')    ?? 'Philippines') : 'Philippines';
  const language  = typeof localStorage !== 'undefined' ? (localStorage.getItem('LANGUAGE')  ?? 'Tagalog') : 'Tagalog';
  // Fix 1: Dynamic prompt — only includes sections relevant to this turn
  const sys = buildGrokNarrationPrompt(lorebook, locale, language, flags);
  const usr = buildGrokUserMessage(turnBrief, mode);

  const { key, provider, model } = getNarratorSlot();
  if (!key || !provider) throw new Error(`Narrator API key not configured. Open ⚙ Settings → Narrator Key.`);

  const cfg = PROVIDER_ENDPOINTS[provider];
  window._devlog?.api(`Narrator call`, { provider, model: model || cfg?.default_narrator_model });

  // Fix 2: scene_context in turn brief replaces multi-turn conversation history
  const messages = [
    { role: 'system', content: sys },
    { role: 'user', content: usr },
  ];

  const _t0 = Date.now();
  let prose;
  if (_isCooling(provider)) {
    window._devlog?.system(`Narrator primary (${provider}) in cooldown — going to fallback.`);
    prose = await _callNarratorFallback(sys, usr);
  } else {
    try {
      prose = await dispatchChat(provider, key, model, messages, 600, 30000);
      _providerCooldowns.delete(provider);
    } catch (err) {
      window._devlog?.error('Narrator primary failed', { provider, error: err.message });
      if (_shouldCool(err.message)) _markCooling(provider, err.message.match(/HTTP\s*\d+/)?.[0] ?? 'error');
      const isOutage = !navigator.onLine || err.message?.includes('429') || err.message?.includes('502') || err.message?.includes('503') || err.message === 'Failed to fetch';
      if (FALLBACK_ON_OUTAGE_ONLY && !isOutage) {
        throw new Error(`Narrator failed (${err.message}) — check your ${getProviderDisplayName(provider)} API key and model.`);
      }
      console.warn('[narrator] Primary failed, trying fallbacks:', err.message);
      prose = await _callNarratorFallback(sys, usr);
    }
  }

  const _rc = prose.toLowerCase();
  const _refused = prose.length < 90 || [
    "i can't assist","i cannot assist","i'm unable to","i am unable to",
    "i can't help","i cannot help","i don't feel comfortable","not able to",
    "against my","my guidelines","my policy","safety guidelines","content policy"
  ].some(p => _rc.includes(p));

  if (_refused) {
    window._devlog?.api('Narrator refusal detected — trying fallback', { provider });
    try {
      const _fbProse = await _callNarratorFallback(sys, usr);
      if (_fbProse && _fbProse.length > 80) {
        return _fbProse;
      }
    } catch (_fe) { window._devlog?.error('Narrator fallback also refused/failed', { error: _fe.message }); }
  }

  window._devlog?.api(`Narrator OK`, { provider, model: model || cfg?.default_narrator_model, elapsed_ms: Date.now()-_t0, chars: prose.length });
  return prose;
}

async function _callNarratorFallback(systemPrompt, userMessage) {
  // Try configured fallback slots first (FIX 5C)
  const configuredFallbacks = getFallbackSlots('narrator');
  for (const { key, provider, model } of configuredFallbacks) {
    if (!key || !provider) continue;
    try {
      const msgs = [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }];
      const text = await dispatchChat(provider, key, model, msgs, 600, 22000);
      if (text && text.length > 60) {
        window._devlog?.api(`Narrator fallback slot OK`, { provider, model });
        return text;
      }
    } catch (e) { window._devlog?.error(`Narrator fallback slot failed`, { provider, model, error: e.message }); }
  }
  // Fall back to hardcoded fallbacks
  const fallbacks = getNarratorFallbacks();
  for (const { key, provider, model } of fallbacks) {
    try {
      const msgs = [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }];
      const text = await dispatchChat(provider, key, model, msgs, 600, 22000);
      if (text && text.length > 60) {
        window._devlog?.api(`Narrator hardcoded fallback OK`, { provider, model });
        return text;
      }
    } catch (e) { window._devlog?.error(`Narrator hardcoded fallback failed`, { provider, model, error: e.message }); }
  }
  throw new Error('All narrator fallbacks exhausted. Configure fallback slots or OpenRouter/Groq keys in ⚙ Settings.');
}

// ─── SCENE CONTEXT EXTRACTOR ──────────────────────────────────────────────────
// Post-narration: Groq extracts structured scene state to replace conversation history.
export async function extractSceneContext(prose, location, activeNpcs) {
  const helper = getHelperSlot();
  if (!helper.key || !helper.provider || !prose || prose.length < 60) return null;
  const npcNames = (activeNpcs ?? [])
    .filter(n => n.status === 'active' && n.significance >= 1 && n.name)
    .map(n => n.name);
  try {
    const parsed = await dispatchJSON(
      helper.provider, helper.key, helper.model,
      buildSceneContextPrompt(prose, location, npcNames), 200
    );
    if (!parsed?.ongoing_thread) return null;
    window._devlog?.system('Scene context extracted', {
      location, thread: (parsed.ongoing_thread ?? '').slice(0, 60),
    });
    return parsed;
  } catch { return null; }
}

// ─── LOREBOOK COMPRESSOR ──────────────────────────────────────────────────────
// One-time at init. Groq compresses raw lorebook → dense factual shorthand.
// Saved to LOREBOOK_COMPRESSED; callGrok uses this on every subsequent call.
export async function compressLorebook(lorebook, playerName, npcNames = []) {
  if (!lorebook?.trim() || lorebook.trim().length < 80) return;
  const helper = getHelperSlot();
  if (!helper.key || !helper.provider) return;
  try {
    const compressed = await dispatchChat(
      helper.provider, helper.key, helper.model,
      [{ role: 'user', content: buildLorebookCompressionPrompt(lorebook, playerName, npcNames) }],
      500, 15000
    );
    if (compressed?.trim().length > 40 && compressed.trim().length < lorebook.length) {
      localStorage.setItem('LOREBOOK_COMPRESSED', compressed.trim());
      window._devlog?.system('Lorebook compressed', {
        original: lorebook.length + 'c',
        result: compressed.trim().length + 'c',
        saved: Math.round((1 - compressed.trim().length / lorebook.length) * 100) + '%',
      });
    }
  } catch (e) { window._devlog?.error('Lorebook compression failed', { error: e.message }); }
}

// ─── GEMINI ───────────────────────────────────────────────────────────────────
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${BG_GEMINI_FAST}:generateContent`;
const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions';

async function geminiRaw(prompt, maxTokens = 400) {
  const { key, provider, model } = getClassifierSlot();
  if (!key || !provider) throw new Error('Classifier API key not configured. Open ⚙ Settings → Classifier Key.');
  if (_isCooling(provider)) {
    window._devlog?.system(`Classifier primary (${provider}) in cooldown — trying fallback slots.`);
    // Try configured fallback slots first (FIX 5C)
    const configuredFallbacks = getFallbackSlots('classifier');
    for (const { key: fbKey, provider: fbProvider, model: fbModel } of configuredFallbacks) {
      if (!fbKey || !fbProvider || fbProvider === provider) continue;
      try {
        return await dispatchJSON(fbProvider, fbKey, fbModel, prompt, maxTokens);
      } catch (e) { window._devlog?.error(`Classifier fallback slot failed`, { provider: fbProvider, error: e.message }); }
    }
    // Fall back to helper slot
    const helper = getHelperSlot();
    if (helper.key && helper.provider && helper.provider !== provider) {
      return dispatchJSON(helper.provider, helper.key, helper.model, prompt, maxTokens);
    }
    throw new Error(`Classifier (${provider}) in cooldown and no fallback available.`);
  }
  try {
    const result = await dispatchJSON(provider, key, model, prompt, maxTokens);
    _providerCooldowns.delete(provider);
    return result;
  } catch (e) {
    if (_shouldCool(e.message)) _markCooling(provider, e.message.match(/HTTP\s*\d+/)?.[0] ?? 'error');
    if (e.message === 'GEMINI_RATE_LIMIT' || e.message?.includes('429')) {
      // Try configured fallback slots first (FIX 5C)
      const configuredFallbacks = getFallbackSlots('classifier');
      for (const { key: fbKey, provider: fbProvider, model: fbModel } of configuredFallbacks) {
        if (!fbKey || !fbProvider || fbProvider === provider) continue;
        try {
          return await dispatchJSON(fbProvider, fbKey, fbModel, prompt, maxTokens);
        } catch (fe) { window._devlog?.error(`Classifier fallback slot failed`, { provider: fbProvider, error: fe.message }); }
      }
      // Fall back to helper slot
      const helper = getHelperSlot();
      if (helper.key && helper.provider && helper.provider !== provider) {
        window._devlog?.api('Classifier rate-limited, falling back to helper slot', { helper_provider: helper.provider });
        return dispatchJSON(helper.provider, helper.key, helper.model, prompt, maxTokens);
      }
    }
    throw e;
  }
}

export async function classifyAction(input, sanitizedState) {
  const _t0 = Date.now();
  try {
    const result = await geminiRaw(buildGeminiClassifyPrompt(input, sanitizedState));
    window._devlog?.api('Gemini classify', { action_type: result.action_type, time_cost: result.time_cost_hours, risk: result.risk_class, deltas: result.stat_deltas, elapsed_ms: Date.now()-_t0 });
    return result;
  } catch(e) {
    window._devlog?.error('Gemini classify failed — using fallback', { error: e.message });
    return { action_type: 'unknown', time_cost_hours: 0.5, stat_deltas: {}, risk_class: 'none', location_change: null, npc_ids_involved: [] };
  }
}

export async function evaluateNpcReaction(npcContext, actionDescription, playerStats) {
  const _t0 = Date.now();
  try {
    const r = await geminiRaw(buildGeminiNpcPrompt(npcContext, actionDescription, playerStats));
    window._devlog?.npc(`${npcContext.name} NPC eval`, { rel_delta: r.relationship_delta, trust_delta: r.trust_delta, summary: r.reaction_summary, flags: r.flags_to_add, elapsed_ms: Date.now()-_t0 });
    return r;
  } catch(e) {
    window._devlog?.error(`NPC eval failed for ${npcContext?.name}`, { error: e.message });
    return null;
  }
}

// Fix #3: autopilot narration — Gemini with strict style guide; prose mode (no JSON)
export async function callGeminiAutopilot(sanitizedState, hours, activityLabel) {
  const prompt = buildGeminiAutopilotPrompt(sanitizedState, hours, activityLabel);
  const msgs   = [{ role: 'user', content: prompt }];
  const hrLabel = hours >= 1 ? `${hours}h` : `${Math.round(hours * 60)}min`;

  // Priority: helper (Groq) → classifier → narrator — autopilot is a cheap task
  const slots = [getHelperSlot(), getClassifierSlot(), getNarratorSlot()];
  const _seenProviders = new Set();
  for (const { key, provider, model } of slots) {
    if (!key || !provider || _seenProviders.has(provider)) continue;
    _seenProviders.add(provider);
    try {
      const cfg = PROVIDER_ENDPOINTS[provider];
      const useModel = model || cfg?.default_helper_model || null;
      const text = await dispatchChat(provider, key, useModel, msgs, 150, 12000);
      if (text && text.length > 20) return text;
    } catch (e) { window._devlog?.error?.('dispatch fallback failed', e ?? {}); }
  }
  return `${hrLabel} passed.`;
}

// Fix #1: session compression is now optional flavor, not required continuity
export async function compressSessionContext(last10Events) {
  if (!last10Events?.length) return '';
  const prompt = `Summarize these simulation events in 1–2 sentences of atmospheric flavor only. Do not add facts not present in the events. Output only the summary:\n\n${last10Events.map((e, i) => `${i + 1}. ${e}`).join('\n')}`;
  const helper = getHelperSlot();
  if (!helper.key || !helper.provider) return '';
  try {
    const text = await dispatchChat(helper.provider, helper.key, helper.model,
      [{ role: 'user', content: prompt }], 80, 12000);
    return text?.trim() ?? '';
  } catch { return ''; }
}

// Fallback narrator — handled by _callNarratorFallback (near callGrok) via providers.js

// ─── LOREBOOK PARSER ──────────────────────────────────────────────────────────
export async function parseLorebookToWorldState(lorebook) {
  const _clsSlot = getClassifierSlot();
  const _hlpSlot = getHelperSlot();
  if (!_clsSlot.key && !_hlpSlot.key) {
    console.warn('[lorebook] No classifier or helper key configured');
    return null;
  }

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

  // Build ordered slot list: classifier first (best JSON quality), then helper as fallback
  const _parseSlots = [];
  if (_clsSlot.key && _clsSlot.provider) _parseSlots.push({ ..._clsSlot, label: 'classifier' });
  if (_hlpSlot.key && _hlpSlot.provider) _parseSlots.push({ ..._hlpSlot, label: 'helper' });
  // Dedupe by provider+model so we don't call the same endpoint twice
  const _seenParse = new Set();
  for (const { key, provider, model, label } of _parseSlots) {
    const _pk = `${provider}/${model || 'default'}`;
    if (_seenParse.has(_pk)) continue;
    _seenParse.add(_pk);
    try {
      console.log(`[lorebook] trying ${provider} (${label})...`);
      window._devlog?.system(`Lorebook parse attempt`, { provider, model: model||'default', label });
      const parsed = await dispatchJSON(provider, key, model, prompt, 1200);
      if (parsed?.player || parsed?.npcs?.length) {
        console.log(`[lorebook] ${provider} parsed OK:`, parsed?.npcs?.length ?? 0, 'NPCs');
        window._devlog?.system('Lorebook parsed OK', { provider, npc_count: parsed?.npcs?.length ?? 0 });
        return parsed;
      } else {
        console.warn(`[lorebook] ${provider} returned empty/incomplete:`, Object.keys(parsed ?? {}).join(', ') || '(empty)');
        window._devlog?.error('Lorebook parse incomplete', { provider, returned_keys: Object.keys(parsed ?? {}).join(', ') || 'empty' });
      }
    } catch (e) {
      console.warn(`[lorebook] ${provider} failed:`, e.message);
      window._devlog?.error('Lorebook parse failed', { provider, error: e.message });
    }
  }

  console.warn('[lorebook] all parsers failed — world starts empty');
  window._devlog?.error('Lorebook parse: all slots exhausted', { tried: [..._seenParse] });
  return null;
}

// ─── MULTI-AI WORLD BUILDING ──────────────────────────────────────────────────
// Runs Gemini (structure) and Groq (trait depth) in parallel during init.

async function buildNpcDepth(lorebook) {
  const helper = getHelperSlot();
  if (!helper.key || !helper.provider) return null;
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
    return await dispatchJSON(helper.provider, helper.key, helper.model, prompt, 500);
  } catch { return null; }
}

export async function buildWorldWithMultipleAIs(lorebook) {
  if (!lorebook?.trim()) return null;

  // Run Gemini (structure) and Groq (NPC trait depth) in parallel
  const [geminiResult, groqResult] = await Promise.allSettled([
    parseLorebookToWorldState(lorebook),
    buildNpcDepth(lorebook),
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
  const helper = getHelperSlot();
  if (!helper.key || !helper.provider || !npcContextArray?.length) return [];

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
    const parsed = await dispatchJSON(helper.provider, helper.key, helper.model, prompt, 150);
    if (!parsed?.has_initiative || !parsed.npc_id || !parsed.brief) return [];
    const _brief = String(parsed.brief).trim();
    // Quality filter: reject generic, too-short, or formulaic briefs
    const _GENERIC = /\b(just\s+checking|what'?s?\s+up|hey\s+there|how\s+are\s+you|hi\s+there|checking\s+in|hello[^,]|how'?s?\s+it\s+going|thinking\s+of\s+you)\b/i;
    if (_brief.length < 28 || _GENERIC.test(_brief)) {
      window._devlog?.npc(`NPC initiative filtered (generic)`, { npc_id: parsed.npc_id, brief: _brief.slice(0, 60) });
      return [];
    }
    return [{ npc_id: parsed.npc_id, type: parsed.type ?? 'message', brief: _brief }];
  } catch { return []; }
}

// ─── DESCRIBED NPC EXTRACTOR ──────────────────────────────────────────────────
// When player describes a third party in explicit content who isn't in the NPC system,
// Groq quickly extracts enough info to register them.

export async function evaluateDescribedNpc(playerInput) {
  const helper = getHelperSlot();
  if (!helper.key || !helper.provider) return null;

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
    const parsed = await dispatchJSON(helper.provider, helper.key, helper.model, prompt, 250);
    return parsed?.found ? parsed : null;
  } catch { return null; }
}

// ─── WORLD ENRICHMENT ─────────────────────────────────────────────────────────
// Always called during init. Generates creative world details even from empty lorebook.

// ── Internal helpers for post-parse validation ────────────────────────────────
function _wc(str) { return str ? String(str).trim().split(/\s+/).filter(Boolean).length : 0; }

// Ensures required display fields are never left blank regardless of which model
// generated the enrichment. Applied to EVERY result before returning — no retry call.
function _backfillEnrichment(parsed, ws) {
  if (!parsed) return parsed;

  // setting_description: 3-sentence / ~25-word minimum
  if (!parsed.setting_description || _wc(parsed.setting_description) < 25) {
    const loc = (ws.player?.location ?? 'a modest home').replace(/_/g, ' ');
    parsed.setting_description =
      `The home at ${loc} is modest but functional, typical of a lower-middle-class household. ` +
      `Worn furniture fills the main living area alongside a small television and basic kitchen equipment. ` +
      `Sounds from the surrounding neighbourhood filter in through the walls.`;
  }

  // job_enrichment: description (≥2 sentences / ~12 words), schedule, and earnings required
  if (parsed.job_enrichment && typeof parsed.job_enrichment === 'object') {
    const je = parsed.job_enrichment;
    if (!je.description || _wc(String(je.description)) < 12) {
      je.description =
        `The role involves carrying out regular daily tasks appropriate to the position and employer. ` +
        `Work follows a structured schedule and is performed on-site according to standard expectations.`;
    }
    if (!je.schedule || String(je.schedule).trim() === '' || je.schedule === 'null') {
      je.schedule = 'Mon–Fri 8:00 AM – 5:00 PM';
    }
    if (!je.earnings || String(je.earnings).trim() === '' || je.earnings === 'null') {
      je.earnings = 'Variable earnings';
    }
  }

  // npc_descriptions: each bio must be at least 2 short sentences (~15 words)
  if (parsed.npc_descriptions && typeof parsed.npc_descriptions === 'object') {
    for (const [key, bio] of Object.entries(parsed.npc_descriptions)) {
      if (!bio || _wc(String(bio)) < 15) {
        const _npcMatch = Object.values(ws.npcs ?? {}).find(n => {
          if (!n.name) return false;
          return n.name.toLowerCase().split(/\s+/)[0] === key.toLowerCase().split('_')[0] || n.id === key;
        });
        const _relLabel = (_npcMatch?.relationship_type ?? 'acquaintance').replace(/_/g, ' ');
        const _nameStr  = _npcMatch?.name ?? key;
        parsed.npc_descriptions[key] =
          `${_nameStr} is a ${_relLabel} in the character's life, familiar from shared routines and close daily proximity. ` +
          `They move through their shared spaces with a quiet ease that comes from long familiarity, their presence a reliable constant.`;
      }
    }
  }

  return parsed;
}

export async function enrichWorldDetails(lorebook, ws) {
  const _helper = getHelperSlot();
  if (!_helper.key || !_helper.provider) return null;

  const _eLocale  = typeof localStorage !== 'undefined' ? (localStorage.getItem('LOCALE')   ?? 'Philippines') : 'Philippines';
  const _eIsPhil  = /philippine|filipin/i.test(_eLocale);
  const _addrFmt  = _eIsPhil
    ? 'specific Philippine address — sitio/street, barangay, municipality, province'
    : `specific ${_eLocale} address with neighborhood, city/town, and region`;
  const _schoolGrade = _eIsPhil
    ? 'e.g. Grade 12 - HUMSS Strand OR 1st Year - BS Criminology'
    : 'e.g. Year 12 - Sciences OR 1st Year - Business Administration';
  const _schoolDefault = _eIsPhil
    ? 'most common in Philippines for this age'
    : `most common for this age in ${_eLocale}`;

  const npcNames  = Object.values(ws.npcs ?? {}).map(n => `${n.name} (${n.relationship_type ?? n.npc_class}, age ${n.age})`).join(', ') || 'none';
  const startYear = ws.sim_time ? new Date(ws.sim_time).getFullYear() : new Date().getFullYear();
  const hasJob    = !!ws.job;
  const hasSchool = !!ws.school;
  const lbText    = lorebook?.trim() || '';

  const prompt = `You are a world-building AI for a ${_eLocale} life simulation game. Generate complete, vivid details for this character. Fill ALL required fields — never skip or return null for required fields.

CHARACTER: ${ws.player?.name ?? 'Character'}, age ${ws.player?.age ?? 18}
YEAR: ${startYear}
${lbText ? `LOREBOOK:\n"""\n${lbText.slice(0, 1400)}\n"""` : `NO LOREBOOK PROVIDED — invent a complete, believable ${_eLocale} life based on the name and age alone. Be creative and specific.`}
KNOWN NPCs: ${npcNames}
JOB ALREADY PARSED: ${hasJob ? 'YES — ' + (ws.job?.position ?? '') + ' at ' + (ws.job?.employer ?? '') : 'NO'}
SCHOOL ALREADY PARSED: ${hasSchool ? 'YES — ' + (ws.school?.name ?? '') : 'NO'}

Return ONLY valid JSON. No markdown. Fill every required field — never return null for required fields.

{
  "location_name": "REQUIRED: ${_addrFmt}. Always generate, never null.",
  "setting_description": "REQUIRED: 3-4 vivid sentences describing the home — layout, furniture, sounds, smells, economic class markers. Always generate, never null.",
  "school": null,
  "job_enrichment": null,
  "starting_possessions": [],
  "npc_descriptions": {},
  "npc_schedules": {}
}

GENERATION RULES — read carefully:

LOCATION: Always generate a specific address matching: ${_addrFmt}. If lorebook names a place, expand it with local-level detail. If no place mentioned, invent one plausibly matching the character's name and cultural background.

SETTING_DESCRIPTION: Always describe the home vividly. MINIMUM 3 full sentences, each covering a different dimension: (1) physical layout and key furniture, (2) economic-class markers and visible condition, (3) sensory atmosphere — sounds, smells, or quality of light. This 3-sentence minimum is MANDATORY for all models including fast or small ones — a single sentence is not acceptable. Match the economic class implied by the lorebook (or default to modest lower-middle class). Never return null or empty string.

SCHOOL — decide based on age and lorebook:
  - Generate IF: character is age 14–22 AND lorebook does NOT say dropped out / no school / graduated / finished school
  - When NO lorebook: age 18 → default to final year of secondary school or 1st year of tertiary/college (${_schoolDefault})
  - When SCHOOL ALREADY PARSED = YES: return null (don't override)
  - Schema: { "name": "realistic ${_eLocale} school name", "grade_level": "${_schoolGrade}", "schedule": "Mon-Fri 7:00 AM – 4:30 PM", "status": "active" }

JOB_ENRICHMENT — reason about it:
  - When JOB ALREADY PARSED = YES: return enrichment details to fill missing gaps — { "platform_or_employer": "...", "position": "specific job title", "description": "REQUIRED — exactly 2 full sentences describing daily tasks and work environment; never omit or leave blank", "schedule": "REQUIRED — e.g. Mon–Fri 8:00 AM – 5:00 PM; never null or empty string", "earnings": "REQUIRED — e.g. ₱550/day or ₱12,000/month; never null or empty string", "days_active": realistic_number }
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
  - MINIMUM 2 full sentences per NPC — mandatory for ALL models including fast or small ones; a one-line label or single fragment is not acceptable

NPC_SCHEDULES — REQUIRED if NPCs exist, never empty object when NPCs are listed:
  - Generate a PERSONALIZED weekly schedule for EVERY NPC in KNOWN NPCs
  - Key: first name in lowercase (same as npc_descriptions keys)
  - Value: { "weekday_routine": [...blocks], "weekend_routine": [...blocks] }
  - Each block: { "start_hour": number, "end_hour": number, "task": string, "interruptible": boolean, "location": string }
  - Blocks MUST be contiguous and cover ALL 24 hours exactly (start at 0, end at 24, no gaps, no overlaps)
  - MANDATORY FIRST BLOCK: Every routine array MUST begin with start_hour: 0 — NO EXCEPTIONS. If the NPC wakes at 5 AM, the FIRST block is {"start_hour":0,"end_hour":5,"task":"sleeping","interruptible":false,"location":"home"}, then their wake block starts at 5. NEVER start at hour 5, 6, or any non-zero value.
  - MANDATORY LAST BLOCK: The final block MUST have end_hour: 24. No exceptions.
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

  // For enrichment: try dedicated enricher slot first (FIX 5D), then fallback slots (FIX 5C),
  // then fall through to helper/classifier. The 8b helper slot is listed so _seenProviders
  // skips it if 70b already ran on Groq, avoiding a redundant same-provider call.
  const _enrichGroqKey = typeof localStorage !== 'undefined' ? localStorage.getItem('GROQ_API_KEY')?.trim() : null;
  const slots = [
    getEnricherSlot(),
    ...getFallbackSlots('enricher'),
    _enrichGroqKey ? { key: _enrichGroqKey, provider: 'groq', model: BG_GROQ_SMART } : null,
    getHelperSlot(),
    getClassifierSlot(),
  ].filter(Boolean);
  const _seenSlots = new Set();
  for (const { key, provider, model } of slots) {
    const _slotKey = `${provider}/${model || 'default'}`;
    if (!key || !provider || _seenSlots.has(_slotKey)) continue;
    _seenSlots.add(_slotKey);
    try {
      const parsed = await dispatchJSON(provider, key, model, prompt, 4096);
      if (parsed && (parsed.location_name || parsed.setting_description || parsed.starting_possessions?.length || parsed.npc_descriptions)) {
        const _filled = _backfillEnrichment(parsed, ws);
        window._devlog?.system('Enrichment OK', { provider, model: model||'default', possessions: _filled.starting_possessions?.length ?? 0, npc_descs: Object.keys(_filled.npc_descriptions ?? {}).length, npc_scheds: Object.keys(_filled.npc_schedules ?? {}).length, has_school: !!_filled.school, has_job_enrich: !!_filled.job_enrichment });
        console.log(`[enrich] ${provider} OK — loc: ${_filled.location_name?.slice(0,40)} | poss: ${_filled.starting_possessions?.length} | school: ${_filled.school?.name}`);
        return _filled;
      } else {
        const _missing = ['location_name','setting_description','starting_possessions','npc_descriptions'].filter(k => !parsed?.[k]);
        window._devlog?.error('Enrichment incomplete', { provider, model: model||'default', missing_fields: _missing, returned_keys: Object.keys(parsed ?? {}).join(', ') || '(empty object)' });
        console.warn(`[enrich] ${provider} returned incomplete — missing: ${_missing.join(', ')}`);
      }
    } catch (e) {
      window._devlog?.error('Enrichment failed', { provider, model: model||'default', error: e.message });
      console.warn(`[enrich] ${provider} failed:`, e.message);
    }
  }

  window._devlog?.error('All enrichment slots exhausted', { tried: [..._seenSlots] });
  console.warn('[enrich] all models failed — tried:', [..._seenSlots].join(', '));
  return null;
}

// ─── NARRATIVE STATE EXTRACTOR ────────────────────────────────────────────────
// After Grok generates prose, Groq checks for implied state changes
// (NPC quits job, player moves, NPC enrolls in school, etc.)
export async function extractNarrativeStateChanges(prose, worldState) {
  const helper = getHelperSlot();
  if (!helper.key || !helper.provider || !prose || prose.length < 80) return null;
  const npcList = Object.values(worldState.npcs ?? {})
    .filter(n => n.status === 'active')
    .map(n => `${n.id}: ${n.name} (${n.relationship_type ?? n.npc_class})`)
    .join('\n');
  const _curPoss = (worldState.player?.possessions ?? []).map(p => p.name).join(', ') || 'none';
  const prompt = `Analyze this simulation narration for DEFINITIVELY STATED changes only.

Narration: "${prose.slice(0, 1000)}"

Current context:
- Player job: ${worldState.job ? `${worldState.job.position ?? 'worker'} at ${worldState.job.employer ?? 'unknown'}` : 'unemployed'}
- Player school: ${worldState.school?.name ?? 'none'} (${worldState.school?.status ?? 'n/a'})
- Player location: ${worldState.player?.location ?? 'unknown'}
- Player cash: ${worldState.player?.cash ?? 0}
- Player possessions: ${_curPoss}
- Active NPCs:
${npcList || 'none'}

RULES:
- Only extract if EXPLICITLY AND DEFINITIVELY stated. "might leave" = NO. "decides to quit" = YES. "moves to Cebu" = YES.
- cash_delta: ONLY when a specific peso amount is explicitly exchanged ("pays ₱150", "receives ₱500", "finds ₱200"). Range: -10000 to +10000. Do NOT infer from general activity.
- possessions_gained: ONLY when a physical item is explicitly given to, bought by, or found by the player. One entry per item.
- possessions_lost: ONLY when an item is definitively taken, broken beyond use, lost, or given away. Use exact names from possessions list above.
- appearance_note: ONLY when a PERMANENT physical change is definitively completed (tattoo done, scar received, haircut finished). One per turn max. null if none.
- NPC mood_event: one sentence describing a significant emotional moment for that NPC in this scene, if clearly stated. Used for interaction log only.
- NPC relationship_note: ONLY if narration states an explicit declaration or irreversible shift in the relationship between player and NPC.

Return ONLY valid JSON:
{
  "has_changes": boolean,
  "player_changes": {
    "location": string_or_null,
    "job_lost": boolean,
    "job_new_employer": string_or_null,
    "school_quit": boolean,
    "school_enrolled": string_or_null,
    "cash_delta": number_or_null,
    "possessions_gained": [{"name": string, "note": string_or_null}],
    "possessions_lost": [string],
    "appearance_note": string_or_null
  },
  "npc_changes": [
    {
      "npc_id": "exact_id_from_list_above",
      "job_lost": boolean,
      "job_new_employer": string_or_null,
      "school_quit": boolean,
      "school_enrolled": string_or_null,
      "status": "active|deceased|moved_away|null",
      "mood_event": string_or_null,
      "relationship_note": string_or_null
    }
  ]
}

Set has_changes: true ONLY if you found at least one definitive change.`;
  try {
    const parsed = await dispatchJSON(helper.provider, helper.key, helper.model, prompt, 350);
    return parsed?.has_changes ? parsed : null;
  } catch { return null; }
}

// ─── CONTEXT-AWARE NPC FLAG EVALUATION ────────────────────────────────────────
export async function evaluateNpcFlagsInContext(npc, prose, hoursElapsed) {
  const helper = getHelperSlot();
  if (!helper.key || !helper.provider || !npc.active_flags?.length) return [];
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
    const parsed = await dispatchJSON(helper.provider, helper.key, helper.model, prompt, 80);
    return Array.isArray(parsed?.flags_to_remove) ? parsed.flags_to_remove : [];
  } catch { return []; }
}

// ─── META CONSOLE ─────────────────────────────────────────────────────────────
export async function callMetaConsole(messages, gameState) {
  const _basePrompt = buildMetaConsolePrompt(gameState);
  // Build live provider context so AI never speculates about which models are active
  const _lsGet = k => (typeof localStorage !== 'undefined' ? localStorage.getItem(k) : null) ?? '';
  const _narKey  = _lsGet('NARRATOR_KEY')    || _lsGet('GROK_API_KEY');
  const _clsKey  = _lsGet('CLASSIFIER_KEY')  || _lsGet('GEMINI_API_KEY');
  const _hlpKey  = _lsGet('GROQ_API_KEY')    || _clsKey;
  const _enrKey  = _lsGet('ENRICHER_KEY')    || _clsKey;
  const _narProv = _lsGet('NARRATOR_PROVIDER')   || detectProvider(_narKey) || 'not configured';
  const _clsProv = _lsGet('CLASSIFIER_PROVIDER') || detectProvider(_clsKey) || 'not configured';
  const _hlpProv = _lsGet('GROQ_API_KEY') ? 'groq' : (_clsProv || 'not configured');
  const _enrProv = _lsGet('ENRICHER_PROVIDER')   || detectProvider(_enrKey) || _clsProv || 'not configured';
  const _activeNpcs = Object.values(gameState?.npcs ?? {}).filter(n => n.status === 'active');
  const _wsPlayer  = gameState?.player;
  const _consoleCtx = `

━━ SIM CONSOLE: LIVE ENGINE CONFIGURATION ━━

ACTIVE API SLOTS — use these facts when asked "which model/AI handles X":
  Narrator  (prose generation):     ${getProviderDisplayName(_narProv)} / ${_lsGet('NARRATOR_MODEL') || 'provider default'}
  Classifier (JSON/stat tasks):     ${getProviderDisplayName(_clsProv)} / ${_lsGet('CLASSIFIER_MODEL') || 'provider default'}
  Helper    (background/fast tasks): ${getProviderDisplayName(_hlpProv)} / ${_lsGet('GROQ_API_KEY') ? 'llama-3.1-8b-instant (fast background)' : 'provider default'}
  Enricher  (world-building init):  ${getProviderDisplayName(_enrProv)} / ${_lsGet('ENRICHER_MODEL') || 'provider default'}

LIVE GAME STATE SUMMARY:
  Player: ${_wsPlayer ? `${_wsPlayer.name}, age ${_wsPlayer.age}, ₱${_wsPlayer.cash ?? 0}, ${_wsPlayer.location ?? '?'}, Turn ${gameState.turn}` : 'no game loaded'}
  Job: ${gameState?.job ? `${gameState.job.position ?? 'worker'} at ${gameState.job.employer ?? '?'}` : 'unemployed'}
  School: ${gameState?.school?.name ?? 'none'} (${gameState?.school?.status ?? 'n/a'})
  Possessions: ${(_wsPlayer?.possessions ?? []).length} items registered
  Active NPCs (${_activeNpcs.length}): ${_activeNpcs.map(n => `${n.name}[${n.id}]`).join(', ') || 'none'}

━━ CONSOLE IDENTITY ━━
You are the SIM CONSOLE — official management and diagnostic interface for The Sim.
You operate through defined channels: SIM_PATCH (data changes), SIM_ACTION (engine operations), direct answers (from state blocks and ENGINE LOG).

CHANNEL AUTHORITY:
- SIM_PATCH: full authority to modify any data field — stats, cash, job, school, NPCs, bios, possessions, setting, flags
- SIM_ACTION: authority to trigger whitelisted engine functions — generate_npcs, regenerate_bio, rerun_enrichment, reparse_lorebook, generate_items, repair_schedules, read_narrations, read_actions
- Direct answers: authority to read ENGINE LOG data and CURRENT GAME STATE and answer from them

ENGINE LOG: When [ENGINE LOG] appears in the conversation, those are REAL devlog entries. Use them as authoritative evidence. Never say "I can't access logs" when logs are present in context.

WHEN ASKED "why did X not happen / which model / why no items":
  1. Check ENGINE LOG for ERROR or SYSTEM entries first
  2. Cross-reference with ACTIVE API SLOTS above
  3. Give a specific, grounded answer — emit the correct SIM_ACTION if a fix is possible

Always emit SIM_PATCH or SIM_ACTION to commit changes. Prose alone does nothing.`;
  const systemPrompt = _basePrompt + _consoleCtx;
  const _sysTokenEst = Math.ceil(systemPrompt.length / 4);
  const _msgTokenEst = messages.slice(-24).reduce((acc, m) => acc + Math.ceil((m.content?.length ?? 0) / 4), 0);
  window._devlog?.console_log('Console API call', { msgs: messages.length, sys_tokens_est: _sysTokenEst, msg_tokens_est: _msgTokenEst, total_est: _sysTokenEst + _msgTokenEst });

  const classifierSlot = getClassifierSlot();
  const helperSlot     = getHelperSlot();
  const narratorSlot   = getNarratorSlot();
  const _tried = new Set();
  // FIX 8B: Context budget — trim history when over 10K token estimate (protects Groq 8b / small models)
  const _budgetMsgs = (_sysTokenEst + _msgTokenEst > 10000)
    ? (() => { window._devlog?.console_log('Context budget exceeded — trimming to last 8 msgs', { total_est: _sysTokenEst + _msgTokenEst }); return messages.slice(-8); })()
    : messages.slice(-20);

  // Classifier slot first — console is a structured reasoning task, not prose
  if (classifierSlot.key && classifierSlot.provider) {
    const _model = classifierSlot.model || PROVIDER_ENDPOINTS[classifierSlot.provider]?.default_helper_model || null;
    _tried.add(classifierSlot.provider);
    window._devlog?.console_log('Console using slot', { provider: classifierSlot.provider, model: _model });
    try {
      const allMsgs = [{ role: 'system', content: systemPrompt }, ..._budgetMsgs];
      const reply = await dispatchChat(classifierSlot.provider, classifierSlot.key, _model, allMsgs, 800, 25000);
      if (reply && reply.length > 20) {
        window._devlog?.console_log(`Console: ${classifierSlot.provider} responded`, { chars: reply.length, hasPatch: /<SIM_PATCH>/i.test(reply) });
        return reply;
      }
    } catch (e) { 
      window._devlog?.console_log('Slot failed → fallback', { failed: classifierSlot.provider, reason: e.message });
      window._devlog?.error('Console: classifier slot failed', { error: e.message }); 
    }
  }

  // Helper slot second (Groq/fast) — structured tasks
  if (helperSlot.key && helperSlot.provider && !_tried.has(helperSlot.provider)) {
    _tried.add(helperSlot.provider);
    const HELPER_CHAT_MODELS = { groq: BG_GROQ_SMART, openai: 'gpt-4o-mini', gemini: BG_GEMINI_FAST };
    // FIX 5E: For console specifically, prefer 70b when Groq is the provider (unless user explicitly set model)
    const model = helperSlot.provider === 'groq' && !helperSlot.model
      ? BG_GROQ_SMART
      : helperSlot.model || HELPER_CHAT_MODELS[helperSlot.provider] || null;
    window._devlog?.console_log('Console using slot', { provider: helperSlot.provider, model });
    const _modelList = [...new Set([model, HELPER_CHAT_MODELS[helperSlot.provider]].filter(Boolean))];
    for (const m of _modelList) {
      try {
        const allMsgs = [{ role: 'system', content: systemPrompt }, ..._budgetMsgs];
        const reply = await dispatchChat(helperSlot.provider, helperSlot.key, m, allMsgs, 800, 25000);
        if (reply && reply.length > 20) {
          window._devlog?.console_log(`Console: ${helperSlot.provider}(${m}) responded`, { chars: reply.length, hasPatch: /<SIM_PATCH>/i.test(reply) });
          return reply;
        }
      } catch (e) { 
        window._devlog?.console_log('Slot failed → fallback', { failed: helperSlot.provider, reason: e.message });
        window._devlog?.error(`Console: ${helperSlot.provider}(${m}) failed`, { error: e.message }); 
      }
    }
  }

  // Configured fallback slots — cheaper than narrator, try before narrator
  const _consoleFallbacks = [...getFallbackSlots('classifier'), ...getFallbackSlots('narrator')];
  for (const { key: _cfbKey, provider: _cfbProv, model: _cfbModel } of _consoleFallbacks) {
    if (!_cfbKey || !_cfbProv || _tried.has(_cfbProv)) continue;
    _tried.add(_cfbProv);
    try {
      const allMsgs = [{ role: 'system', content: systemPrompt }, ..._budgetMsgs];
      const reply = await dispatchChat(_cfbProv, _cfbKey, _cfbModel, allMsgs, 800, 25000);
      if (reply && reply.length > 20) {
        window._devlog?.console_log(`Console: fallback slot (${_cfbProv}) responded`, { chars: reply.length, hasPatch: /<SIM_PATCH>/i.test(reply) });
        return reply;
      }
    } catch (e) {
      window._devlog?.console_log(`Fallback slot failed`, { failed: _cfbProv, reason: e.message });
      window._devlog?.error(`Console: fallback slot (${_cfbProv}) failed`, { error: e.message });
    }
  }

  // Narrator slot last resort — expensive, avoid for console tasks
  if (narratorSlot.key && narratorSlot.provider && !_tried.has(narratorSlot.provider)) {
    window._devlog?.console_log('Console using slot', { provider: narratorSlot.provider, model: narratorSlot.model });
    try {
      const allMsgs = [{ role: 'system', content: systemPrompt }, ..._budgetMsgs];
      const reply = await dispatchChat(narratorSlot.provider, narratorSlot.key, narratorSlot.model, allMsgs, 800, 30000);
      if (reply && reply.length > 20) {
        window._devlog?.console_log(`Console: ${narratorSlot.provider} responded`, { chars: reply.length, hasPatch: /<SIM_PATCH>/i.test(reply) });
        return reply;
      }
    } catch (e) { 
      window._devlog?.console_log('Slot failed → fallback', { failed: narratorSlot.provider, reason: e.message });
      window._devlog?.error('Console: narrator slot failed', { error: e.message }); 
    }
  }

  throw new Error('No API available for console. Configure a Narrator Key in ⚙ Settings.');
}

