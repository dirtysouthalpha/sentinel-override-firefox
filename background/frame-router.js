// Sentinel Override v3 -- Frame Router (Background Script)
// Cross-origin iframe enumeration and command execution via chrome.scripting API.
// Enables the agent to interact with elements inside cross-origin iframes.

import { getErrorMessage } from './error-utils.js';

// ========== Content Script Files for Frame Injection ==========
// Same set as tab-manager.js CONTENT_SCRIPT_FILES, minus index.js (handler injected separately)
const FRAME_UTILITY_FILES = [
  'content/dom-utils.js',
  'content/shadow-dom.js',
  'content/highlight.js',
  'content/cursor.js',
  'content/action-hud.js',
  'content/wait-utils.js',
  'content/dropdown-utils.js',
  'content/special-inputs.js',
  'content/overlay-detector.js'
];

// ========== Frame Tracking ==========
// Map<tabId, Map<positionalIndex, frameId>>
// Positional index = order of appearance among iframes (frameId !== 0) per webNavigation.
// Updated on chrome.webNavigation.onCommitted / onBeforeNavigate / onErrorOccurred.
const frameIdsByTab = new Map();

/**
 * Rebuild the positional-index-to-frameId map for a tab.
 * Queries chrome.webNavigation for all frames, filters to iframes only,
 * and stores them sorted by frameId for consistent positional indexing.
 * @param {number} tabId - The tab whose frame map to rebuild.
 * @returns {Promise<void>}
 */
function rebuildFrameMap(tabId) {
  return chrome.webNavigation.getAllFrames({ tabId }).then((frames) => {
    if (!frames) {
      frameIdsByTab.delete(tabId);
      return;
    }
    // Stable ordering: by frameId ascending so repeat builds give consistent indices.
    const iframes = frames
      .filter((f) => f.frameId !== 0)
      .sort((a, b) => a.frameId - b.frameId);
    const positional = new Map();
    iframes.forEach((f, idx) => positional.set(idx, f.frameId));
    frameIdsByTab.set(tabId, positional);
  }).catch(() => {
    // Tab may have closed mid-flight; ignore.
  });
}

/**
 * Remove the cached frame map for a tab (e.g. on tab close).
 * @param {number} tabId - The tab whose frame map to clear.
 */
function clearFrameMap(tabId) {
  frameIdsByTab.delete(tabId);
}

// ========== Enumerate Frames ==========
// Use chrome.webNavigation.getAllFrames to get all frames in a tab.
// Returns array of { frameId, parentId, url, isIframe, isCrossOrigin }.
/**
 * Enumerate all frames in a tab, returning metadata about each.
 * Includes frameId, parentId, url, whether it's an iframe, and cross-origin status.
 * @param {number} tabId - The tab to enumerate frames in.
 * @returns {Promise<Array<{frameId: number, parentId: number, url: string, isIframe: boolean, isCrossOrigin: boolean}>>}
 */
export async function enumerateFrames(tabId) {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    if (!frames || !frames.length) return [];

    // Get the main frame URL for cross-origin detection
    const mainFrame = frames.find(f => f.frameId === 0);
    let mainOrigin = '';
    if (mainFrame) {
      try {
        mainOrigin = new URL(mainFrame.url).origin;
      } catch (e) {
        console.warn('[Sentinel/frame-router] URL parse failed for main frame:', getErrorMessage(e));
        mainOrigin = mainFrame.url;
      }
    }

    return frames.map(f => {
      let frameOrigin = '';
      try {
        frameOrigin = new URL(f.url).origin;
      } catch (e) {
        console.warn('[Sentinel/frame-router] URL parse failed for frame:', getErrorMessage(e));
        frameOrigin = f.url || '';
      }

      return {
        frameId: f.frameId,
        parentId: f.parentId,
        url: f.url,
        isIframe: f.frameId !== 0,
        isCrossOrigin: f.frameId !== 0 && frameOrigin !== mainOrigin
      };
    });
  } catch (e) {
    const errMsg = getErrorMessage(e);
    console.error('[Sentinel/frame-router] enumerateFrames failed:', errMsg);
    return [];
  }
}

