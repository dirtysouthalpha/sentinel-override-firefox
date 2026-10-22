// popup-modules/templates.js
// Template library UI: list, search, filter, create, edit, run, delete.
// Depends on: ui-common.js (showToast, sanitizeHtml).
// Communicates with background via chrome.runtime.sendMessage (template_* actions).

// ========== Shared State ==========

// ========== Module-level State ==========
let editingTemplateId = null;
let runningTemplateId = null;

// Precompile regex for template parameter parsing (for performance)
const TEMPLATE_PARAM_RE = /:{2}(\w+):{2}/g;

// ========== Relative Time Helper ==========
// relativeTime is in window.Helpers (popup-modules/helpers.js)

// ========== Panel Toggle ==========
// Defensive: any of these elements being absent must not crash the popup.
function _setDisplay(id, value) {
  const el = document.getElementById(id);
  if (el) el.style.display = value;
}
function _toggleClass(id, cls, on) {
  const el = document.getElementById(id);
  if (el) el.classList[on ? 'add' : 'remove'](cls);
}

// ========== Helper Functions ==========
function _hasLastError() {
  return typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null && chrome.runtime.lastError;
}

function _getLastErrorMessage() {
  if (!_hasLastError()) return '';
  const err = chrome.runtime.lastError;
  if (typeof err === 'object' && err !== null && typeof err.message === 'string') return err.message;
  return String(err || '');
}

// eslint-disable-next-line no-unused-vars
function showTemplatesPanel() {
  _setDisplay('templates-panel', 'flex');
  _setDisplay('chat-container', 'none');
  _setDisplay('input-area', 'none');
  _toggleClass('templatesBtn', 'active', true);
  loadTemplates();
}

function hideTemplatesPanel() {
  _setDisplay('templates-panel', 'none');
  _setDisplay('chat-container', 'flex');
  _setDisplay('input-area', 'flex');
  _toggleClass('templatesBtn', 'active', false);
}

// ========== Template List ==========
function loadTemplates() {
  const searchEl = document.getElementById('templateSearchInput');
  const tagEl = document.getElementById('templateTagFilter');
  const searchTerm = searchEl ? searchEl.value.toLowerCase().trim() : '';
  const tagFilter = tagEl ? tagEl.value.toLowerCase().trim() : '';

  chrome.runtime.sendMessage({ action: 'template_list' }, (response) => {
    if (_hasLastError()) {
      showToast(_getLastErrorMessage() || 'Error loading templates', 'error');
      return;
    }

    const templates = response && response.ok && Array.isArray(response.data) ? response.data : [];
    const filtered = filterTemplates(templates, searchTerm, tagFilter);
    renderTemplateList(filtered);
  });
}

