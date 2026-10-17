// background/skills/index.js
// Recovery Skill Library — v3.21.0
//
// When the agent hits a failure pattern (click with no target, navigate loop,
// unproductive extract, etc.), the engine consults this library and either:
//   - Auto-applies a deterministic recovery action (no LLM call needed) — fast
//   - Injects a recovery directive into the next LLM prompt — when the
//     situation needs the LLM to choose between alternatives

import { clickNoTarget } from './click-no-target.js';
import { navigateLoop } from './navigate-loop.js';
import { unproductiveExtract } from './unproductive-extract.js';
import { selectorMiss } from './selector-miss.js';
import { consecutiveFailures } from './consecutive-failures.js';
import { emptyObservation } from './empty-observation.js';
import { slowLlmCall } from './slow-llm-call.js';
import { cspBlocked } from './csp-blocked.js';
import { authWall } from './auth-wall.js';
import { tel } from '../telemetry.js';
import { getErrorMessage } from '../error-utils.js';

const SKILLS = [
  cspBlocked,
  authWall,
  clickNoTarget,
  navigateLoop,
  selectorMiss,
  unproductiveExtract,
  emptyObservation,
  consecutiveFailures,
  slowLlmCall,
];

// Skills map for O(1) lookups by ID (perf optimization)
const SKILLS_MAP = new Map(SKILLS.map(s => [s.id, s]));

// (3.29.0) Adaptive Skill Priority
const STATS_KEY = 'skill_stats';
const ADAPT_ENABLED_KEY = 'telemetrySkillAdapt';
const MIN_FIRES_FOR_ADJUSTMENT = 3;
const MAX_PRIORITY_DELTA = 20;
let _stats = {};
let _adaptEnabled = true;
let _pendingOutcomeSkillIds = [];
let _saveStatsTimer = null;

(function loadAdaptiveState() {
  try {
    chrome.storage.local.get([STATS_KEY, ADAPT_ENABLED_KEY], (r) => {
      if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) { console.warn('[Sentinel/skills] storage load error:', getErrorMessage(chrome.runtime.lastError)); return; }
      if (r && r[STATS_KEY] && typeof r[STATS_KEY] === 'object' && r[STATS_KEY] !== null) _stats = r[STATS_KEY];
      if (r && r[ADAPT_ENABLED_KEY] === false) _adaptEnabled = false;
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[ADAPT_ENABLED_KEY]) {
        const v = changes[ADAPT_ENABLED_KEY].newValue;
        _adaptEnabled = (v == null) ? true : !!v;
      }
      if (changes[STATS_KEY]) {
        const v = changes[STATS_KEY].newValue;
        _stats = (v && typeof v === 'object') ? v : {};
      }
    });
  } catch (e) { console.warn('[Sentinel/skills] init error:', getErrorMessage(e)); }
})();

/**
 * Schedule a debounced save of skill stats to chrome.storage.local.
 * Coalesces rapid updates into a single write every 1500ms.
 * @private
 */
function _scheduleSaveStats() {
  if (_saveStatsTimer) return;
  _saveStatsTimer = setTimeout(() => {
    _saveStatsTimer = null;
    try { chrome.storage.local.set({ [STATS_KEY]: _stats }); } catch (e) { console.warn('[Sentinel/skills] stats save error:', getErrorMessage(e)); }
  }, 1500);
}

/**
 * Compute the adaptive priority for a skill based on its success rate.
 * Skills with higher success rates get a priority boost; low performers get penalized.
 * Falls back to base priority when adaptation is disabled or insufficient data.
 * @param {object} skill - Skill object with id and priority fields.
 * @returns {number} Effective priority (base + adaptive delta).
 * @private
 */
