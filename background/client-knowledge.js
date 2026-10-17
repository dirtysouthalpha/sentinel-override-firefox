// Sentinel Override v3 -- Client Knowledge (3.12.0)
//
// Per-client persistent knowledge that compounds across runs. Solves:
// "every run starts cold and forgets what it learned about Acme last time".
//
// Schema (chrome.storage.local key: sentinelClientKnowledge):
// {
//   activeClientId: "acme-corp" | null,
//   clients: {
//     "acme-corp": {
//       id: "acme-corp",
//       displayName: "Acme Corp",
//       tenant: "acme.onmicrosoft.com",     // optional
//       createdAt: "2026-05-10T...",
//       lastUsedAt: "2026-05-10T...",
//       runCount: 12,
//       entries: [
//         {
//           id: "entry_<rand>",
//           scope: "global" | "url",
//           urlPattern: "*.entra.microsoft.com",  // only if scope === "url"
//           wisdom: "Their Entra has a custom auth proxy that redirects...",
//           tags: ["entra", "timing"],
//           capturedAt: "2026-05-10T...",
//           useCount: 3
//         }
//       ]
//     }
//   }
// }
//
// Public API used by:
//   - agent-engine.js (start-of-run prompt injection)
//   - background/index.js (popup message handlers)
//   - popup-modules/* (client picker + management modal)

import { getErrorMessage } from './error-utils.js';

const STORAGE_KEY = 'sentinelClientKnowledge';

const DEFAULT_STATE = {
  activeClientId: null,
  clients: {}
};

// Regex cache for URL pattern matching to avoid repeated RegExp compilation
const _urlPatternCache = new Map();

// ========== Storage helpers ==========

async function _read() {
  try {
    const obj = await chrome.storage.local.get({ [STORAGE_KEY]: DEFAULT_STATE });
    const state = obj[STORAGE_KEY];
    if (!state || typeof state !== 'object' || state === null) return { ...DEFAULT_STATE };
    if (!state.clients || typeof state.clients !== 'object' || state.clients === null) state.clients = {};
    if (typeof state.activeClientId !== 'string' && state.activeClientId !== null) state.activeClientId = null;
    return state;
  } catch (e) {
    console.error('[Sentinel/client-knowledge] _read failed:', getErrorMessage(e));
    return { ...DEFAULT_STATE };
  }
}

async function _write(state) {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: state });
    return true;
  } catch (e) {
    console.error('[Sentinel/client-knowledge] _write failed:', getErrorMessage(e));
    return false;
  }
}

function _slugify(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 50) || `client-${Date.now()}`;
}

function _genEntryId() {
  return `entry_${Math.random().toString(36).substring(2, 10)}_${Date.now().toString(36)}`;
}

// ========== Client CRUD ==========

/**
 * List all clients sorted by lastUsedAt (most recent first).
 * @returns {Promise<Array<{id: string, displayName: string, tenant: string, entries: Array}>>}
 */
export async function listClients() {
  const state = await _read();
  return Object.values(state.clients).sort((a, b) =>
    (b.lastUsedAt || '').localeCompare(a.lastUsedAt || '')
  );
}

/**
 * Get a single client by ID.
 * @param {string} id - The client's unique identifier.
 * @returns {Promise<object|null>} The client object, or null if not found.
 */
export async function getClient(id) {
  if (!id) return null;
  const state = await _read();
  return state.clients[id] || null;
}

/**
 * Get the currently active client (the one selected for the current session).
 * @returns {Promise<object|null>} The active client, or null if none is set.
 */
export async function getActiveClient() {
  const state = await _read();
  if (!state.activeClientId) return null;
  return state.clients[state.activeClientId] || null;
}

/**
 * Set the active client by ID. Pass null/falsy to deselect.
 * @param {string|null} id - The client ID to activate, or null to deselect.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function setActiveClient(id) {
  const state = await _read();
  if (id && !state.clients[id]) return { ok: false, error: 'Unknown client id' };
  state.activeClientId = id || null;
  const written = await _write(state);
  if (!written) return { ok: false, error: 'Storage write failed' };
  return { ok: true };
}

/**
 * Create a new client with a display name and optional tenant.
 * Generates a slug-based ID with collision avoidance.
 * @param {{displayName: string, tenant?: string}} params - Client properties.
 * @returns {Promise<{ok: boolean, client?: object, error?: string}>}
 */
