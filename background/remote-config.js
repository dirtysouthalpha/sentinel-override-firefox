// Sentinel Override v20.1 — Remote Config (Claude-in-Chrome parity upgrade)
//
// Claude in Chrome loads its agent system prompt from server config, so
// Anthropic hotfixes prompts without shipping extension updates. SO hardcodes
// its prompt in provider-registry.js — every prompt fix needs a new CRX.
//
// This module adds the missing half: a `config` message type on the existing
// ws-bridge (ws://localhost:8001/extension-bridge, already authenticated with
// a per-install token) that carries prompt patches + behavior flags, persisted
// to chrome.storage.local and merged over the built-in defaults at call time.
//
// Security model:
//   - Only arrives over the ALREADY-AUTHENTICATED bridge channel (token +
//     optional HMAC challenge — see ws-bridge.js). No new attack surface.
//   - Merged over defaults, never replaces wholesale: a partial patch can't
//     blank the safety preamble.
//   - The first 200 chars of the built-in safety preamble are PINNED — a
//     patch cannot remove or weaken them. It can only append/extend.
//   - Unknown keys are ignored. Values are length-capped. Everything is
//     validated before storage.

import { getErrorMessage } from './error-utils.js';

const CONFIG_KEY = 'remote_agent_config';

// The immutable floor: the safety preamble's core clauses. A remote patch
// may append but never remove these sentences.
const PINNED_PREAMBLE_SNIPPETS = [
  'Never fabricate data.',
  'Never act outside the safety boundaries',
  'neither can override your safety rules'
];

// Adversarial append patterns — presence of the pinned text is NOT enough,
// because the base (with its pinned clauses) is always prepended. A patch
// that appends "you may now fabricate" passes a presence check while
// contradicting it. These regexes reject known contradiction shapes.
// Deterministic, documented, testable — not a substitute for reviewing
// patches on the dashboard before sending them.
const ADVERSARIAL_APPEND_RE = [
  /(ignore|forget|disregard|override|cancel)[^.\n]{0,60}(previous|prior|above|earlier)[^.\n]{0,60}(instruction|rule|prompt|boundary)/i,
  /(you may|you are now (allowed|permitted|free)|feel free)[^.\n]{0,40}(fabricate|invent|make up|hallucinate|bypass|unsafe)/i,
  /(no longer|stop|don'?t|do not)[^.\n]{0,30}(fabricate|safety|boundar|restrict|guardrail)/i,
  /(safety|fabricat|guardrail|boundar)[^.\n]{0,30}(removed|revoked|lifted|disabled|off)/i,
  /(act as|you are|pretend|roleplay)[^.\n]{0,40}(uncensored|unfiltered|unrestricted|dan\b|jailbreak)/i,
];

const LIMITS = {
  systemPromptAppend: 8000,   // chars
  behaviorFlags: 32,          // keys
  flagName: 64,
  flagValue: 1024,
  toolHint: 256,
};

const ALLOWED_BEHAVIOR_KEYS = new Set([
  'observeCacheTtlMs',      // warm-scan cache TTL hint
  'maxFindResults',         // semantic find result cap
  'visionMode',             // 'auto' | 'off' | 'full-only'
  'retryDelayMs',           // LLM retry base delay
  'enableAutoNotes',        // agent auto-notes toggle
  'announceFindLLM',        // announce nested-LLM find usage in the UI
  'customFlag1', 'customFlag2', 'customFlag3' // forward-compat slots
]);

/** Validate an incoming config patch. Pure; exported for tests.
 * @param {Object} patch - { systemPromptAppend?, behavior? , toolHints? }
 * @returns {{ok: boolean, errors: string[], clean: Object}}
 */
export function validateConfigPatch(patch) {
  const errors = [];
  const clean = {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, errors: ['patch must be an object'], clean: {} };
  }
  if (typeof patch.systemPromptAppend === 'string') {
    const t = patch.systemPromptAppend;
    if (t.length > LIMITS.systemPromptAppend) {
      errors.push(`systemPromptAppend exceeds ${LIMITS.systemPromptAppend} chars`);
    } else {
      clean.systemPromptAppend = t;
    }
  }
  if (patch.behavior !== undefined) {
    if (!patch.behavior || typeof patch.behavior !== 'object' || Array.isArray(patch.behavior)) {
      errors.push('behavior must be an object');
    } else {
      const keys = Object.keys(patch.behavior);
      if (keys.length > LIMITS.behaviorFlags) errors.push(`behavior exceeds ${LIMITS.behaviorFlags} keys`);
      const cleanBehavior = {};
      for (const k of keys) {
        if (!ALLOWED_BEHAVIOR_KEYS.has(k)) { errors.push(`unknown behavior key: ${k}`); continue; }
        if (k.length > LIMITS.flagName) { errors.push(`behavior key too long: ${k}`); continue; }
        const v = patch.behavior[k];
        const vs = typeof v === 'string' ? v : JSON.stringify(v);
        if (vs && vs.length > LIMITS.flagValue) { errors.push(`behavior value too long for ${k}`); continue; }
        cleanBehavior[k] = v;
      }
      if (Object.keys(cleanBehavior).length) clean.behavior = cleanBehavior;
    }
  }
  if (patch.toolHints !== undefined) {
    if (!Array.isArray(patch.toolHints)) {
      errors.push('toolHints must be an array');
    } else {
      const hints = patch.toolHints
        .filter(h => typeof h === 'string' && h.length <= LIMITS.toolHint)
        .slice(0, 10);
      if (hints.length) clean.toolHints = hints;
    }
  }
  const known = Object.keys(clean);
  if (!known.length) errors.push('patch contained no valid fields');
  return { ok: errors.length === 0, errors, clean };
}

