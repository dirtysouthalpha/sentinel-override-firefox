// popup-modules/settings.js
// Settings UI: theme management, provider switching, settings modal, test connection, presets.
// Verified 2026-05-06.
// Depends on: ui-common.js (showToast, isValidUrl, sanitizeHtml).

// ========== DOM Elements ==========
const settingsBtn = document.getElementById('settingsBtn');
const themeToggle = document.getElementById('themeToggle');
const settingsModal = document.getElementById('settings-modal');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');
const closeSettingsBtn = document.getElementById('closeSettingsBtn');
const setProviderEndpoint = document.getElementById('set-provider-endpoint');
const setProviderKey = document.getElementById('set-provider-key');
const setProviderModel = document.getElementById('set-provider-model');
const exportFormatSelect = document.getElementById('export-format');
const themeModal = document.getElementById('theme-modal');
const closeThemeBtn = document.getElementById('closeThemeBtn');
const saveThemeBtn = document.getElementById('saveThemeBtn');

// ========== Theme Management ==========
// Precompute theme sets for O(1) lookups
const darkThemes = new Set(['dark', 'matrix', 'tron', 'cyberpunk', 'neon', 'terminal', 'blood']);
const baseThemes = new Set(['light', 'dark']);

// eslint-disable-next-line no-unused-vars
function loadThemePreference() {
  // Restore named theme (tron, matrix, etc.)
  let savedNamedTheme = null;
  try {
    savedNamedTheme = localStorage.getItem('theme-named');
  } catch (e) {
    console.warn('[Sentinel/settings] Failed to read theme-named:', window.getErrorMessage ? window.getErrorMessage(e) : String(e));
  }
  if (savedNamedTheme && savedNamedTheme !== 'light') {
    applyThemePreset(savedNamedTheme);
    // Update active preset button
    const themeButtons = document.querySelectorAll('[data-theme]');
    if (themeButtons.length) {
      themeButtons.forEach(b => {
        b.classList.toggle('active', b.dataset.theme === savedNamedTheme);
      });
    }
    return;
  }
  let savedTheme = null;
  try {
    savedTheme = localStorage.getItem('theme-preference');
  } catch (e) {
    console.warn('[Sentinel/settings] Failed to read theme-preference:', window.getErrorMessage ? window.getErrorMessage(e) : String(e));
  }
  if (savedTheme) {
    document.body.classList.toggle('dark-mode', savedTheme === 'dark');
    updateThemeToggle();
  } else {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.body.classList.toggle('dark-mode', prefersDark);
    updateThemeToggle();
  }
}

function updateThemeToggle() {
  const isDark = document.body.classList.contains('dark-mode');
  try {
    localStorage.setItem('theme-preference', isDark ? 'dark' : 'light');
  } catch (e) {
    console.warn('[Sentinel/settings] Failed to save theme preference:', getErrorMessage(e));
    showToast('Failed to save theme preference', 'error');
  }
}

function toggleTheme() {
  document.body.classList.toggle('dark-mode');
  updateThemeToggle();
}

// ========== Provider Card Switching ==========
// The old static provider buttons (anthropic/openai) are replaced by the
// catalog-driven dropdown. switchProviderCard is kept for backward compat
// with the preset buttons which call it, but the primary path is now the
// catalog dropdown → auto-fill endpoint/model.
function switchProviderCard(providerId) {
  const state = getState();
  state.activeProviderId = providerId;

  // Populate fields from saved provider config (per-provider keys in storage)
  const config = state.providerConfigs[providerId] || {};
  if (setProviderEndpoint) setProviderEndpoint.value = config.endpoint || '';
  if (setProviderKey) setProviderKey.value = config.api_key || '';
  if (setProviderModel) setProviderModel.value = config.model || '';

  // Auto-fill defaults if fields are empty — look up catalog entry
  if ((!setProviderEndpoint || !setProviderEndpoint.value) && window.catalogRef) {
    const entry = window.catalogRef.find(p => p.id === providerId);
    if (entry) {
      if (setProviderEndpoint && !setProviderEndpoint.value) setProviderEndpoint.value = entry.endpoint || '';
      if (setProviderModel && !setProviderModel.value) setProviderModel.value = entry.defaultModel || '';
    }
  }
}

// Preset buttons still exist in the collapsible section — wire them
const providerBtns = document.querySelectorAll('.provider-btn');
if (providerBtns.length) {
  providerBtns.forEach(btn => {
    btn.addEventListener('click', () => switchProviderCard(btn.dataset.provider));
  });
}

// ========== Settings Management ==========
// eslint-disable-next-line no-unused-vars
function loadSettings() {
  const state = getState();
  chrome.storage.local.get(['active_provider', 'providers', 'api_endpoint', 'api_key', 'model', 'export_format', 'agent_context'], (result) => {
    if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) { console.warn('[Sentinel/settings] Failed to load settings:', getErrorMessage(chrome.runtime.lastError)); return; }
    // Handle both new provider structure and legacy keys
    if (result.providers) {
      state.providerConfigs = result.providers;
      state.activeProviderId = result.active_provider || 'openai';
    } else {
      // Legacy fallback -- migrate on the fly for display
      const providerId = (result.api_endpoint || '').includes('api.anthropic.com') ? 'anthropic' : 'openai';
      state.providerConfigs = {
        anthropic: { api_key: '', model: 'claude-haiku-4-5-20251001', endpoint: 'https://api.anthropic.com/v1/messages', max_tokens: 8000, temperature: 0.3 },
        openai: { api_key: result.api_key || '', model: result.model || 'gpt-4o', endpoint: result.api_endpoint || 'https://api.openai.com/v1/chat/completions', max_tokens: 8000, temperature: 0.3 }
      };
      state.activeProviderId = providerId;
    }
    if (result.export_format && exportFormatSelect) exportFormatSelect.value = result.export_format;
    if (result.agent_context) {
      const el = document.getElementById('set-agent-context');
      if (el) el.value = result.agent_context;
    }
  });
}

// ========== Quick Assist Toggle (3.46.0) ==========
// Controls whether the floating Quick Assist panel appears on text selection.
const quickAssistToggle = document.getElementById('quickAssistToggle');
const quickAssistLabel = document.getElementById('quickAssistLabel');
if (quickAssistToggle) {
  chrome.storage.local.get(['quickAssist'], (result) => {
    if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) { console.warn('[Sentinel/settings] Failed to read quickAssist:', getErrorMessage(chrome.runtime.lastError)); return; }
    const enabled = result.quickAssist !== false; // default ON
    quickAssistToggle.checked = enabled;
    if (quickAssistLabel) {
      quickAssistLabel.textContent = enabled
        ? 'ON — Select text on any page'
        : 'OFF — Quick Assist disabled';
    }
  });
  quickAssistToggle.addEventListener('change', () => {
    const enabled = quickAssistToggle.checked;
    chrome.storage.local.set({ quickAssist: enabled }, () => {
      if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) {
        console.error('[Sentinel/settings] Failed to save quickAssist:', getErrorMessage(chrome.runtime.lastError));
        showToast('Failed to save setting', 'error');
        return;
      }
      if (quickAssistLabel) {
        quickAssistLabel.textContent = enabled
          ? 'ON — Select text on any page'
          : 'OFF — Quick Assist disabled';
      }
    });
  });
}

// ========== Trusted Input Toggle (#9 — CDP-based input dispatch) ==========
// Opt-in: when enabled, the agent routes click/type/press_key through
// chrome.debugger so events are dispatched with isTrusted: true. Default OFF
// because attaching the debugger surfaces the "Sentinel Override is debugging
// this browser" banner — acceptable cost only when sites need trusted events.
const useTrustedInputToggle = document.getElementById('useTrustedInputToggle');
if (useTrustedInputToggle) {
  chrome.storage.local.get(['useTrustedInput'], (result) => {
    if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) { console.warn('[Sentinel/settings] Failed to read useTrustedInput:', getErrorMessage(chrome.runtime.lastError)); return; }
    useTrustedInputToggle.checked = result.useTrustedInput;
  });
  useTrustedInputToggle.addEventListener('change', () => {
    const enabled = useTrustedInputToggle.checked;
    chrome.storage.local.set({ useTrustedInput: enabled }, () => {
      if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) {
        console.error('[Sentinel/settings] Failed to save useTrustedInput:', getErrorMessage(chrome.runtime.lastError));
        showToast('Failed to save setting', 'error');
        return;
      }
      try {
        showToast(
          enabled
            ? 'Trusted input ON — debugger banner will appear during runs'
            : 'Trusted input OFF — using synthetic events',
          enabled ? 'success' : 'info'
        );
      } catch (e) { console.warn('[Sentinel] showToast unavailable:', getErrorMessage(e)); }
    });
  });
}

// ========== Sound Notifications Toggle (3.11.3) ==========
// Off by default. When enabled, the agent posts desktop notifications
// (Windows notification chime) for events like MFA challenges, agent stop,
// scheduled-task completion, and mode changes. Chat banners and the Errors
// tab are unaffected either way. The toggle is checked by every
// chrome.notifications.create call site via notifyIfEnabled() in
// background/shared-state.js, so flipping this silences ALL six sites at once.
const soundEnabledToggle = document.getElementById('soundEnabledToggle');
if (soundEnabledToggle) {
  chrome.storage.local.get({ sentinelSoundEnabled: false }, (result) => {
    if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) { console.warn('[Sentinel/settings] Failed to read soundEnabled:', getErrorMessage(chrome.runtime.lastError)); return; }
    soundEnabledToggle.checked = result.sentinelSoundEnabled;
  });
  soundEnabledToggle.addEventListener('change', () => {
    const enabled = soundEnabledToggle.checked;
    chrome.storage.local.set({ sentinelSoundEnabled: enabled }, () => {
      if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) {
        console.error('[Sentinel/settings] Failed to save sentinelSoundEnabled:', getErrorMessage(chrome.runtime.lastError));
        showToast('Failed to save setting', 'error');
        return;
      }
      try {
        showToast(
          enabled
            ? 'Sound notifications ON — desktop toasts enabled'
            : 'Sound notifications OFF — silent mode',
          'info'
        );
      } catch (e) { console.warn('[Sentinel] showToast failed:', window.getErrorMessage ? window.getErrorMessage(e) : String(e)); }
    });
  });
}

