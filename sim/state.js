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

    // Session flavor — OPTIONAL; not required for continuity.
    // Grok can use it or ignore it. Never the sole source of context.
    session_context_flavor: '',
  };
}

// ─── PERSISTENCE ─────────────────────────────────────────────────────────────
let _worldId = null;

export async function loadWorldState() {
  const all = await db.world.toArray();
  if (!all.length) return null;
  _worldId = all[0].id;
  return all[0].state;
}

export async function saveWorldState(state) {
  if (_worldId !== null) {
    await db.world.update(_worldId, { state });
  } else {
    _worldId = await db.world.add({ state });
  }
}

export async function resetWorldState() {
  await db.world.clear();
  await db.events.clear();
  _worldId = null;
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
    npcReactions, turnClass, isExplicit,
  } = turnData;

  // Build structured history from event_index — only non-null entries
  const structuredHistory = Object.entries(event_index)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v.description} (turn ${v.turn})`)
    .join('\n') || null;

  return {
    turn:               turnNumber,
    sim_time:           simTime,
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
  };
}

export function appendSignificantEvent(worldState, description) {
  return {
    ...worldState,
    recent_significant_events:
      [...worldState.recent_significant_events, description].slice(-5),
  };
}