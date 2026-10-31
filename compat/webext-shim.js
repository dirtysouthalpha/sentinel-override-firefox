// SO-93 — Firefox compatibility shim (background).
// Firefox MV3 = event page (background.scripts), and has no chrome.debugger,
// no chrome.sidePanel, no chrome.tabGroups. This module:
//   1. aliases every real chrome.* namespace onto browser.* (native promises),
//   2. installs a chrome.debugger FAKE that translates the CDP commands
//      Sentinel actually uses into the proven content-script DOM-dispatch
//      actions (click_at / double_click_at / triple_click_at / drag_at /
//      so_scroll_element_at / execute_js), with Page.captureScreenshot via
//      tabs.captureVisibleTab,
//   3. installs a chrome.sidePanel FAKE mapped onto sidebarAction with SO-91
//      semantics degraded per-window: the sidebar opens when the ACTIVE tab is
//      panel-enabled and closes when it is not,
//   4. stubs chrome.tabGroups.
// Loaded FIRST by compat/firefox-entry.js, before background/index.js — ESM
// evaluation order guarantees the shim is in place before any background
// module touches chrome.*.

const REAL_NAMESPACES = [
  'alarms', 'action', 'commands', 'contextMenus', 'downloads',
  'notifications', 'runtime', 'scripting', 'storage', 'tabs',
  'webNavigation', 'windows'
];

// CDP drag threshold (px): pressed→released farther apart than this is a drag.
const DRAG_THRESHOLD_PX = 8;