// ========== Adaptive Prompts (3.15.0) ==========
// Pre-execution platform-aware goal rewrite. Two settings:
//   adaptivePromptsMode: 'auto' | 'approval' | 'off' (default 'auto')
//   adaptiveExpansionMode: 'off' | 'light' | 'full' (default 'light')
const adaptivePromptsModeSelect = document.getElementById('adaptivePromptsModeSelect');
const adaptiveExpansionModeSelect = document.getElementById('adaptiveExpansionModeSelect');

if (adaptivePromptsModeSelect) {
  chrome.storage.local.get(['adaptivePromptsMode', 'adaptiveExpansionMode'], (result) => {
    if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) { console.warn('[Sentinel/settings] Failed to read adaptivePrompts:', getErrorMessage(chrome.runtime.lastError)); return; }
    adaptivePromptsModeSelect.value = result.adaptivePromptsMode || 'auto';
    if (adaptiveExpansionModeSelect) {
      adaptiveExpansionModeSelect.value = result.adaptiveExpansionMode || 'light';
    }
  });
  adaptivePromptsModeSelect.addEventListener('change', () => {
    const v = adaptivePromptsModeSelect.value;
    chrome.storage.local.set({ adaptivePromptsMode: v }, () => {
      if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) {
        console.error('[Sentinel/settings] Failed to save adaptivePromptsMode:', getErrorMessage(chrome.runtime.lastError));
        showToast('Failed to save setting', 'error');
        return;
      }
      try {
        const label = v === 'auto' ? 'Auto (silent rewrite)' : v === 'approval' ? 'Approval (review diff)' : 'Off';
        showToast(`Adaptive Prompts: ${label}`, 'info');
      } catch (e) { console.warn('[Sentinel] showToast failed:', window.getErrorMessage ? window.getErrorMessage(e) : String(e)); }
    });
  });
}

if (adaptiveExpansionModeSelect) {
  adaptiveExpansionModeSelect.addEventListener('change', () => {
    chrome.storage.local.set({ adaptiveExpansionMode: adaptiveExpansionModeSelect.value }).catch((e) => { console.error('[Sentinel] Error in settings.js:', window.getErrorMessage ? window.getErrorMessage(e) : String(e)); });
  });
}

// ========== Telemetry Verbosity (3.25.0) ==========
// Live Telemetry panel verbosity. Background/telemetry.js reads this on
// every emit() to decide whether to broadcast the event. Storage changes
// take effect immediately via the onChanged listener in telemetry.js.
const telemetryLevelSelect = document.getElementById('telemetryLevelSelect');
if (telemetryLevelSelect) {
  chrome.storage.local.get(['telemetryLevel'], (result) => {
    if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) { console.warn('[Sentinel/settings] Failed to read telemetryLevel:', getErrorMessage(chrome.runtime.lastError)); return; }
    telemetryLevelSelect.value = result.telemetryLevel || 'normal';
  });
  telemetryLevelSelect.addEventListener('change', () => {
    chrome.storage.local.set({ telemetryLevel: telemetryLevelSelect.value }, () => {
      if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) {
        console.error('[Sentinel/settings] Failed to save telemetryLevel:', getErrorMessage(chrome.runtime.lastError));
        showToast('Failed to save setting', 'error');
        return;
      }
      try { showToast(`Telemetry verbosity: ${telemetryLevelSelect.value}`, 'info'); } catch (e) { console.warn('[Sentinel] showToast failed:', window.getErrorMessage ? window.getErrorMessage(e) : String(e)); }
    });
  });
}

// ========== Telemetry Persistence (3.27.0) ==========
// Opt-in checkbox. When enabled, background/telemetry.js mirrors every emit
// into chrome.storage.local keyed by runLogId, with the last 5 runs retained
// (older runs auto-evicted). Survives panel close + browser restart.
// Off by default to keep the storage footprint minimal for users who don't
// need cross-session debugging.
const telemetryPersistToggle = document.getElementById('telemetryPersistToggle');
if (telemetryPersistToggle) {
  chrome.storage.local.get(['telemetryPersist'], (result) => {
    if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) { console.warn('[Sentinel/settings] Failed to read telemetryPersist:', getErrorMessage(chrome.runtime.lastError)); return; }
    telemetryPersistToggle.checked = !!result.telemetryPersist;
  });
  telemetryPersistToggle.addEventListener('change', () => {
    chrome.storage.local.set({ telemetryPersist: telemetryPersistToggle.checked }, () => {
      if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) {
        console.error('[Sentinel/settings] Failed to save telemetryPersist:', getErrorMessage(chrome.runtime.lastError));
        showToast('Failed to save setting', 'error');
        return;
      }
      try {
        showToast(telemetryPersistToggle.checked
          ? 'Telemetry will now persist across sessions (last 5 runs)'
          : 'Telemetry persistence disabled', 'info');
      } catch (e) { console.warn('[Sentinel] showToast failed:', window.getErrorMessage ? window.getErrorMessage(e) : String(e)); }
    });
  });
}

// ========== Telemetry Redaction (3.28.0) ==========
// Default ON. Scrubs API keys, bearer/Basic auth, JWT tokens, OAuth query
// params, and JSON fields named password/secret/apikey/etc. before broadcast
// + persist + export. The SW console (chrome://extensions DevTools) always
// shows raw events regardless of this setting — it's a trust boundary anyway.
// Operators can disable for deep debugging when they need to see raw payloads.
const telemetryRedactToggle = document.getElementById('telemetryRedactToggle');
if (telemetryRedactToggle) {
  chrome.storage.local.get(['telemetryRedact'], (result) => {
    if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) { console.warn('[Sentinel/settings] Failed to read telemetryRedact:', getErrorMessage(chrome.runtime.lastError)); return; }
    // Default ON: only set false if explicitly stored as false.
    telemetryRedactToggle.checked = result.telemetryRedact !== false;
  });
  telemetryRedactToggle.addEventListener('change', () => {
    chrome.storage.local.set({ telemetryRedact: telemetryRedactToggle.checked }, () => {
      if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) {
        console.error('[Sentinel/settings] Failed to save telemetryRedact:', getErrorMessage(chrome.runtime.lastError));
        showToast('Failed to save setting', 'error');
        return;
      }
      try {
        showToast(telemetryRedactToggle.checked
          ? 'Telemetry redaction ON — secrets scrubbed before persist'
          : 'Telemetry redaction OFF — raw payloads will be stored', 'info');
      } catch (e) { console.warn('[Sentinel] showToast failed:', window.getErrorMessage ? window.getErrorMessage(e) : String(e)); }
    });
  });
}

// ========== Adaptive Skill Priority (3.29.0) ==========
// Default ON. Re-ranks recovery skills based on observed outcomes — a skill
// with high success rate (next step succeeded after it fired) gets a boost,
// noisy skills with low success rate get penalized. The "View skill stats"
// button opens a modal showing per-skill fire count, success rate, and the
// gap between base vs effective priority.
const telemetrySkillAdaptToggle = document.getElementById('telemetrySkillAdaptToggle');
if (telemetrySkillAdaptToggle) {
  chrome.storage.local.get(['telemetrySkillAdapt'], (result) => {
    if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) { console.warn('[Sentinel/settings] Failed to read telemetrySkillAdapt:', getErrorMessage(chrome.runtime.lastError)); return; }
    telemetrySkillAdaptToggle.checked = result.telemetrySkillAdapt !== false;
  });
  telemetrySkillAdaptToggle.addEventListener('change', () => {
    chrome.storage.local.set({ telemetrySkillAdapt: telemetrySkillAdaptToggle.checked }, () => {
      if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) {
        console.error('[Sentinel/settings] Failed to save telemetrySkillAdapt:', getErrorMessage(chrome.runtime.lastError));
        showToast('Failed to save setting', 'error');
        return;
      }
      try {
        showToast(telemetrySkillAdaptToggle.checked
          ? 'Adaptive skill priority ON — outcomes will re-rank skills'
          : 'Adaptive skill priority OFF — static priorities only', 'info');
      } catch (e) { console.warn('[Sentinel] showToast failed:', window.getErrorMessage ? window.getErrorMessage(e) : String(e)); }
    });
  });
}

const skillStatsResetBtn = document.getElementById('skillStatsResetBtn');
if (skillStatsResetBtn) {
  skillStatsResetBtn.addEventListener('click', () => {
    if (!confirm('Reset all skill outcome stats? This clears fire counts, success rates, and timing data for every recovery skill. The static priority numbers remain unchanged.')) return;
    chrome.runtime.sendMessage({ action: 'reset_skill_stats' }, (resp) => {
      if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) { console.warn('[Sentinel/settings] Failed to reset skill stats:', getErrorMessage(chrome.runtime.lastError)); return; }
      try {
        if (resp && resp.ok) showToast('Skill stats reset', 'success');
        else showToast(`Reset failed: ${(resp && resp.error) || 'unknown'}`, 'error');
      } catch (e) { console.warn('[Sentinel] showToast failed:', window.getErrorMessage ? window.getErrorMessage(e) : String(e)); }
    });
  });
}

const skillStatsViewBtn = document.getElementById('skillStatsViewBtn');
if (skillStatsViewBtn) {
  skillStatsViewBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'list_skills_with_stats' }, (resp) => {
      if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) { console.warn('[Sentinel/settings] Failed to list skills:', getErrorMessage(chrome.runtime.lastError)); return; }
      const skills = Array.isArray(resp) ? resp : (resp && Array.isArray(resp.data) ? resp.data : []);
      _renderSkillStatsModal(skills);
    });
  });
}

