// renderer.js — stat bars, NPC cards, job panel, possessions, turn anchor
// All UI display. No AI output populates these.
'use strict';

import { getNpcCurrentTask } from './npc.js';
import { getCurrencySymbol, detectProvider } from './providers.js';

// ─── NPC LOCATION HELPERS ─────────────────────────────────────────────────────
export function livesWithPlayer(npc) {
  const rt = (npc.relationship_type ?? '').toLowerCase();
  const FAMILY = new Set([
    'mother','father','brother','sister','uncle','aunt',
    'grandfather','grandmother','lola','lolo','guardian',
    'parent_father','parent_mother','stepmother','stepfather',
    'stepbrother','stepsister','parent',
  ]);
  if (FAMILY.has(rt)) return true;
  if (rt === 'roommate') return true;
  if (npc.npc_class === 'household' && !['neighbor','landlord','building_admin'].includes(rt)) return true;
  return false;
}

export function getSmartNpcLabel(task, npc, playerLocation = 'home') {
  const loc      = task.location ?? 'home';
  const cohabits = livesWithPlayer(npc);
  if (loc === 'workplace')    return { label: 'At work',           cls: 'busy'  };
  if (loc === 'school')       return { label: 'At school',         cls: 'busy'  };
  if (loc === 'transit')      return { label: 'Commuting',         cls: 'busy'  };
  if (loc === 'player_home')  return { label: 'Visiting you',      cls: 'avail' };
  if (loc === 'with_player')  return { label: 'With you',          cls: 'avail' };
  if (loc === 'outside') {
    return task.interruptible
      ? { label: 'Out — reachable',  cls: 'avail' }
      : { label: 'Out on errands',   cls: 'busy'  };
  }
  // loc === 'home'
  if (cohabits) {
    if (task.task === 'sleeping')     return { label: 'Sleeping',       cls: 'busy'  };
    if (task.task === 'morning_prep') return { label: 'Getting ready',  cls: 'busy'  };
    if (task.task === 'winding_down') return { label: 'Winding down',   cls: 'avail' };
    return task.available
      ? { label: 'Home — free',  cls: 'avail' }
      : { label: 'Home — busy',  cls: 'busy'  };
  } else {
    if (task.task === 'sleeping')     return { label: 'Asleep at home',  cls: 'busy'  };
    if (task.task === 'morning_prep') return { label: 'Getting ready',   cls: 'busy'  };
    if (task.task === 'winding_down') return { label: 'At home',         cls: 'avail' };
    return task.available
      ? { label: 'At their home',       cls: 'avail' }
      : { label: 'At home — busy',      cls: 'busy'  };
  }
}

const TRAIT_INTERP = {
  jealousy:    v => v >= 70 ? '↑ Gets jealous easily' : v < 30 ? '↓ Not the jealous type' : '— Average',
  honesty:     v => v >= 70 ? '↑ Straightforward' : v < 30 ? '↓ May mislead you' : '— Selective',
  patience:    v => v >= 70 ? '↑ Won\'t rush you' : v < 30 ? '↓ Short fuse' : '— Average',
  warmth:      v => v >= 70 ? '↑ Caring, affectionate' : v < 30 ? '↓ Cold, distant' : '— Neutral',
  ambition:    v => v >= 70 ? '↑ Driven, goal-oriented' : v < 30 ? '↓ Laid-back' : '— Moderate',
  impulsivity: v => v >= 70 ? '↑ Acts before thinking' : v < 30 ? '↓ Deliberate' : '— Moderate',
  dominance:   v => v >= 70 ? '↑ Assertive, takes control' : v < 30 ? '↓ Deferential' : '— Balanced',
  openness:    v => v >= 70 ? '↑ Open to intimacy' : v < 30 ? '↓ Needs deep trust first' : '— Selective',
};

// ─── TURN ANCHOR ──────────────────────────────────────────────────────────────
// Generated entirely by JS. Grok does not generate or know its format.