export function makeFakeDebugger(browser) {
  const attached = new Set();          // tabIds we "attached" to
  const pendingPress = new Map();      // tabId -> {x, y, button, clickCount}
  const lastMove = new Map();          // tabId -> {x, y}

  // H-1/H-2: Clean up pending press/move state when tabs are closed to prevent memory leaks.
  browser.tabs.onRemoved.addListener((tabId) => {
    pendingPress.delete(tabId);
    lastMove.delete(tabId);
  });

  async function executeCommand(tabId, command) {
    // Content-script vocabulary: {action:'execute_command', command:{type,...}}.
    return browser.tabs.sendMessage(tabId, { action: 'execute_command', command });
  }

  async function dispatchMouse(tabId, params) {
    const type = params.type;
    const x = Number(params.x) || 0;
    const y = Number(params.y) || 0;
    const button = params.button || 'left';
    const clickCount = Number(params.clickCount) || 1;

    if (type === 'mouseWheel') {
      return browser.tabs.sendMessage(tabId, {
        action: 'so_scroll_element_at',
        x, y,
        deltaX: Number(params.deltaX) || 0,
        deltaY: Number(params.deltaY) || 0
      });
    }
    if (type === 'mousePressed') {
      pendingPress.set(tabId, { x, y, button, clickCount });
      lastMove.delete(tabId);
      return {};
    }
    if (type === 'mouseMoved') {
      if (pendingPress.has(tabId)) lastMove.set(tabId, { x, y });
      // Bare moves (no active press) are cosmetic in the CDP path — no-op.
      return {};
    }
    if (type === 'mouseReleased' || type === 'mouseClicked') {
      const press = pendingPress.get(tabId);
      pendingPress.delete(tabId);
      if (!press) return {};
      const move = lastMove.get(tabId);
      lastMove.delete(tabId);
      if (move) {
        const dx = move.x - press.x, dy = move.y - press.y;
        if (Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD_PX) {
          return executeCommand(tabId, {
            type: 'drag_at',
            x1: press.x, y1: press.y, x2: move.x, y2: move.y
          });
        }
      }
      const cc = clickCount >= 3 ? 3 : clickCount === 2 ? 2 : 1;
      const type2 = cc === 3 ? 'triple_click_at' : cc === 2 ? 'double_click_at' : 'click_at';
      return executeCommand(tabId, { type: type2, x: press.x, y: press.y, button: press.button });
    }
    throw new Error('[SO-93] Input.dispatchMouseEvent type not supported on Firefox: ' + type);
  }

  async function insertText(tabId, text) {
    // The CDP path types into the element focused by the preceding trusted
    // click. Firefox quirk: execCommand('insertText') silently no-ops on
    // plain <input>/<textarea>, so use the native value setter. CDP
    // Input.insertText semantics are INSERT at the caret — so APPEND to the
    // current value, never replace: the per-char dispatchKeyEvent path calls
    // this once per character. approvalGranted + _shimInternal mark this as
    // trusted internal shim code (fixed string, no user code) so the content
    // script's execute_js approval round-trip and Proxy sandbox are skipped —
    // the same stamp the agent engine sets on engine-dispatched code.
    const code = '(function(){var el=document.activeElement;'
      + 'if(!el||(!/(INPUT|TEXTAREA)/.test(el.tagName)&&!el.isContentEditable)){return "no focused editable";}'
      + 'var t=' + JSON.stringify(String(text)) + ';'
      + 'if(el.isContentEditable){document.execCommand("insertText",false,t);return "ok";}'
      + 'var proto=/TEXTAREA/.test(el.tagName)?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;'
      + 'var d=Object.getOwnPropertyDescriptor(proto,"value");'
      + 'var cur=el.value||"";'
      + 'if(d&&d.set){d.set.call(el,cur+t);}else{el.value=cur+t;}'
      + 'el.dispatchEvent(new Event("input",{bubbles:true,cancelable:true}));'
      + 'el.dispatchEvent(new Event("change",{bubbles:true}));'
      + 'return "ok";})()';
    return executeCommand(tabId, { type: 'execute_js', code, noStore: true, approvalGranted: true, _shimInternal: true });
  }

  return {
    attach: async (target) => { attached.add(target && target.tabId); return {}; },
    detach: async (target) => { attached.delete(target && target.tabId); return {}; },
    getTargets: async () => [...attached].map((tabId) => ({ tabId, attached: true })),
    // (2.7) This fake never emits CDP events (no JS dialog or crash events), so
    // background/event-watchdogs.js must use its content-script lane instead.
    emitsEvents: false,
    onEvent: { addListener() {}, removeListener() {}, hasListener: () => false },
    onDetach: { addListener() {}, removeListener() {}, hasListener: () => false },
    sendCommand: async (target, method, params) => {
      const tabId = target && target.tabId;
      if (method === 'Input.dispatchMouseEvent') return dispatchMouse(tabId, params || {});
      if (method === 'Input.insertText') return insertText(tabId, (params && params.text) || '');
      if (method === 'Input.dispatchKeyEvent') {
        const p = params || {};
        // Only keyDown carries text insertion semantics; the per-char typing
        // loop sends keyDown+keyUp with identical params — inserting on both
        // doubled every character (observed 'hheelllloo...' in E2E).
        if (p.type === 'keyUp') return {};
        if (p.text) return insertText(tabId, p.text);
        const key = p.key || p.code || '';
        if (key && key.length === 1 && !/[\\x00-\\x1f]/.test(key)) return insertText(tabId, key);
        if (!key) return {};
        return executeCommand(tabId, { type: 'press_key', key });
      }
      if (method === 'Page.captureScreenshot') {
        const dataUrl = await browser.tabs.captureVisibleTab(
          params && params.windowId ? params.windowId : undefined,
          { format: 'png' }
        );
        return { data: String(dataUrl).replace(/^data:image\/png;base64,/, '') };
      }
      if (method === 'Runtime.evaluate') {
        const r = await executeCommand(tabId, {
          type: 'execute_js',
          code: (params && params.expression) || '',
          noStore: true
        });
        const value = (r && typeof r === 'object' && 'result' in r) ? r.result : r;
        return { result: { type: typeof value, value } };
      }
      if (method && method.indexOf('Emulation.') === 0) return {};
      // Fail closed: unknown CDP surface must be loud, not silently swallowed.
      throw new Error('[SO-93] CDP method not supported on Firefox: ' + method);
    }
  };
}