function _renderSkillStatsModal(skills) {
  // Strip any existing modal first so re-clicks always show fresh data.
  const existing = document.getElementById('skillStatsModal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'skillStatsModal';
  modal.className = 'modal-overlay';
  modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:1500; display:flex; align-items:center; justify-content:center; padding:24px;';

  const inner = document.createElement('div');
  inner.className = 'modal-content';
  inner.style.cssText = 'background:var(--bg-secondary, #161616); border:1px solid var(--border-color); border-radius:8px; max-width:min(720px, calc(100vw - 48px)); width:100%; max-height:calc(100vh - 48px); display:flex; flex-direction:column; overflow:hidden;';

  const header = document.createElement('div');
  header.style.cssText = 'padding:14px 18px; border-bottom:1px solid var(--border-color); display:flex; justify-content:space-between; align-items:center;';
  header.innerHTML = '<strong style="font-size:14px;">Recovery skill stats</strong><button id="skillStatsCloseBtn" style="background:transparent; border:none; color:var(--text-secondary); font-size:18px; cursor:pointer;">×</button>';
  inner.appendChild(header);

  const body = document.createElement('div');
  body.style.cssText = 'overflow-y:auto; padding:12px 18px; font-size:12px;';

  if (!skills.length) {
    body.innerHTML = '<p style="color:var(--text-tertiary);">No skills registered.</p>';
  } else {
    const table = document.createElement('table');
    table.style.cssText = 'width:100%; border-collapse:collapse; font-size:12px;';
    table.innerHTML = '<thead><tr style="text-align:left; color:var(--text-tertiary); border-bottom:1px solid var(--border-color);"><th style="padding:6px 4px;">Skill</th><th style="padding:6px 4px; text-align:right;">Fires</th><th style="padding:6px 4px; text-align:right;">Success</th><th style="padding:6px 4px; text-align:right;">Rate</th><th style="padding:6px 4px; text-align:right;">Base</th><th style="padding:6px 4px; text-align:right;">Effective</th></tr></thead>';
    const tbody = document.createElement('tbody');
    // Sort by effectivePriority descending so the most-impactful skills lead.
    skills.sort((a, b) => (b.effectivePriority || 0) - (a.effectivePriority || 0));
    for (const s of skills) {
      const tr = document.createElement('tr');
      tr.style.cssText = 'border-bottom:1px solid var(--border-color);';
      const stats = s.stats || { fires: 0, successes: 0, failures: 0 };
      const rate = stats.fires > 0 ? (stats.successes / stats.fires) : null;
      const rateStr = rate === null || Number.isNaN(rate) ? '—' : `${Math.round(rate * 100)}%`;
      const rateColor = rate === null || Number.isNaN(rate) ? 'var(--text-tertiary)' :
        rate >= 0.7 ? '#9ece6a' :
        rate >= 0.4 ? '#e0af68' :
        '#f44';
      const delta = (s.effectivePriority || 0) - (s.priority || 0);
      const deltaStr = delta === 0 ? '' : (delta > 0 ? ` (+${delta})` : ` (${delta})`);
      const deltaColor = delta > 0 ? '#9ece6a' : delta < 0 ? '#f44' : 'var(--text-tertiary)';
      tr.innerHTML = `<td style="padding:6px 4px;"><strong>${escapeHtml(s.id)}</strong><div style="font-size:10px; color:var(--text-tertiary); margin-top:1px;">${escapeHtml(s.description || '')}</div></td>
        <td style="padding:6px 4px; text-align:right; font-variant-numeric:tabular-nums;">${stats.fires}</td>
        <td style="padding:6px 4px; text-align:right; font-variant-numeric:tabular-nums;">${stats.successes} / ${stats.failures}</td>
        <td style="padding:6px 4px; text-align:right; color:${rateColor}; font-variant-numeric:tabular-nums;">${rateStr}</td>
        <td style="padding:6px 4px; text-align:right; color:var(--text-tertiary); font-variant-numeric:tabular-nums;">${s.priority || 0}</td>
        <td style="padding:6px 4px; text-align:right; font-variant-numeric:tabular-nums;">${s.effectivePriority || 0}<span style="color:${deltaColor};">${deltaStr}</span></td>`;
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    body.appendChild(table);
    const note = document.createElement('p');
    note.style.cssText = 'margin-top:14px; font-size:11px; color:var(--text-tertiary); line-height:1.5;';
    note.textContent = 'Effective priority = base ± up to 20 based on success rate. Requires ≥3 fires before adjusting (avoids judging on tiny samples). Sorted by effective priority descending — top rows fire first when multiple skills match.';
    body.appendChild(note);
  }

  inner.appendChild(body);
  modal.appendChild(inner);
  if (document.body) document.body.appendChild(modal);

  const removeEscClose = () => document.removeEventListener('keydown', escClose);
  const close = () => { modal.remove(); removeEscClose(); };
  const skillStatsCloseBtn = document.getElementById('skillStatsCloseBtn');
  if (skillStatsCloseBtn) skillStatsCloseBtn.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  const escClose = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', escClose);
}

// (3.45.0) Quick Mode — skip planning, reduce delays, action-oriented prompts
const quickModeToggle = document.getElementById('quickModeToggle');
const quickModeLabel = document.getElementById('quickModeLabel');
if (quickModeToggle) {
  chrome.storage.local.get(['quickMode'], (result) => {
    if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) { console.warn('[Sentinel/settings] Failed to read quickMode:', getErrorMessage(chrome.runtime.lastError)); return; }
    const enabled = result.quickMode;
    quickModeToggle.checked = enabled;
    if (quickModeLabel) {
      quickModeLabel.textContent = enabled
        ? 'ON — Fast execution, no planning'
        : 'OFF - Standard pace';
    }
  });
  quickModeToggle.addEventListener('change', () => {
    const enabled = quickModeToggle.checked;
    chrome.storage.local.set({ quickMode: enabled }, () => {
      if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) {
        console.error('[Sentinel/settings] Failed to save quickMode:', getErrorMessage(chrome.runtime.lastError));
        showToast('Failed to save setting', 'error');
        return;
      }
      if (quickModeLabel) {
        quickModeLabel.textContent = enabled
          ? 'ON — Fast execution, no planning'
          : 'OFF - Standard pace';
      }
      try { showToast(enabled ? 'Quick Mode ON — agent will move fast' : 'Quick Mode OFF — standard pace', 'success'); } catch (e) { console.warn('[Sentinel] showToast failed:', window.getErrorMessage ? window.getErrorMessage(e) : String(e)); }
    });
  });
}

// ========== API Health Bar ==========
const apiHealthBarToggle = document.getElementById('apiHealthBarToggle');
if (apiHealthBarToggle) {
  chrome.storage.local.get(['show_api_health_bar'], (result) => {
    if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) { console.warn('[Sentinel/settings] Failed to read show_api_health_bar:', getErrorMessage(chrome.runtime.lastError)); return; }
    apiHealthBarToggle.checked = !!result.show_api_health_bar; // default OFF
  });
  apiHealthBarToggle.addEventListener('change', () => {
    const enabled = apiHealthBarToggle.checked;
    chrome.storage.local.set({ show_api_health_bar: enabled }, () => {
      if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) {
        console.error('[Sentinel/settings] Failed to save show_api_health_bar:', getErrorMessage(chrome.runtime.lastError));
        showToast('Failed to save setting', 'error');
        return;
      }
      const bar = document.getElementById('api-health-bar');
      if (bar) bar.style.display = enabled ? 'flex' : 'none';
      try { showToast(enabled ? 'API Health Bar ON' : 'API Health Bar OFF', 'success'); } catch (e) { console.warn('[Sentinel] showToast failed:', window.getErrorMessage ? window.getErrorMessage(e) : String(e)); }
    });
  });
}

// ========== Ticket Mode (3.14.0) ==========
// Toggle wraps every finish summary into one of six MSP templates
// (TICKET_KICKOFF / FINAL_NOTES / WAITING_ON_CLIENT / WAITING_ON_VENDOR /
// IT_GLUE_KB / CLIENT_EMAIL). When off, only ticket-shaped goals get
// auto-formatted into FINAL_NOTES (legacy 3.8.0 behavior).
// Technician details are persisted to chrome.storage.local.technicianInfo
// and consumed by background/agent-engine.js's getTechnicianInfo().
const ticketModeToggle = document.getElementById('ticketModeToggle');
const ticketFormatRow = document.getElementById('ticketFormatRow');
const ticketFormatSelect = document.getElementById('ticketFormatSelect');
const __TECH_INPUTS = {
  name:    document.getElementById('techNameInput'),
  title:   document.getElementById('techTitleInput'),
  company: document.getElementById('techCompanyInput'),
  phone:   document.getElementById('techPhoneInput'),
  email:   document.getElementById('techEmailInput'),
};
const TECH_DEFAULTS = {
  name: '',
  title: '',
  company: '',
  phone: '',
  email: ''
};

function __setTicketFormatRowVisible(visible) {
  if (!ticketFormatRow) return;
  ticketFormatRow.style.display = visible ? 'block' : 'none';
}

