// background/agent-recovery.js
// Agent-level error recovery policy (ERR-04).
// Wraps agent operations with auto-retry and error card emission.

import { AgentError, ERROR_CODES, isRetryable, wrapError } from './agent-errors.js';

const MAX_AUTO_RETRIES = 3;
const RETRY_DELAYS_MS = [2000, 4000, 8000]; // Exponential: 2s, 4s, 8s

// Track retry counts per operation
const retryCounts = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Emit an error card to the popup chat.
 * @param {AgentError} error
 */
function emitErrorCard(error) {
  try {
    chrome.runtime.sendMessage({
      action: 'agent_error',
      error: error.toJSON()
    }).catch(() => { /* popup may not be open */ });
  } catch (_e) { /* non-fatal */ }
}

/**
 * Execute an async operation with auto-retry policy.
 * - Retryable errors: auto-retry up to MAX_AUTO_RETRIES times
 * - After max retries: emit error card and throw
 * - Non-retryable errors: emit error card immediately and throw
 *
 * @param {Function} fn - async function to execute
 * @param {object} context - metadata to attach to errors (goal, stepNumber, etc.)
 * @param {string} operationId - unique key for retry tracking
 * @returns {Promise<*>} result of fn()
 */
export async function withRecovery(fn, context = {}, operationId = 'default') {
  const key = operationId;
  let attempts = retryCounts.get(key) || 0;

  try {
    const result = await fn();
    retryCounts.delete(key);
    return result;
  } catch (rawError) {
    const error = rawError instanceof AgentError
      ? rawError
      : wrapError(rawError, ERROR_CODES.UNKNOWN, null, false, context);

    attempts++;
    retryCounts.set(key, attempts);

    if (error.retryable && attempts < MAX_AUTO_RETRIES) {
      const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];

      await sleep(delay);
      return withRecovery(fn, context, operationId);
    }

    // Max retries exceeded or non-retryable — emit error card
    console.error('[AGENT-RECOVERY] ' + (error.retryable ? 'Max retries exceeded' : 'Non-retryable error') + ':', error.code, error.message);
    const finalError = error.retryable
      ? new AgentError({
          code: ERROR_CODES.MAX_RETRIES_EXCEEDED,
          message: 'Failed after ' + attempts + ' attempts: ' + error.message,
          suggestion: error.suggestion || 'Try again manually or adjust your goal.',
          retryable: true,
          context: { ...context, originalCode: error.code, attempts }
        })
      : error;

    emitErrorCard(finalError);
    throw finalError;
  }
}

/**
 * Reset retry count for an operation (e.g., after a successful step).
 */
export function resetRetries(operationId) {
  retryCounts.delete(operationId);
}

/**
 * Get current retry count for an operation.
 */
export function getRetryCount(operationId) {
  return retryCounts.get(operationId) || 0;
}

