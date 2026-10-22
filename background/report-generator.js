// Sentinel Override v3 -- Report Generator
// Generates structured investigation reports after agent task completion.
// Imports from llm-client.js for LLM calls and message-protocol.js for popup messaging.

import { sendSilentUpdate } from './message-protocol.js';
import { getActiveProvider, resolveProvider } from './provider-registry.js';
import { getErrorMessage } from './error-utils.js';
import { ONE_SECOND_MS, MAX_REPORT_FINDING_LENGTH } from './constants.js';

// Precompute action types to filter from step history for O(1) lookup
const FILTERED_ACTION_TYPES = new Set(['read_page', 'scroll', 'wait_for_text', 'wait_for_element', 'wait_for_navigation']);

// Precompile regex patterns for performance (hot path functions)
const TASK_TYPE_BRIEFING_RE = /top \d|briefing|latest|recent|news|articles/i;
const TASK_TYPE_COMPARISON_RE = /compar|vs\.|versus|better|which/i;
const TASK_TYPE_EXTRACTION_RE = /extract|pull|scrape|list|inventory|export|gather/i;
const TASK_TYPE_INVESTIGATION_RE = /investigat|analyz|audit|review|check|look into|diagnos|troubleshoot/i;
const TASK_TYPE_CONFIGURATION_RE = /config|setup|install|deploy|create|add|enable|configure/i;
const ACTION_FAILED_RE = /(not found|Error|failed|timed out)/i;
const CODE_BLOCK_CLEAN_RE = /^```(?:markdown|md)?\s*\n?([\s\S]*?)\n?```$/s;

// ========== Pure Helpers ==========

/**
 * Truncate a memory value to maxChars for LLM prompt injection.
 * Arrays are joined (up to 5 items); objects are JSON-stringified.
 * @param {*} val
 * @param {number} maxChars
 * @returns {string}
 */
function _truncateMemoryValue(val, maxChars) {
  if (val == null) return '';
  let valStr;
  if (Array.isArray(val)) {
    valStr = val.slice(0, 5).map(v => typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)).join('\n');
  } else if (typeof val === 'object' && val !== null) {
    try { valStr = JSON.stringify(val); } catch { valStr = String(val); }
  } else {
    valStr = String(val);
  }
  if (valStr.length > maxChars) {
    valStr = `${valStr.substring(0, maxChars)}... [truncated; full value in run log]`;
  }
  return valStr;
}

/**
 * Classify the goal into a task type string.
 * @param {string} goal
 * @returns {string}
 */
function _detectTaskType(goal) {
  const goalLower = (goal || '').toLowerCase();
  if (TASK_TYPE_BRIEFING_RE.test(goalLower)) return 'briefing';
  if (TASK_TYPE_COMPARISON_RE.test(goalLower)) return 'comparison';
  if (TASK_TYPE_EXTRACTION_RE.test(goalLower)) return 'extraction';
  if (TASK_TYPE_INVESTIGATION_RE.test(goalLower)) return 'investigation';
  if (TASK_TYPE_CONFIGURATION_RE.test(goalLower)) return 'configuration';
  return 'general';
}

/**
 * Count actions by type and tally success/failure from history.
 * @param {Array} history
 * @returns {{ actionCounts: object, failedActions: number, successfulActions: number }}
 */
function _countActionHistory(history) {
  const actionTypes = ['navigate', 'click', 'type', 'extract', 'extract_list', 'execute_js',
    'read_page', 'note', 'scroll', 'wait_for_text', 'wait_for_element', 'wait_for_navigation',
    'select', 'check', 'hover', 'press_key', 'finish', 'open_tab', 'switch_tab', 'close_tab',
    'dismiss_overlay', 'click_at', 'scroll_to', 'verify', 'lookup', 'read_console_messages',
    'read_network_requests', 'run_remote_command', 'repeat_for_each', 'scroll_at', 'zoom_at', 'triple_click_at'];
  const actionCounts = {};
  for (const t of actionTypes) actionCounts[t] = 0;
  let failedActions = 0;
  let successfulActions = 0;
  for (const h of history) {
    if (!h || !h.action) continue;
    const t = h.action.type || 'unknown';
    if (actionCounts[t] !== undefined) actionCounts[t]++;
    const result = String(h.result || '');
    if (ACTION_FAILED_RE.test(result)) {
      failedActions++;
    } else {
      successfulActions++;
    }
  }
  return { actionCounts, failedActions, successfulActions };
}

