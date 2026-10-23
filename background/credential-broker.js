// background/credential-broker.js
// Phase 0.2 — credential broker. Provider API keys live here, never in
// chrome.storage.local.
//
// WHY THIS EXISTS. chrome.storage.local is NOT a vault:
//
//   - it is plaintext on disk, readable by anything that can read the profile
//   - it survives every browser restart, indefinitely
//   - chrome.storage.sync ships the same bytes to the vendor's cloud
//   - every bit of code in the extension's service-worker context can read it,
//     including a compromised npm dependency
//
// A leaked provider key is a spend bill, and for a cloud account possibly much
// worse. The broker is the ONLY door a provider key passes through, and it
// keeps keys out of chrome.storage.local entirely.
//
// WHAT THIS IS NOT. The broker removes secrets from the browser's own storage
// and puts them somewhere the browser cannot read. It does NOT make a secret
// unreadable to code running in the extension: the agent has to hold the key in
// memory to make the request, so anything that can execute in this context can
// ask the broker for it. What it removes is *at-rest* exposure in the profile
// and *sync* exposure to the vendor cloud. Do not overclaim it.
//
// BACKENDS, tried in order:
//
//   native  — a native messaging host (com.sentinel.broker) that keeps secrets
//             in the OS keychain, or in an encrypted file when no keychain is
//             available. See native-host/. This is the preferred backend.
//   session — chrome.storage.session: memory-only, never written to disk, gone
//             when the browser closes. This is the automatic default and is
//             already a large improvement over `local`.
//
// chrome.storage.local is read ONLY by the migration helper, and only to move
// keys written by older versions. The broker never writes there.
//
// FAIL-CLOSED. When a key is required and the broker cannot produce one, the
// broker returns '' and the caller raises its own "API key not configured"
// error. The broker never falls through to a keyless cloud endpoint and never
// invents a value.
//
// DESIGN. Pure record helpers plus an injected-IO executor. No chrome.* is
// touched at module scope, so the jest suite exercises every path without a
// browser.

export const CREDENTIAL_BROKER_VERSION = 1;

/** Native messaging host name. The host manifest and installer must match. */
export const BROKER_HOST_NAME = 'com.sentinel.broker';

/** Where the broker keeps its record when no native host is installed. */
export const SESSION_STORAGE_KEY = 'sentinel_credentials';

/** Legacy chrome.storage.local keys that may still hold a key. Read-only. */
export const LEGACY_PROVIDERS_KEY = 'providers';
export const LEGACY_API_KEY_KEY = 'api_key';
export const LEGACY_ENDPOINT_KEY = 'api_endpoint';
export const LEGACY_ACTIVE_PROVIDER_KEY = 'active_provider';

/** Backend names. */
export const BACKEND = Object.freeze({
  NATIVE: 'native',
  SESSION: 'session',
  NONE: 'none'
});

export class CredentialBrokerError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CredentialBrokerError';
    this.code = code || 'CREDENTIAL_BROKER_ERROR';
  }
}

function errText(e) {
  if (!e) return 'unknown error';
  if (typeof e === 'string') return e;
  return e.message || String(e);
}

// ========== Record helpers (pure) ==========

/** Build a fresh broker record. */
export function newCredentialRecord(entries = {}) {
  return { v: CREDENTIAL_BROKER_VERSION, keys: Object.assign({}, entries) };
}

/**
 * Coerce an untrusted value into a broker record. Unknown shapes collapse to an
 * empty record rather than throwing, so a corrupt record can never wedge the
 * caller — but it also never fabricates a key.
 */
export function normalizeCredentialRecord(raw) {
  if (!raw || typeof raw !== 'object') return newCredentialRecord();
  const src = raw.keys && typeof raw.keys === 'object' ? raw.keys : {};
  const keys = {};
  for (const id of Object.keys(src)) {
    const v = src[id];
    if (typeof v === 'string') keys[id] = v;
  }
  return newCredentialRecord(keys);
}

/** Trim and validate a provider id. Empty means "not a real provider". */
export function normalizeProviderId(id) {
  return typeof id === 'string' ? id.trim() : '';
}