// ========== Resolve Frame For Selector ==========
// Given a frame index (from content script's frame:N: prefix), map it to a Chrome frameId.
// The mapping is positional: frame index 0 = first iframe in DOM order.
// Prefers the cached frameIdsByTab map (kept fresh by webNavigation events),
// falling back to a live enumeration if the cache is empty.
/**
 * Map a positional frame index (from content script's "frame:N:" prefix) to a Chrome frameId.
 * Uses the cached frameIdsByTab map first, falling back to a live enumeration if the cache is empty.
 * @param {number} tabId - The tab containing the frame.
 * @param {number} frameIndex - Zero-based positional index of the iframe.
 * @returns {Promise<number|null>} The Chrome frameId, or null if not found.
 */
export async function resolveFrameForSelector(tabId, frameIndex) {
  if (tabId == null || frameIndex == null || frameIndex < 0) return null;

  const cached = frameIdsByTab.get(tabId);
  if (cached && cached.has(frameIndex)) {
    return cached.get(frameIndex);
  }

  // Fallback: live enumeration (also refreshes the cache for next time).
  const frames = await enumerateFrames(tabId);
  const iframes = frames.filter(f => f.isIframe);
  if (frameIndex >= iframes.length) return null;

  // Refresh cache from live data using the same positional convention.
  const positional = new Map();
  iframes
    .slice()
    .sort((a, b) => a.frameId - b.frameId)
    .forEach((f, idx) => positional.set(idx, f.frameId));
  frameIdsByTab.set(tabId, positional);

  return positional.has(frameIndex) ? positional.get(frameIndex) : null;
}

// ========== Execute In Frame ==========
// Execute a DOM command inside a specific cross-origin iframe.
// TWO-STEP injection: first inject utility modules, then run command using those utilities.
/**
 * Execute a DOM command inside a specific cross-origin iframe.
 * Two-step injection: first injects utility content scripts into the frame,
 * then runs the command function using those utilities.
 * @param {number} tabId - The tab containing the iframe.
 * @param {number} frameId - The Chrome frameId to execute in.
 * @param {{type: string, [key: string]: any}} command - The DOM command to execute.
 * @returns {Promise<{ok: boolean, error?: string, [key: string]: any}>}
 */
export async function executeInFrame(tabId, frameId, command) {
  // Note: frameId === 0 is the main frame and is a valid value, so check for nullish only.
  if (tabId == null || frameId == null) {
    return { ok: false, error: 'Missing tabId or frameId' };
  }
  if (!command || !command.type) {
    return { ok: false, error: 'Missing command type' };
  }

  try {
    // Step 1: Inject utility modules into the target frame
    // This makes scanDocument, findElementBySelector, isVisible, shadow DOM utils, etc.
    // available inside the cross-origin iframe's isolated world.
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      files: FRAME_UTILITY_FILES
    });

    // Step 2: Inject and run the command using the loaded utilities
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: runCommandInFrame,
      args: [command]
    });

    if (results?.[0]?.result !== undefined) {
      return results[0].result;
    }

    return { ok: false, error: 'No result returned from frame command execution' };
  } catch (e) {
    return { ok: false, error: `Frame execution failed: ${getErrorMessage(e)}` };
  }
}

// ========== Command Runner (injected into iframe) ==========
// This function runs inside the target iframe. It has access to window.__sentinelUtils
// because Step 1 injected the utility files that populate that namespace.
/**
 * Command runner injected into a cross-origin iframe via chrome.scripting.executeScript.
 * Has access to window.__sentinelUtils populated by the utility content scripts injected in step 1.
 * Dispatches DOM commands (click, type, read, etc.) using the loaded utility modules.
 * @param {{type: string, [key: string]: any}} command - The DOM command to execute.
 * @returns {{ok: boolean, error?: string, [key: string]: any}} Command result.
 */
