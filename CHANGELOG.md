# Changelog

## v22.3.0 — 2026-10-23 (Credential Broker — keys leave the browser profile)

Provider API keys no longer live in `chrome.storage.local`. This entry covers the
native messaging host, the JS broker, the write-path and migration wiring, the
installer, and Firefox parity.

(Chrome history note: v22.2.0 was published on the Firefox tree only, as the Run
Guard release. Both trees now carry the same feature set under one number.)

### The problem

`chrome.storage.local` is plaintext on disk. It survives every restart, it is
uploaded to the vendor cloud by `chrome.storage.sync`, and it is readable by any
code running in the extension's own service-worker context. Every provider key
the extension had ever accepted was sitting there in the clear.

### The native host

**`native-host/sentinel_broker.py`** (new) speaks the Chrome/Firefox native
messaging protocol — a 4-byte native-endian length prefix followed by UTF-8
JSON — and stores keys OUTSIDE the browser profile, under `~/.sentinel/`.

Backends, in order:

1. **OS keychain** — libsecret through `secret-tool` on Linux, the `security`
   CLI on macOS, DPAPI through ctypes on Windows.
2. **Encrypted file** — AES-256-GCM when `cryptography` is importable, otherwise
   an HMAC-SHA256 keystream with encrypt-then-MAC. Mode 0600.

The file backend is defence in depth, not a boundary: the machine key sits
beside the ciphertext, so anything that can read one can read the other. Its
real value is that the secret leaves the profile entirely and that it works on
machines with no keychain daemon — headless hosts, containers, minimal installs.
The keychain backend is the one to prefer. The module header states this
plainly rather than overselling it as a security boundary.

The host never writes a key to stdout, stderr or the system log, and replies
carry a key only when the extension asked for exactly one. `--self-test`
exercises the store in-process against a throwaway HOME and exits non-zero on
the first failure; the installer runs it before registering anything.

### The broker

**`background/credential-broker.js`** (new, 17 KB) is the in-extension half. It
probes the native backend first, then falls back to `chrome.storage.session`
(memory-only, cleared on browser close). `get()` returns `''` rather than
throwing for a missing key or a missing backend, because "not configured yet"
is a normal state and the call sites have a legacy fallback. `put()` does throw
when nothing writable exists — the caller must decide, not the broker.

The backend is resolved once and cached, and resolved keys are cached for the
life of the module instance. Without that, every LLM call would pay a process
spawn for a separate Python interpreter.

The broker is self-contained by design: importing `provider-registry` from it
would create a cycle, because `provider-registry` imports it. The one thing they
both need — the endpoint-to-provider-id heuristic — is duplicated locally with
a comment saying why.

### Wiring

- **`background/provider-registry.js`** — `getActiveProvider()` resolves the key
  from the broker before the SO-83 unconfigured-provider check. That ordering is
  load-bearing: `p.api_key` is blank once the broker holds it, so testing the
  field instead of the resolved key would make every configured provider look
  unconfigured and silently reroute it to the keyless local lane.
- **`popup-modules/settings.js`** — the key field shows a fixed placeholder and
  never a secret. `resolveKeyForRequest()` swaps the placeholder for the stored
  key at the moment of use, so Test Connection sends the real credential rather
  than the placeholder. `persistProviderConfig()` writes to the broker first and
  blanks the local copy, falling back to the legacy local copy when the broker is
  unavailable — a configuration the user just verified is never lost.
- **`migrateLegacySettings()`** — the credential migration runs BEFORE its early
  returns. Placing it after would have meant that profiles which already had the
  per-provider structure never moved their keys.

### The migration is not a lost-key path

`migrateLegacyCredentials()` moves a key only once the broker has accepted it,
and leaves the local copy untouched when the write fails. It rewrites the
providers object only when something actually moved — an earlier version rewrote
it on every run, churning the profile for nothing.

### Installer

**`native-host/install_host.py`** (new) writes the host to a stable
`~/.sentinel/bin/` and registers a manifest per browser: seven Chrome-family
directories on Linux plus Firefox's `native-messaging-hosts`. It derives the
Chrome id from the unpacked path, so a development install can be registered
without publishing anything.

