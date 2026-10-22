/**
 * @future Federation Layer - Zero-Trust Multi-Agent Coordination
 *
 * STATUS: Reserved for future multi-agent orchestration.
 * Zero consumers as of v19.0.0. Do not delete — intended for
 * peer-to-peer agent federation across SENTINEL PRIME nodes.
 *
 * Enables multiple Sentinel Override agents to collaborate on goals
 * with zero-trust security, peer discovery, and result reconciliation.
 * 
 * @version 10.0.0
 * @module background/federation
 */

const uuidv4 = () => crypto.randomUUID();
import { getErrorMessage } from './error-utils.js';
import { verifyPayload } from './sig-utils.js';

/**
 * Federation Controller
 * Manages peer discovery, work distribution, and result reconciliation
 */
class FederationController {
  constructor() {
    this.peers = new Map(); // peerId → { info, trust, capabilities, load }
    this.activeJobs = new Map(); // jobId → { goal, subGoals, results, status }
    this.keyPair = null;
    this.config = {
      enabled: false,
      maxPeers: 50,
      minTrustScore: 70,
      rebalanceInterval: 60000, // 1 minute
      resultTimeout: 120000, // 2 minutes
      // v21 security: peers sign their registration payload with HMAC-SHA256
      // over this shared secret (sig-utils.js). Unset => no peer can register.
      sharedSecret: ''
    };
    
    this.rebalanceTimer = null;
    this.auditLog = [];
  }

  /**
   * Initialize federation
   */
  async init() {
    try {
      await this.loadConfig();
      
      if (!this.config.enabled) {
        console.warn('[Federation] Disabled in config');
        return;
      }

      // Generate Ed25519 keypair for signing
      await this.generateKeyPair();

      // Start rebalance loop
      this.startRebalanceLoop();

      console.warn('[Federation] Initialized');
    } catch (error) {
      console.error('[Federation] Init failed:', getErrorMessage(error));
      throw error;
    }
  }

