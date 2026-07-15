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
db.version(4).stores({
  world:      '++id, timestamp',
  events:     '++id, category, turn, saveId',
  actions:    '++id, turn, saveId',
  sim_console:'++id, saveId, timestamp',
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
        social: 50, reputation: 50, alcohol: 0,
      },
      cash:              500,
      skills:            {},
      habits:            [],
      irreversible:      [],
      possessions:       [],
      diseases:          [],
      alcohol_tolerance: 0,
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
    session_context_flavor: '',
    setting_description: '',
    challenges: [],
  };
}

// ─── SAVE MIGRATION ───────────────────────────────────────────────────────────
// Runs automatically when any save is loaded. Adds fields introduced in newer versions.
// Safe to call repeatedly — only fills in genuinely missing fields.
export function migrateSaveState(state) {
  if (!state) return state;
  // Top-level fields
  if (!Array.isArray(state.challenges))                state.challenges               = [];
  if (state.setting_description    == null)            state.setting_description      = '';
  if (state.session_context_flavor == null)            state.session_context_flavor   = '';
  if (!Array.isArray(state.recent_significant_events)) state.recent_significant_events = [];
  if (!state.last_narration_prose)                     state.last_narration_prose     = '';
  if (!state.event_index) state.event_index = {
    last_arrest: null, last_hospitalization: null, last_breakup: null,
    last_job_change: null, last_death_nearby: null, last_major_conflict: null,
    last_sexual_encounter: null, last_new_relationship: null,
    current_relationship: null, current_job_summary: null,
  };
  // Player fields
  if (!Array.isArray(state.player.diseases))      state.player.diseases          = [];
  if (!Array.isArray(state.player.possessions))   state.player.possessions       = [];
  if (!Array.isArray(state.player.irreversible))  state.player.irreversible      = [];
  if (!Array.isArray(state.player.habits))        state.player.habits            = [];
  if (state.player.alcohol_tolerance == null)     state.player.alcohol_tolerance = 0;
  if (!state.player.stats)                        state.player.stats             = {};
  if (state.player.stats.alcohol    == null)      state.player.stats.alcohol     = 0;
  if (state.player.stats.reputation == null)      state.player.stats.reputation  = 50;
  // NPC fields
  for (const npc of Object.values(state.npcs ?? {})) {
    if (!npc.flag_timers)                               npc.flag_timers            = {};
    if (!Array.isArray(npc.active_flags))              npc.active_flags            = [];
    if (!Array.isArray(npc.recent_interactions))       npc.recent_interactions     = [];
    if (npc.significance == null)                      npc.significance            = 0;
    if (!npc.traits) npc.traits = { jealousy:30, honesty:60, patience:50, warmth:50, ambition:50, impulsivity:40, dominance:50, openness:50 };
    else {
      if (npc.traits.jealousy    == null) npc.traits.jealousy    = 30;
      if (npc.traits.openness    == null) npc.traits.openness    = 50;
      if (npc.traits.dominance   == null) npc.traits.dominance   = 50;
      if (npc.traits.impulsivity == null) npc.traits.impulsivity = 40;
    }
    if (!npc.schedule) npc.schedule = { weekday_routine: [], weekend_routine: [], interruptions: [] };
    else if (!Array.isArray(npc.schedule.interruptions)) npc.schedule.interruptions = [];
  }
  return state;
}

// ─── PERSISTENCE ─────────────────────────────────────────────────────────────
let _worldId = null;
export function getCurrentSaveId() { return _worldId; }

