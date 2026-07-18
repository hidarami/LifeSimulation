// ── MAIN APPLICATION ENTRY POINT ──────────────────────────────────────────
import { loadWorldState, saveWorldState, createInitialWorldState,
         createNewSaveSlot, listSaves, deleteSave,
         assembleTurnBrief, appendSignificantEvent, updateEventIndex, logEvent,
         saveNarration, loadNarrations, savePlayerAction, loadPlayerActions,
         setSupabaseClient, saveWorldStateCloud, loadWorldStateCloud,
         getCurrentSaveId, saveConsoleMessage, loadConsoleHistory,
         saveImage, loadImage, loadAllImages,
         addDebt, payDebt, computeFameTier, updateFame, FAME_TIERS,
         exportNpc, exportWorldSummary, exportLorebook,
         exportPatchAuditLog, savePatchAuditEntry, saveClassifierOutput,
         exportClassifierHistory } from './state.js';
import { applyDecay, applyDeltas, advanceTime, formatTimestamp,
         rollRisk, classifyTurn, advanceConsequences, TURN_CLASSIFICATION,
         applyCascadingEffects, computeCharacterEmotions, applyCascadeEffectsToExternal,
         getCircadianModifiers, getSleepEfficiency } from './engine.js';
import { routeInput, isExplicit, classifyExplicitActivity,
         EXPLICIT_ACTIVITY_TABLE, sanitizeStateForGemini, extractCompoundContext, ROUTE,
         hasThirdPartyPresence } from './sanitizer.js';
import { callGrok, classifyAction, evaluateNpcReaction, resetConvId, setConversationHistory,
         callGeminiAutopilot, compressSessionContext, parseLorebookToWorldState,
         buildWorldWithMultipleAIs, evaluateDescribedNpc,
         enrichWorldDetails, evaluateNpcFlagsInContext, callMetaConsole,
         extractNarrativeStateChanges, extractSceneContext, compressLorebook } from './api.js';
import { renderNpcPanel, renderJobPanel,
         renderPossessionsPanel, renderNarration, renderTurnAnchor, renderChallengesPanel,
         livesWithPlayer, getSmartNpcLabel } from './renderer.js';
import { checkWorldEvents, checkNpcEvents, applyEventEffect, applyNpcEventEffect,
         progressDiseases, progressNpcDiseases, checkDiseaseContraction, checkNpcDiseaseSpread,
         calculateAlcoholEffect, getIntoxicationLevel, tickSchoolSuspension,
         tickDebts, tickAddictions, feedAddiction, addAddiction,
         addCrime, decreaseWantedLevel,
         runSimulationDirector, GSD_INTERVAL } from './events.js';
import { challengeFromDisease, challengeFromNpcEvent, challengeFromWorldEvent,
         challengeFromHangover, checkChallengeResolution,
         challengeFromDebt, challengeFromCrime, challengeFromAddiction,
         challengeFromScandal, challengeFromLoanShark } from './challenges.js';
import { tickFlagDecay, addFlag, incrementSignificance, FLAG_DECAY,
         buildNpcContextForGemini, applyRelationshipDelta, createNpc,
         driftTraits, getNpcCurrentTask, updateNpcCareer } from './npc.js';
import { detectProvider, getProviderDisplayName, fetchModels, dispatchChat as _providerDispatchChat } from './providers.js';

import S from './gameState.js';
import { _applySimPatch, _resolveNpcPatchKey, _resolveEnrichmentKey,
         _tryParsePatchJson, _extractAndApplyStateChange, validatePatch } from './patch.js';
import { setStatus, setProcessing, renderAll, renderCenterStats,
         renderSchedulePanel, buildCharacterOverview, renderActionLog,
         openCharModal, openNpcModal, runIntegrityCheck,
         showChallengeQueue } from './uiCore.js';
import { initWizard, startNewGame } from './wizard.js';
import { initSettings, initSupabaseAuth, initLoadModal, initPreferences } from './settingsUI.js';
import { initConsoleUI, sendConsoleMessage, loadConsoleHistoryForCurrentSave,
         appendConsoleMsg } from './consoleUI.js';
import { initDevConsole } from './devConsoleUI.js';
import { initImageUpload, loadImageCache, showCameraFlash } from './imageUpload.js';
import { processTurn } from './turnProcessor.js';

console.log('🎮 Starting The Sim...');

// ── PANEL NAVIGATION ──────────────────────────────────────────────────────────
let currentPanel = 'center';
let _tx = 0, _ty = 0, _tt = 0;
let _panelLock = false;

