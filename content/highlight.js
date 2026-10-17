// Sentinel Override v3 -- Highlight Utilities
// Element highlight/removeHighlight for visual feedback during action execution.
// Uses CSS class injection (not inline style mutation) to avoid corrupting user CSS on error.

window.__sentinelUtils = window.__sentinelUtils || {};
window.__sentinelUtils.highlight = window.__sentinelUtils.highlight || {};

(function() {
  const hl = window.__sentinelUtils.highlight;

  const STYLE_ID = '__sentinel_highlight_style__';
  const HIGHLIGHT_CLASS = 'sentinel-highlight';

  function ensureStyleInjected() {
    try {
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent =
        `.${HIGHLIGHT_CLASS} {
          outline: 3px solid #ff6b00 !important;
          outline-offset: 2px !important;
          box-shadow: 0 0 12px rgba(255,107,0,0.6) !important;
          transition: outline 0.15s ease !important;
        }`;
      // Append to head if available, else documentElement
      (document.head || document.documentElement).appendChild(style);
    } catch { /* non-fatal */ }
  }

  /**
   * Highlight a DOM element with an orange outline for visual feedback during
   * action execution. Injects a CSS class rather than inline styles to avoid
   * corrupting user CSS on error.
   * @param {HTMLElement} el - Element to highlight.
   */
  hl.highlightElement = function(el) {
    try {
      if (!el || !el.classList) return;
      ensureStyleInjected();
      el.classList.add(HIGHLIGHT_CLASS);
    } catch (e) { console.warn('[Sentinel] highlight element:', (typeof e === 'object' && e !== null && 'message' in e && typeof e.message === 'string' ? e.message : String(e))); }
  };

  /**
   * Remove the highlight CSS class from an element after a 500ms delay so the
   * user can see what was acted upon.
   * @param {HTMLElement} el - Element to remove highlight from.
   */
  hl.removeHighlight = function(el) {
    try {
      if (!el || !el.classList) return;
      // Keep highlight visible briefly so the user can see what was acted upon.
      setTimeout(() => {
        try { el.classList.remove(HIGHLIGHT_CLASS); } catch (e) { console.warn('[Sentinel] remove highlight class:', (typeof e === 'object' && e !== null && 'message' in e && typeof e.message === 'string' ? e.message : String(e))); }
      }, 500);
    } catch (e) { console.warn('[Sentinel] removeHighlight:', (typeof e === 'object' && e !== null && 'message' in e && typeof e.message === 'string' ? e.message : String(e))); }
  };
})();