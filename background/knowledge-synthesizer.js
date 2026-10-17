// background/knowledge-synthesizer.js
// v7.0 Intelligence System - Knowledge Synthesizer
// Synthesizes knowledge from multiple sources for comprehensive understanding

import { getErrorMessage } from './error-utils.js';

const STORAGE_KEY = 'synthesized_knowledge_current';
const MAX_SYNTHESIS_ENTRIES = 1000;

// Precompile regex for performance optimization
const WHITESPACE_SPLIT_RE = /\s+/;

/**
 * Synthesize knowledge from a run summary or array of sources.
 * Accepts either an object { goal, history, reasoningTrace, biasStats, ... }
 * or an array of { type, content, confidence, source } objects.
 * @param {object|Array} sources - Run summary object or knowledge sources array
 * @returns {Promise<object>} Synthesized knowledge with summary string
 */
export async function synthesizeKnowledge(sources) {
  // Accept run-summary object form (agent-engine.js usage)
  if (sources && !Array.isArray(sources) && typeof sources === 'object') {
    const runData = sources;
    const stepCount = Array.isArray(runData.history) ? runData.history.length : 0;
    const biasDetections = runData.biasStats?.totalDetections ?? 0;
    const contradictions = runData.contradictionStats?.totalDetections ?? 0;
    const reasoningSteps = runData.reasoningTrace?.totalSteps ?? 0;

    const synthesis = {
      synthesized: [{ type: 'run_summary', goal: runData.goal || '', stepCount, reasoningSteps, biasDetections, contradictions }],
      conflicts: [],
      gaps: [],
      summary: `Goal: ${runData.goal || '(none)'} | Steps: ${stepCount} | Reasoning: ${reasoningSteps} | Biases: ${biasDetections} | Contradictions: ${contradictions}`
    };

    await storeSynthesis(synthesis);
    return synthesis;
  }

  if (!sources || (Array.isArray(sources) && sources.length === 0)) {
    return { synthesized: [], conflicts: [], gaps: [], summary: 'No sources provided.' };
  }

  const synthesis = {
    synthesized: [],
    conflicts: [],
    gaps: [],
    summary: '',
    metadata: {
      timestamp: Date.now(),
      sourceCount: sources.length,
      types: new Set()
    }
  };

  const byType = groupByType(sources);

  for (const [type, typeSources] of Object.entries(byType)) {
    const typeSynthesis = await synthesizeByType(type, typeSources);
    synthesis.synthesized.push(...typeSynthesis.synthesized);
    synthesis.conflicts.push(...typeSynthesis.conflicts);
    synthesis.gaps.push(...typeSynthesis.gaps);
    synthesis.metadata.types.add(type);
  }

  const crossSynthesis = await crossTypeSynthesis(synthesis.synthesized);
  synthesis.synthesized.push(...crossSynthesis.synthesized);
  synthesis.conflicts.push(...crossSynthesis.conflicts);
  synthesis.summary = `${synthesis.synthesized.length} items synthesized, ${synthesis.conflicts.length} conflicts`;

  await storeSynthesis(synthesis);
  return synthesis;
}

/**
 * Group sources by type
 * @param {Array} sources - Knowledge sources
 * @returns {object} Grouped sources
 */
function groupByType(sources) {
  const grouped = {};
  
  for (const source of sources) {
    const type = source.type || 'generic';
    if (!grouped[type]) {
      grouped[type] = [];
    }
    grouped[type].push(source);
  }

  return grouped;
}

/**
 * Synthesize knowledge within a type
 * @param {string} type - Knowledge type
 * @param {Array} sources - Sources of this type
 * @returns {Promise<object>} Type synthesis result
 */
async function synthesizeByType(type, sources) {
  const result = {
    synthesized: [],
    conflicts: [],
    gaps: []
  };

  // Merge similar items
  const merged = await mergeSimilarItems(type, sources);
  result.synthesized.push(...merged.synthesized);
  result.conflicts.push(...merged.conflicts);

  // Identify gaps
  const gaps = identifyKnowledgeGaps(type, sources);
  result.gaps.push(...gaps);

  return result;
}

