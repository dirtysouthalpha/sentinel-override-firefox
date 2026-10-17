// background/agent-errors.js
// Structured error objects for the Sentinel agent engine (ERR-01).

export const ERROR_CODES = Object.freeze({
  TAB_CLOSED: 'TAB_CLOSED',
  TAB_NOT_FOUND: 'TAB_NOT_FOUND',
  LLM_TIMEOUT: 'LLM_TIMEOUT',
  LLM_ERROR: 'LLM_ERROR',
  LLM_RATE_LIMITED: 'LLM_RATE_LIMITED',
  SELECTOR_MISS: 'SELECTOR_MISS',
  EXECUTE_JS_FAILED: 'EXECUTE_JS_FAILED',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  CAPTCHA_DETECTED: 'CAPTCHA_DETECTED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  STORAGE_ERROR: 'STORAGE_ERROR',
  PLUGIN_ERROR: 'PLUGIN_ERROR',
  MAX_RETRIES_EXCEEDED: 'MAX_RETRIES_EXCEEDED',
  USER_ABORTED: 'USER_ABORTED',
  UNKNOWN: 'UNKNOWN'
});

export class AgentError extends Error {
  constructor({ code, message, suggestion, retryable, context }) {
    super(message);
    this.name = 'AgentError';
    this.code = code || ERROR_CODES.UNKNOWN;
    this.suggestion = suggestion || null;
    this.retryable = retryable ?? false;
    this.context = context || {};
    this.timestamp = Date.now();
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      suggestion: this.suggestion,
      retryable: this.retryable,
      context: this.context,
      timestamp: this.timestamp
    };
  }
}

export function isAgentError(error) {
  return error instanceof AgentError;
}

export function isRetryable(error) {
  if (isAgentError(error)) return error.retryable;
  return false;
}

export function wrapError(error, code, suggestion, retryable, context) {
  if (isAgentError(error)) return error;
  return new AgentError({
    code: code || ERROR_CODES.UNKNOWN,
    message: error?.message || String(error),
    suggestion: suggestion || null,
    retryable: retryable ?? false,
    context: context || {}
  });
}

export function fromApiResponse(json) {
  if (!json || typeof json !== 'object') {
    return new AgentError({
      code: ERROR_CODES.UNKNOWN,
      message: 'Invalid error payload',
      retryable: false
    });
  }
  return new AgentError({
    code: json.code || ERROR_CODES.UNKNOWN,
    message: json.message || 'Unknown error',
    suggestion: json.suggestion || null,
    retryable: json.retryable ?? false,
    context: json.context || {}
  });
}

