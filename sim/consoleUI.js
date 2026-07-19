// consoleUI.js — AI Meta Console (chat interface + deterministic commands + SIM_ACTION)
import S from './gameState.js';
import { saveWorldState, getCurrentSaveId, saveConsoleMessage, loadConsoleHistory,
         exportNpc, exportWorldSummary, exportLorebook, exportPatchAuditLog,
         exportClassifierHistory, loadNarrations, loadPlayerActions } from './state.js';
import { callMetaConsole, buildWorldWithMultipleAIs, enrichWorldDetails,
         compressLorebook } from './api.js';
import { detectProvider, getProviderDisplayName, dispatchChat as _providerDispatchChat } from './providers.js';
import { createNpc, getNpcCurrentTask } from './npc.js';
import { renderAll, setStatus, runIntegrityCheck } from './uiCore.js';
import { _applySimPatch, _resolveNpcPatchKey, _resolveEnrichmentKey,
         _tryParsePatchJson, _extractAndApplyStateChange, validatePatch } from './patch.js';

let _consoleMessages = [];
let _consoleSaveId   = null;
let _consoleSending  = false;
let _consoleHistory  = [];
let _consoleCursorIdx = -1;

// ── MARKDOWN RENDERER ──────────────────────────────────────────────────────────
function renderMarkdown(text) {
  let s = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  s = s.replace(/```([\s\S]*?)```/g, '<pre style="background:var(--bg);padding:8px;border-radius:4px;font-size:11px;overflow-x:auto;margin:6px 0;border:1px solid var(--bdr)"><code>$1</code></pre>');
  s = s.replace(/`([^`]+)`/g, '<code style="background:var(--bg);padding:1px 5px;border-radius:3px;font-size:12px;border:1px solid var(--bdr)">$1</code>');
  s = s.replace(/^### (.+)$/gm, '<div style="font-size:12px;font-weight:700;color:var(--acc);margin:10px 0 4px;text-transform:uppercase;letter-spacing:.06em">$1</div>');
  s = s.replace(/^## (.+)$/gm,  '<div style="font-size:13px;font-weight:700;color:var(--txt);margin:10px 0 4px">$1</div>');
  s = s.replace(/^# (.+)$/gm,   '<div style="font-size:14px;font-weight:700;color:var(--txt);margin:10px 0 5px">$1</div>');
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
  s = s.replace(/^[-*] (.+)$/gm, '<li style="margin:2px 0;padding-left:4px">$1</li>');
  s = s.replace(/(<li[^>]*>[\s\S]*?<\/li>\n?)+/g, '<ul style="margin:6px 0;padding-left:18px;list-style:disc">$&</ul>');
  s = s.replace(/^---+$/gm, '<hr style="border:none;border-top:1px solid var(--bdr);margin:10px 0">');
  s = s.replace(/\n\n+/g, '</p><p style="margin:6px 0">');
  s = s.replace(/\n/g, '<br>');
  return '<p style="margin:0">' + s + '</p>';
}

function _consoleBubble(role, content) {
  const ts  = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const el  = document.createElement('div'); el.className = `console-msg ${role}`;
  const body = role === 'assistant' ? renderMarkdown(content) : content.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
  el.innerHTML = `<div class="console-bubble">${body}</div><div class="console-ts">${ts}</div>`;
  return el;
}

export function appendConsoleMsg(role, content, persist = false) {
  const feed  = document.getElementById('console-feed');
  const empty = document.getElementById('console-empty');
  if (empty) empty.style.display = 'none';
  const el = _consoleBubble(role, content);
  feed.appendChild(el);
  feed.scrollTop = feed.scrollHeight;
  if (persist && _consoleSaveId !== null) saveConsoleMessage(_consoleSaveId, role, content).catch(() => {});
}

function showConsoleThinking() {
  const feed  = document.getElementById('console-feed');
  const empty = document.getElementById('console-empty');
  if (empty) empty.style.display = 'none';
  const el = document.createElement('div'); el.id = 'console-thinking-el'; el.className = 'console-msg assistant';
  el.innerHTML = '<div class="console-thinking"><div class="btn-dot"></div><div class="btn-dot"></div><div class="btn-dot"></div></div>';
  feed.appendChild(el); feed.scrollTop = feed.scrollHeight;
}
function removeConsoleThinking() { document.getElementById('console-thinking-el')?.remove(); }

export async function loadConsoleHistoryForCurrentSave(saveId) {
  _consoleSaveId = saveId ?? null; _consoleMessages = [];
  const feed = document.getElementById('console-feed'); if (!feed) return;
  feed.innerHTML = '';
  const emptyEl = document.createElement('div'); emptyEl.id = 'console-empty';
  emptyEl.style.cssText = 'flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:var(--dim);text-align:center;padding:40px';
  emptyEl.innerHTML = '<div class="ce-icon">⌘</div><div class="ce-text" style="text-align:left;max-width:340px;font-size:11px;line-height:1.9;opacity:1"><strong style="color:var(--acc);display:block;margin-bottom:8px;font-size:12px;letter-spacing:.06em">AI CONSOLE</strong><span style="font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:.1em">Live Data (no AI):</span><br><span style="color:var(--txt)">show npcs &nbsp;·&nbsp; show npc [name] &nbsp;·&nbsp; show world</span><br><span style="color:var(--txt)">show errors &nbsp;·&nbsp; show logs [cat] &nbsp;·&nbsp; show model</span><br><span style="color:var(--txt)">show patches &nbsp;·&nbsp; check &nbsp;·&nbsp; undo</span><br><br><span style="font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:.1em">Engine Actions (no AI):</span><br><span style="color:var(--txt)">generate npcs &nbsp;·&nbsp; regenerate bio [name]</span><br><span style="color:var(--txt)">rerun enrichment &nbsp;·&nbsp; reparse lorebook</span><br><br><span style="font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:.1em">Ask Anything:</span><br><span style="color:var(--dim)">Other questions go to AI. Type <strong>help</strong> for this list.</span></div>';
  feed.appendChild(emptyEl);
  if (saveId === null || saveId === undefined) return;
  try {
    const history = await loadConsoleHistory(saveId); if (!history.length) return;
    emptyEl.style.display = 'none';
    for (const msg of history) {
      _consoleMessages.push({ role: msg.role, content: msg.content });
      const ts = new Date(msg.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      const el = document.createElement('div'); el.className = `console-msg ${msg.role}`;
      const safe = msg.content.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
      el.innerHTML = `<div class="console-bubble">${safe}</div><div class="console-ts">${ts}</div>`;
      feed.appendChild(el);
    }
    feed.scrollTop = feed.scrollHeight;
  } catch(e) { console.warn('[console] history load failed:', e.message); }
}

// ── SIM_ACTION DISPATCHER ──────────────────────────────────────────────────────
async function _dispatchSimAction(action, args) {
  if (!S.WS) return { ok: false, summary: 'No game loaded.' };
  try {
    switch (action) {
      case 'generate_npcs': {
        const _lb = localStorage.getItem('LOREBOOK') ?? '';
        if (!_lb.trim()) return { ok: false, summary: 'No lorebook set.' };
        const _parsed = await buildWorldWithMultipleAIs(_lb);
        if (!_parsed?.npcs?.length) return { ok: false, summary: 'Lorebook parsing returned no NPCs.' };
        const _created = [], _skipped = [];
        for (const nd of _parsed.npcs) {
          if (!nd.id || !nd.name) continue;
          if (S.WS.npcs[nd.id] || Object.values(S.WS.npcs).some(n => n.name?.toLowerCase() === nd.name.toLowerCase())) { _skipped.push(nd.name); continue; }
          const _n = createNpc({ id: nd.id, name: nd.name, age: nd.age || 25, npc_class: nd.npc_class || 'household', relationship_type: nd.relationship_type || null, traits: nd.traits || {} });
          _n.relationship_meter = Math.max(-100, Math.min(100, Number(nd.relationship_meter) || 0));
          _n.trust_meter        = Math.max(-100, Math.min(100, Number(nd.trust_meter)        || 0));
          _n.significance = 2; _n.recent_interactions = nd.note ? [nd.note] : [`Created via SIM_ACTION — turn ${S.WS.turn}`];
          S.WS.npcs[nd.id] = _n; _created.push(nd.name);
        }
        if (_created.length) {
          const _enr = await enrichWorldDetails(_lb, S.WS).catch(() => null);
          if (_enr?.npc_descriptions) for (const [k, bio] of Object.entries(_enr.npc_descriptions)) { const _m = _resolveEnrichmentKey(k, S.WS.npcs); if (_m && S.WS.npcs[_m.id] && bio) S.WS.npcs[_m.id].bio = bio; }
          if (_enr?.npc_schedules)     for (const [k, sc]  of Object.entries(_enr.npc_schedules))     { if (!sc?.weekday_routine?.length) continue; const _m = _resolveEnrichmentKey(k, S.WS.npcs); if (_m && S.WS.npcs[_m.id]) S.WS.npcs[_m.id].schedule = { weekday_routine: sc.weekday_routine, weekend_routine: sc.weekend_routine ?? sc.weekday_routine, interruptions: [] }; }
        }
        await saveWorldState(S.WS); renderAll();
        return { ok: true, summary: `Created (${_created.length}): ${_created.join(', ') || 'none'}. Already existed (${_skipped.length}): ${_skipped.join(', ') || 'none'}.` };
      }
      case 'regenerate_bio': {
        const _id = args.npc_id ? _resolveNpcPatchKey(String(args.npc_id)) : null;
        if (!_id || !S.WS.npcs[_id]) return { ok: false, summary: `NPC not found: "${args.npc_id}".` };
        const _npc = S.WS.npcs[_id], _lb = localStorage.getItem('LOREBOOK') ?? '';
        const _key  = localStorage.getItem('GROQ_API_KEY') || localStorage.getItem('CLASSIFIER_KEY') || localStorage.getItem('NARRATOR_KEY') || '';
        const _prov = localStorage.getItem('GROQ_API_KEY') ? 'groq' : (detectProvider(localStorage.getItem('CLASSIFIER_KEY') ?? '') || detectProvider(localStorage.getItem('NARRATOR_KEY') ?? '') || null);
        const _mdl  = localStorage.getItem('GROQ_API_KEY') ? 'llama-3.1-8b-instant' : null;
        if (!_key || !_prov) return { ok: false, summary: 'No API key available.' };
        const _pr = `Write a 2-3 sentence bio for: ${_npc.name}, age ${_npc.age}, ${(_npc.relationship_type ?? _npc.npc_class ?? '').replace(/_/g,' ')}. Lorebook: "${_lb.slice(0,400)}". Cover: appearance, a specific habit, their role in the player's life. Reply with ONLY the bio text.`;
        const _bio = await _providerDispatchChat(_prov, _key, _mdl, [{ role: 'user', content: _pr }], 150, 10000);
        if (_bio?.trim()) { S.WS.npcs[_id].bio = _bio.trim(); await saveWorldState(S.WS); renderAll(); return { ok: true, summary: `Bio updated for ${_npc.name}: "${_bio.trim().slice(0,100)}..."` }; }
        return { ok: false, summary: 'Bio generation returned empty.' };
      }
      case 'rerun_enrichment': {
        const _lb = localStorage.getItem('LOREBOOK') ?? '';
        const _enr = await enrichWorldDetails(_lb, S.WS);
        if (!_enr) return { ok: false, summary: 'Enrichment returned no data.' };
        const _ch = [];
        if (_enr.setting_description) { S.WS.setting_description = _enr.setting_description; _ch.push('setting'); }
        if (_enr.npc_descriptions) for (const [k, bio] of Object.entries(_enr.npc_descriptions)) { const _m = _resolveEnrichmentKey(k, S.WS.npcs); if (_m && S.WS.npcs[_m.id] && bio) { S.WS.npcs[_m.id].bio = bio; _ch.push(`${_m.name}.bio`); } }
        if (_enr.npc_schedules)     for (const [k, sc]  of Object.entries(_enr.npc_schedules))     { if (!sc?.weekday_routine?.length) continue; const _m = _resolveEnrichmentKey(k, S.WS.npcs); if (_m && S.WS.npcs[_m.id]) { S.WS.npcs[_m.id].schedule = { weekday_routine: sc.weekday_routine, weekend_routine: sc.weekend_routine ?? sc.weekday_routine, interruptions: S.WS.npcs[_m.id].schedule?.interruptions ?? [] }; _ch.push(`${_m.name}.schedule`); } }
        await saveWorldState(S.WS); renderAll();
        return { ok: true, summary: `Updated: ${_ch.join(', ') || 'nothing new'}` };
      }
      case 'reparse_lorebook': {
        const _lb = localStorage.getItem('LOREBOOK') ?? '';
        if (!_lb.trim()) return { ok: false, summary: 'No lorebook set.' };
        const _parsed = await buildWorldWithMultipleAIs(_lb);
        if (!_parsed?.npcs?.length) return { ok: false, summary: 'Lorebook parsing returned no NPCs.' };
        const _added = [], _skipped = [];
        for (const nd of _parsed.npcs) {
          if (!nd.id || !nd.name) continue;
          if (S.WS.npcs[nd.id] || Object.values(S.WS.npcs).some(n => n.name?.toLowerCase() === nd.name.toLowerCase())) { _skipped.push(nd.name); continue; }
          const _n = createNpc({ id: nd.id, name: nd.name, age: nd.age || 25, npc_class: nd.npc_class || 'household', relationship_type: nd.relationship_type || null, traits: nd.traits || {} });
          _n.relationship_meter = Math.max(-100, Math.min(100, Number(nd.relationship_meter) || 0));
          _n.trust_meter = Math.max(-100, Math.min(100, Number(nd.trust_meter) || 0));
          _n.significance = 2; S.WS.npcs[nd.id] = _n; _added.push(nd.name);
        }
        await saveWorldState(S.WS); renderAll();
        return { ok: true, summary: `Added: ${_added.join(', ') || 'none'}. Already existed: ${_skipped.join(', ') || 'none'}.` };
      }
      case 'generate_items': {
        const _cur = S.WS.player?.possessions ?? [];
        if (_cur.length >= 4) return { ok: false, summary: `Player already has ${_cur.length} possessions.` };
        const _lb = localStorage.getItem('LOREBOOK') ?? '', _locale = localStorage.getItem('LOCALE') || 'Philippines';
        const _key = localStorage.getItem('GROQ_API_KEY') || localStorage.getItem('CLASSIFIER_KEY') || localStorage.getItem('NARRATOR_KEY') || '';
        const _prov = localStorage.getItem('GROQ_API_KEY') ? 'groq' : (detectProvider(localStorage.getItem('CLASSIFIER_KEY') ?? '') || detectProvider(localStorage.getItem('NARRATOR_KEY') ?? '') || null);
        const _mdl = localStorage.getItem('GROQ_API_KEY') ? 'llama-3.1-8b-instant' : null;
        if (!_key || !_prov) return { ok: false, summary: 'No API key available.' };
        const _pr = `Generate 6-8 realistic starting possessions for: ${S.WS.player?.name}, age ${S.WS.player?.age}, ${_locale}. Lorebook: "${_lb.slice(0,500)}". Return ONLY a JSON array: [{"name":"item","condition":"state","note":"purpose","acquired_method":"bought|gifted|inherited|found"}]. Must include a phone, bag, clothing item, hygiene item.`;
        const _raw = await _providerDispatchChat(_prov, _key, _mdl, [{ role: 'user', content: _pr }], 600, 15000);
        const _newPoss = JSON.parse(_raw.replace(/```json\s*/gi,'').replace(/```\s*/g,'').trim());
        if (Array.isArray(_newPoss) && _newPoss.length) {
          const _seen = new Set(_cur.map(p => (p.name ?? '').toLowerCase()));
          const _toAdd = _newPoss.filter(p => p.name && !_seen.has(p.name.toLowerCase())).map(p => ({ ...p, durability: 90 }));
          S.WS.player.possessions = [..._cur, ..._toAdd];
          await saveWorldState(S.WS); renderAll();
          return { ok: true, summary: `Added ${_toAdd.length} items: ${_toAdd.map(p => p.name).join(', ')}` };
        }
        return { ok: false, summary: 'Item generation returned no valid items.' };
      }
      case 'repair_schedules': {
        const _bad = Object.values(S.WS.npcs).filter(n => { if (n.status !== 'active') return false; const r = n.schedule?.weekday_routine ?? []; if (!r.length) return true; const s = [...r].sort((a,b) => a.start_hour - b.start_hour); return s[0].start_hour !== 0 || s.at(-1).end_hour !== 24; });
        if (!_bad.length) return { ok: true, summary: 'All schedules valid. No repair needed.' };
        const _DEF = [{start_hour:0,end_hour:6,task:'sleeping',interruptible:false,location:'home'},{start_hour:6,end_hour:8,task:'morning_prep',interruptible:false,location:'home'},{start_hour:8,end_hour:12,task:'errands',interruptible:true,location:'outside'},{start_hour:12,end_hour:18,task:'leisure',interruptible:true,location:'home'},{start_hour:18,end_hour:21,task:'leisure',interruptible:true,location:'home'},{start_hour:21,end_hour:24,task:'winding_down',interruptible:true,location:'home'}];
        const _patch = { npc_updates: {} };
        for (const n of _bad) _patch.npc_updates[n.id] = { schedule: { weekday_routine: _DEF, weekend_routine: _DEF } };
        _applySimPatch(_patch); renderAll();
        return { ok: true, summary: `Repaired ${_bad.length} schedules: ${_bad.map(n => n.name).join(', ')}.` };
      }
      case 'read_narrations': {
        const _rows = await loadNarrations(Math.min(args.limit ?? 5, 20), getCurrentSaveId());
        if (!_rows.length) return { ok: true, type: 'content', content: 'No narrations found.' };
        return { ok: true, type: 'content', content: _rows.map(r => `**Turn ${r.turn}** (${r.data?.location ?? '?'}): ${r.description.slice(0,250)}`).join('\n\n') };
      }
      case 'read_actions': {
        const _rows = await loadPlayerActions(Math.min(args.limit ?? 10, 30), getCurrentSaveId());
        if (!_rows.length) return { ok: true, type: 'content', content: 'No actions found.' };
        return { ok: true, type: 'content', content: _rows.map(r => `Turn ${r.turn}: "${r.input}"`).join('\n') };
      }
      default:
        return { ok: false, summary: `Unknown action: "${action}".` };
    }
  } catch (e) {
    window._devlog?.error(`SIM_ACTION ${action} failed`, { error: e.message });
    return { ok: false, summary: `Action failed: ${e.message}` };
  }
}

