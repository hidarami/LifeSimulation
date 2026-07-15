// engine.js — stat math, time, risk rolls, thresholds, turn classification
'use strict';

// ─── TURN CLASSIFICATION CONSTANTS ───────────────────────────────────────────
export const TURN_CLASSIFICATION = {
  ROUTINE: 'ROUTINE',
  NOTABLE: 'NOTABLE',
  CRISIS:  'CRISIS',
  DEATH:   'DEATH',
};

export const THRESHOLDS = {
  CRISIS_HEALTH:            20,
  CRISIS_MOOD:              15,
  CRISIS_RISK_ROLL_MAX:      5,
  DEATH_HEALTH:              0,
  DEATH_RISK_ROLL_MAX:       2,
  NOTABLE_STAT_DELTA:       15,
  NOTABLE_RELATIONSHIP_DELTA: 10,
};

// ─── STAT DEFINITIONS ────────────────────────────────────────────────────────
export const STATS = {
  health:     { min: 0, max: 100, decay: 0.10 },
  energy:     { min: 0, max: 100, decay: 0.40 },
  hunger:     { min: 0, max: 100, decay: 0.50 },  // 0=full, 100=starving
  hygiene:    { min: 0, max: 100, decay: 0.30 },
  mood:       { min: 0, max: 100, decay: 0.15 },
  arousal:    { min: 0, max: 100, decay: 0.60 },
  social:     { min: 0, max: 100, decay: 0.20 },
  reputation: { min: 0, max: 100, decay: 0.00 },
};

// ─── STAT FORMULAS ────────────────────────────────────────────────────────────
export function applyDecay(stats, hoursElapsed) {
  const s = { ...stats };
  for (const [key, def] of Object.entries(STATS)) {
    if (def.decay === 0) continue;
    // hunger increases over time (0=full, 100=starving); all other stats decrease
    const delta = key === 'hunger'
      ? def.decay * hoursElapsed
      : -(def.decay * hoursElapsed);
    s[key] = Math.max(def.min, Math.min(def.max, s[key] + delta));
  }
  return s;
}

export function applyDeltas(stats, deltas) {
  const s = { ...stats };
  for (const [key, delta] of Object.entries(deltas)) {
    if (!(key in STATS)) continue;
    const def = STATS[key];
    s[key] = Math.max(def.min, Math.min(def.max, s[key] + delta));
  }
  return s;
}

export function applySleepRecovery(stats, hoursSlept) {
  const s = { ...stats };
  s.energy  = Math.min(100, s.energy  + Math.min(hoursSlept * 8, 80));
  s.mood    = Math.min(100, s.mood    + Math.min(hoursSlept * 3, 30));
  s.hygiene = Math.max(0,   s.hygiene - hoursSlept * 0.1);
  return s;
}

// ─── CIRCADIAN RHYTHM ─────────────────────────────────────────────────────────
export function getCircadianModifiers(simTimeIso) {
  const h = new Date(simTimeIso).getHours() + new Date(simTimeIso).getMinutes() / 60;
  if (h >= 6  && h < 10) return { energy:  3, mood:  2 }; // morning clarity
  if (h >= 10 && h < 13) return { energy:  1, mood:  1 }; // late morning
  if (h >= 13 && h < 15) return { energy: -3, mood: -2 }; // post-lunch dip
  if (h >= 15 && h < 19) return { energy:  0, mood:  0 }; // afternoon flat
  if (h >= 19 && h < 22) return { energy: -2, mood: -1 }; // evening fade
  if (h >= 22 || h < 2)  return { energy: -6, mood: -3 }; // late night
  return                         { energy:-10, mood: -5 }; // deep night 2–6 AM
}

export function getSleepEfficiency(startHour) {
  if (startHour >= 21 || startHour < 1) return 1.3;  // prime window
  if (startHour >= 1  && startHour < 5) return 0.85; // early morning
  if (startHour >= 5  && startHour < 13) return 0.60; // daytime
  if (startHour >= 13 && startHour < 20) return 0.75; // afternoon nap
  return 1.0;
}

// ─── TIME ─────────────────────────────────────────────────────────────────────
export function advanceTime(currentTime, hoursElapsed) {
  const d = new Date(currentTime);
  d.setTime(d.getTime() + hoursElapsed * 3_600_000);
  return d;
}

export function formatTimestamp(date) {
  const d = new Date(date);
  return {
    day:  d.toLocaleDateString('en-US', { weekday: 'long' }),
    date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    time: d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
  };
}

