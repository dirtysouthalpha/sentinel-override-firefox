// background/telemetry.js
// Live Telemetry — v3.25.0
//
// Solves the "agent black box" problem: when something hangs or behaves
// oddly, the user has no visibility into what's happening internally. This
// module exposes a single emit() API that fans out to:
//   1. chrome.runtime.sendMessage — the popup's telemetry panel subscribes
//      and renders a live stream.
//   2. console.log/warn/error — visible in chrome://extensions service
//      worker DevTools for deep debugging.
//   3. (Future) Forensic run log integration — append-only durable record.
//
// Verbosity is controlled by chrome.storage.local.telemetryLevel:
//   'quiet'   — error only
//   'normal'  — error + warn + info (DEFAULT)
//   'verbose' — error + warn + info + debug
//   'debug'   — all levels including trace
//
// Categories (passed as the first arg) classify events for filtering in
// the panel UI. Keep them stable — the panel's filter chips use them.

import { getErrorMessage } from './error-utils.js';
import { FIVE_SECONDS_MS } from './constants.js';

const LEVELS = { error: 4, warn: 3, info: 2, debug: 1, trace: 0 };

const KNOWN_CATEGORIES = [
  'llm',          // LLM API calls
  'skill',        // Recovery skill consultations + applications
  'platform',     // Platform profile detection / context injection
  'memory',       // Agent memory writes / rejections
  'cdp',          // Chrome DevTools Protocol attach/detach/eval
  'page',         // Page observation / read_page / dismiss_overlay
  'sleep',        // Human-like delays between steps
  'storage',      // chrome.storage writes (run log, history, settings)
  'network',      // read_network_requests captures
  'lifecycle',    // Agent start/finish/pause/resume/step transitions
  'error',        // Errors in any path (always shown regardless of level)
];

let _currentLevel = 'normal';
let _seq = 0;

const MAX_PERSISTED_RUNS = 5;
const PERSIST_FLUSH_INTERVAL_MS = FIVE_SECONDS_MS;
const PERSIST_MAX_EVENTS_PER_RUN = 1000;
let _currentRunId = null;
let _currentRunGoal = '';
let _currentRunStartedAt = 0;
let _runBuffer = [];
let _persistEnabled = false;
let _persistFlushTimer = null;
let _pendingPersistFlush = false;

// In-memory cache for runs index to eliminate repetitive I/O
let _runsIndexCache = null;
// Pending read promise to prevent duplicate storage reads when multiple callers invoke _getRunsIndex simultaneously
let _runsIndexReadPromise = null;

// (3.28.0) Redaction layer. With v3.27.0 persistence + Export JSON shipped,
// telemetry payloads can leak across sessions and into bug-report files. We
// scrub aggressively by default — operators can disable via
// chrome.storage.local.telemetryRedact = false if needed for debugging.
let _redactEnabled = true;

// API key / secret patterns. Anchored conservatively so we don't false-positive
// on URLs that legitimately contain hex/base64.
const REDACT_PATTERNS = [
  // Anthropic: sk-ant-* (must run before the broader OpenAI sk-* pattern)
  { re: /\b(sk-ant-[A-Za-z0-9_-]{20,})\b/g, label: 'anthropic-key' },
  // OpenAI: sk-proj-* / sk-* (40+ chars after prefix, excludes sk-ant-)
  { re: /\b(sk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,})\b/g, label: 'openai-key' },
  // GitHub: ghp_*, gho_*, ghu_*, ghs_*, ghr_*
  { re: /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, label: 'github-token' },
  // AWS access key id
  { re: /\b(AKIA[0-9A-Z]{16})\b/g, label: 'aws-access-key' },
  // Google API key
  { re: /\b(AIza[0-9A-Za-z_-]{35})\b/g, label: 'google-api-key' },
  // Slack tokens
  { re: /\b(xox[abprs]-[A-Za-z0-9-]{10,})\b/g, label: 'slack-token' },
  // Stripe live keys
  { re: /\b((?:sk|pk|rk)_live_[A-Za-z0-9]{20,})\b/g, label: 'stripe-key' },
  // Bearer / Basic auth headers (case-insensitive). Capture the SCHEME so we
  // can preserve it in the redacted output — useful for confirming the auth
  // type in a bug report without leaking the credential itself.
  { re: /\b(Bearer|Basic)\s+([A-Za-z0-9+/=._-]{8,})/gi, label: 'auth-header' },
  // JWT-shaped tokens (three dot-separated base64 segments, decent length)
  { re: /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, label: 'jwt' },
];