function filterTemplates(templates, searchTerm, tagFilter) {
  let result = templates;

  if (searchTerm) {
    result = result.filter(t =>
      t.name && typeof t.name === 'string' && t.name.toLowerCase().includes(searchTerm)
    );
  }

  if (tagFilter) {
    result = result.filter(t =>
      t.tags && Array.isArray(t.tags) && t.tags.some(tag =>
        typeof tag === 'string' && tag.toLowerCase().includes(tagFilter)
      )
    );
  }

  return result.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function renderTemplateList(templates) {
  const container = document.getElementById('template-list');
  if (!container) return;

  if (!templates || !templates.length) {
    container.innerHTML = '<div class="template-empty">No templates yet. Create one from a completed task or build one from scratch.</div>';
    return;
  }

  container.innerHTML = '';
  templates.forEach(template => {
    const card = document.createElement('div');
    card.className = 'template-card';

    const tagsHtml = (template.tags && template.tags.length)
      ? `<div class="template-card-tags">${template.tags.map(t => `<span class="template-tag">${escapeHtml(t)}</span>`).join('')}</div>`
      : '';

    card.innerHTML = `
      <div class="template-card-header">
        <div class="template-card-name">${escapeHtml(template.name)}</div>
        <div class="template-card-actions">
          <button class="small-btn" data-action="run" data-id="${escapeHtml(template.id)}" style="background:var(--accent-primary);color:white;border-color:var(--accent-primary);">Run</button>
          <button class="small-btn" data-action="edit" data-id="${escapeHtml(template.id)}">Edit</button>
          <button class="small-btn" data-action="export" data-id="${escapeHtml(template.id)}" data-name="${escapeHtml(template.name)}">Export</button>
          <button class="small-btn" data-action="delete" data-id="${escapeHtml(template.id)}" data-name="${escapeHtml(template.name)}" style="color:var(--error-color);">Delete</button>
        </div>
      </div>
      <div class="template-card-goal">${escapeHtml(template.goal)}</div>
      ${tagsHtml}
      <div class="template-card-meta">
        <span>Last used: ${relativeTime(template.lastUsedAt)}</span>
        <span>Runs: ${template.runCount || 0}</span>
        <span>${(function() { const pl = template.params && template.params.length || 0; return pl > 0 ? `${pl} param${pl > 1 ? 's' : ''}` : 'No params'; })()}</span>
      </div>
    `;

    // Wire card action buttons
    card.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        const id = btn.dataset.id;
        if (action === 'run') openRunModal(id);
        else if (action === 'edit') openEditTemplateModal(id);
        else if (action === 'export') window.exportTemplateFile?.(id);
        else if (action === 'delete') deleteTemplate(id, btn.dataset.name);
      });
    });

    container.appendChild(card);
  });
}

// ========== Search and Filter ==========
// Defensive: addEventListener on null would throw and abort the entire module.
function _on(id, ev, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener(ev, fn);
}
_on('templateSearchInput', 'input', () => loadTemplates());
_on('templateTagFilter', 'input', () => loadTemplates());

// ========== Create Template ==========
function openCreateTemplateModal(goalText) {
  editingTemplateId = null;
  const title = document.getElementById('template-modal-title');
  if (title) title.textContent = 'New Template';
  const nameInput = document.getElementById('tmpl-name');
  if (nameInput) nameInput.value = '';
  const goalInput = document.getElementById('tmpl-goal');
  if (goalInput) goalInput.value = goalText || '';
  const tagsInput = document.getElementById('tmpl-tags');
  if (tagsInput) tagsInput.value = '';
  const paramsContainer = document.getElementById('tmpl-params-container');
  if (paramsContainer) paramsContainer.innerHTML = '';
  document.getElementById('template-modal')?.classList.add('show');
  updateParamEditor();
}

function saveNewTemplate() {
  const nameEl = document.getElementById('tmpl-name');
  const goalEl = document.getElementById('tmpl-goal');
  const tagsEl = document.getElementById('tmpl-tags');
  const name = nameEl ? nameEl.value.trim() : '';
  const goal = goalEl ? goalEl.value.trim() : '';
  const tagsStr = tagsEl ? tagsEl.value.trim() : '';

  if (!name) {
    showToast('Template name is required', 'error');
    return;
  }
  if (!goal) {
    showToast('Template goal is required', 'error');
    return;
  }

  const tags = parseTags(tagsStr);
  const params = [];
  document.querySelectorAll('#tmpl-params-container input[data-param-key]').forEach(inp => {
    params.push({ key: inp.dataset.paramKey, defaultValue: inp.value });
  });

  chrome.runtime.sendMessage({
    action: 'template_save',
    template: { name, goal, tags, params }
  }, (response) => {
    if (_hasLastError()) {
      showToast(_getLastErrorMessage() || 'Error saving template', 'error');
      return;
    }
    if (response && response.error) {
      showToast(typeof response.error === 'string' ? response.error : String(response.error), 'error');
      return;
    }
    document.getElementById('template-modal')?.classList.remove('show');
    loadTemplates();
    showToast('Template saved', 'success');
  });
}

