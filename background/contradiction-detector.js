// background/contradiction-detector.js
// v7.0 Intelligence System - Contradiction Detection
// Detects contradictions in LLM responses and knowledge base

import { getErrorMessage } from './error-utils.js';

// Precompile regex for sentence splitting (performance optimization)
const SENTENCE_SPLIT_RE = /[.!?]+/;
const IS_PATTERN_RE = /(?:is|are|was|were)\s+([a-z][^,.]*)/i;
const NOT_PATTERN_RE = /(?:is|are|was|were)\s+not\s+([a-z][^,.]*)/i;

/**
 * Analyzes text for logical contradictions
 * @param {string} text - Text to analyze
 * @returns {object} Contradiction analysis results
 */
export function analyzeForContradictions(text) {
  if (!text || typeof text !== 'string') {
    return { hasContradictions: false, contradictions: [], totalScore: 0 };
  }

  const contradictions = [];

  // Direct negation contradictions (e.g., "is X" then "is not X")
  const directNegations = findDirectNegationContradictions(text);
  contradictions.push(...directNegations);

  // Temporal contradictions (e.g., "before X" then "after X")
  const temporalContradictions = findTemporalContradictions(text);
  contradictions.push(...temporalContradictions);

  // Quantifier contradictions (e.g., "all" then "some" or "none")
  const quantifierContradictions = findQuantifierContradictions(text);
  contradictions.push(...quantifierContradictions);

  // Numerical contradictions (e.g., "5 items" then "3 items")
  const numericalContradictions = findNumericalContradictions(text);
  contradictions.push(...numericalContradictions);

  // Conditional contradictions (e.g., "if X then Y" then "if X then not Y")
  const conditionalContradictions = findConditionalContradictions(text);
  contradictions.push(...conditionalContradictions);

  return {
    hasContradictions: contradictions.length > 0,
    contradictions: contradictions,
    totalScore: contradictions.length
  };
}

/**
 * Find direct negation contradictions (X vs not X)
 * @param {string} text - Text to analyze
 * @returns {Array} Array of contradiction objects
 */
function findDirectNegationContradictions(text) {
  const contradictions = [];
  const sentences = text.split(SENTENCE_SPLIT_RE).filter(s => s.trim());
  const sentencesLen = sentences.length;

  for (let i = 0; i < sentencesLen; i++) {
    for (let j = i + 1; j < sentencesLen; j++) {
      const sent1 = sentences[i].trim().toLowerCase();
      const sent2 = sentences[j].trim().toLowerCase();

      // Check for "is X" vs "is not X" pattern
      const match1 = sent1.match(IS_PATTERN_RE);
      const match2 = sent2.match(NOT_PATTERN_RE);

      if (match1 && match2) {
        const term1 = match1[1].trim().toLowerCase();
        const term2 = match2[1].trim().toLowerCase();

        if (term1 === term2 || term1.includes(term2) || term2.includes(term1)) {
          contradictions.push({
            type: 'direct_negation',
            sentence1: sentences[i].trim(),
            sentence2: sentences[j].trim(),
            term: term1,
            severity: 'high'
          });
        }
      }
    }
  }

  return contradictions;
}

/**
 * Find temporal contradictions
 * @param {string} text - Text to analyze
 * @returns {Array} Array of contradiction objects
 */
function findTemporalContradictions(text) {
  const contradictions = [];
  const temporalMarkers = [
    { before: ['before', 'prior to', 'earlier than', 'preceding'], after: ['after', 'subsequent to', 'later than', 'following'] },
    { before: ['already', 'previously', 'formerly'], after: ['not yet', 'still not', 'never'] }
  ];

  const sentences = text.split(SENTENCE_SPLIT_RE).filter(s => s.trim());

  for (const markerGroup of temporalMarkers) {
    for (const sentence of sentences) {
      const sentLower = sentence.toLowerCase();
      
      for (const beforeWord of markerGroup.before) {
        for (const afterWord of markerGroup.after) {
          if (sentLower.includes(beforeWord) && sentLower.includes(afterWord)) {
            contradictions.push({
              type: 'temporal',
              sentence: sentence.trim(),
              markers: [beforeWord, afterWord],
              severity: 'medium'
            });
            break;
          }
        }
      }
    }
  }

  return contradictions;
}

/**
 * Find quantifier contradictions
 * @param {string} text - Text to analyze
 * @returns {Array} Array of contradiction objects
 */
