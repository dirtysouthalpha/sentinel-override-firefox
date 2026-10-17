// Sentinel Override v3 -- Dropdown & Menu Utilities
// Custom dropdown detection, opening, option selection, and nested menu traversal.
// Works with Angular Material, React Select, Ant Design, Ext JS, and other custom components.

window.__sentinelUtils = window.__sentinelUtils || {};
window.__sentinelUtils.dropdown = window.__sentinelUtils.dropdown || {};

(function() {
  function getErrorMessage(e) {
    if (typeof e === 'object' && e !== null && typeof e.message === 'string') return e.message;
    return String(e || '');
  }

  const dd = window.__sentinelUtils.dropdown;
  const dom = window.__sentinelUtils.dom || {};
  const wait = window.__sentinelUtils.wait || {};
  const shadow = window.__sentinelUtils.shadow || {};

  // ========== Open Dropdown ==========
  /**
   * Open a custom dropdown by clicking the trigger element, then poll for option elements.
   * @param {Document} doc - The document context.
   * @param {HTMLElement} triggerEl - The dropdown trigger element to click.
   * @returns {Promise<Element[]|null>} Array of option elements, or null if opening failed within 3 s.
   */
  dd.openDropdown = async function(doc, triggerEl) {
    if (!triggerEl) return null;

    // Scroll trigger into view before clicking
    try { triggerEl.scrollIntoView({ behavior: 'instant', block: 'center' }); } catch { /* detached node */ }

    // Dispatch full mouse sequence consistent with existing click pattern
    const view = doc.defaultView;
    const mouseOpts = { bubbles: true, cancelable: true, composed: true, view: view };
    try {
      triggerEl.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
      triggerEl.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
      triggerEl.click();
      triggerEl.dispatchEvent(new MouseEvent('mouseout', mouseOpts));
    } catch { /* dispatch may fail on detached elements */ }

    // Poll for option elements to appear (100ms interval, 3s timeout)
    const POLL_INTERVAL = 100;
    const TIMEOUT = 3000;
    const startTime = Date.now();

    while (Date.now() - startTime < TIMEOUT) {
      if (wait.sleep) await wait.sleep(POLL_INTERVAL);
      const options = dd.findDropdownOptions(doc, triggerEl);
      if (options && options.length) {
        return options;
      }
    }

    return null; // Failed to open
  };

  // ========== Find Dropdown Options ==========
  /**
   * Find visible dropdown option elements after a dropdown has been opened.
   * Uses scoped lookup (ARIA controls/owns, parent climb) first, then falls back
   * to document-wide search including shadow roots.
   * @param {Document} doc - The document context.
   * @param {HTMLElement|null} triggerEl - The trigger element (used for scoping), or null.
   * @returns {Element[]} Array of visible option elements.
   */
  dd.findDropdownOptions = function(doc, triggerEl) {
    const options = [];
    const seen = new Set();

    function addUnique(el) {
      if (el && !seen.has(el)) {
        seen.add(el);
        options.push(el);
      }
    }

    function addAllFromContainer(container) {
      if (!container || typeof container.querySelectorAll !== 'function') return;
      // The container itself may be a listbox/menu — also count its direct option children
      try {
        const items = container.querySelectorAll(
          '[role="option"], [role="menuitem"], li, .option, .dropdown-item, .menu-item, .select-option'
        );
        if (typeof items.forEach === 'function') {
          items.forEach(addUnique);
        }
      } catch { /* invalid selector */ }
    }

    // ===== Scoped lookup (#22) =====
    // Try to scope to the trigger first so two open dropdowns don't bleed options.
    if (triggerEl && triggerEl.getAttribute) {
      // 1a. aria-controls / aria-owns reference an explicit listbox/menu by id.
      const controlsId = triggerEl.getAttribute('aria-controls');
      if (controlsId) {
        try {
          const controlled = doc.getElementById(controlsId);
          if (controlled) addAllFromContainer(controlled);
        } catch (e) { console.warn('[Sentinel] aria-controls lookup:', getErrorMessage(e)); }
      }
      const ownsId = triggerEl.getAttribute('aria-owns');
      if (ownsId) {
        try {
          const owned = doc.getElementById(ownsId);
          if (owned) addAllFromContainer(owned);
        } catch (e) { console.warn('[Sentinel] aria-owns lookup:', getErrorMessage(e)); }
      }

      // 1b. If we got nothing yet, climb the DOM looking for a parent that contains
      // a [role="listbox"] / [role="menu"] / [role="combobox"] descendant.
      if (options.length === 0) {
        try {
          let cursor = triggerEl.parentElement;
          let depth = 0;
          while (cursor && depth < 8) {
            const localContainers = cursor.querySelectorAll(
              '[role="listbox"], [role="menu"], [role="combobox"]'
            );
            if (localContainers.length && typeof localContainers.forEach === 'function') {
              localContainers.forEach(addAllFromContainer);
              if (options.length) break;
            }
            cursor = cursor.parentElement;
            depth++;
          }
        } catch (e) { console.warn('[Sentinel] parent container climb:', getErrorMessage(e)); }
      }
    }

    // If scoped lookup found options, return them now (skip doc-wide).
    if (options.length) {
      return options.filter(function(el) { return dom.isVisible && dom.isVisible(el); });
    }

    // ===== Fallback: doc-wide lookup =====
    // 2. ARIA pattern: role="option"
    let found = doc.querySelectorAll('[role="option"]');
    if (typeof found.forEach === 'function') {
      found.forEach(addUnique);
    }

    // Also check role="listbox" > role="option" (more specific)
    found = doc.querySelectorAll('[role="listbox"] [role="option"]');
    if (typeof found.forEach === 'function') {
      found.forEach(addUnique);
    }

    // 3. Common dropdown containers
    const containerSelectors = [
      '.dropdown-menu', '.select-options', '.menu',
      '[role="menu"]', '.autocomplete-list',
      '[role="listbox"]', '.dropdown-list', '.options-list',
      '.combo-box-list', '.select-list'
    ];
    for (const sel of containerSelectors) {
      try {
        found = doc.querySelectorAll(sel);
        if (typeof found.forEach === 'function') {
          found.forEach(addAllFromContainer);
        }
      } catch { /* invalid selector */ }
    }

    // 4. Siblings/children of trigger
    if (triggerEl) {
      const parent = triggerEl.parentElement;
      if (parent) {
        const siblingItems = parent.querySelectorAll(
          'li, [role="option"], .option, .dropdown-item, .menu-item'
        );
        if (typeof siblingItems.forEach === 'function') {
          siblingItems.forEach(addUnique);
        }
      }
    }

    // 5. Search inside shadow roots via queryDeep
    if (shadow && shadow.queryDeep) {
      const shadowOptions = shadow.queryDeep(doc, '[role="option"]');
      if (typeof shadowOptions.forEach === 'function') {
        shadowOptions.forEach(addUnique);
      }

      const shadowMenuItems = shadow.queryDeep(doc, '[role="menuitem"]');
      if (typeof shadowMenuItems.forEach === 'function') {
        shadowMenuItems.forEach(addUnique);
      }
    }

    // Filter by visibility
    return options.filter(function(el) {
      return dom.isVisible && dom.isVisible(el);
    });
  };

  // ========== Select Dropdown Option ==========
  /**
   * Select a specific option from an open dropdown by matching its visible text.
   * Matching priority: exact text → value attribute → starts-with → whole word → partial.
   * For large option lists (≥ 50), falls back to a search-input typing strategy.
   * @param {Document} doc - The document context.
   * @param {Element[]} optionEls - Array of option elements returned by findDropdownOptions.
   * @param {string} value - The text to match against option labels.
   * @returns {Promise<Element|null>} The clicked option element, or null if no match.
   */
  dd.selectDropdownOption = async function(doc, optionEls, value) {
    if (!optionEls || optionEls.length === 0) return null;
    if (!value && value !== '') return null;

    const valueLower = value.toLowerCase().trim();

    // Priority matching: exact > starts-with > word boundary > partial (most specific first)
    let matchedEl = null;
    // 1. Exact match (highest priority)
    for (const opt of optionEls) {
      const optText = (opt.innerText || opt.textContent || '').trim().toLowerCase();
      if (optText === valueLower) { matchedEl = opt; break; }
    }
    // 2. Exact match against option value attribute
    if (!matchedEl) {
      for (const opt of optionEls) {
        if (opt.value && opt.value.toLowerCase().trim() === valueLower) { matchedEl = opt; break; }
      }
    }
    // 3. Starts with (word boundary)
    if (!matchedEl) {
      for (const opt of optionEls) {
        const optText = (opt.innerText || opt.textContent || '').trim().toLowerCase();
        if (optText.startsWith(`${valueLower} `) || optText.startsWith(valueLower) && (optText.length === valueLower.length || optText[valueLower.length] === ' ')) {
          matchedEl = opt; break;
        }
      }
    }
    // 4. Contains as whole word
    if (!matchedEl) {
      const wordRegex = new RegExp(`\\b${valueLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      for (const opt of optionEls) {
        const optText = (opt.innerText || opt.textContent || '').trim();
        if (wordRegex.test(optText)) { matchedEl = opt; break; }
      }
    }
    // 5. Partial contains (fallback — least specific)
    if (!matchedEl) {
      for (const opt of optionEls) {
        const optText = (opt.innerText || opt.textContent || '').trim().toLowerCase();
        if (optText.includes(valueLower)) { matchedEl = opt; break; }
      }
    }

    // If no match and large list, try search input strategy
    if (!matchedEl && optionEls.length >= 50) {
      const searchInput = dd._findSearchInput(doc, optionEls);
      if (searchInput) {
        searchInput.focus();
        searchInput.value = '';
        searchInput.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        for (const char of value) {
          const proto = searchInput.tagName === 'TEXTAREA'
            ? (doc.defaultView && doc.defaultView.HTMLTextAreaElement && doc.defaultView.HTMLTextAreaElement.prototype)
            : (doc.defaultView && doc.defaultView.HTMLInputElement && doc.defaultView.HTMLInputElement.prototype);
          const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
          const nativeSetter = descriptor && descriptor.set;
          if (nativeSetter) {
            nativeSetter.call(searchInput, searchInput.value + char);
          } else {
            searchInput.value = searchInput.value + char;
          }
          searchInput.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: char }));
        }
        // Wait for filtered results
        if (wait.sleep) await wait.sleep(300);
        const filteredOptions = dd.findDropdownOptions(doc, null);
        for (const opt of filteredOptions) {
          const optText = (opt.innerText || opt.textContent || '').trim().toLowerCase();
          if (optText === valueLower || optText.includes(valueLower)) {
            matchedEl = opt;
            break;
          }
        }
      }
    }

    if (!matchedEl) return null;

    // Scroll option into view and click
    try { matchedEl.scrollIntoView({ behavior: 'instant', block: 'center' }); } catch { /* detached */ }
    const view = doc.defaultView;
    const mouseOpts = { bubbles: true, cancelable: true, composed: true, view: view };
    try {
      matchedEl.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
      matchedEl.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
      matchedEl.click();
      matchedEl.dispatchEvent(new MouseEvent('mouseout', mouseOpts));
    } catch { /* dispatch may fail on detached elements */ }

    return matchedEl;
  };

  // ========== Traverse Nested Menu ==========
  /**
   * Traverse a nested hover/click menu structure by following a path of labels.
   * @param {Document} doc - The document context.
   * @param {string[]} menuPath - Ordered labels to follow, e.g. ["Settings", "Security", "Firewall"].
   * @returns {Promise<Element|null>} The final clicked element, or null if any level failed.
   */
  dd.traverseNestedMenu = async function(doc, menuPath) {
    if (!menuPath || menuPath.length === 0) return null;

    const view = doc.defaultView;
    let currentEl = null;
    const menuPathLen = menuPath.length;

    for (let level = 0; level < menuPathLen; level++) {
      const targetText = menuPath[level].toLowerCase().trim();
      const isLastLevel = level === menuPathLen - 1;

      // Find menu item matching the text at this level
      const menuItems = dd.findDropdownOptions(doc, currentEl);
      let matchedItem = null;
      for (const item of menuItems) {
        const itemText = (item.innerText || item.textContent || '').trim().toLowerCase();
        if (itemText === targetText || itemText.includes(targetText)) {
          matchedItem = item;
          break;
        }
      }

      if (!matchedItem) return null;

      currentEl = matchedItem;

      if (isLastLevel) {
        // Final item: click it
        try { matchedItem.scrollIntoView({ behavior: 'instant', block: 'center' }); } catch { /* detached */ }
        const mouseOpts = { bubbles: true, cancelable: true, composed: true, view: view };
        try {
          matchedItem.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
          matchedItem.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
          matchedItem.click();
          matchedItem.dispatchEvent(new MouseEvent('mouseout', mouseOpts));
        } catch { /* dispatch may fail */ }
        return matchedItem;
      }

      // Not the last level: hover to reveal submenu
      try { matchedItem.scrollIntoView({ behavior: 'instant', block: 'center' }); } catch { /* detached */ }
      try {
        matchedItem.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, composed: true, view: view }));
        matchedItem.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, composed: true }));
      } catch { /* dispatch may fail */ }

      // Wait for submenu to appear (300ms hover delay, up to 500ms total)
      if (wait.sleep) await wait.sleep(300);

      // Check if submenu appeared
      const subItems = dd.findDropdownOptions(doc, matchedItem);
      if (subItems.length === 0) {
        // Fallback: try clicking instead of hovering
        try {
          matchedItem.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true, view: view }));
          matchedItem.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, composed: true, view: view }));
          matchedItem.click();
        } catch { /* dispatch may fail */ }
        if (wait.sleep) await wait.sleep(200);

        // Check again after click
        const clickSubItems = dd.findDropdownOptions(doc, matchedItem);
        if (clickSubItems.length === 0) return null; // Submenu never appeared
      }
    }
  };

  // ========== Is Custom Dropdown ==========
  // Heuristic to detect if an element is a custom dropdown trigger (not a native <select>).
  dd.isCustomDropdown = function(el) {
    if (!el) return false;
    // Skip native select elements
    if (el.tagName === 'SELECT') return false;

    // ARIA combobox
    if (el.getAttribute('role') === 'combobox') return true;
    // ARIA button with haspopup
    const _hasPopup = el.getAttribute('aria-haspopup');
    if (el.getAttribute('role') === 'button' && _hasPopup) return true;
    if (/^(listbox|menu)$/.test(_hasPopup)) return true;

    // Check class names for common dropdown patterns
    // SVG elements have SVGAnimatedString for className, not a plain string
    let className = '';
    try {
      className = (typeof el.className === 'string') ? el.className : (el.className && el.className.baseVal) || '';
    } catch (e) { console.warn('[Sentinel] className access:', getErrorMessage(e)); }
    className = className.toLowerCase();
    if (/dropdown|combobox|select|picker/.test(className)) {
      return true;
    }

    // Check for nearby dropdown containers
    try {
      const parent = el.parentElement;
      if (parent) {
        // Check siblings for dropdown menu containers
        const siblingContainers = parent.querySelectorAll(
          '[role="listbox"], [role="option"], .dropdown-menu, .select-options, .menu'
        );
        if (siblingContainers.length) return true;

        // Check children
        const childContainers = el.querySelectorAll(
          '.dropdown-menu, .select-options'
        );
        if (childContainers.length) return true;
      }
    } catch { /* querySelectorAll may fail on detached elements */ }

    return false;
  };

  // ========== Dismiss Dropdown ==========
  // Closes any open dropdown by pressing Escape or clicking outside.
  dd.dismissDropdown = function(doc) {
    if (!doc) return false;

    // Check if a dropdown is visibly open
    let openDropdowns;
    try {
      openDropdowns = doc.querySelectorAll(
      '.dropdown-menu:not([style*="display: none"]), .select-options:not([style*="display: none"]), ' +
      '[role="listbox"]:not([style*="display: none"]), [role="menu"]:not([style*="display: none"])'
    );
    } catch { return false; }

    let wasOpen = false;
    if (typeof openDropdowns.forEach === 'function') {
      openDropdowns.forEach(function(dropdown) {
        if (dom.isVisible && dom.isVisible(dropdown)) {
          wasOpen = true;
        }
      });
    }

    // Press Escape to dismiss — full keydown + keypress + keyup sequence (#23)
    try {
      const activeEl = doc.activeElement || doc.body;
      const escOpts = {
        key: 'Escape', code: 'Escape', keyCode: 27, which: 27,
        bubbles: true, cancelable: true, composed: true
      };
      activeEl.dispatchEvent(new KeyboardEvent('keydown', escOpts));
      activeEl.dispatchEvent(new KeyboardEvent('keypress', escOpts));
      activeEl.dispatchEvent(new KeyboardEvent('keyup', escOpts));
    } catch { /* dispatch may fail */ }

    return wasOpen;
  };

  // ========== Internal: Find Search Input ==========
  // Looks for a search/filter input within the dropdown container.
  dd._findSearchInput = function(doc, optionEls) {
    // Look for an input near the first option
    if (optionEls && optionEls.length) {
      const firstOption = optionEls[0];
      try {
        const container = firstOption.closest('[role="listbox"], .dropdown-menu, .select-options, .menu, .autocomplete-list');
        if (container) {
          const searchInput = container.querySelector('input[type="text"], input[type="search"], input[placeholder*="search" i], input[placeholder*="filter" i]');
          if (searchInput) return searchInput;
        }
      } catch { /* closest may fail on detached elements */ }
    }

    // Look for any visible search input that appeared recently
    const searchInputs = doc.querySelectorAll(
      'input[type="text"], input[type="search"], input[placeholder*="search" i], input[placeholder*="filter" i]'
    );
    for (const input of searchInputs) {
      if (dom.isVisible && dom.isVisible(input)) return input;
    }

    return null;
  };
})();

