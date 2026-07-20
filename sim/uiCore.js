// uiCore.js — core UI: status, stats, renderAll, schedule, modals, challenges
import S from './gameState.js';
import { formatTimestamp, computeCharacterEmotions } from './engine.js';
import { renderNpcPanel, renderJobPanel, renderPossessionsPanel,
         renderChallengesPanel, getSmartNpcLabel, livesWithPlayer } from './renderer.js';
import { getNpcCurrentTask } from './npc.js';
import { loadPlayerActions, getCurrentSaveId, saveWorldState, updateFame } from './state.js';

// ── STATUS / PROCESSING ────────────────────────────────────────────────────────
export function setStatus(msg, type = '') {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = type === 'err' ? 's-err' : type === 'load' ? 's-load' : '';
}

export function setProcessing(on) {
  const btn = document.getElementById('submit-btn');
  const bar = document.getElementById('processing-bar');
  const inp = document.getElementById('action-input');
  if (on) {
    btn.innerHTML = '<div class="btn-dots"><div class="btn-dot"></div><div class="btn-dot"></div><div class="btn-dot"></div></div>';
    btn.classList.add('processing'); btn.disabled = true; inp.disabled = true; bar.classList.add('active');
  } else {
    btn.textContent = 'ACT'; btn.classList.remove('processing'); btn.disabled = false; inp.disabled = false; bar.classList.remove('active');
  }
}

// ── CENTER STATS ──────────────────────────────────────────────────────────────
const CSTAT_META = {
  health:     { label: 'Health',  icon: '♥',  invert: false },
  energy:     { label: 'Energy',  icon: '⚡', invert: false },
  hunger:     { label: 'Satiety', icon: '🍽', invert: true  },
  hygiene:    { label: 'Hygiene', icon: '◈',  invert: false },
  mood:       { label: 'Mood',    icon: '◉',  invert: false },
  arousal:    { label: 'Arousal', icon: '◈',  invert: false },
  social:     { label: 'Social',  icon: '◎',  invert: false },
  reputation: { label: 'Rep',     icon: '★',  invert: false },
  alcohol:    { label: 'Alcohol', icon: '🍺', invert: false },
};
function cstatColor(v) {
  return v <= 20 ? 'sc-crit' : v <= 40 ? 'sc-low' : v >= 80 ? 'sc-high' : 'sc-norm';
}
export function renderCenterStats(stats) {
  const c = document.getElementById('center-stats');
  if (!c || !stats) return;
  c.innerHTML = '';
  for (const [key, meta] of Object.entries(CSTAT_META)) {
    if (!(key in stats)) continue;
    if (key === 'arousal' && stats[key] === 0) continue;
    if (key === 'alcohol' && (stats[key] ?? 0) < 5) continue;
    const val  = Math.round(stats[key]);
    const fill = meta.invert ? 100 - val : val;
    const disp = meta.invert ? (100 - val) : val;
    const _prevRaw = S._prevStats?.[key];
    const _prevDisp = _prevRaw != null ? (meta.invert ? 100 - Math.round(_prevRaw) : Math.round(_prevRaw)) : null;
    const _delta = _prevDisp !== null ? disp - _prevDisp : 0;
    const _dHtml = _delta !== 0
      ? `<span class="cstat-delta ${_delta > 0 ? 'cdelta-pos' : 'cdelta-neg'}">${_delta > 0 ? '+' : ''}${_delta}</span>`
      : '';
    const row  = document.createElement('div');
    row.className = 'cstat-row';
    row.innerHTML = `<span class="cstat-icon">${meta.icon}</span><span class="cstat-label">${meta.label}</span><div class="cstat-track"><div class="cstat-fill ${cstatColor(fill)}" style="width:${fill}%"></div></div><span class="cstat-val">${disp}${_dHtml}</span>`;
    c.appendChild(row);
  }
}

