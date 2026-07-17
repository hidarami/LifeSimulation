// devConsoleUI.js — Dev Console (diagnostic log viewer)
export function initDevConsole(getWSFn, closeMenuFn) {
  let _filter = 'ALL', _autoScroll = true;

  function _entryEl(e) {
    const el = document.createElement('div'); el.className = 'devcon-entry';
    const ts = new Date(e.ts).toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    const ds = e.data !== null && e.data !== undefined ? (typeof e.data === 'string' ? e.data : JSON.stringify(e.data, null, 2)) : '';
    el.innerHTML = `<span class="devcon-ts">${ts}</span><span class="devcon-cat" data-cat="${e.cat}">${e.cat}</span><div style="flex:1;min-width:0"><div class="devcon-msg">${String(e.msg).replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>${ds ? `<pre class="devcon-data">${ds.replace(/</g,'&lt;')}</pre>` : ''}</div>`;
    if (ds) el.addEventListener('click', () => el.classList.toggle('expanded'));
    return el;
  }

  function _refresh() {
    const feed = document.getElementById('devcon-feed');
    const cnt  = document.getElementById('devcon-count');
    if (!feed) return;
    const all = window._devlog?.entries ?? [];
    const fil = _filter === 'ALL' ? all : all.filter(e => e.cat === _filter);
    cnt.textContent = `${fil.length} entr${fil.length === 1 ? 'y' : 'ies'}`;
    feed.innerHTML = '';
    if (!fil.length) { feed.innerHTML = '<div style="color:var(--dim);padding:24px;text-align:center;font-size:11px">No entries.</div>'; return; }
    const frag = document.createDocumentFragment();
    for (const e of fil) frag.appendChild(_entryEl(e));
    feed.appendChild(frag);
    if (_autoScroll) feed.scrollTop = feed.scrollHeight;
  }

  document.getElementById('btn-devconsole')?.addEventListener('click', () => {
    document.getElementById('panel-devcon').classList.add('open');
    closeMenuFn(); _refresh();
  });
  document.getElementById('btn-devcon-close')?.addEventListener('click', () => document.getElementById('panel-devcon').classList.remove('open'));
  document.getElementById('btn-devcon-clear')?.addEventListener('click', () => { window._devlog?.clear(); _refresh(); });
  document.getElementById('btn-devcon-dump')?.addEventListener('click', () => {
    const WS = getWSFn();
    if (!WS) { window._devlog?.log('SYSTEM', 'No world state loaded'); _refresh(); return; }
    window._devlog?.log('SYSTEM', 'WORLD STATE DUMP', {
      turn: WS.turn,
      player: { name: WS.player?.name, age: WS.player?.age, cash: WS.player?.cash, location: WS.player?.location, diseases: (WS.player?.diseases ?? []).map(d => d.name) },
      stats: Object.fromEntries(Object.entries(WS.player?.stats ?? {}).map(([k,v]) => [k, Math.round(v)])),
      job: WS.job ? { employer: WS.job.employer, position: WS.job.position, days: WS.job.days_employed, flags: WS.job.performance_flags } : null,
      school: WS.school ? { name: WS.school.name, status: WS.school.status, absences: WS.school.absence_count } : null,
      npcs: Object.values(WS.npcs ?? {}).filter(n => n.status === 'active').map(n => ({ name: n.name, id: n.id, rel: n.relationship_meter, trust: n.trust_meter, flags: n.active_flags })),
      challenges: (WS.challenges ?? []).filter(c => c.active && !c.resolved).map(c => ({ title: c.title, severity: c.severity })),
      consequences: WS.consequences ?? [],
    });
    _refresh();
  });
  document.getElementById('btn-devcon-export')?.addEventListener('click', () => {
    const all = window._devlog?.entries ?? [];
    const fil = _filter === 'ALL' ? all : all.filter(e => e.cat === _filter);
    const lines = fil.map(e => { const ts = new Date(e.ts).toLocaleTimeString(); const data = e.data != null ? '\n  ' + JSON.stringify(e.data, null, 2).replace(/\n/g, '\n  ') : ''; return `[${ts}][${e.cat}] ${e.msg}${data}`; });
    const hdr = `# Dev Console Export\nFilter: ${_filter} | Entries: ${fil.length}\nExported: ${new Date().toLocaleString()}\n\n---\n\n`;
    const txt = hdr + lines.join('\n\n');
    const a = document.createElement('a'); a.href = 'data:text/markdown;charset=utf-8,' + encodeURIComponent(txt); a.download = `devlog-${new Date().toISOString().replace(/[:.]/g, '-')}.md`; document.body.appendChild(a); a.click(); document.body.removeChild(a);
  });
  document.getElementById('devcon-autoscroll')?.addEventListener('change', e => { _autoScroll = e.target.checked; });
  document.querySelectorAll('.devcon-filter').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.devcon-filter').forEach(b => b.classList.remove('on'));
    btn.classList.add('on'); _filter = btn.dataset.cat; _refresh();
  }));
  window._devlog?.on(e => {
    const panel = document.getElementById('panel-devcon');
    if (!panel?.classList.contains('open')) return;
    if (_filter !== 'ALL' && e.cat !== _filter) return;
    const feed = document.getElementById('devcon-feed');
    const cnt  = document.getElementById('devcon-count');
    document.getElementById('devcon-empty-msg')?.remove();
    const all = window._devlog?.entries ?? [];
    const fil = _filter === 'ALL' ? all : all.filter(x => x.cat === _filter);
    if (cnt) cnt.textContent = `${fil.length} entr${fil.length === 1 ? 'y' : 'ies'}`;
    feed?.appendChild(_entryEl(e));
    if (_autoScroll && feed) feed.scrollTop = feed.scrollHeight;
  });
}