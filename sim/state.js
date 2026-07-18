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
db.version(5).stores({
  world:      '++id, timestamp',
  events:     '++id, category, turn, saveId',
  actions:    '++id, turn, saveId',
  sim_console:'++id, saveId, timestamp',
  images:     '++id, key, saveId',
});

// ─── INITIAL WORLD STATE ──────────────────────────────────────────────────────
export function createInitialWorldState(playerName, startDate) {
  return {
    version: 4,
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
    scene_context: null,
    setting_description: '',
    // Ring buffer of compressed turn summaries — injected into AI Console context
    world_memory: [],
    challenges: [],
    debts: [],
    criminal_record: { wanted_level: 0, crimes: [], has_record: false },
    fame: { level: 0, label: 'unknown', followers: 0, unlocked_perks: [], perk_notified: [] },
    addictions: [],
  };
}

// ─── SAVE MIGRATION ───────────────────────────────────────────────────────────
// Runs automatically when any save is loaded. Adds fields introduced in newer versions.
// Safe to call repeatedly — only fills in genuinely missing fields.
export function migrateSaveState(state) {
  if (!state) return state;
  // Top-level fields
  if (!Array.isArray(state.challenges))                state.challenges               = [];
  if (!Array.isArray(state.debts))                     state.debts                    = [];
  if (!state.criminal_record)                          state.criminal_record          = { wanted_level: 0, crimes: [], has_record: false };
  else {
    if (!Array.isArray(state.criminal_record.crimes))  state.criminal_record.crimes   = [];
    if (state.criminal_record.wanted_level == null)    state.criminal_record.wanted_level = 0;
    if (state.criminal_record.has_record   == null)    state.criminal_record.has_record   = false;
  }
  if (!state.fame)                                     state.fame                     = { level: 0, label: 'unknown', followers: 0, unlocked_perks: [], perk_notified: [] };
  else {
    if (!Array.isArray(state.fame.unlocked_perks))     state.fame.unlocked_perks      = [];
    if (!Array.isArray(state.fame.perk_notified))      state.fame.perk_notified       = [];
    if (state.fame.followers == null)                  state.fame.followers           = 0;
  }
  if (!Array.isArray(state.addictions))                state.addictions               = [];
  if (state.setting_description    == null)            state.setting_description      = '';
  if (state.session_context_flavor == null)            state.session_context_flavor   = '';
  if (!Array.isArray(state.recent_significant_events)) state.recent_significant_events = [];
  if (!Array.isArray(state.world_memory))              state.world_memory             = [];
  if (!state.last_narration_prose)                     state.last_narration_prose     = '';
  if (state.scene_context === undefined)               state.scene_context            = null;
  if (!state.event_index) state.event_index = {
    last_arrest: null, last_hospitalization: null, last_breakup: null,
    last_job_change: null, last_death_nearby: null, last_major_conflict: null,
    last_sexual_encounter: null, last_new_relationship: null,
    current_relationship: null, current_job_summary: null,
  };
  // Player fields  
  if (!state.player)                              state.player                   = {};  
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
    if (!npc.known_npcs || typeof npc.known_npcs !== 'object' || Array.isArray(npc.known_npcs)) npc.known_npcs = {};
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
    const saveId = _worldId ?? null;
    await _supabase.from('world_states').upsert(
      { user_id: user.id, save_id: saveId, state, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,save_id' }
    );
  } catch (e) { console.warn('[cloud] save failed:', e.message); }
}

export async function loadWorldStateCloud(saveId = undefined) {
  if (!_supabase) return null;
  try {
    const { data: { user } } = await _supabase.auth.getUser();
    if (!user) return null;
    const targetId = saveId !== undefined ? saveId : _worldId;
    if (targetId !== null && targetId !== undefined) {
      const { data } = await _supabase
        .from('world_states').select('state')
        .eq('user_id', user.id).eq('save_id', targetId).maybeSingle();
      if (data?.state) return data.state;
    }
    // Backward compat: legacy row with no save_id
    const { data: legacy } = await _supabase
      .from('world_states').select('state')
      .eq('user_id', user.id).is('save_id', null).maybeSingle();
    return legacy?.state ?? null;
  } catch { return null; }
}

