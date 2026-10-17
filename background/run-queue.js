// Run Queue Manager — v12 Multi-Agent Support
// Manages concurrent agent runs across multiple tabs.

const MAX_CONCURRENT_RUNS = 5;

const runQueue = {
  active: new Map(),   // tabId -> { goal, status, startTime, promise }
  pending: [],         // [{ goal, tabId, resolve, reject }]
  completed: [],       // [{ goal, tabId, status, duration, result }]
  _maxCompleted: 50    // Keep last 50 completed runs
};

/**
 * Check if a new run can be started.
 * @returns {{ canStart: boolean, reason?: string }}
 */
export function canStartRun(tabId) {
  // Don't allow duplicate runs on same tab
  if (runQueue.active.has(tabId)) {
    return { canStart: false, reason: 'Tab already has an active run' };
  }
  // Check concurrent limit
  if (runQueue.active.size >= MAX_CONCURRENT_RUNS) {
    return { canStart: false, reason: `Max concurrent runs (${MAX_CONCURRENT_RUNS}) reached` };
  }
  return { canStart: true };
}

/**
 * Register a run as active.
 */
export function registerRun(tabId, goal, promise) {
  runQueue.active.set(tabId, {
    goal,
    status: 'running',
    startTime: Date.now(),
    promise
  });
}

/**
 * Mark a run as completed.
 */
export function completeRun(tabId, result) {
  const run = runQueue.active.get(tabId);
  if (!run) return;

  const r = result || {};
  const completed = {
    goal: run.goal,
    tabId,
    status: r.error ? 'failed' : 'completed',
    duration: Date.now() - run.startTime,
    result: r.summary || '',
    timestamp: Date.now()
  };

  runQueue.active.delete(tabId);
  runQueue.completed.push(completed);

  // Trim completed list
  if (runQueue.completed.length > runQueue._maxCompleted) {
    runQueue.completed = runQueue.completed.slice(-runQueue._maxCompleted);
  }

  // Process next pending run
  _processNextPending();

  return completed;
}

/**
 * Queue a run for later execution.
 */
export function queueRun(goal, tabId) {
  return new Promise((resolve, reject) => {
    runQueue.pending.push({ goal, tabId, resolve, reject });
  });
}

/**
 * Get current queue status.
 */
export function getQueueStatus() {
  return {
    activeCount: runQueue.active.size,
    pendingCount: runQueue.pending.length,
    maxConcurrent: MAX_CONCURRENT_RUNS,
    activeRuns: Array.from(runQueue.active.entries()).map(([tabId, run]) => ({
      tabId,
      goal: (run.goal || '').substring(0, 100),
      duration: Date.now() - run.startTime
    })),
    completedCount: runQueue.completed.length,
    recentCompleted: runQueue.completed.slice(-5)
  };
}

/**
 * Cancel a pending run.
 */
export function cancelPendingRun(goal) {
  const idx = runQueue.pending.findIndex(r => r.goal === goal);
  if (idx === -1) return false;
  const [removed] = runQueue.pending.splice(idx, 1);
  removed.reject(new Error('Run cancelled'));
  return true;
}

/**
 * Process the next pending run if capacity allows.
 * @private
 */
function _processNextPending() {
  if (runQueue.pending.length === 0) return;
  if (runQueue.active.size >= MAX_CONCURRENT_RUNS) return;

  const next = runQueue.pending.shift();
  // The caller (startAgent) will handle the actual execution
  // We just signal that this run can proceed
  next.resolve({ canStart: true, tabId: next.tabId });
}

/**
 * Reset the entire queue.
 */
export function resetQueue() {
  runQueue.active.clear();
  runQueue.pending.forEach(p => p.reject(new Error('Queue reset')));
  runQueue.pending.length = 0;
  runQueue.completed.length = 0;
}
