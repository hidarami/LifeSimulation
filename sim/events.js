// events.js — world event table, selector, condition checker
'use strict';

export const EVENT_TABLE = [
  {
    id:          'illness_minor',
    category:    'misc',
    label:       'Minor illness',
    condition:   ws => ws.player.stats.health < 50 && ws.player.stats.hygiene < 30,
    probability: 0.12,
    effect:      () => ({ stat_deltas: { health: -8, energy: -15 }, consequence: { type: 'illness', severity: 'minor', duration: 3 } }),
  },
  {
    id:          'illness_severe',
    category:    'hospitalization',
    label:       'Hospitalized due to illness',
    condition:   ws => ws.player.stats.health < 20,
    probability: 0.30,
    effect:      () => ({ stat_deltas: { health: -20, energy: -30 }, cash_delta: -5000, consequence: { type: 'hospitalization', severity: 'severe', duration: 10 } }),
  },
  {
    id:          'job_termination',
    category:    'job_change',
    label:       'Terminated from job',
    condition:   ws => ws.job?.performance_flags?.includes('poor_performance') && ws.job?.performance_flags?.includes('final_warning'),
    probability: 0.40,
    effect:      () => ({ job_change: null, stat_deltas: { mood: -20, reputation: -5 }, consequence: { type: 'unemployment', severity: 'moderate', duration: 30 } }),
  },
  {
    id:          'windfall_small',
    category:    'misc',
    label:       'Unexpected small income',
    condition:   ws => ws.player.stats.mood > 60,
    probability: 0.04,
    effect:      () => ({ cash_delta: Math.floor(Math.random() * 200) + 50 }),
  },
  {
    id:          'mood_crash',
    category:    'misc',
    label:       'Mood crash from isolation',
    condition:   ws => ws.player.stats.social < 20 && ws.player.stats.mood > 40,
    probability: 0.20,
    effect:      () => ({ stat_deltas: { mood: -15 }, consequence: { type: 'emotional_slump', severity: 'minor', duration: 5 } }),
  },
];

export function checkWorldEvents(worldState) {
  const triggered = [];
  for (const event of EVENT_TABLE) {
    try {
      if (event.condition(worldState) && Math.random() < event.probability) {
        triggered.push({ ...event, effect_result: event.effect(worldState) });
      }
    } catch (e) {
      console.warn(`[events] Condition check failed for ${event.id}:`, e.message);
    }
  }
  return triggered;
}

export function applyEventEffect(worldState, eventResult) {
  let ws = JSON.parse(JSON.stringify(worldState));
  const ef = eventResult.effect_result;

  if (ef.stat_deltas) {
    for (const [k, v] of Object.entries(ef.stat_deltas)) {
      if (k in ws.player.stats) {
        ws.player.stats[k] = Math.max(0, Math.min(100, ws.player.stats[k] + v));
      }
    }
  }
  if (typeof ef.cash_delta === 'number') {
    ws.player.cash = Math.max(0, ws.player.cash + ef.cash_delta);
  }
  if (ef.consequence) {
    ws.consequences = [...ws.consequences, ef.consequence];
  }
  if ('job_change' in ef) {
    ws.job = ef.job_change;
  }
  return ws;
}