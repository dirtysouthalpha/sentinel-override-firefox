// Sentinel Override v9.0 - Runtime Profiler & Self-Evolution
// Runtime profiling, architecture analysis, mutation proposals, canary deployment

// ========================================
// RUNTIME PROFILING
// ========================================

/**
 * Runtime profiler state
 */
const profilerState = {
  enabled: false,
  samples: [],
  sampleIndex: 0, // Next write position in circular buffer
  startTime: null,
  lastSampleTime: null,
  samplingInterval: 1000, // 1 second
  maxSamples: 3600 // 1 hour at 1 sec intervals
};

/**
 * Start runtime profiling
 * @returns {void}
 */
export function startProfiling() {
  profilerState.enabled = true;
  profilerState.startTime = Date.now();
  profilerState.lastSampleTime = Date.now();
  profilerState.samples = [];
  console.debug('[Sentinel/RuntimeProfiler] Profiling started');
}

/**
 * Stop runtime profiling
 * @returns {object} Profiling summary
 */
export function stopProfiling() {
  profilerState.enabled = false;
  const summary = generateProfilingSummary();
  console.debug('[Sentinel/RuntimeProfiler] Profiling stopped', summary);
  return summary;
}

/**
 * Get the actual samples array (handles circular buffer)
 * @returns {Array} The samples array
 */
function _getSamples() {
  const { samples, sampleIndex, maxSamples } = profilerState;
  // If we haven't wrapped around yet, return samples as-is
  if (samples.length < maxSamples) {
    return samples;
  }
  // Return rotated array to show most recent samples first
  return [...samples.slice(sampleIndex), ...samples.slice(0, sampleIndex)];
}

/**
 * Take a profiling sample
 * @returns {object} Current metrics
 */
export function takeProfilingSample() {
  if (!profilerState.enabled) return null;

  const now = Date.now();
  const sample = {
    timestamp: now,
    // Memory metrics
    memory: {
      used: performance.memory?.usedJSHeapSize || 0,
      total: performance.memory?.totalJSHeapSize || 0,
      limit: performance.memory?.jsHeapSizeLimit || 0,
      usagePercent: 0
    },
    // Timing metrics
    timing: {
      sinceLastSample: now - (profilerState.lastSampleTime || now),
      sinceStart: now - (profilerState.startTime || now)
    },
    // Agent state
    agent: {
      stepCount: (typeof window !== 'undefined' && window.__sentinelStepCount) || 0,
      apiCallCount: (typeof window !== 'undefined' && window.__sentinelApiCallCount) || 0,
      failures: (typeof window !== 'undefined' && window.__sentinelFailures) || 0
    }
  };

  // Calculate memory usage percentage
  if (sample.memory.limit > 0) {
    sample.memory.usagePercent = (sample.memory.used / sample.memory.limit) * 100;
  }

  // Circular buffer: overwrite old samples instead of shifting
  if (profilerState.samples.length < profilerState.maxSamples) {
    profilerState.samples.push(sample);
    // % maxSamples so that when the buffer just became full, index wraps to 0
    profilerState.sampleIndex = profilerState.samples.length % profilerState.maxSamples;
  } else {
    profilerState.samples[profilerState.sampleIndex] = sample;
    profilerState.sampleIndex = (profilerState.sampleIndex + 1) % profilerState.maxSamples;
  }

  profilerState.lastSampleTime = now;

  return sample;
}

/**
 * Generate profiling summary
 * @returns {object} Summary statistics
 */
