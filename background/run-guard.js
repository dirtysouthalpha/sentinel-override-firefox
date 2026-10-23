// background/run-guard.js
// Phase 0.5 — persisted kill switch, enforced spend budget, durable rate limit.
//
// WHY THIS EXISTS. Three holes were verified in the pre-Phase-0.5 tree:
//
//   1. NO KILL SWITCH. Stopping a run only cleared in-memory state
//      (cancelActiveLLM -> STOPPED_BY_USER). sw-watchdog.js evaluateTick()
//      returns 'resume' for an orphaned run, and the in-memory agentRunning
//      flag is lost on a service-worker restart — so a restart resurrected a
//      run the operator had explicitly stopped, with nothing left to refuse it.
//
//   2. THE BUDGET GATE FAILED OPEN. check_credit_limit (index.js) returned
//      {allowed:true} from its own catch block, and both call sites — callLLM
//      in llm-client.js and the run loop in agent-engine.js — wrapped the probe
//      in try/catch and continued on error. A failed probe therefore meant
//      "spend anyway". The gate was advisory in the only two places it ran.
//
//   3. RATE LIMITS WERE IN-MEMORY ONLY. _rateLimiter (llm-client.js) and
//      endpointBreaker (endpoint-breaker.js) are module singletons, so a
//      service-worker restart wiped both the sliding call window and the
//      endpoint cooldown. The cooldown is exactly what stops a restart loop
//      from hammering a dead endpoint — and it did not survive the restart
//      that would trigger the loop.
//
// WHAT THIS IS NOT. chrome.storage is plaintext and writable by any
// service-worker-context code, so this is a SAFETY device, not a security
// boundary: it stops a buggy or looping agent from spending unbounded money
// and stops a stopped run from resurrecting. It does not stop an attacker who
// can already write chrome.storage — that is what Phase 0.2 (native-messaging
// credential broker) is for.
//
// DESIGN. Pure decision functions (unit-tested against a fixed clock) plus a
// thin injected-IO executor. No chrome.* is touched at module scope, so the
// jest suite exercises the decisions directly without a browser.

export const GUARD_STORAGE_KEY = 'sentinel_guard';
export const GUARD_VERSION = 1;

/**
 * Default limits. dailyCostUsd/dailyCalls are hard caps per UTC day; the
 * sliding window caps burst rate. ledgerRetentionDays bounds the ledger size.
 */
export const DEFAULT_LIMITS = {
  dailyCostUsd: 5.0,
  dailyCalls: 2000,
  windowMs: 60_000,
  maxCalls: 120,
  ledgerRetentionDays: 7
};

/** Stable machine-readable block reasons (surfaced in logs and the UI). */
export const GUARD_BLOCK = {
  KILL_SWITCH: 'KILL_SWITCH_ENGAGED',
  DAILY_COST: 'DAILY_COST_LIMIT_REACHED',
  DAILY_CALLS: 'DAILY_CALL_LIMIT_REACHED',
  RATE_LIMIT: 'RATE_LIMIT_REACHED',
  STORAGE: 'GUARD_STATE_UNREADABLE'
};

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** UTC day bucket key, e.g. '2026-10-22'. UTC so the cap rolls over once a day. */
export function todayKey(now) {
  return new Date(now).toISOString().split('T')[0];
}

function numOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Drop ledger buckets older than the retention window. Keys are 'YYYY-MM-DD',
 * which sort lexicographically in chronological order, so a string compare is
 * sufficient and avoids Date parsing.
 */
export function pruneLedger(ledger, now, retentionDays = DEFAULT_LIMITS.ledgerRetentionDays) {
  const days = Number.isFinite(retentionDays) && retentionDays > 0
    ? Math.floor(retentionDays)
    : DEFAULT_LIMITS.ledgerRetentionDays;
  const cutoff = new Date(now - days * 86_400_000).toISOString().split('T')[0];
  const out = {};
  for (const key of Object.keys(ledger || {})) {
    if (DAY_KEY_RE.test(key) && key >= cutoff) out[key] = ledger[key];
  }
  return out;
}

/**
 * Return a NEW ledger with `charge` folded into today's bucket, pruned to the
 * retention window. Pure: the input ledger is never mutated.
 */
export function chargeLedger(ledger, now, charge = {}, limits = DEFAULT_LIMITS) {
  const key = todayKey(now);
  const prev = ledger[key] || { costUsd: 0, calls: 0, tokens: 0 };
  const next = {
    costUsd: (Number(prev.costUsd) || 0) + (Number(charge.costUsd) || 0),
    calls: (Number(prev.calls) || 0) + (Number(charge.calls) || 1),
    tokens: (Number(prev.tokens) || 0) + (Number(charge.tokens) || 0)
  };
  const pruned = pruneLedger(ledger, now, limits.ledgerRetentionDays);
  pruned[key] = next;
  return pruned;
}

