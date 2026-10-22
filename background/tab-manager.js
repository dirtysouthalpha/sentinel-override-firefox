// Sentinel Override v3 — Tab Manager
// Tab locking, page load waiting, content script injection, screenshot capture.
// Imports from message-protocol.js only (no circular dependency risk).

import { getErrorMessage, sleep } from './error-utils.js';
import { ONE_SECOND_MS, TWO_SECONDS_MS, THREE_SECONDS_MS, FIVE_SECONDS_MS, ONE_MINUTE_MS, MAX_LOG_ENTRY_LENGTH } from './constants.js';
// Credential redaction layer. Everything the model can read out of the network
// summary passes through here first: request/response header values, credential
// query params in URLs, and console entry source URLs. This is defence-in-depth
// on top of the `network_read` capability gate, never a replacement for it.
import { redactUrl, redactHeaders } from './secrets-redaction.js';

// ========== Page Load Waiting ==========
let pageLoadConfig = {
  pageLoadTimeout: 25000
};

/**
 * Override default page-load configuration.
 * Merges the provided config into the active pageLoadConfig object.
 *
 * @param {object} config - Configuration overrides (e.g. { pageLoadTimeout: 30000 }).
 */
export function setPageLoadConfig(config) {
  pageLoadConfig = { ...pageLoadConfig, ...config };
}

/**
 * Wait for a tab to finish loading (status === 'complete').
 * Resolves immediately if the tab is already complete or doesn't exist.
 * Uses the configured pageLoadTimeout as an upper bound.
 *
 * @param {number} tabId - The tab ID to wait for.
 * @returns {Promise<void>}
 */
export async function waitForPageLoad(tabId) {
  const tab = await new Promise(resolve => {
    chrome.tabs.get(tabId, (i) => {
      resolve((chrome.runtime.lastError && typeof chrome.runtime.lastError === 'object') ? null : i);
    });
  });
  if (!tab || tab.status === 'complete') return;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      try {
        chrome.tabs.onUpdated.removeListener(listener);
      } catch (_e) { /* ignore - listener may not be registered */ }
      resolve();
    }, pageLoadConfig.pageLoadTimeout);
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(listener); clearTimeout(timeout); resolve(); } };
    try {
      chrome.tabs.onUpdated.addListener(listener);
    } catch (_e) {
      clearTimeout(timeout);
      resolve();
    }
  });
}

// ========== Dynamic Page-Ready Detection (replaces fixed 1500ms sleep) ==========
// After waitForPageLoad resolves (tab status === 'complete'), the DOM may still
// be rendering (SPAs, lazy-loaded content, loading spinners). This function polls
// for actual content readiness using a combination of:
//   1. DOM readiness via content script (readyState, body content, spinner check)
//   2. Network idle detection via CDP (in-flight requests drop to 0 for 500ms)
// Caps total wait at pageLoadTimeout to prevent infinite hangs.

/**
 * Count in-flight network requests for a tab using CDP Network domain.
 * Returns the number of requests that have started but not yet completed or failed.
 *
 * @param {number} tabId - Chrome tab ID to count in-flight requests for.
 * @returns {number} Count of requests started but not yet finished (within timeout window).
 */
function getInFlightRequestCount(tabId) {
  const buf = networkBuffers.get(tabId);
  if (!buf || !(buf instanceof Map)) return 0;
  let count = 0;
  for (const entry of buf.values()) {
    // endTs === 0 means the request started but hasn't received a response or failure yet
    if (entry.endTs === 0 && (Date.now() - entry.startTs) < pageLoadConfig.pageLoadTimeout) {
      count++;
    }
  }
  return count;
}

/**
 * Query the tab's content script for DOM readiness state.
 * Returns true if readyState is 'complete', body has content (>50 chars),
 * and no spinner/loading element is visible.
 *
 * @param {number} tabId - Chrome tab ID to check.
 * @returns {Promise<boolean>} True if the page DOM appears fully loaded and rendered.
 */
async function _checkDomReadyState(tabId) {
  try {
    const result = await chrome.tabs.sendMessage(tabId, {
      action: 'execute_command',
      command: {
        type: 'execute_js',
        code: `(() => {
            const rs = document.readyState;
            const bodyLen = (document.body && document.body.innerText) ? document.body.innerText.length : 0;
            const hasSpinner = !!document.querySelector('[class*="spinner"], [class*="loading"], [class*="loader"], [role="progressbar"]');
            return JSON.stringify({ readyState: rs, bodyLen: bodyLen, hasSpinner: hasSpinner });
          })()`
      }
    }).catch(() => null);
    if (!result) return false;
    let data = result;
    if (typeof data === 'string') {
      try { data = JSON.parse(data.replace('JS Result: ', '')); } catch (_e) { /* parse failed */ }
    }
    if (data && typeof data === 'object') {
      let parsed;
      try { parsed = typeof data.value === 'string' ? JSON.parse(data.value) : data; } catch (_e) { parsed = null; }
      if (parsed && parsed.readyState === 'complete' && parsed.bodyLen > 50 && !parsed.hasSpinner) return true;
    } else if (typeof data === 'string') {
      try {
        const parsed = JSON.parse(data);
        if (parsed && parsed.readyState === 'complete' && parsed.bodyLen > 50 && !parsed.hasSpinner) return true;
      } catch (_e) { /* parse failed */ }
    }
  } catch (_e) {
    // Content script not yet injected — normal during page load
  }
  return false;
}

/**
 * Poll until the tab's page is loaded and the content script is responsive.
 * Caps the wait at the configured page-load timeout if maxWaitMs exceeds it.
 *
 * @param {number} tabId - Chrome tab ID to wait on.
 * @param {number} [maxWaitMs=5000] - Maximum milliseconds to wait.
 * @returns {Promise<void>}
 */
export async function waitForPageReady(tabId, maxWaitMs = FIVE_SECONDS_MS) {
  const cap = Math.min(Math.max(0, Number(maxWaitMs) || FIVE_SECONDS_MS), pageLoadConfig.pageLoadTimeout);
  const startTime = Date.now();
  const pollInterval = 200;
  const networkIdleMs = 500;

  let networkIdleSince = null;

  while (Date.now() - startTime < cap) {
    const domReady = await _checkDomReadyState(tabId);

    // Check network idle
    const inFlight = getInFlightRequestCount(tabId);
    if (inFlight === 0) {
      if (!networkIdleSince) networkIdleSince = Date.now();
    } else {
      networkIdleSince = null;
    }
    const networkIdle = networkIdleSince && (Date.now() - networkIdleSince >= networkIdleMs);

    // 3. Both DOM ready and network idle → page is truly ready
    if (domReady && networkIdle) return;

    // 4. If DOM is ready and we've been waiting for network idle for a while,
    //    don't block forever — proceed if we've waited at least 1s total
    if (domReady && Date.now() - startTime >= ONE_SECOND_MS) return;

    // 5. If no content script is available and we've waited 2s, proceed
    if (Date.now() - startTime >= TWO_SECONDS_MS && !domReady) return;

    await sleep(pollInterval);
  }
  // Timeout — proceed anyway (same behavior as the old fixed 1500ms sleep)
}