function findQuantifierContradictions(text) {
  const contradictions = [];

  const quantifiers = {
    universal: ['all', 'every', 'each', 'any', 'always', 'never', 'none'],
    existential: ['some', 'most', 'many', 'few', 'several', 'often', 'sometimes', 'rarely']
  };

  const sentences = text.split(SENTENCE_SPLIT_RE).filter(s => s.trim());
  const sentencesLen = sentences.length;

  for (let i = 0; i < sentencesLen; i++) {
    for (let j = i + 1; j < sentencesLen; j++) {
      const sent1 = sentences[i].trim().toLowerCase();
      const sent2 = sentences[j].trim().toLowerCase();

      // Check for universal vs existential about same subject
      for (const uni of quantifiers.universal) {
        for (const exis of quantifiers.existential) {
          if (sent1.includes(uni) && sent2.includes(exis)) {
            // Try to extract the subject
            const subjectPattern = new RegExp(`\\b([a-z]+)\\s+(?:is|are|was|were)\\s+(?:${uni}|${exis})`, 'i');
            const match1 = sent1.match(subjectPattern);
            const match2 = sent2.match(subjectPattern);

            if (match1 && match2 && match1[1] === match2[1]) {
              contradictions.push({
                type: 'quantifier',
                sentence1: sentences[i].trim(),
                sentence2: sentences[j].trim(),
                subject: match1[1],
                quantifiers: [uni, exis],
                severity: 'medium'
              });
            }
          }
        }
      }
    }
  }

  return contradictions;
}

/**
 * Find numerical contradictions
 * @param {string} text - Text to analyze
 * @returns {Array} Array of contradiction objects
 */
function findNumericalContradictions(text) {
  const contradictions = [];
  
  // Extract all numbers with their context
  const numberPattern = /(\d+)\s*([a-z]+)/gi;
  const matches = [];
  let match;

  while ((match = numberPattern.exec(text)) !== null) {
    matches.push({
      number: parseInt(match[1], 10),
      unit: match[2].toLowerCase(),
      context: text.substring(Math.max(0, match.index - 50), match.index + 50)
    });
  }

  // Compare numbers with same units
  const matchesLen = matches.length;
  for (let i = 0; i < matchesLen; i++) {
    for (let j = i + 1; j < matchesLen; j++) {
      if (matches[i].unit === matches[j].unit && matches[i].number !== matches[j].number) {
        contradictions.push({
          type: 'numerical',
          context1: matches[i].context,
          context2: matches[j].context,
          unit: matches[i].unit,
          values: [matches[i].number, matches[j].number],
          severity: 'medium'
        });
      }
    }
  }

  return contradictions;
}

/**
 * Find conditional contradictions
 * @param {string} text - Text to analyze
 * @returns {Array} Array of contradiction objects
 */
function findConditionalContradictions(text) {
  const contradictions = [];
  
  // Match conditional statements
  const conditionalPattern = /if\s+([^.!?]+)\s+then\s+([^.!?]+)/gi;
  const conditionals = [];
  let match;

  while ((match = conditionalPattern.exec(text)) !== null) {
    conditionals.push({
      condition: match[1].trim(),
      consequence: match[2].trim(),
      full: match[0]
    });
  }

  // Compare conditionals with same condition but different consequences
  const conditionalsLen = conditionals.length;
  for (let i = 0; i < conditionalsLen; i++) {
    for (let j = i + 1; j < conditionalsLen; j++) {
      const cond1 = conditionals[i].condition.toLowerCase();
      const cond2 = conditionals[j].condition.toLowerCase();
      const cons1 = conditionals[i].consequence.toLowerCase();
      const cons2 = conditionals[j].consequence.toLowerCase();

      // Check if conditions are similar
      if (cond1.includes(cond2) || cond2.includes(cond1) || cond1 === cond2) {
        // Check if consequences are opposites
        const negationWords = ['not', 'no', 'never', 'none', 'nothing'];
        const hasNegation1 = negationWords.some(word => cons1.includes(word));
        const hasNegation2 = negationWords.some(word => cons2.includes(word));

        if ((hasNegation1 && !hasNegation2) || (!hasNegation1 && hasNegation2)) {
          contradictions.push({
            type: 'conditional',
            conditional1: conditionals[i].full,
            conditional2: conditionals[j].full,
            condition: cond1,
            consequences: [conditionals[i].consequence, conditionals[j].consequence],
            severity: 'high'
          });
        }
      }
    }
  }

  return contradictions;
}

/**
 * Compare two LLM responses for contradictions
 * @param {string} response1 - First response
 * @param {string} response2 - Second response
 * @returns {object} Contradiction comparison results
 */
export function compareResponsesForContradictions(response1, response2) {
  const r1 = typeof response1 === 'string' ? response1 : '';
  const r2 = typeof response2 === 'string' ? response2 : '';
  const analysis1 = analyzeForContradictions(r1);
  const analysis2 = analyzeForContradictions(r2);

  const crossContradictions = [];

  // Compare direct statements between responses
  const statements1 = extractStatements(r1);
  const statements2 = extractStatements(r2);

  for (const stmt1 of statements1) {
    for (const stmt2 of statements2) {
      if (areContradictoryStatements(stmt1, stmt2)) {
        crossContradictions.push({
          type: 'cross_response',
          statement1: stmt1,
          statement2: stmt2,
          severity: 'high'
        });
      }
    }
  }

  return {
    response1Contradictions: analysis1,
    response2Contradictions: analysis2,
    crossResponseContradictions: crossContradictions,
    totalContradictions: analysis1.totalScore + analysis2.totalScore + crossContradictions.length
  };
}

/**
 * Extract atomic statements from text
 * @param {string} text - Text to parse
 * @returns {Array} Array of statements
 */
