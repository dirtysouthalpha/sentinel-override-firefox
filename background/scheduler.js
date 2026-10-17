// Sentinel Override v3 -- Scheduler
// Schedule CRUD, chrome.alarms management, execution bridge to agent,
// result storage, completion notifications, service worker restart recovery.
// Layer 3 module -- imports from agent-engine.js, template-manager.js, tab-context.js, tab-manager.js.

import * as AgentEngine from './agent-engine.js';
import { resolveTemplateGoal } from './template-manager.js';
import { getActiveTabId as _getActiveTabId, registerInitialTab } from './tab-context.js';
import { getTabInfo } from './tab-manager.js';
import { notifyIfEnabled } from './shared-state.js';
import { FIVE_HUNDRED_MS, ONE_MINUTE_MS, FIVE_MINUTES_MS, ONE_HOUR_MS } from './constants.js';
import { tel } from './telemetry.js';
import { getErrorMessage } from './error-utils.js';

// H-5: Mutex to prevent TOCTOU race on agentRunning check.
// Set to true before checking agentRunning, cleared after startAgent completes.
// This prevents concurrent scheduled tasks from both passing the check.
let _agentStartLock = false;

// ========== Storage Constants ==========
const SCHEDULES_KEY = 'sentinel_schedules';
const RESULTS_KEY = 'sentinel_schedule_results';
const MAX_RESULTS = 50;

// Precompile regex for crash detection in agent summary messages
const CRASH_SUMMARY_RE = /crash|unexpected/i;

// ========== Agent Completion Callback ==========
let agentCompleteCallbacks = [];

/**
 * Register a callback to be invoked when the agent finishes running.
 * Used by the scheduler execution bridge to detect task completion.
 * @param {function} callback - Called with no arguments when agentRunning flips to false
 */
export function onAgentComplete(callback) {
  agentCompleteCallbacks.push(callback);
}

/**
 * Fire all registered agent-complete callbacks.
 * Called from the polling loop in executeScheduledTask.
 */
 
function _fireAgentCompleteCallbacks() {
  const cbs = agentCompleteCallbacks.slice();
  agentCompleteCallbacks = [];
  cbs.forEach(cb => { if (cb) { try { cb(); } catch (e) { console.error('Agent complete callback error:', getErrorMessage(e)); } } });
}

// ========== Storage Helpers ==========

/**
 * Load all schedules from chrome.storage.local.
 * @returns {Promise<Object<string, object>>}
 */
async function loadSchedules() {
  try {
    const result = await chrome.storage.local.get([SCHEDULES_KEY]);
    return result[SCHEDULES_KEY] || {};
  } catch (e) {

    return {};
  }
}

/**
 * Persist all schedules to chrome.storage.local.
 * @param {Object<string, object>} schedules
 */
async function saveSchedules(schedules) {
  try {
    await chrome.storage.local.set({ [SCHEDULES_KEY]: schedules });
  } catch (e) {

  }
}

/**
 * Load all results from chrome.storage.local.
 * @returns {Promise<Object<string, object>>}
 */
async function loadResults() {
  try {
    const result = await chrome.storage.local.get([RESULTS_KEY]);
    return result[RESULTS_KEY] || {};
  } catch (e) {

    return {};
  }
}

/**
 * Persist all results to chrome.storage.local.
 * @param {Object<string, object>} results
 */
async function saveResults(results) {
  try {
    await chrome.storage.local.set({ [RESULTS_KEY]: results });
  } catch (e) {

  }
}

// ========== Alarm Management ==========

/**
 * Register a chrome.alarm for the given schedule.
 * For 'once': alarm fires once at schedule.nextRunAt.
 * For 'recurring': alarm fires at nextRunAt and repeats at periodInMinutes.
 * @param {object} schedule
 */
function registerAlarm(schedule) {
  if (!schedule.nextRunAt) return;

  const alarmInfo = {
    when: schedule.nextRunAt,
  };

  if (schedule.type === 'recurring' && schedule.recurrence) {
    alarmInfo.periodInMinutes = schedule.recurrence.periodInMinutes;
  }

  const _alarmPromise = chrome.alarms.create(`schedule-${schedule.id}`, alarmInfo);
  if (typeof _alarmPromise?.catch === 'function') {
    _alarmPromise.catch((e) => {
      console.error('[_alarmPromise] Unhandled rejection:', getErrorMessage(e));
    });
  } else {
    chrome.alarms.create(`schedule-${schedule.id}`, alarmInfo, () => {
      if (chrome.runtime.lastError) {

      }
    });
  }
  tel.debug('scheduler', `Alarm registered: schedule-${schedule.id} at ${new Date(schedule.nextRunAt).toISOString()}`);
}