export function renderTurnAnchor(turn, simTime, location) {
  const d    = new Date(simTime);
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const el   = document.createElement('div');
  el.className = 'turn-anchor';
  const locStr = location ? location.toUpperCase() : '';
  el.innerHTML = `
    <div class="ta-row">
      <span class="ta-num">TURN ${turn}</span>
      <span class="ta-time">${time} · ${date}</span>
    </div>
    ${locStr ? `<div class="ta-loc">${locStr}</div>` : ''}`;
  return el;
}

// ─── STAT PANEL ───────────────────────────────────────────────────────────────
const STAT_META = {
  health:     { label: 'Health',   icon: '♥',  invert: false },
  energy:     { label: 'Energy',   icon: '⚡', invert: false },
  hunger:     { label: 'Satiety',  icon: '▲', invert: true  }, // 0=starving(displayed 0%), 100=full(displayed 100%)
  hygiene:    { label: 'Hygiene',  icon: '◈',  invert: false },
  mood:       { label: 'Mood',    icon: '◉',  invert: false },
  arousal:    { label: 'Arousal', icon: '◈',  invert: false },
  social:     { label: 'Social',  icon: '◎',  invert: false },
  reputation: { label: 'Rep',     icon: '★',  invert: false },
};

function statColorClass(val, invert) {
  const eff = invert ? 100 - val : val;
  if (eff <= 20) return 'sc-crit';
  if (eff <= 40) return 'sc-low';
  if (eff >= 80) return 'sc-high';
  return 'sc-norm';
}

export function renderStatPanel(stats, cash, container) {
  container.innerHTML = '';

  const cashRow = document.createElement('div');
  cashRow.className = 'stat-row stat-cash';
  const _cur = getCurrencySymbol();
  cashRow.innerHTML = `<span>${_cur}</span><span>Cash</span><span class="sv">${_cur}${cash.toLocaleString()}</span>`;
  container.appendChild(cashRow);

  for (const [key, meta] of Object.entries(STAT_META)) {
    if (!(key in stats)) continue;
    if (key === 'arousal' && stats[key] === 0) continue;
    const val  = Math.round(stats[key]);
    const fill = meta.invert ? 100 - val : val;
    const cc   = statColorClass(val, meta.invert);
    const disp = meta.invert ? (100 - val) : val;
    const row  = document.createElement('div');
    row.className = 'stat-row';
    row.innerHTML = `
      <span class="si">${meta.icon}</span>
      <span class="sl">${meta.label}</span>
      <div class="sbt"><div class="sbf ${cc}" style="width:${fill}%"></div></div>
      <span class="sv">${disp}</span>`;
    container.appendChild(row);
  }
}

// ─── NPC PANEL ────────────────────────────────────────────────────────────────
export function renderNpcPanel(npcs, container, currentDate, playerName, playerLocation = 'home') {
  container.innerHTML = '';
  const pkey = playerName?.toLowerCase().trim();
  const active = Object.values(npcs).filter(n =>
    n.status === 'active' && n.significance >= 1 &&
    n.name?.toLowerCase().trim() !== pkey
  );
  if (!active.length) {
    container.innerHTML = '<p class="empty">No significant relationships yet.</p>';
    return;
  }
  active.forEach(npc => container.appendChild(buildNpcCard(npc, currentDate, playerLocation)));
}

function getNpcEmotionLabel(npc) {
  const flags = npc.active_flags ?? [];
  const MAP = { resentment:'Resentful', jealousy_triggered:'Jealous', angry:'Angry', worried:'Worried', hurt:'Hurt', happy:'Happy', grateful:'Grateful', suspicious:'Suspicious', distant:'Distant', uncomfortable:'Uncomfortable', mistreated_recently:'Hurt', deepening_bond:'Close', aroused:'Aroused', post_first_sexual_encounter:'Flustered', mutual_unspoken_tension:'Tense', concealing_true_feeling:'Guarded', betrayed:'Shaken', comfortable_intimacy:'Comfortable' };
  const e = [];
  for (const [flag, label] of Object.entries(MAP)) { if (flags.includes(flag)) e.push(label); }
  if (!e.length) {
    const r = npc.relationship_meter;
    e.push(r >= 60 ? 'Warm' : r >= 30 ? 'Friendly' : r <= -40 ? 'Cold' : r <= -20 ? 'Tense' : 'Neutral');
  }
  return e.slice(0, 2);
}

