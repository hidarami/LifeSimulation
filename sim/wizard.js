// wizard.js — new game wizard, lorebook builder, startNewGame
import S from './gameState.js';
import { createInitialWorldState, createNewSaveSlot, saveWorldState,
         saveNarration, savePlayerAction, getCurrentSaveId } from './state.js';
import { advanceTime, formatTimestamp } from './engine.js';
import { buildWorldWithMultipleAIs, enrichWorldDetails, compressLorebook,
         callGrok, resetConvId } from './api.js';
import { createNpc } from './npc.js';
import { renderAll, setStatus } from './uiCore.js';
import { renderTurnAnchor, renderNarration } from './renderer.js';
import { loadConsoleHistoryForCurrentSave } from './consoleUI.js';
import { _resolveEnrichmentKey } from './patch.js';

let _initInProgress = false;
export function isInitInProgress() { return _initInProgress; }

// ── WIZARD STEP CONTROL ───────────────────────────────────────────────────────
function showWizardStep(n) {
  document.querySelectorAll('.wizard-step').forEach((el, i) => el.classList.toggle('on', i + 1 === n));
  document.getElementById('wizard-title').textContent = ['New Game','Your World','Starting...'][n-1];
  document.getElementById('btn-wizard-back').style.display = (n === 2) ? 'block' : 'none';
  const footer = document.getElementById('wizard-footer');
  const nextBtn = document.getElementById('btn-wizard-next');
  if (n === 3 && _initInProgress) { footer.style.display = 'none'; }
  else { footer.style.display = 'flex'; nextBtn.textContent = n === 2 ? 'Start Game ▶' : 'Next →'; }
}

function compileLorebook(lorebookText, playerName) {
  const warnings = [];
  if (!lorebookText?.trim()) return { warnings };
  if (lorebookText.trim().length < 60)
    warnings.push('Lorebook is very short — AI may not extract NPCs accurately. Add more context.');
  const BAD_CLASSES = ['family','relative','friend','romantic','sibling'];
  for (const bad of BAD_CLASSES) {
    if (new RegExp(`npc_class[\\s"':]+${bad}`, 'i').test(lorebookText))
      warnings.push(`Contains invalid npc_class "${bad}" — will be defaulted to "household"`);
  }
  if (playerName && lorebookText.toLowerCase().includes(playerName.toLowerCase()))
    warnings.push(`Player name "${playerName}" appears in lorebook — check an NPC wasn't named the same.`);
  return { warnings };
}