/**
 * Clear the chrome.alarm for a given schedule ID.
 * @param {string} scheduleId
 */
function clearAlarm(scheduleId) {
  const _p = chrome.alarms.clear(`schedule-${scheduleId}`);
  if (typeof _p?.catch === 'function') {
    _p.catch((e) => {
      console.error('[_p] Unhandled rejection:', getErrorMessage(e));
    });
  } else {
    chrome.alarms.clear(`schedule-${scheduleId}`, () => {
      if (chrome.runtime.lastError) {

      }
    });
  }
  tel.debug('scheduler', `Alarm cleared: schedule-${scheduleId}`);
}

// ========== Time Computation ==========

/**
 * Compute the next run timestamp from a recurrence configuration.
 * @param {object} recurrence - { interval, periodInMinutes, daysOfWeek, time }
 * @returns {number} Timestamp in ms for the next run
 */
/**
 * Find how many days ahead the next matching weekday is, given daysOfWeek and a candidate time.
 * @param {number[]} daysOfWeek - Array of day indices (0=Sun, 6=Sat)
 * @param {number} currentDay - Current day index
 * @param {number} candidateTime - Candidate Date getTime()
 * @param {number} nowTime - Current Date getTime()
 * @returns {number} Days ahead until next matching day
 */
function _computeWeeklyDaysAhead(daysOfWeek, currentDay, candidateTime, nowTime) {
  if (!Array.isArray(daysOfWeek) || !daysOfWeek.length) return 7;
  const sortedDays = daysOfWeek.slice().sort((a, b) => a - b);
  let daysAhead = 0;
  for (const day of sortedDays) {
    let diff = day - currentDay;
    if (diff < 0) diff += 7;
    if (diff === 0 && candidateTime <= nowTime) diff = 7;
    if (daysAhead === 0 || diff < daysAhead) daysAhead = diff;
  }
  return daysAhead || 7;
}

function computeNextRun(recurrence) {
  if (!recurrence) return Date.now();

  const timeParts = (typeof recurrence.time === 'string' ? recurrence.time : '09:00').split(':');
  const partsLen = timeParts.length;
  const hours = (partsLen && timeParts[0] != null) ? parseInt(timeParts[0], 10) : 9;
  const validHours = Number.isFinite(hours) && hours >= 0 && hours < 24;
  const finalHours = validHours ? hours : 9;
  const minutes = (partsLen >= 2 && timeParts[1] != null) ? parseInt(timeParts[1], 10) : 0;
  const validMinutes = Number.isFinite(minutes) && minutes >= 0 && minutes < 60;
  const finalMinutes = validMinutes ? minutes : 0;
  const now = new Date();
  const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), finalHours, finalMinutes, 0, 0);

  if (recurrence.interval === 'daily') {
    if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1);
    return candidate.getTime();
  }

  if (recurrence.interval === 'weekly' && recurrence.daysOfWeek && Array.isArray(recurrence.daysOfWeek) && recurrence.daysOfWeek.length) {
    const daysAhead = _computeWeeklyDaysAhead(recurrence.daysOfWeek, now.getDay(), candidate.getTime(), now.getTime());
    candidate.setDate(candidate.getDate() + daysAhead);
    return candidate.getTime();
  }

  if (recurrence.interval === 'custom') {
    const periodMs = (recurrence.periodInMinutes || 60) * ONE_MINUTE_MS;
    if (periodMs <= 0) return now.getTime() + ONE_HOUR_MS;
    const nowMs = now.getTime();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const periodsElapsed = Math.floor((nowMs - midnight) / periodMs);
    const nextPeriod = midnight + (periodsElapsed + 1) * periodMs;
    if (nextPeriod <= nowMs + ONE_MINUTE_MS) return midnight + (periodsElapsed + 2) * periodMs;
    return nextPeriod;
  }

  return now.getTime() + ONE_HOUR_MS;
}

// ========== Notifications ==========

/**
 * Send a chrome notification for a completed scheduled task.
 * @param {object} schedule
 * @param {object} result - { status, completedAt, error, report }
 */
