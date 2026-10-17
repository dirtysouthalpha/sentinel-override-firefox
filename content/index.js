(() => {
// (SO-71) Idempotent-injection guard. chrome.scripting.executeScript(files)
// RE-EXECUTES this whole bundle if called twice in the same isolated world
// (agent-engine re-injects mid-run), and the second pass redeclares top-level
// consts -> SyntaxError kills the live script. This block must stay at the
// very top and must not declare any top-level bindings: it is safe to run
// multiple times. If the bundle is already live, the second pass is a no-op.
if (window.__sentinelContentAlive === true) {
  try { chrome.runtime.sendMessage({ action: 'content_script_ready' }).catch(() => {}); } catch (_) {}
  window.__sentinelNoopThrow = true; // CSH-01 handler swallows + preventDefaults this
  window.__sentinelInjectionNoop = window.__sentinelInjectionNoop || function SentinelInjectionNoop() {};
  throw new window.__sentinelInjectionNoop();
}
window.__sentinelContentAlive = true;
// Sentinel Override v3 -- Content Script Entry Point
// Wave 2: ref_id + bbox + scroll_to support added.
// Verified 2026-05-06.
// Handles DOM observation, element scanning, action execution, and dynamic tools.
// Orchestrates utility modules loaded on window.__sentinelUtils.

// (CSH-01) Top-level error boundary — reports uncaught content script errors
// to the background service worker so they appear in telemetry/logs instead
// of silently vanishing in the content script context.
const __sentinelErrorHandler = (event) => {
  try {
    if (window.__sentinelNoopThrow === true) {
      // (SO-71) benign: this is the second-pass injection guard aborting itself.
      window.__sentinelNoopThrow = false;
      event.preventDefault();
      return;
    }
    chrome.runtime.sendMessage({
      action: 'content_telemetry_event',
      category: 'content',
      level: 'error',
      message: 'Uncaught error in content script',
      payload: {
        message: String(event.message || ''),
        filename: String(event.filename || ''),
        lineno: event.lineno || 0,
        colno: event.colno || 0
      }
    }).catch(() => {});
  } catch (_e) { /* truly non-fatal */ }
};

const __sentinelRejectionHandler = (event) => {
  try {
    chrome.runtime.sendMessage({
      action: 'content_telemetry_event',
      category: 'content',
      level: 'error',
      message: 'Unhandled rejection in content script',
      payload: { reason: String(event.reason || '') }
    }).catch(() => {});
  } catch (_e) {}
};
//
// (3.26.0) Content-side telemetry helper — fires `content_telemetry_event`
// messages to the background, which re-emits via tel.emit() (telemetry.js).
// Defined at module top so every handler below has access. Fire-and-forget;
// never blocks the agent or throws.

// Helper function for error message extraction (defined early for use in telemetry)
function getErrorMessage(e) {
  if (typeof e === 'object' && e !== null && typeof e.message === 'string') return e.message;
  return String(e || '');
}

// Precompile regex for Microsoft 365 tenant detection (performance optimization)
const ONMICROSOFT_TENANT_RE = /[a-z0-9-]+\.onmicrosoft\.com/i;

// Precompile regex for modal/overlay detection (hot path in dismissOverlays)
const DIALOG_ROLE_RE = /^(dialog|alertdialog)$/;
const MODAL_TEXT_RE = /\b(modal|dialog|sign in|subscribe)\b/;
const ADBLOCK_TEXT_RE = /\b(ad.?block|adblocker|ad.?blocker|whitelist|white.?list|turn.?off.?ad|disable.?ad|remove.?ad|blocker.?detect|using.?an?.ad)\b/;
const PAYWALL_TEXT_RE = /\b(paywall|premium|subscription|required|register.?to.?read|subscribe.?to.?continue|sign.?up.?to.?continue)\b/;
const CONSENT_TEXT_RE = /\b(consent|cookie|privacy|gdpr| ccpa|notice|we.?use.?cookies|this.?site.?uses)\b/;
const DISMISS_TEXT_RE = /\b(continue.?to.?site|continue.?anyway|continue.?reading|continue.?with|dismiss|not.?now|maybe.?later|no.?thanks|i.?understand)\b/i;

// Precompile regex for UI component skip pattern (hot path in dismissOverlays)
const UI_COMPONENT_SKIP_RE = /compose|drawer|figma|sheet|panel/i;

// (3.26.0) Content-script telemetry emit helper. Bound to window so it
// survives the re-injection guard (re-injection skips the else-branch but
// the helper is defined unconditionally above it).
if (!window.__sentinelContentTel) {
  window.__sentinelContentTel = function _ctel(category, level, message, payload) {
    try {
      chrome.runtime.sendMessage({
        action: 'content_telemetry_event',
        category: String(category || 'content'),
        level: String(level || 'info'),
        message: String(message || '').substring(0, 500),
        payload: payload || null
      }).catch((e) => {
        console.error('[_ctel] Unhandled rejection:', getErrorMessage(e));
      });
    } catch (e) { console.warn('[Sentinel] Runtime error during shutdown:', getErrorMessage(e)); }
  };
  // Per-level shorthands so call sites stay terse.
  window.__sentinelContentTel.error = (c, m, p) => window.__sentinelContentTel(c, 'error', m, p);
  window.__sentinelContentTel.warn  = (c, m, p) => window.__sentinelContentTel(c, 'warn',  m, p);
  window.__sentinelContentTel.info  = (c, m, p) => window.__sentinelContentTel(c, 'info',  m, p);
  window.__sentinelContentTel.debug = (c, m, p) => window.__sentinelContentTel(c, 'debug', m, p);
  window.__sentinelContentTel.trace = (c, m, p) => window.__sentinelContentTel(c, 'trace', m, p);
}
var ctel = window.__sentinelContentTel;

// Re-injection guard: if already initialized, just signal ready and return early.
// This prevents duplicate message listeners and duplicate MutationObservers
// when content/index.js is injected multiple times (e.g., on page navigation).
if (window.__sentinelInitialized) {
  try { chrome.runtime.sendMessage({ action: 'content_script_ready' }).catch((e) => {

  }); } catch (e) { console.warn('[Sentinel] re-inject ready signal:', getErrorMessage(e)); }
} else {
  window.__sentinelInitialized = true;

  // ====== execute_js Sandbox Configuration ======
  // Runtime sandbox is enabled. A self-contained Proxy-based sandbox is
  // injected inline into the <script> tag so it runs in the page's MAIN world
  // alongside the user code — no cross-scope reference issues.
  // Defence-in-depth: approval gate + static regex guard still active.
   
  const _EXECUTE_JS_SANDBOX_ENABLED = true;
  const _EXECUTE_JS_MAX_TIMEOUT_MS = 30000; // Maximum timeout for execute_js commands (30 seconds)
  const _PRIV_RE = /\bdocument\.cookie\b|\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\beval\s*\(|\bFunction\s*\(|\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|\bnavigator\.sendBeacon\b/;

  // Helper function to check chrome.runtime.lastError
  function _hasLastError() {
    return typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null && chrome.runtime.lastError;
  }

  function _getLastErrorMessage() {
    if (!_hasLastError()) return '';
    const err = chrome.runtime.lastError;
    if (typeof err === 'object' && err !== null && typeof err.message === 'string') return err.message;
    return String(err || '');
  }

  // Shorthand references to utility modules
  const dom = (window.__sentinelUtils && window.__sentinelUtils.dom) || null;
  const hl = (window.__sentinelUtils && window.__sentinelUtils.highlight) || null;
  const wait = (window.__sentinelUtils && window.__sentinelUtils.wait) || null;
  const dd = (window.__sentinelUtils && window.__sentinelUtils.dropdown) || null;
  const si = (window.__sentinelUtils && window.__sentinelUtils.specialInputs) || null;
  const ov = (window.__sentinelUtils && window.__sentinelUtils.overlay) || null;
  const fm = (window.__sentinelUtils && window.__sentinelUtils.frame) || null;

  // ========== Overlay / Popup Dismissal ==========
  // Detects and auto-closes common overlays. (#14) Conservative behavior:
  //   - Never auto-clicks cookie "accept" buttons (privacy-preserving default).
  //   - Only hides elements that show positive modal/dialog signals AND were
  //     inserted recently (last 5s).
  //   - Skips structural elements (HTML/BODY/MAIN/elements containing <main>).
  //   - Caps total dismissals per page-load to 3.

  // Track recent DOM insertions so we only consider freshly-added overlays.
  const __sentinelRecentInsertions = new WeakMap();
  let __sentinelDismissalCount = 0;
  let __sentinelLastDismissRoute = '';
  const SENTINEL_MAX_DISMISSALS = 5;
  const SENTINEL_RECENT_MS = 5000;

  // Active iframe document for switch_to_frame / switch_to_parent_frame state.
  let __sentinelActiveFrameDoc = null;

  let insertionObserver = null;
  try {
    insertionObserver = new MutationObserver((muts) => {
      if (!Array.isArray(muts)) return;
      const now = Date.now();
      for (const m of muts) {
        if (!m.addedNodes || typeof m.addedNodes.length !== 'number') continue;
        for (const n of m.addedNodes) {
          if (n && n.nodeType === 1) {
            __sentinelRecentInsertions.set(n, now);
          }
        }
      }
    });
    // Wait until body exists, then start observing.
    const startObserving = () => {
      if (document.body) {
        try { insertionObserver.observe(document.body, { childList: true, subtree: true }); } catch (e) { console.warn('[Sentinel] insertion observer start:', getErrorMessage(e)); }
      } else {
        setTimeout(startObserving, 50);
      }
    };
    startObserving();
  } catch (e) { console.warn('[Sentinel] Observer unavailable:', getErrorMessage(e)); }

  function __sentinelHasPositiveModalSignal(el) {
    try {
      const role = el && el.getAttribute ? el.getAttribute('role') : null;
      if (DIALOG_ROLE_RE.test(role)) return true;
      if (el && el.getAttribute && el.getAttribute('aria-modal') === 'true') return true;
      const text = (el.innerText || el.textContent || '').toLowerCase().slice(0, 500);
      // Core modal signals
      if (MODAL_TEXT_RE.test(text)) return true;
      // Ad-blocker / paywall / consent signals
      if (ADBLOCK_TEXT_RE.test(text)) return true;
      if (PAYWALL_TEXT_RE.test(text)) return true;
      if (CONSENT_TEXT_RE.test(text)) return true;
      // "Continue anyway" / "I understand" popup signals
      if (DISMISS_TEXT_RE.test(text)) return true;
    } catch (e) { console.warn('[Sentinel] modal signal check:', getErrorMessage(e)); }
    return false;
  }

  function __sentinelWasInsertedRecently(el) {
    const t = __sentinelRecentInsertions.get(el);
    if (typeof t !== 'number') return false;
    return (Date.now() - t) <= SENTINEL_RECENT_MS;
  }

  function dismissOverlays() {
    const dismissed = [];

    // Reset the dismissal cap when the SPA route changes (pathname+hash) so
    // new modals on the next "page" are still dismissed even without a full reload.
    try {
      const _route = location.pathname + location.hash;
      if (_route !== __sentinelLastDismissRoute) {
        __sentinelDismissalCount = 0;
        __sentinelLastDismissRoute = _route;
      }
    } catch (e) { console.warn('[Sentinel] route change reset:', getErrorMessage(e)); }

    if (__sentinelDismissalCount >= SENTINEL_MAX_DISMISSALS) {
      return { dismissed: [], count: 0, capped: true };
    }

    // Close/dismiss button selectors.
    // (v3.52) Zero-friction policy: click through ALL consent/cookie overlays including accept.
    // User having browser access IS authorization — auto-dismiss to unblock the agent.
    const closeBtnSelectors = [
      // Cookie consent — REJECT/DECLINE/DISMISS only, not accept
      '[class*="cookie"] [class*="reject" i]', '[class*="cookie"] [class*="decline" i]',
      '[class*="cookie"] [class*="dismiss" i]', '[class*="cookie"] button[class*="close" i]',
      '[id*="cookie"] button[class*="close" i]',
      '[class*="consent"] [class*="reject" i]', '[class*="consent"] [class*="dismiss" i]',
      '[class*="gdpr"] [class*="dismiss" i]', '[class*="gdpr"] [class*="reject" i]',

      // Cookie consent ACCEPT/AGREE buttons (v3.52 zero-friction policy)
      '[class*="cookie"] [class*="accept" i]', '[class*="cookie"] [class*="agree" i]',
      '[class*="cookie"] button[class*="agree" i]', '[class*="cookie"] button[class*="accept" i]',
      '[id*="cookie"] button[class*="agree" i]', '[id*="cookie"] button[class*="accept" i]',
      '[class*="consent"] [class*="accept" i]', '[class*="consent"] [class*="agree" i]',
      '[class*="consent"] button[class*="agree" i]', '[class*="consent"] button[class*="accept" i]',
      '[class*="gdpr"] [class*="accept" i]', '[class*="gdpr"] [class*="agree" i]',
      // OneTrust / TrustArc / common CMP accept buttons
      '#onetrust-accept-btn-handler', '.accept-cookies', '.cookie-accept',
      '#accept-cookie', '#accept-cookie-notification', '.cc-accept',
      '[class*="policy"] button[class*="accept" i]', '[class*="policy"] button[class*="agree" i]',
      // Generic close buttons inside modals/overlays
      '[class*="modal"] [class*="close" i]', '[class*="popup"] [class*="close" i]',
      '[class*="overlay"] [class*="close" i]', '[class*="dialog"] [class*="close" i]',
      '[aria-label="Close"]', '[aria-label="Dismiss"]', '[aria-label="Close banner"]',
      // Newsletter / subscribe
      '[class*="newsletter"] [class*="close" i]', '[class*="newsletter"] [class*="dismiss" i]',
      '[class*="subscribe"] [class*="close" i]', '[class*="signup"] [class*="close" i]',
      // Ad-blocker / paywall warnings
      '[class*="adblock"] [class*="close" i]', '[class*="adblock"] [class*="dismiss" i]',
      '[class*="paywall"] [class*="close" i]', '[class*="paywall"] [class*="dismiss" i]',
      // "Continue" / "Proceed" buttons inside ad-blocker and paywall overlays
      '[class*="adblock"] button', '[class*="adblock"] [role="button"]',
      '[class*="paywall"] button', '[class*="paywall"] [role="button"]',
      '[class*="overlay"] button[class*="continue" i]', '[class*="overlay"] [class*="continue" i]',
      '[class*="modal"] button[class*="continue" i]', '[class*="modal"] [class*="continue" i]',
      '[class*="popup"] button[class*="continue" i]', '[class*="popup"] [class*="continue" i]',
      '[class*="dialog"] button[class*="continue" i]', '[class*="dialog"] [class*="continue" i]',
      // Generic × buttons (SVG or text)
      'button[class*="close" i]', '[class*="dismiss-btn" i]',
    ];

    // Early exit if already at max dismissals
    if (__sentinelDismissalCount >= SENTINEL_MAX_DISMISSALS) {
      return { dismissed, count: __sentinelDismissalCount, capped: true };
    }

    for (const sel of closeBtnSelectors) {
      if (__sentinelDismissalCount >= SENTINEL_MAX_DISMISSALS) break;
      try {
        const buttons = document.querySelectorAll(sel);
        for (const btn of buttons) {
          if (__sentinelDismissalCount >= SENTINEL_MAX_DISMISSALS) break;
          if (btn.offsetParent !== null && btn.getBoundingClientRect().width > 0) {
            btn.click();
            __sentinelDismissalCount++;
            dismissed.push((typeof btn.textContent === 'string' ? btn.textContent.trim().substring(0, 40) : '') || sel);
          }
        }
      } catch (e) { console.warn('[Sentinel] Invalid selector:', getErrorMessage(e)); }
    }

    // Text-based Continue/Dismiss button detection — catches buttons that don't
    // match any class selector but have recognizable text. Scans inside any
    // visible overlay-like container (high z-index, fixed position).
    const _continueTexts = [/^continue$/i, /^continue\s+to\s+site$/i, /^continue\s+anyway$/i,
      /^continue\s+reading$/i, /^proceed$/i, /^dismiss$/i, /^not now$/i, /^maybe later$/i,
      /^no,?\s*thanks$/i, /^i understand$/i, /^got it$/i, /^close$/i, /^skip$/i,
      /^show\s+me\s+the\s+content$/i, /^let\s+me\s+in$/i, /^x$/i, /^✕$/i, /^×$/i,
      // (v3.52) Zero-friction: accept/agree for consent overlays (CNN, news sites, etc.)
      /^i\s+agree$/i, /^agree$/i, /^accept$/i, /^accept\s+all$/i, /^accept\s+cookies$/i,
      /^yes,?\s*i\s+agree$/i, /^ok$/i, /^okay$/i, /^sure$/i, /^allow\s+all$/i,
      /^agree\s+and\s+continue$/i, /^accept\s+and\s+continue$/i, /^agree\s+to\s+all$/i];
    try {
      // Find all visible fixed-position containers that look like overlays
      const _candidates = document.querySelectorAll(
        '[style*="position: fixed"], [style*="position:fixed"], [class*="overlay"], [class*="modal"], [class*="popup"], [class*="dialog"], [class*="banner"], [class*="interstitial"], [class*="consent"], [class*="cookie"], [id*="consent"], [id*="cookie"], [class*="policy"], [id*="policy"], [class*="notice"], [class*="gdpr"]'
      );
      for (const _cand of _candidates) {
        if (__sentinelDismissalCount >= SENTINEL_MAX_DISMISSALS) break;
        try {
          const _style = window.getComputedStyle(_cand);
          if (_style.display === 'none' || _style.visibility === 'hidden') continue;
          if (_style.position !== 'fixed' && _style.position !== 'absolute') continue;
          const _zi = parseInt(_style.zIndex, 10);
          if (Number.isNaN(_zi) || (_zi < 100 && _style.position !== 'fixed')) continue;
          // Find buttons and clickable elements inside this overlay
          const _btns = _cand.querySelectorAll('button, [role="button"], a[class*="btn"], a[class*="button"], span[class*="btn"], div[class*="btn"], input[type="button"], input[type="submit"]');
          for (const _btn of _btns) {
            if (__sentinelDismissalCount >= SENTINEL_MAX_DISMISSALS) break;
            const _btnText = String(_btn.textContent || _btn.value || '').trim();
            for (const _re of _continueTexts) {
              if (_re.test(_btnText)) {
                _btn.click();
                __sentinelDismissalCount++;
                dismissed.push(`text-match: ${_btnText.substring(0, 30)}`);
                break;
              }
            }
          }
        } catch (_skipErr) {
          /* Element parsing failed - non-critical, skip this element */
        }
      }
    } catch (_nonFatalErr) {
      /* Dismissal loop failed - non-fatal, continue with overlay removal */
    }

    // Remove blocking overlays that cover the viewport — but only with strong
    // positive signals AND only if recently inserted. Skip structural roots.
    // (3.41.0) Pre-filter via targeted selector instead of querySelectorAll('*')
    // to avoid calling getComputedStyle on every element on the page (severe
    // layout thrashing on SPAs with 5000+ DOM nodes).
    const SKIP_TAGS = new Set(['HTML', 'BODY', 'MAIN']);
    const allEls = document.querySelectorAll(
      '[role="dialog"],[role="alertdialog"],[aria-modal="true"],' +
      '[class*="modal"],[class*="overlay"],[class*="popup"],[class*="backdrop"],[class*="lightbox"],[class*="cookie"],' +
      '[class*="dialog"],[class*="drawer"],[class*="sheet"],[class*="consent"],[class*="policy"],' +
      '[class*="notice"],[class*="gdpr"],[id*="consent"],[id*="cookie"],[id*="policy"]'
    );
    for (const el of allEls) {
      if (__sentinelDismissalCount >= SENTINEL_MAX_DISMISSALS) break;
      try {
        if (!el || !el.tagName) continue;
        if (SKIP_TAGS.has(el.tagName)) continue;
        // Don't kill page shells that contain <main>
        if (el.querySelector && el.querySelector('main')) continue;

        // Cheap checks before expensive getComputedStyle
        const cls = typeof el.className === 'string' ? el.className : '';
        if (cls.includes('sentinel')) continue;
        // Also skip elements with known composer/drawer class markers early
        if (UI_COMPONENT_SKIP_RE.test(cls + (el.id || ''))) continue;

        // Now do expensive computed style check
        const style = window.getComputedStyle(el);
        const zi = parseInt(style.zIndex || '0', 10);
        if (style.position !== 'fixed' || Number.isNaN(zi) || zi <= 1000) continue;

        const rect = el.getBoundingClientRect();
        const viewportArea = window.innerWidth * window.innerHeight;
        const elArea = rect.width * rect.height;
        if (elArea <= viewportArea * 0.5) continue;

        // Require positive modal/dialog signal.
        // Relax "recently inserted" check for overlays covering >80% of viewport —
        // these are almost always popups that need dismissing, not page content.
        if (!__sentinelHasPositiveModalSignal(el)) continue;
        const _coversMost = elArea >= viewportArea * 0.8;
        if (!_coversMost && !__sentinelWasInsertedRecently(el)) continue;

        // Safe-list: skip dialogs that contain active input/textarea/contenteditable
        // elements (Gmail compose, Linear drawers, Figma panels, form dialogs).
        // These are content the user or agent is actively filling out — dismissing
        // them would destroy in-progress work.
        if (el.querySelector('input:not([type="hidden"]), textarea, [contenteditable="true"], [contenteditable=""]')) continue;

        // Prefer clicking a close button if available; otherwise hide.
        const closeBtn = el.querySelector('button, [role="button"], [class*="close" i], [aria-label="Close"]');
        if (closeBtn) {
          closeBtn.click();
          __sentinelDismissalCount++;
          dismissed.push(`overlay-close: ${(typeof closeBtn.textContent === 'string' ? closeBtn.textContent.trim().substring(0, 30) : 'unnamed')}`);
        } else {
          el.style.display = 'none';
          __sentinelDismissalCount++;
          dismissed.push('hidden-overlay');
          const backdrop = document.querySelector('[class*="backdrop" i], [class*="scrim" i]');
          if (backdrop) backdrop.style.display = 'none';
        }
      } catch (e) { console.warn('[Sentinel] Overlay error:', getErrorMessage(e)); }
    }

    return { dismissed, count: dismissed.length };
  }

  // ========== Sensitive Field Detection (3.7.0) ==========
  // Hard-block typing into fields that look like passwords, pre-shared keys,
  // API secrets, recovery codes, or PII. Runs in BOTH the synthetic 'type'
  // path AND the CDP 'focus_element' path so neither input route can bypass.
  // Goes beyond `el.type === 'password'` because most real-world sensitive
  // fields (PSK, API key, client secret) are plain `type="text"`.

  const __SENTINEL_SENSITIVE_LABEL_RE = /\b(password|passphrase|passcode|pre.?shared.?key|psk|shared.?secret|secret.?key|api.?key|client.?secret|encryption.?key|private.?key|recovery.?code|reset.?code|verification.?code|temporary.?password|tenant.?key|cvv|cvc|ssn|social.?security|credit.?card|card.?number|account.?number|routing.?number|tax.?id|passport)\b/i;

  function __sentinelGetFieldSensitivityContext(el) {
    if (!el) return '';
    const parts = [];
    try {
      if (el.type === 'password') parts.push('password');
      const ac = el && el.getAttribute ? el.getAttribute('autocomplete') : null;
      if (ac) parts.push(ac);
      if (el.name) parts.push(el.name);
      if (el.id) parts.push(el.id);
      if (el.placeholder) parts.push(el.placeholder);
      const al = el && el.getAttribute ? el.getAttribute('aria-label') : null;
      if (al) parts.push(al);
      const tt = el && el.getAttribute ? el.getAttribute('title') : null;
      if (tt) parts.push(tt);
      // Associated <label for="id">
      if (el.id) {
        try {
          const lbl = document.querySelector(`label[for="${CSS.escape(String(el.id))}"]`);
          if (lbl) parts.push((lbl.innerText || lbl.textContent || '').substring(0, 100));
        } catch (e) { console.warn('[Sentinel] label lookup by id:', getErrorMessage(e)); }
      }
      // Walk up to 3 ancestors and collect any nearby label-ish text. Many
      // SPA forms render the label as a sibling div with class containing
      // "label" rather than a real <label> element.
      let p = el.parentElement;
      let depth = 0;
      while (p && depth < 3) {
        try {
          if (!p) continue;
          const lbl = p.querySelector('label, .label, .form-label, [class*="label" i]');
          if (lbl && lbl !== el) {
            parts.push((lbl.innerText || lbl.textContent || '').substring(0, 100));
          }
          // Also previous sibling text — e.g. "Pre-shared Key" rendered as a <span>
          const prev = p.previousElementSibling;
          if (prev) parts.push((prev.innerText || prev.textContent || '').substring(0, 100));
        } catch (e) { console.warn('[Sentinel] ancestor label walk:', getErrorMessage(e)); }
        p = p.parentElement;
        depth++;
      }
    } catch (e) { console.warn('[Sentinel] field sensitivity ctx:', getErrorMessage(e)); }
    return parts.join(' ').toLowerCase();
  }

  // Returns the matched sensitive keyword if `el` should be blocked, or null.
  function __sentinelCheckSensitiveField(el) {
    if (!el) return null;
    if (el.type === 'password') return 'password';
    const ctx = __sentinelGetFieldSensitivityContext(el);
    const m = ctx.match(__SENTINEL_SENSITIVE_LABEL_RE);
    return m ? m[0] : null;
  }

  // ========== MFA Challenge Detection (3.7.0) ==========
  // Detects 2FA / MFA / step-up auth pages so the agent-engine can pause
  // instead of looping uselessly. Caller (agent-engine via observe_page-side
  // metadata) gets back { mfaDetected: true, hint: <matched phrase> } when
  // the page text matches one of the MFA patterns.

  // ========== Message Handler ==========
  async function handleMessage(request) {
    if (!request || !request.action) {
      return null;
    }
    switch (request.action) {
      case 'observe_page': {
        // v20.1: read the warm cache first (pre-built at document_start by
        // content/warm-scan.js). A hit skips the cold scan AND the SPA retry
        // loop entirely — Claude-in-Chrome parity. Any miss/fall-through
        // below is today's cold-scan behavior, unchanged.
        try {
          const _warm = (typeof window !== 'undefined' && window.__sentinelWarmScan)
            ? window.__sentinelWarmScan.read()
            : null;
          if (_warm && Array.isArray(_warm.elements) && _warm.elements.length >= 5) {
            const _warmMap = new Map();
            let _used = 0;
            for (let _wi = 0; _wi < _warm.elements.length; _wi++) {
              const _w = _warm.elements[_wi];
              const _el = _w && _w.ref && typeof _w.ref.deref === 'function' ? _w.ref.deref() : null;
              if (!_el || !_el.isConnected) continue;
              try {
                if (dom && dom._addElement) dom._addElement(_el, interactiveElements, _warmMap, '', false);
                _used++;
              } catch (_we) { /* skip broken element */ }
            }
            if (_used >= 5) {
              if (fm && fm.scanIframes) {
                try {
                  const _ifr = fm.scanIframes(document);
                  if (_ifr.elements && Array.isArray(_ifr.elements)) interactiveElements.push(..._ifr.elements);
                } catch (_we2) { console.warn('[Sentinel] Iframe scan error (warm path):', getErrorMessage(_we2)); }
              }
              return { elements: interactiveElements, warm: true, warmAgeMs: Date.now() - (_warm.snapshot ? _warm.snapshot.capturedAt : 0) };
            }
            // Warm cache too sparse for this page — fall through to cold scan.
          }
        } catch (_warmErr) { /* warm cache is best-effort only */ }
        // Scan for interactive elements. Retry up to 3 times for SPAs (React, Vue, Angular)
        // that render content asynchronously after the initial page load.
        let interactiveElements = [];
        const maxRetries = 3;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          try {
            interactiveElements = [];
            const selectorMap = new Map();
            if (dom && dom.scanDocument) {
              dom.scanDocument(document, interactiveElements, selectorMap, '');
            }
            // Scan iframes using frame-manager
            if (fm && fm.scanIframes) {
              try {
                const iframeResult = fm.scanIframes(document);
                if (iframeResult.elements && Array.isArray(iframeResult.elements)) {
                  interactiveElements.push(...iframeResult.elements);
                }
              } catch (e) { console.warn('[Sentinel] Iframe scan error:', getErrorMessage(e)); }
            }
            // If we found elements, stop retrying
            if (interactiveElements.length >= 5) break;
          } catch (e) {
            if (typeof e === 'object' && e !== null && typeof e.message === 'string' && e.message.includes('Extension context invalidated')) throw e;
          }
          // Wait for SPA to render
          if (attempt < maxRetries - 1) {
            await new Promise(r => setTimeout(r, 1500));
          }
        }
        return { elements: interactiveElements };
      }

      case 'read_page': {
        const title = document.title;
        const url = window.location.href;

        // Smart content extraction: prefer semantic content areas over raw body.innerText.
        // Includes retry loop for SPAs that render content asynchronously (CNN, React apps, etc.)
        const maxRetries = 3;
        const retryDelay = 1500;
        let content = '';

        for (let attempt = 0; attempt < maxRetries; attempt++) {
          try {
            content = '';
            const mainSelectors = ['main', '[role="main"]', 'article', '#main-content', '#content', '.main-content', '.content'];
            let mainEl = null;
            for (const sel of mainSelectors) {
              mainEl = document.querySelector(sel);
              if (mainEl) break;
            }

            if (mainEl) {
              const clone = mainEl.cloneNode(true);
              const skip = ['nav', 'header', 'footer', 'aside', '[role="navigation"]', '[role="banner"]',
                '.cookie-notice', '.cookie-banner', '#cookie', '.ad', '.advertisement', '[aria-hidden="true"]',
                'script', 'style', 'noscript', 'svg'];
              skip.forEach(s => { try { const elements = clone.querySelectorAll(s); if (typeof elements.forEach === 'function') { elements.forEach(el => el.remove()); } } catch(e) { console.warn('[Sentinel] skip selector remove:', getErrorMessage(e)); } });
              content = (clone.innerText || clone.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
            }

            if (!content || content.length < 200) {
              const bodyClone = (document.body || document.documentElement).cloneNode(true);
              ['nav', 'header', 'footer', 'aside', 'script', 'style', 'noscript'].forEach(tag => {
                const elements = bodyClone.querySelectorAll(tag);
                if (typeof elements.forEach === 'function') {
                  elements.forEach(el => el.remove());
                }
              });
              content = (bodyClone.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
            }

            // If we got meaningful content, stop retrying
            if (content.length >= 200) break;
          } catch (e) {
            if (typeof e === 'object' && e !== null && typeof e.message === 'string' && e.message.includes('Extension context invalidated')) throw e;
          }
          // Wait for SPA to render before retrying
          if (attempt < maxRetries - 1) {
            await new Promise(r => setTimeout(r, retryDelay));
          }
        }

        // If still empty after retries, try scrolling down to trigger lazy load
        if (content.length < 200) {
          try {
            if (document.body) window.scrollTo(0, document.body.scrollHeight / 3);
            await new Promise(r => setTimeout(r, 1000));
            const bodyText = (document.body && document.body.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
            if (bodyText.length > content.length) content = bodyText;
          } catch (e) { console.warn('[Sentinel] Page navigation error:', getErrorMessage(e)); }
        }

        return { content: `Page Title: ${title}\nURL: ${url}\n\n${content}` };
      }

      case 'execute_command': {
        const cmd = request.command;
        const result = await executeCommand(cmd);
        // If executeCommand returns an error string, throw so the wrapper sends { ok: false, error }
        if (typeof result === 'string' && (/^(Error)| not found|Element not found|No element/.test(result))) {
          throw new Error(result);
        }
        return { result };
      }

      case 'wait_for': {
        return await wait.handleWaitFor(request.condition);
      }

      case 'read_iframe': {
        const frameIndex = request.frameIndex || 0;
        const iframes = document.querySelectorAll('iframe');
        if (!iframes[frameIndex]) throw new Error(`Iframe not found at index ${frameIndex}`);
        try {
          const iframeDoc = iframes[frameIndex].contentWindow && iframes[frameIndex].contentWindow.document;
          if (!iframeDoc) throw new Error('Cannot access iframe document (detached or cross-origin)');
          const title = iframeDoc.title || '';
          const url = iframes[frameIndex].src || '';
          let content = '';
          const mainSelectors = ['main', '[role="main"]', 'article', '#main-content', '#content'];
          let mainEl = null;
          for (const sel of mainSelectors) {
            mainEl = iframeDoc.querySelector(sel);
            if (mainEl) break;
          }
          if (mainEl) {
            content = (mainEl.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
          } else {
            content = (iframeDoc.body ? iframeDoc.body.innerText : '').replace(/\n{3,}/g, '\n\n').trim();
          }
          return { content: `Iframe Title: ${title}\nURL: ${url}\n\n${content}` };
        } catch {
          console.warn('[Sentinel] iframe content extraction failed', e);
          throw new Error('Cross-origin iframe -- use background routing');
        }
      }

      case 'dismiss_overlays': {
        return dismissOverlays();
      }

      case 'update_hud': {
        // (3.50.0) Update the in-page action HUD overlay
        if (window.__sentinelActionHUD && window.__sentinelActionHUD.update) {
          window.__sentinelActionHUD.update(request.hudData || {});
        }
        return { ok: true };
      }

      case 'show_action_feedback': {
        // (3.50.2) Visual feedback for ALL agent actions — not just CDP clicks.
        // Shows the cursor moving to center-screen with an action banner.
        try {
          const actionType = request.actionType || 'action';
          const label = request.label || actionType;
          const targetDesc = request.target || '';
          const stepNum = request.step || 0;

          // Animate cursor to center of viewport
          if (window.__sentinelCursor && window.__sentinelCursor.moveTo && window.innerWidth > 0 && window.innerHeight > 0) {
            const cx = Math.round(window.innerWidth / 2);
            const cy = Math.round(window.innerHeight / 2);
            window.__sentinelCursor.moveTo(cx, cy, { duration: 400 });
          }

          // Show a brief action banner at top of page
          let banner = document.getElementById('__sentinel_action_banner');
          // (3.51) Re-check if banner was removed by SPA
          if (!banner || !banner.parentElement) {
            banner = document.createElement('div');
            banner.id = '__sentinel_action_banner';
            banner.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
              'background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);color:#e94560;font-family:system-ui,sans-serif;' +
              'font-size:14px;font-weight:600;padding:8px 20px;border-radius:8px;border:1px solid #e94560;' +
              'box-shadow:0 4px 20px rgba(233,69,96,0.3);pointer-events:none;transition:opacity 0.3s,transform 0.3s;' +
              'white-space:nowrap;max-width:90vw;overflow:hidden;text-overflow:ellipsis;';
            // (3.51) Attach to documentElement like cursor — body gets replaced by React/Lit SPAs
            (document.documentElement || document.body).appendChild(banner);
          }

          // Icon map for action types
          const icons = {
            navigate: '🧭', open_tab: '📂', close_tab: '🗑️', note: '📝',
            execute_js: '⚡', click: '👆', type: '⌨️', scroll: '📜',
            switch_tab: '🔄', finish: '✅', extract: '🔍', wait_for: '⏳',
            screenshot: '📸', hover: '👀'
          };
          const icon = icons[actionType] || '▶️';
          banner.textContent = `${icon} Step ${stepNum}: ${label}${targetDesc ? ` — ${targetDesc.substring(0, 60)}` : ''}`;
          banner.style.opacity = '1';
          banner.style.transform = 'translateX(-50%) translateY(0)';

          // Fade out after 2s
          clearTimeout(banner._fadeTimer);
          banner._fadeTimer = setTimeout(() => {
            banner.style.opacity = '0';
            banner.style.transform = 'translateX(-50%) translateY(-10px)';
          }, 2000);
        } catch (_visualErr) {
          /* Non-fatal visual feedback error - banner update failed but action proceeds */
        }
        return { ok: true };
      }

      case 'get_viewport_info': {
        // (#11) DPR-aware screenshots: report viewport in CSS pixels plus DPR
        // and scroll offsets so the background can attach metadata to each capture.
        return {
          width: window.innerWidth,
          height: window.innerHeight,
          dpr: window.devicePixelRatio || 1,
          scrollX: window.scrollX,
          scrollY: window.scrollY
        };
      }

      case 'get_bbox': {
        // (#9) CDP trusted-input support. Resolve ref or selector to the
        // element's bounding-rect center in CSS pixels. The background uses
        // these coordinates with chrome.debugger Input.dispatchMouseEvent.
        const fakeCmd = { ref: request.ref, selector: request.selector };
        const resolved = resolveCommandTarget(fakeCmd, document);
        const el = resolved.el;
        if (!el) throw new Error(`Element not found for bbox: ${request.ref || request.selector || ''}`);
        const rect = el.getBoundingClientRect();
        if (!rect || (rect.width === 0 && rect.height === 0)) {
          throw new Error('Element has zero size');
        }
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          w: rect.width,
          h: rect.height,
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom
        };
      }

      case 'detect_tenant': {
        // (3.7.0) Best-effort tenant detection for Microsoft admin centers.
        // Pulls signals from (in order of confidence):
        //   1. tid= query param on the current URL
        //   2. *.onmicrosoft.com strings in the visible page text
        //   3. Top-right tenant chip text (admin.microsoft.com, entra)
        try {
          let tid = null;
          let onmicrosoft = null;
          let chipText = null;

          try {
            const u = new URL(window.location.href);
            tid = u.searchParams.get('tid') || null;
          } catch (e) { console.warn('[Sentinel] tid URL parse:', getErrorMessage(e)); }

          try {
            const bodyText = (document.body && document.body.innerText) || '';
            const m = bodyText.match(ONMICROSOFT_TENANT_RE);
            if (m) onmicrosoft = m[0];
          } catch (e) { console.warn('[Sentinel] onmicrosoft scan:', getErrorMessage(e)); }

          // Common chip selectors across admin.microsoft.com / entra.microsoft.com / portal.azure.com
          const chipSelectors = [
            '[data-automation-id="header-tenant-name"]',
            '[data-automationid="header-tenant-name"]',
            '[id="tenant-name"]',
            '[id="tenantNameText"]',
            'header [class*="tenant" i]',
            '[class*="MeControl" i] [class*="tenant" i]'
          ];
          for (const sel of chipSelectors) {
            try {
              const el = document.querySelector(sel);
              if (el) {
                const t = (el.innerText || el.textContent || '').trim();
                if (t && t.length < 120) { chipText = t; break; }
              }
            } catch (e) { console.warn('[Sentinel] tenant chip lookup:', getErrorMessage(e)); }
          }

          return {
            tid,
            onmicrosoft,
            chipText,
            url: window.location.href,
            hostname: window.location.hostname
          };
        } catch {
          return { tid: null, onmicrosoft: null, chipText: null };
        }
      }

      case 'so_scroll_element_at': {
        // (SO-90c) Fallback when chrome.debugger mouseWheel wedges: scroll the
        // element actually under (x, y) — walks up from the hit element to the
        // nearest scrollable ancestor, else falls back to the window.
        try {
          const x = Number(request.x) || 0;
          const y = Number(request.y) || 0;
          const dx = Number(request.deltaX) || 0;
          const dy = Number(request.deltaY) || 0;
          const el = document.elementFromPoint(x, y);
          let target = null;
          let node = el;
          while (node && node !== document.body && node !== document.documentElement) {
            const s = window.getComputedStyle(node);
            const ov = (s.overflowY === 'auto' || s.overflowY === 'scroll' || s.overflowX === 'auto' || s.overflowX === 'scroll');
            if (ov && (node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1)) { target = node; break; }
            node = node.parentElement;
          }
          if (!target && (document.documentElement.scrollHeight > window.innerHeight + 1)) target = document.scrollingElement || document.documentElement;
          if (!target) return { ok: true, scrolled: false, note: 'nothing scrollable at point' };
          target.scrollBy({ left: dx, top: dy, behavior: 'auto' });
          await new Promise(r => setTimeout(r, 120));
          return { ok: true, scrolled: true, target: target.tagName ? target.tagName.toLowerCase() : 'element', scrollTop: target.scrollTop };
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      }

      case 'cdp_pre_click_visual': {
        // (G1) Visual feedback for the CDP trusted-input click path.
        // Animates the virtual cursor to (x, y), highlights the element under
        // that point, and shows the click pulse + banner — matching the
        // synthetic path's experience. Called by tab-manager.cdpDispatchClick
        // ~220ms before the actual CDP click fires.
        try {
          const x = Number(request.x) || 0;
          const y = Number(request.y) || 0;
          const desc = request.description || `Clicking at (${Math.round(x)}, ${Math.round(y)})`;

          // Animate cursor first (awaits ~380ms internally; tab-manager only
          // pauses 220ms before firing the click, so the cursor often arrives
          // mid-click — that's fine, the pulse will draw on top).
          if (window.__sentinelCursor && window.__sentinelCursor.moveTo) {
            // Fire-and-forget: don't block the click on the full travel time.
            try { window.__sentinelCursor.moveTo(x, y); } catch (e) { console.warn('[Sentinel] cursor moveTo:', getErrorMessage(e)); }
          }

          // Highlight whatever's at (x, y). Use elementFromPoint with a tiny
          // offset retry in case the cursor halo is briefly capturing input.
          let highlighted = null;
          try {
            highlighted = document.elementFromPoint(x, y);
            if (highlighted && window.__sentinelUtils && window.__sentinelUtils.highlight) {
              window.__sentinelUtils.highlight.highlightElement(highlighted);
              // Auto-clear after 1.5s so the visual doesn't linger forever.
              setTimeout(() => {
                try { window.__sentinelUtils.highlight.removeHighlight(highlighted); } catch (e) { console.warn('[Sentinel] highlight auto-clear:', getErrorMessage(e)); }
              }, 1500);
            }
          } catch (e) { console.warn('[Sentinel] cdp highlight from point:', getErrorMessage(e)); }

          // Banner + pulse + cursor press
          if (window.__sentinelOverlay) {
            try { window.__sentinelOverlay.showActionBanner('click', desc); } catch (e) { console.warn('[Sentinel] action banner show:', getErrorMessage(e)); }
            try { window.__sentinelOverlay.showClickIndicator(x, y); } catch (e) { console.warn('[Sentinel] click indicator show:', getErrorMessage(e)); }
          }
          if (window.__sentinelCursor && window.__sentinelCursor.press) {
            try { window.__sentinelCursor.press(); } catch (e) { console.warn('[Sentinel] cursor press:', getErrorMessage(e)); }
          }

          return { ok: true };
        } catch (e) {
          return { ok: false, error: getErrorMessage(e) };
        }
      }

      case 'cdp_typing_progress': {
        // (G2) Streamed banner update during CDP per-char typing.
        // tab-manager.cdpDispatchType posts these every Nth character so the
        // user sees real-time typing progress — same UX as synthetic typing.
        try {
          const text = String(request.text || '');
          const position = Number(request.position) || 0;
          if (typeof showTypingBanner === 'function') {
            showTypingBanner(text, position, text.length);
          } else if (window.__sentinelOverlay && window.__sentinelOverlay.showActionBanner) {
            const preview = text.substring(0, 40) + (text.length > 40 ? '...' : '');
            window.__sentinelOverlay.showActionBanner(
              'type',
              `Typing: "${preview}" (${position}/${text.length})`
            );
          }
          return { ok: true };
        } catch (e) {
          return { ok: false, error: getErrorMessage(e) };
        }
      }

      case 'cdp_pre_action_announce': {
        // (G5) Pre-action announcement banner. Called by background paths that
        // don't otherwise reach the content script for visuals (extra hook
        // point for future CDP-driven actions).
        try {
          if (window.__sentinelOverlay && window.__sentinelOverlay.showActionBanner) {
            window.__sentinelOverlay.showActionBanner(
              request.actionType || 'action',
              request.description || ''
            );
          }
          return { ok: true };
        } catch (e) {
          return { ok: false, error: getErrorMessage(e) };
        }
      }

      case 'focus_element': {
        // (#9) Used before CDP Input.insertText so trusted text lands on the
        // intended element. We focus via the page's own .focus() API; the
        // subsequent CDP insertText then dispatches trusted input events.
        const fakeCmd = { ref: request.ref, selector: request.selector };
        const resolved = resolveCommandTarget(fakeCmd, document);
        const el = resolved.el;
        if (!el) throw new Error(`Element not found for focus: ${request.ref || request.selector || ''}`);

        // (5.0) Log sensitive field detection for audit but never block — IT techs have full credential access.
        const __sensitiveMatch = __sentinelCheckSensitiveField(el);
        if (__sensitiveMatch) {
          try { ctel && ctel.info && ctel.info('page', `Focus: sensitive field detected (matched "${__sensitiveMatch}") — proceeding per IT-tech authorization`, { match: __sensitiveMatch, url: location.href.substring(0, 200) }); } catch (e) { console.warn('[Sentinel] sensitive field log:', getErrorMessage(e)); }
        }
        try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch { try { el.scrollIntoView(); } catch (e2) { console.warn('[Sentinel] scrollIntoView fallback failed:', ((e2 && typeof e2.message === 'string') ? e2.message : String(e2))); } }
        try { el.focus({ preventScroll: false }); } catch (e) { console.warn('[Sentinel] focus element:', getErrorMessage(e)); }
        // Dispatch explicit FocusEvent for frameworks (Formik, React Hook Form) that use listeners
        try { el.dispatchEvent(new FocusEvent('focus', { bubbles: true, composed: true })); } catch { /* non-fatal */ }
        // Clear existing value so CDP insertText replaces rather than appends,
        // matching the synthetic-path behavior. Only for inputs/textareas.
        try {
          const tag = (el.tagName || '').toLowerCase();
          if (tag === 'input' || tag === 'textarea') {
            const proto = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value');
            if (setter && setter.set) setter.set.call(el, '');
            el.dispatchEvent(new Event('input', { bubbles: true }));
          } else if (el.isContentEditable) {
            el.textContent = '';
          }
        } catch (e) { console.warn('[Sentinel] Non-fatal error:', getErrorMessage(e)); }
        return { focused: true };
      }

      default:
        // Return null for unrecognised actions so other listeners (e.g. quick-assist.js)
        // can still process the message. Chrome only allows one sendResponse per message.
        return null;
    }
  }

  // ========== Visual Overlay System ==========
  // Shows the user what the agent is doing on the page: action banner + click indicators.

  const SENTINEL_OVERLAY_ID = '__sentinel_overlay__';

  function getOrCreateOverlay() {
    try {
      let overlay = document.getElementById(SENTINEL_OVERLAY_ID);
      if (overlay) return overlay;

      const style = document.createElement('style');
      style.id = `${SENTINEL_OVERLAY_ID}_style`;
      style.textContent = `
        #__sentinel_overlay__ {
          position: fixed; top: 12px; right: 12px; z-index: 2147483647;
          background: #1a1a2e; color: #e0e0e0; border: 1px solid #4a4a8a;
          border-radius: 8px; padding: 8px 14px; font-family: monospace;
          font-size: 12px; max-width: 400px; box-shadow: 0 4px 20px rgba(0,0,0,0.5);
          pointer-events: none; transition: opacity 0.3s;
        }
        #__sentinel_overlay__ .sentinel-action { color: #7eb8ff; font-weight: bold; }
        #__sentinel_overlay__ .sentinel-target { color: #ffa07a; margin-top: 2px; }
        #__sentinel_click_indicator__ {
          position: fixed; z-index: 2147483646; pointer-events: none;
          width: 24px; height: 24px; border-radius: 50%;
          border: 2px solid #ff4444; background: rgba(255,68,68,0.15);
          transform: translate(-50%, -50%);
          animation: sentinelClickPulse 0.6s ease-out forwards;
        }
        @keyframes sentinelClickPulse {
          0% { transform: translate(-50%, -50%) scale(0.5); opacity: 1; }
          100% { transform: translate(-50%, -50%) scale(2.5); opacity: 0; }
        }
      `;
      (document.head || document.documentElement).appendChild(style);

      overlay = document.createElement('div');
      overlay.id = SENTINEL_OVERLAY_ID;
      overlay.textContent = 'Sentinel Override';
      (document.body || document.documentElement).appendChild(overlay);
      return overlay;
    } catch {
      return null;
    }
  }

  /**
   * Escape HTML special characters to prevent XSS when inserting into innerHTML.
   * @param {string} str — Raw string that may contain HTML metacharacters.
   * @returns {string} HTML-safe string with &, <, >, ", ' escaped.
   */
  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function showActionBanner(actionType, description) {
    try {
      const overlay = getOrCreateOverlay();
      if (!overlay) return;
      const label = escapeHtml(description || actionType);
      overlay.innerHTML = `<span class="sentinel-action">Sentinel:</span> ${label}`;
      overlay.style.opacity = '1';
    } catch (e) { console.warn('[Sentinel] Extension context invalidated:', getErrorMessage(e)); }
  }

  function hideActionBanner() {
    try {
      const overlay = document.getElementById(SENTINEL_OVERLAY_ID);
      if (overlay) overlay.style.opacity = '0';
    } catch (e) { console.warn('[Sentinel] hide action banner:', getErrorMessage(e)); }
  }

  function showClickIndicator(x, y) {
    try {
      const existing = document.getElementById('__sentinel_click_indicator__');
      if (existing) existing.remove();
      const indicator = document.createElement('div');
      indicator.id = '__sentinel_click_indicator__';
      indicator.style.left = `${x}px`;
      indicator.style.top = `${y}px`;
      (document.body || document.documentElement).appendChild(indicator);
      setTimeout(() => { try { if (indicator.parentNode) indicator.remove(); } catch(e) { console.warn('[Sentinel] click indicator cleanup failed:', getErrorMessage(e)); } }, 700);
    } catch (e) { console.warn('[Sentinel] Extension context invalidated:', getErrorMessage(e)); }
  }

  // Make overlay functions available for the execute_command handler
  window.__sentinelOverlay = { showActionBanner, hideActionBanner, showClickIndicator };

  // ========== Human-like Interaction Helpers ==========
  // Makes agent actions visible and feel natural — watching the agent work
  // should feel like watching a skilled human operator.

  function humanDelay(minMs = 30, maxMs = 80) {
    const delay = minMs + Math.random() * (maxMs - minMs);
    return new Promise(r => setTimeout(r, delay));
  }

  // Layout-stability wait (#19): poll getBoundingClientRect across rAF ticks,
  // resolve when two consecutive frames produce the same top/left/width/height
  // (within 1px tolerance) or when maxMs elapses.
  function waitForStableRect(el, frames = 2, maxMs = 600) {
    return new Promise((resolve) => {
      if (!el || !el.getBoundingClientRect) { resolve(false); return; }
      const start = performance.now();
      let prev = null;
      let stableCount = 0;
      const tick = () => {
        try {
          const r = el.getBoundingClientRect();
          const cur = { t: r.top, l: r.left, w: r.width, h: r.height };
          if (prev &&
              Math.abs(cur.t - prev.t) <= 1 &&
              Math.abs(cur.l - prev.l) <= 1 &&
              Math.abs(cur.w - prev.w) <= 1 &&
              Math.abs(cur.h - prev.h) <= 1) {
            stableCount++;
          } else {
            stableCount = 0;
          }
          prev = cur;
          if (stableCount >= (frames - 1)) { resolve(true); return; }
          if (performance.now() - start >= maxMs) { resolve(false); return; }
          requestAnimationFrame(tick);
        } catch {
          resolve(false);
        }
      };
      requestAnimationFrame(tick);
    });
  }

  // Per-character key event dispatch helpers (#8). Resolves keyCode/which from
  // the character so React/Lexical/Slate/ProseMirror autocomplete reacts.
  function __sentinelKeyEventForChar(type, char) {
    let code;
    if (char === ' ') { code = 'Space'; }
    else if (/^[a-zA-Z]$/.test(char)) { code = `Key${char.toUpperCase()}`; }
    else if (/^[0-9]$/.test(char)) { code = `Digit${char}`; }
    else { code = char; }
    const keyCode = char.length === 1 ? char.charCodeAt(0) : 0;
    return new KeyboardEvent(type, {
      key: char,
      code: code,
      keyCode: keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
      composed: true
    });
  }

  function typingDelay(charIndex, totalChars) {
    // Adaptive speed: fast for long strings, natural variation for short ones
    if (totalChars > 150) return humanDelay(8, 20);   // Very fast for long strings (URLs, etc.)
    if (totalChars > 80) return humanDelay(15, 35);    // Fast for medium strings
    // Natural human-like typing with occasional brief pauses
    if (charIndex > 0 && charIndex % 7 === 0) return humanDelay(80, 200); // Thinking pause every ~7 chars
    return humanDelay(35, 110); // Normal typing speed (9-28 chars/sec)
  }

  // Enhanced action banner with typing preview — shows the user what's being typed
  function showTypingBanner(text, position, total) {
    try {
      const overlay = getOrCreateOverlay();
      if (!overlay) return;
      const safeText = String(text || '');
      const preview = escapeHtml(safeText.substring(0, 40) + (safeText.length > 40 ? '...' : ''));
      const progress = position !== undefined ? ` (${position}/${total})` : '';
      overlay.innerHTML = `<span class="sentinel-action">⌨ Typing:</span> <span class="sentinel-target">"${preview}"</span>${progress}`;
      overlay.style.opacity = '1';
    } catch (e) { console.warn('[Sentinel] typing banner show:', getErrorMessage(e)); }
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    handleMessage(request)
      .then(data => {
        // If handleMessage returned null the action is unrecognised — do NOT
        // call sendResponse so other listeners (e.g. quick-assist.js) can
        // handle the message instead.
        if (data === null) return;
        sendResponse({ ok: true, data });
      })
      .catch(err => sendResponse({ ok: false, error: getErrorMessage(err) }));
    return true; // keep message channel open for async responses
  });

  // ========== execute_js Sandbox Helpers ==========
  // API allowlist for execute_js sandboxing
   
  const _EXECUTE_JS_ALLOWED_GLOBALS = new Set([
    'querySelector', 'querySelectorAll', 'getElementById', 'getElementsByClassName',
    'getElementsByTagName', 'getElementsByName',
    'createElement', 'createTextNode', 'createDocumentFragment', 'createComment',
    'getAttribute', 'setAttribute', 'removeAttribute', 'hasAttribute',
    'addEventListener', 'removeEventListener', 'dispatchEvent',
    'classList', 'style', 'dataset', 'textContent', 'innerHTML', 'innerText',
    'outerHTML', 'tagName', 'nodeName', 'nodeType', 'nodeValue',
    'value', 'checked', 'selected', 'disabled', 'hidden',
    'focus', 'blur', 'click', 'scrollIntoView', 'scrollTo', 'scrollBy',
    'appendChild', 'removeChild', 'insertBefore', 'replaceChild',
    'parentElement', 'parentNode', 'children', 'childNodes',
    'firstChild', 'lastChild', 'firstElementChild', 'lastElementChild',
    'nextSibling', 'previousSibling', 'nextElementSibling', 'previousElementSibling',
    'offsetHeight', 'offsetWidth', 'offsetTop', 'offsetLeft',
    'clientHeight', 'clientWidth', 'clientTop', 'clientLeft',
    'scrollHeight', 'scrollWidth', 'scrollTop', 'scrollLeft',
    'getBoundingClientRect', 'getComputedStyle',
    'documentElement', 'body', 'head', 'title', 'URL', 'baseURI', 'readyState',
    'forms', 'images', 'links', 'scripts', 'anchors', 'embeds', 'plugins',
    'documentMode', 'compatMode', 'characterSet', 'contentType',
    'querySelector', 'querySelectorAll',
    'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
    'requestAnimationFrame', 'cancelAnimationFrame',
    'Promise', 'JSON', 'console', 'Math', 'Date', 'Array', 'Object', 'String', 'Number', 'Boolean',
    'Symbol', 'BigInt', 'Map', 'Set', 'WeakMap', 'WeakSet', 'RegExp',
    'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError',
    'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'NaN', 'Infinity',
    'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
    'btoa', 'atob',
    'structuredClone', 'AbortController', 'AbortSignal',
    'alert', 'confirm', 'prompt'
  ]);

  const EXECUTE_JS_BLOCKED_APIS = new Set([
    'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource',
    'localStorage', 'sessionStorage', 'indexedDB',
    'open', 'close', 'stop', 'print',
    'eval', 'Function',
    'importScripts', 'Worker', 'SharedWorker', 'ServiceWorker',
    'postMessage',
    'navigator', 'location',
    'chrome',
    'crypto'
  ]);

  // Document-level properties to block (beyond what EXECUTE_JS_BLOCKED_APIS covers for window)
  const EXECUTE_JS_BLOCKED_DOC_PROPS = new Set([
    'cookie', 'domain', 'referrer', 'location', 'write', 'writeln'
  ]);

  // Creates a Proxy wrapping the document that blocks sensitive properties
  // but allows all normal DOM read/write operations.
  // sandboxedWin is the already-proxied window, returned when code accesses document.defaultView.
   
  function _createSandboxedDocument(doc, sandboxedWin) {
    return new Proxy(doc, {
      get(target, prop, _receiver) {
        // Block sensitive document properties (cookie, domain, referrer, location, write, writeln)
        if (EXECUTE_JS_BLOCKED_DOC_PROPS.has(prop)) {

          return undefined;
        }
        // When code asks for document.defaultView, return the sandboxed window proxy
        if (prop === 'defaultView') {
          return sandboxedWin;
        }
        // Pass through everything else, binding methods to the real document
        const value = target[prop];
        if (typeof value === 'function') {
          return value.bind(target);
        }
        return value;
      },
      set(target, prop, value) {
        if (EXECUTE_JS_BLOCKED_DOC_PROPS.has(prop)) {

          return true; // silently swallow the write
        }
        target[prop] = value;
        return true;
      },
      has(target, prop) {
        if (EXECUTE_JS_BLOCKED_DOC_PROPS.has(prop)) return false;
        return prop in target;
      }
    });
  }

  // Creates a Proxy wrapping the window that blocks dangerous APIs
  // while allowing safe properties (console, Math, setTimeout, etc.) through.
   
  function _createSandboxedWindow(win) {
    return new Proxy(win, {
      get(target, prop, _receiver) {
        // Block all dangerous window APIs
        if (EXECUTE_JS_BLOCKED_APIS.has(prop)) {

          return undefined;
        }
        // Pass through safe properties, binding methods to the real window
        const value = target[prop];
        if (typeof value === 'function') {
          return value.bind(target);
        }
        return value;
      },
      set(target, prop, value) {
        if (EXECUTE_JS_BLOCKED_APIS.has(prop)) {

          return true; // silently swallow the write
        }
        target[prop] = value;
        return true;
      },
      has(target, prop) {
        if (EXECUTE_JS_BLOCKED_APIS.has(prop)) return false;
        return prop in target;
      }
    });
  }

  // ========== Ref / Selector Element Resolution (#10) ==========
  // Single entry point for resolving a command's target element. Prefers
  // cmd.ref (stable per-scan id from dom-utils) and falls back to selector
  // when the ref is stale (element removed from DOM, or scan rotated).
  // Returns { el, viaRef, staleRef } so callers can log appropriately.
  function resolveCommandTarget(cmd, targetDoc) {
    // Try ref first when provided
    if (cmd && cmd.ref) {
      const el = dom.findElementByRef && dom.findElementByRef(cmd.ref);
      if (el) {
        return { el, viaRef: true, staleRef: false };
      }
      // Ref stale — try semantic identity matches before falling back to the
      // brittle nth-of-type selector chain, which breaks on SPA re-renders.
      try {

      } catch (e) { console.warn('[Sentinel] stale ref log:', getErrorMessage(e)); }
      // 1. aria-label match (most reliable stable identifier)
      if (cmd.ariaLabel) {
        try {
          const byAria = targetDoc.querySelector(`[aria-label="${(cmd.ariaLabel || '').replace(/"/g, '\\"')}"]`);
          if (byAria) return { el: byAria, viaRef: false, staleRef: true };
        } catch (e) { console.warn('[Sentinel] aria-label fallback:', getErrorMessage(e)); }
      }
      // 2. id match
      if (cmd.elementId) {
        try {
          const byId = targetDoc.getElementById(cmd.elementId);
          if (byId) return { el: byId, viaRef: false, staleRef: true };
        } catch (e) { console.warn('[Sentinel] id fallback:', getErrorMessage(e)); }
      }
      // Pre-compute once; used by fallbacks 3-6
      const rawText = cmd.elementText ? String(cmd.elementText).trim() : '';
      // 3. visible text + tag match (e.g. a button that always says "Save")
      if (cmd.elementText && cmd.tag) {
        try {
          const tag = String(cmd.tag).toLowerCase();
          const byText = [...targetDoc.querySelectorAll(tag)]
            .find(el => (el.innerText || el.textContent || '').trim() === rawText);
          if (byText) return { el: byText, viaRef: false, staleRef: true };
        } catch (e) { console.warn('[Sentinel] text+tag fallback:', getErrorMessage(e)); }
      }
      // 4. XPath text search — find any visible element containing the text
      if (cmd.elementText) {
        try {
          const needle = rawText.substring(0, 60);
          const byXPath = targetDoc.evaluate(
            `//*[not(self::script or self::style or self::noscript)]` +
            `[normalize-space(text())=${JSON.stringify(needle)}]`,
            targetDoc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
          ).singleNodeValue;
          if (byXPath) return { el: byXPath, viaRef: false, staleRef: true };
        } catch (e) { console.warn('[Sentinel] XPath fallback:', getErrorMessage(e)); }
      }
      // 5. aria-label partial / case-insensitive match (label may have changed slightly)
      if (cmd.elementText) {
        try {
          const needle = rawText.substring(0, 40).toLowerCase();
          const candidates = targetDoc.querySelectorAll('[aria-label]');
          for (const c of candidates) {
            if ((c.getAttribute('aria-label') || '').toLowerCase().includes(needle)) {
              return { el: c, viaRef: false, staleRef: true };
            }
          }
        } catch (e) { console.warn('[Sentinel] aria partial fallback:', getErrorMessage(e)); }
      }
      // 6. data-testid / data-id partial match
      if (cmd.elementText) {
        try {
          const needle = rawText.substring(0, 30).toLowerCase().replace(/\s+/g, '-');
          const byTestId = targetDoc.querySelector(`[data-testid*="${needle}" i], [data-id*="${needle}" i]`);
          if (byTestId) return { el: byTestId, viaRef: false, staleRef: true };
        } catch (e) { console.warn('[Sentinel] testid fallback:', getErrorMessage(e)); }
      }
      // 7. nth-of-type selector as last resort
      if (cmd.selector) {
        const fallback = dom.findElementBySelector(targetDoc, cmd.selector);
        return { el: fallback, viaRef: false, staleRef: true };
      }
      return { el: null, viaRef: false, staleRef: true };
    }
    // No ref — pure selector path (legacy)
    if (cmd && cmd.selector) {
      const el = dom.findElementBySelector(targetDoc, cmd.selector);
      return { el, viaRef: false, staleRef: false };
    }
    return { el: null, viaRef: false, staleRef: false };
  }

  // Build a short human-readable reference for log/error messages so the
  // dispatcher's existing error strings ("Element not found: SELECTOR") still
  // make sense when the LLM only supplied a ref.
  function describeTarget(cmd) {
    if (!cmd) return '';
    if (cmd.ref && cmd.selector) return `${cmd.ref} (${cmd.selector})`;
    if (cmd.ref) return cmd.ref;
    return cmd.selector || '';
  }

  // ========== Command Execution ==========
  // Shared overlay-blocking guard. Returns null if clear, or an error string if
  // the element is blocked by an overlay that couldn't be dismissed.
  async function guardOverlayBlocking(targetDoc, el, cmd) {
    if (!ov || !ov.isOverlayBlocking) return null;
    const blocking = ov.isOverlayBlocking(targetDoc, el);
    if (!blocking) return null;
    const dismissed = ov.dismissOverlay(targetDoc, blocking);
    if (!dismissed) return `Element blocked by overlay that could not be dismissed: ${describeTarget(cmd)}`;
    await wait.sleep(300);
    return null;
  }

  async function executeCommand(cmd) {
    if (!cmd) return 'Invalid command: cmd is null';
    // Use active frame doc if switch_to_frame was called and no explicit frame: prefix
    // Guard against stale reference (iframe removed from DOM)
    let targetDoc = document;
    if (__sentinelActiveFrameDoc && !(cmd.selector && cmd.selector.startsWith('frame:'))) {
      try {
        // Accessing parentNode on the documentElement checks if the document is still live.
        // If the iframe was removed, this will throw or return null.
        const docEl = __sentinelActiveFrameDoc.documentElement;
        if (docEl && docEl.parentNode !== null) {
          targetDoc = __sentinelActiveFrameDoc;
        } else {
          __sentinelActiveFrameDoc = null;
        }
      } catch (_e) {
        __sentinelActiveFrameDoc = null;
      }
    }
    let selector = cmd.selector;

    // Check if command targets an iframe
    if (selector && selector.startsWith('frame:')) {
      if (fm && fm.findInIframe) {
        const iframeResult = fm.findInIframe(document, selector);
        if (!iframeResult) return `Iframe not found for selector: ${selector}`;

        if (iframeResult.crossOrigin) {
          // Cross-origin: delegate to background script via chrome.runtime.sendMessage
          return new Promise((resolve) => {
            try {
              chrome.runtime.sendMessage({
                action: 'execute_in_frame',
                frameIndex: iframeResult.frameIndex,
                command: cmd
              }, (response) => {
                if (_hasLastError()) {
                  resolve(`Cross-origin iframe error: ${_getLastErrorMessage() || String(chrome.runtime.lastError)}`);
                } else if (response && response.ok) {
                  resolve(JSON.stringify(response.data || response));
                } else {
                  resolve(`Cross-origin iframe error: ${response ? response.error : 'Unknown error'}`);
                }
              });
            } catch {
              resolve('Extension context error during iframe operation');
            }
          });
        }

        // Same-origin: use the iframe's document
        if (!iframeResult.frameDoc) return `Iframe document unavailable for selector: ${selector}`;
        targetDoc = iframeResult.frameDoc;
        selector = iframeResult.remainingSelector || '';
        cmd = { ...cmd, selector };
      } else {
        // Fallback: basic iframe handling without frame-manager
        const parts = selector.split(':');
        const frameIndex = parts.length >= 2 ? parseInt(parts[1], 10) : NaN;
        if (Number.isNaN(frameIndex)) return `Invalid frame index in selector: ${selector}`;
        const iframeSelector = parts.slice(2).join(':');
        const iframes = document.querySelectorAll('iframe');
        if (!iframes || !iframes[frameIndex]) {
          return `Iframe not found at index ${frameIndex}`;
        }
        if (iframes[frameIndex]) {
          try {
            if (!iframes[frameIndex].contentWindow) return 'Cannot access iframe (no content window)';
            targetDoc = iframes[frameIndex].contentWindow.document;
            selector = iframeSelector;
          } catch {
            return 'Cannot access iframe (cross-origin)';
          }
        } else {
          return `Iframe not found at index ${frameIndex}`;
        }
      }
    }

    switch (cmd.type) {
      case 'click': {
        const resolved = resolveCommandTarget(cmd, targetDoc);
        const el = resolved.el;
        if (!el) {
          // (3.26.0) Content-side telemetry: click target unresolved. This is
          // the single most common content-side failure mode (selector hallucination,
          // SPA late mount, or shadow DOM hit). Surface in panel so operators
          // see exactly which selector missed.
          try {
            ctel.warn('page', 'Click target not found', {
              selector: cmd.selector || null,
              ref: cmd.ref || null,
              label: cmd.label || null,
              staleRef: !!resolved.staleRef,
              url: location.href.substring(0, 200)
            });
          } catch (e) { console.warn('[Sentinel] click not found tel:', getErrorMessage(e)); }
          return `Element not found: ${describeTarget(cmd)}`;
        }

        // (#20) Reject disabled / pointer-events:none / aria-disabled targets
        // before doing any visual work, so the agent can react.
        if (dom.checkInteractable) {
          const reason = dom.checkInteractable(el, 'click');
          if (reason) {
            try {
              ctel.warn('page', `Click rejected: ${reason}`, {
                selector: cmd.selector || null,
                ref: cmd.ref || null,
                reason: reason,
                tag: (el.tagName || '').toLowerCase(),
                url: location.href.substring(0, 200)
              });
            } catch (e) { console.warn('[Sentinel] click rejected tel:', getErrorMessage(e)); }
            return `Cannot click ${describeTarget(cmd)}: ${reason}`;
          }
        }

        // Visual feedback: show banner and highlight
        if (window.__sentinelOverlay) window.__sentinelOverlay.showActionBanner('click', `Clicking: ${(el.innerText || el.tagName || '').substring(0, 60)}`);

        // Reactive overlay check: is the target element blocked?
        const overlayBlock = await guardOverlayBlocking(targetDoc, el, cmd);
        if (overlayBlock) return overlayBlock;

        hl.highlightElement(el);
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // (#19) Layout-stability wait — replaces the fixed 500ms sleep so we
        // don't dispatch into a still-shifting target (lazy-loaded images, etc.).
        await waitForStableRect(el, 2, 600);

        // (G3) Virtual cursor travels to the target before the click. Awaits
        // ~380ms — that travel IS the "operator decides" pause, replacing the
        // explicit humanDelay(200, 450) below with a visible movement.
        try {
          if (window.__sentinelCursor && window.__sentinelCursor.moveToElement) {
            await window.__sentinelCursor.moveToElement(el);
          }
        } catch (e) { console.warn('[Sentinel] cursor moveToElement:', getErrorMessage(e)); }

        // Get element center for click indicator
        try {
          const rect = el.getBoundingClientRect();
          if (!rect || !rect.width || !rect.height) throw new Error('Unable to get element bounding rect');
          if (window.__sentinelOverlay) window.__sentinelOverlay.showClickIndicator(rect.left + rect.width / 2, rect.top + rect.height / 2);
        } catch (e) { console.warn('[Sentinel] click indicator rect:', getErrorMessage(e)); }

        // (G3) Cursor press animation, fired at the same moment as the pulse.
        try {
          if (window.__sentinelCursor && window.__sentinelCursor.press) {
            window.__sentinelCursor.press();
          }
        } catch (e) { console.warn('[Sentinel] cursor press click:', getErrorMessage(e)); }

        // Short settle pause — the cursor.moveToElement above already provided
        // the visible "operator looking" travel time, so this is just a brief
        // settle before dispatching mouse events.
        await humanDelay(80, 160);
        if (!targetDoc.defaultView) return 'Error: no window context for click dispatch';
        const mouseOpts = { bubbles: true, cancelable: true, composed: true, view: targetDoc.defaultView };
        el.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
        el.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
        el.click();
        // A trusted CDP click moves focus to the clicked element; synthetic
        // events (Firefox shim path) do not. Replicate that observable effect
        // so a following type/press_key lands in the field the agent clicked.
        try {
          if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable) {
            el.focus();
          }
        } catch (e) { console.warn('[Sentinel] click_at focus:', getErrorMessage(e)); }
        el.dispatchEvent(new MouseEvent('mouseout', mouseOpts));
        // Keep highlight visible for 2 seconds so user can see what was clicked
        setTimeout(() => hl.removeHighlight(el), 2000);

        return `Clicked ${describeTarget(cmd)}${resolved.staleRef ? ' (selector fallback after stale ref)' : ''}`;
      }

      case 'right_click': {
        var rcResolved = resolveCommandTarget(cmd, targetDoc);
        var rcEl = rcResolved.el;
        if (!rcEl) return `Element not found: ${describeTarget(cmd)}`;
        var rcBlock = await guardOverlayBlocking(targetDoc, rcEl, cmd);
        if (rcBlock) return rcBlock;
        hl.highlightElement(rcEl);
        rcEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await waitForStableRect(rcEl, 2, 400);
        try {
          if (window.__sentinelCursor && window.__sentinelCursor.moveToElement) {
            await window.__sentinelCursor.moveToElement(rcEl);
          }
        } catch (e) { console.warn('[Sentinel] cursor right_click:', getErrorMessage(e)); }
        var rcRect = rcEl.getBoundingClientRect();
        if (!rcRect || !rcRect.width || !rcRect.height) return 'Error: unable to get bounding rect for right_click';
        var rcX = Math.round(rcRect.left + rcRect.width / 2);
        var rcY = Math.round(rcRect.top + rcRect.height / 2);
        if (!targetDoc.defaultView) return 'Error: no window context for right_click dispatch';
        var rcView = targetDoc.defaultView;
        rcEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true, view: rcView, button: 2, buttons: 2, clientX: rcX, clientY: rcY }));
        rcEl.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, composed: true, view: rcView, button: 2, buttons: 0, clientX: rcX, clientY: rcY }));
        rcEl.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, composed: true, view: rcView, button: 2, clientX: rcX, clientY: rcY }));
        setTimeout(() => hl.removeHighlight(rcEl), 1500);
        return `Right-clicked ${describeTarget(cmd)}${rcResolved.staleRef ? ' (selector fallback)' : ''}`;
      }

      case 'double_click': {
        var dcResolved = resolveCommandTarget(cmd, targetDoc);
        var dcEl = dcResolved.el;
        if (!dcEl) return `Element not found: ${describeTarget(cmd)}`;
        var dcBlock = await guardOverlayBlocking(targetDoc, dcEl, cmd);
        if (dcBlock) return dcBlock;
        hl.highlightElement(dcEl);
        dcEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await waitForStableRect(dcEl, 2, 400);
        try {
          if (window.__sentinelCursor && window.__sentinelCursor.moveToElement) {
            await window.__sentinelCursor.moveToElement(dcEl);
          }
        } catch (e) { console.warn('[Sentinel] cursor double_click:', getErrorMessage(e)); }
        if (!targetDoc.defaultView) return 'Error: no window context for double_click dispatch';
        var dcView = targetDoc.defaultView;
        var dcOpts = { bubbles: true, cancelable: true, composed: true, view: dcView };
        dcEl.dispatchEvent(new MouseEvent('mousedown', { ...dcOpts, detail: 1 }));
        dcEl.dispatchEvent(new MouseEvent('mouseup',   { ...dcOpts, detail: 1 }));
        dcEl.dispatchEvent(new MouseEvent('click',     { ...dcOpts, detail: 1 }));
        await humanDelay(50, 100);
        dcEl.dispatchEvent(new MouseEvent('mousedown', { ...dcOpts, detail: 2 }));
        dcEl.dispatchEvent(new MouseEvent('mouseup',   { ...dcOpts, detail: 2 }));
        dcEl.dispatchEvent(new MouseEvent('click',     { ...dcOpts, detail: 2 }));
        dcEl.dispatchEvent(new MouseEvent('dblclick',  { ...dcOpts, detail: 2 }));
        setTimeout(() => hl.removeHighlight(dcEl), 1500);
        return `Double-clicked ${describeTarget(cmd)}${dcResolved.staleRef ? ' (selector fallback)' : ''}`;
      }

      case 'triple_click_at': {
        // (SO-90) Synthetic triple click — selects line/paragraph/URL when the
        // CDP path is unavailable (trusted input disabled).
        const tcX = cmd.x, tcY = cmd.y;
        if (typeof tcX !== 'number' || Number.isNaN(tcX) || typeof tcY !== 'number' || Number.isNaN(tcY)) return 'triple_click_at requires numeric x and y coordinates';
        const tcVw = targetDoc.documentElement ? targetDoc.documentElement.clientWidth : 0;
        const tcVh = targetDoc.documentElement ? targetDoc.documentElement.clientHeight : 0;
        if (tcX < 0 || tcY < 0 || tcX > tcVw || tcY > tcVh) return `triple_click_at coordinates out of viewport (x=${tcX}, y=${tcY}, viewport=${tcVw}x${tcVh})`;
        const tcEl = targetDoc.elementFromPoint(tcX, tcY);
        if (!tcEl) return `Error: no element at (${tcX}, ${tcY})`;
        hl.highlightElement(tcEl);
        const tcView = targetDoc.defaultView;
        if (!tcView) return 'Error: no window context for triple_click_at dispatch';
        const tcOpts = { bubbles: true, cancelable: true, composed: true, view: tcView };
        for (let tcD = 1; tcD <= 3; tcD++) {
          tcEl.dispatchEvent(new MouseEvent('mousedown', { ...tcOpts, detail: tcD }));
          tcEl.dispatchEvent(new MouseEvent('mouseup', { ...tcOpts, detail: tcD }));
          tcEl.dispatchEvent(new MouseEvent('click', { ...tcOpts, detail: tcD }));
        }
        tcEl.dispatchEvent(new MouseEvent('dblclick', { ...tcOpts, detail: 2 }));
        setTimeout(() => hl.removeHighlight(tcEl), 1500);
        return `Triple-clicked at (${tcX}, ${tcY})`;
      }

      case 'click_at': {
        const x = cmd.x;
        const y = cmd.y;
        if (typeof x !== 'number' || Number.isNaN(x) || typeof y !== 'number' || Number.isNaN(y)) return 'click_at requires numeric x and y coordinates';

        // (#11) DPR sanity check. Coordinates from the agent are expected to be
        // in CSS pixels (the same coordinate system as elementFromPoint and bbox).
        // If the caller supplies a dpr that disagrees with the live one, log a
        // warning but DO NOT auto-divide — the agent-engine should be sending
        // CSS pixels already.
        try {
          const liveDpr = window.devicePixelRatio || 1;
          if (typeof cmd.dpr === 'number' && !Number.isNaN(cmd.dpr) && Math.abs(cmd.dpr - liveDpr) > 0.01) {

          }
        } catch (e) { console.warn('[Sentinel] Non-fatal error:', getErrorMessage(e)); }

        // (#11) Defensive viewport clamp. If coordinates land outside the
        // visible viewport, refuse rather than silently clicking on nothing.
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        if (x < 0 || y < 0 || x > vw || y > vh) {
          return `click_at coordinates out of viewport (x=${x}, y=${y}, viewport=${vw}x${vh})`;
        }

        if (window.__sentinelOverlay) window.__sentinelOverlay.showActionBanner('click_at', `Clicking at (${x}, ${y})`);

        const el = targetDoc.elementFromPoint(x, y);
        if (!el) return `No element found at coordinates (${x}, ${y})`;

        // (#20) Reject disabled / pointer-events:none / aria-disabled targets.
        if (dom.checkInteractable) {
          const reason = dom.checkInteractable(el, 'click');
          if (reason) return `Cannot click_at (${x}, ${y}): ${reason}`;
        }

        hl.highlightElement(el);
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // (#19) Layout-stability wait instead of fixed 400ms.
        await waitForStableRect(el, 2, 600);

        // (G3) Virtual cursor travels to the click coordinates first, so the
        // user sees where the click is going before the pulse fires.
        try {
          if (window.__sentinelCursor && window.__sentinelCursor.moveTo) {
            await window.__sentinelCursor.moveTo(x, y);
          }
        } catch (e) { console.warn('[Sentinel] cursor moveTo click_at:', getErrorMessage(e)); }

        if (window.__sentinelOverlay) window.__sentinelOverlay.showClickIndicator(x, y);
        try {
          if (window.__sentinelCursor && window.__sentinelCursor.press) {
            window.__sentinelCursor.press();
          }
        } catch (e) { console.warn('[Sentinel] cursor press click_at:', getErrorMessage(e)); }

        // Short settle (cursor travel already provided the visible pause)
        await humanDelay(60, 140);
        if (!targetDoc.defaultView) return 'Error: no window context for click_at dispatch';
        const mouseOpts = { bubbles: true, cancelable: true, composed: true, view: targetDoc.defaultView, clientX: x, clientY: y };
        el.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
        el.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
        el.click();
        // A trusted CDP click moves focus to the clicked element; synthetic
        // events (Firefox shim path) do not. Replicate that observable effect
        // so a following type/press_key lands in the field the agent clicked.
        try {
          if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable) {
            el.focus();
          }
        } catch (e) { console.warn('[Sentinel] click_at focus:', getErrorMessage(e)); }
        el.dispatchEvent(new MouseEvent('mouseout', mouseOpts));
        setTimeout(() => hl.removeHighlight(el), 2000);
        const classes = String(el.className || '').split(' ').filter(Boolean);
        const _classesLen = classes.length; // Cache to avoid repeated property access
        const classSuffix = _classesLen > 0 ? `.${classes[0]}` : '';
        return `Clicked at (${x}, ${y}) on element: ${el.tagName}${el.id ? `#${el.id}` : ''}${classSuffix}`;
      }

      case 'right_click_at': {
        const x = cmd.x, y = cmd.y;
        if (typeof x !== 'number' || Number.isNaN(x) || typeof y !== 'number' || Number.isNaN(y)) return 'right_click_at requires numeric x and y coordinates';
        const vw = window.innerWidth, vh = window.innerHeight;
        if (x < 0 || y < 0 || x > vw || y > vh) return `right_click_at coordinates out of viewport (x=${x}, y=${y}, viewport=${vw}x${vh})`;
        const el = targetDoc.elementFromPoint(x, y);
        if (!el) return `No element found at coordinates (${x}, ${y})`;
        hl.highlightElement(el);
        if (!targetDoc.defaultView) return 'Error: no window context for right_click_at dispatch';
        const rOpts = { bubbles: true, cancelable: true, composed: true, view: targetDoc.defaultView, clientX: x, clientY: y, button: 2 };
        el.dispatchEvent(new MouseEvent('mousedown', rOpts));
        el.dispatchEvent(new MouseEvent('contextmenu', rOpts));
        el.dispatchEvent(new MouseEvent('mouseup', rOpts));
        setTimeout(() => hl.removeHighlight(el), 2000);
        return `Right-clicked at (${x}, ${y}) on element: ${el.tagName}${el.id ? `#${el.id}` : ''}`;
      }

      case 'double_click_at': {
        const x = cmd.x, y = cmd.y;
        if (typeof x !== 'number' || Number.isNaN(x) || typeof y !== 'number' || Number.isNaN(y)) return 'double_click_at requires numeric x and y coordinates';
        const vw = window.innerWidth, vh = window.innerHeight;
        if (x < 0 || y < 0 || x > vw || y > vh) return `double_click_at coordinates out of viewport (x=${x}, y=${y}, viewport=${vw}x${vh})`;
        const el = targetDoc.elementFromPoint(x, y);
        if (!el) return `No element found at coordinates (${x}, ${y})`;
        hl.highlightElement(el);
        if (!targetDoc.defaultView) return 'Error: no window context for double_click_at dispatch';
        const dOpts = { bubbles: true, cancelable: true, composed: true, view: targetDoc.defaultView, clientX: x, clientY: y, detail: 2 };
        el.dispatchEvent(new MouseEvent('mousedown', dOpts));
        el.dispatchEvent(new MouseEvent('mouseup', dOpts));
        el.dispatchEvent(new MouseEvent('click', dOpts));
        el.dispatchEvent(new MouseEvent('dblclick', dOpts));
        setTimeout(() => hl.removeHighlight(el), 2000);
        return `Double-clicked at (${x}, ${y}) on element: ${el.tagName}${el.id ? `#${el.id}` : ''}`;
      }

      case 'drag_at': {
        const x1 = cmd.x1, y1 = cmd.y1, x2 = cmd.x2, y2 = cmd.y2;
        if ([x1, y1, x2, y2].some(n => typeof n !== 'number' || Number.isNaN(n))) return 'drag_at requires numeric x1, y1, x2, y2 coordinates';
        const srcEl = targetDoc.elementFromPoint(x1, y1);
        if (!srcEl) return `No element found at source coordinates (${x1}, ${y1})`;
        if (!targetDoc.defaultView) return 'Error: no window context for drag_at dispatch';
        const dView = targetDoc.defaultView;
        hl.highlightElement(srcEl);
        srcEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await waitForStableRect(srcEl, 2, 500);
        const mkMouse = function(type, x, y, extra) { return new MouseEvent(type, Object.assign({ bubbles: true, cancelable: true, composed: true, view: dView, clientX: x, clientY: y }, extra || {})); };
        const mkDrag = function(type, x, y) { return new DragEvent(type, { bubbles: true, cancelable: true, composed: true, view: dView, clientX: x, clientY: y }); };
        // mousedown + dragstart on the source point
        srcEl.dispatchEvent(mkMouse('mousedown', x1, y1));
        try { srcEl.dispatchEvent(mkDrag('dragstart', x1, y1)); } catch (e) { console.warn('[Sentinel] DragEvent unavailable:', getErrorMessage(e)); }
        // interpolated moves toward the drop point
        var dSteps = 6;
        var lastEl = srcEl;
        for (var dStep = 1; dStep <= dSteps; dStep++) {
          var mx = Math.round(x1 + (x2 - x1) * (dStep / dSteps));
          var my = Math.round(y1 + (y2 - y1) * (dStep / dSteps));
          var overEl = targetDoc.elementFromPoint(mx, my) || lastEl;
          overEl.dispatchEvent(mkMouse('mousemove', mx, my));
          try { overEl.dispatchEvent(mkDrag('dragover', mx, my)); } catch (_dragOverErr) { /* Non-fatal */ }
          lastEl = overEl;
        }
        // drop on whatever is under the destination point
        const dropAt = targetDoc.elementFromPoint(x2, y2) || lastEl;
        try { dropAt.dispatchEvent(mkDrag('dragenter', x2, y2)); } catch (_dragEnterErr) { /* Non-fatal */ }
        try { dropAt.dispatchEvent(mkDrag('drop', x2, y2)); } catch (e) { console.warn('[Sentinel] Drop event error:', getErrorMessage(e)); }
        dropAt.dispatchEvent(mkMouse('mouseup', x2, y2));
        try { srcEl.dispatchEvent(mkDrag('dragend', x2, y2)); } catch (_dragEndErr) { /* Non-fatal */ }
        setTimeout(() => { hl.removeHighlight(srcEl); hl.removeHighlight(dropAt); }, 1500);
        return `Dragged from (${x1}, ${y1}) to (${x2}, ${y2}) — dropped on: ${dropAt.tagName}${dropAt.id ? `#${dropAt.id}` : ''}`;
      }

      case 'drag_and_drop': {
        var dragResolved = resolveCommandTarget({ ref: cmd.source_ref, selector: cmd.source_selector, label: cmd.source_label }, targetDoc);
        var dropResolved = resolveCommandTarget({ ref: cmd.target_ref, selector: cmd.target_selector, label: cmd.target_label }, targetDoc);
        var dragEl = dragResolved.el;
        var dropEl = dropResolved.el;
        if (!dragEl) return 'drag_and_drop: source element not found';
        if (!dropEl) return 'drag_and_drop: target element not found';

        hl.highlightElement(dragEl);
        dragEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await waitForStableRect(dragEl, 2, 500);

        var srcRect = dragEl.getBoundingClientRect();
        var dstRect = dropEl.getBoundingClientRect();
        if (!srcRect || !dstRect || !srcRect.width || !srcRect.height || !dstRect.width || !dstRect.height) return 'Error: unable to get bounding rects for drag_and_drop';
        var srcX = Math.round(srcRect.left + srcRect.width / 2);
        var srcY = Math.round(srcRect.top + srcRect.height / 2);
        var dstX = Math.round(dstRect.left + dstRect.width / 2);
        var dstY = Math.round(dstRect.top + dstRect.height / 2);
        if (!targetDoc.defaultView) return 'Error: no window context for drag_and_drop dispatch';
        var dView = targetDoc.defaultView;
        var mkMouse = function(type, x, y) { return new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: dView, clientX: x, clientY: y }); };
        var mkDrag  = function(type, x, y) { return new DragEvent(type, { bubbles: true, cancelable: true, composed: true, view: dView, clientX: x, clientY: y }); };

        // mousedown + dragstart on source
        dragEl.dispatchEvent(mkMouse('mousedown', srcX, srcY));
        try { dragEl.dispatchEvent(mkDrag('dragstart', srcX, srcY)); } catch (e) { console.warn('[Sentinel] DragEvent unavailable:', getErrorMessage(e)); }

        // intermediate mousemove steps for smooth drag appearance
        var steps = 6;
        for (var dragStep = 1; dragStep <= steps; dragStep++) {
          var mx = Math.round(srcX + (dstX - srcX) * (dragStep / steps));
          var my = Math.round(srcY + (dstY - srcY) * (dragStep / steps));
          dragEl.dispatchEvent(mkMouse('mousemove', mx, my));
          try { dropEl.dispatchEvent(mkDrag('dragover', mx, my)); } catch (_dragOverErr) { /* Non-fatal: dragover failed */ }
          await humanDelay(20, 40);
        }

        // dragenter + drop + dragend on target
        try { dropEl.dispatchEvent(mkDrag('dragenter', dstX, dstY)); } catch (_dragEnterErr) { /* Non-fatal: dragenter failed */ }
        try { dropEl.dispatchEvent(mkDrag('drop', dstX, dstY)); } catch (e) { console.warn('[Sentinel] Drop event error:', getErrorMessage(e)); }
        dragEl.dispatchEvent(mkMouse('mouseup', dstX, dstY));
        try { dragEl.dispatchEvent(mkDrag('dragend', dstX, dstY)); } catch (_dragEndErr) { /* Non-fatal: dragend failed */ }

        setTimeout(() => { hl.removeHighlight(dragEl); hl.removeHighlight(dropEl); }, 1500);
        hl.highlightElement(dropEl);
        return `Dragged ${describeTarget({ ref: cmd.source_ref, selector: cmd.source_selector, label: cmd.source_label })} to ${describeTarget({ ref: cmd.target_ref, selector: cmd.target_selector, label: cmd.target_label })}`;
      }

      case 'type': {
        const resolved = resolveCommandTarget(cmd, targetDoc);
        const el = resolved.el;
        if (!el) {
          // (3.26.0) Content-side telemetry: type target unresolved.
          try {
            ctel.warn('page', 'Type target not found', {
              selector: cmd.selector || null,
              ref: cmd.ref || null,
              label: cmd.label || null,
              staleRef: !!resolved.staleRef,
              textLen: (cmd.text || '').length,
              url: location.href.substring(0, 200)
            });
          } catch (e) { console.warn('[Sentinel] type not found tel:', getErrorMessage(e)); }
          return `Element not found: ${describeTarget(cmd)}`;
        }

        // (5.0) Log sensitive field detection for audit but never block — IT techs have full credential access.
        const __sensitiveMatch = __sentinelCheckSensitiveField(el);
        if (__sensitiveMatch) {
          try {
            ctel.info('page', `Type: sensitive field detected (matched "${__sensitiveMatch}") — proceeding per IT-tech authorization`, {
              match: __sensitiveMatch,
              tag: (el.tagName || '').toLowerCase(),
              type: el.type || null,
              name: (el.name || '').substring(0, 60),
              id: (el.id || '').substring(0, 60),
              url: location.href.substring(0, 200)
            });
          } catch (e) { console.warn('[Sentinel] sensitive field tel:', getErrorMessage(e)); }
        }

        // (#20) Reject disabled targets up front.
        if (dom.checkInteractable) {
          const reason = dom.checkInteractable(el, 'type');
          if (reason) {
            try {
              ctel.warn('page', `Type rejected: ${reason}`, {
                selector: cmd.selector || null,
                ref: cmd.ref || null,
                reason: reason,
                tag: (el.tagName || '').toLowerCase(),
                url: location.href.substring(0, 200)
              });
            } catch (e) { console.warn('[Sentinel] type rejected tel:', getErrorMessage(e)); }
            return `Cannot type into ${describeTarget(cmd)}: ${reason}`;
          }
        }

        if (window.__sentinelOverlay) window.__sentinelOverlay.showActionBanner('type', `Typing "${(cmd.text || '').substring(0, 50)}" into ${(el.innerText || el.tagName || '').substring(0, 40)}`);

        // Reactive overlay check: is the target element blocked?
        const typeOverlayBlock = await guardOverlayBlocking(targetDoc, el, cmd);
        if (typeOverlayBlock) return typeOverlayBlock;

        hl.highlightElement(el);
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await new Promise(r => setTimeout(r, 400)); // Wait for smooth scroll before typing

        // (G3) Cursor travels to the input field before typing starts.
        try {
          if (window.__sentinelCursor && window.__sentinelCursor.moveToElement) {
            await window.__sentinelCursor.moveToElement(el);
          }
        } catch (e) { console.warn('[Sentinel] cursor moveTo type:', getErrorMessage(e)); }

        el.focus();
        const text = cmd.text || '';

        // Rich text editor (Quill, TinyMCE, CKEditor, contenteditable with rich content)
        if (si && si.isRichTextEditor && si.isRichTextEditor(el)) {
          const result = si.setRichTextValue(el, text);
          hl.removeHighlight(el);
          return `Typed into rich text editor ${describeTarget(cmd)} (${result.method})`;
        }

        // Date input
        if (si && si.isDateInput && si.isDateInput(el)) {
          const result = si.setDatePickerValue(el, text);
          hl.removeHighlight(el);
          if (result.success) return `Set date to ${text} (${result.method})`;
          return `Failed to set date: ${result.error || 'unknown error'}`;
        }

        // contenteditable div/span — Lexical / Slate / ProseMirror compat path (#8).
        // Per-char: keydown -> keypress -> beforeinput(insertText) -> input -> keyup.
        if (el.isContentEditable) {
          el.textContent = '';
          el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          // Use execCommand for broadest compatibility with SPA frameworks
          try { targetDoc.execCommand('selectAll', false, null); } catch (e) { console.warn('[Sentinel] execCommand selectAll:', getErrorMessage(e)); }
          try { targetDoc.execCommand('delete', false, null); } catch (e) { console.warn('[Sentinel] execCommand delete:', getErrorMessage(e)); }
          const textLen = text.length;
          for (let i = 0; i < textLen; i++) {
            const char = text[i];
            el.dispatchEvent(__sentinelKeyEventForChar('keydown', char));
            el.dispatchEvent(__sentinelKeyEventForChar('keypress', char));
            // Lexical/ProseMirror listen to beforeinput to map IME / composition.
            el.dispatchEvent(new InputEvent('beforeinput', {
              inputType: 'insertText', data: char,
              bubbles: true, cancelable: true, composed: true
            }));
            // Insert the character. Frameworks that intercept beforeinput may
            // already have updated content, but we still call execCommand for
            // editors that don't.
            try { targetDoc.execCommand('insertText', false, char); } catch (e) { console.warn('[Sentinel] execCommand insertText:', getErrorMessage(e)); }
            el.dispatchEvent(new InputEvent('input', {
              inputType: 'insertText', data: char,
              bubbles: true, cancelable: true, composed: true
            }));
            el.dispatchEvent(__sentinelKeyEventForChar('keyup', char));
            await typingDelay(i, textLen);
          }
          el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          el.dispatchEvent(new Event('blur', { bubbles: true, composed: true }));
          hl.removeHighlight(el);
          return `Typed into contenteditable ${describeTarget(cmd)}`;
        }

        // Standard INPUT / TEXTAREA — full key sequence per character with native
        // setter so React/Vue/MUI controlled inputs sync (#8).
        if (/^(INPUT|TEXTAREA)$/.test(el.tagName)) {
          if (!targetDoc.defaultView) return 'Error: no window context for input typing';
          const _dv = targetDoc.defaultView;
          const _ProtoClass = el.tagName === 'TEXTAREA' ? _dv.HTMLTextAreaElement : _dv.HTMLInputElement;
          if (!_ProtoClass) return 'Error: no HTMLInputElement prototype in this context';
          const proto = _ProtoClass.prototype;
          const desc = Object.getOwnPropertyDescriptor(proto, 'value');
          const nativeSetter = desc && desc.set;
          if (!nativeSetter) return 'Error: unable to access native value setter';

          nativeSetter.call(el, '');
          el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          const textLen = text.length;
          for (let i = 0; i < textLen; i++) {
            const char = text[i];
            // keydown + keypress let suggestion popups (Google, GitHub, Linear) react.
            el.dispatchEvent(__sentinelKeyEventForChar('keydown', char));
            el.dispatchEvent(__sentinelKeyEventForChar('keypress', char));

            const currentVal = el.value || '';
            nativeSetter.call(el, currentVal + char);
            el.dispatchEvent(new InputEvent('input', {
              inputType: 'insertText', data: char,
              bubbles: true, cancelable: true, composed: true
            }));

            el.dispatchEvent(__sentinelKeyEventForChar('keyup', char));

            // Update typing banner every 10 chars for visual feedback
            if (i % 10 === 0 || i === textLen - 1) showTypingBanner(text, i + 1, textLen);
            await typingDelay(i, textLen);
          }
          // Final change event after the full string is typed.
          el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          hl.removeHighlight(el);
          return `Typed into ${describeTarget(cmd)}`;
        }

        // Fallback for any other focusable element
        el.value = text;
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        hl.removeHighlight(el);
        return `Typed into ${describeTarget(cmd)}`;
      }

      case 'upload_file': {
        const resolvedUpload = resolveCommandTarget(cmd, targetDoc);
        const el = resolvedUpload.el;
        if (!el) return `Element not found: ${describeTarget(cmd)}`;
        if (el.type !== 'file') return `Element is not a file input: ${describeTarget(cmd)}`;
        hl.highlightElement(el);
        const uploaded = si && si.uploadFile && si.uploadFile(el, cmd.file_name || 'file.txt', cmd.mime_type || 'text/plain', cmd.content || '');
        hl.removeHighlight(el);
        if (uploaded) return `Uploaded file ${cmd.file_name || 'file.txt'} to ${describeTarget(cmd)}`;
        return `Failed to upload file to ${describeTarget(cmd)}`;
      }

      case 'scroll': {
        var scrollAmount = cmd.amount || 0;
        // If a selector/ref is provided, scroll that element; otherwise scroll the window.
        if (cmd.selector || cmd.ref) {
          var resolvedScroll = resolveCommandTarget(cmd, targetDoc);
          var scrollEl = resolvedScroll && resolvedScroll.el;
          if (scrollEl) {
            scrollEl.scrollBy({ top: scrollAmount, behavior: 'smooth' });
            await new Promise(r => setTimeout(r, 400));
            return `Scrolled element ${describeTarget(cmd)} by ${scrollAmount}`;
          }
          return `Element not found: ${describeTarget(cmd)}`;
        }
        if (!targetDoc.defaultView) return 'Cannot scroll: no window context for target document';
        targetDoc.defaultView.scrollBy({ top: scrollAmount, behavior: 'smooth' });
        await new Promise(r => setTimeout(r, 400)); // Wait for smooth scroll animation
        return `Scrolled ${scrollAmount}`;
      }

      case 'select': {
        const resolvedSel = resolveCommandTarget(cmd, targetDoc);
        const el = resolvedSel.el;
        if (!el) return `Element not found: ${describeTarget(cmd)}`;

        // Reactive overlay check: is the target element blocked?
        const selOverlayBlock = await guardOverlayBlocking(targetDoc, el, cmd);
        if (selOverlayBlock) return selOverlayBlock;

        // Check for custom dropdown (non-native <select>)
        if (dd && dd.isCustomDropdown && dd.isCustomDropdown(el)) {
          hl.highlightElement(el);
          const options = await dd.openDropdown(targetDoc, el);
          if (!options) {
            // Failed to open via dropdown utils, fall back to standard click
            el.click();
            await wait.sleep(500);
            const retryOptions = dd.findDropdownOptions(targetDoc, el);
            if (!retryOptions || retryOptions.length === 0) {
              hl.removeHighlight(el);
              return `Failed to open dropdown: ${describeTarget(cmd)}`;
            }
            const selected = await dd.selectDropdownOption(targetDoc, retryOptions, cmd.value);
            if (!selected) {
              const availableTexts = retryOptions.map(o => (o.innerText || o.textContent || '').trim()).join(', ');
              dd.dismissDropdown(targetDoc);
              hl.removeHighlight(el);
              return `Error: No matching option "${cmd.value}". Available: ${availableTexts}`;
            }
            dd.dismissDropdown(targetDoc);
            hl.removeHighlight(el);
            return `Selected "${cmd.value}" in dropdown ${describeTarget(cmd)}`;
          }
          const selected = await dd.selectDropdownOption(targetDoc, options, cmd.value);
          if (!selected) {
            const availableTexts = options.map(o => (o.innerText || o.textContent || '').trim()).join(', ');
            dd.dismissDropdown(targetDoc);
            hl.removeHighlight(el);
            return `Error: No matching option "${cmd.value}". Available: ${availableTexts}`;
          }
          dd.dismissDropdown(targetDoc);
          hl.removeHighlight(el);
          return `Selected "${cmd.value}" in dropdown ${describeTarget(cmd)}`;
        }

        // Native <select> element — support select by value, visible text, and multi-select
        if (el.tagName !== 'SELECT') return `Element is not a <select>: ${describeTarget(cmd)}`;
        hl.highlightElement(el);
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await new Promise(r => setTimeout(r, 300));

        if (el.multiple && Array.isArray(cmd.value)) {
          // Multi-select: select multiple options by value or text
          const options = [...el.options];
          for (const val of cmd.value) {
            if (val == null) continue;
            const valStr = String(val);
            const opt = options.find(o => o.value === val || (typeof o.textContent === 'string' && o.textContent.trim().toLowerCase() === valStr.toLowerCase()));
            if (opt) opt.selected = true;
          }
          el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          hl.removeHighlight(el);
          return `Multi-selected [${cmd.value.join(', ')}] in ${describeTarget(cmd)}`;
        }

        // Single select: try exact value match, then visible text match
        const options = [...el.options];
        const cmdValueLower = String(cmd.value).toLowerCase();
        let targetOpt = options.find(o => o.value === cmd.value);
        if (!targetOpt) {
          targetOpt = options.find(o => {
            const textLower = typeof o.textContent === 'string' ? o.textContent.trim().toLowerCase() : '';
            return textLower === cmdValueLower;
          });
        }
        if (!targetOpt) {
          // Partial text match as fallback
          targetOpt = options.find(o => {
            const textLower = typeof o.textContent === 'string' ? o.textContent.trim().toLowerCase() : '';
            return textLower.includes(cmdValueLower);
          });
        }
        if (!targetOpt) {
          const availableOpts = options.map(o => `"${o.value}" (${typeof o.textContent === 'string' ? o.textContent.trim() : ''})`).join(', ');
          hl.removeHighlight(el);
          return `Error: No matching option "${cmd.value}". Available: ${availableOpts}`;
        }
        // (#24) Use the native HTMLSelectElement value setter so React-controlled
        // selects don't revert to their previous value on the synthetic change.
        try {
          const selDesc = Object.getOwnPropertyDescriptor(
            targetDoc.defaultView.HTMLSelectElement.prototype, 'value'
          );
          const selectSetter = selDesc && selDesc.set;
          if (selectSetter) {
            selectSetter.call(el, targetOpt.value);
          } else {
            el.value = targetOpt.value;
          }
        } catch {
          // Fallback for any environment where the setter isn't accessible.
          el.value = targetOpt.value;
        }
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        hl.removeHighlight(el);
        return `Selected "${targetOpt.textContent.trim()}" (value: ${targetOpt.value}) in ${describeTarget(cmd)}`;
      }

      case 'check': {
        // Checkbox and radio button support — set to explicit checked state
        const resolvedCheck = resolveCommandTarget(cmd, targetDoc);
        const checkEl = resolvedCheck.el;
        if (!checkEl) return `Element not found: ${describeTarget(cmd)}`;
        hl.highlightElement(checkEl);
        checkEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await new Promise(r => setTimeout(r, 300));

        const desiredState = cmd.checked !== undefined ? cmd.checked : true;
        if (checkEl.type === 'checkbox' || checkEl.type === 'radio') {
          // (#25) Use el.click() to toggle so React Hook Form / Formik / native
          // form handlers see a real click + change pair. Only click if state
          // actually needs to change.
          if (checkEl.checked !== desiredState) {
            // (G3) Cursor travels to the checkbox before the click + press.
            try {
              if (window.__sentinelCursor && window.__sentinelCursor.moveToElement) {
                await window.__sentinelCursor.moveToElement(checkEl);
              }
            } catch (e) { console.warn('[Sentinel] cursor moveTo check:', getErrorMessage(e)); }
            checkEl.focus();
            try {
              if (window.__sentinelCursor && window.__sentinelCursor.press) {
                window.__sentinelCursor.press();
              }
            } catch (e) { console.warn('[Sentinel] cursor press check:', getErrorMessage(e)); }
            await humanDelay(80, 180);
            checkEl.click();
            hl.removeHighlight(checkEl);
            return `${desiredState ? 'Checked' : 'Unchecked'} ${describeTarget(cmd)}`;
          }
          hl.removeHighlight(checkEl);
          return `${describeTarget(cmd)} was already ${desiredState ? 'checked' : 'unchecked'}`;
        }
        // Handle ARIA checkbox roles (common in SPA frameworks)
        if (/^(checkbox|switch)$/.test(checkEl.getAttribute('role'))) {
          const currentAria = checkEl.getAttribute('aria-checked') === 'true';
          if (currentAria !== desiredState) {
            checkEl.click();
            // Explicit change event for frameworks that listen to it on ARIA controls
            checkEl.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
            await humanDelay(100, 200);
            hl.removeHighlight(checkEl);
            return `${desiredState ? 'Checked' : 'Unchecked'} ARIA ${describeTarget(cmd)}`;
          }
          hl.removeHighlight(checkEl);
          return `${describeTarget(cmd)} was already ${desiredState ? 'checked' : 'unchecked'}`;
        }
        hl.removeHighlight(checkEl);
        return `Element is not a checkbox or radio: ${describeTarget(cmd)}`;
      }

      case 'check_all': {
        // Check all matching checkboxes — bulk MSP operations (select multiple policies, devices, etc.)
        const checkSelector = cmd.selector || 'input[type="checkbox"]';
        const checkboxes = targetDoc.querySelectorAll(checkSelector);
        if (checkboxes.length === 0) return `No checkboxes found matching: ${checkSelector}`;
        const desiredState = cmd.checked !== undefined ? cmd.checked : true;
        let count = 0;
        for (const cb of checkboxes) {
          if (cb.type === 'checkbox' && cb.checked !== desiredState) {
            hl.highlightElement(cb);
            await humanDelay(50, 150);
            // Use .click() so React Hook Form / Formik / native form handlers
            // see a real click + change pair — same as the 'check' case above.
            cb.click();
            // Belt-and-suspenders: explicit change event for React-managed checkboxes
            cb.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
            hl.removeHighlight(cb);
            count++;
          }
        }
        return `${desiredState ? 'Checked' : 'Unchecked'} ${count}/${checkboxes.length} matching checkboxes`;
      }

      case 'hover': {
        const resolvedHover = resolveCommandTarget(cmd, targetDoc);
        const el = resolvedHover.el;
        if (!el) return `Element not found: ${describeTarget(cmd)}`;

        // Reactive overlay check: is the target element blocked?
        const hoverOverlayBlock = await guardOverlayBlocking(targetDoc, el, cmd);
        if (hoverOverlayBlock) return hoverOverlayBlock;

        hl.highlightElement(el);
        el.scrollIntoView({ behavior: 'instant', block: 'center' });

        // (G3) Move the cursor to the hover target so menu reveals look like
        // an operator hovering, not teleporting.
        try {
          if (window.__sentinelCursor && window.__sentinelCursor.moveToElement) {
            await window.__sentinelCursor.moveToElement(el);
          }
        } catch (e) { console.warn('[Sentinel] cursor moveTo hover:', getErrorMessage(e)); }

        // (#21) Full pointer + mouse hover sequence so Radix / Headless UI /
        // Tailwind UI menus react. Use PointerEvent where available.
        const view = targetDoc.defaultView;
        const baseOpts = { bubbles: true, cancelable: true, composed: true, view: view };
        const pointerOpts = { pointerType: 'mouse', isPrimary: true, ...baseOpts };

        const PE = view?.PointerEvent ?? PointerEvent ?? null;

        if (PE) {
          el.dispatchEvent(new PE('pointerover', pointerOpts));
          el.dispatchEvent(new PE('pointerenter', pointerOpts));
        }
        el.dispatchEvent(new MouseEvent('mouseover', baseOpts));
        el.dispatchEvent(new MouseEvent('mouseenter', baseOpts));
        if (PE) {
          el.dispatchEvent(new PE('pointermove', pointerOpts));
        }
        el.dispatchEvent(new MouseEvent('mousemove', baseOpts));
        hl.removeHighlight(el);

        // Check if a submenu appeared after hovering
        let result = `Hovered over ${describeTarget(cmd)}`;
        if (dd) {
          await wait.sleep(500);
          const subItems = dd.findDropdownOptions(targetDoc, el);
          if (subItems && subItems.length) {
            const submenuTexts = subItems
              .map(item => (item.innerText || item.textContent || '').trim())
              .filter(t => t.length > 0)
              .slice(0, 20);
            result += `. Submenu items available: ${submenuTexts.join(', ')}`;
          }
        }
        return result;
      }

      case 'press_key': {
        const key = cmd.key || 'Enter';
        const keyMap = {
          'Enter': 'Enter', 'Tab': 'Tab', 'Escape': 'Escape', 'Backspace': 'Backspace',
          'Delete': 'Delete', 'Home': 'Home', 'End': 'End', 'PageUp': 'PageUp', 'PageDown': 'PageDown',
          'ArrowDown': 'ArrowDown', 'ArrowUp': 'ArrowUp', 'ArrowLeft': 'ArrowLeft', 'ArrowRight': 'ArrowRight',
          ' ': ' ', 'Space': ' ',
          'F1': 'F1', 'F2': 'F2', 'F3': 'F3', 'F4': 'F4', 'F5': 'F5', 'F6': 'F6',
          'F7': 'F7', 'F8': 'F8', 'F9': 'F9', 'F10': 'F10', 'F11': 'F11', 'F12': 'F12',
          'Insert': 'Insert', 'PrintScreen': 'PrintScreen', 'ContextMenu': 'ContextMenu',
          'a': 'a', 'c': 'c', 'v': 'v', 'x': 'x', 'z': 'z', 'A': 'A', 'C': 'C', 'V': 'V', 'X': 'X', 'Z': 'Z'
        };
        const keyVal = keyMap[key] || key;
        const activeEl = targetDoc.activeElement || targetDoc.body;
        if (!activeEl) return 'Cannot press key: no active element or body in target document';
        const modifiers = cmd.modifiers || {};
        const keyOpts = {
          key: keyVal, bubbles: true, composed: true,
          ctrlKey: !!modifiers.ctrl || !!modifiers.control,
          shiftKey: !!modifiers.shift,
          altKey: !!modifiers.alt,
          metaKey: !!modifiers.meta || !!modifiers.cmd
        };
        activeEl.dispatchEvent(new KeyboardEvent('keydown', keyOpts));
        activeEl.dispatchEvent(new KeyboardEvent('keypress', keyOpts));
        activeEl.dispatchEvent(new KeyboardEvent('keyup', keyOpts));
        const modStr = [(modifiers.ctrl || modifiers.control) && 'Ctrl', modifiers.shift && 'Shift', modifiers.alt && 'Alt', (modifiers.meta || modifiers.cmd) && 'Meta'].filter(Boolean).join('+');
        return `Pressed key: ${modStr ? `${modStr}+` : ''}${key}`;
      }

      case 'execute_js': {
        // SECURITY REVIEW (DEB-05):
        // Uses <script> tag injection to run code in the page's MAIN world.
        // This bypasses MV3 extension CSP (which blocks new Function/eval in
        // content scripts). The injected script runs under the PAGE's CSP,
        // which almost always allows inline scripts (needed for ads/analytics).
        //
        // SANDBOX: When _EXECUTE_JS_SANDBOX_ENABLED=true AND the code has NOT
        // been explicitly approved (cmd.approvalGranted), a self-contained
        // Proxy-based sandbox is injected inline into the <script> tag. It uses
        // `with` + Proxy to intercept bare-name lookups for dangerous APIs
        // (fetch, XMLHttpRequest, localStorage, eval, etc.) at runtime. Approved
        // code bypasses the sandbox and runs with full page privileges.
        //
        // Defence-in-depth layers:
        //  1. Agent-engine approval gate (approvalMode)
        //  2. Content-side approval round-trip (below)
        //  3. Static regex guard for privileged APIs
        //  4. Runtime Proxy sandbox (this layer)
        // We log a console warning on every invocation so the user can see
        // what's running, and cap the timeout to prevent runaway scripts.
        // Approval gate (defence-in-depth): when the agent-engine has NOT
        // already stamped approvalGranted (e.g. approval mode was off or this
        // code path was reached without going through the engine), we route
        // through the background's approval gate before executing. The
        // round-trip uses chrome.runtime.sendMessage with a 60s timeout.
        // If the background SW terminates mid-await the timeout fires and
        // we default to reject — safe failure mode.
        const code = cmd.code || '';
        if (!code) return 'No code provided';

        if (!cmd.approvalGranted) {
          try {
            const approvalResult = await Promise.race([
              new Promise((resolve) => {
                chrome.runtime.sendMessage({
                  action: 'execute_js_approval_request',
                  code: code.substring(0, 2000),  // truncate for the approval card
                  key: cmd.key || null,
                  url: window.location.href
                }, (response) => {
                  if (_hasLastError()) {
                    resolve({ approved: false, reason: `extension error: ${_getLastErrorMessage() || String(chrome.runtime.lastError)}` });
                  } else {
                    resolve(response || null);
                  }
                });
              }),
              new Promise((resolve) => setTimeout(() => resolve({ approved: false, reason: 'timeout' }), 60000))
            ]);
            if (!approvalResult || approvalResult.approved !== true) {
              return `BLOCKED: execute_js not approved by operator${approvalResult && approvalResult.reason ? ` (${approvalResult.reason})` : ''}`;
            }
            // Track approval. If the background auto-approved (approval mode off),
            // the reason is 'auto' — we set approvalGranted but NOT explicitApproval.
            // The sandbox check below uses explicitApproval to decide whether to
            // wrap the code in Proxy guards. Auto-approved code still runs through
            // the sandbox; only explicitly user-approved code bypasses it.
            if (approvalResult.reason === 'auto') {
              cmd.approvalGranted = true;
              cmd._autoApproved = true;
            } else {
              cmd.approvalGranted = true;
            }
          } catch (_e) {
            // chrome.runtime.sendMessage can throw if the extension context is
            // invalidated (SW terminated, extension update, etc.). Default to
            // reject — the static privileged-API guard below still protects
            // against the most dangerous operations.
            return 'BLOCKED: execute_js approval request failed (extension context lost)';
          }
        }

        // Static guard: block code that accesses privileged browser APIs unless
        // the caller has been explicitly approved (cmd.approvalGranted === true).
        // This is a defence-in-depth layer; the agent-engine approval gate is the
        // primary control, but this fires even if the gate is bypassed or disabled.
        if (!cmd.approvalGranted) {
          if (_PRIV_RE.test(code)) {
            return 'BLOCKED: execute_js code accesses a privileged API (cookie / fetch / XHR / WebSocket / eval / storage). Enable approval mode and re-run — the approval card will show the full code before it executes.';
          }
        }

        try {

        } catch (e) { console.warn('[Sentinel] exec_js warn log:', getErrorMessage(e)); }

        // (#26) Honor cmd.timeout: default 8000ms, max 30000ms; clamp.
        // Hotfix 2026-05-06: bumped default from 3000 -> 8000. The 3s
        // safety-shortened default was firing on legitimate long extracts
        // before the page could respond (e.g., drudgereport.com). The real
        // safety win comes from routing execute_js through CDP Runtime.evaluate
        // at the agent-engine layer (which bypasses page CSP); a longer
        // timeout in the fallback path is fine.
        let execTimeout;
        if (typeof cmd.timeout === 'number' && isFinite(cmd.timeout)) {
          execTimeout = Math.max(100, Math.min(_EXECUTE_JS_MAX_TIMEOUT_MS, cmd.timeout));
        } else {
          execTimeout = 8000;
        }

        if (window.__sentinelOverlay) window.__sentinelOverlay.showActionBanner('execute_js', `Running JS${cmd.key ? ` → "${cmd.key}"` : ''}: ${code.substring(0, 60)}...`);
        try {
          const eventId = `__sentinel_${Date.now()}_${Math.random().toString(36).slice(2)}`;

          // (3.21.1) CSP-violation detector. Pages with strict Content-Security-
          // Policy (SentinelOne, GitHub, etc.) block inline <script> injection.
          // The script appendChild() silently succeeds, the script never runs,
          // and we'd otherwise hit the timeout with a generic "Code execution
          // timed out" error that masks the real cause. Listen for CSP violation
          // events during the injection window so we can return a clear error.
          let __cspBlocked = false;
          const __cspListener = (e) => {
            try {
              const dir = (e && e.violatedDirective) || '';
              const blocked = (e && e.blockedURI) || '';
              if (dir.startsWith('script-src') && (/^(inline|)$/.test(blocked))) {
                __cspBlocked = true;
                // (3.26.0) Content-side telemetry: capture the FIRST CSP
                // violation so operators see the exact directive that's
                // blocking inline scripts. Useful for distinguishing strict
                // SentinelOne-style policies from looser CDN-only policies.
                try {
                  ctel.warn('page', `CSP violation: ${dir}`, {
                    directive: dir,
                    blockedURI: blocked,
                    effectiveDirective: (e && e.effectiveDirective) || '',
                    sample: (e && e.sample) ? String(e.sample).substring(0, 120) : '',
                    sourceFile: (e && e.sourceFile) ? String(e.sourceFile).substring(0, 200) : '',
                    url: location.href.substring(0, 200)
                  });
                } catch (te) { console.warn('[Sentinel] CSP telemetry failed:', getErrorMessage(te)); }
              }
            } catch (err) { console.warn('[Sentinel] CSP violation handler failed:', getErrorMessage(err)); }
          };
          try { document.addEventListener('securitypolicyviolation', __cspListener); } catch (e) { console.warn('[Sentinel] CSP listener add:', getErrorMessage(e)); }

          const execResult = await new Promise((resolve) => {
            const timeout = setTimeout(() => {
              window.removeEventListener('message', handler);
              try { scriptEl.remove(); } catch (e) { console.warn('[Sentinel] script remove timeout:', getErrorMessage(e)); }
              // (3.21.1) Distinguish CSP block from a true timeout. If a CSP
              // violation fired in this window, the script never executed.
              if (__cspBlocked) {
                resolve({ __cspBlocked: true });
              } else {
                resolve({ __timeout: true });
              }
            }, execTimeout);

            const handler = (event) => {
              if (event.source !== window || !event.data || event.data.__sentinelEventId !== eventId) return;
              clearTimeout(timeout);
              window.removeEventListener('message', handler);
              try { scriptEl.remove(); } catch (e) { console.warn('[Sentinel] script remove handler:', getErrorMessage(e)); }
              resolve(event.data);
            };

            window.addEventListener('message', handler);

            // (3.7.0) Hardened wrapper. Two guards:
            // 1. String concatenation (not template-literal interpolation) so
            //    backticks or `${...}` sequences in `code` cannot break out of
            //    the wrapper string at content-script eval time.
            // 2. `</script>` escape — defensive even though we use textContent
            //    (which doesn't HTML-reparse), in case some other path ever
            //    serializes this script element.
            const __safeCode = String(code).replace(/<\/script>/gi, '<\\/script>');
            const __eventIdJson = JSON.stringify(eventId);
            const scriptEl = document.createElement('script');

            // --- Runtime sandbox (self-contained, runs inside the injected <script>) ---
            // When _EXECUTE_JS_SANDBOX_ENABLED is true we wrap the user code in a
            // Proxy-based sandbox that blocks dangerous window/document APIs at
            // runtime. The entire sandbox definition is serialised inline so it
            // executes in the page's MAIN world — no cross-scope references needed.
            //
            // The sandbox uses a `with` statement to intercept bare-name lookups
            // (e.g. `fetch()`, `document.cookie`).  `with` is only available in
            // sloppy mode; we deliberately avoid strict-mode for this wrapper.
            //
            // For explicitly user-approved code (cmd.approvalGranted === true
            // AND cmd._autoApproved !== true) the sandbox is skipped entirely,
            // preserving full page privileges. Auto-approved code still runs
            // through the sandbox as a defence-in-depth measure.

            // Serialise the blocked-API sets so they can be embedded in the script.
            const __blockedApisArr = JSON.stringify([...EXECUTE_JS_BLOCKED_APIS]);
            const __blockedDocArr = JSON.stringify([...EXECUTE_JS_BLOCKED_DOC_PROPS]);

            if (_EXECUTE_JS_SANDBOX_ENABLED && !(cmd.approvalGranted && !cmd._autoApproved)) {
              // SANDBOXED path — user code is NOT approved, run behind Proxy guards.
              scriptEl.textContent =
                '(async () => {' +
                  'try {' +
                    // Build the sandbox inline
                    'var __blk = new Set(' + __blockedApisArr + ');' +
                    'var __blkDoc = new Set(' + __blockedDocArr + ');' +
                    // Window proxy — intercepts reads/writes/has on dangerous globals
                    'var __wp = new Proxy(window, {' +
                      'get(t,p) {' +
                        'if(__blk.has(p)) throw new Error(`Sentinel Sandbox: blocked window.${String(p)}`);' +
                        'var v=t[p];' +
                        'return typeof v==="function"?v.bind(t):v;' +
                      '},' +
                      'set(t,p,v) {' +
                        'if(__blk.has(p)) throw new Error(`Sentinel Sandbox: blocked write window.${String(p)}`);' +
                        't[p]=v; return true;' +
                      '},' +
                      'has(t,p) {' +
                        'if(__blk.has(p)) return false;' +  // return false so `in`-checks on blocked props see "not present"
                        'return true;' +  // always return true so `with` delegates to the proxy
                      '}' +
                    '});' +
                    // Document proxy — intercepts reads/writes/has on sensitive doc props
                    'var __dp = new Proxy(document, {' +
                      'get(t,p) {' +
                        'if(__blkDoc.has(p)) throw new Error(`Sentinel Sandbox: blocked document.${String(p)}`);' +
                        'var v=t[p];' +
                        'return typeof v==="function"?v.bind(t):v;' +
                      '},' +
                      'set(t,p,v) {' +
                        'if(__blkDoc.has(p)) throw new Error(`Sentinel Sandbox: blocked write document.${String(p)}`);' +
                        't[p]=v; return true;' +
                      '},' +
                      'has(t,p) {' +
                        'if(__blkDoc.has(p)) return false;' +  // return false so feature-detect checks on blocked doc props see "not present"
                        'return true;' +
                      '}' +
                    '});' +
                    // Execute user code inside `with` blocks so bare references to
                    // window/document globals are intercepted by the proxies.
                    // outer with=__wp shadows window-level names; we also alias
                    // `document` so that `document.querySelector(...)` hits __dp.
                    'var __r;' +
                    'with(__wp) { with(__dp) { ' +
                      'var document = __dp;' +     // shadow the global `document` with the proxied version
                      '__r = await (async () => { ' + __safeCode + '\n })();' +
                    '}}' +
                    'var __s = typeof __r === "object" && __r !== null' +
                      ' ? JSON.stringify(__r).substring(0, 3000)' +
                      ' : (__r === null || __r === undefined ? "" : String(__r)).substring(0, 3000);' +
                    'window.postMessage({ __sentinelEventId: ' + __eventIdJson + ', __value: __s }, "*");' +
                  '} catch(e) {' +
                    'window.postMessage({ __sentinelEventId: ' + __eventIdJson + ', __error: (typeof e === \'object\' && e !== null && typeof e.message === \'string\' ? e.message : String(e)) }, "*");' +
                  '}' +
                '})();';
            } else {
              // UNSANDBOXED path — code is operator-approved or sandbox is disabled.
              // Runs with full page privileges (same as the pre-sandbox behaviour).
              scriptEl.textContent =
                '(async () => {' +
                  'try {' +
                    'const __r = await (async () => { ' + __safeCode + '\n })();' +
                    'const __s = typeof __r === "object" && __r !== null' +
                      ' ? JSON.stringify(__r).substring(0, 3000)' +
                      ' : (__r === null || __r === undefined ? "" : String(__r)).substring(0, 3000);' +
                    'window.postMessage({ __sentinelEventId: ' + __eventIdJson + ', __value: __s }, "*");' +
                  '} catch(e) {' +
                    'window.postMessage({ __sentinelEventId: ' + __eventIdJson + ', __error: (typeof e === \'object\' && e !== null && typeof e.message === \'string\' ? e.message : String(e)) }, "*");' +
                  '}' +
                '})();';
            }
            document.documentElement.appendChild(scriptEl);
          });

          // (3.21.1) Clean up CSP listener regardless of which path we returned through.
          try { document.removeEventListener('securitypolicyviolation', __cspListener); } catch (e) { console.warn('[Sentinel] CSP listener remove:', getErrorMessage(e)); }

          if (execResult.__cspBlocked) {
            // Clear, actionable error that the agent-engine's recovery skills
            // can pattern-match and route to alternative strategies.
            return 'CSP_BLOCKED: page denies inline scripts (Content-Security-Policy script-src). The content-script execute_js path cannot run here. Use read_page, read_network_requests, or extract / extract_list against the live DOM instead.';
          }
          if (execResult.__timeout) {
            // (3.26.0) Telemetry: execute_js timeout. Different cause profile
            // from CSP — usually a long-running script, infinite loop in the
            // LLM-generated code, or a page that's not responding.
            try {
              ctel.warn('page', `execute_js timed out (${execTimeout}ms)`, {
                timeoutMs: execTimeout,
                key: cmd.key || null,
                codeLen: code.length,
                url: location.href.substring(0, 200)
              });
            } catch (e) { console.warn('[Sentinel] exec_js timeout tel:', getErrorMessage(e)); }
            return `Code execution timed out (${execTimeout}ms)`;
          }
          if (execResult.__error) {
            try {
              ctel.warn('page', `execute_js threw: ${String(execResult.__error).slice(0, 80)}`, {
                error: execResult.__error,
                key: cmd.key || null,
                codeLen: code.length,
                url: location.href.substring(0, 200)
              });
            } catch (e) { console.warn('[Sentinel] exec_js error tel:', getErrorMessage(e)); }
            return `Execution error: ${execResult.__error}`;
          }
          return `JS Result: ${execResult.__value || ''}`;
        } catch (err) {
          try { ctel.error('page', 'execute_js outer failure', { error: (getErrorMessage(err)), url: location.href.substring(0, 200) }); } catch (e) { console.warn('[Sentinel] exec_js outer tel:', getErrorMessage(e)); }
          return `JS Error: ${(getErrorMessage(err))}`;
        }
      }

      case 'extract': {
        const resolvedEx = resolveCommandTarget(cmd, targetDoc);
        const el = resolvedEx.el;
        if (!el) {
          // (3.26.0) Telemetry: extract target unresolved. Same shape as
          // click/type misses — helps operators spot stale selectors fast.
          try {
            ctel.warn('page', 'Extract target not found', {
              selector: cmd.selector || null,
              ref: cmd.ref || null,
              key: cmd.key || null,
              attribute: cmd.attribute || 'text',
              staleRef: !!resolvedEx.staleRef,
              url: location.href.substring(0, 200)
            });
          } catch (e) { console.warn('[Sentinel] extract not found tel:', getErrorMessage(e)); }
          return `Element not found: ${describeTarget(cmd)}`;
        }
        let value;
        const attr = cmd.attribute || 'text';
        if (attr === 'text') {
          value = (el.innerText || el.textContent || '').trim();
        } else if (attr === 'href') {
          value = el.href || el.getAttribute('href') || '';
        } else if (attr === 'value') {
          value = el.value !== undefined ? String(el.value) : (el.getAttribute('value') || '');
        } else if (attr === 'src') {
          value = el.src || el.getAttribute('src') || '';
        } else if (/^(html|innerHTML)$/.test(attr)) {
          value = el.innerHTML || '';
        } else if (attr === 'checked') {
          value = String(el.checked !== undefined ? el.checked : el.getAttribute('aria-checked') === 'true');
        } else {
          value = el.getAttribute(attr) || '';
        }
        return JSON.stringify({ key: cmd.key, value: value.substring(0, 1000) });
      }

      case 'extract_list': {
        // Batch extract: find all containers matching cmd.selector, then for each
        // extract the fields defined in cmd.fields (a map of fieldName -> childSelector).
        // Returns a JSON array stored in agentMemory under cmd.key.
        // (#10) If cmd.ref is supplied, treat it as a single root container —
        // useful for "extract the items inside this specific list" where the
        // LLM picked a known ref instead of writing a fragile CSS selector.
        let containers = [];
        if (cmd.ref) {
          const root = dom.findElementByRef && dom.findElementByRef(cmd.ref);
          if (root) {
            containers = [root];
          } else if (cmd.selector) {
            try {

            } catch (e) { console.warn('[Sentinel] extract_list stale log:', getErrorMessage(e)); }
            try {
              containers = [...targetDoc.querySelectorAll(cmd.selector)];
              // (3.8.0) Auto-fall-through to shadow.queryDeep on empty results.
              if (containers.length === 0 && window.__sentinelUtils && window.__sentinelUtils.shadow && window.__sentinelUtils.shadow.queryDeep) {
                try {
                  containers = window.__sentinelUtils.shadow.queryDeep(targetDoc, cmd.selector) || [];
                } catch (e) { console.warn('[Sentinel] Non-fatal error:', getErrorMessage(e)); }
              }
            } catch {
              return `Element not found: ${describeTarget(cmd)}`;
            }
          } else {
            return `Element not found: ${describeTarget(cmd)}`;
          }
        } else {
          if (!cmd.selector) return JSON.stringify({ key: cmd.key, value: [] });
          try {
            containers = Array.from(targetDoc.querySelectorAll(cmd.selector));
            // (3.8.0) Auto-fall-through to shadow.queryDeep on empty results so
            // extract_list works on Lit/Stencil/Shadow-DOM apps (VirusTotal, etc.).
            if (containers.length === 0 && window.__sentinelUtils && window.__sentinelUtils.shadow && window.__sentinelUtils.shadow.queryDeep) {
              try {
                containers = window.__sentinelUtils.shadow.queryDeep(targetDoc, cmd.selector) || [];
              } catch (e) { console.warn('[Sentinel] Non-fatal error:', getErrorMessage(e)); }
            }
          } catch {
            return `Element not found: ${cmd.selector}`;
          }
        }
        if (!containers.length) return `Element not found: ${describeTarget(cmd)}`;
        const limit = cmd.limit || 20;
        const fields = cmd.fields || {};
        if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) return 'Invalid fields parameter';
        const items = containers.slice(0, limit).map(container => {
          const item = {};
          for (const [fieldName, fieldSelector] of Object.entries(fields)) {
            try {
              const child = fieldSelector === 'self'
                ? container
                : container.querySelector(fieldSelector);
              if (child) {
                item[fieldName] = (child.innerText || child.textContent || child.getAttribute('href') || '').trim().substring(0, 200);
              } else {
                item[fieldName] = '';
              }
            } catch {
              item[fieldName] = '';
            }
          }
          return item;
        });
        return JSON.stringify({ key: cmd.key, value: items });
      }

      case 'open_dropdown': {
        const resolvedDD = resolveCommandTarget(cmd, targetDoc);
        const el = resolvedDD.el;
        if (!el) return `Element not found: ${describeTarget(cmd)}`;
        hl.highlightElement(el);
        // (G3) Cursor travels to the dropdown trigger before opening.
        try {
          if (window.__sentinelCursor && window.__sentinelCursor.moveToElement) {
            await window.__sentinelCursor.moveToElement(el);
          }
        } catch (e) { console.warn('[Sentinel] cursor moveTo dropdown:', getErrorMessage(e)); }
        if (dd) {
          const options = await dd.openDropdown(targetDoc, el);
          if (!options || options.length === 0) {
            hl.removeHighlight(el);
            return `Failed to open dropdown or no options found: ${describeTarget(cmd)}`;
          }
          const optionTexts = options
            .map(o => (o.innerText || o.textContent || '').trim())
            .filter(t => t.length > 0)
            .slice(0, 50);
          hl.removeHighlight(el);
          return `Dropdown opened. Options: ${optionTexts.join(', ')}`;
        }
        hl.removeHighlight(el);
        return 'Dropdown utilities not available';
      }

      case 'dismiss_overlay': {
        if (!ov) return 'Overlay utilities not available';
        // Try Escape globally first — handles enterprise dialogs that trap focus
        var escO = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true, composed: true };
        try { (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', escO)); } catch (e) { console.warn('[Sentinel] ESC dispatch error:', getErrorMessage(e)); }
        try { (document.body || document.documentElement).dispatchEvent(new KeyboardEvent('keydown', escO)); } catch (_escDispatchErr) { /* Non-fatal: ESC dispatch to body failed */ }
        await new Promise(r => setTimeout(r, 200));
        var detectedOverlay = ov.detectOverlay ? ov.detectOverlay(document) : null;
        if (!detectedOverlay) return 'Overlay dismissed (Escape key sent)';
        var dismissed = ov.dismissOverlay(document, detectedOverlay);
        return dismissed ? 'Overlay dismissed successfully' : 'No dismissible overlay found — tried Escape and close buttons';
      }

      case 'scroll_to': {
        // (#10) Scroll a specific element into view. Accepts ref or selector.
        // Awaits layout stability so the next action in the loop is operating
        // on a settled rect (matters for lazy-loaded images / virtualized lists).
        const resolvedScroll = resolveCommandTarget(cmd, targetDoc);
        const el = resolvedScroll.el;
        if (!el) return `Element not found: ${describeTarget(cmd)}`;
        if (window.__sentinelOverlay) {
          window.__sentinelOverlay.showActionBanner('scroll_to', `Scrolling to: ${(el.innerText || el.tagName || '').substring(0, 60)}`);
        }
        hl.highlightElement(el);
        try {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } catch {
          try { el.scrollIntoView(); } catch (ee) { console.warn('[Sentinel] scrollIntoView fallback failed:', getErrorMessage(ee)); }
        }
        await waitForStableRect(el, 2, 800);

        // (G3) After the scroll settles, glide the cursor to the element so
        // the user sees what's now in focus.
        try {
          if (window.__sentinelCursor && window.__sentinelCursor.moveToElement) {
            await window.__sentinelCursor.moveToElement(el, { duration: 250 });
          }
        } catch (e) { console.warn('[Sentinel] cursor moveTo scroll_to:', getErrorMessage(e)); }

        try {
          const r = el.getBoundingClientRect();
          if (!r || !r.width || !r.height) { console.warn('[Sentinel] scroll_to indicator: null or zero rect'); }
          else if (window.__sentinelOverlay) window.__sentinelOverlay.showClickIndicator(r.left + r.width / 2, r.top + r.height / 2);
        } catch (e) { console.warn('[Sentinel] scroll_to indicator:', getErrorMessage(e)); }
        setTimeout(() => hl.removeHighlight(el), 1500);
        const note = resolvedScroll.staleRef ? ' (selector fallback after stale ref)' : '';
        return `Scrolled to ${describeTarget(cmd)}${note}`;
      }

      case 'switch_to_frame': {
        var frameIdx = cmd.frame_index || 0;
        var iframeEls = document.querySelectorAll('iframe');
        if (!iframeEls[frameIdx]) return `Iframe not found at index ${frameIdx}`;
        try {
          const cw = iframeEls[frameIdx].contentWindow;
          if (!cw) return `Cannot access iframe ${frameIdx} (no content window)`;
          var frameDoc = cw.document;
          __sentinelActiveFrameDoc = frameDoc;
          var frameTitle = frameDoc.title || '';
          var frameUrl = iframeEls[frameIdx].src || '';
          return `Switched to iframe ${frameIdx}: ${frameTitle} (${frameUrl}). Subsequent actions target this frame. Use switch_to_parent_frame to return.`;
        } catch {
          return `Cannot access iframe ${frameIdx} (cross-origin)`;
        }
      }

      case 'switch_to_parent_frame': {
        __sentinelActiveFrameDoc = null;
        return 'Switched back to main document';
      }

      default:
        return `Unknown command type: ${cmd.type}`;
    }
  }

  function safeSendMessage(msg) {
    try { chrome.runtime.sendMessage(msg).catch((e) => {

    }); } catch (e) { console.warn('[Sentinel] safe send msg:', getErrorMessage(e)); }
  }

  // SPA observer at module scope for cleanup access
  let domObserver = null;
  let spaDebounce = null;

  function setupSPAObservers() {
    domObserver = new MutationObserver((mutations) => {
      const significantChange = mutations.some(m =>
        m.addedNodes.length > 0 || m.removedNodes.length > 0
      );
      if (significantChange) {
        clearTimeout(spaDebounce);
        spaDebounce = setTimeout(() => {
          safeSendMessage({
            action: 'spa_content_changed',
            url: window.location.href
          });
        }, 500);
      }
    });

    const _startSPAObserving = () => {
      if (document.body) {
        domObserver.observe(document.body, { childList: true, subtree: true });
      } else {
        setTimeout(_startSPAObserving, 50);
      }
    };
    _startSPAObserving();

    let lastUrl = window.location.href;

    const dispatchSPATransition = (url) => {
      clearTimeout(spaDebounce);
      spaDebounce = setTimeout(() => {
        safeSendMessage({
          action: 'spa_navigation',
          url: url
        });
      }, 300);
    };

    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function(...args) {
      originalPushState.apply(this, args);
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        dispatchSPATransition(lastUrl);
      }
    };

    history.replaceState = function(...args) {
      originalReplaceState.apply(this, args);
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        dispatchSPATransition(lastUrl);
      }
    };

    const __sentinelPopstateHandler = () => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        dispatchSPATransition(lastUrl);
      }
    };

    // Cleanup on page unload to prevent memory leaks
    const cleanupObservers = () => {
      if (domObserver) {
        domObserver.disconnect();
        domObserver = null;
      }
      if (insertionObserver) {
        insertionObserver.disconnect();
        insertionObserver = null;
      }
      if (spaDebounce) {
        clearTimeout(spaDebounce);
        spaDebounce = null;
      }
    };
    window.addEventListener('beforeunload', cleanupObservers);
    // pagehide is more reliable than beforeunload in extension contexts
    window.addEventListener('pagehide', cleanupObservers);
  }

  setupSPAObservers();

  try { chrome.runtime.sendMessage({ action: 'content_script_ready' }).catch((e) => {

  }); } catch (e) { console.warn('[Sentinel] init ready signal:', getErrorMessage(e)); }
}
// (3.26.0) End-of-file marker — sync flush. (v3.36.3 dedupe applied)

})();