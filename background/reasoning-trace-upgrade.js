// background/reasoning-trace-upgrade.js
// ReAct-style reasoning traces for Sentinel Override.
//
// Before every action, emit a structured "Thought" trace that explains WHY
// the action was chosen. This enables:
// - Debugging (see what the agent was thinking)
// - Reflexion (store reflections on failure for future attempts)
// - Approval gates (show the user WHY an action was selected)
// - Self-healing (trace what went wrong)
//
// Based on ReAct (arXiv 2210.03629) and research showing CoT + action
// interleaving improves ALFWorld +34% and WebShop +10%.

// Recent traces, newest last. Both emitReasoningTrace and emitReflection append
// here, and buildTraceSummary reads from here. Without a store the summary has
// no source and both emitters are decorative: they run, log, and are discarded.
const TRACE_BUFFER = [];
const MAX_BUFFERED_TRACES = 50;

/**
 * Append a trace to the bounded buffer.
 * @param {object} trace - Reasoning trace or reflection object
 */
export function recordTrace(trace) {
  if (!trace || typeof trace !== 'object') return;
  TRACE_BUFFER.push(trace);
  if (TRACE_BUFFER.length > MAX_BUFFERED_TRACES) {
    TRACE_BUFFER.splice(0, TRACE_BUFFER.length - MAX_BUFFERED_TRACES);
  }
}

/**
 * Return the most recent traces, oldest first.
 * @param {number} maxTraces - Maximum number to return
 * @returns {Array}
 */
export function recentTraces(maxTraces = 5) {
  if (!Array.isArray(TRACE_BUFFER) || TRACE_BUFFER.length === 0) return [];
  return TRACE_BUFFER.slice(-maxTraces);
}

/**
 * Drop all buffered traces. Called between runs so a re-run does not inherit
 * the previous run's reasoning as if it were its own.
 */
export function clearTraces() {
  TRACE_BUFFER.length = 0;
}

/**
 * Emit a reasoning trace before an action.
 * @param {string} thought - The reasoning behind the action
 * @param {string} actionType - The action being taken
 * @param {object} params - Action parameters
 * @param {number} stepNumber - Current step number
 */
export function emitReasoningTrace(thought, actionType, params, stepNumber) {
  const trace = {
    step: stepNumber,
    timestamp: Date.now(),
    type: 'reasoning_trace',
    thought,
    action: { type: actionType, params: sanitizeParams(params) }
  };

  // Log for debugging
  console.log(`[REACT][Step ${stepNumber}] Thought: ${thought}`);
  console.log(`[REACT][Step ${stepNumber}] Action: ${actionType}`);

  // Send to popup for display
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({
        action: 'agent_reasoning_trace',
        trace
      }).catch(() => {});
    }
  } catch (_e) { /* non-fatal */ }

  recordTrace(trace);
  return trace;
}

/**
 * Emit a reflection after a failure (Reflexion pattern).
 * @param {string} failureDescription - What went wrong
 * @param {string} reflection - Self-critique of what to do differently
 * @param {number} stepNumber - Current step number
 */
export function emitReflection(failureDescription, reflection, stepNumber) {
  const reflectionObj = {
    step: stepNumber,
    timestamp: Date.now(),
    type: 'reflection',
    failure: failureDescription,
    reflection,
    storeInMemory: true
  };

  console.log(`[REFLEXION][Step ${stepNumber}] Failure: ${failureDescription}`);
  console.log(`[REFLEXION][Step ${stepNumber}] Reflection: ${reflection}`);

  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({
        action: 'agent_reflection',
        reflection: reflectionObj
      }).catch(() => {});
    }
  } catch (_e) { /* non-fatal */ }

  recordTrace(reflectionObj);
  return reflectionObj;
}

/**
 * Build a summary of recent reasoning traces for context injection.
 * Used when recovering from failures to remind the agent what it tried.
 * @param {Array} traces - Array of recent trace objects
 * @param {number} maxTraces - Maximum number of traces to include
 * @returns {string} Formatted summary
 */
export function buildTraceSummary(traces, maxTraces = 5) {
  if (!Array.isArray(traces) || traces.length === 0) return '';
  const recent = traces.slice(-maxTraces);
  return recent.map(t => {
    if (t.type === 'reasoning_trace') {
      return `Step ${t.step}: Thought: ${t.thought} -> Action: ${t.action?.type}`;
    }
    if (t.type === 'reflection') {
      return `Step ${t.step}: REFLECTION on "${t.failure}": ${t.reflection}`;
    }
    return '';
  }).filter(Boolean).join('\n');
}

/**
 * Sanitize action params for logging (remove sensitive data).
 */
function sanitizeParams(params) {
  if (!params || typeof params !== 'object') return {};
  const sanitized = {};
  for (const [k, v] of Object.entries(params)) {
    if (/password|secret|token|api_key|credential/i.test(k)) {
      sanitized[k] = '[REDACTED]';
    } else {
      sanitized[k] = v;
    }
  }
  return sanitized;
}
