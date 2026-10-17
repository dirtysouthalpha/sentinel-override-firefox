// background/trust-score.js
// Run Trust Score — v3.30.0
//
// Derives a 0-100 score for each completed run that captures "how well did
// the agent actually do" in a single number. Surfaces in the report card,
// the run-log list, and (eventually) historical trend charts.
//
// Design constraints:
//   - Pure function. No chrome.* dependencies. Testable in isolation.
//   - Single canonical computation — every consumer reads the same number.
//   - Decomposes into a `breakdown` object so the UI can show *why* a run
//     scored what it did, not just the final number.
//   - Default-safe: missing metrics map to neutral contributions, not 0.
//
// Component weights (sum to 100):
//   - 40  Failure rate           1 - (failed / totalSteps)
//   - 20  Productive density     productive / totalSteps
//   - 15  Recovery effectiveness skill success rate (if any fired)
//   - 10  Plan adherence         completed / planLength
//   - 10  Token efficiency       1 - clamp(apiCallCount / productive, 0, 1)
//    -5  Safety incidents       deducted, not added
//
// The score is the sum of component contributions. Each component handles
// missing/edge data (zero steps, zero plan, etc.) with documented fallbacks.

// Precompile regex for performance optimization
const GOOD_BAND_RE = /^(high|good)$/;

/**
 * Compute a trust score from agent-run metrics.
 *
 * @param {object} m
 * @param {number} m.totalSteps      Total agent loop iterations
 * @param {number} m.failedSteps     Steps where actionFailed = true
 * @param {number} m.productiveSteps Steps that produced output (extract/note/finish-blocker)
 * @param {number} [m.consecutiveFailureMax] Longest streak of consecutive failures
 * @param {object} [m.skillStats]    Per-skill { fires, successes } map for this run
 * @param {number} [m.apiCallCount]  LLM API calls made this run
 * @param {number} [m.planLength]    Number of steps in the pre-flight plan (or 0 if none)
 * @param {number} [m.planCompleted] How many plan steps were marked done
 * @param {number} [m.safetyBlocks]  Sensitive-field / cross-tenant / CSP blocks
 * @returns {{score: number, band: string, breakdown: object}}
 */
export function computeTrustScore(m) {
  if (!m || typeof m !== 'object') return { score: 0, band: 'unknown', breakdown: {} };
  const totalSteps = Math.max(0, Number(m.totalSteps) || 0);
  const failedSteps = Math.max(0, Math.min(totalSteps, Number(m.failedSteps) || 0));
  const productiveSteps = Math.max(0, Math.min(totalSteps, Number(m.productiveSteps) || 0));
  const apiCallCount = Math.max(0, Number(m.apiCallCount) || 0);
  const safetyBlocks = Math.max(0, Number(m.safetyBlocks) || 0);
  const planLength = Math.max(0, Number(m.planLength) || 0);
  const planCompleted = Math.max(0, Math.min(planLength, Number(m.planCompleted) || 0));
  const consecutiveFailureMax = Math.max(0, Number(m.consecutiveFailureMax) || 0);

  // 1. Failure rate — 40 points max
  // Pure ratio: every step that succeeded contributes. If a run only ran 1
  // step and it failed, that's 0/40. If 0 total steps (somehow), give the
  // benefit of the doubt at 40 — there's no failure data to penalize on.
  const failureRate = totalSteps > 0 ? (failedSteps / totalSteps) : 0;
  // Stiff penalty for long failure streaks even if overall rate looks ok.
  // A streak of 3+ means the agent got stuck — deduct an extra 5 points per
  // streak-step beyond 2, capped so this alone can't tank the component.
  const streakPenalty = Math.min(20, Math.max(0, consecutiveFailureMax - 2) * 5);
  const failurePts = Math.max(0, 40 * (1 - failureRate) - streakPenalty);

  // 2. Productive density — 20 points max
  // Productive steps are the ones the agent had something to show for. A run
  // with 10 steps where 8 produced output is in much better shape than 10
  // steps where 1 produced output. We cap at 1.0 (more productive than total
  // is technically impossible but we clamp).
  const productivityRate = totalSteps > 0 ? Math.min(1, productiveSteps / totalSteps) : 1;
  const productivityPts = 20 * productivityRate;

  // 3. Recovery effectiveness — 15 points max
  // Did skills that fired actually rescue the run? If no skills fired,
  // there was nothing to recover from, so the agent gets the full 15.
  let recoveryRate = 1;  // default: nothing fired, give credit
  let totalSkillFires = 0;
  let totalSkillSuccesses = 0;
  if (m.skillStats && typeof m.skillStats === 'object') {
    for (const stat of Object.values(m.skillStats)) {
      if (!stat) continue;
      totalSkillFires += stat.fires || 0;
      totalSkillSuccesses += stat.successes || 0;
    }
    if (totalSkillFires > 0) {
      recoveryRate = totalSkillSuccesses / totalSkillFires;
    }
  }
  const recoveryPts = 15 * recoveryRate;

  // 4. Plan adherence — 10 points max
  // If we didn't pre-plan, default to full credit (this isn't an unplanned-
  // run penalty). If we did plan and finished most of it, score scales.
  const planRate = planLength > 0 ? Math.min(1, planCompleted / planLength) : 1;
  const planPts = 10 * planRate;

  // 5. Token efficiency — 10 points max
  // Reasonable ratio is roughly 1-2 API calls per productive step (the LLM
  // gets to choose + execute + maybe verify). Above 3 starts to feel
  // wasteful. Below 1 is impossibly efficient and we cap at full.
  // If productiveSteps is 0, we have no signal — give full credit to avoid
  // penalizing legitimate observe-only runs.
  let efficiencyPts = 10;
  if (productiveSteps > 0) {
    const ratio = apiCallCount / productiveSteps;
    const normalized = Math.min(1, Math.max(0, (3 - ratio) / 2));
    efficiencyPts = 10 * normalized;
  }

  // 6. Safety incidents — deduct up to 5 points
  // Each blocked sensitive-field type / cross-tenant action / CSP failure
  // deducts 2 points, capped at 5. This is small on purpose — safety blocks
  // are GOOD outcomes (we prevented something bad). The deduction reflects
  // the underlying request being suspect, not the block being unwelcome.
  const safetyPenalty = Math.min(5, safetyBlocks * 2);

  const breakdown = {
    failure: { points: round(failurePts), max: 40, rate: round(failureRate, 3), streakPenalty: round(streakPenalty), consecutiveFailureMax },
    productivity: { points: round(productivityPts), max: 20, rate: round(productivityRate, 3) },
    recovery: { points: round(recoveryPts), max: 15, rate: round(recoveryRate, 3), fires: totalSkillFires, successes: totalSkillSuccesses },
    plan: { points: round(planPts), max: 10, rate: round(planRate, 3), planLength, planCompleted },
    efficiency: { points: round(efficiencyPts), max: 10, ratio: productiveSteps > 0 ? round(apiCallCount / productiveSteps, 2) : null },
    safety: { points: -round(safetyPenalty), max: 0, blocks: safetyBlocks }
  };

  // Sum and clamp.
  const raw = failurePts + productivityPts + recoveryPts + planPts + efficiencyPts - safetyPenalty;
  const score = Math.max(0, Math.min(100, Math.round(raw)));

  return { score, band: trustBand(score), breakdown };
}