/**
 * Kill switch decision. Only an explicit `disabled === true` blocks — a
 * missing or partially-written kill object must never look engaged.
 */
export function decideKillSwitch(kill) {
  if (!kill || kill.disabled !== true) return { blocked: false, code: '', reason: '' };
  return {
    blocked: true,
    code: GUARD_BLOCK.KILL_SWITCH,
    reason: kill.reason || 'Sentinel is stopped. Clear the kill switch in Settings to resume.',
    since: kill.at || 0
  };
}

/**
 * Budget decision against today's spend. Blocks at OR over the cap (`>=`), so
 * landing exactly on the limit stops the next call rather than allowing one
 * more. A cap of 0 means "spending disabled" and blocks immediately.
 */
export function decideBudget(spent = {}, limits = DEFAULT_LIMITS) {
  const cost = Number(spent.costUsd) || 0;
  const calls = Number(spent.calls) || 0;
  const capCost = Number(limits.dailyCostUsd);
  if (Number.isFinite(capCost) && capCost >= 0 && cost >= capCost) {
    return {
      blocked: true,
      code: GUARD_BLOCK.DAILY_COST,
      reason: `Daily credit limit reached ($${cost.toFixed(2)} of $${capCost.toFixed(2)}). Increase the limit in Settings or wait until tomorrow.`
    };
  }
  const capCalls = Number(limits.dailyCalls);
  if (Number.isFinite(capCalls) && capCalls >= 0 && calls >= capCalls) {
    return {
      blocked: true,
      code: GUARD_BLOCK.DAILY_CALLS,
      reason: `Daily call limit reached (${calls} of ${capCalls} calls). Increase the limit in Settings or wait until tomorrow.`
    };
  }
  return { blocked: false, code: '', reason: '' };
}

/**
 * Sliding-window rate limit. Returns the timestamps still inside the window
 * rather than mutating the input; the caller decides what to persist.
 */
export function liveWindow(timestamps, now, windowMs = DEFAULT_LIMITS.windowMs) {
  return (timestamps || []).filter((t) => Number.isFinite(t) && now - t < windowMs);
}

export function decideRateLimit(timestamps = [], now, limits = DEFAULT_LIMITS) {
  const windowMs = Number(limits.windowMs) || DEFAULT_LIMITS.windowMs;
  const maxCalls = Number(limits.maxCalls) || DEFAULT_LIMITS.maxCalls;
  const live = liveWindow(timestamps, now, windowMs);
  if (live.length >= maxCalls) {
    const oldest = Math.min(...live);
    const retryInSeconds = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000));
    return {
      allowed: false,
      code: GUARD_BLOCK.RATE_LIMIT,
      retryInSeconds,
      remaining: 0,
      reason: `Rate limit: ${maxCalls} calls per ${Math.round(windowMs / 1000)}s. Retry in ${retryInSeconds}s.`
    };
  }
  return { allowed: true, code: '', reason: '', retryInSeconds: 0, remaining: maxCalls - live.length };
}

/**
 * Coerce untrusted stored JSON into a well-formed guard state.
 *
 * `malformed` is the fail-closed signal: the key was present but could not be
 * understood. An absent key (fresh install, or never written) is NOT malformed
 * — it normalises to defaults. Anything present-but-wrong flips the flag so
 * evaluateGuard refuses to spend on an unverifiable budget rather than
 * silently resetting it to zero.
 */
