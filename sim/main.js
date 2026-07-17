// ── MAIN APPLICATION ENTRY POINT ──────────────────────────────────────────
// This file boots up all the game modules and initializes the UI.
// All game logic is in separate modules that get imported here.

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

// ── Split modules ───────────────────────────────────────────────────────────
import S from './gameState.js';
import { _applySimPatch, _resolveNpcPatchKey, _resolveEnrichmentKey,
         _tryParsePatchJson, _extractAndApplyStateChange, validatePatch } from './patch.js';
import { setStatus, setProcessing, renderAll, renderCenterStats,
         renderSchedulePanel, buildCharacterOverview, renderActionLog,
         openCharModal, openNpcModal, runIntegrityCheck,
         showChallengeQueue } from './uiCore.js';
import { initWizard, startNewGame } from './wizard.js';
import { initSettings, initSupabaseAuth, initLoadModal } from './settingsUI.js';
import { initConsoleUI, sendConsoleMessage, loadConsoleHistoryForCurrentSave,
         appendConsoleMsg } from './consoleUI.js';
import { initDevConsole } from './devConsoleUI.js';
import { initImageUpload, loadImageCache, showCameraFlash } from './imageUpload.js';

// ── BOOT: Initialize all UI systems ─────────────────────────────────────────
console.log('🎮 Starting The Sim...');

// Initialize core UI systems
initWizard();
initSettings();
initLoadModal();
initSupabaseAuth();
initConsoleUI();
initDevConsole();
initImageUpload();

// Initialize panel navigation and menu
let currentPanel = 'center';
let _tx = 0, _ty = 0, _tt = 0;
let _panelLock = false;

function showPanel(p) {
  currentPanel = p; _panelLock = true;
  const w = document.getElementById('panels-wrapper');
  w.className = p === 'left' ? 'show-left' : p === 'right' ? 'show-right' : 'show-center';
  setTimeout(() => { _panelLock = false; }, 400);
}

document.querySelectorAll('.panel-back').forEach(btn => {
  btn.addEventListener('click', () => showPanel(btn.dataset.target));
});

document.addEventListener('touchstart', e => { _tx = e.touches[0].clientX; _ty = e.touches[0].clientY; _tt = Date.now(); }, { passive: true });
document.addEventListener('touchend', e => {
  if (_panelLock) return;
  if (document.querySelector('.modal-overlay.open')) return;
  if (document.getElementById('menu-drawer').classList.contains('open')) return;
  const dx = e.changedTouches[0].clientX - _tx;
  const dy = e.changedTouches[0].clientY - _ty;
  if (Math.abs(dy) > Math.abs(dx) * 1.2 || Math.abs(dx) < 50 || Date.now() - _tt > 500) return;
  if (dx < 0) { if (currentPanel === 'left') showPanel('center'); else if (currentPanel === 'center') showPanel('right'); }
  else        { if (currentPanel === 'right') showPanel('center'); else if (currentPanel === 'center') showPanel('left'); }
}, { passive: true });

// Menu
function openMenu()  { document.getElementById('menu-overlay').classList.add('open');    document.getElementById('menu-drawer').classList.add('open'); }
function closeMenu() { document.getElementById('menu-overlay').classList.remove('open'); document.getElementById('menu-drawer').classList.remove('open'); }
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
document.getElementById('modal-char').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('open'); });
document.getElementById('npc-cards').addEventListener('click', e => { const btn = e.target.closest('.npc-detail-btn'); if (btn && S.WS) openNpcModal(btn.dataset.id); });
document.getElementById('btn-npc-close').addEventListener('click', () => document.getElementById('modal-npc').classList.remove('open'));
document.getElementById('modal-npc').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('open'); });

console.log('🎮 The Sim loaded successfully!');
