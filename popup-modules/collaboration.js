// popup-modules/collaboration.js
// Export/import UI: file picker, import preview, conflict resolution, version warnings.
// Depends on: ui-common.js (showToast, sanitizeHtml).
// Communicates with background via chrome.runtime.sendMessage (collab_* actions).

// ========== Export Template ==========

/**
 * Export a single template as a downloadable JSON file.
 * @param {string} templateId
 */
async function exportTemplateFile(templateId) {
  try {
    const response = await collabSendMessage('collab_export_template', { id: templateId });
    if (!response.ok) throw new Error(response.error || 'Export failed');

    const data = response.data;
    if (!data || !data.template) throw new Error('Malformed export response');
    const filename = `${sanitizeFilename(data.template.name)}.json`;
    downloadJson(data, filename);
    showToast('Template exported', 'success');
  } catch (err) {
    showToast(getErrorMessage(err) || 'Export failed', 'error');
  }
}

/**
 * Export all templates as a batch JSON file.
 */
async function exportAllTemplatesFile() {
  try {
    const response = await collabSendMessage('collab_export_all_templates', {});
    if (!response.ok) throw new Error(response.error || 'Export failed');

    const data = response.data;
    const filename = `sentinel-templates-${new Date().toISOString().slice(0, 10)}.json`;
    downloadJson(data, filename);
    showToast(`${data && data.count != null ? data.count : '?'} template(s) exported`, 'success');
  } catch (err) {
    showToast(getErrorMessage(err) || 'Export failed', 'error');
  }
}

// ========== Import Template ==========

/**
 * Open file picker and handle template import flow.
 */
function openImportDialog() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.style.display = 'none';
  if (document.body) document.body.appendChild(input);

  input.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files.length && e.target.files[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      // Validate import
      const validation = await collabSendMessage('collab_validate_import', { data: data });
      if (!validation.ok) {
        showToast(validation.error || 'Validation failed', 'error');
        return;
      }

      const result = validation.data;

      // Check for errors
      if (!result.safe) {
        showImportErrors(result);
        return;
      }

      // Check for version warnings
      if (result.warnings && result.warnings.length) {
        showImportPreview(result, result.warnings);
      } else {
        showImportPreview(result, []);
      }
    } catch (err) {
      const errorMsg = getErrorMessage(err);
      // Distinguish between file read errors and JSON parse errors
      const prefix = errorMsg && errorMsg.includes('JSON') ? 'Invalid JSON file' : 'Failed to read file';
      showToast(`${prefix}: ${errorMsg}`, 'error');
    } finally {
      if (document.body && document.body.contains(input)) document.body.removeChild(input);
    }
  });

  input.addEventListener('cancel', () => {
    if (document.body && document.body.contains(input)) document.body.removeChild(input);
  });
  input.click();
}

// ========== Export Report ==========

/**
 * Export the current report as a downloadable markdown file.
 * @param {{ summary: string, fullReport: string, goal: string, timestamp: string }} report
 */
async function exportReportFile(report) {
  if (!report || !report.fullReport) {
    showToast('No report to export', 'error');
    return;
  }

  try {
    const response = await collabSendMessage('collab_export_report', { report });
    if (!response.ok) throw new Error(response.error || 'Export failed');

    const markdown = response.data;
    const filename = `report-${new Date().toISOString().slice(0, 10)}.md`;
    downloadText(markdown, filename, 'text/markdown');
    showToast('Report exported', 'success');
  } catch (err) {
    showToast(getErrorMessage(err) || 'Export failed', 'error');
  }
}

// ========== Import Preview Modal ==========

