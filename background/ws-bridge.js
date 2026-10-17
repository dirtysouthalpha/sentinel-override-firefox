// Sentinel Override v20.0.0 — WebSocket Bridge Client
// Connects to SENTINEL PRIME bridge server for external orchestration.
// Receives task/query/cancel commands and routes to the agent engine.

import { getErrorMessage } from './error-utils.js';

// ========== Configuration ==========
const BRIDGE_URL = 'ws://localhost:8001/extension-bridge';
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const HEARTBEAT_INTERVAL_MS = 30000;
const MAX_MESSAGE_SIZE = 1048576;
const VALID_MSG_TYPES = new Set(['auth', 'auth_challenge', 'task', 'query', 'cancel', 'status', 'config']);

let ws = null;
let reconnectDelay = RECONNECT_BASE_MS;
let heartbeatTimer = null;
let isConnecting = false;
let enabled = true;
let authenticated = false;
let challengeNonce = null;

// Auth token loaded from chrome.storage.local — never hardcoded.
// Generated once on install, persisted, and read at connect time.
let authToken = null;

function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function ensureAuthToken() {
  if (authToken) return authToken;
  return new Promise((resolve) => {
    chrome.storage.local.get(['ws_bridge_token'], (result) => {
      if (chrome.runtime.lastError) {

        const token = generateToken();
        authToken = token;
        resolve(token);
        return;
      }
      if (result.ws_bridge_token) {
        authToken = result.ws_bridge_token;
        resolve(authToken);
      } else {
        const token = generateToken();
        chrome.storage.local.set({ ws_bridge_token: token }, () => {
          if (chrome.runtime.lastError) {

          }
          authToken = token;

          resolve(authToken);
        });
      }
    });
  });
}

// ========== Connection Management ==========

export async function startBridge() {
  if (!enabled) return;

  await ensureAuthToken();
  connect();
}

