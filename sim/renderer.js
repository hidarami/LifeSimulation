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
  hunger:     { label: 'Hunger',  icon: '▲',  invert: true  }, // full bar = starving
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
export function renderNpcPanel(npcs, container, currentDate) {
  container.innerHTML = '';
  const active = Object.values(npcs).filter(n => n.status === 'active' && n.significance >= 1);
  if (!active.length) {
    container.innerHTML = '<p class="empty">No significant relationships yet.</p>';
    return;
  }
  active.forEach(npc => container.appendChild(buildNpcCard(npc, currentDate)));
}

function buildNpcCard(npc, currentDate) {
  const card = document.createElement('div');
  card.className   = 'npc-card';
  card.dataset.id  = npc.id;

  const task = getNpcCurrentTask(npc, currentDate);
  const taskClass = task.available ? 'avail' : 'busy';

  const traitBars = Object.entries(npc.traits).map(([k, v]) =>
    `<div class="tr-row"><span class="tr-k">${k}</span><div class="tr-t"><div class="tr-f" style="width:${v}%"></div></div></div>`
  ).join('');

  const recent = npc.recent_interactions.slice(-3)
    .map(i => `<li>${i}</li>`).join('') || '<li>No interactions yet.</li>';

  const flags = npc.active_flags.map(f =>
    `<span class="nflag">${f.replace(/_/g,' ')}</span>`).join('');

  card.innerHTML = `
    <div class="npc-hdr">
      <span class="npc-name">${npc.name}</span>
      <span class="npc-age">Age ${npc.age}</span>
      <span class="npc-cls">${npc.npc_class}</span>
      <span class="npc-task ${taskClass}">${task.task.replace(/_/g,' ')}</span>
    </div>
    <div class="npc-meters">
      ${buildMeter(npc.relationship_meter, 'Rel')}
      ${buildMeter(npc.trust_meter, 'Trust')}
    </div>
    <div class="npc-traits">${traitBars}</div>
    <ul class="npc-recent">${recent}</ul>
    ${flags ? `<div class="npc-flags">${flags}</div>` : ''}`;
  return card;
}

function buildMeter(val, label) {
  const fill   = (val + 100) / 2;
  const cc     = val >= 30 ? 'mp' : val <= -30 ? 'mn' : 'mz';
  const sign   = val > 0 ? '+' : '';
  return `<div class="m-row"><span>${label}</span><div class="mt"><div class="mf ${cc}" style="width:${fill}%"></div></div><span class="mv">${sign}${val}</span></div>`;
}

// ─── JOB PANEL ────────────────────────────────────────────────────────────────
export function renderJobPanel(job, container) {
  container.innerHTML = '';
  if (!job) { container.innerHTML = '<p class="empty">Unemployed.</p>'; return; }
  const flags = job.performance_flags?.map(f => `<span class="jflag">${f}</span>`).join('') ?? '';
  container.innerHTML = `
    <div class="job-entry">
      <div class="j-emp">${job.employer}</div>
      <div class="j-pos">${job.position}</div>
      <div class="j-sal">₱${job.salary_per_cycle?.toLocaleString()} / ${job.pay_cycle}</div>
      <div class="j-sch">${job.schedule}</div>
      <div class="j-days">${job.days_employed ?? 0} days employed</div>
      ${flags ? `<div class="j-flags">${flags}</div>` : ''}
    </div>`;
}

// ─── POSSESSIONS PANEL ────────────────────────────────────────────────────────
export function renderPossessionsPanel(possessions, irreversible, container) {
  container.innerHTML = '';
  if (irreversible?.length) {
    container.innerHTML += `<div class="psub">Permanent</div>` +
      irreversible.map(i => `<div class="irrev">${i}</div>`).join('');
  }
  if (possessions?.length) {
    container.innerHTML += `<div class="psub">Possessions</div>` +
      possessions.map(p => `<div class="poss">${p.name}${p.note ? ` <span class="pnote">${p.note}</span>` : ''}</div>`).join('');
  }
  if (!irreversible?.length && !possessions?.length) {
    container.innerHTML = '<p class="empty">Nothing notable.</p>';
  }
}

// ─── NARRATION DISPLAY ────────────────────────────────────────────────────────
export function renderNarration(prose, anchorEl, feed) {
  const wrapper = document.createElement('div');
  wrapper.className = 'narration-entry';
  wrapper.appendChild(anchorEl);
  const proseEl = document.createElement('div');
  proseEl.className = 'narration-prose';
  proseEl.textContent = prose;
  wrapper.appendChild(proseEl);
  feed.prepend(wrapper);
}