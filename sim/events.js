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
  // ── DEBT ────────────────────────────────────────────────────────────────────
  {
    id: 'debt_collector_visit',
    category: 'financial',
    label: 'Debt collector demands payment',
    condition: ws => (ws.debts ?? []).some(d => d.status === 'overdue'),
    probability: 0.35,
    effect: ws => {
      const debt = (ws.debts ?? []).find(d => d.status === 'overdue');
      return {
        stat_deltas: { mood: -20, reputation: -8, social: -10 },
        consequence: { type: 'debt_pressure', severity: 'moderate', duration: 5 },
        debt_event: { type: 'collector_visit', debt_id: debt?.id },
      };
    },
    challenge_trigger: true,
    challenge_type: 'financial',
  },
  {
    id: 'loan_shark_threat',
    category: 'danger',
    label: 'Loan shark sends threatening message',
    condition: ws => (ws.debts ?? []).some(d => d.type === 'loan_shark' && d.status === 'overdue'),
    probability: 0.55,
    effect: () => ({
      stat_deltas: { mood: -30, health: -5, social: -15 },
      consequence: { type: 'physical_threat', severity: 'major', duration: 10 },
    }),
    challenge_trigger: true,
    challenge_type: 'danger',
  },
  {
    id: 'debt_accumulation',
    category: 'financial',
    label: 'Unpaid bills pile up into debt',
    condition: ws => ws.player.cash < 200 && ws.job === null && !(ws.debts ?? []).some(d => d.status === 'active' && d.type === 'rent'),
    probability: 0.10,
    effect: () => ({
      stat_deltas: { mood: -10, reputation: -3 },
      add_debt: { creditor: 'Landlord', amount: 2000, type: 'rent', turns_due: 20, interest_rate: 0.02, description: 'Overdue rent and utilities' },
    }),
    challenge_trigger: true,
    challenge_type: 'financial',
  },
  {
    id: 'debt_lawsuit',
    category: 'legal',
    label: 'Creditor files lawsuit',
    condition: ws => (ws.debts ?? []).some(d => d.status === 'overdue' && (d.turns_remaining ?? 0) <= -20),
    probability: 0.15,
    effect: () => ({
      stat_deltas: { mood: -35, reputation: -20, social: -15 },
      cash_delta: -5000,
      consequence: { type: 'lawsuit', severity: 'critical', duration: 30 },
    }),
    challenge_trigger: true,
    challenge_type: 'legal',
  },
  {
    id: 'unexpected_windfall',
    category: 'financial',
    label: 'Unexpected money arrives',
    condition: ws => ws.player.stats.reputation > 60 && ws.player.stats.mood > 65,
    probability: 0.02,
    effect: () => ({
      cash_delta: Math.floor(Math.random() * 3000) + 500,
      stat_deltas: { mood: 20 },
    }),
    challenge_trigger: false,
  },
  // ── CRIMINALITY ─────────────────────────────────────────────────────────────
  {
    id: 'police_patrol_encounter',
    category: 'legal',
    label: 'Police stops and questions you',
    condition: ws => (ws.criminal_record?.wanted_level ?? 0) >= 1,
    probability: 0.14,
    effect: ws => {
      const wl = ws.criminal_record?.wanted_level ?? 0;
      return {
        stat_deltas: { mood: -15, social: -8 },
        consequence: { type: 'police_encounter', severity: wl >= 3 ? 'major' : 'moderate', duration: 2 },
        criminal_event: { type: 'stopped', escalate: wl >= 4 },
      };
    },
    challenge_trigger: true,
    challenge_type: 'legal',
  },
  {
    id: 'criminal_record_rejection',
    category: 'legal',
    label: 'Criminal record blocks an opportunity',
    condition: ws => ws.criminal_record?.has_record && ws.player.stats.reputation < 50,
    probability: 0.09,
    effect: () => ({
      stat_deltas: { mood: -15, reputation: -5 },
      consequence: { type: 'record_stigma', severity: 'moderate', duration: 15 },
    }),
    challenge_trigger: true,
    challenge_type: 'legal',
  },
  {
    id: 'bystander_robbery',
    category: 'danger',
    label: 'Mugged on the street',
    condition: ws => ws.player.cash > 500 && (ws.criminal_record?.wanted_level ?? 0) === 0 && ws.player.stats.social < 30 && ws.player.stats.mood < 40,
    probability: 0.04,
    effect: ws => {
      const lost = Math.min(ws.player.cash, Math.floor(ws.player.cash * 0.35));
      return {
        stat_deltas: { health: -10, mood: -25, social: -15 },
        cash_delta: -lost,
        consequence: { type: 'robbery_victim', severity: 'major', duration: 10 },
      };
    },
    challenge_trigger: true,
    challenge_type: 'danger',
  },
  {
    id: 'wanted_level_decay',
    category: 'legal',
    label: 'Police heat fades over time',
    condition: ws => (ws.criminal_record?.wanted_level ?? 0) >= 1,
    probability: 0.08,
    effect: () => ({ criminal_wanted_decrease: 1 }),
    challenge_trigger: false,
  },
  // ── FAME ────────────────────────────────────────────────────────────────────
  {
    id: 'fan_recognition',
    category: 'fame',
    label: 'Recognized by a fan in public',
    condition: ws => (ws.fame?.level ?? 0) >= 1,
    probability: 0.18,
    effect: ws => {
      const fl = ws.fame?.level ?? 0;
      return {
        stat_deltas: { mood: fl >= 3 ? 18 : 10, social: 12, reputation: 2 },
        fame_followers: fl >= 2 ? 500 : 50,
      };
    },
    challenge_trigger: false,
  },
  {
    id: 'media_scandal',
    category: 'fame',
    label: 'Caught in a public scandal',
    condition: ws => (ws.fame?.level ?? 0) >= 2 && ws.player.stats.reputation < 65,
    probability: 0.09,
    effect: ws => {
      const fl = ws.fame?.level ?? 0;
      return {
        stat_deltas: { mood: -30, reputation: -20 - fl * 4, social: -18 },
        fame_followers: -Math.floor((ws.fame?.followers ?? 0) * 0.12),
        consequence: { type: 'public_scandal', severity: 'major', duration: 20 },
      };
    },
    challenge_trigger: true,
    challenge_type: 'fame',
  },
  {
    id: 'brand_deal_offer',
    category: 'fame',
    label: 'Brand reaches out with endorsement deal',
    condition: ws => (ws.fame?.level ?? 0) >= 1 && ws.player.stats.reputation >= 60,
    probability: 0.07,
    effect: ws => {
      const fl = ws.fame?.level ?? 0;
      const amount = fl >= 3 ? 50000 : fl >= 2 ? 10000 : 2000;
      return {
        cash_delta: amount,
        stat_deltas: { mood: 20, reputation: 5 },
        fame_followers: fl >= 2 ? 2000 : 300,
      };
    },
    challenge_trigger: false,
  },
  {
    id: 'viral_moment',
    category: 'fame',
    label: 'Something you did goes viral',
    condition: ws => ws.player.stats.mood > 75 && ws.player.stats.social > 65,
    probability: 0.02,
    effect: () => ({
      stat_deltas: { mood: 25, reputation: 12, social: 18 },
      fame_followers: 8000,
    }),
    challenge_trigger: false,
  },
  {
    id: 'paparazzi_encounter',
    category: 'fame',
    label: 'Paparazzi follows you around',
    condition: ws => (ws.fame?.level ?? 0) >= 3,
    probability: 0.22,
    effect: () => ({
      stat_deltas: { mood: -12, social: -8, energy: -5 },
      fame_followers: 1200,
    }),
    challenge_trigger: false,
  },
  {
    id: 'celebrity_event_invite',
    category: 'fame',
    label: 'Invited to exclusive celebrity event',
    condition: ws => (ws.fame?.level ?? 0) >= 3,
    probability: 0.10,
    effect: () => ({
      stat_deltas: { mood: 22, social: 28, reputation: 10 },
      cash_delta: 8000,
      fame_followers: 3500,
    }),
    challenge_trigger: false,
  },
  {
    id: 'talk_show_invite',
    category: 'fame',
    label: 'Invited to appear on a talk show',
    condition: ws => (ws.fame?.level ?? 0) >= 3 && ws.player.stats.reputation >= 75,
    probability: 0.06,
    effect: () => ({
      stat_deltas: { mood: 30, reputation: 15, social: 20 },
      cash_delta: 25000,
      fame_followers: 15000,
    }),
    challenge_trigger: false,
  },
  // ── ADDICTION ───────────────────────────────────────────────────────────────
  {
    id: 'addiction_withdrawal',
    category: 'health',
    label: 'Experiencing withdrawal symptoms',
    condition: ws => (ws.addictions ?? []).some(a => a.status === 'withdrawing'),
    probability: 0.65,
    effect: ws => {
      const levels = ['mild','moderate','severe'];
      const worst = (ws.addictions ?? []).filter(a => a.status === 'withdrawing')
        .sort((a,b) => levels.indexOf(b.severity) - levels.indexOf(a.severity))[0];
      const sev = worst?.severity ?? 'mild';
      return {
        stat_deltas: sev === 'severe' ? { health: -8, energy: -20, mood: -25, social: -15 }
          : sev === 'moderate' ? { health: -4, energy: -12, mood: -15, social: -8 }
          : { health: -1, energy: -6, mood: -8 },
        consequence: { type: 'withdrawal', severity: sev === 'severe' ? 'major' : 'moderate', duration: 3 },
      };
    },
    challenge_trigger: true,
    challenge_type: 'health',
  },
  {
    id: 'addiction_craving',
    category: 'health',
    label: 'Intense craving hits unexpectedly',
    condition: ws => (ws.addictions ?? []).some(a => a.status === 'active' && a.severity !== 'mild'),
    probability: 0.22,
    effect: () => ({ stat_deltas: { mood: -14, energy: -8, social: -5 } }),
    challenge_trigger: false,
  },
  // ── SOCIAL / MISC EXTRAS ────────────────────────────────────────────────────
  {
    id: 'community_event',
    category: 'social',
    label: 'Local community event nearby',
    condition: ws => {
      const dow = new Date(ws.sim_time).getDay();
      return (dow === 6 || dow === 0) && ws.player.stats.social < 60;
    },
    probability: 0.12,
    effect: () => ({ stat_deltas: { mood: 10, social: 18, reputation: 2 } }),
    challenge_trigger: false,
  },
  {
    id: 'unexpected_praise',
    category: 'misc',
    label: 'Received unexpected praise from someone',
    condition: ws => ws.player.stats.reputation > 55 && ws.player.stats.mood < 50,
    probability: 0.08,
    effect: () => ({ stat_deltas: { mood: 15, reputation: 3, social: 8 } }),
    challenge_trigger: false,
  },
  {
    id: 'surprise_expense',
    category: 'financial',
    label: 'Surprise expense — phone breaks, appliance fails',
    condition: ws => ws.player.cash > 800,
    probability: 0.04,
    effect: () => ({
      cash_delta: -(Math.floor(Math.random() * 500) + 200),
      stat_deltas: { mood: -12 },
    }),
    challenge_trigger: false,
  },
  {
    id: 'bad_news_call',
    category: 'misc',
    label: 'Received distressing news',
    condition: ws => ws.player.stats.mood > 55 && ws.player.stats.social > 40,
    probability: 0.04,
    effect: () => ({ stat_deltas: { mood: -20, social: -10, energy: -8 } }),
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
  if (ef.fame_followers != null && ws.fame) {
    ws.fame.followers = Math.max(0, (ws.fame.followers ?? 0) + ef.fame_followers);
  }
  if (ef.add_debt) {
    ws.debts = ws.debts ?? [];
    ws.debts.push({
      id: `debt_${Date.now()}`,
      ...ef.add_debt,
      original_amount: ef.add_debt.amount,
      status: 'active',
      interest_turns: 0,
      created_turn: ws.turn,
    });
  }
  if (ef.criminal_event) {
    ws.criminal_record = ws.criminal_record ?? { wanted_level: 0, crimes: [], has_record: false };
    if (ef.criminal_event.escalate) {
      ws.criminal_record.wanted_level = Math.min(5, (ws.criminal_record.wanted_level ?? 0) + 1);
    }
  }
  if (ef.criminal_wanted_decrease) {
    if (ws.criminal_record) {
      ws.criminal_record.wanted_level = Math.max(0, (ws.criminal_record.wanted_level ?? 0) - ef.criminal_wanted_decrease);
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

// ─── DEBT TICK ─────────────────────────────────────────────────────────────────
export function tickDebts(worldState) {
  let ws = JSON.parse(JSON.stringify(worldState));
  if (!ws.debts?.length) return ws;
  for (const debt of ws.debts) {
    if (debt.status === 'paid' || debt.status === 'forgiven') continue;
    debt.turns_remaining = (debt.turns_remaining ?? 30) - 1;
    // Weekly interest accumulation
    debt.interest_turns = (debt.interest_turns ?? 0) + 1;
    if (debt.interest_turns >= 7) {
      debt.interest_turns = 0;
      const rate = debt.type === 'loan_shark' ? 0.15 : (debt.interest_rate ?? 0.05);
      debt.amount = Math.ceil(debt.amount * (1 + rate));
    }
    if (debt.turns_remaining <= 0 && debt.status === 'active') {
      debt.status = 'overdue';
      ws.player.stats.reputation = Math.max(0, ws.player.stats.reputation - 8);
      ws.player.stats.mood       = Math.max(0, ws.player.stats.mood       - 10);
    }
  }
  return ws;
}

// ─── ADDICTION MANAGEMENT ─────────────────────────────────────────────────────
export function addAddiction(worldState, { type, severity = 'mild', source = 'unknown' }) {
  let ws = JSON.parse(JSON.stringify(worldState));
  ws.addictions = ws.addictions ?? [];
  const existing = ws.addictions.find(a => a.type === type && a.status !== 'recovered');
  if (existing) {
    const levels = ['mild', 'moderate', 'severe'];
    const idx = levels.indexOf(existing.severity);
    if (idx < 2) existing.severity = levels[idx + 1];
    existing.status = 'active';
  } else {
    ws.addictions.push({
      id: `addiction_${type}_${Date.now()}`,
      type, severity, source,
      status: 'active',
      days_active: 0,
      withdrawal_turns: 0,
      last_fed_turn: ws.turn,
    });
  }
  return ws;
}

export function feedAddiction(worldState, type) {
  let ws = JSON.parse(JSON.stringify(worldState));
  ws.addictions = ws.addictions ?? [];
  const addiction = ws.addictions.find(a => a.type === type && a.status !== 'recovered');
  if (!addiction) {
    if (Math.random() < 0.12) return addAddiction(ws, { type, severity: 'mild', source: 'repeated_use' });
    return ws;
  }
  addiction.last_fed_turn = ws.turn;
  addiction.status        = 'active';
  addiction.withdrawal_turns = 0;
  addiction.days_active      = (addiction.days_active ?? 0) + 1;
  if (addiction.days_active > 90 && addiction.severity === 'moderate') addiction.severity = 'severe';
  else if (addiction.days_active > 30 && addiction.severity === 'mild')  addiction.severity = 'moderate';
  return ws;
}

export function tickAddictions(worldState) {
  let ws = JSON.parse(JSON.stringify(worldState));
  if (!ws.addictions?.length) return ws;
  for (const addiction of ws.addictions) {
    if (addiction.status === 'recovered') continue;
    const turnsSinceFed = (ws.turn ?? 0) - (addiction.last_fed_turn ?? ws.turn ?? 0);
    const threshold = addiction.severity === 'severe' ? 4 : addiction.severity === 'moderate' ? 10 : 20;
    if (turnsSinceFed > threshold) {
      addiction.status = 'withdrawing';
      addiction.withdrawal_turns = (addiction.withdrawal_turns ?? 0) + 1;
      if (addiction.withdrawal_turns > 60  && addiction.severity === 'mild')     addiction.status = 'recovered';
      if (addiction.withdrawal_turns > 120 && addiction.severity === 'moderate') { addiction.severity = 'mild'; addiction.withdrawal_turns = 0; }
    } else {
      addiction.status           = 'active';
      addiction.withdrawal_turns = 0;
    }
  }
  return ws;
}

// ─── CRIMINAL RECORD ──────────────────────────────────────────────────────────
export function addCrime(worldState, { type, severity = 'minor', description = '' }) {
  let ws = JSON.parse(JSON.stringify(worldState));
  ws.criminal_record = ws.criminal_record ?? { wanted_level: 0, crimes: [], has_record: false };
  ws.criminal_record.crimes = [...(ws.criminal_record.crimes ?? []), {
    id: `crime_${Date.now()}`, type, severity, description, turn: ws.turn, status: 'active',
  }];
  ws.criminal_record.has_record = true;
  const wlInc = severity === 'minor' ? 1 : severity === 'moderate' ? 2 : severity === 'major' ? 3 : 5;
  ws.criminal_record.wanted_level = Math.min(5, (ws.criminal_record.wanted_level ?? 0) + wlInc);
  ws.player.stats.reputation = Math.max(0, ws.player.stats.reputation - wlInc * 5);
  ws.player.stats.mood       = Math.max(0, ws.player.stats.mood - 10);
  return ws;
}

export function decreaseWantedLevel(worldState, amount = 1) {
  let ws = JSON.parse(JSON.stringify(worldState));
  if (ws.criminal_record) {
    ws.criminal_record.wanted_level = Math.max(0, (ws.criminal_record.wanted_level ?? 0) - amount);
  }
  return ws;
}