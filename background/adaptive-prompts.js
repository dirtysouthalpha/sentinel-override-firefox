// background/adaptive-prompts.js
// Adaptive Prompts engine — v3.15.0
//
// Pre-execution pass that rewrites a user goal using a platform-aware profile.
// The agent then runs against the rewritten goal. Falls back to the original
// goal if anything goes wrong — never blocks a run.
//
// Triggered from agent-engine.js startAgent. Controlled by two settings:
//   chrome.storage.local.adaptivePromptsMode    'auto' | 'approval' | 'off' (default 'auto')
//   chrome.storage.local.adaptiveExpansionMode  'off'  | 'light'    | 'full' (default 'light')
//
// 'auto' rewrites silently. 'approval' broadcasts an adapted_goal_available
// message and waits for the user to accept / reject / edit via the popup.

import { getActiveProvider } from './provider-registry.js';
import { getErrorMessage } from './error-utils.js';
import { getPlatformProfile, findMismatchHints } from './platforms/index.js';
import { API_TIMEOUT_MS } from './constants.js';

const REWRITER_TIMEOUT_MS = API_TIMEOUT_MS;
const REWRITER_MAX_TOKENS = 4000;

// Precompiled regex for extracting JSON from markdown code blocks
const CODE_BLOCK_REGEX = /```(?:json)?\s*\n?([\s\S]*?)\n?```/;

/**
 * Build the rewriter system + user prompts for the LLM.
 * @returns {{system: string, user: string}}
 */