function buildNpcCard(npc, currentDate, playerLocation = 'home') {
  const card = document.createElement('div');
  card.className       = 'npc-card';
  card.dataset.id      = npc.id;
  card.dataset.expanded = 'false';

  const task                         = getNpcCurrentTask(npc, currentDate);
  const { label: taskDisplay, cls: taskClass } = getSmartNpcLabel(task, npc, playerLocation);
  const rawLabel  = npc.relationship_type ?? npc.npc_class ?? '';
  const relLabel  = (
    npc.relationship_meter === 0 && npc.trust_meter === 0 && !['brother','sister','mother','father','uncle','aunt','cousin','friend','best_friend','boyfriend','girlfriend'].includes(rawLabel)
      ? 'stranger'
      : rawLabel || 'acquaintance'
  ).replace(/_/g, ' ');
  const relSign   = npc.relationship_meter > 0 ? '+' : '';
  const relClass  = npc.relationship_meter >= 30 ? 'mp' : npc.relationship_meter <= -30 ? 'mn' : 'mz';

  // ── Collapsed header (always visible) ────────────────────────────────────
  // Only show flag-derived emotions; suppress generic relationship-state labels
  const _GENERIC_EMOS = new Set(['Warm','Friendly','Neutral','Cold','Tense','Comfortable']);
  const npcEmos = getNpcEmotionLabel(npc).filter(e => !_GENERIC_EMOS.has(e));
  const header = document.createElement('div');
  header.className = 'npc-collapsed';
  header.innerHTML = `
    <div class="npc-col-top">
      <span class="npc-name">${npc.name}</span>
      <span class="npc-rel-num ${relClass}">${relSign}${npc.relationship_meter}</span>
      <span class="npc-expand-icon">▶</span>
    </div>
    <div class="npc-col-bottom">
      <span class="npc-age-rel">Age ${npc.age} · <em>${relLabel}</em></span>
      <span class="npc-task-pill ${taskClass}">${taskDisplay}</span>
    </div>
    ${npcEmos.length ? `<div class="npc-emotions">${npcEmos.map(em => `<span class="npc-emo-pill">${em}</span>`).join('')}</div>` : ''}`;

  // ── Expanded details ──────────────────────────────────────────────────────
  const traitBars = Object.entries(npc.traits ?? {}).map(([k, v]) =>
    `<div style="margin-bottom:5px">
      <div class="tr-row"><span class="tr-k">${k}</span><div class="tr-t"><div class="tr-f" style="width:${v}%"></div></div><span class="tr-v">${v}</span></div>
      <div style="font-size:9px;color:var(--dim);padding-left:72px;margin-top:1px;line-height:1.3">${(TRAIT_INTERP[k] ?? (() => ''))(v)}</div>
    </div>`
  ).join('');

  const flags = (npc.active_flags ?? []).filter(f => {
    const timer = npc.flag_timers?.[f];
    return timer == null || timer > 0;
  }).map(f => `<span class="nflag">${f.replace(/_/g,' ')}</span>`).join('');

  const details = document.createElement('div');
  details.className     = 'npc-details';
  details.style.display = 'none';
  details.innerHTML = `
    <div class="npc-meters" style="margin-top:6px">
      ${buildMeter(npc.relationship_meter, 'Rel')}
      ${buildMeter(npc.trust_meter, 'Trust')}
    </div>
    <div style="margin-top:9px;margin-bottom:4px;font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em">Personality</div>
    <div class="npc-traits">${traitBars}</div>
    ${flags ? `<div style="margin-top:7px;margin-bottom:3px;font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em">Active States</div><div class="npc-flags">${flags}</div>` : ''}
    <button class="npc-detail-btn" data-id="${npc.id}">Schedule & History ↗</button>`;

  header.addEventListener('click', e => {
    e.stopPropagation();
    const open = card.dataset.expanded === 'true';
    card.dataset.expanded   = open ? 'false' : 'true';
    details.style.display   = open ? 'none' : 'block';
    header.querySelector('.npc-expand-icon').textContent = open ? '▶' : '▼';
  });

  card.appendChild(header);
  card.appendChild(details);
  return card;
}