/** True when a string is a plausible API key (non-empty after trim). */
export function isUsableKey(key) {
  return typeof key === 'string' && key.trim() !== '';
}

/**
 * Pick a provider id for a bare legacy key, using the same endpoint heuristic
 * as provider-registry.migrateLegacySettings. Duplicated on purpose: importing
 * provider-registry here would create a cycle, because provider-registry
 * imports this module.
 */
export function guessProviderId(endpoint) {
  const e = typeof endpoint === 'string' ? endpoint : '';
  if (/api\.anthropic\.com/.test(e)) return 'anthropic';
  if (/z\.ai|api\.z\.ai/.test(e)) return 'zai';
  return 'openai';
}

// ========== Backends ==========

/**
 * The native backend. Returns null when the runtime cannot host native
 * messaging at all, so the caller falls through to `session`.
 */
export function makeNativeBackend(browser) {
  const rt = browser && browser.runtime;
  if (!rt || typeof rt.sendNativeMessage !== 'function') return null;
  return {
    name: BACKEND.NATIVE,
    /** Resolves to the host's reply, or rejects when the host is absent. */
    async send(message) {
      const reply = await rt.sendNativeMessage(BROKER_HOST_NAME, message);
      if (!reply || typeof reply !== 'object') {
        throw new CredentialBrokerError('native host returned no reply', 'NATIVE_NO_REPLY');
      }
      if (reply.ok !== true) {
        throw new CredentialBrokerError(
          errText(reply.error) || 'native host rejected the request',
          'NATIVE_HOST_ERROR'
        );
      }
      return reply;
    }
  };
}

/**
 * The session backend. chrome.storage.session is memory-only: it is never
 * written to disk and is cleared when the browser closes.
 */
export function makeSessionBackend(browser) {
  const area = browser && browser.storage && browser.storage.session;
  if (!area || typeof area.get !== 'function' || typeof area.set !== 'function') return null;
  return {
    name: BACKEND.SESSION,
    async load() {
      const raw = await area.get(SESSION_STORAGE_KEY);
      return normalizeCredentialRecord(raw && raw[SESSION_STORAGE_KEY]);
    },
    async save(record) {
      await area.set({ [SESSION_STORAGE_KEY]: record });
    }
  };
}

/**
 * Probe the backends and return the first that answers. `native` is pinged so a
 * missing or broken host is not mistaken for a working one.
 */
export async function probeBackend(browser) {
  const native = makeNativeBackend(browser);
  if (native) {
    try {
      const pong = await native.send({ cmd: 'ping' });
      if (pong && pong.ok === true) return native;
    } catch (_e) {
      // Host not installed (or not registered for this extension). Fall through.
    }
  }
  return makeSessionBackend(browser);
}

// ========== Broker ==========

/**
 * The broker. Wraps one backend and never lets a key reach a log line.
 *
 * `probe` is injected so tests can pin the backend without a browser.
 */
export class CredentialBroker {
  constructor(probe, log = () => {}) {
    this._probe = typeof probe === 'function' ? probe : () => null;
    this._log = typeof log === 'function' ? log : () => {};
    this._backend = null;
    this._resolved = false;
    // Resolved keys held for the life of this object. The native host is a
    // separate process that Chrome starts per message, so without this every
    // LLM call would pay a process spawn. Invalidated by put/remove/reset.
    this._cache = new Map();
  }

  /** Backend name once resolved: 'native', 'session' or 'none'. */
  get name() {
    return this._backend ? this._backend.name : BACKEND.NONE;
  }

  /** True once a backend has been resolved (even if that resolution was 'none'). */
  get resolved() {
    return this._resolved;
  }

  /** Resolve the backend once. Safe to call repeatedly. */
  async _ensure() {
    if (this._resolved) return this._backend;
    this._backend = await this._probe();
    this._resolved = true;
    return this._backend;
  }

  /** Forget the resolved backend (used by tests and by a host install). */
  reset() {
    this._backend = null;
    this._resolved = false;
    this._cache.clear();
  }