function buildRewriterPrompt(rawGoal, currentUrl, profile, expansionMode, technicianInfo, mismatchHints) {
  const expansionLine = expansionMode === 'full'
    ? 'EXPANSION: FULL — if the user gave only a short directive, expand it into a multi-phase plan that produces a structured deliverable.'
    : expansionMode === 'light'
      ? 'EXPANSION: LIGHT — if the user gave only a one-sentence directive, you MAY add a brief plan; otherwise preserve their structure.'
      : 'EXPANSION: OFF — do not add phases or steps the user did not ask for.';

  const tech = technicianInfo || {};
  const techLine = (tech.name || tech.phone || tech.email)
    ? `Technician: ${tech.name || ''}${tech.company ? ` · ${tech.company}` : ''}${tech.phone ? ` · ${tech.phone}` : ''}${tech.email ? ` · ${tech.email}` : ''}.`
    : '';

  const mismatchLines = (mismatchHints && mismatchHints.length)
    ? `\n\nDETECTED MENU MISMATCHES (user wrote on-box menu paths but you are on the cloud portal):\n${
      mismatchHints.map(h => `  - "${h.onbox}"  →  "${h.target}"`).join('\n')
    }\nReplace each occurrence in the rewritten goal.`
    : '';

  // Build NAVIGATION SIGNALS block from profile.waitStrings
  let navSignalsBlock = '';
  try {
    const ws = profile.waitStrings;
    if (ws && typeof ws === 'object') {
      const lines = Object.entries(ws).map(([k, v]) =>
        Array.isArray(v) && v.length ? `  ${k}: any of [${v.map(s => `"${s}"`).join(', ')}]` : null
      ).filter(Boolean);
      if (lines.length) {
        navSignalsBlock = `\nNAVIGATION SIGNALS (add wait_for_text with these after each navigation step to confirm page load):\n${lines.join('\n')}`;
      }
    }
  } catch (e) { console.warn('[Sentinel/adaptive-prompts] waitStrings parse failed:', getErrorMessage(e)); }

  // Build KNOWN SUB-PAGES block from profile.pageTypes
  let subPagesBlock = '';
  try {
    if (Array.isArray(profile.pageTypes) && profile.pageTypes.length) {
      const lines = profile.pageTypes.reduce((acc, pt) => {
        if (pt?.name && pt?.hint) {
          acc.push(`  ${pt.name}: ${pt.hint}`);
        }
        return acc;
      }, []);
      if (lines.length) {
        subPagesBlock = `\nKNOWN SUB-PAGES (use these hints when navigating to each section):\n${lines.join('\n')}`;
      }
    }
  } catch (e) { console.warn('[Sentinel/adaptive-prompts] pageTypes parse failed:', getErrorMessage(e)); }

  // Build WORKFLOW SCAFFOLD block from profile.workflowHints if goal matches
  let workflowScaffold = '';
  try {
    if (Array.isArray(profile.workflowHints)) {
      for (const wh of profile.workflowHints) {
        if (wh?.match instanceof RegExp && wh?.hint && wh.match.test(rawGoal)) {
          workflowScaffold = `\nWORKFLOW SCAFFOLD (goal matches a known task pattern — use as the phase structure unless the user already provided one):\n${wh.hint}`;
          break;
        }
      }
    }
  } catch (e) { console.warn('[Sentinel/adaptive-prompts] workflowHints parse failed:', getErrorMessage(e)); }

  const profileBlock = `
DETECTED PLATFORM: ${profile.label} (id: ${profile.id})
CURRENT URL: ${currentUrl || '(unknown)'}
MEMORY KEY PREFIX: ${profile.memoryKeyPrefix || '(none)'}

PLATFORM CAVEATS:
${profile.liveDataCaveats || '(none)'}

KNOWN GOTCHAS:
${profile.knownGotchas || '(none)'}

${profile.needsTargetSelection ? `PRE-FLIGHT (Phase 0) — REQUIRED:\n${profile.preflightInstructions}\n` : ''}
PLATFORM-SPECIFIC INSTRUCTIONS:
${profile.rewriteInstructions || '(none)'}
${navSignalsBlock}
${subPagesBlock}
${workflowScaffold}
${mismatchLines}
`.trim();

  const system = `You are an Adaptive Prompts rewriter for an MSP browser-automation agent. Your job is to take a technician's investigation goal and rewrite it so the agent will navigate the CURRENT cloud portal correctly. You are NOT executing the goal — you are preparing it.

CORE RULES — follow EXACTLY:
1. Preserve the user's intent, phase structure, output style, deliverable, and any "[MISSING DATA — ...]" / "noteworthy" / "never invent" directives EXACTLY.
2. Only modify what is necessary to make the goal work on the detected platform.
3. Replace on-box menu paths with the platform-correct equivalents from PLATFORM-SPECIFIC INSTRUCTIONS.
4. If the platform requires drilling into a target device/firewall/tenant before per-device menus appear, insert the platform's Phase 0 verbatim (or as a clearly-numbered first phase) BEFORE the user's existing Phase 1.
5. If the platform has a memory-key prefix, ensure the goal instructs the agent to use it for all saved findings.
6. Add a brief, neutral block at the very top labeled "=== ADAPTED FOR ${profile.label} ===" describing what was changed (3-6 bullet points max). Do NOT pad with platitudes.
7. Do NOT change the user's deliverable section, output style rules, or technician details.
8. ${expansionLine}
9. ${techLine}
10. If NAVIGATION SIGNALS are provided, weave wait_for_text directives (using those signal strings) after each navigation step so the agent waits for the page to fully load before proceeding.
11. If a WORKFLOW SCAFFOLD is provided and the user's goal doesn't already have a phase structure, use that scaffold as the phase skeleton — fill in the user's specific details (client name, device, ticket number, etc.) while keeping the navigation steps.

If the user's goal is ALREADY correctly written for this platform with no mismatches detected, respond with the special marker:
{"no_adaptation_needed": true, "reason": "<short reason>"}

OUTPUT FORMAT:
Return ONLY a JSON object with two fields:
{
  "adapted_goal": "<the full rewritten goal as a single string>",
  "summary": "<3-6 bullet summary of changes, plain text with newlines>"
}
No prose outside the JSON. No code fences. No markdown wrapping the JSON.`;

  const user = `${profileBlock}

ORIGINAL GOAL (verbatim):
"""
${rawGoal}
"""

Rewrite it.`;

  return { system, user };
}

/**
 * Attempt to extract a JSON object from the LLM response.
 */
function extractJsonObject(text) {
  if (!text) return null;
  let s = String(text).trim();
  // Strip code fences if present
  if (s.startsWith('```')) {
    const m = s.match(CODE_BLOCK_REGEX);
    if (m && m[1]) s = m[1].trim();
  }
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ''); // preserve \t \n \r for JSON fallback parsing
  try { return JSON.parse(s); } catch (_e) { /* will try fallback parsing */ }
  // Find first { ... } balanced
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  const sLen = s.length;
  for (let i = start; i < sLen; i++) {
    const c = s[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        const candidate = s.substring(start, i + 1);
        try { return JSON.parse(candidate); } catch (_parseErr) { return null; }
      }
    }
  }
  return null;
}