function buildMeter(val, label) {
  const fill   = (val + 100) / 2;
  const cc     = val >= 30 ? 'mp' : val <= -30 ? 'mn' : 'mz';
  const sign   = val > 0 ? '+' : '';
  return `<div class="m-row"><span>${label}</span><div class="mt"><div class="mf ${cc}" style="width:${fill}%"></div></div><span class="mv">${sign}${val}</span></div>`;
}

// ─── JOB PANEL ────────────────────────────────────────────────────────────────
export function renderJobPanel(job, school, container) {
  container.innerHTML = '';

  if (school?.name) {
    const sec = document.createElement('div');
    sec.className = 'job-section';
    sec.innerHTML = `
      <div class="j-label">Student</div>
      <div class="j-emp">${school.name}</div>
      ${school.grade_level ? `<div class="j-role">${school.grade_level}</div>` : ''}
      ${school.schedule && school.schedule !== 'null' ? `<div class="j-meta-row"><span class="j-meta-key">Hours</span><span class="j-sch-val">${school.schedule}</span></div>` : ''}
      ${school.absence_count ? `<div class="j-meta-row"><span class="j-meta-key">Absent</span><span style="color:var(--low);font-size:11px">${school.absence_count} day${school.absence_count !== 1 ? 's' : ''}</span></div>` : ''}
      ${school.status === 'active' ? '<div class="j-flag-good">Currently Enrolled</div>' : ''}`;
    container.appendChild(sec);
  }

  if (!job) {
    if (!school) container.innerHTML = '<p class="empty">Unemployed.</p>';
    return;
  }

  const isBadStr = v => !v || v === 'null' || v === 'undefined';
  const employer = isBadStr(job.employer) ? 'Freelance / Self-employed' : job.employer;
  const _jobCur  = getCurrencySymbol();
  const salary   = job.salary_per_cycle
    ? `${_jobCur}${job.salary_per_cycle.toLocaleString()} / ${job.pay_cycle ?? 'cycle'}`
    : (job.earnings_note ?? 'Variable earnings');
  const flags = (job.performance_flags ?? []).map(f => `<span class="jflag">${f}</span>`).join('');

  const sec = document.createElement('div');
  sec.className = 'job-section';
  sec.innerHTML = `
    <div class="j-label">Work</div>
    <div class="j-emp">${employer}</div>
    ${!isBadStr(job.position) ? `<div class="j-role">${job.position}</div>` : ''}
    ${job.description ? `<div class="j-desc">${job.description}</div>` : ''}
    <div class="j-meta-row"><span class="j-meta-key">Pay</span><span class="j-earn">${salary}</span></div>
    ${!isBadStr(job.schedule) ? `<div class="j-meta-row"><span class="j-meta-key">Hours</span><span class="j-sch-val">${job.schedule}</span></div>` : ''}
    <div class="j-meta-row"><span class="j-meta-key">Active</span><span class="j-days-val">${job.days_employed ?? 0} days</span></div>
    ${flags ? `<div class="j-flags" style="margin-top:6px">${flags}</div>` : ''}`;
  container.appendChild(sec);
}