function extractStatements(text) {
  const statements = [];
  const sentences = text.split(SENTENCE_SPLIT_RE).filter(s => s.trim());
  
  for (const sentence of sentences) {
    // Extract subject-verb-object triples
    const svoPattern = /(.+?)\s+(is|are|was|were|has|have|had|will|would|should|could|can|may)\s+(.+)/i;
    const match = sentence.match(svoPattern);
    
    if (match) {
      statements.push({
        subject: match[1].trim(),
        verb: match[2].trim(),
        object: match[3].trim(),
        full: sentence.trim()
      });
    }
  }

  return statements;
}

/**
 * Check if two statements are contradictory
 * @param {object} stmt1 - First statement
 * @param {object} stmt2 - Second statement
 * @returns {boolean} True if statements contradict
 */
function areContradictoryStatements(stmt1, stmt2) {
  // Check same subject
  const subject1 = stmt1.subject.toLowerCase();
  const subject2 = stmt2.subject.toLowerCase();
  if (subject1 !== subject2) {
    return false;
  }

  // Check same verb (or negation of verb)
  const verb1 = stmt1.verb.toLowerCase();
  const verb2 = stmt2.verb.toLowerCase();

  if (verb1 !== verb2 && !verb1.includes(verb2) && !verb2.includes(verb1)) {
    return false;
  }

  // Check if objects are opposites
  const obj1 = stmt1.object.toLowerCase();
  const obj2 = stmt2.object.toLowerCase();

  const negationWords = ['not', 'no', 'never', 'none', 'nothing'];
  const hasNegation1 = negationWords.some(word => obj1.includes(word));
  const hasNegation2 = negationWords.some(word => obj2.includes(word));

  // One has negation, other doesn't
  if (hasNegation1 !== hasNegation2) {
    // Check if the non-negated parts are similar
    const cleanObj1 = obj1.replace(/\b(not|no|never|none|nothing)\b/gi, '').trim();
    const cleanObj2 = obj2.replace(/\b(not|no|never|none|nothing)\b/gi, '').trim();

    if (cleanObj1 === cleanObj2 || cleanObj1.includes(cleanObj2) || cleanObj2.includes(cleanObj1)) {
      return true;
    }
  }

  return false;
}

const CONTRADICTION_LOG_KEY = 'contradiction_log_current';

/**
 * Log contradiction detection for the current run.
 * @param {object} contradictionAnalysis - Analysis result
 * @param {number} step - Step number
 */
export async function logContradictionDetection(contradictionAnalysis, step = 0) {
  if (!contradictionAnalysis || !contradictionAnalysis.hasContradictions) {
    return;
  }

  try {
    const result = await chrome.storage.local.get([CONTRADICTION_LOG_KEY]);
    const log = result[CONTRADICTION_LOG_KEY] || [];

    log.push({
      step,
      timestamp: Date.now(),
      contradictions: contradictionAnalysis.contradictions,
      totalScore: contradictionAnalysis.totalScore
    });

    await chrome.storage.local.set({ [CONTRADICTION_LOG_KEY]: log });
  } catch (e) {
    console.error('[Sentinel] Failed to log contradiction detection:', getErrorMessage(e));
  }
}

/**
 * Get contradiction log for the current run.
 * @returns {Promise<Array>} Contradiction log
 */
export async function getContradictionLog() {
  try {
    const result = await chrome.storage.local.get([CONTRADICTION_LOG_KEY]);
    return result[CONTRADICTION_LOG_KEY] || [];
  } catch (e) {
    console.error('[Sentinel] Failed to retrieve contradiction log:', getErrorMessage(e));
    return [];
  }
}

/**
 * Get contradiction statistics for the current run.
 * @returns {Promise<object>} Contradiction statistics
 */
export async function getContradictionStatistics() {
  const log = await getContradictionLog();

  if (log.length === 0) {
    return {
      totalDetections: 0,
      byType: {},
      bySeverity: { high: 0, medium: 0, low: 0 },
      mostCommonType: null
    };
  }

  const stats = {
    totalDetections: log.length,
    byType: {},
    bySeverity: { high: 0, medium: 0, low: 0 },
    mostCommonType: null
  };

  let maxTypeCount = 0;

  for (const entry of log) {
    if (!Array.isArray(entry.contradictions)) continue;
    for (const contradiction of entry.contradictions) {
      // Count by type
      stats.byType[contradiction.type] = (stats.byType[contradiction.type] || 0) + 1;

      // Count by severity — only increment known severity levels
      if (contradiction.severity in stats.bySeverity) {
        stats.bySeverity[contradiction.severity]++;
      }

      // Track most common type
      if (stats.byType[contradiction.type] > maxTypeCount) {
        maxTypeCount = stats.byType[contradiction.type];
        stats.mostCommonType = contradiction.type;
      }
    }
  }

  return stats;
}

/**
 * Clear contradiction log for a run
 */
export async function clearContradictionLog() {
  try {
    await chrome.storage.local.remove(CONTRADICTION_LOG_KEY);
  } catch (e) {
    console.error('[Sentinel] Failed to clear contradiction log:', getErrorMessage(e));
  }
}