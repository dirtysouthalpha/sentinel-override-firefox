/**
 * Sentinel Override — Page Change Monitor.
 * Watches DOM elements for content changes and notifies the user.
 */

import { getErrorMessage } from './error-utils.js';

const MONITOR_STORAGE_KEY = 'sentinel_monitors';
const _CHECK_INTERVAL_MS = 30_000; // 30 seconds (reserved for future use)

// ========== In-Memory Cache ==========
let _cachedMonitors = null;
let _loadMonitorsPromise = null;

// Invalidate cache when storage changes externally
if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes[MONITOR_STORAGE_KEY]) {
      _cachedMonitors = null;
      _loadMonitorsPromise = null;
    }
  });
}

/**
 * Clear the in-memory cache. Exposed for testing.
 */
export function clearMonitorCache() {
  _cachedMonitors = null;
  _loadMonitorsPromise = null;
}

/**
 * @typedef {Object} PageMonitor
 * @property {string} id - UUID
 * @property {string} url - Page URL pattern
 * @property {string} selector - CSS selector to watch
 * @property {string} lastContent - Last known content hash
 * @property {string} label - Human-readable label
 * @property {boolean} active - Whether monitoring is active
 * @property {number} interval - Check interval in seconds
 * @property {string} createdAt - ISO timestamp
 * @property {string} lastChangedAt - ISO timestamp of last change
 * @property {number} changeCount - Number of changes detected
 */

