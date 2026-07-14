// renderer.js — stat bars, NPC cards, job panel, possessions, turn anchor
// All UI display. No AI output populates these.
'use strict';

import { getNpcCurrentTask } from './npc.js';

// ─── TURN ANCHOR ──────────────────────────────────────────────────────────────
// Generated entirely by JS. Grok does not generate or know its format.

export function renderTurnAnchor(turn, simTime, location) {
  const d    = new Date(simTime);
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const el   = document.createElement('div');
  el.className = 'turn-anchor';
  el.innerHTML = `<span class="ta-num">TURN ${turn}</span><span class="ta-time">${time} · ${date}</span><span class="ta-loc">${location ?? ''}</span>`;
  return el;
}

// ─── STAT PANEL ───────────────────────────────────────────────────────────────
const STAT_META = {
  health:     { label: 'Health',  icon: '♥',  invert: false },
  energy:     { label: 'Energy',  icon: '⚡', invert: false },
  hunger:     { label: 'Hunger',  icon: '▲',  invert: false }, // 0 = full (not hungry), 100 = empty (starving)
  hygiene:    { label: 'Hygiene', icon: '◈',  invert: false },
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
  cashRow.innerHTML = `<span>₱</span><span>Cash</span><span class="sv">₱${cash.toLocaleString()}</span>`;
  container.appendChild(cashRow);

  for (const [key, meta] of Object.entries(STAT_META)) {
    if (!(key in stats)) continue;
    if (key === 'arousal' && stats[key] === 0) continue;
    const val  = Math.round(stats[key]);
    const fill = meta.invert ? 100 - val : val;
    const cc   = statColorClass(val, meta.invert);
    const row  = document.createElement('div');
    row.className = 'stat-row';
    row.innerHTML = `
      <span class="si">${meta.icon}</span>
      <span class="sl">${meta.label}</span>
      <div class="sbt"><div class="sbf ${cc}" style="width:${fill}%"></div></div>
      <span class="sv">${val}</span>`;
    container.appendChild(row);
  }
}

// ─── NPC PANEL ────────────────────────────────────────────────────────────────
export function renderNpcPanel(npcs, container, currentDate, playerName) {
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
  active.forEach(npc => container.appendChild(buildNpcCard(npc, currentDate)));
}

function buildNpcCard(npc, currentDate) {
  const card = document.createElement('div');
  card.className       = 'npc-card';
  card.dataset.id      = npc.id;
  card.dataset.expanded = 'false';

  const task      = getNpcCurrentTask(npc, currentDate);
  const taskClass = task.available ? 'avail' : 'busy';
  const rawLabel  = npc.relationship_type ?? npc.npc_class ?? '';
  const relLabel  = (
    npc.relationship_meter === 0 && npc.trust_meter === 0 && !['brother','sister','mother','father','uncle','aunt','cousin','friend','best_friend','boyfriend','girlfriend'].includes(rawLabel)
      ? 'stranger'
      : rawLabel || 'acquaintance'
  ).replace(/_/g, ' ');
  const relSign   = npc.relationship_meter > 0 ? '+' : '';
  const relClass  = npc.relationship_meter >= 30 ? 'mp' : npc.relationship_meter <= -30 ? 'mn' : 'mz';

  // ── Collapsed header (always visible) ────────────────────────────────────
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
      <span class="npc-task-pill ${taskClass}">${task.task.replace(/_/g,' ')}</span>
    </div>`;

  // ── Expanded details ──────────────────────────────────────────────────────
  const traitBars = Object.entries(npc.traits ?? {}).map(([k, v]) =>
    `<div class="tr-row"><span class="tr-k">${k}</span><div class="tr-t"><div class="tr-f" style="width:${v}%"></div></div><span class="tr-v">${v}</span></div>`
  ).join('');

  const recentArr = npc.recent_interactions ?? [];
  const recentDefault = (npc.relationship_meter !== 0 || npc.trust_meter !== 0)
    ? `<li>Relationship established prior to game start${npc.relationship_type ? ' — ' + npc.relationship_type.replace(/_/g,' ') : ''}.</li>`
    : '<li>No meaningful interaction yet.</li>';
  const recent = recentArr.slice(-3).map(i => `<li>${i}</li>`).join('') || recentDefault;

  const flags = (npc.active_flags ?? []).map(f => {
    const timer = npc.flag_timers?.[f];
    return `<span class="nflag">${f.replace(/_/g,' ')}${timer != null ? `<span class="nflag-timer"> ${timer}t</span>` : ''}</span>`;
  }).join('');

  const details = document.createElement('div');
  details.className    = 'npc-details';
  details.style.display = 'none';
  details.innerHTML = `
    <div class="npc-meters" style="margin-top:6px">
      ${buildMeter(npc.relationship_meter, 'Rel')}
      ${buildMeter(npc.trust_meter, 'Trust')}
    </div>
    <div class="npc-traits" style="margin-top:6px">${traitBars}</div>
    <ul class="npc-recent" style="margin-top:4px">${recent}</ul>
    ${flags ? `<div class="npc-flags" style="margin-top:4px">${flags}</div>` : ''}
    <button class="npc-detail-btn" data-id="${npc.id}">Full Details ↗</button>`;

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
  const salary   = job.salary_per_cycle
    ? `₱${job.salary_per_cycle.toLocaleString()} / ${job.pay_cycle ?? 'cycle'}`
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
      if (p.value_peso != null)           rows.push(`<div class="poss-detail-row"><span class="poss-detail-key">Value</span><span class="poss-val">₱${Number(p.value_peso).toLocaleString()}</span></div>`);

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