// (A1 fix 3) SW watchdog — give the sw_heartbeat alarm a job.
// History: the heartbeat alarm fires every 0.5 min (created in index.js) but
// its handler only logged. Two failure modes slipped through:
//   1. A run that hung mid-step kept agentRunning=true forever, silently
//      blocking every future start.
//   2. An interrupted run (SW death) was only recovered on SW wake or when the
//      popup asked — never re-checked periodically.
// This module is the tick body: a pure decision (evaluateTick) plus an async
// executor (runWatchdogTick) with every IO injected, so the decision logic is
// unit-testable without chrome.

export const DEFAULT_STALL_LIMIT_MS = 5 * 60 * 1000;   // no checkpoint progress for 5 min => stalled
export const AUTO_RESUME_WINDOW_MS = 10 * 60 * 1000;   // mirrors the SW-wake self-heal window in index.js

/**
 * Decide what the watchdog should do on this tick.
 * @param {object} s
 * @param {boolean} s.memoryRunning  in-memory agentRunning flag (this SW instance)
 * @param {boolean} [s.paused]       agent loop paused (paused runs write no checkpoints — never stall-stop them)
 * @param {object|null} [s.session]  chrome.storage.session {agentRunning, agentGoal, agentStartTime} or null
 * @param {object|null} [s.checkpoint] agent_checkpoint ({lastUpdate, lastGoal, ...}) or null
 * @param {number} s.now             current epoch ms
 * @param {number} [s.stallLimitMs]
 * @param {number} [s.resumeWindowMs]
 * @returns {{action: 'ok'|'idle'|'stop_stalled'|'resume'|'clear_stale_flags', stalledMs?: number, ageMs?: number, reason?: string}}
 */
export function evaluateTick({ memoryRunning, paused = false, session = null, checkpoint = null, now, stallLimitMs = DEFAULT_STALL_LIMIT_MS, resumeWindowMs = AUTO_RESUME_WINDOW_MS }) {
  const sessRunning = !!(session && session.agentRunning);
  // Freshest available progress signal: per-step checkpoint writes carry
  // lastUpdate; before the first checkpoint, the run start time anchors us.
  const lastProgress = Math.max((checkpoint && checkpoint.lastUpdate) || 0, (session && session.agentStartTime) || 0);

  if (memoryRunning) {
    if (paused) return { action: 'ok', reason: 'paused runs are exempt from stall detection' };
    if (sessRunning && lastProgress > 0 && now - lastProgress > stallLimitMs) {
      const stalledMs = now - lastProgress;
      return { action: 'stop_stalled', stalledMs, reason: `no checkpoint progress for ${Math.round(stalledMs / 1000)}s` };
    }
    return { action: 'ok' };
  }

  // In-memory flag is down — does session storage still claim an active run?
  // (SW restart lost the flag, or the wake self-heal never ran / failed.)
  if (sessRunning && session.agentGoal) {
    const ageMs = now - ((session && session.agentStartTime) || 0);
    if (ageMs < resumeWindowMs && checkpoint && checkpoint.lastGoal) {
      return { action: 'resume', ageMs };
    }
    return { action: 'clear_stale_flags', ageMs };
  }
  return { action: 'idle' };
}

/**
 * Gather state, decide, act. All IO is injected so tests run without chrome.
 * @param {object} d deps: isRunning, isPaused, getSessionState, getCheckpoint, now,
 *   stopAgent, startAgent, restoreFromCheckpoint, clearCheckpoint, clearSessionFlags, log
 * @returns {Promise<object>} the verdict (+ what was done)
 */
export async function runWatchdogTick(d) {
  const {
    isRunning, isPaused, getSessionState, getCheckpoint, now,
    stopAgent, startAgent, restoreFromCheckpoint, clearCheckpoint, clearSessionFlags,
    log = () => {}
  } = d;
  const [memoryRunning, paused, session, checkpoint] = await Promise.all([
    Promise.resolve(isRunning()).catch(() => false),
    Promise.resolve(isPaused ? isPaused() : false).catch(() => false),
    Promise.resolve(getSessionState()).catch(() => null),
    Promise.resolve(getCheckpoint()).catch(() => null)
  ]);
  const verdict = evaluateTick({ memoryRunning, paused, session, checkpoint, now: now() });

  if (verdict.action === 'stop_stalled') {
    log('warn', '[Sentinel/watchdog] Run stalled — stopping it', verdict);
    try { await stopAgent(); verdict.stopped = true; }
    catch (e) {
      log('error', '[Sentinel/watchdog] stopAgent failed', { error: String(e) });
      verdict.stopped = false; verdict.error = String(e);
    }
    return verdict;
  }

  if (verdict.action === 'resume') {
    log('info', '[Sentinel/watchdog] Orphaned run detected — resuming from checkpoint', verdict);
    try {
      const result = await restoreFromCheckpoint();
      if (!result || !result.restored) {
        log('warn', '[Sentinel/watchdog] Restore failed — clearing stale flags', { error: result && result.error });
        await clearSessionFlags();
        verdict.resumed = false; verdict.error = (result && result.error) || 'restore failed';
        return verdict;
      }
      await clearCheckpoint();
      const goal = (checkpoint && checkpoint.lastGoal) || (session && session.agentGoal) || '';
      // Fire-and-forget: startAgent manages its own claim/lifecycle; the alarm
      // handler must not hold the service worker open on a full agent run.
      Promise.resolve(startAgent(goal)).catch((e) => log('error', '[Sentinel/watchdog] resume startAgent failed', { error: String(e) }));
      verdict.resumed = true;
    } catch (e) {
      log('error', '[Sentinel/watchdog] resume failed', { error: String(e) });
      verdict.resumed = false; verdict.error = String(e);
    }
    return verdict;
  }

  if (verdict.action === 'clear_stale_flags') {
    log('info', '[Sentinel/watchdog] Clearing stale run flags', verdict);
    try { await clearSessionFlags(); verdict.cleared = true; }
    catch (e) { verdict.cleared = false; verdict.error = String(e); }
    return verdict;
  }

  return verdict;
}
