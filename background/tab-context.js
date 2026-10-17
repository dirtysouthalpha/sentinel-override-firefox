// Sentinel Override v3 -- Tab Context Manager
// Multi-tab state management: tracks which tabs the agent is operating on,
// which one is active, and maintains per-tab screenshot caches and snapshots.
// Imports from message-protocol.js and tab-manager.js only (no circular deps).

import { sendTabStateUpdate } from './message-protocol.js';
import { waitForPageLoad, getTabInfo } from './tab-manager.js';
import { getErrorMessage } from './error-utils.js';

// ========== Constants ==========
export const TAB_LIMIT = 10;

// ========== State ==========
let tabContexts = new Map();   // Map<tabId, TabContext>
let activeTabId = null;        // Which tab the agent is currently operating on

// ========== Accessors ==========

/** Returns the currently active tab ID (null if none). */
export function getActiveTabId() { return activeTabId; }

/** Sets the active tab, deactivating ALL other tabs. Returns true on success. */
export function setActiveTab(tabId) {
  if (!tabContexts.has(tabId)) return false;
  // Defensive: deactivate every other context to enforce the "exactly one active"
  // invariant, even if drift happened elsewhere.
  for (const [id, ctx] of tabContexts) {
    if (id !== tabId) ctx.isActive = false;
  }
  activeTabId = tabId;
  tabContexts.get(tabId).isActive = true;
  notifyStateChange();
  return true;
}

/** Returns the TabContext for a specific tab, or undefined. */
export function getTabContext(tabId) { return tabContexts.get(tabId); }

/** Returns an array of all tracked TabContexts. */
export function getAllTabContexts() { return [...tabContexts.values()]; }

/** Returns the number of tracked tabs. */
export function getTabCount() { return tabContexts.size; }

// ========== Tab Lifecycle ==========

/**
 * Open a new tab, register it in the context map, and activate it.
 * If at TAB_LIMIT, evict the oldest non-active tab first.
 * @param {string} url - URL to open
 * @param {string} [label] - Human-readable label
 * @returns {Promise<TabContext>} The new TabContext
 */
export async function openTab(url, label) {
  // LRU eviction: if at limit, remove oldest non-active tab
  if (tabContexts.size >= TAB_LIMIT) {
    const entries = [...tabContexts.entries()]
      .filter(([id]) => id !== activeTabId)
      .sort((a, b) => a[1].createdAt - b[1].createdAt);
    if (entries[0]?.[0]) {
      try { await closeTab(entries[0][0]); } catch (e) { console.warn('[Sentinel/tab-context] LRU eviction failed:', getErrorMessage(e)); }
    }
  }

  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false }); // Don't steal focus
  } catch (e) {
    console.error('[Sentinel/tab-context] Failed to open tab for', url, ':', getErrorMessage(e));
    return null;
  }
  const ctx = {
    tabId: tab.id,
    label: label || url,
    url: url,
    title: '',
    isActive: false,
    snapshot: null,
    // (#11) DPR-aware cache shape: cachedSnapshot holds {base64Image,width,height,dpr,scrollX,scrollY,capturedAt}.
    // cachedBase64Image kept for backward compat with any older readers; takeScreenshot writes both fields cohesively.
    screenshotCache: { cachedSnapshot: null, cachedBase64Image: null, lastScreenshotUrl: null },
    createdAt: Date.now(),
    isAgentCreated: true,
  };
  tabContexts.set(tab.id, ctx);

  // Wait for the page to load before returning
  try { await waitForPageLoad(tab.id); } catch (_e) { console.warn('[Sentinel/tab-context] waitForPageLoad error:', getErrorMessage(_e)); }

  // Update URL/title from the actual loaded page
  try {
    const info = await getTabInfo(tab.id);
    if (info) {
      ctx.url = info.url || url;
      ctx.title = info.title || '';
    }
  } catch (_e) { console.warn('[Sentinel/tab-context] getTabInfo error:', getErrorMessage(_e)); }

  setActiveTab(ctx.tabId);
  return ctx;
}

/**
 * Switch to a different tracked tab: make it the visible tab and set it active.
 * @param {number} tabId
 * @returns {Promise<boolean>} true on success
 */
export async function switchToTab(tabId) {
  if (!tabContexts.has(tabId)) return false;
  try { await chrome.tabs.update(tabId, { active: true }); } catch { return false; }
  // (3.50.1) Dismiss overlays (cursor, HUD, highlights) on ALL other tabs
  // so visual feedback only shows on the active agent tab.
  const otherTabIds = [];
  for (const id of tabContexts.keys()) {
    if (id !== tabId) otherTabIds.push(id);
  }
  for (const otherId of otherTabIds) {
    try {
      await chrome.tabs.sendMessage(otherId, { action: 'dismiss_overlays' });
    } catch (_) { /* tab may not have content script */ }
  }
  return setActiveTab(tabId);
}