// ========== Content Script Injection ==========
/**
 * Create a one-shot listener that waits for the content script to signal readiness.
 * Returns a promise that resolves to `true` if the content script responds,
 * or `false` on timeout. Also exposes a `cancel()` method for manual cleanup.
 *
 * @param {number} tabId - The tab to listen for.
 * @param {number} [timeout=3000] - Maximum wait in milliseconds.
 * @returns {{ promise: Promise<boolean>, cancel: () => void }}
 */
export function createContentScriptListener(tabId, timeout = THREE_SECONDS_MS) {
  let timer, listener, resolved = false;
  const promise = new Promise((resolve) => {
    timer = setTimeout(() => { if (resolved) return; resolved = true; chrome.runtime.onMessage.removeListener(listener); resolve(false); }, timeout);
    listener = (msg, sender) => {
      if (msg.action === 'content_script_ready' && sender.tab && sender.tab.id === tabId) {
        if (resolved) return; resolved = true; chrome.runtime.onMessage.removeListener(listener); clearTimeout(timer); resolve(true);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
  });
  return { promise, cancel() { if (resolved) return; resolved = true; chrome.runtime.onMessage.removeListener(listener); clearTimeout(timer); } };
}

/**
 * Inject the content script into the target tab, with retry logic.
 * Returns true if the content script signaled ready, false otherwise.
 *
 * @param {number} tabId
 * @param {number} [maxAttempts=3]
 * @returns {Promise<boolean>}
 */
const CONTENT_SCRIPT_FILES = [
  'content/dom-utils.js',
  'content/shadow-dom.js',
  'content/highlight.js',
  'content/cursor.js',
  'content/action-hud.js',
  'content/wait-utils.js',
  'content/dropdown-utils.js',
  'content/special-inputs.js',
  'content/overlay-detector.js',
  'content/frame-manager.js',
  'content/index.js'
];

/**
 * Inject the content script bundle into the target tab and wait for readiness.
 * Retries up to maxAttempts times with a 500ms delay between attempts.
 *
 * @param {number} tabId - The tab to inject into.
 * @param {number} [maxAttempts=3] - Number of injection attempts.
 * @returns {Promise<boolean>} True if the content script signaled ready.
 */
export async function injectContentScript(tabId, maxAttempts = 3) {
  // (SO-71) Fast path: if the bundle is already live in this tab (injected by a
  // prior call, another run, or the tab-manager navigation path), pinging it
  // succeeds without re-executing the files. Re-executing content/index.js in
  // the same isolated world redeclares its top-level consts and kills the
  // running content script with SyntaxError.
  try {
    const alive = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => !!(window.__sentinelContentAlive === true)
    });
    if (alive && alive[0] && alive[0].result === true) return true;
  } catch { /* tab may not be injectable yet — fall through to full injection */ }
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const csListener = createContentScriptListener(tabId);
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPT_FILES });
      const scriptReady = await csListener.promise;
      if (scriptReady) return true;
    } catch { csListener.cancel(); }
    await sleep(500);
  }
  return false;
}

// ========== Message Sending with Retry ==========
/**
 * Send a message to the content script in a tab, with automatic retry and
 * re-injection on failure. Unwraps the content-script response envelope
 * ({ ok, data }) and the inner execute_command wrapper ({ result }).
 *
 * @param {number} tabId - Target tab ID.
 * @param {object} message - The message payload to send.
 * @param {number} [maxRetries=3] - Maximum send attempts before throwing.
 * @returns {Promise<*>} The unwrapped response data from the content script.
 * @throws {Error} If all retries are exhausted.
 */
export async function sendMessageWithRetry(tabId, message, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, message);
      // Unwrap the content-script envelope: { ok: true, data: <actual> }
      if (response && !response.ok) {
        throw new Error(response.error || 'Content script error');
      }
      // Unwrap outer envelope
      let data = response && response.data !== undefined ? response.data : response;
      // Unwrap inner execute_command wrapper: { result: <string> }
      // Content script returns { result } for execute_command actions
      if (data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length === 1 && 'result' in data) {
        data = data.result;
      }
      return data;
    } catch (err) {
      if (i < maxRetries - 1) {
        // (SO-71) Route re-injection through injectContentScript: its ping-gate
        // skips re-execution when the bundle is already live. The raw
        // executeScript used here re-ran the whole bundle in the same isolated
        // world; the second parse redeclared its top-level consts and killed
        // the running content script with SyntaxError.
        // One attempt per message-retry: the outer loop retries anyway, and the
        // next round's ping-gate adopts the script once it finishes loading.
        try { await injectContentScript(tabId, 1); } catch { /* gated injector already bounded */ }
        await sleep(500 * (i + 1));
      } else { throw err; }
    }
  }
}

// ========== Screenshot Capture ==========
// CDP debugger attachment tracking — keep one attachment per tab for the duration
// of an agent run, instead of attach/detach on every screenshot. This avoids the
// CDP banner shifting viewport pixels by ~30px between captures.
const attachedDebuggees = new Set();
const userDetachedTabs = new Set(); // tabs where the user dismissed the CDP banner
let onDetachListenerInstalled = false;

// (3.7.0) Per-tab observability buffers for read_console_messages and
// read_network_requests. Keys are tabIds; values are bounded ring-buffers
// of recent entries. Listener installation is tracked per-tab so we don't
// double-subscribe across re-attaches.
const consoleBuffers = new Map();   // tabId -> Array<{level,text,url,line,ts}>
const networkBuffers = new Map();   // tabId -> Map<requestId, {method,url,status,duration,startTs,endTs,type,requestHeaders,responseHeaders,failed,errorText}>
                                    // url/requestHeaders/responseHeaders are stored REDACTED (see secrets-redaction.js).
const observabilityListenersInstalled = new Set(); // tabIds
const CONSOLE_BUFFER_MAX = 200;
const NETWORK_BUFFER_MAX = 200;

/**
 * Append a console log entry to the tab's console buffer.
 * Evicts oldest entries when the buffer exceeds CONSOLE_BUFFER_MAX.
 *
 * @param {number} tabId - Chrome tab ID.
 * @param {{ level: string, text: string, url: string, line: number, ts: number }} entry -
 *   Console entry with severity level, message text, source URL, line number, and timestamp.
 */
function pushConsoleEntry(tabId, entry) {
  let buf = consoleBuffers.get(tabId);
  if (!buf) {
    buf = [];
    consoleBuffers.set(tabId, buf);
  }
  // Redact the source URL before storage: console entries carry the document /
  // script URL, which can itself hold a credential query param. Entry text is
  // left alone here — free-form text needs the pattern scanner in telemetry.js,
  // not this structural layer.
  buf.push({ ...entry, url: typeof entry.url === 'string' ? redactUrl(entry.url) : entry.url });
  const toRemove = buf.length - CONSOLE_BUFFER_MAX;
  if (toRemove > 0) buf.splice(0, toRemove);
}