// ─── RISK ROLLS ───────────────────────────────────────────────────────────────
const RISK_FLOORS = { none: 50, low: 20, moderate: 8, high: 2, critical: 0 };

const SEVERE_EVENTS = {
  critical: ['death_roll', 'permanent_injury', 'criminal_charge'],
  high:     ['hospitalization', 'arrest', 'serious_injury'],
  moderate: ['injury', 'confrontation'],
  low:      ['minor_injury'],
  none:     ['minor_incident'],
};

const MODERATE_EVENTS = {
  critical: ['serious_injury', 'arrest'],
  high:     ['injury', 'police_contact'],
  moderate: ['confrontation', 'property_damage'],
  low:      ['minor_incident'],
  none:     ['minor_incident'],
};

function pickFrom(table, riskClass) {
  const opts = table[riskClass] ?? ['minor_incident'];
  return opts[Math.floor(Math.random() * opts.length)];
}

export function rollRisk(riskClass, stats) {
  const floor = RISK_FLOORS[riskClass] ?? 50;
  const roll  = Math.floor(Math.random() * 100) + 1;
  if (roll >= floor) return { roll, severity: null, event: null };
  const effective = roll + (stats.health < 30 ? -10 : 0);
  if (effective <= 2) return { roll, severity: 'severe',   event: pickFrom(SEVERE_EVENTS,   riskClass) };
  if (effective <= 8) return { roll, severity: 'moderate', event: pickFrom(MODERATE_EVENTS, riskClass) };
  return               { roll, severity: 'minor',    event: 'minor_incident' };
}

// ─── TURN CLASSIFICATION ──────────────────────────────────────────────────────
export function classifyTurn({ stats, riskResult, consequenceSeverity, statDeltas, relationshipDeltas }) {
  if (stats.health <= THRESHOLDS.DEATH_HEALTH) return TURN_CLASSIFICATION.DEATH;
  if (riskResult?.event === 'death_roll' && riskResult?.roll <= THRESHOLDS.DEATH_RISK_ROLL_MAX) {
    return TURN_CLASSIFICATION.DEATH;
  }
  // Multi-stat cascade failure = death
  const critCount = [
    stats.health < THRESHOLDS.CRISIS_HEALTH,
    stats.mood   < THRESHOLDS.CRISIS_MOOD,
    stats.hunger > 85,
    stats.energy < 8,
  ].filter(Boolean).length;
  if (critCount >= 3) return TURN_CLASSIFICATION.DEATH;

  if (stats.health < THRESHOLDS.CRISIS_HEALTH) return TURN_CLASSIFICATION.CRISIS;
  if (stats.mood   < THRESHOLDS.CRISIS_MOOD)   return TURN_CLASSIFICATION.CRISIS;
  if (stats.hunger > 85)                        return TURN_CLASSIFICATION.CRISIS;
  if (stats.energy < 8)                         return TURN_CLASSIFICATION.CRISIS;
  if (riskResult?.roll <= THRESHOLDS.CRISIS_RISK_ROLL_MAX && riskResult?.severity) {
    return TURN_CLASSIFICATION.CRISIS;
  }
  if (consequenceSeverity === 'critical') return TURN_CLASSIFICATION.CRISIS;

  if (statDeltas && Object.values(statDeltas).some(d => Math.abs(d) >= THRESHOLDS.NOTABLE_STAT_DELTA)) {
    return TURN_CLASSIFICATION.NOTABLE;
  }
  if (relationshipDeltas && Object.values(relationshipDeltas).some(d => Math.abs(d) >= THRESHOLDS.NOTABLE_RELATIONSHIP_DELTA)) {
    return TURN_CLASSIFICATION.NOTABLE;
  }
  if (riskResult?.severity === 'moderate' || riskResult?.severity === 'severe') {
    return TURN_CLASSIFICATION.NOTABLE;
  }
  return TURN_CLASSIFICATION.ROUTINE;
}

// ─── CONSEQUENCES ─────────────────────────────────────────────────────────────
export function advanceConsequences(consequences) {
  return consequences
    .map(c => ({ ...c, duration: c.duration - 1 }))
    .filter(c => c.duration > 0);
}