function showImportPreview(validationResult, warnings) {
  const templates = validationResult.templates || [];

  // Clear and populate preview
  const list = document.getElementById('import-preview-list');
  if (!list) return;
  list.innerHTML = '';

  templates.forEach(t => {
    const row = document.createElement('div');
    row.style.cssText = 'padding:10px 0;border-bottom:1px solid var(--border-color);';

    const paramsText = (t.params && t.params.length)
      ? `${t.params.length} param(s)`
      : 'No params';

    const tagsText = (t.tags && t.tags.length)
      ? t.tags.map(tag => `<span class="template-tag">${escapeHtml(tag)}</span>`).join(' ')
      : '';

    row.innerHTML = `
      <div style="font-size:14px;font-weight:600;color:var(--text-primary);margin-bottom:4px;">${escapeHtml(t.name)}</div>
      <div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px;white-space:pre-wrap;max-height:40px;overflow:hidden;">${escapeHtml(t.goal)}</div>
      <div style="display:flex;gap:8px;align-items:center;font-size:11px;color:var(--text-tertiary);">
        <span>${paramsText}</span>
        ${tagsText}
      </div>
    `;
    list.appendChild(row);
  });

  // Show version warning if any
  const warningEl = document.getElementById('import-version-warning');
  if (warningEl) {
    if (warnings.length) {
      warningEl.style.display = 'block';
      warningEl.innerHTML = warnings.map(w =>
        `<div style="font-size:12px;color:var(--warning-color);padding:4px 0;">⚠ ${escapeHtml(w)}</div>`
      ).join('');
    } else {
      warningEl.style.display = 'none';
    }
  }

  // Store templates for import
  window.__importTemplates = templates;
  window.__importVersion = validationResult.version;

  const importModal = document.getElementById('import-modal');
  if (importModal) importModal.classList.add('show');
}

function showImportErrors(result) {
  const errors = result.errors || [];
  if (!errors.length) return;

  const message = errors.length === 1
    ? errors[0]
    : `${errors.length} errors:\n` + errors.map((e, i) => `${i + 1}. ${e}`).join('\n');

  showToast(message, 'error');
}

// ========== Import Execution ==========

async function executeImport() {
  const templates = window.__importTemplates;
  if (!templates || !templates.length) return;

  const conflictMode = document.querySelector('input[name="import-conflict"]:checked')?.value || 'skip';

  try {
    const response = await collabSendMessage('collab_import_templates', {
      templates,
      conflictMode,
    });

    if (!response.ok) {
      showToast(response.error || 'Import failed', 'error');
      return;
    }

    const result = response.data || {};
    const importModal = document.getElementById('import-modal');
    if (importModal) importModal.classList.remove('show');
    window.__importTemplates = null;

    const parts = [];
    if (result.imported > 0) parts.push(`${result.imported} imported`);
    if (result.renamed > 0) parts.push(`${result.renamed} renamed`);
    if (result.overwritten > 0) parts.push(`${result.overwritten} overwritten`);
    if (result.skipped > 0) parts.push(`${result.skipped} skipped`);

    showToast(`Import complete: ${parts.length ? parts.join(', ') : 'nothing changed'}`, 'success');

    // Refresh template list if templates panel is visible
    if (typeof loadTemplates === 'function') loadTemplates();
  } catch (err) {
    showToast(getErrorMessage(err) || 'Import failed', 'error');
  }
}

// ========== Download Helpers ==========

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  try {
    if (document.body) document.body.appendChild(a);
    a.click();
  } finally {
    try { if (document.body) document.body.removeChild(a); } catch (_e) {}
    URL.revokeObjectURL(url);
  }
}

function downloadText(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  try {
    if (document.body) document.body.appendChild(a);
    a.click();
  } finally {
    try { if (document.body) document.body.removeChild(a); } catch (_e) {}
    URL.revokeObjectURL(url);
  }
}

function sanitizeFilename(name) {
  return (name || 'template')
    .replace(/[^a-z0-9_\-\s]/gi, '')
    .replace(/\s+/g, '-')
    .toLowerCase()
    .substring(0, 80);
}

// ========== Message Helper ==========

function collabSendMessage(action, data) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action, ...(data || {}) }, (response) => {
      if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) {
        resolve({ ok: false, error: getErrorMessage(chrome.runtime.lastError) || 'Unknown error' });
        return;
      }
      resolve(response || { ok: false, error: 'No response' });
    });
  });
}

// ========== Event Wiring ==========

document.getElementById('closeImportModalBtn')?.addEventListener('click', () => {
  document.getElementById('import-modal')?.classList.remove('show');
});

document.getElementById('importConfirmBtn')?.addEventListener('click', () => {
  executeImport();
});

// ========== Window Exports ==========
window.exportTemplateFile = exportTemplateFile;
window.exportAllTemplatesFile = exportAllTemplatesFile;
window.openImportDialog = openImportDialog;
window.exportReportFile = exportReportFile;
