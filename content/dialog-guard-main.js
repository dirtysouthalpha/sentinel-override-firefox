// content/dialog-guard-main.js
//
// (2.7 content lane) MAIN-world JS dialog guard for browsers without
// chrome.debugger (Firefox). Registered as a MAIN-world content script at
// document_start in every frame. Pairs with content/dialog-guard-bridge.js.
//
// Inert until the isolated-world bridge arms it, which happens only while an
// agent run owns this tab. While armed:
//   alert()   -> not shown, reported, returns undefined (accepted)
//   confirm() -> not shown, reported, returns false     (dismissed)
//   prompt()  -> not shown, reported, returns null      (dismissed)
// These calls block, so the answer has to be synchronous; this is the CDP
// lane's no-decision policy (alert accepted, never auto-accept the rest).
// beforeunload prompts are only reported: the browser still shows its own
// prompt, because answering it from here would mean leaving the page.
//
// This file runs in the page's world, so the page can see and tamper with
// it. That is fine: a page can only change how its own dialogs behave, and
// the bridge treats every report as untrusted input.
(function (w) {
  'use strict';
  if (!w || typeof w.addEventListener !== 'function') return;
  try {
    if (w.__soDialogGuard) return;
    Object.defineProperty(w, '__soDialogGuard', { value: true });
  } catch (_e) { return; }

  var REPORT_EVENT = '__so_dialog_report';
  var ARM_EVENT = '__so_dialog_arm';
  var MAX_MESSAGE = 300;
  var CE = w.CustomEvent;
  var dispatch = w.dispatchEvent;
  var stringify = JSON.stringify;
  var reportedUnloads = typeof WeakSet === 'function' ? new WeakSet() : null;
  var armed = false;

  function report(type, message) {
    try {
      var m = message == null ? '' : String(message);
      if (m.length > MAX_MESSAGE) m = m.slice(0, MAX_MESSAGE);
      dispatch.call(w, new CE(REPORT_EVENT, { detail: stringify({ v: 1, type: type, message: m }) }));
    } catch (_e) { /* never break the page */ }
  }

  w.addEventListener(ARM_EVENT, function (ev) { armed = !!ev && ev.detail === '1'; });

  function wrap(name, answer) {
    var orig = w[name];
    if (typeof orig !== 'function') return;
    var guarded = function (message) {
      if (!armed) return orig.apply(w, arguments);
      report(name, message);
      return answer;
    };
    try {
      Object.defineProperty(w, name, { value: guarded, writable: true, configurable: true, enumerable: true });
    } catch (_e) {
      try { w[name] = guarded; } catch (_e2) { /* leave native */ }
    }
  }
  wrap('alert', undefined);
  wrap('confirm', false);
  wrap('prompt', null);

  function reportUnload(ev) {
    if (!armed) return;
    if (reportedUnloads && ev && typeof ev === 'object') {
      if (reportedUnloads.has(ev)) return;
      reportedUnloads.add(ev);
    }
    report('beforeunload', '');
  }

  // addEventListener('beforeunload') handlers: this listener is added at
  // document_start, before any page listener, so it can watch the event's
  // preventDefault() and returnValue for the ones that run after it.
  w.addEventListener('beforeunload', function (ev) {
    if (!armed || !ev) return;
    try {
      var pd = ev.preventDefault;
      Object.defineProperty(ev, 'preventDefault', {
        configurable: true,
        value: function () { reportUnload(ev); return pd.apply(ev, arguments); },
      });
      var proto = ev, d = null;
      while (proto && !(d = Object.getOwnPropertyDescriptor(proto, 'returnValue'))) proto = Object.getPrototypeOf(proto);
      if (d && d.get && d.set) {
        Object.defineProperty(ev, 'returnValue', {
          configurable: true,
          get: function () { return d.get.call(ev); },
          set: function (v) { if (v) reportUnload(ev); d.set.call(ev, v); },
        });
      }
    } catch (_e) { /* event not instrumentable; property handlers are still seen */ }
  }, true);

  // window.onbeforeunload = fn: wrap the handler so a returned string is seen.
  try {
    var holder = w, desc = null;
    while (holder && !(desc = Object.getOwnPropertyDescriptor(holder, 'onbeforeunload'))) holder = Object.getPrototypeOf(holder);
    if (desc && desc.set && desc.get && desc.configurable !== false) {
      var userHandler = null;
      Object.defineProperty(w, 'onbeforeunload', {
        configurable: true,
        enumerable: true,
        get: function () { return userHandler; },
        set: function (fn) {
          userHandler = typeof fn === 'function' ? fn : null;
          desc.set.call(w, userHandler ? function (ev) {
            var r = userHandler.apply(this, arguments);
            if (r !== undefined && r !== null && r !== false) reportUnload(ev);
            return r;
          } : null);
        },
      });
    }
  } catch (_e) { /* leave native */ }
})(typeof window !== 'undefined' ? window : undefined);
