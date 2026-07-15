// events.js — expanded world/NPC event system, disease, alcohol, challenges
'use strict';

// ─── DISEASE POOL ─────────────────────────────────────────────────────────────
export const DISEASE_POOL = [
  {
    id: 'common_cold',
    name: 'Common Cold',
    severity: 'minor',
    base_duration: 7,
    per_turn_effects: { health: -1, energy: -5, mood: -5 },
    cascade_difficulty: { hunger_rate: 1.2, energy_drain: 1.3 },
    spread_risk: 0.06,
    contraction_base_prob: 0.05,
    conditions: ws => ws.player.stats.health < 65 || ws.player.stats.hygiene < 40,
    sources: ['sick NPC contact', 'crowded place', 'rain exposure', 'low sleep'],
    resolution: 'Rest and maintain hygiene. Health above 70 speeds recovery.',
    resolution_threshold: { health: 70 },
    challenge_title: "You've Come Down With a Cold",
    challenge_effects_text: 'Energy -5, Mood -5, Health -1 per turn. Fatigue increases faster than usual.',
  },
  {
    id: 'influenza',
    name: 'Influenza',
    severity: 'moderate',
    base_duration: 10,
    per_turn_effects: { health: -3, energy: -12, mood: -15, social: -8 },
    cascade_difficulty: { hunger_rate: 1.4, energy_drain: 1.5, hygiene_drain: 1.3 },
    spread_risk: 0.10,
    contraction_base_prob: 0.03,
    conditions: ws => ws.player.stats.health < 55,
    sources: ['sick NPC close contact', 'crowded place', 'compromised immunity'],
    resolution: 'Rest completely. Avoid exertion. Must endure full duration; health above 65 required.',
    resolution_threshold: { health: 65 },
    challenge_title: 'Down with the Flu',
    challenge_effects_text: 'Health -3, Energy -12, Mood -15, Social -8 per turn. Activities significantly impaired.',
  },
  {
    id: 'food_poisoning',
    name: 'Food Poisoning',
    severity: 'moderate',
    base_duration: 3,
    per_turn_effects: { health: -8, energy: -20, mood: -20, hygiene: -5 },
    cascade_difficulty: { energy_drain: 1.8 },
    spread_risk: 0,
    contraction_base_prob: 0.04,
    conditions: ws => ws.player.stats.hygiene < 30,
    sources: ['contaminated food', 'poor hygiene before eating', 'questionable street food'],
    resolution: 'Stay hydrated. Duration must pass naturally — typically 2-3 days.',
    resolution_threshold: { health: 50 },
    challenge_title: 'Food Poisoning',
    challenge_effects_text: 'Health -8, Energy -20, Mood -20 per turn. Appetite suppressed, near-incapacitated.',
  },
  {
    id: 'hangover',
    name: 'Hangover',
    severity: 'minor',
    base_duration: 2,
    per_turn_effects: { health: -2, energy: -15, mood: -20, hygiene: -3 },
    cascade_difficulty: { energy_drain: 1.4 },
    spread_risk: 0,
    contraction_base_prob: 0,
    conditions: () => false,
    sources: ['heavy drinking'],
    resolution: 'Rest and hydrate. Passes naturally within a day or two.',
    resolution_threshold: {},
    challenge_title: 'Nursing a Hangover',
    challenge_effects_text: 'Energy -15, Mood -20 per turn. Sensitivity to light and noise. Low productivity.',
  },
  {
    id: 'severe_infection',
    name: 'Severe Infection',
    severity: 'serious',
    base_duration: 14,
    per_turn_effects: { health: -5, energy: -18, mood: -20, social: -10 },
    cascade_difficulty: { hunger_rate: 1.5, energy_drain: 1.6, hygiene_drain: 1.4 },
    spread_risk: 0.04,
    contraction_base_prob: 0.01,
    conditions: ws => ws.player.stats.health < 35 && ws.player.stats.hygiene < 25,
    sources: ['untreated wound', 'extreme neglect', 'prolonged illness progression'],
    resolution: 'Requires medical attention. Health must reach 50 after seeking care or time.',
    resolution_threshold: { health: 50 },
    challenge_title: 'Serious Infection — Medical Attention Needed',
    challenge_effects_text: 'Health -5, Energy -18 per turn. Risk of hospitalization if untreated.',
  },
];