/**
 * Merge similar items within a type
 * @param {string} type - Knowledge type
 * @param {Array} sources - Sources to merge
 * @returns {Promise<object>} Merge result
 */
async function mergeSimilarItems(type, sources) {
  const merged = [];
  const conflicts = [];

  // Simple clustering by similarity
  const clusters = clusterSimilarItems(sources);

  for (const cluster of clusters) {
    if (cluster.items.length === 1) {
      // No merge needed
      merged.push({
        type,
        content: cluster.items[0].content,
        confidence: cluster.items[0].confidence || 0.5,
        sources: [cluster.items[0].source],
        mergeCount: 1
      });
    } else {
      // Merge cluster
      const mergeResult = mergeCluster(cluster);
      merged.push(mergeResult.synthesized);

      // Check for conflicts
      if (mergeResult.hasConflicts) {
        conflicts.push({
          type,
          clusterId: cluster.id,
          conflictingItems: cluster.items,
          severity: 'medium'
        });
      }
    }
  }

  return { synthesized: merged, conflicts };
}

/**
 * Cluster similar items
 * @param {Array} items - Items to cluster
 * @returns {Array} Clusters
 */
function clusterSimilarItems(items) {
  const clusters = [];
  let clusterId = 0;

  for (const item of items) {
    let matched = false;

    // Try to match with existing clusters
    for (const cluster of clusters) {
      if (areItemsSimilar(item, cluster.items[0])) {
        cluster.items.push(item);
        matched = true;
        break;
      }
    }

    // Create new cluster if no match
    if (!matched) {
      clusters.push({
        id: clusterId++,
        items: [item]
      });
    }
  }

  return clusters;
}

/**
 * Check if two items are similar
 * @param {object} item1 - First item
 * @param {object} item2 - Second item
 * @returns {boolean} True if similar
 */
function areItemsSimilar(item1, item2) {
  const content1 = (item1.content || '').toLowerCase();
  const content2 = (item2.content || '').toLowerCase();

  // Simple word overlap check
  const words1 = new Set(content1.split(WHITESPACE_SPLIT_RE));
  const words2 = new Set(content2.split(WHITESPACE_SPLIT_RE));

  const intersection = new Set([...words1].filter(x => words2.has(x)));
  const union = new Set([...words1, ...words2]);

  const similarity = intersection.size / union.size;

  return similarity > 0.5; // 50% similarity threshold
}

/**
 * Merge a cluster of similar items
 * @param {object} cluster - Cluster to merge
 * @returns {object} Merge result
 */
function mergeCluster(cluster) {
  // Combine content (simple concatenation for now)
  const combinedContent = cluster.items
    .map(item => item.content || '')
    .filter(c => c.trim())
    .join('; ');

  // Calculate average confidence
  const avgConfidence = cluster.items.reduce((sum, item) => 
    sum + (item.confidence || 0.5), 0) / cluster.items.length;

  // Collect sources
  const sources = cluster.items.map(item => item.source || 'unknown');

  // Check for conflicts (different confidences indicating disagreement)
  const confidences = cluster.items.map(item => item.confidence || 0.5);
  const confidenceRange = Math.max(...confidences) - Math.min(...confidences);
  const hasConflicts = confidenceRange > 0.3; // 30% difference threshold

  return {
    synthesized: {
      content: combinedContent,
      confidence: avgConfidence,
      sources,
      mergeCount: cluster.items.length
    },
    hasConflicts
  };
}

/**
 * Identify knowledge gaps
 * @param {string} type - Knowledge type
 * @param {Array} sources - Current sources
 * @returns {Array} Knowledge gaps
 */