  /**
   * Load configuration
   */
  async loadConfig() {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(['federationConfig'], (result) => {
        if (chrome.runtime.lastError) {
          console.error('[Federation] Failed to load config:', chrome.runtime.lastError.message);
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (result.federationConfig) {
          this.config = { ...this.config, ...result.federationConfig };
        }
        resolve();
      });
    });
  }

  /**
   * Generate Ed25519 keypair
   */
  async generateKeyPair() {
    // Placeholder - in production, use noble-ed25519 or Web Crypto API
    this.keyPair = {
      publicKey: 'fed_' + uuidv4(),
      secretKey: 'fed_sec_' + uuidv4()
    };
    console.warn('[Federation] Keypair generated');
  }

  /**
   * Register peer
   */
  async registerPeer(peerInfo) {
    const { peer_id, capabilities, max_concurrent_goals, trust_score_baseline, signature } = peerInfo;

    // Verify signature (HMAC-SHA256 over the canonical payload)
    if (!(await this.verifySignature(peerInfo, signature))) {
      throw new Error('Invalid peer signature');
    }

    // Check max peers
    if (this.peers.size >= this.config.maxPeers) {
      throw new Error('Max peers reached');
    }

    // Register peer
    this.peers.set(peer_id, {
      id: peer_id,
      capabilities: capabilities || [],
      maxGoals: max_concurrent_goals || 3,
      trust: {
        baseline: trust_score_baseline || 75,
        current: trust_score_baseline || 75,
        history: []
      },
      load: {
        activeGoals: 0,
        lastSeen: Date.now()
      },
      status: 'active'
    });

    console.warn('[Federation] Peer registered:', peer_id);
    this.logAudit('peer_registered', { peer_id, capabilities });

    return {
      federation_id: this.keyPair?.publicKey || '',
      status: 'registered'
    };
  }

  /**
   * Unregister peer
   */
  unregisterPeer(peerId) {
    if (!this.peers.has(peerId)) {
      return false;
    }

    // Cancel all jobs assigned to this peer
    for (const [jobId, job] of this.activeJobs.entries()) {
      if (job.assignedPeers.includes(peerId)) {
        this.reassignSubGoal(jobId, peerId).catch(e => console.error('[Federation] reassignSubGoal failed:', getErrorMessage(e)));
      }
    }

    this.peers.delete(peerId);
    console.warn('[Federation] Peer unregistered:', peerId);
    this.logAudit('peer_unregistered', { peer_id: peerId });

    return true;
  }

  /**
   * Distribute goal across peers
   */
  async distributeGoal(goal, context = {}) {
    const jobId = uuidv4();

    // Decompose goal into sub-goals
    const subGoals = await this.decomposeGoal(goal, context);

    // Initialize job
    this.activeJobs.set(jobId, {
      id: jobId,
      goal,
      context,
      subGoals: subGoals.map((sg, i) => ({
        id: `${jobId}_sub_${i}`,
        description: sg.description,
        requirements: sg.requirements,
        status: 'pending',
        assignedTo: null,
        result: null,
        attempts: 0
      })),
      results: [],
      status: 'distributing',
      assignedPeers: [],
      startTime: Date.now()
    });

    // Assign sub-goals to capable peers
    for (const subGoal of this.activeJobs.get(jobId).subGoals) {
      await this.assignSubGoal(jobId, subGoal);
    }

    // Wait for completion
    await this.waitForCompletion(jobId);

    // Reconcile results
    const finalResult = await this.reconcileResults(jobId);

    this.activeJobs.get(jobId).status = 'complete';
    this.activeJobs.get(jobId).finalResult = finalResult;

    return finalResult;
  }

  /**
   * Decompose goal into sub-goals
   */
  async decomposeGoal(goal, _context) {
    // Simple decomposition based on goal keywords
    const subGoals = [];
    const goalLower = goal.toLowerCase();

    // Detect multi-portal patterns
    if (goalLower.includes('entra') && goalLower.includes('exchange')) {
      subGoals.push({
        description: 'Investigate Entra sign-in logs',
        requirements: ['vision', 'network', 'm365']
      });
      subGoals.push({
        description: 'Investigate Exchange mail logs',
        requirements: ['vision', 'network', 'm365']
      });
    } else if (goalLower.includes('all users') || goalLower.includes('list users')) {
      subGoals.push({
        description: 'Extract user list from admin portal',
        requirements: ['vision']
      });
      subGoals.push({
        description: 'Analyze user patterns and anomalies',
        requirements: ['knowledge_graph']
      });
    } else {
      // Single sub-goal for simple goals
      subGoals.push({
        description: goal,
        requirements: ['vision']
      });
    }

    return subGoals;
  }

  /**
   * Assign sub-goal to capable peer
   */
  async assignSubGoal(jobId, subGoal) {
    const job = this.activeJobs.get(jobId);
    if (!job) return;

    // Find capable peers with capacity
    const capablePeers = [];
    for (const [peerId, peer] of this.peers.entries()) {
      if (peer.status !== 'active') continue;
      if (peer.load.activeGoals >= peer.maxGoals) continue;
      if (peer.trust.current < this.config.minTrustScore) continue;

      // Check capability match
      const hasCapabilities = subGoal.requirements.every(req =>
        peer.capabilities.includes(req)
      );

      if (hasCapabilities) {
        capablePeers.push({
          peerId,
          trust: peer.trust.current,
          load: peer.load.activeGoals
        });
      }
    }

    if (capablePeers.length === 0) {
      console.warn('[Federation] No capable peers for sub-goal:', subGoal.id);
      subGoal.status = 'failed';
      subGoal.error = 'No capable peers available';
      return;
    }

    // Select best peer (highest trust, lowest load)
    capablePeers.sort((a, b) => {
      if (b.trust !== a.trust) return b.trust - a.trust;
      return a.load - b.load;
    });

    const selectedPeer = capablePeers[0];
    const peer = this.peers.get(selectedPeer.peerId);

    // Assign sub-goal
    subGoal.assignedTo = selectedPeer.peerId;
    subGoal.status = 'assigned';
    subGoal.assignedAt = Date.now();

    peer.load.activeGoals++;
    if (!job.assignedPeers.includes(selectedPeer.peerId)) {
      job.assignedPeers.push(selectedPeer.peerId);
    }

    console.warn('[Federation] Assigned', subGoal.id, 'to', selectedPeer.peerId);

    // Send goal to peer (via UAP server or direct message)
    await this.sendGoalToPeer(selectedPeer.peerId, subGoal);
  }

  /**
   * Reassign sub-goal
   */
  async reassignSubGoal(jobId, peerId) {
    const job = this.activeJobs.get(jobId);
    if (!job) return;

    // Find all sub-goals assigned to this peer
    const subGoalsToReassign = job.subGoals.filter(sg => sg.assignedTo === peerId);

    for (const subGoal of subGoalsToReassign) {
      subGoal.assignedTo = null;
      subGoal.status = 'pending';
      subGoal.attempts++;

      if (subGoal.attempts < 3) {
        await this.assignSubGoal(jobId, subGoal);
      } else {
        subGoal.status = 'failed';
        subGoal.error = 'Max assignment attempts reached';
      }
    }
  }

  /**
   * Send goal to peer
   */
  async sendGoalToPeer(peerId, subGoal) {
    // Implementation depends on transport mechanism
    // Could use WebSocket, HTTP, or chrome.runtime messaging
    console.warn('[Federation] Sending goal to peer:', peerId, subGoal.description);
    
    // Placeholder - would send actual message via UAP server
    this.logAudit('goal_sent_to_peer', { peer_id: peerId, sub_goal_id: subGoal.id });
  }

  /**
   * Wait for job completion
   */
  async waitForCompletion(jobId) {
    const job = this.activeJobs.get(jobId);
    if (!job) return;

    const timeout = setTimeout(() => {
      job.status = 'timeout';
      for (const subGoal of job.subGoals) {
        if (subGoal.status === 'assigned' || subGoal.status === 'running') {
          subGoal.status = 'timeout';
        }
      }
    }, this.config.resultTimeout);

    // Wait for all sub-goals to complete
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        const allComplete = job.subGoals.every(sg =>
          ['complete', 'failed', 'timeout'].includes(sg.status)
        );

        if (allComplete || ['timeout', 'failed'].includes(job.status)) {
          clearTimeout(timeout);
          clearInterval(checkInterval);
          resolve();
        }
      }, 1000);
    });
  }

  /**
   * Reconcile results from multiple peers
   */
  async reconcileResults(jobId) {
    const job = this.activeJobs.get(jobId);
    if (!job) return null;

    const successfulResults = job.subGoals
      .filter(sg => sg.status === 'complete' && sg.result)
      .map(sg => ({
        ...sg.result,
        peerId: sg.assignedTo,
        subGoalId: sg.id
      }));

    if (successfulResults.length === 0) {
      return {
        status: 'failed',
        error: 'No sub-goals completed successfully',
        subGoals: job.subGoals.map(sg => ({
          id: sg.id,
          status: sg.status,
          error: sg.error
        }))
      };
    }

    // Aggregate results
    const aggregated = {
      status: 'success',
      summary: this.buildSummary(job.goal, successfulResults),
      findings: this.aggregateFindings(successfulResults),
      evidence: this.aggregateEvidence(successfulResults),
      trustScore: this.calculateJobTrustScore(job, successfulResults),
      subGoals: job.subGoals.map(sg => ({
        id: sg.id,
        status: sg.status,
        peerId: sg.assignedTo,
        error: sg.error
      })),
      metrics: {
        duration: Date.now() - job.startTime,
        totalSubGoals: job.subGoals.length,
        completedSubGoals: successfulResults.length,
        failedSubGoals: job.subGoals.reduce((count, sg) => count + (sg.status === 'failed' ? 1 : 0), 0)
      }
    };

    // Update peer trust scores
    this.updatePeerTrustScores(job, successfulResults);

    return aggregated;
  }

  /**
   * Build summary from results
   */
  buildSummary(goal, results) {
    // Combine summaries from each result (optimized to avoid intermediate array)
    const summaries = [];
    for (const r of results) {
      if (r.summary) {
        summaries.push(r.summary);
      }
    }

    if (summaries.length === 0) {
      return `Completed goal: ${goal}`;
    }

    if (summaries.length === 1) {
      return summaries[0];
    }

    return `Multi-peer execution complete:\n${summaries.join('\n')}`;
  }

  /**
   * Aggregate findings from results
   */
  aggregateFindings(results) {
    const findings = [];
    const seen = new Set();

    for (const result of results) {
      if (result.findings && Array.isArray(result.findings)) {
        for (const finding of result.findings) {
          const key = JSON.stringify(finding);
          if (!seen.has(key)) {
            seen.add(key);
            findings.push({
              ...finding,
              sourcePeer: result.peerId
            });
          }
        }
      }
    }

    return findings;
  }

  /**
   * Aggregate evidence from results
   */
  aggregateEvidence(results) {
    const evidence = {};

    for (const result of results) {
      if (result.evidence && typeof result.evidence === 'object') {
        for (const [key, value] of Object.entries(result.evidence)) {
          if (!evidence[key]) {
            evidence[key] = [];
          }
          if (Array.isArray(value)) {
            evidence[key].push(...value);
          } else {
            evidence[key].push(value);
          }
        }
      }
    }

    return evidence;
  }

  /**
   * Calculate job trust score
   */
  calculateJobTrustScore(job, results) {
    if (results.length === 0) return 0;
    const subGoalCount = job.subGoals?.length || 0;
    if (subGoalCount === 0) return 0;

    const peerScores = results.map(r => {
      const peer = this.peers.get(r.peerId);
      return peer ? peer.trust.current : 0;
    });

    // Average trust score weighted by completion rate
    const avgTrust = peerScores.reduce((a, b) => a + b, 0) / peerScores.length;
    const completionRate = results.length / subGoalCount;

    return Math.round(avgTrust * completionRate);
  }

  /**
   * Update peer trust scores
   */
  updatePeerTrustScores(job, results) {
    for (const result of results) {
      const peer = this.peers.get(result.peerId);
      if (!peer) continue;

      const subGoal = job.subGoals.find(sg => sg.id === result.subGoalId);
      if (!subGoal) continue;

      // Calculate performance score
      let scoreDelta = 0;

      // Success bonus
      scoreDelta += 5;

      // Quality bonus (if result has findings)
      if (result.findings && result.findings.length > 0) {
        scoreDelta += 3;
      }

      // Evidence bonus
      if (result.evidence && Object.keys(result.evidence).length > 0) {
        scoreDelta += 2;
      }

      // Speed penalty (if took too long)
      const duration = Date.now() - subGoal.assignedAt;
      if (duration > 60000) {
        scoreDelta -= 2;
      }

      // Update trust score
      peer.trust.current = Math.max(0, Math.min(100, peer.trust.current + scoreDelta));
      peer.trust.history.push({
        timestamp: Date.now(),
        delta: scoreDelta,
        jobId: job.id
      });

      console.warn(`[Federation] Updated trust for ${result.peerId}: ${peer.trust.current} (${scoreDelta > 0 ? '+' : ''}${scoreDelta})`);
    }
  }

  /**
   * Verify peer signature
   */
  async verifySignature(peerInfo, signature) {
    if (!peerInfo || !signature) return false;
    // Fails closed when `config.sharedSecret` is unset or the HMAC mismatches.
    return verifyPayload(this.config.sharedSecret, peerInfo, signature);
  }

  /**
   * Start rebalance loop
   */
  startRebalanceLoop() {
    this.rebalanceTimer = setInterval(() => {
      this.rebalance();
    }, this.config.rebalanceInterval);
  }

  /**
   * Rebalance work across peers
   */
  rebalance() {
    console.warn('[Federation] Rebalancing...');

    // Check for stalled peers
    const now = Date.now();
    for (const [peerId, peer] of this.peers.entries()) {
      if (now - peer.load.lastSeen > 300000) { // 5 minutes
        console.warn('[Federation] Peer stalled:', peerId);
        peer.status = 'stalled';
      }
    }

    // Reassign work from stalled peers
    for (const [jobId, job] of this.activeJobs.entries()) {
      if (job.status !== 'distributing' && job.status !== 'running') continue;

      for (const subGoal of job.subGoals) {
        if (subGoal.status === 'assigned') {
          const peer = this.peers.get(subGoal.assignedTo);
          if (!peer || peer.status === 'stalled') {
            this.reassignSubGoal(jobId, subGoal.assignedTo).catch(e => console.error('[Federation] reassignSubGoal failed:', getErrorMessage(e)));
          }
        }
      }
    }
  }

  /**
   * Get peer status
   */
  getPeerStatus(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return null;

    return {
      id: peer.id,
      status: peer.status,
      trust: peer.trust.current,
      capabilities: peer.capabilities,
      load: peer.load.activeGoals,
      maxGoals: peer.maxGoals
    };
  }

  /**
   * Get all peers
   */
  getAllPeers() {
    const result = [];
    for (const peer of this.peers.values()) {
      result.push({
        id: peer.id,
        status: peer.status,
        trust: peer.trust.current,
        capabilities: peer.capabilities,
        load: peer.load.activeGoals,
        maxGoals: peer.maxGoals,
        lastSeen: peer.load.lastSeen
      });
    }
    return result;
  }

  /**
   * Log audit event
   */
  logAudit(eventType, data) {
    const entry = {
      timestamp: new Date().toISOString(),
      event_type: eventType,
      federation_id: this.keyPair?.publicKey || '',
      ...data
    };

    this.auditLog.push(entry);

    // Persist to storage
    chrome.storage.local.get(['federationAuditLog'], (result) => {
      if (chrome.runtime.lastError) {
        console.error('[Federation] Failed to read audit log:', chrome.runtime.lastError.message);
        return;
      }
      const log = result.federationAuditLog || [];
      log.push(entry);
      chrome.storage.local.set({ federationAuditLog: log.slice(-10000) }, () => {
        if (chrome.runtime.lastError) {
          console.error('[Federation] Failed to persist audit log:', chrome.runtime.lastError.message);
        }
      });
    });
  }

  /**
   * Shutdown federation
   */
  async shutdown() {
    if (this.rebalanceTimer) {
      clearInterval(this.rebalanceTimer);
      this.rebalanceTimer = null;
    }

    this.peers.clear();
    this.activeJobs.clear();

    console.warn('[Federation] Shut down');
  }
}

// Export singleton
export const federation = new FederationController();

// Auto-initialize
if (typeof chrome !== 'undefined' && chrome.runtime) {
  chrome.runtime.onStartup.addListener(() => {
    federation.init().catch(error => {
      console.error('[Federation] Failed to start:', getErrorMessage(error));
    });
  });

  chrome.runtime.onInstalled.addListener(() => {
    federation.init().catch(error => {
      console.error('[Federation] Failed to start:', getErrorMessage(error));
    });
  });
}