// ── SCHEDULE PANEL ────────────────────────────────────────────────────────────
export function renderSchedulePanel(job, school, container) {
  if (!container) return;
  container.innerHTML = '';
  const isBad = v => !v || v === 'null' || v === 'undefined';
  const blocks = [];
  if (school) {
    const st = school.status ?? 'active';
    let html = `<div class="sch-block"><div class="sch-type-label">Education</div>`;
    if (school.name) html += `<div class="sch-name">${school.name}</div>`;
    if (school.grade_level) html += `<div class="sch-sub">${school.grade_level}</div>`;
    if (st === 'active') {
      if (!isBad(school.schedule)) html += `<div class="sch-row"><span class="sch-key">Hours</span><span class="sch-val">${school.schedule}</span></div>`;
      if (school.absence_count) html += `<div class="sch-row"><span class="sch-key">Absences</span><span class="sch-val" style="color:var(--low)">${school.absence_count}</span></div>`;
      html += `<span class="sch-pill active">Enrolled</span>`;
    } else if (st === 'graduated') { html += `<span class="sch-pill grad">✓ Graduated</span>`;
    } else if (st === 'dropped_out') { html += `<span class="sch-pill out">Dropped out</span>`;
    } else if (st === 'vacation' || st === 'break') { html += `<span class="sch-pill" style="background:#1a2a3a;color:#70a0d0">On break</span>`; }
    html += `</div>`;
    blocks.push(html);
  }
  if (job) {
    const employer = isBad(job.employer) ? 'Freelance / Self-employed' : job.employer;
    let html = `<div class="sch-block"><div class="sch-type-label">Work</div><div class="sch-name">${employer}</div>`;
    if (!isBad(job.position)) html += `<div class="sch-sub">${job.position}</div>`;
    if (job.description) html += `<div class="sch-sub" style="margin-top:4px;line-height:1.5">${job.description}</div>`;
    if (!isBad(job.schedule)) html += `<div class="sch-row"><span class="sch-key">Hours</span><span class="sch-val">${job.schedule}</span></div>`;
    const pay = job.earnings_note ?? (job.salary_per_cycle ? `${localStorage.getItem('CURRENCY_SYMBOL')||'₱'}${job.salary_per_cycle.toLocaleString()}/${job.pay_cycle ?? 'cycle'}` : null);
    if (pay) html += `<div class="sch-row"><span class="sch-key">Pay</span><span class="sch-val" style="color:var(--norm)">${pay}</span></div>`;
    html += `<div class="sch-row"><span class="sch-key">Days</span><span class="sch-val">${job.days_employed ?? 0}</span></div>`;
    const pf = (job.performance_flags ?? []).map(f => `<span class="sch-pflag">${f}</span>`).join('');
    if (pf) html += `<div style="margin-top:5px">${pf}</div>`;
    html += `</div>`;
    blocks.push(html);
  }
  if (!blocks.length) { container.innerHTML = '<p class="empty">No current schedule.</p>'; return; }
  container.innerHTML = blocks.join('');
}

// ── CHARACTER OVERVIEW ────────────────────────────────────────────────────────
export function buildCharacterOverview(ws) {
  if (!ws?.player) return '';
  const { player, consequences, npcs, sim_time } = ws;
  const _use24h = localStorage.getItem('TIME_FORMAT_24H') === '1';
  const _td = new Date(sim_time);
  const _time = _td.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: !_use24h });
  const _day  = _td.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const emotions = computeCharacterEmotions(player.stats, consequences ?? [], Object.values(npcs ?? {}));
  const emoLabel = emotions[0]?.label ?? '';
  const loc = (player.location ?? 'somewhere').replace(/_/g, ' ');
  const nearby = Object.values(npcs ?? {})
    .filter(n => n.status === 'active' && n.significance >= 2)
    .slice(0, 2)
    .map(n => n.name);
  const _cur = localStorage.getItem('CURRENCY_SYMBOL') || '₱';
  const _activeChallenges = (ws.challenges ?? []).filter(c => c.active && !c.resolved);
  let text = `${_day}, ${_time}. At ${loc}.`;
  if (emoLabel && !['Fine','Neutral'].includes(emoLabel)) text += ` ${emoLabel}.`;
  if (_activeChallenges.length === 1) text += ` Issue: ${_activeChallenges[0].title}.`;
  else if (_activeChallenges.length > 1) text += ` ${_activeChallenges.length} active issues.`;
  else if (consequences?.length) text += ` ${consequences[0].type.replace(/_/g,' ')}.`;
  if (player.cash < 150 && !_activeChallenges.some(c => c.type === 'financial')) {
    text += ` Low cash (${_cur}${player.cash}).`;
  }
  if (ws.school?.status === 'suspended') text += ` Suspended from school.`;
  else if (ws.school?.status === 'active' && (ws.school.absence_count ?? 0) >= 4) {
    text += ` ${ws.school.absence_count} absences.`;
  }
  if (nearby.length) {
    text += ' ' + (nearby.length === 1 ? `${nearby[0]} nearby.` : `${nearby.join(' & ')} nearby.`);
  }
  return text;
}

