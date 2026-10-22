// background/capabilities.js
// Code-enforced capability gate ("two-color rule").
//
// THE RULE
//   RED  — everything the model may do by default. Red actions are dispatched
//          with no capability check.
//   BLUE — a small set of privileged capabilities. A blue action is refused
//          unless the OPERATOR has granted that capability. Grants come from
//          exactly two operator-owned sources:
//            (a) the persisted `grantedCapabilities` list in chrome.storage.local,
//                written only by the operator surface (settings), and
//            (b) a per-action operator approval, carried on the action as
//                `approvalGranted` and set by engine code after the user
//                clicked Approve.
//          Neither is reachable from model output: the action schema
//          (background/action-schema.js) rejects `approvalGranted` and any
//          `_`/`__`-prefixed field, and nothing in the message protocol writes
//          `grantedCapabilities` — this module only ever READS that key.
//
// WHY IT CANNOT BE BYPASSED
//   `checkCapability` is a pure function called at the dispatch boundary, once
//   per action: at the single choke point in the agent run loop (before the
//   first action handler) and at the service worker's external action entry
//   points (index.js). Every model-authored action flows through one of those
//   before any privileged handler is reached.
//
//   The two escape hatches below — `approvalGranted` and `_engineInternal` —
//   are the only ways an action clears a blue capability without a standing
//   grant, and neither is reachable from model output:
//     * background/action-schema.js rejects both names (and every other
//       `_`-prefixed field) in LLM JSON; and
//     * the run loop strips them again at the dispatch boundary, because the
//       tool-calling parse path does not run the schema. Only engine code
//       writes them after that strip.
//   The grant set itself is computed from operator storage (this module only
//   ever READS `grantedCapabilities`) and from engine-stamped approval flags,
//   so no model-supplied value can widen it.
//
// HONEST LIMITS
//   - Capability *classification* of `navigate`/`open_tab` URLs and of
//     `execute_js` source text is heuristic (URL scheme/extension, regex over
//     code). It decides whether a capability is REQUIRED; it is not itself a
//     boundary. A privileged action that the classifier misses still has to
//     clear the gates it does match, and `execute_js` always requires
//     EXECUTE_JS regardless.
//   - The static sandbox and `_PRIV_RE` guard in the content script remain
//     best-effort. This gate and the approval gate are the real controls.

// The reserved trust-marker names, imported from the action schema so the two
// modules cannot drift. The Firefox port now carries action-schema.js (ported
// from Chrome verbatim), so this is the same import Chrome makes rather than a
// copy of the list that could fall behind it.
import { RESERVED_FIELD_NAMES } from './action-schema.js';

/** Blue (operator-grantable) capability names. Everything else is red. */
export const CAPABILITIES = Object.freeze({
  EXECUTE_JS: 'execute_js',                 // arbitrary page-context JS
  COOKIES: 'cookies',                       // cookie / web-storage access from JS
  NETWORK_READ: 'network_read',             // network reads beyond the current tab
  DOWNLOADS: 'downloads',                   // navigating to a download URL
  FILE_UPLOAD: 'file_upload',               // sending a local file into a page
  CROSS_ORIGIN_FRAME: 'cross_origin_frame', // driving a frame the tab cannot reach
  REMOTE_COMMAND: 'run_remote_command',     // typing commands into a remote console
  CROSS_ORIGIN_NAV: 'cross_origin_navigation', // leaving the run's current origin
});

export const ALL_CAPABILITIES = Object.freeze(Object.values(CAPABILITIES));

/** Storage key holding the operator's persisted grants. Read-only from here. */
export const GRANTED_CAPABILITIES_KEY = 'grantedCapabilities';

// Fields that only engine code may set on an action, because each one is read by
// a gate as evidence of operator consent or of engine authorship. The schema
// rejects them from model JSON (RESERVED_FIELD_RE / RESERVED_FIELD_NAMES); this
// list is what the dispatch boundary strips, and it is deliberately a NAME list
// rather than the `_`-prefix pattern: the engine sets other underscore fields
// (_visionAction, _visionIndex, ...) BEFORE the boundary runs, and stripping
// those would break the vision path.
const MODEL_UNTRUSTED_FIELDS = Object.freeze([...RESERVED_FIELD_NAMES, '_engineInternal']);