// JSON field names whose VALUES should be redacted regardless of pattern match.
// Matched case-insensitively against the full key name.
const REDACT_KEY_PATTERNS = [
  /password/i,
  /passwd/i,
  /secret/i,
  /^api[_-]?key$/i,
  /^auth[_-]?token$/i,
  /^access[_-]?token$/i,
  /^refresh[_-]?token$/i,
  /^bearer[_-]?token$/i,
  /^session[_-]?token$/i,
  /private[_-]?key/i,
  /^client[_-]?secret$/i,
  /^csrf[_-]?token$/i,
  /^recovery[_-]?code$/i,
  /^mfa[_-]?code$/i,
];

// URL query params to scrub. Other params pass through.
// (Note: param names are also hardcoded in _redactString's regex for perf.)
 
const _REDACT_QUERY_PARAMS = new Set([
  'token', 'access_token', 'refresh_token', 'auth_token', 'id_token',
  'apikey', 'api_key', 'key', 'secret', 'password', 'pwd', 'sig', 'signature',
  'code', 'state'  // OAuth flow values
]);

function _redactString(s) {
  if (typeof s !== 'string' || !s.length) return s;
  let out = s;
  // Pattern-based replacements
  for (const { re, label } of REDACT_PATTERNS) {
    out = out.replace(re, (full, p1, p2) => {
      // Special case: auth headers — preserve scheme, redact credential
      if (label === 'auth-header' && p1 && p2) return `${p1} [REDACTED:${label}]`;
      return `[REDACTED:${label}]`;
    });
  }
  // URL query-param scrub (string-level; we don't try to parse — just match)
  out = out.replace(/([?&])(token|access_token|refresh_token|auth_token|id_token|apikey|api_key|key|secret|password|pwd|sig|signature|code|state)=([^&\s"'<>]+)/gi,
    (m, sep, k) => `${sep}${k}=[REDACTED]`);
  return out;
}

function _redactValue(value, keyHint) {
  // Field-name driven scrub (handles whole-value redaction for password-like keys)
  if (keyHint && typeof value === 'string' && value) {
    for (const kre of REDACT_KEY_PATTERNS) {
      if (kre.test(keyHint)) return '[REDACTED]';
    }
  }
  if (value == null) return value;
  if (typeof value === 'string') return _redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(v => _redactValue(v, keyHint));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = _redactValue(v, k);
    }
    return out;
  }
  return value;
}

function _redactEvent(event) {
  if (!_redactEnabled || !event) return event;
  try {
    // We construct a new object rather than mutating in place — the unredacted
    // event may still be useful in SW console logs (we don't scrub those for
    // backwards compatibility; operators can flip _redactConsoleAlso if needed).
    return {
      ...event,
      message: _redactString(event.message),
      payload: _redactValue(event.payload, null)
    };
  } catch (e) {
    console.warn('[Sentinel] redaction failed, returning original event', e);
    // If redaction throws, fail open with the original event rather than
    // dropping telemetry entirely — visibility is the whole point of the panel.
    return event;
  }
}