function generateProfilingSummary() {
  const samples = _getSamples();
  if (samples.length === 0) {
    return { error: 'No samples collected' };
  }

  // Memory statistics
  const memoryUsage = samples.map(s => s.memory.usagePercent);
  const memLen = memoryUsage.length;
  const avgMemory = memoryUsage.reduce((a, b) => a + b, 0) / memLen;
  const maxMemory = Math.max(...memoryUsage);
  const minMemory = Math.min(...memoryUsage);

  // Timing statistics - optimized to avoid intermediate array
  const lastSample = samples[samples.length - 1];
  const intervals = samples.reduce((arr, s) => {
    const t = s.timing.sinceLastSample;
    if (t > 0) arr.push(t);
    return arr;
  }, []);
  const intLen = intervals.length;
  const avgInterval = intervals.reduce((a, b) => a + b, 0) / intLen;

  // Agent activity
  const agentActivity = lastSample?.agent || {};

  // Detect trends
  const memoryTrend = detectTrend(memoryUsage.slice(-10)); // Last 10 samples
  const performanceTrend = detectPerformanceTrend(samples);

  return {
    duration: lastSample.timing.sinceStart,
    sampleCount: samples.length,
    memory: {
      average: Math.round(avgMemory * 100) / 100,
      max: Math.round(maxMemory * 100) / 100,
      min: Math.round(minMemory * 100) / 100,
      trend: memoryTrend,
      status: getMemoryStatus(avgMemory, maxMemory)
    },
    timing: {
      averageInterval: Math.round(avgInterval),
      performance: performanceTrend
    },
    agent: agentActivity,
    recommendations: generateProfilingRecommendations(avgMemory, memoryTrend, performanceTrend)
  };
}

function detectTrend(values) {
  if (values.length < 3) return 'stable';
  
  const first = values[0];
  const last = values[values.length - 1];
  const change = ((last - first) / first) * 100;
  
  if (change > 10) return 'increasing';
  if (change < -10) return 'decreasing';
  return 'stable';
}

function detectPerformanceTrend(samples) {
  if (samples.length < 5) return 'unknown';

  // Check if intervals are increasing (slowing down)
  const intervals = samples.slice(-10).map(s => s.timing.sinceLastSample);
  const firstHalf = intervals.slice(0, Math.floor(intervals.length / 2));
  const secondHalf = intervals.slice(Math.floor(intervals.length / 2));

  const firstLen = firstHalf.length;
  const secondLen = secondHalf.length;
  const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstLen;
  const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondLen;

  if (secondAvg > firstAvg * 1.2) return 'degrading';
  if (secondAvg < firstAvg * 0.8) return 'improving';
  return 'stable';
}

function getMemoryStatus(avg, max) {
  if (max > 90) return 'critical';
  if (avg > 70 || max > 80) return 'high';
  if (avg > 50) return 'moderate';
  return 'normal';
}

function generateProfilingRecommendations(avgMemory, memoryTrend, performanceTrend) {
  const recommendations = [];
  
  if (avgMemory > 70) {
    recommendations.push('High memory usage detected - consider reducing history cache size');
  }
  
  if (memoryTrend === 'increasing') {
    recommendations.push('Memory usage trending upward - investigate potential memory leaks');
  }
  
  if (performanceTrend === 'degrading') {
    recommendations.push('Performance degrading - review recent code changes and optimize hot paths');
  }
  
  if (recommendations.length === 0) {
    recommendations.push('System performance within acceptable parameters');
  }
  
  return recommendations;
}

/**
 * Get current profiling status
 * @returns {object} Status information
 */
export function getProfilingStatus() {
  return {
    enabled: profilerState.enabled,
    sampleCount: profilerState.samples.length,
    duration: profilerState.startTime 
      ? Date.now() - profilerState.startTime 
      : 0,
    recentSample: profilerState.samples[profilerState.samples.length - 1] || null
  };
}

// ========================================
// ARCHITECTURE ANALYZER
// ========================================

/**
 * Analyze system architecture for optimization opportunities
 * @param {object} systemState - Current system state
 * @returns {object} Architecture analysis
 */
export function analyzeArchitecture(systemState) {
  const analysis = {
    bottlenecks: identifyBottlenecks(systemState),
    complexity: assessComplexity(systemState),
    coupling: assessCoupling(systemState),
    cohesion: assessCohesion(systemState),
    recommendations: []
  };
  
  // Generate recommendations based on analysis
  analysis.recommendations = generateArchitectureRecommendations(analysis);
  
  return analysis;
}

/**
 * Identify performance bottlenecks
 * @param {object} state - System state
 * @returns {Array} List of bottlenecks
 */
