// popup-modules/client-knowledge.js (3.12.0)
// Wires the Clients & Knowledge UI: header chip, picker modal, per-client
// detail modal with entries CRUD, export/import. Talks to background via
// chrome.runtime.sendMessage with action: 'client_*'.
//
// Dependencies: ui-common.js (showToast, sanitizeHtml/escapeHtml).

// ---------- Defensive helpers ----------
function _on(id, ev, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener(ev, fn);
}
function _set(id, prop, value) {
  const el = document.getElementById(id);
  if (el) el[prop] = value;
}
function _get(id) { return document.getElementById(id); }
function _safeEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>'"]/g, (char) => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return char;
    }
  });
}

function _hasLastError() {
  return typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null && chrome.runtime.lastError;
}

function _getLastErrorMessage() {
  if (!_hasLastError()) return '';
  const err = chrome.runtime.lastError;
  if (typeof err === 'object' && err !== null && typeof err.message === 'string') return err.message;
  return String(err || '');
}

// ---------- State ----------
let _editingClientId = null;
 
let _activeClientCache = null;

// ---------- Backend calls ----------
function _send(action, body) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action, ...(body || {}) }, (res) => {
      if (_hasLastError()) {
        resolve({ ok: false, error: getErrorMessage(chrome.runtime.lastError) || 'Unknown error' });
        return;
      }
      resolve(res || { ok: false, error: 'No response' });
    });
  });
}

// ---------- Header chip ----------
async function refreshHeaderChip() {
  try {
    const chip = _get('clientChip');
    const name = _get('clientChipName');
    if (!chip || !name) return;
    const res = await _send('client_get_active');
    const active = res && res.data;
    _activeClientCache = active || null;
    if (active && active.displayName) {
      name.textContent = active.displayName;
      chip.style.color = 'var(--accent-primary, #4caf50)';
      chip.style.borderColor = 'var(--accent-primary, #4caf50)';
      chip.title = `Active client: ${active.displayName}. ${(active.entries || []).length} knowledge entries. Click to switch.`;
    } else {
      name.textContent = 'none';
      chip.style.color = 'var(--text-secondary, #aaa)';
      chip.style.borderColor = 'var(--border-color, rgba(255,255,255,0.15))';
      chip.title = 'No active client. Click to set one.';
    }
  } catch (err) {
    console.error('[client-knowledge] refreshHeaderChip error:', getErrorMessage(err));
  }
}

// ---------- Picker modal ----------
async function openClientModal() {
  try {
    await refreshClientPicker();
    await refreshClientList();
    const modal = _get('client-modal');
    if (modal) modal.classList.add('show');
  } catch (err) {
    console.error('[client-knowledge] openClientModal error:', getErrorMessage(err));
  }
}
function closeClientModal() {
  const modal = _get('client-modal');
  if (modal) modal.classList.remove('show');
}

async function refreshClientPicker() {
  try {
    const sel = _get('clientActivePicker');
    if (!sel) return;
    const [listRes, activeRes] = await Promise.all([_send('client_list'), _send('client_get_active')]);
    const list = (listRes && listRes.data) || [];
    const active = activeRes && activeRes.data;
    sel.innerHTML = '<option value="">— No client (default behavior) —</option>'
      + list.map(c => {
        const entryCount = (c.entries || []).length; // Cache to avoid repeated property access
        return `<option value="${_safeEsc(c.id)}" ${active && active.id === c.id ? 'selected' : ''}>${_safeEsc(c.displayName)} (${entryCount} entries)</option>`;
      }).join('');
  } catch (err) {
    console.error('[client-knowledge] refreshClientPicker error:', getErrorMessage(err));
  }
}

