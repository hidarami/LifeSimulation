// state.js — world_state manager, Dexie.js / IndexedDB persistence
// Fix #1: structured event_index replaces narrative compression as primary continuity
'use strict';

import Dexie from 'https://unpkg.com/dexie@4/dist/dexie.mjs';

// ─── DATABASE ─────────────────────────────────────────────────────────────────
const db = new Dexie('SimDB');
db.version(1).stores({
  world:  '++id',
  events: '++id, category, turn',
});
db.version(2).stores({
  world:   '++id',
  events:  '++id, category, turn',
  actions: '++id, turn',
});
db.version(3).stores({
  world:   '++id, timestamp',
  events:  '++id, category, turn, saveId',
  actions: '++id, turn, saveId',
});

// ─── INITIAL WORLD STATE ──────────────────────────────────────────────────────
export function createInitialWorldState(playerName, startDate) {
  return {
    version: 2,
    turn:    0,
    sim_time: startDate ?? new Date().toISOString(),

    player: {
      name:     playerName,
      age:      18,
      location: 'home',
      stats: {
        health: 80, energy: 70, hunger: 20,
        hygiene: 70, mood: 60, arousal: 0,
        social: 50, reputation: 50,
      },
      cash:         500,
      skills:       {},
      habits:       [],
      irreversible: [],
      possessions:  [],
    },

    npcs:            {},
    active_dynamics: [],
    consequences:    [],
    job:             null,
    school:          null,

    // Fix #1: structured history index — AI queries these directly.
    // These are the "chapters" of the character's life; no summarization needed.
    event_index: {
      last_arrest:             null,
      last_hospitalization:    null,
      last_breakup:            null,
      last_job_change:         null,
      last_death_nearby:       null,
      last_major_conflict:     null,
      last_sexual_encounter:   null,
      last_new_relationship:   null,
      current_relationship:    null,
      current_job_summary:     null,
    },

    // Last 5 NOTABLE+ events for turn brief — one sentence each
    recent_significant_events: [],

    // Last Grok prose — for narrative continuity across turns and page reloads
    last_narration_prose: '',

    // Session flavor — OPTIONAL; not required for continuity.
    // Grok can use it or ignore it. Never the sole source of context.
    session_context_flavor: '',
  };
}

// ─── PERSISTENCE ─────────────────────────────────────────────────────────────
let _worldId = null;
export function getCurrentSaveId() { return _worldId; }

export async function loadWorldState(id = null) {
  if (id) {
    const item = await db.world.get(id);
    if (item) {
      _worldId = id;
      return item.state;
    }
    return null;
  }
  // Load most recent save if no ID specified
  const all = await db.world.orderBy('timestamp').reverse().toArray();
  if (!all.length) return null;
  _worldId = all[0].id;
  return all[0].state;
}

export async function saveWorldState(state) {
  const timestamp = new Date().toISOString();
  if (_worldId !== null) {
    await db.world.update(_worldId, { state, timestamp });
  } else {
    _worldId = await db.world.add({ state, timestamp });
  }
}

export async function createNewSaveSlot(state) {
  _worldId = null; // Reset to force new save
  return await saveWorldState(state);
}

export async function listSaves() {
  return await db.world.orderBy('timestamp').reverse().toArray();
}

export async function deleteSave(id) {
  await db.world.delete(id);
  // Also delete associated events
  const events = await db.events.where('saveId').equals(id).toArray();
  for (const ev of events) {
    await db.events.delete(ev.id);
  }
}

export async function resetWorldState() {
  await db.world.clear();
  await db.events.clear();
  _worldId = null;
}

// ─── SUPABASE CLOUD SYNC ──────────────────────────────────────────────────────
let _supabase = null;

export function setSupabaseClient(client) {
  _supabase = client;
}