// ─── WORLD EVENT TABLE ────────────────────────────────────────────────────────
export const WORLD_EVENT_TABLE = [
  // ── HEALTH ──────────────────────────────────────────────────────────────────
  {
    id: 'illness_minor',
    category: 'health',
    label: 'Came down with a minor illness',
    condition: ws => ws.player.stats.health < 50 && ws.player.stats.hygiene < 30 && !hasActiveDisease(ws),
    probability: 0.12,
    effect: ws => ({
      stat_deltas: { health: -8, energy: -15 },
      consequence: { type: 'illness', severity: 'minor', duration: 4 },
      disease_id: 'common_cold',
      disease_cause: 'weakened immunity from low health and poor hygiene',
    }),
    challenge_trigger: true,
    challenge_type: 'health',
  },
  {
    id: 'illness_severe',
    category: 'hospitalization',
    label: 'Hospitalized due to critical health',
    condition: ws => ws.player.stats.health < 20 && !hasActiveDisease(ws, 'serious'),
    probability: 0.30,
    effect: ws => ({
      stat_deltas: { health: -20, energy: -30 },
      cash_delta: -5000,
      consequence: { type: 'hospitalization', severity: 'severe', duration: 10 },
      disease_id: 'severe_infection',
      disease_cause: 'critical health neglect requiring hospitalization',
    }),
    challenge_trigger: true,
    challenge_type: 'health',
  },
  {
    id: 'minor_accident',
    category: 'accident',
    label: 'Minor accident or mishap',
    condition: ws => ws.player.stats.energy < 20 || ws.player.stats.mood < 15,
    probability: 0.06,
    effect: () => ({
      stat_deltas: { health: -10, energy: -8, mood: -10 },
      consequence: { type: 'minor_injury', severity: 'minor', duration: 3 },
    }),
    challenge_trigger: true,
    challenge_type: 'health',
  },
  // ── EMPLOYMENT ──────────────────────────────────────────────────────────────
  {
    id: 'job_termination',
    category: 'job_change',
    label: 'Terminated from job',
    condition: ws => ws.job?.performance_flags?.includes('poor_performance') && ws.job?.performance_flags?.includes('final_warning'),
    probability: 0.40,
    effect: () => ({
      job_change: null,
      stat_deltas: { mood: -20, reputation: -5 },
      consequence: { type: 'unemployment', severity: 'moderate', duration: 30 },
    }),
    challenge_trigger: true,
    challenge_type: 'employment',
  },
  {
    id: 'job_written_up',
    category: 'job_warning',
    label: 'Formal warning issued at work',
    condition: ws => ws.job && !ws.job.performance_flags?.includes('formal_warning') &&
      (ws.job.performance_flags?.includes('poor_attendance') || ws.job.performance_flags?.includes('poor_performance')),
    probability: 0.18,
    effect: () => ({
      stat_deltas: { mood: -10, reputation: -3 },
      job_flag: 'formal_warning',
    }),
    challenge_trigger: true,
    challenge_type: 'employment',
  },
  // ── SCHOOL ──────────────────────────────────────────────────────────────────
  {
    id: 'school_suspension',
    category: 'school_discipline',
    label: 'Suspended from school',
    condition: ws => ws.school?.status === 'active' && (ws.school?.absence_count ?? 0) >= 5,
    probability: 0.25,
    effect: () => ({
      stat_deltas: { mood: -25, reputation: -15 },
      school_update: { status: 'suspended', suspension_turns_remaining: 5 },
      consequence: { type: 'school_suspension', severity: 'moderate', duration: 5 },
    }),
    challenge_trigger: true,
    challenge_type: 'academic',
  },
  // ── FINANCIAL ───────────────────────────────────────────────────────────────
  {
    id: 'windfall_small',
    category: 'misc',
    label: 'Unexpected small income',
    condition: ws => ws.player.stats.mood > 60,
    probability: 0.04,
    effect: () => ({ cash_delta: Math.floor(Math.random() * 200) + 50 }),
    challenge_trigger: false,
  },
  {
    id: 'unexpected_expense',
    category: 'misc',
    label: 'Unexpected expense cropped up',
    condition: ws => ws.player.cash > 600,
    probability: 0.05,
    effect: () => ({
      cash_delta: -(Math.floor(Math.random() * 300) + 100),
      stat_deltas: { mood: -8 },
    }),
    challenge_trigger: false,
  },
  // ── SOCIAL/MOOD ─────────────────────────────────────────────────────────────
  {
    id: 'mood_crash',
    category: 'misc',
    label: 'Mood crash from isolation',
    condition: ws => ws.player.stats.social < 20 && ws.player.stats.mood > 40,
    probability: 0.20,
    effect: () => ({
      stat_deltas: { mood: -15 },
      consequence: { type: 'emotional_slump', severity: 'minor', duration: 5 },
    }),
    challenge_trigger: false,
  },
  // ── ENVIRONMENTAL ───────────────────────────────────────────────────────────
  {
    id: 'traffic_jam',
    category: 'misc',
    label: 'Caught in heavy traffic',
    condition: ws => {
      const h = new Date(ws.sim_time).getHours();
      return (h >= 7 && h <= 9) || (h >= 17 && h <= 19);
    },
    probability: 0.15,
    effect: () => ({ stat_deltas: { mood: -8, energy: -5 }, time_cost_extra: 1 }),
    challenge_trigger: false,
  },
];