function sendNotification(schedule, result) {
  const title = `Schedule ${schedule.name}`;
  let message;

  const completedDate = result.completedAt && !Number.isNaN(new Date(result.completedAt).getTime()) ? new Date(result.completedAt) : new Date();

  if (result.status === 'success') {
    message = `Completed successfully at ${completedDate.toLocaleTimeString()}.`;
    if (typeof result.report === 'string') {
      const snippet = result.report.substring(0, 150).replace(/\n/g, ' ');
      message += ` ${snippet}${result.report.length > 150 ? '...' : ''}`;
    }
  } else {
    message = `Failed at ${completedDate.toLocaleTimeString()}.`;
    if (typeof result.error === 'string') {
      message += ` Error: ${result.error.substring(0, 100)}`;
    }
  }

  notifyIfEnabled(`schedule-result-${result.id}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icon-128.png'),
    title,
    message: message.substring(0, 500),
    priority: result.status === 'success' ? 0 : 2,
  });
}

// ========== Badge ==========

/**
 * Set the extension icon badge to indicate a pending result.
 * @param {string} status - 'success' or 'failure'
 */
function setBadge(status) {
  const _t = chrome.action.setBadgeText({ text: '1' });
  if (typeof _t?.catch === 'function') _t.catch((e) => {
    console.error('[_t] Unhandled rejection:', getErrorMessage(e));
  });
  const _b = chrome.action.setBadgeBackgroundColor({
    color: status === 'success' ? '#22c55e' : '#ef4444',
  });
  if (typeof _b?.catch === 'function') _b.catch((e) => {
    console.error('[_b] Unhandled rejection:', getErrorMessage(e));
  });
}

// ========== CRUD Operations ==========

/**
 * Create a new schedule.
 * @param {{ name: string, templateId?: string, goal?: string, params?: object, type: 'once'|'recurring', recurrence?: object, runAt?: number }} data
 * @returns {Promise<object>} The created schedule
 */
/**
 * Validate createSchedule input fields and throw descriptive errors.
 * @param {object} data
 */
function _validateScheduleData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Schedule data must be an object');
  if (!data.name || typeof data.name !== 'string' || !data.name.trim()) throw new Error('Schedule name is required');
  if (!data.templateId && (!data.goal || typeof data.goal !== 'string' || !data.goal.trim())) {
    throw new Error('Either templateId or goal is required');
  }
}

/**
 * Build the recurrence config and compute the next run timestamp for a schedule.
 * @param {object} data - Raw schedule data from the caller
 * @param {number} now - Current timestamp (ms)
 * @returns {{ recurrence: object|null, nextRunAt: number }}
 */
function _buildScheduleTiming(data, now) {
  if (data.type === 'once') {
    return { recurrence: null, nextRunAt: (data.runAt && data.runAt > now) ? data.runAt : now + ONE_HOUR_MS };
  }
  if (data.type === 'recurring' && data.recurrence) {
    const recurrence = {
      interval: data.recurrence.interval || 'daily',
      periodInMinutes: data.recurrence.periodInMinutes || 1440,
      daysOfWeek: data.recurrence.daysOfWeek || null,
      time: data.recurrence.time || '09:00',
    };
    if (!data.recurrence.periodInMinutes) {
      if (recurrence.interval === 'daily') recurrence.periodInMinutes = 1440;
      else if (recurrence.interval === 'weekly') recurrence.periodInMinutes = 10080;
    }
    return { recurrence, nextRunAt: computeNextRun(recurrence) };
  }
  throw new Error('Schedule type must be "once" or "recurring" with recurrence config');
}

/**
 * Create and persist a new scheduled task.
 * Validates the data, computes the first run time from cron/recurrence/runAt,
 * and writes it to chrome.storage.local.
 *
 * @param {object} data - Schedule configuration (name, goal/templateId, recurrence, etc.).
 * @returns {Promise<object>} The created schedule object with its generated id.
 */
export async function createSchedule(data) {
  _validateScheduleData(data);

  const id = crypto.randomUUID();
  const now = Date.now();
  const { recurrence, nextRunAt } = _buildScheduleTiming(data, now);

  const schedule = {
    id,
    name: data.name.trim(),
    templateId: data.templateId || null,
    goal: data.goal || null,
    params: data.params || null,
    type: data.type,
    recurrence,
    enabled: true,
    nextRunAt,
    lastRunAt: null,
    lastRunStatus: null,
    createdAt: now,
  };

  const schedules = await loadSchedules();
  schedules[id] = schedule;
  await saveSchedules(schedules);
  registerAlarm(schedule);

  return schedule;
}

/**
 * List all schedules, sorted by nextRunAt ascending (enabled first, then disabled).
 * @returns {Promise<Array<object>>}
 */
export async function listSchedules() {
  const schedules = await loadSchedules();
  const all = Object.values(schedules);

  const enabled = [];
  const disabled = [];
  for (const s of all) {
    if (s.enabled) enabled.push(s);
    else disabled.push(s);
  }
  const sortFn = (a, b) => (a.nextRunAt || Infinity) - (b.nextRunAt || Infinity);
  enabled.sort(sortFn);
  disabled.sort(sortFn);

  return [...enabled, ...disabled];
}

/**
 * Delete a schedule by ID.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteSchedule(id) {
  if (!id || typeof id !== 'string') {
    throw new Error('Schedule ID is required');
  }

  const schedules = await loadSchedules();
  if (!schedules[id]) {
    throw new Error(`Schedule not found: ${id}`);
  }

  delete schedules[id];
  await saveSchedules(schedules);
  clearAlarm(id);

  // Clear all associated results
  const results = await loadResults();
  const resultIds = Object.keys(results).filter(rid => results[rid] && results[rid].scheduleId === id);
  for (const rid of resultIds) {
    delete results[rid];
  }
  if (resultIds.length) {
    await saveResults(results);
  }
}

/**
 * Toggle a schedule's enabled state.
 * @param {string} id
 * @param {boolean} enabled
 * @returns {Promise<object>} The updated schedule
 */
export async function toggleSchedule(id, enabled) {
  if (!id || typeof id !== 'string') {
    throw new Error('Schedule ID is required');
  }
  if (typeof enabled !== 'boolean') {
    throw new Error('Enabled flag must be a boolean');
  }

  const schedules = await loadSchedules();
  const schedule = schedules[id];
  if (!schedule) {
    throw new Error(`Schedule not found: ${id}`);
  }

  schedule.enabled = enabled;

  if (enabled) {
    // Recompute nextRunAt if needed
    if (!schedule.nextRunAt || schedule.nextRunAt <= Date.now()) {
      if (schedule.recurrence) {
        schedule.nextRunAt = computeNextRun(schedule.recurrence);
      }
    }
    registerAlarm(schedule);
  } else {
    clearAlarm(id);
  }

  schedules[id] = schedule;
  await saveSchedules(schedules);

  return schedule;
}

/**
 * Calculate the next run time for a schedule.
 * @param {object} schedule
 * @returns {number|null} Timestamp in ms, or null
 */
export function getNextRunTime(schedule) {
  if (!schedule) return null;

  if (schedule.type === 'once') {
    return schedule.nextRunAt;
  }

  if (schedule.type === 'recurring' && schedule.recurrence) {
    return computeNextRun(schedule.recurrence);
  }

  return schedule.nextRunAt;
}

// ========== Execution Bridge ==========

/**
 * Execute a scheduled task when its alarm fires.
 * Called from chrome.alarms.onAlarm in index.js.
 *
 * Flow:
 * 1. Parse scheduleId from alarmName
 * 2. Load schedule, check enabled
 * 3. Check agentRunning -- skip if busy
 * 4. Resolve goal (template or direct)
 * 5. Create result record
 * 6. Find or open a tab, set up tab context
 * 7. Start agent
 * 8. Poll for completion (max 5 minutes)
 * 9. Update result and schedule
 * 10. Re-register alarm for recurring
 * 11. Send notification and set badge
 *
 * @param {string} alarmName - The alarm name (format: schedule-${scheduleId})
 */
export async function executeScheduledTask(alarmName) {
  const scheduleId = alarmName.replace('schedule-', '');
  if (!scheduleId) {
    console.error('[Sentinel/scheduler] Invalid alarm name:', alarmName);
    return;
  }

  const schedules = await loadSchedules();
  const schedule = schedules[scheduleId];
  if (!schedule) {

    clearAlarm(scheduleId);
    return;
  }
  if (!schedule.enabled) {
    tel.debug('scheduler', `Schedule ${schedule.name} is disabled, skipping`);
    return;
  }

  // H-5: Acquire mutex before checking agentRunning to prevent TOCTOU race
  if (_agentStartLock) {
    tel.info('scheduler', `Agent start already in progress, skipping schedule ${schedule.name}`);
    schedule.lastRunStatus = 'skipped';
    schedule.lastRunAt = Date.now();
    if (schedule.type === 'recurring' && schedule.recurrence) {
      schedule.nextRunAt = computeNextRun(schedule.recurrence);
    }
    schedules[scheduleId] = schedule;
    await saveSchedules(schedules);
    if (schedule.type === 'recurring' && schedule.recurrence) {
      registerAlarm(schedule);
    }
    return;
  }
  _agentStartLock = true;

  try {
    if (AgentEngine.agentRunning) {
      tel.info('scheduler', `Agent busy, skipping schedule ${schedule.name}`);
      schedule.lastRunStatus = 'skipped';
      schedule.lastRunAt = Date.now();
      if (schedule.type === 'recurring' && schedule.recurrence) {
        schedule.nextRunAt = computeNextRun(schedule.recurrence);
      }
      schedules[scheduleId] = schedule;
      await saveSchedules(schedules);
      if (schedule.type === 'recurring' && schedule.recurrence) {
        registerAlarm(schedule);
      }
      return;
    }

  const resultId = crypto.randomUUID();
  const startedAt = Date.now();

  let goal;
  try {
    goal = await _resolveGoalForSchedule(schedule);
  } catch (err) {
    console.error(`Failed to resolve goal for schedule ${schedule.name}:`, getErrorMessage(err));
    await _handleTaskFailure(schedule, scheduleId, schedules, { id: resultId, startedAt, error: `Goal resolution failed: ${getErrorMessage(err)}` });
    return;
  }

  if (!goal) {
    console.error(`Schedule "${schedule.name}" resolved to empty goal — skipping`);
    await _handleTaskFailure(schedule, scheduleId, schedules, { id: resultId, startedAt, error: 'Resolved goal was empty' });
    return;
  }
  tel.info('scheduler', `Executing scheduled task: ${schedule.name}`, { goal: typeof goal === 'string' ? goal.substring(0, 80) : String(goal).substring(0, 80) });

  let tabId;
  try {
    tabId = await _getOrCreateTab();
  } catch (err) {
    console.error('Failed to get/create tab:', getErrorMessage(err));
    await _handleTaskFailure(schedule, scheduleId, schedules, { id: resultId, startedAt, error: `Tab creation failed: ${getErrorMessage(err)}` });
    return;
  }

  let tabInfo;
  try { tabInfo = await getTabInfo(tabId); } catch (e) { console.warn('[Sentinel/scheduler] getTabInfo failed:', getErrorMessage(e)); tabInfo = null; }
  registerInitialTab(tabId, tabInfo?.url || '');

  // Register listener BEFORE startAgent so agent_loop_complete can't fire and be missed
  // if startAgent ever completes synchronously in a fast-path (e.g. cached single-step plan).
  const { promise: completionPromise, cancel: cancelCompletion } = _waitForAgentCompletion(FIVE_MINUTES_MS);

  try {
    await AgentEngine.startAgent(goal, { tab: { id: tabId } });
  } catch (err) {
    cancelCompletion(); // Clean up the timer + listener so they don't leak
    console.error('Failed to start agent:', getErrorMessage(err));
    await _handleTaskFailure(schedule, scheduleId, schedules, { id: resultId, startedAt, error: `Agent start failed: ${getErrorMessage(err)}` });
    return;
  } finally {
    // H-5: Release mutex after startAgent completes (success or failure)
    _agentStartLock = false;
  }

  const completionResult = await completionPromise;
  const completedAt = Date.now();

  const finalResult = {
    id: resultId,
    scheduleId: schedule.id,
    scheduleName: schedule.name,
    templateId: schedule.templateId,
    goal,
    status: completionResult.status,
    startedAt,
    completedAt,
    report: completionResult.report,
    error: completionResult.error,
  };

  await storeResult(schedule, finalResult);

  schedule.lastRunAt = completedAt;
  schedule.lastRunStatus = completionResult.status;

  if (schedule.type === 'recurring' && schedule.recurrence) {
    schedule.nextRunAt = computeNextRun(schedule.recurrence);
    registerAlarm(schedule);
  }
  if (schedule.type === 'once') {
    schedule.enabled = false;
  }

  schedules[scheduleId] = schedule;
  await saveSchedules(schedules);

  sendNotification(schedule, finalResult);
  setBadge(finalResult.status);
  // Direct desktop notification — always fires (not gated by sound setting)
  try {
    chrome.notifications.create('scheduled-' + scheduleId + '-' + Date.now(), {
      type: 'basic',
      iconUrl: 'icon-128.png',
      title: 'Scheduled Run Complete',
      message: `"${schedule.name || scheduleId}" finished · Check results in extension popup`,
      priority: 2
    });
  } catch (_e) {}
  tel.info('scheduler', `Scheduled task ${schedule.name} completed`, { status: finalResult.status });
  _fireAgentCompleteCallbacks();
}

// ========== Execution Helpers ==========

/**
 * Resolve the goal string for a schedule, applying template params if needed.
 * @param {object} schedule
 * @returns {Promise<string>}
 */
async function _resolveGoalForSchedule(schedule) {
  if (schedule.templateId) {
    return resolveTemplateGoal(schedule.templateId, schedule.params || {});
  }
  return schedule.goal;
}

/**
 * Get the active tab ID, creating a new blank tab if no active tab exists.
 * @returns {Promise<number>} The tab ID to use
 */
async function _getOrCreateTab() {
  const tabs = await new Promise(resolve => {
    chrome.tabs.query({ active: true, currentWindow: true }, (t) => {
      if (chrome.runtime.lastError) {

        resolve([]);
        return;
      }
      resolve(t || []);
    });
  });
  if (tabs?.[0]?.id && typeof tabs[0].id === 'number') return tabs[0].id;
  const newTab = await chrome.tabs.create({ url: 'about:blank' });
  await new Promise(resolve => setTimeout(resolve, FIVE_HUNDRED_MS));
  if (newTab && newTab.id) return newTab.id;
  throw new Error('Failed to create tab');
}

/**
 * Wait for the agent to send an agent_loop_complete message, with a timeout.
 * Returns the promise AND a cancel() function that cleans up the timer and
 * listener if the caller needs to abort early (e.g. startAgent threw before
 * the agent ever ran).
 * @param {number} timeoutMs
 * @returns {{ promise: Promise<{ status: string, error: string|null, report: string|null }>, cancel: () => void }}
 */
function _waitForAgentCompletion(timeoutMs) {
  let _resolve;
  const promise = new Promise((resolve) => { _resolve = resolve; });

  const timer = setTimeout(() => {
    chrome.runtime.onMessage.removeListener(listener);
    _resolve({ status: 'failure', error: 'Agent execution timed out after 5 minutes', report: null });
  }, timeoutMs);

  const listener = (msg) => {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    if (msg.action === 'agent_loop_complete') {
      clearTimeout(timer);
      chrome.runtime.onMessage.removeListener(listener);
      _resolve({ status: 'success', error: null, report: msg.report || null });
    } else if (msg.action === 'agent_finished' && msg.summary && CRASH_SUMMARY_RE.test(msg.summary)) {
      // runAgentLoop crashed — agent_loop_complete will never come; fail fast instead of waiting 5 min
      clearTimeout(timer);
      chrome.runtime.onMessage.removeListener(listener);
      _resolve({ status: 'failure', error: msg.summary || 'Agent crashed unexpectedly', report: null });
    }
  };
  chrome.runtime.onMessage.addListener(listener);

  const cancel = () => {
    clearTimeout(timer);
    chrome.runtime.onMessage.removeListener(listener);
  };

  return { promise, cancel };
}

/**
 * Persist a failure result and update the schedule's last-run state.
 * Re-registers the alarm for recurring schedules before returning.
 * @param {object} schedule
 * @param {string} scheduleId
 * @param {object} schedules - Full schedules map (mutated in place)
 * @param {object} resultPartial - { id?, startedAt, error } for storeResult
 */
async function _handleTaskFailure(schedule, scheduleId, schedules, resultPartial) {
  await storeResult(schedule, {
    id: resultPartial.id,
    status: 'failure',
    startedAt: resultPartial.startedAt,
    completedAt: Date.now(),
    report: null,
    error: resultPartial.error,
  });
  schedule.lastRunStatus = 'failure';
  schedule.lastRunAt = Date.now();
  schedules[scheduleId] = schedule;
  await saveSchedules(schedules);
  if (schedule.type === 'recurring' && schedule.recurrence) {
    schedule.nextRunAt = computeNextRun(schedule.recurrence);
    registerAlarm(schedule);
  }
  sendNotification(schedule, { id: resultPartial.id, status: 'failure', error: resultPartial.error, completedAt: Date.now() });
  setBadge('failure');
}

/**
 * Store a result record, enforcing the MAX_RESULTS cap per schedule.
 * @param {object} schedule
 * @param {object} result
 */
async function storeResult(schedule, result) {
  const results = await loadResults();

  // Ensure result has all required fields
  const fullResult = {
    id: result.id || crypto.randomUUID(),
    scheduleId: schedule.id,
    scheduleName: schedule.name,
    templateId: schedule.templateId,
    goal: result.goal || schedule.goal,
    status: result.status,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    report: result.report || null,
    error: result.error || null,
  };

  results[fullResult.id] = fullResult;

  // Enforce cap: keep only the most recent MAX_RESULTS per schedule
  const scheduleResultIds = Object.keys(results)
    .filter(rid => results[rid] && results[rid].scheduleId === schedule.id)
    .sort((a, b) => (results[b].completedAt || 0) - (results[a].completedAt || 0));

  if (scheduleResultIds.length > MAX_RESULTS) {
    const toRemove = scheduleResultIds.slice(MAX_RESULTS);
    for (const rid of toRemove) {
      delete results[rid];
    }
  }

  await saveResults(results);
  return fullResult;
}

// ========== Result Queries ==========

/**
 * Get results for a specific schedule, sorted by completedAt desc, limited to 20.
 * @param {string} scheduleId
 * @returns {Promise<Array<object>>}
 */
export async function getScheduleResults(scheduleId) {
  if (!scheduleId || typeof scheduleId !== 'string') return [];

  const results = await loadResults();
  return Object.values(results)
    .filter(r => r && r.scheduleId === scheduleId)
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))
    .slice(0, 20);
}

/**
 * Get recent results across all schedules, sorted by completedAt desc.
 * @param {number} [limit=20]
 * @returns {Promise<Array<object>>}
 */
export async function getRecentResults(limit = 20) {
  const results = await loadResults();
  return Object.values(results)
    .filter(r => r != null)
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))
    .slice(0, limit);
}

/**
 * Clear all results for a specific schedule.
 * @param {string} scheduleId
 * @returns {Promise<void>}
 */
export async function clearScheduleResults(scheduleId) {
  if (!scheduleId || typeof scheduleId !== 'string') {
    throw new Error('Schedule ID is required');
  }

  const results = await loadResults();
  const toRemove = Object.keys(results).filter(rid => results[rid] && results[rid].scheduleId === scheduleId);
  for (const rid of toRemove) {
    delete results[rid];
  }
  await saveResults(results);
}

// ========== Initialization ==========

/**
 * Initialize the scheduler on service worker startup.
 * Re-registers alarms for all enabled schedules that don't already have one.
 * This handles browser restart alarm loss.
 */
export async function initScheduler() {
  tel.info('scheduler', 'Initializing scheduler...');
  const schedules = await loadSchedules();

  for (const [id, schedule] of Object.entries(schedules)) {
    if (!schedule.enabled) continue;

    try {
      const alarm = await new Promise(resolve => {
        chrome.alarms.get(`schedule-${id}`, (a) => {
          if (chrome.runtime.lastError) {

            resolve(undefined);
            return;
          }
          resolve(a);
        });
      });

      if (!alarm) {
        // Recompute nextRunAt if it's in the past
        if (!schedule.nextRunAt || schedule.nextRunAt <= Date.now()) {
          if (schedule.recurrence) {
            schedule.nextRunAt = computeNextRun(schedule.recurrence);
          } else {
            schedule.nextRunAt = Date.now() + ONE_HOUR_MS; // 1 hour from now
          }
          schedules[id] = schedule;
        }
        registerAlarm(schedule);
        tel.debug('scheduler', `Re-registered alarm for schedule: ${schedule.name}`);
      }
    } catch (err) {
      console.error(`Failed to check/register alarm for schedule ${schedule.name}:`, getErrorMessage(err));
    }
  }

  // Save any updated schedules
  await saveSchedules(schedules);
  const _enabledCount = Object.values(schedules).reduce((acc, s) => acc + (s.enabled ? 1 : 0), 0);
  tel.info('scheduler', `Scheduler initialized. ${_enabledCount} enabled schedules.`);
}
