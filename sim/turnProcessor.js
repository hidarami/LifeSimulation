// turnProcessor.js — processTurn orchestration, death handler, schedule detection
import S from './gameState.js';
import { saveWorldState, assembleTurnBrief, appendSignificantEvent, updateEventIndex, logEvent,
         saveNarration, savePlayerAction, saveWorldStateCloud, saveClassifierOutput,
         updateFame } from './state.js';
import { applyDecay, applyDeltas, advanceTime,
         rollRisk, classifyTurn, advanceConsequences, TURN_CLASSIFICATION,
         applyCascadingEffects, applyCascadeEffectsToExternal,
         getCircadianModifiers, getSleepEfficiency, applySleepRecovery } from './engine.js';
import { routeInput, classifyExplicitActivity,
         EXPLICIT_ACTIVITY_TABLE, sanitizeStateForGemini, extractCompoundContext, ROUTE,
         hasThirdPartyPresence } from './sanitizer.js';
import { callGrok, classifyAction, evaluateNpcReaction, resetConvId,
         callGeminiAutopilot, compressSessionContext, evaluateDescribedNpc,
         evaluateNpcFlagsInContext, extractNarrativeStateChanges, extractSceneContext,
         checkNpcInitiative } from './api.js';
import { renderNarration, renderTurnAnchor, livesWithPlayer, getSmartNpcLabel } from './renderer.js';
import { checkWorldEvents, checkNpcEvents, applyEventEffect, applyNpcEventEffect,
         progressDiseases, progressNpcDiseases, checkDiseaseContraction, checkNpcDiseaseSpread,
         calculateAlcoholEffect, tickSchoolSuspension, tickDebts, tickAddictions,
         feedAddiction, runSimulationDirector, GSD_INTERVAL } from './events.js';
import { challengeFromDisease, challengeFromNpcEvent, challengeFromWorldEvent,
         challengeFromHangover, checkChallengeResolution, challengeFromDebt,
         challengeFromAddiction, challengeFromScandal, challengeFromLoanShark } from './challenges.js';
import { tickFlagDecay, addFlag, incrementSignificance, FLAG_DECAY,
         buildNpcContextForGemini, applyRelationshipDelta, createNpc,
         driftTraits, getNpcCurrentTask, updateNpcCareer,
         checkNpcConsentGate, computeWitnessReaction } from './npc.js';
import { renderAll, setStatus, setProcessing, showChallengeQueue, renderActionLog } from './uiCore.js';
import { showCameraFlash } from './imageUpload.js';

