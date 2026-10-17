// Sentinel Override v8.0 - Predictive Engine
// Time series forecasting, failure prediction, Monte Carlo simulation, risk scoring

// ========================================
// TIME SERIES FORECASTING
// ========================================

/**
 * Simple moving average forecast
 * @param {number[]} data - Historical data points
 * @param {number} periods - Number of periods to forecast
 * @returns {number[]} Forecasted values
 */
export function simpleMovingAverage(data, periods = 5) {
  if (data.length < 3) return new Array(periods).fill(data[data.length - 1] || 0);

  const window = Math.min(5, data.length);
  const forecasts = [];
  const working = data.slice();

  for (let i = 0; i < periods; i++) {
    const recent = working.slice(-window);
    const avg = recent.reduce((a, b) => a + b, 0) / window;
    forecasts.push(avg);
    working.push(avg);
  }

  return forecasts;
}

/**
 * Exponential smoothing forecast
 * @param {number[]} data - Historical data points
 * @param {number} periods - Number of periods to forecast
 * @param {number} alpha - Smoothing factor (0-1)
 * @returns {number[]} Forecasted values
 */
export function exponentialSmoothing(data, periods = 5, alpha = 0.3) {
  if (data.length === 0) return new Array(periods).fill(0);
  
  let smoothed = data[0];
  const forecasts = [];
  
  // Compute initial smoothed value
  for (let i = 1; i < data.length; i++) {
    smoothed = alpha * data[i] + (1 - alpha) * smoothed;
  }
  
  // Generate forecasts
  for (let i = 0; i < periods; i++) {
    forecasts.push(smoothed);
  }
  
  return forecasts;
}

/**
 * Linear trend forecast
 * @param {number[]} data - Historical data points
 * @param {number} periods - Number of periods to forecast
 * @returns {number[]} Forecasted values
 */
export function linearTrendForecast(data, periods = 5) {
  if (data.length < 2) return new Array(periods).fill(data[data.length - 1] || 0);
  
  const n = data.length;
  const x = Array.from({ length: n }, (_, i) => i);
  const y = data;
  
  // Calculate linear regression: y = mx + b
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
  const sumXX = x.reduce((sum, xi) => sum + xi * xi, 0);
  
  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  
  // Generate forecasts
  const forecasts = [];
  for (let i = 0; i < periods; i++) {
    const nextX = n + i;
    forecasts.push(slope * nextX + intercept);
  }
  
  return forecasts;
}

// ========================================
// FAILURE PREDICTION
// ========================================

/**
 * Predict time to next failure based on historical intervals
 * @param {number[]} failureIntervals - Array of time-between-failures
 * @returns {object} Prediction with confidence intervals
 */
export function predictNextFailure(failureIntervals) {
  if (failureIntervals.length < 2) {
    return {
      predicted: null,
      lowerBound: null,
      upperBound: null,
      confidence: 0
    };
  }

  const len = failureIntervals.length;
  const avg = failureIntervals.reduce((a, b) => a + b, 0) / len;
  const variance = failureIntervals.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / len;
  const stdDev = Math.sqrt(variance);

  // 95% confidence interval
  const margin = 1.96 * stdDev / Math.sqrt(len);

  return {
    predicted: Math.round(avg),
    lowerBound: Math.round(avg - margin),
    upperBound: Math.round(avg + margin),
    confidence: Math.min(95, len * 10), // More data = higher confidence
    trend: len > 2 ? detectTrend(failureIntervals) : 'stable'
  };
}

/**
 * Detect trend in time series data
 * @param {number[]} data - Time series data
 * @returns {string} 'increasing', 'decreasing', or 'stable'
 */
function detectTrend(data) {
  if (data.length < 3) return 'stable';

  const firstHalf = data.slice(0, Math.floor(data.length / 2));
  const secondHalf = data.slice(Math.floor(data.length / 2));

  const firstLen = firstHalf.length;
  const secondLen = secondHalf.length;
  const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstLen;
  const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondLen;

  const percentChange = ((secondAvg - firstAvg) / firstAvg) * 100;

  if (percentChange > 10) return 'increasing';
  if (percentChange < -10) return 'decreasing';
  return 'stable';
}

/**
 * Analyze failure patterns by type
 * @param {Array} failures - Array of failure objects with {type, timestamp}
 * @returns {object} Pattern analysis
 */
