// background/bias-detector.js
// v6.0 Intelligence System - Bias Detection
// Detects potential biases in LLM interactions and responses

import { getErrorMessage } from './error-utils.js';

// Bias patterns to detect - precompiled with 'gi' flags for reuse
const BIAS_PATTERNS = {
  // Confirmation bias: favoring information that confirms preexisting beliefs
  confirmationBias: [
    /as expected/gi,
    /as i thought/gi,
    /just as i suspected/gi,
    /confirms my belief/gi,
    /told you so/gi
  ],

  // Anchoring bias: relying too heavily on first piece of information
  anchoringBias: [
    /initial.*indicated/gi,
    /first.*suggested/gi,
    /originally.*thought/gi,
    /starting point/gi
  ],

  // Availability heuristic: overestimating importance of readily available information
  availabilityHeuristic: [
    /recent.*suggests/gi,
    /lately.*seen/gi,
    /common.*encounter/gi,
    /often.*find/gi
  ],

  // Selection bias: choosing data that supports a conclusion
  selectionBias: [
    /ignoring.*evidence/gi,
    /disregarding.*data/gi,
    /only.*considering/gi,
    /selectively.*looking/gi
  ],

  // Stereotyping: making assumptions about groups
  stereotyping: [
    /typical.*for/gi,
    /usually.*these/gi,
    /characteristic.*of/gi,
    /standard.*for.*type/gi
  ],

  // Hindsight bias: seeing past events as predictable
  hindsightBias: [
    /should have.*known/gi,
    /obvious.*in.*retrospect/gi,
    /clear.*now.*that/gi,
    /with.*benefit.*of.*hindsight/gi
  ]
};

// Severity levels for detected biases
const SEVERITY_LEVELS = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3
};

/**
 * Analyze LLM response text for potential biases
 * @param {string} text - The text to analyze
 * @returns {object} Bias analysis results
 */
export function analyzeForBias(text) {
  if (!text || typeof text !== 'string') {
    return { hasBias: false, biases: [], severity: SEVERITY_LEVELS.none };
  }

  const detectedBiases = [];
  let maxSeverity = SEVERITY_LEVELS.none;

  for (const [biasType, patterns] of Object.entries(BIAS_PATTERNS)) {
    for (const pattern of patterns) {
      const matches = text.match(pattern);
      if (matches) {
        const severity = calculateBiasSeverity(biasType, text, pattern);
        detectedBiases.push({
          type: biasType,
          pattern: pattern.toString(),
          matches: matches,
          severity: severity
        });

        if (severity > maxSeverity) {
          maxSeverity = severity;
        }
      }
    }
  }

  return {
    hasBias: detectedBiases.length > 0,
    biases: detectedBiases,
    severity: maxSeverity,
    totalBiasScore: detectedBiases.length
  };
}

/**
 * Calculate severity level for a detected bias
 * @param {string} biasType - Type of bias
 * @param {string} text - Full text being analyzed
 * @param {RegExp} pattern - Pattern that matched
 * @returns {number} Severity level (0-3)
 */
function calculateBiasSeverity(biasType, text, pattern) {
  // Count occurrences of the bias pattern - pattern is precompiled with 'gi' flags
  const matches = text.match(pattern);
  const occurrenceCount = matches ? matches.length : 0;

  // Calculate based on frequency and bias type
  let severity = SEVERITY_LEVELS.low;

  if (occurrenceCount >= 3) {
    severity = SEVERITY_LEVELS.high;
  } else if (occurrenceCount >= 2) {
    severity = SEVERITY_LEVELS.medium;
  }

  // Certain bias types are considered more severe
  if (biasType === 'stereotyping' || biasType === 'selectionBias') {
    severity = Math.min(severity + 1, SEVERITY_LEVELS.high);
  }

  return severity;
}

/**
 * Analyze an action decision for potential bias
 * @param {object} action - The action object from LLM response
 * @returns {object} Bias analysis results
 */
export function analyzeActionForBias(action) {
  if (!action || typeof action !== 'object') {
    return { hasBias: false, biases: [], severity: SEVERITY_LEVELS.none };
  }

  // Analyze different fields of the action
  const analysisResults = [];

  // Analyze reasoning field if present
  if (action.reasoning) {
    analysisResults.push(analyzeForBias(action.reasoning));
  }

  // Analyze target description
  if (action.target) {
    const targetText = typeof action.target === 'string' ? action.target : JSON.stringify(action.target);
    analysisResults.push(analyzeForBias(targetText));
  }

  // Analyze value for type actions
  if (action.type === 'type' && action.value) {
    analysisResults.push(analyzeForBias(action.value));
  }

  // Combine results
  const combinedResult = {
    hasBias: false,
    biases: [],
    severity: SEVERITY_LEVELS.none,
    totalBiasScore: 0
  };

  for (const result of analysisResults) {
    if (result.hasBias) {
      combinedResult.hasBias = true;
      combinedResult.biases.push(...result.biases);
      combinedResult.severity = Math.max(combinedResult.severity, result.severity);
      combinedResult.totalBiasScore += result.totalBiasScore;
    }
  }

  return combinedResult;
}