/**
 * Map a numeric score to a coarse trust band. UI uses this to pick a color
 * and label. Boundaries chosen so that "good" requires not just lack of
 * failures but actual productive output.
 */
export function trustBand(score) {
  const n = Number(score);
  if (!isFinite(n)) return 'unknown';
  if (n >= 80) return 'high';
  if (n >= 60) return 'good';
  if (n >= 40) return 'questionable';
  return 'low';
}

/**
 * Human-readable one-line summary for a score + breakdown. Used in toast
 * messages and the run-log row hover-tip.
 */
export function describeTrustScore(scoreResult) {
  if (!scoreResult || typeof scoreResult.score !== 'number') return 'Trust score unavailable';
  const { score, band, breakdown = {} } = scoreResult;
  const parts = [];
  const safeDelta = (comp) => (comp && typeof comp.max === 'number' && typeof comp.points === 'number') ? comp.max - comp.points : 0;
  // Lead with the dominant factor (largest gap from max).
  const components = [
    { name: 'failure',      delta: safeDelta(breakdown.failure) },
    { name: 'productivity', delta: safeDelta(breakdown.productivity) },
    { name: 'recovery',     delta: safeDelta(breakdown.recovery) },
    { name: 'plan',         delta: safeDelta(breakdown.plan) },
    { name: 'efficiency',   delta: safeDelta(breakdown.efficiency) },
  ];
  components.sort((a, b) => b.delta - a.delta);
  if (components[0]?.delta > 5) parts.push(`weak ${components[0].name}`);
  if (breakdown.safety) { const blocks = breakdown.safety.blocks; if (blocks > 0) parts.push(`${blocks} safety block${blocks > 1 ? 's' : ''}`); }
  const suffix = parts.length ? ` (${parts.join(', ')})` : '';
  return `Trust ${score}/100 · ${band}${suffix}`;
}

function round(n, digits = 0) {
  if (!isFinite(n)) return 0;
  const m = Math.pow(10, digits);
  return Math.round(n * m) / m;
}