export function makeFakeSidePanel(browser) {
  const panelState = new Map(); // tabId -> setOptions argument
  let globalOpts = null;
  let activatedListener = null;

  // H-1/H-2: Clean up panel state when tabs are closed to prevent memory leaks.
  browser.tabs.onRemoved.addListener((tabId) => {
    panelState.delete(tabId);
  });

  async function windowIdOf(tabId) {
    try { const t = await browser.tabs.get(tabId); return t && t.windowId; } catch (_e) { return undefined; }
  }

  async function syncSidebar(tabId) {
    const opts = panelState.get(tabId);
    const enabled = !!(opts && opts.enabled);
    const win = await windowIdOf(tabId);
    if (win === undefined) return;
    try {
      if (enabled) await browser.sidebarAction.open({ windowId: win });
      else await browser.sidebarAction.close({ windowId: win });
    } catch (_e) {
      // sidebarAction.open() can require a user-gesture context; tab-switch
      // sync then degrades to "sidebar stays as the user left it". The icon
      // click path IS a gesture, so attach-on-click still works.
    }
  }

  browser.tabs.onActivated.addListener((activatedListener = async (info) => {
    if (info && typeof info.tabId === 'number' && panelState.has(info.tabId)) {
      await syncSidebar(info.tabId);
    }
  }));

  return {
    setOptions: async (opts) => {
      if (opts && opts.tabId != null) {
        panelState.set(opts.tabId, opts);
        await syncSidebar(opts.tabId);
        return;
      }
      globalOpts = opts || {};
    },
    getOptions: async (opts) => {
      if (opts && opts.tabId != null) return panelState.get(opts.tabId) || {};
      return globalOpts || {};
    },
    open: async (opts) => {
      const tabId = opts && opts.tabId;
      if (tabId != null) {
        panelState.set(tabId, Object.assign({}, panelState.get(tabId), { enabled: true, path: 'popup.html' }));
        const win = await windowIdOf(tabId);
        if (win !== undefined) await browser.sidebarAction.open({ windowId: win });
      }
    },
    close: async (opts) => {
      const tabId = opts && opts.tabId;
      if (tabId != null) {
        const win = await windowIdOf(tabId);
        if (win !== undefined) await browser.sidebarAction.close({ windowId: win });
      }
    },
    setPanelBehavior: async () => {},
    _panelState: panelState,
    _activatedListener: activatedListener
  };
}


// Wrap a promise-style browser.* API object to also support callback-style calls.
// When the last argument is a function, it is treated as a callback: the promise
// result is passed to it on success, or chrome.runtime.lastError is set on error.
function wrapWithCallbackSupport(obj) {
  if (!obj || typeof obj !== "object") return obj;
  // Do not wrap event objects (they have addListener/removeListener)
  if (typeof obj.addListener === "function") return obj;
  var wrapped = {};
  // `const` (not `var`) is load-bearing: `var` is function-scoped, so every
  // closure below would share ONE `val` binding and read whatever the final
  // iteration left there — "can't access property apply, val is undefined".
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === "function") {
      wrapped[key] = function() {
        var args = Array.prototype.slice.call(arguments);
        var lastArg = args[args.length - 1];
        if (typeof lastArg === "function") {
          var callback = lastArg;
          args.pop();
          return val.apply(obj, args).then(function(result) {
            callback(result);
          }).catch(function(err) {
            if (typeof chrome !== "undefined" && chrome.runtime) {
              chrome.runtime.lastError = { message: String(err) };
            }
            callback(undefined);
          });
        }
        return val.apply(obj, args);
      };
    } else if (val && typeof val === "object") {
      wrapped[key] = wrapWithCallbackSupport(val);
    } else {
      wrapped[key] = val;
    }
  }
  return wrapped;
}

// Receiver-aware broadcast.
//
// Firefox reports a rejected runtime.sendMessage broadcast as an "uncaught
// exception" in the browser console even when the caller has already attached
// .catch() — the rejection is reported at the moment it is created, so handling
// it afterwards is not enough to silence the log. Chrome behaves differently: a
// sendMessage with no receiver throws synchronously through
// chrome.runtime.lastError and never creates a rejected promise. So the
// telemetry/status broadcasts that Sentinel fires on a timer are pure console
// noise on Firefox whenever the panel is closed.
//
// The fix is to not create the rejection at all: track live receivers through
// runtime.onConnect and skip the broadcast when the set is empty.
//
// The port is a LIVENESS BEACON, not a data channel. Nothing is posted through
// it — it exists only so the background can tell whether the sidebar document is
// alive. When the set is non-empty the broadcast is passed to the native
// sendMessage unchanged, so every existing receiver (the telemetry panel, the
// chat status ticker, the report card) keeps working exactly as before. The
// sidebar document is what opens the port, because that is the only context
// that listens for these broadcasts; content scripts ignore them.
// --- Receiver diagnostics -------------------------------------------------
// The guard's entire effect is invisible from outside: when it suppresses, the
// console is quiet, and when it passes a broadcast through, the message is simply
// delivered. A popup that never opened its receiver port therefore produced the
// exact same "quiet console" as a correct build — which is how a real regression
// (a marker gate that could never evaluate true) shipped past a green
// verification run. Recording the last connect/disconnect makes the receiver set
// observable from the profile, so "is the panel actually registering?" is
// answerable without a debugger. Best-effort: a storage failure must never affect
// the guard.
export const RECEIVER_DIAG_KEY = 'sentinel_receiver_diag';