/**
 * Collect unique URLs visited from the action history.
 * @param {Array} history
 * @returns {string[]}
 */
function _collectUrlsVisited(history) {
  const urlsVisited = [];
  const seenUrls = new Set();
  for (const h of history) {
    if (!h) continue;
    if (h.action && h.action.type === 'navigate' && h.action.url) {
      const u = h.action.url;
      if (!seenUrls.has(u)) { urlsVisited.push(u); seenUrls.add(u); }
    }
    if (h.url && !seenUrls.has(h.url)) {
      urlsVisited.push(h.url);
      seenUrls.add(h.url);
    }
  }
  return urlsVisited;
}

/**
 * Build the memory summary string and citable-keys list for the report prompt.
 * Filters out failed/empty entries and truncates each value to 600 chars.
 * @param {object} agentMemory
 * @returns {{ memorySummary: string, citableKeysList: string }}
 */
function _buildMemorySummary(agentMemory) {
  if (!agentMemory || typeof agentMemory !== 'object' || Array.isArray(agentMemory)) {
    return { memorySummary: 'No usable data was extracted.', citableKeysList: '(none)' };
  }
  const memoryKeys = Object.keys(agentMemory);
  const usableKeys = memoryKeys.filter(k => {
    const v = agentMemory[k];
    let s;
    try { s = typeof v === 'string' ? v : JSON.stringify(v); } catch { s = String(v); }
    return s && s.length > 3 && s !== 'Done'
      && !s.startsWith('Execution error') && !s.startsWith('Code execution timed out')
      && !s.startsWith('JS Error:') && !s.startsWith('Element not found');
  });
  // (3.50.0) Hard-cap each memory entry at 400 chars — keeps report prompt
  // small enough to avoid timeouts on slower models.
  const memorySummary = usableKeys.length
    ? usableKeys.map(k => `- ${k}: ${_truncateMemoryValue(agentMemory[k], 400)}`).join('\n')
    : 'No usable data was extracted (all extractions failed or timed out).';
  const citableKeysList = usableKeys.length
    ? usableKeys.map(k => `\`${k}\``).join(', ')
    : '(none — investigation produced no extractable data)';
  return { memorySummary, citableKeysList };
}

// ========== Report Generation ==========
/**
 * Generate a structured investigation report from agent execution data.
 * Uses callLLMWithRetry for reliable LLM calls with automatic retry.
 * Returns both human-readable markdown and machine-readable structured JSON.
 *
 * @param {object} executionData - Snapshot of agent execution state
 * @param {string} executionData.goal - The original user goal
 * @param {Array} executionData.history - Step-by-step action history
 * @param {object} executionData.agentMemory - Extracted data from investigation
 * @param {Array|null} executionData.agentPlan - Original execution plan (if any)
 * @param {number} executionData.stepCount - Total steps executed
 * @param {number} executionData.apiCallCount - Total API calls made
 * @param {Array} executionData.tabContexts - Tab contexts with label, url, hasScreenshot
 * @param {object} CONFIG - Agent configuration object
 * @returns {Promise<{summary: string, fullReport: string, structuredData: object, goal: string, timestamp: string}>}
 */