// ─── NPC EVENT TABLE ──────────────────────────────────────────────────────────
export const NPC_EVENT_TABLE = [
  {
    id: 'npc_falls_ill',
    label: 'falls ill',
    per_npc_probability: 0.015,
    condition: (npc) => !(npc.diseases?.length) && npc.significance >= 1 && npc.status === 'active',
    effect: () => ({
      npc_disease: { id: 'common_cold', name: 'Common Cold', severity: 'minor', duration: 7, per_turn_effects: { energy: -5 } },
      spread_risk_to_player: 0.06,
    }),
    creates_player_challenge: false,
    creates_npc_flag: 'sick',
    narrative_hint: 'is feeling unwell',
  },
  {
    id: 'npc_major_illness',
    label: 'is seriously ill and hospitalized',
    per_npc_probability: 0.003,
    condition: (npc) => npc.significance >= 2 || ['mother','father','brother','sister'].includes(npc.relationship_type),
    effect: () => ({
      npc_disease: { id: 'severe_illness', name: 'Serious Illness', severity: 'serious', duration: 20, per_turn_effects: { energy: -15 } },
      spread_risk_to_player: 0.02,
    }),
    creates_player_challenge: true,
    challenge_type: 'relationship',
    creates_npc_flag: 'hospitalized',
    narrative_hint: 'has been hospitalized',
  },
  {
    id: 'npc_gets_drunk',
    label: 'has been drinking',
    per_npc_probability: 0.02,
    condition: (npc, ws) => {
      const h = new Date(ws.sim_time).getHours();
      return h >= 18 && (npc.traits?.impulsivity ?? 40) > 50;
    },
    effect: () => ({
      npc_intoxicated: true,
      npc_alcohol_level: 30 + Math.floor(Math.random() * 40),
    }),
    creates_player_challenge: false,
    creates_npc_flag: 'intoxicated',
    narrative_hint: 'has been drinking and is somewhat intoxicated',
  },
  {
    id: 'npc_moves_away',
    label: 'moves to another city',
    per_npc_probability: 0.001,
    condition: (npc) => npc.npc_class === 'professional' && npc.relationship_meter < 30 && npc.significance < 3,
    effect: () => ({ npc_status_change: 'moved_away', relationship_delta: -10 }),
    creates_player_challenge: false,
    creates_npc_flag: 'moved_away',
    narrative_hint: 'has moved away to another city',
  },
  {
    id: 'npc_major_life_change',
    label: 'has a significant life event',
    per_npc_probability: 0.004,
    condition: (npc) => npc.significance >= 2 && (npc.traits?.ambition ?? 50) > 60 && npc.status === 'active',
    effect: () => ({ npc_mood_boost: true, relationship_delta: 5 }),
    creates_player_challenge: false,
    creates_npc_flag: null,
    narrative_hint: 'seems to have something new and positive going on in their life',
  },
  {
    id: 'npc_dies',
    label: 'passes away',
    per_npc_probability: 0.0003,
    condition: (npc) => {
      const isElderly = npc.age > 70;
      const hasCriticalDisease = (npc.diseases ?? []).some(d => d.severity === 'serious' && (d.duration_remaining ?? 0) <= 3);
      return (isElderly && Math.random() < (npc.age - 70) * 0.008) || hasCriticalDisease;
    },
    effect: (npc) => ({
      npc_status_change: 'deceased',
      player_stat_deltas: npc.significance >= 2 ? { mood: -35, social: -20, health: -5 } : { mood: -15 },
    }),
    creates_player_challenge: true,
    challenge_type: 'loss',
    creates_npc_flag: null,
    narrative_hint: 'has passed away',
  },
];

