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
  { start_hour:  0, end_hour:  5, task: 'sleeping',     interruptible: false, location: 'home'      },
  { start_hour:  5, end_hour:  7, task: 'morning_prep', interruptible: false, location: 'home'      },
  { start_hour:  7, end_hour: 17, task: 'work',         interruptible: false, location: 'workplace' },
  { start_hour: 17, end_hour: 19, task: 'commuting',    interruptible: false, location: 'transit'   },
  { start_hour: 19, end_hour: 22, task: 'leisure',      interruptible: true,  location: 'home'      },
  { start_hour: 22, end_hour: 24, task: 'winding_down', interruptible: true,  location: 'home'      },
];

const DEFAULT_WEEKEND = [
  { start_hour:  0, end_hour:  8, task: 'sleeping',     interruptible: false, location: 'home'    },
  { start_hour:  8, end_hour: 11, task: 'leisure',      interruptible: true,  location: 'home'    },
  { start_hour: 11, end_hour: 14, task: 'errands',      interruptible: true,  location: 'outside' },
  { start_hour: 14, end_hour: 21, task: 'leisure',      interruptible: true,  location: 'home'    },
  { start_hour: 21, end_hour: 24, task: 'winding_down', interruptible: true,  location: 'home'    },
];

const PARENT_WEEKDAY = [
  { start_hour:  0, end_hour:  5, task: 'sleeping',     interruptible: false, location: 'home'      },
  { start_hour:  5, end_hour:  6, task: 'morning_prep', interruptible: true,  location: 'home'      },
  { start_hour:  6, end_hour: 17, task: 'work',         interruptible: false, location: 'workplace' },
  { start_hour: 17, end_hour: 18, task: 'commuting',    interruptible: false, location: 'transit'   },
  { start_hour: 18, end_hour: 21, task: 'leisure',      interruptible: true,  location: 'home'      },
  { start_hour: 21, end_hour: 24, task: 'sleeping',     interruptible: false, location: 'home'      },
];

const STUDENT_WEEKDAY = [
  { start_hour:  0, end_hour:  5, task: 'sleeping',     interruptible: false, location: 'home'    },
  { start_hour:  5, end_hour:  7, task: 'morning_prep', interruptible: false, location: 'home'    },
  { start_hour:  7, end_hour: 16, task: 'school',       interruptible: false, location: 'school'  },
  { start_hour: 16, end_hour: 18, task: 'commuting',    interruptible: false, location: 'transit' },
  { start_hour: 18, end_hour: 22, task: 'leisure',      interruptible: true,  location: 'home'    },
  { start_hour: 22, end_hour: 24, task: 'winding_down', interruptible: true,  location: 'home'    },
];

const HOUSEHOLD_WEEKDAY = [
  { start_hour:  0, end_hour:  6, task: 'sleeping',     interruptible: false, location: 'home'    },
  { start_hour:  6, end_hour:  8, task: 'morning_prep', interruptible: true,  location: 'home'    },
  { start_hour:  8, end_hour: 12, task: 'errands',      interruptible: true,  location: 'outside' },
  { start_hour: 12, end_hour: 15, task: 'leisure',      interruptible: true,  location: 'home'    },
  { start_hour: 15, end_hour: 18, task: 'errands',      interruptible: true,  location: 'outside' },
  { start_hour: 18, end_hour: 22, task: 'leisure',      interruptible: true,  location: 'home'    },
  { start_hour: 22, end_hour: 24, task: 'winding_down', interruptible: true,  location: 'home'    },
];

export { DEFAULT_WEEKDAY, DEFAULT_WEEKEND, STUDENT_WEEKDAY, HOUSEHOLD_WEEKDAY, PARENT_WEEKDAY };

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
    const _intLoc     = interruption.location ?? 'home';
    const _intPresent = !['workplace', 'school', 'transit'].includes(_intLoc);
    return {
      task:          interruption.task,
      interruptible: interruption.interruptible ?? true,
      available:     (interruption.available ?? false) && _intPresent,
      present:       _intPresent,
      location:      _intLoc,
      note:          interruption.note ?? null,
    };
  }

  const block = routine.find(b => hour >= b.start_hour && hour < b.end_hour);
  if (!block) return { task: 'unknown', interruptible: true, available: true, present: true, location: 'home' };
  const _present = !['workplace', 'school', 'transit'].includes(block.location ?? 'home');
  return {
    task:          block.task,
    interruptible: block.interruptible,
    available:     block.interruptible && _present,
    present:       _present,
    location:      block.location ?? 'home',
    note:          null,
  };
}