// ── RENDER ALL ────────────────────────────────────────────────────────────────
export function renderAll() {
  if (!S.WS) return;
  renderCenterStats(S.WS.player.stats);
  const overviewEl = document.getElementById('char-overview');
  if (overviewEl) {
    const ovTxt = buildCharacterOverview(S.WS);
    overviewEl.textContent = ovTxt;
    overviewEl.classList.toggle('visible', !!ovTxt);
  }
  const charStatusEl = document.getElementById('char-status');
  if (charStatusEl && S.WS?.player?.stats) {
    const NEG = new Set(['Starving','Hungry','Sick','Unwell','Exhausted','Tired','Grimy','Depressed','Down','Isolated','Ill','Stressed','Tense','Embarrassed','Panicked']);
    const POS = new Set(['Upbeat','Connected','Happy','Grateful','Elated']);
    const BLANK = new Set(['Fine','Neutral']);
    const emotions = computeCharacterEmotions(S.WS.player.stats, S.WS.consequences ?? [], Object.values(S.WS.npcs ?? {}));
    charStatusEl.innerHTML = emotions.map(em => {
      const cls = NEG.has(em.label) ? 'neg' : POS.has(em.label) ? 'pos' : BLANK.has(em.label) ? '' : 'warn';
      return `<span class="emotion-badge ${cls}">${em.label}<span class="emotion-cause">${em.cause}</span></span>`;
    }).join('');
  }
  renderNpcPanel(S.WS.npcs, document.getElementById('npc-cards'), S.WS.sim_time, S.WS.player.name, S.WS.player.location ?? 'home', S._prevNpcMeters ?? {});
  renderJobPanel(S.WS.job, S.WS.school ?? null, document.getElementById('p-job'));
  renderPossessionsPanel(S.WS.player.possessions, S.WS.player.irreversible, document.getElementById('p-items'));
  renderChallengesPanel(S.WS.challenges, S.WS.debts ?? [], S.WS.fame ?? null, document.getElementById('p-challenges'));
  renderSchedulePanel(S.WS.job, S.WS.school ?? null, document.getElementById('p-schedule'));
  const _use24h = localStorage.getItem('TIME_FORMAT_24H') === '1';
  const _td = new Date(S.WS.sim_time);
  const _timeStr = _td.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: !_use24h });
  const _dayStr  = _td.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  document.getElementById('h-time').innerHTML = `${_timeStr}<br><span style="font-size:10px">${_dayStr}</span>`;
  document.getElementById('h-cash').textContent = `${localStorage.getItem('CURRENCY_SYMBOL')||'₱'}${S.WS.player.cash.toLocaleString()}`;
  const nm = S.WS.player.name || '—';
  document.getElementById('char-name').textContent = nm;
  const _avEl = document.getElementById('char-avatar');
  const _cachedImg = S._imageCache['player'];
  if (_cachedImg) {
    _avEl.style.backgroundImage = `url(${_cachedImg})`;
    _avEl.textContent = ''; _avEl.style.color = 'transparent';
  } else {
    _avEl.style.backgroundImage = '';
    _avEl.textContent = nm.charAt(0).toUpperCase(); _avEl.style.color = '';
  }
  const _existFame = document.getElementById('h-fame-badge');
  if (_existFame) _existFame.remove();
  if (S.WS.fame?.level >= 1) {
    const _fb = document.createElement('span');
    _fb.id = 'h-fame-badge';
    _fb.className = `fame-header-badge fame-${S.WS.fame.label}`;
    _fb.title = `${(S.WS.fame.followers ?? 0).toLocaleString()} followers`;
    const _ficons = { local:'🌟', regional:'⭐', national:'🏆', celebrity:'👑' };
    _fb.textContent = `${_ficons[S.WS.fame.label] ?? '🌟'} ${S.WS.fame.label}`;
    document.getElementById('char-info').appendChild(_fb);
    document.getElementById('char-header').closest('body')?.classList.toggle('celebrity-mode', S.WS.fame.level >= 4);
  }
}