(function loadLevel() {
  try {
    chrome.storage.local.get(['telemetryLevel', 'telemetryPersist', 'telemetryRedact'], (r) => {
      if (chrome.runtime.lastError) { console.warn('[Sentinel/telemetry] loadLevel failed:', getErrorMessage(chrome.runtime.lastError)); return; }
      if (r && typeof r.telemetryLevel === 'string') _currentLevel = r.telemetryLevel;
      if (r && typeof r.telemetryPersist === 'boolean') _persistEnabled = r.telemetryPersist;
      // (3.28.0) Default ON for safety; respects explicit false from storage.
      if (r && typeof r.telemetryRedact === 'boolean') _redactEnabled = r.telemetryRedact;
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.telemetryLevel) {
        _currentLevel = changes.telemetryLevel.newValue || 'normal';
      }
      if (changes.telemetryPersist) {
        _persistEnabled = !!changes.telemetryPersist.newValue;
        if (!_persistEnabled) {
          _runsIndexCache = null;
          _runBuffer = [];
          if (_persistFlushTimer) { clearInterval(_persistFlushTimer); _persistFlushTimer = null; }
        } else if (_persistEnabled && _currentRunId && !_persistFlushTimer) {
          _scheduleFlush();
        }
      }
      if (changes.telemetryRedact) {
        // Default-true semantics: any explicit value sets the flag; missing/unset = true.
        const v = changes.telemetryRedact.newValue;
        _redactEnabled = (v == null) ? true : !!v;
      }
      if (changes.telemetry_runs_index) {
        _runsIndexCache = Array.isArray(changes.telemetry_runs_index.newValue) ? changes.telemetry_runs_index.newValue : [];
        _runsIndexReadPromise = null;
      }
    });
  } catch (e) { console.warn('[Sentinel/telemetry] init error:', getErrorMessage(e)); }
})();

function _scheduleFlush() {
  if (_persistFlushTimer) return;
  _persistFlushTimer = setInterval(() => {
    if (_pendingPersistFlush) {
      _flushRunBuffer();
    }
  }, PERSIST_FLUSH_INTERVAL_MS);
}

async function _flushRunBuffer() {
  if (!_persistEnabled || !_currentRunId || !_runBuffer.length) return;
  const key = `telemetry_run_${_currentRunId}`;
  try {
    const stored = await chrome.storage.local.get(key);
    const existing = Array.isArray(stored[key]) ? stored[key] : [];
    const merged = [...existing, ..._runBuffer];
    const capped = merged.length > PERSIST_MAX_EVENTS_PER_RUN
      ? merged.slice(-PERSIST_MAX_EVENTS_PER_RUN)
      : merged;
    await chrome.storage.local.set({ [key]: capped });
    _pendingPersistFlush = false;
    _runBuffer = [];
  } catch (e) {
    // Re-enable so the interval timer retries on the next tick
    _pendingPersistFlush = true;
    console.warn('[Sentinel/telemetry] flush error (will retry):', getErrorMessage(e));
  }
}

/**
 * Get the runs index from cache or storage.
 * Uses in-memory cache to eliminate repetitive I/O.
 * Coalesces simultaneous reads to prevent duplicate storage access.
 * @returns {Promise<Array>} The runs index array.
 */
async function _getRunsIndex() {
  if (_runsIndexCache !== null) return _runsIndexCache;
  // If a read is already in progress, wait for it to complete instead of duplicating the I/O
  if (_runsIndexReadPromise) return _runsIndexReadPromise;
  try {
    _runsIndexReadPromise = (async () => {
      const stored = await chrome.storage.local.get('telemetry_runs_index');
      _runsIndexCache = Array.isArray(stored.telemetry_runs_index) ? stored.telemetry_runs_index : [];
      _runsIndexReadPromise = null;
      return _runsIndexCache;
    })();
    return await _runsIndexReadPromise;
  } catch (e) {
    _runsIndexCache = [];
    _runsIndexReadPromise = null;
    throw e;
  }
}

/**
 * Set the runs index, updating cache and storage atomically.
 * @param {Array} index - The runs index array.
 */
