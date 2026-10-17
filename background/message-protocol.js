// Sentinel Override v3 — Message Protocol
// Standardized message send/receive wrappers with { ok, data, error } envelope.
// Pure utility module — imports NOTHING from other background modules (no circular dependency risk).
// NOTE: tab-context.js imports sendTabStateUpdate from this module. This is acceptable
// because tab-context.js does not re-export anything from message-protocol.js, and
// message-protocol.js never imports from tab-context.js.

import { TEN_SECONDS_MS } from './constants.js';

/**
 * Promise wrapper around chrome.tabs.sendMessage.
 * Checks chrome.runtime.lastError, rejects on error,
 * rejects if response.ok is false, resolves with response.data.
 *
 * @param {number} tabId
 * @param {object} message
 * @param {number} [timeoutMs=10000]
 * @returns {Promise<any>} response.data on success
 */
export function sendMessage(tabId, message, timeoutMs = TEN_SECONDS_MS) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Message to tab ${tabId} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    chrome.tabs.sendMessage(tabId, message, (response) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) {
        const errorMsg = (typeof chrome.runtime.lastError.message === 'string' ? chrome.runtime.lastError.message : chrome.runtime.lastError) || 'Content script message failed';
        reject(new Error(errorMsg));
        return;
      }
      if (!response) {
        reject(new Error('No response from content script'));
        return;
      }
      if (!response.ok) {
        reject(new Error(response.error || 'Unknown content script error'));
        return;
      }
      resolve(response.data !== undefined ? response.data : response);
    });
  });
}

/**
 * Promise wrapper around chrome.runtime.sendMessage for popup-to-background communication.
 * Checks chrome.runtime.lastError, rejects on error, resolves with response.
 *
 * @param {object} message
 * @param {number} [timeoutMs=10000]
 * @returns {Promise<any>} response on success
 */
export function sendRuntimeMessage(message, timeoutMs = TEN_SECONDS_MS) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Runtime message timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    chrome.runtime.sendMessage(message, (response) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) {
        const errorMsg = (typeof chrome.runtime.lastError.message === 'string' ? chrome.runtime.lastError.message : chrome.runtime.lastError) || 'Runtime message failed';
        reject(new Error(errorMsg));
        return;
      }
      resolve(response);
    });
  });
}

/**
 * Returns a (request, sender, sendResponse) => true function that wraps an async handler.
 * On success: sendResponse({ ok: true, data: result })
 * On failure: sendResponse({ ok: false, error: err.message })
 * Always returns true to keep the message channel open for async responses.
 *
 * @param {function} asyncHandler - async (request, sender) => result
 * @returns {function} (request, sender, sendResponse) => true
 */
export function wrapMessageHandler(asyncHandler) {
  return (request, sender, sendResponse) => {
    asyncHandler(request, sender)
      .then(data => sendResponse({ ok: true, data }))
      .catch(err => {
        // v10.3.1: Log every unhandled message-handler error to SW console
        const msg = (err && typeof err.message === 'string') ? err.message : String(err);
        console.error(`[Sentinel/SW] Message handler error (action=${request && request.action}):`, msg, err);
        sendResponse({ ok: false, error: msg });
      });
    return true; // keep message channel open
  };
}

/**
 * Send a silent status update to the popup (step log area or status bar).
 * stepNumber tags the message to a specific step card in the UI.
 * Pass 0 or omit for pre-loop messages (planning, startup).
 *
 * @param {string} text
 * @param {number} [stepNumber=0]
 */
export function sendSilentUpdate(text, stepNumber) {
  chrome.runtime.sendMessage({
    action: 'agent_update',
    text,
    stepNumber: stepNumber || 0,
    silent: true
  }).catch((e) => {
    console.error('[sendSilentUpdate] Unhandled rejection:', e);
  });
}

/**
 * Send the current page context (URL, title, step number) to the popup.
 * Used by the agent engine to keep the popup UI in sync with the active page.
 * @param {string} url - The current page URL.
 * @param {string} pageTitle - The current page title.
 * @param {number} [stepNumber=0] - The current agent step number.
 * @param {number} [tabId=null] - The active tab ID.
 * @param {number} [totalSteps=0] - The dynamic step budget for this run.
 */