if (ticketModeToggle) {
  // Load saved state and prefill technician fields.
  chrome.storage.local.get(['ticketMode', 'ticketFormat', 'technicianInfo'], (result) => {
    if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) { console.warn('[Sentinel/settings] Failed to read ticketMode:', getErrorMessage(chrome.runtime.lastError)); return; }
    const enabled = result.ticketMode;
    ticketModeToggle.checked = enabled;
    __setTicketFormatRowVisible(enabled);
    if (ticketFormatSelect) {
      ticketFormatSelect.value = result.ticketFormat || 'auto';
    }
    const tech = { ...TECH_DEFAULTS, ...(result.technicianInfo || {}) };
    for (const key of Object.keys(__TECH_INPUTS)) {
      const el = __TECH_INPUTS[key];
      if (el) el.value = tech[key] || '';
    }
  });

  ticketModeToggle.addEventListener('change', () => {
    const enabled = ticketModeToggle.checked;
    __setTicketFormatRowVisible(enabled);
    chrome.storage.local.set({ ticketMode: enabled }, () => {
      if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) {
        console.error('[Sentinel/settings] Failed to save ticketMode:', getErrorMessage(chrome.runtime.lastError));
        showToast('Failed to save setting', 'error');
        return;
      }
      try {
        showToast(
          enabled
            ? 'Ticket Mode ON — finish summaries will be formatted as ticket blocks'
            : 'Ticket Mode OFF — auto-formatting on ticket-shaped goals only',
          enabled ? 'success' : 'info'
        );
      } catch (e) { console.warn('[Sentinel] showToast failed:', window.getErrorMessage ? window.getErrorMessage(e) : String(e)); }
    });
  });
}

if (ticketFormatSelect) {
  ticketFormatSelect.addEventListener('change', () => {
    chrome.storage.local.set({ ticketFormat: ticketFormatSelect.value }).catch((e) => { console.error('[Sentinel] Error saving ticket format:', window.getErrorMessage ? window.getErrorMessage(e) : String(e)); });
  });
}

// Debounced save for technician inputs — on every keystroke.
{
  let __techSaveTimer = null;
  const queueTechSave = () => {
    if (__techSaveTimer) clearTimeout(__techSaveTimer);
    __techSaveTimer = setTimeout(() => {
      const tech = {};
      for (const key of Object.keys(__TECH_INPUTS)) {
        const el = __TECH_INPUTS[key];
        const trimmed = el && el.value ? el.value.trim() : '';
        if (trimmed) tech[key] = trimmed;
      }
      chrome.storage.local.set({ technicianInfo: tech }).catch((e) => { console.error('[Sentinel] Error in settings.js:', window.getErrorMessage ? window.getErrorMessage(e) : String(e)); });
    }, 400);
  };
  for (const key of Object.keys(__TECH_INPUTS)) {
    const el = __TECH_INPUTS[key];
    if (el) el.addEventListener('input', queueTechSave);
  }
}

// ========== Expected Tenant (3.7.0) ==========
// Cross-client safety: when set, the header chip on Microsoft admin URLs
// turns green when the detected tenant matches and red when it doesn't.
const expectedTenantInput = document.getElementById('expectedTenantInput');
if (expectedTenantInput) {
  chrome.storage.local.get(['expectedTenant'], (result) => {
    if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) { console.warn('[Sentinel/settings] Failed to read expectedTenant:', getErrorMessage(chrome.runtime.lastError)); return; }
    if (typeof result.expectedTenant === 'string') {
      expectedTenantInput.value = result.expectedTenant;
    }
  });
  // Save on every change (debounced lightly so we don't spam storage).
  let __tenantSaveTimer = null;
  expectedTenantInput.addEventListener('input', () => {
    if (__tenantSaveTimer) clearTimeout(__tenantSaveTimer);
    __tenantSaveTimer = setTimeout(() => {
      const v = (expectedTenantInput.value || '').trim();
      chrome.storage.local.set({ expectedTenant: v }).catch((e) => { console.error('[Sentinel] Error in settings.js:', window.getErrorMessage ? window.getErrorMessage(e) : String(e)); });
    }, 350);
  });
}

// ========== Theme Toggle ==========
if (themeToggle) themeToggle.addEventListener('click', toggleTheme);

// ========== Settings Modal ==========
// ========== Learned Patterns Viewer ==========
function _renderLearnedPatterns(patterns) {
  const list = document.getElementById('learnedPatternsList');
  if (!list) return;
  if (!patterns || !Array.isArray(patterns) || !patterns.length) {
    list.innerHTML = '<em style="color:var(--text-tertiary,#666);">No patterns saved yet.</em>';
    return;
  }
  list.innerHTML = patterns.map((p, i) => {
    const date = p.timestamp && !Number.isNaN(Date.parse(p.timestamp)) ? new Date(p.timestamp).toLocaleDateString() : '';
    const steps = Array.isArray(p.steps) ? p.steps.length : '?';
    const safeGoal = escapeHtml(p.goal || '(no goal)');
    return `<div style="display:flex; align-items:center; justify-content:space-between; padding:4px 0; border-bottom:1px solid var(--border-color);">
      <span title="${safeGoal}" style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-right:8px;">${i + 1}. ${safeGoal} <span style="color:var(--text-tertiary,#666);">(${steps} steps, ${date})</span></span>
      <button data-idx="${i}" class="delete-pattern-btn" style="font-size:10px; padding:1px 6px; border-radius:4px; border:1px solid var(--error-color,#ef4444); background:transparent; color:var(--error-color,#ef4444); cursor:pointer; flex-shrink:0;">✕</button>
    </div>`;
  }).join('');
  list.querySelectorAll('.delete-pattern-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        const idx = parseInt(btn.dataset.idx, 10);
        if (Number.isNaN(idx) || idx < 0) return;
        const s = await chrome.storage.local.get(['learned_patterns']);
        const arr = s.learned_patterns || [];
        if (idx >= 0 && idx < arr.length) arr.splice(idx, 1);
        await chrome.storage.local.set({ learned_patterns: arr });
        _renderLearnedPatterns(arr);
      } catch (e) { console.warn('[Sentinel] delete pattern failed:', window.getErrorMessage ? window.getErrorMessage(e) : String(e)); }
    });
  });
}

const clearAllPatternsBtn = document.getElementById('clearAllPatternsBtn');
if (clearAllPatternsBtn) {
  clearAllPatternsBtn.addEventListener('click', async () => {
    try {
      await chrome.storage.local.set({ learned_patterns: [] });
      _renderLearnedPatterns([]);
    } catch (e) { console.warn('[Sentinel] clear patterns failed:', window.getErrorMessage ? window.getErrorMessage(e) : String(e)); }
  });
}

const downloadAuditLogBtn = document.getElementById('downloadAuditLogBtn');
if (downloadAuditLogBtn) {
  downloadAuditLogBtn.addEventListener('click', async () => {
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'get_audit_log' });
      if (!resp || !resp.ok) {
        downloadAuditLogBtn.textContent = 'No log available';
        setTimeout(() => { downloadAuditLogBtn.textContent = 'Download Audit Log CSV'; }, 2000);
        return;
      }
      const csv = resp.csv || '';
      if (!csv || csv.split('\n').length <= 1) {
        downloadAuditLogBtn.textContent = 'Log is empty';
        setTimeout(() => { downloadAuditLogBtn.textContent = 'Download Audit Log CSV'; }, 2000);
        return;
      }
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'sentinel-audit-log.csv';
      if (document.body) document.body.appendChild(a);
      a.click();
      if (document.body) document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      downloadAuditLogBtn.textContent = `Error: ${window.getErrorMessage ? window.getErrorMessage(e) : String(e)}`;
      setTimeout(() => { downloadAuditLogBtn.textContent = 'Download Audit Log CSV'; }, 3000);
    }
  });
}

if (settingsBtn) settingsBtn.addEventListener('click', async () => {
  const state = getState();
  // Load provider settings from storage
  let stored;
  try {
    stored = await chrome.storage.local.get(['active_provider', 'providers', 'api_endpoint', 'api_key', 'model']);
  } catch (e) {
    console.warn('[Sentinel/settings] storage read failed:', window.getErrorMessage ? window.getErrorMessage(e) : String(e));
    stored = {};
  }

  if (stored.providers) {
    state.providerConfigs = stored.providers;
    state.activeProviderId = stored.active_provider || 'openai';
  } else {
    // Legacy fallback -- migrate on the fly for display
    const providerId = (stored.api_endpoint || '').includes('api.anthropic.com') ? 'anthropic' : 'openai';
    state.providerConfigs = {
      anthropic: { api_key: '', model: 'claude-haiku-4-5-20251001', endpoint: 'https://api.anthropic.com/v1/messages', max_tokens: 8000, temperature: 0.3 },
      openai: { api_key: stored.api_key || '', model: stored.model || 'gpt-4o', endpoint: stored.api_endpoint || 'https://api.openai.com/v1/chat/completions', max_tokens: 8000, temperature: 0.3 }
    };
    state.activeProviderId = providerId;
  }

  switchProviderCard(state.activeProviderId);
  // Seed the saved-key tracker from storage so the inline indicator reflects
  // the real persisted state the moment the modal opens.
  _lastSavedProviderKey = (state.providerConfigs[state.activeProviderId] || {}).api_key || '';
  refreshProviderSaveStatus();
  // Sync the catalog dropdown to the active provider
  const catalogSel = document.getElementById('providerCatalogSelect');
  if (catalogSel) {
    // Try to match by endpoint first (most reliable), then by provider ID
    const activeConfig = state.providerConfigs[state.activeProviderId] || {};
    const _activeEndpoint = activeConfig.endpoint || '';
    let matched = false;
    if (catalogSel.options) {
      for (const opt of catalogSel.options) {
        if (opt.value === state.activeProviderId) {
          catalogSel.value = state.activeProviderId;
          matched = true;
          break;
        }
      }
    }
    if (!matched) catalogSel.value = ''; // custom or unknown provider
  }
  if (settingsModal) settingsModal.classList.add('show');
  // Load and render learned patterns
  chrome.storage.local.get(['learned_patterns'], (s) => {
    if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) { console.warn('[Sentinel/settings] Failed to read learned patterns:', getErrorMessage(chrome.runtime.lastError)); return; }
    _renderLearnedPatterns(s.learned_patterns || []);
  });
});

