// Sentinel Override v3 -- Overlay/Modal Detector
// Modal, dialog, cookie banner detection heuristics and systematic dismissal patterns.
// Reactive overlay checking: only checks when an action is about to be performed.

window.__sentinelUtils = window.__sentinelUtils || {};
window.__sentinelUtils.overlay = window.__sentinelUtils.overlay || {};

(function() {
  const ov = window.__sentinelUtils.overlay;
  const dom = window.__sentinelUtils && window.__sentinelUtils.dom;
  const shadow = window.__sentinelUtils && window.__sentinelUtils.shadow;

  // ========== Cookie Banner Patterns ==========
  const COOKIE_SELECTORS = [
    '.cookie-banner', '.cookie-notice', '.cookie-consent', '.cookie-popup',
    '.consent-popup', '.consent-banner', '.consent-bar',
    '#onetrust-banner', '#onetrust-pc-sdk', '#cookie-notice', '#cookie-banner',
    '#cookie-consent', '#cc-banner', '#CybotCookiebotDialog',
    '[class*="cookie" i]', '[id*="cookie" i]',
    '[class*="consent" i]', '[id*="consent" i]'
  ];

  const MIN_BLOCKING_Z_INDEX = 1000;
  const VIEWPORT_COVERAGE_THRESHOLD = 0.8;

  // Precompile regex for dismiss button text matching (hot path in overlay detection)
  const DISMISS_TEXT_RE = /^(close|dismiss|accept|ok|got it|agree|yes|continue|understood)$/i;

  // ========== Detect Overlay ==========
  /**
   * Checks for modals, dialogs, cookie banners blocking the page.
   * Uses multiple heuristics: ARIA modal detection, role dialog checking,
   * high z-index overlay detection, and viewport coverage analysis.
   * @param {Document} doc - The document to check for overlays.
   * @returns {Element|null} The blocking overlay element, or null if none found.
   */
  ov.detectOverlay = function(doc) {
    if (!doc) return null;

    // 1. ARIA modal
    const ariaModals = doc.querySelectorAll('[aria-modal="true"]');
    for (let i = 0, ariaLen = ariaModals.length; i < ariaLen; i++) {
      if (dom && dom.isVisible(ariaModals[i])) return ariaModals[i];
    }

    // Also search in shadow DOM
    if (shadow && shadow.queryDeep) {
      const shadowModals = shadow.queryDeep(doc, '[aria-modal="true"]');
      for (let i = 0, shadowModalLen = shadowModals.length; i < shadowModalLen; i++) {
        if (dom && dom.isVisible(shadowModals[i])) return shadowModals[i];
      }
    }

    // 2. Role dialog / alertdialog
    const dialogSelectors = '[role="dialog"], [role="alertdialog"]';
    const dialogs = doc.querySelectorAll(dialogSelectors);
    for (let i = 0, dialogLen = dialogs.length; i < dialogLen; i++) {
      if (dom && dom.isVisible(dialogs[i])) return dialogs[i];
    }

    // Shadow DOM dialogs
    if (shadow && shadow.queryDeep) {
      const shadowDialogs = shadow.queryDeep(doc, dialogSelectors);
      for (let i = 0, shadowDialogLen = shadowDialogs.length; i < shadowDialogLen; i++) {
        if (dom && dom.isVisible(shadowDialogs[i])) return shadowDialogs[i];
      }
    }

    // 3. High z-index fixed/absolute overlays
    const candidates = doc.querySelectorAll('div, section');
    for (let i = 0, candLen = candidates.length; i < candLen; i++) {
      const el = candidates[i];
      try {
        const view = doc.defaultView;
        if (!view) continue;
        const style = view.getComputedStyle(el);
        if (style.position !== 'fixed' && style.position !== 'absolute') continue;
        const zIndex = parseInt(style.zIndex, 10);
        if (Number.isNaN(zIndex) || zIndex <= MIN_BLOCKING_Z_INDEX) continue;
        if (style.pointerEvents === 'none') continue;
        const rect = el.getBoundingClientRect();
        const viewportW = view.innerWidth || doc.documentElement.clientWidth;
        const viewportH = view.innerHeight || doc.documentElement.clientHeight;
        // Check if overlay covers most of the viewport
        if (rect.width >= viewportW * VIEWPORT_COVERAGE_THRESHOLD && rect.height >= viewportH * VIEWPORT_COVERAGE_THRESHOLD) {
          if (dom && dom.isVisible(el)) return el;
        }
      } catch {
        continue;
      }
    }

    // 4. Cookie banners
    for (let i = 0, cookieSelLen = COOKIE_SELECTORS.length; i < cookieSelLen; i++) {
      try {
        const cookieEls = doc.querySelectorAll(COOKIE_SELECTORS[i]);
        for (let j = 0, cookieLen = cookieEls.length; j < cookieLen; j++) {
          if (dom && dom.isVisible(cookieEls[j])) return cookieEls[j];
        }
      } catch {
        // Invalid selector, skip
      }
    }

    // Cookie banners in shadow DOM
    if (shadow && shadow.queryDeep) {
      const cookieShadowSels = ['.cookie-banner', '#onetrust-banner', '#cookie-notice', '.consent-popup'];
      for (let i = 0, shadowSelLen = cookieShadowSels.length; i < shadowSelLen; i++) {
        const shadowCookies = shadow.queryDeep(doc, cookieShadowSels[i]);
        for (let j = 0, shadowCookieLen = shadowCookies.length; j < shadowCookieLen; j++) {
          if (dom && dom.isVisible(shadowCookies[j])) return shadowCookies[j];
        }
      }
    }

    return null;
  };

  // ========== Dismiss Overlay ==========
  /**
   * Attempts to dismiss a detected overlay using systematic close patterns.
   * Tries multiple strategies: close buttons (ARIA labels), cookie accept buttons,
   * text-matched dismiss buttons, and Escape key simulation.
   * @param {Document} doc - The document containing the overlay.
   * @param {Element} overlay - The overlay element to dismiss.
   * @returns {boolean} True if the overlay was successfully dismissed (removed from DOM or hidden).
   */
  ov.dismissOverlay = function(doc, overlay) {
    if (!doc || !overlay) return false;

    // 0. Escape key first — fastest path for enterprise modal dialogs (M365, Azure, etc.)
    const activeEl = doc.activeElement || doc.body || doc.documentElement;
    const escOpts = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true, composed: true };
    if (!activeEl) return false;
    activeEl.dispatchEvent(new KeyboardEvent('keydown', escOpts));
    activeEl.dispatchEvent(new KeyboardEvent('keypress', escOpts));
    activeEl.dispatchEvent(new KeyboardEvent('keyup', escOpts));
    if (!(doc.body && doc.body.contains(overlay)) || !(dom && dom.isVisible(overlay))) {
      return true;
    }

    // 1. Close buttons (ARIA labels)
    const closeSelectors = [
      '[aria-label="Close" i]', '[aria-label="Dismiss" i]',
      'button.close', '.close-btn', '.modal-close', '.close-button',
      '[data-dismiss="modal"]', '[data-dismiss="dialog"]',
      '.btn-close', '[aria-label="Close dialog" i]',
      '[aria-label="Close this dialog" i]'
    ];

    for (let i = 0, closeSelLen = closeSelectors.length; i < closeSelLen; i++) {
      try {
        const closeBtns = overlay.querySelectorAll(closeSelectors[i]);
        for (let j = 0, closeBtnLen = closeBtns.length; j < closeBtnLen; j++) {
          if (!dom || !dom.isVisible(closeBtns[j])) continue;
          closeBtns[j].click();
          closeBtns[j].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true }));
          closeBtns[j].dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, composed: true }));
          closeBtns[j].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
          if (!(doc.body && doc.body.contains(overlay)) || !(dom && dom.isVisible(overlay))) {
            return true;
          }
        }
      } catch {
        continue;
      }
    }

    // 2. Cookie accept buttons
    const acceptSelectors = [
      '.cookie-banner .accept', '.cookie-banner .accept-btn',
      '.consent-btn', '.accept-all', '.btn-accept',
      '#onetrust-accept-btn-handler', '#accept-cookie',
      'button[class*="accept" i]', 'button[id*="accept" i]',
      'a[class*="accept" i]', 'a[id*="accept" i]'
    ];

    for (let i = 0, acceptSelLen = acceptSelectors.length; i < acceptSelLen; i++) {
      try {
        const acceptBtns = overlay.querySelectorAll(acceptSelectors[i]);
        for (let j = 0, acceptBtnLen = acceptBtns.length; j < acceptBtnLen; j++) {
          if (!dom || !dom.isVisible(acceptBtns[j])) continue;
          acceptBtns[j].click();
          acceptBtns[j].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true }));
          acceptBtns[j].dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, composed: true }));
          acceptBtns[j].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
          if (!(doc.body && doc.body.contains(overlay)) || !(dom && dom.isVisible(overlay))) {
            return true;
          }
        }
      } catch {
        continue;
      }
    }

    // 3. Text match: buttons/links with dismiss text
    const clickableEls = overlay.querySelectorAll('button, a, [role="button"]');
    for (let i = 0, clickableLen = clickableEls.length; i < clickableLen; i++) {
      const el = clickableEls[i];
      if (!dom || !dom.isVisible(el)) continue;
      const text = (el.innerText || el.textContent || '').trim();
      if (DISMISS_TEXT_RE.test(text)) {
        el.click();
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, composed: true }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
        if (!(doc.body && doc.body.contains(overlay)) || !(dom && dom.isVisible(overlay))) {
          return true;
        }
      }
    }

    // 4. Backdrop click — click outside the overlay bounds as a last resort
    try {
      const rect = overlay.getBoundingClientRect();
      const outsideX = rect.right + 10;
      const outsideY = rect.bottom + 10;
      const clickOpts = { clientX: outsideX, clientY: outsideY, bubbles: true, cancelable: true, composed: true };
      if (!doc.body) throw new Error('no body');
      doc.body.dispatchEvent(new MouseEvent('mousedown', clickOpts));
      doc.body.dispatchEvent(new MouseEvent('mouseup', clickOpts));
      doc.body.dispatchEvent(new MouseEvent('click', clickOpts));
      if (!(doc.body && doc.body.contains(overlay)) || !(dom && dom.isVisible(overlay))) {
        return true;
      }
    } catch { /* backdrop click failed */ }

    return false;
  };

  // ========== Is Overlay Blocking ==========
  /**
   * Check if a specific target element is obscured by an overlay.
   * Uses elementFromPoint with the target's center coordinates to determine
   * if another element is blocking interaction with the target.
   * @param {Document} doc - The document containing the elements.
   * @param {Element} targetEl - The target element to check for blocking.
   * @returns {Element|null} The blocking element if found, or null if not blocked.
   */
  ov.isOverlayBlocking = function(doc, targetEl) {
    if (!doc || !targetEl) return null;

    try {
      const rect = targetEl.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      // Check if target is even in the viewport
      const view = doc.defaultView;
      if (!view) return null;
      if (centerX < 0 || centerY < 0 || centerX > view.innerWidth || centerY > view.innerHeight) {
        return null;
      }

      const topElement = doc.elementFromPoint(centerX, centerY);
      if (!topElement) return null;

      // If the topmost element IS the target (or a child of it), not blocked
      if (topElement === targetEl || targetEl.contains(topElement)) {
        return null;
      }

      // Something is on top -- check if it looks like an overlay
      if (topElement !== doc.body && topElement !== doc.documentElement) {
        return topElement;
      }

      return null;
    } catch {
      return null;
    }
  };
})();