export async function saveWorldStateCloud(state) {
  if (!_supabase) return;
  try {
    const { data: { user } } = await _supabase.auth.getUser();
    if (!user) return;
    await _supabase.from('world_states').upsert(
      { user_id: user.id, state, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    );
  } catch (e) { console.warn('[cloud] save failed:', e.message); }
}

export async function loadWorldStateCloud() {
  if (!_supabase) return null;
  try {
    const { data: { user } } = await _supabase.auth.getUser();
    if (!user) return null;
    const { data } = await _supabase
      .from('world_states')
      .select('state')
      .eq('user_id', user.id)
      .single();
    return data?.state ?? null;
  } catch { return null; }
}

// ─── EVENT LOG ────────────────────────────────────────────────────────────────
// Full mechanical log — never sent to AI in full; queried by slice.
// Categories: arrest | hospitalization | breakup | job_change |
//             death | conflict | sexual_encounter | relationship_start | misc

export async function logEvent(event) {
  await db.events.add({
    turn:        event.turn,
    category:    event.category ?? 'misc',
    description: event.description,
    npc_id:      event.npc_id   ?? null,
    data:        event.data     ?? {},
    timestamp:   new Date().toISOString(),
    saveId:      _worldId,
  });
}

export async function queryLastEvent(category) {
  const r = await db.events.where('category').equals(category).reverse().limit(1).toArray();
  return r[0] ?? null;
}

// Update the fast-access index on world_state
export function updateEventIndex(worldState, key, description, turn) {
  if (!(key in worldState.event_index)) return worldState;
  return {
    ...worldState,
    event_index: {
      ...worldState.event_index,
      [key]: { description, turn, timestamp: new Date().toISOString() },
    },
  };
}

// ─── TURN BRIEF ASSEMBLY ──────────────────────────────────────────────────────
// Fix #1: turn brief draws from structured event_index, not a narrative summary.
// session_context_flavor is included as optional flavor — not required continuity.

export function assembleTurnBrief(worldState, turnData) {
  const {
    player, event_index, recent_significant_events,
    active_dynamics, session_context_flavor,
  } = worldState;

  const {
    turnNumber, simTime, location, actionDescription,
    statDeltas, riskResult, consequenceUpdate,
    npcReactions, turnClass, isExplicit, rawInput,
  } = turnData;

  // Build structured history from event_index — only non-null entries
  const structuredHistory = Object.entries(event_index)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v.description} (turn ${v.turn})`)
    .join('\n') || null;

  const _td = new Date(simTime);
  const sim_time_formatted =
    _td.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) +
    ' · ' +
    _td.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

  return {
    turn:               turnNumber,
    sim_time:           simTime,
    sim_time_formatted,
    location,
    player_stats:       player.stats,
    player_cash:        player.cash,
    player_name:        player.name,
    action_taken:       actionDescription,
    stat_deltas:        statDeltas,
    risk_result:        riskResult,
    consequence_update: consequenceUpdate,
    npc_reactions:      npcReactions,
    turn_class:         turnClass,
    is_explicit:        isExplicit,
    active_dynamics,
    recent_events:      recent_significant_events.slice(-5),
    // Structured history — queryable facts, not a narrative paragraph
    structured_history: structuredHistory,
    // Optional flavor — narrator may use or ignore
    session_flavor:     session_context_flavor || null,
    // Previous turn prose — for narrative continuity
    last_narration:     worldState.last_narration_prose || null,
    // Raw player input — Grok uses this to honor location hints and compound actions
    player_raw_input:   rawInput || null,
  };
}

export function appendSignificantEvent(worldState, description) {
  return {
    ...worldState,
    recent_significant_events:
      [...worldState.recent_significant_events, description].slice(-5),
  };
}

// ─── NARRATION LOG ────────────────────────────────────────────────────────────
export async function saveNarration(turn, simTime, location, prose) {
  await db.events.add({
    turn,
    category:    'narration',
    description: prose,
    npc_id:      null,
    data:        { simTime, location },
    timestamp:   new Date().toISOString(),
    saveId:      _worldId,
  });
}

export async function loadNarrations(limit = 50, saveId = null) {
  let query = db.events.where('category').equals('narration');
  if (saveId !== null) {
    query = query.and(ev => ev.saveId === saveId);
  }
  const rows = await query.reverse().limit(limit).toArray();
  return rows.reverse(); // chronological order
}

// ─── ACTION LOG ────────────────────────────────────────────────────────────────
export async function savePlayerAction(turn, simTime, input) {
  await db.actions.add({ turn, input, timestamp: simTime, saveId: _worldId });
}

export async function loadPlayerActions(limit = 200, saveId = null) {
  let query = db.actions.orderBy('turn').reverse();
  if (saveId !== null) {
    query = query.and(act => act.saveId === saveId);
  }
  const rows = await query.limit(limit).toArray();
  return rows.reverse();
}