export async function createClient({ displayName, tenant }) {
  if (!displayName || typeof displayName !== 'string' || !displayName.trim()) {
    return { ok: false, error: 'Display name is required' };
  }
  const state = await _read();
  let id = _slugify(displayName);
  // Avoid collision
  let suffix = 1;
  const baseId = id;
  while (state.clients[id]) {
    suffix += 1;
    id = `${baseId}-${suffix}`;
  }
  const now = new Date().toISOString();
  state.clients[id] = {
    id,
    displayName: displayName.trim(),
    tenant: typeof tenant === 'string' ? tenant.trim() : '',
    createdAt: now,
    lastUsedAt: now,
    runCount: 0,
    entries: []
  };
  const written = await _write(state);
  if (!written) return { ok: false, error: 'Storage write failed' };
  return { ok: true, client: state.clients[id] };
}

/**
 * Update a client's display name and/or tenant.
 * @param {string} id - The client ID to update.
 * @param {{displayName?: string, tenant?: string}} updates - Fields to update.
 * @returns {Promise<{ok: boolean, client?: object, error?: string}>}
 */
export async function updateClient(id, updates) {
  if (!id) return { ok: false, error: 'Client id required' };
  if (!updates || typeof updates !== 'object' || updates === null) return { ok: false, error: 'Updates required' };
  const state = await _read();
  const c = state.clients[id];
  if (!c) return { ok: false, error: 'Client not found' };
  if (typeof updates.displayName === 'string') c.displayName = updates.displayName.trim();
  if (typeof updates.tenant === 'string') c.tenant = updates.tenant.trim();
  const written = await _write(state);
  if (!written) return { ok: false, error: 'Storage write failed' };
  return { ok: true, client: c };
}

/**
 * Delete a client by ID. Also clears it from active if it was selected.
 * @param {string} id - The client ID to delete.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function deleteClient(id) {
  if (!id) return { ok: false, error: 'Client id required' };
  const state = await _read();
  if (!state.clients[id]) return { ok: false, error: 'Client not found' };
  delete state.clients[id];
  if (state.activeClientId === id) state.activeClientId = null;
  const written = await _write(state);
  if (!written) return { ok: false, error: 'Storage write failed' };
  return { ok: true };
}

// ========== Entry CRUD ==========

/**
 * Add a knowledge entry to a client. Entries can be global or URL-scoped.
 * @param {string} clientId - The client to add the entry to.
 * @param {{scope?: string, urlPattern?: string, wisdom: string, tags?: string[]}} entry - Entry data.
 * @returns {Promise<{ok: boolean, entry?: object, error?: string}>}
 */
export async function addEntry(clientId, { scope, urlPattern, wisdom, tags }) {
  if (!clientId) return { ok: false, error: 'Client id required' };
  if (!wisdom || typeof wisdom !== 'string' || !wisdom.trim()) {
    return { ok: false, error: 'Wisdom text is required' };
  }
  const state = await _read();
  const c = state.clients[clientId];
  if (!c) return { ok: false, error: 'Client not found' };
  const entry = {
    id: _genEntryId(),
    scope: scope === 'url' ? 'url' : 'global',
    urlPattern: scope === 'url' && typeof urlPattern === 'string' ? urlPattern.trim() : '',
    wisdom: wisdom.trim().substring(0, 1000),
    tags: Array.isArray(tags) ? tags.slice(0, 8).map(t => String(t).trim()).filter(Boolean) : [],
    capturedAt: new Date().toISOString(),
    useCount: 0
  };
  if (!Array.isArray(c.entries)) c.entries = [];
  c.entries.push(entry);
  const written = await _write(state);
  if (!written) return { ok: false, error: 'Storage write failed' };
  return { ok: true, entry };
}

