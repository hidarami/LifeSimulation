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
    debt_collector_visit: {
      type: 'financial',
      title: 'Debt Collector Came Knocking',
      cause: 'An overdue debt triggered a collector visit.',
      description: 'A debt collector has made contact. The clock is ticking on your overdue obligation.',
      effects_text: 'Mood -20, Reputation -8. Continued non-payment escalates to legal action.',
      resolution_steps: 'Pay the outstanding debt as soon as possible. Each day overdue adds interest.',
      severity: 'moderate',
    },
    loan_shark_threat: {
      type: 'danger',
      title: 'Threatened by Loan Shark',
      cause: 'A loan shark debt is severely overdue.',
      description: 'You are being threatened with physical harm over an unpaid loan shark debt.',
      effects_text: 'Health risk every few turns. Mood severely affected. Violence is imminent.',
      resolution_steps: 'Pay immediately or find protection. Do not ignore this.',
      severity: 'critical',
    },
    debt_accumulation: {
      type: 'financial',
      title: 'Debt Is Piling Up',
      cause: 'No income and mounting bills have created a debt obligation.',
      description: 'Bills have turned into formal debt. Creditors are now expecting repayment.',
      effects_text: 'Reputation and mood hit each overdue turn. Interest compounds weekly.',
      resolution_steps: 'Find employment or other income. Start making any payments you can.',
      severity: 'moderate',
    },
    debt_lawsuit: {
      type: 'legal',
      title: 'Sued by Creditor',
      cause: 'An unpaid debt has escalated to a formal lawsuit.',
      description: 'You are being taken to court over unpaid debt. Legal costs and garnishments loom.',
      effects_text: 'Reputation -20, Cash -₱5,000. Court date pending. Assets may be at risk.',
      resolution_steps: 'Settle the debt if possible. Seek legal counsel. Avoid further defaults.',
      severity: 'critical',
    },
    police_patrol_encounter: {
      type: 'legal',
      title: 'Stopped by Police',
      cause: 'Your criminal record raised a red flag during a routine patrol.',
      description: 'Police have taken interest in you. Your record makes encounters more frequent.',
      effects_text: 'Mood -15. Risk of escalation if wanted level is high. Random checks possible.',
      resolution_steps: 'Stay out of trouble. Wanted level decreases gradually with clean behavior.',
      severity: 'moderate',
    },
    criminal_record_rejection: {
      type: 'legal',
      title: 'Criminal Record Closes a Door',
      cause: 'Your record blocked an opportunity you were pursuing.',
      description: 'Having a criminal record is costing you chances that others take for granted.',
      effects_text: 'Mood -15, Reputation -5. Employment, housing, or social opportunities restricted.',
      resolution_steps: 'Build up reputation through positive actions. Some doors reopen with time.',
      severity: 'moderate',
    },
    bystander_robbery: {
      type: 'danger',
      title: 'Robbed',
      cause: 'You were mugged while out.',
      description: 'Someone took your money by force. The experience is rattling.',
      effects_text: 'Health -10, Mood -25, cash lost. Social confidence shaken.',
      resolution_steps: 'Rest and recover. Consider avoiding high-risk areas and times.',
      severity: 'major',
    },
    media_scandal: {
      type: 'fame',
      title: 'Public Scandal',
      cause: 'Private behavior or failures became public amid your public profile.',
      description: 'Your reputation is under attack in the public eye.',
      effects_text: 'Reputation severely reduced. Follower loss. Public scrutiny elevated.',
      resolution_steps: 'Stay out of further controversy. Time and good deeds rebuild image.',
      severity: 'major',
    },
    addiction_withdrawal: {
      type: 'health',
      title: 'Withdrawal Episode',
      cause: 'Going without a substance you depend on triggered withdrawal.',
      description: 'Your body is fighting against deprivation. The symptoms are physically real.',
      effects_text: 'Health, energy, and mood severely impacted each turn during withdrawal.',
      resolution_steps: 'Endure the withdrawal period. Symptoms ease as your body adjusts. Seek help if severe.',
      severity: 'moderate',
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

// ─── DEBT CHALLENGE ────────────────────────────────────────────────────────────
export function challengeFromDebt(debt, turn) {
  const sev = { loan_shark: 'critical', rent: 'major', bank: 'moderate', personal: 'moderate' }[debt.type] ?? 'moderate';
  const cur = (typeof localStorage !== 'undefined' ? localStorage.getItem('CURRENCY_SYMBOL') : null) || '₱';
  return createChallenge({
    id: `debt_${debt.id}_${Date.now()}`,
    type: 'financial',
    title: `Debt to ${debt.creditor}`,
    cause: `You owe ${debt.creditor} — ${debt.description || 'outstanding debt'}.`,
    description: `An outstanding debt demands repayment. Interest accumulates and pressure mounts.`,
    effects_text: `${cur}${debt.amount.toLocaleString()} owed. Mood -10, Reputation -8 if overdue. Debt collector visits possible.`,
    resolution_steps: `Earn money and pay off the debt. Full payment clears this challenge.`,
    severity: sev,
    created_turn: turn,
  });
}

// ─── CRIMINAL CHALLENGE ───────────────────────────────────────────────────────
export function challengeFromCrime(crime, wantedLevel, turn) {
  const titles = {
    theft: 'Accused of Theft', assault: 'Assault Charge', vandalism: 'Vandalism Record',
    drug_possession: 'Drug Possession Charge', public_disturbance: 'Disorderly Conduct Record',
  };
  return createChallenge({
    id: `crime_${crime.id}_${Date.now()}`,
    type: 'legal',
    title: titles[crime.type] ?? `Criminal Record — ${crime.type.replace(/_/g, ' ')}`,
    cause: `You have a ${crime.severity} criminal record for ${crime.type.replace(/_/g, ' ')}.`,
    description: `Your criminal record is affecting daily life. Police interest is elevated.`,
    effects_text: `Wanted Level: ${wantedLevel}/5. Job rejections possible. Police encounters more frequent.`,
    resolution_steps: `Lay low and avoid further criminal activity. Wanted level fades over time. Seek legal help if possible.`,
    severity: crime.severity === 'major' ? 'critical' : crime.severity === 'moderate' ? 'major' : 'moderate',
    created_turn: turn,
  });
}

// ─── ADDICTION CHALLENGE ──────────────────────────────────────────────────────
export function challengeFromAddiction(addiction, turn) {
  const names = { alcohol: 'Alcohol', drugs: 'Substance', gambling: 'Gambling', smoking: 'Nicotine', caffeine: 'Caffeine' };
  const name = names[addiction.type] ?? addiction.type;
  return createChallenge({
    id: `addiction_${addiction.id}_${Date.now()}`,
    type: 'health',
    title: `${name} Dependency — ${addiction.severity.charAt(0).toUpperCase() + addiction.severity.slice(1)}`,
    cause: `Repeated use has developed into a ${addiction.severity} ${name.toLowerCase()} dependency.`,
    description: `Your body and mind depend on this substance. Abstinence triggers real suffering.`,
    effects_text: `Cravings hit regularly. ${addiction.severity === 'severe' ? 'Severe withdrawal damages health.' : 'Withdrawal causes energy and mood crashes.'}`,
    resolution_steps: `Reduce use gradually. Sustained abstinence over many turns leads to recovery. Severity can decrease.`,
    severity: addiction.severity === 'severe' ? 'critical' : addiction.severity === 'moderate' ? 'major' : 'moderate',
    created_turn: turn,
  });
}

// ─── FAME / SCANDAL CHALLENGE ─────────────────────────────────────────────────
export function challengeFromScandal(description, fameLevel, turn) {
  return createChallenge({
    id: `scandal_${Date.now()}`,
    type: 'fame',
    title: 'Public Scandal',
    cause: description || 'Private matters became public knowledge.',
    description: `Your public image has taken a serious hit. The media and audience are watching every move.`,
    effects_text: `Reputation reduced. Follower count dropping. Every action is under scrutiny.`,
    resolution_steps: `Maintain good public behavior. Avoid further incidents. Time and positive actions restore reputation.`,
    severity: fameLevel >= 3 ? 'critical' : 'major',
    created_turn: turn,
  });
}

// ─── LEGAL / DANGER CHALLENGES ────────────────────────────────────────────────
export function challengeFromLoanShark(debtAmount, turn) {
  const cur = (typeof localStorage !== 'undefined' ? localStorage.getItem('CURRENCY_SYMBOL') : null) || '₱';
  return createChallenge({
    id: `loanshark_${Date.now()}`,
    type: 'danger',
    title: 'Loan Shark Threat',
    cause: `You owe a loan shark ${cur}${debtAmount.toLocaleString()} and have not paid.`,
    description: `You are being threatened. Physical harm is a real possibility if debt is not cleared.`,
    effects_text: `Mood -30, Health risk each turn. Violence is possible if debt ignored much longer.`,
    resolution_steps: `Pay the debt immediately. Involve authorities if threatened. Borrow from safer sources to cover it.`,
    severity: 'critical',
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
    case 'financial':
      return (worldState.debts ?? []).every(d => d.status === 'paid' || d.status === 'forgiven' || d.status !== 'overdue');
    case 'legal':
      return (worldState.criminal_record?.wanted_level ?? 0) === 0 && !worldState.criminal_record?.has_record;
    case 'danger': {
      const dangerTurns = (worldState.turn ?? 0) - (challenge.created_turn ?? 0);
      return dangerTurns > 30 && (worldState.debts ?? []).every(d => d.type !== 'loan_shark' || d.status === 'paid');
    }
    case 'fame': {
      const fameTurns = (worldState.turn ?? 0) - (challenge.created_turn ?? 0);
      return fameTurns > 20 && worldState.player.stats.reputation >= 70;
    }
    default:
      return false;
  }
}