function recordReceiverDiag(browser, event, count) {
  try {
    const local = browser && browser.storage && browser.storage.local;
    if (!local || typeof local.set !== 'function') return;
    local.set({ [RECEIVER_DIAG_KEY]: { event, receivers: count, at: Date.now() } });
  } catch (_e) { /* diagnostics must never break the guard */ }
}

export function installBroadcastGuard(browser, chrome) {
  const runtime = chrome && chrome.runtime;
  if (!runtime || typeof runtime.sendMessage !== 'function') return false;

  const receivers = new Set();
  try {
    browser.runtime.onConnect.addListener((port) => {
      receivers.add(port);
      recordReceiverDiag(browser, 'connect', receivers.size);
      port.onDisconnect.addListener(() => {
        receivers.delete(port);
        recordReceiverDiag(browser, 'disconnect', receivers.size);
      });
    });
  } catch (_e) {
    // No onConnect (should not happen in a WebExtension context) — fall back to
    // always sending, which is the pre-guard behaviour.
    return false;
  }

  const nativeSend = runtime.sendMessage;
  chrome.runtime.sendMessage = function () {
    var args = Array.prototype.slice.call(arguments);
    var lastArg = args[args.length - 1];
    var hasCallback = typeof lastArg === 'function';
    if (receivers.size === 0) {
      // Chrome's contract for a failed callback send is lastError + undefined.
      if (hasCallback) {
        if (typeof chrome !== 'undefined' && chrome.runtime) {
          chrome.runtime.lastError = {
            message: 'Could not establish connection. Receiving end does not exist.'
          };
        }
        lastArg(undefined);
        return Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    }
    return nativeSend.apply(null, args);
  };

  // Reports whether the guard is live, so the caller can branch on it. Chrome
  // has no such guard — there, sendMessage throws synchronously through
  // lastError instead of creating a rejected promise — and an open receiver port
  // would needlessly hold Chrome's MV3 service worker alive. popup-full.js reads
  // the manifest instead of this return value, because it runs in a separate
  // global scope and cannot see anything set here.
  return true;
}

export function installWebextShim(browser) {
  if (!browser) throw new Error('[SO-93] browser namespace not found — not a WebExtension context?');
  const chrome = {};
  for (const ns of REAL_NAMESPACES) {
    if (browser[ns]) chrome[ns] = wrapWithCallbackSupport(browser[ns]);
  }
  installBroadcastGuard(browser, chrome);
  chrome.debugger = makeFakeDebugger(browser);
  chrome.sidePanel = makeFakeSidePanel(browser);
  // Firefox has no tabGroups API; agent-engine groups attached tabs for a
  // visual glow. The stub keeps those call sites no-ops instead of throwing.
  chrome.tabGroups = { update: async () => undefined, query: async () => [] };
  globalThis.chrome = chrome;
  // Whether the guard installed is NOT published on a global: the popup and the
  // background have separate global scopes, so a marker set here would be
  // invisible to popup-full.js deciding whether to open a receiver port.
  // popup-full.js instead reads the manifest (background.scripts means the guard
  // is live), which is synchronous and in-context.
  return chrome;
}

// Auto-install when loaded as a module inside the extension (firefox-entry.js
// imports this file for its side effect). Tests import the named exports and
// call installWebextShim(mockBrowser) directly instead.
if (typeof globalThis.browser !== 'undefined' && globalThis.browser.runtime && globalThis.browser.runtime.id) {
  installWebextShim(globalThis.browser);
}
