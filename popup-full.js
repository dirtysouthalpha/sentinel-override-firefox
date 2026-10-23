// popup-full.js -- Bootstrap
// Global state initialization, DOMContentLoaded wiring, and modal close handlers.
// Loaded last (after ui-common.js, settings.js, chat.js) so all module functions
// are available in global scope.

// ========== Global State (initialized by popup-state.js) ==========
initPopupState();

// ========== Background Receiver Registration ==========
// Firefox reports a rejected chrome.runtime.sendMessage broadcast as an
// "uncaught exception" in the browser console even when the background has
// already attached .catch(), because the rejection is reported when it is
// created. So the background cannot silence it by handling the rejection — it
// instead tracks live receivers and skips the broadcast when none exist.
//
// This panel document is the only listener for those broadcasts (the telemetry
// panel, the chat status ticker, the report card), so it is what registers as a
// receiver. The port carries no data — the background passes real broadcasts
// through to the native sendMessage whenever this document is alive.
//
// Open the port only when the background actually installed the guard, which is
// the Firefox event-page build (manifest background.scripts). Chrome's manifest
// declares background.service_worker instead, and Chrome needs no receiver — its
// sendMessage throws synchronously through lastError rather than rejecting — so
// an open port there would only hold its MV3 service worker open. Reading the
// manifest is synchronous and in-context, so unlike a global marker it cannot be
// defeated by the popup and the background having separate global scopes.
var _soManifest = null;
var _soGuardLive = false;
try {
  _soManifest = chrome.runtime.getManifest();
  var _soBackground = _soManifest && _soManifest.background;
  _soGuardLive = !!_soBackground && Array.isArray(_soBackground.scripts);
} catch (_e) {
  // getManifest is absent in some contexts (the jest harness uses a bare chrome
  // stub). With no manifest there is no way to prove the guard is live, so skip
  // the port: broadcasts degrade to a no-op instead of crashing the bootstrap.
  _soGuardLive = false;
}
if (_soGuardLive) {
  try {
    window.__sentinelPopupPort = chrome.runtime.connect({ name: 'sentinel-popup' });
    window.__sentinelPopupPort.onDisconnect?.addListener(() => {
      // The sidebar document is torn down per window; a fresh document opens a
      // fresh port. Nothing to clean up beyond dropping our reference.
      window.__sentinelPopupPort = null;
    });
  } catch (_e) { /* connect unavailable — broadcasts degrade to no-op */ }
}

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
