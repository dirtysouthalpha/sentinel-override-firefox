// Sentinel Override v20.1 — Warm-Scan Sensor (Claude-in-Chrome parity upgrade)
// Injected at document_start (ISOLATED world, all frames). Pre-builds the
// interactive-element snapshot BEFORE the agent ever asks for it, so
// observe_page reads a warm cache instead of cold-scanning with SPA retries.
//
// Design notes:
//   - Claude in Chrome injects a 6.8KB a11y-tree pre-builder at document_start.
//     This is the same idea, adapted to SO's scanDocument pipeline.
//   - Cache lives on window.__sentinelWarmScan (per frame). content/index.js
//     reads it in observe_page; a DOM mutation observer + SPA URL watcher
//     invalidate it so the cache never goes stale.
//   - Ref stability: the cache stores element snapshots WITHOUT ref ids.
//     Refs are assigned by dom-utils at observe time (scan-local, WeakRef).
//     The warm cache keeps raw element references in a WeakRef list so the
//     expensive visibility/label/selector work is reused, not the ref ids.
//   - Zero dependencies on other SO utils at document_start time: this file
//     must load before dom-utils.js exists. It re-implements a minimal
//     "is probably interactive" selector test. When __sentinelUtils.dom IS
//     present (programmatic injection path) it defers to the real
//     scanDocument for parity, falling back to the built-in test otherwise.
//   - Never throws: every entry point is try/catch-wrapped. A broken warm
//     cache must degrade to today's cold-scan behavior, nothing more.