// Build the report-generation prompt from execution data pieces.
// Returns the user-content prompt string for the LLM report writer.
function _buildReportPrompt(goal, planContext, stepCount, apiCallCount, timestamp, condensedHistory, memorySummary, tabReferences, citableKeysList) {
  return `You are a brilliant research analyst and writer — think Claude-quality output. Your job is to take raw data collected by a browser agent and produce a polished, insightful report that the user actually WANTS to read.

## Original Goal
${goal}

${planContext}

## How the Agent Collected Data
- Total steps: ${stepCount}
- API calls: ${apiCallCount}
- Timestamp: ${timestamp}

## Raw Action History
${condensedHistory.map(h => `[${h.action}] ${h.result}`).join('\n')}

## Raw Extracted Data
${memorySummary}

${tabReferences}

---

## YOUR TASK

Synthesize the raw extracted data into a clean, compelling report. Follow these principles:

### Writing Style
- **Conversational but authoritative** — like a knowledgeable colleague briefing you over coffee, not a robot reading a list
- **Lead with insight** — open with a 1-2 sentence executive summary that answers the user's core question
- **Specific > vague** — use actual names, numbers, dates, quotes, URLs. "3.2 million users" not "a large number of users"
- **Contextualize** — don't just list facts; explain WHY they matter. Connect dots between data points
- **Structured for scanning** — use headers, numbered lists, bold key terms. The user should find any detail in <5 seconds

### Output Format
Adapt to the task type:

**For news briefings (top N articles):**
→ Lead with "Here's your briefing on [topic]..."
→ Each item: **numbered headline** → 2-3 sentence summary of what happened and why it matters → source link
→ End with "Bottom line:" — one sentence takeaway

**For research/analysis tasks:**
→ Lead with the answer/conclusion upfront
→ Then support with evidence in structured sections
→ End with recommendations or next steps

**For comparisons:**
→ Side-by-side format with specific data points
→ Clear verdict with reasoning

**For data extraction (configs, logs, etc.):**
→ Clean structured format (tables, key-value pairs)
→ Anomalies or notable findings highlighted
→ Summary of what was found

### Rules
- ONLY use data that was actually extracted — NEVER fabricate, infer, or use training data
- If data is incomplete or missing, say so explicitly rather than guessing
- If extracted data contains errors/failed extractions, skip those and work with what succeeded
- Keep the report tight — every sentence should earn its place
- Use proper markdown formatting (headers, bold, lists, links)
- Do NOT wrap in code fences or JSON
- Return ONLY the report, nothing else

### Source-Cited Outputs (MANDATORY)
Every specific factual claim in your report — numbers, prices, dates, statistics, named quotes, named people / companies / IPs, URLs you actually visited — MUST end with an inline tag in the form **\`[src:memory_key]\`** where \`memory_key\` is one of the keys listed below in "Available memory keys to cite from". The popup renders these as clickable orange chips that expand the underlying data, so the reader can audit any claim back to its source.

**Available memory keys to cite from:** ${citableKeysList}

Examples of correctly cited claims:

- "M4 Max Mac Studio starts at $1,999 [src:apple_store_pricing]"
- "47 sign-ins from IP 203.0.113.42 [src:entra_signins]"
- "Repository has 110,000 stars [src:github_repo_meta]"

Hard rules:

1. **Every** number, price, date, percentage, statistic, named entity, named quote, or specific URL needs a \`[src:key]\` tag pointing to a real memory key from the list above.
2. If a claim has NO supporting memory key (e.g., it's general framing or your interpretation), either drop the specific number / leave it un-cited as prose, OR tag it \`[unverified]\` and move it to a "Caveats" section.
3. Do NOT invent memory keys. If you can't find a real key for a claim, either remove the claim or mark it \`[unverified]\`.
4. Headers, transitions, and structural prose do not need tags — only specific factual claims do.
5. Cite generously — overcitation is acceptable; under-citation is not.

This is not optional. A report with specific numbers but no \`[src:*]\` tags is broken, even if the prose looks polished.`;
}