export function normalizeGuardState(raw) {
  const fresh = () => ({
    version: GUARD_VERSION,
    kill: { disabled: false, at: 0, reason: '', by: '' },
    limits: { ...DEFAULT_LIMITS },
    ledger: {},
    calls: [],
    malformed: false
  });

  if (raw === undefined || raw === null) return fresh();
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    const s = fresh();
    s.malformed = true;
    return s;
  }

  const state = fresh();

  if (raw.limits !== undefined && raw.limits !== null) {
    const l = raw.limits;
    if (typeof l !== 'object' || Array.isArray(l)) {
      state.malformed = true;
    } else {
      const merged = {
        dailyCostUsd: numOr(l.dailyCostUsd, DEFAULT_LIMITS.dailyCostUsd),
        dailyCalls: numOr(l.dailyCalls, DEFAULT_LIMITS.dailyCalls),
        windowMs: numOr(l.windowMs, DEFAULT_LIMITS.windowMs),
        maxCalls: numOr(l.maxCalls, DEFAULT_LIMITS.maxCalls),
        ledgerRetentionDays: numOr(l.ledgerRetentionDays, DEFAULT_LIMITS.ledgerRetentionDays)
      };
      // A non-numeric limit reverts to the default rather than flagging the
      // whole state malformed: the default caps are lower than any
      // operator-set limit, so this is the conservative direction and cannot
      // open a spend hole. A NEGATIVE limit is the dangerous case — it reads
      // as "unlimited" — so it fails closed.
      if (Object.values(merged).some((v) => !Number.isFinite(v) || v < 0)) {
        state.malformed = true;
      }
      state.limits = merged;
    }
  }

  if (raw.ledger !== undefined && raw.ledger !== null) {
    const lg = raw.ledger;
    if (typeof lg !== 'object' || Array.isArray(lg)) {
      state.malformed = true;
    } else {
      for (const [key, value] of Object.entries(lg)) {
        if (!DAY_KEY_RE.test(key) || !value || typeof value !== 'object' || Array.isArray(value)) {
          state.malformed = true;
          continue;
        }
        state.ledger[key] = {
          costUsd: numOr(value.costUsd, 0),
          calls: numOr(value.calls, 0),
          tokens: numOr(value.tokens, 0)
        };
      }
    }
  }

  if (raw.calls !== undefined && raw.calls !== null) {
    if (!Array.isArray(raw.calls)) {
      state.malformed = true;
    } else {
      state.calls = raw.calls.filter((t) => Number.isFinite(t));
    }
  }

  if (raw.kill !== undefined && raw.kill !== null) {
    const k = raw.kill;
    if (typeof k !== 'object' || Array.isArray(k)) {
      state.malformed = true;
    } else {
      state.kill = {
        disabled: k.disabled === true,
        at: numOr(k.at, 0),
        reason: typeof k.reason === 'string' ? k.reason : '',
        by: typeof k.by === 'string' ? k.by : ''
      };
    }
  }

  return state;
}

/** Read-only snapshot for logs and the settings UI. */
export function guardStatus(state, now) {
  const key = todayKey(now);
  const spent = (state.ledger && state.ledger[key]) || { costUsd: 0, calls: 0, tokens: 0 };
  const capCost = Number(state.limits.dailyCostUsd) || 0;
  const capCalls = Number(state.limits.dailyCalls) || 0;
  return {
    version: state.version,
    kill: { ...state.kill },
    limits: { ...state.limits },
    today: key,
    spentCostUsd: spent.costUsd,
    spentCalls: spent.calls,
    spentTokens: spent.tokens,
    remainingCostUsd: Math.max(0, capCost - spent.costUsd),
    remainingCalls: Math.max(0, capCalls - spent.calls),
    malformed: !!state.malformed,
    daysTracked: Object.keys(state.ledger || {}).length
  };
}

/**
 * The whole gate, in order: kill switch, unreadable state, budget, rate limit.
 * Returns {blocked, code, reason, status} — `status` is always populated so a
 * block can be explained to the operator without a second read.
 */
export function evaluateGuard(state, now) {
  const s = state || normalizeGuardState(null);
  const status = guardStatus(s, now);

  const kill = decideKillSwitch(s.kill);
  if (kill.blocked) return { blocked: true, code: kill.code, reason: kill.reason, since: kill.since, status };

  if (s.malformed) {
    return {
      blocked: true,
      code: GUARD_BLOCK.STORAGE,
      reason: 'Guard state is unreadable — spending is paused. Reset the guard in Settings to resume.',
      status
    };
  }

  const spent = s.ledger[todayKey(now)] || {};
  const budget = decideBudget(spent, s.limits);
  if (budget.blocked) return { blocked: true, code: budget.code, reason: budget.reason, status };

  const rate = decideRateLimit(s.calls, now, s.limits);
  if (!rate.allowed) {
    return { blocked: true, code: rate.code, reason: rate.reason, retryInSeconds: rate.retryInSeconds, status };
  }

  return { blocked: false, code: '', reason: '', retryInSeconds: 0, status };
}

// ---------------------------------------------------------------------------
// Storage IO
// ---------------------------------------------------------------------------

function hasStorage() {
  return !!(typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local);
}

/**
 * Read the raw guard object. Resolves {ok, value} on success or {ok:false,
 * error} on failure. Supports BOTH the callback and promise forms of
 * chrome.storage.local.get — real Chrome uses the callback form and returns
 * undefined, while several jest mocks return a promise.
 */