export async function loadWorldState(id = null) {
  if (id) {
    const item = await db.world.get(id);
    if (item) {
      _worldId = id;
      return migrateSaveState(item.state);
    }
    return null;
  }
  // Load most recent save if no ID specified
  const all = await db.world.orderBy('timestamp').reverse().toArray();
  if (!all.length) return null;
  _worldId = all[0].id;
  return migrateSaveState(all[0].state);
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
  await db.events.where('saveId').equals(id).delete();
  await db.actions.where('saveId').equals(id).delete();
  await db.sim_console.where('saveId').equals(id).delete();
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

// ─── SCHEDULE HELPERS ─────────────────────────────────────────────────────────
function _parseScheduleStartHour(schedStr) {
  if (!schedStr || typeof schedStr !== 'string') return null;
  // Try "7:30 AM", "07:00 AM", "7AM" patterns
  const m12 = schedStr.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
  if (m12) {
    let h = parseInt(m12[1]);
    const mn = m12[2] ? parseInt(m12[2]) : 0;
    const ap = m12[3].toUpperCase();
    if (ap === 'PM' && h < 12) h += 12;
    if (ap === 'AM' && h === 12) h = 0;
    return h + mn / 60;
  }
  // Try 24h: "07:30", "7:00"
  const m24 = schedStr.match(/\b(\d{1,2}):(\d{2})\b/);
  if (m24) return parseInt(m24[1]) + parseInt(m24[2]) / 60;
  return null;
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

  // Upcoming schedule — commitments starting within 2 in-game hours
  const _nowH = _td.getHours() + _td.getMinutes() / 60;
  const _isWkday = _td.getDay() >= 1 && _td.getDay() <= 5;
  const _upSched = [];
  if (worldState.school?.status === 'active' && _isWkday) {
    const _sh = _parseScheduleStartHour(worldState.school.schedule);
    if (_sh !== null && _sh > _nowH && _sh - _nowH <= 2) {
      _upSched.push({ type: 'school', name: worldState.school.name ?? 'school', in_hours: Math.round((_sh - _nowH) * 10) / 10 });
    }
  }
  if (worldState.job?.employer && _isWkday) {
    const _jh = _parseScheduleStartHour(worldState.job.schedule);
    if (_jh !== null && _jh > _nowH && _jh - _nowH <= 2) {
      _upSched.push({ type: 'work', employer: worldState.job.employer, in_hours: Math.round((_jh - _nowH) * 10) / 10 });
    }
  }

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
    // Upcoming schedule commitments within 2 hours
    upcoming_schedule:  _upSched.length ? _upSched : null,
    // Active diseases (player)
    active_diseases:    (worldState.player?.diseases ?? []).map(d => ({
      id: d.id, name: d.name, severity: d.severity, duration: d.duration_remaining, cause: d.cause,
    })),
    // Intoxication level if above tipsy threshold
    alcohol_state: (() => {
      const a = worldState.player?.stats?.alcohol ?? 0;
      if (a < 15) return null;
      if (a < 25) return 'tipsy';
      if (a < 45) return 'drunk';
      if (a < 65) return 'very_drunk';
      if (a < 80) return 'severely_drunk';
      return 'alcohol_poisoning';
    })(),
    // NPC health/intoxication conditions relevant to this turn
    npc_conditions: Object.values(worldState.npcs ?? {})
      .filter(n => n.status === 'active' && ((n.diseases?.length) || (n.alcohol_level ?? 0) > 10))
      .map(n => ({
        id: n.id, name: n.name,
        sick: n.diseases?.length ? n.diseases[0].name : null,
        intoxicated: (n.alcohol_level ?? 0) > 10,
      })),
    // Active challenges summary (for Grok awareness)
    active_challenges: (worldState.challenges ?? [])
      .filter(c => c.active && !c.resolved)
      .map(c => ({ type: c.type, title: c.title, severity: c.severity }))
      .slice(0, 3),
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

// ─── CONSOLE HISTORY ──────────────────────────────────────────────────────────
export async function saveConsoleMessage(saveId, role, content) {
  if (saveId === null || saveId === undefined) return;
  await db.sim_console.add({ saveId, role, content, timestamp: new Date().toISOString() });
}

export async function loadConsoleHistory(saveId) {
  if (saveId === null || saveId === undefined) return [];
  return await db.sim_console.where('saveId').equals(saveId).sortBy('timestamp');
}

export async function clearConsoleHistory(saveId) {
  if (saveId === null || saveId === undefined) return;
  await db.sim_console.where('saveId').equals(saveId).delete();
}