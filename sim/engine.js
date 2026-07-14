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
    s[key] = Math.max(def.min, Math.min(def.max, s[key] - def.decay * hoursElapsed));
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
  // Hunger → energy, mood, social
  if (s.hunger >= 85)       { c.energy = -15; c.mood = -12; c.social = -8; }
  else if (s.hunger >= 65)  { c.energy = -7;  c.mood = -5;  c.social = -4; }
  else if (s.hunger >= 45)  { c.energy = -2;  c.mood = -1; }
  // Low energy → mood, hygiene
  if (s.energy <= 10)       { c.mood = (c.mood ?? 0) - 10; c.hygiene = (c.hygiene ?? 0) - 4; }
  else if (s.energy <= 25)  { c.mood = (c.mood ?? 0) - 4; }
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
  // Apply at 50% weight to avoid instant death spirals
  for (const [key, delta] of Object.entries(c)) {
    if (!(key in STATS)) continue;
    const def = STATS[key];
    s[key] = Math.max(def.min, Math.min(def.max, s[key] + delta * 0.5));
  }
  return s;
}

// ─── EMOTION COMPUTATION ──────────────────────────────────────────────────────
export function computeCharacterEmotions(stats, consequences = []) {
  const e = [];
  if (stats.hunger >= 80)       e.push({ label: 'Starving',  cause: 'Hasn\'t eaten in hours' });
  else if (stats.hunger >= 60)  e.push({ label: 'Hungry',    cause: 'Stomach is growling' });
  if (stats.health <= 20)       e.push({ label: 'Sick',      cause: 'Body is failing' });
  else if (stats.health <= 40)  e.push({ label: 'Unwell',    cause: 'Not feeling right' });
  if (stats.energy <= 10)       e.push({ label: 'Exhausted', cause: 'Running on empty' });
  else if (stats.energy <= 25)  e.push({ label: 'Tired',     cause: 'Low on energy' });
  if (stats.hygiene <= 15)      e.push({ label: 'Grimy',     cause: 'Badly needs a wash' });
  if (stats.mood <= 15)         e.push({ label: 'Depressed', cause: 'Mood has bottomed out' });
  else if (stats.mood <= 30)    e.push({ label: 'Down',      cause: 'Feeling low' });
  else if (stats.mood >= 80)    e.push({ label: 'Upbeat',    cause: 'In good spirits' });
  if (stats.social <= 15)       e.push({ label: 'Isolated',  cause: 'Disconnected from everyone' });
  if (stats.arousal >= 70)      e.push({ label: 'Tense',     cause: 'Pent-up tension' });
  const ill = consequences.find(c => c.type === 'illness' || c.type === 'hospitalization');
  if (ill) e.push({ label: 'Ill', cause: `${ill.type.replace(/_/g,' ')} — ${ill.duration}t left` });
  const unemp = consequences.find(c => c.type === 'unemployment');
  if (unemp) e.push({ label: 'Stressed', cause: 'Out of work' });
  if (!e.length) {
    e.push(stats.mood >= 65 && stats.health >= 65 && stats.energy >= 55
      ? { label: 'Fine',    cause: 'Everything\'s okay' }
      : { label: 'Neutral', cause: 'Coasting' });
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