async function refreshClientList() {
  try {
    const container = _get('clientList');
    if (!container) return;
    const res = await _send('client_list');
    const list = (res && res.data) || [];
    if (!list.length) {
      container.innerHTML = '<div style="text-align:center; color:var(--text-tertiary); font-size:13px; padding:24px;">No clients yet. Add your first one above.</div>';
      return;
    }
    container.innerHTML = list.map(c => {
      const entryCount = (c.entries || []).length; // Cache to avoid repeated property access
      return `
      <div class="template-card" data-client-id="${_safeEsc(c.id)}" style="margin-bottom:8px;">
        <div class="template-card-header">
          <div class="template-card-name">${_safeEsc(c.displayName)}</div>
          <div class="template-card-actions">
            <button class="small-btn" data-action="open" data-id="${_safeEsc(c.id)}">Manage</button>
            <button class="small-btn" data-action="export" data-id="${_safeEsc(c.id)}">Export</button>
            <button class="small-btn" data-action="delete" data-id="${_safeEsc(c.id)}" style="color:var(--error-color);">Delete</button>
          </div>
        </div>
        <div class="template-card-meta" style="margin-top:4px;">
          <span>${entryCount} entries</span>
          <span>Runs: ${c.runCount || 0}</span>
          ${c.tenant ? `<span title="Linked tenant">${_safeEsc(c.tenant)}</span>` : ''}
        </div>
      </div>
    `;}).join('');
    container.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        const id = btn.dataset.id;
        try {
          if (action === 'open') {
            closeClientModal();
            await openClientDetailModal(id);
          } else if (action === 'export') {
            await exportClientToFile(id);
          } else if (action === 'delete') {
            const c = list.find(x => x.id === id);
            if (!confirm(`Delete client "${c ? c.displayName : id}" and all its knowledge entries? This cannot be undone.`)) return;
            const res = await _send('client_delete', { id });
            if (res.ok) {
              await refreshClientPicker();
              await refreshClientList();
              await refreshHeaderChip();
              try { window.showToast && showToast('Client deleted', 'success'); } catch { /* showToast may fail in detached popup */ }
            } else {
              alert(res.error || 'Delete failed');
            }
          }
        } catch (err) {
          console.error('[client-knowledge] action error:', getErrorMessage(err));
          alert(`Action failed: ${getErrorMessage(err)}`);
        }
      });
    });
  } catch (err) {
    console.error('[client-knowledge] refreshClientList error:', getErrorMessage(err));
  }
}

// ---------- Detail modal (per-client entries) ----------
async function openClientDetailModal(clientId) {
  try {
    const res = await _send('client_get', { id: clientId });
    if (!res.ok || !res.data) {
      alert(res.error || 'Client not found');
      return;
    }
    _editingClientId = clientId;
    const c = res.data;
    _set('clientDetailTitle', 'textContent', c.displayName);
    _set('clientDetailNameInput', 'value', c.displayName || '');
    _set('clientDetailTenantInput', 'value', c.tenant || '');
    _set('clientEntryWisdomInput', 'value', '');
    _set('clientEntryUrlPatternInput', 'value', '');
    const scopeSel = _get('clientEntryScopeSelect');
    if (scopeSel) scopeSel.value = 'global';
    _toggleUrlPatternVisibility();
    await refreshEntriesList(clientId);
    const modal = _get('client-detail-modal');
    if (modal) modal.classList.add('show');
  } catch (err) {
    console.error('[client-knowledge] openClientDetailModal error:', err);
  }
}
function closeClientDetailModal() {
  _editingClientId = null;
  const modal = _get('client-detail-modal');
  if (modal) modal.classList.remove('show');
}