function identifyKnowledgeGaps(type, sources) {
  const gaps = [];

  // Common gaps by type
  const commonGaps = {
    'action': ['error_handling', 'edge_cases', 'alternatives'],
    'observation': ['page_structure', 'hidden_elements', 'dynamic_content'],
    'decision': ['reasoning', 'alternatives_considered', 'risk_assessment'],
    'generic': ['context', 'assumptions', 'limitations']
  };

  const typeGaps = commonGaps[type] || commonGaps['generic'];

  for (const gap of typeGaps) {
    // Check if gap is filled
    const gapFilled = sources.some(source => 
      source.content && source.content.toLowerCase().includes(gap.replace('_', ' '))
    );

    if (!gapFilled) {
      gaps.push({
        type,
        gap,
        severity: 'low',
        suggestion: `Consider including information about ${gap.replace('_', ' ')}`
      });
    }
  }

  return gaps;
}

/**
 * Cross-type synthesis
 * @param {Array} synthesized - Synthesized items
 * @returns {Promise<object>} Cross-type synthesis result
 */
async function crossTypeSynthesis(synthesized) {
  const result = {
    synthesized: [],
    conflicts: []
  };

  // Group by semantic similarity (simplified)
  const semanticGroups = groupBySemanticSimilarity(synthesized);

  for (const group of semanticGroups) {
    if (group.length > 1) {
      // Check for cross-type conflicts
      const conflicts = detectCrossTypeConflicts(group);
      result.conflicts.push(...conflicts);

      // Create cross-type synthesis
      const groupLen = group.length;
      result.synthesized.push({
        type: 'cross_type',
        content: `Combined knowledge from ${groupLen} sources`,
        sources: group.flatMap(g => g.sources || []),
        confidence: group.reduce((sum, g) => sum + (g.confidence || 0.5), 0) / groupLen,
        involvedTypes: group.map(g => g.type)
      });
    }
  }

  return result;
}

/**
 * Group items by semantic similarity
 * @param {Array} items - Items to group
 * @returns {Array} Semantic groups
 */
function groupBySemanticSimilarity(items) {
  const groups = [];
  const assigned = new Set();
  const itemsLen = items.length;

  for (let i = 0; i < itemsLen; i++) {
    if (assigned.has(i)) continue;

    const group = [items[i]];
    assigned.add(i);

    for (let j = i + 1; j < itemsLen; j++) {
      if (assigned.has(j)) continue;

      if (areSemanticallySimilar(items[i], items[j])) {
        group.push(items[j]);
        assigned.add(j);
      }
    }

    if (group.length > 1) {
      groups.push(group);
    }
  }

  return groups;
}

/**
 * Check if two items are semantically similar
 * @param {object} item1 - First item
 * @param {object} item2 - Second item
 * @returns {boolean} True if semantically similar
 */
function areSemanticallySimilar(item1, item2) {
  const content1 = (item1.content || '').toLowerCase();
  const content2 = (item2.content || '').toLowerCase();

  // Check for shared key terms
  const words1 = content1.split(/\s+/).filter(w => w.length >= 4);
  const words2 = content2.split(/\s+/).filter(w => w.length >= 4);

  if (words1.length === 0 || words2.length === 0) return false;

  const words2Set = new Set(words2);
  let sharedCount = 0;
  for (const word of words1) {
    if (words2Set.has(word)) {
      sharedCount++;
    }
  }

  return sharedCount / Math.min(words1.length, words2.length) > 0.3;
}

/**
 * Detect cross-type conflicts
 * @param {Array} group - Group of semantically similar items
 * @returns {Array} Detected conflicts
 */
function detectCrossTypeConflicts(group) {
  const conflicts = [];
  const groupLen = group.length;

  // Check for contradictory statements across types
  for (let i = 0; i < groupLen; i++) {
    for (let j = i + 1; j < groupLen; j++) {
      if (areContradictory(group[i], group[j])) {
        conflicts.push({
          type: 'cross_type',
          item1: { type: group[i].type, content: group[i].content },
          item2: { type: group[j].type, content: group[j].content },
          severity: 'high'
        });
      }
    }
  }

  return conflicts;
}