export async function generateReport(executionData, CONFIG) {
  if (!executionData || typeof executionData !== 'object' || executionData === null) {
    throw new Error('generateReport: executionData is required');
  }
  const { goal = '', agentPlan, stepCount = 0, apiCallCount = 0 } = executionData;
  const history = Array.isArray(executionData.history) ? executionData.history : [];
  const tabContexts = Array.isArray(executionData.tabContexts) ? executionData.tabContexts : [];
  const agentMemory = executionData.agentMemory || {};
  const timestamp = new Date().toISOString();

  sendSilentUpdate('Generating investigation report...');

  // (3.50.0) Cap condensed history to last 12 steps for report prompt.
  // Long runs produce massive prompts that timeout small-context LLMs.
  const _allHistory = history.map(h => ({
    step: h.step,
    action: h.action ? h.action.type : 'unknown',
    detail: (function() { const a = h.action; return a && a.selector && typeof a.selector === 'string' ? a.selector.substring(0, 80) : (a && (a.url || a.text) || ''); })(),
    result: typeof h.result === 'string' ? h.result.substring(0, 150) : (h.result != null ? String(h.result).substring(0, 150) : '')
  }));
  const condensedHistory = _allHistory.length > 14
    ? [..._allHistory.slice(0, 2), { step: '...', action: `(${_allHistory.length - 14} steps omitted)`, detail: '', result: '' }, ..._allHistory.slice(-12)]
    : _allHistory;
  const { memorySummary, citableKeysList } = _buildMemorySummary(agentMemory);
  const planContext = agentPlan && agentPlan.length
    ? `\nOriginal plan (${agentPlan.length} steps):\n${agentPlan.map((s, i) => {
        const stepStr = typeof s === 'string' ? s : (s && s.description) || '';
        try {
          return `${i + 1}. ${stepStr || JSON.stringify(s)}`;
        } catch {
          return `${i + 1}. ${stepStr || '[unstringifiable step]'}`;
        }
      }).join('\n')}`
    : '\nNo formal plan was generated (direct execution mode).';
  const tabReferences = tabContexts.length
    ? `\nTabs/screenshots captured:\n${tabContexts.map(tc => `- "${tc.label}" (${tc.url})${tc.hasScreenshot ? ' [screenshot available]' : ''}`).join('\n')}`
    : '';

  const reportPrompt = _buildReportPrompt(goal, planContext, stepCount, apiCallCount, timestamp, condensedHistory, memorySummary, tabReferences, citableKeysList);
  const reportSystemPrompt = `You are a world-class research analyst and writer. You produce clear, insightful, beautifully structured reports from raw data. Your writing is conversational yet authoritative — like a brilliant colleague who respects the reader's time. You never use filler phrases, corporate jargon, or generic descriptions. Every word earns its place.`;
  const structuredData = buildStructuredData(executionData, timestamp);

  try {
    const reportResult = await generateReportViaLLM(reportPrompt, CONFIG, reportSystemPrompt);
    const fullReport = String(reportResult).trim();
    const firstParagraph = fullReport.split('\n\n')[0] || '';
    const summary = firstParagraph.length > 300 ? `${firstParagraph.substring(0, 297)}...` : firstParagraph;
    return { summary, fullReport, structuredData, goal, timestamp };
  } catch (err) {
    console.error('Report generation failed:', getErrorMessage(err));
    // (3.50.0) Build a better fallback that actually shows the collected data
    const fb = buildFallbackReport(executionData);
    // Prepend a note about the LLM failure
    const fallbackReport = `> ⚠️ AI report formatting failed (${getErrorMessage(err)}). Showing raw collected data.\n\n---\n\n${fb}`;
    return { summary: fb.split('\n\n')[0] || '', fullReport: fallbackReport, structuredData, goal, timestamp };
  }
}

// ========== LLM Call for Report ==========
/**
 * Makes an LLM call specifically for report generation.
 * Reuses settings from chrome.storage but with a dedicated prompt.
 * @param {string} prompt - The user prompt for report generation
 * @param {object} CONFIG - Agent config with fetchTimeout
 * @param {string} systemPrompt - System prompt override
 * @returns {Promise<string>} The generated report text
 */