function generateId() {
  return `mon-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Load all monitors from storage.
 * Uses in-memory cache to reduce I/O overhead.
 * @returns {Promise<PageMonitor[]>}
 */
export async function loadMonitors() {
  // Return cached data if available
  if (_cachedMonitors !== null) {
    return _cachedMonitors;
  }

  // Coalesce concurrent calls to avoid duplicate storage reads
  if (_loadMonitorsPromise !== null) {
    return _loadMonitorsPromise;
  }

  _loadMonitorsPromise = (async () => {
    try {
      const result = await chrome.storage.local.get(MONITOR_STORAGE_KEY);
      _cachedMonitors = result[MONITOR_STORAGE_KEY] || [];
      return _cachedMonitors;
    } catch (e) {
      console.error('[Sentinel/page-monitor] loadMonitors failed:', getErrorMessage(e));
      return [];
    } finally {
      _loadMonitorsPromise = null;
    }
  })();

  return _loadMonitorsPromise;
}

async function saveMonitors(monitors) {
  try {
    await chrome.storage.local.set({ [MONITOR_STORAGE_KEY]: monitors });
    // Update cache immediately after save
    _cachedMonitors = monitors;
  } catch (e) {
    console.error('[Sentinel/page-monitor] saveMonitors failed:', getErrorMessage(e));
    throw e;
  }
}

/**
 * Create a new page monitor.
 * @param {string} url - URL pattern to watch
 * @param {string} selector - CSS selector
 * @param {string} label - Display name
 * @param {number} [interval=30] - Check interval in seconds
 * @returns {Promise<PageMonitor>}
 */
export async function createMonitor(url, selector, label, interval = 30) {
  const monitors = await loadMonitors();
  const monitor = {
    id: generateId(),
    url: (url || '').trim(),
    selector: (selector || '').trim(),
    lastContent: '',
    label: (label || '').trim() || `Monitor: ${selector}`,
    active: true,
    interval,
    createdAt: new Date().toISOString(),
    lastChangedAt: null,
    changeCount: 0,
  };
  monitors.push(monitor);
  await saveMonitors(monitors);
  return monitor;
}

/**
 * Remove a monitor.
 * @param {string} id
 */
export async function removeMonitor(id) {
  const monitors = await loadMonitors();
  await saveMonitors(monitors.filter(m => m.id !== id));
}

/**
 * Toggle a monitor on/off.
 * @param {string} id
 * @param {boolean} active
 */
export async function toggleMonitor(id, active) {
  const monitors = await loadMonitors();
  const mon = monitors.find(m => m.id === id);
  if (mon) {
    mon.active = active;
    await saveMonitors(monitors);
  }
}

/**
 * Check a single monitor for changes.
 * Runs in content script context via messaging.
 * @param {PageMonitor} monitor
 * @returns {Promise<{changed: boolean, content: string}>}
 */
export async function checkMonitor(monitor) {
  // Hash the current content of the selector
  try {
    const tabs = await chrome.tabs.query({ url: monitor.url });
    if (!tabs || !tabs.length) return { changed: false, content: '' };

    const tab = tabs[0];
    if (!tab || !tab.id) return { changed: false, content: '' };
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (selector) => {
        // Handle :contains() pseudo-selectors (jQuery-style, not native CSS).
        // Extract the text and scan elements manually.
        const containsMatch = selector.match(/^[^:]*:contains\(['"]([^'"]*)['"]\)$/i);
        if (containsMatch) {
          const text = containsMatch[1].toLowerCase();
          const all = document.querySelectorAll('*');
          for (let i = 0; i < all.length; i++) {
            if (all[i].children.length === 0 && all[i].textContent.toLowerCase().includes(text)) {
              return all[i].textContent.trim();
            }
          }
          return '';
        }
        try {
          const el = document.querySelector(selector);
          return el ? el.textContent.trim() : '';
        } catch (_) {
          return document.body ? document.body.textContent.trim().substring(0, 500) : '';
        }
      },
      args: [monitor.selector],
    });

    const content = results?.[0]?.result || '';
    if (!content) return { changed: false, content: '' };

    // Ensure changed is always a boolean: false if no prior content, true if content differs
    const changed = Boolean(monitor.lastContent) && content !== monitor.lastContent;

    // Update stored content
    const monitors = await loadMonitors();
    const mon = monitors.find(m => m.id === monitor.id);
    if (mon) {
      if (changed) {
        mon.lastChangedAt = new Date().toISOString();
        mon.changeCount++;
      }
      mon.lastContent = content;
      await saveMonitors(monitors);
    }

    return { changed, content, changeCount: mon ? mon.changeCount : monitor.changeCount };
  } catch (e) {
    console.error('[Sentinel/page-monitor] checkMonitor failed:', getErrorMessage(e));
    return { changed: false, content: '', changeCount: monitor.changeCount };
  }
}

/**
 * Run a check cycle across all active monitors.
 * Sends Chrome notifications for any detected changes.
 */
export async function runMonitorCycle() {
  const monitors = await loadMonitors();
  const active = monitors.filter(m => m.active);

  for (const monitor of active) {
    const { changed, changeCount } = await checkMonitor(monitor);
    if (changed) {
      chrome.notifications.create(`sentinel-change-${monitor.id}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icon-128.png'),
        title: 'Sentinel Override — Change Detected',
        message: `"${monitor.label}" has changed! (${changeCount} changes total)`,
        priority: 2,
      });
    }
  }
}

let _monitorLoopStarted = false;
let _monitorAlarmHandler = null;

/** Reset idempotency guard — only for use in tests. */
export function _resetMonitorLoop() {
  if (_monitorAlarmHandler) {
    chrome.alarms.onAlarm.removeListener(_monitorAlarmHandler);
    _monitorAlarmHandler = null;
  }
  _monitorLoopStarted = false;
}

/**
 * Start the periodic monitor check loop.
 * @returns {string} Alarm name for reference
 */
export function startMonitorLoop() {
  if (_monitorLoopStarted) return 'sentinel-monitor-check';
  _monitorLoopStarted = true;

  chrome.alarms.create('sentinel-monitor-check', {
    periodInMinutes: 0.5, // 30 seconds
  });

  _monitorAlarmHandler = alarm => {
    if (alarm.name === 'sentinel-monitor-check') {
      runMonitorCycle().catch(e => console.error('[Sentinel/page-monitor] Cycle failed:', getErrorMessage(e)));
    }
  };
  chrome.alarms.onAlarm.addListener(_monitorAlarmHandler);

  return 'sentinel-monitor-check';
}
