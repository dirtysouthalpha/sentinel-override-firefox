// popup-modules/scheduler-ui.js
// Schedule management UI: list, create, enable/disable, delete, run history.
// Communicates with background via chrome.runtime.sendMessage (schedule_* actions).

// ========== Constants ==========
const SCHEDULER_REFRESH_INTERVAL_MS = 30000; // 30 seconds - refresh countdown timers

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

function getErrorMessage(e) {
  if (typeof e === 'object' && e !== null && typeof e.message === 'string') return e.message;
  return String(e || '');
}

// ========== Module-level State ==========
let refreshIntervalId = null;
let templatesCache = [];

// ========== Countdown / Relative Time Helpers ==========
// formatCountdown, relativeTime, formatDuration are in window.Helpers (popup-modules/helpers.js)

// ========== Panel Toggle ==========
function showSchedulesPanel() {
  const sp = document.getElementById('schedules-panel');
  if (sp) sp.style.display = 'flex';
  const cc = document.getElementById('chat-container');
  if (cc) cc.style.display = 'none';
  const ia = document.getElementById('input-area');
  if (ia) ia.style.display = 'none';
  const tp = document.getElementById('templates-panel');
  if (tp) tp.style.display = 'none';
  document.getElementById('templatesBtn')?.classList.remove('active');
  document.getElementById('schedulerBtn')?.classList.add('active');

  // Load templates for the create form dropdown
  loadTemplatesCache();

  // Load and render schedules
  loadAndRenderSchedules();

  // Clear notification badge
  chrome.runtime.sendMessage({ action: 'schedule_clear_badge' });

  // Start refresh interval for countdown timers
  if (refreshIntervalId) clearInterval(refreshIntervalId);
  refreshIntervalId = setInterval(() => {
    loadAndRenderSchedules();
  }, SCHEDULER_REFRESH_INTERVAL_MS);
}

function hideSchedulesPanel() {
  const sp = document.getElementById('schedules-panel');
  if (sp) sp.style.display = 'none';
  const cc = document.getElementById('chat-container');
  if (cc) cc.style.display = 'flex';
  const ia = document.getElementById('input-area');
  if (ia) ia.style.display = 'flex';
  document.getElementById('schedulerBtn')?.classList.remove('active');
  const tp = document.getElementById('templates-panel');
  if (tp) tp.style.display = 'none';
  document.getElementById('templatesBtn')?.classList.remove('active');

  if (refreshIntervalId) {
    clearInterval(refreshIntervalId);
    refreshIntervalId = null;
  }
}

// ========== Templates Cache ==========
function loadTemplatesCache() {
  chrome.runtime.sendMessage({ action: 'template_list' }, (response) => {
    if (_hasLastError() || !response) {
      console.warn('[Sentinel/scheduler-ui] Template list fetch failed:', _getLastErrorMessage() || 'No response');
      return;
    }
    if (response.ok && Array.isArray(response.data)) {
      templatesCache = response.data;
    }
  });
}

// ========== Schedule List ==========
async function loadAndRenderSchedules() {
  const container = document.getElementById('schedule-list');
  if (!container) return;

  try {
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'schedule_list' }, (resp) => {
        if (_hasLastError() || !resp) {
          reject(new Error(getErrorMessage(chrome.runtime.lastError) || 'No response'));
          return;
        }
        resolve(resp);
      });
    });

    const schedules = (response && response.ok && Array.isArray(response.data))
      ? response.data
      : [];

    if (!schedules.length) {
      container.innerHTML = '<div class="schedule-empty">No schedules yet. Click + New Schedule to create one.</div>';
      return;
    }

    container.innerHTML = '';
    if (schedules && typeof schedules.forEach === 'function') {
      schedules.forEach(schedule => {
        const card = document.createElement('div');
        card.className = `schedule-card${schedule.enabled ? '' : ' disabled'}`;
        card.innerHTML = renderScheduleCard(schedule);
        container.appendChild(card);
      });
    }
  } catch (err) {
    container.innerHTML = `<div class="schedule-empty" style="color:var(--error-color);">Error loading schedules: ${escapeHtml(getErrorMessage(err))}</div>`;
  }
}