/**
 * Check if a bias detection should trigger a warning
 * @param {object} biasAnalysis - Result from analyzeForBias or analyzeActionForBias
 * @returns {boolean} True if warning should be shown
 */
export function shouldTriggerBiasWarning(biasAnalysis) {
  if (!biasAnalysis || !biasAnalysis.hasBias) {
    return false;
  }

  // Trigger warning for medium or high severity
  return biasAnalysis.severity >= SEVERITY_LEVELS.medium;
}

/**
 * Generate a human-readable bias report
 * @param {object} biasAnalysis - Result from analyzeForBias or analyzeActionForBias
 * @returns {string} Formatted bias report
 */
export function generateBiasReport(biasAnalysis) {
  if (!biasAnalysis || !biasAnalysis.hasBias) {
    return 'No biases detected.';
  }

  const parts = [];
  parts.push('## Bias Detection Report\n\n');
  parts.push(`**Severity Level:** ${getSeverityLabel(biasAnalysis.severity)}\n`);
  parts.push(`**Biases Detected:** ${biasAnalysis.totalBiasScore}\n\n`);

  for (const bias of biasAnalysis.biases) {
    parts.push(`### ${bias.type}\n`);
    parts.push(`- **Pattern:** ${bias.pattern}\n`);
    parts.push(`- **Severity:** ${getSeverityLabel(bias.severity)}\n`);
    parts.push(`- **Matches:** ${bias.matches.join(', ')}\n\n`);
  }

  return parts.join('');
}

/**
 * Get human-readable severity label
 * @param {number} severity - Severity level (0-3)
 * @returns {string} Severity label
 */
function getSeverityLabel(severity) {
  switch (severity) {
    case SEVERITY_LEVELS.none:
      return 'None';
    case SEVERITY_LEVELS.low:
      return 'Low';
    case SEVERITY_LEVELS.medium:
      return 'Medium';
    case SEVERITY_LEVELS.high:
      return 'High';
    default:
      return 'Unknown';
  }
}

const BIAS_LOG_KEY = 'bias_log_current';

/**
 * Store bias detection in run log
 * @param {object} biasAnalysis - The bias analysis result
 * @param {number} step - The step number
 */
export async function logBiasDetection(biasAnalysis, step = 0) {
  if (!biasAnalysis || !biasAnalysis.hasBias) {
    return;
  }

  try {
    const key = BIAS_LOG_KEY;
    const result = await chrome.storage.local.get([key]);
    const log = result[key] || [];

    log.push({
      step,
      timestamp: Date.now(),
      biases: biasAnalysis.biases,
      severity: biasAnalysis.severity,
      totalScore: biasAnalysis.totalBiasScore
    });

    await chrome.storage.local.set({ [key]: log });
  } catch (e) {
    console.error('[Sentinel] Failed to log bias detection:', getErrorMessage(e));
  }
}

/**
 * Retrieve bias log for the current run.
 * @returns {Promise<Array>} Array of bias detection logs
 */
export async function getBiasLog() {
  try {
    const result = await chrome.storage.local.get([BIAS_LOG_KEY]);
    return result[BIAS_LOG_KEY] || [];
  } catch (e) {
    console.error('[Sentinel] Failed to retrieve bias log:', getErrorMessage(e));
    return [];
  }
}

/**
 * Get overall bias statistics for the current run.
 * @returns {Promise<object>} Bias statistics
 */
export async function getBiasStatistics() {
  const log = await getBiasLog();

  if (log.length === 0) {
    return {
      totalDetections: 0,
      byType: {},
      bySeverity: { none: 0, low: 0, medium: 0, high: 0 },
      mostCommonBias: null
    };
  }

  const stats = {
    totalDetections: log.length,
    byType: {},
    bySeverity: { none: 0, low: 0, medium: 0, high: 0 },
    mostCommonBias: null
  };

  let maxTypeCount = 0;

  for (const entry of log) {
    // Count by severity — only increment known severity keys
    const sevKey = getSeverityLabel(entry.severity).toLowerCase();
    if (sevKey in stats.bySeverity) {
      stats.bySeverity[sevKey]++;
    }

    // Count by bias type
    if (!Array.isArray(entry.biases)) continue;
    for (const bias of entry.biases) {
      if (!stats.byType[bias.type]) {
        stats.byType[bias.type] = 0;
      }
      stats.byType[bias.type]++;

      if (stats.byType[bias.type] > maxTypeCount) {
        maxTypeCount = stats.byType[bias.type];
        stats.mostCommonBias = bias.type;
      }
    }
  }

  return stats;
}

/**
 * Clear bias log for the current run.
 */
export async function clearBiasLog() {
  try {
    await chrome.storage.local.remove(BIAS_LOG_KEY);
  } catch (e) {
    console.error('[Sentinel] Failed to clear bias log:', getErrorMessage(e));
  }
}