Two defects were found by running it against a sandboxed HOME and are fixed:
bare `--uninstall` (documented usage) demanded an extension id it never used and
exited 1; and uninstall left the now-empty browser manifest directories behind.
Uninstall now works with no arguments and prunes what it created. The encrypted
store is deliberately NOT deleted — it holds the user's keys, not the
installer's state — and the uninstaller says where it is so the choice stays
theirs.

### Firefox parity

The broker, the wiring and the native-host payload are byte-identical in both
trees, and `nativeMessaging` is in both manifests. `compat/webext-shim.js`
already aliases `runtime` and `storage`, and Firefox's `sendNativeMessage`
returns a Promise, so the same code runs unmodified. Verified by loading the
addon in a real headless Firefox: `web-ext lint` reports 0 errors and no new
warnings, and a deliberately broken module graph produces nine uncaught
exceptions where the real addon produces none.

### Verification

`tests/credential-broker.test.js` (62 tests) covers every backend, the cache,
the migration paths and the fail-closed rule. The host was verified directly on
nuke-standby over the real wire protocol: install, self-test, ping/put/get/list/
delete round-trip, no key material in `list`, no plaintext key anywhere in HOME,
and a clean uninstall. Full suite: 10358 passing, 0 failing; lint 0 errors.

## v22.2.0 — 2026-10-23 (Run Guard, Console-Noise Fix, Shim Sync)

This is the first changelog entry for the Firefox tree. It covers the Phase 0.5
run guard, the startup console-noise fix, and the compat shim sync that makes the
two trees byte-identical in `compat/`.

### Run Guard (Phase 0.5) — persisted kill switch, enforced spend budget, durable rate limit

Three holes were verified in the pre-Phase-0.5 tree and are now closed:

1. **No kill switch.** Stopping a run only cleared in-memory state
   (`cancelActiveLLM` → `STOPPED_BY_USER`). `sw-watchdog.js` `evaluateTick()`
   returns `resume` for an orphaned run, and the in-memory `agentRunning` flag is
   lost when the background script is torn down — so a restart resurrected a run
   the operator had explicitly stopped, with nothing left to refuse it.
2. **The budget gate failed open.** `check_credit_limit` returned
   `{allowed:true}` from its own catch block, and both call sites — `callLLM` in
   `llm-client.js` and the run loop in `agent-engine.js` — wrapped the probe in
   try/catch and continued on error. A failed probe therefore meant "spend anyway".
   The gate was advisory in the only two places it ran.
3. **Rate limits were in-memory only.** `_rateLimiter` (`llm-client.js`) and
   `endpointBreaker` (`endpoint-breaker.js`) are module singletons, so a background
   restart wiped both the sliding call window and the endpoint cooldown. The
   cooldown is exactly what stops a restart loop from hammering a dead endpoint —
   and it did not survive the restart that would trigger the loop.

**`background/run-guard.js`** (new, 471 lines) is the single persisted source of
truth: a kill switch, a UTC-day spend budget (`dailyCostUsd` / `dailyCalls`), a
sliding-window rate limit, and a 7-day ledger. It is pure decision functions
unit-tested against a fixed clock, plus a thin injected-IO executor — no `chrome.*`
is touched at module scope, so the jest suite exercises the decisions directly
without a browser.

Enforcement points:

- **`background/agent-engine.js`** — `startAgent()` checks the guard before creating
  any task; the run loop re-checks every step.
- **`background/llm-client.js`** — `callLLM()` blocks before the API call and charges
  the ledger after; `callLLMSimple()` (Quick Assist + the nested semantic find) is
  now guarded too, where it previously had no guard, no rate limit and no breaker,
  so it could spend outside the budget entirely.
- **`background/index.js`** — `record_credit_usage` / `check_credit_limit` delegate
  to the guard, so there is one ledger instead of two that can drift apart;
  `check_credit_limit` now **fails closed**.