// ─── CASCADING STAT EFFECTS ───────────────────────────────────────────────────
export function applyCascadingEffects(stats) {
  const s = { ...stats };
  const c = {};
  // NEGATIVE CASCADES
  // Hunger → energy, mood, social
  if (s.hunger >= 85)       { c.energy = -15; c.mood = -12; c.social = -8; }
  else if (s.hunger >= 65)  { c.energy = -7;  c.mood = -5;  c.social = -4; }
  else if (s.hunger >= 45)  { c.energy = -2;  c.mood = -1; }
  // Low energy → mood, hygiene
  if (s.energy <= 10)       { c.mood = (c.mood ?? 0) - 6; c.hygiene = (c.hygiene ?? 0) - 2; }
  else if (s.energy <= 25)  { c.mood = (c.mood ?? 0) - 3; }
  // Low mood → social, energy
  if (s.mood <= 15)         { c.social = (c.social ?? 0) - 12; c.energy = (c.energy ?? 0) - 5; }
  else if (s.mood <= 30)    { c.social = (c.social ?? 0) - 5; }
  // Low health → everything
  if (s.health <= 20)       { c.energy = (c.energy ?? 0) - 15; c.mood = (c.mood ?? 0) - 10; c.hygiene = (c.hygiene ?? 0) - 6; c.social = (c.social ?? 0) - 6; }
  else if (s.health <= 40)  { c.energy = (c.energy ?? 0) - 6; c.mood = (c.mood ?? 0) - 4; }
  // Low hygiene → mood, social
  if (s.hygiene <= 15)      { c.mood = (c.mood ?? 0) - 6;  c.social = (c.social ?? 0) - 10; }
  else if (s.hygiene <= 30) { c.mood = (c.mood ?? 0) - 2;  c.social = (c.social ?? 0) - 4; }
  // Low social → mood
  if (s.social <= 15)       { c.mood = (c.mood ?? 0) - 7; }
  // Low reputation → mood, social
  if (s.reputation <= 20)   { c.mood = (c.mood ?? 0) - 5; c.social = (c.social ?? 0) - 8; }
  else if (s.reputation <= 40) { c.mood = (c.mood ?? 0) - 2; c.social = (c.social ?? 0) - 3; }
  // High arousal → mood, social (can be distracting)
  if (s.arousal >= 80)       { c.mood = (c.mood ?? 0) - 3; c.social = (c.social ?? 0) - 5; }
  else if (s.arousal >= 60)  { c.mood = (c.mood ?? 0) - 1; c.social = (c.social ?? 0) - 2; }

  // POSITIVE CASCADES (recovery mechanics)
  // High mood → social, energy
  if (s.mood >= 85)         { c.social = (c.social ?? 0) + 8; c.energy = (c.energy ?? 0) + 5; }
  else if (s.mood >= 70)    { c.social = (c.social ?? 0) + 4; c.energy = (c.energy ?? 0) + 2; }
  // High energy → mood, hygiene
  if (s.energy >= 85)       { c.mood = (c.mood ?? 0) + 6; c.hygiene = (c.hygiene ?? 0) + 3; }
  else if (s.energy >= 70)  { c.mood = (c.mood ?? 0) + 3; c.hygiene = (c.hygiene ?? 0) + 1; }
  // High hygiene → mood, social
  if (s.hygiene >= 85)      { c.mood = (c.mood ?? 0) + 5; c.social = (c.social ?? 0) + 6; }
  else if (s.hygiene >= 70) { c.mood = (c.mood ?? 0) + 2; c.social = (c.social ?? 0) + 3; }
  // High social → mood
  if (s.social >= 85)       { c.mood = (c.mood ?? 0) + 7; }
  else if (s.social >= 70)  { c.mood = (c.mood ?? 0) + 3; }
  // High reputation → mood, social
  if (s.reputation >= 85)    { c.mood = (c.mood ?? 0) + 5; c.social = (c.social ?? 0) + 8; }
  else if (s.reputation >= 70) { c.mood = (c.mood ?? 0) + 2; c.social = (c.social ?? 0) + 4; }
  // Low hunger (well-fed) → energy, mood
  if (s.hunger <= 15)        { c.energy = (c.energy ?? 0) + 4; c.mood = (c.mood ?? 0) + 3; }
  else if (s.hunger <= 30)  { c.energy = (c.energy ?? 0) + 2; c.mood = (c.mood ?? 0) + 1; }

  // Apply at 50% weight to avoid instant death spirals
  for (const [key, delta] of Object.entries(c)) {
    if (!(key in STATS)) continue;
    const def = STATS[key];
    s[key] = Math.max(def.min, Math.min(def.max, s[key] + delta * 0.5));
  }
  return s;
}