// ── ACTION LOG ────────────────────────────────────────────────────────────────
export async function renderActionLog(showPanelFn) {
  const c = document.getElementById('p-log');
  if (!c) return;
  c.innerHTML = '';
  try {
    const actions = await loadPlayerActions(100, getCurrentSaveId());
    if (!actions.length) { c.innerHTML = '<p class="empty">No actions yet.</p>'; return; }
    for (const a of actions) {
      const el = document.createElement('div');
      el.className = 'log-entry';
      const preview = a.input.length > 55 ? a.input.slice(0, 55) + '…' : a.input;
      const row = document.createElement('div');
      row.className = 'log-entry-row';
      row.innerHTML = `<span class="log-turn">T${a.turn}</span><span class="log-text" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px">${preview.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</span><button class="log-jump" title="Jump to response">→</button>`;
      const full = document.createElement('div');
      full.className = 'log-full-text'; full.textContent = a.input;
      row.querySelector('.log-jump').addEventListener('click', e => {
        e.stopPropagation();
        if (showPanelFn) showPanelFn('center');
        setTimeout(() => {
          const t = document.querySelector(`.narration-entry[data-turn="${a.turn}"]`);
          if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 350);
      });
      row.addEventListener('click', e => { if (e.target.classList.contains('log-jump')) return; el.classList.toggle('open'); });
      el.appendChild(row); el.appendChild(full); c.appendChild(el);
    }
  } catch { c.innerHTML = '<p class="empty">Log unavailable.</p>'; }
}

// ── CHARACTER SHEET MODAL ──────────────────────────────────────────────────────
export function openCharModal() {
  if (!S.WS) return;
  const p = S.WS.player;
  const rows = [
    ['Name', p.name || '—'], ['Age', p.age ?? '—'], ['Sex', p.sex || '—'],
    ['Born', p.birthday ? `~${p.birthday}` : '—'], ['Location', p.location || '—'],
    ['Cash', `${localStorage.getItem('CURRENCY_SYMBOL')||'₱'}${(p.cash || 0).toLocaleString()}`],
  ];
  document.getElementById('modal-char-body').innerHTML = `
    <div id="modal-char-avatar-lg">${(p.name||'?').charAt(0).toUpperCase()}</div>
    <div class="section-hdr">Identity</div>
    ${rows.map(([k,v])=>`<div class="char-row"><span class="char-key">${k}</span><span class="char-val">${v}</span></div>`).join('')}
    ${S.WS.setting_description ? `<div class="section-hdr" style="margin-top:14px">Setting</div><div style="font-size:12px;color:var(--dim);line-height:1.75;font-family:var(--fs);padding:4px 0 2px">${S.WS.setting_description}</div>` : ''}
    ${p.habits?.length ? `<div class="section-hdr" style="margin-top:14px">Habits</div>${p.habits.map(h=>`<div class="poss">${h}</div>`).join('')}` : ''}
    ${p.irreversible?.length ? `<div class="section-hdr" style="margin-top:14px">Permanent</div>${p.irreversible.map(i=>`<div class="irrev">${i}</div>`).join('')}` : ''}
  `;
  document.getElementById('modal-char').classList.add('open');
}

// ── NPC DETAIL MODAL ──────────────────────────────────────────────────────────
export function openNpcModal(npcId) {
  if (!S.WS?.npcs[npcId]) return;
  const npc = S.WS.npcs[npcId];
  document.getElementById('modal-npc-title').textContent = npc.name;
  const rF = (npc.relationship_meter + 100) / 2;
  const tF = (npc.trust_meter + 100) / 2;
  const rC = npc.relationship_meter >= 30 ? 'var(--pos)' : npc.relationship_meter <= -30 ? 'var(--neg)' : 'var(--neu)';
  const tC = npc.trust_meter >= 30 ? 'var(--pos)' : npc.trust_meter <= -30 ? 'var(--neg)' : 'var(--neu)';
  const task = S.WS.sim_time ? getNpcCurrentTask(npc, S.WS.sim_time) : null;
  const _mPresent   = task ? (task.present !== false) : true;
  const _mLocInfo   = task ? getSmartNpcLabel(task, npc, S.WS?.player?.location ?? 'home') : null;
  const _mTaskLabel = _mLocInfo?.label ?? '';
  const _mAvail = task ? (task.available && _mPresent) : false;
  const taskHtml = task ? `<div class="npc-d-section"><div class="npc-d-title">Right Now</div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
      <span class="npc-task-pill ${_mAvail ? 'avail' : 'busy'}" style="font-size:11px;padding:3px 9px">${_mTaskLabel}</span>
      <span style="font-size:11px;color:var(--dim)">${_mPresent ? (_mAvail ? '— available' : '— busy') : `— not present (${task.location})`}</span>
    </div></div>` : '';
  const _npcSchedBlocks = npc.schedule?.weekday_routine ?? [];
  const schedHtml = _npcSchedBlocks.length ? `<div class="npc-d-section"><div class="npc-d-title">Weekday Schedule</div>
    <div style="font-size:11px;line-height:2.1">${_npcSchedBlocks.map(b => `<div style="display:flex;gap:8px"><span style="width:96px;color:var(--acc);font-size:10px;flex-shrink:0">${String(b.start_hour).padStart(2,'0')}:00–${String(b.end_hour).padStart(2,'0')}:00</span><span style="color:${['workplace','school','transit'].includes(b.location??'') ? 'var(--low)' : 'var(--txt)'}">${b.task.replace(/_/g,' ')}${b.location && b.location !== 'home' ? `<span style="color:var(--dim);margin-left:4px">(${b.location})</span>` : ''}</span></div>`).join('')}</div></div>` : '';
  const relCtx = npc.relationship_meter >= 70 ? 'Close bond — they care about you deeply.'
    : npc.relationship_meter >= 40 ? 'Positive — they like you.'
    : npc.relationship_meter >= 10 ? 'Neutral-positive — still getting to know you.'
    : npc.relationship_meter <= -50 ? 'Hostile — resentment has built up.'
    : npc.relationship_meter <= -20 ? 'Strained — something went wrong.'
    : 'Acquaintance — relationship is still developing.';
  const op = npc.traits?.openness ?? 50;
  const intimacyNote = op < 30 && npc.trust_meter < 60
    ? '🔴 Not open to intimacy — needs much more trust first.'
    : op < 50 && npc.relationship_meter < 20
    ? '🟡 Cautious — needs a stronger relationship before getting close.'
    : op >= 70 ? '🟢 Open — receptive when the moment is right.'
    : '🟡 Depends on how much trust and closeness exists.';
  const _npcImgUrl = S._imageCache[npcId];
  const _npcAvatarHtml = _npcImgUrl
    ? `<img src="${_npcImgUrl}" class="npc-modal-img" alt="${npc.name}" id="npc-detail-avatar" data-upload="${npcId}" title="Tap to change photo" style="cursor:pointer">`
    : `<div id="npc-detail-avatar" data-upload="${npcId}" style="cursor:pointer;width:52px;height:52px;border-radius:50%;background:var(--sur2);border:2px solid var(--bdr);display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;color:var(--dim);margin:0 auto 10px" title="Tap to upload photo">${(npc.name||'?').charAt(0).toUpperCase()}<span style="position:absolute;bottom:0;right:0;font-size:10px;background:var(--acc);border-radius:50%;width:16px;height:16px;display:flex;align-items:center;justify-content:center">📷</span></div>`;
  document.getElementById('modal-npc-body').innerHTML = `
    <div style="position:relative;text-align:center;margin-bottom:6px">${_npcAvatarHtml}</div>
    <div style="text-align:center;margin-bottom:4px;font-size:13px;font-weight:700;color:var(--txt)">${npc.name}</div>
    <div style="text-align:center;margin-bottom:14px;font-size:11px;color:var(--dim)">${(npc.relationship_type??npc.npc_class??'').replace(/_/g,' ')} · Age ${npc.age} · ${npc.npc_class}</div>
    ${npc.bio ? `<div class="npc-d-section"><div class="npc-d-title">About</div><div style="font-size:12px;color:var(--txt);line-height:1.75;font-family:var(--fs);padding:2px 0">${npc.bio}</div></div>` : ''}
    ${taskHtml}${schedHtml}
    <div class="npc-d-section">
      <div class="npc-d-title">Relationship</div>
      <div class="trait-row"><span class="trait-key">Rel</span><div class="trait-track"><div class="trait-fill" style="width:${rF}%;background:${rC}"></div></div><span style="font-size:10px;color:var(--dim);width:32px;text-align:right">${npc.relationship_meter>0?'+':''}${npc.relationship_meter}</span></div>
      <div class="trait-row"><span class="trait-key">Trust</span><div class="trait-track"><div class="trait-fill" style="width:${tF}%;background:${tC}"></div></div><span style="font-size:10px;color:var(--dim);width:32px;text-align:right">${npc.trust_meter>0?'+':''}${npc.trust_meter}</span></div>
      <div style="font-size:11px;color:var(--dim);margin-top:7px;line-height:1.6">${relCtx}</div>
      <div style="font-size:11px;margin-top:5px;line-height:1.6">${intimacyNote}</div>
    </div>
    ${npc.active_flags?.length ? `<div class="npc-d-section"><div class="npc-d-title">Active States (${npc.active_flags.length})</div><div class="npc-flags">${npc.active_flags.map(f=>{const t=npc.flag_timers?.[f];return`<span class="nflag">${f.replace(/_/g,' ')}${t!=null?`<span class="nflag-timer"> ${t}t</span>`:''}</span>`}).join('')}</div></div>` : ''}
    ${npc.recent_interactions?.length ? `<div class="npc-d-section"><div class="npc-d-title">Full Interaction History (${npc.recent_interactions.length})</div><ul class="npc-recent-list">${[...npc.recent_interactions].reverse().map(i=>`<li style="padding:5px 0;border-bottom:1px solid var(--bdr)">${i}</li>`).join('')}</ul></div>` : ''}
  `;
  document.getElementById('modal-npc').classList.add('open');
}

// ── INTEGRITY CHECK ────────────────────────────────────────────────────────────
export function runIntegrityCheck(ws) {
  if (!ws) return { failed: ['No game loaded'], warnings: [] };
  const failed = [], warnings = [];
  const VALID_CLASSES = new Set(['intimate','household','professional','institutional']);
  const INTIMATE_TYPES = ['lover','partner','boyfriend','girlfriend','spouse'];
  for (const [id, npc] of Object.entries(ws.npcs ?? {})) {
    if (npc.status !== 'active') continue;
    if (!npc.name) failed.push(`NPC "${id}": missing name`);
    if (!VALID_CLASSES.has(npc.npc_class)) failed.push(`${npc.name ?? id}: npc_class "${npc.npc_class}" is invalid`);
    if (INTIMATE_TYPES.includes(npc.relationship_type) && npc.relationship_meter < 20)
      warnings.push(`${npc.name}: relationship_type "${npc.relationship_type}" but rel_meter=${npc.relationship_meter} (min 20 expected)`);
    const routine = npc.schedule?.weekday_routine ?? [];
    if (!routine.length) { warnings.push(`${npc.name}: no weekday schedule blocks`); }
    else {
      const sorted = [...routine].sort((a,b) => a.start_hour - b.start_hour);
      if (sorted[0].start_hour !== 0) failed.push(`${npc.name}: schedule gap at start (starts at hour ${sorted[0].start_hour})`);
      if (sorted.at(-1).end_hour !== 24) failed.push(`${npc.name}: schedule gap at end (ends at hour ${sorted.at(-1).end_hour})`);
      for (let i = 0; i < sorted.length - 1; i++) {
        if (sorted[i].end_hour !== sorted[i+1].start_hour)
          failed.push(`${npc.name}: schedule gap ${sorted[i].end_hour}:00–${sorted[i+1].start_hour}:00`);
      }
    }
    if (npc.significance >= 2 && !npc.bio) warnings.push(`${npc.name}: significance=${npc.significance} but no bio set`);
  }
  for (const [stat, val] of Object.entries(ws.player?.stats ?? {})) {
    if (typeof val === 'number' && (val < 0 || val > 100)) failed.push(`Player stat "${stat}" out of range: ${val}`);
  }
  const lorebook = localStorage.getItem('LOREBOOK') ?? '';
  if (lorebook.trim() && Object.keys(ws.npcs ?? {}).length === 0)
    failed.push('Lorebook is set but world has zero NPCs — lorebook parsing failed at init');
  for (const c of (ws.consequences ?? [])) {
    if (c.duration <= 0) warnings.push(`Stale consequence "${c.type}" has duration ${c.duration} — should be cleared`);
  }
  // Ghost NPCs — invalid ids or names from bad AI patches
  for (const [id, npc] of Object.entries(ws.npcs ?? {})) {
    if (id === 'undefined' || id === 'null')
      failed.push(`Ghost NPC with invalid id "${id}" — fix: SIM_PATCH {"remove_npcs":["${id}"]}`);
    else if (!npc.name || npc.name === 'undefined' || npc.name === 'null')
      failed.push(`NPC "${id}": missing or invalid name — fix with SIM_PATCH or remove`);
  }
  // Absence sanity — counts can't exceed total turns played
  if (ws.school?.status === 'active' && (ws.school.absence_count ?? 0) > ws.turn)
    failed.push(`School absence_count (${ws.school.absence_count}) exceeds total turns (${ws.turn}) — overcounted. Fix: SIM_PATCH {"school_update":{"absence_count":1,"last_absence_date":null}}`);
  if (ws.job && (ws.job.absent_count ?? 0) > ws.turn)
    warnings.push(`Job absent_count (${ws.job.absent_count}) exceeds total turns (${ws.turn}) — likely overcounted`);
  // Job with no employer name — possible misclassified family chore
  if (ws.job && (!ws.job.employer || ws.job.employer === 'null' || ws.job.employer === 'undefined'))
    warnings.push(`Job has no employer name — may be a misclassified household responsibility. Use SIM_PATCH job_update:null if incorrect`);
  // Inactive NPCs retaining active flags can cause ghost reactions in narration
  const _inactiveWithFlags = Object.values(ws.npcs ?? {}).filter(n => n.status !== 'active' && (n.active_flags?.length ?? 0) > 0);
  if (_inactiveWithFlags.length)
    warnings.push(`${_inactiveWithFlags.length} inactive NPC(s) still have active flags (ghost states): ${_inactiveWithFlags.map(n => n.name ?? n.id).join(', ')}`);
  return { failed, warnings };
}

// ── CHALLENGE DISPLAY ──────────────────────────────────────────────────────────
let _pendingChallengeQueue = [];

export function showChallengeQueue(challenges) {
  if (!challenges?.length) return;
  _pendingChallengeQueue.push(...challenges);
  _drainChallengeQueue();
}

function _drainChallengeQueue() {
  if (!_pendingChallengeQueue.length) return;
  const ch = _pendingChallengeQueue.shift();
  _showSingleChallenge(ch, () => setTimeout(_drainChallengeQueue, 300));
}

function _showSingleChallenge(ch, onDismiss) {
  const stack = document.getElementById('challenge-stack');
  const overlay = document.getElementById('challenge-overlay');
  if (!stack || !overlay) { onDismiss?.(); return; }
  overlay.style.display = '';
  const card = document.createElement('div');
  card.className = `challenge-card ${ch.severity ?? 'minor'}`;
  const sIcon = { minor: '⚠', moderate: '⚠', major: '🔴', critical: '🚨' };
  card.innerHTML = `
    <div class="challenge-card-hdr">
      <span style="font-size:14px">${sIcon[ch.severity] ?? '⚠'}</span>
      <span class="challenge-card-title">${ch.title}</span>
      <button class="challenge-card-dismiss" title="Dismiss">×</button>
    </div>
    <div class="challenge-card-cause">${ch.cause}</div>
    <div class="challenge-card-effects">${ch.effects_text}</div>
    <div class="challenge-card-resolution">${ch.resolution_steps}</div>`;
  card.querySelector('.challenge-card-dismiss').addEventListener('click', () => {
    card.style.animation = 'none'; card.style.opacity = '0'; card.style.transform = 'translateY(-8px)';
    card.style.transition = 'opacity .2s, transform .2s';
    setTimeout(() => {
      card.remove();
      if (!stack.children.length) overlay.style.display = 'none';
      if (S.WS?.challenges) {
        const idx = S.WS.challenges.findIndex(c => c.id === ch.id);
        if (idx !== -1) { S.WS.challenges[idx].acknowledged = true; saveWorldState(S.WS).catch(() => {}); }
      }
      onDismiss?.();
    }, 220);
  });
  stack.appendChild(card);
  if (ch.severity === 'minor') setTimeout(() => card.querySelector('.challenge-card-dismiss')?.click(), 8000);
}