/**
 * Record the start of a network request in the tab's network buffer.
 * Creates a new tracked entry with method, URL, type, and start timestamp.
 * Evicts oldest entries when the buffer exceeds NETWORK_BUFFER_MAX.
 *
 * SECURITY: the URL and the request headers are redacted (via
 * background/secrets-redaction.js) BEFORE they are stored, so no session cookie,
 * bearer token, basic-auth password, API key, or OAuth `?code=`/`?access_token=`
 * value ever lands in the buffer that readNetworkRequests hands to the model.
 * `params.request.postData` is deliberately NOT stored: a request body can carry
 * credentials (login forms, API payloads) and body-shaped redaction is not what
 * this layer does, so the safest move is to keep dropping it as before.
 *
 * @param {number} tabId - Chrome tab ID.
 * @param {object} params - CDP Network.requestWillBeSent event params.
 * @param {string} params.requestId - Unique request identifier.
 * @param {{ method: string, url: string, headers?: object }} [params.request] - HTTP request info.
 * @param {string} [params.type] - Resource type (Document, XHR, Script, etc.).
 */
function recordNetworkStart(tabId, params) {
  let buf = networkBuffers.get(tabId);
  if (!buf) { buf = new Map(); networkBuffers.set(tabId, buf); }
  if (!params || !params.requestId) return;
  buf.set(params.requestId, {
    method: (params.request && params.request.method) || '',
    url: redactUrl((params.request && params.request.url) || ''),
    type: params.type || '',
    status: 0,
    startTs: Date.now(),
    endTs: 0,
    duration: 0,
    failed: false,
    errorText: '',
    requestHeaders: redactHeaders((params.request && params.request.headers) || null),
    responseHeaders: null
  });
  // Bound the map size by trimming oldest entries.
  if (buf && buf.size > NETWORK_BUFFER_MAX) {
    const it = buf.keys();
    let toRemove = buf.size - NETWORK_BUFFER_MAX;
    while (toRemove-- > 0) {
      const { value: k, done } = it.next();
      if (done || k === undefined || k === null) break;
      buf.delete(k);
    }
  }
}
/**
 * Record a network response in the tab's network buffer.
 * Updates the matching request entry with status code, end timestamp, and duration.
 *
 * SECURITY: response headers are redacted before storage. `set-cookie` in
 * particular is the session token being handed to the page, so its value is
 * replaced with `[REDACTED]` and never emitted verbatim.
 *
 * @param {number} tabId - Chrome tab ID.
 * @param {object} params - CDP Network.responseReceived event params.
 * @param {string} params.requestId - Unique request identifier.
 * @param {{ status: number, headers?: object }} [params.response] - HTTP response.
 */
function recordNetworkResponse(tabId, params) {
  const buf = networkBuffers.get(tabId);
  if (!buf || !params || !params.requestId) return;
  const e = buf.get(params.requestId);
  if (!e) return;
  e.status = (params.response && params.response.status) || 0;
  e.endTs = Date.now();
  e.duration = e.endTs - e.startTs;
  if (params.response && params.response.headers) {
    e.responseHeaders = redactHeaders(params.response.headers);
  }
}
/**
 * Record a failed network request in the tab's network buffer.
 * Marks the request entry with a failure flag and error text.
 *
 * @param {number} tabId - Chrome tab ID.
 * @param {object} params - CDP Network.loadingFailed event params.
 * @param {string} params.requestId - Unique request identifier.
 * @param {string} [params.errorText] - Failure reason text.
 */
function recordNetworkFailure(tabId, params) {
  const buf = networkBuffers.get(tabId);
  if (!buf || !params || !params.requestId) return;
  const e = buf.get(params.requestId);
  if (!e) return;
  e.failed = true;
  e.errorText = params.errorText || 'failed';
  e.endTs = Date.now();
  e.duration = e.endTs - e.startTs;
}

/**
 * Merge the headers carried by a CDP `Network.*ExtraInfo` event into an existing
 * buffer entry. `requestWillBeSentExtraInfo` / `responseReceivedExtraInfo` are
 * the events that carry the headers `requestWillBeSent` omits — most importantly
 * the `Cookie` header and any `Set-Cookie` — so they are exactly the events a
 * credential leak would ride in on. Headers are redacted before merging.
 *
 * @param {number} tabId - Chrome tab ID.
 * @param {object} params - CDP Network.requestWillBeSentExtraInfo /
 *   Network.responseReceivedExtraInfo event params.
 * @param {string} params.requestId - Unique request identifier.
 * @param {object} [params.headers] - Extra header map for this request/response.
 * @param {'request'|'response'} direction - Which side of the exchange to merge into.
 */
function recordNetworkExtraHeaders(tabId, params, direction) {
  const buf = networkBuffers.get(tabId);
  if (!buf || !params || !params.requestId || !params.headers) return;
  const e = buf.get(params.requestId);
  if (!e) return;
  const redacted = redactHeaders(params.headers);
  if (direction === 'response') {
    e.responseHeaders = { ...(e.responseHeaders || {}), ...redacted };
  } else {
    e.requestHeaders = { ...(e.requestHeaders || {}), ...redacted };
  }
}

// Install Log + Network listeners on a tab once. Caller must already have
// chrome.debugger attached (we just enable the domains and wire the events).
/**
 * Enable CDP Log, Runtime, and Network domains on an attached tab.
 * Marks the tab as having observability listeners installed so domains
 * aren't re-enabled on subsequent calls. Errors from individual domain
 * enables are silently caught (some targets may not support all domains).
 *
 * @param {number} tabId - Chrome tab ID with an active debugger attachment.
 * @returns {Promise<void>}
 */
async function ensureObservabilityListeners(tabId) {
  if (observabilityListenersInstalled.has(tabId)) return;
  let anySucceeded = false;
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Log.enable');
    anySucceeded = true;
  } catch (_e) { /* may not be supported on this target */ }
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
    anySucceeded = true;
  } catch (_e) { /* Runtime domain may not be available */ }
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
    anySucceeded = true;
  } catch (_e) { /* Network domain may not be available */ }
  if (anySucceeded) {
    observabilityListenersInstalled.add(tabId);
  }
}

// Single global event hook: chrome.debugger fires onEvent for every attached
// target. We dispatch into per-tab buffers based on source.tabId.
let __obsEventHookInstalled = false;
/**
 * Install a global chrome.debugger.onEvent listener that dispatches CDP events
 * into per-tab console and network buffers. Handles Log.entryAdded,
 * Runtime.consoleAPICalled, Runtime.exceptionThrown, and Network domain events.
 * Only installs once; subsequent calls are no-ops.
 */