if (closeSettingsBtn) closeSettingsBtn.addEventListener('click', () => {
  if (settingsModal) settingsModal.classList.remove('show');
});

// Tracks the API key currently persisted in storage for the active provider,
// so the inline status indicator can tell "saved" from "unsaved edits".
let _lastSavedProviderKey = null;

// Update the inline "API key saved / unsaved" indicator under Test Connection.
// kind: 'saved' | 'unsaved' | 'hidden'. When no key is entered, stays hidden.
function setProviderSaveStatus(kind) {
  const el = document.getElementById('providerSaveStatus');
  if (!el) return;
  const key = setProviderKey && setProviderKey.value ? setProviderKey.value.trim() : '';
  if (kind === 'hidden' || !key) {
    el.style.display = 'none';
    el.textContent = '';
    return;
  }
  el.style.display = 'block';
  if (kind === 'saved') {
    el.textContent = '✓ API key saved';
    el.style.color = 'var(--success-color, #00aa44)';
  } else {
    el.textContent = '● Unsaved changes — click Save Settings';
    el.style.color = 'var(--warning-color, #ffaa00)';
  }
}

// Recompute the indicator by comparing the form key to the last persisted key.
function refreshProviderSaveStatus() {
  const key = setProviderKey && setProviderKey.value ? setProviderKey.value.trim() : '';
  if (!key) { setProviderSaveStatus('hidden'); return; }
  setProviderSaveStatus(key === _lastSavedProviderKey ? 'saved' : 'unsaved');
}

// Persist the current provider form values to chrome.storage.local under the
// active provider, in the exact shape getActiveProvider() / boot-catcher read.
// Shared by "Save Settings" and a successful "Test Connection" so that a config
// the user just verified is never silently lost when they close the modal
// without clicking Save — the root cause of "tested fine but says no API key".
// Returns a Promise resolving to the activeProviderId on success, or null on failure.
function persistProviderConfig(endpoint, apiKey, model) {
  return new Promise((resolve) => {
    const state = getState();
    const activeProviderId = state.activeProviderId || 'openai';
    state.providerConfigs = state.providerConfigs || {};
    state.providerConfigs[activeProviderId] = {
      api_key: apiKey,
      model: model,
      endpoint: endpoint,
      max_tokens: 8000,
      temperature: 0.3
    };
    chrome.storage.local.set({
      active_provider: activeProviderId,
      providers: state.providerConfigs
    }, () => {
      if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) {
        console.error('[Sentinel/settings] persistProviderConfig failed:', getErrorMessage(chrome.runtime.lastError));
        resolve(null);
        return;
      }
      // Reflect the freshly persisted key in the inline status indicator.
      _lastSavedProviderKey = apiKey;
      try { setProviderSaveStatus('saved'); } catch (_e) { /* non-fatal */ }
      resolve(activeProviderId);
    });
  });
}

if (saveSettingsBtn) saveSettingsBtn.addEventListener('click', async () => {
  const endpoint = setProviderEndpoint && setProviderEndpoint.value ? setProviderEndpoint.value.trim() : '';
  const apiKey = setProviderKey && setProviderKey.value ? setProviderKey.value.trim() : '';
  const model = setProviderModel && setProviderModel.value ? setProviderModel.value.trim() : '';
  const format = exportFormatSelect && exportFormatSelect.value ? exportFormatSelect.value : '';
  const agentContextEl = document.getElementById('set-agent-context');
  const agentContext = agentContextEl && agentContextEl.value ? agentContextEl.value.trim() : '';

  if (!apiKey) {
    showToast('API key is required', 'error');
    return;
  }

  if (endpoint && !isValidUrl(endpoint)) {
    showToast('Invalid API endpoint URL', 'error');
    return;
  }

  // Save provider config via the shared helper (single source of truth for the
  // storage shape) plus the non-provider preferences.
  const activeProviderId = await persistProviderConfig(endpoint, apiKey, model);
  if (!activeProviderId) {
    showToast('Failed to save settings', 'error');
    return;
  }

  chrome.storage.local.set({
    export_format: format,
    agent_context: agentContext
  }, () => {
    if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) {
      console.error('[Sentinel/settings] Failed to save preferences:', getErrorMessage(chrome.runtime.lastError));
      showToast('Failed to save settings', 'error');
      return;
    }
    if (settingsModal) settingsModal.classList.remove('show');
    showToast(`Settings saved (${activeProviderId})`, 'success');
  });
});

// ========== Theme Customization ==========
const themeButtons = document.querySelectorAll('[data-theme]');
if (themeButtons.length) {
  themeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const theme = btn.dataset.theme;
      const allThemeButtons = document.querySelectorAll('[data-theme]');
      if (allThemeButtons.length) {
        allThemeButtons.forEach(b => b.classList.remove('active'));
      }
      btn.classList.add('active');
      applyThemePreset(theme);
    });
  });
}

function applyThemePreset(theme) {
  const presets = {
    light: {
      '--bg-primary': '#ffffff',
      '--text-primary': '#0d0d0d',
      '--accent-primary': '#0084ff'
    },
    dark: {
      '--bg-primary': '#0d0d0d',
      '--text-primary': '#ffffff',
      '--accent-primary': '#0084ff'
    },
    matrix: {
      '--bg-primary': '#0a0a0a',
      '--bg-secondary': '#0d1a0d',
      '--bg-tertiary': '#112211',
      '--bg-input': '#0d1a0d',
      '--text-primary': '#00ff41',
      '--text-secondary': '#00cc33',
      '--text-tertiary': '#00802a',
      '--accent-primary': '#00ff41',
      '--accent-hover': '#00cc33',
      '--border-color': '#004d1a',
      '--message-user-bg': '#00ff41',
      '--message-user-text': '#0a0a0a',
      '--message-assistant-bg': '#0d1a0d',
      '--message-assistant-text': '#00ff41',
      '--code-bg': '#050d05',
      '--error-color': '#ff3333',
      '--success-color': '#00ff41',
      '--warning-color': '#ffcc00'
    },
    tron: {
      '--bg-primary': '#000000',
      '--bg-secondary': '#0a0a14',
      '--bg-tertiary': '#10102a',
      '--bg-input': '#0a0a1a',
      '--text-primary': '#00d4ff',
      '--text-secondary': '#80e8ff',
      '--text-tertiary': '#4a6a7a',
      '--accent-primary': '#00d4ff',
      '--accent-hover': '#00a8cc',
      '--border-color': '#003344',
      '--message-user-bg': '#00d4ff',
      '--message-user-text': '#000000',
      '--message-assistant-bg': '#0a0a18',
      '--message-assistant-text': '#80e8ff',
      '--code-bg': '#050510',
      '--error-color': '#ff4444',
      '--success-color': '#00d4ff',
      '--warning-color': '#ff8800'
    },
    cyberpunk: {
      '--bg-primary': '#0d0221',
      '--bg-secondary': '#150535',
      '--bg-tertiary': '#1e0845',
      '--bg-input': '#1a0640',
      '--text-primary': '#ff2a6d',
      '--text-secondary': '#d1c4e9',
      '--text-tertiary': '#7c6f99',
      '--accent-primary': '#ff2a6d',
      '--accent-hover': '#ff5599',
      '--border-color': '#3d1a6e',
      '--message-user-bg': '#ff2a6d',
      '--message-user-text': '#0d0221',
      '--message-assistant-bg': '#150535',
      '--message-assistant-text': '#d1c4e9',
      '--code-bg': '#0a0118',
      '--error-color': '#ff0040',
      '--success-color': '#05d9e8',
      '--warning-color': '#f5f500'
    },
    neon: {
      '--bg-primary': '#0a0014',
      '--bg-secondary': '#12001f',
      '--bg-tertiary': '#1a002a',
      '--bg-input': '#160025',
      '--text-primary': '#e040fb',
      '--text-secondary': '#ce93d8',
      '--text-tertiary': '#7b5e80',
      '--accent-primary': '#e040fb',
      '--accent-hover': '#ab47bc',
      '--border-color': '#38006b',
      '--message-user-bg': '#e040fb',
      '--message-user-text': '#0a0014',
      '--message-assistant-bg': '#12001f',
      '--message-assistant-text': '#ce93d8',
      '--code-bg': '#08000f',
      '--error-color': '#ff1744',
      '--success-color': '#00e676',
      '--warning-color': '#ffea00'
    },
    terminal: {
      '--bg-primary': '#1a1a1a',
      '--bg-secondary': '#222222',
      '--bg-tertiary': '#2a2a2a',
      '--bg-input': '#1e1e1e',
      '--text-primary': '#33ff33',
      '--text-secondary': '#b0b0b0',
      '--text-tertiary': '#666666',
      '--accent-primary': '#33ff33',
      '--accent-hover': '#22cc22',
      '--border-color': '#333333',
      '--message-user-bg': '#33ff33',
      '--message-user-text': '#1a1a1a',
      '--message-assistant-bg': '#222222',
      '--message-assistant-text': '#cccccc',
      '--code-bg': '#111111',
      '--error-color': '#ff4444',
      '--success-color': '#33ff33',
      '--warning-color': '#ffaa00'
    },
    blood: {
      '--bg-primary': '#0a0000',
      '--bg-secondary': '#140000',
      '--bg-tertiary': '#1e0000',
      '--bg-input': '#160000',
      '--text-primary': '#ff1a1a',
      '--text-secondary': '#cc8888',
      '--text-tertiary': '#664444',
      '--accent-primary': '#ff1a1a',
      '--accent-hover': '#cc0000',
      '--border-color': '#330000',
      '--message-user-bg': '#ff1a1a',
      '--message-user-text': '#0a0000',
      '--message-assistant-bg': '#140000',
      '--message-assistant-text': '#cc8888',
      '--code-bg': '#080000',
      '--error-color': '#ff0000',
      '--success-color': '#00cc44',
      '--warning-color': '#ff6600'
    }
  };

  if (presets[theme]) {
    // Save to localStorage
    try {
      localStorage.setItem('theme-named', theme);
    } catch (e) {
      console.warn('[Sentinel/settings] Failed to save theme-named:', window.getErrorMessage ? window.getErrorMessage(e) : String(e));
      showToast('Failed to save theme', 'error');
    }
    // Remove all theme glow classes
    if (document.body) {
      document.body.className = (document.body.className || '')
        .replace(/theme-\S+/g, '')
        .trim();
    }

    // Toggle dark-mode class for dark themes
    if (document.body) {
      document.body.classList.toggle('dark-mode', darkThemes.has(theme));
    }

    // Add theme glow class for themed presets
    if (!baseThemes.has(theme)) {
      if (document.body) {
        document.body.classList.add(`theme-${theme}`);
      }
    }

    Object.entries(presets[theme]).forEach(([key, value]) => {
      document.documentElement.style.setProperty(key, value);
    });
  }
}