function showPanel(p) {
  currentPanel = p; _panelLock = true;
  const w = document.getElementById('panels-wrapper');
  w.className = p === 'left' ? 'show-left' : p === 'right' ? 'show-right' : 'show-center';
  setTimeout(() => { _panelLock = false; }, 400);
}
function openMenu()  { document.getElementById('menu-overlay').classList.add('open');    document.getElementById('menu-drawer').classList.add('open'); }
function closeMenu() { document.getElementById('menu-overlay').classList.remove('open'); document.getElementById('menu-drawer').classList.remove('open'); }

// ── BOOT: Initialize all UI systems ─────────────────────────────────────────
// NOTE: closeMenu is a function declaration — hoisted — safe to pass before textual definition
initWizard(closeMenu);
initSettings(closeMenu);
initPreferences(closeMenu);
initLoadModal(loadImageCache);
initSupabaseAuth();
initConsoleUI(closeMenu);
initDevConsole(() => S.WS, closeMenu);
initImageUpload();

// Panel back buttons
document.querySelectorAll('.panel-back').forEach(btn => {
  btn.addEventListener('click', () => showPanel(btn.dataset.target));
});

// Touch swipe navigation
document.addEventListener('touchstart', e => { _tx=e.touches[0].clientX; _ty=e.touches[0].clientY; _tt=Date.now(); }, { passive:true });
document.addEventListener('touchend', e => {
  if (_panelLock) return;
  if (document.querySelector('.modal-overlay.open')) return;
  if (document.getElementById('menu-drawer').classList.contains('open')) return;
  const dx=e.changedTouches[0].clientX-_tx, dy=e.changedTouches[0].clientY-_ty;
  if (Math.abs(dy)>Math.abs(dx)*1.2||Math.abs(dx)<50||Date.now()-_tt>500) return;
  if (dx<0) { if(currentPanel==='left') showPanel('center'); else if(currentPanel==='center') showPanel('right'); }
  else      { if(currentPanel==='right') showPanel('center'); else if(currentPanel==='center') showPanel('left'); }
}, { passive:true });

// Menu
document.getElementById('menu-btn').addEventListener('click', openMenu);
document.getElementById('menu-overlay').addEventListener('click', closeMenu);

// Theme
let isDark = localStorage.getItem('theme') !== 'light';
function applyTheme(dark) {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  document.getElementById('theme-tog').classList.toggle('on', !dark);
  localStorage.setItem('theme', dark ? 'dark' : 'light');
}
applyTheme(isDark);
document.getElementById('btn-theme').addEventListener('click', () => { isDark = !isDark; applyTheme(isDark); });

// Tabs
document.querySelectorAll('.p-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.p-tab').forEach(t => t.classList.remove('on'));
    document.querySelectorAll('.panel-section').forEach(p => p.classList.remove('on'));
    tab.classList.add('on');
    document.getElementById(`p-${tab.dataset.p}`).classList.add('on');
    if (tab.dataset.p === 'log') renderActionLog(showPanel);
  });
});
document.getElementById('btn-logs').addEventListener('click', () => {
  closeMenu(); showPanel('left');
  document.querySelectorAll('.p-tab').forEach(t => t.classList.remove('on'));
  document.querySelectorAll('.panel-section').forEach(p => p.classList.remove('on'));
  const lt = document.querySelector('.p-tab[data-p="log"]');
  if (lt) { lt.classList.add('on'); document.getElementById('p-log').classList.add('on'); }
  renderActionLog(showPanel);
});

// Modals
document.getElementById('char-avatar').addEventListener('click', openCharModal);
document.getElementById('btn-char-close').addEventListener('click', () => document.getElementById('modal-char').classList.remove('open'));
document.getElementById('modal-char').addEventListener('click', e => { if(e.target===e.currentTarget) e.currentTarget.classList.remove('open'); });
document.getElementById('npc-cards').addEventListener('click', e => { const btn=e.target.closest('.npc-detail-btn'); if(btn&&S.WS) openNpcModal(btn.dataset.id); });
document.getElementById('btn-npc-close').addEventListener('click', () => document.getElementById('modal-npc').classList.remove('open'));
document.getElementById('modal-npc').addEventListener('click', e => { if(e.target===e.currentTarget) e.currentTarget.classList.remove('open'); });

