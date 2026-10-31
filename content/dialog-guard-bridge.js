// content/dialog-guard-bridge.js
//
// (2.7 content lane) Isolated-world bridge between content/dialog-guard-main.js
// and background/event-watchdogs.js, for browsers without chrome.debugger
// (Firefox). Registered at document_start in every frame.
//
// - Opens a runtime Port named 'so-page-watch'. The background uses it to arm
//   the MAIN-world guard while a run owns the tab, to ping the page
//   (heartbeat), and to notice the page dying (Port drop with no navigation).
// - Forwards the guard's dialog reports. They come from the page's world, so
//   they are untrusted: the detail must be a short JSON string with exactly
//   {v:1, type, message}, type must be a dialog type, the message is clipped,
//   and reports are rate limited. Only a {type:'dialog'} Port message can
//   result; tab, frame and origin are taken from port.sender by the background.
// - Forwards nothing while unarmed (no active run on this tab).
// - Exits at once when the manifest has the debugger permission: that browser
//   answers dialogs over CDP.
(function (w, ext) {
  'use strict';
  var rt = ext && ext.runtime;
  if (!w || !rt || typeof rt.connect !== 'function' || typeof w.addEventListener !== 'function') return;
  try {
    var manifest = typeof rt.getManifest === 'function' ? rt.getManifest() : null;
    if (manifest && Array.isArray(manifest.permissions) && manifest.permissions.indexOf('debugger') !== -1) return;
  } catch (_e) { /* assume no debugger */ }
  if (w.__soPageWatchBridge) return; // isolated-world expando, invisible to the page
  w.__soPageWatchBridge = true;

  var PORT_NAME = 'so-page-watch';
  var CONNECT_MSG = 'so_page_watch_connect';
  var REPORT_EVENT = '__so_dialog_report';
  var ARM_EVENT = '__so_dialog_arm';
  var MAX_DETAIL = 2048;
  var MAX_MESSAGE = 300;
  var RATE_WINDOW_MS = 5000;
  var RATE_MAX = 10;
  var TYPES = { alert: true, confirm: true, prompt: true, beforeunload: true };
  var KEYS = { v: true, type: true, message: true };
  var has = Object.prototype.hasOwnProperty;

  var port = null;
  var armed = false;
  var sent = [];

  function setArmed(on) {
    armed = on === true;
    try { w.dispatchEvent(new w.CustomEvent(ARM_EVENT, { detail: armed ? '1' : '0' })); } catch (_e) { /* page gone */ }
  }

  function parseReport(detail) {
    if (typeof detail !== 'string' || !detail || detail.length > MAX_DETAIL) return null;
    var o;
    try { o = JSON.parse(detail); } catch (_e) { return null; }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    for (var k in o) if (has.call(o, k) && !has.call(KEYS, k)) return null;
    if (o.v !== 1 || typeof o.type !== 'string' || !has.call(TYPES, o.type)) return null;
    if (o.message !== undefined && typeof o.message !== 'string') return null;
    return { type: o.type, message: (o.message || '').slice(0, MAX_MESSAGE) };
  }

  function connect() {
    if (port) return;
    var p;
    try { p = rt.connect({ name: PORT_NAME }); } catch (_e) { return; }
    if (!p) return;
    port = p;
    p.onMessage.addListener(function (msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'ping') {
        try { p.postMessage({ type: 'pong', seq: msg.seq }); } catch (_e) { /* disconnected */ }
      } else if (msg.type === 'arm') {
        setArmed(msg.armed === true);
      }
    });
    p.onDisconnect.addListener(function () {
      void rt.lastError; // read it so Chrome does not log an unchecked error
      if (port === p) port = null;
      setArmed(false);
    });
  }

  w.addEventListener(REPORT_EVENT, function (ev) {
    if (!armed || !port) return;
    var r = parseReport(ev && ev.detail);
    if (!r) return;
    var t = Date.now();
    sent = sent.filter(function (x) { return t - x < RATE_WINDOW_MS; });
    if (sent.length >= RATE_MAX) return;
    sent.push(t);
    try { port.postMessage({ type: 'dialog', dialogType: r.type, message: r.message }); } catch (_e) { /* disconnected */ }
  });

  if (rt.onMessage && typeof rt.onMessage.addListener === 'function') {
    rt.onMessage.addListener(function (msg) {
      if (msg && msg.type === CONNECT_MSG) connect();
    });
  }
  connect();
})(typeof window !== 'undefined' ? window : undefined, typeof chrome !== 'undefined' ? chrome : undefined);