/**
 * Check if two synthesized items are contradictory
 * @param {object} item1 - First item
 * @param {object} item2 - Second item
 * @returns {boolean} True if contradictory
 */
function areContradictory(item1, item2) {
  const content1 = (item1.content || '').toLowerCase();
  const content2 = (item2.content || '').toLowerCase();

  // Check for negation patterns
  const negationWords = ['not', 'no', 'never', 'none', 'nothing', 'cannot', 'can not'];

  // Extract key statements
  const statements1 = [];
  const statements2 = [];
  for (const s of content1.split(/[.;]/)) {
    const trimmed = s.trim();
    if (trimmed.length > 0) statements1.push(trimmed);
  }
  for (const s of content2.split(/[.;]/)) {
    const trimmed = s.trim();
    if (trimmed.length > 0) statements2.push(trimmed);
  }

  for (const stmt1 of statements1) {
    for (const stmt2 of statements2) {
      // Check if they share key terms
      const words1 = stmt1.split(/\s+/);
      const words2Set = new Set(stmt2.split(/\s+/));

      const sharedWords = words1.filter(w => w.length >= 3 && words2Set.has(w));
      
      if (sharedWords.length >= 2) {
        // Check for negation in one but not the other
        const hasNegation1 = negationWords.some(nw => stmt1.includes(nw));
        const hasNegation2 = negationWords.some(nw => stmt2.includes(nw));

        if (hasNegation1 !== hasNegation2) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Store synthesis result for the current run.
 * @param {object} synthesis - Synthesis result
 */
export async function storeSynthesis(synthesis) {
  try {
    const result = await chrome.storage.local.get([STORAGE_KEY]);
    const existing = result[STORAGE_KEY] || { entries: [] };

    existing.entries.push(synthesis);

    if (existing.entries.length > MAX_SYNTHESIS_ENTRIES) {
      existing.entries = existing.entries.slice(-MAX_SYNTHESIS_ENTRIES);
    }

    await chrome.storage.local.set({ [STORAGE_KEY]: existing });
  } catch (e) {
    console.error('[Sentinel] Failed to store synthesis:', getErrorMessage(e));
  }
}

/**
 * Get synthesis history for the current run.
 * @returns {Promise<object>} Synthesis history
 */
export async function getSynthesis() {
  try {
    const result = await chrome.storage.local.get([STORAGE_KEY]);
    return result[STORAGE_KEY] || { entries: [] };
  } catch (e) {
    console.error('[Sentinel] Failed to get synthesis:', getErrorMessage(e));
    return { entries: [] };
  }
}

/**
 * Get synthesis statistics for the current run.
 * @returns {Promise<object>} Synthesis statistics
 */
export async function getSynthesisStatistics() {
  const synthesis = await getSynthesis();
  const entries = synthesis.entries || [];

  if (entries.length === 0) {
    return {
      totalSyntheses: 0,
      totalSynthesized: 0,
      totalConflicts: 0,
      totalGaps: 0,
      byType: {}
    };
  }

  const stats = {
    totalSyntheses: entries.length,
    totalSynthesized: 0,
    totalConflicts: 0,
    totalGaps: 0,
    byType: {}
  };

  for (const entry of entries) {
    stats.totalSynthesized += (entry.synthesized || []).length;
    stats.totalConflicts += (entry.conflicts || []).length;
    stats.totalGaps += (entry.gaps || []).length;

    // Count by type
    for (const item of (entry.synthesized || [])) {
      stats.byType[item.type] = (stats.byType[item.type] || 0) + 1;
    }
  }

  return stats;
}

/**
 * Clear synthesis for the current run.
 */
export async function clearSynthesis() {
  try {
    await chrome.storage.local.remove(STORAGE_KEY);
  } catch (e) {
    console.error('[Sentinel] Failed to clear synthesis:', getErrorMessage(e));
  }
}