async function generateReportViaLLM(prompt, CONFIG, systemPrompt) {
  const MAX_ATTEMPTS = 2;
  const REPORT_TIMEOUT = CONFIG.reportTimeout || 90000;
  let lastError = new Error('Report generation failed');

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const providerConfig = await getActiveProvider();
      if (!providerConfig) throw new Error('No active provider configured');
      const { endpoint, apiKey, model } = providerConfig;
      const _isLocalEndpoint = /^(https?:)?\/\/(127\.0\.0\.1|localhost|\[::1\])([:/]|$)/i.test(endpoint || '');
      if (!apiKey && !_isLocalEndpoint) throw new Error('API key not configured');

      const provider = resolveProvider(endpoint);
      if (!provider) throw new Error(`Unsupported API endpoint for report generation: ${endpoint}`);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REPORT_TIMEOUT);

      const reportSystem = systemPrompt || 'You are a world-class research analyst and writer. You produce clear, insightful, beautifully structured reports from raw data. Return ONLY the report content with no wrapping.';

      const maxTokens = attempt === 1 ? 4000 : 2000;
      let requestBody, requestHeaders;
      try {
        requestBody = JSON.stringify(provider.buildBody(model, reportSystem, prompt, { maxTokens, temperature: 0.3 }));
        requestHeaders = provider.buildHeaders(apiKey);
      } catch (err) {
        clearTimeout(timeout);
        throw new Error(`Failed to build report request: ${getErrorMessage(err)}`);
      }

      let response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: requestHeaders,
          body: requestBody,
          signal: controller.signal
        });
      } catch (err) {
        clearTimeout(timeout);
        if (err.name === 'AbortError') {
          lastError = new Error(`Report LLM timed out after ${REPORT_TIMEOUT / ONE_SECOND_MS}s (attempt ${attempt}/${MAX_ATTEMPTS})`);
          if (attempt < MAX_ATTEMPTS) {
            console.warn('[Sentinel/report] Attempt', attempt, 'timed out, retrying with shorter output...');
            continue;
          }
          throw lastError;
        }
        throw err;
      }
      clearTimeout(timeout);

      if (!response.ok) {
        let errorData;
        try { errorData = await response.text(); } catch (_) { errorData = 'unknown error'; }
        lastError = new Error(`Report LLM call failed: ${response.status} - ${errorData}`);
        if (attempt < MAX_ATTEMPTS) {
          console.warn('[Sentinel/report] Attempt', attempt, 'failed:', response.status, 'retrying...');
          continue;
        }
        throw lastError;
      }

      let data;
      try {
        data = await response.json();
      } catch (e) {
        throw new Error(`Report LLM returned invalid JSON: ${getErrorMessage(e)}`);
      }
      if (!data) throw new Error('Report LLM returned null response body');
      const responseText = provider.parseResponse(data) || '';

      let cleaned = responseText.trim();
      if (cleaned.startsWith('```')) {
        // Remove opening and closing code blocks in single pass
        cleaned = cleaned.replace(CODE_BLOCK_CLEAN_RE, '$1');
      }

      return cleaned;
    } catch (err) {
      lastError = err;
      const errMsg = getErrorMessage(err);
      const isNonRetryable = errMsg === 'No active provider configured'
        || errMsg === 'API key not configured'
        || errMsg.startsWith('Failed to build report request')
        || errMsg.startsWith('Report LLM returned invalid JSON');
      if (isNonRetryable) break;
      if (attempt < MAX_ATTEMPTS) {
        console.warn('[Sentinel/report] Attempt', attempt, 'failed:', errMsg, 'retrying...');
        await new Promise(r => setTimeout(r, ONE_SECOND_MS));
      }
    }
  }
  throw lastError;
}
// ========== Structured Data Builder ==========
/**
 * Builds a machine-readable JSON object from raw execution data.
 * This provides programmatic access to findings for automation, scheduling, and API consumers.
 *
 * @param {object} executionData - Same data passed to generateReport
 * @param {string} timestamp - ISO timestamp for the report
 * @returns {object} Structured report data
 */