async function refreshEntriesList(clientId) {
  try {
    const container = _get('clientEntriesList');
    if (!container) return;
    const res = await _send('client_get', { id: clientId });
    const c = res && res.data;
    if (!c || !Array.isArray(c.entries) || !c.entries.length) {
      container.innerHTML = '<div style="text-align:center; color:var(--text-tertiary); font-size:13px; padding:24px;">No knowledge yet for this client. Add an entry above as you learn things during runs.</div>';
      return;
    }
    container.innerHTML = c.entries.map(e => `
      <div style="background:var(--bg-secondary); border:1px solid var(--border-color); border-radius:6px; padding:10px; margin-bottom:8px;">
        <div style="display:flex; gap:8px; align-items:flex-start; justify-content:space-between;">
          <div style="flex:1;">
            <div style="font-size:13px; color:var(--text-primary); line-height:1.5;">${_safeEsc(e.wisdom)}</div>
            <div style="font-size:11px; color:var(--text-tertiary); margin-top:6px; display:flex; gap:8px;">
              <span>${e.scope === 'url' ? `URL: <code>${_safeEsc(e.urlPattern || '*')}</code>` : 'Always applies'}</span>
              <span>Used ${e.useCount || 0}x</span>
            </div>
          </div>
          <button class="small-btn" data-entry-action="delete" data-entry-id="${_safeEsc(e.id)}" style="color:var(--error-color); flex-shrink:0;">×</button>
        </div>
      </div>
    `).join('');
    container.querySelectorAll('[data-entry-action="delete"]').forEach(btn => {
      const capturedClientId = _editingClientId;
      btn.addEventListener('click', async () => {
        try {
          const entryId = btn.dataset.entryId;
          const r = await _send('client_entry_delete', { clientId: capturedClientId, entryId });
          if (r.ok) {
            await refreshEntriesList(capturedClientId);
            await refreshClientList();
          } else {
            alert(r.error || 'Delete failed');
          }
        } catch (err) {
          console.error('[client-knowledge] entry delete error:', err);
        }
      });
    });
  } catch (err) {
    console.error('[client-knowledge] refreshEntriesList error:', err);
  }
}

function _toggleUrlPatternVisibility() {
  const sel = _get('clientEntryScopeSelect');
  const inp = _get('clientEntryUrlPatternInput');
  if (!sel || !inp) return;
  inp.style.display = sel.value === 'url' ? '' : 'none';
}

// ---------- Export / Import ----------
async function exportClientToFile(clientId) {
  try {
    const res = await _send('client_export', { id: clientId });
    if (!res.ok || !res.data) {
      alert(res.error || 'Export failed');
      return;
    }
    const json = JSON.stringify(res.data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const clientName = (res.data.client && res.data.client.displayName);
    const safeName = (typeof clientName === 'string' ? clientName : 'client').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    a.download = `sentinel-client-${safeName}.json`;
    if (document.body) document.body.appendChild(a);
    a.click();
    if (document.body) document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (err) {
    const errMsg = getErrorMessage(err);
    console.error('[client-knowledge] exportClientToFile error:', errMsg);
    alert(`Export failed: ${errMsg}`);
  }
}

function importClientFromFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async (e) => {
    const file = e.target.files && e.target.files.length && e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const res = await _send('client_import', { payload });
      if (res.ok) {
        await refreshClientPicker();
        await refreshClientList();
        try { window.showToast && showToast(`Client imported: ${(res.data && (res.data.displayName || (res.data.client && res.data.client.displayName))) || 'client'}`, 'success'); } catch { /* showToast may fail in detached popup */ }
      } else {
        alert(res.error || 'Import failed');
      }
    } catch (err) {
      const errorMsg = getErrorMessage(err);
      // Distinguish between file read errors and JSON parse errors
      const prefix = errorMsg && errorMsg.includes('JSON') ? 'Invalid JSON file' : 'Import failed';
      alert(`${prefix}: ${errorMsg}`);
    }
  };
  input.click();
}

// ---------- Wiring ----------
_on('clientChip', 'click', () => openClientModal());
_on('closeClientModalBtn', 'click', () => closeClientModal());
_on('closeClientDetailBtn', 'click', () => closeClientDetailModal());
_on('clientImportBtn', 'click', () => importClientFromFile());