// ── SEND CONSOLE MESSAGE (main dispatcher) ─────────────────────────────────────
export async function sendConsoleMessage() {
  if (_consoleSending) return;
  const inp     = document.getElementById('console-input');
  const content = inp.value.trim(); if (!content) return;
  inp.value = ''; inp.style.height = 'auto';
  if (content && _consoleHistory.at(-1) !== content) _consoleHistory.push(content);
  if (_consoleHistory.length > 50) _consoleHistory.shift();
  _consoleCursorIdx = -1;
  window._devlog?.console_log('Console request', { msg: content.slice(0,100) });

  // ── /state shortcut ────────────────────────────────────────────────────────
  if (content.toLowerCase() === '/state' || content.toLowerCase() === 'state') {
    const _cur = localStorage.getItem('CURRENCY_SYMBOL') || '₱';
    const _snap = S.WS ? [
      `━━ WORLD STATE — Turn ${S.WS.turn} ━━`,
      `${S.WS.player?.name} · ${_cur}${(S.WS.player?.cash??0).toLocaleString()} · ${S.WS.player?.location??'?'}`,
      `Stats: ${Object.entries(S.WS.player?.stats??{}).map(([k,v])=>`${k}:${Math.round(v)}`).join(' | ')}`,
      `Job: ${S.WS.job?(S.WS.job.position??'Worker')+' @ '+(S.WS.job.employer??'?'):'Unemployed'} | School: ${S.WS.school?.name??'None'}`,
      `NPCs (${Object.values(S.WS.npcs??{}).filter(n=>n.status==='active').length}): ${Object.values(S.WS.npcs??{}).filter(n=>n.status==='active').map(n=>`${n.name}[${n.relationship_meter>0?'+':''}${n.relationship_meter}]`).join(', ')||'none'}`,
      `Issues: ${(S.WS.challenges??[]).filter(c=>c.active&&!c.resolved).map(c=>c.title).join(', ')||'none'}`,
    ].join('\n') : 'No game loaded.';
    appendConsoleMsg('user', '/state');
    appendConsoleMsg('assistant', _snap, false);
    return;
  }

  // ── undo ───────────────────────────────────────────────────────────────────
  const _undoMatch = content.match(/^\s*undo(?:\s+(\d+))?\s*$/i);
  if (_undoMatch) {
    appendConsoleMsg('user', content);
    const steps = Math.min(parseInt(_undoMatch[1] ?? '1', 10) || 1, S._undoStack.length);
    if (steps > 0 && S.WS) {
      let _t = null; for (let i = 0; i < steps; i++) _t = S._undoStack.pop();
      S.WS = _t; await saveWorldState(S.WS).catch(() => {}); renderAll();
      appendConsoleMsg('assistant', `↩ Went back ${steps} step${steps > 1 ? 's' : ''} — ${S._undoStack.length} undo${S._undoStack.length !== 1 ? 's' : ''} remaining.`, false);
    } else { appendConsoleMsg('assistant', 'Nothing to undo.', false); }
    return;
  }

  // ── preview patch ──────────────────────────────────────────────────────────
  const _previewMatch = content.match(/^\s*(?:preview|dry.?run|test)\s+patch\s*:?\s*([\s\S]+)/i);
  if (_previewMatch) {
    appendConsoleMsg('user', content);
    if (!S.WS) { appendConsoleMsg('assistant', 'No game loaded.', false); return; }
    const _pv = _tryParsePatchJson(_previewMatch[1].trim());
    if (!_pv) { appendConsoleMsg('assistant', '⚠ Could not parse JSON.', false); return; }
    const _viol = validatePatch(_pv, S.WS);
    let rep = `**SIM_PATCH Preview — Dry Run (not applied)**\n\n`;
    if (_viol.length) { rep += `**❌ Would REJECT (${_viol.length}):**\n` + _viol.map(v => '- ' + v).join('\n'); }
    else {
      rep += '**✓ Validation passes.**\n\nWould modify: ';
      const _f = [];
      if (_pv.npc_updates) _f.push(`NPCs: ${Object.keys(_pv.npc_updates).join(', ')}`);
      if (_pv.player_updates) _f.push(`Player: ${Object.keys(_pv.player_updates).join(', ')}`);
      if ('job_update' in _pv) _f.push('job'); if ('school_update' in _pv) _f.push('school');
      if (_pv.add_npcs?.length) _f.push(`add_npcs: ${_pv.add_npcs.map(n=>n.name).join(', ')}`);
      rep += _f.join(' | ') || '(empty patch)';
    }
    appendConsoleMsg('assistant', rep + '\n\n*Source: validatePatch() — no AI*', false);
    return;
  }

  // ── explain last turn ──────────────────────────────────────────────────────
  if (/^\s*(?:explain|breakdown|last\s+turn\s+explain)\s*(?:last\s+turn)?\s*$/i.test(content)) {
    appendConsoleMsg('user', content);
    if (!S.WS) { appendConsoleMsg('assistant', 'No game loaded.', false); return; }
    try {
      const [_ltClass, _ltNarr, _ltAction] = await Promise.all([exportClassifierHistory(1, getCurrentSaveId()), loadNarrations(1, getCurrentSaveId()), loadPlayerActions(1, getCurrentSaveId())]);
      const _cls = _ltClass[0]?.data ?? null, _ltN = _ltNarr[0], _ltA = _ltAction[0];
      let rep = `**Last Turn Breakdown — Turn ${S.WS.turn}**\n\n`;
      if (_ltA) rep += `**Player Action:** "${_ltA.input}"\n\n`;
      if (_cls) {
        rep += `**Gemini Classification:**\n- Type: \`${_cls.action_type}\` · Time: \`${_cls.time_cost_hours}\`h · Risk: \`${_cls.risk_class}\`\n`;
        const _dlt = _cls.stat_deltas ?? {};
        if (Object.keys(_dlt).length) rep += `- Stat deltas: ${Object.entries(_dlt).map(([k,v]) => `${k}${v>=0?'+':''}${v}`).join(' | ')}\n`;
        if (_cls.npc_ids_involved?.length) rep += `- NPCs involved: ${_cls.npc_ids_involved.join(', ')}\n`;
        if (_cls.alcohol_consumed?.detected) rep += `- Alcohol: ${_cls.alcohol_consumed.drink_type} ×${_cls.alcohol_consumed.quantity}\n`;
      } else { rep += '*No classifier data.*\n'; }
      const _errs = (window._devlog?.entries ?? []).filter(e => e.cat === 'ERROR').slice(-3);
      if (_errs.length) rep += `\n**Recent Errors:**\n${_errs.map(e => `- ${e.msg}`).join('\n')}\n`;
      if (_ltN) rep += `\n**Narration preview:**\n> ${_ltN.description.slice(0,300)}...\n`;
      appendConsoleMsg('assistant', rep + '\n*Source: IndexedDB — no AI*', false);
    } catch (e) { appendConsoleMsg('assistant', `⚠ ${e.message}`, false); }
    return;
  }

  // ── show undo stack ────────────────────────────────────────────────────────
  if (/^\s*(?:show|list)\s+undo\s*(?:stack|history)?\s*$/i.test(content)) {
    appendConsoleMsg('user', content);
    if (!S._undoStack.length) { appendConsoleMsg('assistant', 'Undo stack is empty.', false); }
    else { appendConsoleMsg('assistant', `**Undo Stack (${S._undoStack.length} of ${S._UNDO_MAX} max):**\n\n${S._undoStack.slice().reverse().map((s, i) => `- Undo ${i+1}: Turn ${s?.turn ?? '?'} state`).join('\n')}\n\nType \`undo\` or \`undo N\` to step back.`, false); }
    return;
  }

  // ── show npc [name] ────────────────────────────────────────────────────────
  const _npcMatch = content.match(/^\s*(?:show|read|inspect|get)\s+npc\s+(.+)/i);
  if (_npcMatch) {
    const _query = _npcMatch[1].trim();
    const _rid = _resolveNpcPatchKey(_query);
    window._devlog?.console_log('Command detected', { command: 'show_npc', target: _query });
    appendConsoleMsg('user', content);
    if (_rid && S.WS) {
      const _d = exportNpc(S.WS, _rid); const _t = getNpcCurrentTask(S.WS.npcs[_rid], S.WS.sim_time);
      appendConsoleMsg('assistant', `**${_d.name}** [id: ${_d.id}]\n\n**Age:** ${_d.age} · **Class:** ${_d.npc_class} · **Type:** ${_d.relationship_type}\n\n**Relationship:** ${_d.relationship_meter} · **Trust:** ${_d.trust_meter}\n\n**Right Now:** ${_t.task.replace(/_/g,' ')} at ${_t.location} (${_t.available ? 'available' : 'not available'})\n\n**Bio:** ${_d.bio}\n\n**Flags:** ${_d.active_flags.length ? _d.active_flags.join(', ') : 'none'}\n\n**Traits:** ${Object.entries(_d.traits ?? {}).map(([k,v])=>`${k}:${v}`).join(' · ')}\n\n**Recent:** ${_d.recent_interactions.slice(-3).join(' | ') || 'none'}\n\n*Source: live engine data*`, false);
    } else { appendConsoleMsg('assistant', `No NPC found matching "${_query}".\n\nAvailable ids: ${S.WS ? Object.keys(S.WS.npcs).join(', ') : 'none'}`, false); }
    return;
  }

  // ── show world ─────────────────────────────────────────────────────────────
  if (/^\s*(?:show|read|dump)\s+(?:world|state|game)\s*$/i.test(content)) {
    appendConsoleMsg('user', content);
    if (!S.WS) { appendConsoleMsg('assistant', 'No game loaded.', false); return; }
    appendConsoleMsg('assistant', '**World State — Live Data**\n\n```\n' + JSON.stringify(exportWorldSummary(S.WS), null, 2) + '\n```\n\n*Source: live engine data*', false);
    return;
  }

  // ── show lorebook ──────────────────────────────────────────────────────────
  if (/^\s*(?:show|read)\s+lorebook\s*$/i.test(content)) {
    appendConsoleMsg('user', content);
    const _lb = exportLorebook();
    appendConsoleMsg('assistant', _lb ? '**Lorebook:**\n\n' + _lb + '\n\n*Source: localStorage LOREBOOK*' : 'No lorebook set.', false);
    return;
  }

  // ── show npcs ──────────────────────────────────────────────────────────────
  if (/^\s*(?:show|list)\s+npcs?\s*$/i.test(content)) {
    appendConsoleMsg('user', content);
    if (!S.WS) { appendConsoleMsg('assistant', 'No game loaded.', false); return; }
    const _active = Object.values(S.WS.npcs).filter(n => n.status === 'active');
    const _inactive = Object.values(S.WS.npcs).filter(n => n.status !== 'active');
    let rep = `**Active NPCs (${_active.length}):**\n\n`;
    for (const n of _active) rep += `- **${n.name}** [${n.id}] · ${n.relationship_type} · rel:${n.relationship_meter} trust:${n.trust_meter} · bio:${n.bio ? '✓' : '✗'}\n`;
    if (_inactive.length) rep += `\n**Inactive (${_inactive.length}):** ${_inactive.map(n=>n.name).join(', ')}`;
    appendConsoleMsg('assistant', rep + '\n\n*Source: live engine data*', false);
    return;
  }

  // ── check / integrity ──────────────────────────────────────────────────────
  if (/^\s*(?:check|integrity|verify|scan)\s*$/i.test(content)) {
    appendConsoleMsg('user', content);
    if (!S.WS) { appendConsoleMsg('assistant', 'No game loaded.', false); return; }
    const _ir = runIntegrityCheck(S.WS);
    let rep = '**Integrity Check — Deterministic Engine Rules**\n\n*Source: engine rules, no AI*\n\n';
    if (_ir.failed.length) rep += `**❌ FAILED (${_ir.failed.length}):**\n` + _ir.failed.map(f => '- ' + f).join('\n') + '\n\n';
    if (_ir.warnings.length) rep += `**⚠ WARNINGS (${_ir.warnings.length}):**\n` + _ir.warnings.map(w => '- ' + w).join('\n') + '\n\n';
    if (!_ir.failed.length && !_ir.warnings.length) rep += '**✓ All rules passed.**';
    appendConsoleMsg('assistant', rep, false);
    return;
  }

  // ── show patches ───────────────────────────────────────────────────────────
  if (/^\s*(?:show|list)\s+patches?\s*$/i.test(content)) {
    appendConsoleMsg('user', content);
    const _pl = await exportPatchAuditLog(20, getCurrentSaveId());
    if (!_pl.length) { appendConsoleMsg('assistant', 'No patches applied yet.', false); return; }
    let rep = `**Patch Audit Log (last ${_pl.length})**\n\n`;
    for (const e of _pl) { const _pts = new Date(e.timestamp).toLocaleTimeString(); const _icon = e.data.rejected ? '❌' : '✓'; rep += `${_icon} **${e.data.patchId}** · ${_pts}\n  ${e.description}\n`; }
    appendConsoleMsg('assistant', rep + '\n*Source: events table*', false);
    return;
  }

  // ── show errors ────────────────────────────────────────────────────────────
  if (/^\s*show\s+errors?\s*(?:log)?\s*$/i.test(content)) {
    appendConsoleMsg('user', content);
    const _errs = (window._devlog?.entries ?? []).filter(e => e.cat === 'ERROR').slice(-10);
    if (!_errs.length) { appendConsoleMsg('assistant', '✓ No errors in devlog.\n\n*Source: live _devlog.entries*', false); return; }
    appendConsoleMsg('assistant', `**Last ${_errs.length} Errors:**\n\n${_errs.map(e => `[${new Date(e.ts).toLocaleTimeString()}] **${e.msg}**${e.data ? '\n  ' + JSON.stringify(e.data).slice(0,140) : ''}`).join('\n\n')}\n\n*Source: live _devlog.entries*`, false);
    return;
  }

  // ── show api calls ─────────────────────────────────────────────────────────
  if (/^\s*show\s+api\s*(?:calls?)?\s*$/i.test(content)) {
    appendConsoleMsg('user', content);
    const _apis = (window._devlog?.entries ?? []).filter(e => e.cat === 'API').slice(-10);
    if (!_apis.length) { appendConsoleMsg('assistant', 'No API calls logged yet.', false); return; }
    appendConsoleMsg('assistant', `**Last ${_apis.length} API Calls:**\n\n${_apis.map(e => { const d = e.data ?? {}; const info = [d.provider, d.model, d.elapsed_ms != null ? d.elapsed_ms + 'ms' : null, d.chars ? d.chars + ' chars' : null].filter(Boolean).join(' · '); return `[${new Date(e.ts).toLocaleTimeString()}] ${e.msg}${info ? ' — ' + info : ''}`; }).join('\n')}\n\n*Source: live _devlog.entries*`, false);
    return;
  }

  // ── show recent ────────────────────────────────────────────────────────────
  if (/^\s*show\s+(?:recent|activity)\s*$/i.test(content)) {
    appendConsoleMsg('user', content);
    const _recent = (window._devlog?.entries ?? []).slice(-15).reverse();
    if (!_recent.length) { appendConsoleMsg('assistant', 'No devlog entries yet.', false); return; }
    appendConsoleMsg('assistant', `**Last ${_recent.length} entries:**\n\n${_recent.map(e => `[${new Date(e.ts).toLocaleTimeString()}] **${e.cat}** ${e.msg}`).join('\n')}\n\n*Source: live _devlog.entries*`, false);
    return;
  }

  // ── show logs [category] ───────────────────────────────────────────────────
  const _showLogsMatch = content.match(/^\s*show\s+logs?\s+(\w+)\s*$/i);
  if (_showLogsMatch) {
    const _logCat = _showLogsMatch[1].toUpperCase();
    appendConsoleMsg('user', content);
    const _VALID = new Set(['ERROR','API','ROUTE','TURN','NPC','STAT','PATCH','SYSTEM','CONSOLE']);
    if (!_VALID.has(_logCat)) { appendConsoleMsg('assistant', `Unknown category "${_logCat}". Valid: ERROR, API, ROUTE, TURN, NPC, STAT, PATCH, SYSTEM, CONSOLE`, false); return; }
    const _entries = (window._devlog?.entries ?? []).filter(e => e.cat === _logCat).slice(-10);
    if (!_entries.length) { appendConsoleMsg('assistant', `No ${_logCat} entries.`, false); return; }
    appendConsoleMsg('assistant', `**${_logCat} log (last ${_entries.length}):**\n\n${_entries.map(e => `[${new Date(e.ts).toLocaleTimeString()}] ${e.msg}${e.data ? ' — ' + JSON.stringify(e.data).slice(0,110) : ''}`).join('\n')}\n\n*Source: live _devlog.entries*`, false);
    return;
  }

  // ── show model ─────────────────────────────────────────────────────────────
  if (/^\s*(?:show\s+model|what\s+model|which\s+model|what\s+ai)\s*$/i.test(content)) {
    appendConsoleMsg('user', content);
    const _nk = localStorage.getItem('NARRATOR_KEY') || localStorage.getItem('GROK_API_KEY') || '';
    const _ck = localStorage.getItem('CLASSIFIER_KEY') || localStorage.getItem('GEMINI_API_KEY') || '';
    const _ek = localStorage.getItem('ENRICHER_KEY') || '';
    const _hk = localStorage.getItem('GROQ_API_KEY') || '';
    const _np = localStorage.getItem('NARRATOR_PROVIDER') || detectProvider(_nk) || '?';
    const _cp = localStorage.getItem('CLASSIFIER_PROVIDER') || detectProvider(_ck) || '?';
    const _ep = _ek ? (localStorage.getItem('ENRICHER_PROVIDER') || detectProvider(_ek) || '?') : null;
    appendConsoleMsg('assistant', `**Active AI Slot Configuration:**\n\n**Narrator:** ${getProviderDisplayName(_np)} / ${localStorage.getItem('NARRATOR_MODEL') || '(provider default)'}\n**Classifier:** ${getProviderDisplayName(_cp)} / ${localStorage.getItem('CLASSIFIER_MODEL') || '(provider default)'}\n**Helper:** ${_hk ? 'Groq / llama-3.1-8b-instant' : 'fallback to classifier slot'}\n**Enricher:** ${_ek ? getProviderDisplayName(_ep) + ' / ' + (localStorage.getItem('ENRICHER_MODEL') || 'provider default') : 'fallback to classifier slot'}\n\n*Source: localStorage*`, false);
    return;
  }

  // ── show providers ─────────────────────────────────────────────────────────
  if (/^\s*(?:show|list|check)\s+providers?\s*(?:status|config|slots?)?\s*$/i.test(content)) {
    appendConsoleMsg('user', content);
    const _mask = k => k ? k.slice(0,6) + '...' + k.slice(-4) : '— not set —';
    const _nk = localStorage.getItem('NARRATOR_KEY') || localStorage.getItem('GROK_API_KEY') || '';
    const _ck = localStorage.getItem('CLASSIFIER_KEY') || localStorage.getItem('GEMINI_API_KEY') || '';
    const _hk = localStorage.getItem('GROQ_API_KEY') || '';
    const _ek = localStorage.getItem('ENRICHER_KEY') || '';
    const _np = localStorage.getItem('NARRATOR_PROVIDER')   || detectProvider(_nk) || '?';
    const _cp = localStorage.getItem('CLASSIFIER_PROVIDER') || detectProvider(_ck) || '?';
    const _ep = _ek ? (localStorage.getItem('ENRICHER_PROVIDER') || detectProvider(_ek) || '?') : (_cp + ' (fallback)');
    const _fbSlots = (() => { try { return JSON.parse(localStorage.getItem('FALLBACK_SLOTS') ?? '[]').filter(s => s.enabled && s.key); } catch { return []; } })();
    let rep = `**Active API Slot Configuration:**\n\n**Narrator** — ${getProviderDisplayName(_np)}\n  Key: ${_mask(_nk)}\n  Model: ${localStorage.getItem('NARRATOR_MODEL') || '(provider default)'}\n\n**Classifier** — ${getProviderDisplayName(_cp)}\n  Key: ${_mask(_ck)}\n  Model: ${localStorage.getItem('CLASSIFIER_MODEL') || '(provider default)'}\n\n**Helper** — ${_hk ? 'Groq / llama-3.1-8b-instant' : '(classifier fallback)'}\n  Key: ${_mask(_hk || _ck)}\n\n**Enricher** — ${getProviderDisplayName(_ep)}\n  Key: ${_mask(_ek || _ck)}\n  Model: ${localStorage.getItem('ENRICHER_MODEL') || '(provider default)'}\n\n`;
    if (_fbSlots.length) rep += `**Fallback Slots (${_fbSlots.length} enabled):**\n` + _fbSlots.map(s => `  Slot ${s.slot}: ${s.provider || detectProvider(s.key) || '?'} → ${(s.roles ?? []).join(', ') || 'none'}`).join('\n') + '\n\n';
    const _health = !_nk && !_ck ? '❌ No keys set' : !_nk ? '⚠ Narrator key missing' : !_ck ? '⚠ Classifier key missing' : '✓ Required slots configured';
    rep += `**Health:** ${_health}\n\n*Source: localStorage — no AI*`;
    appendConsoleMsg('assistant', rep, false);
    return;
  }

  // ── show items ─────────────────────────────────────────────────────────────
  if (/^\s*(?:show|list)\s+(?:items?|possessions?|inventory)\s*$/i.test(content)) {
    appendConsoleMsg('user', content);
    if (!S.WS) { appendConsoleMsg('assistant', 'No game loaded.', false); return; }
    const poss = S.WS.player?.possessions ?? [], irrev = S.WS.player?.irreversible ?? [];
    let rep = `**Player Inventory — ${S.WS.player?.name}:**\n\n`;
    if (!poss.length) { rep += '❌ **No possessions registered.**\n\n> Run `generate items` to create them.\n\n'; }
    else { rep += `**Possessions (${poss.length}):**\n` + poss.map(p => { const _d = p.durability != null ? ` [${Math.round(p.durability)}%]` : ''; return `- **${p.name}** (${p.condition ?? 'used'})${_d}${p.note && p.note !== p.condition ? ' — ' + p.note : ''}`; }).join('\n') + '\n\n'; }
    if (irrev.length) rep += `**Permanent (${irrev.length}):**\n${irrev.map(i => `- ${i}`).join('\n')}\n\n`;
    appendConsoleMsg('assistant', rep + '*Source: live engine data*', false);
    return;
  }

  // ── show init log ──────────────────────────────────────────────────────────
  if (/^\s*(?:show|get|read|dump)\s+(?:init(?:ialization)?|startup|pipeline|enrich(?:ment)?\s+log)\s*$/i.test(content)) {
    appendConsoleMsg('user', content);
    const _all = window._devlog?.entries ?? [];
    const _initEntries = _all.filter(e => ['SYSTEM','API','ERROR'].includes(e.cat));
    if (!_initEntries.length) { appendConsoleMsg('assistant', 'No initialization log found.\n\n*Source: live _devlog.entries*', false); return; }
    const _errs = _initEntries.filter(e => e.cat === 'ERROR');
    const _sys  = _initEntries.filter(e => e.cat === 'SYSTEM');
    const _apis = _initEntries.filter(e => e.cat === 'API').slice(-20);
    let rep = `**Initialization & Enrichment Log:**\n\n`;
    if (_errs.length) { rep += `**❌ ERRORS (${_errs.length}):**\n${_errs.map(e => `  [${new Date(e.ts).toLocaleTimeString()}] ${e.msg}${e.data ? '\n    ' + JSON.stringify(e.data).slice(0,200) : ''}`).join('\n')}\n\n`; } else rep += '**✓ No errors.**\n\n';
    if (_sys.length) rep += `**System Events (${_sys.length}):**\n${_sys.map(e => `  ${e.msg}`).join('\n')}\n\n`;
    if (_apis.length) rep += `**API Calls (${_apis.length}):**\n${_apis.map(e => `  ${e.msg}`).join('\n')}\n\n`;
    appendConsoleMsg('assistant', rep + '*Source: live _devlog.entries*', false);
    return;
  }

  // ── help ───────────────────────────────────────────────────────────────────
  if (/^\s*(?:help|commands?|what\s+can\s+you\s+do)\s*$/i.test(content)) {
    appendConsoleMsg('user', content);
    appendConsoleMsg('assistant',
      '**SIM CONSOLE — Commands**\n\n**LIVE DATA (no AI):**\n- `show npcs` — all active NPCs\n- `show npc [name]` — full NPC data\n- `show world` — world state snapshot\n- `show lorebook` — lorebook text\n- `show items` / `show possessions` — player inventory\n- `show providers` — API slot config\n- `show init` — enrichment & startup log\n- `show patches` — patch audit log\n- `show errors` — recent errors\n- `show logs [category]` — filter devlog\n- `show api calls` — recent API calls\n- `show recent` — last 15 devlog entries\n- `show model` — active AI slot config\n- `check` — engine rule validation\n- `explain last turn` — last turn breakdown\n- `preview patch: {...}` — dry-run a patch\n- `undo` / `undo N` — reverse patches\n\n**ENGINE ACTIONS (no AI):**\n- `generate npcs` — create NPCs from lorebook\n- `regenerate bio [name]` — rebuild NPC bio\n- `generate items` — create player inventory\n- `fix schedules` — repair broken NPC schedules\n- `rerun enrichment` — re-run world enrichment\n- `reparse lorebook` — parse lorebook again\n\n**ASK ANYTHING:**\nAll other input goes to AI with full game context.\n\n*Source: deterministic engine — no AI*', false);
    return;
  }

  // ── pending reparse confirmation ───────────────────────────────────────────
  if (window._consolePendingReparse) {
    window._consolePendingReparse = false;
    appendConsoleMsg('user', content);
    if (/^\s*yes\s*$/i.test(content)) {
      appendConsoleMsg('assistant', '⏳ Reparsing lorebook...', false);
      try {
        const _res = await _dispatchSimAction('reparse_lorebook', {});
        appendConsoleMsg('assistant', `**Reparse Complete**\n\n${_res.summary}\n\n*Source: Engine action — buildWorldWithMultipleAIs*`, false);
      } catch(e) { appendConsoleMsg('assistant', `⚠ Reparse failed: ${e.message}`, false); }
    } else { appendConsoleMsg('assistant', '↩ Reparse cancelled.', false); }
    return;
  }

  // ── engine commands ────────────────────────────────────────────────────────
  if (/^\s*(?:generate\s+npcs?|create\s+npcs?\s+from\s+lorebook)\s*$/i.test(content)) {
    appendConsoleMsg('user', content);
    if (!S.WS) { appendConsoleMsg('assistant', 'No game loaded.', false); return; }
    if (!(localStorage.getItem('LOREBOOK') ?? '').trim()) { appendConsoleMsg('assistant', 'No lorebook set.', false); return; }
    appendConsoleMsg('assistant', '⏳ Parsing lorebook and creating NPCs...', false);
    try {
      const _res = await _dispatchSimAction('generate_npcs', {});
      appendConsoleMsg('assistant', `**NPC Generation Complete**\n\n${_res.summary}\n\n*Source: Engine action*`, false);
    } catch(e) { appendConsoleMsg('assistant', `⚠ ${e.message}`, false); }
    return;
  }

  const _reBioMatch = content.match(/^\s*(?:regenerate|update|rebuild|fix)\s+bio\s*(.*)$/i);
  if (_reBioMatch) {
    const _q = (_reBioMatch[1] ?? '').trim();
    appendConsoleMsg('user', content);
    if (!_q) { appendConsoleMsg('assistant', 'Usage: `regenerate bio [name]`', false); return; }
    if (!S.WS) { appendConsoleMsg('assistant', 'No game loaded.', false); return; }
    appendConsoleMsg('assistant', `⏳ Generating bio for ${_q}...`, false);
    try {
      const _res = await _dispatchSimAction('regenerate_bio', { npc_id: _q });
      appendConsoleMsg('assistant', `**${_res.ok ? '✓' : '⚠'} ${_res.summary}**\n\n*Source: Engine action*`, false);
    } catch(e) { appendConsoleMsg('assistant', `⚠ ${e.message}`, false); }
    return;
  }

  if (/^\s*(?:rerun\s+enrichment|fix\s+world|reenrich)\s*$/i.test(content)) {
    appendConsoleMsg('user', content);
    if (!S.WS) { appendConsoleMsg('assistant', 'No game loaded.', false); return; }
    appendConsoleMsg('assistant', '⏳ Running world enrichment...', false);
    try {
      const _res = await _dispatchSimAction('rerun_enrichment', {});
      appendConsoleMsg('assistant', `**Enrichment Complete**\n\n${_res.summary}\n\n*Source: Engine action*`, false);
    } catch(e) { appendConsoleMsg('assistant', `⚠ ${e.message}`, false); }
    return;
  }

  if (/^\s*reparse\s+lorebook\s*$/i.test(content)) {
    appendConsoleMsg('user', content);
    if (!S.WS) { appendConsoleMsg('assistant', 'No game loaded.', false); return; }
    if (!(localStorage.getItem('LOREBOOK') ?? '').trim()) { appendConsoleMsg('assistant', 'No lorebook set.', false); return; }
    appendConsoleMsg('assistant', `⚠ This will add missing NPCs from lorebook. Existing ${Object.keys(S.WS.npcs).length} NPCs will not be modified.\n\nReply **yes** to continue.`, false);
    window._consolePendingReparse = true;
    return;
  }

  if (/^\s*(?:fix|repair|rebuild)\s+schedules?\s*$/i.test(content)) {
    appendConsoleMsg('user', content);
    if (!S.WS) { appendConsoleMsg('assistant', 'No game loaded.', false); return; }
    const _res = await _dispatchSimAction('repair_schedules', {});
    appendConsoleMsg('assistant', `${_res.ok ? '✓' : '⚠'} ${_res.summary}\n\n*Source: Engine action*`, false);
    return;
  }

  if (/^\s*(?:generate|create|add)\s+(?:items?|possessions?|inventory)\s*$/i.test(content)) {
    appendConsoleMsg('user', content);
    if (!S.WS) { appendConsoleMsg('assistant', 'No game loaded.', false); return; }
    appendConsoleMsg('assistant', '⏳ Generating possessions...', false);
    try {
      const _res = await _dispatchSimAction('generate_items', {});
      appendConsoleMsg('assistant', `${_res.ok ? '✓' : '⚠'} ${_res.summary}\n\n*Source: Engine action*`, false);
    } catch(e) { appendConsoleMsg('assistant', `⚠ ${e.message}`, false); }
    return;
  }

  // ── AI fallback ────────────────────────────────────────────────────────────
  window._devlog?.console_log('Routing to AI', { reason: 'no deterministic command matched' });
  let _diagSuffix = '';
  const _diagTrigger = /\b(?:why|what\s+went\s+wrong|fail|error|debug|diagnos|no\s+npc|missing|not\s+work|no\s+item|no\s+possession|no\s+schedule|init|startup|generation|enrich|which\s+(?:model|ai)|provider|who\s+handles)\b/i.test(content);
  if (_diagTrigger) {
    const _diag = (window._devlog?.entries ?? []).filter(e => ['ERROR','API','SYSTEM','PATCH'].includes(e.cat)).slice(-35);
    if (_diag.length) {
      _diagSuffix = '\n\n[ENGINE LOG — use as primary evidence]:\n' + _diag.map(e => `[${new Date(e.ts).toLocaleTimeString()}][${e.cat}] ${e.msg}${e.data ? ' → ' + JSON.stringify(e.data).slice(0,160) : ''}`).join('\n');
    }
  }
  _consoleSending = true;
  document.getElementById('console-submit').disabled = true;
  _consoleMessages.push({ role: 'user', content: content + _diagSuffix });
  appendConsoleMsg('user', content, true);
  showConsoleThinking();
  try {
    const _t0 = Date.now();
    let reply = await callMetaConsole(_consoleMessages.slice(-24), S.WS ?? null);
    removeConsoleThinking();
    window._devlog?.console_log('AI responded', { elapsed_ms: Date.now()-_t0, chars: reply.length });
    const _extractAndApplyPatch = (raw) => {
      const m = raw.match(/<SIM_PATCH>\s*([\s\S]*?)\s*<\/SIM_PATCH>/i); if (!m) return false;
      const parsed = _tryParsePatchJson(m[1].trim()); if (!parsed) return false;
      return _applySimPatch(parsed);
    };
    let _patchApplied = _extractAndApplyPatch(reply);
    if (_patchApplied?.rejected) { reply += '\n\n❌ **Patch rejected:**\n' + _patchApplied.violations.map(v => '- ' + v).join('\n'); _patchApplied = false; }
    if (!_patchApplied && /<STATE_CHANGE>/i.test(reply)) _patchApplied = _extractAndApplyStateChange(reply);
    // SIM_ACTION dispatch
    const _sams = [...reply.matchAll(/<SIM_ACTION>\s*([\s\S]*?)\s*<\/SIM_ACTION>/gi)];
    const _actionSummaries = [];
    let _actionCount = 0;
    for (const _sam of _sams) {
      if (_actionCount >= 2) { _actionSummaries.push('⚠ Action limit (max 2). Send follow-up to run more.'); break; }
      try {
        const _spec = JSON.parse(_sam[1].trim()); if (!_spec.action) continue;
        showConsoleThinking();
        const _result = await _dispatchSimAction(_spec.action, _spec.args ?? {});
        removeConsoleThinking(); _actionCount++;
        if (_result.type === 'content') {
          try { const _sum = await callMetaConsole([..._consoleMessages.slice(-12), { role: 'user', content: `[SIM_ACTION ${_spec.action} result]\n${_result.content}\n\nSummarize for the user in 2-4 sentences.` }], S.WS ?? null); _actionSummaries.push(`**${_spec.action}:**\n${_sum.replace(/<SIM_PATCH>[\s\S]*?<\/SIM_PATCH>/gi,'').replace(/<SIM_ACTION>[\s\S]*?<\/SIM_ACTION>/gi,'').trim()}`); }
          catch { _actionSummaries.push(`**${_spec.action}:**\n${_result.content.slice(0,500)}`); }
        } else { _actionSummaries.push(`${_result.ok ? '✓' : '⚠'} **${_spec.action}:** ${_result.summary}`); }
      } catch (e) { removeConsoleThinking(); _actionSummaries.push(`⚠ SIM_ACTION error: ${e.message}`); }
    }
    reply = reply.replace(/<SIM_PATCH>[\s\S]*?<\/SIM_PATCH>/gi,'').replace(/<STATE_CHANGE>[\s\S]*?<\/STATE_CHANGE>/gi,'').replace(/<SIM_ACTION>[\s\S]*?<\/SIM_ACTION>/gi,'').trim();
    if (_actionSummaries.length) reply = (reply ? reply + '\n\n' : '') + '---\n' + _actionSummaries.join('\n\n');
    // Second pass if reply claims change but no patch found
    const _userLast = _consoleMessages.filter(m => m.role === 'user').at(-1)?.content ?? '';
    const _isChangeReq = /\b(give|set|change|update|add|remove|make|fix|adjust|modify|increase|decrease|boost|reset|delete|clear)\b/i.test(_userLast);
    const _replyAcks = /\b(i['']ve|i have|updated?|changed?|applied|modified|done|set|added|removed)\b/i.test(reply);
    if (!_patchApplied && S.WS) {
      if (_isChangeReq && _replyAcks) {
        try {
          // Add 10-second timeout for second-pass patch generation
          const _p2Promise = callMetaConsole([..._consoleMessages.slice(-18), { role: 'assistant', content: reply }, { role: 'user', content: '(SYSTEM) Output the <SIM_PATCH> JSON block now to commit your changes. Output ONLY the opening tag, the JSON object, and the closing tag.' }], S.WS);
          const _timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000));
          const _p2 = await Promise.race([_p2Promise, _timeoutPromise]);
          const _p2Result = _extractAndApplyPatch(_p2);
          if (_p2Result && !_p2Result?.rejected) _patchApplied = _p2Result;
          else if (_p2Result?.rejected) {
            // AI acknowledged but patch was rejected - show the violations
            reply += '\n\n⚠ **Patch was rejected:**\n' + _p2Result.violations.map(v => '- ' + v).join('\n');
          }
        } catch (e) {
          // AI failed to output valid patch - tell user what went wrong
          if (e.message === 'timeout') {
            reply += '\n\n⚠ **Patch generation timed out** (10s). The AI did not output a valid <SIM_PATCH> block. Use `preview patch: {...}` to test your changes manually.';
          } else {
            reply += '\n\n⚠ **Failed to apply changes:** The AI did not output a valid <SIM_PATCH> block. Try rephrasing your request or use `preview patch: {...}` to test your changes.';
          }
        }
      }
    }
    // FIX: Provide clear feedback when patch was expected but not applied
    if (!_patchApplied && _isChangeReq && _replyAcks) {
      reply += '\n\n⚠ **No <SIM_PATCH> was output.** The AI acknowledged your request but did not provide the required JSON block. Changes were NOT applied. Try rephrasing or use `preview patch: {...}` to test your patch first.';
    }
    if (_patchApplied?.patchId) reply += `\n\n✓ Changes applied — **Patch ${_patchApplied.patchId}** · type "show patches" to audit`;
    else if (_patchApplied) reply += '\n\n✓ Changes applied to game world.';
    reply += '\n\n---\n*Source: AI inference — for live data use: `show npc [name]`, `show world`, `check`*';
    _consoleMessages.push({ role: 'assistant', content: reply });
    appendConsoleMsg('assistant', reply, true);
    if (_patchApplied && !_patchApplied?.rejected) renderAll();
  } catch(err) {
    removeConsoleThinking();
    appendConsoleMsg('assistant', `⚠ ${err.message}`, false);
  } finally {
    _consoleSending = false;
    document.getElementById('console-submit').disabled = false;
    document.getElementById('console-input').focus();
  }
}