// ─── NPC FACTORY ─────────────────────────────────────────────────────────────
export function createNpc({ id, name, age, npc_class, relationship_type = null, traits = {}, schedule = null }) {
  return {
    id, name, age, npc_class,
    relationship_type: relationship_type ?? npc_class,
    status: 'active',
    known_npcs: {},
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

// ─── CAREER UPDATE ────────────────────────────────────────────────────────────
// Called when narration implies an NPC changed job, school, or living situation
export function updateNpcCareer(npc, change) {
  let updated = { ...npc, traits: { ...npc.traits }, schedule: { ...npc.schedule } };
  if (change.action === 'quit_job') {
    updated.job = null;
    if (updated.npc_class === 'professional') updated.npc_class = 'household';
    updated.schedule = { ...updated.schedule, weekday_routine: _pickSchedule(updated.relationship_type, updated.npc_class, updated.age) };
    updated.recent_interactions = [...(updated.recent_interactions ?? []), `[State update: quit their job]`].slice(-5);
  }
  if (change.action === 'new_job') {
    updated.job = change.details ?? {};
    updated.npc_class = 'professional';
    updated.schedule = { ...updated.schedule, weekday_routine: DEFAULT_WEEKDAY };
    updated.recent_interactions = [...(updated.recent_interactions ?? []), `[State update: started new job — ${change.details?.employer ?? 'unknown employer'}]`].slice(-5);
  }
  if (change.action === 'enroll_school') {
    updated.enrolled_school = change.details?.school_name ?? 'school';
    updated.schedule = { ...updated.schedule, weekday_routine: STUDENT_WEEKDAY };
    updated.recent_interactions = [...(updated.recent_interactions ?? []), `[State update: enrolled in school]`].slice(-5);
  }
  if (change.action === 'quit_school') {
    updated.enrolled_school = null;
    updated.schedule = { ...updated.schedule, weekday_routine: HOUSEHOLD_WEEKDAY };
  }
  if (change.action === 'move_away') {
    updated.active_flags = [...new Set([...(updated.active_flags ?? []), 'moved_away'])];
    updated.departure_reason = change.details?.destination ?? 'another city';
  }
  return updated;
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
    current_location:    task.location ?? 'home',
    present_at_home:     task.present !== false,
    available:           task.available,
    interruptible:       task.interruptible,
    recent_interactions: npc.recent_interactions.slice(-3),
    bio: npc.bio ?? null,
  };
}

// ─── PRE-CONSENT GATE ─────────────────────────────────────────────────────────
// JS-level — cannot be bypassed by player wording. Openness rises slowly via
// driftTraits (deepTrust, consistent_positive contexts), so the gate is not static.
export function checkNpcConsentGate(npc, actType) {
  const open  = npc.traits?.openness    ?? 50;
  const rel   = npc.relationship_meter;
  const trust = npc.trust_meter;

  // Established intimate partner — only gate on very bad standing
  if (npc.npc_class === 'intimate') {
    if (rel < -20) return 'refuse';
    return 'proceed';
  }

  const FULL_ACTS  = ['intercourse','oral_giving','oral_receiving','mutual_masturbation'];
  const LIGHT_ACTS = ['manual_giving','manual_receiving','makeout'];

  if (FULL_ACTS.includes(actType)) {
    if (open < 30 && !(trust >= 60 && rel >= 40)) return 'refuse';
    if (open < 50 && rel < 35)                    return 'refuse';
    if (rel < 35 || trust < 25)                   return 'refuse';
  }
  if (LIGHT_ACTS.includes(actType)) {
    if (open < 30 && trust < 40) return 'refuse';
    if (rel < 15 || trust < 10)  return 'refuse';
  }
  return 'proceed';
}

// ─── WITNESS REACTION ─────────────────────────────────────────────────────────
// How a bystander NPC reacts to witnessing an explicit act.
// Co-presence check happens in turnProcessor before this is called.
export function computeWitnessReaction(witnessNpc, primaryNpcId, actType) {
  const open     = witnessNpc.traits?.openness    ?? 50;
  const jealousy = witnessNpc.traits?.jealousy    ?? 30;
  const impuls   = witnessNpc.traits?.impulsivity ?? 40;
  const wRel     = witnessNpc.relationship_meter;

  const knownPrimary     = witnessNpc.known_npcs?.[primaryNpcId];
  const meterToPrimary   = knownPrimary?.meter ?? 0;
  const isLinkedToPrimary = meterToPrimary > 55;

  const FULL_ACTS = ['intercourse','oral_giving','oral_receiving','mutual_masturbation'];
  const isFullAct = FULL_ACTS.includes(actType);

  const result = { rel_delta: 0, trust_delta: 0, flags: [], summary: null, mood_label: 'neutral' };

  // Case 1 — Close bond with primary NPC (betrayal witness)
  if (isLinkedToPrimary && isFullAct) {
    const anger = Math.max(-20, Math.round(-12 - jealousy * 0.08 - impuls * 0.04));
    result.rel_delta   = anger;
    result.trust_delta = -12;
    result.flags = [{ flag:'betrayed', decay_rate:'slow' }, { flag:'angry', decay_rate:'medium' }];
    result.mood_label = 'betrayed';
    result.summary = `${witnessNpc.name} goes completely still — the kind of stillness that comes right before something breaks.`;
    return result;
  }

  // Case 2 — Jealous of player (has feelings for player, sees them with someone else)
  if (wRel > 40 && jealousy > 65 && isFullAct) {
    result.rel_delta   = -8;
    result.trust_delta = -4;
    result.flags = [{ flag:'jealousy_triggered', decay_rate:'medium' }];
    result.mood_label = 'jealous';
    result.summary = `${witnessNpc.name} clocks what's happening and looks away sharply, something tight crossing their face.`;
    return result;
  }

  // Case 3 — Family member (always uncomfortable regardless of openness)
  const FAMILY = new Set(['mother','father','brother','sister','uncle','aunt','grandmother','grandfather',
    'lola','lolo','guardian','parent_father','parent_mother','stepmother','stepfather','stepbrother','stepsister']);
  if (FAMILY.has(witnessNpc.relationship_type ?? '')) {
    result.rel_delta   = isFullAct ? -15 : -8;
    result.trust_delta = isFullAct ? -8  : -4;
    result.flags = [
      { flag:'uncomfortable', decay_rate:'medium' },
      ...(isFullAct ? [{ flag:'angry', decay_rate:'medium' }] : []),
    ];
    result.mood_label = 'horrified';
    result.summary = `${witnessNpc.name} stops dead in the doorway, then disappears. The silence that follows has weight.`;
    return result;
  }

  // Case 4 — High openness — curious or voyeuristic
  if (open > 70 && isFullAct) {
    result.rel_delta = Math.random() > 0.5 ? 2 : 0;
    result.flags = [{ flag:'aroused', decay_rate:'fast' }];
    result.mood_label = 'aroused';
    result.summary = `${witnessNpc.name} hesitates a beat longer than they should before finding somewhere else to be.`;
    return result;
  }

  // Case 5 — Low openness / conservative
  if (open < 30) {
    result.rel_delta   = isFullAct ? -6 : -3;
    result.trust_delta = isFullAct ? -3 : -1;
    result.flags = [{ flag:'uncomfortable', decay_rate:'medium' }];
    result.mood_label = 'uncomfortable';
    result.summary = `${witnessNpc.name} leaves without a word. The kind of silence that tends to linger.`;
    return result;
  }

  // Default — average person, embarrassed
  result.rel_delta = -2;
  result.flags = [{ flag:'uncomfortable', decay_rate:'fast' }];
  result.mood_label = 'embarrassed';
  result.summary = `${witnessNpc.name} realizes what they walked in on a beat too late, then quietly exits.`;
  return result;
}