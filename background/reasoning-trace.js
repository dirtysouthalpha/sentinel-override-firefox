// background/reasoning-trace.js
// v6.0 Intelligence System - Reasoning Trace Capture
// Captures detailed reasoning traces for all agent decisions for explainability

import { getErrorMessage } from './error-utils.js';

const MAX_TRACE_ENTRIES = 1000; // Per-run limit
const STORAGE_KEY_PREFIX = 'reasoning_trace_';

// In-memory cache for active run
const _traceCache = new Map(); // runId → trace object
// Pending write timeouts for debouncing storage writes
const _pendingWrites = new Map(); // runId → timerId
const WRITE_DELAY_MS = 500; // Batch writes within this window

// Current active run ID (set by initReasoningTrace)
let _currentRunId = null;

function _storageKey(runId) {
  return STORAGE_KEY_PREFIX + String(runId).replace(/[^a-z0-9_-]/gi, '_');
}

/**
 * Persist a trace to storage (debounced)
 */
async function _persistTrace(runId) {
  const existing = _pendingWrites.get(runId);
  if (existing) clearTimeout(existing);

  // Capture the timerId for closure
  let timerId;
  const callback = async () => {
    // Check if this timer was cancelled by verifying it's still in _pendingWrites
    // This handles Jest fake timers where clearTimeout doesn't prevent execution
    if (_pendingWrites.get(runId) !== timerId) {
      return; // Timer was cancelled or replaced
    }
    _pendingWrites.delete(runId);
    const trace = _traceCache.get(runId);
    if (!trace) return;
    try {
      await chrome.storage.local.set({ [_storageKey(runId)]: trace });
    } catch (e) {
      console.error('[Sentinel] Failed to persist reasoning trace:', getErrorMessage(e));
    }
  };

  timerId = setTimeout(callback, WRITE_DELAY_MS);
  // Allow the Node.js process (and Jest workers) to exit without waiting for pending writes
  if (typeof timerId === 'object' && timerId !== null && typeof timerId.unref === 'function') timerId.unref();
  _pendingWrites.set(runId, timerId);
}

/**
 * Initialize a new reasoning trace for the current run.
 * @param {object|string} metadata - Optional { goal, model, timestamp } OR legacy runId string
 * @param {string} [goal] - Optional goal string (for backward compatibility)
 * @param {string} [model] - Optional model string (for backward compatibility)
 */
export async function initReasoningTrace(metadata = {}, goal = '', model = '') {
  // Handle backward compatibility with initReasoningTrace(runId, goal, model)
  if (typeof metadata === 'string') {
    // First param is runId (ignored, we generate our own), second is goal, third is model
    goal = arguments[1] || '';
    model = arguments[2] || '';
    metadata = {};
  }

  _currentRunId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const trace = {
    runId: _currentRunId,
    startTime: metadata.timestamp || Date.now(),
    goal: metadata.goal || goal,
    model: metadata.model || model,
    entries: []
  };
  _traceCache.set(_currentRunId, trace);
  try {
    await chrome.storage.local.set({ [_storageKey(_currentRunId)]: trace });
  } catch (e) {
    console.error('[Sentinel] Failed to initialize reasoning trace:', getErrorMessage(e));
  }
}

/**
 * Capture a reasoning step in the agent's decision-making process.
 * @param {string} phase - The decision phase (e.g. 'plan_generation', 'action_decision')
 * @param {string} direction - 'input' or 'output'
 * @param {object} data - Additional context data
 */
export async function captureReasoningStep(phase, direction, data = {}) {
  if (!_currentRunId) return;
  const trace = _traceCache.get(_currentRunId);
  if (!trace) {
    console.warn('[Sentinel] No active reasoning trace');
    return;
  }

  trace.entries.push({
    timestamp: Date.now(),
    step: trace.entries.length,
    phase: phase || 'unknown',
    direction: direction || 'unknown',
    data: data || {}
  });

  // Cap entries to prevent unbounded growth
  if (trace.entries.length > MAX_TRACE_ENTRIES) {
    trace.entries = trace.entries.slice(-MAX_TRACE_ENTRIES);
  }

  await _persistTrace(_currentRunId);
}

/**
 * Retrieve the full reasoning trace for a specific run.
 * @param {string} runId - The run identifier
 * @returns {Promise<object|null>}
 */
export async function getReasoningTrace(runId) {
  if (_traceCache.has(runId)) return _traceCache.get(runId);

  try {
    const result = await chrome.storage.local.get([_storageKey(runId)]);
    const trace = result[_storageKey(runId)];
    if (trace) {
      _traceCache.set(runId, trace);
      return trace;
    }
  } catch (e) {
    console.error('[Sentinel] Failed to load reasoning trace:', getErrorMessage(e));
  }
  return null;
}