// ─── ALCOHOL SYSTEM ───────────────────────────────────────────────────────────
export const ALCOHOL_DRINKS = {
  beer:        { units: 1.0 },
  light_beer:  { units: 0.5 },
  wine:        { units: 1.5 },
  spirit_shot: { units: 2.0 },
  cocktail:    { units: 1.5 },
  hard_liquor: { units: 3.0 },
  spiked_drink:{ units: 2.5 },
};

export function calculateAlcoholEffect(drinkType, playerState) {
  const drink = ALCOHOL_DRINKS[drinkType] ?? ALCOHOL_DRINKS.beer;
  const tolerance = playerState.alcohol_tolerance ?? 0;
  const emptyStomach = (playerState.stats?.hunger ?? 0) > 50;
  const baseIncrement = drink.units * 12;
  const toleranceFactor = 1 - (tolerance / 200);
  const stomachFactor = emptyStomach ? 1.4 : 1.0;
  return Math.round(baseIncrement * toleranceFactor * stomachFactor);
}

export function getIntoxicationLevel(alcoholStat) {
  if (alcoholStat < 15)  return { level: 'sober',             label: 'Sober' };
  if (alcoholStat < 25)  return { level: 'tipsy',             label: 'Tipsy' };
  if (alcoholStat < 45)  return { level: 'drunk',             label: 'Drunk' };
  if (alcoholStat < 65)  return { level: 'very_drunk',        label: 'Very Drunk' };
  if (alcoholStat < 80)  return { level: 'severely_drunk',    label: 'Severely Drunk', health_risk: true };
  return                         { level: 'alcohol_poisoning', label: 'Alcohol Poisoning', health_risk: true, critical: true };
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function hasActiveDisease(ws, severity = null) {
  if (!ws.player?.diseases?.length) return false;
  if (!severity) return true;
  return ws.player.diseases.some(d => d.severity === severity);
}

export function getDiseaseById(id) {
  return DISEASE_POOL.find(d => d.id === id) ?? null;
}

// ─── EVENT CHECKERS ───────────────────────────────────────────────────────────
export function checkWorldEvents(worldState) {
  const triggered = [];
  for (const event of WORLD_EVENT_TABLE) {
    try {
      if (event.condition(worldState) && Math.random() < event.probability) {
        triggered.push({ ...event, effect_result: event.effect(worldState) });
      }
    } catch (e) {
      console.warn(`[events] World event check failed for ${event.id}:`, e.message);
    }
  }
  return triggered;
}

export function checkNpcEvents(worldState) {
  const triggered = [];
  for (const [npcId, npc] of Object.entries(worldState.npcs ?? {})) {
    if (npc.status !== 'active') continue;
    for (const event of NPC_EVENT_TABLE) {
      try {
        if (Math.random() < event.per_npc_probability && event.condition(npc, worldState)) {
          triggered.push({ ...event, npc_id: npcId, npc_name: npc.name, effect_result: event.effect(npc, worldState) });
          break; // max 1 event per NPC per turn
        }
      } catch (e) {
        console.warn(`[events] NPC event check failed for ${event.id} on ${npcId}:`, e.message);
      }
    }
  }
  return triggered;
}

export function checkDiseaseContraction(worldState, contextTags = []) {
  if ((worldState.player?.diseases?.length ?? 0) >= 2) return null;
  for (const disease of DISEASE_POOL) {
    if (disease.contraction_base_prob === 0) continue;
    if ((worldState.player?.diseases ?? []).some(d => d.id === disease.id)) continue;
    let prob = disease.contraction_base_prob;
    if (contextTags.includes('crowded_place'))       prob *= 1.5;
    if (contextTags.includes('sick_npc_proximity'))  prob *= 2.0;
    if (contextTags.includes('rain_exposure'))       prob *= 1.3;
    if (worldState.player.stats.health < 40)         prob *= 1.5;
    if (worldState.player.stats.hygiene < 30)        prob *= 1.4;
    try {
      if (disease.conditions(worldState) && Math.random() < prob) {
        return { disease, cause: disease.sources[Math.floor(Math.random() * disease.sources.length)] };
      }
    } catch { /* skip */ }
  }
  return null;
}

export function checkNpcDiseaseSpread(worldState, npcIdsInvolved = []) {
  if ((worldState.player?.diseases?.length ?? 0) >= 2) return null;
  for (const npcId of npcIdsInvolved) {
    const npc = worldState.npcs?.[npcId];
    if (!npc?.diseases?.length) continue;
    for (const disease of npc.diseases) {
      const data = DISEASE_POOL.find(d => d.id === disease.id);
      if (!data?.spread_risk) continue;
      if ((worldState.player?.diseases ?? []).some(d => d.id === disease.id)) continue;
      if (Math.random() < data.spread_risk) {
        return { disease: data, cause: `contracted from ${npc.name}`, source_npc_id: npcId };
      }
    }
  }
  return null;
}

// ─── APPLY EFFECTS ────────────────────────────────────────────────────────────
export function applyEventEffect(worldState, eventResult) {
  let ws = JSON.parse(JSON.stringify(worldState));
  const ef = eventResult.effect_result;

  if (ef.stat_deltas) {
    for (const [k, v] of Object.entries(ef.stat_deltas)) {
      if (k in (ws.player?.stats ?? {})) {
        ws.player.stats[k] = Math.max(0, Math.min(100, ws.player.stats[k] + v));
      }
    }
  }
  if (typeof ef.cash_delta === 'number') {
    ws.player.cash = Math.max(0, ws.player.cash + ef.cash_delta);
  }
  if (ef.consequence) {
    ws.consequences = [...(ws.consequences ?? []), ef.consequence];
  }
  if ('job_change' in ef) {
    ws.job = ef.job_change;
  }
  if (ef.job_flag && ws.job) {
    ws.job.performance_flags = [...new Set([...(ws.job.performance_flags ?? []), ef.job_flag])];
  }
  if (ef.school_update && ws.school) {
    Object.assign(ws.school, ef.school_update);
  }
  if (ef.disease_id) {
    const data = DISEASE_POOL.find(d => d.id === ef.disease_id);
    if (data) {
      ws.player.diseases = [...(ws.player.diseases ?? []), {
        id: data.id, name: data.name, severity: data.severity,
        duration_remaining: data.base_duration,
        cause: ef.disease_cause ?? data.sources[0],
        per_turn_effects: data.per_turn_effects,
        resolution: data.resolution, challenge_title: data.challenge_title,
        challenge_effects_text: data.challenge_effects_text,
      }];
    }
  }
  return ws;
}

export function applyNpcEventEffect(worldState, npcEvent) {
  let ws = JSON.parse(JSON.stringify(worldState));
  const { npc_id, effect_result: ef } = npcEvent;
  if (!ws.npcs?.[npc_id]) return ws;

  if (ef.npc_status_change === 'deceased') {
    ws.npcs[npc_id].status = 'inactive';
    ws.npcs[npc_id].departure_reason = 'deceased';
  } else if (ef.npc_status_change === 'moved_away') {
    ws.npcs[npc_id].departure_reason = 'moved_away';
  }
  if (ef.npc_disease) {
    ws.npcs[npc_id].diseases = [...(ws.npcs[npc_id].diseases ?? []),
      { ...ef.npc_disease, duration_remaining: ef.npc_disease.duration ?? 7 }];
  }
  if (typeof ef.relationship_delta === 'number') {
    ws.npcs[npc_id].relationship_meter = Math.max(-100, Math.min(100,
      ws.npcs[npc_id].relationship_meter + ef.relationship_delta));
  }
  if (ef.player_stat_deltas) {
    for (const [k, v] of Object.entries(ef.player_stat_deltas)) {
      if (k in ws.player.stats) {
        ws.player.stats[k] = Math.max(0, Math.min(100, ws.player.stats[k] + v));
      }
    }
  }
  if (ef.npc_intoxicated) {
    ws.npcs[npc_id].alcohol_level = ef.npc_alcohol_level ?? 30;
  }
  if (ef.npc_mood_boost) {
    ws.npcs[npc_id].relationship_meter = Math.min(100, ws.npcs[npc_id].relationship_meter + 5);
  }
  if (npcEvent.creates_npc_flag) {
    ws.npcs[npc_id].active_flags = [...new Set([...(ws.npcs[npc_id].active_flags ?? []), npcEvent.creates_npc_flag])];
    ws.npcs[npc_id].flag_timers = { ...(ws.npcs[npc_id].flag_timers ?? {}), [npcEvent.creates_npc_flag]: 8 };
  }
  return ws;
}

// ─── DISEASE PROGRESSION ──────────────────────────────────────────────────────
export function progressDiseases(worldState) {
  let ws = JSON.parse(JSON.stringify(worldState));
  if (!ws.player?.diseases?.length) return ws;
  const remaining = [];
  for (const disease of ws.player.diseases) {
    for (const [stat, delta] of Object.entries(disease.per_turn_effects ?? {})) {
      if (stat in ws.player.stats) {
        ws.player.stats[stat] = Math.max(0, Math.min(100, ws.player.stats[stat] + delta));
      }
    }
    disease.duration_remaining = (disease.duration_remaining ?? 1) - 1;
    const data = DISEASE_POOL.find(d => d.id === disease.id);
    const threshold = data?.resolution_threshold ?? {};
    const healthOk = !threshold.health || ws.player.stats.health >= threshold.health;
    if (disease.duration_remaining > 0 || !healthOk) {
      remaining.push(disease);
    } else {
      ws.player.stats.mood = Math.min(100, (ws.player.stats.mood ?? 50) + 5);
    }
  }
  ws.player.diseases = remaining;
  return ws;
}

export function progressNpcDiseases(worldState) {
  let ws = JSON.parse(JSON.stringify(worldState));
  for (const [npcId, npc] of Object.entries(ws.npcs ?? {})) {
    if (!npc.diseases?.length) continue;
    const remaining = [];
    for (const disease of npc.diseases) {
      disease.duration_remaining = (disease.duration_remaining ?? 1) - 1;
      if (disease.duration_remaining > 0) {
        remaining.push(disease);
      } else {
        ws.npcs[npcId].active_flags = (ws.npcs[npcId].active_flags ?? []).filter(f => f !== 'sick' && f !== 'hospitalized');
        delete ws.npcs[npcId].alcohol_level;
      }
    }
    ws.npcs[npcId].diseases = remaining;
    if (ws.npcs[npcId].alcohol_level > 0) {
      ws.npcs[npcId].alcohol_level = Math.max(0, ws.npcs[npcId].alcohol_level - 10);
      if (ws.npcs[npcId].alcohol_level < 10) {
        ws.npcs[npcId].active_flags = (ws.npcs[npcId].active_flags ?? []).filter(f => f !== 'intoxicated');
      }
    }
  }
  return ws;
}

// ─── SCHOOL SUSPENSION COUNTDOWN ──────────────────────────────────────────────
export function tickSchoolSuspension(worldState) {
  let ws = JSON.parse(JSON.stringify(worldState));
  if (!ws.school || ws.school.status !== 'suspended') return ws;
  const dow = new Date(ws.sim_time).getDay();
  if (dow >= 1 && dow <= 5) {
    ws.school.suspension_turns_remaining = Math.max(0, (ws.school.suspension_turns_remaining ?? 1) - 1);
    if (ws.school.suspension_turns_remaining <= 0) {
      ws.school.status = 'active';
      ws.player.stats.mood = Math.min(100, (ws.player.stats.mood ?? 50) + 5);
    }
  }
  return ws;
}