export function analyzeFailurePatterns(failures) {
  const patterns = {};
  const byType = {};
  
  // Group by type
  for (const failure of failures) {
    if (!byType[failure.type]) {
      byType[failure.type] = [];
    }
    byType[failure.type].push(failure.timestamp);
  }
  
  // Analyze each type
  for (const [type, timestamps] of Object.entries(byType)) {
    if (timestamps.length < 2) continue;
    
    // Calculate intervals
    const intervals = [];
    const len = timestamps.length;
    for (let i = 1; i < len; i++) {
      intervals.push(timestamps[i] - timestamps[i - 1]);
    }

    patterns[type] = {
      count: len,
      avgInterval: intervals.reduce((a, b) => a + b, 0) / intervals.length,
      prediction: predictNextFailure(intervals),
      lastOccurrence: timestamps[timestamps.length - 1]
    };
  }
  
  return patterns;
}

// ========================================
// RISK SCORING
// ========================================

/**
 * Calculate composite risk score from multiple factors
 * @param {object} factors - Risk factors with normalized values (0-1)
 * @returns {object} Risk score and breakdown
 */
export function calculateRiskScore(factors) {
  // Weight factors
  const weights = {
    complexity: 0.2,
    novelty: 0.25,
    instability: 0.2,
    dependencies: 0.15,
    impact: 0.2
  };
  
  let totalScore = 0;
  const breakdown = {};
  
  for (const [factor, value] of Object.entries(factors)) {
    const weight = weights[factor] || 0.1;
    const score = value * weight;
    totalScore += score;
    breakdown[factor] = {
      value,
      weight,
      score: Math.round(score * 100) / 100
    };
  }
  
  // Normalize to 0-100
  const finalScore = Math.min(100, Math.round(totalScore * 100));
  
  return {
    score: finalScore,
    level: getRiskLevel(finalScore),
    breakdown,
    recommendation: getRiskRecommendation(finalScore)
  };
}

function getRiskLevel(score) {
  if (score >= 70) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 30) return 'moderate';
  if (score >= 10) return 'low';
  return 'minimal';
}

function getRiskRecommendation(score) {
  if (score >= 70) return 'Require explicit approval and rollback plan';
  if (score >= 50) return 'Require approval and detailed testing';
  if (score >= 30) return 'Recommended testing before deployment';
  if (score >= 10) return 'Monitor during deployment';
  return 'Standard deployment';
}

// ========================================
// MONTE CARLO SIMULATION
// ========================================

/**
 * Run Monte Carlo simulation for project completion
 * @param {object} params - {tasks: [{min, mostLikely, max}], iterations: number}
 * @returns {object} Simulation results
 */
export function monteCarloSimulation(params) {
  const { tasks, iterations = 1000 } = params;
  const results = [];
  
  for (let i = 0; i < iterations; i++) {
    let totalDuration = 0;
    
    for (const task of tasks) {
      const duration = triangularRandom(task.min, task.mostLikely, task.max);
      totalDuration += duration;
    }
    
    results.push(totalDuration);
  }

  // Sort results for percentile analysis
  results.sort((a, b) => a - b);

  const len = results.length;
  return {
    mean: results.reduce((a, b) => a + b, 0) / len,
    median: results[Math.floor(len / 2)],
    percentiles: {
      p50: results[Math.floor(len * 0.5)],
      p80: results[Math.floor(len * 0.8)],
      p90: results[Math.floor(len * 0.9)],
      p95: results[Math.floor(len * 0.95)]
    },
    confidence: {
      lower: results[Math.floor(len * 0.05)],
      upper: results[Math.floor(len * 0.95)]
    },
    iterations
  };
}

/**
 * Triangular distribution random number generator
 * @param {number} min - Minimum value
 * @param {number} mode - Most likely value
 * @param {number} max - Maximum value
 * @returns {number} Random sample
 */
function triangularRandom(min, mode, max) {
  const u = Math.random();
  const c = (mode - min) / (max - min);
  
  if (u < c) {
    return min + Math.sqrt(u * (max - min) * (mode - min));
  } else {
    return max - Math.sqrt((1 - u) * (max - min) * (max - mode));
  }
}

// ========================================
// WHAT-IF ANALYSIS
// ========================================

/**
 * Analyze impact of changing variables
 * @param {object} params - {baseline: object, changes: {variations: []}, metric: function}
 * @returns {object} Analysis results
 */