// ==========================================================================
// (3.31.0) Score-driven retry suggestions
// ==========================================================================
//
// Turn a low trust score from "a number you read" into "an action you can
// take." After every run, the engine inspects the breakdown and emits 0-3
// suggested re-run configurations targeting the weakest component(s). The
// chat renders these as one-click apply cards.
//
// Each suggestion has:
//   - id           stable identifier (used to dedupe + persist user-rejected suggestions)
//   - label        button text ("Re-run with approval mode")
//   - reason       one-liner explaining WHY ("12 failures — approval mode would let you catch each one")
//   - severity     'high' | 'medium' | 'low' — drives card border color
//   - applyKeys    storage keys to set before re-running
//   - applyValues  values to write for those keys
//
// applyKeys/applyValues are applied in order. The chat-side handler sets
// each key in chrome.storage.local, then re-fires the most recent goal as
// a new run. If applyKeys is empty, the suggestion is informational only —
// the user has to act manually (e.g. "Verify expected tenant before retry").

/**
 * Generate retry suggestions based on a trust-score result. Returns an
 * empty array when the score is high/good — no nudge needed for healthy runs.
 *
 * @param {{score, band, breakdown}} scoreResult
 * @returns {Array<{id, label, reason, severity, applyKeys, applyValues}>}
 */
export function suggestRetryActions(scoreResult) {
  if (!scoreResult || typeof scoreResult.score !== 'number') return [];
  if (GOOD_BAND_RE.test(scoreResult.band)) return [];

  const bd = scoreResult.breakdown || {};
  const suggestions = [];
  const severity = scoreResult.band === 'low' ? 'high' : 'medium';

  const gap = (comp) => {
    if (!comp || typeof comp.points !== 'number' || typeof comp.max !== 'number' || comp.max === 0) return 0;
    return Math.max(0, (comp.max - comp.points) / comp.max);
  };
  const failureGap = gap(bd.failure);
  const productivityGap = gap(bd.productivity);
  const recoveryGap = gap(bd.recovery);
  const planGap = gap(bd.plan);
  const efficiencyGap = gap(bd.efficiency);
  const safetyBlocks = (bd.safety && bd.safety.blocks) || 0;

  if (failureGap > 0.4) {
    const streakLen = (bd.failure && bd.failure.consecutiveFailureMax) || 0;
    const streakNote = streakLen > 2 ? ` with a ${streakLen}+ failure streak` : '';
    suggestions.push({
      id: 'retry-approval-mode',
      label: 'Re-run with approval mode',
      reason: `High failure rate${streakNote} - approval mode lets you catch each step before it commits.`,
      severity,
      applyKeys: ['approvalMode'],
      applyValues: [true]
    });
  }

  if (recoveryGap > 0.5 && bd.recovery && typeof bd.recovery.fires === 'number' && bd.recovery.fires >= 3) {
    suggestions.push({
      id: 'reset-skills-and-retry',
      label: 'Reset skill stats and retry',
      reason: `Recovery skills fired ${bd.recovery.fires} times but only succeeded ${bd.recovery.successes || 0}. The adaptive priorities may be miscalibrated - reset to start fresh.`,
      severity,
      applyKeys: [],
      applyValues: []
    });
  }

  if (planGap > 0.4 && bd.plan && bd.plan.planLength > 0) {
    suggestions.push({
      id: 'enable-adaptive-prompts',
      label: 'Re-run with Adaptive Prompts',
      reason: `Only completed ${bd.plan.planCompleted}/${bd.plan.planLength} planned steps. Adaptive Prompts will rewrite the goal for the detected platform before execution.`,
      severity,
      applyKeys: ['adaptivePromptsMode', 'adaptiveExpansionMode'],
      applyValues: ['auto', 'light']
    });
  }

  if (productivityGap > 0.5 && bd.productivity && bd.productivity.rate < 0.3) {
    suggestions.push({
      id: 'refine-goal',
      label: 'Refine the goal and retry',
      reason: `Only ${Math.round(bd.productivity.rate * 100)}% of steps produced output. Try a more concrete goal - name the specific portal, the exact data to extract, and the deliverable format.`,
      severity: 'medium',
      applyKeys: [],
      applyValues: []
    });
  }

  if (efficiencyGap > 0.5 && bd.efficiency && bd.efficiency.ratio && bd.efficiency.ratio > 2.5) {
    suggestions.push({
      id: 'try-leaner-model',
      label: 'Try a leaner model',
      reason: `Used ${bd.efficiency.ratio} API calls per productive step. A smaller/faster model may give cleaner runs at lower cost.`,
      severity: 'low',
      applyKeys: [],
      applyValues: []
    });
  }

  if (safetyBlocks >= 2) {
    suggestions.push({
      id: 'verify-tenant-before-retry',
      label: 'Verify expected tenant',
      reason: `${safetyBlocks} safety blocks fired (cross-tenant or sensitive-field). Confirm the expected tenant in Settings before re-running so the agent stays scoped.`,
      severity: 'high',
      applyKeys: [],
      applyValues: []
    });
  }

  return suggestions.slice(0, 3);
}
