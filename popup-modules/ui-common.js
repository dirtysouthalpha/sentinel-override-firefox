// popup-modules/ui-common.js
// Shared popup utilities: HTML sanitization, URL validation, toasts, markdown config.
// Loaded first (before settings.js and chat.js) so these utilities are available globally.

// Precompile regex patterns for performance in hot-path sanitization
const URL_ATTR_RE = /^(href|src|action|formaction|xlink:href)$/;
const DANGEROUS_PROTO_RE = /^\s*(javascript\s*:|data\s*:|vbscript\s*:)/i;
const DANGEROUS_STYLE_RE = /expression\s*\(|url\s*\(\s*['"]?\s*javascript/i;

// ========== Shared Helpers ==========
// getState is defined in popup-state.js (loaded before this file).

/**
 * Escape a string for safe HTML insertion via textContent→innerHTML round-trip.
 * @param {string} text - Raw text to escape.
 * @returns {string} HTML-safe string with <, >, &, " encoded.
 */
// eslint-disable-next-line no-unused-vars
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

// ========== HTML Sanitization ==========
/**
 * Sanitize an HTML string by removing dangerous elements (script, iframe, etc.)
 * and stripping event-handler attributes and javascript:/data: URLs.
 * @param {string} dirtyHtml - Untrusted HTML string.
 * @returns {string} Sanitized HTML safe for innerHTML insertion.
 */
// eslint-disable-next-line no-unused-vars
function sanitizeHtml(dirtyHtml) {
  if (!dirtyHtml) return '';
  const doc = new DOMParser().parseFromString(dirtyHtml, 'text/html');
  // Remove dangerous elements (includes SVG/MathML foreign content vectors)
  const dangerous = doc.querySelectorAll('script, iframe, object, embed, form, link[rel="import"], base, meta, svg, math');
  dangerous.forEach(el => el.remove());
  // Remove event handler attributes and dangerous URLs from all remaining elements
  doc.querySelectorAll('*').forEach(el => {
    for (const attr of el.attributes) {
      const name = attr.name.toLowerCase();
      const val = attr.value.toLowerCase().trim();
      // Remove on* event handlers
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
        continue;
      }
      // Remove javascript:, data:, vbscript: URLs in href/src/action/formaction/xlink:href
      if (URL_ATTR_RE.test(name)
          && DANGEROUS_PROTO_RE.test(val)) {
        el.removeAttribute(attr.name);
        continue;
      }
      // Remove style attributes that could contain expression() or url(javascript:)
      if (name === 'style' && DANGEROUS_STYLE_RE.test(val)) {
        el.removeAttribute(attr.name);
      }
    }
  });
  return doc.body.innerHTML;
}

// ========== Utility Functions ==========
/**
 * Check whether a string is a valid URL (parsable by the URL constructor).
 * @param {string} url - String to validate.
 * @returns {boolean} True if the URL is syntactically valid.
 */
// eslint-disable-next-line no-unused-vars
function isValidUrl(url) {
  if (!url) return false;
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Show a transient toast notification at the bottom of the popup.
 * Auto-removes after 3 seconds.
 * @param {string} message - Text to display in the toast.
 * @param {'success'|'error'|'info'} [type='success'] - Toast style variant.
 */
// eslint-disable-next-line no-unused-vars
function showToast(message, type = 'success') {
  if (!message || !document.body) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    if (toast.parentNode) {
      toast.remove();
    }
  }, 3000);
}

/**
 * Check if chrome.runtime.lastError has a value.
 * This replaces the repeated pattern:
 *   typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null && chrome.runtime.lastError
 *
 * @returns {boolean} True if chrome.runtime.lastError has a value
 */
function hasLastError() {
  return typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null && chrome.runtime.lastError;
}

function _hasLastError() {
  return typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null && chrome.runtime.lastError;
}

/**
 * Get chrome.runtime.lastError message safely.
 *
 * @returns {string} The lastError message or empty string if no error
 */
function _getLastErrorMessage() {
  if (!_hasLastError()) return '';
  const err = chrome.runtime.lastError;
  if (typeof err === 'object' && err !== null && typeof err.message === 'string') return err.message;
  return String(err || '');
}

// ========== Markdown Configuration ==========
marked.setOptions({
  breaks: true,
  gfm: true,
});