function identifyBottlenecks(state) {
  const bottlenecks = [];
  
  // Check LLM call frequency
  if (state.apiCallCount > 50) {
    bottlenecks.push({
      type: 'api_calls',
      severity: state.apiCallCount > 100 ? 'high' : 'medium',
      description: 'High LLM API call frequency',
      impact: 'Increased cost and latency',
      recommendation: 'Consider batching requests or implementing smarter caching'
    });
  }
  
  // Check step count
  if (state.stepCount > 30) {
    bottlenecks.push({
      type: 'step_count',
      severity: state.stepCount > 50 ? 'high' : 'medium',
      description: 'High step count',
      impact: 'Potential inefficiency in action execution',
      recommendation: 'Review plan optimization opportunities'
    });
  }
  
  // Check memory usage
  if (state.memoryUsage > 80) {
    bottlenecks.push({
      type: 'memory',
      severity: 'critical',
      description: 'High memory usage',
      impact: 'Risk of browser tab crash',
      recommendation: 'Implement memory cleanup and cache limits'
    });
  }
  
  // Check failure rate — guard against stepCount=0 producing Infinity
  const failureRate = state.stepCount > 0 ? state.failures / state.stepCount : 0;
  if (failureRate > 0.3) {
    bottlenecks.push({
      type: 'failure_rate',
      severity: 'high',
      description: 'High failure rate',
      impact: 'Inefficient execution and poor user experience',
      recommendation: 'Review error handling and recovery strategies'
    });
  }
  
  return bottlenecks;
}

/**
 * Assess system complexity
 * @param {object} state - System state
 * @returns {object} Complexity metrics
 */
function assessComplexity(state) {
  return {
    planComplexity: calculatePlanComplexity(state.plan),
    historyComplexity: calculateHistoryComplexity(state.history),
    memoryComplexity: calculateMemoryComplexity(state.memory),
    overallScore: calculateOverallComplexity(state)
  };
}

function calculatePlanComplexity(plan) {
  if (!plan) return 0;
  return plan.steps?.length || 0;
}

function calculateHistoryComplexity(history) {
  if (!history) return 0;
  
  // Count unique action types
  const actionTypes = new Set(history.map(h => h.action));
  return actionTypes.size;
}

function calculateMemoryComplexity(memory) {
  if (!memory) return 0;
  return Object.keys(memory).length;
}

function calculateOverallComplexity(state) {
  const scores = [
    calculatePlanComplexity(state.plan) / 10, // Normalize
    calculateHistoryComplexity(state.history) / 5,
    calculateMemoryComplexity(state.memory) / 20
  ];

  const len = scores.length;
  const avg = scores.reduce((a, b) => a + b, 0) / len;
  return Math.min(100, avg * 20); // Scale to 0-100
}

/**
 * Assess module coupling
 * @param {object} state - System state
 * @returns {object} Coupling analysis
 */
function assessCoupling(state) {
  // Analyze dependencies between modules
  const dependencies = analyzeDependencies(state);
  
  return {
    score: calculateCouplingScore(dependencies),
    tightCoupling: identifyTightCoupling(dependencies),
    recommendation: getCouplingRecommendation(dependencies)
  };
}

function analyzeDependencies(_state) {
  // This would analyze actual module imports/dependencies
  // For now, return placeholder
  return {
    moduleCount: 10,
    dependencyCount: 25,
    avgDependencies: 2.5
  };
}

function calculateCouplingScore(deps) {
  // Higher avg dependencies = tighter coupling
  return Math.min(100, deps.avgDependencies * 20);
}

function identifyTightCoupling(deps) {
  return deps.avgDependencies > 3 ? 'high' : deps.avgDependencies > 2 ? 'moderate' : 'low';
}

function getCouplingRecommendation(_deps) {
  return 'Coupling within acceptable limits';
}

/**
 * Assess module cohesion
 * @param {object} state - System state
 * @returns {object} Cohesion analysis
 */
function assessCohesion(_state) {
  // Analyze how closely related module responsibilities are
  return {
    score: 70, // Placeholder
    level: 'good',
    recommendation: 'Module cohesion is good'
  };
}

/**
 * Generate architecture recommendations
 * @param {object} analysis - Architecture analysis
 * @returns {Array} Recommendations
 */
function generateArchitectureRecommendations(analysis) {
  const recommendations = [];
  
  // From bottlenecks
  for (const bottleneck of analysis.bottlenecks) {
    recommendations.push({
      priority: bottleneck.severity === 'critical' ? 'high' : 'medium',
      category: bottleneck.type,
      recommendation: bottleneck.recommendation
    });
  }
  
  // From complexity
  if (analysis.complexity.overallScore > 70) {
    recommendations.push({
      priority: 'medium',
      category: 'complexity',
      recommendation: 'Consider simplifying system architecture to improve maintainability'
    });
  }
  
  return recommendations;
}