function _effectivePriority(skill) {
  const base = (skill && typeof skill.priority === 'number') ? skill.priority : 0;
  if (!_adaptEnabled) return base;
  const stat = _stats[skill.id];
  if (!stat || stat.fires < MIN_FIRES_FOR_ADJUSTMENT) return base;
  const rate = stat.successes / Math.max(stat.fires, 1);
  const delta = Math.round((rate - 0.5) * 2 * MAX_PRIORITY_DELTA);
  return base + delta;
}

/**
 * Record the outcome (success/failure) of previously pending skills.
 * Called at the start of each runRecoverySkills invocation to resolve
 * skills that were applied in the previous step.
 * @param {object} context - Agent context with lastActionFailed flag.
 * @private
 */
function _recordPendingOutcomes(context) {
  if (!Array.isArray(_pendingOutcomeSkillIds) || !_pendingOutcomeSkillIds.length) return;
  if (typeof context.lastActionFailed !== 'boolean') {
    _pendingOutcomeSkillIds = [];
    return;
  }
  const success = !context.lastActionFailed;
  const now = Date.now();
  for (const skillId of _pendingOutcomeSkillIds) {
    if (!_stats[skillId]) _stats[skillId] = { fires: 0, successes: 0, failures: 0, lastFiredAt: 0, lastOutcomeAt: 0 };
    _stats[skillId].fires++;
    if (success) _stats[skillId].successes++;
    else _stats[skillId].failures++;
    _stats[skillId].lastOutcomeAt = now;
    try {
      tel.debug('skill', `Skill outcome: ${skillId} -> ${success ? 'success' : 'failure'}`, {
        skillId,
        success,
        fires: _stats[skillId].fires,
        successes: _stats[skillId].successes,
        failures: _stats[skillId].failures,
        successRate: _stats[skillId].fires > 0 ? _stats[skillId].successes / _stats[skillId].fires : 0,
        adjustedPriority: _effectivePriority({ id: skillId, priority: (SKILLS_MAP.get(skillId) || {}).priority })
      });
    } catch (_e) { /* telemetry logging failure is non-critical */ }
  }
  _pendingOutcomeSkillIds = [];
  _scheduleSaveStats();
}

/**
 * Reset all adaptive skill statistics.
 * Clears in-memory stats and removes persisted data from chrome.storage.local.
 * @returns {Promise<void>}
 */
export async function resetSkillStats() {
  if (_saveStatsTimer) { clearTimeout(_saveStatsTimer); _saveStatsTimer = null; }
  _stats = {};
  _pendingOutcomeSkillIds = [];
  try { await chrome.storage.local.remove(STATS_KEY); } catch (_e) { console.warn('[Sentinel/skills] stats clear error:', getErrorMessage(_e)); }
  try { tel.info('skill', 'Skill outcome stats reset', {}); } catch (_e) { /* telemetry unavailable */ }
}

/**
 * Get a snapshot of current skill statistics.
 * Returns an object keyed by skill ID, each containing fires, successes,
 * failures, basePriority, effectivePriority, and successRate.
 * @returns {Object<string, {fires: number, successes: number, failures: number, lastFiredAt: number, lastOutcomeAt: number, basePriority: number|null, effectivePriority: number|null, successRate: number|null}>}
 */
export function getSkillStats() {
  const out = {};
  for (const [k, v] of Object.entries(_stats)) {
    out[k] = { ...v };
    const skill = SKILLS_MAP.get(k);
    out[k].basePriority = skill ? (skill.priority || 0) : null;
    out[k].effectivePriority = skill ? _effectivePriority(skill) : null;
    out[k].successRate = (v.fires > 0 && Number.isFinite(v.fires) && Number.isFinite(v.successes)) ? v.successes / v.fires : null;
  }
  return out;
}

/**
 * Run the recovery skill library against the current agent context.
 * Evaluates all registered skills, applies auto-recovery actions when matched,
 * and collects prompt-injection directives for the LLM.
 *
 * Records pending outcomes that will be resolved on the next call to
 * determine whether the recovery was successful.
 *
 * @param {object} context - Agent loop context including stepCount, consecutiveFailures,
 *   lastActionFailed, lastCommand, and other state the skills use to match.
 * @returns {{autoApply: object|null, promptInjection: string, appliedSkillIds: string[]}}
 */