(function () {
  'use strict';
  if (window.__sentinelWarmScan) return; // idempotent re-injection

  var VERSION = '20.1.0';

  // ---- Minimal interactive-element test (document_start, no deps) ----
  var INTERACTIVE_SELECTOR = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
    '[role="tab"]', '[role="menuitem"]', '[role="option"]', '[role="switch"]',
    '[role="textbox"]', '[role="combobox"]', '[role="searchbox"]',
    '[onclick]', '[tabindex]:not([tabindex="-1"])',
    'label[for]'
  ].join(',');

  var MUTATION_DEBOUNCE_MS = 300;
  var MAX_WARM_ELEMENTS = 500;          // hard cap — warm cache is a hint, not the index
  var MAX_TREE_WALK_NODES = 20000;      // walk guard for pathological pages

  var state = {
    snapshot: null,        // { url, title, readyState, capturedAt, count, source }
    elements: null,        // Array<{ el: WeakRef, selectorHint: string, text: string, tag, role, type, ariaLabel, elementId }>
    invalid: true,
    scanCount: 0,          // diagnostics: how many warm scans we ran
    hitCount: 0,           // diagnostics: how many observe_page reads found a valid cache
    lastScanMs: 0
  };

  var mutationTimer = null;
  var lastUrl = null;

  function now() { return Date.now(); }

  function isVisible(el) {
    try {
      var style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
    } catch (_e) { /* assume visible */ }
    return true;
  }

  function cssSelectorHint(el) {
    // Cheap hint only — the authoritative selector is built by dom-utils at
    // observe time. This exists so the warm cache can be diffed/debugged.
    try {
      if (el.id) return '#' + el.id;
      var name = el.tagName ? el.tagName.toLowerCase() : 'el';
      if (el.getAttribute && el.getAttribute('name')) return name + '[name="' + el.getAttribute('name') + '"]';
      return name;
    } catch (_e) { return 'el'; }
  }

  function textOf(el) {
    try {
      var t = (el.innerText || el.textContent || '');
      return t.replace(/\s+/g, ' ').trim().substring(0, 100);
    } catch (_e) { return ''; }
  }

  // ---- The warm scan itself ----
  function runScan() {
    var t0 = now();
    var doc = document;
    var out = [];
    var seen = new Set();
    var walked = 0;
    try {
      var candidates = doc.querySelectorAll(INTERACTIVE_SELECTOR);
      var len = candidates.length;
      for (var i = 0; i < len && out.length < MAX_WARM_ELEMENTS && walked < MAX_TREE_WALK_NODES; i++) {
        walked++;
        var el = candidates[i];
        if (!el || seen.has(el)) continue;
        seen.add(el);
        if (!isVisible(el)) continue;
        out.push({
          el: (typeof WeakRef === 'function') ? new WeakRef(el) : { deref: function () { return el; } },
          selectorHint: cssSelectorHint(el),
          text: textOf(el),
          tag: el.tagName || '',
          role: (el.getAttribute && el.getAttribute('role')) || '',
          type: (el.getAttribute && el.getAttribute('type')) || '',
          ariaLabel: (el.getAttribute && el.getAttribute('aria-label')) || '',
          elementId: el.id || ''
        });
      }
      state.elements = out;
      state.snapshot = {
        url: location.href,
        title: doc.title || '',
        readyState: doc.readyState,
        capturedAt: now(),
        count: out.length,
        source: 'warm-scan',
        version: VERSION
      };
      state.invalid = false;
      state.scanCount++;
      state.lastScanMs = now() - t0;
    } catch (_e) {
      // Any scan failure leaves the cache invalid; observe_page falls back
      // to the normal cold scan. Never break the page.
      state.invalid = true;
    }
  }

  function invalidate() {
    state.invalid = true;
  }

  function scheduleRescan() {
    if (mutationTimer) clearTimeout(mutationTimer);
    mutationTimer = setTimeout(function () {
      mutationTimer = null;
      runScan();
    }, MUTATION_DEBOUNCE_MS);
  }

  // ---- Public API on window.__sentinelWarmScan ----
  var api = {
    version: VERSION,

    /** Read the warm cache. Returns null when invalid/absent so the caller
     *  falls back to its normal cold scan. Never throws. */
    read: function () {
      try {
        if (state.invalid || !state.elements || !state.snapshot) return null;
        // URL changed without a SPA event firing? Treat as invalid.
        if (state.snapshot.url !== location.href) return null;
        state.hitCount++;
        var live = [];
        for (var i = 0; i < state.elements.length; i++) {
          var entry = state.elements[i];
          var el = entry.el && typeof entry.el.deref === 'function' ? entry.el.deref() : null;
          if (el && el.isConnected) live.push({ ref: entry.el, meta: entry });
        }
        return {
          snapshot: state.snapshot,
          elements: live,
          fresh: (now() - state.snapshot.capturedAt) < 2000
        };
      } catch (_e) {
        return null;
      }
    },

    /** Force a synchronous rescan (used by observe_page when cache is cold). */
    scan: function () {
      runScan();
      return state.invalid ? null : state.snapshot;
    },

    invalidate: invalidate,

    /** Diagnostics for tests + the popup debug view. */
    stats: function () {
      return {
        version: VERSION,
        invalid: state.invalid,
        count: state.elements ? state.elements.length : 0,
        scanCount: state.scanCount,
        hitCount: state.hitCount,
        lastScanMs: state.lastScanMs,
        url: state.snapshot ? state.snapshot.url : null
      };
    }
  };

  window.__sentinelWarmScan = api;

  // ---- Lifecycle wiring ----
  function boot() {
    runScan();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    // document_start scripts normally see 'loading', but programmatic
    // injection (tab-manager) can land after load — scan immediately.
    boot();
  }

  try {
    var observer = new MutationObserver(function (muts) {
      // Only meaningful mutations trigger a rescan. Text tweaks don't.
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === 'childList' && (m.addedNodes.length || m.removedNodes.length)) {
          invalidate();
          scheduleRescan();
          return;
        }
        if (m.type === 'attributes' && m.target && m.target.getAttribute) {
          var a = m.attributeName;
          if (a === 'style' || a === 'class' || a === 'hidden' || a === 'disabled' || a === 'aria-hidden') {
            invalidate();
            scheduleRescan();
            return;
          }
        }
      }
    });
    // Observe once DOM exists; document_start may be too early for documentElement.
    function attachObserver() {
      try {
        observer.observe(document.documentElement || document, {
          childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'disabled', 'aria-hidden']
        });
      } catch (_e) { /* non-fatal: cache just goes cold on demand */ }
    }
    if (document.documentElement) attachObserver();
    else document.addEventListener('DOMContentLoaded', attachObserver, { once: true });
  } catch (_e) { /* MutationObserver unavailable — cold scan remains the fallback */ }

  // SPA URL watcher: invalidate (and debounce-rescan) on pushState/replaceState.
  try {
    var _push = history.pushState;
    if (typeof _push === 'function') {
      history.pushState = function () {
        var r = _push.apply(this, arguments);
        invalidate();
        scheduleRescan();
        return r;
      };
    }
    var _replace = history.replaceState;
    if (typeof _replace === 'function') {
      history.replaceState = function () {
        var r = _replace.apply(this, arguments);
        invalidate();
        scheduleRescan();
        return r;
      };
    }
    window.addEventListener('popstate', function () {
      invalidate();
      scheduleRescan();
    });
    window.addEventListener('hashchange', function () {
      invalidate();
      scheduleRescan();
    });
  } catch (_e) { /* non-fatal */ }

  // Cleanup on unload so timers die with the page.
  window.addEventListener('beforeunload', function () {
    if (mutationTimer) { clearTimeout(mutationTimer); mutationTimer = null; }
  });
})();