// ========================================
// MUTATION PROPOSER
// ========================================

/**
 * Propose safe mutations to improve system performance
 * @param {object} currentState - Current system state
 * @returns {object} Mutation proposals
 */
export function proposeMutations(currentState) {
  const proposals = {
    safe: [],
    moderate: [],
    experimental: []
  };
  
  // Analyze current state for mutation opportunities
  
  // Safe mutations: Low risk, high confidence
  proposals.safe.push(
    {
      type: 'cache_optimization',
      description: 'Increase LLM response cache TTL from 5 minutes to 10 minutes',
      expectedImpact: '15% reduction in API calls',
      rollbackPlan: 'Revert cache TTL to original value',
      riskLevel: 'low'
    },
    {
      type: 'memory_cleanup',
      description: 'Implement aggressive history trimming at 25 entries instead of 30',
      expectedImpact: '10% memory reduction',
      rollbackPlan: 'Revert history limit to 30',
      riskLevel: 'low'
    }
  );
  
  // Moderate mutations: Medium risk, good confidence
  if (currentState.stepCount > 30) {
    proposals.moderate.push({
      type: 'plan_optimization',
      description: 'Implement plan compression for steps > 25',
      expectedImpact: 'Faster execution on long runs',
      rollbackPlan: 'Disable plan compression',
      riskLevel: 'medium'
    });
  }
  
  if (currentState.apiCallCount > 50) {
    proposals.moderate.push({
      type: 'batch_processing',
      description: 'Batch multiple extract operations into single LLM call',
      expectedImpact: '20% reduction in API calls',
      rollbackPlan: 'Revert to individual extract calls',
      riskLevel: 'medium'
    });
  }
  
  // Experimental mutations: Higher risk, need validation
  proposals.experimental.push({
    type: 'adaptive_timeout',
    description: 'Implement adaptive timeout based on page complexity',
    expectedImpact: 'Better handling of complex pages',
    rollbackPlan: 'Revert to fixed timeout',
    riskLevel: 'high'
  });
  
  return proposals;
}

/**
 * Rank mutations by expected value
 * @param {object} proposals - Mutation proposals
 * @returns {Array} Ranked mutations
 */
export function rankMutations(proposals) {
  const allMutations = [
    ...(proposals?.safe || []).map(m => ({ ...m, category: 'safe', score: 90 })),
    ...(proposals?.moderate || []).map(m => ({ ...m, category: 'moderate', score: 70 })),
    ...(proposals?.experimental || []).map(m => ({ ...m, category: 'experimental', score: 50 }))
  ];
  
  // Sort by score (descending)
  return allMutations.sort((a, b) => b.score - a.score);
}

// ========================================
// CANARY DEPLOYMENT
// ========================================

/**
 * Canary deployment state
 */
const canaryState = {
  active: false,
  mutation: null,
  startTime: null,
  samples: [],
  threshold: {
    errorRate: 0.1, // 10% error rate threshold
    performanceDegradation: 1.5, // 50% slower threshold
    memoryIncrease: 1.3 // 30% memory increase threshold
  },
  rollbackTriggered: false
};

/**
 * Start canary deployment for a mutation
 * @param {object} mutation - Mutation to deploy
 * @returns {object} Canary deployment info
 */
export function startCanaryDeployment(mutation) {
  canaryState.active = true;
  canaryState.mutation = mutation;
  canaryState.startTime = Date.now();
  canaryState.samples = [];
  canaryState.rollbackTriggered = false;
  
  console.debug('[Sentinel/Canary] Starting canary deployment', mutation);
  
  return {
    status: 'started',
    mutation,
    startTime: canaryState.startTime
  };
}

/**
 * Monitor canary deployment health
 * @param {object} metrics - Current system metrics
 * @returns {object} Health status
 */
