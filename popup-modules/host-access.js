// popup-modules/host-access.js
// Host-access banner.
//
// `<all_urls>` is an optional permission now, so the panel is the surface that
// turns "the background could not get access" into the one click that can
// grant it. Chrome raises the permission prompt only from an extension surface
// being clicked, so this button — not the service worker — is what makes the
// request succeed.

(function () {
  const BANNER_ID = 'host-access-banner';
  const REASON_ID = 'host-access-reason';
  const GRANT_ID = 'host-access-grant';

  function _el(id) {
    return document.getElementById(id);
  }

  function show(reason) {
    const banner = _el(BANNER_ID);
    if (!banner) return;
    banner.classList.add('show');
    banner.setAttribute('aria-live', 'assertive');
    if (reason) {
      const node = _el(REASON_ID);
      if (node) node.textContent = reason;
    }
  }

  function hide() {
    const banner = _el(BANNER_ID);
    if (!banner) return;
    banner.classList.remove('show');
    banner.removeAttribute('aria-live');
  }

  function setBusy(busy, label) {
    const btn = _el(GRANT_ID);
    if (!btn) return;
    btn.disabled = !!busy;
    btn.textContent = busy ? 'Requesting…' : (label || 'Grant access');
  }

  // Ask the background whether the capability is held. The background is the
  // only place that can see chrome.permissions state that affects every tab.
  async function refresh() {
    try {
      const res = await chrome.runtime.sendMessage({ action: 'host_access_status' });
      if (!res) return;
      if (res.granted) {
        hide();
        return;
      }
      show(res.error || 'Sentinel Override needs access to the page before it can act on it.');
    } catch (_e) {
      // Background not ready (cold service worker, or a harness with a bare
      // chrome stub). Leaving the banner hidden is the safe default: the run
      // itself will report a refusal if there is one.
    }
  }

  // The click is the user gesture. Request from the panel, not the background.
  async function grant() {
    setBusy(true);
    try {
      const res = await chrome.runtime.sendMessage({ action: 'host_access_grant' });
      if (res && res.granted) {
        hide();
        return;
      }
      show((res && res.error) || 'The browser did not grant access. Click again to retry.');
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      show(message);
    } finally {
      setBusy(false);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const btn = _el(GRANT_ID);
    if (btn) btn.addEventListener('click', grant);
    refresh();
  });
})();