async function runCommandInFrame(command) {
  // Inlined: chrome.scripting.executeScript serializes only the function body,
  // dropping all closure scope (module imports and module-level constants).
  const _300MS = 300;
  const _inputTagRe = /^(INPUT|TEXTAREA)$/;
  const _multiNlRe = /\n{3,}/g;
  const _errMsg = (e) => typeof e === 'string' ? e : (e && typeof e.message === 'string' ? e.message : (e == null ? '' : String(e)));
  const utils = window.__sentinelUtils;
  if (!utils || !utils.dom) {
    return { ok: false, error: 'Sentinel utilities not loaded in frame' };
  }

  const dom = utils.dom;
  const hl = utils.highlight;
  const ov = utils.overlay;
  const si = utils.specialInputs;
  const doc = document;
  const view = doc.defaultView || window;
  const eventOpts = { bubbles: true, composed: true };

  try {
    switch (command.type) {
      case 'click': {
        const el = dom.findElementBySelector(doc, command.selector);
        if (!el) return { ok: false, error: `Element not found: ${command.selector}` };

        // Overlay check
        if (ov && ov.isOverlayBlocking) {
          const blocking = ov.isOverlayBlocking(doc, el);
          if (blocking) {
            if (ov.dismissOverlay(doc, blocking)) {
              await new Promise(resolve => setTimeout(resolve, _300MS));
            } else {
              return { ok: false, error: 'Element blocked by overlay that could not be dismissed' };
            }
          }
        }

        if (hl) hl.highlightElement(el);
        el.scrollIntoView({ behavior: 'instant', block: 'center' });
        const mouseOpts = { bubbles: true, cancelable: true, composed: true, view: view };
        el.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
        el.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
        el.click();
        el.dispatchEvent(new MouseEvent('mouseout', mouseOpts));
        if (hl) hl.removeHighlight(el);
        return { ok: true, data: `Clicked ${command.selector}` };
      }

      case 'type': {
        const el = dom.findElementBySelector(doc, command.selector);
        if (!el) return { ok: false, error: `Element not found: ${command.selector}` };

        // Overlay check
        if (ov && ov.isOverlayBlocking) {
          const blocking = ov.isOverlayBlocking(doc, el);
          if (blocking) {
            if (ov.dismissOverlay(doc, blocking)) {
              await new Promise(resolve => setTimeout(resolve, _300MS));
            } else {
              return { ok: false, error: 'Element blocked by overlay that could not be dismissed' };
            }
          }
        }

        if (hl) hl.highlightElement(el);
        el.scrollIntoView({ behavior: 'instant', block: 'center' });
        el.focus();
        const text = command.text || '';

        // Rich text editor
        if (si && si.isRichTextEditor && si.isRichTextEditor(el)) {
          const result = si.setRichTextValue(el, text);
          if (hl) hl.removeHighlight(el);
          return { ok: result.success, data: result };
        }

        // Date input
        if (si && si.isDateInput && si.isDateInput(el)) {
          const result = si.setDatePickerValue(el, text);
          if (hl) hl.removeHighlight(el);
          return { ok: result.success, data: result };
        }

        // contenteditable
        if (el.isContentEditable) {
          el.textContent = '';
          el.dispatchEvent(new Event('input', eventOpts));
          doc.execCommand('selectAll', false, null);
          doc.execCommand('delete', false, null);
          for (const char of text) {
            doc.execCommand('insertText', false, char);
            el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: char }));
          }
          el.dispatchEvent(new Event('change', eventOpts));
          if (hl) hl.removeHighlight(el);
          return { ok: true, data: 'Typed into contenteditable' };
        }

        // Standard INPUT/TEXTAREA
        if (_inputTagRe.test(el.tagName)) {
          const proto = el.tagName === 'TEXTAREA'
            ? (view.HTMLTextAreaElement && view.HTMLTextAreaElement.prototype)
            : (view.HTMLInputElement && view.HTMLInputElement.prototype);
          const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
          const nativeSetter = descriptor && descriptor.set;
          if (nativeSetter) {
            nativeSetter.call(el, '');
          } else {
            el.value = '';
          }
          el.dispatchEvent(new Event('input', eventOpts));
          for (const char of text) {
            const currentVal = el.value;
            if (nativeSetter) {
              nativeSetter.call(el, currentVal + char);
            } else {
              el.value = currentVal + char;
            }
            el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: char }));
          }
          el.dispatchEvent(new Event('change', eventOpts));
          if (hl) hl.removeHighlight(el);
          return { ok: true, data: `Typed into ${command.selector}` };
        }

        // Fallback
        el.value = text;
        el.dispatchEvent(new Event('input', eventOpts));
        el.dispatchEvent(new Event('change', eventOpts));
        if (hl) hl.removeHighlight(el);
        return { ok: true, data: `Typed into ${command.selector}` };
      }

      case 'observe_page': {
        const interactiveElements = [];
        const selectorMap = new Map();
        dom.scanDocument(doc, interactiveElements, selectorMap, '');
        return { ok: true, data: { elements: interactiveElements } };
      }

      case 'read_page': {
        const title = doc.title;
        const url = view.location.href;
        let content = '';
        const mainSelectors = ['main', '[role="main"]', 'article', '#main-content', '#content', '.main-content', '.content'];
        let mainEl = null;
        for (const sel of mainSelectors) {
          mainEl = doc.querySelector(sel);
          if (mainEl) break;
        }
        if (mainEl) {
          const clone = mainEl.cloneNode(true);
          const skipSelectors = ['nav', 'header', 'footer', 'aside', 'script', 'style', 'noscript', 'svg'];
          try {
            clone.querySelectorAll(skipSelectors.join(',')).forEach(el => el.remove());
          } catch(e) {
            console.warn('[Sentinel/frame-router] DOM cleanup failed:', _errMsg(e));
          }
          content = (clone.innerText || clone.textContent || '').replace(_multiNlRe, '\n\n').trim();
        }
        if ((!content || content.length < 200) && doc.body) {
          const bodyClone = doc.body.cloneNode(true);
          const skipSelectors = ['nav', 'header', 'footer', 'aside', 'script', 'style', 'noscript'];
          try {
            bodyClone.querySelectorAll(skipSelectors.join(',')).forEach(el => el.remove());
          } catch(e) {
            console.warn('[Sentinel/frame-router] Body cleanup failed:', _errMsg(e));
          }
          content = (bodyClone.innerText || '').replace(_multiNlRe, '\n\n').trim();
        }
        return { ok: true, data: `Page Title: ${title}\nURL: ${url}\n\n${content}` };
      }

      default:
        return { ok: false, error: `Unknown command type in frame: ${command.type}` };
    }
  } catch (e) {
    return { ok: false, error: `Frame command error: ${_errMsg(e)}` };
  }
}