// ── HELPERS ───────────────────────────────────────────────────────────────────
function autopilotHours(i) {
  if (/sleep|nap/i.test(i)) return 7;
  if (/commute/i.test(i))   return 1;
  if (/shift|work\s*day/i.test(i)) return 8;
  return 1;
}
function autopilotDeltas(i, h) {
  if (/sleep|nap/i.test(i)) return { energy: Math.min(h*8,80), mood: Math.min(h*3,30) };
  return { energy: -(h*4) };
}
function _parseMissEndHour(schedStr, fallback) {
  if (!schedStr) return fallback;
  const m = schedStr.match(/[-–]\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i);
  if (!m) return fallback;
  let h = parseInt(m[1]);
  const mn = m[2] ? parseInt(m[2]) : 0;
  const ap = m[3]?.toUpperCase();
  if (ap === 'PM' && h < 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return h + mn / 60;
}
function detectScheduleMiss(prevIso, newIso, playerAction, ws) {
  const prev = new Date(prevIso), next = new Date(newIso), missed = [];
  if (ws.school?.status === 'active') {
    const schoolAction = /\b(school|class|attend|lecture|go\s*to\s*school|pasok|eskwela)\b/i.test(playerAction);
    if (!schoolAction) {
      const endH = _parseMissEndHour(ws.school.schedule, 16);
      const d = new Date(prev); d.setHours(0,0,0,0);
      const last = new Date(next); last.setHours(0,0,0,0);
      while (d <= last) {
        const dow = d.getDay();
        if (dow >= 1 && dow <= 5) { const end = new Date(d); end.setHours(endH,0,0,0); if (prev < end && next >= end) missed.push({ type:'school' }); }
        d.setDate(d.getDate() + 1);
      }
    }
  }
  if (ws.job?.employer && ws.job?.schedule) {
    const workAction = /\b(work|shift|clocked?\s*(in|out)|go\s*to\s*work|office|overtime)\b/i.test(playerAction);
    if (!workAction) {
      const endH = _parseMissEndHour(ws.job.schedule, 17);
      const d = new Date(prev); d.setHours(0,0,0,0);
      const last = new Date(next); last.setHours(0,0,0,0);
      while (d <= last) {
        const dow = d.getDay();
        if (dow >= 1 && dow <= 5) { const end = new Date(d); end.setHours(endH,0,0,0); if (prev < end && next >= end) missed.push({ type:'job' }); }
        d.setDate(d.getDate() + 1);
      }
    }
  }
  return missed;
}

// ── ACTION REALITY CHECK ──────────────────────────────────────────────────────
// Returns null (grounded) or a tag passed to Grok to anchor narration.
// Does NOT block the action — the world narrates what actually happened.
function detectActionReality(input, ws) {
  if (/\b(fly\b|teleport|levitat|walk through (the\s+)?wall|become invisible|time trave|resurrect|come back (from the\s+)?dead|breathe (in\s+)?space)\b/i.test(input))
    return 'impossible_physics';
  const hasFame = (ws.fame?.level ?? 0) >= 2;
  if (/\b(become (a )?(celebrity|famous|president|prime minister|senator|CEO|billionaire|millionaire|movie star|pop star|idol))\b/i.test(input) && !hasFame)
    return 'context_mismatch';
  if (/\b(i am now|suddenly (am|become|have become)|instantly (become|transform into|am))\b/i.test(input))
    return 'context_mismatch';
  if (/^(i wish|if only|imagine (if|that)|what if i|someday i('ll| will)|i fantasize|i daydream)\b/i.test(input.toLowerCase()))
    return 'fantasy_wish';
  return null;
}

// ── DEATH / POV SHIFT ─────────────────────────────────────────────────────────
async function _handleDeath(deathProse) {
  if (!S.WS) return;
  window._devlog?.system('DEATH: initiating POV shift');
  const _candidates = Object.values(S.WS.npcs)
    .filter(n => n.status === 'active' && n.significance >= 1)
    .sort((a, b) => b.significance - a.significance || b.relationship_meter - a.relationship_meter);
  const _successor = _candidates[0] ?? null;
  if (!_successor) { setStatus('☠ Character has died. No active characters remain — game over.', 'err'); return; }
  const _deceasedName = S.WS.player.name ?? 'the previous character';
  setStatus(`☠ Generating post-death summary... POV shifts to ${_successor.name}.`, 'err');
  let legacyProse = '';
  try {
    const _lb = assembleTurnBrief(S.WS, {
      turnNumber: S.WS.turn, simTime: S.WS.sim_time, location: S.WS.player.location,
      actionDescription: '[death_legacy]', statDeltas: {}, riskResult: null,
      consequenceUpdate: null, npcReactions: [], turnClass: 'DEATH', isExplicit: false,
      rawInput: `[${_deceasedName} has died. ${_successor.name} will carry the story forward.]`,
    });
    legacyProse = await callGrok(
      { ..._lb, successor_npc: { name: _successor.name, relationship: _successor.relationship_type ?? _successor.npc_class } },
      'legacy', { isDeath: true, isCrisis: true }
    );
  } catch { legacyProse = `${_deceasedName} is gone. The world moves on. ${_successor.name} is left to carry what remains.`; }
  const _la = renderTurnAnchor(S.WS.turn, S.WS.sim_time, S.WS.player.location);
  renderNarration(legacyProse, _la, document.getElementById('feed'), S.WS.turn);
  document.getElementById('feed').lastElementChild?.scrollIntoView({ behavior: 'smooth' });
  const _deadId = `${_deceasedName.toLowerCase().replace(/\s+/g,'_')}_deceased`;
  S.WS.npcs[_deadId] = {
    id: _deadId, name: _deceasedName, age: S.WS.player.age ?? 18, npc_class: 'household',
    relationship_type: 'deceased_player', status: 'inactive', departure_reason: 'deceased',
    significance: 3, relationship_meter: 0, trust_meter: 0,
    traits: {}, active_flags: [], flag_timers: {}, recent_interactions: [`Died on turn ${S.WS.turn}`],
    schedule: { weekday_routine: [], weekend_routine: [], interruptions: [] },
  };
  delete S.WS.npcs[_successor.id];
  S.WS.player = {
    name: _successor.name, age: _successor.age ?? 20,
    sex: _successor.sex ?? (S.WS.player.sex ?? 'unknown'), location: S.WS.player.location,
    stats: {
      health: 75, energy: 65, hunger: 30, hygiene: 65, mood: 35, arousal: 0, social: 50,
      reputation: Math.max(10, Math.min(60, Math.round((_successor.relationship_meter + 100) / 3.33))), alcohol: 0,
    },
    cash: 200, skills: {}, habits: [], irreversible: [], possessions: [], diseases: [], alcohol_tolerance: 0,
  };
  S.WS.challenges = []; S.WS.consequences = [];
  S.WS.last_narration_prose = legacyProse; S.WS.session_context_flavor = '';
  S.WS.recent_significant_events = [`${_successor.name} takes over after ${_deceasedName} died on turn ${S.WS.turn}`];
  S.WS.turn += 1;
  await saveWorldState(S.WS);
  await saveNarration(S.WS.turn, S.WS.sim_time, S.WS.player.location, legacyProse);
  renderAll(); resetConvId();
  setTimeout(async () => {
    try {
      const _ib = assembleTurnBrief(S.WS, {
        turnNumber: S.WS.turn + 1, simTime: S.WS.sim_time, location: S.WS.player.location,
        actionDescription: '[pov_shift_start]', statDeltas: {}, riskResult: null,
        consequenceUpdate: null, npcReactions: [], turnClass: 'NOTABLE', isExplicit: false,
        rawInput: `[Begin playing as ${S.WS.player.name}, reacting to the recent death of ${_deceasedName}]`,
      });
      const _ip = await callGrok(_ib, 'pov_shift', { isDeath: true, isCrisis: true });
      S.WS.turn += 1; S.WS.last_narration_prose = _ip;
      const _ia = renderTurnAnchor(S.WS.turn, S.WS.sim_time, S.WS.player.location);
      renderNarration(_ip, _ia, document.getElementById('feed'), S.WS.turn);
      document.getElementById('feed').lastElementChild?.scrollIntoView({ behavior: 'smooth' });
      await saveWorldState(S.WS); await saveNarration(S.WS.turn, S.WS.sim_time, S.WS.player.location, _ip);
      renderAll(); setStatus(`${S.WS.player.name} — Turn ${S.WS.turn}`);
    } catch { setStatus(`${S.WS.player.name} — Continue.`); }
    document.getElementById('submit-btn').disabled = false;
    document.getElementById('action-input').disabled = false;
    setProcessing(false);
  }, 800);
}

// ── PROCESS TURN ──────────────────────────────────────────────────────────────
export async function processTurn(input) {
  if (!S.WS) { alert('Start a new game first.'); return; }
  const _turnToken = ++S._processTurnCounter;
  setStatus('Processing…', 'load'); setProcessing(true);
  let _turnCommitted = false;
  try {
    let ws = JSON.parse(JSON.stringify(S.WS));
    let statDeltas={}, relDeltas={}, timeCost=0.25, locationChange=null, npcReactions=[];
    let riskResult={roll:100,severity:null,event:null}, consequenceUpd=null;
    let actionDesc = input, _mentionedNpc = null, _cls2Result = null, _npcWitnesses = [], _realityCheck = null;

    let route = routeInput(input);
    if (route === ROUTE.PATH_1_EXPLICIT && localStorage.getItem('CONTENT_MODE') === 'filtered') {
      route = ROUTE.PATH_3_AUTOPILOT;
      setStatus('Explicit content is off — action processed as time skip.', 'load');
    }
    window._devlog?.system(`processTurn start T${(S.WS?.turn??0)+1}`, { input: input.slice(0,80), route });

    if (route === ROUTE.PATH_1_EXPLICIT) {
      let type = classifyExplicitActivity(input);
      const NEEDS_PARTNER = ['intercourse','oral_giving','oral_receiving','manual_giving','manual_receiving','mutual_masturbation'];
      const FULL_ACTS     = ['intercourse','oral_giving','oral_receiving','mutual_masturbation'];
      const hasActiveNpc  = Object.values(ws.npcs).some(n => n.status==='active' && n.significance>=1);
      const thirdParty    = hasThirdPartyPresence(input);
      if (NEEDS_PARTNER.includes(type) && !hasActiveNpc && !thirdParty) type = 'solo_masturbation';

      // ── Identify target NPC FIRST so consent gate runs before actionDesc ────
      const _inputLower = input.toLowerCase();
      const _possNpc = Object.values(ws.npcs).find(n => n.status==='active' && n.name && _inputLower.includes(n.name.toLowerCase()+"'s"));
      let _closestNpc = null, _minVerbDist = Infinity;
      if (!_possNpc) {
        const _aVerbs = ['jerk','stroke','finger','suck','blow','fuck','ride','mount','massage','grab','lick','eat','penetrat','makeout','rub','squeeze','pump','touch'];
        for (const _cn of Object.values(ws.npcs)) {
          if (_cn.status !== 'active' || !_cn.name) continue;
          const _ni = _inputLower.indexOf(_cn.name.toLowerCase()); if (_ni === -1) continue;
          for (const _vb of _aVerbs) { const _vi = _inputLower.indexOf(_vb); if (_vi === -1) continue; const _d = Math.abs(_ni-_vi); if (_d < _minVerbDist) { _minVerbDist=_d; _closestNpc=_cn; } }
        }
      }
      _mentionedNpc = _possNpc ?? _closestNpc ?? Object.values(ws.npcs).find(n => n.status==='active' && n.name && _inputLower.includes(n.name.toLowerCase()));

      // ── Pre-consent gate — JS level, cannot be bypassed by player wording ──
      let _consentResult = 'proceed';
      if (_mentionedNpc && NEEDS_PARTNER.includes(type) && type !== 'solo_masturbation') {
        _consentResult = checkNpcConsentGate(_mentionedNpc, type);
      }

      if (_consentResult === 'refuse') {
        // Act did NOT happen. Build refusal context for Grok.
        const _refType = FULL_ACTS.includes(type) ? 'refused_explicit' : 'refused_light';
        statDeltas = { ...(EXPLICIT_ACTIVITY_TABLE[_refType] ?? { mood: -5, social: -8 }) };
        timeCost   = 0.1;
        actionDesc = `[intimate_attempt_refused — ${type} — described partner in scene${_mentionedNpc ? ': ' + _mentionedNpc.name : ''}]`;
        if (_mentionedNpc && ws.npcs[_mentionedNpc.id]) {
          try {
            const _rCtx = buildNpcContextForGemini(_mentionedNpc, ws.sim_time);
            const _rRxn = await evaluateNpcReaction(_rCtx, `player attempted [${type}] — NPC declined based on traits and relationship standing`, ws.player.stats);
            const _rDelta = _rRxn?.relationship_delta ?? -5;
            ws.npcs[_mentionedNpc.id] = applyRelationshipDelta(ws.npcs[_mentionedNpc.id], _rDelta, _rRxn?.trust_delta ?? -3);
            for (const f of (_rRxn?.flags_to_add ?? [{ flag:'uncomfortable', decay_rate:'fast' }])) {
              ws.npcs[_mentionedNpc.id] = addFlag(ws.npcs[_mentionedNpc.id], f.flag, FLAG_DECAY[f.decay_rate] ?? FLAG_DECAY.fast);
            }
            ws.npcs[_mentionedNpc.id] = incrementSignificance(ws.npcs[_mentionedNpc.id]);
            relDeltas[_mentionedNpc.id] = _rDelta;
            const _rSum = _rRxn?.reaction_summary ?? `${_mentionedNpc.name} pulls back, making it clear this isn't going to happen.`;
            npcReactions.push({ npc_id: _mentionedNpc.id, summary: _rSum });
            ws.npcs[_mentionedNpc.id]._hidden = ws.npcs[_mentionedNpc.id]._hidden ?? {};
            ws.npcs[_mentionedNpc.id]._hidden.last_interaction_turn = ws.turn;
            ws.npcs[_mentionedNpc.id].recent_interactions = [...(ws.npcs[_mentionedNpc.id].recent_interactions ?? []), _rSum].slice(-5);
            if (_rDelta <= -5) ws.npcs[_mentionedNpc.id] = driftTraits(ws.npcs[_mentionedNpc.id], { mistreated: true });
          } catch {
            npcReactions.push({ npc_id: _mentionedNpc.id, summary: `${_mentionedNpc.name} makes it clear this isn't happening.` });
          }
        }
        riskResult = rollRisk('none', ws.player.stats);
      } else {
        // Consent granted (or solo) — proceed normally
        statDeltas = { ...(EXPLICIT_ACTIVITY_TABLE[type] ?? {}) };
        const compound = extractCompoundContext(input);
        if (compound.ate) { statDeltas.hunger=(statDeltas.hunger??0)-30; statDeltas.mood=(statDeltas.mood??0)+5; }
        if (compound.location_hint) locationChange = compound.location_hint;
        timeCost = 0.5;
        const _bystanders = Object.values(ws.npcs).filter(n => n.status==='active' && n.name && _inputLower.includes(n.name.toLowerCase()) && n.id !== _mentionedNpc?.id)
          .map(n => { const _bt = getNpcCurrentTask(n, ws.sim_time); return `${n.name} (${_bt.task.replace(/_/g,' ')} — bystander)`; });
        const _bystanderNote = _bystanders.length ? ` — others present but uninvolved: ${_bystanders.join('; ')}` : '';
        const partnerTag = (thirdParty && NEEDS_PARTNER.includes(type))
          ? ` — described partner in scene${_mentionedNpc ? ': '+_mentionedNpc.name : ''}`
          : (!hasActiveNpc && !thirdParty ? ' — no established partner' : '');
        actionDesc = `[explicit: ${type}${partnerTag}${_bystanderNote}]` + (compound.ate ? ' + ate' : '');
        if (thirdParty && !hasActiveNpc && NEEDS_PARTNER.includes(type)) {
          evaluateDescribedNpc(input).then(nd => {
            if (_turnToken !== S._processTurnCounter) return;
            const _exists = Object.values(S.WS?.npcs??{}).some(n => n.name?.toLowerCase().trim() === nd?.name?.toLowerCase().trim());
            const _nh = ['holder','curtain','table','chair','door','wall','rack','rod','knob','sink','toilet','bucket','bin','stool','lamp','shelf'];
            const _human = nd?.name && /^[A-Z]/.test(nd.name) && nd.name.split(/\s+/).length<=3 && nd.name.length<=28 && !_nh.some(w=>nd.name.toLowerCase().includes(w));
            if (nd?.id && !S.WS?.npcs?.[nd.id] && !_exists && _human && nd.significance !== 'none') {
              const _n = createNpc({ id:nd.id, name:nd.name, age:nd.age||20, npc_class:nd.npc_class||'household', traits:nd.traits||{} });
              _n.relationship_meter = nd.relationship_meter ?? 20; _n.trust_meter = nd.trust_meter ?? 10; _n.significance = 1;
              S.WS.npcs[nd.id] = _n; saveWorldState(S.WS).catch(()=>{}); renderAll();
            }
          }).catch(()=>{});
        }
        riskResult = rollRisk('low', ws.player.stats);
      }
    }
    else if (route === ROUTE.PATH_2_NOVEL) {
      const safe = sanitizeStateForGemini(ws);
      const cls  = await classifyAction(input, safe);
      _cls2Result = cls;
      window._devlog?.turn('Gemini classify result', { action_type:cls.action_type, time_cost_hours:cls.time_cost_hours, risk_class:cls.risk_class, stat_deltas:cls.stat_deltas, npc_ids:cls.npc_ids_involved });
      saveClassifierOutput(ws.turn+1, ws.sim_time, _cls2Result).catch(()=>{});
      statDeltas=cls.stat_deltas??{}; timeCost=Math.min(Math.max(cls.time_cost_hours??0.25,0.08),4.0);
      locationChange=cls.location_change??null; actionDesc=`[${cls.action_type??'action'}]`;
      riskResult=rollRisk(cls.risk_class??'none', ws.player.stats);
      for (const npcId of (cls.npc_ids_involved??[])) {
        if (!ws.npcs[npcId]) continue;
        const ctx = buildNpcContextForGemini(ws.npcs[npcId], ws.sim_time);
        const rxn = await evaluateNpcReaction(ctx, input, ws.player.stats).catch(()=>null);
        if (!rxn) continue;
        window._devlog?.npc(`${ws.npcs[npcId].name} reacted`, { rel_delta:rxn.relationship_delta, trust_delta:rxn.trust_delta, summary:rxn.reaction_summary, flags:rxn.flags_to_add });
        ws.npcs[npcId] = applyRelationshipDelta(ws.npcs[npcId], rxn.relationship_delta??0, rxn.trust_delta??null);
        for (const f of rxn.flags_to_add??[]) ws.npcs[npcId] = addFlag(ws.npcs[npcId], f.flag, FLAG_DECAY[f.decay_rate]??FLAG_DECAY.medium);
        ws.npcs[npcId] = incrementSignificance(ws.npcs[npcId]);
        relDeltas[npcId] = rxn.relationship_delta ?? 0;
        npcReactions.push({ npc_id:npcId, summary:rxn.reaction_summary });
        ws.npcs[npcId]._hidden = ws.npcs[npcId]._hidden ?? {};
        ws.npcs[npcId]._hidden.last_interaction_turn = ws.turn;
        const _rd = rxn.relationship_delta??0, _td2 = rxn.trust_delta??0;
        if (_rd <= -8)  ws.npcs[npcId] = driftTraits(ws.npcs[npcId], { mistreated:true });
        else if (_td2 >= 8) ws.npcs[npcId] = driftTraits(ws.npcs[npcId], { deepTrust:true });
        else if (_rd >= 5 && ws.npcs[npcId].relationship_meter >= 35) ws.npcs[npcId] = driftTraits(ws.npcs[npcId], { consistent_positive:true });
        if (_rd <= -15) ws.npcs[npcId] = driftTraits(ws.npcs[npcId], { betrayed:true });
        if (rxn.reaction_summary) {
          const ri = ws.npcs[npcId].recent_interactions ?? [];
          ws.npcs[npcId].recent_interactions = [...ri, rxn.reaction_summary].slice(-5);
        }
      }
      if (Array.isArray(cls.future_plans) && cls.future_plans.length) {
        for (const plan of cls.future_plans) {
          if (!ws.npcs[plan.npc_id] || !(plan.offset_hours>0) || !(plan.duration_hours>0)) continue;
          const _ps = advanceTime(ws.sim_time, plan.offset_hours).toISOString();
          const _pe = advanceTime(ws.sim_time, plan.offset_hours+plan.duration_hours).toISOString();
          ws.npcs[plan.npc_id].schedule = ws.npcs[plan.npc_id].schedule ?? { weekday_routine:[], weekend_routine:[], interruptions:[] };
          ws.npcs[plan.npc_id].schedule.interruptions = ws.npcs[plan.npc_id].schedule.interruptions ?? [];
          const _pS = new Date(_ps).getTime(), _pE = new Date(_pe).getTime();
          const _noOv = (ws.npcs[plan.npc_id].schedule.interruptions??[]).every(ex => { const eS=new Date(ex.start).getTime(),eE=new Date(ex.end).getTime(); return _pE<=eS||_pS>=eE; });
          if (_noOv) ws.npcs[plan.npc_id].schedule.interruptions.push({ start:_ps, end:_pe, task:plan.task??'outing with player', interruptible:false, available:true, location:plan.location??'outside', note:`Planned with player — turn ${ws.turn}` });
        }
      }
    }
    else { timeCost=autopilotHours(input); statDeltas=autopilotDeltas(input,timeCost); actionDesc='[autopilot]'; }

    // Explicit NPC reaction — refused acts already handled in PATH_1 block above
    if (route === ROUTE.PATH_1_EXPLICIT) {
      const _EXP = ['intercourse','oral_giving','oral_receiving','manual_giving','manual_receiving','mutual_masturbation'];
      const _eType = actionDesc.match(/\[explicit:\s*(\w+)/)?.[1] ?? '';
      const _wasRefused = actionDesc.startsWith('[intimate_attempt_refused');
      if (!_wasRefused && _EXP.includes(_eType) && !actionDesc.includes('no established partner')) {
        const _tNpc = _mentionedNpc ?? Object.values(ws.npcs).find(n => n.status==='active' && n.significance>=1);
        if (_tNpc && ws.npcs[_tNpc.id]) {
          try {
            const _eCtx = buildNpcContextForGemini(_tNpc, ws.sim_time);
            const _eRxn = await evaluateNpcReaction(_eCtx, `[explicit: ${_eType}] — player performs this with ${_tNpc.name}`, ws.player.stats);
            if (_eRxn) {
              ws.npcs[_tNpc.id] = applyRelationshipDelta(ws.npcs[_tNpc.id], _eRxn.relationship_delta??0, _eRxn.trust_delta??null);
              for (const f of _eRxn.flags_to_add??[]) ws.npcs[_tNpc.id] = addFlag(ws.npcs[_tNpc.id], f.flag, FLAG_DECAY[f.decay_rate]??FLAG_DECAY.medium);
              ws.npcs[_tNpc.id] = incrementSignificance(ws.npcs[_tNpc.id]);
              relDeltas[_tNpc.id] = _eRxn.relationship_delta??0;
              if (_eRxn.reaction_summary) {
                npcReactions.push({ npc_id:_tNpc.id, summary:_eRxn.reaction_summary });
                ws.npcs[_tNpc.id]._hidden = ws.npcs[_tNpc.id]._hidden ?? {};
                ws.npcs[_tNpc.id]._hidden.last_interaction_turn = ws.turn;
                ws.npcs[_tNpc.id].recent_interactions = [...(ws.npcs[_tNpc.id].recent_interactions??[]), _eRxn.reaction_summary].slice(-5);
              }
              if ((_eRxn.relationship_delta??0) <= -5) ws.npcs[_tNpc.id] = driftTraits(ws.npcs[_tNpc.id], { mistreated:true });
              else if ((_eRxn.trust_delta??0) >= 6)   ws.npcs[_tNpc.id] = driftTraits(ws.npcs[_tNpc.id], { deepTrust:true });
            }
          } catch {
            ws.npcs[_tNpc.id].recent_interactions = [...(ws.npcs[_tNpc.id].recent_interactions??[]), `Intimate encounter — turn ${ws.turn+1}`].slice(-5);
          }
        }
      }
    }

    // ── WITNESS REACTIONS (NPCs physically present but not directly involved) ──
    if (route === ROUTE.PATH_1_EXPLICIT && !actionDesc.startsWith('[intimate_attempt_refused') && _mentionedNpc) {
      const _wActType = actionDesc.match(/\[explicit:\s*(\w+)/)?.[1] ?? '';
      const _FULL_W = ['intercourse','oral_giving','oral_receiving','mutual_masturbation'];
      if (_FULL_W.includes(_wActType)) {
        for (const [_wId, _wNpc] of Object.entries(ws.npcs)) {
          if (_wId === _mentionedNpc.id || _wNpc.status !== 'active') continue;
          const _wTask = getNpcCurrentTask(_wNpc, ws.sim_time);
          const _wAwayLoc = ['workplace','school','transit','outside'];
          if (_wAwayLoc.includes(_wTask.location ?? '') || _wTask.present === false) continue;
          if (!livesWithPlayer(_wNpc) && _wTask.location !== 'player_home' && _wTask.location !== 'with_player') continue;
          const _wr = computeWitnessReaction(_wNpc, _mentionedNpc.id, _wActType);
          if (_wr.rel_delta === 0 && _wr.trust_delta === 0 && !_wr.flags.length) continue;
          ws.npcs[_wId] = applyRelationshipDelta(ws.npcs[_wId], _wr.rel_delta, _wr.trust_delta);
          for (const f of _wr.flags) ws.npcs[_wId] = addFlag(ws.npcs[_wId], f.flag, FLAG_DECAY[f.decay_rate] ?? FLAG_DECAY.medium);
          ws.npcs[_wId] = incrementSignificance(ws.npcs[_wId]);
          if (_wr.mood_label === 'betrayed' || _wr.mood_label === 'horrified') ws.npcs[_wId] = driftTraits(ws.npcs[_wId], { mistreated: true });
          if (_wr.summary) {
            ws.npcs[_wId].recent_interactions = [...(ws.npcs[_wId].recent_interactions ?? []), _wr.summary].slice(-5);
            ws.npcs[_wId]._hidden = ws.npcs[_wId]._hidden ?? {};
            ws.npcs[_wId]._hidden.last_interaction_turn = ws.turn;
            _npcWitnesses.push({ npc_id: _wId, name: _wNpc.name, mood: _wr.mood_label, summary: _wr.summary });
            window._devlog?.npc(`Witness reaction: ${_wNpc.name}`, { mood: _wr.mood_label, rel_delta: _wr.rel_delta });
          }
        }
      }
    }

    const prevSimTime = ws.sim_time;
    if (route === ROUTE.PATH_3_AUTOPILOT && /sleep|nap/i.test(input)) {
      const _sH = new Date(prevSimTime).getHours(), _eff = getSleepEfficiency(_sH);
      const _effHours = timeCost * _eff;
      const _sleptStats = applySleepRecovery({ ...ws.player.stats }, _effHours);
      statDeltas.energy  = Math.round(_sleptStats.energy  - ws.player.stats.energy);
      statDeltas.mood    = Math.round(_sleptStats.mood    - ws.player.stats.mood);
      statDeltas.hygiene = Math.round(_sleptStats.hygiene - ws.player.stats.hygiene);
      statDeltas.health  = (statDeltas.health ?? 0) + Math.round(_effHours * 0.4);
    }
    ws.sim_time = advanceTime(ws.sim_time, timeCost).toISOString();

    if (route === ROUTE.PATH_1_EXPLICIT && _mentionedNpc && ws.npcs[_mentionedNpc.id]) {
      ws.npcs[_mentionedNpc.id].schedule = ws.npcs[_mentionedNpc.id].schedule ?? { weekday_routine:[], weekend_routine:[], interruptions:[] };
      ws.npcs[_mentionedNpc.id].schedule.interruptions = ws.npcs[_mentionedNpc.id].schedule.interruptions ?? [];
      const _iS=new Date(prevSimTime).getTime(), _iE=new Date(ws.sim_time).getTime();
      const _noOv = ws.npcs[_mentionedNpc.id].schedule.interruptions.every(ex => { const eS=new Date(ex.start).getTime(),eE=new Date(ex.end).getTime(); return _iE<=eS||_iS>=eE; });
      if (_noOv) ws.npcs[_mentionedNpc.id].schedule.interruptions.push({ start:prevSimTime, end:ws.sim_time, task:'with_player', interruptible:false, available:true, location:'with_player', note:`Explicit scene — turn ${ws.turn+1}` });
    }

    ws.player.stats = applyDecay(ws.player.stats, timeCost);
    const _circ = getCircadianModifiers(ws.sim_time), _cScale = Math.min(timeCost,3)*0.25;
    ws.player.stats.energy = Math.max(0,Math.min(100,ws.player.stats.energy+_circ.energy*_cScale));
    ws.player.stats.mood   = Math.max(0,Math.min(100,ws.player.stats.mood  +_circ.mood  *_cScale));

    const missedSchedule = detectScheduleMiss(prevSimTime, ws.sim_time, input, ws);
    for (const miss of missedSchedule) {
      if (miss.type === 'school' && ws.school) {
        ws.school.absence_count = (ws.school.absence_count??0)+1; const n=ws.school.absence_count;
        statDeltas.mood       = (statDeltas.mood??0)+Math.max(-20,-(4+n*3));
        statDeltas.reputation = (statDeltas.reputation??0)-(n>2?3:1);
        await logEvent({ turn:ws.turn, category:'schedule_miss', description:`Missed school — ${n} total absence${n>1?'s':''}` });
      }
      if (miss.type === 'job' && ws.job) {
        ws.job.absent_count = (ws.job.absent_count??0)+1; const n=ws.job.absent_count;
        statDeltas.mood       = (statDeltas.mood??0)+Math.max(-15,-(3+n*2));
        statDeltas.reputation = (statDeltas.reputation??0)-(n>1?2:1);
        if (n>=3 && ws.job.performance_flags) ws.job.performance_flags = [...new Set([...ws.job.performance_flags,'poor_attendance'])];
        await logEvent({ turn:ws.turn, category:'schedule_miss', description:`Missed work — ${n} total absence${n>1?'s':''}` });
      }
    }

    ws.player.stats = applyDeltas(ws.player.stats, statDeltas);
    ws.player.stats = applyCascadingEffects(ws.player.stats);
    window._devlog?.stat(`T${ws.turn+1} stats post-cascade`, { ...ws.player.stats });

    const _CASC = new Set(['too_sick_to_work','too_sick_to_attend','reduced_performance_health','exhausted_at_work','exhausted_at_school','low_energy_performance','severely_depressed','depressed_performance','excellent_mood','poor_hygiene','below_average_hygiene','poor_reputation','excellent_reputation']);
    if (ws.job)    ws.job.performance_flags    = (ws.job.performance_flags   ||[]).filter(f=>!_CASC.has(f));
    if (ws.school) ws.school.performance_flags = (ws.school.performance_flags||[]).filter(f=>!_CASC.has(f));
    const cascadeEffects = applyCascadeEffectsToExternal(ws.player.stats, ws.job, ws.school, ws.npcs);
    if (ws.job    && cascadeEffects.jobPerformance.length   >0) ws.job.performance_flags    = [...new Set([...(ws.job.performance_flags   ||[]),...cascadeEffects.jobPerformance])];
    if (ws.school && cascadeEffects.schoolPerformance.length>0) ws.school.performance_flags = [...new Set([...(ws.school.performance_flags||[]),...cascadeEffects.schoolPerformance])];

    if (locationChange) ws.player.location = locationChange;
    ws = tickSchoolSuspension(ws);
    ws = tickDebts(ws);
    ws = tickAddictions(ws);
    ws = updateFame(ws);

    let _directorEvents = [];
    if (ws.turn % GSD_INTERVAL === 0) {
      const { worldState:_wsGSD, directorEvents:_de } = runSimulationDirector(ws);
      ws = _wsGSD; _directorEvents = _de;
      for (const de of _de) {
        window._devlog?.system(`GSD: ${de.type}`, { desc:de.description, severity:de.severity, hidden:de.hidden??false });
        if (!de.hidden) ws = appendSignificantEvent(ws, `[Director] ${de.description}`);
      }
    }

    if (route === ROUTE.PATH_2_NOVEL && _cls2Result?.alcohol_consumed?.detected) ws = feedAddiction(ws, 'alcohol');
    if ((ws.fame?.level??0) >= 4 && Math.random() < 0.15) setTimeout(showCameraFlash, Math.random()*3000+500);

    if (ws.school?.status === 'active') {
      const _sdDow = new Date(ws.sim_time).getDay();
      if (_sdDow>=1 && _sdDow<=5 && timeCost>=0.5) ws.school.days_enrolled = (ws.school.days_enrolled??0)+Math.min(1,timeCost/6);
    }

    if (route === ROUTE.PATH_2_NOVEL && _cls2Result?.alcohol_consumed?.detected && _cls2Result.alcohol_consumed.drink_type !== 'none') {
      const alcoholInc = calculateAlcoholEffect(_cls2Result.alcohol_consumed.drink_type, ws.player) * (_cls2Result.alcohol_consumed.quantity??1);
      ws.player.stats.alcohol = Math.min(100,(ws.player.stats.alcohol??0)+alcoholInc);
      if ((ws.player.stats.alcohol??0)>20) ws.player.alcohol_tolerance = Math.min(100,(ws.player.alcohol_tolerance??0)+0.5);
    }

    let hangoverChallengePending = null;
    if (route === ROUTE.PATH_3_AUTOPILOT && /sleep|nap/i.test(input)) {
      if ((ws.player.stats.alcohol??0)>30 && !(ws.player.diseases??[]).some(d=>d.id==='hangover')) {
        ws.player.diseases = [...(ws.player.diseases??[]), { id:'hangover', name:'Hangover', severity:'minor', duration_remaining:2, cause:'heavy drinking', per_turn_effects:{health:-2,energy:-15,mood:-20,hygiene:-3}, resolution:'Rest and hydrate. Passes in a day or two.', challenge_title:'Nursing a Hangover', challenge_effects_text:'Energy -15, Mood -20 per turn.' }];
        hangoverChallengePending = challengeFromHangover(ws.turn+1);
      }
    }

    ws = progressDiseases(ws);
    ws = progressNpcDiseases(ws);

    const _contextTags = [...(_cls2Result?.context_tags??[])];
    if (!_contextTags.includes('crowded_place') && /crowd|mall|market|school|church|public|fiesta|concert/i.test(input)) _contextTags.push('crowded_place');
    if (!_contextTags.includes('rain_exposure') && /rain|wet|storm|baha|ulan/i.test(input)) _contextTags.push('rain_exposure');
    if (!_contextTags.includes('outdoor') && /outside|outdoors|park|street/i.test(input)) _contextTags.push('outdoor');

    const newChallenges = [];
    for (const de of _directorEvents.filter(e=>['major','critical','moderate'].includes(e.severity)&&!e.hidden)) {
      const _dCh = { id:`dir_${de.type}_${ws.turn}`, type:de.type??'simulation_event', title:de.description, cause:'Simulation cascade', effects_text:de.description, resolution_steps:'Address the underlying situation to clear this.', severity:de.severity, active:true, resolved:false, turn_created:ws.turn, acknowledged:false };
      ws.challenges = [...(ws.challenges??[]), _dCh]; newChallenges.push(_dCh);
    }
    const _envDisease = checkDiseaseContraction(ws, _contextTags);
    if (_envDisease) {
      const { disease, cause } = _envDisease;
      ws.player.diseases = [...(ws.player.diseases??[]), { id:disease.id, name:disease.name, severity:disease.severity, duration_remaining:disease.base_duration, cause, per_turn_effects:disease.per_turn_effects, resolution:disease.resolution, challenge_title:disease.challenge_title, challenge_effects_text:disease.challenge_effects_text }];
      await logEvent({ turn:ws.turn, category:'health', description:`Contracted ${disease.name} — ${cause}` });
      const ch = challengeFromDisease(disease, cause, ws.turn); ws.challenges=[...(ws.challenges??[]),ch]; newChallenges.push(ch);
    }
    if (npcReactions.length) {
      const _spread = checkNpcDiseaseSpread(ws, npcReactions.map(r=>r.npc_id));
      if (_spread) {
        ws.player.diseases = [...(ws.player.diseases??[]), { id:_spread.disease.id, name:_spread.disease.name, severity:_spread.disease.severity, duration_remaining:_spread.disease.base_duration, cause:_spread.cause, per_turn_effects:_spread.disease.per_turn_effects, resolution:_spread.disease.resolution, challenge_title:_spread.disease.challenge_title, challenge_effects_text:_spread.disease.challenge_effects_text }];
        const _sch = challengeFromDisease(_spread.disease, _spread.cause, ws.turn); ws.challenges=[...(ws.challenges??[]),_sch]; newChallenges.push(_sch);
      }
    }
    let _sceneDriver = null;
    let _hasMajorEvent = false;
    for (const ev of checkWorldEvents(ws)) {
      ws=applyEventEffect(ws,ev); await logEvent({turn:ws.turn,category:ev.category,description:ev.label});
      ws=updateEventIndex(ws,`last_${ev.category}`,ev.label,ws.turn);
      if (ev.challenge_trigger) {
        _hasMajorEvent = true;
        const ch=challengeFromWorldEvent(ev,ws); if(ch){ws.challenges=[...(ws.challenges??[]),ch];newChallenges.push(ch);}
      }
      // Capture first texture scene driver; ignored if a major event fires
      if (!_sceneDriver && ev.scene_driver && ev.effect_result?.scene_driver) {
        _sceneDriver = ev.effect_result.scene_driver;
      }
    }
    // Major events (challenges) are their own scene drivers — suppress texture
    if (_hasMajorEvent) _sceneDriver = null;
    // Non-hidden director events seed a light scene_driver when nothing else claimed it
    if (!_sceneDriver && !_hasMajorEvent && _directorEvents.length) {
      const _lightDE = _directorEvents.find(e => !e.hidden && ['minor','moderate'].includes(e.severity) && !['job_terminated','school_failing_risk'].includes(e.type));
      if (_lightDE) _sceneDriver = { type: 'environment', description: _lightDE.description, weight: 'light', source: 'director' };
    }
    for (const npcEv of checkNpcEvents(ws)) {
      ws=applyNpcEventEffect(ws,npcEv); await logEvent({turn:ws.turn,category:'npc_event',description:`${npcEv.npc_name}: ${npcEv.label}`});
      ws=appendSignificantEvent(ws,`Turn ${ws.turn}: ${npcEv.npc_name} ${npcEv.label}`);
      if (npcEv.creates_player_challenge) { const npc=ws.npcs[npcEv.npc_id]; if(npc){const ch=challengeFromNpcEvent(npcEv,npc,ws.turn);if(ch){ws.challenges=[...(ws.challenges??[]),ch];newChallenges.push(ch);}}}
    }
    // NPC initiative — wired here for the first time; fires every 3rd turn when no scene driver captured
    if (ws.turn % 3 === 0 && !_sceneDriver) {
      const _initCtxs = Object.values(ws.npcs)
        .filter(n => n.status === 'active' && n.significance >= 1)
        .slice(0, 4)
        .map(n => buildNpcContextForGemini(n, ws.sim_time));
      if (_initCtxs.length) {
        try {
          const _inits = await checkNpcInitiative(_initCtxs, ws.player.stats, ws.turn);
          if (_inits.length) {
            _sceneDriver = { type: 'npc_initiative', npc_id: _inits[0].npc_id, brief: _inits[0].brief, contact_type: _inits[0].type, weight: 'medium' };
          }
        } catch {}
      }
    }

    for (const debt of (ws.debts??[])) {
      if (debt.status==='overdue') {
        const alreadyHas=(ws.challenges??[]).some(c=>c.active&&!c.resolved&&c.id.includes(debt.id));
        if (!alreadyHas) {
          const ch=challengeFromDebt(debt,ws.turn); ws.challenges=[...(ws.challenges??[]),ch]; newChallenges.push(ch);
          if (debt.type==='loan_shark') { const lsCh=challengeFromLoanShark(debt.amount,ws.turn); ws.challenges=[...ws.challenges,lsCh]; newChallenges.push(lsCh); }
        }
      }
    }
    for (const addiction of (ws.addictions??[])) {
      if (addiction.status==='withdrawing' && addiction.severity!=='mild') {
        const alreadyHas=(ws.challenges??[]).some(c=>c.active&&!c.resolved&&c.id.includes(addiction.id));
        if (!alreadyHas) { const ch=challengeFromAddiction(addiction,ws.turn); ws.challenges=[...(ws.challenges??[]),ch]; newChallenges.push(ch); }
      }
    }
    const _scandalEv=(ws.consequences??[]).find(c=>c.type==='public_scandal');
    if (_scandalEv && !(ws.challenges??[]).some(c=>c.active&&!c.resolved&&c.type==='fame') && (ws.fame?.level??0)>=2) {
      const sch=challengeFromScandal('Private behavior became public during your rise to fame.',ws.fame.level,ws.turn); ws.challenges=[...(ws.challenges??[]),sch]; newChallenges.push(sch);
    }
    for (const ch of (ws.challenges??[])) { if (ch.active&&!ch.resolved&&checkChallengeResolution(ch,ws)){ch.resolved=true;ch.active=false;} }

    ws.consequences = advanceConsequences(ws.consequences);
    if (ws.consequences.length) consequenceUpd = ws.consequences[0];

    const turnClass = classifyTurn({ stats:ws.player.stats, riskResult, consequenceSeverity:ws.consequences[0]?.severity, statDeltas, relationshipDeltas:relDeltas });
    for (const id of Object.keys(ws.npcs)) ws.npcs[id] = tickFlagDecay(ws.npcs[id]);
    ws.turn += 1;

    // Reality annotation — does not block; tells Grok what actually could occur
    if (route === ROUTE.PATH_2_NOVEL) _realityCheck = detectActionReality(input, ws);

    let prose = '';
    if (route === ROUTE.PATH_3_AUTOPILOT && turnClass === TURN_CLASSIFICATION.ROUTINE) {
      prose = await callGeminiAutopilot(sanitizeStateForGemini(ws), timeCost, input).catch(()=>`${timeCost}h passed.`);
    } else {
      const brief = assembleTurnBrief(ws, { turnNumber:ws.turn, simTime:ws.sim_time, location:ws.player.location, actionDescription:actionDesc, statDeltas, riskResult, consequenceUpdate:consequenceUpd, npcReactions, turnClass, isExplicit:route===ROUTE.PATH_1_EXPLICIT, rawInput:input, sceneDriver:_sceneDriver });
      brief.npc_locations = {};
      const _nlInputLow=input.toLowerCase(), _nlReacted=new Set(npcReactions.map(r=>r.npc_id)), _nlAwayLocs=new Set(['workplace','school','transit']), _nlAbsent=[];
      for (const [_nlId,_nlNpc] of Object.entries(ws.npcs)) {
        if (_nlNpc.status!=='active') continue;
        const _nlTask=getNpcCurrentTask(_nlNpc,ws.sim_time), _nlLoc=_nlTask.location??'home', _nlCo=livesWithPlayer(_nlNpc);
        const _nlAway=_nlAwayLocs.has(_nlLoc), _nlNamed=_nlNpc.name&&_nlInputLow.includes(_nlNpc.name.toLowerCase());
        if (_nlAway&&!_nlNamed&&!_nlReacted.has(_nlId)) { if(_nlNpc.significance>=1) _nlAbsent.push(`${_nlNpc.name}(${_nlLoc})`); continue; }
        let _nlCtx=_nlLoc;
        if      (_nlLoc==='home'&&_nlCo)        _nlCtx="same household as player — their home IS the player's home";
        else if (_nlLoc==='home'&&!_nlCo)       _nlCtx="their own separate home — NOT the player's home";
        else if (_nlLoc==='player_home')         _nlCtx='visiting player\'s home right now';
        else if (_nlLoc==='with_player')         _nlCtx='physically with the player at a shared location';
        brief.npc_locations[_nlId]={name:_nlNpc.name,task:_nlTask.task,location:_nlLoc,present:_nlTask.present!==false,context:_nlCtx};
      }
      if (_nlAbsent.length) brief.absent_npcs_note=`Away this turn (not in scene): ${_nlAbsent.join(', ')}`;
      brief.action_reality_check = _realityCheck;
      brief.npc_witnesses = _npcWitnesses.length ? _npcWitnesses : null;
      const mode={[TURN_CLASSIFICATION.ROUTINE]:'notable',[TURN_CLASSIFICATION.NOTABLE]:'notable',[TURN_CLASSIFICATION.CRISIS]:'crisis',[TURN_CLASSIFICATION.DEATH]:'death'}[turnClass]??'notable';
      prose = await callGrok(brief, mode, {
        isExplicit:route===ROUTE.PATH_1_EXPLICIT, hasDisease:(ws.player?.diseases?.length??0)>0,
        hasAlcohol:(ws.player?.stats?.alcohol??0)>=15, hasChallenges:(ws.challenges??[]).some(c=>c.active&&!c.resolved),
        hasNpcConditions:(brief.npc_conditions?.length??0)>0, isAutopilot:route===ROUTE.PATH_3_AUTOPILOT,
        isInit:false, hasUpcomingSchedule:(brief.upcoming_schedule?.length??0)>0,
        isCrisis:turnClass===TURN_CLASSIFICATION.CRISIS||turnClass===TURN_CLASSIFICATION.DEATH,
        isDeath:turnClass===TURN_CLASSIFICATION.DEATH,
      });
      window._devlog?.turn(`T${ws.turn} narrated`, { class:turnClass, route, chars:prose.length, first50:prose.slice(0,50) });
    }

    // Auto-create NPCs Grok introduces
    if (prose && route !== ROUTE.PATH_3_AUTOPILOT) {
      const _knownNames=new Set(Object.values(ws.npcs).map(n=>n.name?.toLowerCase()).filter(Boolean));
      const _skip=new Set(['The','You','Your','She','He','They','His','Her','Their','What','This','That','Then','Turn','Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','January','February','March','April','May','June','July','August','September','October','November','December']);
      const _objWords=['holder','curtain','table','chair','door','wall','bed','floor','ceiling','window','lamp','sink','toilet','shower','stove','fan','rod','rack','post','knob','handle','frame','stool','barrel'];
      const _relTerms=['mother','father','brother','sister','aunt','uncle','cousin','grandmother','grandfather','mom','dad'];
      const _newName=(prose.match(/\b([A-Z][a-z]{1,14})\b/g)??[]).filter(n=>!_skip.has(n)&&!_knownNames.has(n.toLowerCase())&&!_objWords.some(w=>n.toLowerCase().includes(w))).find((n,i,arr)=>arr.indexOf(n)===i);
      const _relTerm=!_newName?_relTerms.find(term=>prose.toLowerCase().includes(term)&&!_knownNames.has(term)):null;
      const _candidateName=_newName||(_relTerm?_relTerm.charAt(0).toUpperCase()+_relTerm.slice(1):null);
      if (_candidateName) {
        evaluateDescribedNpc(prose.slice(0,500)).then(nd=>{
          if(_turnToken!==S._processTurnCounter) return;
          const _exists=Object.values(S.WS?.npcs??{}).some(n=>n.name?.toLowerCase().trim()===nd?.name?.toLowerCase().trim());
          const _nh=['holder','curtain','table','chair','door','wall','rack','rod','knob','sink','toilet','bucket','bin','stool','lamp','shelf','barrel','pillar','post'];
          const _human=nd?.name&&/^[A-Z]/.test(nd.name)&&nd.name.split(/\s+/).length<=3&&nd.name.length<=28&&!_nh.some(w=>nd.name.toLowerCase().includes(w));
          if (nd?.id&&nd?.name&&S.WS&&!S.WS.npcs?.[nd.id]&&!_exists&&_human&&nd.significance==='significant'){
            const _nn=createNpc({id:nd.id,name:nd.name,age:nd.age||20,npc_class:nd.npc_class||'household',traits:nd.traits||{}});
            _nn.relationship_meter=nd.relationship_meter??10; _nn.trust_meter=nd.trust_meter??5; _nn.significance=1;
            _nn.recent_interactions=[`Appeared in scene — turn ${ws.turn}`];
            S.WS.npcs[nd.id]=_nn; saveWorldState(S.WS).catch(()=>{}); renderAll();
          }
        }).catch(()=>{});
      }
    }

    if (turnClass!==TURN_CLASSIFICATION.ROUTINE) ws=appendSignificantEvent(ws,`Turn ${ws.turn}: ${actionDesc}`);
    if (ws.turn%10===0 && ws.recent_significant_events.length) {
      const _compressed=await compressSessionContext(ws.recent_significant_events).catch(()=>'');
      ws.session_context_flavor=_compressed;
      if (_compressed) ws.world_memory=[...(ws.world_memory??[]),`Turn ~${ws.turn}: ${_compressed}`].slice(-20);
    }

    ws.last_narration_prose = prose;
    const anchor = renderTurnAnchor(ws.turn, ws.sim_time, ws.player.location);
    renderNarration(prose, anchor, document.getElementById('feed'), ws.turn);
    document.getElementById('feed').lastElementChild?.scrollIntoView({ behavior:'smooth' });
    S.WS = ws;
    _turnCommitted = true;
    await saveWorldState(ws); await saveNarration(ws.turn, ws.sim_time, ws.player.location, prose);
    await savePlayerAction(ws.turn, ws.sim_time, input);
    saveWorldStateCloud(ws).catch(()=>{});
    renderAll();

    if (prose && prose.length > 40) {
      const _scNpcs = Object.values(ws.npcs).filter(n=>n.status==='active');
      extractSceneContext(prose, ws.player.location, _scNpcs)
        .then(ctx=>{ if(ctx&&S.WS){S.WS.scene_context=ctx;saveWorldState(S.WS).catch(()=>{});} }).catch(()=>{});
    }

    const _td=new Date(ws.sim_time), _u24=localStorage.getItem('TIME_FORMAT_24H')==='1';
    setStatus(`Turn ${ws.turn} · ${_td.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:!_u24})}`);
    if (document.querySelector('.p-tab[data-p="log"]')?.classList.contains('on')) renderActionLog(null);
    if (newChallenges.length) showChallengeQueue(newChallenges);
    if (hangoverChallengePending) showChallengeQueue([hangoverChallengePending]);

    // Narrative state extractor (non-blocking)
    if (prose && route !== ROUTE.PATH_3_AUTOPILOT) {
      extractNarrativeStateChanges(prose, S.WS).then(changes=>{
        if (!changes||!S.WS) return;
        let _nsWs=JSON.parse(JSON.stringify(S.WS)), _nsChanged=false;
        const pc=changes.player_changes??{};
        if (pc.location) { _nsWs.player.location=pc.location; _nsChanged=true; }
        if (pc.job_lost) { _nsWs.job=null; _nsChanged=true; }
        if (pc.job_new_employer) { _nsWs.job={employer:pc.job_new_employer,position:'Worker',performance_flags:[],days_employed:0,salary_per_cycle:null,pay_cycle:null,schedule:null}; _nsChanged=true; }
        if (pc.school_quit&&_nsWs.school) { _nsWs.school.status='dropped_out'; _nsChanged=true; }
        if (pc.school_enrolled) { _nsWs.school={name:pc.school_enrolled,status:'active',grade_level:null,schedule:null,absence_count:0,days_enrolled:0}; _nsChanged=true; }
        if (pc.cash_delta!=null&&typeof pc.cash_delta==='number'&&pc.cash_delta!==0) {
          _nsWs.player.cash=Math.max(0,(_nsWs.player.cash??0)+Math.max(-10000,Math.min(10000,Math.round(pc.cash_delta)))); _nsChanged=true;
          window._devlog?.stat(`Prose cash delta: ${pc.cash_delta>0?'+':''}${pc.cash_delta} → ${_nsWs.player.cash}`,{});
        }
        if (Array.isArray(pc.possessions_gained)&&pc.possessions_gained.length) {
          _nsWs.player.possessions=_nsWs.player.possessions??[];
          const _en=new Set(_nsWs.player.possessions.map(p=>(p.name??'').toLowerCase()));
          for (const _pg of pc.possessions_gained) { if(!_pg.name||_en.has(_pg.name.toLowerCase()))continue; _nsWs.player.possessions.push({name:_pg.name,note:_pg.note??null,condition:'new',durability:100,acquired_method:'scene'}); _en.add(_pg.name.toLowerCase()); } _nsChanged=true;
        }
        if (Array.isArray(pc.possessions_lost)&&pc.possessions_lost.length) {
          _nsWs.player.possessions=_nsWs.player.possessions??[];
          for (const _pl of pc.possessions_lost) { const _bl=_nsWs.player.possessions.length; _nsWs.player.possessions=_nsWs.player.possessions.filter(p=>!p.name||p.name.toLowerCase()!==_pl.toLowerCase()); if(_nsWs.player.possessions.length<_bl)_nsChanged=true; }
        }
        if (pc.appearance_note&&typeof pc.appearance_note==='string') {
          _nsWs.player.irreversible=_nsWs.player.irreversible??[]; const _an=pc.appearance_note.trim();
          if(_an&&!_nsWs.player.irreversible.some(i=>i.toLowerCase().includes(_an.toLowerCase().slice(0,20)))){ _nsWs.player.irreversible.push(_an); _nsChanged=true; }
        }
        for (const nc of (changes.npc_changes??[])) {
          if (!nc.npc_id||!_nsWs.npcs[nc.npc_id]) continue;
          if (nc.job_lost){_nsWs.npcs[nc.npc_id]=updateNpcCareer(_nsWs.npcs[nc.npc_id],{action:'quit_job'});_nsChanged=true;}
          if (nc.job_new_employer){_nsWs.npcs[nc.npc_id]=updateNpcCareer(_nsWs.npcs[nc.npc_id],{action:'new_job',details:{employer:nc.job_new_employer}});_nsChanged=true;}
          if (nc.school_quit){_nsWs.npcs[nc.npc_id]=updateNpcCareer(_nsWs.npcs[nc.npc_id],{action:'quit_school'});_nsChanged=true;}
          if (nc.school_enrolled){_nsWs.npcs[nc.npc_id]=updateNpcCareer(_nsWs.npcs[nc.npc_id],{action:'enroll_school',details:{school_name:nc.school_enrolled}});_nsChanged=true;}
          if (nc.status&&nc.status!=='null'&&nc.status!=='active'){
            if(nc.status==='deceased'){_nsWs.npcs[nc.npc_id].status='inactive';_nsWs.npcs[nc.npc_id].departure_reason='deceased';}
            else if(nc.status==='moved_away'){_nsWs.npcs[nc.npc_id]=updateNpcCareer(_nsWs.npcs[nc.npc_id],{action:'move_away'});}
            _nsChanged=true;
          }
          if (nc.mood_event&&typeof nc.mood_event==='string'){const _ri=_nsWs.npcs[nc.npc_id].recent_interactions??[];_nsWs.npcs[nc.npc_id].recent_interactions=[..._ri,nc.mood_event.trim()].slice(-5);_nsChanged=true;}
          if (nc.relationship_note&&typeof nc.relationship_note==='string'){const _ri=_nsWs.npcs[nc.npc_id].recent_interactions??[];_nsWs.npcs[nc.npc_id].recent_interactions=[..._ri,`[Relationship shift — Turn ${_nsWs.turn}] ${nc.relationship_note.trim()}`].slice(-5);_nsChanged=true;}
        }
        if (_nsChanged){S.WS=_nsWs;saveWorldState(S.WS).catch(()=>{});renderAll();}
      }).catch(()=>{});
    }

    // NPC flag cleanup (non-blocking)
    if (prose && route !== ROUTE.PATH_3_AUTOPILOT) {
      const _cfNpcs=Object.entries(S.WS.npcs).filter(([,n])=>n.active_flags?.length>0);
      if (_cfNpcs.length) {
        Promise.all(_cfNpcs.map(([_cfId,_cfNpc])=>
          evaluateNpcFlagsInContext(_cfNpc,prose,timeCost).then(_cfRemove=>{
            if(!_cfRemove.length||!S.WS?.npcs?.[_cfId]) return;
            S.WS.npcs[_cfId]={...S.WS.npcs[_cfId],active_flags:S.WS.npcs[_cfId].active_flags.filter(f=>!_cfRemove.includes(f)),flag_timers:Object.fromEntries(Object.entries(S.WS.npcs[_cfId].flag_timers??{}).filter(([k])=>!_cfRemove.includes(k)))};
          }).catch(()=>{})
        )).then(()=>{ if(_turnToken!==S._processTurnCounter) return; saveWorldState(S.WS).catch(()=>{}); renderAll(); });
      }
    }

    if (turnClass === TURN_CLASSIFICATION.DEATH) {
      setStatus('☠ Character has died — processing...', 'err');
      document.getElementById('submit-btn').disabled = true;
      document.getElementById('action-input').disabled = true;
      setTimeout(() => _handleDeath(prose), 500);
    }
  } catch(err) {
    window._devlog?.error('processTurn error', { message:err.message, stack:err.stack?.slice(0,400) });
    if (_turnCommitted) setStatus('Turn processed — narrator failed. Type anything to continue.', 'err');
    else setStatus(`Error: ${err.message}`, 'err');
    console.error('[processTurn]', err);
  } finally {
    if (!S.WS || S.WS.player?.stats?.health > 0) setProcessing(false);
  }
}