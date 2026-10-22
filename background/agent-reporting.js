// Sentinel Override — Agent Reporting Module
// Extracted from agent-engine.js: run replay, pattern tracking, confidence scoring,
// desktop notifications, and learned-pattern dashboard emission.

import { getErrorMessage } from './error-utils.js';

// ========== Module State ==========

// Lightweight in-memory run recorder that captures every step for instant
// HTML replay export. Lives alongside the forensic runLogBuffer but is
// optimised for quick human-readable HTML generation rather than storage.
const _runRecording = {
  steps: [],
  startTime: null,
  goal: '',
  tabId: null
};


// Precompile regex for PII redaction (used by saveLearnedPattern)
const PII_IP_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
const PII_EMAIL_RE = /[\w.+-]+@[\w.-]+/g;
const PII_TICKET_RE = /(?:\b(?:TKT|TICKET|INC|INCIDENT|SR)|#)\s*\d+/gi;
const PII_CLIENT_STRING_RE = /"[^"]{2,60}"/g;
const PII_CLIENT_SINGLE_RE = /'[^']{2,60}'/g;

// Default config — mirrors CONFIG.maxLearnedPatterns from agent-engine.js
const REPORTING_CONFIG = {
  maxLearnedPatterns: 100
};

// ========== Run Replay Recording ==========

function startRunRecording(tabId, goal) {
  _runRecording.startTime = Date.now();
  _runRecording.goal = goal || '';
  _runRecording.tabId = tabId;
  _runRecording.steps = [];
}

function recordStep(stepData) {
  _runRecording.steps.push({
    ...stepData,
    timestamp: Date.now()
  });
}

