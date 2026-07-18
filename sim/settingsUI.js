// settingsUI.js — settings modal, API key testing, fallback slots, load modal
import S from './gameState.js';
import { saveWorldState, setSupabaseClient, saveWorldStateCloud, getCurrentSaveId,
         loadWorldState, loadNarrations, listSaves, deleteSave } from './state.js';
import { compressLorebook, resetConvId, setConversationHistory } from './api.js';
import { detectProvider, getProviderDisplayName, fetchModels,
         dispatchChat as _providerDispatchChat } from './providers.js';
import { renderAll, setStatus } from './uiCore.js';
import { renderTurnAnchor, renderNarration } from './renderer.js';
import { loadConsoleHistoryForCurrentSave } from './consoleUI.js';
import { loadAllImages } from './state.js';

// ── PROVIDER DETECTION HELPERS ─────────────────────────────────────────────────
function _effectiveProvider(prefix) {
  const sel = document.getElementById(`k-${prefix}-provider`)?.value?.trim();
  if (sel) return sel;
  return detectProvider(document.getElementById(`k-${prefix}`)?.value?.trim() ?? '');
}
function _updateCustomBaseUrlRow() {
  const row = document.getElementById('k-custom-baseurl-row'); if (!row) return;
  const isCustom = _effectiveProvider('narrator') === 'custom' || _effectiveProvider('classifier') === 'custom';
  row.style.display = isCustom ? 'block' : 'none';
}
function _updateSlotDetection(prefix) {
  const inp = document.getElementById(`k-${prefix}`);
  const badge = document.getElementById(`k-${prefix}-badge`);
  const provRow = document.getElementById(`k-${prefix}-provider-row`);
  const provSel = document.getElementById(`k-${prefix}-provider`);
  if (!inp) return;
  const v = inp.value.trim(); const auto = detectProvider(v);
  if (badge) {
    if (auto)   { badge.textContent = `✓ Detected: ${getProviderDisplayName(auto)}`; badge.style.color = 'var(--pos)'; badge.style.display = 'block'; }
    else if (v) { badge.textContent = '⚠ Unrecognized key — choose a provider below'; badge.style.color = 'var(--warn, #d98b2b)'; badge.style.display = 'block'; }
    else        { badge.textContent = ''; badge.style.display = 'none'; }
  }
  if (provRow) provRow.style.display = ((v && !auto) || (provSel && provSel.value)) ? 'block' : 'none';
  _updateCustomBaseUrlRow();
}
function _seedModelList(prefix) {
  const listEl = document.getElementById(`k-${prefix}-model-list`); if (!listEl) return;
  const saved = localStorage.getItem(`${prefix.toUpperCase()}_MODEL`) ?? '';
  listEl.innerHTML = saved ? `<option value="${saved}" selected>${saved}</option><option value="">— use provider default —</option>` : '<option value="">— enter key, then Discover —</option>';
}
async function _discoverModels(prefix) {
  const listEl = document.getElementById(`k-${prefix}-model-list`);
  const key = document.getElementById(`k-${prefix}`)?.value?.trim();
  const provider = _effectiveProvider(prefix);
  const baseUrl = document.getElementById('k-custom-baseurl')?.value?.trim();
  if (!listEl) return;
  document.getElementById(`k-${prefix}-model-filter`)?.remove();
  document.getElementById(`k-${prefix}-model-count`)?.remove();
  if (!key || !provider) { listEl.innerHTML = '<option value="">— enter a key / pick a provider first —</option>'; return; }
  listEl.innerHTML = '<option value="">Loading…</option>';
  const models = await fetchModels(provider, key, baseUrl);
  const current = localStorage.getItem(`${prefix.toUpperCase()}_MODEL`) ?? '';
  if (!models.length) { listEl.innerHTML = '<option value="">— discovery failed, type a model below —</option>'; return; }
  listEl.innerHTML = '<option value="">— use provider default —</option>' + models.map(m => `<option value="${m}"${m === current ? ' selected' : ''}>${m}</option>`).join('');
  const _fi = document.createElement('input'); _fi.id = `k-${prefix}-model-filter`; _fi.className = 'field-input'; _fi.placeholder = 'Filter models…'; _fi.style.cssText = 'margin-bottom:4px;font-size:12px';
  const _ce = document.createElement('div'); _ce.id = `k-${prefix}-model-count`; _ce.style.cssText = 'font-size:10px;color:var(--dim);margin-bottom:4px'; _ce.textContent = `${models.length} models`;
  listEl.parentNode.insertBefore(_fi, listEl); listEl.parentNode.insertBefore(_ce, listEl);
  _fi.addEventListener('input', () => { const q = _fi.value.toLowerCase(); let shown = 0; for (const opt of listEl.options) { if (!opt.value) continue; const match = !q || opt.value.toLowerCase().includes(q); opt.style.display = match ? '' : 'none'; if (match) shown++; } _ce.textContent = q ? `Showing ${shown} of ${models.length} models` : `${models.length} models`; });
}
function _updateMutualExclusion() {
  const qsVal  = (document.getElementById('k-quickstart')?.value ?? '').trim();
  const narVal = (document.getElementById('k-narrator')?.value    ?? '').trim();
  const clsVal = (document.getElementById('k-classifier')?.value  ?? '').trim();
  const qsBadge = document.getElementById('k-quickstart-badge');
  const _narGroup = ['k-narrator','k-narrator-model','k-narrator-model-list','k-narrator-refresh','k-narrator-provider'].map(id => document.getElementById(id)).filter(Boolean);
  const _clsGroup = ['k-classifier','k-classifier-model','k-classifier-model-list','k-classifier-refresh','k-classifier-provider'].map(id => document.getElementById(id)).filter(Boolean);
  const _qsInp = document.getElementById('k-quickstart');
  if (qsVal) {
    [..._narGroup, ..._clsGroup].forEach(el => { el.disabled = true; el.style.opacity = '0.4'; });
    if (_qsInp) { _qsInp.disabled = false; _qsInp.style.opacity = ''; }
    if (qsBadge) { qsBadge.textContent = '✓ Using quick-start key for both slots'; qsBadge.style.color = 'var(--pos)'; qsBadge.style.display = 'block'; }
  } else if (narVal || clsVal) {
    if (_qsInp) { _qsInp.disabled = true; _qsInp.style.opacity = '0.4'; }
    [..._narGroup, ..._clsGroup].forEach(el => { el.disabled = false; el.style.opacity = ''; });
    if (qsBadge) { qsBadge.textContent = '⚡ Using dual-slot configuration'; qsBadge.style.color = 'var(--acc)'; qsBadge.style.display = 'block'; }
    _updateSlotDetection('narrator'); _updateSlotDetection('classifier');
  } else {
    [..._narGroup, ..._clsGroup].forEach(el => { el.disabled = false; el.style.opacity = ''; });
    if (_qsInp) { _qsInp.disabled = false; _qsInp.style.opacity = ''; }
    if (qsBadge) qsBadge.style.display = 'none';
    _updateSlotDetection('narrator'); _updateSlotDetection('classifier');
  }
}
function _wireSlot(prefix) {
  const inp = document.getElementById(`k-${prefix}`);
  const provSel = document.getElementById(`k-${prefix}-provider`);
  const refreshBtn = document.getElementById(`k-${prefix}-refresh`);
  const listEl = document.getElementById(`k-${prefix}-model-list`);
  if (inp && !inp._slotWired) { inp._slotWired = true; inp.addEventListener('input', () => { _updateSlotDetection(prefix); _updateMutualExclusion(); }); }
  if (provSel && !provSel._slotWired) { provSel._slotWired = true; provSel.addEventListener('change', _updateCustomBaseUrlRow); }
  if (refreshBtn && !refreshBtn._slotWired) { refreshBtn._slotWired = true; refreshBtn.addEventListener('click', () => _discoverModels(prefix)); }
  if (listEl && !listEl._slotWired) { listEl._slotWired = true; listEl.addEventListener('change', () => { const ov = document.getElementById(`k-${prefix}-model`); if (ov && listEl.value) ov.value = listEl.value; }); }
}