export function sendPageContext(url, pageTitle, stepNumber, tabId, totalSteps) {
  chrome.runtime.sendMessage({
    action: 'page_context',
    url: url || '',
    title: pageTitle || '',
    stepNumber: stepNumber || 0,
    tabId: typeof tabId === 'number' ? tabId : null,
    totalSteps: typeof totalSteps === 'number' && totalSteps > 0 ? totalSteps : 0,
  }).catch((e) => {
    console.error('[sendPageContext] Unhandled rejection:', e);
  });
}

// Precompute interactive command types for O(1) lookup
const INTERACTIVE_COMMANDS = new Set(['click', 'type', 'hover', 'select', 'extract']);

// Build a human-readable one-liner describing a command for the popup action card.
function _describeCommand(command, observation) {
  if (INTERACTIVE_COMMANDS.has(command.type) && observation && observation.elements) {
    const el = observation.elements.find(e => e.selector === command.selector);
    if (el && el.text && el.text !== 'No label') {
      const label = el.text.length > 50 ? `${el.text.substring(0, 47)}...` : el.text;
      if (command.type === 'click')    return `Click "${label}"`;
      if (command.type === 'hover')    return `Hover "${label}"`;
      if (command.type === 'select')   return `Select in "${label}"`;
      if (command.type === 'extract')  return `Extract from "${label}"`;
      return `Type into "${label}"`;
    }
    return `${command.type} element`;
  }
  if (command.type === 'navigate' && command.url) {
    try { return `Navigate to ${new URL(command.url).hostname}`; } catch (_urlErr) { return `Navigate to ${command.url}`; }
  }
  if (command.type === 'scroll')              return `Scroll ${(command.amount || 0) >= 0 ? 'down' : 'up'}`;
  if (command.type === 'execute_js') {
    const codePreview = (command.code || '').substring(0, 60).replace(/\n/g, ' ');
    return command.key ? `Run JS → save as "${command.key}": ${codePreview}...` : `Run JS: ${codePreview}...`;
  }
  if (command.type === 'press_key')           return `Press ${command.key || 'Enter'}`;
  if (command.type === 'wait_for_text')       return `Wait for text: "${(command.text || '').substring(0, 40)}"`;
  if (command.type === 'wait_for_element')    return 'Wait for element';
  if (command.type === 'wait_for_navigation') return 'Wait for navigation';
  if (command.type === 'click_at')            return `Click at (${command.x}, ${command.y})`;
  if (command.type === 'scroll_at')           return `Scroll ${command.direction || 'down'} at (${command.x}, ${command.y})`;
  if (command.type === 'zoom_at')             return `Zoom at (${command.x}, ${command.y})`;
  if (command.type === 'triple_click_at')     return `Triple-click at (${command.x}, ${command.y})`;
  if (command.type === 'open_tab')            return `Open tab: ${command.label || command.url}`;
  if (command.type === 'switch_tab')          return `Switch to: ${command.label || command.tab_id}`;
  if (command.type === 'close_tab')           return `Close tab: ${command.label || command.tab_id}`;
  return `${command.type}`;
}

/**
 * Send an action message to the popup (shows an action card).
 *
 * @param {object} command - The command object from the LLM
 * @param {number} stepNumber - Current step number
 * @param {object} [observation] - The page observation (with elements array)
 */