// ─── POSSESSIONS PANEL ────────────────────────────────────────────────────────
export function renderPossessionsPanel(possessions, irreversible, container) {
  container.innerHTML = '';

  if (irreversible?.length) {
    const h = document.createElement('div'); h.className = 'psub'; h.textContent = 'Permanent';
    container.appendChild(h);
    irreversible.forEach(i => {
      const d = document.createElement('div'); d.className = 'irrev'; d.textContent = i;
      container.appendChild(d);
    });
  }

  if (possessions?.length) {
    const h = document.createElement('div'); h.className = 'psub';
    h.textContent = `Possessions (${possessions.length})`;
    container.appendChild(h);
    possessions.forEach(p => {
      const item = document.createElement('div');
      item.className = 'poss-item';
      item.dataset.open = 'false';

      const condition = p.condition || null;

      const head = document.createElement('div');
      head.className = 'poss-header';
      head.innerHTML = `
        <div class="poss-header-main">
          <span class="poss-name">${p.name}</span>
          ${condition ? `<span class="poss-cond-preview">${condition}</span>` : ''}
        </div>
        <span class="poss-icon">▶</span>`;
      item.appendChild(head);

      const rows = [];
      if (p.note && p.note !== condition) rows.push(`<div class="poss-detail-row"><span class="poss-detail-key">About</span><span>${p.note}</span></div>`);
      if (condition)                       rows.push(`<div class="poss-detail-row"><span class="poss-detail-key">Cond.</span><span>${condition}</span></div>`);
      if (p.acquired_method)              rows.push(`<div class="poss-detail-row"><span class="poss-detail-key">Origin</span><span>${p.acquired_method}</span></div>`);
      if (p.value_peso != null)           rows.push(`<div class="poss-detail-row"><span class="poss-detail-key">Value</span><span class="poss-val">${getCurrencySymbol()}${Number(p.value_peso).toLocaleString()}</span></div>`);

      const body = document.createElement('div');
      body.className = 'poss-body';
      body.innerHTML = rows.length ? rows.join('') : `<div class="poss-detail-row" style="opacity:.6">No additional details.</div>`;
      item.appendChild(body);

      head.addEventListener('click', () => {
        const open = item.dataset.open === 'true';
        item.dataset.open = open ? 'false' : 'true';
        head.querySelector('.poss-icon').textContent = open ? '▶' : '▼';
      });

      container.appendChild(item);
    });
  }

  if (!irreversible?.length && !possessions?.length) {
    const p = document.createElement('p'); p.className = 'empty'; p.textContent = 'Nothing notable.';
    container.appendChild(p);
  }
}

// ─── NARRATION DISPLAY ────────────────────────────────────────────────────────
export function renderNarration(prose, anchorEl, feed, turn) {
  const wrapper = document.createElement('div');
  wrapper.className = 'narration-entry';
  if (turn != null) wrapper.dataset.turn = turn;
  wrapper.appendChild(anchorEl);
  const proseEl = document.createElement('div');
  proseEl.className = 'narration-prose';
  proseEl.textContent = prose;
  wrapper.appendChild(proseEl);
  feed.appendChild(wrapper);
}