async function _setRunsIndex(index) {
  _runsIndexCache = index;
  await chrome.storage.local.set({ telemetry_runs_index: index });
}

/**
 * Start a new telemetry run, creating an entry in the persisted runs index.
 * Evicts oldest runs beyond MAX_PERSISTED_RUNS.
 * @param {string} runId - Unique run identifier.
 * @param {string} goal - The goal text for this run (truncated to 200 chars).
 */
export async function startRun(runId, goal) {
  _currentRunId = runId || null;
  _currentRunGoal = (goal || '').substring(0, 200);
  _currentRunStartedAt = Date.now();
  _runBuffer = [];
  if (!_persistEnabled || !_currentRunId) return;
  try {
    const cachedIndex = await _getRunsIndex();
    const index = [...cachedIndex];
    index.unshift({
      runId: _currentRunId,
      goal: _currentRunGoal,
      startedAt: _currentRunStartedAt,
      finishedAt: null,
      count: 0
    });
    const toEvict = index.splice(MAX_PERSISTED_RUNS);
    for (const old of toEvict) {
      try { await chrome.storage.local.remove(`telemetry_run_${old.runId}`); } catch (e) { console.warn('[Sentinel/telemetry] evict error:', getErrorMessage(e)); }
    }
    await _setRunsIndex(index);
    _scheduleFlush();
  } catch (e) { console.warn('[Sentinel/telemetry] startRun error:', getErrorMessage(e)); }
}

/**
 * End the current telemetry run, flush buffered events, and update the runs index.
 * @param {string} runId - Run identifier to finalize (uses current if omitted).
 */
export async function endRun(runId) {
  if (_persistFlushTimer) { clearInterval(_persistFlushTimer); _persistFlushTimer = null; }
  const id = runId || _currentRunId;
  if (!_persistEnabled || !id) {
    _currentRunId = null;
    _runBuffer = [];
    return;
  }
  try {
    await _flushRunBuffer();
    const cachedIndex = await _getRunsIndex();
    const index = [...cachedIndex];
    const storedEvents = await chrome.storage.local.get(`telemetry_run_${id}`);
    const events = Array.isArray(storedEvents[`telemetry_run_${id}`]) ? storedEvents[`telemetry_run_${id}`] : [];
    const entry = index.find(e => e.runId === id);
    if (entry) {
      entry.finishedAt = Date.now();
      entry.count = events.length;
      await _setRunsIndex(index);
    }
  } catch (e) { console.warn('[Sentinel/telemetry] endRun error:', getErrorMessage(e)); }
  _currentRunId = null;
  _runBuffer = [];
}

/**
 * List all persisted telemetry run metadata from storage.
 * @returns {Promise<Array>} Array of run index entries (runId, goal, startedAt, etc.).
 */
export async function listPersistedRuns() {
  try {
    return await _getRunsIndex();
  } catch { return []; }
}

/**
 * Load all telemetry events for a specific persisted run.
 * @param {string} runId - The run identifier to load.
 * @returns {Promise<Array>} Array of telemetry event objects.
 */
export async function loadPersistedRun(runId) {
  if (!runId) return [];
  try {
    const stored = await chrome.storage.local.get(`telemetry_run_${runId}`);
    return Array.isArray(stored[`telemetry_run_${runId}`]) ? stored[`telemetry_run_${runId}`] : [];
  } catch { return []; }
}

/**
 * Delete a persisted run from both the index and event storage.
 * @param {string} runId - The run identifier to delete.
 */
export async function deletePersistedRun(runId) {
  if (!runId) return;
  try {
    const cachedIndex = await _getRunsIndex();
    const index = [...cachedIndex];
    const filtered = index.filter(e => e.runId !== runId);
    await _setRunsIndex(filtered);
    await chrome.storage.local.remove(`telemetry_run_${runId}`);
  } catch (e) { console.warn('[Sentinel/telemetry] deletePersistedRun error:', getErrorMessage(e)); }
}