/**
 * Update a knowledge entry's wisdom, scope, urlPattern, or tags.
 * @param {string} clientId - The client that owns the entry.
 * @param {string} entryId - The entry ID to update.
 * @param {{wisdom?: string, scope?: string, urlPattern?: string, tags?: string[]}} updates - Fields to update.
 * @returns {Promise<{ok: boolean, entry?: object, error?: string}>}
 */
export async function updateEntry(clientId, entryId, updates) {
  if (!updates || typeof updates !== 'object' || updates === null) return { ok: false, error: 'Updates required' };
  const state = await _read();
  const c = state.clients[clientId];
  if (!c) return { ok: false, error: 'Client not found' };
  const e = (c.entries || []).find(x => x.id === entryId);
  if (!e) return { ok: false, error: 'Entry not found' };
  if (typeof updates.wisdom === 'string') e.wisdom = updates.wisdom.trim().substring(0, 1000);
  if (/^(global|url)$/.test(updates.scope)) e.scope = updates.scope;
  if (typeof updates.urlPattern === 'string') e.urlPattern = updates.urlPattern.trim();
  if (Array.isArray(updates.tags)) e.tags = updates.tags.slice(0, 8).map(t => String(t).trim()).filter(Boolean);
  const written = await _write(state);
  if (!written) return { ok: false, error: 'Storage write failed' };
  return { ok: true, entry: e };
}

/**
 * Delete a knowledge entry from a client.
 * @param {string} clientId - The client that owns the entry.
 * @param {string} entryId - The entry ID to delete.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function deleteEntry(clientId, entryId) {
  const state = await _read();
  const c = state.clients[clientId];
  if (!c) return { ok: false, error: 'Client not found' };
  const entries = c.entries || [];
  const filtered = entries.filter(x => x.id !== entryId);
  if (filtered.length === entries.length) return { ok: false, error: 'Entry not found' };
  c.entries = filtered;
  const written = await _write(state);
  if (!written) return { ok: false, error: 'Storage write failed' };
  return { ok: true };
}

// ========== Run-time helpers (used by agent-engine) ==========

// Match a urlPattern (glob with *) against a URL. Simple substring + wildcard.
function _urlMatches(pattern, url) {
  if (!pattern || !url) return false;
  try {
    const _patternLower = pattern.toLowerCase(); // Cache to avoid repeated toLowerCase calls
    const _urlLower = url.toLowerCase(); // Cache to avoid repeated toLowerCase calls
    if (!pattern.includes('*')) return _urlLower.includes(_patternLower);

    // Use cached regex if available, otherwise create and cache it
    let re = _urlPatternCache.get(_patternLower);
    if (!re) {
      re = new RegExp(
        `^${_patternLower
          .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')}$`
      );
      _urlPatternCache.set(_patternLower, re);
    }
    return re.test(_urlLower);
  } catch (e) {
    console.error('[Sentinel/client-knowledge] _matchesPattern failed:', getErrorMessage(e));
    return false;
  }
}

// Sync helper — filters entries from an already-loaded client object.
function _filterEntries(c, currentUrl) {
  const url = (currentUrl || '').toLowerCase();
  return (c.entries || []).filter(e => {
    if (e.scope === 'global') return true;
    if (e.scope === 'url' && e.urlPattern) return _urlMatches(e.urlPattern, url);
    return false;
  });
}

/**
 * Get knowledge entries relevant to the current run.
 * Returns global entries always, plus url-scoped entries that match currentUrl.
 * Does NOT increment useCount (call markEntriesUsed after the run if you want).
 */
export async function getRelevantEntries(clientId, currentUrl) {
  if (!clientId) return [];
  const state = await _read();
  const c = state.clients[clientId];
  if (!c) return [];
  return _filterEntries(c, currentUrl);
}

/**
 * Format relevant entries as a system-prompt section.
 * Returns an empty string when there's no client / no relevant entries.
 */
export async function formatPromptSection(clientId, currentUrl) {
  if (!clientId) return '';
  const state = await _read();
  const c = state.clients[clientId];
  if (!c) return '';
  const relevant = _filterEntries(c, currentUrl);
  if (!relevant.length) return '';
  const lines = relevant.map((e, i) => `${i + 1}. ${e.wisdom}`).join('\n');
  return `\n## CLIENT-SPECIFIC KNOWLEDGE for ${c.displayName}\nThese are facts learned from previous runs for this specific client. Treat as authoritative for THIS run unless the page actively contradicts them:\n\n${lines}\n`;
}