function buildStructuredData(executionData, timestamp) {
  if (!executionData) return {};
  const { goal = '', history = [], agentPlan, stepCount = 0, apiCallCount = 0, tabContexts } = executionData;
  const agentMemory = executionData.agentMemory || {};

  const { actionCounts, failedActions, successfulActions } = _countActionHistory(history);

  const findings = {};
  for (const [key, val] of Object.entries(agentMemory)) {
    if (Array.isArray(val)) {
      findings[key] = val.slice(0, 50);
    } else if (typeof val === 'object' && val !== null) {
      try {
        const str = JSON.stringify(val);
        findings[key] = str.length > MAX_REPORT_FINDING_LENGTH ? `${str.substring(0, MAX_REPORT_FINDING_LENGTH)}... [truncated]` : str;
      } catch {
        findings[key] = String(val).substring(0, MAX_REPORT_FINDING_LENGTH);
      }
    } else {
      const str = String(val != null ? val : '');
      findings[key] = str.length > 2000 ? `${str.substring(0, 2000)}... [truncated]` : str;
    }
  }

  const urlsVisited = _collectUrlsVisited(history);

  return {
    meta: {
      version: '4.0',
      timestamp,
      goal,
      taskType: _detectTaskType(goal),
      planSteps: agentPlan ? agentPlan.length : 0,
      totalSteps: stepCount,
      apiCallCount,
      successRate: stepCount > 0 ? Math.round((successfulActions / stepCount) * 100) : 0,
      failedActions,
      urlsVisited: urlsVisited.slice(0, 50),
      tabsUsed: tabContexts ? tabContexts.length : 0
    },
    actionBreakdown: actionCounts,
    findings,
    tabs: (tabContexts || []).map(tc => ({
      label: tc.label,
      url: tc.url,
      hasScreenshot: !!tc.hasScreenshot
    }))
  };
}

// ========== Fallback Report ==========
/**
 * Builds a basic report from execution data when the LLM call fails.
 * Ensures the user always gets something useful even if report generation errors out.
 * @param {object} executionData
 * @returns {string} Markdown report string
 */
export function buildFallbackReport(executionData) {
  if (!executionData) return 'Report generation failed: no execution data available.';
  const { goal, history, agentMemory, stepCount, apiCallCount } = executionData;

  const memoryLines = Object.entries(agentMemory || {}).map(([k, val]) => {
    const valStr = Array.isArray(val)
      ? `${val.length} items: ${val.slice(0, 5).map(v => String(v).substring(0, 100)).join(', ')}`
      : (val !== null && typeof val === 'object')
        ? (() => { try { return JSON.stringify(val).substring(0, 300); } catch { return '[object]'; } })()
        : String(val).substring(0, 300);
    return `- **${k}**: ${valStr}`;
  });

  const stepsTaken = (history || [])
    .filter(h => h && h.action && h.action.type && !FILTERED_ACTION_TYPES.has(h.action.type))
    .map(h => `${h.step || '?'}. **${h.action.type}**${h.action.selector ? ` on ${h.action.selector.substring(0, 60)}` : ''}: ${typeof h.result === 'string' ? h.result.substring(0, 150) : ''}`)
    .join('\n');

  return `### Goal
${goal}

### Steps Taken
${stepsTaken || 'No significant steps recorded.'}

### Key Findings
Report generation encountered an error. The raw extracted data is shown below.

### Evidence
${memoryLines.length ? memoryLines.join('\n') : 'No data was extracted during this investigation.'}

### Conclusions
Investigation completed in ${stepCount} steps (${apiCallCount} API calls). For a detailed report, retry the task or check the agent's step-by-step log above.`;
}