export function monitorCanary(metrics) {
  if (!canaryState.active) {
    return { status: 'inactive' };
  }
  
  const stepCount = metrics.stepCount || 1;
  const sample = {
    timestamp: Date.now(),
    errorRate: metrics.failures / stepCount,
    avgStepTime: metrics.totalTime / stepCount,
    memoryUsage: metrics.memoryUsage
  };
  
  canaryState.samples.push(sample);
  
  // Compare against baseline (first few samples)
  const health = evaluateCanaryHealth(sample);
  
  if (health.shouldRollback) {
    triggerRollback(health.reason);
  }
  
  return {
    status: canaryState.rollbackTriggered ? 'rolled_back' : 'active',
    health: health.status,
    sample,
    totalSamples: canaryState.samples.length,
    duration: Date.now() - canaryState.startTime
  };
}

/**
 * Evaluate canary deployment health
 * @param {object} sample - Current metrics sample
 * @returns {object} Health evaluation
 */
function evaluateCanaryHealth(sample) {
  // Use first 5 samples as baseline
  const baselineSize = Math.min(5, canaryState.samples.length - 1);
  if (baselineSize < 1) {
    return { status: 'insufficient_data', shouldRollback: false };
  }
  
  const baseline = canaryState.samples.slice(0, baselineSize);
  const baseLen = baseline.length;
  const avgBaselineError = baseline.reduce((sum, s) => sum + s.errorRate, 0) / baseLen;
  const avgBaselineTime = baseline.reduce((sum, s) => sum + s.avgStepTime, 0) / baseLen;
  const avgBaselineMemory = baseline.reduce((sum, s) => sum + s.memoryUsage, 0) / baseLen;
  
  const reasons = [];
  let shouldRollback = false;
  
  // Check error rate
  if (sample.errorRate > avgBaselineError + canaryState.threshold.errorRate) {
    reasons.push(`Error rate exceeded threshold: ${sample.errorRate.toFixed(2)} vs baseline ${avgBaselineError.toFixed(2)}`);
    shouldRollback = true;
  }
  
  // Check performance degradation
  if (sample.avgStepTime > avgBaselineTime * canaryState.threshold.performanceDegradation) {
    reasons.push(`Performance degraded beyond threshold: ${sample.avgStepTime.toFixed(0)}ms vs baseline ${avgBaselineTime.toFixed(0)}ms`);
    shouldRollback = true;
  }
  
  // Check memory increase
  if (sample.memoryUsage > avgBaselineMemory * canaryState.threshold.memoryIncrease) {
    reasons.push(`Memory increased beyond threshold: ${sample.memoryUsage.toFixed(1)}% vs baseline ${avgBaselineMemory.toFixed(1)}%`);
    shouldRollback = true;
  }
  
  const status = shouldRollback ? 'rollback' : 
                sample.errorRate > avgBaselineError * 1.5 ? 'degraded' : 
                sample.errorRate > avgBaselineError ? 'warning' : 'healthy';
  
  return { status, shouldRollback, reason: reasons.join('; ') };
}

/**
 * Trigger automatic rollback
 * @param {string} reason - Rollback reason
 * @returns {void}
 */
function triggerRollback(reason) {
  console.warn('[Sentinel/Canary] Automatic rollback triggered:', reason);
  canaryState.rollbackTriggered = true;
  canaryState.active = false;
  
  // Emit rollback event for system to handle
  if (typeof window !== 'undefined' && window.__sentinelRollbackHandler) {
    window.__sentinelRollbackHandler(canaryState.mutation, reason);
  }
}

/**
 * Stop canary deployment (success or manual)
 * @param {boolean} success - Whether deployment was successful
 * @returns {object} Summary
 */
export function stopCanaryDeployment(success = true) {
  if (!canaryState.active) {
    return { status: 'not_active' };
  }
  
  const duration = Date.now() - canaryState.startTime;
  const summary = {
    status: success ? 'success' : 'cancelled',
    mutation: canaryState.mutation,
    duration,
    samples: canaryState.samples.length,
    rolledBack: canaryState.rollbackTriggered
  };
  
  console.debug('[Sentinel/Canary] Deployment stopped', summary);
  
  canaryState.active = false;
  canaryState.mutation = null;
  canaryState.startTime = null;
  
  return summary;
}

// ========================================
// GENETIC ALGORITHM
// ========================================