/**
 * Remove every trust marker a model must not be able to supply.
 *
 * The run loop calls this at the dispatch boundary, after the branch that
 * produced the action and before either gate. It exists because
 * background/action-schema.js only runs on the JSON-parse path: the
 * tool-calling path (provider.parseToolUseResponse) turns model-supplied tool
 * arguments straight into an action object, so a tool call could otherwise carry
 * `approvalGranted` or `_engineInternal` and clear a blue capability.
 *
 * Uses Reflect.deleteProperty, which reports false instead of throwing on a
 * frozen or non-extensible object — engine-authored actions may be frozen and
 * must survive.
 *
 * @param {object} action
 * @returns {object} the same action, for chaining.
 */
export function stripModelTrustFields(action) {
  if (!action || typeof action !== 'object') return action;
  for (const field of MODEL_UNTRUSTED_FIELDS) Reflect.deleteProperty(action, field);
  return action;
}

// Cookie / web-storage access inside execute_js source.
const COOKIE_STORAGE_RE = /document\s*\.\s*cookie|localStorage|sessionStorage|indexedDB|\bcaches\s*\.|\bchrome\s*\.\s*cookies|\bbrowser\s*\.\s*cookies/;
// URL schemes and extensions that mean "this navigation is a download".
const DOWNLOAD_SCHEME_RE = /^(blob:|data:|filesystem:|file:)/i;
const DOWNLOAD_EXT_RE = /\.(exe|msi|msp|dmg|pkg|apk|deb|rpm|zip|rar|7z|tar|gz|tgz|bz2|xz|iso|jar|ps1|bat|cmd|sh)(?:[?#].*)?$/i;

/**
 * Coerce arbitrary stored/derived data into a Set of KNOWN capability names.
 * Unknown strings are dropped rather than honoured, so a typo or an injected
 * value can never widen the grant set.
 * @param {Iterable<string>|Object<string,boolean>|null|undefined} value
 * @returns {Set<string>}
 */
export function normalizeGrants(value) {
  const out = new Set();
  if (!value) return out;
  let items;
  if (value instanceof Set) items = value;
  else if (Array.isArray(value)) items = value;
  else if (typeof value === 'object') items = Object.keys(value).filter((k) => value[k]);
  else return out;
  for (const item of items) {
    if (ALL_CAPABILITIES.includes(item)) out.add(item);
  }
  return out;
}

/**
 * The grant set in force for a run.
 *
 * `approvalMode === false` is an explicit, persisted operator decision to run
 * without per-action gating. It is read from storage, never from model input,
 * and therefore stands in for a blanket grant. Anything else (including the
 * fresh-install default of ON) grants nothing beyond what the operator stored.
 *
 * @param {boolean} approvalMode
 * @param {Iterable<string>|Object<string,boolean>|null} storedGrants
 * @returns {Set<string>}
 */
export function effectiveGrantedCapabilities(approvalMode, storedGrants) {
  if (approvalMode === false) return new Set(ALL_CAPABILITIES);
  return normalizeGrants(storedGrants);
}

/**
 * Read the operator's persisted grants and the approval mode from storage.
 * The only side effect in this module, and it is a read.
 * @returns {Promise<Set<string>>}
 */
export async function loadGrantedCapabilities() {
  try {
    const stored = await chrome.storage.local.get(['approvalMode', GRANTED_CAPABILITIES_KEY]);
    return effectiveGrantedCapabilities(stored && stored.approvalMode, stored && stored[GRANTED_CAPABILITIES_KEY]);
  } catch (_e) {
    // Fail closed: an unreadable grant list means no grants.
    return new Set();
  }
}

function _originOf(url) {
  if (typeof url !== 'string' || !url) return null;
  try { return new URL(url).origin; } catch (_e) { return null; }
}

function _looksLikeDownload(url) {
  if (typeof url !== 'string' || !url) return false;
  return DOWNLOAD_SCHEME_RE.test(url.trim()) || DOWNLOAD_EXT_RE.test(url.trim());
}

/** True when the action's URL target is a different origin from the run's. */
function _leavesOrigin(action, context) {
  const current = _originOf(context && context.currentOrigin) || _originOf(context && context.currentUrl);
  if (!current) return false; // origin unknown — cannot claim it leaves; caller must supply it to enforce
  const target = _originOf(action.url);
  if (!target) return false;  // relative/opaque target stays on the current origin
  return target !== current;
}

/** True when a network read is scoped outside the run's current tab. */
function _networkBeyondCurrentTab(action, context) {
  const currentTabId = context && context.currentTabId;
  // Only an explicit request for another tab's log is privileged. A url_includes
  // filter is not a reliable signal — the model routinely filters by a host it
  // has not resolved yet — and treating it as one would refuse ordinary
  // same-tab reads under the default configuration.
  //
  // Honest note: the agent's read_network_requests handler is tab-scoped today
  // (agent-engine passes the run's tab and ignores any tab_id), and the action
  // schema does not accept tab_id on that action, so this branch is currently
  // reachable only from an external caller that supplies one. It is here so that
  // the first caller to gain a cross-tab read is refused without a grant rather
  // than silently trusted.
  if (action.tab_id != null && currentTabId != null && action.tab_id !== currentTabId) return true;
  return false;
}

function _nestedActions(action) {
  const out = [];
  if (Array.isArray(action.actions)) out.push(...action.actions);
  if (Array.isArray(action.commands)) out.push(...action.commands);
  if (Array.isArray(action.steps)) out.push(...action.steps);
  if (Array.isArray(action.do)) out.push(...action.do);
  if (action.action && typeof action.action === 'object' && !Array.isArray(action.action)) out.push(action.action);
  return out.filter((a) => a && typeof a === 'object');
}

/**
 * The blue capabilities an action requires. Empty array means the action is red.
 * Pure. Recurses into batch sub-actions, which is load-bearing: a batch runs its
 * first sub-action inline without re-entering the gate, so the container must be
 * charged for everything it can dispatch. repeat_for_each is the exception —
 * see the note on its branch below.
 *
 * @param {object} action
 * @param {{currentTabId?: number, currentOrigin?: string, currentUrl?: string}} [context]
 * @returns {string[]}
 */
export function capabilitiesForAction(action, context = {}) {
  if (!action || typeof action !== 'object') return [];
  const required = [];

  switch (action.type) {
    case 'execute_js':
      required.push(CAPABILITIES.EXECUTE_JS);
      if (typeof action.code === 'string' && COOKIE_STORAGE_RE.test(action.code)) required.push(CAPABILITIES.COOKIES);
      break;
    case 'run_remote_command':
      required.push(CAPABILITIES.REMOTE_COMMAND);
      break;
    case 'upload_file':
      required.push(CAPABILITIES.FILE_UPLOAD);
      break;
    case 'execute_in_frame':
      // The SW relay only exists for frames the content script could not reach
      // (cross-origin). Same-origin frames are driven in-page.
      required.push(CAPABILITIES.CROSS_ORIGIN_FRAME);
      break;
    case 'read_network_requests':
      if (_networkBeyondCurrentTab(action, context)) required.push(CAPABILITIES.NETWORK_READ);
      break;
    case 'navigate':
    case 'smart_navigate':
    case 'open_tab':
      if (_leavesOrigin(action, context)) required.push(CAPABILITIES.CROSS_ORIGIN_NAV);
      if (_looksLikeDownload(action.url)) required.push(CAPABILITIES.DOWNLOADS);
      break;
    default:
      break;
  }

  // repeat_for_each fans its `do` list into the engine's command queue, where
  // every sub-action is gated again on its own iteration. Requiring the
  // container as well would refuse the whole loop before the operator ever sees
  // a sub-action to approve — so the container is deliberately not charged for
  // what its children are charged for.
  if (action.type !== 'repeat_for_each') {
    for (const nested of _nestedActions(action)) {
      required.push(...capabilitiesForAction(nested, context));
    }
  }

  return [...new Set(required)];
}

/**
 * Decide whether one action may be dispatched.
 *
 * @param {object} action - The parsed action.
 * @param {Iterable<string>|Object<string,boolean>} grantedCapabilities - Operator grants in force.
 * @param {{currentTabId?: number, currentOrigin?: string, currentUrl?: string}} [context]
 * @returns {{allowed: boolean, capability: string|null, required: string[], missing?: string[], viaApproval?: boolean, reason?: string}}
 */
export function checkCapability(action, grantedCapabilities, context = {}) {
  const required = capabilitiesForAction(action, context);
  if (required.length === 0) {
    return { allowed: true, capability: null, required };
  }
  // Engine-authored commands (never model output — the schema forbids
  // underscore-prefixed fields from the model) bypass the gate. Used by
  // internal fallbacks that the engine itself composes.
  if (action && action._engineInternal === true) {
    return { allowed: true, capability: null, required };
  }
  const granted = normalizeGrants(grantedCapabilities);
  const missing = required.filter((cap) => !granted.has(cap));
  if (missing.length === 0) {
    return { allowed: true, capability: null, required };
  }
  // Per-action operator approval covers this one action only.
  if (action && action.approvalGranted === true) {
    return { allowed: true, capability: null, required, viaApproval: true };
  }
  const label = missing.join(', ');
  return {
    allowed: false,
    capability: missing[0],
    required,
    missing,
    reason: `Privileged action "${action && action.type}" requires the operator to grant: ${label}. `
      + 'A model cannot grant this — ask the user to enable it in Sentinel settings.',
  };
}