function installObservabilityEventHook() {
  if (__obsEventHookInstalled) return;
  __obsEventHookInstalled = true;
  try {
    chrome.debugger.onEvent.addListener((source, method, params) => {
      if (!source || typeof source.tabId !== 'number') return;
      const tabId = source.tabId;
      try {
        if (method === 'Log.entryAdded' && params && params.entry) {
          const e = params.entry;
          pushConsoleEntry(tabId, {
            level: e.level || 'info',
            text: (e && typeof e.text === 'string' ? e.text : '').substring(0, MAX_LOG_ENTRY_LENGTH),
            url: e.url || '',
            line: e.lineNumber || 0,
            ts: Date.now()
          });
        } else if (method === 'Runtime.consoleAPICalled' && params) {
          // console.log/error/warn/info — most app-level logs come through here
          const args = (Array.isArray(params.args) ? params.args : []).map(a => String(a?.value ?? a?.description ?? '')).join(' ').substring(0, MAX_LOG_ENTRY_LENGTH);
          pushConsoleEntry(tabId, {
            level: params.type || 'log',
            text: args,
            url: '',
            line: 0,
            ts: Date.now()
          });
        } else if (method === 'Runtime.exceptionThrown' && params && params.exceptionDetails) {
          const ex = params.exceptionDetails;
          const txt = ((ex.exception && typeof ex.exception === 'object') && (ex.exception.description || ex.exception.value)) || ex.text || 'exception';
          pushConsoleEntry(tabId, {
            level: 'error',
            text: (typeof txt === 'string' ? txt : '').substring(0, MAX_LOG_ENTRY_LENGTH),
            url: ex.url || '',
            line: ex.lineNumber || 0,
            ts: Date.now()
          });
        } else if (method === 'Network.requestWillBeSent') {
          recordNetworkStart(tabId, params);
        } else if (method === 'Network.requestWillBeSentExtraInfo') {
          recordNetworkExtraHeaders(tabId, params, 'request');
        } else if (method === 'Network.responseReceived') {
          recordNetworkResponse(tabId, params);
        } else if (method === 'Network.responseReceivedExtraInfo') {
          recordNetworkExtraHeaders(tabId, params, 'response');
        } else if (method === 'Network.loadingFailed') {
          recordNetworkFailure(tabId, params);
        }
      } catch (_e) { /* swallow per-event errors so one bad event can't disable the hook */ }
    });
  } catch (_e) { /* chrome.debugger unavailable in some test contexts */ }
}

/**
 * Read captured console messages for a tab (requires startConsoleCapture first).
 * Supports filtering by severity level and limiting result count.
 *
 * @param {number} tabId - The tab whose console buffer to read.
 * @param {object} [options] - Filter options.
 * @param {number} [options.limit=50] - Maximum entries to return (most recent).
 * @param {'error'|'errors'|'warning'|'warn'} [options.filter] - Severity filter.
 * @returns {Array<{level:string,text:string,timestamp:number}>} Filtered console entries.
 */
export function readConsoleMessages(tabId, options) {
  const buf = consoleBuffers.get(tabId) || [];
  const limit = (options && typeof options === 'object' && Number(options.limit)) || 50;
  if (!isFinite(limit) || limit < 0) return [];
  const filter = options && typeof options === 'object' ? options.filter : undefined;
  let out = buf.slice();
  if (/^error?s?$/.test(filter)) {
    out = out.filter(e => /error|severe|critical/i.test(e.level));
  } else if (/^warn(ing)?$/.test(filter)) {
    out = out.filter(e => /warn/i.test(e.level));
  }
  // Belt-and-braces: re-run URL redaction on the way out (idempotent) so a
  // future writer that forgets to redact at push time still cannot leak a
  // credential query param into the model-facing result.
  return out.slice(-limit).map(e => ({
    ...e,
    url: typeof e.url === 'string' ? redactUrl(e.url) : e.url
  }));
}

/**
 * Read recent network requests captured for a tab via CDP Network domain.
 * Supports filtering by status code class and URL substring.
 * Returns results most-recent-first, limited to `options.limit`.
 *
 * @param {number} tabId - The tab to read network requests from.
 * @param {object} [options] - Filter options.
 * @param {number} [options.limit=30] - Maximum entries to return.
 * @param {'failed'|'4xx'|'5xx'} [options.filter] - Status-code filter.
 * @param {string} [options.url_includes] - Only include URLs containing this substring.
 * @returns {Array<{method:string,url:string,status:number,type:string,duration_ms:number,failed:boolean,error:string,request_headers:object,response_headers:object}>}
 *   All credential-bearing values are redacted to `[REDACTED]`; header names and
 *   non-sensitive headers are preserved.
 */
export function readNetworkRequests(tabId, options) {
  const buf = networkBuffers.get(tabId);
  if (!buf) return [];
  const limit = (options && typeof options === 'object' && Number(options.limit)) || 30;
  if (!isFinite(limit) || limit < 0) return [];
  const filter = options && typeof options === 'object' ? options.filter : undefined;
  const urlIncludes = options && typeof options === 'object' ? options.url_includes : undefined;
  let arr = [...buf.values()];
  if (filter === 'failed') {
    arr = arr.filter(e => e.failed || (e.status >= 400));
  } else if (filter === '4xx') {
    arr = arr.filter(e => e.status >= 400 && e.status < 500);
  } else if (filter === '5xx') {
    arr = arr.filter(e => e.status >= 500);
  }
  if (typeof urlIncludes === 'string') {
    const needle = urlIncludes.toLowerCase();
    arr = arr.filter(e => (e.url || '').toLowerCase().includes(needle));
  }
  // Most-recent first
  arr.sort((a, b) => b.startTs - a.startTs);
  return arr.slice(0, limit).map(e => ({
    method: e.method,
    // Redact again on the way out (idempotent) — the buffer is already redacted,
    // but this guarantees nothing un-redacted can reach the model if a future
    // writer bypasses recordNetworkStart.
    url: redactUrl(e.url || '').substring(0, 300),
    status: e.status,
    type: e.type,
    duration_ms: e.duration,
    failed: e.failed,
    error: e.errorText || '',
    // Header NAMES and non-sensitive header values are preserved for debugging;
    // cookie values, Authorization, API keys, Set-Cookie, ... are `[REDACTED]`.
    request_headers: redactHeaders(e.requestHeaders) || {},
    response_headers: redactHeaders(e.responseHeaders) || {}
  }));
}

/**
 * Clear all observability buffers (console and network) for a tab.
 * Also removes the tab from the installed-listeners set.
 *
 * @param {number} tabId - The tab to clear buffers for.
 */
export function clearObservabilityBuffers(tabId) {
  consoleBuffers.delete(tabId);
  networkBuffers.delete(tabId);
  observabilityListenersInstalled.delete(tabId);
}


/**
 * Install a one-time chrome.debugger.onDetach listener.
 * On detach, cleans up the tab's attached state, observability buffers,
 * and records that the user manually detached so a re-attach warning can be shown.
 */
function installDetachListenerOnce() {
  if (onDetachListenerInstalled) return;
  onDetachListenerInstalled = true;
  try {
    chrome.debugger.onDetach.addListener((source /*, reason */) => {
      // If the user manually detaches via the debugger banner, drop our tracking
      // and remember this tab so we can warn the user on next re-attach.
      if (source && typeof source.tabId === 'number') {
        attachedDebuggees.delete(source.tabId);
        clearObservabilityBuffers(source.tabId);
        userDetachedTabs.add(source.tabId);
      }
    });
  } catch (_e) { /* in non-extension contexts (tests) chrome.debugger may be absent */ }
}

/**
 * Detach chrome.debugger from all tabs we've attached to.
 * Call from agent-engine cleanup paths (loop end, stop, error).
 */
export async function detachAllDebuggees() {
  const ids = [...attachedDebuggees];
  attachedDebuggees.clear();
  for (const tabId of ids) {
    try { await chrome.debugger.detach({ tabId }); } catch (_e) { /* may already be gone */ }
  }
}