function parseTags(tagString) {
  if (!tagString) return [];
  return tagString.split(',')
    .map(t => t.trim())
    .filter(t => t.length);
}

// ========== Edit Template ==========
function openEditTemplateModal(templateId) {
  chrome.runtime.sendMessage({ action: 'template_get', id: templateId }, (response) => {
    if (_hasLastError()) {
      showToast(_getLastErrorMessage() || 'Error loading template', 'error');
      return;
    }
    if (!response || !response.ok || !response.data) {
      showToast(response?.error || 'Template not found', 'error');
      return;
    }

    const template = response.data;
    editingTemplateId = templateId;
    const title = document.getElementById('template-modal-title');
    if (title) title.textContent = 'Edit Template';
    const nameEl = document.getElementById('tmpl-name');
    if (nameEl) nameEl.value = template.name || '';
    const goalEl = document.getElementById('tmpl-goal');
    if (goalEl) goalEl.value = template.goal || '';
    const tagsEl = document.getElementById('tmpl-tags');
    if (tagsEl) tagsEl.value = (template.tags || []).join(', ');
    document.getElementById('template-modal')?.classList.add('show');
    updateParamEditor(template.params);
  });
}

function saveEditedTemplate() {
  const nameEl = document.getElementById('tmpl-name');
  const goalEl = document.getElementById('tmpl-goal');
  const tagsEl = document.getElementById('tmpl-tags');
  const name = nameEl ? nameEl.value.trim() : '';
  const goal = goalEl ? goalEl.value.trim() : '';
  const tagsStr = tagsEl ? tagsEl.value.trim() : '';

  if (!name) {
    showToast('Template name is required', 'error');
    return;
  }
  if (!goal) {
    showToast('Template goal is required', 'error');
    return;
  }

  const tags = parseTags(tagsStr);
  const params = [];
  document.querySelectorAll('#tmpl-params-container input[data-param-key]').forEach(inp => {
    params.push({ key: inp.dataset.paramKey, defaultValue: inp.value });
  });

  chrome.runtime.sendMessage({
    action: 'template_update',
    id: editingTemplateId,
    updates: { name, goal, tags, params }
  }, (response) => {
    if (_hasLastError()) {
      showToast(_getLastErrorMessage() || 'Error updating template', 'error');
      return;
    }
    if (response && response.error) {
      showToast(typeof response.error === 'string' ? response.error : String(response.error), 'error');
      return;
    }
    editingTemplateId = null;
    document.getElementById('template-modal')?.classList.remove('show');
    loadTemplates();
    showToast('Template updated', 'success');
  });
}

// ========== Parameter Editor (create/edit modal) ==========
function updateParamEditor(existingParams) {
  const goalEl = document.getElementById('tmpl-goal');
  const container = document.getElementById('tmpl-params-container');
  const goalText = goalEl ? goalEl.value : '';
  if (!container) return;

  const seen = new Set();
  const keys = [];
  let match;
  while ((match = TEMPLATE_PARAM_RE.exec(goalText)) !== null) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      keys.push(match[1]);
    }
  }

  if (!keys.length) {
    container.innerHTML = '<div style="font-size:12px;color:var(--text-tertiary);">No parameters detected. Use ::key:: in the goal to add placeholders.</div>';
    return;
  }

  container.innerHTML = '';
  keys.forEach(key => {
    const label = key
      .replace(/_/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());

    // Look up default from existing params (when editing)
    const existing = (existingParams || []).find(p => p.key === key);
    const defaultValue = existing ? (existing.defaultValue || '') : '';

    const row = document.createElement('div');
    row.className = 'template-param-row';
    row.innerHTML = `
      <label>${escapeHtml(label)}</label>
      <input type="text" data-param-key="${key}" placeholder="Default value (optional)" value="${escapeHtml(defaultValue)}">
    `;
    container.appendChild(row);
  });
}

// Wire goal input to auto-detect params (defensive: now wired via _on at the bottom).

