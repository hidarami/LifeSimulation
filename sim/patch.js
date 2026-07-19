// patch.js — SIM_PATCH validation and application
import S from './gameState.js';
import { saveWorldState, savePatchAuditEntry } from './state.js';
import { createNpc } from './npc.js';

export function _resolveNpcPatchKey(key) {
  if (!S.WS || !key || typeof key !== 'string') return null;
  if (S.WS.npcs[key]) return key;
  const kl = key.toLowerCase().replace(/[\s-]+/g, '_');
  const kFirst = kl.split('_')[0];
  return Object.keys(S.WS.npcs).find(id => {
    const npc = S.WS.npcs[id];
    const nl = (npc.name ?? '').toLowerCase().replace(/[\s-]+/g, '_');
    const nlFirst = nl.split('_')[0];
    return id.toLowerCase() === kl || nl === kl || nlFirst === kFirst || id.split('_')[0] === kFirst;
  }) ?? null;
}

export function _resolveEnrichmentKey(key, npcs) {
  if (!key || typeof key !== 'string') return null;
  const k = key.toLowerCase().replace(/[\s-]+/g, '_');
  const kFirst = k.split('_')[0];
  const FAMILY_TERM_MAP = {
    'mama':'mother','mommy':'mother','nanay':'mother','inay':'mother',
    'papa':'father','daddy':'father','tatay':'father','itay':'father',
    'kuya':'brother','ate':'sister','lola':'grandmother','lolo':'grandfather',
    'tita':'aunt','tito':'uncle','bro':'brother','sis':'sister',
  };
  const mappedRelType = FAMILY_TERM_MAP[kFirst] ?? null;
  return Object.values(npcs).find(n => {
    if (!n.name) return false;
    const nameFirst = n.name.toLowerCase().split(/\s+/)[0];
    const nameFull  = n.name.toLowerCase().replace(/\s+/g, '_');
    const npcId     = (n.id ?? '').toLowerCase();
    const relType   = (n.relationship_type ?? '').toLowerCase();
    return (
      nameFirst === kFirst || nameFull === k || npcId === k ||
      npcId.split('_')[0] === kFirst ||
      (mappedRelType && relType.includes(mappedRelType)) ||
      relType === kFirst
    );
  }) ?? null;
}

export function _tryParsePatchJson(raw) {
  try { return JSON.parse(raw); } catch {}
  const c1 = raw.replace(/```json|```/g, '').trim();
  try { return JSON.parse(c1); } catch {}
  const c2 = c1
    .replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')
    .replace(/,(\s*[}\]])/g, '$1')
    .replace(/:\s*undefined\b/g, ':null');
  try { return JSON.parse(c2); } catch {}
  return null;
}

export function validatePatch(patch, ws) {
  const violations = [];
  const VALID_CLASSES = new Set(['intimate','household','professional','institutional']);
  const INTIMATE_TYPES = ['lover','partner','boyfriend','girlfriend','spouse'];
  const VALID_TRAITS = new Set(['jealousy','honesty','patience','warmth','ambition','impulsivity','dominance','openness']);
  if (patch.npc_updates) {
    for (const [rawId, upd] of Object.entries(patch.npc_updates)) {
      // Guard against non-string keys
      if (typeof rawId !== 'string') {
        violations.push(`NPC key is not a string: ${typeof rawId}`);
        continue;
      }
      const id = _resolveNpcPatchKey(rawId);
      if (!id) { violations.push(`Cannot resolve NPC "${rawId}" — use exact ids from CURRENT GAME STATE`); continue; }
      const npc = ws.npcs[id];
      const newType  = upd.relationship_type ?? npc.relationship_type;
      const newMeter = upd.relationship_meter ?? npc.relationship_meter;
      const newClass = upd.npc_class ?? npc.npc_class;
      if (INTIMATE_TYPES.includes(newType) && newMeter < 20)
        violations.push(`${npc.name}: Cannot set relationship_type "${newType}" with rel_meter=${newMeter} (min 20).`);
      if (newClass && !VALID_CLASSES.has(newClass))
        violations.push(`${npc.name}: npc_class "${newClass}" invalid — use: intimate / household / professional / institutional`);
      // Validate trait names
      if (upd.traits) {
        for (const traitName of Object.keys(upd.traits)) {
          if (!VALID_TRAITS.has(traitName)) {
            violations.push(`${npc.name}: Invalid trait "${traitName}" — valid traits: ${Array.from(VALID_TRAITS).join(', ')}`);
          }
        }
      }
      if (upd.schedule?.weekday_routine) {
        const sorted = [...upd.schedule.weekday_routine].sort((a,b) => a.start_hour - b.start_hour);
        if (!sorted.length || sorted[0].start_hour !== 0 || sorted.at(-1).end_hour !== 24)
          violations.push(`${npc.name}: schedule must cover hours 0–24 continuously`);
      }
      if (upd.relationship_meter != null) {
        const v = Number(upd.relationship_meter);
        if (v < -100 || v > 100) violations.push(`${npc.name}: relationship_meter ${v} out of -100..100`);
      }
    }
  }
  if (patch.player_updates?.stats) {
    for (const [stat, val] of Object.entries(patch.player_updates.stats)) {
      if (typeof val === 'number' && (val < 0 || val > 100))
        violations.push(`Player stat "${stat}": ${val} out of 0..100`);
    }
  }
  return violations;
}