// ========== CDP Trusted Input Dispatch (#9) ==========
// Opt-in trusted-input path. When the user enables `useTrustedInput`, the
// agent engine routes click/type/press_key through chrome.debugger so events
// are dispatched with `isTrusted: true`. Sites with strict event verification
// (reCAPTCHA, paywalls, OAuth, banks) accept these where synthetic content
// script events get rejected.
//
// Reuses the `attachedDebuggees` set above so we don't double-attach. We
// never detach here -- detachAllDebuggees() handles cleanup at agent end.

/**
 * Ensure the Chrome DevTools Protocol debugger is attached to a tab.
 * If already attached, just re-enables observability listeners. On first attach,
 * sets up the detach listener, observability event hook, and CDP domains.
 * Sends a warning message to the UI if re-attaching after a user-initiated detach.
 *
 * @param {number} tabId - Chrome tab ID to attach the debugger to.
 * @returns {Promise<void>}
 */
async function ensureDebuggerAttached(tabId) {
  installDetachListenerOnce();
  installObservabilityEventHook();
  if (attachedDebuggees.has(tabId)) {
    await ensureObservabilityListeners(tabId);
    return;
  }
  const wasUserDetached = userDetachedTabs.has(tabId);
  await chrome.debugger.attach({ tabId }, '1.3');
  attachedDebuggees.add(tabId);
  await ensureObservabilityListeners(tabId);
  // Warn the user that the debugger re-attached after they dismissed the banner,
  // so they're aware trusted input is active again.
  if (wasUserDetached) {
    userDetachedTabs.delete(tabId);
    try {
      chrome.runtime.sendMessage({
        action: 'cdp_reattach_warning',
        tabId,
        message: 'Debugger re-attached after banner was dismissed. Trusted input is active. Dismiss this banner again to fall back to synthetic events.'
      }).catch((e) => {
        console.error('[Sentinel/tab-manager] Unhandled rejection in wasUserDetached:', getErrorMessage(e));
      });
    } catch (_e) { console.warn('[Sentinel/tab-manager] CDP reattach warning broadcast failed:', getErrorMessage(_e)); }
  }
}

/**
 * Dispatch a trusted mouse click at (x, y) in CSS pixels via CDP.
 * Sends Input.dispatchMouseEvent type='mousePressed' then 'mouseReleased'
 * with a small delay between to mimic a real click.
 *
 * @param {number} tabId
 * @param {number} x - CSS pixels (NOT image pixels). Caller must already
 *                     have divided screenshot coordinates by dpr.
 * @param {number} y - CSS pixels.
 * @param {object} [options]
 * @param {string} [options.button='left']  - 'left' | 'right' | 'middle'
 * @param {number} [options.clickCount=1]
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function cdpDispatchClick(tabId, x, y, options = {}) {
  const button = options.button || 'left';
  const clickCount = options.clickCount || 1;
  try {
    await ensureDebuggerAttached(tabId);

    // (G1) Pre-click visual feedback. Notify the content script so it can
    // animate the virtual cursor to (x, y), highlight the element under the
    // pointer, and show the click pulse — visuals the synthetic-events path
    // gets for free, but the CDP path used to skip entirely.
    if (!options.skipVisual) {
      try {
        await chrome.tabs.sendMessage(tabId, {
          action: 'cdp_pre_click_visual',
          x: Number(x) || 0,
          y: Number(y) || 0,
          description: (typeof options.description === 'string' ? options.description : `Clicking at (${Math.round(Number(x) || 0)}, ${Math.round(Number(y) || 0)})`)
        });
      } catch (_e) { /* content script may not be ready on first frame */ }
      // Brief pause so the user sees the cursor arrive + element light up
      // before the click actually fires.
      await sleep(220);
    }

    const base = { x: Number(x) || 0, y: Number(y) || 0, button, clickCount };
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' });
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
    await sleep(50);
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: getErrorMessage(err) };
  }
}

/**
 * Drag from (x1,y1) to (x2,y2) in CSS pixels via CDP Input.dispatchMouseEvent:
 * move → press → interpolated moves (HTML5 drag + slider friendly) → release.
 * Uses mouseMoved events so Draggables that track hover state engage before press.
 * @param {number} tabId - Chrome tab ID.
 * @param {number} x1 - Start X (CSS px).
 * @param {number} y1 - Start Y (CSS px).
 * @param {number} x2 - End X (CSS px).
 * @param {number} y2 - End Y (CSS px).
 * @param {Object} [options] - { description?: string, steps?: number }
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function cdpDispatchDrag(tabId, x1, y1, x2, y2, options = {}) {
  try {
    await ensureDebuggerAttached(tabId);
    const sx = Math.round(Number(x1) || 0), sy = Math.round(Number(y1) || 0);
    const ex = Math.round(Number(x2) || 0), ey = Math.round(Number(y2) || 0);
    const steps = Math.max(2, Math.min(24, Number(options.steps) || 10));
    if (!options.skipVisual) {
      try {
        await chrome.tabs.sendMessage(tabId, {
          action: 'cdp_pre_click_visual',
          x: sx, y: sy,
          description: (typeof options.description === 'string' ? options.description : `Dragging (${sx}, ${sy}) → (${ex}, ${ey})`)
        });
      } catch (_e) { /* content script may not be ready */ }
      await sleep(220);
    }
    const base = { x: sx, y: sy, button: 'left', clickCount: 1 };
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' });
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
    await sleep(60);
    for (let i = 1; i <= steps; i++) {
      const ix = Math.round(sx + ((ex - sx) * i) / steps);
      const iy = Math.round(sy + ((ey - sy) * i) / steps);
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { ...base, x: ix, y: iy, type: 'mouseMoved', buttons: 1 });
      await sleep(25);
    }
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { x: ex, y: ey, button: 'left', clickCount: 1, type: 'mouseReleased', buttons: 0 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: getErrorMessage(err) };
  }
}

// Map a key name to CDP key params. Returns null when unknown so caller
// can fall through to insertText / synthetic dispatch.
/**
 * Map a key name to CDP Input.dispatchKeyEvent parameters.
 * Handles special keys (Enter, Tab, arrows, etc.) and single printable characters.
 * Returns null for unrecognized multi-character strings so the caller can fall back.
 *
 * @param {string} key - Key name (e.g. 'Enter', 'Tab', 'ArrowDown', 'a').
 * @returns {{ key: string, code: string, windowsVirtualKeyCode: number, text?: string } | null}
 */
