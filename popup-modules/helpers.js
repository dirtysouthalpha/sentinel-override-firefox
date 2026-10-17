/**
 * popup-modules/helpers.js
 * Shared utility functions for popup modules.
 * Consolidates duplicated helper functions from scheduler-ui.js and templates.js.
 * Loaded via script tag before other popup-modules so these are available globally.
 */

// Time constants for readability
const MS_PER_MINUTE = 60000;
const MS_PER_HOUR = 3600000;
const MS_PER_DAY = 86400000;
const MS_PER_SECOND = 1000;

window.Helpers = {};

/**
 * Safely extract an error message from any value.
 * Matches the implementation in background/error-utils.js for consistency.
 * @param {*} err - The error value to extract a message from
 * @returns {string} A string representation of the error
 */
Helpers.getErrorMessage = function getErrorMessage(err) {
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && err !== null && typeof err.message === 'string') return err.message;
  return String(err || '');
};

// Also expose as global function for backward compatibility
window.getErrorMessage = Helpers.getErrorMessage;

/**
 * Format a future timestamp as a countdown string.
 * @param {number} timestamp - The target timestamp (ms).
 * @returns {string} Human-readable countdown.
 */
Helpers.formatCountdown = function formatCountdown(timestamp) {
  if (!timestamp) return 'Not scheduled';
  const now = Date.now();
  const diff = timestamp - now;

  if (diff <= 0) return 'Overdue';

  const minutes = Math.floor(diff / MS_PER_MINUTE);
  const hours = Math.floor(diff / MS_PER_HOUR);
  const days = Math.floor(diff / MS_PER_DAY);

  if (minutes < 60) return `${minutes}m away`;
  if (hours < 24) return `${hours}h ${minutes % 60}m away`;
  if (days <= 6) return `${days}d ${hours % 24}h away`;

  return new Date(timestamp).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
};

/**
 * Format a past timestamp as a relative time string.
 * @param {number} timestamp - The past timestamp (ms).
 * @returns {string} Human-readable relative time.
 */
Helpers.relativeTime = function relativeTime(timestamp) {
  if (!timestamp) return 'Never';
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / MS_PER_MINUTE);
  const hours = Math.floor(diff / MS_PER_HOUR);
  const days = Math.floor(diff / MS_PER_DAY);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
};

/**
 * Format the duration between two timestamps.
 * @param {number} startedAt - Start timestamp (ms).
 * @param {number} completedAt - End timestamp (ms).
 * @returns {string} Human-readable duration.
 */
Helpers.formatDuration = function formatDuration(startedAt, completedAt) {
  if (!startedAt || !completedAt) return '';
  const diff = completedAt - startedAt;
  const seconds = Math.floor(diff / MS_PER_SECOND);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return `${seconds}s`;
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
};

// Also expose as global functions for backward compatibility with existing call sites
// that use bare names (e.g. relativeTime(...) instead of Helpers.relativeTime(...))
window.formatCountdown = Helpers.formatCountdown;
window.relativeTime = Helpers.relativeTime;
window.formatDuration = Helpers.formatDuration;
