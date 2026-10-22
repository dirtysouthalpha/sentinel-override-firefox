// background/audit-log.js
// Per-run audit trail for MSP compliance — v3.40.0
//
// Stores a circular buffer of the last MAX_ENTRIES_PER_RUN entries per runId
// in chrome.storage.local under the key 'audit_<runId>'. The popup can request
// the log via { action: 'get_audit_log', runId } and download it as CSV.
//
// Each entry: { ts, step, type, target, outcome }
//
// Performance: an in-memory cache eliminates the read-before-write that was
// happening on every appendAuditEntry call. The cache is populated on first
// access and kept in sync; clearAuditLog evicts the cache entry.

import { getErrorMessage } from './error-utils.js';

const MAX_ENTRIES_PER_RUN = 500;
const STORAGE_KEY_PREFIX = 'audit_';

const _cache = new Map(); // runId → log array (single source of truth during a run)

function _storageKey(runId) {
  return STORAGE_KEY_PREFIX + String(runId).replace(/[^a-z0-9_-]/gi, '_');
}

/**
 * Append a single entry to the audit log for the given runId.
 * Fire-and-forget — never throws.
 *
 * @param {string} runId - Identifier for the current agent run.
 * @param {{ts?:number, step?:number, type:string, target:string, outcome:string}} entry
 * @returns {Promise<void>}
 */
export async function appendAuditEntry(runId, entry) {
  if (!runId) return;
  try {
    const key = _storageKey(runId);
    let log = _cache.get(runId);
    if (!log) {
      // Reserve the cache slot synchronously before awaiting, so concurrent
      // callers all push into the same array reference instead of stampeding.
      log = [];
      _cache.set(runId, log);
      const stored = await chrome.storage.local.get(key).catch(() => ({}));
      const persisted = Array.isArray(stored[key]) ? stored[key] : [];
      // Splice persisted entries to front so they precede any concurrent entries
      // already pushed during the await (preserves chronological order).
      if (persisted.length) log.splice(0, 0, ...persisted);
    }
    log.push({
      ts:      entry.ts      || Date.now(),
      step:    entry.step    ?? null,
      type:    String(entry.type    || ''),
      target:  String(entry.target  || '').slice(0, 120),
      outcome: String(entry.outcome || '').slice(0, 200),
    });
    if (log.length > MAX_ENTRIES_PER_RUN) log.splice(0, log.length - MAX_ENTRIES_PER_RUN);
    await chrome.storage.local.set({ [key]: log }).catch((e) => {
      console.error('[audit-log] Error:', getErrorMessage(e));
    });
  } catch (e) { console.warn('[Sentinel/audit-log] appendAuditEntry failed:', getErrorMessage(e)); }
}

/**
 * Retrieve the full audit log for a runId.
 * Returns the in-memory cache when available; falls back to storage.
 *
 * @param {string} runId - Identifier for the agent run to retrieve.
 * @returns {Promise<Array>} Array of entry objects (may be empty).
 */
export async function getAuditLog(runId) {
  if (!runId) return [];
  if (_cache.has(runId)) return _cache.get(runId).slice();
  try {
    const key = _storageKey(runId);
    const stored = await chrome.storage.local.get(key).catch(() => ({}));
    return Array.isArray(stored[key]) ? stored[key] : [];
  } catch (e) {
    /* storage read failed — return empty log rather than crashing */
    console.warn('[Sentinel/audit-log] storage read failed:', getErrorMessage(e));
    return [];
  }
}

/**
 * Convert an audit log array to a CSV string (UTF-8, CRLF line endings).
 *
 * @param {Array} log - Array of audit entry objects from getAuditLog.
 * @returns {string} CSV with header row: timestamp, step, type, target, outcome.
 */
export function auditLogToCsv(log) {
  const header = 'timestamp,step,type,target,outcome';
  const rows = (log || []).map(e => {
    const ts = new Date(e.ts || 0).toISOString();
    return [ts, e.step ?? '', e.type ?? '', e.target ?? '', e.outcome ?? '']
      .map(v => `"${String(v).replace(/"/g, '""')}"`)
      .join(',');
  });
  return [header, ...rows].join('\r\n');
}

/**
 * Delete the audit log for a runId from storage and evict the in-memory cache.
 *
 * @param {string} runId - Identifier for the run to clear.
 * @returns {Promise<void>}
 */
export async function clearAuditLog(runId) {
  if (!runId) return;
  _cache.delete(runId);
  try {
    const key = _storageKey(runId);
    await chrome.storage.local.remove(key).catch((e) => {
      console.error('[audit-log] remove failed:', getErrorMessage(e));
    });
  } catch (e) { console.warn('[Sentinel/audit-log] clearAuditLog failed:', getErrorMessage(e)); }
}

/**
 * Evict the in-memory cache for a runId (e.g. at end of run so the next read
 * comes from storage and reflects any cross-process writes).
 * @param {string} runId
 */
export function evictAuditCache(runId) {
  if (runId) _cache.delete(runId);
}

/** Clear the entire in-memory cache (test isolation only). */
export function _resetAuditCacheForTesting() {
  _cache.clear();
}