// ── CONSOLE UI INIT ────────────────────────────────────────────────────────────
export function initConsoleUI(closeMenuFn) {
  document.getElementById('btn-console').addEventListener('click', () => {
    document.getElementById('panel-console').classList.add('open');
    setTimeout(() => document.getElementById('console-input').focus(), 80);
    closeMenuFn();
  });
  document.getElementById('btn-console-close').addEventListener('click', () => document.getElementById('panel-console').classList.remove('open'));
  document.getElementById('console-submit').addEventListener('click', sendConsoleMessage);
  document.getElementById('btn-console-export-md')?.addEventListener('click', () => {
    if (!_consoleMessages.length) { setStatus('Nothing to export.'); return; }
    const lines = _consoleMessages.map(m => { const role = m.role === 'user' ? '**YOU**' : '**AI CONSOLE**'; const body = m.content.replace(/\*\*/g,'').replace(/<[^>]+>/g,'').replace(/---\n\*Source:.*$/m,'').trim(); return `${role}\n\n${body}`; });
    const txt = `# AI Console Conversation\nExported: ${new Date().toLocaleString()}\n\n---\n\n` + lines.join('\n\n---\n\n');
    const a = document.createElement('a'); a.href = 'data:text/markdown;charset=utf-8,' + encodeURIComponent(txt); a.download = `console-${new Date().toISOString().replace(/[:.]/g,'-')}.md`; document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setStatus('Console conversation downloaded.');
  });
  document.getElementById('console-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _consoleCursorIdx = -1; sendConsoleMessage(); return; }
    if (e.key === 'ArrowUp' && _consoleHistory.length) { e.preventDefault(); _consoleCursorIdx = Math.min(_consoleCursorIdx + 1, _consoleHistory.length - 1); e.target.value = _consoleHistory[_consoleHistory.length - 1 - _consoleCursorIdx] ?? ''; setTimeout(() => e.target.setSelectionRange(e.target.value.length, e.target.value.length), 0); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); if (_consoleCursorIdx <= 0) { _consoleCursorIdx = -1; e.target.value = ''; return; } _consoleCursorIdx--; e.target.value = _consoleHistory[_consoleHistory.length - 1 - _consoleCursorIdx] ?? ''; setTimeout(() => e.target.setSelectionRange(e.target.value.length, e.target.value.length), 0); }
  });
  document.getElementById('console-input').addEventListener('input', function() { this.style.height = 'auto'; this.style.height = Math.min(this.scrollHeight, 130) + 'px'; });
}