if (saveThemeBtn) saveThemeBtn.addEventListener('click', () => {
  const primaryEl = document.getElementById('colorPrimary');
  const bgEl = document.getElementById('colorBg');
  const textEl = document.getElementById('colorText');
  const primary = primaryEl ? primaryEl.value : '';
  const bg = bgEl ? bgEl.value : '';
  const text = textEl ? textEl.value : '';

  document.documentElement.style.setProperty('--accent-primary', primary);
  document.documentElement.style.setProperty('--bg-primary', bg);
  document.documentElement.style.setProperty('--text-primary', text);

  try {
    localStorage.setItem('custom-theme', JSON.stringify({ primary, bg, text }));
  } catch (e) {
    console.warn('[Sentinel/settings] Failed to save custom theme:', window.getErrorMessage ? window.getErrorMessage(e) : String(e));
    showToast('Failed to save custom theme', 'error');
  }
  if (themeModal) themeModal.classList.remove('show');
  showToast('Theme applied', 'success');
});

if (closeThemeBtn) closeThemeBtn.addEventListener('click', () => {
  if (themeModal) themeModal.classList.remove('show');
});

// ========== Preset Buttons ==========
const presetButtons = document.querySelectorAll('.preset-btn');
if (presetButtons.length) {
  presetButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const provider = btn.dataset.provider || ((btn.dataset.endpoint || '').includes('api.anthropic.com') ? 'anthropic' : 'openai');
      switchProviderCard(provider);
      if (setProviderEndpoint) setProviderEndpoint.value = btn.dataset.endpoint || '';
      if (setProviderModel) setProviderModel.value = btn.dataset.model || '';
      showToast(`Preset loaded: ${typeof btn.textContent === 'string' ? btn.textContent : ''}`, 'success');
    });
  });
}

// ========== Test Connection Button ==========
const testConnectionBtn = document.getElementById('testConnectionBtn');
if (testConnectionBtn) testConnectionBtn.addEventListener('click', async () => {
  const endpoint = setProviderEndpoint && setProviderEndpoint.value ? setProviderEndpoint.value.trim() : '';
  const apiKey = setProviderKey && setProviderKey.value ? setProviderKey.value.trim() : '';
  const model = setProviderModel && setProviderModel.value ? setProviderModel.value.trim() : '';

  if (!endpoint || !apiKey || !model) {
    showToast('Fill in endpoint, API key, and model first', 'error');
    return;
  }

  const prevText = testConnectionBtn.textContent;
  testConnectionBtn.textContent = 'Testing...';
  testConnectionBtn.disabled = true;

  try {
    // Determine provider format from endpoint (popup context cannot import background modules)
    const isAnthropic = endpoint.includes('api.anthropic.com');
    const headers = isAnthropic
      ? { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }
      : { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
    const body = JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch(endpoint, { method: 'POST', headers, body, signal: controller.signal });
    clearTimeout(timer);

    if (resp.ok) {
      // Persist the verified config immediately. Previously Test only validated
      // form values and saved nothing, so a user who tested OK then closed the
      // modal without clicking "Save Settings" had no key in storage — the agent
      // then failed at runtime with "API key not configured" ("no API"). Saving
      // here makes "Connection OK" mean the config is actually usable.
      const savedId = await persistProviderConfig(endpoint, apiKey, model);
      showToast(savedId ? '✓ Connection OK — settings saved' : '✓ Connection OK — but save failed', savedId ? 'success' : 'error');
    } else {
      const errText = (await resp.text()).slice(0, 200);
      const hint = resp.status === 401 ? 'Check your API key.' : resp.status === 403 ? 'Your plan may not include this model.' : resp.status >= 500 ? 'The API server is having issues.' : '';
      showToast(`Connection failed (${resp.status}): ${hint || errText}`, 'error');
    }
  } catch (err) {
    const msg = String(err);
    if (msg.includes('Failed to fetch')) showToast('Network error — check your internet connection.', 'error');
    else showToast(`Connection error: ${msg.slice(0, 120)}`, 'error');
  } finally {
    testConnectionBtn.textContent = prevText;
    testConnectionBtn.disabled = false;
  }
});

// Editing any provider field means the in-memory form no longer matches what's
// persisted — flip the indicator to "unsaved" so the user knows to Save/Test.
[setProviderKey, setProviderModel, setProviderEndpoint].forEach((field) => {
  if (field && typeof field.addEventListener === 'function') {
    field.addEventListener('input', () => { try { refreshProviderSaveStatus(); } catch (_e) { /* non-fatal */ } });
  }
});

// ========== Provider Catalog Auto-Detect (3.10.0) ==========
// Loads the 16-provider catalog from the background, populates the dropdown,
// auto-fills the endpoint on selection, and provides a Detect Models button
// that calls the provider's /models endpoint with the user's API key.


(function wireProviderCatalog() {
  const sel = document.getElementById('providerCatalogSelect');
  const detectBtn = document.getElementById('detectModelsBtn');
  const modelsSel = document.getElementById('detectedModelsSelect');
  const useBtn = document.getElementById('useDetectedModelBtn');
  if (!sel || !detectBtn || !modelsSel || !useBtn) return;

  let catalog = [];
  // Expose catalog to switchProviderCard for default lookups
  window.catalogRef = catalog;

  function refreshCatalog() {
    chrome.runtime.sendMessage({ action: 'get_provider_catalog' }, (resp) => {
      if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) { console.warn('[Sentinel/settings] Failed to get provider catalog:', getErrorMessage(chrome.runtime.lastError)); return; }
      const data = (resp && resp.data) ? resp.data : resp;
      if (!Array.isArray(data)) return;
      catalog = data;
      sel.innerHTML = '<option value="">- Pick a provider -</option>';
      for (const p of catalog) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.label;
        sel.appendChild(opt);
      }
    });
  }
  refreshCatalog();

  sel.addEventListener('change', () => {
    const id = sel.value;
    if (!id) return;
    const provider = catalog.find(p => p.id === id);
    if (!provider) return;

    // Update active provider ID in state
    const state = getState();
    state.activeProviderId = id;

    // Check if we have saved config for this provider
    const savedConfig = (state.providerConfigs || {})[id] || {};

    // Auto-fill endpoint (saved > catalog default)
    const epInput = document.getElementById('set-provider-endpoint');
    if (epInput) {
      epInput.value = savedConfig.endpoint || provider.endpoint || '';
    }

    // Auto-fill model (saved > catalog default)
    const modelInput = document.getElementById('set-provider-model');
    if (modelInput) {
      modelInput.value = savedConfig.model || provider.defaultModel || '';
    }

    // Auto-fill API key from saved config
    const keyInput = document.getElementById('set-provider-key');
    if (keyInput) {
      keyInput.value = savedConfig.api_key || '';
    }

    // The active provider just changed — re-baseline the saved-key tracker to
    // this provider's persisted key so the indicator reflects its real state.
    _lastSavedProviderKey = savedConfig.api_key || '';
    refreshProviderSaveStatus();

    // Reset detected models dropdown
    modelsSel.innerHTML = '<option value="">(click Detect Models to populate)</option>';
    modelsSel.disabled = true;
    useBtn.disabled = true;

    // Auto-detect models if we have a key and a models URL
    if (savedConfig.api_key && provider.modelsUrl) {
      // Silently attempt model detection
      try { showToast(`Endpoint set for ${provider.label}`, 'info'); } catch (_e) { /* non-fatal */ }
    } else {
      try { showToast(`Endpoint set for ${provider.label}${provider.auth === 'none' ? ' (no key needed)' : ''}`, 'info'); } catch (_e) { /* non-fatal */ }
    }
  });

  detectBtn.addEventListener('click', async () => {
    const id = sel.value;
    if (!id) {
      try { showToast('Pick a provider first', 'error'); } catch (e) { console.warn('[Sentinel] showToast failed:', window.getErrorMessage ? window.getErrorMessage(e) : String(e)); }
      return;
    }
    const apiKey = (document.getElementById('set-provider-key') || {}).value || '';
    const customEndpoint = (document.getElementById('set-provider-endpoint') || {}).value || '';
    const prevText = detectBtn.textContent;
    detectBtn.textContent = 'Detecting...';
    detectBtn.disabled = true;
    modelsSel.innerHTML = '<option value="">(fetching...)</option>';
    modelsSel.disabled = true;
    useBtn.disabled = true;
    try {
      const resp = await chrome.runtime.sendMessage({
        action: 'fetch_provider_models',
        providerId: id,
        apiKey,
        customEndpoint
      });
      const data = (resp && resp.data) ? resp.data : resp;
      if (!data || !data.ok) {
        const msg = (data && data.error) || 'Unknown error';
        const hint = msg.includes('401') ? 'Check your API key.' : msg.includes('fetch') ? 'Network error — check your connection.' : msg;
        try { showToast(`Model detection failed: ${hint}`, 'error'); } catch (e) { console.warn('[Sentinel] showToast failed:', window.getErrorMessage ? window.getErrorMessage(e) : String(e)); }
        modelsSel.innerHTML = '<option value="">(detection failed — enter model manually)</option>';
        return;
      }
      const models = data.models || [];
      if (!models.length) {
        modelsSel.innerHTML = '<option value="">(no models returned)</option>';
        try { showToast('No models returned', 'error'); } catch (e) { console.warn('[Sentinel] showToast failed:', window.getErrorMessage ? window.getErrorMessage(e) : String(e)); }
        return;
      }
      modelsSel.innerHTML = '';
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = `- Select a model (${models.length} available) -`;
      modelsSel.appendChild(placeholder);
      for (const m of models) {
        const o = document.createElement('option');
        o.value = m;
        o.textContent = m;
        modelsSel.appendChild(o);
      }
      modelsSel.disabled = false;
      useBtn.disabled = false;
      try { showToast(`Detected ${models.length} models`, 'success'); } catch (e) { console.warn('[Sentinel] showToast failed:', window.getErrorMessage ? window.getErrorMessage(e) : String(e)); }
    } catch (e) {
      try { showToast(`Error: ${String(e)}`, 'error'); } catch (e) { console.warn('[Sentinel] showToast failed:', window.getErrorMessage ? window.getErrorMessage(e) : String(e)); }
      modelsSel.innerHTML = '<option value="">(error - see toast)</option>';
    } finally {
      detectBtn.textContent = prevText;
      detectBtn.disabled = false;
    }
  });

  useBtn.addEventListener('click', () => {
    const value = modelsSel.value;
    if (!value) {
      try { showToast('Pick a model from the list first', 'error'); } catch (e) { console.warn('[Sentinel] showToast failed:', window.getErrorMessage ? window.getErrorMessage(e) : String(e)); }
      return;
    }
    const modelInput = document.getElementById('set-provider-model');
    if (modelInput) {
      modelInput.value = value;
      try { refreshProviderSaveStatus(); } catch (_e) { /* non-fatal */ }
      try { showToast(`Model set to ${value}`, 'success'); } catch (e) { console.warn('[Sentinel] showToast failed:', window.getErrorMessage ? window.getErrorMessage(e) : String(e)); }
    }
  });
})();

