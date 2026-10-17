// background/novelty-detector.js
// v7.0 Intelligence System - Novelty Detection
// Detects novel patterns, information, and behaviors

import { getErrorMessage } from './error-utils.js';

const STORAGE_KEY = 'novelty_history';
const MAX_HISTORY = 5000;

// Track the most recently used runId so stats/clear work without explicit runId
let _currentRunId = null;

// Precompile regex patterns for performance optimization
const WHITESPACE_SPLIT_RE = /\s+/;
const NON_ALPHA_RE = /[^a-z]/g;
const DIGIT_RE = /\d+/g;
const QUOTED_STRING_RE = /"[^"]*"/g;
const ELEMENT_TYPE_RE = /\b(button|input|link|text|element|field)\b/g;
const URL_RE = /https?:\/\/[^\s]+/g;
const ACTION_RE = /\b(click|type|navigate|scroll|extract|wait)\b/g;

/**
 * Analyze information for novelty
 * @param {string} runId - Run identifier
 * @param {object} data - Data to analyze { type, content, context }
 * @returns {Promise<object>} Novelty analysis results
 */
export async function analyzeForNovelty(runId, data) {
  const { type = 'generic', content = '', context = {} } = data;

  if (!content || typeof content !== 'string') {
    return { isNovel: false, confidence: 0, reasons: [] };
  }

  // Get historical patterns
  const history = await getNoveltyHistory(runId);
  
  const reasons = [];
  let noveltyScore = 0;

  // Check 1: Content similarity to historical data
  const similarityResult = await checkContentSimilarity(content, history);
  if (!similarityResult.isSimilar) {
    noveltyScore += 0.3;
    reasons.push({
      factor: 'content_dissimilarity',
      description: 'Content differs significantly from historical patterns',
      confidence: similarityResult.confidence
    });
  }

  // Check 2: Pattern uniqueness
  const patternResult = await checkPatternUniqueness(type, content, history);
  if (patternResult.isUnique) {
    noveltyScore += 0.2;
    reasons.push({
      factor: 'pattern_uniqueness',
      description: 'Pattern structure is unique',
      confidence: patternResult.confidence
    });
  }

  // Check 3: Context novelty
  const contextResult = await checkContextNovelty(context, history);
  if (contextResult.isNovel) {
    noveltyScore += 0.2;
    reasons.push({
      factor: 'context_novelty',
      description: 'Context or situation is novel',
      confidence: contextResult.confidence
    });
  }

  // Check 4: Semantic novelty
  const semanticResult = await checkSemanticNovelty(content, history);
  if (semanticResult.isNovel) {
    noveltyScore += 0.2;
    reasons.push({
      factor: 'semantic_novelty',
      description: 'Meaning or concept is novel',
      confidence: semanticResult.confidence
    });
  }

  // Check 5: Behavioral novelty (for actions)
  if (type === 'action' || type === 'decision') {
    const behaviorResult = await checkBehavioralNovelty(data, history);
    if (behaviorResult.isNovel) {
      noveltyScore += 0.1;
      reasons.push({
        factor: 'behavioral_novelty',
        description: 'Behavior pattern is novel',
        confidence: behaviorResult.confidence
      });
    }
  }

  const isNovel = noveltyScore >= 0.5;
  const confidence = Math.min(noveltyScore * 1.5, 1.0); // Scale to max 1.0

  return {
    isNovel,
    confidence,
    noveltyScore,
    reasons
  };
}

/**
 * Check content similarity to historical data
 * @param {string} content - Content to check
 * @param {Array} history - Historical data
 * @returns {Promise<object>} Similarity analysis
 */
async function checkContentSimilarity(content, history) {
  if (history.length === 0) {
    return { isSimilar: false, confidence: 1.0 };
  }

  // Simple word overlap similarity
  const contentWords = new Set(content.toLowerCase().split(WHITESPACE_SPLIT_RE));
  let maxSimilarity = 0;

  for (const entry of history) {
    const entryContent = (entry.content || '').toLowerCase();
    const entryWords = new Set(entryContent.split(WHITESPACE_SPLIT_RE));

    // Calculate Jaccard similarity
    const intersection = new Set([...contentWords].filter(x => entryWords.has(x)));
    const union = new Set([...contentWords, ...entryWords]);
    const similarity = intersection.size / union.size;

    if (similarity > maxSimilarity) {
      maxSimilarity = similarity;
    }
  }

  // If max similarity is low, content is novel
  return {
    isSimilar: maxSimilarity > 0.6,
    confidence: 1 - maxSimilarity
  };
}