// Note: does NOT call renderAll — callers must call renderAll after applying
export function _applySimPatch(patch) {
  if (!S.WS || !patch) return;
  const patchId = 'P-' + Date.now().toString(36).toUpperCase();
  const _violations = validatePatch(patch, S.WS);
  if (_violations.length) {
    window._devlog?.error(`SIM_PATCH ${patchId} validation failed`, { violations: _violations });
    savePatchAuditEntry(patchId, patch, [], true, _violations).catch(() => {});
    return { rejected: true, violations: _violations };
  }
  S._undoStack.push(JSON.parse(JSON.stringify(S.WS)));
  if (S._undoStack.length > S._UNDO_MAX) S._undoStack.shift();
  window._devlog?.patch(`SIM_PATCH ${patchId} received`, patch);
  const _changed = [];
  try {
    if (patch.npc_updates) {
      for (const [rawId, upd] of Object.entries(patch.npc_updates)) {
        const id = _resolveNpcPatchKey(rawId);
        if (!id) { window._devlog?.error(`SIM_PATCH: Cannot resolve NPC "${rawId}"`, { available: Object.keys(S.WS.npcs) }); continue; }
        if (upd.schedule?.weekday_routine?.length) {
          S.WS.npcs[id].schedule = {
            weekday_routine: upd.schedule.weekday_routine,
            weekend_routine: upd.schedule.weekend_routine ?? S.WS.npcs[id].schedule?.weekend_routine ?? upd.schedule.weekday_routine,
            interruptions:   S.WS.npcs[id].schedule?.interruptions ?? [],
          };
        }
        if (upd.relationship_meter != null) S.WS.npcs[id].relationship_meter = Math.max(-100, Math.min(100, Number(upd.relationship_meter)));
        if (upd.trust_meter       != null) S.WS.npcs[id].trust_meter         = Math.max(-100, Math.min(100, Number(upd.trust_meter)));
        if (upd.traits)            S.WS.npcs[id].traits            = { ...S.WS.npcs[id].traits, ...upd.traits };
        if (upd.active_flags)      S.WS.npcs[id].active_flags      = upd.active_flags;
        if (upd.bio)               S.WS.npcs[id].bio               = upd.bio;
        if (upd.npc_class)         S.WS.npcs[id].npc_class         = upd.npc_class;
        if (upd.relationship_type) S.WS.npcs[id].relationship_type = upd.relationship_type;
        _changed.push(`NPC:${S.WS.npcs[id].name}`);
      }
    }
    if (patch.player_updates) {
      if (patch.player_updates.cash != null) { S.WS.player.cash = Number(patch.player_updates.cash); _changed.push('cash'); }
      if (patch.player_updates.location)      { S.WS.player.location = patch.player_updates.location; _changed.push('location'); }
      if (patch.player_updates.stats && typeof patch.player_updates.stats === 'object') {
        S.WS.player.stats = { ...S.WS.player.stats, ...patch.player_updates.stats };
        _changed.push('stats');
      }
    }
    if ('job_update'    in patch) { S.WS.job    = patch.job_update;    _changed.push('job'); }
    if ('school_update' in patch) { S.WS.school = patch.school_update; _changed.push('school'); }
    if (patch.setting_description) { S.WS.setting_description = patch.setting_description; _changed.push('setting'); }
    if (patch.add_npcs?.length) {
      const _VALID = new Set(['intimate','household','professional','institutional']);
      for (const nd of patch.add_npcs) {
        if (!nd.id || typeof nd.id !== 'string' || nd.id === 'undefined' || nd.id === 'null' || !nd.id.trim()) {
          window._devlog?.error('SIM_PATCH add_npcs: invalid id', { id: nd.id, name: nd.name }); continue;
        }
        if (!nd.name || typeof nd.name !== 'string' || nd.name === 'undefined' || nd.name === 'null' || !nd.name.trim()) {
          window._devlog?.error('SIM_PATCH add_npcs: invalid name', { id: nd.id }); continue;
        }
        if (S.WS.npcs[nd.id]) continue;
        const _cls = _VALID.has(nd.npc_class) ? nd.npc_class : 'household';
        const _pn = createNpc({ id: nd.id, name: nd.name, age: nd.age ?? 20, npc_class: _cls, relationship_type: nd.relationship_type ?? null, traits: nd.traits ?? {} });
        _pn.relationship_meter = nd.relationship_meter ?? 0;
        _pn.trust_meter        = nd.trust_meter        ?? 0;
        _pn.significance       = nd.significance != null ? Math.max(1, Number(nd.significance)) : 2;
        if (nd.bio)                                             _pn.bio         = nd.bio;
        if (nd.active_flags && Array.isArray(nd.active_flags)) _pn.active_flags = nd.active_flags;
        if (nd.schedule?.weekday_routine?.length) {
          _pn.schedule = { weekday_routine: nd.schedule.weekday_routine, weekend_routine: nd.schedule.weekend_routine ?? nd.schedule.weekday_routine, interruptions: [] };
        }
        S.WS.npcs[nd.id] = _pn;
        _changed.push(`add_npc:${nd.name}`);
      }
    }
  if (patch.remove_npcs?.length) {
      for (const rid of patch.remove_npcs) {
        // Guard against non-string, undefined, or null values in remove_npcs array
        if (typeof rid !== 'string' || rid === 'undefined' || rid === 'null' || !rid.trim()) {
          window._devlog?.error(`SIM_PATCH remove_npcs: invalid entry`, { entry: rid });
          continue;
        }
        const id = _resolveNpcPatchKey(rid);
        if (id && S.WS.npcs[id]) { S.WS.npcs[id].status = 'inactive'; _changed.push(`remove_npc:${id}`); }
      }
    }
    if (patch.add_interruptions?.length) {
      for (const { npc_id, interruption } of patch.add_interruptions) {
        const id = _resolveNpcPatchKey(npc_id ?? '');
        if (!id || !S.WS.npcs[id] || !interruption?.start || !interruption?.end) continue;
        S.WS.npcs[id].schedule = S.WS.npcs[id].schedule ?? { weekday_routine: [], weekend_routine: [], interruptions: [] };
        S.WS.npcs[id].schedule.interruptions = S.WS.npcs[id].schedule.interruptions ?? [];
        const _nS = new Date(interruption.start).getTime(), _nE = new Date(interruption.end).getTime();
        const _ok = S.WS.npcs[id].schedule.interruptions.every(ex => {
          const eS = new Date(ex.start).getTime(), eE = new Date(ex.end).getTime();
          return _nE <= eS || _nS >= eE;
        });
        if (_ok) { S.WS.npcs[id].schedule.interruptions.push(interruption); _changed.push(`interruption:${id}`); }
      }
    }
    saveWorldState(S.WS).catch(() => {});
    window._devlog?.patch(`SIM_PATCH ${patchId} applied`, { changed: _changed });
    savePatchAuditEntry(patchId, patch, _changed, false, []).catch(() => {});
    return { rejected: false, patchId };
  } catch(e) {
    window._devlog?.error('SIM_PATCH apply error', { error: e.message });
  }
}