function renderScheduleCard(schedule) {
  const isEnabled = schedule.enabled;
  const goalPreview = schedule.goal
    ? escapeHtml(schedule.goal.length > 80 ? `${schedule.goal.substring(0, 80)}...` : schedule.goal)
    : (schedule.templateId ? '<em>Template task</em>' : '<em>No goal</em>');

  // Recurrence display
  let recurrenceText = '';
  if (schedule.type === 'once') {
    recurrenceText = 'Once';
  } else if (schedule.recurrence) {
    const r = schedule.recurrence;
    if (r.interval === 'daily') {
      recurrenceText = `Daily at ${r.time || '09:00'}`;
    } else if (r.interval === 'weekly' && r.daysOfWeek && r.daysOfWeek.length) {
      const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const days = [...r.daysOfWeek].sort((a, b) => a - b).map(d => dayNames[d]).join(', ');
      recurrenceText = `Weekly on ${days} at ${r.time || '09:00'}`;
    } else if (r.interval === 'custom') {
      recurrenceText = `Every ${r.periodInMinutes || 60} minutes`;
    } else {
      recurrenceText = 'Recurring';
    }
  }

  // Next run countdown
  const nextRunText = isEnabled
    ? formatCountdown(schedule.nextRunAt)
    : (schedule.nextRunAt ? 'Disabled' : 'Not scheduled');

  // Last run status badge
  let statusBadge = '';
  if (schedule.lastRunStatus) {
    const validStatuses = ['success','failed','running','pending','error','timeout','cancelled'];
    const statusClass = validStatuses.includes(schedule.lastRunStatus) ? schedule.lastRunStatus : 'unknown';
    const status = schedule.lastRunStatus || '';
    const statusLabel = escapeHtml(status ? status.charAt(0).toUpperCase() + status.slice(1) : '?');
    statusBadge = `<span class="schedule-status-badge ${statusClass}">${statusLabel}</span>`;
  }

  // Toggle checkbox
  const toggleChecked = isEnabled ? 'checked' : '';

  return `
    <div class="schedule-card-header">
      <div class="schedule-card-name">${escapeHtml(schedule.name)}</div>
      <label class="toggle-switch" style="flex-shrink:0;">
        <input type="checkbox" data-action="toggle" data-id="${escapeHtml(schedule.id)}" ${toggleChecked}>
        <span class="toggle-slider"></span>
      </label>
    </div>
    <div class="schedule-card-goal">${goalPreview}</div>
    <div class="schedule-card-meta">
      <span>${recurrenceText}</span>
      <span>${nextRunText}</span>
      ${schedule.lastRunAt ? `<span>Last run: ${relativeTime(schedule.lastRunAt)}</span>` : ''}
      ${statusBadge}
    </div>
    <div style="display:flex;gap:6px;margin-top:8px;justify-content:flex-end;">
      <button class="small-btn" data-action="history" data-id="${escapeHtml(schedule.id)}" data-name="${escapeHtml(schedule.name)}">History</button>
      <button class="small-btn" data-action="delete" data-id="${escapeHtml(schedule.id)}" data-name="${escapeHtml(schedule.name)}" style="color:var(--error-color);">Delete</button>
    </div>
  `;
}

// ========== Event Delegation for Schedule List ==========
const _schedulesPanel = document.getElementById('schedules-panel');
if (_schedulesPanel) {
  _schedulesPanel.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;

    const action = target.dataset.action;
    const id = target.dataset.id;

    if (action === 'toggle') {
      // Checkbox change is handled separately below
      return;
    }
    if (action === 'history') {
      showRunHistory(id, target.dataset.name);
    } else if (action === 'delete') {
      handleDeleteSchedule(id, target.dataset.name);
    }
  });

  // Handle toggle checkbox changes (change event)
  _schedulesPanel.addEventListener('change', (e) => {
    const target = e.target.closest('[data-action="toggle"]');
    if (!target) return;

    const id = target.dataset.id;
    const enabled = target.checked;
    handleToggleSchedule(id, enabled);
  });
}