function _shouldEmit(level) {
  const lvl = LEVELS[level] != null ? LEVELS[level] : LEVELS.info;
  const threshold = _currentLevel === 'debug' ? LEVELS.trace
    : _currentLevel === 'verbose' ? LEVELS.debug
    : _currentLevel === 'quiet' ? LEVELS.error
    : LEVELS.info;
  return lvl >= threshold;
}

/**
 * Emit a telemetry event. Broadcasts to the popup/side-panel via runtime messaging,
 * logs to the service worker console, and buffers for run persistence.
 * Respects the current log level — events below threshold are silently dropped
 * (errors always emit regardless of level).
 * @param {string} category - Event category (e.g. 'agent', 'llm', 'ui').
 * @param {string} level - Log level: 'trace'|'debug'|'info'|'warn'|'error'.
 * @param {string} message - Human-readable event message.
 * @param {*} [payload] - Optional structured data attached to the event.
 */
export function emit(category, level, message, payload) {
  if (level !== 'error' && !_shouldEmit(level)) return;
  _seq++;
  const rawEvent = {
    action: 'telemetry_event',
    ts: Date.now(),
    seq: _seq,
    category: String(category || 'misc'),
    level: String(level || 'info'),
    message: String(message || '').substring(0, 500),
    payload: payload || null
  };
  // (3.28.0) Scrub before broadcast + persist. The SW console mirror below
  // still gets the RAW event so operators with chrome://extensions DevTools
  // open can see un-redacted detail — that's already a trust boundary
  // (anyone with DevTools could read storage anyway), but no version of the
  // event ever leaves the SW unredacted when telemetryRedact is on.
  const event = _redactEvent(rawEvent);
  try {
    // SW console shows rawEvent — chrome://extensions DevTools access is
    // already a trust boundary, and unredacted output helps deep debugging.
    const consoleArgs = [`[Sentinel/${rawEvent.category}]`, rawEvent.message];
    if (payload) consoleArgs.push(payload);
    if (level === 'error') console.error.apply(console, consoleArgs);
    else if (level === 'warn') console.warn.apply(console, consoleArgs);
    else if (level === 'debug' || level === 'trace') console.debug.apply(console, consoleArgs);
    else console.log.apply(console, consoleArgs);
  } catch (_e) { /* console unavailable in some contexts */ }
  try {
    chrome.runtime.sendMessage(event).catch(() => {
      // Popup not open — expected when side panel is closed. Silent.
    });
  } catch (_e) { /* extension context invalidated */ }
  if (_currentRunId && _persistEnabled) {
    try {
      _runBuffer.push(event);
      _pendingPersistFlush = true;
      if (_runBuffer.length >= 200) {
        _flushRunBuffer().catch(() => {});
      }
    } catch (_e) { /* buffer append is non-critical */ }
  }
}

export const tel = {
  error: (cat, msg, pl) => emit(cat, 'error', msg, pl),
  warn:  (cat, msg, pl) => emit(cat, 'warn',  msg, pl),
  info:  (cat, msg, pl) => emit(cat, 'info',  msg, pl),
  debug: (cat, msg, pl) => emit(cat, 'debug', msg, pl),
  trace: (cat, msg, pl) => emit(cat, 'trace', msg, pl),
};

/**
 * Get the list of known telemetry event categories.
 * @returns {string[]} Copy of the known categories array.
 */
export function listCategories() {
  return KNOWN_CATEGORIES.slice();
}

/**
 * Get the current telemetry log level.
 * @returns {string} Current level: 'trace'|'debug'|'info'|'verbose'|'quiet'.
 */
export function getLevel() {
  return _currentLevel;
}

/**
 * Clear the runs index cache (for testing).
 */
export function _clearCacheForTests() { _runsIndexCache = null; }