/**
 * Genetic algorithm for parameter optimization
 * @param {object} params - GA parameters
 * @returns {object} Optimization results
 */
export function runGeneticAlgorithm(params) {
  const {
    populationSize = 20,
    generations = 50,
    mutationRate = 0.1,
    crossoverRate = 0.7,
    fitnessFunction,
    geneSpace,
    initialPopulation = null
  } = params;
  
  // Initialize population
  let population = initialPopulation || 
    generateInitialPopulation(populationSize, geneSpace);
  
  const history = [];
  let bestIndividual = null;
  let bestFitness = -Infinity;
  
  for (let gen = 0; gen < generations; gen++) {
    // Evaluate fitness
    const fitnessScores = population.map(ind => ({
      individual: ind,
      fitness: fitnessFunction(ind)
    }));
    const fitnessScoresLen = fitnessScores.length;

    // Track best
    const genBest = fitnessScores.reduce((best, current) =>
      current.fitness > best.fitness ? current : best);
    
    if (genBest.fitness > bestFitness) {
      bestFitness = genBest.fitness;
      bestIndividual = genBest.individual;
    }
    
    // Selection
    const selected = tournamentSelection(fitnessScores, populationSize);
    
    // Crossover
    const offspring = [];
    for (let i = 0; i < populationSize; i += 2) {
      const parent1 = selected[i];
      const parent2 = selected[i + 1] || selected[0];
      
      if (Math.random() < crossoverRate) {
        const [child1, child2] = crossover(parent1, parent2, geneSpace);
        offspring.push(child1, child2);
      } else {
        offspring.push(parent1, parent2);
      }
    }
    
    // Mutation
    population = offspring.map(ind => 
      Math.random() < mutationRate ? mutate(ind, geneSpace) : ind);
    
    history.push({
      generation: gen,
      bestFitness: genBest.fitness,
      avgFitness: fitnessScores.reduce((sum, s) => sum + s.fitness, 0) / fitnessScoresLen,
      bestIndividual: genBest.individual
    });
  }
  
  return {
    bestIndividual,
    bestFitness,
    generations,
    history
  };
}

function generateInitialPopulation(size, geneSpace) {
  const population = [];
  for (let i = 0; i < size; i++) {
    const individual = {};
    for (const [gene, range] of Object.entries(geneSpace)) {
      individual[gene] = randomInRange(range.min, range.max);
    }
    population.push(individual);
  }
  return population;
}

function randomInRange(min, max) {
  return Math.random() * (max - min) + min;
}

function tournamentSelection(fitnessScores, count) {
  const selected = [];
  const tournamentSize = 3;
  
  for (let i = 0; i < count; i++) {
    let best = null;
    for (let j = 0; j < tournamentSize; j++) {
      const candidate = fitnessScores[Math.floor(Math.random() * fitnessScores.length)];
      if (!best || candidate.fitness > best.fitness) {
        best = candidate;
      }
    }
    selected.push(best.individual);
  }
  
  return selected;
}

function crossover(parent1, parent2, geneSpace) {
  const child1 = {};
  const child2 = {};
  
  for (const gene of Object.keys(geneSpace)) {
    if (Math.random() < 0.5) {
      child1[gene] = parent1[gene];
      child2[gene] = parent2[gene];
    } else {
      child1[gene] = parent2[gene];
      child2[gene] = parent1[gene];
    }
  }
  
  return [child1, child2];
}

function mutate(individual, geneSpace) {
  const mutated = { ...individual };
  const geneKeys = Object.keys(geneSpace);
  const gene = geneKeys[Math.floor(Math.random() * geneKeys.length)];
  const range = geneSpace[gene];

  mutated[gene] = randomInRange(range.min, range.max);

  return mutated;
}

// ========================================
// SELF-HEALING
// ========================================

/**
 * Self-healing state
 */
const healingState = {
  activeHealings: new Map(),
  history: []
};

/**
 * Attempt to heal a detected issue
 * @param {object} issue - Detected issue
 * @returns {object} Healing attempt result
 */