// ========== Create Schedule Modal ==========
function openCreateScheduleModal() {
  const titleEl = document.getElementById('schedule-modal-title');
  if (titleEl) titleEl.textContent = 'New Schedule';
  const nameEl = document.getElementById('sch-name');
  if (nameEl) nameEl.value = '';
  const sourceTypeEl = document.getElementById('sch-source-type');
  if (sourceTypeEl) sourceTypeEl.value = 'template';
  const goalEl = document.getElementById('sch-goal');
  if (goalEl) goalEl.value = '';
  const typeEl = document.getElementById('sch-type');
  if (typeEl) typeEl.value = 'once';
  const runAtEl = document.getElementById('sch-run-at');
  if (runAtEl) runAtEl.value = '';
  const intervalEl = document.getElementById('sch-interval');
  if (intervalEl) intervalEl.value = 'daily';
  const timeEl = document.getElementById('sch-time');
  if (timeEl) timeEl.value = '09:00';
  const periodEl = document.getElementById('sch-period');
  if (periodEl) periodEl.value = '60';
  const paramsEl = document.getElementById('sch-template-params');
  if (paramsEl) paramsEl.innerHTML = '';

  // Reset day checkboxes
  document.querySelectorAll('.sch-day-check').forEach(cb => { cb.checked = false; });

  // Reset field visibility
  const templateFieldEl = document.getElementById('sch-template-field');
  if (templateFieldEl) templateFieldEl.style.display = '';
  const goalFieldEl = document.getElementById('sch-goal-field');
  if (goalFieldEl) goalFieldEl.style.display = 'none';
  const onceFieldsEl = document.getElementById('sch-once-fields');
  if (onceFieldsEl) onceFieldsEl.style.display = '';
  const recurringFieldsEl = document.getElementById('sch-recurring-fields');
  if (recurringFieldsEl) recurringFieldsEl.style.display = 'none';
  const weeklyDaysEl = document.getElementById('sch-weekly-days');
  if (weeklyDaysEl) weeklyDaysEl.style.display = 'none';
  const customIntervalEl = document.getElementById('sch-custom-interval');
  if (customIntervalEl) customIntervalEl.style.display = 'none';

  // Set min datetime to now
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const minDatetime = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const runAtMinEl = document.getElementById('sch-run-at');
  if (runAtMinEl) runAtMinEl.min = minDatetime;

  // Populate template dropdown
  populateTemplateDropdown();

  // Show modal
  const modalEl = document.getElementById('schedule-modal');
  if (modalEl) modalEl.classList.add('show');
}

function openCreateScheduleModalForTemplate(templateId, templateName) {
  openCreateScheduleModal();

  // Pre-fill name immediately (synchronous)
  if (templateName) {
    const nameEl = document.getElementById('sch-name');
    if (nameEl) nameEl.value = `${templateName} Schedule`;
  }

  // populateTemplateDropdown is async — pre-select after it finishes by
  // passing the target id so the callback can set .value and fire 'change'.
  populateTemplateDropdown(templateId);
}

function populateTemplateDropdown(preselectId) {
  const dropdown = document.getElementById('sch-template-id');
  if (!dropdown) return;
  dropdown.innerHTML = '<option value="">-- Select a template --</option>';

  chrome.runtime.sendMessage({ action: 'template_list' }, (response) => {
    if (_hasLastError() || !response) {
      console.warn('[Sentinel/scheduler-ui] Template list fetch failed in populateTemplateDropdown:', _getLastErrorMessage() || 'No response');
      dropdown.innerHTML = '<option value="">Error loading templates</option>';
      return;
    }

    const templates = (response && response.ok && Array.isArray(response.data))
      ? response.data
      : [];

    templatesCache = templates;

    if (templates && typeof templates.forEach === 'function') {
      templates.forEach(t => {
      const option = document.createElement('option');
      option.value = t.id;
      option.textContent = t.name;
      dropdown.appendChild(option);
      });
    }

    if (templates && !templates.length) {
      dropdown.innerHTML = '<option value="">No templates available</option>';
    }

    // Apply pre-selection now that options exist
    if (preselectId) {
      dropdown.value = preselectId;
      dropdown.dispatchEvent(new Event('change'));
    }
  });
}

// ========== Form Field Toggling ==========