/**
 * Single-read helper for agent startup: returns active client, relevant entries,
 * and formatted prompt section in one storage round-trip.
 */
export async function getClientStartupContext(currentUrl) {
  const state = await _read();
  if (!state.activeClientId) return { client: null, relevantEntries: [], promptSection: '' };
  const c = state.clients[state.activeClientId];
  if (!c) return { client: null, relevantEntries: [], promptSection: '' };
  const relevantEntries = _filterEntries(c, currentUrl);
  let promptSection = '';
  if (relevantEntries.length) {
    const lines = relevantEntries.map((e, i) => `${i + 1}. ${e.wisdom}`).join('\n');
    promptSection = `\n## CLIENT-SPECIFIC KNOWLEDGE for ${c.displayName}\nThese are facts learned from previous runs for this specific client. Treat as authoritative for THIS run unless the page actively contradicts them:\n\n${lines}\n`;
  }
  return { client: c, relevantEntries, promptSection };
}

/**
 * After a successful run, increment runCount and useCount for entries
 * that were marked relevant at the start of the run. Call from agent-engine.js
 * end-of-run path.
 */
export async function markRunCompleted(clientId, usedEntryIds) {
  if (!clientId) return;
  const state = await _read();
  const c = state.clients[clientId];
  if (!c) return;
  c.runCount = (c.runCount || 0) + 1;
  c.lastUsedAt = new Date().toISOString();
  const ids = new Set(Array.isArray(usedEntryIds) ? usedEntryIds : []);
  if (ids.size > 0) {
    for (const e of (c.entries || [])) {
      if (ids.has(e.id)) e.useCount = (e.useCount || 0) + 1;
    }
  }
  await _write(state);
}

// ========== Export / Import (team sharing) ==========

/**
 * Export a client (with all entries) as a portable JSON payload for team sharing.
 * @param {string} clientId - The client ID to export.
 * @returns {Promise<{schemaVersion: number, exportedAt: string, client: object}|null>}
 */
export async function exportClient(clientId) {
  const state = await _read();
  const c = state.clients[clientId];
  if (!c) return null;
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    client: c
  };
}

/**
 * Import a client from an exported JSON payload. Optionally rename on import.
 * Generates new entry IDs to avoid collisions.
 * @param {{schemaVersion: number, client: object}} payload - The exported client data.
 * @param {{rename?: string}} options - Optional rename for the imported client.
 * @returns {Promise<{ok: boolean, client?: object, error?: string}>}
 */
export async function importClient(payload, { rename } = {}) {
  if (!payload || typeof payload !== 'object' || !payload.client) {
    return { ok: false, error: 'Invalid import payload' };
  }
  const incoming = payload.client;
  if (!incoming.displayName) return { ok: false, error: 'Import missing displayName' };
  const state = await _read();
  let id = _slugify(rename || incoming.displayName);
  let suffix = 1;
  const baseId = id;
  while (state.clients[id]) {
    suffix += 1;
    id = `${baseId}-${suffix}`;
  }
  const now = new Date().toISOString();
  state.clients[id] = {
    id,
    displayName: rename || incoming.displayName,
    tenant: incoming.tenant || '',
    createdAt: incoming.createdAt || now,
    lastUsedAt: now,
    runCount: 0,
    entries: Array.isArray(incoming.entries)
      ? incoming.entries.map(e => ({
          id: _genEntryId(),
          scope: e.scope === 'url' ? 'url' : 'global',
          urlPattern: typeof e.urlPattern === 'string' ? e.urlPattern : '',
          wisdom: typeof e.wisdom === 'string' ? e.wisdom.substring(0, 1000) : '',
          tags: Array.isArray(e.tags) ? e.tags.slice(0, 8) : [],
          capturedAt: e.capturedAt || now,
          useCount: 0
        })).filter(e => e.wisdom)
      : []
  };
  const written = await _write(state);
  if (!written) return { ok: false, error: 'Failed to save imported client' };
  return { ok: true, client: state.clients[id] };
}