export function whatIfAnalysis(params) {
  const { baseline, changes, metric } = params;
  const baselineValue = metric(baseline);
  const results = [];
  
  for (const variation of changes.variations) {
    const scenario = { ...baseline, ...variation };
    const value = metric(scenario);
    const change = value - baselineValue;
    const percentChange = baselineValue !== 0 ? (change / baselineValue) * 100 : 0;
    
    results.push({
      variation,
      value,
      change,
      percentChange: Math.round(percentChange * 100) / 100,
      impact: Math.abs(percentChange) > 20 ? 'high' : Math.abs(percentChange) > 10 ? 'medium' : 'low'
    });
  }
  
  // Sort by absolute impact
  results.sort((a, b) => Math.abs(b.percentChange) - Math.abs(a.percentChange));
  
  return {
    baseline: baselineValue,
    scenarios: results,
    mostSensitive: results[0]?.variation || null,
    recommendation: getWhatIfRecommendation(results)
  };
}

function getWhatIfRecommendation(results) {
  const highImpact = results.filter(r => r.impact === 'high');
  if (highImpact.length > 0) {
    return `Focus on ${highImpact.map(r => Object.keys(r.variation)[0]).join(', ')} - highest impact variables`;
  }
  return 'All variables show acceptable impact levels';
}

// ========================================
// PLANNING ENGINE
// ========================================

/**
 * Generate optimized execution plan with critical path analysis
 * @param {Array} tasks - Array of {id, duration, dependencies[]}
 * @returns {object} Optimized plan with critical path
 */
export function generateOptimizedPlan(tasks) {
  // Build dependency graph
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  const inDegree = new Map();
  const adjList = new Map();
  
  for (const task of tasks) {
    inDegree.set(task.id, 0);
    adjList.set(task.id, []);
  }
  
  for (const task of tasks) {
    for (const dep of task.dependencies || []) {
      const depList = adjList.get(dep);
      if (!depList) continue; // dep not in tasks — skip unknown dependency
      depList.push(task.id);
      inDegree.set(task.id, (inDegree.get(task.id) || 0) + 1);
    }
  }
  
  // Topological sort for execution order
  const queue = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }
  
  const executionOrder = [];
  const levels = new Map(); // Track which level each task belongs to
  
  let queueIndex = 0;
  while (queueIndex < queue.length) {
    const id = queue[queueIndex++];
    executionOrder.push(id);

    const level = taskMap.get(id)?.dependencies?.length || 0;
    levels.set(id, level);
    
    for (const nextId of adjList.get(id)) {
      inDegree.set(nextId, inDegree.get(nextId) - 1);
      if (inDegree.get(nextId) === 0) {
        queue.push(nextId);
      }
    }
  }
  
  // Calculate earliest start/finish times
  const earliestStart = new Map();
  const earliestFinish = new Map();
  
  for (const id of executionOrder) {
    const task = taskMap.get(id);
    const deps = task.dependencies || [];
    const maxDepFinish = deps.length > 0 
      ? Math.max(...deps.map(d => earliestFinish.get(d) || 0))
      : 0;
    
    earliestStart.set(id, maxDepFinish);
    earliestFinish.set(id, maxDepFinish + task.duration);
  }
  
  // Calculate latest start/finish times (backwards pass)
  const finishValues = Array.from(earliestFinish.values());
  const projectDuration = finishValues.length > 0 ? Math.max(...finishValues) : 0;
  const latestFinish = new Map();
  const latestStart = new Map();
  
  for (const id of [...executionOrder].reverse()) {
    const task = taskMap.get(id);
    const successors = adjList.get(id);
    
    if (successors.length === 0) {
      latestFinish.set(id, projectDuration);
    } else {
      const minSuccessorStart = Math.min(...successors.map(s => latestStart.get(s) || projectDuration));
      latestFinish.set(id, minSuccessorStart);
    }
    
    latestStart.set(id, latestFinish.get(id) - task.duration);
  }
  
  // Calculate slack and identify critical path
  const slack = new Map();
  const criticalPath = [];
  
  for (const id of executionOrder) {
    const slackValue = latestStart.get(id) - earliestStart.get(id);
    slack.set(id, slackValue);
    
    if (slackValue === 0) {
      criticalPath.push(id);
    }
  }
  
  return {
    executionOrder,
    projectDuration,
    criticalPath,
    tasks: executionOrder.map(id => ({
      id,
      task: taskMap.get(id),
      earliestStart: earliestStart.get(id),
      earliestFinish: earliestFinish.get(id),
      latestStart: latestStart.get(id),
      latestFinish: latestFinish.get(id),
      slack: slack.get(id),
      isCritical: slack.get(id) === 0
    }))
  };
}