// ── START NEW GAME ────────────────────────────────────────────────────────────
export async function startNewGame() {
  const name     = document.getElementById('w-name').value.trim();
  const age      = parseInt(document.getElementById('w-age').value) || 18;
  const sex      = document.getElementById('w-sex').value;
  const lorebook = document.getElementById('w-lorebook').value.trim();
  if (!confirm(`Start new game as "${name}"? This creates a new save slot.`)) return;
  if (_initInProgress) return;
  _initInProgress = true;
  showWizardStep(3);
  document.getElementById('wizard-footer').style.display = 'none';
  if (lorebook) localStorage.setItem('LOREBOOK', lorebook);
  let ws = createInitialWorldState(name, new Date().toISOString());
  ws.player.age = age; ws.player.sex = sex;
  ws.player.birthday = String(new Date(ws.sim_time).getFullYear() - age);
  resetConvId();
  document.getElementById('feed').innerHTML = '';
  const pfill   = document.getElementById('init-pfill');
  const stageEl = document.getElementById('init-stage-text');
  const subEl   = document.getElementById('init-sub-text');
  const setStage = (text, sub, pct) => { stageEl.textContent = text; if (subEl) subEl.textContent = sub; pfill.style.width = pct + '%'; };
  try {
    if (lorebook) {
      const { warnings } = compileLorebook(lorebook, name);
      for (const w of warnings) { setStage('Validating lorebook...', '⚠ ' + w, 5); await new Promise(r => setTimeout(r, 2000)); }
      setStage('Parsing your world...', 'AI is reading your lorebook...', 10);
      const parsed = await buildWorldWithMultipleAIs(lorebook).catch(() => null);
      if (!parsed || !parsed.npcs?.length) {
        setStage('Parsing your world...', parsed
          ? '⚠ Lorebook parsed but no NPCs were extracted. Check your API key or rewrite the lorebook.'
          : '⚠ Lorebook parsing failed entirely. Game will start with an empty world.', 10);
        await new Promise(r => setTimeout(r, 3500));
      }
      if (parsed) {
        setStage('Building world state...', 'Initializing characters and relationships...', 32);
        if (parsed.player?.location) ws.player.location = parsed.player.location;
        if (parsed.player?.cash != null && !isNaN(Number(parsed.player.cash))) ws.player.cash = Number(parsed.player.cash);
        if (parsed.player?.initial_stats && typeof parsed.player.initial_stats === 'object') {
          for (const [_sk, _sv] of Object.entries(parsed.player.initial_stats)) {
            if (_sv !== null && _sv !== undefined && _sk in ws.player.stats && _sk !== 'arousal')
              ws.player.stats[_sk] = Math.max(0, Math.min(100, Number(_sv)));
          }
        }
        if (parsed.job && typeof parsed.job === 'object') ws.job = { performance_flags: [], days_employed: 0, ...parsed.job };
        if (Array.isArray(parsed.npcs)) {
          for (const nd of parsed.npcs) {
            if (!nd.id || !nd.name) continue;
            const npc = createNpc({ id: nd.id, name: nd.name, age: nd.age || 25, npc_class: nd.npc_class || 'household', relationship_type: nd.relationship_type || null, traits: nd.traits || {} });
            npc.relationship_meter = Math.max(-100, Math.min(100, Number(nd.relationship_meter) || 0));
            npc.trust_meter = Math.max(-100, Math.min(100, Number(nd.trust_meter) || 0));
            npc.significance = 2;
            const _initNotes = nd.note ? [nd.note] : [];
            if (!_initNotes.length) {
              const _relDesc = (nd.relationship_type ?? nd.npc_class ?? '').replace(/_/g, ' ');
              _initNotes.push(`Known to player from before the game start${_relDesc ? ' — ' + _relDesc : ''}.`);
            }
            npc.recent_interactions = _initNotes;
            ws.npcs[nd.id] = npc;
          }
        }
        if (Array.isArray(parsed.possessions)) ws.player.possessions = parsed.possessions;
        if (parsed.start_date?.year) {
          const yr = parsed.start_date.year;
          const mo = Math.max(0, Math.min(11, (parsed.start_date.month ?? 6) - 1));
          const hr = parsed.start_date.hour != null ? Math.max(0, Math.min(23, parsed.start_date.hour)) : 8;
          ws.sim_time = new Date(yr, mo, 15, hr, 0, 0).toISOString();
          ws.player.birthday = String(yr - age);
        }
      }
    }
    {
      setStage('Imagining your world...', 'Filling in missing details...', 48);
      const enriched = await enrichWorldDetails(lorebook || '', ws).catch(() => null);
      if (enriched) {
        if (enriched.location_name) ws.player.location = enriched.location_name;
        if (enriched.setting_description) ws.setting_description = enriched.setting_description;
        if (enriched.npc_descriptions && typeof enriched.npc_descriptions === 'object') {
          for (const [key, bio] of Object.entries(enriched.npc_descriptions)) {
            if (!bio || typeof bio !== 'string') continue;
            const _bioNpc = _resolveEnrichmentKey(key, ws.npcs);
            if (_bioNpc && ws.npcs[_bioNpc.id]) ws.npcs[_bioNpc.id].bio = bio;
          }
        }
        if (enriched.npc_schedules && typeof enriched.npc_schedules === 'object') {
          for (const [key, sched] of Object.entries(enriched.npc_schedules)) {
            if (!sched?.weekday_routine?.length) continue;
            const _sNpc = _resolveEnrichmentKey(key, ws.npcs);
            if (_sNpc && ws.npcs[_sNpc.id]) {
              ws.npcs[_sNpc.id].schedule = { weekday_routine: sched.weekday_routine, weekend_routine: sched.weekend_routine ?? sched.weekday_routine, interruptions: ws.npcs[_sNpc.id].schedule?.interruptions ?? [] };
            }
          }
        }
        if (enriched.school?.name) ws.school = enriched.school;
        if (enriched.job_enrichment) {
          if (ws.job) {
            if (!ws.job.description)                              ws.job.description    = enriched.job_enrichment.description;
            if (!ws.job.schedule || ws.job.schedule === 'null')   ws.job.schedule      = enriched.job_enrichment.schedule;
            ws.job.earnings_note  = enriched.job_enrichment.earnings;
            ws.job.employer       = ws.job.employer || enriched.job_enrichment.platform_or_employer;
            ws.job.days_employed  = enriched.job_enrichment.days_active ?? ws.job.days_employed ?? 0;
          } else {
            ws.job = { employer: enriched.job_enrichment.platform_or_employer, position: enriched.job_enrichment.position ?? 'Part-time Worker', description: enriched.job_enrichment.description, salary_per_cycle: null, pay_cycle: null, schedule: enriched.job_enrichment.schedule, earnings_note: enriched.job_enrichment.earnings, days_employed: enriched.job_enrichment.days_active ?? 0, performance_flags: [] };
          }
        }
        if (enriched.starting_possessions?.length) {
          const _seenPoss = new Set();
          const _allPoss = [...enriched.starting_possessions, ...(ws.player.possessions ?? [])];
          ws.player.possessions = _allPoss.filter(p => { const _k = (p.name ?? '').toLowerCase().trim(); if (!_k || _seenPoss.has(_k)) return false; _seenPoss.add(_k); return true; });
        }
      }
    }
    if (lorebook.trim()) compressLorebook(lorebook, name, Object.values(ws.npcs).map(n => n.name).filter(Boolean)).catch(() => {});
    setStage('Saving world state...', 'Writing to storage...', 54);
    await createNewSaveSlot(ws);
    S.WS = ws;
    loadConsoleHistoryForCurrentSave(getCurrentSaveId()).catch(() => {});
    setStage('Writing your opening scene...', 'Grok is composing your world...', 72);
    const _use24h = localStorage.getItem('TIME_FORMAT_24H') === '1';
    const _td = new Date(ws.sim_time);
    const sim_time_formatted = _td.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: !_use24h }) + ' · ' + _td.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    const initBrief = { turn: 1, sim_time: ws.sim_time, sim_time_formatted, location: ws.player.location || 'home', player_stats: ws.player.stats, player_cash: ws.player.cash, player_name: ws.player.name, action_taken: '[game_start]', player_raw_input: 'Begin', stat_deltas: {}, risk_result: null, consequence_update: null, npc_reactions: [], turn_class: 'NOTABLE', is_explicit: false, active_dynamics: [], recent_events: [], structured_history: null, session_flavor: null, last_narration: null };
    const prose = await callGrok(initBrief, 'init', { isInit: true });
    pfill.style.width = '100%';
    await new Promise(r => setTimeout(r, 300));
    ws.turn = 1; ws.last_narration_prose = prose;
    await saveWorldState(ws); S.WS = ws;
    await saveNarration(1, ws.sim_time, ws.player.location, prose);
    await savePlayerAction(1, ws.sim_time, '[game_start]');
    _initInProgress = false;
    document.getElementById('modal-newgame').classList.remove('open');
    renderAll();
    const anchor = renderTurnAnchor(1, ws.sim_time, ws.player.location);
    renderNarration(prose, anchor, document.getElementById('feed'), 1);
    document.getElementById('feed').lastElementChild?.scrollIntoView({ behavior: 'smooth' });
    setStatus(`Game started · ${name}`);
  } catch (err) {
    _initInProgress = false;
    pfill.style.background = 'var(--crit)';
    stageEl.textContent = '⚠ Failed to start';
    if (subEl) subEl.textContent = err.message;
    document.getElementById('wizard-footer').style.display = 'flex';
    document.getElementById('btn-wizard-back').style.display = 'block';
    document.getElementById('btn-wizard-next').textContent = 'Retry';
    console.error('[init]', err);
  }
}