// Source type: template vs goal
document.getElementById('sch-source-type')?.addEventListener('change', (e) => {
  const isTemplate = e.target.value === 'template';
  const tf = document.getElementById('sch-template-field');
  const gf = document.getElementById('sch-goal-field');
  if (tf) tf.style.display = isTemplate ? '' : 'none';
  if (gf) gf.style.display = isTemplate ? 'none' : '';
});

// Schedule type: once vs recurring
document.getElementById('sch-type')?.addEventListener('change', (e) => {
  const isOnce = e.target.value === 'once';
  const onceFields = document.getElementById('sch-once-fields');
  const recFields = document.getElementById('sch-recurring-fields');
  if (onceFields) onceFields.style.display = isOnce ? '' : 'none';
  if (recFields) recFields.style.display = isOnce ? 'none' : '';

  if (!isOnce) {
    const weeklyDays = document.getElementById('sch-weekly-days');
    const customInterval = document.getElementById('sch-custom-interval');
    const intervalEl = document.getElementById('sch-interval');
    if (weeklyDays) weeklyDays.style.display = 'none';
    if (customInterval) customInterval.style.display = 'none';
    if (intervalEl) intervalEl.value = 'daily';
  }
});

// Interval: daily vs weekly vs custom
document.getElementById('sch-interval')?.addEventListener('change', (e) => {
  const interval = e.target.value;
  const weeklyDays = document.getElementById('sch-weekly-days');
  const customInterval = document.getElementById('sch-custom-interval');
  if (weeklyDays) weeklyDays.style.display = interval === 'weekly' ? '' : 'none';
  if (customInterval) customInterval.style.display = interval === 'custom' ? '' : 'none';
});

// Template selection: load params
document.getElementById('sch-template-id')?.addEventListener('change', (e) => {
  const templateId = e.target.value;
  const container = document.getElementById('sch-template-params');
  if (!container) return;

  if (!templateId) {
    container.innerHTML = '';
    return;
  }

  // Find template from cache or fetch
  const cached = templatesCache.find(t => t.id === templateId);
  if (cached && cached.params && cached.params.length) {
    renderTemplateParams(cached.params);
  } else {
    container.innerHTML = '';
  }
});

function renderTemplateParams(params) {
  const container = document.getElementById('sch-template-params');
  if (!container) return;
  container.innerHTML = '';

  if (params && Array.isArray(params) && typeof params.forEach === 'function') {
    params.forEach(param => {
    const row = document.createElement('div');
    row.className = 'template-param-row';
    row.style.marginTop = '8px';
    row.innerHTML = `
      <label>${escapeHtml(param.label || param.key)}</label>
      <input type="text" data-sch-param="${param.key}" placeholder="${escapeHtml(param.defaultValue || 'Enter value...')}" value="${escapeHtml(param.defaultValue || '')}">
    `;
    container.appendChild(row);
  });
  }
}