export async function listWorldStatesCloud() {
  if (!_supabase) return [];
  try {
    const { data: { user } } = await _supabase.auth.getUser();
    if (!user) return [];
    const { data } = await _supabase
      .from('world_states').select('save_id, state, updated_at')
      .eq('user_id', user.id).order('updated_at', { ascending: false });
    return data ?? [];
  } catch { return []; }
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
    npcReactions, turnClass, isExplicit, rawInput, sceneDriver,
  } = turnData;

  // Build structured history from event_index — only non-null entries
  const structuredHistory = Object.entries(event_index)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v.description} (turn ${v.turn})`)
    .join('\n') || null;

  const _td = new Date(simTime);
  const _stUse24h = (typeof localStorage !== 'undefined' ? localStorage.getItem('TIME_FORMAT_24H') : null) === '1';
  const sim_time_formatted =
    _td.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: !_stUse24h }) +
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
    scene_context:      worldState.scene_context ?? null,
    // Raw player input — Grok uses this to honor location hints and compound actions
    player_raw_input:   rawInput || null,
    // Upcoming schedule commitments within 2 hours
    upcoming_schedule:  _upSched.length ? _upSched : null,
    // World-driven scene moment for this turn (texture event or NPC initiative)
    scene_driver:       sceneDriver ?? null,
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
    // Criminal record — affects ambient police presence and NPC wariness
    criminal_status: (worldState.criminal_record?.wanted_level ?? 0) > 0 ? {
      wanted_level: worldState.criminal_record.wanted_level,
      has_record:   worldState.criminal_record.has_record,
    } : null,
    // Active addictions — craving/withdrawal state for narrator
    active_addictions: (worldState.addictions ?? [])
      .filter(a => a.status !== 'recovered')
      .map(a => ({ type: a.type, severity: a.severity, status: a.status })),
    // Recent compressed world memory — long-term story continuity
    world_memory_recent: (worldState.world_memory ?? []).slice(-3),
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

// ─── IMAGE STORAGE ────────────────────────────────────────────────────────────
export async function saveImage(key, dataUrl) {
  try {
    const sid = _worldId;
    const existing = await db.images.where('key').equals(key).and(i => i.saveId === sid).first().catch(() => null);
    if (existing) await db.images.update(existing.id, { dataUrl, timestamp: new Date().toISOString() });
    else await db.images.add({ key, dataUrl, saveId: sid, timestamp: new Date().toISOString() });
  } catch(e) { console.warn('[image] save failed:', e.message); }
}

export async function loadImage(key) {
  try {
    const sid = _worldId;
    const img = await db.images.where('key').equals(key).and(i => i.saveId === sid).first().catch(() => null);
    return img?.dataUrl ?? null;
  } catch { return null; }
}

export async function loadAllImages() {
  try {
    const sid = _worldId;
    if (sid === null || sid === undefined) return {};
    const imgs = await db.images.where('saveId').equals(sid).toArray().catch(() => []);
    const result = {};
    for (const img of imgs) result[img.key] = img.dataUrl;
    return result;
  } catch { return {}; }
}

// ─── DEBT HELPERS ─────────────────────────────────────────────────────────────
export function addDebt(worldState, { creditor, amount, type = 'personal', turns_due = 30, interest_rate = 0.05, description = '' }) {
  const ws = JSON.parse(JSON.stringify(worldState));
  ws.debts = ws.debts ?? [];
  ws.debts.push({
    id: `debt_${Date.now()}`,
    creditor, amount, type,
    turns_remaining: turns_due,
    original_amount: amount,
    interest_rate, description,
    status: 'active',
    interest_turns: 0,
    created_turn: ws.turn,
  });
  return ws;
}

export function payDebt(worldState, debtId, amount) {
  const ws = JSON.parse(JSON.stringify(worldState));
  const debt = (ws.debts ?? []).find(d => d.id === debtId);
  if (!debt || ws.player.cash < amount) return ws;
  ws.player.cash -= amount;
  debt.amount = Math.max(0, debt.amount - amount);
  if (debt.amount <= 0) {
    debt.status = 'paid';
    ws.player.stats.mood       = Math.min(100, ws.player.stats.mood       + 15);
    ws.player.stats.reputation = Math.min(100, ws.player.stats.reputation + 5);
    if (ws.challenges) {
      for (const ch of ws.challenges) {
        if (ch.active && !ch.resolved && ch.id.startsWith('debt_') && ch.id.includes(debtId)) {
          ch.resolved = true; ch.active = false;
        }
      }
    }
  }
  return ws;
}

// ─── FAME HELPERS ─────────────────────────────────────────────────────────────
export const FAME_TIERS = [
  { level: 0, label: 'unknown',   min_rep: 0,  min_followers: 0,      perks: [] },
  { level: 1, label: 'local',     min_rep: 55, min_followers: 100,    perks: ['local_fan_encounters', 'small_brand_deals'] },
  { level: 2, label: 'regional',  min_rep: 70, min_followers: 5000,   perks: ['media_coverage', 'event_invites', 'regional_fan_encounters'] },
  { level: 3, label: 'national',  min_rep: 82, min_followers: 50000,  perks: ['talk_show_invites', 'major_brand_deals', 'paparazzi', 'national_fan_encounters'] },
  { level: 4, label: 'celebrity', min_rep: 90, min_followers: 500000, perks: ['viral_status', 'global_brand_deals', 'constant_attention', 'scandal_risk'] },
];

export function computeFameTier(reputation, followers) {
  let tier = FAME_TIERS[0];
  for (const t of FAME_TIERS) {
    if (reputation >= t.min_rep && (followers ?? 0) >= t.min_followers) tier = t;
  }
  return tier;
}

export function updateFame(worldState) {
  let ws = JSON.parse(JSON.stringify(worldState));
  if (!ws.fame) ws.fame = { level: 0, label: 'unknown', followers: 0, unlocked_perks: [], perk_notified: [] };
  const tier = computeFameTier(ws.player.stats.reputation, ws.fame.followers ?? 0);
  const prevLevel = ws.fame.level;
  ws.fame.level = tier.level;
  ws.fame.label = tier.label;
  const newPerks = tier.perks.filter(p => !(ws.fame.unlocked_perks ?? []).includes(p));
  if (newPerks.length) ws.fame.unlocked_perks = [...(ws.fame.unlocked_perks ?? []), ...newPerks];
  // Passive follower growth for known characters
  if (tier.level >= 1) {
    const growthRate = [0, 2, 15, 80, 500][tier.level] ?? 0;
    ws.fame.followers = (ws.fame.followers ?? 0) + growthRate;
  }
  return ws;
}

// ─── CONSOLE READ API ─────────────────────────────────────────────────────────
export function exportNpc(ws, npcId) {
  if (!ws?.npcs?.[npcId]) return null;
  const npc = ws.npcs[npcId];
  return {
    id: npc.id, name: npc.name, age: npc.age,
    npc_class: npc.npc_class, relationship_type: npc.relationship_type,
    relationship_meter: npc.relationship_meter, trust_meter: npc.trust_meter,
    traits: npc.traits, active_flags: npc.active_flags, flag_timers: npc.flag_timers,
    bio: npc.bio ?? 'No bio set', significance: npc.significance, status: npc.status,
    schedule_summary: {
      weekday_blocks: npc.schedule?.weekday_routine?.length ?? 0,
      has_interruptions: (npc.schedule?.interruptions?.length ?? 0) > 0,
      current_task: null,
    },
    recent_interactions: npc.recent_interactions ?? [],
  };
}

export function exportWorldSummary(ws) {
  if (!ws) return null;
  return {
    turn: ws.turn, sim_time: ws.sim_time,
    player: {
      name: ws.player.name, age: ws.player.age,
      location: ws.player.location, cash: ws.player.cash,
      stats: Object.fromEntries(Object.entries(ws.player.stats).map(([k,v]) => [k, Math.round(v)])),
      diseases: (ws.player.diseases ?? []).map(d => d.name),
      possessions_count: (ws.player.possessions ?? []).length,
    },
    job: ws.job ? { employer: ws.job.employer, position: ws.job.position,
      days: ws.job.days_employed, flags: ws.job.performance_flags } : null,
    school: ws.school ? { name: ws.school.name, status: ws.school.status,
      absences: ws.school.absence_count } : null,
    npcs: Object.values(ws.npcs ?? {})
      .filter(n => n.status === 'active')
      .map(n => ({
        id: n.id, name: n.name, age: n.age,
        relationship_type: n.relationship_type,
        relationship_meter: n.relationship_meter, trust_meter: n.trust_meter,
        npc_class: n.npc_class, bio_set: !!n.bio, flags: n.active_flags ?? [],
      })),
    active_challenges: (ws.challenges ?? []).filter(c => c.active && !c.resolved).length,
    active_debts: (ws.debts ?? []).filter(d => d.status === 'active' || d.status === 'overdue').length,
    consequences: (ws.consequences ?? []).map(c => ({ type: c.type, duration: c.duration })),
  };
}

export function exportLorebook() {
  return localStorage.getItem('LOREBOOK') ?? '';
}

export async function exportClassifierHistory(limit = 10, saveId = null) {
  const rows = await db.events
    .where('category').equals('classifier_output')
    .and(ev => saveId === null || ev.saveId === saveId)
    .reverse().limit(limit).toArray();
  return rows.reverse();
}

export async function exportPatchAuditLog(limit = 20, saveId = null) {
  const rows = await db.events
    .where('category').equals('patch_applied')
    .and(ev => saveId === null || ev.saveId === saveId)
    .reverse().limit(limit).toArray();
  return rows.reverse();
}

export async function savePatchAuditEntry(patchId, patch, changed, rejected, violations) {
  await db.events.add({
    turn: null,
    category: 'patch_applied',
    description: rejected
      ? `PATCH ${patchId} REJECTED: ${violations[0]}`
      : `PATCH ${patchId} APPLIED: ${changed.join(', ')}`,
    data: { patchId, patch, changed, rejected, violations },
    timestamp: new Date().toISOString(),
    saveId: _worldId,
  });
}

export async function saveClassifierOutput(turn, simTime, output) {
  await db.events.add({
    turn,
    category: 'classifier_output',
    description: `Turn ${turn}: ${output.action_type ?? 'action'}`,
    data: {
      action_type:      output.action_type,
      time_cost_hours:  output.time_cost_hours,
      stat_deltas:      output.stat_deltas,
      npc_ids_involved: output.npc_ids_involved,
      location_change:  output.location_change,
      risk_class:       output.risk_class,
      alcohol_consumed: output.alcohol_consumed,
      context_tags:     output.context_tags,
    },
    timestamp: simTime,
    saveId: _worldId,
  });
}

// ─── FULL SAVE EXPORT ─────────────────────────────────────────────────────────
export async function exportFullSave(ws, saveId) {
  if (!ws) return null;
  const sid = saveId ?? _worldId;
  const [narrations, actions, consoleMsgs] = await Promise.all([
    loadNarrations(9999, sid),
    loadPlayerActions(9999, sid),
    loadConsoleHistory(sid),
  ]);
  const lorebook = (typeof localStorage !== 'undefined' ? localStorage.getItem('LOREBOOK') : '') ?? '';
  const cur = (typeof localStorage !== 'undefined' ? localStorage.getItem('CURRENCY_SYMBOL') : null) || '₱';
  const p = ws.player;
  const out = [];
  const H = (t, n = 2) => out.push('\n' + '#'.repeat(n) + ' ' + t + '\n');

  out.push('# THE SIM — Full Save Export');
  out.push(`**Exported:** ${new Date().toLocaleString()}`);
  out.push(`**Save ID:** ${sid} | **Turn:** ${ws.turn} | **Sim Time:** ${new Date(ws.sim_time).toLocaleString()}`);

  H('PLAYER');
  out.push(`**Name:** ${p.name} | **Age:** ${p.age} | **Sex:** ${p.sex ?? '?'} | **Born:** ~${p.birthday ?? '?'}`);
  out.push(`**Location:** ${p.location ?? '?'} | **Cash:** ${cur}${(p.cash ?? 0).toLocaleString()}`);
  out.push('\n**Stats:**');
  const _sn = {health:'Health',energy:'Energy',hunger:'Hunger (0=full 100=starving)',hygiene:'Hygiene',mood:'Mood',arousal:'Arousal',social:'Social',reputation:'Reputation',alcohol:'Alcohol'};
  for (const [k,lbl] of Object.entries(_sn)) if (k in (p.stats ?? {})) out.push(`- ${lbl}: ${Math.round(p.stats[k])}`);
  if (p.diseases?.length) { out.push('\n**Active Diseases:**'); p.diseases.forEach(d => out.push(`- ${d.name} (${d.severity}, ${d.duration_remaining} turns remaining) — ${d.cause}`)); }
  if (p.possessions?.length) { out.push('\n**Possessions:**'); p.possessions.forEach(i => out.push(`- **${i.name}** (${i.condition ?? 'used'}${i.durability != null ? ', '+Math.round(i.durability)+'%' : ''})${i.note && i.note !== i.condition ? ' — '+i.note : ''}`)); }
  if (p.irreversible?.length) { out.push('\n**Permanent Changes:**'); p.irreversible.forEach(i => out.push(`- ${i}`)); }
  if (p.habits?.length) { out.push('\n**Habits:**'); p.habits.forEach(h => out.push(`- ${h}`)); }
  if ((ws.addictions ?? []).length) { out.push('\n**Addictions:**'); ws.addictions.forEach(a => out.push(`- ${a.type} (${a.severity}, ${a.status})`)); }

  H('WORLD STATE');
  if (ws.setting_description) out.push(`**Setting:** ${ws.setting_description}\n`);
  if (ws.job) {
    out.push(`**Job:** ${ws.job.position ?? 'Worker'} at ${ws.job.employer ?? '?'}`);
    out.push(`- Schedule: ${ws.job.schedule ?? 'N/A'} | Days employed: ${ws.job.days_employed ?? 0}`);
    if (ws.job.description) out.push(`- ${ws.job.description}`);
    if (ws.job.performance_flags?.length) out.push(`- Flags: ${ws.job.performance_flags.join(', ')}`);
  } else out.push('**Job:** Unemployed');
  if (ws.school) {
    out.push(`**School:** ${ws.school.name} (${ws.school.grade_level ?? 'N/A'}, ${ws.school.status ?? 'active'})`);
    out.push(`- Schedule: ${ws.school.schedule ?? 'N/A'} | Absences: ${ws.school.absence_count ?? 0}`);
  }
  if (ws.consequences?.length) { out.push('\n**Active Consequences:**'); ws.consequences.forEach(c => out.push(`- ${c.type} (${c.duration} turns left, ${c.severity})`)); }
  if ((ws.criminal_record?.wanted_level ?? 0) > 0) out.push(`\n**Criminal Record:** Wanted Level ${ws.criminal_record.wanted_level}/5 | Has record: ${ws.criminal_record.has_record}`);
  if ((ws.fame?.level ?? 0) > 0) out.push(`\n**Fame:** ${ws.fame.label} | ${(ws.fame.followers ?? 0).toLocaleString()} followers`);

  H('NPCS');
  const _active = Object.values(ws.npcs ?? {}).filter(n => n.status === 'active');
  const _inactive = Object.values(ws.npcs ?? {}).filter(n => n.status !== 'active');
  _active.forEach(n => {
    H(`${n.name} [${n.id}]`, 3);
    out.push(`**Type:** ${n.relationship_type ?? n.npc_class} | **Class:** ${n.npc_class} | **Age:** ${n.age}`);
    out.push(`**Relationship:** ${n.relationship_meter > 0 ? '+' : ''}${n.relationship_meter} | **Trust:** ${n.trust_meter > 0 ? '+' : ''}${n.trust_meter} | **Significance:** ${n.significance}`);
    if (n.bio) out.push(`**Bio:** ${n.bio}`);
    if (n.traits) out.push(`**Traits:** ${Object.entries(n.traits).map(([k,v])=>`${k}:${v}`).join(' | ')}`);
    if (n.active_flags?.length) out.push(`**Active Flags:** ${n.active_flags.join(', ')}`);
    if (n.recent_interactions?.length) { out.push('**Recent Interactions:**'); n.recent_interactions.forEach(r => out.push(`  - ${r}`)); }
  });
  if (_inactive.length) { H('Inactive / Departed NPCs', 3); _inactive.forEach(n => out.push(`- **${n.name}** (${n.departure_reason ?? 'inactive'})`)); }

  const _activeCh = (ws.challenges ?? []).filter(c => c.active && !c.resolved);
  if (_activeCh.length) {
    H('ACTIVE CHALLENGES');
    _activeCh.forEach(c => { out.push(`**[${c.severity.toUpperCase()}] ${c.title}**`); out.push(`- Cause: ${c.cause}`); out.push(`- Effects: ${c.effects_text}`); out.push(`- Resolution: ${c.resolution_steps}\n`); });
  }

  const _activeDebts = (ws.debts ?? []).filter(d => d.status === 'active' || d.status === 'overdue');
  if (_activeDebts.length) {
    H('DEBTS');
    _activeDebts.forEach(d => out.push(`- **${d.creditor}** (${d.type}) — ${cur}${d.amount.toLocaleString()} [${d.status.toUpperCase()}]${d.description ? ': '+d.description : ''}`));
  }

  if (lorebook.trim()) { H('LOREBOOK'); out.push(lorebook.trim()); }
  if (ws.world_memory?.length) { H('COMPRESSED WORLD MEMORY'); ws.world_memory.forEach(m => out.push(`- ${m}`)); }

  H('NARRATION LOG');
  narrations.forEach(n => {
    out.push(`\n---\n**Turn ${n.turn}** · ${n.data?.simTime ? new Date(n.data.simTime).toLocaleString() : ''} · ${n.data?.location ?? ''}\n`);
    out.push(n.description);
  });

  H('ACTION LOG');
  actions.forEach(a => out.push(`**T${a.turn}:** ${a.input}`));

  if (consoleMsgs.length) {
    H('AI CONSOLE LOG');
    consoleMsgs.forEach(m => out.push(`**[${m.role.toUpperCase()} — ${new Date(m.timestamp).toLocaleTimeString()}]**\n${m.content.replace(/---\n\*Source:.*$/m,'').trim().slice(0,800)}\n`));
  }

  return out.join('\n');
}