// ========== Run Template ==========
function openRunModal(templateId) {
  chrome.runtime.sendMessage({ action: 'template_get', id: templateId }, (response) => {
    if (_hasLastError()) {
      showToast(_getLastErrorMessage() || 'Error loading template', 'error');
      return;
    }
    if (!response || !response.ok || !response.data) {
      showToast(response?.error || 'Template not found', 'error');
      return;
    }

    const template = response.data;
    runningTemplateId = templateId;
    const runTitle = document.getElementById('template-run-title');
    if (runTitle) runTitle.textContent = `Run: ${template.name}`;
    const goalPreview = document.getElementById('template-run-goal-preview');
    if (goalPreview) goalPreview.textContent = template.goal;

    const container = document.getElementById('tmpl-run-params-container');
    if (!container) return;
    container.innerHTML = '';

    const params = template.params || [];
    if (!params.length) {
      container.innerHTML = '<div style="font-size:13px;color:var(--text-tertiary);">No parameters required. Click Run to execute.</div>';
    } else {
      params.forEach(param => {
        const row = document.createElement('div');
        row.className = 'template-param-row';
        row.innerHTML = `
          <label>${escapeHtml(param.label || param.key)}</label>
          <input type="text" data-run-param="${param.key}" placeholder="${escapeHtml(param.defaultValue || 'Enter value...')}" value="${escapeHtml(param.defaultValue || '')}">
        `;
        container.appendChild(row);
      });
    }

    document.getElementById('template-run-modal')?.classList.add('show');
  });
}

function executeTemplate() {
  if (!runningTemplateId) return;

  // Collect param values from inputs
  const params = {};
  const inputs = document.querySelectorAll('#tmpl-run-params-container input[data-run-param]');
  inputs.forEach(input => {
    params[input.dataset.runParam] = input.value;
  });

  chrome.runtime.sendMessage({
    action: 'template_run',
    templateId: runningTemplateId,
    params
  }, (response) => {
    if (_hasLastError()) {
      showToast(_getLastErrorMessage() || 'Error running template', 'error');
      return;
    }
    if (response && response.error) {
      showToast(typeof response.error === 'string' ? response.error : String(response.error), 'error');
      return;
    }
    runningTemplateId = null;
    document.getElementById('template-run-modal')?.classList.remove('show');
    hideTemplatesPanel();
    showToast('Template running...', 'success');
  });
}

// ========== Delete Template ==========
function deleteTemplate(templateId, templateName) {
  if (!confirm(`Delete template "${templateName}"? This cannot be undone.`)) {
    return;
  }

  chrome.runtime.sendMessage({
    action: 'template_delete',
    id: templateId
  }, (response) => {
    if (_hasLastError()) {
      showToast(_getLastErrorMessage() || 'Error deleting template', 'error');
      return;
    }
    if (response && response.error) {
      showToast(typeof response.error === 'string' ? response.error : String(response.error), 'error');
      return;
    }
    loadTemplates();
    showToast('Template deleted', 'success');
  });
}

// ========== Event Wiring ==========
// Defensive: any missing button must not crash the entire module load.
_on('createTemplateBtn', 'click', () => openCreateTemplateModal());
_on('saveTemplateBtn', 'click', () => {
  if (editingTemplateId) {
    saveEditedTemplate();
  } else {
    saveNewTemplate();
  }
});
_on('closeTemplateModalBtn', 'click', () => {
  const modal = document.getElementById('template-modal');
  if (modal) modal.classList.remove('show');
  editingTemplateId = null;
});
_on('runTemplateBtn', 'click', () => executeTemplate());
_on('closeRunModalBtn', 'click', () => {
  const modal = document.getElementById('template-run-modal');
  if (modal) modal.classList.remove('show');
  runningTemplateId = null;
});

// Auto-detect parameters when goal text changes (defensive).
_on('tmpl-goal', 'input', () => updateParamEditor());