// ─── CASCADE EFFECTS ON JOB/SCHEDULE/RELATIONSHIPS ─────────────────────────────
export function applyCascadeEffectsToExternal(stats, job, school, npcs) {
  const effects = {
    jobPerformance: [],
    schoolPerformance: [],
    relationshipModifiers: {}
  };

  // Health affects job/school attendance and performance
  if (stats.health <= 20) {
    effects.jobPerformance.push('too_sick_to_work');
    effects.schoolPerformance.push('too_sick_to_attend');
  } else if (stats.health <= 40) {
    effects.jobPerformance.push('reduced_performance_health');
    effects.schoolPerformance.push('reduced_performance_health');
  }

  // Energy affects work/school performance
  if (stats.energy <= 15) {
    effects.jobPerformance.push('exhausted_at_work');
    effects.schoolPerformance.push('exhausted_at_school');
  } else if (stats.energy <= 30) {
    effects.jobPerformance.push('low_energy_performance');
    effects.schoolPerformance.push('low_energy_performance');
  }

  // Mood affects work/school performance and relationships
  if (stats.mood <= 15) {
    effects.jobPerformance.push('severely_depressed');
    effects.schoolPerformance.push('severely_depressed');
    // Low mood makes character irritable in relationships
    for (const [npcId, npc] of Object.entries(npcs || {})) {
      effects.relationshipModifiers[npcId] = (effects.relationshipModifiers[npcId] || 0) - 5;
    }
  } else if (stats.mood <= 30) {
    effects.jobPerformance.push('depressed_performance');
    effects.schoolPerformance.push('depressed_performance');
    for (const [npcId, npc] of Object.entries(npcs || {})) {
      effects.relationshipModifiers[npcId] = (effects.relationshipModifiers[npcId] || 0) - 2;
    }
  } else if (stats.mood >= 85) {
    effects.jobPerformance.push('excellent_mood');
    effects.schoolPerformance.push('excellent_mood');
    for (const [npcId, npc] of Object.entries(npcs || {})) {
      effects.relationshipModifiers[npcId] = (effects.relationshipModifiers[npcId] || 0) + 3;
    }
  }

  // Hygiene affects social interactions and some jobs
  if (stats.hygiene <= 15) {
    effects.jobPerformance.push('poor_hygiene');
    effects.schoolPerformance.push('poor_hygiene');
    for (const [npcId, npc] of Object.entries(npcs || {})) {
      effects.relationshipModifiers[npcId] = (effects.relationshipModifiers[npcId] || 0) - 4;
    }
  } else if (stats.hygiene <= 30) {
    effects.jobPerformance.push('below_average_hygiene');
    effects.schoolPerformance.push('below_average_hygiene');
    for (const [npcId, npc] of Object.entries(npcs || {})) {
      effects.relationshipModifiers[npcId] = (effects.relationshipModifiers[npcId] || 0) - 2;
    }
  }

  // Social affects relationship quality
  if (stats.social <= 15) {
    for (const [npcId, npc] of Object.entries(npcs || {})) {
      effects.relationshipModifiers[npcId] = (effects.relationshipModifiers[npcId] || 0) - 3;
    }
  } else if (stats.social >= 85) {
    for (const [npcId, npc] of Object.entries(npcs || {})) {
      effects.relationshipModifiers[npcId] = (effects.relationshipModifiers[npcId] || 0) + 4;
    }
  }

  // Reputation affects job opportunities and social standing
  if (stats.reputation <= 20) {
    effects.jobPerformance.push('poor_reputation');
    for (const [npcId, npc] of Object.entries(npcs || {})) {
      effects.relationshipModifiers[npcId] = (effects.relationshipModifiers[npcId] || 0) - 3;
    }
  } else if (stats.reputation >= 85) {
    effects.jobPerformance.push('excellent_reputation');
    for (const [npcId, npc] of Object.entries(npcs || {})) {
      effects.relationshipModifiers[npcId] = (effects.relationshipModifiers[npcId] || 0) + 3;
    }
  }

  return effects;
}