// ── WIZARD EVENT WIRING ────────────────────────────────────────────────────────
export function initWizard(closeMenuFn) {
  document.getElementById('btn-new').addEventListener('click', () => {
    closeMenuFn();
    document.getElementById('w-name').value = '';
    document.getElementById('w-age').value = '18';
    document.getElementById('w-sex').value = 'male';
    document.getElementById('w-lorebook').value = localStorage.getItem('LOREBOOK') || '';
    const _defMode = document.querySelector('input[name="lb-mode"][value="builder"]');
    if (_defMode) { _defMode.checked = true; _defMode.dispatchEvent(new Event('change')); }
    ['lb-year','lb-season','lb-location','lb-home','lb-cash','lb-lang','lb-possessions','lb-notes','lb-school','lb-school-sched','lb-job','lb-job-sched'].forEach(id => { const el = document.getElementById(id); if (el) el.value = id === 'lb-year' ? new Date().getFullYear() : ''; });
    document.getElementById('lb-npc-list').innerHTML = '';
    const _defStatus = document.querySelector('input[name="lb-status"][value="neither"]');
    if (_defStatus) { _defStatus.checked = true; _defStatus.dispatchEvent(new Event('change')); }
    showWizardStep(1);
    document.getElementById('modal-newgame').classList.add('open');
  });
  document.getElementById('btn-wizard-close').addEventListener('click', () => { if (!_initInProgress) document.getElementById('modal-newgame').classList.remove('open'); });
  document.getElementById('btn-wizard-back').addEventListener('click', () => { if (!_initInProgress) showWizardStep(1); });
  document.getElementById('btn-wizard-next').addEventListener('click', async () => {
    if (document.querySelectorAll('.wizard-step')[0].classList.contains('on')) {
      if (!document.getElementById('w-name').value.trim()) { alert('Please enter a character name.'); return; }
      showWizardStep(2);
    } else { await startNewGame(); }
  });
  // Lorebook mode toggle
  document.querySelectorAll('input[name="lb-mode"]').forEach(r => {
    r.addEventListener('change', () => {
      const mode = document.querySelector('input[name="lb-mode"]:checked')?.value;
      const builderEl = document.getElementById('lb-helper');
      const lbWrap    = document.getElementById('w-lorebook-wrap');
      const aiNotice  = document.getElementById('lb-ai-notice');
      if (!builderEl || !lbWrap || !aiNotice) return;
      if (mode === 'builder')     { builderEl.style.display = ''; lbWrap.style.display = ''; aiNotice.style.display = 'none'; }
      else if (mode === 'paste')  { builderEl.style.display = 'none'; lbWrap.style.display = ''; aiNotice.style.display = 'none'; }
      else { builderEl.style.display = 'none'; lbWrap.style.display = 'none'; aiNotice.style.display = ''; document.getElementById('w-lorebook').value = ''; }
    });
  });
  // Lorebook builder toggle
  document.getElementById('lb-helper-toggle').addEventListener('click', () => {
    const body = document.getElementById('lb-helper-body');
    const icon = document.getElementById('lb-toggle-icon');
    const open = body.style.display !== 'none' && getComputedStyle(body).display !== 'none';
    body.style.display = open ? 'none' : 'block'; icon.textContent = open ? '▶' : '▼';
  });
  document.querySelectorAll('input[name="lb-status"]').forEach(r => {
    r.addEventListener('change', () => {
      const v = document.querySelector('input[name="lb-status"]:checked')?.value;
      document.getElementById('lb-student-fields').style.display = (v === 'student' || v === 'both') ? 'block' : 'none';
      document.getElementById('lb-work-fields').style.display   = (v === 'working' || v === 'both') ? 'block' : 'none';
    });
  });
  document.getElementById('lb-add-npc').addEventListener('click', () => {
    const row = document.createElement('div'); row.className = 'lb-npc-row';
    row.innerHTML = `<input class="field-input lb-npc-name" placeholder="Name" style="flex:2;min-width:70px"><input class="field-input lb-npc-age" placeholder="Age" type="number" style="width:50px;flex-shrink:0"><input class="field-input lb-npc-rel" placeholder="Relationship" style="flex:2;min-width:80px"><input class="field-input lb-npc-note" placeholder="Brief note" style="flex:3;min-width:90px"><button class="btn" data-lb-remove style="padding:0 8px;height:36px;flex-shrink:0">✕</button>`;
    document.getElementById('lb-npc-list').appendChild(row);
  });
  document.getElementById('lb-npc-list').addEventListener('click', e => { if ('lbRemove' in e.target.dataset) e.target.closest('.lb-npc-row').remove(); });
  document.getElementById('lb-generate').addEventListener('click', () => {
    const name = document.getElementById('w-name').value.trim() || 'Character';
    const age  = document.getElementById('w-age').value  || '';
    const sex  = document.getElementById('w-sex').value  || '';
    const lines = [];
    const idParts = [name, age, sex].filter(Boolean);
    lines.push(idParts.join(', ') + '.');
    const lang = document.getElementById('lb-lang').value.trim();
    if (lang) lines.push(`Speaks ${lang}.`);
    const year = document.getElementById('lb-year').value.trim();
    const season = document.getElementById('lb-season').value.trim();
    if (year || season) { let d = year ? `The year is ${year}.` : ''; if (season) d += (d ? ' ' : '') + season + '.'; lines.push(d.trim()); }
    const loc  = document.getElementById('lb-location').value.trim();   if (loc)  lines.push(`Lives in ${loc}.`);
    const home = document.getElementById('lb-home').value.trim();       if (home) lines.push(`Home: ${home}.`);
    const cash = document.getElementById('lb-cash').value.trim();       if (cash) lines.push(`Has ₱${cash}.`);
    const poss = document.getElementById('lb-possessions').value.trim(); if (poss) lines.push(`Possessions: ${poss}.`);
    const status = document.querySelector('input[name="lb-status"]:checked')?.value ?? 'neither';
    if (status === 'student' || status === 'both') { const s = document.getElementById('lb-school').value.trim(); const ss = document.getElementById('lb-school-sched').value.trim(); lines.push(s ? `Enrolled at ${s}${ss ? ' (' + ss + ')' : ''}.` : 'Currently a student.'); }
    if (status === 'working' || status === 'both') { const j = document.getElementById('lb-job').value.trim(); const js = document.getElementById('lb-job-sched').value.trim(); lines.push(j ? `Works as ${j}${js ? ' — ' + js : ''}.` : 'Currently employed.'); }
    if (status === 'neither') lines.push('Not currently enrolled in school or employed.');
    document.querySelectorAll('.lb-npc-row').forEach(row => {
      const n = row.querySelector('.lb-npc-name')?.value.trim(); if (!n) return;
      const a = row.querySelector('.lb-npc-age')?.value.trim();
      const rel = row.querySelector('.lb-npc-rel')?.value.trim();
      const nt = row.querySelector('.lb-npc-note')?.value.trim();
      let entry = `${rel ? rel + ' ' : ''}${n}${a ? ', ' + a : ''}`; if (nt) entry += ' — ' + nt;
      lines.push(entry + '.');
    });
    const notes = document.getElementById('lb-notes').value.trim();
    if (notes) lines.push('\n' + notes);
    document.getElementById('w-lorebook').value = lines.filter(Boolean).join('\n');
  });
}