// ========== Save Schedule ==========
async function handleSaveSchedule() {
  const nameEl = document.getElementById('sch-name');
  if (!nameEl) { showToast('Schedule name field not found', 'error'); return; }
  const name = nameEl.value.trim();
  if (!name) {
    showToast('Schedule name is required', 'error');
    return;
  }

  const sourceTypeEl = document.getElementById('sch-source-type');
  if (!sourceTypeEl) { showToast('Source type field not found', 'error'); return; }
  const sourceType = sourceTypeEl.value;
  const schTypeEl = document.getElementById('sch-type');
  if (!schTypeEl) { showToast('Schedule type field not found', 'error'); return; }
  const schType = schTypeEl.value;

  // Build schedule data
  const scheduleData = { name, type: schType };

  if (sourceType === 'template') {
    const templateIdEl = document.getElementById('sch-template-id');
    if (!templateIdEl) { showToast('Template field not found', 'error'); return; }
    const templateId = templateIdEl.value;
    if (!templateId) {
      showToast('Please select a template', 'error');
      return;
    }
    scheduleData.templateId = templateId;

    // Collect params
    const params = {};
    const paramInputs = document.querySelectorAll('#sch-template-params input[data-sch-param]');
    if (paramInputs && typeof paramInputs.forEach === 'function') {
      paramInputs.forEach(input => {
        params[input.dataset.schParam] = input.value;
      });
    }
    scheduleData.params = Object.keys(params).length ? params : null;
  } else {
    const goalEl = document.getElementById('sch-goal');
    if (!goalEl) { showToast('Goal field not found', 'error'); return; }
    const goal = goalEl.value.trim();
    if (!goal) {
      showToast('Goal is required', 'error');
      return;
    }
    scheduleData.goal = goal;
  }

  // Time configuration
  if (schType === 'once') {
    const runAtEl = document.getElementById('sch-run-at');
    if (!runAtEl) { showToast('Run-at field not found', 'error'); return; }
    const runAtValue = runAtEl.value;
    if (!runAtValue) {
      showToast('Please select a date and time', 'error');
      return;
    }
    scheduleData.runAt = new Date(runAtValue).getTime();
    if (!scheduleData.runAt || Number.isNaN(scheduleData.runAt) || scheduleData.runAt <= Date.now()) {
      showToast('Date and time must be in the future', 'error');
      return;
    }
  } else {
    // Recurring
    const intervalEl = document.getElementById('sch-interval');
    if (!intervalEl) { showToast('Interval field not found', 'error'); return; }
    const interval = intervalEl.value;
    const timeEl = document.getElementById('sch-time');
    const time = (timeEl ? timeEl.value : '') || '09:00';

    const recurrence = { interval, time };

    if (interval === 'weekly') {
      const days = [];
      const checkedBoxes = document.querySelectorAll('.sch-day-check:checked');
      if (checkedBoxes && typeof checkedBoxes.forEach === 'function') {
        checkedBoxes.forEach(cb => {
          days.push(parseInt(cb.value, 10));
        });
      }
      if (!days.length) {
        showToast('Please select at least one day of the week', 'error');
        return;
      }
      recurrence.daysOfWeek = days;
    }

    if (interval === 'custom') {
      const periodEl = document.getElementById('sch-period');
      if (!periodEl) { showToast('Period field not found', 'error'); return; }
      const period = parseInt(periodEl.value, 10);
      if (!period || period < 30) {
        showToast('Custom interval must be at least 30 minutes', 'error');
        return;
      }
      recurrence.periodInMinutes = period;
    }

    scheduleData.recurrence = recurrence;
  }

  // Send create request
  try {
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'schedule_create', schedule: scheduleData }, (resp) => {
        if (_hasLastError() || !resp) {
          reject(new Error(getErrorMessage(chrome.runtime.lastError) || 'No response'));
          return;
        }
        resolve(resp);
      });
    });

    if (!response || !response.ok) {
      showToast((response && response.error) || 'Failed to create schedule', 'error');
      return;
    }

    // Close modal and refresh
    const modalEl = document.getElementById('schedule-modal');
    if (modalEl) modalEl.classList.remove('show');
    loadAndRenderSchedules();
    showToast('Schedule created', 'success');
  } catch (err) {
    showToast(`Error creating schedule: ${getErrorMessage(err)}`, 'error');
  }
}

// ========== Toggle Schedule ==========
async function handleToggleSchedule(scheduleId, enabled) {
  try {
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'schedule_toggle', id: scheduleId, enabled }, (resp) => {
        if (_hasLastError() || !resp) {
          reject(new Error(getErrorMessage(chrome.runtime.lastError) || 'No response'));
          return;
        }
        resolve(resp);
      });
    });

    if (!response || !response.ok) {
      showToast((response && response.error) || 'Failed to toggle schedule', 'error');
      return;
    }

    loadAndRenderSchedules();
    showToast(enabled ? 'Schedule enabled' : 'Schedule disabled', 'success');
  } catch (err) {
    showToast(`Error toggling schedule: ${getErrorMessage(err)}`, 'error');
  }
}

// ========== Delete Schedule ==========
async function handleDeleteSchedule(scheduleId, name) {
  if (!confirm(`Delete schedule "${name}"? This cannot be undone.`)) {
    return;
  }

  try {
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'schedule_delete', id: scheduleId }, (resp) => {
        if (_hasLastError() || !resp) {
          reject(new Error(getErrorMessage(chrome.runtime.lastError) || 'No response'));
          return;
        }
        resolve(resp);
      });
    });

    if (!response || !response.ok) {
      showToast((response && response.error) || 'Failed to delete schedule', 'error');
      return;
    }

    loadAndRenderSchedules();
    showToast('Schedule deleted', 'success');
  } catch (err) {
    showToast(`Error deleting schedule: ${getErrorMessage(err)}`, 'error');
  }
}