// ── ACTION INPUT ──────────────────────────────────────────────────────────────
document.getElementById('submit-btn').addEventListener('click', () => {
  const v = document.getElementById('action-input').value.trim();
  if (!v) return;
  document.getElementById('action-input').value = '';
  document.getElementById('action-input').style.height = 'auto';
  processTurn(v);
});
document.getElementById('action-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById('submit-btn').click(); }
});
document.getElementById('action-input').addEventListener('input', function() {
  this.style.height = 'auto'; this.style.height = Math.min(this.scrollHeight, 110) + 'px';
});

// ── UPDATE SYSTEM ─────────────────────────────────────────────────────────────
async function checkForUpdate() {
  try {
    const res = await fetch('version.json?_=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return;
    const { version, notes } = await res.json();
    const stored = localStorage.getItem('sim_version');
    if (!stored) { localStorage.setItem('sim_version', version); return; }
    if (stored !== version) {
      const banner = document.getElementById('update-banner');
      const notesEl = document.getElementById('update-notes');
      if (notesEl) notesEl.textContent = notes || `Version ${version} is ready`;
      if (banner) { banner.style.display = ''; banner.dataset.newVersion = version; }
    }
  } catch { /* network unavailable */ }
}
document.getElementById('btn-dismiss-update')?.addEventListener('click', () => {
  document.getElementById('update-banner').style.display = 'none';
});
document.getElementById('btn-apply-update')?.addEventListener('click', async () => {
  try { const res=await fetch('version.json?_='+Date.now(),{cache:'no-store'}); if(res.ok){const{version}=await res.json();localStorage.setItem('sim_version',version);} } catch {}
  window.location.reload(true);
});

// ── BOOT ──────────────────────────────────────────────────────────────────────
async function boot() {
  const su = localStorage.getItem('SUPABASE_URL'), sk = localStorage.getItem('SUPABASE_ANON_KEY');
  let signedIn = false;
  if (su && sk && window.supabase) {
    if (!S._sbClient) { S._sbClient = window.supabase.createClient(su, sk); setSupabaseClient(S._sbClient); }
    await S._sbClient.auth.getSession();
    window.history.replaceState(null, '', window.location.pathname);
    const { data: { user } } = await S._sbClient.auth.getUser();
    if (user) { signedIn = true; setStatus(`Signed in: ${user.email}`); }
  }
  S.WS = await loadWorldState();
  await loadImageCache().catch(() => {});
  const _bootCloud = await loadWorldStateCloud();
  if (_bootCloud) { S.WS = _bootCloud; await saveWorldState(S.WS); }
  if (S.WS) {
    loadConsoleHistoryForCurrentSave(getCurrentSaveId()).catch(() => {});
    renderAll();
    try {
      const saved = await loadNarrations(50, getCurrentSaveId());
      const feed  = document.getElementById('feed');
      if (saved.length) {
        feed.innerHTML = '';
        for (const n of saved) {
          const a = renderTurnAnchor(n.turn, n.data?.simTime ?? n.timestamp, n.data?.location ?? '');
          renderNarration(n.description, a, feed, n.turn);
        }
        feed.scrollTop = feed.scrollHeight;
        const history = [];
        for (const n of saved.slice(-3)) {
          history.push({ role:'user',      content:`[turn ${n.turn} context restored]` });
          history.push({ role:'assistant', content:n.description });
        }
        setConversationHistory(history);
        if (!signedIn) setStatus(`Turn ${S.WS.turn} · ${S.WS.player.name}`);
      } else {
        if (!signedIn) setStatus(`Loaded — Turn ${S.WS.turn} · ${S.WS.player.name} (no narrations)`);
      }
    } catch(e) {
      console.warn('[boot] narration restore failed:', e.message);
      if (!signedIn) setStatus(`Loaded — Turn ${S.WS.turn} · ${S.WS.player.name}`);
    }
  } else if (!signedIn) {
    setStatus('Ready. Start a new game or load a save.');
  }
}

// ── MOBILE KEYBOARD FIX ───────────────────────────────────────────────────────
if ('visualViewport' in window) {
  window.visualViewport.addEventListener('resize', () => {
    const _off = Math.max(0, window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop);
    document.getElementById('input-area').style.paddingBottom = Math.max(10, _off) + 'px';
  });
}
document.getElementById('action-input').addEventListener('focus', () => {
  if (window.innerWidth < 768) setTimeout(() => { const _f=document.getElementById('feed'); if(_f) _f.scrollTop=_f.scrollHeight; }, 350);
});

boot();
checkForUpdate();
console.log('🎮 The Sim loaded successfully!');