function cdpKeyParamsFor(key) {
  if (!key) return null;
  const k = String(key);
  const SPECIAL = {
    'Enter':      { key: 'Enter',      code: 'Enter',      windowsVirtualKeyCode: 13, text: '\r' },
    'Return':     { key: 'Enter',      code: 'Enter',      windowsVirtualKeyCode: 13, text: '\r' },
    'Tab':        { key: 'Tab',        code: 'Tab',        windowsVirtualKeyCode:  9 },
    'Escape':     { key: 'Escape',     code: 'Escape',     windowsVirtualKeyCode: 27 },
    'Esc':        { key: 'Escape',     code: 'Escape',     windowsVirtualKeyCode: 27 },
    'Backspace':  { key: 'Backspace',  code: 'Backspace',  windowsVirtualKeyCode:  8 },
    'Delete':     { key: 'Delete',     code: 'Delete',     windowsVirtualKeyCode: 46 },
    'Del':        { key: 'Delete',     code: 'Delete',     windowsVirtualKeyCode: 46 },
    'ArrowDown':  { key: 'ArrowDown',  code: 'ArrowDown',  windowsVirtualKeyCode: 40 },
    'ArrowUp':    { key: 'ArrowUp',    code: 'ArrowUp',    windowsVirtualKeyCode: 38 },
    'ArrowLeft':  { key: 'ArrowLeft',  code: 'ArrowLeft',  windowsVirtualKeyCode: 37 },
    'ArrowRight': { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
    'Down':       { key: 'ArrowDown',  code: 'ArrowDown',  windowsVirtualKeyCode: 40 },
    'Up':         { key: 'ArrowUp',    code: 'ArrowUp',    windowsVirtualKeyCode: 38 },
    'Left':       { key: 'ArrowLeft',  code: 'ArrowLeft',  windowsVirtualKeyCode: 37 },
    'Right':      { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
    'Home':       { key: 'Home',       code: 'Home',       windowsVirtualKeyCode: 36 },
    'End':        { key: 'End',        code: 'End',        windowsVirtualKeyCode: 35 },
    'PageUp':     { key: 'PageUp',     code: 'PageUp',     windowsVirtualKeyCode: 33 },
    'PageDown':   { key: 'PageDown',   code: 'PageDown',   windowsVirtualKeyCode: 34 },
    ' ':          { key: ' ',          code: 'Space',      windowsVirtualKeyCode: 32, text: ' ' },
    'Space':      { key: ' ',          code: 'Space',      windowsVirtualKeyCode: 32, text: ' ' },
  };
  if (SPECIAL[k]) return SPECIAL[k];
  // Single printable char fallback
  if (k.length === 1) {
    const code = k.charCodeAt(0);
    return { key: k, code: `Key${k.toUpperCase()}`, windowsVirtualKeyCode: code, text: k };
  }
  return null;
}

/**
 * Dispatch a trusted key press via CDP. Sends keyDown then keyUp.
 *
 * @param {number} tabId
 * @param {string} key - 'Enter' | 'Tab' | 'Escape' | 'ArrowDown' | etc.
 * @param {object} [options] - reserved for future modifiers support.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
/**
 * (SO-90) Dispatch a trusted mouse-wheel event at x,y via CDP
 * Input.dispatchMouseEvent type:'mouseWheel'. Reaches scrollable containers,
 * virtualized lists, maps and canvases that window.scrollBy cannot.
 * @param {number} tabId - Chrome tab ID.
 * @param {number} x - CSS pixels.
 * @param {number} y - CSS pixels.
 * @param {number} deltaX - Horizontal wheel delta (positive scrolls right).
 * @param {number} deltaY - Vertical wheel delta (positive scrolls down).
 * @param {Object} [options] - { description?: string, skipVisual?: boolean }
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function cdpDispatchWheel(tabId, x, y, deltaX, deltaY, options = {}) {
  try {
    await ensureDebuggerAttached(tabId);
    const wx = Math.round(Number(x) || 0), wy = Math.round(Number(y) || 0);
    if (!options.skipVisual) {
      try {
        await chrome.tabs.sendMessage(tabId, {
          action: 'cdp_pre_click_visual',
          x: wx, y: wy,
          description: (typeof options.description === 'string' ? options.description : `Scrolling at (${wx}, ${wy})`)
        });
      } catch (_e) { /* content script may not be ready on first frame */ }
      await sleep(120);
    }
    // (SO-90c) chrome.debugger.sendCommand can wedge indefinitely on mouseWheel in
    // some Chromium builds (raw CDP resolves in ~10ms; the extension bridge does not).
    // Race it with a hard ceiling; on timeout fall back to an element-targeted JS scroll.
    const WHEEL_TIMEOUT_MS = 3000;
    const dispatched = await Promise.race([
      chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: wx, y: wy, deltaX: Number(deltaX) || 0, deltaY: Number(deltaY) || 0
      }).then(() => true),
      sleep(WHEEL_TIMEOUT_MS).then(() => false)
    ]);
    if (dispatched) return { ok: true };
    // Fallback: scroll the element actually under (wx, wy) via content script.
    try {
      const res = await chrome.tabs.sendMessage(tabId, {
        action: 'so_scroll_element_at', x: wx, y: wy,
        deltaX: Number(deltaX) || 0, deltaY: Number(deltaY) || 0
      });
      if (res && res.ok) return { ok: true, fallback: 'element-scroll' };
      return { ok: false, error: 'wheel dispatch timed out and element scroll failed: ' + ((res && res.error) || 'no response') };
    } catch (e) {
      return { ok: false, error: 'wheel dispatch timed out; element scroll unavailable: ' + getErrorMessage(e) };
    }
  } catch (err) {
    return { ok: false, error: getErrorMessage(err) };
  }
}

/**
 * (SO-90) Capture a magnified screenshot of a viewport region via CDP
 * Page.captureScreenshot with clip+scale. Returns a takeScreenshot-shaped
 * result so the agent loop's capture block can consume it directly
 * (base64Image + width/height/dpr/scroll offsets).
 * @param {number} tabId - Chrome tab ID.
 * @param {number} cx - Region center X (CSS px).
 * @param {number} cy - Region center Y (CSS px).
 * @param {number} width - Region width (CSS px, clamped 80-800).
 * @param {number} height - Region height (CSS px, clamped 60-600).
 * @param {number} zoom - Scale factor (clamped 1-4).
 * @returns {Promise<{ok: boolean, base64Image?: string, width?: number, height?: number, dpr?: number, scrollX?: number, scrollY?: number, zoomed?: boolean, error?: string}>}
 */
export async function cdpDispatchZoom(tabId, cx, cy, width, height, zoom) {
  const tid = (typeof tabId === 'object' && tabId !== null) ? tabId.id : tabId;
  const w = Math.min(800, Math.max(80, Math.round(Number(width) || 400)));
  const h = Math.min(600, Math.max(60, Math.round(Number(height) || 300)));
  const s = Math.min(4, Math.max(1, Number(zoom) || 2));
  const clip = {
    x: Math.max(0, Math.round(Number(cx) || 0) - Math.floor(w / 2)),
    y: Math.max(0, Math.round(Number(cy) || 0) - Math.floor(h / 2)),
    width: w, height: h, scale: s
  };
  try {
    await ensureDebuggerAttached(tid);
    const shot = await chrome.debugger.sendCommand({ tabId: tid }, 'Page.captureScreenshot', {
      format: 'png', clip, captureBeyondViewport: false
    });
    if (!shot || !shot.data) return { ok: false, error: 'empty zoom capture' };
    return {
      ok: true,
      base64Image: shot.data,
      width: w, height: h,
      dpr: s,
      scrollX: clip.x, scrollY: clip.y,
      zoomed: true
    };
  } catch (err) {
    return { ok: false, error: getErrorMessage(err) };
  }
}