export function sendActionMessage(command, stepNumber, observation) {
  const description = _describeCommand(command, observation);
  // (3.7.1) Enriched payload — include the raw command fields so the popup's
  // describeActionPlain helper (and the active-tab strip) can render a rich,
  // human-readable live status with the actual click target text, typed value,
  // URL, key name, etc. Truncate `text` and `code` so we don't ship huge
  // payloads through the message bus.
  const enrichedText = (typeof command.text === 'string' && command.text.length > 200)
    ? `${command.text.slice(0, 200)}…`
    : command.text;
  const enrichedCode = (typeof command.code === 'string' && command.code.length > 200)
    ? `${command.code.slice(0, 200)}…`
    : command.code;
  // Resolve the visible text of the clicked/hovered element so the popup can
  // show "Clicking 'Save'" rather than "Clicking button.save-btn".
  let resolvedText = '';
  try {
    if (observation && observation.elements && command.selector) {
      const el = observation.elements.find(e => e.selector === command.selector);
      if (el && el.text && el.text !== 'No label') resolvedText = el.text;
    }
  } catch (_e) { /* element lookup is best-effort */ }
  chrome.runtime.sendMessage({
    action: 'agent_action',
    payload: {
      type: command.type,
      description,
      stepNumber,
      // raw command fields for richer popup rendering
      selector: command.selector,
      ref: command.ref,
      url: command.url,
      key: command.key,
      value: command.value,
      label: command.label,
      attribute: command.attribute,
      x: command.x,
      y: command.y,
      amount: command.amount,
      checked: command.checked,
      frame_index: command.frame_index,
      fields: command.fields,
      text: enrichedText,
      code: enrichedCode,
      targetText: resolvedText,
      reasoning: (typeof command.__reasoning === 'string' && command.__reasoning)
        ? command.__reasoning.substring(0, 600) : undefined,
      confidence: (typeof command.__confidence === 'number')
        ? command.__confidence : undefined
    }
  }).catch((e) => {
    console.error('[sendActionMessage] Unhandled rejection:', e);
  });
}

/**
 * Send an action result update to the popup (updates an action card with success/failure).
 *
 * @param {number} stepNumber
 * @param {string} result
 * @param {boolean} isError
 */
export function sendActionResult(stepNumber, result, isError) {
  let resultStr;
  try { resultStr = typeof result === 'string' ? result : JSON.stringify(result); } catch (_e) { resultStr = String(result); }
  chrome.runtime.sendMessage({
    action: 'agent_action_result',
    stepNumber,
    result: resultStr.substring(0, 300),
    isError: !!isError
  }).catch((e) => {
    console.error('[sendActionResult] Unhandled rejection:', e);
  });
}

/**
 * Send a report update to the popup (generating, ready, or error).
 * Fire-and-forget messaging pattern consistent with other send functions.
 *
 * @param {string} status - 'generating' | 'ready' | 'error'
 * @param {object} [report] - The report object (when ready)
 * @param {string} [error] - Error message (when status is 'error')
 */
export function sendReportUpdate(status, report, error) {
  const message = { action: 'report_update', status };
  if (report) message.report = report;
  if (error) message.error = error;
  chrome.runtime.sendMessage(message).catch((e) => {
    console.error('[message] Unhandled rejection:', e);
  });
}

/**
 * Send a tab state update to the popup (renders the tab bar).
 *
 * @param {Array<object>} tabs - Array of TabContext-shaped objects
 */
export function sendTabStateUpdate(tabs) {
  chrome.runtime.sendMessage({
    action: 'tab_state_update',
    tabs: (tabs || []).map(t => ({
      tabId: t.tabId,
      label: t.label,
      url: t.url,
      title: t.title || '',
      isActive: !!t.isActive
    }))
  }).catch((e) => {
    console.error('[sendTabStateUpdate] Unhandled rejection:', e);
  });
}

/**
 * (3.16.0) Broadcast a granular per-step activity item. Each step emits a
 * stream of micro-actions (observe, screenshot, consult-ai, dispatch,
 * wait-load, sleep, result) so the popup can render a Claude-in-Chrome-style
 * checklist with spinner / checkmark / failed states.
 *
 * @param {number} stepNumber - Current step number (groups items into a step's card)
 * @param {string} key - Stable identifier within the step (e.g. 'observe', 'consult-ai', 'dispatch'). Upserted by key.
 * @param {string} label - Human-readable label ("Observing page", "Consulting AI · 5s")
 * @param {string} status - 'in_progress' | 'done' | 'failed' | 'pending'
 * @param {object} [detail] - Optional context: { durationMs, evidence, ... }
 */
export function sendAgentActivity(stepNumber, key, label, status, detail) {
  chrome.runtime.sendMessage({
    action: 'agent_activity',
    stepNumber: stepNumber || 0,
    key: key || 'misc',
    label: label || '',
    status: status || 'in_progress',
    detail: detail || null,
    timestamp: Date.now()
  }).catch((e) => {
    console.error('[sendAgentActivity] Unhandled rejection:', e);
  });
}

/**
 * (3.16.0) Signal that a new agent step is starting. Popup creates the
 * step's card + empty activity stream container so subsequent
 * sendAgentActivity calls land in the right place.
 *
 * @param {number} stepNumber
 * @param {number} [totalPlannedSteps]
 */
