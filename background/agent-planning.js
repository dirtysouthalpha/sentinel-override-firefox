// Sentinel Override — Agent Planning Module
// Extracted from agent-engine.js: plan generation, adaptive prompts, heuristic planning.
// All functions are pure or receive dependencies as parameters — no reliance on
// agent-engine.js module-level variables.

import { generatePlan, getPlatformContext, getRelevantPatterns } from './llm-client.js';
import { rewriteGoalForPlatform } from './adaptive-prompts.js';
import { getActiveProvider } from './provider-registry.js';
import { getTabContext } from './tab-context.js';
import { sendSilentUpdate, sendAgentStatus } from './message-protocol.js';
import { captureReasoningStep } from './reasoning-trace.js';
import { analyzeForBias, shouldTriggerBiasWarning, logBiasDetection } from './bias-detector.js';
import { startSwKeepalive, stopSwKeepalive } from './shared-state.js';
import { FIVE_MINUTES_MS } from './constants.js';
import { getErrorMessage } from './error-utils.js';

// ── Regex constants for plan generation ──────────────────────────
// Duplicated from agent-engine.js to keep this module self-contained.
// These are compile-once constants; no runtime cost.

const MULTI_PAGE_GOAL_RE = /\b(top\s+\d|each|every|all|10|5|3)\b.*\b(articles?|pages?|sites?|links?|urls?|results?|sources?)\b/i;
const URL_NAV_RE = /(?:go to|navigate to|visit|check|open)\s+(https?:\/\/[^\s,]+|[\w.-]+\.(?:com|org|net|io|gov|edu|co)[^\s,]*)/i;
const URL_ANY_RE = /(https?:\/\/[^\s]+)/i;
const BARE_SITE_RE = /(?:go to|navigate to|visit|check|open)\s+(?:the\s+)?([\w\s]+?)(?:\s+(?:and|then|,|\.))?(?:\s|$)/i;
const WHITESPACE_NORMALIZE_RE = /\s+/g;
const SEARCH_LONG_RE = /(?:search|find|look up|google)\s+(?:for\s+)?["']?([^"']{10,80})/i;
const ABOUT_RE = /(?:about|on|regarding)\s+([^,.\n]{10,60})/i;
const COUNT_RE = /(?:top\s+)?(\d+)/;
const WWW_PREFIX_RE = /^www\./;

// Bare site name mapping for heuristic plan generation ("go to Amazon" -> "amazon.com")
const BARE_SITE_MAP = {
  amazon: 'amazon.com',
  reddit: 'reddit.com',
  youtube: 'youtube.com',
  twitter: 'twitter.com',
  x: 'x.com',
  github: 'github.com',
  wikipedia: 'wikipedia.org',
  hackernews: 'news.ycombinator.com',
  'hacker news': 'news.ycombinator.com',
  hn: 'news.ycombinator.com',
  google: 'google.com',
  facebook: 'facebook.com',
  instagram: 'instagram.com',
  linkedin: 'linkedin.com',
  netflix: 'netflix.com',
  yahoo: 'yahoo.com',
  bing: 'bing.com',
  duckduckgo: 'duckduckgo.com',
  stackoverflow: 'stackoverflow.com',
  'stack overflow': 'stackoverflow.com',
  cnn: 'cnn.com',
  bbc: 'bbc.com',
  nytimes: 'nytimes.com',
  espn: 'espn.com',
  weather: 'weather.gov'
};
export { BARE_SITE_MAP };

// ========== Heuristic Plan Generator ==========
// Fallback when LLM-based plan generation fails. Analyzes the goal text
// to produce a basic step-by-step plan without any API calls.

export function generateHeuristicPlan(goal, currentUrl) {
  if (!goal) return null;
  const g = goal.toLowerCase();
  const currentHost = (() => { try { return new URL(currentUrl).hostname; } catch (_urlErr) { return ''; } })();

  // Detect multi-page research patterns
  const isMultiPage = MULTI_PAGE_GOAL_RE.test(g)
    || /\b(open|visit|browse|check)\b.*\b(each|and|then)\b/i.test(g)
    || /\b(summarize?|brief|report)\b.*\b(all|each|every)\b/i.test(g);

  // Extract target URL from goal
  const urlMatch = goal.match(URL_NAV_RE)
    || goal.match(URL_ANY_RE);
  // v3.63: Also match bare site names ("go to Amazon", "go to Reddit")
  let _urlMatch = urlMatch;
  if (!_urlMatch) {
    const _bareMatch = goal.match(BARE_SITE_RE);
    if (_bareMatch && _bareMatch[1]) {
      const _siteKey = _bareMatch[1].trim().toLowerCase().replace(WHITESPACE_NORMALIZE_RE, '');
      if (BARE_SITE_MAP[_siteKey]) {
        _urlMatch = [`go to ${_bareMatch[1]}`, `https://${BARE_SITE_MAP[_siteKey]}`];
      } else {
        // Try partial match
        for (const [k, v] of Object.entries(BARE_SITE_MAP)) {
          if (_siteKey.includes(k) || k.includes(_siteKey)) {
            _urlMatch = [`go to ${_bareMatch[1]}`, `https://${v}`];
            break;
          }
        }
      }
    }
  }
  const urlMatchFinal = _urlMatch;
  const targetUrl = urlMatchFinal && urlMatchFinal[1] ? urlMatchFinal[1] : null;
  const targetHost = targetUrl ? (() => { try { return new URL(targetUrl).hostname.replace(WWW_PREFIX_RE, ''); } catch (_urlErr) { return ''; } })() : '';
  const _normHost = currentHost.replace(WWW_PREFIX_RE, '');
  const alreadyThere = targetHost && (_normHost === targetHost || _normHost.endsWith('.' + targetHost));

  // Extract search query from goal
  const searchMatch = goal.match(SEARCH_LONG_RE)
    || goal.match(ABOUT_RE);
  const searchQuery = searchMatch && searchMatch[1] && typeof searchMatch[1] === 'string' ? searchMatch[1].trim() : null;

  // Extract count
  const countMatch = goal.match(COUNT_RE);
  const count = countMatch && countMatch[1] ? (parseInt(countMatch[1], 10) || 10) : 10;

  if (isMultiPage) {
    const steps = [];
    if (targetUrl && !alreadyThere) {
      steps.push(`Navigate to ${targetUrl}`);
    } else if (searchQuery) {
      steps.push(`Search Google for "${searchQuery}"`);
    }
    steps.push(`Use execute_js with key "links" to extract article/result links from the page`);
    steps.push(`Review extracted links and identify the ${count} most relevant ones`);
    for (let i = 1; i <= Math.min(count, 10); i++) {
      steps.push(`Open article ${i} in a new tab, read it, and note a brief summary`);
    }
    steps.push(`Close all article tabs`);
    steps.push(`Finish with a combined summary of all ${count} items`);
    return steps;
  }

  if (targetUrl && !alreadyThere) {
    return [
      `Navigate to ${targetUrl}`,
      'Read the page content',
      'Extract key information using execute_js with key "data"',
      'Finish with a summary of findings'
    ];
  }

  if (searchQuery) {
    return [
      `Search Google for "${searchQuery}"`,
      'Read search results and extract top links',
      'Visit the most relevant result',
      'Read and extract key information',
      'Finish with a summary'
    ];
  }

  // Generic fallback
  return [
    'Read the current page',
    'Extract key information',
    'If needed, navigate to find more data',
    'Finish with a summary'
  ];
}

// ========== Initial Plan Generation ==========

// Generate the initial execution plan before the agent loop starts.
// In quick mode, skips planning and returns null. Otherwise tries LLM planning
// first and falls back to a heuristic plan if the LLM call fails.
//
// @param {string} goal - The agent's goal text
// @param {number} workingTabId - Tab ID for context lookup
// @param {Object} runSettings - Run-stable settings (previously _runSettings module var)
// @returns {Promise<string[]|null>} Plan steps or null

export async function _generateInitialPlan(goal, workingTabId, runSettings) {
  if (runSettings.quickMode) {
    sendSilentUpdate('⚡ Quick Mode — executing directly');
    return null;
  }
  sendSilentUpdate('Planning task...');
  sendAgentStatus('planning', 'Generating task plan...');
  const planProviderConfig = await getActiveProvider();
  if (!planProviderConfig) {
    sendSilentUpdate('No provider configured — cannot generate plan');
    return null;
  }
  const planSettings = {
    api_endpoint: planProviderConfig.endpoint,
    api_key: planProviderConfig.apiKey,
    model: planProviderConfig.model
  };
  const currentTabInfo = await getTabContext(workingTabId);
  const platformCtx = getPlatformContext(currentTabInfo?.url || '', goal);
  const patterns = await getRelevantPatterns(goal);
  // v10.0: Capture reasoning for plan generation
  await captureReasoningStep('plan_generation', 'input', {
    goal,
    url: currentTabInfo?.url || '',
    title: currentTabInfo?.title || '',
    platformContext: platformCtx,
    patterns: patterns.length
  });
  let plan = await generatePlan(goal, planSettings, {
    currentUrl: currentTabInfo?.url || '',
    pageTitle: currentTabInfo?.title || '',
    platformContext: platformCtx,
    relevantPatterns: patterns
  });
  // v10.0: Capture plan result and check for bias
  await captureReasoningStep('plan_generation', 'output', {
    planSteps: plan?.length || 0,
    firstStep: plan?.[0] || 'none'
  });
  // Analyze plan for potential bias
  const planBiasAnalysis = analyzeForBias(plan?.join('\n') || '');
  if (planBiasAnalysis.hasBias && shouldTriggerBiasWarning(planBiasAnalysis)) {
    console.warn('[Sentinel] Plan bias detected:', planBiasAnalysis);
    logBiasDetection(planBiasAnalysis, 'plan_generation');
  }
  if (plan) {
    sendSilentUpdate(`📋 Plan ready (${plan.length} steps): ${plan[0] || ''}`);
    return plan;
  }
  // Fallback: heuristic plan from goal analysis
  plan = generateHeuristicPlan(goal, currentTabInfo?.url || '');
  if (plan) {
    sendSilentUpdate(`📋 Basic plan (${plan.length} steps): ${plan[0] || ''}`);
  } else {
    sendSilentUpdate('Running in direct mode');
  }
  return plan;
}

// ========== Adaptive Prompts ==========

// (3.15.0) Approval flow for Adaptive Prompts. Broadcasts the rewritten goal
// to the popup, waits for the user's decision via adapted_goal_response, and
// keeps the SW alive during the wait.

export async function _waitForAdaptedGoalDecision(rewriteResult, _startTabId) {
  const requestId = crypto.randomUUID();
  const kaName = `adaptive_prompt_${requestId}`;
  try { startSwKeepalive(kaName); } catch (e) { console.error('[Sentinel] Error in agent-planning.js:', getErrorMessage(e)); }
  return new Promise((resolve) => {
    const finish = (payload) => {
      try { stopSwKeepalive(kaName); } catch (e) { console.error('[Sentinel] Error in agent-planning.js:', getErrorMessage(e)); }
      resolve(payload);
    };
    chrome.runtime.sendMessage({
      action: 'adapted_goal_available',
      mode: 'approval',
      requestId,
      platform: rewriteResult.platform,
      summary: rewriteResult.summary,
      mismatchHints: rewriteResult.mismatchHints,
      originalGoal: rewriteResult.originalGoal,
      adaptedGoal: rewriteResult.adaptedGoal
    }).catch((e) => {
      console.error('[finish] Unhandled rejection:', e);
    });
    const listener = (message) => {
      if (message && message.action === 'adapted_goal_response' && message.requestId === requestId) {
        chrome.runtime.onMessage.removeListener(listener);
        clearTimeout(timeoutId);
        finish({
          approved: !!message.approved,
          useOriginal: !!message.useOriginal,
          edited: !!message.edited,
          editedGoal: message.editedGoal
        });
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    // Cap at 5 minutes — if the user walks away, proceed with adapted goal
    // rather than blocking the run forever.
    const timeoutId = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      finish({ approved: true, useOriginal: false, edited: false, reason: 'approval_timeout_default_adapted' });
    }, FIVE_MINUTES_MS);
  });
}

// (3.15.0) Run the adaptive-prompts platform-rewrite pass before agent execution.
// Reads user settings, calls rewriteGoalForPlatform, handles the approval flow
// (if mode === 'approval'), and returns the final goal string to use for the run.
// Falls back to the original goal on any error.
//
// @param {string} goal - Original goal text
// @param {Object} tabInfo - Tab context info
// @param {number} startTabId - Tab ID for approval flow
// @param {string|null} currentRunLogId - Current run log ID (module-level runLogId)
// @param {Array} currentRunLogBuffer - Current run log buffer (module-level runLogBuffer)
// @returns {Promise<string>} Final goal string

export async function _applyAdaptivePrompts(goal, tabInfo, startTabId, currentRunLogId, currentRunLogBuffer) {
  try {
    const apSettings = await chrome.storage.local.get(['adaptivePromptsMode', 'adaptiveExpansionMode', 'technicianInfo']);
    const apMode = (apSettings.adaptivePromptsMode || 'auto').toString();
    if (apMode === 'off') return goal;
    const result = await rewriteGoalForPlatform(
      goal,
      tabInfo?.url || '',
      apSettings.technicianInfo || null,
      apSettings.adaptiveExpansionMode || 'light'
    );
    if (!result || !result.adapted) return goal;
    // Log the adaptation to the forensic run log
    try {
      if (currentRunLogId) {
        currentRunLogBuffer.push({
          step: 0,
          timestamp: new Date().toISOString(),
          kind: 'adaptive_prompt_applied',
          platform: result.platform ? result.platform.id : '',
          mismatchCount: (result.mismatchHints || []).length,
          durationMs: result.durationMs,
          originalLength: (result.originalGoal || '').length,
          adaptedLength: (result.adaptedGoal || '').length
        });
        chrome.storage.local.set({ [`run_log_${currentRunLogId}`]: { goal, runLogId: currentRunLogId, entries: currentRunLogBuffer, lastUpdate: Date.now() } }).catch((e) => {
          console.error('[_applyAdaptivePrompts] Unhandled rejection:', getErrorMessage(e));
        });
      }
    } catch (_) { /* non-fatal */ }
    if (apMode === 'approval') {
      const decision = await _waitForAdaptedGoalDecision(result, startTabId);
      if (decision.useOriginal) return goal;
      if (decision.edited && typeof decision.editedGoal === 'string' && decision.editedGoal.length > 10) return decision.editedGoal;
      // approved, timeout, or unknown → use adapted
      return result.adaptedGoal;
    }
    // Auto mode: swap silently but broadcast the card for the popup diff view
    try {
      chrome.runtime.sendMessage({
        action: 'adapted_goal_available',
        mode: 'auto',
        platform: result.platform,
        summary: result.summary,
        mismatchHints: result.mismatchHints,
        originalGoal: result.originalGoal,
        adaptedGoal: result.adaptedGoal
      }).catch((e) => {
        console.error('[_applyAdaptivePrompts] Unhandled rejection:', getErrorMessage(e));
      });
    } catch (_e) { /* non-fatal */ }
    return result.adaptedGoal;
  } catch (e) {
    console.warn('[Sentinel] adaptive-prompts pass failed (non-fatal):', getErrorMessage(e));
    return goal;
  }
}
