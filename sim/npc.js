// npc.js — NPC profiles, trait arrays, relationship logic, scheduler
// Fix #5: each NPC has a weekly schedule with availability computation
'use strict';

// ─── NPC CLASSES ─────────────────────────────────────────────────────────────
export const NPC_CLASS = {
  INTIMATE:      'intimate',
  HOUSEHOLD:     'household',
  PROFESSIONAL:  'professional',
  INSTITUTIONAL: 'institutional',
};

// ─── FLAG DECAY (in turns) ────────────────────────────────────────────────────
export const FLAG_DECAY = { slow: 20, medium: 8, fast: 3 };

// ─── DEFAULT SCHEDULES ────────────────────────────────────────────────────────
const DEFAULT_WEEKDAY = [
  { start_hour:  0, end_hour:  7, task: 'sleeping',     interruptible: false },
  { start_hour:  7, end_hour:  8, task: 'morning_prep', interruptible: false },
  { start_hour:  8, end_hour: 17, task: 'work',         interruptible: false },
  { start_hour: 17, end_hour: 19, task: 'commuting',    interruptible: false },
  { start_hour: 19, end_hour: 22, task: 'leisure',      interruptible: true  },
  { start_hour: 22, end_hour: 24, task: 'winding_down', interruptible: true  },
];

const DEFAULT_WEEKEND = [
  { start_hour:  0, end_hour:  9, task: 'sleeping',     interruptible: false },
  { start_hour:  9, end_hour: 12, task: 'leisure',      interruptible: true  },
  { start_hour: 12, end_hour: 14, task: 'errands',      interruptible: true  },
  { start_hour: 14, end_hour: 22, task: 'leisure',      interruptible: true  },
  { start_hour: 22, end_hour: 24, task: 'winding_down', interruptible: true  },
];

const PARENT_WEEKDAY = [
  { start_hour:  0, end_hour:  5, task: 'sleeping',     interruptible: false },
  { start_hour:  5, end_hour:  7, task: 'morning_prep', interruptible: true  },
  { start_hour:  7, end_hour: 17, task: 'work',         interruptible: false },
  { start_hour: 17, end_hour: 19, task: 'errands',      interruptible: true  },
  { start_hour: 19, end_hour: 22, task: 'leisure',      interruptible: true  },
  { start_hour: 22, end_hour: 24, task: 'sleeping',     interruptible: false },
];

const STUDENT_WEEKDAY = [
  { start_hour:  0, end_hour:  6, task: 'sleeping',     interruptible: false },
  { start_hour:  6, end_hour:  7, task: 'morning_prep', interruptible: false },
  { start_hour:  7, end_hour: 16, task: 'school',       interruptible: false },
  { start_hour: 16, end_hour: 18, task: 'commuting',    interruptible: false },
  { start_hour: 18, end_hour: 22, task: 'leisure',      interruptible: true  },
  { start_hour: 22, end_hour: 24, task: 'winding_down', interruptible: true  },
];

const HOUSEHOLD_WEEKDAY = [
  { start_hour:  0, end_hour:  9, task: 'sleeping',     interruptible: false },
  { start_hour:  9, end_hour: 11, task: 'morning_prep', interruptible: true  },
  { start_hour: 11, end_hour: 14, task: 'errands',      interruptible: true  },
  { start_hour: 14, end_hour: 17, task: 'leisure',      interruptible: true  },
  { start_hour: 17, end_hour: 20, task: 'errands',      interruptible: true  },
  { start_hour: 20, end_hour: 23, task: 'leisure',      interruptible: true  },
  { start_hour: 23, end_hour: 24, task: 'winding_down', interruptible: true  },
];

function _pickSchedule(relationship_type, npc_class, age) {
  const rt = (relationship_type ?? '').toLowerCase();
  if (rt === 'mother' || rt === 'father')                                               return PARENT_WEEKDAY;
  if ((rt === 'brother' || rt === 'sister' || rt === 'classmate') && age && age < 23)  return STUDENT_WEEKDAY;
  if (npc_class === 'professional')                                                     return DEFAULT_WEEKDAY;
  if (npc_class === 'household' || npc_class === 'intimate')                           return HOUSEHOLD_WEEKDAY;
  return DEFAULT_WEEKDAY;
}

// ─── SCHEDULER ────────────────────────────────────────────────────────────────
export function getNpcCurrentTask(npc, currentDate) {
  const d          = new Date(currentDate);
  const hour       = d.getHours() + d.getMinutes() / 60;
  const isWeekend  = d.getDay() === 0 || d.getDay() === 6;
  const routine    = isWeekend
    ? (npc.schedule?.weekend_routine ?? DEFAULT_WEEKEND)
    : (npc.schedule?.weekday_routine ?? DEFAULT_WEEKDAY);

  // Check one-off interruptions first
  const interruption = (npc.schedule?.interruptions ?? []).find(i => {
    const s = new Date(i.start), e = new Date(i.end);
    return d >= s && d <= e;
  });
  if (interruption) {
    return {
      task:          interruption.task,
      interruptible: interruption.interruptible ?? true,
      available:     interruption.available     ?? false,
      note:          interruption.note           ?? null,
    };
  }

  const block = routine.find(b => hour >= b.start_hour && hour < b.end_hour);
  if (!block) return { task: 'unknown', interruptible: true, available: true };
  return {
    task:          block.task,
    interruptible: block.interruptible,
    available:     block.interruptible,
    note:          null,
  };
}