  async _load() {
    const backend = await this._ensure();
    if (!backend) {
      throw new CredentialBrokerError('no credential backend available', 'NO_BACKEND');
    }
    if (typeof backend.load !== 'function') {
      throw new CredentialBrokerError(`backend '${backend.name}' cannot load`, 'BACKEND_NO_LOAD');
    }
    return backend.load();
  }

  async _save(record) {
    const backend = await this._ensure();
    if (!backend || typeof backend.save !== 'function') {
      throw new CredentialBrokerError('no writable credential backend available', 'NO_WRITABLE_BACKEND');
    }
    await backend.save(record);
  }

  /**
   * Read one provider's key. Returns '' when absent — never throws for a missing
   * key, because "not configured yet" is a normal state, not an error.
   */
  async get(providerId) {
    const id = normalizeProviderId(providerId);
    if (!id) return '';
    if (this._cache.has(id)) return this._cache.get(id);
    const backend = await this._ensure();
    if (!backend) return '';
    let key = '';
    try {
      if (backend.name === BACKEND.NATIVE) {
        const reply = await backend.send({ cmd: 'get', provider: id });
        key = typeof reply.key === 'string' ? reply.key : '';
      } else {
        const record = await backend.load();
        key = typeof record.keys[id] === 'string' ? record.keys[id] : '';
      }
    } catch (e) {
      this._log(`credential read failed for '${id}': ${errText(e)}`);
      return '';
    }
    this._cache.set(id, key);
    return key;
  }

  /** Store one provider's key. Throws when no writable backend exists. */
  async put(providerId, key) {
    const id = normalizeProviderId(providerId);
    if (!id) throw new CredentialBrokerError('empty provider id', 'EMPTY_PROVIDER');
    if (!isUsableKey(key)) throw new CredentialBrokerError('empty credential', 'EMPTY_CREDENTIAL');
    const backend = await this._ensure();
    if (!backend) throw new CredentialBrokerError('no credential backend available', 'NO_BACKEND');
    if (backend.name === BACKEND.NATIVE) {
      await backend.send({ cmd: 'put', provider: id, key });
      this._cache.set(id, key);
      return;
    }
    const record = await backend.load();
    record.keys[id] = key;
    await backend.save(record);
    this._cache.set(id, key);
  }

  /** Remove one provider's key. Idempotent. */
  async remove(providerId) {
    const id = normalizeProviderId(providerId);
    if (!id) return;
    const backend = await this._ensure();
    if (!backend) return;
    try {
      if (backend.name === BACKEND.NATIVE) {
        await backend.send({ cmd: 'delete', provider: id });
        this._cache.delete(id);
        return;
      }
      const record = await backend.load();
      if (Object.prototype.hasOwnProperty.call(record.keys, id)) {
        delete record.keys[id];
        await backend.save(record);
      }
    } catch (e) {
      this._log(`credential delete failed for '${id}': ${errText(e)}`);
    }
    this._cache.delete(id);
  }

  /** Provider ids that currently hold a key. Never returns key material. */
  async list() {
    const backend = await this._ensure();
    if (!backend) return [];
    try {
      if (backend.name === BACKEND.NATIVE) {
        const reply = await backend.send({ cmd: 'list' });
        return Array.isArray(reply.providers) ? reply.providers.slice() : [];
      }
      const record = await backend.load();
      return Object.keys(record.keys).filter((k) => record.keys[k] !== '');
    } catch (e) {
      this._log(`credential list failed: ${errText(e)}`);
      return [];
    }
  }
}

// ========== Legacy migration ==========

/**
 * Move any provider key still sitting in chrome.storage.local into the broker,
 * then blank it out of local. Idempotent: re-running it after a successful pass
 * finds nothing to do.
 *
 * Ordering matters. The broker write happens FIRST and must succeed; only then is
 * the local copy blanked. A failure halfway leaves the key in both places, which
 * is a failed migration — never a lost key.
 *
 * Returns { moved, providers } for diagnostics. Never throws: a migration that
 * cannot complete must not stop the extension from starting.
 */