_on('clientActivePicker', 'change', async () => {
  try {
    const sel = _get('clientActivePicker');
    if (!sel) return;
    const id = sel.value || null;
    await _send('client_set_active', { id });
    await refreshHeaderChip();
  } catch (err) {
    console.error('[client-knowledge] active picker change error:', err);
  }
});

_on('clientAddBtn', 'click', async () => {
  try {
    const inp = _get('clientNewNameInput');
    if (!inp) return;
    const name = inp.value.trim();
    if (!name) { try { window.showToast && showToast('Enter a client name', 'error'); } catch { /* showToast may fail in detached popup */ } return; }
    const res = await _send('client_create', { client: { displayName: name } });
    if (res.ok) {
      inp.value = '';
      await refreshClientPicker();
      await refreshClientList();
    } else {
      alert(res.error || 'Create failed');
    }
  } catch (err) {
    console.error('[client-knowledge] add client error:', err);
    alert(`Create failed: ${getErrorMessage(err)}`);
  }
});

_on('clientDetailSaveBtn', 'click', async () => {
  try {
    if (!_editingClientId) return;
    const name = (_get('clientDetailNameInput') || {}).value || '';
    const tenant = (_get('clientDetailTenantInput') || {}).value || '';
    const res = await _send('client_update', { id: _editingClientId, updates: { displayName: name, tenant } });
    if (res.ok) {
      _set('clientDetailTitle', 'textContent', name);
      await refreshClientList();
      await refreshHeaderChip();
      try { window.showToast && showToast('Saved', 'success'); } catch { /* showToast may fail in detached popup */ }
    } else {
      alert(res.error || 'Save failed');
    }
  } catch (err) {
    console.error('[client-knowledge] save client error:', err);
    alert(`Save failed: ${getErrorMessage(err)}`);
  }
});

_on('clientDetailDeleteBtn', 'click', async () => {
  try {
    if (!_editingClientId) return;
    if (!confirm('Delete this client and ALL its knowledge entries? Cannot be undone.')) return;
    const res = await _send('client_delete', { id: _editingClientId });
    if (res.ok) {
      closeClientDetailModal();
      await refreshClientPicker();
      await refreshClientList();
      await refreshHeaderChip();
    } else {
      alert(res.error || 'Delete failed');
    }
  } catch (err) {
    console.error('[client-knowledge] delete client error:', err);
    alert(`Delete failed: ${getErrorMessage(err)}`);
  }
});

_on('clientDetailExportBtn', 'click', async () => {
  if (_editingClientId) await exportClientToFile(_editingClientId);
});

_on('clientEntryScopeSelect', 'change', _toggleUrlPatternVisibility);

_on('clientEntryAddBtn', 'click', async () => {
  try {
    if (!_editingClientId) return;
    const wisdom = (_get('clientEntryWisdomInput') || {}).value || '';
    const scope = (_get('clientEntryScopeSelect') || {}).value || 'global';
    const urlPattern = (_get('clientEntryUrlPatternInput') || {}).value || '';
    if (!wisdom.trim()) { try { window.showToast && showToast('Enter what you learned', 'error'); } catch { /* showToast may fail in detached popup */ } return; }
    const res = await _send('client_entry_add', { clientId: _editingClientId, entry: { wisdom, scope, urlPattern } });
    if (res.ok) {
      _set('clientEntryWisdomInput', 'value', '');
      _set('clientEntryUrlPatternInput', 'value', '');
      await refreshEntriesList(_editingClientId);
      await refreshClientList();
      try { window.showToast && showToast('Knowledge saved', 'success'); } catch { /* showToast may fail in detached popup */ }
    } else {
      alert(res.error || 'Add failed');
    }
  } catch (err) {
    console.error('[client-knowledge] add entry error:', err);
    alert(`Add failed: ${getErrorMessage(err)}`);
  }
});

// ---------- Init ----------
refreshHeaderChip();