/**
 * Check pattern uniqueness
 * @param {string} type - Data type
 * @param {string} content - Content to check
 * @param {Array} history - Historical data
 * @returns {Promise<object>} Pattern analysis
 */
async function checkPatternUniqueness(type, content, history) {
  if (history.length === 0) {
    return { isUnique: true, confidence: 1.0 };
  }

  // Extract structural pattern (e.g., "click on [element]" pattern)
  const pattern = extractPattern(content);
  const typeHistory = history.filter(entry => entry.type === type);

  let patternCount = 0;
  for (const entry of typeHistory) {
    const entryPattern = extractPattern(entry.content || '');
    if (entryPattern === pattern) {
      patternCount++;
    }
  }

  const uniqueness = 1 - (patternCount / Math.max(typeHistory.length, 1));

  return {
    isUnique: uniqueness > 0.7,
    confidence: uniqueness
  };
}

/**
 * Extract structural pattern from content
 * @param {string} content - Content to analyze
 * @returns {string} Structural pattern
 */
function extractPattern(content) {
  // Replace specific values with placeholders
  let pattern = content.toLowerCase();

  // Replace numbers
  pattern = pattern.replace(DIGIT_RE, '[NUM]');

  // Replace quoted strings
  pattern = pattern.replace(QUOTED_STRING_RE, '[STR]');

  // Replace specific elements
  pattern = pattern.replace(ELEMENT_TYPE_RE, '[ELEMENT]');

  // Replace URLs
  pattern = pattern.replace(URL_RE, '[URL]');

  // Replace specific actions
  pattern = pattern.replace(ACTION_RE, '[ACTION]');

  return pattern;
}

/**
 * Check context novelty
 * @param {object} context - Context data
 * @param {Array} history - Historical data
 * @returns {Promise<object>} Context analysis
 */
async function checkContextNovelty(context, history) {
  if (history.length === 0) {
    return { isNovel: true, confidence: 1.0 };
  }

  const contextKeys = Object.keys(context);
  if (contextKeys.length === 0) {
    return { isNovel: false, confidence: 0 };
  }

  // Pre-build a Set of "key\0value" combos from all history entries (O(history))
  const seenCombos = new Set();
  for (const entry of history) {
    const entryContext = entry.context || {};
    for (const [k, v] of Object.entries(entryContext)) {
      seenCombos.add(`${k}\0${v}`);
    }
  }

  let novelFeatures = 0;
  for (const key of contextKeys) {
    if (!seenCombos.has(`${key}\0${context[key]}`)) {
      novelFeatures++;
    }
  }

  const noveltyRatio = novelFeatures / contextKeys.length;

  return {
    isNovel: noveltyRatio > 0.5,
    confidence: noveltyRatio
  };
}

/**
 * Check semantic novelty
 * @param {string} content - Content to analyze
 * @param {Array} history - Historical data
 * @returns {Promise<object>} Semantic analysis
 */
async function checkSemanticNovelty(content, history) {
  if (history.length === 0) {
    return { isNovel: true, confidence: 1.0 };
  }

  // Extract key concepts (nouns, verbs)
  const concepts = extractConcepts(content);

  // Pre-build a Set of all words seen across history (O(total words))
  const historyWords = new Set();
  for (const entry of history) {
    const words = (entry.content || '').toLowerCase().split(WHITESPACE_SPLIT_RE);
    for (const w of words) {
      const clean = w.replace(NON_ALPHA_RE, '');
      if (clean) historyWords.add(clean);
    }
  }

  let novelConcepts = 0;
  for (const concept of concepts) {
    if (!historyWords.has(concept)) {
      novelConcepts++;
    }
  }

  const conceptNovelty = concepts.length > 0 ? novelConcepts / concepts.length : 0;

  return {
    isNovel: conceptNovelty > 0.3,
    confidence: conceptNovelty
  };
}

/**
 * Extract concepts from content
 * @param {string} content - Content to analyze
 * @returns {Set} Set of concepts
 */
function extractConcepts(content) {
  const concepts = new Set();
  
  // Simple noun/verb extraction (common words to skip)
  const skipWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'should', 'could', 'may', 'might', 'can', 'to', 'from', 'in', 'on', 'at', 'by', 'with', 'for', 'of', 'and', 'or', 'but', 'if', 'then', 'when', 'while', 'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them', 'their', 'he', 'she', 'him', 'her', 'his', 'hers', 'you', 'your', 'we', 'us', 'our', 'i', 'me', 'my', 'mine']);

  const words = content.toLowerCase().split(WHITESPACE_SPLIT_RE);
  for (const word of words) {
    const cleanWord = word.replace(NON_ALPHA_RE, '');
    if (cleanWord.length >= 3 && !skipWords.has(cleanWord)) {
      concepts.add(cleanWord);
    }
  }

  return concepts;
}

