// background/endpoint-breaker.js
// (O4/A1) Cross-run endpoint cooldown breaker — complements (SO-94).
// SO-94 aborts a run after 5 consecutive raw LLM failures, but the NEXT run
// would hammer the same dead or rate-limiting endpoint immediately. This
// module keeps the endpoint itself resting: after a rejection streak it
// OPENS, blocks outbound LLM requests until the cooldown elapses, then
// allows ONE probe request. Probe success closes the breaker; probe failure
// re-opens with double the cooldown, capped. Pure logic, no chrome.* APIs —
// the jest suite tests it directly with injected time.

export const BREAKER = { CLOSED: "closed", OPEN: "open", HALF_OPEN: "half_open" };

const DEFAULTS = {
  threshold: 5,          // consecutive rejections before the breaker opens
  cooldownMs: 60000,     // first open window — doubles on each re-trip
  maxCooldownMs: 300000, // backoff cap — 5 minutes
  halfOpenMax: 1,        // probe requests allowed while half open
};

export class CooldownBreaker {
  constructor(options = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this._now = options.now || (() => Date.now());
    this.reset();
  }

  reset() {
    this.state = BREAKER.CLOSED;
    this.streak = 0;  // consecutive unresolved rejections
    this.trips = 0;   // completed trips — drives the doubling backoff
    this.openedAt = 0;
    this.probesInFlight = 0;
    this.lastReason = null;
  }

  _windowMs() {
    if (this.trips <= 0) return this.opts.cooldownMs;
    return Math.min(this.opts.cooldownMs * Math.pow(2, this.trips - 1), this.opts.maxCooldownMs);
  }

  // True when an outbound request is allowed. While HALF_OPEN a call consumes
  // one probe slot — the caller MUST settle it with recordSuccess or
  // recordRejection, or the probe pool stays exhausted.
  canRequest() {
    if (this.state === BREAKER.CLOSED) return true;
    if (this._now() - this.openedAt < this._windowMs()) return false;
    if (this.state === BREAKER.OPEN) {
      this.state = BREAKER.HALF_OPEN;
      this.probesInFlight = 0;
    }
    if (this.probesInFlight >= this.opts.halfOpenMax) return false;
    this.probesInFlight += 1;
    return true;
  }

  recordRejection(reason) {
    this.streak += 1;
    this.lastReason = reason || null;
    this.probesInFlight = 0;
    if (this.state === BREAKER.HALF_OPEN || this.streak >= this.opts.threshold) {
      this.state = BREAKER.OPEN;
      this.openedAt = this._now();
      this.trips = Math.min(this.trips + 1, 30);
    }
  }

  recordSuccess() {
    this.reset();
  }

  getStatus() {
    return {
      state: this.state,
      streak: this.streak,
      trips: this.trips,
      windowMs: this._windowMs(),
      msUntilProbe: this.state === BREAKER.CLOSED
        ? 0
        : Math.max(0, this._windowMs() - (this._now() - this.openedAt)),
      lastReason: this.lastReason,
    };
  }
}

// Singleton wired into llm-client.js — survives across agent runs by design
// so a fresh run cannot reset an endpoint that is still cooling down.
export const endpointBreaker = new CooldownBreaker();
export function resetEndpointBreaker() { endpointBreaker.reset(); }