// ========== Listener Registration ==========
// Call once at service-worker startup. Subscribes to webNavigation events
// to keep frameIdsByTab fresh, and (optionally) installs an
// 'execute_in_frame' message listener if one isn't already installed in
// background/index.js. This module idempotently registers webNavigation
// listeners so re-import doesn't double-subscribe.
let __frameRouterListenersInstalled = false;
/**
 * Install chrome.webNavigation and chrome.tabs event listeners for frame tracking.
 * Idempotent — safe to call multiple times; only registers listeners once.
 * Subscribes to onCommitted, onErrorOccurred (to rebuild frame maps),
 * and tabs.onRemoved (to clean up stale maps).
 */
export function addFrameRouterListeners() {
  if (__frameRouterListenersInstalled) return;
  __frameRouterListenersInstalled = true;

  if (chrome.webNavigation && chrome.webNavigation.onCommitted) {
    chrome.webNavigation.onCommitted.addListener((details) => {
      if (typeof details.tabId === 'number' && details.tabId >= 0) {
        rebuildFrameMap(details.tabId);
      }
    });
  }
  if (chrome.webNavigation && chrome.webNavigation.onErrorOccurred) {
    chrome.webNavigation.onErrorOccurred.addListener((details) => {
      if (typeof details.tabId === 'number' && details.tabId >= 0) {
        rebuildFrameMap(details.tabId);
      }
    });
  }
  if (chrome.tabs && chrome.tabs.onRemoved) {
    chrome.tabs.onRemoved.addListener((tabId) => {
      clearFrameMap(tabId);
    });
  }
}
