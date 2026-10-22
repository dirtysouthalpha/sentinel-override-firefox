// SO-93 — content-side shim (classic script, runs first in the content world).
// Firefox's chrome.* namespace in content scripts is callback-style; the
// Sentinel content bundle is promise-style. Feature-detect: fire a harmless
// ping; if sendMessage came back as a promise, chrome.* already behaves like
// browser.* and we do nothing. Otherwise alias the namespaces we use.
(function () {
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
    if (typeof browser === 'undefined' || !browser.runtime) return;
    var probe;
    try {
      probe = chrome.runtime.sendMessage({ action: 'ping' });
      // Firefox rejects this promise when no background listener exists yet;
      // a bare try/catch cannot see that, so attach a handler or it surfaces
      // as an unhandled-rejection "JavaScript error" on every content script.
      if (probe && typeof probe.then === 'function') probe.catch(() => {});
    } catch (_e) { probe = undefined; }
    if (probe && typeof probe.then === 'function') return; // promise-style already
    ['runtime', 'storage', 'tabs', 'scripting', 'action', 'alarms', 'contextMenus', 'downloads', 'webNavigation', 'windows', 'notifications', 'commands'].forEach(function (ns) {
      if (browser[ns]) { try { chrome[ns] = browser[ns]; } catch (_e) { /* skip */ } }
    });
  } catch (_e) { /* never break the host page */ }
})();