/**
 * Rewrite a goal for the detected platform. Always returns a result object,
 * never throws — fall back to the original goal on any error.
 *
 * @param {string} rawGoal The user's original goal text.
 * @param {string} currentUrl The starting tab's URL.
 * @param {object} technicianInfo Optional {name, title, company, phone, email}.
 * @param {string} expansionMode 'off' | 'light' | 'full' (default 'light').
 * @returns {Promise<{adapted: boolean, adaptedGoal: string, originalGoal: string,
 *                   platform: object|null, summary: string, mismatchHints: object[],
 *                   error: string|null, durationMs: number}>}
 */
export async function rewriteGoalForPlatform(rawGoal, currentUrl, technicianInfo, expansionMode) {
  const startedAt = Date.now();
  const result = {
    adapted: false,
    adaptedGoal: rawGoal,
    originalGoal: rawGoal,
    platform: null,
    summary: '',
    mismatchHints: [],
    error: null,
    durationMs: 0
  };

  try {
    if (!rawGoal || typeof rawGoal !== 'string' || rawGoal.length < 10) {
      result.error = 'goal too short for rewrite';
      return result;
    }
    const profile = getPlatformProfile(currentUrl, rawGoal);
    if (!profile) {
      result.error = 'no matching platform profile';
      return result;
    }
    result.platform = { id: profile.id, label: profile.label, memoryKeyPrefix: profile.memoryKeyPrefix };
    const mismatchHints = findMismatchHints(profile, rawGoal);
    result.mismatchHints = mismatchHints;

    // Resolve expansion mode before the short-circuit check so we can use it.
    const expMode = (expansionMode || 'light').toString().toLowerCase();

    // Short-circuit: only skip when adaptation is explicitly disabled AND there
    // are no structural mismatches to fix. When a platform profile matched, even
    // short goals benefit from workflow scaffolding and wait-string injection.
    if (expMode === 'off' && !mismatchHints.length && !profile.needsTargetSelection) {
      result.error = 'adaptation disabled (expansionMode=off, no mismatches, no Phase 0)';
      return result;
    }

    const provider = await getActiveProvider();
    if (!provider || !provider.apiKey) {
      result.error = 'no active provider configured';
      return result;
    }

    const { system, user } = buildRewriterPrompt(rawGoal, currentUrl, profile, expMode, technicianInfo, mismatchHints);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REWRITER_TIMEOUT_MS);
    let response;
    try {
      const isComplex = rawGoal.length > 200;
      const useThinking = isComplex && provider.supportsToolUse && provider.buildBodyTextWithThinking;
      const body = useThinking
        ? JSON.stringify(provider.buildBodyTextWithThinking(provider.model, system, user, 5000, { maxTokens: REWRITER_MAX_TOKENS }))
        : JSON.stringify(provider.buildBody(provider.model, system, user, { maxTokens: REWRITER_MAX_TOKENS, temperature: 0.2 }));
      const headers = provider.buildHeaders(provider.apiKey);
      response = await fetch(provider.endpoint, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      result.error = `rewriter API ${response.status}`;
      response.body && response.body.cancel().catch(() => {});
      return result;
    }

    const data = await response.json();
    if (!data) { result.error = 'rewriter returned null response body'; return result; }
    const content = provider.parseResponse(data);
    if (!content) {
      result.error = 'rewriter returned empty content';
      return result;
    }

    const parsed = extractJsonObject(content);
    if (!parsed) {
      result.error = 'rewriter response not valid JSON';
      return result;
    }

    if (parsed.no_adaptation_needed) {
      result.error = `rewriter judged no adaptation needed: ${parsed.reason || ''}`;
      return result;
    }

    if (typeof parsed.adapted_goal !== 'string' || parsed.adapted_goal.length < 20) {
      result.error = 'rewriter returned no adapted_goal';
      return result;
    }

    result.adapted = true;
    result.adaptedGoal = parsed.adapted_goal;
    result.summary = typeof parsed.summary === 'string' ? parsed.summary : '';
    return result;

  } catch (e) {
    result.error = getErrorMessage(e);
    return result;
  } finally {
    result.durationMs = Date.now() - startedAt;
  }
}
