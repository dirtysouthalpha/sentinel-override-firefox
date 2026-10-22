// Agent Learning Engine — v13 Learning & Autonomy
// Tracks action success/failure per platform, learns optimal patterns,
// and enables one-shot execution for well-known tasks.

import { getErrorMessage } from './error-utils.js';

const ACTION_HISTORY_KEY = 'agent_action_history';
const PLATFORM_PATTERNS_KEY = 'agent_platform_patterns';
const PLAYBOOK_AUTO_KEY = 'agent_auto_playbooks';

// In-memory cache
let _actionHistory = [];
let _platformPatterns = {};
let _autoPlaybooks = [];

/**
 * Initialize learning engine — load from storage.
 */
export async function initLearningEngine() {
  try {
    const stored = await chrome.storage.local.get([ACTION_HISTORY_KEY, PLATFORM_PATTERNS_KEY, PLAYBOOK_AUTO_KEY]);
    _actionHistory = stored[ACTION_HISTORY_KEY] || [];
    _platformPatterns = stored[PLATFORM_PATTERNS_KEY] || {};
    _autoPlaybooks = stored[PLAYBOOK_AUTO_KEY] || [];
  } catch (e) {
    console.warn('[Sentinel/Learn] Init failed:', getErrorMessage(e));
  }
}

/**
 * Record an action outcome for learning.
 * @param {string} platform - Platform name (e.g., 'sonicwall_nsm')
 * @param {string} actionType - Action type (e.g., 'click', 'type', 'navigate')
 * @param {string} selector - Selector used
 * @param {boolean} success - Whether the action succeeded
 * @param {number} duration - How long the action took in ms
 */
export function recordActionOutcome(platform, actionType, selector, success, duration) {
  const entry = {
    platform,
    actionType,
    selector,
    success,
    duration,
    timestamp: Date.now()
  };
  _actionHistory.push(entry);

  // Keep last 1000 entries
  if (_actionHistory.length > 1000) {
    _actionHistory = _actionHistory.slice(-1000);
  }

  // Update platform-specific patterns
  if (!_platformPatterns[platform]) {
    _platformPatterns[platform] = {};
  }
  const key = `${actionType}:${(selector || '').substring(0, 80)}`;
  if (!_platformPatterns[platform][key]) {
    _platformPatterns[platform][key] = { attempts: 0, successes: 0, totalDuration: 0 };
  }
  _platformPatterns[platform][key].attempts++;
  if (success) _platformPatterns[platform][key].successes++;
  _platformPatterns[platform][key].totalDuration += duration;
  _platformPatterns[platform][key].avgDuration = Math.round(
    _platformPatterns[platform][key].totalDuration / _platformPatterns[platform][key].attempts
  );

  // Persist (debounced — will be called on run end)
  _schedulePersist();

  return entry;
}

/**
 * Get the best selector for an action on a platform.
 * Returns null if no learned pattern exists.
 */
export function getBestSelector(platform, actionType) {
  const patterns = _platformPatterns[platform];
  if (!patterns) return null;

  const candidates = Object.entries(patterns)
    .filter(([key]) => key.startsWith(actionType + ':'))
    .map(([key, data]) => ({
      selector: key.substring(actionType.length + 1),
      successRate: data.attempts > 0 ? data.successes / data.attempts : 0,
      avgDuration: data.avgDuration || 0,
      attempts: data.attempts
    }))
    .filter(c => c.successRate > 0.5 && c.attempts >= 2)
    .sort((a, b) => b.successRate - a.successRate || a.avgDuration - b.avgDuration);

  return candidates.length > 0 ? candidates[0] : null;
}

/**
 * Get failures for a platform — selectors that consistently fail.
 */
export function getFailedSelectors(platform, actionType) {
  const patterns = _platformPatterns[platform];
  if (!patterns) return [];

  return Object.entries(patterns)
    .filter(([key]) => key.startsWith(actionType + ':'))
    .map(([key, data]) => ({
      selector: key.substring(actionType.length + 1),
      successRate: data.attempts > 0 ? data.successes / data.attempts : 0,
      attempts: data.attempts
    }))
    .filter(c => c.successRate < 0.3 && c.attempts >= 3)
    .map(c => c.selector);
}

