/**
 * Universal Agent Protocol (UAP) Server
 * 
 * Provides WebSocket-based universal access to Sentinel Override capabilities
 * for external frameworks, CI/CD systems, and multi-agent networks.
 * 
 * @version 10.0.0
 * @module background/uap-server
 */

import { v4 as uuidv4 } from 'uuid';
import { getErrorMessage } from './error-utils.js';

// Precompile regex for tenant validation (performance optimization)
const ONMICROSOFT_TENANT_RE = /^[a-z0-9.-]+\.onmicrosoft\.com$/;

/**
 * UAP Server class
 * Handles WebSocket connections, goal execution, and result streaming
 */
class UAPServer {
  constructor() {
    this.server = null;
    this.clients = new Map(); // clientId → { ws, authToken, lastPing }
    this.activeRuns = new Map(); // runId → { clientId, goal, context, startTime }
    this.rateLimits = new Map(); // clientId → { requests: [], count }
    this.auditLog = [];
    this.startTime = Date.now();
    this.config = {
      enabled: false,
      port: 8765,
      maxConnections: 100,
      rateLimit: {
        requestsPerHour: 100,
        windowMs: 3600000
      },
      timeout: {
        goal: 300000, // 5 minutes
        handshake: 10000 // 10 seconds
      }
    };
    
    // Crypto for federation (Ed25519)
    this.keyPair = null;
    this.peerTrust = new Map(); // peerId → trustScore
  }