export async function cdpDispatchKey(tabId, key, _options = {}) {
  const params = cdpKeyParamsFor(key);
  if (!params) return { ok: false, error: `Unknown key: ${key}` };
  try {
    await ensureDebuggerAttached(tabId);
    // For keys with `text` (Enter, Space, printable chars) use 'keyDown' so the
    // event has both keyboard and text dispatch. For pure control keys (Tab,
    // Escape, arrows, etc.) use 'rawKeyDown' to avoid generating a text event.
    const downType = params.text ? 'keyDown' : 'rawKeyDown';
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { ...params, type: downType });
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { ...params, type: 'keyUp' });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: getErrorMessage(err) };
  }
}

/**
 * Dispatch trusted text entry via CDP. Uses Input.insertText for the bulk
 * of the text (which dispatches proper trusted input events) and falls back
 * to per-character dispatchKeyEvent for any character insertText rejects.
 *
 * Caller is responsible for focusing the target element first (either via
 * the content script or via a preceding cdpDispatchClick).
 *
 * @param {number} tabId
 * @param {string} text
 * @param {object} [options]
 * @param {boolean} [options.perCharKeyEvents=false] - if true, also dispatch
 *        keyDown/keyUp per character (slower, but triggers more handlers).
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function cdpDispatchType(tabId, text, options = {}) {
  if (typeof text !== 'string' || !text.length) {
    return { ok: true };
  }
  try {
    await ensureDebuggerAttached(tabId);

    // (G2) Default per-char dispatch for short strings so the user can SEE
    // the agent typing — same UX as the synthetic-events path. Long strings
    // (URLs, pasted blocks > 40 chars) use the fast Input.insertText path
    // because watching 200 chars get typed one-at-a-time wastes time.
    const explicitOff = options.perCharKeyEvents === false;
    const usePerChar = !explicitOff && (options.perCharKeyEvents === true || text.length <= 40);

    if (usePerChar) {
      // Pace banner updates: every char for very short strings, every Nth
      // char for medium strings so the popup stream isn't spammy.
      const textLen = text.length;
      const updateInterval = Math.max(1, Math.floor(textLen / 12));
      let consecutiveErrors = 0;
      const MAX_CONSECUTIVE_ERRORS = 3;

      for (let i = 0; i < textLen; i++) {
        const ch = text[i];

        // Stream typing-progress to the content script so showTypingBanner
        // can update with the current position.
        if (i % updateInterval === 0 || i === textLen - 1) {
          try {
            await chrome.tabs.sendMessage(tabId, {
              action: 'cdp_typing_progress',
              text,
              position: i + 1
            });
            consecutiveErrors = 0;
          } catch (e) {
            consecutiveErrors++;
            console.warn('[Sentinel/tab-manager] typing progress update failed:', getErrorMessage(e));
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
              return { ok: false, error: `Content script unreachable after ${MAX_CONSECUTIVE_ERRORS} consecutive failures` };
            }
          }
        }

        try {
          if (/^[\n\r]$/.test(ch)) {
            await cdpDispatchKey(tabId, 'Enter');
          } else {
            const params = cdpKeyParamsFor(ch) || {
              key: ch,
              code: `Key${ch.toUpperCase()}`,
              windowsVirtualKeyCode: ch.charCodeAt(0),
              text: ch
            };
            await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { ...params, type: 'keyDown' });
            await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { ...params, type: 'keyUp' });
          }
          consecutiveErrors = 0;
        } catch (e) {
          consecutiveErrors++;
          console.warn('[Sentinel/tab-manager] character dispatch failed:', getErrorMessage(e));
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            return { ok: false, error: `Debugger command failed after ${MAX_CONSECUTIVE_ERRORS} consecutive failures` };
          }
        }

        // Human-ish typing pace: fast for medium strings, slightly slower
        // with thinking pauses for short strings so it reads naturally.
        let delay;
        if (text.length > 25) {
          delay = 22 + Math.floor(Math.random() * 22);
        } else if (i > 0 && i % 6 === 0) {
          delay = 80 + Math.floor(Math.random() * 80); // thinking pause
        } else {
          delay = 40 + Math.floor(Math.random() * 50);
        }
        await sleep(delay);
      }
      return { ok: true };
    }

    // Fast path: single Input.insertText call. CDP dispatches trusted
    // input/beforeinput events for the inserted text in one shot.
    await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: getErrorMessage(err) };
  }
}

/**
 * Execute arbitrary JS in the page's MAIN world via CDP Runtime.evaluate.
 *
 * This is the canonical bypass for sites with strict Content Security Policies
 * (script-src without 'unsafe-inline' / 'unsafe-eval'). The <script>-tag
 * injection used by content/index.js execute_js gets blocked by such CSPs,
 * silently failing and producing a timeout. CDP Runtime.evaluate has elevated
 * privileges and bypasses page CSP entirely, so the code actually runs.
 *
 * Used by agent-engine.js as the preferred path for execute_js. Falls back
 * to the content-script script-tag injection only if CDP fails (e.g.,
 * chrome:// pages where debugger.attach is denied).
 *
 * @param {number} tabId
 * @param {string} code - JS source. Wrapped in `(async () => { ... })()`
 *                        so `return` and top-level await both work.
 * @param {object} [options]
 * @param {number} [options.timeout=8000] - Hard wall-clock timeout in ms.
 *                                          Clamped to [500, 60000].
 * @param {boolean} [options.approvalMode] - When true, the caller is running
 *   under approval mode and this call is refused unless approvalGranted is set.
 * @param {boolean} [options.approvalGranted] - The operator's explicit approval
 *   for this specific command.
 * @returns {Promise<{ok: boolean, value?: any, error?: string, cspBlocked?: boolean, blocked?: boolean}>}
 */
export async function cdpExecuteJs(tabId, code, options = {}) {
  if (typeof code !== 'string' || !code.length) {
    return { ok: false, error: 'No code provided' };
  }
  // Approval gate (defence-in-depth). CDP Runtime.evaluate runs with full page
  // privileges and bypasses page CSP, so model-authored execute_js must never
  // reach it without the same operator approval the content-script path
  // requires. Callers opt in by passing approvalMode; internal engine helpers
  // (DOM probes, vision scaffolding, scroll) do not, so they are unaffected.
  if (options.approvalMode && !options.approvalGranted) {
    return { ok: false, blocked: true, error: 'BLOCKED: execute_js requires operator approval (CDP path refused while approval mode is on).' };
  }
  const timeout = Math.max(500, Math.min(ONE_MINUTE_MS, Number(options.timeout) || 8000)) || 8000;
  try {
    await ensureDebuggerAttached(tabId);
    const expression = `(async () => { ${code} \n })()`;
    const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout
    });
    if (result && result.exceptionDetails) {
      const ex = result.exceptionDetails;
      const msg = ((ex.exception && typeof ex.exception === 'object') && (ex.exception.description || ex.exception.value)) || ex.text || 'Runtime exception';
      return { ok: false, error: typeof msg === 'string' ? msg.slice(0, 500) : String(msg) };
    }
    const value = result && result.result ? result.result.value : undefined;
    return { ok: true, value };
  } catch (err) {
    const msg = getErrorMessage(err);
    // Detect chrome:// / extension page where debugger.attach is denied.
    return { ok: false, error: msg, cspBlocked: false, attachDenied: /Cannot access|chrome:\/\/|extension/i.test(msg) };
  }
}