// ─── CHALLENGES PANEL ─────────────────────────────────────────────────────────
export function renderChallengesPanel(challenges, debts, fame, container) {
  if (!container) return;
  container.innerHTML = '';
  const cur = getCurrencySymbol();

  // ── Fame tier display ──────────────────────────────────────────────────────
  if (fame && fame.level >= 1) {
    const fameColors = { local:'#c8922a', regional:'#e67e22', national:'#e74c3c', celebrity:'#8e44ad' };
    const fameIcons  = { local:'🌟', regional:'⭐', national:'🏆', celebrity:'👑' };
    const fc = document.createElement('div');
    fc.style.cssText = 'margin-bottom:12px;padding:8px 10px;border:1px solid var(--bdr);border-radius:4px;background:var(--sur)';
    fc.innerHTML = `
      <div style="font-size:9px;color:var(--acc);text-transform:uppercase;letter-spacing:.08em;margin-bottom:5px">Fame Status</div>
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:18px">${fameIcons[fame.label] ?? '🌟'}</span>
        <div>
          <div style="font-size:13px;font-weight:700;color:${fameColors[fame.label] ?? 'var(--acc)'};text-transform:capitalize">${fame.label}</div>
          <div style="font-size:10px;color:var(--dim)">${(fame.followers ?? 0).toLocaleString()} followers</div>
        </div>
      </div>
      ${fame.unlocked_perks?.length ? `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:3px">${fame.unlocked_perks.slice(0,4).map(p => `<span style="font-size:9px;padding:1px 5px;background:var(--acc2);border:1px solid var(--acc);border-radius:3px;color:var(--acc)">${p.replace(/_/g,' ')}</span>`).join('')}</div>` : ''}`;
    container.appendChild(fc);
  }

  // ── Debts display ──────────────────────────────────────────────────────────
  const activeDebts = (debts ?? []).filter(d => d.status === 'active' || d.status === 'overdue');
  if (activeDebts.length) {
    const dh = document.createElement('div');
    dh.className = 'psub'; dh.textContent = `Debts (${activeDebts.length})`;
    container.appendChild(dh);
    for (const debt of activeDebts) {
      const de = document.createElement('div');
      de.style.cssText = 'border-bottom:1px solid var(--bdr);padding:6px 0 8px';
      const isOverdue = debt.status === 'overdue';
      de.innerHTML = `
        <div style="display:flex;align-items:baseline;gap:6px;margin-bottom:2px">
          <span style="font-size:12px;font-weight:600;color:${isOverdue ? 'var(--neg)' : 'var(--txt)'}">${debt.creditor}</span>
          <span style="font-size:9px;padding:1px 5px;border-radius:3px;${isOverdue ? 'background:#3a1010;color:var(--neg)' : 'background:var(--sur2);color:var(--dim)'}">${isOverdue ? 'OVERDUE' : debt.type}</span>
        </div>
        <div style="font-size:11px;color:var(--low);font-weight:600">${cur}${(debt.amount ?? 0).toLocaleString()}</div>
        ${debt.description ? `<div style="font-size:10px;color:var(--dim);margin-top:1px">${debt.description}</div>` : ''}
        <div style="font-size:10px;color:var(--dim);margin-top:2px">${isOverdue ? '⚠ Overdue' : `${debt.turns_remaining ?? 0} turns remaining`}</div>`;
      container.appendChild(de);
    }
  }

  const active   = (challenges ?? []).filter(c => c.active && !c.resolved);
  const resolved = (challenges ?? []).filter(c => c.resolved);
  if (!active.length && !resolved.length && !activeDebts.length && (!fame || fame.level === 0)) {
    container.innerHTML = '<p class="empty">No active challenges.</p>';
    return;
  }
  if (active.length) {
    const hdr = document.createElement('div');
    hdr.className = 'psub'; hdr.textContent = `Active (${active.length})`;
    container.appendChild(hdr);
    for (const ch of active) container.appendChild(buildChallengeRow(ch, false));
  }
  if (resolved.length) {
    const hdr = document.createElement('div');
    hdr.className = 'psub'; hdr.style.marginTop = '14px'; hdr.textContent = `Resolved (${resolved.length})`;
    container.appendChild(hdr);
    for (const ch of resolved.slice(-5)) container.appendChild(buildChallengeRow(ch, true));
  }
}

function buildChallengeRow(ch, isResolved) {
  const el = document.createElement('div');
  el.className = 'challenge-row';
  el.dataset.open = 'false';
  const severityColor = { minor: 'var(--low)', moderate: '#e67e22', major: 'var(--neg)', critical: '#c0392b' };
  const head = document.createElement('div');
  head.className = 'challenge-row-head';
  head.innerHTML = `
    <span class="challenge-row-dot" style="background:${severityColor[ch.severity] ?? 'var(--dim)'}"></span>
    <span class="challenge-row-title" style="${isResolved ? 'opacity:.5;text-decoration:line-through' : ''}">${ch.title}</span>
    <span style="font-size:9px;color:var(--dim);flex-shrink:0">${isResolved ? '✓' : ch.severity}</span>
    <span class="challenge-expand-icon" style="font-size:9px;color:var(--dim);flex-shrink:0">▶</span>`;
  const body = document.createElement('div');
  body.className = 'challenge-row-body';
  body.style.display = 'none';
  body.innerHTML = `
    <div style="font-size:11px;color:var(--dim);margin-bottom:5px;line-height:1.55">${ch.cause}</div>
    <div style="font-size:11px;color:var(--low);margin-bottom:5px;line-height:1.55">${ch.effects_text}</div>
    <div style="font-size:11px;color:var(--txt);opacity:.7;line-height:1.55;padding-top:5px;border-top:1px solid var(--bdr)">${ch.resolution_steps}</div>`;
  head.addEventListener('click', () => {
    const open = el.dataset.open === 'true';
    el.dataset.open = open ? 'false' : 'true';
    body.style.display = open ? 'none' : 'block';
    head.querySelector('.challenge-expand-icon').textContent = open ? '▶' : '▼';
  });
  el.appendChild(head);
  el.appendChild(body);
  return el;
}