(function wireCustomCss() {
  const STYLE_ID = 'sentinel-custom-css';
  const STORAGE_KEY = 'sentinel-custom-css';

  function applyCustomCss(css) {
    try {
      let el = document.getElementById(STYLE_ID);
      if (!el) {
        el = document.createElement('style');
        el.id = STYLE_ID;
        if (document.head) {
          document.head.appendChild(el);
        }
      }
      el.textContent = css || '';
    } catch (e) {
      console.warn('[Sentinel/settings] CSS application failed:', window.getErrorMessage ? window.getErrorMessage(e) : String(e));
    }
  }

  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) applyCustomCss(saved);
  } catch (e) {
    console.warn('[Sentinel/settings] localStorage access failed:', window.getErrorMessage ? window.getErrorMessage(e) : String(e));
  }

  function wire() {
    const ta = document.getElementById('customCssTextarea');
    const applyBtn = document.getElementById('customCssApplyBtn');
    const clearBtn = document.getElementById('customCssClearBtn');
    const statusEl = document.getElementById('customCssStatus');
    if (!ta) return;

    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) ta.value = saved;
    } catch (e) {
      console.warn('[Sentinel/settings] localStorage access failed:', window.getErrorMessage ? window.getErrorMessage(e) : String(e));
    }

    let saveTimer = null;
    const setStatus = (text, color) => {
      if (!statusEl) return;
      statusEl.textContent = text || '';
      statusEl.style.color = color || 'var(--text-tertiary)';
      if (text) {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => { statusEl.textContent = ''; }, 2200);
      }
    };

    let debounce = null;
    ta.addEventListener('input', () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        const css = ta.value || '';
        try { localStorage.setItem(STORAGE_KEY, css); } catch (e) {
        console.warn('[Sentinel/settings] localStorage save failed:', window.getErrorMessage ? window.getErrorMessage(e) : String(e));
      }
        applyCustomCss(css);
        setStatus('saved', '#6fcf80');
      }, 350);
    });

    if (applyBtn) applyBtn.addEventListener('click', () => {
      const css = ta.value || '';
      try { localStorage.setItem(STORAGE_KEY, css); } catch (e) {
        console.warn('[Sentinel/settings] localStorage save failed:', window.getErrorMessage ? window.getErrorMessage(e) : String(e));
      }
      applyCustomCss(css);
      setStatus('applied', '#6fcf80');
    });
    if (clearBtn) clearBtn.addEventListener('click', () => {
      ta.value = '';
      try { localStorage.removeItem(STORAGE_KEY); } catch (e) {
        console.warn('[Sentinel/settings] localStorage remove failed:', window.getErrorMessage ? window.getErrorMessage(e) : String(e));
      }
      applyCustomCss('');
      setStatus('cleared', 'var(--text-tertiary)');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();

(function wireThemeAutoSave() {
  function init() {
    const themePresets = document.querySelectorAll('.theme-preset[data-theme]');
    if (themePresets.length) {
      themePresets.forEach(el => {
        el.addEventListener('click', () => {
          const theme = el.dataset.theme;
          if (!theme) return;
          document.body.className = (document.body.className || '').split(/\s+/).filter(c => !c.startsWith('theme-')).join(' ');
          if (theme !== 'light' && theme !== 'dark') {
            document.body.classList.add(`theme-${theme}`);
          }
          if (theme === 'dark') document.body.classList.add('dark-mode');
          else document.body.classList.remove('dark-mode');
          try { localStorage.setItem('theme-named', theme); } catch (e) {
            console.warn('[Sentinel/settings] localStorage save failed:', window.getErrorMessage ? window.getErrorMessage(e) : String(e));
          }
          const allThemePresets = document.querySelectorAll('.theme-preset');
          if (allThemePresets.length) {
            allThemePresets.forEach(b => b.classList.toggle('active', b.dataset.theme === theme));
          }
          try { showToast(`Theme: ${theme} (saved)`, 'success'); } catch (e) { console.warn('[Sentinel] showToast failed:', window.getErrorMessage ? window.getErrorMessage(e) : String(e)); }
        });
      });
    }
  }
})();

// ========== Export / Import Settings (SET-04) ==========
(function wireExportImportPlugins() {
  const SETTINGS_EXPORT_VERSION = 1;
  const EXPORT_KEYS = [
    'active_provider', 'providers', 'export_format', 'agent_context',
    'quickAssist', 'useTrustedInput', 'sentinelSoundEnabled',
    'adaptivePromptsMode', 'adaptiveExpansionMode', 'telemetryLevel',
    'telemetryPersist', 'telemetryRedact', 'telemetrySkillAdapt',
    'quickMode', 'show_api_health_bar', 'ticketMode', 'ticketFormat',
    'technicianInfo', 'expectedTenant'
  ];

  function doExportSettings() {
    chrome.storage.local.get(EXPORT_KEYS, (data) => {
      if (chrome.runtime.lastError) {
        showToast('Export failed', 'error');
        return;
      }
      data._version = SETTINGS_EXPORT_VERSION;
      data._exportedAt = new Date().toISOString();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sentinel-settings-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('Settings exported', 'success');
    });
  }

  function doImportSettings(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data._version || data._version > SETTINGS_EXPORT_VERSION) {
          showToast('Incompatible settings file', 'error');
          return;
        }
        const toWrite = {};
        for (const key of EXPORT_KEYS) {
          if (key in data) toWrite[key] = data[key];
        }
        chrome.storage.local.set(toWrite, () => {
          if (chrome.runtime.lastError) {
            showToast('Import failed', 'error');
            return;
          }
          showToast('Settings imported — reloading', 'success');
          setTimeout(() => location.reload(), 800);
        });
      } catch (_e) {
        showToast('Invalid JSON file', 'error');
      }
    };
    reader.readAsText(file);
  }

  const exportBtn = document.getElementById('exportSettingsBtn');
  if (exportBtn) exportBtn.addEventListener('click', doExportSettings);

  const importBtn = document.getElementById('importSettingsBtn');
  const importFile = document.getElementById('importSettingsFile');
  if (importBtn && importFile) {
    importBtn.addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', () => {
      if (importFile.files.length) doImportSettings(importFile.files[0]);
    });
  }

  // ========== Plugin Management UI (PLG-06) ==========
  const pluginList = document.getElementById('pluginList');
  const pluginRegistryUrl = document.getElementById('pluginRegistryUrl');
  const pluginManifestUrl = document.getElementById('pluginManifestUrl');
  const installPluginBtn = document.getElementById('installPluginBtn');

  function renderPluginList(plugins) {
    if (!pluginList) return;
    const entries = Object.entries(plugins);
    if (!entries.length) {
      pluginList.innerHTML = '<div style="color:var(--text-secondary); font-size:12px; padding:8px 0;">No plugins installed</div>';
      return;
    }
    pluginList.innerHTML = entries.map(([id, p]) => `
      <div style="display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid var(--border-color, #333);">
        <div style="flex:1; min-width:0;">
          <div style="font-size:12px; font-weight:600;">${sanitizeHtml(p.name || id)}</div>
          <div style="font-size:11px; color:var(--text-secondary);">${sanitizeHtml(p.version || '?')} by ${sanitizeHtml(p.author || '?')}</div>
        </div>
        <button class="form-btn-sm plugin-toggle" data-id="${id}" style="font-size:10px; ${p.active ? 'background:var(--success-color, #4caf50);' : 'background:var(--bg-tertiary);'}">${p.active ? 'ON' : 'OFF'}</button>
        <button class="form-btn-sm plugin-uninstall" data-id="${id}" style="font-size:10px; color:var(--error-color, #f44336);">Remove</button>
      </div>
    `).join('');

    pluginList.querySelectorAll('.plugin-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'plugin_toggle', pluginId: btn.dataset.id }, (resp) => {
          if (resp && resp.ok) refreshPluginList();
        });
      });
    });
    pluginList.querySelectorAll('.plugin-uninstall').forEach(btn => {
      btn.addEventListener('click', () => {
        if (confirm('Remove plugin ' + btn.dataset.id + '?')) {
          chrome.runtime.sendMessage({ action: 'plugin_uninstall', pluginId: btn.dataset.id }, (resp) => {
            if (resp && resp.ok) refreshPluginList();
          });
        }
      });
    });
  }

  function refreshPluginList() {
    chrome.runtime.sendMessage({ action: 'plugin_list' }, (resp) => {
      if (resp && resp.plugins) renderPluginList(resp.plugins);
    });
  }

  if (pluginRegistryUrl) {
    chrome.runtime.sendMessage({ action: 'plugin_get_registry_url' }, (resp) => {
      if (resp && resp.url) pluginRegistryUrl.value = resp.url;
    });
    pluginRegistryUrl.addEventListener('change', () => {
      chrome.runtime.sendMessage({ action: 'plugin_set_registry_url', url: pluginRegistryUrl.value.trim() });
    });
  }

  if (installPluginBtn && pluginManifestUrl) {
    installPluginBtn.addEventListener('click', () => {
      const url = pluginManifestUrl.value.trim();
      if (!url) { showToast('Enter a manifest URL', 'error'); return; }
      installPluginBtn.disabled = true;
      chrome.runtime.sendMessage({ action: 'plugin_install', manifestUrl: url }, (resp) => {
        installPluginBtn.disabled = false;
        if (resp && resp.ok) {
          showToast('Plugin installed', 'success');
          pluginManifestUrl.value = '';
          refreshPluginList();
        } else {
          showToast(resp?.error || 'Install failed', 'error');
        }
      });
    });
  }

  refreshPluginList();
})();

