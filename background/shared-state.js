// background/shared-state.js
// Mutable shared state for cross-module flags.
// Kept separate from message-protocol.js (pure utility, no state).
//
// This module exists because content.js sends SPA transition messages to
// the background, and index.js needs to set a flag that agent-engine.js
// reads at the top of each loop iteration. Placing this flag in
// message-protocol.js would violate its "no state" design constraint.
// A dedicated shared-state module keeps the dependency graph clean:
//   index.js  --> shared-state.js  <-- agent-engine.js
// No circular imports.

import { getErrorMessage } from './error-utils.js';
import { TWENTY_SECONDS_MS } from './constants.js';

let _spaTransitionPending = false;

/** Mark that an SPA page transition occurred while the agent is running. */
export function setSPATransitionPending() { _spaTransitionPending = true; }

/** Check whether a pending SPA transition needs to be handled. */
export function isSPATransitionPending() { return _spaTransitionPending; }

/** Clear the SPA transition flag after it has been handled. */
export function clearSPATransition() { _spaTransitionPending = false; }

// (3.14.0) Service-worker keepalive helper. MV3 SWs are terminated after ~30s
// of idle. While the agent is awaiting human input (approval prompts, tenant
// overrides, long human-delay sleeps), nothing else may be poking the SW —
// the listener for the approval response is registered but never fires until
// the user clicks, and the awaiting Promise alone doesn't reset the idle
// timer. Result: SW dies, listener is GC'd, the approval prompt resolves into
// the void.
//
// Mitigation: while a keepalive name is active, call a trivial chrome.* API
// every 20s. Any chrome.storage / chrome.runtime call resets the idle timer.
// Multiple callers can hold a keepalive by name — only the last release stops
// the heartbeat.
const _keepaliveHandles = new Map();   // name -> intervalId
const _keepaliveRefCounts = new Map(); // name -> count

/**
 * Start a service-worker keepalive heartbeat for the given name.
 * Prevents Chrome from terminating the MV3 service worker during idle periods
 * (e.g. while awaiting human input on approval prompts). Multiple callers can
 * hold a keepalive by the same name — only the last release stops the heartbeat.
 * @param {string} name - Identifier for the keepalive (defaults to 'default').
 */
export function startSwKeepalive(name) {
  if (typeof name !== 'string' || !name) name = 'default';
  _keepaliveRefCounts.set(name, (_keepaliveRefCounts.get(name) || 0) + 1);
  if (_keepaliveHandles.has(name)) return;
  const tick = () => {
    // chrome.storage.session is in-memory only — cheap pulse, no I/O.
    try {
      if (chrome && chrome.storage && chrome.storage.session && chrome.storage.session.set) {
        chrome.storage.session.set({ [`_sw_keepalive_${name}`]: Date.now() }).catch((e) => {
          console.error('[tick] Unhandled rejection:', getErrorMessage(e));
        });
      } else if (chrome && chrome.runtime && chrome.runtime.getPlatformInfo) {
        chrome.runtime.getPlatformInfo(() => {});
      }
    } catch (_e) { /* chrome API not available */ }
  };
  tick();
  const handle = setInterval(tick, TWENTY_SECONDS_MS);
  _keepaliveHandles.set(name, handle);
}

/**
 * Release one reference to a service-worker keepalive heartbeat.
 * When the last reference is released, the interval is cleared and the session
 * storage pulse key is cleaned up.
 * @param {string} name - Identifier for the keepalive (defaults to 'default').
 */
export function stopSwKeepalive(name) {
  if (typeof name !== 'string' || !name) name = 'default';
  const refs = (_keepaliveRefCounts.get(name) || 0) - 1;
  if (refs > 0) {
    _keepaliveRefCounts.set(name, refs);
    return;
  }
  _keepaliveRefCounts.delete(name);
  const handle = _keepaliveHandles.get(name);
  if (handle) {
    try { clearInterval(handle); } catch (_e) { /* clearInterval is safe to ignore */ }
    _keepaliveHandles.delete(name);
  }
  // Clean the session pulse key so it doesn't leak.
  try {
    if (chrome && chrome.storage && chrome.storage.session && chrome.storage.session.remove) {
      chrome.storage.session.remove(`_sw_keepalive_${name}`).catch((e) => {
        console.error('[handle] Unhandled rejection:', getErrorMessage(e));
      });
    }
  } catch (_e) { /* session storage may not be available */ }
}

// (3.11.3) Centralized "fire a desktop notification only if the user enabled
// sound notifications" helper. Default: OFF — Sentinel runs silently unless
// the user opts in via Settings > Sound notifications. Replaces direct
// chrome.notifications.create() calls site-wide so a single toggle silences
// every site at once.
//
// Accepts either form chrome.notifications.create supports:
//   notifyIfEnabled(opts)            — auto-generated id
//   notifyIfEnabled(id, opts)        — caller-supplied id
/**
 * Fire a desktop notification only if the user has enabled sound notifications.
 * Accepts the same argument forms as chrome.notifications.create:
 *   notifyIfEnabled(opts)         — auto-generated notification id
 *   notifyIfEnabled(id, opts)     — caller-supplied notification id
 * No-ops silently when notifications are disabled (the default).
 * @param {string|object} idOrOpts - Notification id (string) or options object.
 * @param {object} [optsIfId] - Options object when first arg is an id.
 * @returns {Promise<void>}
 */
export async function notifyIfEnabled(idOrOpts, optsIfId) {
  try {
    const { sentinelSoundEnabled } = await chrome.storage.local.get({ sentinelSoundEnabled: false });
    if (!sentinelSoundEnabled) return;
    if (typeof idOrOpts === 'string') {
      await chrome.notifications.create(idOrOpts, optsIfId);
    } else {
      await chrome.notifications.create(idOrOpts);
    }
  } catch (_e) { /* notifications permission optional / storage unavailable */ }
}
