// challenges.js — Challenge card system for significant life events
'use strict';

export const CHALLENGE_SEVERITY = { MINOR: 'minor', MODERATE: 'moderate', MAJOR: 'major', CRITICAL: 'critical' };

export function createChallenge({ id, type, title, cause, description, effects_text, resolution_steps, severity, linked_npc_id = null, created_turn = null }) {
  return { id, type, title, cause, description, effects_text, resolution_steps, severity, linked_npc_id, created_turn, active: true, acknowledged: false, resolved: false };
}

// ─── FACTORIES ────────────────────────────────────────────────────────────────
export function challengeFromDisease(disease, cause, turn) {
  const sMap = { minor: 'minor', moderate: 'moderate', serious: 'major', critical: 'critical' };
  return createChallenge({
    id: `disease_${disease.id}_${Date.now()}`,
    type: 'health',
    title: disease.challenge_title ?? disease.name,
    cause: `You contracted ${disease.name.toLowerCase()} — ${cause}.`,
    description: `Your body is fighting ${disease.name}. Daily activities are harder than usual.`,
    effects_text: disease.challenge_effects_text ?? 'Ongoing health, energy, and mood penalties per turn.',
    resolution_steps: disease.resolution ?? 'Rest and maintain your stats.',
    severity: sMap[disease.severity] ?? 'minor',
    created_turn: turn,
  });
}

export function challengeFromNpcEvent(npcEvent, npc, turn) {
  const configs = {
    npc_dies: {
      type: 'loss',
      title: `${npc.name} Has Passed Away`,
      cause: `${npc.name} (your ${(npc.relationship_type ?? 'contact').replace(/_/g,' ')}) has died.`,
      description: 'A loss like this leaves a mark. Grief will affect your daily functioning for some time.',
      effects_text: 'Mood significantly reduced. Social connection lost. Recovery takes many turns.',
      resolution_steps: 'Allow yourself to grieve. Connect with others who knew them. Mood recovers gradually over time.',
      severity: npc.significance >= 3 ? 'critical' : 'major',
    },
    npc_major_illness: {
      type: 'relationship',
      title: `${npc.name} Has Been Hospitalized`,
      cause: `${npc.name} has been admitted to the hospital with a serious illness.`,
      description: 'Someone close to you is seriously ill and needs support.',
      effects_text: 'Their availability is severely limited. Visiting costs time and energy.',
      resolution_steps: `Support ${npc.name} through this. They will recover over time if attended to.`,
      severity: 'major',
    },
  };
  const cfg = configs[npcEvent.id];
  if (!cfg) return null;
  return createChallenge({ ...cfg, id: `npc_${npcEvent.id}_${npc.id}_${Date.now()}`, linked_npc_id: npc.id, created_turn: turn });
}

export function challengeFromWorldEvent(event, worldState) {
  const turn = worldState.turn ?? 0;
  const configs = {
    school_suspension: {
      type: 'academic',
      title: 'Suspended from School',
      cause: `Accumulated absences (${worldState.school?.absence_count ?? 0}) triggered disciplinary action.`,
      description: 'You have been suspended from school. Returning requires serving the full suspension period.',
      effects_text: 'Reputation -15, Mood -25. School access blocked. Further absences post-return risk expulsion.',
      resolution_steps: 'Serve the 5-day suspension. Return punctually and avoid further absences.',
      severity: 'moderate',
    },
    job_termination: {
      type: 'employment',
      title: 'Terminated from Employment',
      cause: 'Repeated poor performance or warnings led to termination.',
      description: 'You have lost your job. Finding new employment will take real effort.',
      effects_text: 'No income. Mood -20, Reputation -5. Financial pressure will build over time.',
      resolution_steps: 'Search for and apply to new employment. Your reputation will gradually recover.',
      severity: 'major',
    },
    job_written_up: {
      type: 'employment',
      title: 'Formal Warning at Work',
      cause: 'A formal disciplinary warning was issued for attendance or performance issues.',
      description: 'Your employer has issued a written warning. One more serious infraction risks termination.',
      effects_text: 'Mood -10, Reputation -3. One further warning likely means being fired.',
      resolution_steps: 'Improve attendance and performance. Avoid any further flags.',
      severity: 'moderate',
    },
    illness_minor: {
      type: 'health',
      title: "Feeling Under the Weather",
      cause: 'Poor health and hygiene left you vulnerable to illness.',
      description: 'A minor illness is draining your energy and mood.',
      effects_text: 'Ongoing energy and mood penalties per turn.',
      resolution_steps: 'Rest, eat, and maintain hygiene. Health above 70 will speed recovery.',
      severity: 'minor',
    },
    illness_severe: {
      type: 'health',
      title: 'Hospitalized — Critical Health Event',
      cause: 'Your health declined to a critical level requiring emergency medical care.',
      description: 'You were hospitalized. Recovery and medical bills will take significant resources.',
      effects_text: 'Health severely reduced. Cash -₱5,000. Requires sustained rest to recover.',
      resolution_steps: 'Rest extensively and maintain health above 50. Avoid strenuous activities.',
      severity: 'critical',
    },
    minor_accident: {
      type: 'health',
      title: 'Injured in an Accident',
      cause: 'Fatigue or distress led to a lapse in attention, resulting in injury.',
      description: 'You were hurt. Rest is needed before returning to full capacity.',
      effects_text: 'Health -10, Energy -8, Mood -10. Avoid strain while healing.',
      resolution_steps: 'Rest and avoid physical exertion. Health will recover in a few days.',
      severity: 'minor',
    },
  };
  const cfg = configs[event.id];
  if (!cfg) return null;
  return createChallenge({ ...cfg, id: `world_${event.id}_${Date.now()}`, created_turn: turn });
}

// ─── HANGOVER CHALLENGE ───────────────────────────────────────────────────────
export function challengeFromHangover(turn) {
  return createChallenge({
    id: `hangover_${Date.now()}`,
    type: 'health',
    title: 'Nursing a Hangover',
    cause: 'Heavy alcohol consumption led to a hangover.',
    description: 'Your head is pounding. Light and noise are painful. Everything feels like too much effort.',
    effects_text: 'Energy -15, Mood -20, Health -2 per turn. Low productivity. Sensitivity to stimulation.',
    resolution_steps: 'Rest, drink water, eat a light meal. Will pass within a day or two.',
    severity: 'minor',
    created_turn: turn,
  });
}

// ─── RESOLUTION CHECK ────────────────────────────────────────────────────────
export function checkChallengeResolution(challenge, worldState) {
  if (!challenge.active || challenge.resolved) return false;
  switch (challenge.type) {
    case 'health': {
      const hasDiseaseMatch = (worldState.player?.diseases ?? []).some(d => challenge.id.includes(d.id));
      const hasConsequenceMatch = (worldState.consequences ?? []).some(c =>
        ['illness','hospitalization','minor_injury'].includes(c.type));
      return !hasDiseaseMatch && !hasConsequenceMatch;
    }
    case 'academic':
      return worldState.school?.status === 'active' && !(worldState.school?.suspension_turns_remaining > 0);
    case 'employment':
      if (challenge.id.includes('termination')) return !!worldState.job;
      if (challenge.id.includes('written_up')) return !worldState.job?.performance_flags?.includes('formal_warning');
      return false;
    case 'loss':
    case 'relationship': {
      const turnsSince = (worldState.turn ?? 0) - (challenge.created_turn ?? 0);
      return turnsSince > 25;
    }
    default:
      return false;
  }
}