export function runRecoverySkills(context) {
  const result = { autoApply: null, promptInjection: '', appliedSkillIds: [] };
  if (!context || typeof context !== 'object' || Array.isArray(context)) return result;

  _recordPendingOutcomes(context);

  const matches = [];
  for (const skill of SKILLS) {
    if (!skill || typeof skill.matches !== 'function') continue;
    try {
      if (skill.matches(context)) {
        matches.push(skill);
        try {
          tel.debug('skill', `Skill matched: ${skill.id}`, {
            skillId: skill.id,
            priority: skill.priority || 0,
            stepCount: context.stepCount,
            consecutiveFailures: context.consecutiveFailures,
            lastActionFailed: !!context.lastActionFailed,
            lastCommandType: context.lastCommand ? context.lastCommand.type : null
          });
        } catch (_e) { /* telemetry failure is non-critical */ }
      }
    } catch (e) {
      try { tel.error('skill', `Skill predicate threw: ${skill.id}`, { skillId: skill.id, error: getErrorMessage(e) }); } catch (_e) { /* telemetry unavailable */ }
      try { console.warn('[Sentinel/skills] predicate error in', skill.id, ':', getErrorMessage(e)); } catch (_e) { /* console unavailable */ }
    }
  }
  if (!matches.length) return result;

  matches.sort((a, b) => _effectivePriority(b) - _effectivePriority(a));

  for (const skill of matches) {
    if (typeof skill.autoApply === 'function') {
      try {
        const cmd = skill.autoApply(context);
        if (typeof cmd === 'object' && cmd !== null && cmd.type) {
          result.autoApply = cmd;
          result.appliedSkillIds.push(skill.id);
          break;
        }
      } catch (e) {
        try { console.warn('[Sentinel/skills] autoApply error in', skill.id, ':', getErrorMessage(e)); } catch (_e) { /* console unavailable */ }
      }
    }
  }

  const injections = [];
  for (const skill of matches) {
    if (typeof skill.promptInjection !== 'function') continue;
    try {
      const text = skill.promptInjection(context);
      if (typeof text === 'string' && text.trim()) {
        injections.push(`### Recovery skill: ${skill.id}\n${text.trim()}`);
        if (!result.appliedSkillIds.includes(skill.id)) {
          result.appliedSkillIds.push(skill.id);
        }
      }
    } catch (e) {
      try { console.warn('[Sentinel/skills] promptInjection error in', skill.id, ':', getErrorMessage(e)); } catch (_e) { /* console unavailable */ }
    }
  }
  if (injections.length) {
    result.promptInjection = `\n\n## RECOVERY DIRECTIVES (Sentinel skill library)\nThe engine detected a pattern that suggests a different strategy. Read these before deciding your next action:\n\n${injections.join('\n\n')}\n`;
  }

  if (result.appliedSkillIds.length) {
    const now = Date.now();
    _pendingOutcomeSkillIds = result.appliedSkillIds.slice();
    for (const id of result.appliedSkillIds) {
      if (!_stats[id]) _stats[id] = { fires: 0, successes: 0, failures: 0, lastFiredAt: 0, lastOutcomeAt: 0 };
      _stats[id].lastFiredAt = now;
    }
    _scheduleSaveStats();
  }

  return result;
}

/**
 * List all registered recovery skills with their current priority and stats.
 * Useful for diagnostic/telemetry UI surfaces.
 * @returns {Array<{id: string, description: string, priority: number, effectivePriority: number, stats: object|null}>}
 */
export function listSkills() {
  return SKILLS.map(s => ({
    id: s.id,
    description: s.description,
    priority: s.priority || 0,
    effectivePriority: _effectivePriority(s),
    stats: _stats[s.id] ? { ...(_stats[s.id]) } : null
  }));
}
