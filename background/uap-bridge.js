/**
 * UAP Bridge — Service-Worker-Safe HTTP Bridge to External UAP Server
 *
 * Chrome Manifest v3 service workers cannot bind TCP ports or run WebSocket
 * servers. This bridge uses fetch() (which IS available in service workers)
 * to communicate with the external UAP server process (scripts/uap-server.js).
 *
 * Architecture:
 *   ┌──────────────────┐    fetch()    ┌─────────────────────┐
 *   │  Extension SW     │ ──────────▶  │  External UAP Server │
 *   │  (uap-bridge.js)  │  POST/events │  (Node.js :8766)     │
 *   │                   │  GET /tasks  │                      │
 *   └──────────────────┘              └─────────────────────┘
 *
 * Features:
 * - Fire-and-forget event broadcasting (POST /uap/events)
 * - Periodic task polling (GET /uap/tasks) every 5 seconds
 * - Graceful degradation: silent no-op if UAP server is not running
 * - Zero new dependencies: uses built-in fetch() / XMLHttpRequest
 *
 * @version 10.0.0
 * @module background/uap-bridge
 */

// ── Configuration ──
const DEFAULT_SERVER_URL = 'http://localhost:8766';
const POLL_INTERVAL_MS = 5000;
const REQUEST_TIMEOUT_MS = 3000;
const MAX_RETRIES = 1;

let _serverUrl = DEFAULT_SERVER_URL;
let _polling = false;
let _pollTimer = null;
let _lastTaskTimestamp = 0;
let _serverAvailable = false;
let _consecutiveFailures = 0;
let _onGoalCallback = null;
let _runId = null;

/**
 * Initialize the UAP bridge.
 *
 * @param {Object} options
 * @param {string} [options.serverUrl] - UAP server URL (default http://localhost:8766)
 * @param {Function} [options.onGoal] - Callback when external goal is received from polling
 * @returns {Promise<void>}
 */
export async function initBridge(options = {}) {
  _serverUrl = options.serverUrl || DEFAULT_SERVER_URL;
  _onGoalCallback = options.onGoal || null;

  // Check if server is reachable
  await _healthCheck();

  if (_serverAvailable) {
    _startPolling();
    console.log('[UAP Bridge] Connected to', _serverUrl);
  } else {
    console.log('[UAP Bridge] Server not available at', _serverUrl, '— will retry on next broadcast');
  }
}

/**
 * Set the goal callback. Called when the external server has a queued goal.
 * @param {Function} callback - async (goal, context) => {}
 */
export function setGoalCallback(callback) {
  _onGoalCallback = callback;
}

/**
 * Set the current run ID for event correlation.
 * @param {string|null} runId
 */
export function setRunId(runId) {
  _runId = runId;
}

/**
 * Broadcast an event to the external UAP server.
 * Fire-and-forget: never throws, never blocks the caller.
 *
 * @param {string} eventType - Event type (e.g., 'agent.started', 'task.completed', 'agent.error')
 * @param {Object} [data] - Event payload
 */
export function broadcast(eventType, data) {
  // Fire-and-forget: wrap in IIFE with try/catch
  (async () => {
    try {
      await _postWithRetry('/uap/events', {
        type: eventType,
        data: {
          ...data,
          runId: _runId || undefined,
          source: 'sentinel-extension'
        }
      });
      _serverAvailable = true;
      _consecutiveFailures = 0;
    } catch (e) {
      _consecutiveFailures++;
      // After 5 consecutive failures, mark server as unavailable
      if (_consecutiveFailures >= 5) {
        _serverAvailable = false;
        if (_pollTimer) {
          clearInterval(_pollTimer);
          _pollTimer = null;
          _polling = false;
        }
      }
      // Silent: never crash the agent loop because UAP is down
    }
  })();
}

/**
 * Stop the bridge and cleanup resources.
 */
export function stopBridge() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
  _polling = false;
  _serverAvailable = false;
  _consecutiveFailures = 0;
}

/**
 * Check if the UAP server is currently reachable.
 * @returns {boolean}
 */
export function isServerAvailable() {
  return _serverAvailable;
}

/**
 * Get the current server URL.
 * @returns {string}
 */
export function getServerUrl() {
  return _serverUrl;
}

// ── Internal helpers ──

/**
 * Check if the UAP server is healthy.
 * @returns {Promise<boolean>}
 */
async function _healthCheck() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const response = await fetch(`${_serverUrl}/uap/status`, {
      method: 'GET',
      signal: controller.signal
    });
    clearTimeout(timeout);
    _serverAvailable = response.ok;
    return _serverAvailable;
  } catch (e) {
    _serverAvailable = false;
    return false;
  }
}

/**
 * Start polling the external server for pending tasks.
 */
function _startPolling() {
  if (_polling) return;
  _polling = true;
  _pollTimer = setInterval(() => {
    _pollTasks().catch(() => {
      // Silent: polling failures don't crash anything
    });
  }, POLL_INTERVAL_MS);
}

/**
 * Poll the UAP server for pending tasks.
 */
async function _pollTasks() {
  if (!_serverAvailable) {
    // Try health check to see if server came back
    const healthy = await _healthCheck();
    if (healthy) {
      _startPolling();
    }
    return;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const response = await fetch(
      `${_serverUrl}/uap/tasks?since=${_lastTaskTimestamp}`,
      { method: 'GET', signal: controller.signal }
    );
    clearTimeout(timeout);

    if (!response.ok) {
      _serverAvailable = false;
      return;
    }

    const result = await response.json();
    _lastTaskTimestamp = result.timestamp || Date.now();
    _serverAvailable = true;
    _consecutiveFailures = 0;

    // Process any pending tasks
    const tasks = result.tasks || [];
    for (const task of tasks) {
      if (task.type === 'goal_request' && task.status === 'pending' && _onGoalCallback) {
        try {
          await _onGoalCallback(task.goal, task.context);
        } catch (e) {
          console.warn('[UAP Bridge] Goal callback error:', e);
        }
      }
    }
  } catch (e) {
    _consecutiveFailures++;
    if (_consecutiveFailures >= 5) {
      _serverAvailable = false;
    }
  }
}

/**
 * POST data to the UAP server with optional retry.
 * @param {string} path - URL path (e.g., '/uap/events')
 * @param {Object} payload - JSON body
 * @returns {Promise<Object>} Response data
 */
async function _postWithRetry(path, payload) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const response = await fetch(`${_serverUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`UAP server returned ${response.status}`);
      }

      return await response.json();
    } catch (e) {
      lastError = e;
      if (attempt < MAX_RETRIES) {
        // Brief backoff before retry
        await new Promise(r => setTimeout(r, 200));
      }
    }
  }
  throw lastError;
}
