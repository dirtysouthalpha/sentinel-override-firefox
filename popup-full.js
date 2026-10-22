// popup-full.js -- Bootstrap
// Global state initialization, DOMContentLoaded wiring, and modal close handlers.
// Loaded last (after ui-common.js, settings.js, chat.js) so all module functions
// are available in global scope.

// ========== Global State (initialized by popup-state.js) ==========
initPopupState();

// ========== Initialization ==========
window.addEventListener('DOMContentLoaded', () => {
  loadThemePreference();
  loadSettings();
  loadApprovalMode();
  loadChatHistory();
  setupVoiceInput();
  setupApprovalModeToggle();

  // Templates button toggle
  const templatesBtn = document.getElementById('templatesBtn');
  if (templatesBtn) {
    templatesBtn.addEventListener('click', () => {
      const panel = document.getElementById('templates-panel');
      if (panel && (panel.style.display === 'none' || !panel.style.display)) {
        showTemplatesPanel();
        const schBtn = document.getElementById('schedulerBtn');
        if (schBtn) schBtn.classList.remove('active');
      } else {
        hideTemplatesPanel();
      }
    });
  }

  // Scheduler panel toggle
  const schedulerBtn = document.getElementById('schedulerBtn');
  if (schedulerBtn) {
    schedulerBtn.addEventListener('click', () => {
      const panel = document.getElementById('schedules-panel');
      if (panel && (panel.style.display === 'none' || !panel.style.display)) {
        window.showSchedulesPanel();
        schedulerBtn.classList.add('active');
        if (templatesBtn) templatesBtn.classList.remove('active');
      } else {
        window.hideSchedulesPanel();
        schedulerBtn.classList.remove('active');
      }
    });
  }

  // Schedule modal close handlers
  document.getElementById('closeScheduleModalBtn')?.addEventListener('click', () => {
    document.getElementById('schedule-modal')?.classList.remove('show');
  });
  document.getElementById('closeHistoryModalBtn')?.addEventListener('click', () => {
    document.getElementById('schedule-history-modal')?.classList.remove('show');
  });

  // Schedule create/save buttons
  document.getElementById('createScheduleBtn')?.addEventListener('click', () => {
    window.openCreateScheduleModal();
  });
  document.getElementById('saveScheduleBtn')?.addEventListener('click', () => {
    window._handleSaveSchedule?.();
  });

  // Collaboration buttons
  document.getElementById('importTemplatesBtn')?.addEventListener('click', () => {
    window.openImportDialog?.();
  });
  document.getElementById('exportAllTemplatesBtn')?.addEventListener('click', () => {
    window.exportAllTemplatesFile?.();
  });
});

// ========== Close Modals on Escape ==========
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.getElementById('settings-modal')?.classList.remove('show');
    document.getElementById('theme-modal')?.classList.remove('show');
    document.getElementById('report-modal')?.classList.remove('show');
    document.getElementById('template-modal')?.classList.remove('show');
    document.getElementById('template-run-modal')?.classList.remove('show');
    document.getElementById('schedule-modal')?.classList.remove('show');
    document.getElementById('schedule-history-modal')?.classList.remove('show');
    document.getElementById('import-modal')?.classList.remove('show');
    if (typeof closeCommandPalette === 'function') closeCommandPalette();
  }
});

// ========== Click outside modal to close ==========
window.addEventListener('click', (e) => {
  if (e.target === document.getElementById('settings-modal')) {
    document.getElementById('settings-modal')?.classList.remove('show');
  }
  if (e.target === document.getElementById('theme-modal')) {
    document.getElementById('theme-modal')?.classList.remove('show');
  }
  if (e.target === document.getElementById('report-modal')) {
    closeReportModal();
  }
  if (e.target === document.getElementById('template-modal')) {
    document.getElementById('template-modal')?.classList.remove('show');
  }
  if (e.target === document.getElementById('template-run-modal')) {
    document.getElementById('template-run-modal')?.classList.remove('show');
  }
  if (e.target === document.getElementById('schedule-modal')) {
    document.getElementById('schedule-modal')?.classList.remove('show');
  }
  if (e.target === document.getElementById('schedule-history-modal')) {
    document.getElementById('schedule-history-modal')?.classList.remove('show');
  }
  if (e.target === document.getElementById('import-modal')) {
    document.getElementById('import-modal')?.classList.remove('show');
  }
});

// ========== Boot Diagnostic ==========
// Runs after ALL scripts have loaded. Checks that critical listeners exist.
// (Provider config check is handled by boot-catcher.js with correct storage keys)
const _bootTimer = setTimeout(() => {
  const goalInput = document.getElementById('goalInput');
  const sendBtn = document.getElementById('sendBtn');
  const errors = window.__sentinelErrors || [];
  if (errors.length > 0) {
    console.error('[Sentinel/BOOT] Errors during load:', errors);
  }
  // Verify elements exist
  if (!goalInput) console.error('[Sentinel/BOOT] goalInput NOT FOUND in DOM');
  if (!sendBtn) console.error('[Sentinel/BOOT] sendBtn NOT FOUND in DOM');

}, 500);
window.addEventListener('unload', () => clearTimeout(_bootTimer), { once: true });

// ========== FALLBACK INPUT LISTENERS ==========
// If chat.js IIFE failed to attach listeners, these catch it.
// popup-full.js loads LAST, so all functions should be in global scope.
(function attachFallbackListeners() {
  const _goalInput = document.getElementById('goalInput');
  const _sendBtn = document.getElementById('sendBtn');

  if (_sendBtn) {
    _sendBtn.addEventListener('click', () => {
      if (typeof sendMessage === 'function') {
        sendMessage();
      } else {
        console.error('[Sentinel/FALLBACK] sendMessage is NOT a function! typeof:', typeof sendMessage);
        alert('Sentinel Error: sendMessage function not found. Try reloading the extension.');
      }
    });
  } else {
    console.error('[Sentinel/FALLBACK] sendBtn NOT FOUND');
  }

  if (_goalInput) {
    _goalInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (typeof sendMessage === 'function') {
          sendMessage();
        } else {
          console.error('[Sentinel/FALLBACK] sendMessage is NOT a function!');
          alert('Sentinel Error: sendMessage function not found.');
        }
      }
    });
  } else {
    console.error('[Sentinel/FALLBACK] goalInput NOT FOUND');
  }
})();