// ========================================
// PREDICTIVE ANALYTICS
// ========================================

/**
 * Comprehensive predictive analysis for agent behavior
 * @param {object} data - Historical run data
 * @returns {object} Predictive insights
 */
export function analyzePredictively(data) {
  const runHistory = data.runHistory || data.history || [];
  const failureHistory = data.failureHistory || data.failures || [];
  const performanceMetrics = data.performanceMetrics || data;

  // Predict next run duration (optimized to avoid intermediate array)
  const durations = [];
  for (const r of runHistory) {
    if (r && typeof r === 'object' && r.duration != null) {
      durations.push(r.duration);
    }
  }
  const durationForecast = linearTrendForecast(durations, 5);

  // Analyze failure patterns
  const failurePatterns = analyzeFailurePatterns(failureHistory);

  // Risk assessment
  const riskFactors = {
    complexity: calculateComplexityRisk(performanceMetrics),
    novelty: calculateNoveltyRisk(runHistory),
    instability: calculateInstabilityRisk(runHistory),
    dependencies: calculateDependencyRisk(performanceMetrics),
    impact: calculateImpactRisk(performanceMetrics)
  };

  const riskScore = calculateRiskScore(riskFactors);

  return {
    durationForecast: {
      next: durationForecast[0],
      trend: detectTrend(durations),
      predicted5Step: durationForecast
    },
    failurePrediction: failurePatterns,
    riskAssessment: riskScore,
    recommendations: generatePredictiveRecommendations(riskScore, failurePatterns)
  };
}

function calculateComplexityRisk(metrics) {
  // Higher step count = higher complexity
  const avgSteps = metrics?.avgSteps || 10;
  return Math.min(1, avgSteps / 50); // Normalize to 0-1
}

function calculateNoveltyRisk(history) {
  // More unique URLs/actions = higher novelty
  // Defensive: history entries may be strings or objects without .url
  const uniqueUrls = new Set(
    (Array.isArray(history) ? history : [])
      .map(h => (h && typeof h === 'object' && h.url) || '')
      .filter(Boolean)
  ).size;
  return Math.min(1, uniqueUrls / 20); // Normalize to 0-1
}

function calculateInstabilityRisk(history) {
  // More failures = higher instability
  const safeHistory = Array.isArray(history) ? history : [];
  let failures = 0;
  const histLen = safeHistory.length;
  for (let i = 0; i < histLen; i++) {
    if (safeHistory[i] && typeof safeHistory[i] === 'object' && safeHistory[i].failed) failures++;
  }
  return histLen > 0 ? Math.min(1, failures / histLen) : 0;
}

function calculateDependencyRisk(metrics) {
  // More platform dependencies = higher risk
  const platforms = metrics?.platforms || 1;
  return Math.min(1, platforms / 5);
}

function calculateImpactRisk(metrics) {
  // More modifying actions = higher impact
  const modifyingActions = metrics?.modifyingActions || 0;
  return Math.min(1, modifyingActions / 20);
}

function generatePredictiveRecommendations(riskScore, failurePatterns) {
  const recommendations = [];
  
  if (riskScore.score >= 70) {
    recommendations.push('High-risk scenario detected - implement manual approval gates');
  }
  
  if (riskScore.score >= 50) {
    recommendations.push('Implement canary deployment with automatic rollback');
  }
  
  for (const [type, pattern] of Object.entries(failurePatterns)) {
    if (pattern.prediction.confidence > 70) {
      recommendations.push(`Watch for ${type} failures - predicted within ${pattern.prediction.predicted} steps`);
    }
  }
  
  if (recommendations.length === 0) {
    recommendations.push('Standard execution - no significant risks detected');
  }
  
  return recommendations;
}

// ========================================
// EXPORT: PREDICTIVE ENGINE API
// ========================================

export const PredictiveEngine = {
  // Time series
  forecast: simpleMovingAverage,
  exponentialSmoothing,
  linearTrend: linearTrendForecast,
  
  // Failure prediction
  predictNextFailure,
  analyzePatterns: analyzeFailurePatterns,
  
  // Risk assessment
  assessRisk: calculateRiskScore,
  
  // Simulation
  monteCarlo: monteCarloSimulation,
  whatIf: whatIfAnalysis,
  
  // Planning
  optimizePlan: generateOptimizedPlan,
  
  // Comprehensive
  analyze: analyzePredictively
};