// ── FALLBACK SLOTS ─────────────────────────────────────────────────────────────
function _loadFallbackSlots() { try { return JSON.parse(localStorage.getItem('FALLBACK_SLOTS') ?? '[]'); } catch { return []; } }
export function _saveFallbackSlots() {
  const slots = [];
  document.querySelectorAll('.fb-slot').forEach((el, idx) => {
    const key = el.querySelector('.fb-key')?.value?.trim() ?? '';
    const provider = el.querySelector('.fb-provider')?.value?.trim() ?? '';
    const model = el.querySelector('.fb-model')?.value?.trim() ?? '';
    const enabled = el.querySelector('.fb-toggle-inp')?.checked ?? false;
    const roles = []; el.querySelectorAll('.fb-role:checked').forEach(r => roles.push(r.value));
    slots.push({ slot: idx + 1, enabled, key, provider, model, roles });
  });
  localStorage.setItem('FALLBACK_SLOTS', JSON.stringify(slots));
}
function _renderFallbackSlots() {
  const container = document.getElementById('fallback-slots-list'); if (!container) return;
  const saved = _loadFallbackSlots(); container.innerHTML = '';
  const _ALL_PROVS = [['grok','Grok/xAI'],['openai','OpenAI'],['anthropic','Anthropic'],['openrouter','OpenRouter'],['groq','Groq'],['gemini','Google Gemini'],['huggingface','HuggingFace'],['mistral','Mistral AI'],['cerebras','Cerebras'],['github','GitHub Models'],['cohere','Cohere']];
  for (let i = 0; i < 8; i++) {
    const s = saved[i] ?? { slot: i+1, enabled: false, key: '', provider: '', model: '', roles: [] };
    const _autoP = s.key ? (detectProvider(s.key) ?? '') : '';
    const _pName = _autoP ? getProviderDisplayName(_autoP) : '';
    const _provOpts = _ALL_PROVS.map(([v,n]) => `<option value="${v}"${s.provider===v?' selected':''}>${n}</option>`).join('');
    const el = document.createElement('div'); el.className = 'fb-slot';
    el.style.cssText = 'border:1px solid var(--bdr);border-radius:4px;margin-bottom:6px;overflow:hidden';
    const summaryText = s.key ? (_pName || s.provider || '?') + (s.model ? ' / ' + s.model : '') : 'Not configured';
    el.innerHTML = `<div class="fb-slot-head" style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--sur);cursor:pointer;user-select:none"><input type="checkbox" class="fb-toggle-inp" ${s.enabled?'checked':''} style="cursor:pointer;accent-color:var(--acc);flex-shrink:0"><span style="font-size:11px;color:var(--acc);font-weight:700;flex-shrink:0">Slot ${i+1}</span><span class="fb-slot-summary" style="flex:1;font-size:10px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${summaryText}</span><span class="fb-expand-icon" style="font-size:9px;color:var(--dim);transition:transform .2s">${s.enabled?'▼':'▶'}</span></div>
    <div class="fb-slot-body" style="display:${s.enabled?'block':'none'};padding:10px;background:var(--bg)">
      <div class="field" style="margin-bottom:8px"><label class="field-label">API Key</label><div class="pw-wrapper"><input class="field-input fb-key" type="password" value="${s.key.replace(/"/g,'&quot;')}" placeholder="Any supported API key"><button class="fb-pw-toggle" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);cursor:pointer;color:var(--dim);font-size:14px;background:none;border:none;padding:0">👁</button></div><div style="display:flex;align-items:center;gap:8px;margin-top:4px"><div class="fb-badge" style="font-size:10px;color:var(--pos);flex:1;${_autoP&&s.key?'':'display:none'}">${_autoP&&s.key?'✓ Detected: '+_pName:''}</div><button class="fb-test-btn" type="button" style="font-size:10px;padding:3px 10px;flex-shrink:0;background:transparent;border:1px solid var(--bdr);border-radius:3px;cursor:pointer;color:var(--dim);font-family:inherit">Test</button></div><div class="fb-test-result" style="font-size:10px;margin-top:3px;display:none"></div></div>
      <div style="margin-bottom:8px"><label class="field-label">Provider</label><select class="field-input fb-provider" style="font-size:12px;margin-bottom:6px"><option value="">Auto-detect</option>${_provOpts}</select><label class="field-label">Model</label><div style="display:flex;gap:4px;margin-bottom:4px"><select class="field-input fb-model-list" style="flex:1;font-size:11px"><option value="">— provider default —</option>${s.model?`<option value="${s.model.replace(/"/g,'&quot;')}" selected>${s.model}</option>`:''}</select><button class="fb-discover-btn" type="button" style="padding:0 10px;height:36px;font-size:12px;background:transparent;border:1px solid var(--bdr);border-radius:3px;cursor:pointer;color:var(--dim);font-family:inherit;white-space:nowrap">↻</button></div><input class="field-input fb-model" value="${s.model.replace(/"/g,'&quot;')}" placeholder="Override: exact model id (optional)" style="font-size:11px"></div>
      <div style="font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px">Roles</div>
      <div style="display:flex;gap:12px;flex-wrap:wrap"><label style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--dim);cursor:pointer"><input type="checkbox" class="fb-role" value="narrator" ${(s.roles??[]).includes('narrator')?'checked':''} style="accent-color:var(--acc)"> Narrator</label><label style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--dim);cursor:pointer"><input type="checkbox" class="fb-role" value="classifier" ${(s.roles??[]).includes('classifier')?'checked':''} style="accent-color:var(--acc)"> Classifier</label><label style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--dim);cursor:pointer"><input type="checkbox" class="fb-role" value="enricher" ${(s.roles??[]).includes('enricher')?'checked':''} style="accent-color:var(--acc)"> Enricher</label></div>
    </div>`;
    el.querySelector('.fb-slot-head').addEventListener('click', ev => { if (ev.target.tagName === 'INPUT') return; const body = el.querySelector('.fb-slot-body'); const icon = el.querySelector('.fb-expand-icon'); const open = body.style.display !== 'none'; body.style.display = open ? 'none' : 'block'; icon.textContent = open ? '▶' : '▼'; });
    el.querySelector('.fb-toggle-inp').addEventListener('change', ev => { const body = el.querySelector('.fb-slot-body'); const icon = el.querySelector('.fb-expand-icon'); body.style.display = ev.target.checked ? 'block' : 'none'; icon.textContent = ev.target.checked ? '▼' : '▶'; });
    el.querySelector('.fb-key').addEventListener('input', function() { const badge = el.querySelector('.fb-badge'); const auto = detectProvider(this.value.trim()); const pn = auto ? getProviderDisplayName(auto) : ''; badge.textContent = auto ? '✓ Detected: ' + pn : ''; badge.style.display = (auto && this.value.trim()) ? 'block' : 'none'; const provSel = el.querySelector('.fb-provider'); if (auto && !provSel.value) provSel.value = auto; });
    el.querySelector('.fb-pw-toggle').addEventListener('click', function() { const inp = el.querySelector('.fb-key'); inp.type = inp.type === 'password' ? 'text' : 'password'; this.textContent = inp.type === 'password' ? '👁' : '🙈'; });
    el.querySelector('.fb-test-btn').addEventListener('click', async function() { const key = el.querySelector('.fb-key').value.trim(); const provSel = el.querySelector('.fb-provider').value.trim(); const autoP = detectProvider(key); const provider = provSel || autoP; const resultEl = el.querySelector('.fb-test-result'); resultEl.style.display = 'block'; if (!key) { resultEl.textContent = '⚠ Enter a key first'; resultEl.style.color = 'var(--low)'; return; } if (!provider) { resultEl.textContent = '⚠ Select provider'; resultEl.style.color = 'var(--low)'; return; } resultEl.textContent = 'Testing…'; resultEl.style.color = 'var(--dim)'; try { const reply = await _providerDispatchChat(provider, key, null, [{ role: 'user', content: 'Reply with the single word: OK' }], 20, 8000); resultEl.textContent = reply?.length ? `✓ Works — ${getProviderDisplayName(provider)}` : '⚠ Empty response'; resultEl.style.color = reply?.length ? 'var(--pos)' : 'var(--low)'; } catch(e) { resultEl.textContent = `✗ ${e.message.slice(0,80)}`; resultEl.style.color = 'var(--crit)'; } });
    el.querySelector('.fb-discover-btn').addEventListener('click', async function() { const key = el.querySelector('.fb-key').value.trim(); const provSel = el.querySelector('.fb-provider').value.trim(); const autoP = detectProvider(key); const provider = provSel || autoP; const listEl2 = el.querySelector('.fb-model-list'); if (!key || !provider) { listEl2.innerHTML = '<option value="">Enter key + provider first</option>'; return; } listEl2.innerHTML = '<option value="">Discovering…</option>'; const models = await fetchModels(provider, key).catch(() => []); if (!models.length) { listEl2.innerHTML = '<option value="">No models found</option>'; return; } const current = el.querySelector('.fb-model').value.trim(); listEl2.innerHTML = '<option value="">— provider default —</option>' + models.slice(0,100).map(m => `<option value="${m}"${m===current?' selected':''}>${m}</option>`).join(''); });
    el.querySelector('.fb-model-list').addEventListener('change', function() { if (this.value) el.querySelector('.fb-model').value = this.value; });
    container.appendChild(el);
  }
}

// ── SETTINGS MODAL INIT ────────────────────────────────────────────────────────
// Preferences state is now managed by initPreferences()

export function initSettings(closeMenuFn) {
  document.getElementById('k-custom-baseurl')?.addEventListener('input', _updateCustomBaseUrlRow);
  document.getElementById('btn-settings').addEventListener('click', () => {
    closeMenuFn();
    document.getElementById('modal').classList.add('open');
    document.getElementById('k-quickstart').value      = '';
    document.getElementById('k-narrator').value        = localStorage.getItem('NARRATOR_KEY') ?? '';
    document.getElementById('k-narrator-model').value  = localStorage.getItem('NARRATOR_MODEL') ?? '';
    document.getElementById('k-narrator-provider').value = localStorage.getItem('NARRATOR_PROVIDER') ?? '';
    document.getElementById('k-classifier').value      = localStorage.getItem('CLASSIFIER_KEY') ?? '';
    document.getElementById('k-classifier-model').value = localStorage.getItem('CLASSIFIER_MODEL') ?? '';
    document.getElementById('k-classifier-provider').value = localStorage.getItem('CLASSIFIER_PROVIDER') ?? '';
    document.getElementById('k-custom-baseurl').value  = localStorage.getItem('CUSTOM_BASE_URL') ?? '';
    document.getElementById('k-grok').value            = localStorage.getItem('GROK_API_KEY') ?? '';
    document.getElementById('k-gem').value             = localStorage.getItem('GEMINI_API_KEY') ?? '';
    document.getElementById('k-or').value              = localStorage.getItem('OPENROUTER_API_KEY') ?? '';
    document.getElementById('k-groq').value            = localStorage.getItem('GROQ_API_KEY') ?? '';
    document.getElementById('k-sb-url').value          = localStorage.getItem('SUPABASE_URL') ?? '';
    document.getElementById('k-sb-key').value          = localStorage.getItem('SUPABASE_ANON_KEY') ?? '';
    document.getElementById('k-enricher').value        = localStorage.getItem('ENRICHER_KEY') ?? '';
    document.getElementById('k-enricher-model').value  = localStorage.getItem('ENRICHER_MODEL') ?? '';
    document.getElementById('k-enricher-provider').value = localStorage.getItem('ENRICHER_PROVIDER') ?? '';
    document.getElementById('auth-status').textContent = '';
    ['quickstart','narrator','classifier','enricher'].forEach(_wireSlot);
    _seedModelList('narrator'); _seedModelList('classifier'); _seedModelList('enricher');
    ['quickstart','narrator','classifier','enricher'].forEach(_updateSlotDetection);
    _updateMutualExclusion();
    _renderFallbackSlots();
  });
  [document.getElementById('btn-mcancel'), document.getElementById('btn-mcancel2')].forEach(b => b?.addEventListener('click', () => document.getElementById('modal').classList.remove('open')));
  document.getElementById('modal').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('open'); });
  document.getElementById('btn-msave').addEventListener('click', () => {
    const _sv = id => document.getElementById(id)?.value?.trim() ?? '';
    const _set = (k, v) => v ? localStorage.setItem(k, v) : localStorage.removeItem(k);
    const _qs = _sv('k-quickstart');
    _set('NARRATOR_KEY',        _qs || _sv('k-narrator'));
    _set('NARRATOR_MODEL',      _sv('k-narrator-model') || _sv('k-narrator-model-list'));
    _set('NARRATOR_PROVIDER',   _sv('k-narrator-provider'));
    _set('CLASSIFIER_KEY',      _qs || _sv('k-classifier'));
    _set('CLASSIFIER_MODEL',    _sv('k-classifier-model') || _sv('k-classifier-model-list'));
    _set('CLASSIFIER_PROVIDER', _sv('k-classifier-provider'));
    _set('CUSTOM_BASE_URL',     _sv('k-custom-baseurl'));
    localStorage.setItem('GROK_API_KEY',       _sv('k-grok'));
    localStorage.setItem('GEMINI_API_KEY',     _sv('k-gem'));
    localStorage.setItem('OPENROUTER_API_KEY', _sv('k-or'));
    localStorage.setItem('GROQ_API_KEY',       _sv('k-groq'));
    localStorage.setItem('SUPABASE_URL',       _sv('k-sb-url'));
    localStorage.setItem('SUPABASE_ANON_KEY',  _sv('k-sb-key'));
    _set('ENRICHER_KEY',      _sv('k-enricher'));
    _set('ENRICHER_MODEL',    _sv('k-enricher-model') || _sv('k-enricher-model-list'));
    _set('ENRICHER_PROVIDER', _sv('k-enricher-provider'));
    _saveFallbackSlots();
    const su = localStorage.getItem('SUPABASE_URL'), sk = localStorage.getItem('SUPABASE_ANON_KEY');
    if (su && sk && window.supabase) { S._sbClient = window.supabase.createClient(su, sk); setSupabaseClient(S._sbClient); }
    document.getElementById('modal').classList.remove('open');
    setStatus('Settings saved.');
    if (S.WS) renderAll();
  });
  document.querySelectorAll('.pw-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const inp = document.getElementById(btn.dataset.target); if (!inp) return;
      inp.type = inp.type === 'password' ? 'text' : 'password';
      btn.textContent = inp.type === 'password' ? '👁' : '🙈';
    });
  });
  // API Key test buttons
  ['quickstart','narrator','classifier','enricher'].forEach(prefix => {
    document.getElementById(`k-${prefix}-test`)?.addEventListener('click', () => {
      _testApiKey(document.getElementById(`k-${prefix}`)?.value?.trim() ?? '', prefix);
    });
  });
}

async function _testApiKey(keyVal, prefix) {
  const resEl = document.getElementById(`k-${prefix}-test-result`); if (!resEl) return;
  resEl.style.display = 'block'; resEl.style.color = 'var(--dim)'; resEl.textContent = 'Testing…';
  if (!keyVal) { resEl.textContent = '⚠ Paste a key first'; resEl.style.color = 'var(--low)'; return; }
  const providerOverride = document.getElementById(`k-${prefix}-provider`)?.value?.trim();
  const provider = providerOverride || detectProvider(keyVal);
  if (!provider) { resEl.textContent = '⚠ Unrecognized key prefix — choose a provider first'; resEl.style.color = 'var(--low)'; return; }
  try {
    const reply = await _providerDispatchChat(provider, keyVal, null, [{ role: 'user', content: 'Reply with the single word: OK' }], 20, 8000);
    if (reply && reply.length > 0) { resEl.textContent = `✓ Key works — ${getProviderDisplayName(provider)} responded`; resEl.style.color = 'var(--pos)'; }
    else { resEl.textContent = '⚠ Key returned empty response'; resEl.style.color = 'var(--low)'; }
  } catch (e) { resEl.textContent = `✗ ${e.message.slice(0,100)}`; resEl.style.color = 'var(--crit)'; }
}

// ── SUPABASE AUTH ──────────────────────────────────────────────────────────────
export function initSupabaseAuth() {
  document.getElementById('btn-login-link').addEventListener('click', async () => {
    const email = document.getElementById('k-email').value.trim();
    const status = document.getElementById('auth-status');
    if (!email) { status.textContent = 'Enter an email first.'; return; }
    const su = localStorage.getItem('SUPABASE_URL'), sk = localStorage.getItem('SUPABASE_ANON_KEY');
    if (!su || !sk || !window.supabase) { status.textContent = 'Save Supabase keys first.'; return; }
    if (!S._sbClient) S._sbClient = window.supabase.createClient(su, sk);
    const { error } = await S._sbClient.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.href.split('#')[0] } });
    status.textContent = error ? `Error: ${error.message}` : `Link sent to ${email}`;
  });
}

// ── LOAD MODAL ─────────────────────────────────────────────────────────────────
export function initLoadModal(imageLoadFn) {
  document.getElementById('btn-load').addEventListener('click', async () => {
    const statusEl = document.getElementById('load-status');
    const listEl   = document.getElementById('save-list');
    listEl.innerHTML = ''; statusEl.textContent = 'Loading saves...';
    document.getElementById('load-modal').classList.add('open');
    try {
      const saves = await listSaves();
      if (!saves.length) {
        listEl.innerHTML = '<p class="empty">No saves found. Start a new game first.</p>';
        document.getElementById('btn-load-confirm').disabled = true;
      } else {
        document.getElementById('btn-load-confirm').disabled = false;
        listEl.innerHTML = saves.map(s => {
          const d = new Date(s.timestamp);
          return `<div class="log-entry" data-id="${s.id}"><span class="log-turn">T${s.state.turn}</span><span class="log-text">${s.state.player.name} — ${d.toLocaleString()}</span><button class="btn-delete-save" data-id="${s.id}" style="margin-left:auto;padding:2px 6px;font-size:10px;background:none;border:1px solid var(--bdr);color:var(--dim);cursor:pointer;border-radius:3px;flex-shrink:0">✕</button></div>`;
        }).join('');
        listEl.querySelectorAll('.log-entry').forEach(el => {
          el.addEventListener('click', e => {
            if (e.target.classList.contains('btn-delete-save')) return;
            listEl.querySelectorAll('.log-entry').forEach(x => x.style.background = '');
            el.style.background = 'var(--sur2)'; el.dataset.selected = 'true';
          });
        });
        listEl.querySelectorAll('.btn-delete-save').forEach(btn => {
          btn.addEventListener('click', async e => {
            e.stopPropagation();
            if (!confirm('Delete this save? Cannot be undone.')) return;
            await deleteSave(parseInt(btn.dataset.id)).catch(() => {});
            btn.parentElement.remove();
            if (!listEl.children.length) { listEl.innerHTML = '<p class="empty">No saves found.</p>'; document.getElementById('btn-load-confirm').disabled = true; }
            statusEl.textContent = 'Save deleted.';
          });
        });
        statusEl.textContent = `${saves.length} save${saves.length > 1 ? 's' : ''} found.`;
      }
    } catch(e) { statusEl.textContent = 'Error: ' + e.message; }
  });
  [document.getElementById('btn-load-cancel'), document.getElementById('btn-load-cancel2')].forEach(b => {
    b?.addEventListener('click', () => document.getElementById('load-modal').classList.remove('open'));
  });
  document.getElementById('load-modal').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('open'); });
  document.getElementById('btn-load-confirm').addEventListener('click', async () => {
    const listEl   = document.getElementById('save-list');
    const statusEl = document.getElementById('load-status');
    const selected = listEl.querySelector('[data-selected="true"]');
    if (!selected) { statusEl.textContent = 'Select a save first.'; return; }
    const id = parseInt(selected.dataset.id);
    document.getElementById('load-modal').classList.remove('open');
    try {
      setStatus('Loading…', 'load');
      S.WS = await loadWorldState(id);
      if (!S.WS) { setStatus('Load failed — save not found.', 'err'); return; }
      resetConvId();
      if (imageLoadFn) await imageLoadFn().catch(() => {});
      loadConsoleHistoryForCurrentSave(id).catch(() => {});
      document.getElementById('feed').innerHTML = '';
      renderAll();
      const saved = await loadNarrations(50, id);
      const feed  = document.getElementById('feed');
      if (saved.length) {
        for (const n of saved) {
          const a = renderTurnAnchor(n.turn, n.data?.simTime ?? n.timestamp, n.data?.location ?? '');
          renderNarration(n.description, a, feed, n.turn);
        }
        feed.scrollTop = feed.scrollHeight;
        const history = [];
        for (const n of saved.slice(-3)) {
          history.push({ role: 'user',      content: `[turn ${n.turn} context restored]` });
          history.push({ role: 'assistant', content: n.description });
        }
        setConversationHistory(history);
      }
      setStatus(`Turn ${S.WS.turn} · ${S.WS.player.name}`);
    } catch(e) { setStatus('Load error: ' + e.message, 'err'); console.error('[load confirm]', e); }
  });
}

// ── PREFERENCES MODAL ─────────────────────────────────────────────────────────
let _prefContentExplicit = localStorage.getItem('CONTENT_MODE') !== 'filtered';
let _prefTimeFormat24h   = localStorage.getItem('TIME_FORMAT_24H') === '1';

export function initPreferences(closeMenuFn) {
  document.getElementById('btn-preferences')?.addEventListener('click', () => {
    closeMenuFn();
    document.getElementById('modal-preferences').classList.add('open');
    document.getElementById('pref-locale').value    = localStorage.getItem('LOCALE')           ?? 'Philippines';
    document.getElementById('pref-language').value  = localStorage.getItem('LANGUAGE')         ?? 'Tagalog';
    document.getElementById('pref-currency').value  = localStorage.getItem('CURRENCY_SYMBOL')  ?? '';
    document.getElementById('pref-lorebook').value  = localStorage.getItem('LOREBOOK')         ?? '';
    _prefContentExplicit = localStorage.getItem('CONTENT_MODE') !== 'filtered';
    _prefTimeFormat24h   = localStorage.getItem('TIME_FORMAT_24H') === '1';
    document.getElementById('pref-content-mode-tog')?.classList.toggle('on', _prefContentExplicit);
    document.getElementById('pref-time-format-tog')?.classList.toggle('on', _prefTimeFormat24h);
  });

  document.getElementById('pref-content-mode')?.addEventListener('click', () => {
    _prefContentExplicit = !_prefContentExplicit;
    document.getElementById('pref-content-mode-tog')?.classList.toggle('on', _prefContentExplicit);
  });

  document.getElementById('pref-time-format')?.addEventListener('click', () => {
    _prefTimeFormat24h = !_prefTimeFormat24h;
    document.getElementById('pref-time-format-tog')?.classList.toggle('on', _prefTimeFormat24h);
  });

  [document.getElementById('btn-pref-cancel'), document.getElementById('btn-pref-cancel2')]
    .forEach(b => b?.addEventListener('click', () => document.getElementById('modal-preferences').classList.remove('open')));

  document.getElementById('modal-preferences')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) e.currentTarget.classList.remove('open');
  });

  document.getElementById('btn-pref-save')?.addEventListener('click', () => {
    const _sv = id => document.getElementById(id)?.value?.trim() ?? '';
    localStorage.setItem('LOCALE',   _sv('pref-locale')   || 'Philippines');
    localStorage.setItem('LANGUAGE', _sv('pref-language') || 'Tagalog');
    const _cur = _sv('pref-currency');
    if (_cur) localStorage.setItem('CURRENCY_SYMBOL', _cur); else localStorage.removeItem('CURRENCY_SYMBOL');
    const _newLb = document.getElementById('pref-lorebook')?.value ?? '';
    localStorage.setItem('LOREBOOK', _newLb);
    localStorage.removeItem('LOREBOOK_COMPRESSED');
    if (_newLb.trim() && S.WS?.player?.name) {
      compressLorebook(_newLb, S.WS.player.name, Object.values(S.WS?.npcs ?? {}).map(n => n.name).filter(Boolean)).catch(() => {});
    }
    localStorage.setItem('CONTENT_MODE', _prefContentExplicit ? 'explicit' : 'filtered');
    if (_prefTimeFormat24h) localStorage.setItem('TIME_FORMAT_24H', '1');
    else localStorage.removeItem('TIME_FORMAT_24H');
    document.getElementById('modal-preferences').classList.remove('open');
    setStatus('Preferences saved.');
    if (S.WS) renderAll();
  });
}