// ========== Quick Model Switcher (free OpenRouter models) ==========
(function wireQuickModelSwitcher() {
  const select = document.getElementById('quickModelSelect');
  if (!select) return;

  // Free OpenRouter models with vision + tool support
  const FREE_MODELS = [
    { id: 'nex-agi/nex-n2-pro:free', label: 'Nex-N2-Pro (vision+tools)', vision: true, tools: true },
    { id: 'google/gemma-4-31b-it:free', label: 'Gemma 4 31B (vision+tools)', vision: true, tools: true },
    { id: 'nvidia/nemotron-3-super-120b-a12b:free', label: 'Nemotron 3 Super (1M ctx)', vision: false, tools: true },
    { id: 'poolside/laguna-m.1:free', label: 'Poolside Laguna (coding)', vision: false, tools: true },
  ];

  // Build dropdown
  select.innerHTML = '';
  for (const m of FREE_MODELS) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    select.appendChild(opt);
  }

  // Load saved selection
  chrome.storage.local.get(['quick_model', 'active_provider', 'providers'], (result) => {
    if (chrome.runtime.lastError) return;
    const saved = result.quick_model || '';
    if (saved && FREE_MODELS.some(m => m.id === saved)) {
      select.value = saved;
    } else {
      // Default to first model
      select.value = FREE_MODELS[0].id;
    }
    // Ensure provider is set to openrouter with the key
    _ensureOpenRouterConfig(result);
  });

  // On model change: save + update provider config
  select.addEventListener('change', () => {
    const modelId = select.value;
    if (!modelId) return;
    try { localStorage.setItem('quick_model', modelId); } catch (_e) { /* non-fatal */ }
    chrome.storage.local.set({ quick_model: modelId });

    // Auto-switch provider to openrouter with this model
    chrome.storage.local.get(['active_provider', 'providers'], (result) => {
      if (chrome.runtime.lastError) return;
      const providers = result.providers || {};
      const orConfig = providers.openrouter || providers.nexn2 || {};

      // If openrouter config exists, just update the model
      if (orConfig.api_key) {
        providers.openrouter = { ...orConfig, model: modelId };
        chrome.storage.local.set({
          active_provider: 'openrouter',
          providers
        }, () => {
          if (!chrome.runtime.lastError) {
            try { showToast(`Switched to ${modelId.split('/').pop()}`, 'success'); } catch (_e) { /* non-fatal */ }
          }
        });
      } else {
        // No openrouter key yet — prompt user to add it in settings
        try { showToast('Set your OpenRouter API key in Settings first', 'info'); } catch (_e) { /* non-fatal */ }
      }
    });
  });

  function _ensureOpenRouterConfig(result) {
    const providers = result.providers || {};
    if (providers.openrouter && providers.openrouter.api_key) return; // already configured
    // Check if any other openrouter-compatible provider has a key
    for (const key of ['nexn2', 'gemma4', 'nemotron', 'poolside']) {
      if (providers[key] && providers[key].api_key) {
        // Migrate key to openrouter
        providers.openrouter = { ...providers[key], model: select.value };
        chrome.storage.local.set({ providers });
        return;
      }
    }
  }

})();

// ========== OpenRouter Credit Protection ==========
(function wireCreditProtection() {
  const badge = document.getElementById('quickModelCreditBadge');
  if (!badge) return;

  const DAILY_LIMIT = 5.00; // $5/day limit (configurable)

  function _loadCreditData(callback) {
    chrome.storage.local.get(['credit_usage', 'credit_limit'], (result) => {
      if (chrome.runtime.lastError) { callback(null); return; }
      const today = new Date().toISOString().split('T')[0];
      const usage = result.credit_usage || {};
      const todayUsage = usage[today] || { tokens: 0, cost: 0, calls: 0 };
      const limit = result.credit_limit || DAILY_LIMIT;
      callback({ todayUsage, limit, today });
    });
  }

  // Expose for background to call after each LLM response
  window._recordCreditUsage = function(inputTokens, outputTokens, model) {
    chrome.storage.local.get(['credit_usage'], (result) => {
      if (chrome.runtime.lastError) return;
      const today = new Date().toISOString().split('T')[0];
      const usage = result.credit_usage || {};
      if (!usage[today]) usage[today] = { tokens: 0, cost: 0, calls: 0 };

      // Free models = $0 cost, but track tokens for rate limiting
      const isFree = (model || '').includes(':free');
      const costPerToken = isFree ? 0 : 0.000003; // rough estimate for paid
      const addedCost = ((inputTokens || 0) + (outputTokens || 0)) * costPerToken;

      usage[today].tokens += (inputTokens || 0) + (outputTokens || 0);
      usage[today].cost += addedCost;
      usage[today].calls++;

      // Keep only last 7 days
      const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
      for (const key of Object.keys(usage)) {
        if (key < cutoff) delete usage[key];
      }

      chrome.storage.local.set({ credit_usage: usage });
      _refreshBadge();
    });
  };

  function _refreshBadge() {
    _loadCreditData((data) => {
      if (!data) { badge.style.display = 'none'; return; }
      const { todayUsage, limit } = data;
      const pct = limit > 0 ? (todayUsage.cost / limit) * 100 : 0;

      if (todayUsage.calls === 0) {
        badge.style.display = 'none';
        return;
      }

      badge.style.display = '';
      badge.textContent = `$${todayUsage.cost.toFixed(2)}`;
      badge.title = `Today: ${todayUsage.calls} calls, ${todayUsage.tokens.toLocaleString()} tokens, $${todayUsage.cost.toFixed(4)} / $${limit.toFixed(2)} limit`;

      badge.classList.remove('warn', 'danger');
      if (pct >= 90) badge.classList.add('danger');
      else if (pct >= 70) badge.classList.add('warn');
    });
  }

  // Refresh on load
  _refreshBadge();

  // Expose for background to check before calls
  window._checkCreditLimit = function(callback) {
    _loadCreditData((data) => {
      if (!data) { callback(true); return; } // allow if unknown
      const { todayUsage, limit } = data;
      const allowed = todayUsage.cost < limit;
      if (!allowed) {
        try { showToast('Daily credit limit reached! Increase in Settings or wait until tomorrow.', 'error'); } catch (_e) { /* non-fatal */ }
      }
      callback(allowed);
    });
  };
})();

// ========== Credit Limit Settings UI ==========
(function wireCreditLimitUI() {
  const limitInput = document.getElementById('creditLimitInput');
  const usageDisplay = document.getElementById('creditUsageDisplay');
  if (!limitInput || !usageDisplay) return;

  // Load saved limit
  chrome.storage.local.get(['credit_limit', 'credit_usage'], (result) => {
    if (chrome.runtime.lastError) return;
    const limit = result.credit_limit || 5.00;
    limitInput.value = limit;

    const today = new Date().toISOString().split('T')[0];
    const usage = result.credit_usage || {};
    const todayUsage = usage[today] || { tokens: 0, cost: 0, calls: 0 };
    usageDisplay.textContent = `$${todayUsage.cost.toFixed(2)} / $${limit.toFixed(2)} (${todayUsage.calls} calls, ${todayUsage.tokens.toLocaleString()} tokens)`;
  });

  // Save limit on change
  limitInput.addEventListener('change', () => {
    const val = parseFloat(limitInput.value);
    if (isNaN(val) || val < 0) {
      try { showToast('Enter a valid limit', 'error'); } catch (_e) { /* non-fatal */ }
      return;
    }
    chrome.storage.local.set({ credit_limit: val }, () => {
      if (!chrome.runtime.lastError) {
        try { showToast(`Daily limit set to $${val.toFixed(2)}`, 'success'); } catch (_e) { /* non-fatal */ }
      }
    });
  });
})();
