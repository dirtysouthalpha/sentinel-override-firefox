// popup-modules/boot-catcher.js
// Global error catcher — loaded FIRST before all other popup scripts.
// Catches and displays any JS errors that prevent the extension from working.
window.__sentinelErrors = [];

function __showBootBanner(text, color) {
  let banner = document.getElementById('__sentinel-boot-err');
  if (!banner && document.body) {
    banner = document.createElement('div');
    banner.id = '__sentinel-boot-err';
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999999;background:' + (color || '#ff0040') + ';color:#fff;padding:8px 12px;font-size:12px;font-family:monospace;white-space:pre-wrap;max-height:200px;overflow:auto;';
    document.body.prepend(banner);
  }
  if (banner) banner.textContent += text + '\n';
}

window.addEventListener('error', (e) => {
  window.__sentinelErrors.push({
    type: 'error',
    message: e.message,
    filename: e.filename,
    lineno: e.lineno,
    colno: e.colno
  });
  console.error('[Sentinel/BOOT]', e.message, e.filename + ':' + e.lineno);
  __showBootBanner('[ERROR] ' + (e.filename || '').split('/').pop() + ':' + e.lineno + ' — ' + e.message, '#ff0040');
});

window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason && e.reason.message ? e.reason.message : String(e.reason);
  window.__sentinelErrors.push({ type: 'unhandledrejection', message: msg });
  console.error('[Sentinel/BOOT] Unhandled rejection:', msg);
  __showBootBanner('[PROMISE] ' + msg, '#ff8800');
});

// Post-boot diagnostic: check that the service worker is alive and elements exist
setTimeout(() => {
  const goalInput = document.getElementById('goalInput');
  const sendBtn = document.getElementById('sendBtn');
  const errors = window.__sentinelErrors || [];

  if (errors.length > 0) {
    __showBootBanner('Boot errors: ' + errors.length + ' — check console', '#ff0040');
  }

  if (!goalInput) __showBootBanner('[DIAG] goalInput NOT FOUND', '#ff8800');
  if (!sendBtn) __showBootBanner('[DIAG] sendBtn NOT FOUND', '#ff8800');

  // Ping service worker
  try {
    chrome.runtime.sendMessage({ action: 'ping' }, (resp) => {
      if (chrome.runtime.lastError) {
        __showBootBanner('[SW] NOT REACHABLE: ' + (chrome.runtime.lastError.message || 'unknown'), '#ff0040');
        return;
      }
      if (!(resp && (resp.pong || resp.data?.pong))) {
        __showBootBanner('[SW] Unexpected response: ' + JSON.stringify(resp), '#ff8800');
      }
    });
  } catch (e) {
    __showBootBanner('[SW] Ping threw: ' + e.message, '#ff0040');
  }

  // Check if provider has API key (correct storage keys: active_provider + providers)
  chrome.storage.local.get(['active_provider', 'providers', 'api_key'], (result) => {
    const activeId = result.active_provider;
    const providers = result.providers;
    const legacyKey = result.api_key;
    let hasKey = false;
    if (activeId && providers && providers[activeId] && providers[activeId].api_key) {
      hasKey = true;
    } else if (legacyKey) {
      hasKey = true;
    }

    const activeEndpoint = (activeId && providers && providers[activeId] && providers[activeId].endpoint) || '';
    const isKeylessLocal = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])([:\/]|$)/i.test(activeEndpoint);
    // SO-81: nothing configured at all = the built-in keyless local default
    // (B60 internvl3-8b on 127.0.0.1:8083) is what the agent will actually
    // use. That is READY, not an error. Only a CLOUD provider without a key
    // deserves the warning.
    if (!activeId && !providers && !legacyKey) {
      __showBootBanner('[OK] Built-in local model ready (B60 internvl3-8b, keyless) — add a provider in Settings anytime', '#00aa44');
    } else if (!hasKey && !isKeylessLocal) {
      __showBootBanner('[CONFIG] No API key for provider "' + (activeId || 'null') + '" — set it in Settings, or pick a local model', '#ffaa00');
      const gi = document.getElementById('goalInput');
      if (gi) gi.placeholder = 'Set up an API key in Settings for this provider (local models need none)';
    } else {
      __showBootBanner('[OK] Provider: ' + (activeId || 'legacy') + (isKeylessLocal && !hasKey ? ' (keyless local) — ready' : ' — ready'), '#00aa44');
    }
  });
}, 600);