export function readGuardRaw() {
  return new Promise((resolve) => {
    if (!hasStorage()) return resolve({ ok: false, error: 'no-storage-api' });
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const ret = chrome.storage.local.get(GUARD_STORAGE_KEY, (raw) => {
        if (chrome.runtime && chrome.runtime.lastError) {
          return done({ ok: false, error: String(chrome.runtime.lastError.message || 'storage-error') });
        }
        done({ ok: true, value: raw ? raw[GUARD_STORAGE_KEY] : null });
      });
      if (ret && typeof ret.then === 'function') {
        ret.then(
          (raw) => done({ ok: true, value: raw ? raw[GUARD_STORAGE_KEY] : null }),
          (e) => done({ ok: false, error: String((e && e.message) || e) })
        );
      }
    } catch (e) {
      done({ ok: false, error: String((e && e.message) || e) });
    }
  });
}

/** Persist the guard object. Same dual-form handling as readGuardRaw. */
export function writeGuardRaw(state) {
  return new Promise((resolve) => {
    if (!hasStorage()) return resolve({ ok: false, error: 'no-storage-api' });
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const ret = chrome.storage.local.set({ [GUARD_STORAGE_KEY]: state }, () => {
        if (chrome.runtime && chrome.runtime.lastError) {
          return done({ ok: false, error: String(chrome.runtime.lastError.message || 'storage-error') });
        }
        done({ ok: true });
      });
      if (ret && typeof ret.then === 'function') {
        ret.then(() => done({ ok: true }), (e) => done({ ok: false, error: String((e && e.message) || e) }));
      }
    } catch (e) {
      done({ ok: false, error: String((e && e.message) || e) });
    }
  });
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * The guard as a usable object. IO is injected so every decision path is
 * testable without chrome; the exported `guardStore` singleton wires it to
 * chrome.storage.local and a wall clock.
 *
 * Fail-closed rule: a storage API that is PRESENT but failing blocks spending
 * (we cannot prove the budget). A storage API that is entirely ABSENT cannot
 * be enforced against and is treated as "no guard configured" — that is the
 * only fail-open path, and it does not occur in a real extension context.
 */
export class GuardStore {
  constructor(deps = {}) {
    this._read = deps.read || readGuardRaw;
    this._write = deps.write || writeGuardRaw;
    this._now = deps.now || (() => Date.now());
  }

  async load() {
    const res = await this._read();
    if (!res.ok) {
      const state = normalizeGuardState(null);
      if (res.error !== 'no-storage-api') state.malformed = true;
      return state;
    }
    return normalizeGuardState(res.value);
  }

  async evaluate() {
    const state = await this.load();
    return { verdict: evaluateGuard(state, this._now()), state };
  }

  /** The verdict only — the hot path used before each LLM call. */
  async check() {
    return (await this.evaluate()).verdict;
  }

  /** Record one LLM call and its cost. Returns {ok, error, status}. */
  async charge(charge = {}) {
    const now = this._now();
    const state = await this.load();
    const next = {
      ...state,
      version: GUARD_VERSION,
      ledger: chargeLedger(state.ledger, now, charge, state.limits),
      calls: [...liveWindow(state.calls, now, state.limits.windowMs), now]
    };
    const res = await this._write(next);
    return { ok: res.ok, error: res.error, status: guardStatus(next, now) };
  }

  async engageKillSwitch(reason = '', by = '') {
    const now = this._now();
    const state = await this.load();
    const next = { ...state, version: GUARD_VERSION, kill: { disabled: true, at: now, reason, by } };
    const res = await this._write(next);
    return { ok: res.ok, error: res.error, status: guardStatus(next, now) };
  }

  async clearKillSwitch(by = '') {
    const now = this._now();
    const state = await this.load();
    const next = { ...state, version: GUARD_VERSION, kill: { disabled: false, at: 0, reason: '', by } };
    const res = await this._write(next);
    return { ok: res.ok, error: res.error, status: guardStatus(next, now) };
  }

  async setLimits(limits = {}) {
    const now = this._now();
    const state = await this.load();
    const next = { ...state, version: GUARD_VERSION, limits: { ...state.limits, ...limits } };
    const res = await this._write(next);
    return { ok: res.ok, error: res.error, status: guardStatus(next, now) };
  }

  /** Wipe the guard back to defaults (the "reset" button in Settings). */
  async reset() {
    const now = this._now();
    const next = normalizeGuardState(null);
    const res = await this._write(next);
    return { ok: res.ok, error: res.error, status: guardStatus(next, now) };
  }
}

/** Singleton wired to chrome.storage.local — the one the SW and popup use. */
export const guardStore = new GuardStore();