export function _extractAndApplyStateChange(raw) {
  const m = raw.match(/<STATE_CHANGE>\s*([\s\S]*?)\s*<\/STATE_CHANGE>/i);
  if (!m) return false;
  try {
    const cmd = JSON.parse(m[1].trim());
    const patch = {};
    switch (cmd.action) {
      case 'modify_stat': case 'update_player':
        patch.player_updates = {};
        if (cmd.changes?.cash != null)     patch.player_updates.cash     = Number(cmd.changes.cash);
        if (cmd.changes?.location)         patch.player_updates.location = cmd.changes.location;
        if (cmd.changes?.stats && typeof cmd.changes.stats === 'object') patch.player_updates.stats = cmd.changes.stats;
        break;
      case 'update_job':    patch.job_update    = cmd.changes; break;
      case 'clear_job':     patch.job_update    = null;        break;
      case 'update_school': patch.school_update = cmd.changes; break;
      case 'clear_school':  patch.school_update = null;        break;
      case 'update_npc': {
        const _u = {};
        if (cmd.changes?.relationship_meter != null) _u.relationship_meter = cmd.changes.relationship_meter;
        if (cmd.changes?.trust_meter        != null) _u.trust_meter        = cmd.changes.trust_meter;
        if (cmd.changes?.traits)                     _u.traits             = cmd.changes.traits;
        if (cmd.changes?.bio)                        _u.bio                = cmd.changes.bio;
        if (cmd.changes?.status)                     _u.status             = cmd.changes.status;
        if (Object.keys(_u).length) patch.npc_updates = { [cmd.target]: _u };
        break;
      }
    }
    if (Object.keys(patch).length) { _applySimPatch(patch); return true; }
  } catch (e) { window._devlog?.error('STATE_CHANGE parse failed', { error: e.message }); }
  return false;
}