export async function migrateLegacyCredentials(broker, browser, log = () => {}) {
  const local = browser && browser.storage && browser.storage.local;
  if (!local || typeof local.get !== 'function' || typeof local.set !== 'function') {
    log('credential migration skipped: chrome.storage.local unavailable');
    return { moved: 0, providers: [] };
  }

  let stored;
  try {
    stored = await local.get([
      LEGACY_PROVIDERS_KEY,
      LEGACY_API_KEY_KEY,
      LEGACY_ENDPOINT_KEY,
      LEGACY_ACTIVE_PROVIDER_KEY
    ]);
  } catch (e) {
    log(`credential migration read failed: ${errText(e)}`);
    return { moved: 0, providers: [] };
  }

  const moved = [];
  const writes = {};
  const removes = [];

  const providers = stored && stored[LEGACY_PROVIDERS_KEY];
  if (providers && typeof providers === 'object') {
    const nextProviders = Object.assign({}, providers);
    let changed = false;
    for (const id of Object.keys(nextProviders)) {
      const cfg = nextProviders[id];
      if (!cfg || typeof cfg !== 'object') continue;
      const key = cfg.api_key;
      if (!isUsableKey(key)) continue;
      const idNorm = normalizeProviderId(id);
      const have = await broker.get(idNorm);
      if (have === '') {
        try {
          await broker.put(idNorm, key);
        } catch (e) {
          // Leave the local copy in place. A half-done migration is a failed
          // migration, never a lost key.
          log(`credential migration: broker write failed for '${idNorm}' — leaving the local copy in place`);
          continue;
        }
      }
      // The key is in the broker now (or was already). Retire the local copy.
      cfg.api_key = '';
      changed = true;
      moved.push(idNorm);
    }
    // Only touch storage when a key actually moved. Rewriting an unchanged
    // providers object on every run would churn the profile for nothing.
    if (changed) writes[LEGACY_PROVIDERS_KEY] = nextProviders;
  }

  // Legacy top-level single-key layout, from before the per-provider structure.
  const legacyKey = stored && stored[LEGACY_API_KEY_KEY];
  if (isUsableKey(legacyKey)) {
    const active = normalizeProviderId(stored && stored[LEGACY_ACTIVE_PROVIDER_KEY]);
    const id = active || guessProviderId(stored && stored[LEGACY_ENDPOINT_KEY]);
    const have = await broker.get(id);
    if (have === '') {
      try {
        await broker.put(id, legacyKey);
      } catch (e) {
        log(`credential migration: broker write failed for '${id}' — leaving the local copy in place`);
        return _finishMigration(local, writes, removes, moved, log);
      }
      if ((await broker.get(id)) === '') {
        return _finishMigration(local, writes, removes, moved, log);
      }
    }
    removes.push(LEGACY_API_KEY_KEY);
    moved.push(id);
  }

  return _finishMigration(local, writes, removes, moved, log);
}

/**
 * Persist the retired local copies. A failed write-back is logged, not thrown:
 * the keys are already safe in the broker, and the next startup retries.
 */
async function _finishMigration(local, writes, removes, moved, log) {
  try {
    if (Object.keys(writes).length > 0) await local.set(writes);
    if (removes.length > 0) await local.remove(removes);
  } catch (e) {
    log(`credential migration write-back failed: ${errText(e)}`);
  }
  if (moved.length > 0) {
    log(`credential migration moved ${moved.length} provider key(s) out of chrome.storage.local: ${moved.join(', ')}`);
  }
  return { moved: moved.length, providers: moved };
}

// ========== Runtime singleton ==========

let _singleton = null;

/**
 * Read one provider's key from the broker, falling back to a value that is
 * still sitting in chrome.storage.local. The fallback is what makes the broker
 * additive: a profile that predates it, or a machine where the native host is
 * not installed, keeps working exactly as before.
 */
export async function readProviderKey(broker, providerId, fallback = '') {
  const key = await broker.get(providerId);
  return key || fallback;
}

/**
 * The extension-wide broker. Lazily constructed so importing this module never
 * touches chrome.*, which keeps the jest harness free of browser mocks.
 */
export function getCredentialBroker() {
  if (_singleton) return _singleton;
  const g = globalThis;
  const browser = g.browser || g.chrome;
  _singleton = new CredentialBroker(() => probeBackend(browser));
  return _singleton;
}