// ─── EMOTION COMPUTATION ──────────────────────────────────────────────────────
export function computeCharacterEmotions(stats, consequences = [], npcContext = null) {
  const e = [];
  // Check for situational emotions from NPC reactions first (highest priority)
  if (npcContext) {
    const npcs = Array.isArray(npcContext) ? npcContext : [npcContext];
    const uncomfortableNpcs = npcs.filter(n => n.active_flags?.includes('uncomfortable') || n.active_flags?.includes('angry') || n.active_flags?.includes('suspicious'));
    if (uncomfortableNpcs.length > 0) {
      e.push({ label: 'Embarrassed', cause: 'Caught in awkward situation' });
      if (uncomfortableNpcs.length > 1 || uncomfortableNpcs.some(n => n.active_flags?.includes('angry'))) {
        e.push({ label: 'Panicked', cause: 'Multiple witnesses upset' });
      }
    }
  }
  // Physical needs - allow multiple to coexist
  if (stats.hunger >= 80)       e.push({ label: 'Starving',   cause: 'Hasn\'t eaten in hours' });
  else if (stats.hunger >= 60)  e.push({ label: 'Hungry',     cause: 'Stomach is growling' });
  if (stats.health <= 20)       e.push({ label: 'Sick',       cause: 'Body is failing' });
  else if (stats.health <= 40)  e.push({ label: 'Unwell',     cause: 'Not feeling right' });
  if (stats.energy <= 10)       e.push({ label: 'Exhausted',  cause: 'Running on empty' });
  else if (stats.energy <= 25)  e.push({ label: 'Tired',      cause: 'Low on energy' });
  if (stats.hygiene <= 15)      e.push({ label: 'Grimy',      cause: 'Badly needs a shower' });
  else if (stats.hygiene <= 30) e.push({ label: 'Unkempt',    cause: 'Could use a wash' });
  // Mood — suppress positive labels when situational emotions (Embarrassed/Panicked) are active
  const _hasSituational = e.some(em => ['Embarrassed','Panicked'].includes(em.label));
  if (stats.mood <= 15)                              e.push({ label: 'Depressed', cause: 'Mood has bottomed out' });
  else if (stats.mood <= 30)                         e.push({ label: 'Down',      cause: 'Feeling low' });
  else if (!_hasSituational && stats.mood >= 88)     e.push({ label: 'Elated',   cause: 'Riding high right now' });
  else if (!_hasSituational && stats.mood >= 75)     e.push({ label: 'Upbeat',   cause: 'In good spirits' });
  // Social - allow coexistence
  if (stats.social <= 15)       e.push({ label: 'Isolated',   cause: 'Disconnected from everyone' });
  else if (stats.social >= 80)  e.push({ label: 'Connected', cause: 'Present and social' });
  // Arousal - always add if threshold met, coexists with other emotions
  if (stats.arousal >= 70)      e.push({ label: 'Horny',     cause: 'Strong physical urge' });
  else if (stats.arousal >= 50) e.push({ label: 'Aroused',   cause: 'Building tension' });
  else if (stats.arousal >= 30) e.push({ label: 'Restless',  cause: 'Mild tension' });
  // Consequences
  const ill = consequences.find(c => c.type === 'illness' || c.type === 'hospitalization');
  if (ill)   e.push({ label: 'Ill',      cause: `${ill.type.replace(/_/g,' ')} — ${ill.duration}t left` });
  const unemp = consequences.find(c => c.type === 'unemployment');
  if (unemp) e.push({ label: 'Stressed', cause: 'Out of work' });
  // Add baseline emotion if no strong emotions present
  if (e.length === 0) {
    if (stats.mood >= 65 && stats.health >= 65 && stats.energy >= 55) {
      e.push({ label: 'Fine', cause: 'Everything\'s holding together' });
    } else {
      e.push({ label: 'Neutral', cause: 'Coasting through the day' });
    }
  }
  return e.slice(0, 3);
}

export function computeNpcEmotions(npc) {
  const flags = npc.active_flags ?? [];
  const MAP = { resentment:'Resentful', jealousy_triggered:'Jealous', angry:'Angry', worried:'Worried', hurt:'Hurt', happy:'Happy', grateful:'Grateful', suspicious:'Suspicious', distant:'Distant', uncomfortable:'Uncomfortable', mistreated_recently:'Hurt', deepening_bond:'Close' };
  const e = [];
  for (const [flag, label] of Object.entries(MAP)) { if (flags.includes(flag)) e.push(label); }
  if (!e.length) {
    const r = npc.relationship_meter;
    e.push(r >= 60 ? 'Warm' : r >= 30 ? 'Friendly' : r <= -40 ? 'Cold' : r <= -20 ? 'Tense' : 'Neutral');
  }
  return e.slice(0, 2);
}