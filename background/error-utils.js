// background/error-utils.js
// Utility functions for safe error handling across the codebase.

/**
 * Safely extract an error message from any value.
 * Handles Error objects, strings, objects with message properties, and primitives.
 * This is used 200+ times across the codebase to avoid:
 *   typeof e === 'object' && e !== null && typeof e.message === 'string' ? e.message : String(e)
 *
 * @param {*} err - The error value to extract a message from
 * @returns {string} A string representation of the error
 */
export function getErrorMessage(err) {
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && err !== null && typeof err.message === 'string') return err.message;
  if (err === null || err === undefined) return '';
  return String(err);
}

/**
 * Sleep for a specified number of milliseconds.
 * Used for adding delays in async operations (e.g., retry logic, polling).
 *
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>} Resolves after the specified delay
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
