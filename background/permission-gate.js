// background/permission-gate.js
// Point-of-use host permission gate.
//
// The manifest used to declare `<all_urls>` up front, so Sentinel Override asked
// for "read and change all your data on all websites" at install — before the
// user had done anything to justify it. The capability is real: the content
// bundle is injected with chrome.scripting.executeScript, which needs host
// permission for the target URL, and frame-router injects into cross-origin
// iframes. But it should be asked for when it is used, not when it is
// installed.
//
// So `<all_urls>` moved to `optional_host_permissions`, `host_permissions`
// shrank to the origins the background contacts on its own (the DoH resolver
// and the local UAP bridge), and this module asks for the rest at the moment a
// tab is actually about to be driven.
//
// Why the broad capability rather than the origin of the tab being driven: the
// agent reaches cross-origin iframes, so a grant scoped to the top frame would
// not cover the frames it has to touch. One broad request is simpler and states
// plainly what the extension does.
//
// Why the panel is involved: Chrome only raises the permission prompt from an
// extension surface that is being clicked. A service worker has no user
// gesture, so a request made there is refused; the panel's button supplies the
// gesture that makes it succeed.

export const ALL_URLS = '<all_urls>';

// Chrome's message when a permission request arrives without a user gesture.
const NO_GESTURE = /user gesture|user interaction|requires a user gesture/i;

// null = unknown, true = granted. A granted result is remembered because
// sendMessageWithRetry calls this on every retry and the agent loop calls it
// many times per run; chrome.permissions.contains is an IPC round-trip each
// time. A revocation clears it via onRemoved below.
let _granted = null;

// Last refusal, kept so the panel can explain what happened rather than just
// reporting "not granted".
let _lastRefusal = null;

export function isAvailable() {
  return !!(typeof chrome !== 'undefined'
    && chrome.permissions
    && typeof chrome.permissions.request === 'function');
}

/** Forget the remembered grant — called when the browser reports a removal. */
export function _resetGrantCache() {
  _granted = null;
  _lastRefusal = null;
}

/** The most recent refusal reason, or null. */
export function lastRefusal() {
  return _lastRefusal;
}

/**
 * Whether the extension already holds the given host access. Never throws:
 * an unreachable permissions API is treated as granted, which is the pre-existing
 * behaviour (the jest harness ships a chrome stub with no permissions object).
 *
 * @param {string[]} [origins]
 * @returns {Promise<boolean>}
 */
export async function hasHostAccess(origins = [ALL_URLS]) {
  if (!isAvailable()) return true;
  if (_granted === true) return true;
  try {
    const held = await chrome.permissions.contains({ origins });
    if (held === true) {
      _granted = true;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Ask for host access at the point of use.
 *
 * @param {{origins?: string[], reason?: string}} [opts]
 * @returns {Promise<{granted: boolean, error: string|null}>}
 */
export async function ensureHostAccess(opts = {}) {
  const origins = (Array.isArray(opts.origins) && opts.origins.length)
    ? opts.origins
    : [ALL_URLS];
  const reason = typeof opts.reason === 'string' ? opts.reason : '';

  if (!isAvailable()) return { granted: true, error: null };

  if (await hasHostAccess(origins)) return { granted: true, error: null };

  try {
    const granted = await chrome.permissions.request({ origins });
    if (granted === true) {
      _granted = true;
      _lastRefusal = null;
      return { granted: true, error: null };
    }
    // The browser answered no without raising: no gesture, or the user said no.
    _lastRefusal = 'Host access was not granted.'
      + ' Open the Sentinel Override panel and use "Grant access", then retry.';
    return { granted: false, error: _lastRefusal };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    _lastRefusal = `${reason ? reason + ': ' : ''}${message}`;
    return { granted: false, error: _lastRefusal };
  }
}

/**
 * True when a refusal means "no user gesture here", i.e. the panel can fix it
 * by letting the user click. Exported for tests and for callers that want to
 * route the message to the UI themselves.
 *
 * @param {string} message
 * @returns {boolean}
 */
export function refusalNeedsUserGesture(message) {
  return NO_GESTURE.test(String(message || ''));
}

// Drop the remembered grant the moment the browser revokes it, so a later call
// re-checks instead of acting on a stale yes.
if (isAvailable() && typeof chrome.permissions.onRemoved === 'object' && chrome.permissions.onRemoved) {
  chrome.permissions.onRemoved.addListener((perms) => {
    const origins = perms && Array.isArray(perms.origins) ? perms.origins : [];
    if (origins.includes(ALL_URLS) || origins.length === 0) _granted = null;
  });
}