// ─── NPC FACTORY ─────────────────────────────────────────────────────────────
export function createNpc({ id, name, age, npc_class, relationship_type = null, traits = {}, schedule = null }) {
  return {
    id, name, age, npc_class,
    relationship_type: relationship_type ?? npc_class,
    status: 'active',
    traits: {
      jealousy:    traits.jealousy    ?? 30,
      honesty:     traits.honesty     ?? 60,
      patience:    traits.patience    ?? 50,
      warmth:      traits.warmth      ?? 50,
      ambition:    traits.ambition    ?? 50,
      impulsivity: traits.impulsivity ?? 40,
      dominance:   traits.dominance   ?? 50,
      openness:    traits.openness    ?? 50,
    },
    relationship_meter: 0,
    trust_meter:        0,
    active_flags:       [],
    flag_timers:        {},
    recent_interactions: [],
    significance:        0,
    schedule: schedule ?? {
      weekday_routine: _pickSchedule(relationship_type, npc_class, age),
      weekend_routine: DEFAULT_WEEKEND,
      interruptions:   [],
    },
  };
}

// ─── RELATIONSHIP ─────────────────────────────────────────────────────────────
export function applyRelationshipDelta(npc, relDelta, trustDelta = null) {
  return {
    ...npc,
    relationship_meter: Math.max(-100, Math.min(100, npc.relationship_meter + relDelta)),
    trust_meter:        Math.max(-100, Math.min(100, npc.trust_meter + (trustDelta ?? relDelta * 0.4))),
  };
}

export function tickFlagDecay(npc) {
  const timers = { ...npc.flag_timers };
  let   flags  = [...npc.active_flags];
  for (const flag of Object.keys(timers)) {
    timers[flag] -= 1;
    if (timers[flag] <= 0) {
      delete timers[flag];
      flags = flags.filter(f => f !== flag);
    }
  }
  return { ...npc, flag_timers: timers, active_flags: flags };
}

export function addFlag(npc, flag, decayTurns) {
  const flags  = npc.active_flags.includes(flag) ? [...npc.active_flags] : [...npc.active_flags, flag];
  const timers = { ...npc.flag_timers, [flag]: decayTurns };
  return { ...npc, active_flags: flags, flag_timers: timers };
}

// ─── TRAIT DRIFT ─────────────────────────────────────────────────────────────
// Traits shift slowly based on repeated interactions. Max ±3 per call.
export function driftTraits(npc, context = {}) {
  const t = { ...(npc.traits ?? {}) };
  if (context.mistreated) {
    t.warmth      = Math.max(0,   (t.warmth      ?? 50) - 2);
    t.impulsivity = Math.min(100, (t.impulsivity ?? 50) + 1);
    t.jealousy    = Math.min(100, (t.jealousy    ?? 50) + 1);
    t.openness    = Math.max(0,   (t.openness    ?? 50) - 1);
  }
  if (context.deepTrust && npc.trust_meter >= 55) {
    t.openness  = Math.min(100, (t.openness  ?? 50) + 1);
    t.jealousy  = Math.max(0,   (t.jealousy  ?? 50) - 1);
    t.warmth    = Math.min(100, (t.warmth    ?? 50) + 1);
  }
  if (context.consistent_positive && npc.relationship_meter >= 35) {
    t.warmth    = Math.min(100, (t.warmth    ?? 50) + 1);
    t.patience  = Math.min(100, (t.patience  ?? 50) + 1);
  }
  if (context.betrayed) {
    t.warmth      = Math.max(0,   (t.warmth    ?? 50) - 3);
    t.openness    = Math.max(0,   (t.openness  ?? 50) - 2);
    t.impulsivity = Math.min(100, (t.impulsivity ?? 50) + 2);
  }
  return { ...npc, traits: t };
}

export function incrementSignificance(npc) {
  return { ...npc, significance: npc.significance + 1 };
}

export function shouldPromoteToCard(npc, lastRelDelta = 0) {
  return npc.significance >= 2 || Math.abs(lastRelDelta) >= 10;
}

export function buildNpcContextForGemini(npc, currentDate) {
  const task = getNpcCurrentTask(npc, currentDate);
  return {
    id:                  npc.id,
    name:                npc.name,
    age:                 npc.age,
    npc_class:           npc.npc_class,
    relationship_type:   npc.relationship_type ?? npc.npc_class,
    traits:              npc.traits,
    relationship_meter:  npc.relationship_meter,
    trust_meter:         npc.trust_meter,
    active_flags:        npc.active_flags,
    current_task:        task.task,
    available:           task.available,
    interruptible:       task.interruptible,
    recent_interactions: npc.recent_interactions.slice(-3),
  };
}