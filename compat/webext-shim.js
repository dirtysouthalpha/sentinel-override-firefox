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

export function installWebextShim(browser) {
  if (!browser) throw new Error('[SO-93] browser namespace not found — not a WebExtension context?');
  const chrome = {};
  for (const ns of REAL_NAMESPACES) {
    if (browser[ns]) chrome[ns] = browser[ns];
  }
  chrome.debugger = makeFakeDebugger(browser);
  chrome.sidePanel = makeFakeSidePanel(browser);
  chrome.tabGroups = { update: async () => undefined, query: async () => [] };
  globalThis.chrome = chrome;
  return chrome;
}

// Auto-install when loaded as a module inside the extension (firefox-entry.js
// imports this file for its side effect). Tests import the named exports and
// call installWebextShim(mockBrowser) directly instead.
if (typeof globalThis.browser !== 'undefined' && globalThis.browser.runtime && globalThis.browser.runtime.id) {
  installWebextShim(globalThis.browser);
}