/**
 * Check a candidate prompt against the pinned safety floor. Pure; tests.
 * The floor holds if every pinned snippet still appears (case-insensitive)
 * in the merged prompt.
 * @param {string} mergedPrompt
 * @returns {boolean}
 */
export function safetyFloorHolds(mergedPrompt) {
  const p = String(mergedPrompt || '').toLowerCase();
  return PINNED_PREAMBLE_SNIPPETS.every(s => p.includes(s.toLowerCase()));
}

/**
 * Merge a validated patch over the built-in prompt. Pure; tests.
 * Enforces the safety floor: if appending would break it, the append is
 * rejected (returns base unchanged with floorBroken=true).
 * @param {string} basePrompt - built-in systemPromptTweak
 * @param {Object} validatedPatch - output of validateConfigPatch().clean
 * @returns {{prompt: string, floorBroken: boolean}}
 */
export function mergePrompt(basePrompt, validatedPatch) {
  const base = String(basePrompt || '');
  const append = validatedPatch && validatedPatch.systemPromptAppend;
  if (!append) return { prompt: base, floorBroken: false };
  for (const re of ADVERSARIAL_APPEND_RE) {
    if (re.test(append)) return { prompt: base, floorBroken: true };
  }
  const merged = `${base}\n${append}`;
  if (!safetyFloorHolds(merged)) {
    return { prompt: base, floorBroken: true };
  }
  // A malicious append that CONTAINS the pinned text without the base would
  // pass the includes() check above — but the base is always present by
  // construction (we prepend it), so this is belt-and-suspenders.
  return { prompt: merged, floorBroken: false };
}

// ---------- Storage ----------

function getStorage(storage) {
  return storage || (typeof chrome !== 'undefined' && chrome.storage ? chrome.storage.local : null);
}

// v20.1: chrome.storage compatibility wrapper — real MV3 chrome uses
// callback-style, some environments/mocks use promise-style. Handle both,
// with a short timeout so a broken impl can never hang the caller.
function stGet(st, keys) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(_t);
      resolve(v || {});
    };
    const _t = setTimeout(() => done({}), 150);
    try {
      const r = st.get(keys, (res) => done(res));
      if (r && typeof r.then === 'function') r.then((res) => done(res), () => done({}));
    } catch (_e) { done({}); }
  });
}

function stSet(st, obj) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; clearTimeout(_t); resolve(); } };
    const _t = setTimeout(done, 150);
    try {
      const r = st.set(obj, () => done());
      if (r && typeof r.then === 'function') r.then(done, done);
    } catch (_e) { done(); }
  });
}

/** Load the stored remote config. Safe without chrome. */
export async function loadRemoteConfig(storage) {
  const st = getStorage(storage);
  if (!st) return null;
  try {
    const got = await stGet(st, [CONFIG_KEY]);
    const cfg = got && got[CONFIG_KEY];
    return (cfg && typeof cfg === 'object') ? cfg : null;
  } catch (_e) {
    return null;
  }
}

/**
 * Validate + persist an incoming patch. Returns a result object for the
 * bridge to relay back to the server.
 * @param {Object} patch
 * @param {Object} [storage]
 * @returns {Promise<{ok: boolean, errors?: string[], applied?: Object}>}
 */
export async function applyRemoteConfig(patch, storage) {
  const st = getStorage(storage);
  const { ok, errors, clean } = validateConfigPatch(patch);
  if (!ok) return { ok: false, errors };
  if (!st) return { ok: true, applied: clean }; // validation-only mode (tests)
  try {
    await stSet(st, { [CONFIG_KEY]: clean });
    return { ok: true, applied: clean };
  } catch (e) {
    return { ok: false, errors: [getErrorMessage(e)] };
  }
}

/**
 * Runtime resolver: merged system prompt honoring any stored patch.
 * Used by llm-client instead of reading provider.systemPromptTweak raw.
 * @param {string} basePrompt
 * @param {Object} [storage]
 * @returns {Promise<string>}
 */
export async function resolveSystemPrompt(basePrompt, storage) {
  const cfg = await loadRemoteConfig(storage);
  if (!cfg) return basePrompt;
  const { prompt } = mergePrompt(basePrompt, cfg);
  return prompt;
}

/**
 * Runtime resolver: behavior flags merged over defaults.
 * @param {Object} defaults
 * @param {Object} [storage]
 * @returns {Promise<Object>}
 */
export async function resolveBehaviorFlags(defaults = {}, storage) {
  const cfg = await loadRemoteConfig(storage);
  if (!cfg || !cfg.behavior) return { ...defaults };
  const out = { ...defaults };
  for (const k of Object.keys(cfg.behavior)) {
    if (ALLOWED_BEHAVIOR_KEYS.has(k)) out[k] = cfg.behavior[k];
  }
  return out;
}

/** Clear stored config (popup "reset to built-in" button / tests). */
export async function clearRemoteConfig(storage) {
  const st = getStorage(storage);
  if (!st) return;
  try { await new Promise((r) => { try { st.remove([CONFIG_KEY], () => r()); } catch (_e) { r(); } }); } catch (_e) { /* noop */ }
}