- **`background/sw-watchdog.js`** — `evaluateTick()` takes `killEngaged` and returns
  `clear_stale_flags` instead of `resume` when the switch is on.

**Scope, stated honestly:** `chrome.storage` is plaintext and writable by any
background-context code, so this is a **safety device, not a security boundary**.
It stops a buggy or looping agent from spending unbounded money and stops a
stopped run from resurrecting. It does not stop an attacker who can already write
`chrome.storage` — that is what Phase 0.2 (the native-messaging credential broker)
is for.

**Fail-closed rule (decided and documented in code):** a storage API that is
*absent* → allow (nothing to enforce); a storage API that is *present but
erroring* → block. This is the only fail-open path and does not occur in a real
extension context.

### Popup — Run Guard card
New Settings card (`popup.html` + `popup-modules/settings.js`): live guard status,
daily-call and rate-limit inputs, an **Engage kill switch** button, and Reset guard
state. The old credit UI now reads the guard ledger rather than a second counter.

### Startup console-noise fix (SO-93 follow-up)
`initScheduler()` emitted two telemetry broadcasts at startup through
`chrome.runtime.sendMessage(event).catch(() => {})`. Firefox reports the rejection
at the moment it is *created*, so `.catch()` cannot silence it — the browser
console filled with `uncaught exception` lines whenever the panel was closed.

Fix: `installBroadcastGuard()` in `compat/webext-shim.js` tracks live receivers
via `runtime.onConnect` and resolves `undefined` (setting `chrome.runtime.lastError`
for the callback form) when the set is empty, so no rejection object is ever
created. `popup-full.js` opens a named port to register the panel document as a
receiver. The port is a **liveness beacon, not a data channel** — nothing is posted
through it; real broadcasts pass through to the native `sendMessage` unchanged
whenever a receiver is alive.

The port is opened based on the **manifest**, not a global marker. That matters
because the popup and the background are separate documents with separate global
scopes: an earlier revision gated the port on `globalThis.__sentinelBroadcastGuard`,
which the shim sets only in the background context (it is loaded solely by
`compat/firefox-entry.js`), so the marker was never visible to the popup and the
port never opened. The background then saw zero receivers and suppressed *every*
broadcast — silently killing the telemetry panel and the chat status ticker while
the console stayed quiet, which is how a real regression shipped past a green
"0 uncaught exceptions" verification run. `Array.isArray(manifest.background.scripts)`
is synchronous and in-context, so it cannot be defeated by the split scope.

Because the guard's effect is invisible from outside — a suppressed broadcast and
a delivered one both produce a quiet console — the shim now also writes a
`sentinel_receiver_diag` record (`connect`/`disconnect`, receiver count,
timestamp) on every port event, so "is the panel actually registering?" is
answerable from the profile without a debugger.

Verified on `nuke-standy`: 4/4 runs, 0 uncaught exceptions (baseline ~78% per
run). Extension storage IDB confirmed the extension actually executed
(`approvalMode`, `sentinel_schedules`). A follow-up probe opened the panel
document and read the diagnostic back out of the profile: `event: connect` with a
non-empty receiver set — the exact condition the guard requires to pass
broadcasts through.

### compat shim sync
`compat/webext-shim.js` is now byte-identical to the Chrome tree's copy (verified
with `cmp`), along with `compat/content-shim.js`. The two trees had diverged; the
Firefox copy carried callback support, the broadcast guard, the H-1/H-2
`tabs.onRemoved` leak fix, the `tabGroups` stub, and the
`getPanelOptions` → `getOptions` rename, while Chrome's copy had fallen behind
Chrome's own `background/index.js`.

- Version bumped to **22.2.0** in `manifest.json`.
- The Firefox tree ships no jest suite of its own; the guard decisions are covered
  by the Chrome tree's `tests/run-guard.test.js` (472 lines), and the shim by
  `tests/firefox-compat.test.js` (21/21 green, including six broadcast-guard
  tests). Full Chrome suite: **235 suites / 10291 tests passing**, lint clean.