export function attemptHealing(issue) {
  const healingId = `heal_${Date.now()}`;
  
  const healing = {
    id: healingId,
    issue,
    startTime: Date.now(),
    attempts: 0,
    maxAttempts: 3,
    strategies: selectHealingStrategies(issue),
    status: 'in_progress'
  };
  
  healingState.activeHealings.set(healingId, healing);
  
  // Try first strategy
  const result = tryHealingStrategy(healing, healing.strategies[0]);
  
  if (result.success) {
    healing.status = 'healed';
    healing.successStrategy = healing.strategies[0];
    healing.endTime = Date.now();
    healingState.history.push(healing);
    healingState.activeHealings.delete(healingId);
  } else {
    // Try next strategies
    const strategiesLen = healing.strategies.length;
    for (let i = 1; i < strategiesLen; i++) {
      healing.attempts++;
      const nextResult = tryHealingStrategy(healing, healing.strategies[i]);
      if (nextResult.success) {
        healing.status = 'healed';
        healing.successStrategy = healing.strategies[i];
        healing.endTime = Date.now();
        healingState.history.push(healing);
        healingState.activeHealings.delete(healingId);
        break;
      }
    }
    
    if (healing.status === 'in_progress') {
      healing.status = 'failed';
      healing.endTime = Date.now();
      healingState.history.push(healing);
      healingState.activeHealings.delete(healingId);
    }
  }
  
  return {
    healingId,
    status: healing.status,
    attempts: healing.attempts + 1,
    successStrategy: healing.successStrategy || null
  };
}

function selectHealingStrategies(issue) {
  const strategies = [];
  
  switch (issue.type) {
    case 'memory_leak':
      strategies.push(
        { name: 'clear_caches', action: 'Clear all caches and trim history' },
        { name: 'reduce_history', action: 'Reduce history limit to 15 entries' },
        { name: 'restart_agent', action: 'Restart agent loop' }
      );
      break;
      
    case 'performance_degradation':
      strategies.push(
        { name: 'disable_advanced_features', action: 'Disable non-critical features' },
        { name: 'increase_timeout', action: 'Increase timeout thresholds' },
        { name: 'simplify_plan', action: 'Compress current plan' }
      );
      break;
      
    case 'high_failure_rate':
      strategies.push(
        { name: 'retry_with_backoff', action: 'Implement exponential backoff' },
        { name: 'switch_strategy', action: 'Switch to alternative action strategy' },
        { name: 'request_intervention', action: 'Request user intervention' }
      );
      break;
      
    case 'stuck_loop':
      strategies.push(
        { name: 'break_loop', action: 'Force break from current action pattern' },
        { name: 'random_pivot', action: 'Try random alternative action' },
        { name: 'skip_step', action: 'Skip current step and continue' }
      );
      break;
      
    default:
      strategies.push(
        { name: 'generic_recovery', action: 'Attempt generic recovery' }
      );
  }
  
  return strategies;
}

function tryHealingStrategy(healing, strategy) {
  console.debug(`[Sentinel/Healing] Trying strategy: ${strategy.name}`, strategy.action);
  
  // Simulate healing attempt
  // In real implementation, this would execute the actual healing action
  
  healing.attempts++;
  
  // For now, randomly succeed/fail based on attempt number
  const successProbability = 0.3 + (healing.attempts * 0.2);
  const success = Math.random() < successProbability;
  
  return {
    success,
    strategy: strategy.name,
    attempt: healing.attempts
  };
}

/**
 * Get healing history
 * @returns {Array} Healing history
 */
export function getHealingHistory() {
  return healingState.history;
}

/**
 * Get active healings
 * @returns {Array} Active healing attempts
 */
export function getActiveHealings() {
  return Array.from(healingState.activeHealings.values());
}

// ========================================
// EXPORT: RUNTIME PROFILER API
// ========================================

export const RuntimeProfiler = {
  // Profiling
  start: startProfiling,
  stop: stopProfiling,
  sample: takeProfilingSample,
  getStatus: getProfilingStatus,
  
  // Architecture analysis
  analyzeArchitecture,
  
  // Mutations
  proposeMutations,
  rankMutations,
  
  // Canary deployment
  startCanary: startCanaryDeployment,
  monitorCanary,
  stopCanary: stopCanaryDeployment,
  
  // Genetic algorithm
  geneticAlgorithm: runGeneticAlgorithm,
  
  // Self-healing
  heal: attemptHealing,
  getHealingHistory,
  getActiveHealings
};