// ========== Run History ==========
async function showRunHistory(scheduleId, scheduleName) {
  const container = document.getElementById('schedule-history-list');
  if (!container) return;
  container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-tertiary);">Loading history...</div>';

  try {
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'schedule_results', id: scheduleId }, (resp) => {
        if (_hasLastError() || !resp) {
          reject(new Error(getErrorMessage(chrome.runtime.lastError) || 'No response'));
          return;
        }
        resolve(resp);
      });
    });

    const results = (response && response.ok && Array.isArray(response.data))
      ? response.data
      : [];

    if (!results.length) {
      container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-tertiary);">No run history yet.</div>';
    } else {
      container.innerHTML = '';
      if (results && typeof results.forEach === 'function') {
        results.forEach(result => {
        const item = document.createElement('div');
        item.className = 'schedule-result-item';

        const validStatuses = ['success','failed','running','pending','error','timeout','cancelled'];
        const statusClass = validStatuses.includes(result.status) ? result.status : 'pending';
        const statusLabel = escapeHtml((result.status || 'pending').charAt(0).toUpperCase() + (result.status || 'pending').slice(1));
        const duration = formatDuration(result.startedAt, result.completedAt);
        const timestamp = result.completedAt
          ? new Date(result.completedAt).toLocaleString()
          : 'In progress...';

        let reportBtn = '';
        if (result.report) {
          reportBtn = `<button class="small-btn" data-action="view-report" data-report="${encodeURIComponent(result.report)}" style="margin-top:4px;">View Report</button>`;
        }

        let errorMsg = '';
        if (result.error) {
          errorMsg = `<div style="font-size:11px;color:var(--error-color);margin-top:2px;">${escapeHtml(typeof result.error === 'string' ? result.error : String(result.error))}</div>`;
        }

        item.innerHTML = `
          <div>
            <span class="schedule-status-badge ${statusClass}">${statusLabel}</span>
            <div class="schedule-result-time" style="margin-top:4px;">${timestamp}</div>
            ${duration ? `<div style="font-size:11px;color:var(--text-tertiary);margin-top:2px;">Duration: ${duration}</div>` : ''}
            ${errorMsg}
            ${reportBtn}
          </div>
        `;
        container.appendChild(item);
      });
      }

      // Wire view-report buttons inside history modal
      const viewReportBtns = container.querySelectorAll('[data-action="view-report"]');
      if (viewReportBtns && typeof viewReportBtns.forEach === 'function') {
        viewReportBtns.forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const report = decodeURIComponent(btn.dataset.report || '');
            if (report && window.openReportModal) {
              window.openReportModal(report);
            }
          });
        });
      }
    }

    // Show modal
    const _histModal = document.getElementById('schedule-history-modal');
    if (_histModal) {
      _histModal.classList.add('show');
      const _h2 = _histModal.querySelector('h2');
      if (_h2) _h2.textContent = `Run History: ${scheduleName}`;
    }
  } catch (err) {
    container.innerHTML = `<div style="text-align:center;padding:20px;color:var(--error-color);">Error: ${escapeHtml(getErrorMessage(err))}</div>`;
    const _histModal = document.getElementById('schedule-history-modal');
    if (_histModal) _histModal.classList.add('show');
  }
}

// ========== Popup Unload Cleanup ==========
// Clear intervals when popup closes to prevent memory leaks
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('unload', () => {
  if (refreshIntervalId) {
    clearInterval(refreshIntervalId);
    refreshIntervalId = null;
  }
  });
}

// ========== Global Exports ==========
window.showSchedulesPanel = showSchedulesPanel;
window.hideSchedulesPanel = hideSchedulesPanel;
window.openCreateScheduleModal = openCreateScheduleModal;
window.openCreateScheduleModalForTemplate = openCreateScheduleModalForTemplate;
window._handleSaveSchedule = handleSaveSchedule;
