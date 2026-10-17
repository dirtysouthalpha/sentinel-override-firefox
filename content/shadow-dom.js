// Sentinel Override v3 -- Shadow DOM Utilities
// Shadow DOM piercing: queryDeep, queryDeepFirst, walkShadowTree, getShadowRoot.
// Supports both open shadow roots (direct access) and closed shadow roots
// (via attachShadow patch from shadow-intercept.js).

window.__sentinelUtils = window.__sentinelUtils || {};
window.__sentinelUtils.shadow = window.__sentinelUtils.shadow || {};

(function() {
  const shadow = window.__sentinelUtils.shadow;

  // ========== Get Shadow Root ==========
  /**
   * Get the shadow root for an element.
   * Returns el.shadowRoot for open roots, or checks the WeakMap
   * populated by shadow-intercept.js for closed roots.
   * @param {HTMLElement} el - The element to get the shadow root for.
   * @returns {ShadowRoot|null} The shadow root, or null if not found.
   */
  shadow.getShadowRoot = function(el) {
    if (!el) return null;
    // Open shadow root -- direct access
    if (el.shadowRoot) return el.shadowRoot;
    // Closed shadow root -- check intercepted WeakMap
    if (window.__sentinelCapturedRoots) {
      const captured = window.__sentinelCapturedRoots.get(el);
      if (captured) return captured;
    }
    return null;
  };

  // ========== Is In Shadow DOM ==========
  /**
   * Check if an element resides inside a shadow DOM tree.
   * @param {HTMLElement} el - The element to check.
   * @returns {boolean} True if the element's root node has a host property.
   */
  shadow.isInShadowDOM = function(el) {
    if (!el) return false;
    try {
      const rootNode = el.getRootNode();
      return rootNode !== null && rootNode.host !== undefined;
    } catch {
      return false;
    }
  };

  // ========== Walk Shadow Tree ==========
  /**
   * Walk the entire DOM tree including open (and intercepted closed) shadow roots,
   * invoking the callback for each element node.
   * @param {Node} root - The root node to start walking from.
   * @param {function(Element): void} callback - Called for each element discovered.
   */
  shadow.walkShadowTree = function(root, callback) {
    if (!root) return;

    const walker = (root.ownerDocument || document).createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT,
      null,
      false
    );

    let node = walker.currentNode;
    while (node) {
      callback(node);

      // If this element has a shadow root (open or intercepted closed), walk into it
      const sr = shadow.getShadowRoot(node);
      if (sr) {
        shadow.walkShadowTree(sr, callback);
      }

      // Also walk into any shadow roots of slot children
      const slots = node.querySelectorAll ? node.querySelectorAll('slot') : [];
      slots.forEach(function(slot) {
        const assignedNodes = slot.assignedNodes ? slot.assignedNodes({ flatten: true }) : [];
        assignedNodes.forEach(function(assigned) {
          if (assigned.nodeType === Node.ELEMENT_NODE) {
            callback(assigned);
            const assignedSR = shadow.getShadowRoot(assigned);
            if (assignedSR) {
              shadow.walkShadowTree(assignedSR, callback);
            }
          }
        });
      });

      node = walker.nextNode();
    }
  };

  // ========== Query Deep ==========
  /**
   * Recursively search the DOM piercing through shadow roots.
   * Fast-path uses querySelectorAll on the root, then walks all elements
   * checking for shadowRoot and querying inside each one.
   * @param {Node} root - The root to search from (typically `document`).
   * @param {string} selector - A CSS selector string.
   * @returns {Element[]} Array of matched elements (deduplicated).
   */
  shadow.queryDeep = function(root, selector) {
    if (!root || !selector) return [];
    const results = [];
    const seen = new Set();

    // Fast path: try normal querySelectorAll on the root
    try {
      const direct = root.querySelectorAll(selector);
      if (direct && typeof direct.forEach === 'function') {
        Array.from(direct).filter(el => el).forEach(el => {
          seen.add(el);
          results.push(el);
        });
      }
    } catch { /* invalid selector */ }

    // Walk the tree looking for shadow roots
    shadow.walkShadowTree(root, function(el) {
      // Skip the root itself (already queried)
      if (el === root) return;
      // Check if this element matches the selector
      try {
        if (el.matches && el.matches(selector) && !seen.has(el)) {
          seen.add(el);
          results.push(el);
        }
      } catch { /* matches() not supported or invalid selector */ }

      // If this element has a shadow root, query inside it
      const sr = shadow.getShadowRoot(el);
      if (sr) {
        try {
          const shadowMatches = sr.querySelectorAll(selector);
          shadowMatches.forEach(function(matchEl) {
            if (!seen.has(matchEl)) {
              seen.add(matchEl);
              results.push(matchEl);
            }
          });
        } catch { /* invalid selector in shadow context */ }
      }
    });

    return results;
  };

  // ========== Query Deep First ==========
  /**
   * Return the first element matching the selector, piercing through shadow roots.
   * More efficient than queryDeep when only one element is needed.
   * @param {Node} root - The root to search from.
   * @param {string} selector - A CSS selector string.
   * @returns {Element|null} The first matching element, or null.
   */
  shadow.queryDeepFirst = function(root, selector) {
    if (!root || !selector) return null;

    // Fast path: try normal querySelector on the root
    try {
      const direct = root.querySelector(selector);
      if (direct) return direct;
    } catch { /* invalid selector */ }

    // Walk the tree looking for shadow roots
    let found = null;
    shadow.walkShadowTree(root, function(el) {
      if (found) return; // already found, skip remaining
      if (el === root) return;

      try {
        if (el.matches && el.matches(selector)) {
          found = el;
          return;
        }
      } catch { /* matches() not supported */ }

      // If this element has a shadow root, query inside it
      const sr = shadow.getShadowRoot(el);
      if (sr && !found) {
        try {
          const shadowMatch = sr.querySelector(selector);
          if (shadowMatch) {
            found = shadowMatch;
          }
        } catch { /* invalid selector in shadow context */ }
      }
    });

    return found;
  };
})();