/**
 * Close a tracked tab. If agent-created, calls chrome.tabs.remove.
 * If it was the active tab, switches to another tracked tab or null.
 * @param {number} tabId
 */
export async function closeTab(tabId) {
  if (!tabContexts.has(tabId)) return;

  const wasActive = (tabId === activeTabId);
  const ctx = tabContexts.get(tabId);
  if (ctx && ctx.isAgentCreated) {
    try { await chrome.tabs.remove(tabId); } catch (_e) { /* tab may already be closed */ }
  }
  tabContexts.delete(tabId);

  if (wasActive) {
    const remaining = [...tabContexts.keys()];
    if (remaining.length) {
      setActiveTab(remaining[0]); // deactivates all others, calls notifyStateChange
      return;
    }
    activeTabId = null;
  }
  notifyStateChange();
}

/**
 * Batch-close all agent-created tabs, clear map, reset activeTabId.
 * Used at agent loop end.
 */
export async function closeAllAgentTabs() {
  const closable = [...tabContexts.entries()]
    .filter(([, ctx]) => ctx.isAgentCreated);
  for (const [tabId] of closable) {
    try { await chrome.tabs.remove(tabId); } catch (_e) { console.warn('[Sentinel/tab-context] close tab error:', getErrorMessage(_e)); }
  }
  tabContexts.clear();
  activeTabId = null;
  notifyStateChange();
}

// ========== Snapshot Management ==========

/**
 * Update the snapshot for a specific tab and sync url/title.
 * @param {number} tabId
 * @param {object} snapshot - { elements, pageContent, url, title }
 */
export function updateSnapshot(tabId, snapshot) {
  const ctx = tabContexts.get(tabId);
  if (ctx) {
    ctx.snapshot = {
      elements: snapshot.elements || [],
      pageContent: snapshot.pageContent || '',
      timestamp: Date.now(),
    };
    if (snapshot.url) ctx.url = snapshot.url;
    if (snapshot.title) ctx.title = snapshot.title;
  }
}

// ========== Initialization & Reset ==========

/**
 * Clear the entire context map and activeTabId.
 * Used on agent reset.
 */
export function resetAllContexts() {
  tabContexts.clear();
  activeTabId = null;
}

/**
 * Register the user's starting tab as a non-agent-created tab.
 * Called once at agent start.
 * @param {number} tabId
 * @param {string} [url]
 */
export function registerInitialTab(tabId, url) {
  const ctx = {
    tabId: tabId,
    label: 'Main Task Tab',
    url: url || '',
    title: '',
    isActive: false, // setActiveTab will flip this to true after deactivating others
    snapshot: null,
    // (#11) DPR-aware cache shape: cachedSnapshot holds {base64Image,width,height,dpr,scrollX,scrollY,capturedAt}.
    // cachedBase64Image kept for backward compat with any older readers; takeScreenshot writes both fields cohesively.
    screenshotCache: { cachedSnapshot: null, cachedBase64Image: null, lastScreenshotUrl: null },
    createdAt: Date.now(),
    isAgentCreated: false,
  };
  tabContexts.set(tabId, ctx);
  // Use setActiveTab to enforce the "exactly one active tab" invariant:
  // it deactivates the previously-active tab (if any) before activating this one.
  setActiveTab(tabId);
}

// ========== Lookup ==========

/**
 * Find a tab context by label string (case-insensitive partial match).
 * @param {string} label
 * @returns {number|null} Tab ID of the first match, or null
 */
export function findTabByLabel(label) {
  if (!label) return null;
  const lowerLabel = label.toLowerCase();
  for (const ctx of tabContexts.values()) {
    if (String(ctx.label || '').toLowerCase().includes(lowerLabel)) {
      return ctx.tabId;
    }
  }
  return null;
}

// ========== External Tab Closure ==========

/**
 * Handle a tab being removed externally (e.g., by the user).
 * Called from index.js chrome.tabs.onRemoved listener.
 * @param {number} tabId
 */
export function handleTabRemoved(tabId) {
  if (!tabContexts.has(tabId)) return;

  const wasActive = (tabId === activeTabId);
  tabContexts.delete(tabId);

  if (wasActive) {
    const remaining = [...tabContexts.keys()];
    if (remaining.length) {
      setActiveTab(remaining[0]); // deactivates all others, calls notifyStateChange
      return;
    }
    activeTabId = null;
  }
  notifyStateChange();
}

// ========== Internal Helpers ==========

/** Notify the popup of tab state changes. */
function notifyStateChange() {
  try { sendTabStateUpdate(getAllTabContexts()); } catch (_e) { /* popup may be closed */ }
}
