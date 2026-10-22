// background/agent-recovery.js — Agent-level error recovery policy (ERR-04)
import { AgentError, ERROR_CODES, isRetryable, wrapError } from './agent-errors.js';

const MAX_AUTO_RETRIES = 5;
const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30000;
const retryCounts = new Map();
const retryContexts = new Map();

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function backoffDelay(attempt) {
  const exp = Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1));
  return Math.floor(Math.random() * exp);
}

function emitErrorCard(error) {
  try {
    chrome.runtime.sendMessage({ action: 'agent_error', error: error.toJSON() }).catch(() => {});
  } catch (_e) {}
}

function emitRecoveryNotice(message, meta = {}) {
  try {
    chrome.runtime.sendMessage({ action: 'agent_recovery_notice', message, ...meta }).catch(() => {});
  } catch (_e) {}
}

export async function withRecovery(fn, context = {}, operationId = 'default') {
  const key = operationId;
  let attempts = retryCounts.get(key) || 0;
  const retryLog = retryContexts.get(key) || [];
  try {
    const result = await fn();
    retryCounts.delete(key); retryContexts.delete(key);
    return result;
  } catch (rawError) {
    const error = rawError instanceof AgentError ? rawError : wrapError(rawError, ERROR_CODES.UNKNOWN, null, false, context);
    attempts++;
    retryCounts.set(key, attempts);
    retryLog.push({ attempt: attempts, code: error.code, ts: Date.now() });
    retryContexts.set(key, retryLog);
    if (error.retryable && attempts < MAX_AUTO_RETRIES) {
      const delay = backoffDelay(attempts);
      console.warn('[AGENT-RECOVERY] Retry attempt ' + attempts + '/' + MAX_AUTO_RETRIES + ' in ' + delay + 'ms:', error.code);
      emitRecoveryNotice('Retrying (' + attempts + '/' + MAX_AUTO_RETRIES + ')', { attempt: attempts, delayMs: delay });
      await sleep(delay);
      return withRecovery(fn, context, operationId);
    }
    console.error('[AGENT-RECOVERY] Final error:', error.code, error.message);
    const finalError = error.retryable
      ? new AgentError({ code: ERROR_CODES.MAX_RETRIES_EXCEEDED, message: 'Failed after ' + attempts + ' attempts: ' + error.message, suggestion: error.suggestion || 'Try again manually.', retryable: true, context: { ...context, originalCode: error.code, attempts, retryLog } })
      : error;
    emitErrorCard(finalError);
    throw finalError;
  }
}

export async function withTimeout(fn, timeoutMs, context = {}, operationId = 'default_timeout') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new AgentError({ code: ERROR_CODES.LLM_TIMEOUT, message: 'Timed out after ' + timeoutMs + 'ms', retryable: true, context })), timeoutMs);
    fn().then(r => { clearTimeout(timer); resolve(r); }, e => { clearTimeout(timer); reject(e); });
  });
}

export function resetRetries(operationId) { retryCounts.delete(operationId); retryContexts.delete(operationId); }
export function getRetryCount(operationId) { return retryCounts.get(operationId) || 0; }
export function getRetryLog(operationId) { return retryContexts.get(operationId) || []; }