export function sendAgentStepStart(stepNumber, totalPlannedSteps) {
  chrome.runtime.sendMessage({
    action: 'agent_step_start',
    stepNumber: stepNumber || 0,
    totalPlannedSteps: totalPlannedSteps || 0,
    timestamp: Date.now()
  }).catch((e) => {
    console.error('[sendAgentStepStart] Unhandled rejection:', e);
  });
}

/**
 * (3.7.1) Forward the latest captured screenshot to the popup so the live
 * mini-shot panel can render the agent's-eye view. Fire-and-forget.
 *
 * @param {string} base64Image - JPEG base64 (without the data: prefix)
 * @param {number} stepNumber
 */
export function sendScreenshotUpdate(base64Image, stepNumber, viewportMeta) {
  if (!base64Image) return;
  chrome.runtime.sendMessage({
    action: 'screenshot_update',
    base64Image,
    stepNumber: stepNumber || 0,
    viewportW: viewportMeta && viewportMeta.width,
    viewportH: viewportMeta && viewportMeta.height
  }).catch((e) => {
    console.error('[sendScreenshotUpdate] Unhandled rejection:', e);
  });
}

/**
 * (6.0) Broadcast the agent's current lifecycle state to the popup live ticker.
 * States: 'observing' | 'thinking' | 'planning' | 'executing' | 'verifying' | 'waiting' | 'idle'
 *
 * @param {string} state - Machine state name
 * @param {string} [text] - Human-readable description shown in the ticker
 */
export function sendAgentStatus(state, text) {
  const now = new Date();
  const ts = now.toTimeString().slice(0, 8);
  chrome.runtime.sendMessage({
    action: 'agent_status',
    state: state || 'idle',
    text: text || '',
    timestamp: ts
  }).catch(() => {});
}

/**
 * (6.0) Send API response time to popup for the health heartbeat indicator.
 *
 * @param {number} durationMs - LLM call duration in milliseconds
 */
export function sendHeartbeat(durationMs) {
  chrome.runtime.sendMessage({
    action: 'heartbeat_update',
    durationMs: durationMs || 0,
    timestamp: Date.now()
  }).catch(() => {});
}

/**
 * (8.1) Broadcast the generated plan to the popup for preview before execution.
 *
 * @param {Array<string>} steps - Array of plan step strings
 * @param {number} [estimatedSteps] - Total estimated step count
 */
/**
 * (9.1) Broadcast the client knowledge facts being injected so the popup can
 * show "Using 5 facts for MSP Client: ..." before the run starts.
 *
 * @param {string} clientName - Display name of the active client
 * @param {Array<{id:string,wisdom:string,scope:string}>} entries - Relevant entries
 */
/**
 * (9.2) Broadcast running cost estimate to the popup.
 *
 * @param {number} estimatedCostUsd - Total estimated run cost in USD
 * @param {number} inputTokens - Total input tokens so far
 * @param {number} outputTokens - Total output tokens so far
 * @param {number} callCount - Number of LLM calls so far
 */
export function sendCostUpdate(estimatedCostUsd, inputTokens, outputTokens, callCount) {
  chrome.runtime.sendMessage({
    action: 'cost_update',
    estimatedCostUsd: estimatedCostUsd || 0,
    inputTokens: inputTokens || 0,
    outputTokens: outputTokens || 0,
    callCount: callCount || 0,
    timestamp: Date.now()
  }).catch(() => {});
}

export function sendClientKnowledgePreview(clientName, entries) {
  if (!entries || !Array.isArray(entries) || !entries.length) return;
  chrome.runtime.sendMessage({
    action: 'client_knowledge_preview',
    clientName: clientName || 'Unknown Client',
    count: entries.length,
    facts: entries.map(e => ({ id: e.id, wisdom: e.wisdom, scope: e.scope })),
    timestamp: Date.now()
  }).catch(() => {});
}

export function sendPlanPreview(steps, estimatedSteps) {
  if (!steps || !steps.length) return;
  chrome.runtime.sendMessage({
    action: 'plan_preview',
    steps,
    estimatedSteps: estimatedSteps || steps.length,
    timestamp: Date.now()
  }).catch(() => {});
}