/**
 * Check behavioral novelty
 * @param {object} data - Action/decision data
 * @param {Array} history - Historical data
 * @returns {Promise<object>} Behavioral analysis
 */
async function checkBehavioralNovelty(data, history) {
  const typeHistory = history.filter(entry => 
    entry.type === 'action' || entry.type === 'decision'
  );

  if (typeHistory.length === 0) {
    return { isNovel: true, confidence: 1.0 };
  }

  // Check action sequence novelty
  const currentAction = data.action || data.decision || '';
  let actionSeen = false;

  for (const entry of typeHistory) {
    const entryAction = entry.action || entry.decision || '';
    if (entryAction === currentAction) {
      actionSeen = true;
      break;
    }
  }

  // Check target-action combination novelty
  const targetActionCombo = `${data.target || ''}:${currentAction}`;
  let comboSeen = false;

  for (const entry of typeHistory) {
    const entryCombo = `${entry.target || ''}:${entry.action}`;
    if (entryCombo === targetActionCombo) {
      comboSeen = true;
      break;
    }
  }

  const noveltyScore = (!actionSeen ? 0.5 : 0) + (!comboSeen ? 0.5 : 0);

  return {
    isNovel: noveltyScore > 0.5,
    confidence: noveltyScore
  };
}

/**
 * Store novelty detection result
 * @param {string} runId - Run identifier
 * @param {object} data - Data that was analyzed
 * @param {object} result - Novelty analysis result
 */
export async function storeNoveltyResult(runId, data, result) {
  _currentRunId = runId;
  try {
    const history = await getNoveltyHistory(runId);

    // Add new entry
    history.push({
      timestamp: Date.now(),
      type: data.type,
      content: data.content,
      context: data.context,
      isNovel: result.isNovel,
      confidence: result.confidence,
      reasons: result.reasons
    });

    // Cap history size
    if (history.length > MAX_HISTORY) {
      history.splice(0, history.length - MAX_HISTORY);
    }

    // Persist
    const key = `${STORAGE_KEY}_${runId}`;
    await chrome.storage.local.set({ [key]: history });
  } catch (e) {
    console.error('[Sentinel] Failed to store novelty result:', getErrorMessage(e));
  }
}

/**
 * Get novelty history for a run
 * @param {string} runId - Run identifier
 * @returns {Promise<Array>} Novelty history
 */
export async function getNoveltyHistory(runId) {
  try {
    const key = `${STORAGE_KEY}_${runId}`;
    const result = await chrome.storage.local.get([key]);
    return result[key] || [];
  } catch (e) {
    console.error('[Sentinel] Failed to get novelty history:', getErrorMessage(e));
    return [];
  }
}

/**
 * Get novelty statistics for the current (or specified) run.
 * @param {string} [runId] - Run identifier; defaults to the most recent run
 * @returns {Promise<object>} Novelty statistics
 */
export async function getNoveltyStatistics(runId) {
  const history = await getNoveltyHistory(runId || _currentRunId);

  if (history.length === 0) {
    return {
      totalItems: 0,
      novelItems: 0,
      noveltyRatio: 0,
      byType: {},
      avgConfidence: 0
    };
  }

  const stats = {
    totalItems: history.length,
    novelItems: 0,
    noveltyRatio: 0,
    byType: {},
    avgConfidence: 0,
    totalConfidence: 0
  };

  for (const entry of history) {
    if (entry.isNovel) {
      stats.novelItems++;
    }

    stats.byType[entry.type] = (stats.byType[entry.type] || 0) + 1;
    stats.totalConfidence += entry.confidence || 0;
  }

  stats.noveltyRatio = stats.novelItems / stats.totalItems;
  stats.avgConfidence = stats.totalConfidence / stats.totalItems;

  return stats;
}

/**
 * Clear novelty history for the current (or specified) run.
 * @param {string} [runId] - Run identifier; defaults to the most recent run
 */
export async function clearNoveltyHistory(runId) {
  const id = runId || _currentRunId;
  if (!id) return; // nothing stored yet
  _currentRunId = null;
  try {
    await chrome.storage.local.remove(`${STORAGE_KEY}_${id}`);
  } catch (e) {
    console.error('[Sentinel] Failed to clear novelty history:', getErrorMessage(e));
  }
}