/**
 * Get estimated wait time for a platform based on learned page load times.
 */
export function getEstimatedWaitTime(platform) {
  const patterns = _platformPatterns[platform];
  if (!patterns) return null;

  const navigatePatterns = Object.entries(patterns)
    .filter(([key]) => key.startsWith('navigate:'))
    .map(([, data]) => data.avgDuration)
    .filter(d => d > 0);

  if (navigatePatterns.length === 0) return null;
  return Math.round(navigatePatterns.reduce((a, b) => a + b, 0) / navigatePatterns.length);
}

/**
 * Try to find a matching one-shot playbook for a goal.
 * Returns the playbook steps if found, null otherwise.
 */
export function findOneShotPlaybook(goal, platform) {
  const goalLower = (goal || '').toLowerCase();
  for (const playbook of _autoPlaybooks) {
    if (playbook.platform !== platform) continue;
    // Check if the goal matches the playbook's trigger patterns
    const matches = (playbook.triggerPatterns || []).some(p => goalLower.includes(p.toLowerCase()));
    if (matches && playbook.runCount >= 3 && playbook.successRate >= 0.8) {
      return playbook.steps;
    }
  }
  return null;
}

/**
 * Auto-generate a playbook from a successful run.
 * Called after 3+ successful runs of the same goal type.
 */
export function maybeGeneratePlaybook(goal, platform, steps) {
  const goalKey = (goal || '').substring(0, 60).toLowerCase();

  // Check if we already have a playbook for this goal pattern
  const existing = _autoPlaybooks.find(p =>
    p.platform === platform && p.goalKey === goalKey
  );

  if (existing) {
    existing.runCount++;
    if (steps && steps.length > 0) {
      existing.successRate = ((existing.successRate * (existing.runCount - 1)) + 1) / existing.runCount;
    }
    _schedulePersist();
    return existing;
  }

  // Create new playbook if we have steps
  if (!steps || steps.length === 0) return null;

  const playbook = {
    id: `pb_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
    goalKey,
    platform,
    triggerPatterns: [goalKey.split(' ').slice(0, 3).join(' ')],
    steps: steps.map(s => ({
      type: s.type || 'unknown',
      selector: s.selector || '',
      value: s.value || '',
      description: s.description || ''
    })),
    runCount: 1,
    successRate: 1.0,
    createdAt: Date.now(),
    lastUsed: Date.now()
  };

  _autoPlaybooks.push(playbook);

  // Keep max 50 playbooks
  if (_autoPlaybooks.length > 50) {
    _autoPlaybooks.sort((a, b) => b.runCount - a.runCount);
    _autoPlaybooks = _autoPlaybooks.slice(0, 50);
  }

  _schedulePersist();
  return playbook;
}

/**
 * Get all playbooks (for UI display).
 */
export function getPlaybooks() {
  return [..._autoPlaybooks];
}

/**
 * Get all platform patterns (for UI display).
 */
export function getPlatformPatterns() {
  return structuredClone(_platformPatterns);
}

/**
 * Get action history summary.
 */
export function getActionHistorySummary() {
  const byPlatform = {};
  for (const entry of _actionHistory) {
    if (!byPlatform[entry.platform]) byPlatform[entry.platform] = { total: 0, success: 0, fail: 0 };
    byPlatform[entry.platform].total++;
    if (entry.success) byPlatform[entry.platform].success++;
    else byPlatform[entry.platform].fail++;
  }
  return { totalActions: _actionHistory.length, byPlatform, playbooks: _autoPlaybooks.length };
}

// Persist to storage (debounced)
let _persistTimer = null;
function _schedulePersist() {
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(_persist, 5000);
}

async function _persist() {
  try {
    await chrome.storage.local.set({
      [ACTION_HISTORY_KEY]: _actionHistory,
      [PLATFORM_PATTERNS_KEY]: _platformPatterns,
      [PLAYBOOK_AUTO_KEY]: _autoPlaybooks
    });
  } catch (e) {
    console.warn('[Sentinel/Learn] Persist failed:', getErrorMessage(e));
  }
}