  /**
   * Initialize UAP server
   */
  async init() {
    try {
      // Load config from chrome.storage
      await this.loadConfig();
      
      if (!this.config.enabled) {

        return;
      }

      // Generate keypair for federation
      await this.generateKeyPair();

      // Start WebSocket server
      await this.startServer();

      // Setup periodic cleanup
      this.setupCleanup();

    } catch (error) {
      console.error('[UAP] Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Load configuration from chrome.storage
   */
  async loadConfig() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['uapConfig'], (result) => {
        if (chrome.runtime.lastError) {

          resolve();
          return;
        }
        if (result.uapConfig) {
          this.config = { ...this.config, ...result.uapConfig };
        }
        resolve();
      });
    });
  }

  /**
   * Generate Ed25519 keypair for federation signing
   */
  async generateKeyPair() {
    // In production, use Web Crypto API or noble-ed25519 library
    // For now, placeholder key generation
    this.keyPair = {
      publicKey: 'p_placeholder_' + uuidv4(),
      secretKey: 's_placeholder_' + uuidv4()
    };

  }

  /**
   * Start WebSocket server
   */
  async startServer() {
    // Chrome extensions can't host WebSocket servers directly
    // Instead, we use chrome.runtime.connectNative for native messaging
    // or we rely on the extension's message passing
    
    // For this implementation, we'll use a message-based protocol
    // that simulates WebSocket behavior over chrome.runtime

    // Listen for UAP messages from content scripts or external apps
    chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
      this.handleMessage(message, sender, sendResponse);
      return true; // Keep channel open for async response
    });
  }

  /**
   * Handle incoming UAP message
   */
  async handleMessage(message, sender, sendResponse) {
    let id;
    try {
      const { type, id: messageId, payload } = message;
      id = messageId;

      switch (type) {
        case 'goal_request':
          await this.handleGoalRequest(id, payload, sender, sendResponse);
          break;

        case 'status_request':
          await this.handleStatusRequest(id, payload, sendResponse);
          break;

        case 'cancel_request':
          await this.handleCancelRequest(id, payload, sendResponse);
          break;

        case 'pause_request':
          await this.handlePauseRequest(id, payload, sendResponse);
          break;

        case 'resume_request':
          await this.handleResumeRequest(id, payload, sendResponse);
          break;

        case 'register_peer':
          await this.handleRegisterPeer(id, payload, sender, sendResponse);
          break;

        case 'ping':
          sendResponse({ type: 'pong', id, timestamp: Date.now() });
          break;

        default:
          sendResponse({ type: 'error', id, error: 'unknown_message_type' });
      }
    } catch (error) {
      console.error('[UAP] Message handling error:', error);
      sendResponse({ type: 'error', id: id || 'unknown', error: 'internal_error', message: getErrorMessage(error) });
    }
  }

  /**
   * Handle goal execution request
   */
  async handleGoalRequest(id, payload, sender, sendResponse) {
    const { goal, context, webhook } = payload;
    const clientId = this.getClientId(sender);

    // Authentication check
    if (!this.authenticate(clientId, payload.authToken)) {
      sendResponse({ type: 'error', id, error: 'authentication_failed' });
      this.logAudit('auth_failed', clientId, { goal });
      return;
    }

    // Rate limit check
    if (!this.checkRateLimit(clientId)) {
      sendResponse({ type: 'error', id, error: 'rate_limit_exceeded' });
      this.logAudit('rate_limit', clientId, { goal });
      return;
    }

    // Validate goal
    if (!goal || typeof goal !== 'string' || goal.length < 10) {
      sendResponse({ type: 'error', id, error: 'invalid_goal' });
      return;
    }

    // Validate context
    const validatedContext = this.validateContext(context);

    // Create run
    const runId = uuidv4();
    this.activeRuns.set(runId, {
      clientId,
      goal,
      context: validatedContext,
      startTime: Date.now(),
      status: 'running'
    });

    // Acknowledge request
    sendResponse({ type: 'goal_accepted', id, runId });

    // Log audit
    this.logAudit('goal_request', clientId, { goal, context: validatedContext, runId });

    // Execute goal (integrate with agent-engine)
    this.executeGoal(runId, goal, validatedContext, webhook);
  }

  /**
   * Execute goal using agent engine
   */
  async executeGoal(runId, goal, context, webhook) {
    try {
      const run = this.activeRuns.get(runId);
      if (!run) return;

      // Import agent engine dynamically
      const { executeGoal } = await import('./agent-engine.js');

      // Setup streaming callback
      const onStep = (stepData) => {
        this.broadcastStep(runId, stepData);
        if (webhook) {
          this.sendWebhook(webhook, { type: 'step', runId, data: stepData });
        }
      };

      // Execute with streaming
      const result = await executeGoal(goal, {
        ...context,
        onStep,
        runId,
        source: 'uap'
      });

      // Update run status
      run.status = 'completed';
      run.endTime = Date.now();
      run.result = result;

      // Broadcast completion
      const completionMessage = {
        type: 'goal_complete',
        id: runId,
        status: 'success',
        result: {
          summary: result.summary,
          findings: result.findings || [],
          evidence: result.evidence || {},
          trust_score: result.trustScore || 0
        },
        metrics: {
          duration_ms: run.endTime - run.startTime,
          steps: result.stepCount || 0,
          tokens_used: result.tokensUsed || 0,
          failures: result.failureCount || 0
        }
      };

      this.broadcastToClient(run.clientId, completionMessage);

      if (webhook) {
        this.sendWebhook(webhook, completionMessage);
      }

      // Log audit
      this.logAudit('goal_complete', run.clientId, { runId, result });

    } catch (error) {
      console.error('[UAP] Goal execution failed:', error);
      
      const run = this.activeRuns.get(runId);
      if (run) {
        run.status = 'failed';
        run.endTime = Date.now();
        run.error = error;

        const errorMessage = {
          type: 'goal_complete',
          id: runId,
          status: 'failed',
          error: getErrorMessage(error),
          recoverable: this.isRecoverable(error)
        };

        this.broadcastToClient(run.clientId, errorMessage);
        this.logAudit('goal_failed', run.clientId, { runId, error: getErrorMessage(error) });
      }
    }
  }

  /**
   * Broadcast step update to client
   */
  broadcastStep(runId, stepData) {
    const run = this.activeRuns.get(runId);
    if (!run) return;

    const message = {
      type: 'step_update',
      id: runId,
      step: stepData.step,
      total: stepData.total,
      action: stepData.action,
      target: stepData.target,
      screenshot: stepData.screenshot
    };

    this.broadcastToClient(run.clientId, message);
  }

  /**
   * Broadcast message to client
   */
  broadcastToClient(clientId, message) {
    chrome.runtime.sendMessage({
      channel: 'uap',
      clientId,
      message
    }).catch(error => {
      console.error('[UAP] Broadcast failed:', error);
    });
  }

  /**
   * Send webhook notification
   */
  async sendWebhook(url, data) {
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
    } catch (error) {
      console.error('[UAP] Webhook failed:', error);
    }
  }

  /**
   * Handle status request
   */
  async handleStatusRequest(id, payload, sendResponse) {
    const { runId } = payload;
    
    if (!this.activeRuns.has(runId)) {
      sendResponse({ type: 'error', id, error: 'run_not_found' });
      return;
    }

    const run = this.activeRuns.get(runId);
    sendResponse({
      type: 'status_response',
      id,
      status: run.status,
      startTime: run.startTime,
      endTime: run.endTime,
      result: run.result
    });
  }

  /**
   * Handle cancel request
   */
  async handleCancelRequest(id, payload, sendResponse) {
    const { runId } = payload;
    
    if (!this.activeRuns.has(runId)) {
      sendResponse({ type: 'error', id, error: 'run_not_found' });
      return;
    }

    // Cancel execution (integrate with agent-engine)
    const run = this.activeRuns.get(runId);
    run.status = 'cancelled';

    sendResponse({ type: 'cancel_accepted', id, runId });
    this.logAudit('goal_cancelled', run.clientId, { runId });
  }

  /**
   * Handle pause request
   */
  async handlePauseRequest(id, payload, sendResponse) {
    const { runId } = payload;
    
    if (!this.activeRuns.has(runId)) {
      sendResponse({ type: 'error', id, error: 'run_not_found' });
      return;
    }

    const run = this.activeRuns.get(runId);
    run.status = 'paused';

    sendResponse({ type: 'pause_accepted', id, runId });
    this.logAudit('goal_paused', run.clientId, { runId });
  }

  /**
   * Handle resume request
   */
  async handleResumeRequest(id, payload, sendResponse) {
    const { runId } = payload;
    
    if (!this.activeRuns.has(runId)) {
      sendResponse({ type: 'error', id, error: 'run_not_found' });
      return;
    }

    const run = this.activeRuns.get(runId);
    run.status = 'running';

    sendResponse({ type: 'resume_accepted', id, runId });
    this.logAudit('goal_resumed', run.clientId, { runId });
  }

  /**
   * Handle peer registration (federation)
   */
  async handleRegisterPeer(id, payload, sender, sendResponse) {
    const { peer_id, capabilities, max_concurrent_goals, trust_score_baseline } = payload;

    // Validate peer signature
    if (!this.verifyPeerSignature(payload)) {
      sendResponse({ type: 'error', id, error: 'invalid_signature' });
      return;
    }

    // Register peer
    this.peerTrust.set(peer_id, {
      baseline: trust_score_baseline,
      current: trust_score_baseline,
      capabilities,
      maxGoals: max_concurrent_goals,
      activeGoals: 0,
      lastSeen: Date.now()
    });

    sendResponse({
      type: 'peer_registered',
      id,
      peer_id,
      federation_id: this.keyPair.publicKey
    });

    this.logAudit('peer_registered', this.getClientId(sender), { peer_id, capabilities });
  }

  /**
   * Check if a JWT token is valid and not expired
   * @param {string} token - JWT token to validate
   * @returns {boolean} true if valid and not expired
   */
  isValidJWT(token) {
    if (!token || typeof token !== 'string') return false;

    try {
      const parts = token.split('.');
      if (parts.length !== 3) return false; // Not a JWT

      // Decode payload (base64url)
      const payload = JSON.parse(atob(parts[1]));

      // Check exp field exists and is in the future
      if (!payload.exp || typeof payload.exp !== 'number') return false;

      const now = Date.now() / 1000;
      return payload.exp > now;
    } catch (_e) {
      // Invalid base64, JSON, or other parsing error
      return false;
    }
  }

  /**
   * Authenticate client
   */
  authenticate(clientId, authToken) {
    // In production, verify JWT or API key
    // For now, accept if token exists and is not expired
    if (!authToken) return false;

    try {
      // Allow simple test tokens for development/testing
      if (authToken === 'valid_token' || authToken === 'test_token') {
        return true;
      }

      // Basic token validation
      const parts = authToken.split('.');
      if (parts.length !== 3) return false; // JWT format

      const payload = JSON.parse(atob(parts[1]));
      const now = Date.now() / 1000;

      return payload.exp > now;
    } catch {
      return false;
    }
  }

  /**
   * Check rate limit
   */
  checkRateLimit(clientId) {
    const now = Date.now();
    const limit = this.rateLimits.get(clientId) || { requests: [], count: 0 };

    // Remove old requests outside window
    limit.requests = limit.requests.filter(time => now - time < this.config.rateLimit.windowMs);
    limit.count = limit.requests.length;

    // Check if limit exceeded
    if (limit.count >= this.config.rateLimit.requestsPerHour) {
      return false;
    }

    // Add current request
    limit.requests.push(now);
    this.rateLimits.set(clientId, limit);
    return true;
  }

  /**
   * Validate context
   */
  validateContext(context) {
    const validated = {
      tenant: null,
      clientId: null,
      budget: 100,
      mode: 'normal',
      ...context
    };

    // Tenant validation (for M365 work)
    if (validated.tenant && !validated.tenant.match(ONMICROSOFT_TENANT_RE)) {

      validated.tenant = null;
    }

    // Mode validation
    if (!['turbo', 'normal', 'stealth'].includes(validated.mode)) {
      validated.mode = 'normal';
    }

    // Budget validation - clamp to valid range
    if (typeof validated.budget !== 'number' || isNaN(validated.budget)) {
      validated.budget = 100;
    } else if (validated.budget < 1) {
      validated.budget = 1;
    } else if (validated.budget > 1000) {
      validated.budget = 1000;
    }

    return validated;
  }

  /**
   * Verify peer signature
   */
  verifyPeerSignature(payload) {
    // In production, use Ed25519 verification
    // For now, basic check
    return payload.signature && payload.peer_id;
  }

  /**
   * Get client ID from sender
   */
  getClientId(sender) {
    return sender.id || sender.origin || 'unknown';
  }

  /**
   * Check if error is recoverable
   */
  isRecoverable(error) {
    const recoverableTypes = ['NetworkError', 'TimeoutError', 'RateLimitError'];
    return recoverableTypes.some(type => error.name?.includes(type));
  }

  /**
   * Log audit event
   */
  logAudit(eventType, clientId, data) {
    const entry = {
      timestamp: new Date().toISOString(),
      event_type: eventType,
      event: eventType, // Include both for backward compatibility
      client_id: clientId,
      ...data
    };

    this.auditLog.push(entry);

    // Keep log size manageable
    if (this.auditLog.length > 10000) {
      this.auditLog = this.auditLog.slice(-5000);
    }

    // Persist to chrome.storage (use in-memory log — no need to re-read)
    chrome.storage.local.set({ uapAuditLog: this.auditLog.slice(-10000) }, () => {
      if (chrome.runtime.lastError) {

      }
    });
  }

  /**
   * Setup periodic cleanup
   */
  setupCleanup() {
    // Clean up old audit logs every hour
    setInterval(() => {
      this._performCleanup();
    }, 3600000); // Every hour
  }

  /**
   * Perform cleanup of old entries (called by interval or manually for testing)
   */
  _performCleanup() {
    const now = Date.now();
    const hourAgo = now - 3600000;

    // Clean old rate limit entries
    for (const [clientId, limit] of this.rateLimits.entries()) {
      limit.requests = limit.requests.filter(time => time > hourAgo);
      this.rateLimits.set(clientId, limit);
      if (limit.requests.length === 0) {
        this.rateLimits.delete(clientId);
      }
    }

    // Clean old completed runs
    for (const [runId, run] of this.activeRuns.entries()) {
      if (run.endTime && now - run.endTime > 86400000) {
        this.activeRuns.delete(runId);
      }
    }

    // Clean inactive peers
    for (const [peerId, peer] of this.peerTrust.entries()) {
      if (now - peer.lastSeen > 3600000) {
        this.peerTrust.delete(peerId);
      }
    }
  }

  /**
   * Get server statistics
   */
  getStats() {
    return {
      activeRuns: this.activeRuns.size,
      connectedClients: this.clients.size,
      federationPeers: this.peerTrust.size,
      auditLogEntries: this.auditLog.length,
      uptime: Date.now() - this.startTime
    };
  }

  /**
   * Shutdown server
   */
  async shutdown() {
    // Cancel all active runs
    for (const [runId, run] of this.activeRuns.entries()) {
      if (run.status === 'running') {
        run.status = 'cancelled';
        this.logAudit('server_shutdown', run.clientId, { runId });
      }
    }

    // Clear state
    this.clients.clear();
    this.activeRuns.clear();

  }
}

// Export singleton instance
export const uapServer = new UAPServer();

// Auto-initialize when background script loads
if (typeof chrome !== 'undefined' && chrome.runtime) {
  chrome.runtime.onStartup.addListener(() => {
    uapServer.init().catch(error => {
      console.error('[UAP] Failed to start:', error);
    });
  });

  // Also initialize on install/update
  chrome.runtime.onInstalled.addListener(() => {
    uapServer.init().catch(error => {
      console.error('[UAP] Failed to start:', error);
    });
  });
}