function generateRunReplay() {
  const duration = Date.now() - (_runRecording.startTime || Date.now());
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Sentinel Override Run Replay</title>
<style>
body{font-family:system-ui;background:#0a0a1a;color:#ccc;margin:0;padding:20px;}
.header{border-bottom:1px solid #333;padding-bottom:12px;margin-bottom:20px;}
.goal{font-size:16px;color:#fff;margin:8px 0;}
.meta{font-size:12px;color:#666;}
.step{background:#111;border-radius:8px;padding:12px;margin:8px 0;border-left:3px solid #333;}
.step.click{border-left-color:#4caf50;} .step.type{border-left-color:#2196f3;}
.step.navigate{border-left-color:#ff9800;} .step.error{border-left-color:#f44336;}
.step.extract{border-left-color:#ab47bc;} .step.finish{border-left-color:#26c6da;}
.step-header{display:flex;justify-content:space-between;font-size:12px;color:#888;margin-bottom:4px;}
.step-action{font-size:13px;color:#ccc;} .step-result{font-size:12px;color:#999;margin-top:4px;}
.screenshot{max-width:100%;border-radius:4px;margin-top:8px;border:1px solid #333;}
.stats{display:flex;gap:20px;margin-top:16px;font-size:12px;color:#666;}
</style></head><body>
<div class="header">
<h1>Sentinel Override Run Replay</h1>
<div class="goal">Goal: ${_runRecording.goal || 'N/A'}</div>
<div class="meta">${_runRecording.startTime ? new Date(_runRecording.startTime).toLocaleString() : 'N/A'} &middot; ${Math.round(duration/1000)}s &middot; ${_runRecording.steps.length} steps</div>
</div>
<div class="stats">
<div>Total Steps: ${_runRecording.steps.length}</div>
<div>Duration: ${Math.round(duration/1000)}s</div>
</div>
${_runRecording.steps.map((s,i) => {
  const screenshotHtml = s.screenshot ? '<img class="screenshot" src="data:image/jpeg;base64,' + s.screenshot + '" alt="Step ' + (i+1) + '" />' : '';
  return '<div class="step ' + (s.actionType || '') + '"><div class="step-header"><span>Step ' + (i+1) + '</span><span>' + (s.actionType || 'unknown') + '</span><span>' + new Date(s.timestamp).toLocaleTimeString() + '</span></div><div class="step-action">' + (s.action || 'No action recorded') + '</div>' + (s.result ? '<div class="step-result">' + s.result + '</div>' : '') + screenshotHtml + '</div>';
}).join('')}
</body></html>`;
  return html;
}

// ========== Learned Patterns Dashboard (Phase 5) ==========
// Emits the top-20 learned patterns to the popup for the patterns dashboard.
// Called after each step completes and on run finish.
function emitLearnedPatterns(tabId, learnedPatterns) {
  try {
    const patterns = Object.entries(learnedPatterns || {}).map(([key, data]) => ({
      pattern: key,
      uses: data.uses,
      successes: data.successes,
      rate: data.uses > 0 ? Math.round(data.successes / data.uses * 100) : 0,
      lastUsed: data.lastUsed
    })).sort((a, b) => b.uses - a.uses).slice(0, 20);
    chrome.runtime.sendMessage({ type: 'learned_patterns', tabId, patterns }).catch(() => {});
  } catch (_e) {}
}

// ========== Desktop Notification on Run Completion ==========
// Fires a chrome notification when a manual (non-scheduled) agent run finishes.

/**
 * Send a desktop notification when an agent run completes.
 * @param {string} goal - The run goal text.
 * @param {boolean} success - Whether the run succeeded.
 * @param {number} stepCount - Total steps executed.
 * @param {number} duration - Run duration in ms.
 */
function notifyRunComplete(goal, success, stepCount, duration) {
  try {
    const truncatedGoal = (goal || 'Task').substring(0, 50);
    const status = success ? 'Completed successfully' : 'Failed';
    const body = `${status} · ${stepCount} steps · ${Math.round((duration || 0) / 1000)}s`;
    chrome.notifications.create('run-complete-' + Date.now(), {
      type: 'basic',
      iconUrl: 'icon-128.png',
      title: 'Sentinel Override: ' + truncatedGoal,
      message: body,
      priority: 2
    });
  } catch (_e) {
    // notifications API may not be available
  }
}

// ========== Confidence Scoring ==========
// Scores each action 0-100 so the popup can display how sure the agent is
// about a given step. Pure function — no side effects.

function scoreActionConfidence(command, pageContext) {
  if (!command) return 0;
  let score = 50; // baseline
  const type = command.type || '';

  // High-confidence actions
  if (type === 'note' || type === 'finish') return 95;
  if (type === 'navigate' || type === 'open_tab') { score = 80; }

  // Selector-based scoring
  if (command.selector) {
    score += 10; // has explicit selector
    if (command.selector.startsWith('#')) score += 10; // ID selector = very specific
    else if (command.selector.includes('[aria-')) score += 8; // ARIA = good
    else if (command.selector.startsWith('//')) score -= 5; // XPath = fragile
  }

  // Text-based matching
  if (command.text || command.value) score += 5; // has text to match

  // Check if selector exists in observed elements
  if (pageContext && pageContext.elements && command.selector) {
    const found = pageContext.elements.some(el =>
      el.selector === command.selector || el.id === command.selector
    );
    if (found) score += 15;
    else score -= 20; // selector not found on page
  }

  return Math.max(0, Math.min(100, score));
}

// ========== Self-Learning ==========

async function saveLearnedPattern(goal, history, success) {
  try {
    const stored = await chrome.storage.local.get(['learned_patterns']);
    const patterns = stored.learned_patterns || [];
    // Scrub PII before persisting — IPs, emails, ticket numbers, and quoted
    // strings (often client names) are replaced with safe placeholders so
    // chrome.storage.local doesn't accumulate identifiable client data.
    const _scrubPii = (str) => String(str)
      .replace(PII_IP_RE, '[REDACTED:ip]')
      .replace(PII_EMAIL_RE, '[REDACTED:email]')
      .replace(PII_TICKET_RE, '[REDACTED:ticket]')
      .replace(PII_CLIENT_STRING_RE, '"[REDACTED:client]"')
      .replace(PII_CLIENT_SINGLE_RE, "'[REDACTED:client]'");
    const steps = [];
    for (const h of history) {
      if (h.action) {
        steps.push({ type: h.action.type, selector: h.action.selector });
      }
    }
    patterns.push({
      goal: _scrubPii(goal.substring(0, 100)),
      steps,
      success,
      timestamp: Date.now()
    });
    const maxPatterns = REPORTING_CONFIG.maxLearnedPatterns;
    if (patterns.length > maxPatterns) patterns.splice(0, patterns.length - maxPatterns);
    await chrome.storage.local.set({ learned_patterns: patterns });
  } catch (e) { console.warn('Failed to save pattern:', getErrorMessage(e)); }
}

// ========== Exports ==========
// State accessors for agent-engine.js to read/write module-level state.

export {
  _runRecording,
  startRunRecording,
  recordStep,
  generateRunReplay,
  emitLearnedPatterns,
  notifyRunComplete,
  scoreActionConfidence,
  saveLearnedPattern
};