/**
 * Get a summary of the current run's reasoning trace.
 * @param {string} [runId] - Run ID; defaults to the current run
 * @returns {Promise<{totalSteps: number, goal: string, model: string, phases: object, summary: string}>}
 */
export async function getReasoningSummary(runId) {
  const id = runId || _currentRunId;
  if (!id) return { totalSteps: 0, goal: '', model: '', phases: {}, summary: 'No active reasoning trace.' };

  const trace = _traceCache.get(id) || await getReasoningTrace(id);
  if (!trace) return { totalSteps: 0, goal: '', model: '', phases: {}, summary: 'No reasoning trace found.' };

  const entries = trace.entries || [];
  // Group by phase
  const phases = {};
  for (const entry of entries) {
    if (!phases[entry.phase]) phases[entry.phase] = { inputs: 0, outputs: 0 };
    if (entry.direction === 'input') phases[entry.phase].inputs++;
    else phases[entry.phase].outputs++;
  }

  const summary = [
    `Run: ${trace.runId}`,
    `Goal: ${trace.goal || '(none)'}`,
    `Total steps: ${entries.length}`,
    `Phases: ${Object.keys(phases).join(', ') || 'none'}`
  ].join(' | ');

  return {
    totalSteps: entries.length,
    goal: trace.goal,
    model: trace.model,
    phases,
    summary
  };
}

/**
 * Convert reasoning trace to JSON format for export.
 * @param {string} [runId] - Run ID; defaults to the current run
 * @returns {Promise<string>} JSON string
 */
export async function reasoningTraceToJson(runId) {
  const id = runId || _currentRunId;
  if (!id) return JSON.stringify({ error: 'No active reasoning trace' }, null, 2);
  const trace = _traceCache.get(id) || await getReasoningTrace(id);
  if (!trace) return JSON.stringify({ error: 'No reasoning trace found' }, null, 2);
  return JSON.stringify(trace, null, 2);
}

/**
 * Clear the reasoning trace for the current run (or a specific run).
 * @param {string} [runId] - Run ID; defaults to the current run
 */
export async function clearReasoningTrace(runId) {
  const id = runId || _currentRunId;
  if (!id) return;

  const timerId = _pendingWrites.get(id);
  if (timerId) {
    clearTimeout(timerId);
    _pendingWrites.delete(id); // Delete immediately to mark timer as cancelled
  }

  _traceCache.delete(id);
  if (id === _currentRunId) _currentRunId = null;

  // Don't await the storage removal - do it fire-and-forget style
  chrome.storage.local.remove(_storageKey(id)).catch(e => {
    console.error('[Sentinel] Failed to clear reasoning trace:', getErrorMessage(e));
  });
}

/**
 * Get high-confidence decisions from the current run's trace.
 * @param {number} minConfidence - Minimum confidence threshold (0-1)
 * @returns {Promise<Array>}
 */
export async function getHighConfidenceDecisions(minConfidence = 0.8) {
  if (!_currentRunId) return [];
  const trace = _traceCache.get(_currentRunId);
  if (!trace) return [];
  return trace.entries.filter(e => (e.data?.confidence ?? 1) >= minConfidence);
}

/**
 * Get low-confidence decisions from the current run's trace.
 * @param {number} maxConfidence - Maximum confidence threshold (0-1)
 * @returns {Promise<Array>}
 */
export async function getLowConfidenceDecisions(maxConfidence = 0.5) {
  if (!_currentRunId) return [];
  const trace = _traceCache.get(_currentRunId);
  if (!trace) return [];
  return trace.entries.filter(e => (e.data?.confidence ?? 1) <= maxConfidence);
}

/**
 * Flush any pending writes immediately (for shutdown/cleanup).
 */
export async function flushPendingWrites() {
  const promises = [];
  for (const [runId, timerId] of _pendingWrites) {
    clearTimeout(timerId);
    _pendingWrites.delete(runId);
    const trace = _traceCache.get(runId);
    if (!trace) continue;
    promises.push((async () => {
      try {
        await chrome.storage.local.set({ [_storageKey(runId)]: trace });
      } catch (e) {
        console.error('[Sentinel] Failed to flush reasoning trace:', getErrorMessage(e));
      }
    })());
  }
  await Promise.all(promises);
}

/**
 * Reset all module state (for testing).
 */
export function _resetReasoningTraceCache() {
  for (const timerId of _pendingWrites.values()) clearTimeout(timerId);
  _pendingWrites.clear();
  _traceCache.clear();
  _currentRunId = null;
}