/**
 * Take a screenshot of the given tab using CDP, with captureVisibleTab as fallback.
 * On the FIRST screenshot for a tab, attaches the debugger and keeps it attached
 * for the rest of the agent run. Subsequent screenshots reuse the attachment.
 *
 * (#11) DPR-aware: queries the content script for live viewport CSS-pixel
 * dimensions, devicePixelRatio, and scroll offsets, and bundles them with the
 * captured base64 image so downstream consumers can correlate screenshot pixels
 * to CSS coordinates correctly on HiDPI displays.
 *
 * Returns { base64Image, width, height, dpr, scrollX, scrollY, capturedAt, url }
 * or null if screenshot fails. Width/height are in CSS pixels (NOT image pixels).
 *
 * @param {number} tabId
 * @param {number} windowId
 * @param {string} currentUrl - The current URL (for caching)
 * @param {object} screenshotCache - { cachedSnapshot, lastScreenshotUrl } mutable ref;
 *                                   legacy { cachedBase64Image } is also accepted on read
 * @param {object} CONFIG - { screenshotQuality, screenshotCache }
 * @param {number} stepNumber - For status messages
 * @param {function} sendSilentUpdateFn - Reference to sendSilentUpdate
 * @returns {Promise<{ base64Image: string, width: number, height: number, dpr: number, scrollX: number, scrollY: number, capturedAt: number, url: string }|null>}
 */
export async function takeScreenshot(tabId, windowId, currentUrl, screenshotCache, CONFIG, stepNumber, sendSilentUpdateFn) {
  // (#11) Cache hit: prefer the new cachedSnapshot object; fall back to the
  // legacy cachedBase64Image string for backward compatibility on first run
  // after upgrade.
  if (CONFIG.screenshotCache && screenshotCache.lastScreenshotUrl === currentUrl) {
    if (screenshotCache.cachedSnapshot && screenshotCache.cachedSnapshot.base64Image) {
      return { ...screenshotCache.cachedSnapshot, url: currentUrl };
    }
    if (screenshotCache.cachedBase64Image) {
      // Legacy cache shape — wrap in the new object form.
      return {
        base64Image: screenshotCache.cachedBase64Image,
        width: 0, height: 0, dpr: 1, scrollX: 0, scrollY: 0,
        capturedAt: Date.now(),
        url: currentUrl
      };
    }
  }

  installDetachListenerOnce();
  installObservabilityEventHook();

  // (#11) Fetch viewport metadata from the content script before capture.
  // We do this BEFORE the screenshot so width/height/dpr describe the same
  // viewport that's about to be photographed. If the content script isn't
  // available (very early load, error pages), fall back to safe defaults.
  let viewport = { width: 0, height: 0, dpr: 1, scrollX: 0, scrollY: 0 };
  try {
    const vp = await sendMessageWithRetry(tabId, { action: 'get_viewport_info' }, 1);
    if (vp && typeof vp === 'object') {
      viewport = {
        width: Number(vp.width) || 0,
        height: Number(vp.height) || 0,
        dpr: Number(vp.dpr) || 1,
        scrollX: Number(vp.scrollX) || 0,
        scrollY: Number(vp.scrollY) || 0
      };
    }
  } catch (e) { console.warn('[Sentinel/tab-manager] viewport parse failed, keeping defaults:', getErrorMessage(e)); }

  let base64Image = null;
  try {
    if (!attachedDebuggees.has(tabId)) {
      await chrome.debugger.attach({ tabId }, '1.3');
      attachedDebuggees.add(tabId);
    }
    try { await ensureObservabilityListeners(tabId); } catch (e) { console.warn('[Sentinel/tab-manager] ensureObservabilityListeners failed:', getErrorMessage(e)); }
    const screenshotResult = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', { format: 'jpeg', quality: CONFIG.screenshotQuality });
    base64Image = (screenshotResult && typeof screenshotResult.data === 'string') ? screenshotResult.data : null;
  } catch (e) {
    console.warn('[Sentinel] debugger attach failed', e);
    // Attachment or capture failed — drop our tracking, attempt a clean detach,
    // then fall back to captureVisibleTab.
    attachedDebuggees.delete(tabId);
    observabilityListenersInstalled.delete(tabId);
    try { await chrome.debugger.detach({ tabId }); } catch(e) { console.warn('[Sentinel/tab-manager] Debugger detach failed in error path:', getErrorMessage(e)); }
    try {
      const screenshotDataUrl = await new Promise((resolve, reject) => {
        chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: CONFIG.screenshotQuality }, (dataUrl) => {
          if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) {
            const err = typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null && typeof chrome.runtime.lastError.message === 'string' ? chrome.runtime.lastError.message : String(chrome.runtime.lastError);
            reject(new Error(err || 'Screenshot capture failed'));
          } else if (typeof dataUrl !== 'string' || !dataUrl.length) {
            reject(new Error('Screenshot capture returned empty data'));
          } else {
            resolve(dataUrl);
          }
        });
      });
      const _parts = typeof screenshotDataUrl === 'string' && screenshotDataUrl ? screenshotDataUrl.split(',') : [];
      if (!Array.isArray(_parts) || _parts.length < 2 || !_parts[1] || !_parts[1].length) throw new Error('captureVisibleTab returned invalid data URL');
      base64Image = _parts[1];
    } catch {
      if (sendSilentUpdateFn) sendSilentUpdateFn('Screenshot skipped (text-only mode)', stepNumber);
      return null;
    }
  }

  if (base64Image) {
    const snapshot = {
      base64Image,
      width: viewport.width,
      height: viewport.height,
      dpr: viewport.dpr,
      scrollX: viewport.scrollX,
      scrollY: viewport.scrollY,
      capturedAt: Date.now()
    };
    screenshotCache.cachedSnapshot = snapshot;
    screenshotCache.cachedBase64Image = null;
    screenshotCache.lastScreenshotUrl = currentUrl;
    return { ...snapshot, url: currentUrl };
  }
  return null;
}

// ========== Validation ==========
// Precompute valid protocols for O(1) lookup
const VALID_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Check whether a URL string is a valid http or https URL.
 *
 * @param {string} url - The URL to validate.
 * @returns {boolean} True if the URL parses and uses http: or https: protocol.
 */
export function isValidUrl(url) {
  if (!url || typeof url !== 'string') {
    return false;
  }
  try {
    const parsed = new URL(url);
    return VALID_PROTOCOLS.has(parsed.protocol);
  } catch (_e) {
    // Invalid URL format
    return false;
  }
}

// ========== Tab Info ==========
/**
 * Get tab info with lastError handling.
 * @param {number} tabId
 * @returns {Promise<chrome.tabs.Tab|null>}
 */
export async function getTabInfo(tabId) {
  return new Promise(resolve => {
    chrome.tabs.get(tabId, (info) => { resolve((typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) ? null : info); });
  });
}

// ========== Utilities ==========
