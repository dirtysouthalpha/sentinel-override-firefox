// Sentinel Override v3 -- Virtual Operator Cursor
// A persistent, animated cursor that visibly travels to action targets BEFORE
// the action fires. Pairs with the existing highlight + click-pulse system to
// give users the "watching a real operator" feel on BOTH the synthetic-events
// path AND the CDP trusted-input path. The CDP path historically had no
// visual feedback because it dispatches mouse/key events at the browser level
// and never reaches the content script -- a message hook from tab-manager.js
// (`cdp_pre_click_visual`, `cdp_typing_progress`) drives this module.
//
// (3.8.1) Hardened against SPA reconciliation:
//   - Attaches to documentElement (not body) so React/Lit body rewrites
//     can't orphan the cursor element.
//   - MutationObserver watches for cursor removal and re-creates immediately
//     so frameworks that prune unknown DOM nodes don't kill us.
//   - "keepVisible" mode: when an agent is running, cursor stays at full
//     opacity between actions instead of fading out — so users always see
//     where the operator is, even during idle thinking time.

window.__sentinelUtils = window.__sentinelUtils || {};

(function() {
  // Idempotency guard — content script may inject multiple times across SPA
  // navigations. Keep the existing cursor instance.
  if (window.__sentinelCursor && window.__sentinelCursor.__initialized) return;

  const CURSOR_ID = '__sentinel_cursor__';
  const STYLE_ID = '__sentinel_cursor_style__';
  const HIDE_AFTER_MS = 12000;
  const DEFAULT_TRAVEL_MS = 380;

  function getErrorMessage(e) {
    if (typeof e === 'object' && e !== null && typeof e.message === 'string') return e.message;
    return String(e || '');
  }

  let lastX = -1;
  let lastY = -1;
  let hideTimer = null;
  let keepVisibleMode = true;  // (3.8.1) on by default — show always when content script loads
  let observer = null;

  function ensureStyle() {
    try {
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent =
        `#${CURSOR_ID} {` +
          `position: fixed !important;` +
          `z-index: 2147483647 !important;` +
          `pointer-events: none !important;` +
          `width: 48px !important;` +
          `height: 48px !important;` +
          `transform: translate(-6px, -3px);` +
          `transition: left 380ms cubic-bezier(0.4, 0, 0.2, 1),` +
          `            top 380ms cubic-bezier(0.4, 0, 0.2, 1),` +
          `            opacity 200ms ease;` +
          `opacity: 1 !important;` +
          `will-change: left, top, opacity;` +
          `isolation: isolate;` +
          `contain: layout style;` +
          `filter: drop-shadow(0 0 6px #ff0000) drop-shadow(0 0 12px #ff4444) !important;` +
          `animation: sentinelCursorBreathe 2.4s ease-in-out infinite;` +
        `}` +
        `#${CURSOR_ID}.dimmed { opacity: 0 !important; }` +
        `#${CURSOR_ID} .sentinel-cursor-halo {` +
          `position: absolute;` +
          `top: 50%;` +
          `left: 50%;` +
          `width: 40px;` +
          `height: 40px;` +
          `border-radius: 50%;` +
          `background: radial-gradient(circle, rgba(255,107,0,0.55) 0%, rgba(255,107,0,0) 72%);` +
          `transform: translate(-50%, -50%);` +
          `transition: width 180ms ease, height 180ms ease, background 180ms ease;` +
        `}` +
        `#${CURSOR_ID}.pressing .sentinel-cursor-halo {` +
          `width: 24px;` +
          `height: 24px;` +
          `background: radial-gradient(circle, rgba(255,68,68,0.75) 0%, rgba(255,68,68,0) 72%);` +
        `}` +
        `#${CURSOR_ID} svg {` +
          `position: relative;` +
          `z-index: 1;` +
          `filter: drop-shadow(0 2px 4px rgba(0,0,0,0.55)) drop-shadow(0 0 6px rgba(255,107,0,0.5));` +
        `}` +
        `@keyframes sentinelCursorBreathe {` +
          `0%, 100% { filter: drop-shadow(0 0 4px rgba(255,107,0,0.45)); }` +
          `50% { filter: drop-shadow(0 0 12px rgba(255,107,0,0.85)); }` +
        `}` +
        `@keyframes sentinelCursorPress {` +
          `0% { transform: translate(-4px, -2px) scale(1); }` +
          `50% { transform: translate(-4px, -2px) scale(0.78); }` +
          `100% { transform: translate(-4px, -2px) scale(1); }` +
        `}` +
        `#${CURSOR_ID}.pressing {` +
          `animation: sentinelCursorPress 220ms ease-out;` +
        `}`;
      // (3.8.1) Append to documentElement so a body wipe doesn't kill us.
      (document.head || document.documentElement).appendChild(style);
    } catch { /* non-fatal */ }
  }

  function ensureCursor() {
    try {
      let c = document.getElementById(CURSOR_ID);
      // (3.8.1) Element might exist but be detached (React reconciliation).
      // If it's not currently in the document, drop it and rebuild.
      if (c && !c.isConnected) {
        try { c.remove(); } catch (e) { console.warn('[Sentinel] cursor remove detached:', getErrorMessage(e)); }
        c = null;
      }
      if (c) return c;

      ensureStyle();

      if (lastX < 0 || lastY < 0) {
        lastX = (window.innerWidth || 800) / 2;
        lastY = (window.innerHeight || 600) / 2;
      }

      c = document.createElement('div');
      c.id = CURSOR_ID;
      c.setAttribute('data-sentinel', 'cursor');
      c.style.left = `${lastX}px`;
      c.style.top = `${lastY}px`;
      c.innerHTML =
        `<div class="sentinel-cursor-halo"></div>` +
        `<svg width="22" height="24" viewBox="0 0 22 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
          `<path d="M3 2 L3 18 L7 14 L10 21 L13 20 L10 13 L17 13 Z"` +
                ` fill="#ff6b00" stroke="#ffffff" stroke-width="1.4" stroke-linejoin="round"/>` +
        `</svg>`;

      // (3.8.1) Attach to documentElement (the <html> node), NOT body.
      // documentElement is far less likely to be replaced/rewritten by the
      // page's framework, so the cursor survives SPA reconciliation.
      const root = document.documentElement || document.body || document;
      const appendNow = () => {
        try { root.appendChild(c); }
        catch (e) {
          console.warn('[Sentinel] ensureCursor failed', e);
          // Fallback: try body
          try { (document.body || document).appendChild(c); } catch (e2) { console.warn('[Sentinel] cursor element append fallback failed:', getErrorMessage(e2)); }
        }
      };

      if (document.documentElement) {
        appendNow();
      } else {
        const id = setInterval(() => {
          if (document.documentElement) { clearInterval(id); appendNow(); }
        }, 30);
        setTimeout(() => clearInterval(id), 5000);
      }

      installRemovalObserver();
      return c;
    } catch { return null; }
  }

  // (3.8.1) Re-create the cursor immediately if a framework prunes it.
  function installRemovalObserver() {
    if (observer) return;
    try {
      observer = new MutationObserver((_mutations) => {
        // Only act if the cursor was actually removed.
        const c = document.getElementById(CURSOR_ID);
        if (c && c.isConnected) return;
        // Re-create on next animation frame so we don't fight an ongoing
        // reconciliation pass.
        requestAnimationFrame(() => {
          try { ensureCursor(); } catch (e) { console.warn('[Sentinel] cursor recreate on mutation:', getErrorMessage(e)); }
        });
      });
      const target = document.documentElement || document.body;
      if (target) {
        observer.observe(target, { childList: true, subtree: true });
      }
    } catch { /* MutationObserver unavailable in some test contexts */ }
  }

  function scheduleAutoHide() {
    if (keepVisibleMode) return;  // (3.8.1) skip auto-hide while a run is active
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      try {
        const c = document.getElementById(CURSOR_ID);
        if (c) c.classList.add('dimmed');
      } catch (e) { console.warn('[Sentinel] cursor auto-hide dim:', getErrorMessage(e)); }
    }, HIDE_AFTER_MS);
  }

  // Clamp coordinates so the cursor sprite stays anchored on viewport edges
  // even if the agent points at something off-screen.
  function clamp(x, y) {
    const vw = window.innerWidth || 800;
    const vh = window.innerHeight || 600;
    return {
      x: Math.max(0, Math.min(vw - 1, x)),
      y: Math.max(0, Math.min(vh - 1, y))
    };
  }

  /**
   * @typedef {Object} SentinelCursor
   * @property {boolean} __initialized - Marker indicating the cursor has been initialized
   * @property {function(number, number, Object=): Promise<void>} moveTo - Moves cursor to coordinates
   * @property {function(Element, Object=): Promise<void>} moveToElement - Moves cursor to element center
   * @property {function(): void} press - Shows cursor press animation
   * @property {function(): void} show - Makes cursor visible
   * @property {function(): void} hide - Hides cursor (dims it)
   * @property {function(boolean): void} setKeepVisible - Controls whether cursor stays visible
   * @property {function(): {x: number, y: number}} getPosition - Gets current cursor position
   */

  /** @type {SentinelCursor} */
  window.__sentinelCursor = {
    __initialized: true,

    /**
     * Moves the virtual cursor to the specified viewport coordinates.
     * @param {number} x - Target X coordinate in viewport pixels
     * @param {number} y - Target Y coordinate in viewport pixels
     * @param {Object} [options] - Optional parameters
     * @param {number} [options.duration] - Animation duration in milliseconds (default: 380)
     * @returns {Promise<void>} Resolves when cursor animation completes
     */
    moveTo(x, y, options) {
      try {
        if (typeof x !== 'number' || typeof y !== 'number' || Number.isNaN(x) || Number.isNaN(y)) {
          return Promise.resolve();
        }
        const clamped = clamp(x, y);
        const c = ensureCursor();
        if (!c) return Promise.resolve();
        c.classList.remove('dimmed');
        c.style.left = `${clamped.x}px`;
        c.style.top = `${clamped.y}px`;
        lastX = clamped.x;
        lastY = clamped.y;
        scheduleAutoHide();
        const dur = (options && typeof options.duration === 'number')
          ? options.duration
          : DEFAULT_TRAVEL_MS;
        return new Promise(resolve => setTimeout(resolve, dur));
      } catch (e) {
        console.warn('[Sentinel] moveTo failed', e);
        return Promise.resolve();
      }
    },

    /**
     * Moves the virtual cursor to the center of the specified element.
     * @param {Element} el - Target DOM element
     * @param {Object} [options] - Optional parameters
     * @param {number} [options.duration] - Animation duration in milliseconds
     * @returns {Promise<void>} Resolves when cursor animation completes
     */
    moveToElement(el, options) {
      try {
        if (!el || typeof el.getBoundingClientRect !== 'function') {
          return Promise.resolve();
        }
        const r = el.getBoundingClientRect();
        if (!r || (r.width === 0 && r.height === 0)) return Promise.resolve();
        return this.moveTo(r.left + r.width / 2, r.top + r.height / 2, options);
      } catch (e) {
        console.warn('[Sentinel] moveToElement failed', e);
        return Promise.resolve();
      }
    },

    /**
     * Shows a "pressing" animation on the cursor to simulate mouse button press.
     * Adds a CSS class that visually indicates the press state for 240ms.
     * @returns {void}
     */
    press() {
      try {
        const c = ensureCursor();
        if (!c) return;
        c.classList.add('pressing');
        setTimeout(() => {
          try { c.classList.remove('pressing'); } catch (e) { console.warn('[Sentinel] cursor press cleanup:', getErrorMessage(e)); }
        }, 240);
      } catch (e) { console.warn('[Sentinel] cursor press:', getErrorMessage(e)); }
    },

    /**
     * Makes the virtual cursor visible by removing the dimmed state.
     * Also schedules auto-hide if keepVisible mode is off.
     * @returns {void}
     */
    show() {
      try {
        const c = ensureCursor();
        if (c) c.classList.remove('dimmed');
        scheduleAutoHide();
      } catch (e) { console.warn('[Sentinel] cursor show:', getErrorMessage(e)); }
    },

    /**
     * Hides the virtual cursor by adding the dimmed state.
     * Cancels any pending auto-hide timer.
     * @returns {void}
     */
    hide() {
      try {
        const c = document.getElementById(CURSOR_ID);
        if (c) c.classList.add('dimmed');
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      } catch (e) { console.warn('[Sentinel] cursor hide:', getErrorMessage(e)); }
    },

    /**
     * Controls whether the cursor stays visible during agent runs.
     * When enabled, the cursor won't auto-hide and will remain visible between actions.
     * @param {boolean} on - True to keep cursor visible, false to allow auto-hide
     * @returns {void}
     */
    setKeepVisible(on) {
      keepVisibleMode = !!on;
      if (on) {
        try { const c = document.getElementById(CURSOR_ID); if (c) c.classList.remove('dimmed'); } catch (e) { console.warn('[Sentinel] cursor keepVisible un-dim:', getErrorMessage(e)); }
      }
    },

    /**
     * Gets the current cursor position in viewport coordinates.
     * @returns {{x: number, y: number}} Current cursor position, or (-1, -1) if cursor not found
     */
    getPosition() {
      try {
        const c = document.getElementById(CURSOR_ID);
        if (!c || !c.isConnected) return { x: -1, y: -1 };
        // Try to access the style to verify the element is valid
        const _ = c.style;
        return { x: lastX, y: lastY };
      } catch (e) {

        return { x: -1, y: -1 };
      }
    }
  };

  window.__sentinelUtils.cursor = window.__sentinelCursor;

  // (3.8.1) Make the cursor visible immediately on script load.
  try {
    ensureCursor();
  } catch (e) { console.warn('[Sentinel/CURSOR] Init failed:', getErrorMessage(e)); }
})();