export function stopBridge() {

  enabled = false;
  authenticated = false;
  if (ws) {
    ws.close();
    ws = null;
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function connect() {
  if (isConnecting || (ws && ws.readyState === WebSocket.OPEN)) return;
  isConnecting = true;

  try {
    ws = new WebSocket(BRIDGE_URL);
  } catch (e) {

    isConnecting = false;
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {

    isConnecting = false;
    reconnectDelay = RECONNECT_BASE_MS;
    authenticated = false;

    ws.send(JSON.stringify({
      type: 'auth',
      token: authToken
    }));

    heartbeatTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        sendStatus();
      }
    }, HEARTBEAT_INTERVAL_MS);
  };

  ws.onmessage = async (event) => {
    try {
      if (typeof event.data === 'string' && event.data.length > MAX_MESSAGE_SIZE) {

        return;
      }
      const message = JSON.parse(event.data);
      if (!validateMessage(message)) {

        return;
      }
      await handleMessage(message);
    } catch (e) {
      console.error('[WS-BRIDGE] Error handling message:', e);
    }
  };

  ws.onclose = () => {

    isConnecting = false;
    authenticated = false;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = () => {

  };
}

function validateMessage(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (!VALID_MSG_TYPES.has(msg.type)) return false;
  return true;
}

function scheduleReconnect() {
  if (!enabled) return;
  const jitter = Math.random() * 0.3 * reconnectDelay;
  const delay = reconnectDelay + jitter;

  setTimeout(() => {
    if (enabled) connect();
  }, delay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

// ========== Message Handling ==========

async function handleMessage(message) {
  const msgType = message.type;
  const requestId = message.request_id;

  switch (msgType) {
    case 'auth':
      if (message.success) {
        authenticated = true;

        sendStatus();
      } else {
        console.error('[WS-BRIDGE] Authentication failed:', message.message);
      }
      break;

    case 'auth_challenge':
      challengeNonce = message.nonce;
      const response = await computeChallengeResponse(challengeNonce);
      ws.send(JSON.stringify({ type: 'auth_challenge_response', response }));
      break;

    case 'task':
      if (!authenticated) { sendResponse(requestId, { type: 'error', message: 'Not authenticated' }); return; }
      await handleTask(message.goal, requestId);
      break;

    case 'query':
      if (!authenticated) { sendResponse(requestId, { type: 'error', message: 'Not authenticated' }); return; }
      await handleQuery(message.message, requestId);
      break;

    case 'cancel':
      if (!authenticated) { sendResponse(requestId, { type: 'error', message: 'Not authenticated' }); return; }
      await handleCancel(requestId);
      break;

    case 'config':
      // v20.1 remote-config channel (Claude-in-Chrome-style server-side
      // prompt/behavior updates without an extension update).
      {
        const _cfg = message.config || message.patch || null;
        import('./remote-config.js').then(async (rc) => {
          const _res = await rc.applyRemoteConfig(_cfg, null);
          console.log('[WS-BRIDGE] config patch applied:', _res.ok, (_res.errors || []).join('; '));
          sendResponse(requestId, { type: 'config_result', ok: _res.ok, errors: _res.errors || [], applied: _res.applied || null });
        }).catch((e) => sendResponse(requestId, { type: 'config_result', ok: false, errors: [String(e)] }));
      }
      break;

    default:

  }
}

async function computeChallengeResponse(nonce) {
  const enc = new TextEncoder();
  const data = enc.encode(authToken + ':' + nonce);
  try {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (_e) {
    return btoa(authToken + ':' + nonce);
  }
}

async function handleTask(goal, requestId) {
  if (!goal) {
    sendResponse(requestId, { type: 'error', message: 'No goal provided' });
    return;
  }

  try {
    // Import and call the agent engine's startAgent function
    const { startAgent } = await import('./agent-engine.js');

    // Send progress update
    sendResponse(requestId, {
      type: 'result',
      success: true,
      data: { status: 'started', goal: goal.slice(0, 100) },
      request_id: requestId,
    });

    // Start the agent - this runs asynchronously
    // The agent will send updates via the sidepanel, and we relay them
    const sender = { tab: { id: -1 } };  // Synthetic sender for bridge
    await startAgent(goal, sender);

  } catch (e) {
    console.error('[WS-BRIDGE] Task error:', e);
    sendResponse(requestId, {
      type: 'error',
      message: `Agent error: ${e.message}`,
      request_id: requestId,
    });
  }
}

async function handleQuery(queryText, requestId) {

  try {
    // Get current page content and answer the query
    const { getActiveTabId, getTabContext } = await import('./tab-context.js');
    const tabId = getActiveTabId();
    const ctx = tabId ? getTabContext(tabId) : null;

    const pageUrl = ctx?.url || 'unknown';
    const pageTitle = ctx?.title || 'unknown';

    sendResponse(requestId, {
      type: 'result',
      success: true,
      data: {
        url: pageUrl,
        title: pageTitle,
        query: queryText,
      },
      request_id: requestId,
    });
  } catch (e) {
    sendResponse(requestId, {
      type: 'error',
      message: `Query error: ${e.message}`,
      request_id: requestId,
    });
  }
}

async function handleCancel(requestId) {
  try {
    const { stopAgent } = await import('./agent-engine.js');
    stopAgent();
    sendResponse(requestId, {
      type: 'result',
      success: true,
      data: { status: 'cancelled' },
      request_id: requestId,
    });
  } catch (e) {
    sendResponse(requestId, {
      type: 'error',
      message: `Cancel error: ${e.message}`,
      request_id: requestId,
    });
  }
}

// ========== Send Helpers ==========

function sendResponse(requestId, message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    if (requestId) message.request_id = requestId;
    ws.send(JSON.stringify(message));
  }
}

function sendStatus() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  // Get agent state asynchronously
  import('./agent-engine.js').then(({ agentRunning }) => {
    return import('./tab-context.js').then(({ getActiveTabId, getTabContext }) => {
      const tabId = getActiveTabId();
      const ctx = tabId ? getTabContext(tabId) : null;

      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({
        type: 'status',
        agent_running: agentRunning || false,
        url: ctx?.url || '',
        title: ctx?.title || '',
      }));
    });
  }).catch(() => {});
}

// ========== Test exports ==========
// Pure functions exported for unit testing.
// Tests must set authToken before calling computeChallengeResponse.
export { validateMessage, computeChallengeResponse };
export function setAuthTokenForTest(token) { authToken = token; }
export function _resetBridgeForTest() {
  enabled = true;
  authenticated = false;
  isConnecting = false;
  challengeNonce = null;
  authToken = null;
  reconnectDelay = RECONNECT_BASE_MS;
  ws = null;
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

// ========== Auto-start ==========
// Start the bridge connection when this module loads
