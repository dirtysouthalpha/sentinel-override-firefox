// Sentinel Override v3 -- DOM Utilities
// Core DOM operations: visibility checks, label extraction, selector generation, element scanning.

window.__sentinelUtils = window.__sentinelUtils || {};
window.__sentinelUtils.dom = window.__sentinelUtils.dom || {};
// Wave 2: ref id + bbox emission per element. See ref helpers below.

(function() {
  const dom = window.__sentinelUtils.dom;

  // Precompute sets for O(1) lookups in hot path functions
  const genericIds = new Set(['button', 'input', 'form', 'container', 'main', 'wrapper', 'div', 'span', 'content', 'body', 'header', 'footer', 'nav']);
  const formTags = new Set(['input', 'select', 'textarea', 'button']);

  // ========== Visibility Check ==========
  /**
   * Check whether an element is visible on the page.
   * Returns false for display:none, visibility:hidden, opacity:0, or zero-size elements.
   * @param {HTMLElement} el - The element to check.
   * @returns {boolean} True if the element is visible.
   */
  dom.isVisible = function(el) {
    try {
      const _view = (el && el.ownerDocument && el.ownerDocument.defaultView) || document.defaultView;
      if (!_view) return true;
      const style = _view.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
    } catch { /* non-fatal, assume visible */ }
    return true;
  };

  // ========== Interactability Check (#20) ==========
  /**
   * Check whether an element is interactable for a given action type.
   * Detects pointer-events:none, disabled, and aria-disabled states.
   * @param {HTMLElement} el - The element to check.
   * @param {string} action - The action being attempted (e.g. 'click').
   * @returns {string|null} A reason string if blocked, or null if interactable.
   */
  dom.checkInteractable = function(el, action) {
    if (!el) return 'Element not found';
    if (el.isConnected === false) return 'Element is detached from DOM';
    try {
      const view = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      const style = view.getComputedStyle(el);
      if (action === 'click' && style.pointerEvents === 'none') {
        return 'Element is pointer-events:none';
      }
      if (el.disabled === true) return 'Element is disabled';
      const ariaDisabled = el.getAttribute && el.getAttribute('aria-disabled');
      if (ariaDisabled === 'true') return 'Element is aria-disabled';
    } catch { /* non-fatal */ }
    return null;
  };

  // ========== Label Extraction ==========
  /**
   * Extract a human-readable label from an element.
   * Tries innerText, placeholder, aria-label, title, value, then name attributes.
   * @param {HTMLElement} el - The element to extract a label from.
   * @returns {string} The extracted label, or 'No label'.
   */
  dom.getLabel = function(el) {
    if (!el) return 'No label';
    return (
      el.innerText ||
      el.placeholder ||
      el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      el.getAttribute('value') ||
      el.getAttribute('name') ||
      'No label'
    ).trim();
  };

  // ========== Multi-Strategy Selector ==========
  /**
   * Generate a unique CSS selector for an element using a multi-strategy approach.
   * Prefers data-testid, then aria-label, then id (excluding generic ids),
   * then name attribute, falling back to nth-of-type path.
   * @param {HTMLElement} el - The element to generate a selector for.
   * @returns {string} A CSS selector string.
   */
  dom.getUniqueSelector = function(el) {
    const testId = el.getAttribute('data-testid');
    if (testId) return `[data-testid="${CSS.escape(testId)}"]`;

    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return `[aria-label="${CSS.escape(ariaLabel)}"]`;

    if (el.id) {
      if (!genericIds.has(el.id.toLowerCase())) return `#${CSS.escape(el.id)}`;
    }

    const tagName = el.tagName.toLowerCase();
    if (formTags.has(tagName) && el.name) {
      return `${tagName}[name="${CSS.escape(el.name)}"]`;
    }

    return dom.getNthOfTypePath(el);
  };

  /**
   * Generate an nth-of-type CSS path for an element, up to MAX_DEPTH ancestors.
   * @param {HTMLElement} el - The element to build a path for.
   * @returns {string} A CSS selector path using nth-of-type notation.
   */
  dom.getNthOfTypePath = function(el) {
    const MAX_DEPTH = 8;
    const path = [];
    let current = el;
    let depth = 0;
    while (current && current.parentElement && depth < MAX_DEPTH) {
      let index = 0;
      let sibling = current.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === current.tagName) index++;
        sibling = sibling.previousElementSibling;
      }
      path.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${index + 1})`);
      current = current.parentElement;
      depth++;
    }
    return path.join(' > ');
  };

  // ========== Find Element by Selector ==========
  /**
   * Find a DOM element by selector string, with fallback strategies.
   * Tries standard querySelector, then regex-based parsing for data-testid,
   * aria-label, and name selectors, and finally pierces shadow DOM.
   * @param {Document|Element} doc - The root to search from.
   * @param {string} selector - The CSS selector string.
   * @returns {HTMLElement|null} The found element, or null.
   */
  dom.findElementBySelector = function(doc, selector) {
    if (!selector) return null;
    try {
      const el = doc.querySelector(selector);
      if (el) return el;
    } catch (e) { console.warn('[Sentinel] selector query fallback:', (typeof e === 'object' && e !== null && typeof e.message === 'string' ? e.message : String(e))); }

    const testIdMatch = selector.match(/^\[data-testid="(.+)"\]$/);
    if (testIdMatch) {
      const el = doc.querySelector(`[data-testid="${testIdMatch[1]}"]`);
      if (el) return el;
    }

    const ariaMatch = selector.match(/^\[aria-label="(.+)"\]$/);
    if (ariaMatch) {
      const el = doc.querySelector(`[aria-label="${ariaMatch[1]}"]`);
      if (el) return el;
    }

    const nameMatch = selector.match(/^(\w+)\[name="(.+)"\]$/);
    if (nameMatch) {
      const el = doc.querySelector(`${nameMatch[1]}[name="${nameMatch[2]}"]`);
      if (el) return el;
    }

    const shadow = window.__sentinelUtils && window.__sentinelUtils.shadow;
    if (shadow && shadow.queryDeepFirst) {
      const shadowEl = shadow.queryDeepFirst(doc, selector);
      if (shadowEl) return shadowEl;
    }

    // ── Self-healing fallbacks ────────────────────────────────────────────
    // 1. Case-insensitive aria-label (LLM sometimes gets casing wrong)
    const ariaHealMatch = selector.match(/\[aria-label="([^"]+)"\]/i);
    if (ariaHealMatch) {
      try {
        const lc = ariaHealMatch[1].toLowerCase();
        const candidates = doc.querySelectorAll('[aria-label]');
        for (var _hi = 0, _candLen = candidates.length; _hi < _candLen; _hi++) {
          if ((candidates[_hi].getAttribute('aria-label') || '').toLowerCase() === lc) return candidates[_hi];
        }
      } catch (_) { /* non-fatal */ }
    }

    // 2. Partial data-testid match (catches dynamic suffixes like -123)
    const testIdHealMatch = selector.match(/\[data-testid="([^"]+)"\]/);
    if (testIdHealMatch) {
      try {
        const base = testIdHealMatch[1];
        const el = doc.querySelector(`[data-testid*="${base.replace(/"/g, '')}"]`);
        if (el) return el;
      } catch (_) { /* non-fatal */ }
    }

    // 3. Text-content match for interactive elements (catches label/text changes)
    try {
      var _textHint = null;
      var _ariaLabelChunk = selector.match(/\[aria-label="([^"]+)"\]/i);
      if (_ariaLabelChunk) { _textHint = _ariaLabelChunk[1]; }
      if (!_textHint) {
        // Extract likely button text from :contains()-style selectors or end of chain
        var _textChunk = selector.match(/:contains\("([^"]+)"\)/i) || selector.match(/['"]([\w\s]{2,40})['"]/);
        if (_textChunk) _textHint = _textChunk[1];
      }
      if (_textHint) {
        var _lc = _textHint.trim().toLowerCase();
        var _interactives = doc.querySelectorAll('button, a, [role="button"], input[type="submit"], input[type="button"], [role="link"]');
        for (var _ii = 0, _intLen = _interactives.length; _ii < _intLen; _ii++) {
          var _el = _interactives[_ii];
          var _elText = (_el.innerText || _el.textContent || _el.value || _el.getAttribute('aria-label') || '').trim().toLowerCase();
          if (_elText === _lc || _elText.includes(_lc)) return _el;
        }
      }
    } catch (_) { /* non-fatal */ }

    // 4. Strip positional pseudo-classes and retry — SPAs re-render and change
    //    :nth-child / :nth-of-type positions; removing them often recovers the match.
    try {
      var _stripped = selector.replace(/:nth-child\(\d+\)|:nth-of-type\(\d+\)|:first-child|:last-child|:first-of-type|:last-of-type|:only-child|:only-of-type/g, '').trim();
      if (_stripped && _stripped !== selector) {
        try {
          var _strippedEl = doc.querySelector(_stripped);
          if (_strippedEl) return _strippedEl;
        } catch (_) { /* invalid after strip */ }
      }
    } catch (_) { /* non-fatal */ }

    // 5. Try the leaf (last combinatorial segment) of a complex path selector.
    //    e.g. "div.container > ul > li > a.btn" → try "a.btn" alone.
    try {
      var _parts = selector.split(/[\s>+~]+/);
      var _partsLen = _parts.length; // Cache to avoid repeated property access
      var _leaf = _partsLen > 0 ? (_parts[_partsLen - 1] || '').trim() : '';
      if (_leaf && _leaf !== selector && _leaf.length > 1) {
        try {
          var _leafEl = doc.querySelector(_leaf);
          if (_leafEl) return _leafEl;
        } catch (_) { /* invalid leaf */ }
      }
    } catch (_) { /* non-fatal */ }

    // 6. Placeholder / name / id text match for inputs (catches renamed attributes).
    try {
      var _labelHint = selector.match(/\[placeholder="([^"]+)"\]/i);
      if (_labelHint) {
        var _ph = _labelHint[1].trim().toLowerCase();
        var _inputs = doc.querySelectorAll('input, textarea');
        for (var _pi = 0, _inputsLen = _inputs.length; _pi < _inputsLen; _pi++) {
          if ((_inputs[_pi].getAttribute('placeholder') || '').trim().toLowerCase() === _ph) return _inputs[_pi];
        }
      }
    } catch (_) { /* non-fatal */ }

    return null;
  };

  // ========== Ref ID System (#10 -- Wave 2) ==========
  // Scan-local stable ref ids ("ref_1", "ref_2", ...). Each scanDocument call
  // resets the counter and rebuilds the lookup map. WeakRef map lets the
  // dispatcher resolve a ref back to the live Element node; old refs deref to
  // null after the next scan -- the dispatcher treats that as a stale-ref
  // fallback to selector.

  let __sentinelRefCounter = 0;
  let __sentinelRefLookup = new Map();
  let __sentinelScanId = 0;

  /**
   * Reset the ref ID counter and lookup map for a new scan pass.
   * @private
   */
  dom._beginScan = function() {
    __sentinelRefCounter = 0;
    __sentinelRefLookup = new Map();
    __sentinelScanId++;
  };

  /**
   * Assign a stable ref ID (e.g. "ref_3") to an element and store a WeakRef
   * in the lookup map for later resolution.
   * @param {HTMLElement} el - The element to assign a ref to.
   * @returns {string} The assigned ref ID.
   * @private
   */
  dom._assignRef = function(el) {
    __sentinelRefCounter++;
    const refId = `ref_${__sentinelRefCounter}`;
    try {
      const wr = (typeof WeakRef === 'function') ? new WeakRef(el) : { deref: () => el };
      __sentinelRefLookup.set(refId, wr);
    } catch {
      __sentinelRefLookup.set(refId, { deref: () => el });
    }
    return refId;
  };

  /**
   * Resolve a ref ID back to its live DOM element.
   * Returns null if the ref is unknown, the element was garbage-collected,
   * or the element is no longer connected to the document.
   * @param {string} refId - The ref ID (e.g. "ref_5").
   * @returns {HTMLElement|null} The live element, or null.
   */
  dom.findElementByRef = function(refId) {
    if (!refId || typeof refId !== 'string') return null;
    const wr = __sentinelRefLookup.get(refId);
    if (!wr) return null;
    let el = null;
    try { el = wr.deref ? wr.deref() : null; } catch { el = null; }
    if (!el) return null;
    try {
      if (!el.isConnected) return null;
    } catch { return null; }
    return el;
  };

  /**
   * Get the current scan ID (incremented on each _beginScan call).
   * @returns {number} The current scan ID.
   */
  dom.getCurrentScanId = function() { return __sentinelScanId; };

  // ========== Document Scanning ==========
  /**
   * Scan a document (and its shadow DOM trees) for interactive elements.
   * Collects visible interactive elements into the interactiveElements array
   * and populates the selectorMap Set to prevent duplicates.
   * @param {Document|Element} doc - The root to scan.
   * @param {Array} interactiveElements - Accumulator array for found elements.
   * @param {Set} selectorMap - Set of seen selectors for deduplication.
   * @param {string} [prefix] - Optional selector prefix for iframe-scoped elements.
   */
  dom.scanDocument = function(doc, interactiveElements, selectorMap, prefix) {
    const shadow = window.__sentinelUtils && window.__sentinelUtils.shadow;
    if (!prefix) {
      dom._beginScan();
    }

    const interactiveSelectors = [
      'button', 'a', 'input', 'select', 'textarea',
      '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="textbox"]',
      '[role="combobox"]', '[role="listbox"]', '[role="option"]', '[role="menuitem"]',
      '[role="tab"]', '[role="switch"]', '[role="radio"]',
      '[contenteditable="true"]',
      '[tabindex]:not([tabindex="-1"])',
      '[onclick]'
    ].join(', ');

    const elements = doc.querySelectorAll(interactiveSelectors);
    if (elements && typeof elements.forEach === 'function') {
      elements.forEach((el) => {
        if (!el || !dom.isVisible(el)) return;
        dom._addElement(el, interactiveElements, selectorMap, prefix, false);
      });
    }

    if (shadow && shadow.walkShadowTree && shadow.isInShadowDOM) {
      shadow.walkShadowTree(doc, function(el) {
        if (el === doc || doc.contains(el)) return;
        try {
          if (el.matches && el.matches(interactiveSelectors)) {
            if (dom.isVisible(el)) {
              dom._addElement(el, interactiveElements, selectorMap, prefix, shadow.isInShadowDOM(el));
            }
          }
        } catch (e) { console.warn('[Sentinel] shadow element scan:', (typeof e === 'object' && e !== null && typeof e.message === 'string' ? e.message : String(e))); }
      });
    }
  };

  /**
   * Internal helper: add a single element to the interactive elements list.
   * Assigns a ref ID, computes bounding box, and extracts metadata.
   * @param {HTMLElement} el - The interactive element.
   * @param {Array} interactiveElements - Accumulator array.
   * @param {Set} selectorMap - Deduplication set.
   * @param {string} prefix - Selector prefix.
   * @param {boolean} inShadowDOM - Whether the element is inside a shadow root.
   * @private
   */
  dom._addElement = function(el, interactiveElements, selectorMap, prefix, inShadowDOM) {
    const text = dom.getLabel(el);
    const selector = prefix + dom.getUniqueSelector(el);
    if (selectorMap.has(selector)) return;
    selectorMap.set(selector, true);

    // (#10) Stable ref id + bbox per element so the LLM can use refs and the
    // model can correlate screenshot pixels to DOM nodes.
    const refId = dom._assignRef(el);
    let bbox = null;
    try {
      const r = el.getBoundingClientRect();
      // Emit page-absolute coords so click_at remains accurate after scroll.
      // scrollX/scrollY convert viewport-relative rect to document-absolute position.
      bbox = {
        x: Math.round((Number(r.left) || 0) + (Number(window.scrollX) || 0)),
        y: Math.round((Number(r.top) || 0) + (Number(window.scrollY) || 0)),
        w: Math.round(Number(r.width) || 0),
        h: Math.round(Number(r.height) || 0)
      };
    } catch (e) { console.warn('[Sentinel] bbox getBoundingClientRect:', (typeof e === 'object' && e !== null && typeof e.message === 'string' ? e.message : String(e))); }

    const elementData = {
      index: interactiveElements.length,
      tag: el.tagName,
      text: text.substring(0, 100),
      selector: selector,
      role: el.getAttribute('role') || 'none',
      type: el.getAttribute('type') || 'none',
      ref: refId,
      bbox: bbox,
      // Semantic hints included so stale-ref fallback can match by identity
      // rather than brittle nth-of-type selector chains.
      ariaLabel: (el.getAttribute('aria-label') || '').substring(0, 100) || undefined,
      elementId: el.id || undefined
    };

    if (el.tagName === 'SELECT') {
      const opts = [...el.options].slice(0, 30);
      elementData.options = opts.map(o => ({ value: o.value, text: typeof o.textContent === 'string' ? o.textContent.trim().substring(0, 60) : '' }));
      elementData.multiple = el.multiple;
    }

    if (/^(checkbox|radio)$/.test(el.type)) {
      elementData.checked = el.checked;
    }

    if (inShadowDOM) {
      elementData.inShadowDOM = true;
    }

    interactiveElements.push(elementData);
  };
})();
