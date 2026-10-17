// popup-modules/chat.js
// Chat UI: goal input, message rendering, action cards, typing indicator, file attachments,
// voice input, command palette, search, export, report card/modal, background message handler.
// Depends on: ui-common.js (sanitizeHtml, isValidUrl, showToast, marked config).
// Depends on: settings.js (toggleTheme).

// ========== User-Friendly Error Messages ==========
// Translates raw API/runtime errors into actionable messages the user can act on.
function friendlyError(raw) {
  if (!raw || typeof raw !== 'string') return 'Something went wrong. Try again or check Settings.';
  const lower = raw.toLowerCase();

  // API key / auth
  if (lower.includes('api key') || lower.includes('api_key') || lower.includes('authentication') || lower.includes('unauthorized') || lower.includes('401'))
    return '🔑 API key issue — open Settings and verify your key is correct.';
  if (lower.includes('forbidden') || lower.includes('403'))
    return '🚫 Access denied — your API key doesn\'t have permission for this model. Check your plan in Settings.';

  // Network
  if (lower.includes('failed to fetch') || lower.includes('networkerror') || lower.includes('net::'))
    return '🌐 Network error — check your internet connection and try again.';
  if (lower.includes('timed out') || lower.includes('timeout') || lower.includes('aborted'))
    return '⏱️ Request timed out — the API took too long to respond. Try again or switch to a faster model.';

  // Rate limits
  if (lower.includes('429') || lower.includes('rate limit') || lower.includes('too many'))
    return '⚡ Rate limited — too many requests. Wait a moment and try again.';

  // Server errors
  if (lower.includes('502') || lower.includes('bad gateway'))
    return '🔧 API server error (502) — the provider is having issues. Try again in a minute.';
  if (lower.includes('503') || lower.includes('service unavailable'))
    return '🔧 API unavailable (503) — the provider is temporarily down. Try again shortly.';

  // Content / model errors
  if (lower.includes('400') && lower.includes('vision'))
    return '👁️ Vision request rejected — try a text-only model or check if screenshots are supported.';
  if (lower.includes('context_length_exceeded') || lower.includes('too many tokens') || lower.includes('max_tokens'))
    return '📏 Request too large — the page content exceeded the model\'s context limit. Try a simpler goal.';

  // Port / extension
  if (lower.includes('disconnected port') || lower.includes('message port closed'))
    return '🔌 Extension connection lost — reload the page and try again.';

  // Fallback
  if (raw.length > 200) return raw.slice(0, 200) + '… — check Settings or try again.';
  return raw;
}
// ========== DOM Elements ==========
const chatContainer = document.getElementById('chat-container');
const stopBtn = document.getElementById('stopBtn');
const injectContextBar = document.getElementById('injectContextBar');
const injectContextInput = document.getElementById('injectContextInput');
const injectContextBtn = document.getElementById('injectContextBtn');
const voiceBtn = document.getElementById('voiceBtn');
const status = document.getElementById('status');
const statusText = document.getElementById('status-text');
const newChatBtn = document.getElementById('newChatBtn');
const commandPaletteBtn = document.getElementById('commandPaletteBtn');
const searchInput = document.getElementById('searchInput');
const previewBtn = document.getElementById('previewBtn');
const markdownPreview = document.getElementById('markdownPreview');
const previewContent = document.getElementById('previewContent');
const attachBtn = document.getElementById('attachBtn');
const fileInput = document.getElementById('file-input');
const attachmentPreview = document.getElementById('attachmentPreview');
const exportBtn = document.getElementById('exportBtn');
const chatExportFormatSelect = document.getElementById('export-format');
const commandPalette = document.getElementById('commandPalette');
const commandPaletteBackdrop = document.getElementById('commandPaletteBackdrop');
const commandInput = document.getElementById('commandInput');
const commandList = document.getElementById('commandList');
const approvalModeToggle = document.getElementById('approvalModeToggle');
const approvalModeLabel = document.getElementById('approvalModeLabel');
const modeBadge = document.getElementById('modeBadge');
const approvalCardContainer = document.getElementById('approvalCardContainer');
const activeIndicator = document.getElementById('activeIndicator');

// ========== Paste Ticket Modal Elements ==========
const pasteTicketBtn = document.getElementById('pasteTicketBtn');
const pasteTicketModal = document.getElementById('paste-ticket-modal');
const closePasteTicketBtn = document.getElementById('closePasteTicketBtn');
const closePasteTicketBtnCancel = document.getElementById('closePasteTicketBtnCancel');
const usePasteTicketBtn = document.getElementById('usePasteTicketBtn');

// ========== Report Modal Elements ==========
const reportModal = document.getElementById('report-modal');
const reportContent = document.getElementById('report-content');
const closeReportBtn = document.getElementById('closeReportBtn');
const copyReportMdBtn = document.getElementById('copyReportMdBtn');
const downloadReportBtn = document.getElementById('downloadReportBtn');
const copyReportTextBtn = document.getElementById('copyReportTextBtn');

// Voice Input - uses webkitSpeechRecognition in the active tab
// (Web Speech API doesn't work in extension popups, so we delegate to the tab)
let _voiceListening = false;
let _voiceListeningTabId = null; // Track which tab we're listening to
let _voiceMessageListener = null;
let _voiceClickHandler = null;

// ========== Tenant Chip (3.7.0) ==========
// eslint-disable-next-line no-unused-vars
function renderTenantChip(tenant, expected) {
  const chip = document.getElementById('tenantChip');
  if (!chip) return;
  if (!tenant || (!tenant.tid && !tenant.onmicrosoft && !tenant.chipText)) {
    chip.style.display = 'none';
    chip.classList.remove('match', 'mismatch');
    chip.textContent = '';
    chip.removeAttribute('title');
    return;
  }
  // Display priority: chipText > onmicrosoft > tid (truncated)
  const display = tenant.chipText || tenant.onmicrosoft || (tenant.tid ? (`tid:${String(tenant.tid).slice(0, 8)}…`) : 'tenant');
  chip.textContent = display;
  chip.style.display = 'inline-flex';

  // Match logic — case-insensitive substring match against any signal.
  if (typeof expected === 'string' && expected.trim()) {
    const expLow = expected.trim().toLowerCase();
    const signals = [
      tenant.chipText || '',
      tenant.onmicrosoft || '',
      tenant.tid || ''
    ].map(s => String(s).toLowerCase());
    const matches = signals.some(s => s && (s.includes(expLow) || expLow.includes(s)));
    chip.classList.toggle('match', matches);
    chip.classList.toggle('mismatch', !matches);
    chip.title = matches
      ? `Tenant matches expected (${expected})`
      : `Tenant MISMATCH — expected "${expected}", saw "${display}"`;
  } else {
    chip.classList.remove('match', 'mismatch');
    chip.title = `Detected tenant: ${display} (set expected tenant in Settings to enable match check)`;
  }
}

// ========== Active Tab Strip (3.7.1) ==========
// Surfaces what tab the agent is on, what step it's on, and what it's doing
// right now — so users watching the side-panel popup can see WHERE and WHAT
// without having to flip to the page tab.

let __atsStripState = {
  visible: false,
  url: '',
  title: '',
  hostname: '',
  tabId: null,
  stepNumber: 0,
  totalSteps: null,
  lastAction: ''
};

function showActiveTabStrip() {
  const strip = document.getElementById('active-tab-strip');
  if (!strip) return;
  strip.style.display = 'flex';
  __atsStripState.visible = true;
}

function hideActiveTabStrip() {
  const strip = document.getElementById('active-tab-strip');
  if (!strip) return;
  strip.style.display = 'none';
  __atsStripState.visible = false;
  __atsStripState.lastAction = '';
}

function updateActiveTabPage(url, title) {
  if (!url) return;
  let host = url;
  try { host = new URL(url).hostname; } catch (_urlErr) { /* URL parse failure is non-critical */ }
  __atsStripState.url = url;
  __atsStripState.title = title || '';
  __atsStripState.hostname = host;

  const elHost = document.getElementById('ats-host');
  const elTitle = document.getElementById('ats-title');
  const elFav = document.getElementById('ats-favicon');
  if (elHost) elHost.textContent = host;
  if (elTitle) elTitle.textContent = title || '';
  if (elFav) {
    // Use Google's favicon service as a stable, no-CORS path. Fallback to a
    // tiny blank if we can't compute a clean URL.
    try {
      elFav.src = `https://www.google.com/s2/favicons?sz=32&domain_url=${encodeURIComponent(host)}`;
    } catch (_favErr) { elFav.src = ''; }
  }
  showActiveTabStrip();
}

function updateActiveTabStep(stepNumber, totalSteps) {
  __atsStripState.stepNumber = stepNumber || 0;
  if (typeof totalSteps === 'number') __atsStripState.totalSteps = totalSteps;
  const elStep = document.getElementById('ats-step');
  if (!elStep) return;
  if (__atsStripState.totalSteps) {
    elStep.textContent = `STEP ${__atsStripState.stepNumber}/${__atsStripState.totalSteps}`;
  } else if (__atsStripState.stepNumber > 0) {
    elStep.textContent = `STEP ${__atsStripState.stepNumber}`;
  } else {
    elStep.textContent = '';
  }
}

// Convert an agent_action payload into a plain-English live status string.
function describeActionPlain(payload) {
  if (!payload) return '';
  const t = payload.type;
  const desc = payload.description || '';
  switch (t) {
    case 'click':       return `Clicking ${payload.targetText ? `"${payload.targetText.length > 50 ? `${payload.targetText.slice(0, 50)}…` : payload.targetText}"` : (desc || payload.selector || 'element')}`;
    case 'click_at':    return `Clicking at coordinates${payload.x !== undefined ? ` (${Math.round(payload.x)},${Math.round(payload.y)})` : ''}`;
    case 'scroll_at':   return `Scrolling${payload.direction ? ` ${payload.direction}` : ''}${payload.x !== undefined ? ` at (${Math.round(payload.x)},${Math.round(payload.y)})` : ''}`;
    case 'zoom_at':     return `Zooming${payload.x !== undefined ? ` at (${Math.round(payload.x)},${Math.round(payload.y)})` : ''}`;
    case 'triple_click_at': return `Triple-clicking at coordinates${payload.x !== undefined ? ` (${Math.round(payload.x)},${Math.round(payload.y)})` : ''}`;
    case 'type': {
      const text = String(payload.text || payload.value || '');
      const safe = (payload.sensitive ? '[sensitive — blocked]' : (text.length > 60 ? `${text.slice(0, 60)}…` : text));
      const target = payload.targetText
        ? `"${payload.targetText.length > 40 ? `${payload.targetText.slice(0, 40)}…` : payload.targetText}"`
        : (desc || '');
      return `Typing "${safe}"${target ? ` into ${target}` : ''}`;
    }
    case 'navigate':    return `Navigating to ${payload.url || desc || ''}`;
    case 'scroll':      return `Scrolling ${payload.amount > 0 ? 'down' : 'up'}`;
    case 'select':      return `Selecting "${payload.value || ''}"${payload.targetText ? ` in "${payload.targetText}"` : (desc ? ` in ${desc}` : '')}`;
    case 'check':       return `${payload.checked ? 'Checking ' : 'Unchecking '}${payload.targetText ? `"${payload.targetText}"` : (desc || payload.selector || 'element')}`;
    case 'hover':       return `Hovering over ${payload.targetText ? `"${payload.targetText}"` : (desc || payload.selector || 'element')}`;
    case 'press_key':   return `Pressing ${payload.key || 'key'}`;
    case 'execute_js':  return `Running JavaScript${payload.key ? ` → memory["${payload.key}"]` : ''}`;
    case 'extract':     return `Extracting ${payload.attribute || 'text'} from ${desc || payload.selector || 'element'}`;
    case 'extract_list':return `Extracting list of items${payload.fields && typeof payload.fields === 'object' ? ` (${Object.keys(payload.fields).join(', ')})` : ''}`;
    case 'read_page':   return 'Reading page content';
    case 'read_console_messages': return 'Reading console messages';
    case 'read_network_requests': return 'Reading network requests';
    case 'wait_for_text':    return `Waiting for text "${payload.text || ''}"`;
    case 'wait_for_element': return `Waiting for element ${payload.selector || payload.ref || ''}`;
    case 'wait_for_navigation': return 'Waiting for navigation';
    case 'open_tab':    return `Opening new tab${payload.label ? ` "${payload.label}"` : ''}`;
    case 'switch_tab':  return `Switching to tab ${payload.label || ''}`;
    case 'close_tab':   return `Closing tab ${payload.label || ''}`;
    case 'note':        return 'Recording note';
    case 'finish':      return 'Finishing task';
    case 'scroll_to':   return `Scrolling to ${desc || payload.ref || payload.selector || ''}`;
    case 'dismiss_overlay': return 'Dismissing overlay';
    case 'open_dropdown': return 'Opening dropdown';
    case 'switch_to_frame': return `Switching to iframe ${payload.frame_index || 0}`;
    default: return `${t}${desc ? ': ' : ''}${desc}`;
  }
}

function updateActiveTabAction(payload) {
  const elAction = document.getElementById('ats-action');
  if (!elAction) return;
  const text = describeActionPlain(payload);
  __atsStripState.lastAction = text;
  elAction.textContent = text;
  // Color-code by action family
  elAction.classList.remove('is-clicking', 'is-typing', 'is-blocked');
  if (payload && (payload.type === 'click' || payload.type === 'click_at' || payload.type === 'triple_click_at')) {
    elAction.classList.add('is-clicking');
  } else if (payload && payload.type === 'type') {
    elAction.classList.add('is-typing');
  }
}

// Wire the Focus button — opens the agent's working tab in Chrome and brings
// it to the front so the user can watch cursor + highlights live alongside.
// (3.8.1) Robust: if no tabId was captured yet, fall back to URL/hostname
// queries so the button always works.
(function wireAtsFocusButton() {
  const btn = document.getElementById('ats-focus-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    let tabId = __atsStripState.tabId;
    // Fallback 1: query by exact URL
    if (!tabId && __atsStripState.url) {
      try {
        const tabs = await chrome.tabs.query({ url: __atsStripState.url });
        if (tabs && tabs.length) tabId = tabs[0].id;
      } catch (_apiErr) { /* extension API may fail */ }
    }
    // Fallback 2: query by hostname pattern
    if (!tabId && __atsStripState.hostname) {
      try {
        const pattern = `*://*.${__atsStripState.hostname.replace(/^www\./, '')}/*`;
        const tabs = await chrome.tabs.query({ url: pattern });
        if (tabs && tabs.length) tabId = tabs[0].id;
      } catch (_apiErr) { /* extension API may fail */ }
    }
    // Fallback 3: bare hostname in URL string match across all tabs
    if (!tabId && __atsStripState.hostname) {
      try {
        const all = await chrome.tabs.query({});
        const match = (all || []).find(t => t.url && t.url.includes(__atsStripState.hostname));
        if (match) tabId = match.id;
      } catch (_apiErr) { /* extension API may fail */ }
    }
    if (!tabId) {
      try { showToast('Could not find the agent\'s tab to focus', 'error'); } catch (_toastErr) { /* showToast may fail in detached popup */ }
      return;
    }
    try { await chrome.tabs.update(tabId, { active: true }); } catch (_updateErr) { /* extension API may fail */ }
    try {
      chrome.tabs.get(tabId, (info) => {
        if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) {

          return;
        }
        if (info && typeof info.windowId === 'number') {
          try { chrome.windows.update(info.windowId, { focused: true }); } catch (_winErr) { /* extension API may fail */ }
        }
      });
    } catch (_tabsErr) { /* chrome.tabs.get callback may fail */ }
  });
})();

// ========== Mini Screenshot Panel (3.7.1) ==========
// Collapsible thumbnail of the most recent observation. Shows the user
// exactly what the agent is "seeing" without leaving the popup.

let __miniShotPanelEl = null;
let __miniShotCollapsed = false;

function ensureMiniShotPanel() {
  if (__miniShotPanelEl) return __miniShotPanelEl;
  const wrap = document.createElement('div');
  wrap.className = 'mini-shot-panel';
  wrap.innerHTML = `
    <div class="mini-shot-header">
      <span>Agent's view (latest)</span>
      <span class="mini-shot-toggle">▾ HIDE</span>
    </div>
    <div class="mini-shot-img-wrap" style="position:relative;">
      <img id="mini-shot-img" alt="" style="display:block; width:100%;">
      <svg id="mini-shot-crosshair" style="display:none; position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none;" xmlns="http://www.w3.org/2000/svg">
        <line id="msc-h" stroke="#ff4444" stroke-width="1.5" stroke-dasharray="4 3"/>
        <line id="msc-v" stroke="#ff4444" stroke-width="1.5" stroke-dasharray="4 3"/>
        <circle id="msc-dot" r="5" fill="none" stroke="#ff4444" stroke-width="2"/>
      </svg>
    </div>
  `;
  // Insert below the active-tab strip, before the chat container.
  const strip = document.getElementById('active-tab-strip');
  if (strip && strip.parentNode) {
    strip.parentNode.insertBefore(wrap, strip.nextSibling);
  } else {
    if (document.body) document.body.insertBefore(wrap, document.body.firstChild);
  }
  // Toggle collapse on header click
  const miniShotHeader = wrap.querySelector('.mini-shot-header');
  if (miniShotHeader) {
    miniShotHeader.addEventListener('click', () => {
      __miniShotCollapsed = !__miniShotCollapsed;
      wrap.classList.toggle('collapsed', __miniShotCollapsed);
      const tog = wrap.querySelector('.mini-shot-toggle');
      if (tog) tog.textContent = __miniShotCollapsed ? '▸ SHOW' : '▾ HIDE';
    });
  }
  __miniShotPanelEl = wrap;
  return wrap;
}

function hideMiniShot() {
  if (__miniShotPanelEl) __miniShotPanelEl.style.display = 'none';
}
function showMiniShot() {
  if (__miniShotPanelEl) __miniShotPanelEl.style.display = '';
}

let __lastClickCoords = null; // (7.1) last click_at coords for crosshair overlay
let __lastViewportSize = null; // (7.1) viewport size from screenshotMeta for coord scaling

function showCrosshair(x, y, viewportW, viewportH) {
  const panel = __miniShotPanelEl;
  if (!panel) return;
  const svg = panel.querySelector('#mini-shot-crosshair');
  if (!svg) return;
  if (!viewportW || !viewportH || viewportW <= 0 || viewportH <= 0 || typeof x !== 'number' || typeof y !== 'number') { svg.style.display = 'none'; return; }
  const px = `${(x / viewportW * 100).toFixed(2)}%`;
  const py = `${(y / viewportH * 100).toFixed(2)}%`;
  const h = svg.querySelector('#msc-h'); const v = svg.querySelector('#msc-v'); const dot = svg.querySelector('#msc-dot');
  if (h) { h.setAttribute('x1', '0%'); h.setAttribute('x2', '100%'); h.setAttribute('y1', py); h.setAttribute('y2', py); }
  if (v) { v.setAttribute('x1', px); v.setAttribute('x2', px); v.setAttribute('y1', '0%'); v.setAttribute('y2', '100%'); }
  if (dot) { dot.setAttribute('cx', px); dot.setAttribute('cy', py); }
  svg.style.display = 'block';
  // Auto-hide after 3 seconds
  setTimeout(() => { if (svg) svg.style.display = 'none'; }, 3000);
}

// ========== Zoom & Inspect — Click-to-Zoom Overlay ==========
// Clicking on the mini screenshot opens a full-screen zoom overlay at 2x,
// centered on the clicked point. Click again to dismiss. The zoom transform
// origin is set to the click position so the region of interest fills the
// viewport. A zoom hint badge appears on the thumbnail to indicate clickability.

let __zoomOverlayEl = null;
let __zoomHintAdded = false;

function _addZoomHintToMiniShot(panel) {
  if (__zoomHintAdded) return;
  __zoomHintAdded = true;
  const hint = document.createElement('div');
  hint.style.cssText = 'position:absolute;bottom:4px;right:4px;background:rgba(0,0,0,0.6);color:#fff;font-size:10px;padding:1px 5px;border-radius:3px;pointer-events:none;z-index:1;';
  hint.textContent = '🔍 Click to zoom';
  const imgWrap = panel.querySelector('.mini-shot-img-wrap');
  if (imgWrap) {
    imgWrap.style.cursor = 'zoom-in';
    imgWrap.appendChild(hint);
  }
}

function _openZoomOverlay(imgSrc, clickXPct, clickYPct) {
  if (__zoomOverlayEl) __zoomOverlayEl.remove();
  const overlay = document.createElement('div');
  overlay.id = 'zoom-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.92);z-index:10000;display:flex;align-items:center;justify-content:center;cursor:zoom-out;';
  const zoomedImg = document.createElement('img');
  zoomedImg.src = imgSrc;
  zoomedImg.style.cssText = 'max-width:95%;max-height:95%;object-fit:contain;transform:scale(2);transform-origin:' + clickXPct + '% ' + clickYPct + '%;transition:transform 0.2s ease;';
  zoomedImg.draggable = false;
  overlay.appendChild(zoomedImg);
  // Close on click
  overlay.addEventListener('click', () => { overlay.remove(); __zoomOverlayEl = null; });
  // Close on Escape
  const escHandler = (e) => {
    if (e.key === 'Escape') { overlay.remove(); __zoomOverlayEl = null; document.removeEventListener('keydown', escHandler); }
  };
  document.addEventListener('keydown', escHandler);
  document.body.appendChild(overlay);
  __zoomOverlayEl = overlay;
}

function updateMiniShot(base64Image) {
  if (!base64Image) return;
  const panel = ensureMiniShotPanel();
  const img = panel.querySelector('#mini-shot-img');
  if (img) img.src = `data:image/jpeg;base64,${base64Image}`;
  // Wire zoom-on-click and hint badge
  _wireMiniShotZoom(panel);
  _addZoomHintToMiniShot(panel);
}

function _wireMiniShotZoom(panel) {
  const img = panel.querySelector('#mini-shot-img');
  if (!img || img._zoomWired) return;
  img._zoomWired = true;
  img.addEventListener('click', (e) => {
    e.stopPropagation();
    const rect = img.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const clickXPct = ((e.clientX - rect.left) / rect.width * 100).toFixed(1);
    const clickYPct = ((e.clientY - rect.top) / rect.height * 100).toFixed(1);
    _openZoomOverlay(img.src, clickXPct, clickYPct);
  });
}

// ========== Approval Mode ==========
// On first run (when `approvalMode` has never been written), default to ON
// for safety. Users must explicitly opt out via a confirmation dialog.
// eslint-disable-next-line no-unused-vars
function loadApprovalMode() {
  chrome.storage.local.get(['approvalMode'], (result) => {
    if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) { console.error('[Sentinel/chat] loadApprovalMode failed:', getErrorMessage(chrome.runtime.lastError)); return; }
    let isApprovalMode;
    if (typeof result.approvalMode !== 'undefined' && result.approvalMode !== null) {
      isApprovalMode = result.approvalMode;
    } else {
      // First run -- default to ON and persist so subsequent reads are deterministic.
      isApprovalMode = true;
      chrome.storage.local.set({ approvalMode: true }).catch((e) => { console.error('[Sentinel] Error in chat.js:', getErrorMessage(e)); });
    }
    if (approvalModeToggle) approvalModeToggle.checked = isApprovalMode;
    updateApprovalModeUI(isApprovalMode);

    // Optional first-run safety banner (#5 from the task list)
    maybeShowSafetyBanner();
  });
}

// eslint-disable-next-line no-unused-vars
function setupApprovalModeToggle() {
  if (!approvalModeToggle) return;
  approvalModeToggle.addEventListener('change', () => {
    const isApprovalMode = approvalModeToggle.checked;

    // Disabling approvals is the dangerous direction -- confirm first.
    if (!isApprovalMode) {
      const ok = window.confirm(
        `Disabling approvals lets the agent submit forms, click buy/send, and run JavaScript without asking. Continue?

OK = I understand the risks (continue without approvals)
Cancel = Keep approvals on (recommended)`
      );
      if (!ok) {
        // Revert the toggle; do NOT persist.
        approvalModeToggle.checked = true;
        updateApprovalModeUI(true);
        return;
      }
      // User accepted the risk: persist OFF + acknowledgement flag.
      chrome.storage.local.set({
        approvalMode: false,
        approvalModeAcknowledged: true
      }).catch((e) => { console.warn('[Sentinel/chat] Failed to persist approval mode:', getErrorMessage(e)); });
      updateApprovalModeUI(false);
      return;
    }

    // Re-enabling approvals is always safe; persist immediately.
    chrome.storage.local.set({ approvalMode: true }).catch((e) => { console.error('[Sentinel] Error in chat.js:', getErrorMessage(e)); });
    updateApprovalModeUI(true);
  });
}

function updateApprovalModeUI(isApprovalMode) {
  if (isApprovalMode) {
    if (approvalModeLabel) approvalModeLabel.textContent = 'APPROVAL REQUIRED (recommended)';
    if (modeBadge) { modeBadge.textContent = 'APPROVAL'; modeBadge.className = 'mode-badge approval'; }
  } else {
    if (approvalModeLabel) approvalModeLabel.textContent = 'AUTONOMOUS (caution)';
    if (modeBadge) { modeBadge.textContent = 'AUTONOMOUS'; modeBadge.className = 'mode-badge yolo'; }
  }
}

// ========== First-run Safety Banner ==========
function maybeShowSafetyBanner() {
  chrome.storage.local.get(['seenSafetyBanner'], (result) => {
    if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) { console.error('[Sentinel/chat] maybeShowSafetyBanner failed:', getErrorMessage(chrome.runtime.lastError)); return; }
    if (result.seenSafetyBanner) return;

    if (!chatContainer) return;
    const welcome = chatContainer.querySelector('.welcome-message');
    const banner = document.createElement('div');
    banner.className = 'safety-banner';
    banner.id = 'safety-banner';
    banner.innerHTML = `
      <div class="safety-banner-header">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2L3 7v6c0 5 3.5 9.5 9 11 5.5-1.5 9-6 9-11V7l-9-5z"></path>
        </svg>
        <span>Before you start</span>
      </div>
      <ul class="safety-banner-list">
        <li>The agent runs with your full browser session privileges (cookies, logged-in sites).</li>
        <li>Approval mode is <strong>on by default</strong>. You will be asked before risky actions.</li>
        <li>Sensitive fields (passwords, SSN, credit cards) are blocked at the content-script level.</li>
        <li>See the README for the complete safety model.</li>
      </ul>
      <div class="safety-banner-actions">
        <button class="safety-banner-dismiss" id="dismissSafetyBanner">Got it</button>
      </div>
    `;

    // Insert above the welcome message if present, otherwise at the top of the chat.
    if (welcome) {
      chatContainer.insertBefore(banner, welcome);
    } else {
      chatContainer.insertBefore(banner, chatContainer.firstChild);
    }

    const dismissSafetyBanner = document.getElementById('dismissSafetyBanner');
    if (dismissSafetyBanner) {
      dismissSafetyBanner.addEventListener('click', () => {
        chrome.storage.local.set({ seenSafetyBanner: true }).catch((e) => { console.error('[Sentinel] Error in chat.js:', getErrorMessage(e)); });
        banner.remove();
      });
    }
  });
}

// Words that indicate a high-risk action — used to highlight the approval card.
const RISKY_ACTION_PATTERN = /\b(submit|buy|send|transfer|wire|delete|publish|purchase|checkout|post|confirm|accept terms)\b/i;

// Precompile regex patterns for performance
const EXECUTE_JS_ACTION_RE = /^(execute_js|run_js)$/;
const REJECTED_SKIPPED_RE = /^(rejected|skipped)$/;
const ERROR_PREFIX_RE = /^❌|Error|failed/;
const RETRY_PREFIX_RE = /^⚠️|Retrying/;
const NAVIGATE_SEARCH_RE = /go to|navigate|search/;
const INPUT_TEXTAREA_RE = /^(INPUT|TEXTAREA)$/;
const CSV_QUOTE_RE = /[",\n\r]/;
const SOURCE_TAG_RE = /\[src:([a-z0-9_-]+)\]|\[unverified\]/gi;
const COST_EXTRACTION_RE = /\$[\d.]+/;

function showApprovalCard(payload) {
  if (!approvalCardContainer) return;
  removeApprovalCard();

  const description = (payload && typeof payload.description === 'string') ? payload.description : '';
  const stepNumber = (payload && payload.stepNumber) || '?';
  const requestId = payload && payload.requestId;
  const actionType = payload && payload.type;
  // Prefer human-readable target label over raw CSS selector in the card subtitle
  const targetLabel = (payload && (payload.ariaLabel || payload.elementText || payload.selector)) || null;
  // Code body for execute_js / run_js -style actions. Several historical field
  // names are tolerated so this card stays compatible regardless of which one
  // the background sends.
  const code = payload && (payload.code || payload.script || payload.js);
  const isCode = (EXECUTE_JS_ACTION_RE.test(actionType) || !!code);
  const isRisky = RISKY_ACTION_PATTERN.test(description);

  const card = document.createElement('div');
  card.className = 'approval-card';
  card.id = 'approval-card';
  if (requestId) card.dataset.requestId = requestId;
  card.dataset.description = description;

  // Build the action body separately so we can choose between the scrollable
  // text view and the monospace code view.
  let bodyHtml;
  if (isCode) {
    const codeText = code || description;
    bodyHtml = `
      <div class="approval-card-code-label">JavaScript code (will run with full page privileges)</div>
      <div class="approval-card-action approval-card-code${isRisky ? ' risky' : ''}">${escapeHtml(codeText)}</div>
    `;
  } else {
    bodyHtml = `<div class="approval-card-action${isRisky ? ' risky' : ''}">${escapeHtml(description)}</div>`;
  }

  card.innerHTML = `
    <div class="approval-card-header">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
        <line x1="12" y1="9" x2="12" y2="13"></line>
        <line x1="12" y1="17" x2="12.01" y2="17"></line>
      </svg>
      <span>Agent requests approval${isRisky ? ' — risky' : ''}</span>
    </div>
    <div class="approval-card-step">Step #${escapeHtml(String(stepNumber))}${actionType ? ` &middot; ${escapeHtml(String(actionType))}` : ''}${targetLabel ? ` &middot; <em>${escapeHtml(String(targetLabel).slice(0, 80))}</em>` : ''}</div>
    ${bodyHtml}
    <div class="approval-card-buttons">
      <button class="approval-btn approve" id="approvalApprove">Approve</button>
      <button class="approval-btn reject" id="approvalReject">Reject</button>
      <button class="approval-btn skip" id="approvalSkip">Skip</button>
    </div>
  `;

  approvalCardContainer.appendChild(card);

  // Scroll to show the card
  approvalCardContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Wire up buttons. Capture description + requestId so the response handler
  // and the skip/reject system note can reference them.
  const approvalApprove = document.getElementById('approvalApprove');
  const approvalReject = document.getElementById('approvalReject');
  const approvalSkip = document.getElementById('approvalSkip');
  if (approvalApprove) approvalApprove.addEventListener('click', () => respondApproval('approved', { requestId, description }));
  if (approvalReject) approvalReject.addEventListener('click', () => respondApproval('rejected', { requestId, description }));
  if (approvalSkip) approvalSkip.addEventListener('click', () => respondApproval('skipped', { requestId, description }));
}

function removeApprovalCard() {
  const card = document.getElementById('approval-card');
  if (card) card.remove();
}

function respondApproval(decision, context) {
  const ctx = context || {};
  removeApprovalCard();

  const message = {
    action: 'approval_response',
    approved: decision === 'approved',
    skipped: decision === 'skipped',
    rejected: decision === 'rejected'
  };
  // Mirror the requestId back so the background can match the response to the
  // pending request (per the contract with Agent A).
  if (ctx.requestId) message.requestId = ctx.requestId;

  chrome.runtime.sendMessage(message).catch((e) => { console.error('[Sentinel] Error in chat.js:', getErrorMessage(e)); });

  // Show a UX-only system note for skip/reject so the user can see the
  // rejection in the chat history. The actual injection into the LLM history
  // is handled server-side.
  if (REJECTED_SKIPPED_RE.test(decision)) {
    appendSkipRejectionNote(decision, ctx.description);
  }
}

function appendSkipRejectionNote(decision, description) {
  const desc = (description && description.trim()) ? description : '(no description)';
  const verb = decision === 'rejected' ? 'rejected' : 'skipped';

  const wrapper = document.createElement('div');
  wrapper.className = 'message-group skip-note-group';

  const note = document.createElement('div');
  note.className = 'skip-note';
  note.textContent = `User ${verb}: ${desc}. Agent should choose an alternative path.`;

  wrapper.appendChild(note);
  chatContainer.appendChild(wrapper);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

// ========== Claude-style Action Cards ==========
// eslint-disable-next-line no-unused-vars
function addActionCard(payload) {
  const state = getState();
  const welcome = chatContainer.querySelector('.welcome-message');
  if (welcome) welcome.remove();

  const group = document.createElement('div');
  group.className = 'message-group agent-action-group';

  const wrapper = document.createElement('div');
  wrapper.className = 'message-wrapper assistant-wrapper';

  const msg = document.createElement('div');
  msg.className = 'message assistant-msg agent-action-card';
  msg.id = `agent-action-${payload.stepNumber}`;

  const inner = document.createElement('div');
  inner.className = 'agent-action-inner';

  const header = document.createElement('div');
  header.className = 'agent-action-header';

  // Click header only to expand/collapse (not the whole card, so log lines are selectable)
  header.style.cursor = 'pointer';
  header.addEventListener('click', () => {
    inner.classList.toggle('collapsed');
  });

  const typeLabel = document.createElement('span');
  typeLabel.className = 'agent-action-type';
  typeLabel.textContent = payload.type;

  const stepLabel = document.createElement('span');
  stepLabel.className = 'agent-action-step';
  stepLabel.textContent = `Step ${payload.stepNumber}`;

  const collapseIndicator = document.createElement('span');
  collapseIndicator.className = 'collapse-indicator';

  const resultBadge = document.createElement('span');
  resultBadge.className = 'collapse-result-badge';
  resultBadge.id = `agent-badge-${payload.stepNumber}`;

  header.appendChild(typeLabel);
  header.appendChild(stepLabel);
  header.appendChild(resultBadge);
  header.appendChild(collapseIndicator);

  const desc = document.createElement('div');
  desc.className = 'agent-action-desc';
  desc.textContent = payload.description;

  // Step log area: shows observing/consulting/executing timeline within the card
  const logArea = document.createElement('div');
  logArea.className = 'step-log';
  logArea.id = `step-log-${payload.stepNumber}`;

  inner.appendChild(header);
  inner.appendChild(desc);
  inner.appendChild(logArea);

  msg.appendChild(inner);
  wrapper.appendChild(msg);
  group.appendChild(wrapper);

  chatContainer.appendChild(group);

  // Drain any log lines that arrived before this card was created
  const logs = state.pendingStepLogs[payload.stepNumber];
  if (logs && Array.isArray(logs) && logs.length) {
    logs.forEach(text => appendLogLine(payload.stepNumber, text));
    delete state.pendingStepLogs[payload.stepNumber];
  }

  chatContainer.scrollTop = chatContainer.scrollHeight;
}

// Append a log line to the step log area. If the card doesn't exist yet, buffer it.
function appendLogLine(stepNumber, text) {
  const state = getState();
  const logArea = document.getElementById(`step-log-${stepNumber}`);
  if (!logArea) {
    // Card not created yet -- buffer it
    if (!state.pendingStepLogs[stepNumber]) state.pendingStepLogs[stepNumber] = [];
    const arr = state.pendingStepLogs[stepNumber];
    if (Array.isArray(arr)) arr.push(text);
    return;
  }
  const line = document.createElement('div');
  line.className = 'step-log-line';
  // Detect error/warning state for styling
  if (ERROR_PREFIX_RE.test(text)) {
    line.classList.add('log-error');
  } else if (RETRY_PREFIX_RE.test(text)) {
    line.classList.add('log-warn');
  } else if (text.startsWith('✅')) {
    line.classList.add('log-success');
  }
  line.textContent = text;
  logArea.appendChild(line);
  // Auto-scroll the chat
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function updateActionCardResult(stepNumber, resultText, isError) {
  const card = document.getElementById(`agent-action-${stepNumber}`);
  if (!card) return;

  const inner = card.querySelector('.agent-action-inner');
  if (!inner) return;

  const existing = inner.querySelector('.agent-action-result');
  if (existing) existing.remove();

  const result = document.createElement('div');
  result.className = `agent-action-result ${isError ? 'error' : 'success'}`;
  result.textContent = isError ? `Failed: ${resultText}` : resultText;
  inner.appendChild(result);

  // Update the collapsed badge
  const badge = document.getElementById(`agent-badge-${stepNumber}`);
  if (badge) {
    badge.className = `collapse-result-badge ${isError ? 'error' : 'success'}`;
    badge.innerHTML = isError
      ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>'
      : '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>';
  }

  // Auto-collapse after 2 seconds (Claude-style: show then vanish)
  setTimeout(() => {
    inner.classList.add('collapsed');
  }, 2000);
}

// ========== Chat History ==========

/**
 * Render a message bubble into the chat container WITHOUT touching
 * conversationHistory or storage. Used by loadChatHistory() to replay
 * stored messages without doubling the state.
 */
function _renderMessageBubble(textStr, role) {
  if (!chatContainer) return;

  const messageGroup = document.createElement('div');
  messageGroup.className = 'message-group';

  const wrapper = document.createElement('div');
  wrapper.className = `message-wrapper ${role === 'user' ? 'user-wrapper' : 'assistant-wrapper'}`;

  const msg = document.createElement('div');
  msg.className = `message ${role === 'user' ? 'user-msg' : 'assistant-msg'}`;

  if (role === 'user') {
    msg.textContent = textStr;
  } else {
    try {
      msg.innerHTML = sanitizeHtml(marked.parse(textStr));
      addCodeCopyButtons(msg);
    } catch (err) {
      msg.textContent = textStr;

    }
  }

  const copyBtn = document.createElement('button');
  copyBtn.className = 'message-copy-btn';
  copyBtn.title = 'Copy message';
  copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
  copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(textStr).then(() => {
      copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
      copyBtn.classList.add('copied');
      setTimeout(() => {
        copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
        copyBtn.classList.remove('copied');
      }, 2000);
    }).catch((e) => { console.warn('[Sentinel/chat] Copy failed:', getErrorMessage(e)); });
  });

  wrapper.appendChild(msg);
  wrapper.appendChild(copyBtn);
  messageGroup.appendChild(wrapper);
  chatContainer.appendChild(messageGroup);
}

// Deduplicate conversation history by removing consecutive duplicate turns.
// This repairs data corrupted by the previous loadChatHistory bug that
// doubled the array on every popup open.
function _dedupHistory(history) {
  if (!Array.isArray(history) || history.length === 0) return history;
  const deduped = [history[0]];
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1];
    const curr = history[i];
    if (curr && prev && curr.text === prev.text && curr.role === prev.role) {
      continue; // skip duplicate
    }
    deduped.push(curr);
  }
  return deduped;
}

const CHAT_HISTORY_MAX = 200; // cap to prevent runaway growth

// eslint-disable-next-line no-unused-vars
function loadChatHistory() {
  const state = getState();
  chrome.storage.local.get(['chat_history'], (result) => {
    if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) { console.error('[Sentinel/chat] loadChatHistory failed:', getErrorMessage(chrome.runtime.lastError)); return; }
    if (Array.isArray(result.chat_history) && result.chat_history.length) {
      // Repair corrupted history (dedup + cap)
      let history = _dedupHistory(result.chat_history);
      if (history.length > CHAT_HISTORY_MAX) {

        history = history.slice(-CHAT_HISTORY_MAX);
      }
      // Persist the cleaned-up version if it changed
      if (history.length !== result.chat_history.length) {
        chrome.storage.local.set({ chat_history: history }).catch((e) => {
          console.error('[Sentinel/chat] failed to persist deduped history:', getErrorMessage(e));
        });
      }
      // Set state ONCE — do NOT call addMessage (which would push + save again)
      state.conversationHistory = history;
      if (chatContainer) chatContainer.innerHTML = '';
      history.forEach(turn => {
        if (turn && typeof turn.text === 'string') {
          _renderMessageBubble(turn.text, turn.role || 'assistant');
        }
      });
      chatContainer.scrollTop = chatContainer.scrollHeight;
      hideStatus();
    }
  });
}

function saveChatHistory() {
  try {
    const state = getState();
    chrome.storage.local.set({ chat_history: state.conversationHistory }).catch((e) => { console.error('[Sentinel] Error in chat.js:', getErrorMessage(e)); });
  } catch (_e) { /* storage unavailable */ }
}

// ========== Error Card (ERR-02, ERR-03) ==========

/**
 * Render an AgentError as a styled card in the chat stream.
 * Shows: error code, message, suggestion, and a Retry button if retryable.
 * @param {object} errorData - AgentError.toJSON() payload
 */
function renderErrorCard(errorData) {
  const welcome = chatContainer ? chatContainer.querySelector('.welcome-message') : null;
  if (welcome) welcome.remove();

  const card = document.createElement('div');
  card.className = 'message-group agent-error-card';
  card.dataset.errorCode = errorData.code || 'UNKNOWN';
  card.dataset.retryable = errorData.retryable ? 'true' : 'false';
  card.dataset.context = JSON.stringify(errorData.context || {});

  const retryBtn = errorData.retryable
    ? `<button class="error-retry-btn" style="margin-top:8px; padding:4px 12px; border:1px solid var(--error-color, #f44336); background:transparent; color:var(--error-color, #f44336); border-radius:4px; cursor:pointer; font-size:12px;">Retry</button>`
    : '';

  card.innerHTML = `
    <div class="message assistant-msg" style="border-left:3px solid var(--error-color, #f44336); padding:10px 14px; background:rgba(244,67,54,0.08); border-radius:6px;">
      <div style="font-weight:600; font-size:13px; color:var(--error-color, #f44336);">
        ${escapeHtml(errorData.code || 'ERROR')}
      </div>
      <div style="font-size:12px; margin-top:4px;">${escapeHtml(errorData.message || 'Unknown error')}</div>
      ${errorData.suggestion ? `<div style="font-size:11px; margin-top:6px; color:var(--text-secondary);">Suggestion: ${escapeHtml(errorData.suggestion)}</div>` : ''}
      <details style="margin-top:6px; font-size:11px; color:var(--text-secondary);">
        <summary style="cursor:pointer;">Technical details</summary>
        <pre style="margin-top:4px; white-space:pre-wrap; font-size:10px;">${escapeHtml(JSON.stringify(errorData.context || {}, null, 2))}</pre>
      </details>
      ${retryBtn}
    </div>
  `;

  const retryButton = card.querySelector('.error-retry-btn');
  if (retryButton && errorData.retryable) {
    retryButton.addEventListener('click', () => {
      const ctx = errorData.context || {};
      if (ctx.goal) {
        const goalInput = document.getElementById('goalInput');
        if (goalInput) goalInput.value = ctx.goal;
        card.remove();
        // Re-fire the goal through the normal send path
        const sendBtn = document.getElementById('sendBtn');
        if (sendBtn) sendBtn.click();
      } else {
        showToast('No context available for retry', 'error');
      }
    });
  }

  if (chatContainer) chatContainer.appendChild(card);
  if (chatContainer) chatContainer.scrollTop = chatContainer.scrollHeight;
}

// ========== Message Handling ==========
function addMessage(text, role = 'assistant') {
  const state = getState();
  const welcome = chatContainer.querySelector('.welcome-message');
  if (welcome) welcome.remove();

  // Ensure text is always a string
  let textStr;
  if (typeof text === 'string') {
    textStr = text;
  } else {
    try {
      textStr = JSON.stringify(text);
    } catch (e) {
      textStr = getErrorMessage(e);
    }
  }

  if (!Array.isArray(state.conversationHistory)) {
    state.conversationHistory = [];
  }

  state.conversationHistory.push({ text: textStr, role });
  saveChatHistory();

  const messageGroup = document.createElement('div');
  messageGroup.className = 'message-group';
  messageGroup.dataset.messageIndex = state.conversationHistory.length - 1;

  const wrapper = document.createElement('div');
  wrapper.className = `message-wrapper ${role === 'user' ? 'user-wrapper' : 'assistant-wrapper'}`;

  const msg = document.createElement('div');
  msg.className = `message ${role === 'user' ? 'user-msg' : 'assistant-msg'}`;

  if (role === 'user') {
    msg.textContent = textStr;
  } else {
    try {
      msg.innerHTML = sanitizeHtml(marked.parse(textStr));
      addCodeCopyButtons(msg);
    } catch (err) {
      msg.textContent = textStr;

    }
  }

  const copyBtn = document.createElement('button');
  copyBtn.className = 'message-copy-btn';
  copyBtn.title = 'Copy message';
  copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
  copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const textToCopy = textStr;
    navigator.clipboard.writeText(textToCopy).then(() => {
      copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
      copyBtn.classList.add('copied');
      setTimeout(() => {
        copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
        copyBtn.classList.remove('copied');
      }, 2000);
    }).catch((e) => { console.warn('[Sentinel/chat] Copy failed:', getErrorMessage(e)); });
  });

  wrapper.appendChild(msg);
  wrapper.appendChild(copyBtn);
  messageGroup.appendChild(wrapper);
  chatContainer.appendChild(messageGroup);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function addCodeCopyButtons(messageElement) {
  if (!messageElement) return;
  const codeBlocks = messageElement.querySelectorAll('pre');
  codeBlocks.forEach(pre => {
    const code = pre.querySelector('code');
    if (code) {
      const lang = code.className.replace('language-', '') || 'plaintext';

      const header = document.createElement('div');
      header.className = 'code-header';

      const langSpan = document.createElement('span');
      langSpan.textContent = lang;

      const copyBtn = document.createElement('button');
      copyBtn.className = 'code-copy-btn';
      copyBtn.textContent = 'Copy';

      copyBtn.addEventListener('click', () => {
        const text = code.textContent;
        navigator.clipboard.writeText(text).then(() => {
          copyBtn.textContent = 'Copied!';
          copyBtn.classList.add('copied');
          setTimeout(() => {
            copyBtn.textContent = 'Copy';
            copyBtn.classList.remove('copied');
          }, 2000);
        }).catch((e) => { console.warn('[Sentinel/chat] Copy failed:', getErrorMessage(e)); });
      });

      header.appendChild(langSpan);
      header.appendChild(copyBtn);
      pre.insertBefore(header, code);
    }
  });
}

// ========== Typing Indicator ==========
function showTypingIndicator() {
  const wrapper = document.createElement('div');
  wrapper.className = 'message-wrapper assistant-wrapper';
  wrapper.id = 'typing-indicator';

  const indicator = document.createElement('div');
  indicator.className = 'status-indicator';
  indicator.innerHTML = `
    <span class="loading-dot"></span>
    <span class="loading-dot"></span>
    <span class="loading-dot"></span>
    <span>Sentinel Override is thinking...</span>
  `;

  wrapper.appendChild(indicator);
  chatContainer.appendChild(wrapper);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function removeTypingIndicator() {
  const indicator = document.getElementById('typing-indicator');
  if (indicator) indicator.remove();
}

// ========== Status Updates ==========
function updateStatus(text) {
  if (statusText) statusText.textContent = text;
  if (status) status.style.display = 'block';
}

function hideStatus() {
  if (status) status.style.display = 'none';
  if (statusText) statusText.textContent = '';
}

// ========== Input Area ==========

// Bulletproof send: document-level delegated handlers so the send path works
// even if the direct per-element listeners never attach (DOM timing, a missing
// element halting init, or the input/button being re-rendered after wiring).
// Delegation is attached to `document`, which always exists, in the bubble
// phase — Enter from #goalInput and clicks on #sendBtn (or the SVG inside it)
// both reach it. sendMessage() clears the input on entry, so when both a direct
// and the delegated handler fire for one keystroke the second sees an empty
// goal and returns — no double-send. Any throw is surfaced to the user as a
// toast instead of failing silently ("nothing happens, no errors").
function _safeSendMessage(origin) {
  // send handler entry
  try {
    if (typeof sendMessage !== 'function') {
      console.error('[Sentinel] sendMessage is not a function');
      return;
    }
    sendMessage();
  } catch (err) {
    const m = (typeof getErrorMessage === 'function') ? getErrorMessage(err) : String(err);
    console.error('[Sentinel] sendMessage threw:', m, err);
    // sendMessage threw — already logged above
    if (typeof showToast === 'function') showToast(`Send failed: ${m}`, 'error');
  }
}
if (typeof document !== 'undefined' && document.addEventListener && !window.__sentinelSendDelegated) {
  window.__sentinelSendDelegated = true;
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    const ae = document.activeElement;
    if (!ae || ae.id !== 'goalInput') return;
    e.preventDefault();
    _safeSendMessage('enter');
  });
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('#sendBtn');
    if (!btn) return;
    _safeSendMessage('click');
  });
}

// Input listeners (auto-resize, example-prompt buttons, Enter key, send button)
// are now consolidated into popup-full.js DOMContentLoaded to eliminate the
// race condition that occurred when this IIFE ran before DOM elements existed.
// Document-level delegated handlers above handle the send path as a safety net.

// ========== Safety: ensure UI is never stuck disabled on popup open ==========
// If the previous session crashed mid-run, the agent_finished message was never
// received and the UI would be stuck with sendBtn disabled + goalInput disabled.
// Check if an agent is actually running; if not, force-reset the UI.
(function safetyResetOnOpen() {
  setTimeout(() => {
    const _sendBtn = document.getElementById('sendBtn');
    const _goalInput = document.getElementById('goalInput');
    // If inputs are disabled but no agent is running, force-reset
    if ((_sendBtn && _sendBtn.disabled) || (_goalInput && _goalInput.disabled)) {
      chrome.runtime.sendMessage({ action: 'ping' }, (resp) => {
        void chrome.runtime.lastError; // consume any error
        // wrapMessageHandler wraps responses as { ok: true, data: {...} }
        // so pong/agentRunning may be at resp.data, not resp directly
        const _pong = resp && (resp.pong || (resp.data && resp.data.pong));
        const _isRunning = resp && (resp.agentRunning === true || (resp.data && resp.data.agentRunning === true));
        if (_pong && !_isRunning) {

          resetUI();
        }
        // If SW is unreachable, also reset — no agent could be running
        if (!resp) {

          resetUI();
        }
      });
    }
  }, 1000); // delay increased to let all DOMContentLoaded listeners settle
})();

function setAgentActive(isActive) {
  if (!activeIndicator) return;
  const _goalInput = document.getElementById('goalInput');
  if (isActive) {
    activeIndicator.classList.add('active');
    if (injectContextBar) injectContextBar.style.display = 'flex';
    if (_goalInput) _goalInput.placeholder = 'Type a correction or instruction...';
  } else {
    activeIndicator.classList.remove('active');
    if (injectContextBar) injectContextBar.style.display = 'none';
    if (injectContextInput) injectContextInput.value = '';
    if (_goalInput) _goalInput.placeholder = 'What should I do?';
  }
}

// Mid-run context injection
function sendInjectedContext() {
  if (!injectContextInput) return;
  const note = injectContextInput.value.trim();
  if (!note) return;
  chrome.runtime.sendMessage({ action: 'inject_context', note }, (resp) => {
    if ((typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) || (resp && !resp.ok)) {
      if (typeof showToast === 'function') showToast(`Failed to send note: ${getErrorMessage(chrome.runtime.lastError || resp?.error || 'Unknown')}`, 'error');
      return;
    }
    injectContextInput.value = '';
    addMessage(`📌 Note sent to agent: ${note}`, 'user');
  });
}
if (injectContextBtn) injectContextBtn.addEventListener('click', sendInjectedContext);
if (injectContextInput) {
  injectContextInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendInjectedContext(); }
  });
}

// SO-84: send-path config snapshot. Populated at boot, kept current via
// onChanged, read synchronously by sendMessage() so a popup close can never
// drop a goal between the key check and the run_agent_loop dispatch.
let __sendCfg = { last_agent_goal: '', agent_history: [], active_provider: null, providers: null, api_key: '', api_endpoint: '' };
chrome.storage.local.get(['last_agent_goal', 'agent_history', 'active_provider', 'providers', 'api_key', 'api_endpoint'], (s) => {
  if (s) Object.assign(__sendCfg, s);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  ['last_agent_goal', 'agent_history', 'active_provider', 'providers', 'api_key', 'api_endpoint'].forEach((k) => {
    if (k in changes) __sendCfg[k] = changes[k].newValue;
  });
});

function sendMessage() {
  if (typeof showToast !== 'function') {
    console.error('[Sentinel] showToast not available — initialization incomplete');
    alert('Extension not fully loaded. Please close and reopen the popup.');
    return;
  }
  if (typeof showToast === 'function') showToast('Sending...', 'info');
  const state = getState();
  // Robust goal-field resolution. getElementById returns only the FIRST
  // #goalInput; if a duplicate ever exists in the live DOM, that first one may
  // be empty/hidden while the user typed into another. Prefer the focused field
  // (what the user actually typed into), then any #goalInput that has text.
  const _goalInputs = Array.prototype.slice.call(document.querySelectorAll('#goalInput'));
  let _goalInput = document.getElementById('goalInput');
  const _activeEl = document.activeElement;
  if (_activeEl && _activeEl.id === 'goalInput' && typeof _activeEl.value === 'string') {
    _goalInput = _activeEl;
  } else {
    const _withText = _goalInputs.find(el => el && typeof el.value === 'string' && el.value.trim());
    if (_withText) _goalInput = _withText;
  }
  // goal input resolved
  const _sendBtn = document.getElementById('sendBtn');
  const _stopBtn = document.getElementById('stopBtn');
  const _pauseBtn = document.getElementById('pauseBtn');
  const _undoBtn = document.getElementById('undoBtn');
  const _attachmentPreview = document.getElementById('attachmentPreview');

  if (!_goalInput) {
    console.error('[Sentinel] sendMessage: goalInput not found');
    if (typeof showToast === 'function') showToast('ERROR: goalInput not found', 'error');
    return;
  }

  const goal = _goalInput.value.trim();
  if (!goal) {
    return;
  }
  // If agent is already running, send text as a mid-run correction instead of a new goal.
  const _isAgentRunning = activeIndicator && activeIndicator.classList.contains('active');
  if (_isAgentRunning) {
    const _correctionTabId = __atsStripState.tabId || null;
    chrome.runtime.sendMessage({
      action: 'agent_correction',
      correction: goal,
      tabId: _correctionTabId
    }, (resp) => {
      if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) {

        if (typeof showToast === 'function') showToast('Correction failed to send', 'error');
        return;
      }
      if (resp && resp.ok) {
        if (typeof showToast === 'function') showToast('Correction applied', 'info');
      } else {
        if (typeof showToast === 'function') showToast(resp?.error || 'Correction rejected', 'error');
      }
    });
    // Add to chat as user correction message
    addMessage(goal, 'user');
    _goalInput.value = '';
    _goalInput.style.height = 'auto';
    _goalInput.placeholder = 'Type a correction or instruction...';
    return;
  }

  // Disable send button to prevent starting a new run, but keep input enabled
  // so the user can type mid-run corrections.
  addMessage(goal, 'user');
  _goalInput.value = '';
  _goalInput.style.height = 'auto';
  if (_sendBtn) _sendBtn.disabled = true;
  if (_stopBtn) _stopBtn.style.display = 'flex';
  if (_pauseBtn) { _pauseBtn.style.display = 'flex'; _pauseBtn.dataset.paused = 'false'; _pauseBtn.innerHTML = PAUSE_ICON; _pauseBtn.title = 'Pause agent'; }
  if (_undoBtn) { _undoBtn.style.display = 'flex'; _undoBtn.disabled = true; }
  _goalInput.placeholder = 'Type a correction or instruction...';
  state.selectedAttachments = [];
  if (_attachmentPreview) _attachmentPreview.style.display = 'none';

  showTypingIndicator();
  updateStatus('Agent is starting...');
  setAgentActive(true);

  // Carry over the last goal if the new message seems like a follow-up
  let fullGoal = goal;
  // SO-84: synchronous send path. The old async storage.local.get callback
  // meant the goal survived only across an async hop; closing the popup in
  // that window (user hits Enter, clicks back to the page) dropped it
  // silently. __sendCfg (boot + onChanged synced) replaces the fetch.
  {
    const stored = __sendCfg;

    // Pre-flight: bail early with clear, visible feedback if no API key is
    // configured. Without this the agent half-starts and only surfaces a buried
    // "API call failed: API key not configured" note several steps in, which
    // reads to the user as "nothing happened / no API even though I set one".
    const _activeId = stored.active_provider;
    const _providers = stored.providers;
    const _hasProviderKey = !!(_activeId && _providers && _providers[_activeId] && _providers[_activeId].api_key);
    const _hasLegacyKey = !!stored.api_key;
    // SO-82: mirror the engine's resolution (provider-registry SO-76b, boot-catcher
    // SO-81). Truly empty config = the built-in keyless B60 default runs - that is
    // READY, not an error. A configured keyless-loopback endpoint is also ready.
    // Only a cloud provider missing its key blocks the send.
    // SO-84b: mirror the engine's resolution (provider-registry SO-83). An
    // active-provider shell with no endpoint and no key is NOT an error —
    // the engine falls back to the built-in keyless B60 default and runs.
    // Block only a real, non-loopback endpoint that has no key.
    const _provObj = (_activeId && _providers) ? _providers[_activeId] : null;
    const _activeEndpoint = (_provObj && _provObj.endpoint) || stored.api_endpoint || (_provObj && _provObj.defaultEndpoint) || '';
    const _isKeylessLocal = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])([:\/]|$)/i.test(_activeEndpoint);
    const _engineDefaultsLocal = !_activeEndpoint; // nothing real set -> engine uses keyless B60 default
    if (!_hasProviderKey && !_hasLegacyKey && !_isKeylessLocal && !_engineDefaultsLocal) {
      removeTypingIndicator();
      addMessage('No API key for provider "' + (_activeId || 'null') + '". Open Settings, enter the key and click "Test Connection" (which saves it), or pick a local model - local models need no key.', 'assistant');
      if (typeof showToast === 'function') showToast('Set up an API key in Settings (local models need none)', 'error');
      // Restore the goal the user typed so they don't lose it, and re-enable UI.
      if (_goalInput) _goalInput.value = goal;
      resetUI();
      return;
    }

    const lastGoal = stored.last_agent_goal || '';
    const history = stored.agent_history || [];
    // If the message is short and looks like a follow-up (not a URL or specific instruction), prepend context
    const isFollowUp = goal.length < 50 && history.length &&
      !goal.startsWith('http') &&
      !NAVIGATE_SEARCH_RE.test(goal);
    if (isFollowUp && lastGoal) {
      fullGoal = `Previous task: "${lastGoal}"
Follow-up instruction: ${goal}
The user wants you to continue or adjust the previous task. Look at the current page and respond accordingly.`;
    }
    chrome.storage.local.set({ last_agent_goal: isFollowUp ? lastGoal : goal }).catch((e) => { console.error('[Sentinel] Error in chat.js:', getErrorMessage(e)); });

    // Wake up the service worker with a ping before sending the goal.
    // MV3 service workers can be inactive when the popup opens, causing
    // sendMessage to silently fail. The ping ensures the SW is alive.
    const _sendGoal = () => {
      chrome.runtime.sendMessage({ action: 'run_agent_loop', goal: fullGoal }, (response) => {
        if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) {
          console.error('[Sentinel] run_agent_loop lastError:', getErrorMessage(chrome.runtime.lastError));
          // Agent runtime error — already logged
          removeTypingIndicator();
          addMessage(friendlyError(getErrorMessage(chrome.runtime.lastError)), 'assistant');
          resetUI();
          return;
        }
        if (response && !response.ok) {
          console.error('[Sentinel] run_agent_loop error:', response.error);
          // Agent returned error — already logged
          removeTypingIndicator();
          addMessage(friendlyError(response.error || 'Unknown error'), 'assistant');
          resetUI();
        }
        // If response is ok, the agent is running — agent_finished will reset UI
      });
    };

    // SO-84: dispatch immediately. MV3 wakes the service worker for this
    // message on its own; the old ping-then-send gate added a second async
    // hop where closing the popup right after Enter silently dropped the goal.
    _sendGoal();
    // SO-87: also park the goal in storage. A pending_goal write raises
    // storage.onChanged — an MV3 wake event listened for top-level in the
    // SW — so a popup that dies before sendMessage delivers (Chrome 155:
    // sender-death during SW cold start eats the message silently) still
    // starts the run. The SW marks the goal done, making this idempotent.
    chrome.storage.local.set({ pending_goal: { goal: fullGoal, ts: Date.now(), done: false } })
      .catch((e) => { console.error('[Sentinel] pending_goal write failed:', getErrorMessage(e)); });
  }
}

function resetUI() {
  const _sendBtn = document.getElementById('sendBtn');
  const _stopBtn = document.getElementById('stopBtn');
  const _pauseBtn = document.getElementById('pauseBtn');
  const _undoBtn = document.getElementById('undoBtn');
  const _goalInput = document.getElementById('goalInput');
  
  if (_sendBtn) _sendBtn.disabled = false;
  if (_stopBtn) _stopBtn.style.display = 'none';
  if (_pauseBtn) { _pauseBtn.style.display = 'none'; _pauseBtn.dataset.paused = 'false'; }
  if (_undoBtn) { _undoBtn.style.display = 'none'; _undoBtn.disabled = true; }
  if (_goalInput) {
    _goalInput.disabled = false;
    _goalInput.placeholder = 'Tell me what to do...';
  }
  hideStatus();
  setAgentActive(false);
}

// ========== Stop Button ==========
if (stopBtn) {
  stopBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'stop_agent_loop' }, (response) => {
      if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null && !response) {
        addMessage(friendlyError(getErrorMessage(chrome.runtime.lastError)), 'assistant');
      } else if (response && !response.ok) {
        addMessage(`⚠️ ${friendlyError(response.error || 'Unknown error')}`, 'assistant');
      } else {
        addMessage('Agent stopped by user.', 'assistant');
      }
      removeTypingIndicator();
      setAgentActive(false);
      resetUI();
      renderTabBar([]);
    });
  });
} else {
  console.error('[Sentinel] stopBtn not found - event listener not attached');
}

// ========== Speed Controls ==========
// Speed buttons are in the UI already — wire them up to the agent engine
document.querySelectorAll('[data-speed]').forEach(btn => {
  btn.addEventListener('click', () => {
    const mode = btn.getAttribute('data-speed');
    chrome.runtime.sendMessage({ action: 'set_agent_speed', mode }, (resp) => {
      if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) { console.error('[Sentinel/chat] setAgentSpeed failed:', getErrorMessage(chrome.runtime.lastError)); return; }
      if (resp && resp.ok !== false) {
        // Update active state on buttons
        document.querySelectorAll('[data-speed]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      }
    });
  });
});

// Pause/resume toggle
const pauseBtn = document.getElementById('pauseBtn');
const PAUSE_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"></rect><rect x="14" y="4" width="4" height="16" rx="1"></rect></svg>';
const RESUME_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"></polygon></svg>';
if (pauseBtn) {
  pauseBtn.addEventListener('click', () => {
    const isPaused = pauseBtn.dataset.paused === 'true';
    const action = isPaused ? 'resume_agent_loop' : 'pause_agent_loop';
    chrome.runtime.sendMessage({ action }, (resp) => {
      if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null && !resp) return;
      pauseBtn.dataset.paused = isPaused ? 'false' : 'true';
      pauseBtn.innerHTML = isPaused ? PAUSE_ICON : RESUME_ICON;
      pauseBtn.title = isPaused ? 'Pause agent' : 'Resume agent';
    });
  });
}

// ========== Undo Button ==========
const undoBtn = document.getElementById('undoBtn');
if (undoBtn) {
  undoBtn.addEventListener('click', () => {
    undoBtn.disabled = true;
    chrome.runtime.sendMessage({ action: 'undo_action' }, (resp) => {
      if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null && !resp) {
        addMessage(friendlyError(getErrorMessage(chrome.runtime.lastError)), 'assistant');
        return;
      }
      if (resp && !resp.ok) {
        addMessage(friendlyError(resp.error || 'Undo not available'), 'assistant');
      } else if (resp && resp.data && !resp.data.success) {
        addMessage(`Nothing to undo: ${resp.data.reason || ''}`, 'assistant');
      } else if (resp && resp.data && resp.data.success) {
        addMessage(`Undone: ${resp.data.description || 'Last action reversed'}`, 'assistant');
      }
    });
  });
}

// Listen for undo stack size updates from background to enable/disable the button.
// (Handled in the main message listener below alongside other agent messages.)

// Ctrl+Z / Cmd+Z keyboard shortcut for undo — mirrors the undo button behavior
// Space key while agent is running: toggle pause/resume
document.addEventListener('keydown', (e) => {
  const active = document.activeElement;
  const inText = active && (INPUT_TEXTAREA_RE.test(active.tagName) || active.isContentEditable);
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
    if (inText) return;
    const _undoBtn = document.getElementById('undoBtn');
    if (!_undoBtn || _undoBtn.disabled || _undoBtn.style.display === 'none') return;
    e.preventDefault();
    _undoBtn.click();
  }
  if (e.key === ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (inText) return;
    const _pauseBtn = document.getElementById('pauseBtn');
    if (!_pauseBtn || _pauseBtn.style.display === 'none') return;
    e.preventDefault();
    _pauseBtn.click();
  }
});
newChatBtn && newChatBtn.addEventListener('click', () => {
  if (confirm('Start a new chat? This will clear the current conversation. (The current chat will be archived to Recent Chats.)')) {
    const _goalInput = document.getElementById('goalInput');
    // (3.24.0) Archive the current chat to Recent Chats BEFORE clearing so
    // the user can restore it via the Recent Chats rail button.
    try {
      if (window.__sentinelRecentChats && typeof window.__sentinelRecentChats.archive === 'function') {
        window.__sentinelRecentChats.archive({ reason: 'new-chat' });
      }
    } catch { /* recentChats archive is non-critical */ }
    chrome.storage.local.set({ chat_history: [] }, () => {
      if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) { console.error('[Sentinel/chat] clearChatHistory failed:', getErrorMessage(chrome.runtime.lastError)); return; }
      const state = getState();
      state.conversationHistory = [];
      if (chatContainer) {
        chatContainer.innerHTML = `
          <div class="welcome-message">
            <h2>Sentinel Override</h2>
            <p>Automate your browser tasks with AI. What would you like me to do?</p>
          </div>
        `;
      }
      if (_goalInput) {
        _goalInput.value = '';
        _goalInput.style.height = 'auto';
      }
      resetUI();
      showToast('Chat cleared (archived to Recent Chats)', 'success');
    });
  }
});

// ========== Message Search ==========
searchInput && searchInput.addEventListener('input', (e) => {
  const state = getState();
  state.currentSearchQuery = (e.target && typeof e.target.value === 'string' ? e.target.value : '').toLowerCase();
  state.currentSearchIndex = 0;

  if (state.currentSearchQuery) {
    highlightSearchResults();
  } else {
    clearSearchHighlights();
  }
});

function highlightSearchResults() {
  const state = getState();
  clearSearchHighlights();

  const messages = chatContainer ? chatContainer.querySelectorAll('.message-group') : [];
  if (!messages.length) return;
  let matchCount = 0;

  messages.forEach(group => {
    const text = typeof group.textContent === 'string' ? group.textContent.toLowerCase() : '';
    if (text.includes(state.currentSearchQuery)) {
      group.classList.add('highlighted');
      matchCount++;
    }
  });

  const searchCount = document.getElementById('searchCount');
  if (searchCount) {
    if (matchCount > 0) {
      searchCount.textContent = `${matchCount} match${matchCount !== 1 ? 'es' : ''}`;
      searchCount.style.display = 'inline';
    } else {
      searchCount.style.display = 'none';
    }
  }
}

function clearSearchHighlights() {
  document.querySelectorAll('.message-group.highlighted').forEach(group => {
    group.classList.remove('highlighted');
  });
  const searchCount = document.getElementById('searchCount');
  if (searchCount) searchCount.style.display = 'none';
}

// ========== Markdown Preview ==========
previewBtn && previewBtn.addEventListener('click', () => {
  markdownPreview.classList.toggle('show');
  previewBtn.classList.toggle('active');
});

// (3.34.0) Closable preview pane. Three dismissal paths so the panel can
// never trap the user when it covers the toolbar:
//   1. × button in the preview header (visible inside the panel itself).
//   2. Click outside the preview while it's open.
//   3. Escape key.
// All three converge on the same _closeMarkdownPreview() helper so the
// toggle state and previewBtn .active class stay in sync.
function _closeMarkdownPreview() {
  if (!markdownPreview) return;
  if (markdownPreview.classList.contains('show')) {
    markdownPreview.classList.remove('show');
    try { previewBtn.classList.remove('active'); } catch (e) { console.warn('[Sentinel] DOM detach error:', getErrorMessage(e)); }
  }
}
const _mdPreviewCloseBtn = document.getElementById('markdownPreviewCloseBtn');
if (_mdPreviewCloseBtn) {
  _mdPreviewCloseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    _closeMarkdownPreview();
  });
}
// Outside-click dismiss. We don't dismiss when the user clicks inside the
// preview itself, nor when they click the previewBtn (that's a manual toggle).
document.addEventListener('mousedown', (e) => {
  if (!markdownPreview || !markdownPreview.classList.contains('show')) return;
  if (markdownPreview.contains(e.target)) return;
  if (previewBtn && (e.target === previewBtn || previewBtn.contains(e.target))) return;
  _closeMarkdownPreview();
}, true);
// Escape: if preview is open, close it; if other dismissable overlays are
// open, let their own handlers take priority (we check preview class first).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (markdownPreview && markdownPreview.classList.contains('show')) {
    _closeMarkdownPreview();
    e.stopPropagation();
  }
});

// (3.34.0) Safety-net Escape handler. If any other modal overlay is open
// (Settings, Templates, Recent Chats, Run Log, etc.) and the user presses
// Escape, dismiss the top-most one even if its own close button is broken
// or covered. We run this AFTER the preview handler so preview takes
// precedence, and we only fire if the preview didn't claim the event.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (markdownPreview && markdownPreview.classList.contains('show')) return;
  // Find the top-most visible .modal.show — use the last one in DOM
  // order since modals stack visually with the last-added on top.
  const openModals = document.querySelectorAll('.modal.show');
  if (openModals.length === 0) return;
  const top = openModals[openModals.length - 1];
  try { top.classList.remove('show'); } catch (e) { console.warn('[Sentinel] DOM detach error:', getErrorMessage(e)); }
});

// (3.34.0) Click-the-backdrop safety net. If the operator clicks the dark
// translucent area OUTSIDE the modal-content (i.e. directly on the
// .modal-overlay), dismiss the modal. Skip clicks inside .modal-content
// itself — those should be handled by interior buttons.
document.addEventListener('mousedown', (e) => {
  const target = e.target;
  if (!target || !target.classList || !target.classList.contains('modal')) return;
  if (!target.classList.contains('show')) return;
  // The class is on the overlay element AND the click landed on the overlay
  // itself (not on a descendant inside modal-content), so dismiss.
  try { target.classList.remove('show'); } catch (e) { console.warn('[Sentinel] DOM detach error:', getErrorMessage(e)); }
}, true);

function _updateMarkdownPreview() {
  const _goalInput = document.getElementById('goalInput');
  if (!_goalInput) return;
  const text = _goalInput.value;
  if (text) {
    previewContent.innerHTML = sanitizeHtml(marked.parse(text));
  } else {
    previewContent.innerHTML = '<p style="color: var(--text-tertiary);">Preview appears here...</p>';
  }
}

// ========== File Attachment ==========
attachBtn && attachBtn.addEventListener('click', () => {
  fileInput.click();
});

fileInput && fileInput.addEventListener('change', (e) => {
  const state = getState();
  if (e.target && e.target.files) {
    state.selectedAttachments = [...e.target.files];
    updateAttachmentPreview();
  }
});

function updateAttachmentPreview() {
  const state = getState();
  if (!state.selectedAttachments || !Array.isArray(state.selectedAttachments) || state.selectedAttachments.length === 0) {
    attachmentPreview.style.display = 'none';
    return;
  }
  attachmentPreview.innerHTML = '<span>Attachments:</span>';
  state.selectedAttachments.forEach((file, index) => {
      const item = document.createElement('div');
      item.className = 'attachment-item';
      const nameSpan = document.createElement('span');
      nameSpan.textContent = file.name;
      const removeBtn = document.createElement('span');
      removeBtn.className = 'attachment-remove';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => {
        if (!state.selectedAttachments) return;
        if (index >= 0 && index < state.selectedAttachments.length) {
          state.selectedAttachments.splice(index, 1);
          updateAttachmentPreview();
        }
      });
      item.appendChild(nameSpan);
      item.appendChild(removeBtn);
      attachmentPreview.appendChild(item);
    });
    attachmentPreview.style.display = 'flex';
}

// ========== Voice Input (tab-based) ==========
// eslint-disable-next-line no-unused-vars -- Function is called from popup-full.js
function setupVoiceInput() {
  // Guard: the mic button must exist before we wire click/message handlers.
  // voiceBtn is captured at module load; if the popup markup ever ships without
  // #voiceBtn this would otherwise throw uncaught inside DOMContentLoaded and
  // abort the rest of popup init. Fail loud-but-safe instead.
  if (!voiceBtn) {

    return;
  }

  // Remove previous listeners if exists (prevent duplicates on popup reopen)
  if (_voiceMessageListener) {
    try {
      chrome.runtime.onMessage.removeListener(_voiceMessageListener);
    } catch (_e) { /* ignore */ }
    _voiceMessageListener = null;
  }

  // Remove previous click handler to prevent duplicates
  if (_voiceClickHandler) {
    try {
      voiceBtn.removeEventListener('click', _voiceClickHandler);
    } catch (_e) { /* ignore */ }
    _voiceClickHandler = null;
  }

  _voiceClickHandler = async () => {
    if (_voiceListening) {
      // Stop listening
      const stoppingTabId = _voiceListeningTabId;
      _voiceListening = false;
      _voiceListeningTabId = null;
      voiceBtn.classList.remove('listening');
      voiceBtn.title = 'Voice input (click to speak)';
      if (stoppingTabId) {
        chrome.scripting.executeScript({
          target: { tabId: stoppingTabId },
          func: () => {
            if (window.__sentinelVoiceHandler) {
              try { window.__sentinelVoiceHandler.stop(); } catch(_e) {}
              window.__sentinelVoiceHandler = null;
            }
          }
        }).catch(() => {});
      }
      return;
    }

    // Start listening
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) {
        showToast('No active tab found', 'error');
        return;
      }

      _voiceListening = true;
      _voiceListeningTabId = tab.id;
      voiceBtn.classList.add('listening');
      voiceBtn.title = 'Listening... (click to stop)';

      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (capturedTabId) => {
          // Stop any existing recognition
          if (window.__sentinelVoiceHandler) {
            try { window.__sentinelVoiceHandler.stop(); } catch(_e) {}
          }
          const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
          if (!SpeechRecognition) {
            chrome.runtime.sendMessage({ action: 'voice_error', error: 'Speech recognition not supported in this tab', tabId: capturedTabId });
            return;
          }
          const recognition = new SpeechRecognition();
          recognition.continuous = true;
          recognition.interimResults = true;
          recognition.lang = 'en-US';
          let finalTranscript = '';
          recognition.onresult = (event) => {
            let interim = '';
            const results = event.results || [];
            const resultIndex = event.resultIndex || 0;
            const resultsLen = results.length;
            for (let i = resultIndex; i < resultsLen; i++) {
              if (results[i] && results[i][0] && results[i][0].transcript) {
                if (results[i].isFinal) {
                  finalTranscript += results[i][0].transcript;
                } else {
                  interim += results[i][0].transcript;
                }
              }
            }
            chrome.runtime.sendMessage({
              action: 'voice_interim',
              text: finalTranscript + interim,
              tabId: capturedTabId
            }).catch(() => {});
          };
          recognition.onend = () => {
            chrome.runtime.sendMessage({
              action: 'voice_result',
              text: finalTranscript,
              tabId: capturedTabId
            }).catch(() => {});
          };
          recognition.onerror = (event) => {
            chrome.runtime.sendMessage({
              action: 'voice_error',
              error: (event && event.error) || 'unknown_error',
              tabId: capturedTabId
            }).catch(() => {});
          };
          recognition.start();
          window.__sentinelVoiceHandler = recognition;
        },
        args: [tab.id]
      });
      showToast('Listening... speak now', 'success');
    } catch (err) {
      console.error('Voice input error:', getErrorMessage(err));
      showToast(`Voice error: ${getErrorMessage(err)}`, 'error');
      _voiceListening = false;
      _voiceListeningTabId = null;
      voiceBtn.classList.remove('listening');
    }
  };

  voiceBtn.addEventListener('click', _voiceClickHandler);

  _voiceMessageListener = (msg, sender) => {
    // Only process voice messages if we're currently listening
    // and the message is from the tab we're listening to (if tabId is provided)
    if (!_voiceListening) return;

    // If the message includes a tabId, verify it matches the tab we're listening to
    // This prevents processing voice messages from other tabs
    if (msg.tabId !== undefined && msg.tabId !== _voiceListeningTabId) {
      return; // Ignore messages from other tabs
    }

    // For backwards compatibility, also check sender.tab.id if available
    if (sender && sender.tab && sender.tab.id && sender.tab.id !== _voiceListeningTabId) {
      return; // Ignore messages from other tabs (sender-based check)
    }

    if (msg.action === 'voice_result' && msg.text) {
      const _goalInput = document.getElementById('goalInput');
      const _voiceBtn = document.getElementById('voiceBtn');
      if (_goalInput) {
        _goalInput.value = msg.text;
        _goalInput.style.height = 'auto';
        _goalInput.style.height = `${Math.min(_goalInput.scrollHeight, 100)}px`;
        _goalInput.focus();
      }
      _voiceListening = false;
      _voiceListeningTabId = null;
      if (_voiceBtn) { _voiceBtn.classList.remove('listening'); _voiceBtn.title = 'Voice input (click to speak)'; }
      showToast('Voice input captured', 'success');
    }
    if (msg.action === 'voice_interim' && msg.text) {
      const _goalInput = document.getElementById('goalInput');
      if (_goalInput) {
        _goalInput.value = msg.text;
        _goalInput.style.height = 'auto';
        _goalInput.style.height = `${Math.min(_goalInput.scrollHeight, 100)}px`;
      }
    }
    if (msg.action === 'voice_error') {
      showToast(`Voice error: ${msg.error || 'Unknown error'}`, 'error');
      _voiceListening = false;
      _voiceListeningTabId = null;
      if (voiceBtn) { voiceBtn.classList.remove('listening'); voiceBtn.title = 'Voice input (click to speak)'; }
    }
  };

  chrome.runtime.onMessage.addListener(_voiceMessageListener);

  // Cleanup on popup unload - stop any ongoing voice input
  // Guard: window.addEventListener may not exist in test environments
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('unload', () => {
      if (_voiceListening && _voiceListeningTabId) {
        chrome.scripting.executeScript({
          target: { tabId: _voiceListeningTabId },
          func: () => {
            if (window.__sentinelVoiceHandler) {
              try { window.__sentinelVoiceHandler.stop(); } catch(_e) {}
              window.__sentinelVoiceHandler = null;
            }
          }
        }).catch(() => {});
      }
    });
  }
}

// setupVoiceInput() is called from popup-full.js DOMContentLoaded; calling it
// here too would register a duplicate chrome.runtime.onMessage listener.

// ========== Conversation Export ==========
exportBtn && exportBtn.addEventListener('click', () => {
  const state = getState();
  if (!state.conversationHistory || !Array.isArray(state.conversationHistory) || state.conversationHistory.length === 0) {
    showToast('No messages to export', 'error');
    return;
  }

  const format = (chatExportFormatSelect && chatExportFormatSelect.value) || 'text';
  let content, filename, mimeType;

  if (format === 'markdown') {
    content = state.conversationHistory
      .map(turn => `### ${turn.role === 'user' ? 'You' : 'Agent'}\n\n${turn.text}`)
      .join('\n\n---\n\n');
    filename = `conversation-${Date.now()}.md`;
    mimeType = 'text/markdown';
  } else if (format === 'json') {
    try {
      content = JSON.stringify(state.conversationHistory, null, 2);
    } catch (e) {
      content = JSON.stringify({ error: 'Failed to serialize conversation', message: getErrorMessage(e) }, null, 2);
    }
    filename = `conversation-${Date.now()}.json`;
    mimeType = 'application/json';
  } else {
    content = state.conversationHistory
      .map(turn => `[${turn.role.toUpperCase()}]\n${turn.text}`)
      .join('\n\n---\n\n');
    filename = `conversation-${Date.now()}.txt`;
    mimeType = 'text/plain';
  }

  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  if (document.body) document.body.appendChild(a);
  a.click();
  if (document.body) document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast(`Exported as ${format.toUpperCase()}`, 'success');
});

// ========== Export Replay (Chat Header) ==========
// Adds a toolbar button that exports the in-memory run recording as a
// self-contained HTML replay file. Different from the report-modal
// "Export Replay" — this is always available in the toolbar, not just
// after a run finishes.
(function initExportReplayBtn() {
  const toolbar = document.querySelector('.toolbar');
  if (!toolbar) return;
  const replayBtn = document.createElement('button');
  replayBtn.className = 'toolbar-icon-btn';
  replayBtn.id = 'chatExportReplayBtn';
  replayBtn.title = 'Export run replay as HTML';
  replayBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
  replayBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'export_replay' }, (response) => {
      if (response && response.html) {
        const blob = new Blob([response.html], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'sentinel-run-' + new Date().toISOString().slice(0, 10) + '.html';
        if (document.body) document.body.appendChild(a);
        a.click();
        if (document.body) document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('Run replay exported', 'success');
      } else {
        showToast('No replay data — run the agent first', 'error');
      }
    });
  });
  toolbar.appendChild(replayBtn);
})();

// ========== Command Palette ==========
commandPaletteBtn && commandPaletteBtn.addEventListener('click', openCommandPalette);
commandPaletteBackdrop && commandPaletteBackdrop.addEventListener('click', closeCommandPalette);

function openCommandPalette() {
  commandPalette.classList.add('show');
  commandPaletteBackdrop.classList.add('show');
  commandInput.focus();
  renderCommandList([]);
}

function closeCommandPalette() {
  commandPalette.classList.remove('show');
  commandPaletteBackdrop.classList.remove('show');
  commandInput.value = '';
}

commandInput && commandInput.addEventListener('input', filterCommands);
commandInput && commandInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeCommandPalette();
  if (e.key === 'Enter') executeSelectedCommand();
  if (e.key === 'ArrowDown') moveCommandSelection(1);
  if (e.key === 'ArrowUp') moveCommandSelection(-1);
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    openCommandPalette();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
    e.preventDefault();
    newChatBtn.click();
  }
});

const COMMANDS = [
  { name: 'New Chat', desc: 'Start a new conversation', action: 'new-chat', icon: 'edit' },
  { name: 'Export Conversation', desc: 'Download chat history', action: 'export', icon: 'save' },
  { name: 'Clear Search', desc: 'Clear search results', action: 'clear-search', icon: 'search' },
  { name: 'Toggle Dark Mode', desc: 'Switch theme', action: 'toggle-dark', icon: 'moon' },
  { name: 'Open Settings', desc: 'Configure API and preferences', action: 'settings', icon: 'settings' },
  { name: 'Customize Theme', desc: 'Customize colors', action: 'theme', icon: 'palette' },
  { name: 'Run Log History', desc: 'Browse and re-export past forensic run logs', action: 'run-log-history', icon: 'log' },
  { name: 'About', desc: 'About Sentinel Override', action: 'about', icon: 'info' },
];

// Cache normalized commands for faster filtering (avoid repeated toLowerCase calls)
const COMMANDS_NORMALIZED = COMMANDS.map(cmd => ({
  ...cmd,
  nameLower: cmd.name.toLowerCase(),
  descLower: cmd.desc.toLowerCase()
}));

function filterCommands() {
  if (!commandInput) return;
  const query = commandInput.value.toLowerCase();
  const filtered = COMMANDS_NORMALIZED.filter(cmd =>
    cmd.nameLower.includes(query) || cmd.descLower.includes(query)
  );
  renderCommandList(filtered);
}

function renderCommandList(commands) {
  if (!commandList) return;
  if (!commands || !Array.isArray(commands) || commands.length === 0) {
    commands = COMMANDS;
  }

  commandList.innerHTML = '';
  commands.forEach((cmd, idx) => {
    const item = document.createElement('div');
    item.className = 'command-item';
    item.dataset.index = idx;
    item.dataset.action = cmd.action;
    item.innerHTML = `
      <div class="command-icon">${cmd.icon}</div>
      <div class="command-text">
        <div class="command-name">${cmd.name}</div>
        <div class="command-desc">${cmd.desc}</div>
      </div>
    `;
    item.addEventListener('click', () => executeCommand(cmd.action));
    commandList.appendChild(item);
  });
}

function moveCommandSelection(direction) {
  const items = commandList.querySelectorAll('.command-item');
  const selected = commandList.querySelector('.command-item.selected');

  if (!selected && items.length) {
    items[0].classList.add('selected');
  } else if (selected) {
    const nextIndex = [...items].indexOf(selected) + direction;
    if (nextIndex >= 0 && nextIndex < items.length) {
      selected.classList.remove('selected');
      items[nextIndex].classList.add('selected');
    }
  }
}

function executeSelectedCommand() {
  const selected = commandList.querySelector('.command-item.selected');
  if (selected) {
    const action = selected.dataset.action || 'about';
    executeCommand(action);
  }
}

window.openReportModal = openReportModal;
window.closeReportModal = closeReportModal;

window.executeCommand = (action) => {
  closeCommandPalette();

  switch(action) {
    case 'new-chat':
      newChatBtn.click();
      break;
    case 'export':
      exportBtn.click();
      break;
    case 'clear-search':
      searchInput.value = '';
      clearSearchHighlights();
      break;
    case 'toggle-dark':
      toggleTheme();
      break;
    case 'settings':
      document.getElementById('settingsBtn')?.click();
      break;
    case 'theme':
      document.getElementById('theme-modal')?.classList.add('show');
      break;
    case 'run-log-history':
      try { openRunLogHistoryModal(); } catch (e) { console.error('[Sentinel] Error in chat.js:', getErrorMessage(e)); try { showToast(`Run log history unavailable: ${getErrorMessage(e)}`, 'error'); } catch { /* showToast may fail in detached popup */ } }
      break;
    case 'about':
      showToast('Sentinel Override v2.0 - AI-powered browser automation', 'success');
      break;
  }
};

// ========== Agent Tab Bar ==========
// Keyed cache of the last-rendered tab row content: tabId -> { text, title, isActive }
const _tabBarCache = new Map();

function renderTabBar(tabs) {
  const tabBar = document.getElementById('agent-tab-bar');
  if (!tabBar) return;
  if (!tabs || tabs.length === 0) {
    tabBar.style.display = 'none';
    tabBar.innerHTML = '';
    _tabBarCache.clear();
    return;
  }
  tabBar.style.display = 'block';

  const incomingIds = new Set(tabs.map(t => t.tabId));

  // Remove stale rows
  for (const [id] of _tabBarCache) {
    if (!incomingIds.has(id)) {
      const stale = tabBar.querySelector(`[data-tab-id="${id}"]`);
      if (stale) stale.remove();
      _tabBarCache.delete(id);
    }
  }

  // Update or insert each tab row in order
  tabs.forEach((ctx, i) => {
    let hostname = '';
    try { hostname = new URL(ctx.url).hostname.replace(/^www\./, ''); } catch { /* URL parse failure is non-critical */ }
    const displayText = ctx.label ? `${ctx.label} (${hostname})` : hostname || ctx.url;
    const cached = _tabBarCache.get(ctx.tabId);

    if (cached && cached.text === displayText && cached.title === ctx.url && cached.isActive === !!ctx.isActive) {
      // Row unchanged — only reorder if needed
      const existing = tabBar.querySelector(`[data-tab-id="${ctx.tabId}"]`);
      const nthChild = tabBar.children[i];
      if (existing && nthChild !== existing) tabBar.insertBefore(existing, nthChild || null);
      return;
    }

    let tab = tabBar.querySelector(`[data-tab-id="${ctx.tabId}"]`);
    if (!tab) {
      tab = document.createElement('div');
      tab.dataset.tabId = String(ctx.tabId);
      tab.addEventListener('click', () => {
        if (ctx.tabId) chrome.tabs.update(ctx.tabId, { active: true }).catch((e) => { console.error('[Sentinel] Error in chat.js:', getErrorMessage(e)); });
      });
    }
    tab.className = `agent-tab-item${ctx.isActive ? ' active' : ''}`;
    tab.textContent = displayText;
    tab.title = ctx.url;
    _tabBarCache.set(ctx.tabId, { text: displayText, title: ctx.url, isActive: !!ctx.isActive });

    const nthChild = tabBar.children[i];
    if (nthChild !== tab) tabBar.insertBefore(tab, nthChild || null);
  });
}

// ========== Report Card & Modal ==========

/**
 * Adds an inline report card to the chat feed with summary preview
 * and a "View Full Report" button.
 *
 * @param {object} report - Report object with summary, fullReport, goal, timestamp
 */
function addReportCard(report) {
  // (3.19.1) Defensive guard — some report-generation failure paths can call
  // this with undefined/null. Don't crash the popup; surface a non-blocking
  // toast and bail. The user can re-run the report from the modal.
  if (!report || typeof report !== 'object' || report === null) {
    try { showToast('Report data missing or malformed — skipped report card', 'error'); } catch { /* showToast may fail in detached popup */ }
    console.warn('[Sentinel] addReportCard called without a report object; ignoring.');
    return;
  }
  const state = getState();
  state.currentReport = report;

  const welcome = chatContainer.querySelector('.welcome-message');
  if (welcome) welcome.remove();

  const group = document.createElement('div');
  group.className = 'message-group report-group';

  const header = document.createElement('div');
  header.className = 'report-card-header';

  const title = document.createElement('div');
  title.className = 'report-card-title';
  title.textContent = 'Investigation Report';

  const time = document.createElement('div');
  time.className = 'report-card-time';
  try {
    time.textContent = new Date(report.timestamp).toLocaleTimeString();
  } catch {
    time.textContent = '';
  }

  header.appendChild(title);
  header.appendChild(time);

  const summary = document.createElement('div');
  summary.className = 'report-card-summary';
  summary.textContent = report.summary || 'Report generated.';

  const actions = document.createElement('div');
  actions.className = 'report-card-actions';

  const viewBtn = document.createElement('button');
  viewBtn.className = 'report-view-btn';
  viewBtn.textContent = 'View Full Report';
  viewBtn.addEventListener('click', () => {
    openReportModal(report.fullReport);
  });

  const exportBtn = document.createElement('button');
  exportBtn.className = 'report-view-btn';
  exportBtn.textContent = 'Export .md';
  exportBtn.addEventListener('click', () => {
    if (window.exportReportFile) window.exportReportFile(report);
  });

  actions.appendChild(viewBtn);
  actions.appendChild(exportBtn);

  group.appendChild(header);
  group.appendChild(summary);
  group.appendChild(actions);
  chatContainer.appendChild(group);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

/**
 * Opens the report modal with the full report rendered as markdown.
 *
 * @param {string} markdown - The full report markdown
 */
function openReportModal(markdown) {
  // (3.20.2) Reports now open as a full browser tab rather than as an
  // in-panel modal — the modal overflowed the narrow Chrome side panel
  // (560px max-width into ~400px viewport) and covered the chat. The new
  // tab uses the full window width and leaves the side panel uncovered.
  // The legacy in-panel modal stays in the DOM as a fallback path; pass
  // {fallback: true} or call openReportModalInline directly to use it.
  const state = getState();
  state.currentReportMarkdown = markdown;

  // Stash the report data so report-view.html can read it on load.
  const payload = {
    fullReport: markdown,
    goal: (state.currentReport && state.currentReport.goal) || '',
    timestamp: (state.currentReport && state.currentReport.timestamp) || new Date().toISOString()
  };
  try {
    chrome.storage.local.set({ _pendingViewReport: payload }, () => {
      if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) {

        openReportModalInline(markdown);
        return;
      }
      try {
        const url = chrome.runtime.getURL('report-view.html');
        chrome.tabs.create({ url }).catch(() => {

          openReportModalInline(markdown);
        });
      } catch (e) {
        // Tab creation failed — fall back to the in-panel modal.

        openReportModalInline(markdown);
      }
    });
  } catch (e) {

    openReportModalInline(markdown);
  }
}

// (3.20.2) Legacy in-panel modal path. Kept as a fallback when the new tab
// can't open (e.g., chrome.tabs unavailable, popup contexts). Not wired by
// default; openReportModal above handles routing.
function openReportModalInline(markdown) {
  const state = getState();
  state.currentReportMarkdown = markdown;

  // Close other modals (use getElementById to avoid cross-module variable dependency)
  document.getElementById('settings-modal')?.classList.remove('show');
  document.getElementById('theme-modal')?.classList.remove('show');

  // Render markdown with sanitization
  try {
    reportContent.innerHTML = sanitizeHtml(marked.parse(markdown));
    addCodeCopyButtons(reportContent);
    try { renderSourceChipsIn(reportContent); } catch { /* non-fatal */ }
  } catch {
    reportContent.textContent = markdown;
  }

  reportModal.classList.add('show');
}

/**
 * Closes the report modal.
 */
function closeReportModal() {
  reportModal.classList.remove('show');
}

// Report modal close button
closeReportBtn && closeReportBtn.addEventListener('click', closeReportModal);

// Close report modal on backdrop click
reportModal && reportModal.addEventListener('click', (e) => {
  if (e.target === reportModal) {
    closeReportModal();
  }
});

// Export: Copy as Markdown
copyReportMdBtn && copyReportMdBtn.addEventListener('click', () => {
  const state = getState();
  if (!state.currentReportMarkdown) {
    showToast('No report to copy', 'error');
    return;
  }
  navigator.clipboard.writeText(state.currentReportMarkdown).then(() => {
    showToast('Markdown copied to clipboard', 'success');
  }).catch(() => {
    showToast('Failed to copy', 'error');
  });
});

// Export: Download as .md (with YAML frontmatter via collaboration module)
downloadReportBtn && downloadReportBtn.addEventListener('click', () => {
  const state = getState();
  if (!state.currentReportMarkdown) {
    showToast('No report to download', 'error');
    return;
  }
  if (window.exportReportFile && state.currentReport) {
    window.exportReportFile(state.currentReport);
  } else {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const filename = `report-${timestamp}.md`;
    const blob = new Blob([state.currentReportMarkdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    if (document.body) document.body.appendChild(a);
    a.click();
    if (document.body) document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Report downloaded', 'success');
  }
});

// Export: PDF (3.12.0) -- stash report in storage, open print-friendly page,
// browser print dialog appears with "Save as PDF" as a destination option.
const exportReportPdfBtn = document.getElementById('exportReportPdfBtn');
if (exportReportPdfBtn) {
  exportReportPdfBtn.addEventListener('click', async () => {
    const state = getState();
    if (!state.currentReportMarkdown) {
      showToast('No report to export', 'error');
      return;
    }
    try {
      const payload = {
        fullReport: state.currentReportMarkdown,
        goal: (state.currentReport && state.currentReport.goal) || '',
        timestamp: (state.currentReport && state.currentReport.timestamp) || new Date().toISOString()
      };
      await chrome.storage.local.set({ _pendingPrintReport: payload });
      const url = chrome.runtime.getURL('report-print.html');
      await chrome.tabs.create({ url });
      showToast('Print dialog opening — pick "Save as PDF" as destination', 'info');
    } catch (e) {
      showToast(`PDF export failed: ${String(e)}`, 'error');
    }
  });
}

// Export: Interactive HTML Replay (9.3)
const exportReplayBtn = document.getElementById('exportReplayBtn');
if (exportReplayBtn) {
  exportReplayBtn.addEventListener('click', async () => {
    try {
      exportReplayBtn.disabled = true;
      exportReplayBtn.textContent = 'Generating…';
      const costEl = document.getElementById('run-cost');
      const costText = costEl ? costEl.title : '';
      const costMatch = costText.match(COST_EXTRACTION_RE);
      const estimatedCostUsd = costMatch && costMatch[0] && typeof costMatch[0] === 'string' ? (parseFloat(costMatch[0].slice(1)) || 0) : 0;
      const resp = await chrome.runtime.sendMessage({ action: 'export_replay_report', params: { estimatedCostUsd } });
      if (!resp || !resp.ok || !resp.data || !resp.data.html) {
        throw new Error((resp && resp.error) || 'No replay data available — run the agent first');
      }
      const blob = new Blob([resp.data.html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      await chrome.downloads.download({ url, filename: `sentinel-replay-${Date.now()}.html`, saveAs: true });
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      showToast('Replay report downloading…', 'info');
    } catch (e) {
      showToast(`Replay export failed: ${String(e)}`, 'error');
    } finally {
      exportReplayBtn.disabled = false;
      exportReplayBtn.textContent = 'Export Replay';
    }
  });
}

// Export: Copy as Plain Text
copyReportTextBtn && copyReportTextBtn.addEventListener('click', () => {
  const state = getState();
  if (!state.currentReportMarkdown) {
    showToast('No report to copy', 'error');
    return;
  }
  // Strip markdown formatting for plain text
  const plainText = state.currentReportMarkdown
    .replace(/^#{1,6}\s+/gm, '')      // Remove headers
    .replace(/\*\*(.+?)\*\*/g, '$1')   // Remove bold
    .replace(/\*(.+?)\*/g, '$1')       // Remove italic
    .replace(/`(.+?)`/g, '$1')         // Remove inline code
    .replace(/^- /gm, '')              // Remove unordered list markers
    .replace(/^\d+\.\s/gm, '')         // Remove ordered list markers
    .replace(/^---+$/gm, '')           // Remove horizontal rules
    .replace(/>\s+/gm, '')             // Remove blockquote markers
    .replace(/\n{3,}/g, '\n\n')        // Collapse multiple newlines
    .trim();
  navigator.clipboard.writeText(plainText).then(() => {
    showToast('Plain text copied to clipboard', 'success');
  }).catch(() => {
    showToast('Failed to copy', 'error');
  });
});

// ========== MFA Pause Banner (3.7.0) ==========
 
function showMfaBanner(url, hint, _stepNumber) {
  // Remove any existing MFA banner first so we don't stack them.
  const existing = document.getElementById('mfa-banner');
  if (existing) existing.remove();

  let host = '';
  if (typeof url === 'string') {
    try { host = new URL(url).hostname; } catch { host = url; }
  } else {
    host = 'the page';
  }

  const banner = document.createElement('div');
  banner.id = 'mfa-banner';
  banner.className = 'safety-banner';
  banner.style.borderColor = 'var(--accent-primary, #ff6b00)';
  banner.style.background = 'linear-gradient(180deg, rgba(255,107,0,0.08) 0%, transparent 100%)';
  banner.innerHTML = `
    <div class="safety-banner-header" style="color: var(--accent-primary, #ff6b00);">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
      </svg>
      <span>MFA challenge — agent paused</span>
    </div>
    <div style="font-size: 12px; line-height: 1.5; margin: 6px 0 8px 22px;">
      Detected on <strong>${escapeHtml(host)}</strong>${hint ? ` (${escapeHtml(String(hint).substring(0, 60))})` : ''}.
      Approve the prompt or enter the code on the page, then click Resume.
    </div>
    <div class="safety-banner-actions" style="margin-left: 22px;">
      <button class="safety-banner-dismiss" id="mfaResumeBtn" style="background: var(--accent-primary, #ff6b00); color: white; border-color: var(--accent-primary, #ff6b00);">Resume</button>
      <button class="safety-banner-dismiss" id="mfaDismissBtn" style="margin-left: 6px;">Dismiss</button>
    </div>
  `;

  chatContainer.appendChild(banner);
  chatContainer.scrollTop = chatContainer.scrollHeight;

  const mfaResumeBtn = document.getElementById('mfaResumeBtn');
  if (mfaResumeBtn) {
    mfaResumeBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'resume_agent_loop' }).catch((e) => { console.error('[Sentinel] Error in chat.js:', getErrorMessage(e)); });
      banner.remove();
    });
  }
  const mfaDismissBtn = document.getElementById('mfaDismissBtn');
  if (mfaDismissBtn) {
    mfaDismissBtn.addEventListener('click', () => {
      banner.remove();
    });
  }
}

// ========== Sign-In Wall Banner (3.14.1) ==========
// Surfaced when the agent hits a login page on a known auth host and can't
// auto-fill credentials. User signs in manually in the affected tab, then
// clicks Resume. Re-uses the existing pause/resume_agent_loop infra.
 
function showSignInWallBanner(url, host, evidence, _stepNumber) {
  const existing = document.getElementById('sign-in-wall-banner');
  if (existing) existing.remove();

  let hostname = host || '';
  if (!hostname && typeof url === 'string') {
    try { hostname = new URL(url).hostname; } catch { hostname = url; }
  }
  if (!hostname) hostname = 'the page';

  const banner = document.createElement('div');
  banner.id = 'sign-in-wall-banner';
  banner.className = 'safety-banner';
  banner.style.borderColor = 'var(--accent-primary, #ff6b00)';
  banner.style.background = 'linear-gradient(180deg, rgba(255,107,0,0.08) 0%, transparent 100%)';
  banner.innerHTML = `
    <div class="safety-banner-header" style="color: var(--accent-primary, #ff6b00);">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path>
        <polyline points="10 17 15 12 10 7"></polyline>
        <line x1="15" y1="12" x2="3" y2="12"></line>
      </svg>
      <span>Sign-in required — agent paused</span>
    </div>
    <div style="font-size: 12px; line-height: 1.5; margin: 6px 0 8px 22px;">
      Detected on <strong>${escapeHtml(hostname)}</strong>${evidence ? ` (${escapeHtml(String(evidence).substring(0, 80))})` : ''}.
      Sentinel doesn't auto-fill credentials. Switch to the affected tab, sign in manually (and complete any MFA), then click Resume.
    </div>
    <div class="safety-banner-actions" style="margin-left: 22px;">
      <button class="safety-banner-dismiss" id="signInWallResumeBtn" style="background: var(--accent-primary, #ff6b00); color: white; border-color: var(--accent-primary, #ff6b00);">Resume</button>
      <button class="safety-banner-dismiss" id="signInWallFocusBtn" style="margin-left: 6px;" title="Switch focus to the affected tab">Focus tab</button>
      <button class="safety-banner-dismiss" id="signInWallDismissBtn" style="margin-left: 6px;">Dismiss</button>
    </div>
  `;

  chatContainer.appendChild(banner);
  chatContainer.scrollTop = chatContainer.scrollHeight;

  const signInWallResumeBtn = document.getElementById('signInWallResumeBtn');
  if (signInWallResumeBtn) {
    signInWallResumeBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'resume_agent_loop' }).catch((e) => { console.error('[Sentinel] Error in chat.js:', getErrorMessage(e)); });
      banner.remove();
    });
  }
  const signInWallFocusBtn = document.getElementById('signInWallFocusBtn');
  if (signInWallFocusBtn) {
    signInWallFocusBtn.addEventListener('click', () => {
    // Best-effort: ask the background to focus the URL's tab via the existing
    // active-tab focus hook (re-uses focus_tab message handled by index.js).
    chrome.runtime.sendMessage({ action: 'focus_tab_by_url', url: url || '' }).catch((e) => { console.error('[Sentinel] Error in chat.js:', getErrorMessage(e)); });
    });
  }
  const signInWallDismissBtn = document.getElementById('signInWallDismissBtn');
  if (signInWallDismissBtn) {
    signInWallDismissBtn.addEventListener('click', () => {
      banner.remove();
    });
  }
}

// ========== Per-Step Activity Stream (3.16.0) ==========
// Claude-in-Chrome-style per-step checklist. Each step's card gets a stream
// of activity items (observe, consult-ai, dispatch, etc.) with status icons
// (spinner / checkmark / x) and per-item durations. Lets the user SEE what
// the agent is doing inside the step rather than waiting on a stale status
// bar that says "Consulting AI... (5s)" and nothing else.

// Map of stepNumber -> { card, stream } DOM references. Avoids
// re-querySelector-ing on every activity update.
const __activityState = new Map();

function _activityIcon(status) {
  // SVG icons sized for line-height: 14px circle/check/x
  if (status === 'done') {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><polyline points="20 6 9 17 4 12"></polyline></svg>';
  }
  if (status === 'failed') {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
  }
  if (status === 'in_progress') {
    // Animated spinner — CSS @keyframes spin defined in popup.css
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="activity-spinner" style="flex-shrink:0;"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>';
  }
  // pending
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; opacity:0.4;"><circle cx="12" cy="12" r="9"></circle></svg>';
}

function _formatDuration(ms) {
  if (!ms || ms < 0) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

/** Ensure a step card exists for this stepNumber and return its activity stream container. */
function _ensureActivityStream(stepNumber) {
  if (__activityState.has(stepNumber)) {
    return __activityState.get(stepNumber).stream;
  }
  // Look up the action card by stepNumber (created by addActionCard) — if it
  // doesn't exist yet (agent_step_start arrived first), create a placeholder
  // card so the activity items have somewhere to go.
  const welcome = chatContainer.querySelector('.welcome-message');
  if (welcome) welcome.remove();
  let card = chatContainer.querySelector(`.agent-action-group[data-step="${stepNumber}"]`);
  if (!card) {
    // Create a placeholder step card
    card = document.createElement('div');
    card.className = 'message-group agent-action-group activity-step-card';
    card.setAttribute('data-step', stepNumber);
    card.innerHTML = `
      <div class="message-wrapper assistant-wrapper">
        <div class="message assistant-msg activity-step-msg">
          <div class="activity-step-header" style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
            <span class="activity-step-label" style="font-size:11px; font-weight:600; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.5px;">Step ${stepNumber}</span>
            <span class="activity-step-action" style="font-size:12px; color:var(--text-primary); line-height:1.4;">Preparing…</span>
          </div>
          <div class="activity-stream" data-step="${stepNumber}"></div>
        </div>
      </div>
    `;
    chatContainer.appendChild(card);
  } else {
    // Existing action card from addActionCard — append an activity stream if not present
    if (!card.querySelector('.activity-stream')) {
      const msg = card.querySelector('.message.assistant-msg, .assistant-wrapper');
      if (msg) {
        const stream = document.createElement('div');
        stream.className = 'activity-stream';
        stream.setAttribute('data-step', stepNumber);
        stream.style.cssText = 'margin-top:6px;';
        msg.appendChild(stream);
      }
    }
  }
  const stream = card.querySelector('.activity-stream');
  __activityState.set(stepNumber, { card, stream });
  chatContainer.scrollTop = chatContainer.scrollHeight;
  return stream;
}

/** Upsert an activity item in the step's stream. */
function showAgentActivity(stepNumber, key, label, status, detail) {
  if (!stepNumber || stepNumber < 1) return;
  const stream = _ensureActivityStream(stepNumber);
  if (!stream) return;

  let item = stream.querySelector(`.activity-item[data-key="${CSS.escape(String(key))}"]`);
  if (!item) {
    item = document.createElement('div');
    item.className = 'activity-item';
    item.setAttribute('data-key', String(key));
    item.style.cssText = 'display:flex; align-items:center; gap:8px; padding:3px 0; font-size:12px; line-height:1.5;';
    stream.appendChild(item);
  }
  item.setAttribute('data-status', status || 'in_progress');

  // Color by status
  const statusColor = (status === 'done') ? 'var(--success-color, #4caf50)'
    : (status === 'failed') ? 'var(--error-color, #f44336)'
    : 'var(--accent-primary, #ff6b00)';

  // Duration string from detail
  let durationStr = '';
  if (detail && typeof detail.durationMs === 'number' && status !== 'in_progress') {
    durationStr = ` <span style="color:var(--text-tertiary); font-size:11px; margin-left:6px;">· ${_formatDuration(detail.durationMs)}</span>`;
  }

  item.innerHTML = `<span style="color:${statusColor}; display:inline-flex;">${_activityIcon(status)}</span>
    <span style="color:${status === 'failed' ? 'var(--error-color, #f44336)' : 'var(--text-primary)'}; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(label || '')}</span>
    ${durationStr}`;

  // (3.19.1) When the consult-ai item finalizes, if no agent_action message
  // has updated the step headline yet (typical for internal actions like
  // note / extract / extract_list / read_page / finish / wait_for_*), use
  // the AI-decided label as the headline so the user doesn't see
  // "Preparing…" stuck for the rest of the step.
  if (key === 'consult-ai' && status === 'done' && typeof label === 'string') {
    const state = __activityState.get(stepNumber);
    const card = state ? state.card : null;
    if (card) {
      const actionEl = card.querySelector('.activity-step-action');
      const actionText = typeof actionEl?.textContent === 'string' ? actionEl.textContent : '';
      if (actionEl && (actionText === 'Preparing…' || actionText.trim() === '')) {
        // Convert "AI decided: note" → "Recording a note", "AI decided: finish" → "Finishing run"
        const m = label.match(/AI decided:\s*(\w+)/i);
        if (m) {
          const t = String(m[1]).toLowerCase();
          const pretty = {
            note: 'Recording a note',
            extract: 'Extracting data',
            extract_list: 'Extracting list',
            read_page: 'Reading the page',
            finish: 'Finishing the run',
            wait_for_text: 'Waiting for text',
            wait_for_element: 'Waiting for element',
            wait_for_navigation: 'Waiting for navigation',
            dismiss_overlay: 'Dismissing overlay',
            scroll: 'Scrolling',
          }[t] || (t.charAt(0).toUpperCase() + t.slice(1).replace(/_/g, ' '));
          actionEl.textContent = pretty;
        }
      }
    }
  }

  chatContainer.scrollTop = chatContainer.scrollHeight;
}

/** Update the step card's headline action label (called when agent_action arrives). */
function updateStepCardAction(stepNumber, actionDescription) {
  if (!stepNumber || stepNumber < 1) return;
  const state = __activityState.get(stepNumber);
  const card = state ? state.card : chatContainer.querySelector(`.agent-action-group[data-step="${stepNumber}"]`);
  if (!card) return;
  const actionEl = card.querySelector('.activity-step-action');
  if (actionEl) actionEl.textContent = actionDescription || '';
}

/** Drop tracked state for the step (called when agent_finished fires for a clean reset). */
function clearActivityState() {
  __activityState.clear();
}

// ========== Mode Mismatch Card (3.15.2) ==========
// Surfaced when the goal text contains a "Mode: APPROVAL" / "Mode: AUTONOMOUS"
// directive that disagrees with the current Approval Mode setting. Prevents
// the user-wrote-APPROVAL-but-toggle-was-AUTONOMOUS disaster on live changes.
 
function showModeMismatchCard(payload) {
  if (!payload) return;
  const existing = document.getElementById('mode-mismatch-card');
  if (existing) existing.remove();

  const requestId = payload.requestId || '';
  const goalWants = (payload.goalWants || 'approval').toLowerCase();
  const actualMode = (payload.actualMode || 'autonomous').toLowerCase();
  const evidence = (payload.evidence || '').toString().substring(0, 200);
  const confidence = payload.confidence || 'high';

  // Headline color: red if the goal wants approval but actual is autonomous
  // (more dangerous direction); orange the other way.
  const dangerous = (goalWants === 'approval' && actualMode === 'autonomous');
  const borderColor = dangerous ? '#C00000' : 'var(--accent-primary, #ff6b00)';
  const headerColor = dangerous ? '#FF8A8A' : 'var(--accent-primary, #ff6b00)';
  const bgGrad = dangerous ? 'linear-gradient(180deg, rgba(192,0,0,0.10) 0%, transparent 100%)' : 'linear-gradient(180deg, rgba(255,107,0,0.08) 0%, transparent 100%)';

  const card = document.createElement('div');
  card.id = 'mode-mismatch-card';
  card.className = 'safety-banner';
  card.style.cssText = `border: 2px solid ${borderColor}; background: ${bgGrad}; margin: 8px 14px; padding: 14px 16px; border-radius: 8px;`;
  card.innerHTML = `
    <div style="display:flex; align-items:center; gap:8px; color:${headerColor}; font-weight:700; font-size:13px; margin-bottom:8px;">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
        <line x1="12" y1="9" x2="12" y2="13"></line>
        <line x1="12" y1="17" x2="12.01" y2="17"></line>
      </svg>
      <span>Approval Mode mismatch — confirm before running</span>
    </div>
    <div style="font-size: 12px; line-height: 1.55; margin-bottom: 10px;">
      Your goal asks for <strong style="text-transform:uppercase;">${escapeHtml(goalWants)}</strong> mode${evidence ? ` (matched: <em>"${escapeHtml(evidence)}"</em>)` : ''}, but the toggle is currently <strong style="text-transform:uppercase;">${escapeHtml(actualMode)}</strong>.
      ${dangerous ? '<br><span style="color:#FF8A8A;">Running in AUTONOMOUS mode will execute every action without pausing — including clicks that modify settings.</span>' : ''}
    </div>
    <div style="font-size:11px; line-height:1.5; padding:8px 10px; background:rgba(0,0,0,0.18); border-radius:4px; margin-bottom:10px;">
      <div style="font-family:monospace;"><span style="color:#888;">Goal wants:</span> <strong>${escapeHtml(goalWants.toUpperCase())}</strong></div>
      <div style="font-family:monospace;"><span style="color:#888;">Toggle is:</span> <strong>${escapeHtml(actualMode.toUpperCase())}</strong></div>
      ${confidence ? `<div style="margin-top:2px; color:#bbb;">Match confidence: ${escapeHtml(confidence)}</div>` : ''}
    </div>
    <div style="display:flex; flex-wrap:wrap; gap:6px;">
      <button id="modeMismatchFlipBtn" style="flex:1; min-width:140px; padding:9px 12px; border-radius:6px; border:1px solid ${borderColor}; background:${borderColor}; color:white; cursor:pointer; font-size:12px; font-weight:600;">Flip to ${escapeHtml(goalWants.toUpperCase())} &amp; continue</button>
      <button id="modeMismatchContinueBtn" style="flex:1; min-width:140px; padding:9px 12px; border-radius:6px; border:1px solid var(--border-color); background:var(--bg-tertiary); color:var(--text-primary); cursor:pointer; font-size:12px;">Continue as ${escapeHtml(actualMode.toUpperCase())}</button>
      <button id="modeMismatchCancelBtn" style="flex:1; min-width:80px; padding:9px 12px; border-radius:6px; border:1px solid var(--border-color); background:var(--bg-tertiary); color:var(--text-primary); cursor:pointer; font-size:12px;">Cancel run</button>
    </div>
  `;
  chatContainer.appendChild(card);
  chatContainer.scrollTop = chatContainer.scrollHeight;

  const sendResponse = (payload) => {
    try {
      chrome.runtime.sendMessage({ action: 'mode_mismatch_response', requestId, ...payload }).catch(() => {});
    } catch { /* message may fail if background not ready */ }
  };

  const modeMismatchFlipBtn = document.getElementById('modeMismatchFlipBtn');
  if (modeMismatchFlipBtn) {
    modeMismatchFlipBtn.addEventListener('click', () => {
      const wantsApproval = (goalWants === 'approval');
      // Write the new setting from the popup side so updateApprovalModeUI and
      // the toggle reflect it without needing a separate broadcast.
      chrome.storage.local.set({ approvalMode: wantsApproval }, () => {
        if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) { console.error('[Sentinel/chat] setApprovalMode failed:', getErrorMessage(chrome.runtime.lastError)); return; }
        try {
          if (approvalModeToggle) {
            approvalModeToggle.checked = wantsApproval;
          }
          if (typeof updateApprovalModeUI === 'function') {
            updateApprovalModeUI(wantsApproval);
          }
        } catch (e) { console.warn('[Sentinel] DOM detach error:', getErrorMessage(e)); }
        sendResponse({ flip: true });
        card.remove();
      });
    });
  }
  const modeMismatchContinueBtn = document.getElementById('modeMismatchContinueBtn');
  if (modeMismatchContinueBtn) {
    modeMismatchContinueBtn.addEventListener('click', () => {
      sendResponse({ continue: true });
      card.remove();
    });
  }
  const modeMismatchCancelBtn = document.getElementById('modeMismatchCancelBtn');
  if (modeMismatchCancelBtn) {
    modeMismatchCancelBtn.addEventListener('click', () => {
      sendResponse({ cancel: true });
      card.remove();
    });
  }
}

// ========== Adapted Goal Card (3.15.0) ==========
// Surfaced before the agent loop starts when Adaptive Prompts has rewritten
// the goal for the detected platform. In 'auto' mode the card is collapsed
// by default and informational only. In 'approval' mode the card has three
// buttons (Use Adapted / Use Original / Edit) and the agent is paused until
// the user decides.
 
function showAdaptedGoalCard(payload) {
  if (!payload) return;
  // Remove any prior card so we don't stack on repeated agent starts
  const existing = document.getElementById('adapted-goal-card');
  if (existing) existing.remove();

  const mode = payload.mode || 'auto';
  const platform = payload.platform || {};
  const summary = (payload.summary || '').toString();
  const originalGoal = (payload.originalGoal || '').toString();
  const adaptedGoal = (payload.adaptedGoal || '').toString();
  const mismatchCount = Array.isArray(payload.mismatchHints) ? payload.mismatchHints.length : 0;
  const requestId = payload.requestId || '';

  const card = document.createElement('div');
  card.id = 'adapted-goal-card';
  card.className = 'safety-banner';
  card.style.borderColor = 'var(--accent-primary, #ff6b00)';
  card.style.background = 'linear-gradient(180deg, rgba(120,180,255,0.06) 0%, transparent 100%)';

  const platformLabel = platform.label ? escapeHtml(platform.label) : 'a detected platform';
  const mismatchLine = mismatchCount > 0
    ? `${mismatchCount} menu mismatch${mismatchCount === 1 ? '' : 'es'} corrected`
    : 'no on-box menu mismatches detected';
  const collapsedByDefault = mode === 'auto';
  const summaryHtml = summary
    ? `<pre style="white-space: pre-wrap; font-family: inherit; font-size: 12px; line-height: 1.5; margin: 0; color: var(--text-secondary);">${escapeHtml(summary)}</pre>`
    : '<div style="font-size: 12px; color: var(--text-tertiary); font-style: italic;">(no summary provided)</div>';

  const actionsHtml = (mode === 'approval')
    ? `
      <div class="safety-banner-actions" style="margin-left: 22px; margin-top: 8px;">
        <button class="safety-banner-dismiss" id="adaptedGoalAcceptBtn" style="background: var(--accent-primary, #ff6b00); color: white; border-color: var(--accent-primary, #ff6b00);">Use Adapted Goal</button>
        <button class="safety-banner-dismiss" id="adaptedGoalOriginalBtn" style="margin-left: 6px;">Use Original</button>
        <button class="safety-banner-dismiss" id="adaptedGoalEditBtn" style="margin-left: 6px;">Edit…</button>
      </div>
    `
    : `
      <div style="margin-left: 22px; margin-top: 8px; font-size: 11px; color: var(--text-tertiary);">
        Auto-applied. Settings → Adaptive Prompts → Approval to review next time.
      </div>
    `;

  card.innerHTML = `
    <div class="safety-banner-header" style="color: var(--accent-primary, #ff6b00);">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 20h9"></path>
        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
      </svg>
      <span>Goal adapted for ${platformLabel}</span>
    </div>
    <div style="font-size: 12px; line-height: 1.5; margin: 6px 0 8px 22px;">
      ${mismatchLine}.
      <button id="adaptedGoalToggleBtn" style="margin-left: 6px; padding: 1px 8px; font-size: 11px; border-radius: 4px; border: 1px solid var(--border-color); background: var(--bg-tertiary); color: var(--text-primary); cursor: pointer;">
        ${collapsedByDefault ? 'Show details' : 'Hide details'}
      </button>
    </div>
    <div id="adaptedGoalDetails" style="margin-left: 22px; ${collapsedByDefault ? 'display: none;' : ''}">
      <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-tertiary); margin-bottom: 4px;">Changes</div>
      ${summaryHtml}
      <details style="margin-top: 10px;">
        <summary style="cursor: pointer; font-size: 11px; color: var(--text-secondary);">View adapted goal (${adaptedGoal.length} chars)</summary>
        <pre id="adaptedGoalText" style="white-space: pre-wrap; font-family: inherit; font-size: 11px; line-height: 1.45; margin: 6px 0 0; padding: 8px 10px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 6px; max-height: 220px; overflow: auto;">${escapeHtml(adaptedGoal)}</pre>
      </details>
      <details style="margin-top: 6px;">
        <summary style="cursor: pointer; font-size: 11px; color: var(--text-secondary);">View original goal (${originalGoal.length} chars)</summary>
        <pre style="white-space: pre-wrap; font-family: inherit; font-size: 11px; line-height: 1.45; margin: 6px 0 0; padding: 8px 10px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 6px; max-height: 160px; overflow: auto; opacity: 0.75;">${escapeHtml(originalGoal)}</pre>
      </details>
    </div>
    ${actionsHtml}
  `;

  chatContainer.appendChild(card);
  chatContainer.scrollTop = chatContainer.scrollHeight;

  const toggleBtn = document.getElementById('adaptedGoalToggleBtn');
  const details = document.getElementById('adaptedGoalDetails');
  if (toggleBtn && details) {
    toggleBtn.addEventListener('click', () => {
      const hidden = details.style.display === 'none';
      details.style.display = hidden ? '' : 'none';
      toggleBtn.textContent = hidden ? 'Hide details' : 'Show details';
    });
  }

  if (mode === 'approval') {
    const sendResponse = (payload) => {
      try {
        chrome.runtime.sendMessage({ action: 'adapted_goal_response', requestId, ...payload }).catch(() => {});
      } catch { /* message may fail if background not ready */ }
    };
    const adaptedGoalAcceptBtn = document.getElementById('adaptedGoalAcceptBtn');
    if (adaptedGoalAcceptBtn) {
      adaptedGoalAcceptBtn.addEventListener('click', () => {
        sendResponse({ approved: true });
        card.remove();
      });
    }
    const adaptedGoalOriginalBtn = document.getElementById('adaptedGoalOriginalBtn');
    if (adaptedGoalOriginalBtn) {
      adaptedGoalOriginalBtn.addEventListener('click', () => {
        sendResponse({ useOriginal: true });
        card.remove();
      });
    }
    const adaptedGoalEditBtn = document.getElementById('adaptedGoalEditBtn');
    if (adaptedGoalEditBtn) {
      adaptedGoalEditBtn.addEventListener('click', () => {
        // Replace the pre with a textarea, replace the buttons with Save/Cancel.
        const textEl = document.getElementById('adaptedGoalText');
        if (!textEl || !textEl.parentElement) return;
        const ta = document.createElement('textarea');
        ta.value = adaptedGoal;
        ta.style.cssText = 'width: 100%; min-height: 200px; font-family: inherit; font-size: 11px; line-height: 1.45; padding: 8px 10px; background: var(--bg-input); border: 1px solid var(--accent-primary, #ff6b00); border-radius: 6px; color: var(--text-primary); box-sizing: border-box; resize: vertical;';
        textEl.parentElement.replaceChild(ta, textEl);
        const actions = card.querySelector('.safety-banner-actions');
        if (actions) {
          actions.innerHTML = `
            <button class="safety-banner-dismiss" id="adaptedGoalSaveEditBtn" style="background: var(--accent-primary, #ff6b00); color: white; border-color: var(--accent-primary, #ff6b00);">Save & Run</button>
            <button class="safety-banner-dismiss" id="adaptedGoalCancelEditBtn" style="margin-left: 6px;">Cancel</button>
          `;
          const adaptedGoalSaveEditBtn = document.getElementById('adaptedGoalSaveEditBtn');
          if (adaptedGoalSaveEditBtn) {
            adaptedGoalSaveEditBtn.addEventListener('click', () => {
              sendResponse({ edited: true, editedGoal: ta.value });
              card.remove();
            });
          }
          const adaptedGoalCancelEditBtn = document.getElementById('adaptedGoalCancelEditBtn');
          if (adaptedGoalCancelEditBtn) {
            adaptedGoalCancelEditBtn.addEventListener('click', () => {
              // Restore the buttons to their original state by removing the card
              // and re-rendering — simplest path that keeps the original adapted
              // text intact for a second look.
              card.remove();
              showAdaptedGoalCard(payload);
            });
          }
        }
      });
    }
  }
}

// ========== Download Capture (3.9.0) ==========
 
function showDownloadCaptured(dl) {
  if (!dl) return;
  const filename = (dl.filename || '').split(/[\\/]/).pop() || 'file';
  const wrapper = document.createElement('div');
  wrapper.className = 'message-group';
  wrapper.innerHTML = `
    <div class="skip-note" style="border-left: 3px solid #2EA043; background: rgba(46,160,67,0.10); padding: 8px 12px;">
      <div style="display:flex; align-items:center; gap:8px;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2EA043" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
        <strong style="color:#2EA043;">File downloaded</strong>
      </div>
      <div style="font-size:12px; margin-top:4px;">${escapeHtml(filename)}</div>
      <div style="font-size:10px; color:var(--text-secondary,#999); margin-top:2px; word-break:break-all;">${escapeHtml(dl.filename || '')}</div>
    </div>
  `;
  chatContainer.appendChild(wrapper);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

// ========== Run Log Export (3.9.0) ==========
let __lastRunLogId = null;
 
function showRunLogExportButton(runLogId, entryCount) {
  __lastRunLogId = runLogId;
  // Remove any prior export banner
  const existing = document.getElementById('run-log-banner');
  if (existing) existing.remove();
  const banner = document.createElement('div');
  banner.id = 'run-log-banner';
  banner.className = 'safety-banner';
  banner.style.borderColor = 'var(--accent-primary, #ff6b00)';
  banner.innerHTML = `
    <div class="safety-banner-header" style="color: var(--accent-primary, #ff6b00);">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
        <polyline points="14 2 14 8 20 8"></polyline>
      </svg>
      <span>Forensic run log available</span>
    </div>
    <div style="font-size: 12px; margin: 6px 0 8px 22px;">
      ${entryCount} structured log entries captured for this run. Export as JSON or CSV for the ticket.
    </div>
    <div class="safety-banner-actions" style="margin-left: 22px;">
      <button class="safety-banner-dismiss" id="exportRunLogJsonBtn" style="background: var(--accent-primary, #ff6b00); color: white; border-color: var(--accent-primary, #ff6b00);">Export JSON</button>
      <button class="safety-banner-dismiss" id="exportRunLogCsvBtn" style="margin-left: 6px;">Export CSV</button>
      <button class="safety-banner-dismiss" id="viewRunLogHistoryBtn" style="margin-left: 6px;" title="Browse all stored run logs">View past runs</button>
      <button class="safety-banner-dismiss" id="dismissRunLogBtn" style="margin-left: 6px;">Dismiss</button>
    </div>
  `;
  chatContainer.appendChild(banner);
  chatContainer.scrollTop = chatContainer.scrollHeight;

  const exportJsonBtn = document.getElementById('exportRunLogJsonBtn');
  const exportCsvBtn = document.getElementById('exportRunLogCsvBtn');
  const dismissBtn = document.getElementById('dismissRunLogBtn');
  if (exportJsonBtn) exportJsonBtn.addEventListener('click', () => exportRunLog('json'));
  if (exportCsvBtn) exportCsvBtn.addEventListener('click', () => exportRunLog('csv'));
  if (dismissBtn) dismissBtn.addEventListener('click', () => banner.remove());
  const histBtn = document.getElementById('viewRunLogHistoryBtn');
  if (histBtn) histBtn.addEventListener('click', () => openRunLogHistoryModal());
}

// ========== Run Log History Modal (3.14.0) ==========
// Lists the last 20 runs from chrome.storage.local.run_log_index with
// re-export buttons. Lets users recover logs even if they dismissed the
// post-run banner.

async function openRunLogHistoryModal() {
  const modal = document.getElementById('run-log-history-modal');
  if (!modal) return;
  modal.classList.add('show');
  await renderRunLogHistoryList();
}

function closeRunLogHistoryModal() {
  const modal = document.getElementById('run-log-history-modal');
  if (modal) modal.classList.remove('show');
}

async function renderRunLogHistoryList() {
  const listEl = document.getElementById('runLogHistoryList');
  if (!listEl) return;
  listEl.innerHTML = '<div style="text-align:center; color:var(--text-tertiary); font-size:13px; padding:24px;">Loading…</div>';
  try {
    const stored = await chrome.storage.local.get('run_log_index');
    const list = Array.isArray(stored.run_log_index) ? stored.run_log_index : [];
    if (list.length === 0) {
      listEl.innerHTML = '<div style="text-align:center; color:var(--text-tertiary); font-size:13px; padding:24px;">No runs recorded yet. Start an agent run to populate this list.</div>';
      return;
    }
    const fmtDate = (ts) => {
      if (!ts) return '—';
      try { return new Date(ts).toLocaleString(); } catch { return '—'; }
    };
    const fmtDuration = (start, end) => {
      if (!start || !end) return '';
      const sec = Math.max(0, Math.round((end - start) / 1000));
      if (sec < 60) return `${sec}s`;
      const m = Math.floor(sec / 60), s = sec % 60;
      return `${m}m ${s}s`;
    };
    const rowsHtml = list.map((entry) => {
      const id = escapeHtml(entry.runLogId || '');
      const goalShort = (entry.goal || '(no goal)').replace(/</g, '&lt;').slice(0, 140);
      const statusChip = entry.completed
        ? '<span style="display:inline-block; padding:2px 6px; font-size:10px; border-radius:8px; background:rgba(0,255,100,0.12); color:#33cc66; border:1px solid #2a9d4a;">COMPLETE</span>'
        : '<span style="display:inline-block; padding:2px 6px; font-size:10px; border-radius:8px; background:rgba(255,180,0,0.12); color:#cc8800; border:1px solid #aa7700;">INCOMPLETE</span>';
      const duration = fmtDuration(entry.startedAt, entry.finishedAt);
      const subtitle = [
        fmtDate(entry.startedAt),
        `${entry.stepCount || 0} steps`,
        `${entry.apiCallCount || 0} AI calls`,
        duration
      ].filter(Boolean).join(' · ');
      return `
        <div class="run-log-history-row" data-runid="${id}" style="padding:10px; border:1px solid var(--border-color); border-radius:8px; margin-bottom:8px; background:var(--bg-secondary);">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
            <div style="flex:1; min-width:0;">
              <div style="font-size:13px; color:var(--text-primary); line-height:1.4; word-break:break-word;">${goalShort}</div>
              <div style="font-size:10px; color:var(--text-tertiary); margin-top:4px;">${subtitle}</div>
            </div>
            <div style="flex-shrink:0;">${statusChip}</div>
          </div>
          <div style="display:flex; gap:6px; margin-top:8px;">
            <button class="small-btn run-log-export-json" data-runid="${id}" style="font-size:11px;">Export JSON</button>
            <button class="small-btn run-log-export-csv" data-runid="${id}" style="font-size:11px;">Export CSV</button>
            <button class="small-btn run-log-delete" data-runid="${id}" style="font-size:11px; color:var(--error-color); margin-left:auto;">Delete</button>
          </div>
        </div>
      `;
    }).join('');
    listEl.innerHTML = rowsHtml;
    // Wire row buttons
    listEl.querySelectorAll('.run-log-export-json').forEach(b => {
      b.addEventListener('click', () => exportRunLogById(b.dataset.runid, 'json'));
    });
    listEl.querySelectorAll('.run-log-export-csv').forEach(b => {
      b.addEventListener('click', () => exportRunLogById(b.dataset.runid, 'csv'));
    });
    listEl.querySelectorAll('.run-log-delete').forEach(b => {
      b.addEventListener('click', () => deleteRunLogById(b.dataset.runid));
    });
  } catch (e) {
    listEl.innerHTML = `<div style="text-align:center; color:var(--error-color); font-size:13px; padding:24px;">Failed to load run log index: ${escapeHtml(getErrorMessage(e))}</div>`;
  }
}

async function exportRunLogById(runLogId, format) {
  if (!runLogId) return;
  // Re-use the existing exportRunLog flow by stuffing __lastRunLogId.
  __lastRunLogId = runLogId;
  await exportRunLog(format);
}

async function deleteRunLogById(runLogId) {
  if (!runLogId) return;
  if (!confirm('Delete this run log permanently? This cannot be undone.')) return;
  try {
    const stored = await chrome.storage.local.get('run_log_index');
    const list = Array.isArray(stored.run_log_index) ? stored.run_log_index : [];
    const next = list.filter(e => e && e.runLogId !== runLogId);
    await chrome.storage.local.set({ run_log_index: next });
    await chrome.storage.local.remove(`run_log_${runLogId}`);
    try { showToast('Run log deleted', 'info'); } catch { /* showToast may fail in detached popup */ }
    await renderRunLogHistoryList();
  } catch (e) {
    try { showToast(`Delete failed: ${getErrorMessage(e)}`, 'error'); } catch { /* showToast may fail in detached popup */ }
  }
}

async function clearAllRunLogs() {
  if (!confirm('Delete ALL stored run logs permanently? This cannot be undone.')) return;
  try {
    const stored = await chrome.storage.local.get('run_log_index');
    const list = Array.isArray(stored.run_log_index) ? stored.run_log_index : [];
    // Single-pass optimization: filter and map in one loop
    const keys = [];
    for (const e of list) {
      if (e && e.runLogId) keys.push(`run_log_${e.runLogId}`);
    }
    if (keys.length) {
      try { await chrome.storage.local.remove(keys); } catch { /* storage write may fail */ }
    }
    await chrome.storage.local.set({ run_log_index: [] });
    try { showToast('All run logs cleared', 'info'); } catch { /* showToast may fail in detached popup */ }
    await renderRunLogHistoryList();
  } catch (e) {
    try { showToast(`Clear failed: ${getErrorMessage(e)}`, 'error'); } catch { /* showToast may fail in detached popup */ }
  }
}

// Wire modal close buttons and "Clear All" once at module load.
(function wireRunLogHistoryModal() {
  const close1 = document.getElementById('closeRunLogHistoryBtn');
  const close2 = document.getElementById('closeRunLogHistoryBtn2');
  const clearBtn = document.getElementById('runLogHistoryClearBtn');
  if (close1) close1.addEventListener('click', closeRunLogHistoryModal);
  if (close2) close2.addEventListener('click', closeRunLogHistoryModal);
  if (clearBtn) clearBtn.addEventListener('click', clearAllRunLogs);
  // (3.17.0) Wire the new left-action-rail Run Log button to the same modal.
  const railBtn = document.getElementById('runLogHistoryRailBtn');
  if (railBtn) railBtn.addEventListener('click', () => {
    try { openRunLogHistoryModal(); } catch { /* modal may not be initialized yet */ }
  });
  // Expose for command-palette / other entry points.
  try { window.__openRunLogHistory = openRunLogHistoryModal; } catch { /* window assignment may fail in some contexts */ }
})();

async function exportRunLog(format) {
  if (!__lastRunLogId) return;
  try {
    const stored = await chrome.storage.local.get(`run_log_${__lastRunLogId}`);
    const log = stored[`run_log_${__lastRunLogId}`];
    if (!log) {
      try { showToast('Run log not found in storage', 'error'); } catch { /* showToast may fail in detached popup */ }
      return;
    }
    let content, mime, ext;
    if (format === 'csv') {
      const headers = ['step', 'timestamp', 'kind', 'url', 'tenant', 'action_type', 'selector_or_ref', 'text_preview', 'result', 'failed'];
      const escape = (v) => {
        if (v == null) return '';
        const s = String(v).replace(/"/g, '""');
        return CSV_QUOTE_RE.test(s) ? `"${s}"` : s;
      };
      const rows = (log.entries || []).map(e => [
        e.step, e.timestamp, e.kind, e.url || '', e.tenant || '',
        e.action_type || '',
        (e.action && (e.action.ref || e.action.selector)) || '',
        (e.action && e.action.text) ? String(e.action.text).slice(0, 100) : '',
        e.result || (e.summary_preview || ''),
        e.failed === true ? 'true' : (e.failed === false ? 'false' : '')
      ].map(escape).join(','));
      content = `${headers.join(',')}\n${rows.join('\n')}`;
      mime = 'text/csv';
      ext = 'csv';
    } else {
      content = JSON.stringify(log, null, 2);
      mime = 'application/json';
      ext = 'json';
    }
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sentinel_run_log_${((__lastRunLogId || '').slice(0, 8) || 'unknown')}.${ext}`;
    if (document.body) document.body.appendChild(a);
    a.click();
    if (document.body) document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) {
    try { showToast(`Export failed: ${String(e)}`, 'error'); } catch { /* showToast may fail in detached popup */ }
  }
}

// ========== Resume Banner (3.9.0) ==========
async function checkResumeOnLoad() {
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'check_resume_available' });
    const data = (resp && resp.data) ? resp.data : resp;
    if (!data || !data.available) return;
    showResumeBanner(data.goal, data.stepCount, data.ageSeconds);
  } catch { /* non-fatal */ }
}

function showResumeBanner(goal, stepCount, ageSeconds) {
  const banner = document.createElement('div');
  banner.id = 'resume-banner';
  banner.className = 'safety-banner';
  banner.style.borderColor = 'var(--accent-primary, #ff6b00)';
  const ageText = (!ageSeconds || Number.isNaN(ageSeconds)) ? 'unknown ago'
    : ageSeconds < 60 ? `${ageSeconds}s ago` : `${Math.floor(ageSeconds / 60)}m ago`;
  const preview = `${(goal || '').slice(0, 200)}${(goal || '').length > 200 ? '…' : ''}`;
  banner.innerHTML = `
    <div class="safety-banner-header" style="color: var(--accent-primary, #ff6b00);">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="23 4 23 10 17 10"></polyline>
        <polyline points="1 20 1 14 7 14"></polyline>
        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
      </svg>
      <span>Resume previous run?</span>
    </div>
    <div style="font-size: 12px; margin: 6px 0 6px 22px; opacity: 0.85;">
      Last run reached step ${stepCount} (${ageText}). Goal preview:
    </div>
    <div style="font-size: 11px; margin: 0 0 8px 22px; padding: 6px 8px; background: rgba(0,0,0,0.18); border-radius: 4px; font-family: 'Inter', sans-serif; line-height: 1.4;">
      ${escapeHtml(preview)}
    </div>
    <div class="safety-banner-actions" style="margin-left: 22px;">
      <button class="safety-banner-dismiss" id="resumeRunBtn" style="background: var(--accent-primary, #ff6b00); color: white; border-color: var(--accent-primary, #ff6b00);">Resume</button>
      <button class="safety-banner-dismiss" id="dismissResumeBtn" style="margin-left: 6px;">Dismiss</button>
    </div>
  `;
  chatContainer.insertBefore(banner, chatContainer.firstChild);

  const resumeBtn = document.getElementById('resumeRunBtn');
  const dismissResumeBtn = document.getElementById('dismissResumeBtn');
  if (resumeBtn) resumeBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'resume_from_checkpoint' }).catch((e) => { console.error('[Sentinel] Error in chat.js:', getErrorMessage(e)); });
    banner.remove();
  });
  if (dismissResumeBtn) dismissResumeBtn.addEventListener('click', () => banner.remove());
}

// Run resume check on load (after DOM is ready).
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', checkResumeOnLoad);
} else {
  checkResumeOnLoad();
}

// v3.61.2: Robust report display via storage listener + retry.
// The agent saves the report to chrome.storage.local but sendReportUpdate
// via runtime.sendMessage can be lost if the panel isn't listening.
// This uses BOTH a storage change listener AND a polling fallback.
let _reportShown = false;

async function _tryShowReport() {
  if (_reportShown) return;
  try {
    const stored = await chrome.storage.local.get(['last_agent_report']);
    const report = stored.last_agent_report;
    if (!report || typeof report !== 'object' || report === null) return;
    // Only show if report is less than 5 minutes old
    const age = Date.now() - new Date(report.timestamp).getTime();
    if (Number.isNaN(age) || age > 5 * 60 * 1000) return;
    // Don't show if there's already a report card in the chat
    if (chatContainer && chatContainer.querySelector('.report-card-title')) {
      _reportShown = true;
      return;
    }
    addReportCard(report);
    _reportShown = true;
    // Auto-scroll to the report card
    setTimeout(() => {
      const card = chatContainer && chatContainer.querySelector('.report-card-title');
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
  } catch (e) {

  }
}

// Storage change listener — fires in real-time when report is saved
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.last_agent_report && changes.last_agent_report.newValue) {
    setTimeout(_tryShowReport, 100);
  }
});

// Polling fallback — try 3 times at 500ms, 1500ms, 3000ms
function _scheduleReportPoll() {
  setTimeout(_tryShowReport, 500);
  setTimeout(_tryShowReport, 1500);
  setTimeout(_tryShowReport, 3000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _scheduleReportPoll);
} else {
  _scheduleReportPoll();
}

// ========== Source Tag Chips (3.10.0) ==========
// Convert inline [src:memory_key] markers in agent finish summaries into
// clickable chips that expand the underlying memory entry inline. Builds
// auditability: every specific claim becomes traceable to extracted data.

function renderSourceChipsIn(rootEl) {
  if (!rootEl) return;
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, null);
  const texts = [];
  let n; while ((n = walker.nextNode())) texts.push(n);
  for (const tn of texts) {
    if (!SOURCE_TAG_RE.test(tn.textContent)) continue;
    SOURCE_TAG_RE.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0; let m;
    const tnContent = typeof tn.textContent === 'string' ? tn.textContent : '';
    while ((m = SOURCE_TAG_RE.exec(tnContent)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(tnContent.slice(last, m.index)));
      const chip = document.createElement('span');
      chip.className = 'sentinel-src-chip';
      const isUnverified = typeof m[0] === 'string' && m[0].toLowerCase() === '[unverified]';
      const key = isUnverified ? null : (typeof m[1] === 'string' ? m[1] : null);
      chip.textContent = isUnverified ? '⚠ unverified' : `🔖 ${key}`;
      chip.dataset.key = key || '';
      chip.dataset.unverified = isUnverified ? '1' : '0';
      chip.title = isUnverified
        ? 'This claim has no verified source — treat with caution'
        : `Source: agentMemory["${key}"]. Click to view.`;
      chip.style.cssText = `display:inline-flex; align-items:center; gap:3px; padding:1px 7px; margin:0 2px;
        border-radius:9px; font-size:10px; font-weight:600; cursor:pointer; vertical-align:baseline;
        ${isUnverified
          ? 'background:rgba(220,60,60,0.20); color:#ff8a8a; border:1px solid rgba(220,60,60,0.5);'
          : 'background:rgba(255,107,0,0.18); color:#ff9a4a; border:1px solid rgba(255,107,0,0.45);'}`;
      chip.addEventListener('click', () => toggleSourceChipExpansion(chip));
      frag.appendChild(chip);
      last = m.index + m[0].length;
    }
    if (last < tnContent.length) frag.appendChild(document.createTextNode(tnContent.slice(last)));
    tn.parentNode.replaceChild(frag, tn);
  }
}

async function toggleSourceChipExpansion(chip) {
  const key = chip.dataset.key;
  const unverified = chip.dataset.unverified === '1';
  // Toggle: if a sibling expansion exists, remove it.
  const next = chip.nextElementSibling;
  if (next && next.classList && next.classList.contains('sentinel-src-expansion')) {
    next.remove(); return;
  }
  const exp = document.createElement('div');
  exp.className = 'sentinel-src-expansion';
  exp.style.cssText = `margin: 6px 0 6px 22px; padding: 8px 12px; background: rgba(255,255,255,0.05);
    border-left: 3px solid var(--accent-primary, #ff6b00); border-radius: 4px;
    font-size: 11px; font-family: monospace; white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow: auto;`;
  if (unverified || !key) {
    exp.textContent = 'No verified source for this claim. Treat as model-prior or caveat content.';
    chip.parentNode.insertBefore(exp, chip.nextSibling);
    return;
  }
  try {
    const stored = await chrome.storage.local.get('agent_memory');
    const mem = stored && stored.agent_memory;
    const value = mem && Object.prototype.hasOwnProperty.call(mem, key) ? mem[key] : null;
    if (value === null || value === undefined) {
      exp.textContent = `(memory key "${key}" not found in current agent_memory; may have been cleared since the run completed)`;
    } else {
      exp.textContent = (typeof value === 'string') ? value.slice(0, 4000) : JSON.stringify(value).slice(0, 4000);
    }
  } catch (e) {
    exp.textContent = `Error reading source: ${String(e)}`;
  }
  chip.parentNode.insertBefore(exp, chip.nextSibling);
}

// Note: renderSourceChipsIn is called explicitly at key render points
// (openReportModalInline, agent_finished handler). A full addMessage patch
// was planned here but was never completed; the dead assignment was removed.

// ========== Tenant Override Card (3.11.0) ==========
// Hard-stop modal-style card when the agent attempts a modifying action on
// a Microsoft admin URL whose tenant doesn't match the user's expectedTenant.
// Career-risk gate: forces an explicit "yes, intentional cross-tenant work"
// click before dispatching. Forensic log captures the timestamped decision.

// ========== Paste Ticket Modal ==========
if (pasteTicketBtn && pasteTicketModal) {
  pasteTicketBtn.addEventListener('click', () => {
    pasteTicketModal.style.display = 'flex';
    const ptIssue = document.getElementById('ptIssue');
    if (ptIssue) ptIssue.focus();
  });

  const _closePasteTicket = () => { pasteTicketModal.style.display = 'none'; };
  if (closePasteTicketBtn) closePasteTicketBtn.addEventListener('click', _closePasteTicket);
  if (closePasteTicketBtnCancel) closePasteTicketBtnCancel.addEventListener('click', _closePasteTicket);

  pasteTicketModal.addEventListener('click', (e) => {
    if (e.target === pasteTicketModal) _closePasteTicket();
  });

  if (usePasteTicketBtn) {
    usePasteTicketBtn.addEventListener('click', () => {
      const ticketNum  = (document.getElementById('ptTicketNumber')?.value || '').trim();
      const client     = (document.getElementById('ptClient')?.value || '').trim();
      const issue      = (document.getElementById('ptIssue')?.value || '').trim();
      const prior      = (document.getElementById('ptPriorAttempts')?.value || '').trim();
      const target     = (document.getElementById('ptTargetSystem')?.value || '').trim();
      const success    = (document.getElementById('ptSuccessCriteria')?.value || '').trim();

      if (!issue) {
        const issueEl = document.getElementById('ptIssue');
        if (issueEl) { issueEl.focus(); issueEl.style.outline = '2px solid var(--accent-red, #f44)'; }
        return;
      }

      const parts = [];
      if (ticketNum) parts.push(`Ticket: ${ticketNum}`);
      if (client)    parts.push(`Client: ${client}`);
      parts.push(`Issue: ${issue}`);
      if (prior)     parts.push(`Prior attempts: ${prior}`);
      if (target)    parts.push(`Target: ${target}`);
      if (success)   parts.push(`Success criteria: ${success}`);

      const _goalInput = document.getElementById('goalInput');
      if (_goalInput) {
        _goalInput.value = parts.join('\n');
        _goalInput.dispatchEvent(new Event('input'));
        _goalInput.focus();
      }

      _closePasteTicket();

      // Reset outline if it was highlighted
      const issueEl = document.getElementById('ptIssue');
      if (issueEl) issueEl.style.outline = '';
    });
  }
}

// ========== Health Heartbeat (6.0) ==========
const __heartbeat = { samples: [], el: null };
function _ensureHeartbeatDot() {
  if (__heartbeat.el) return __heartbeat.el;
  const dot = document.createElement('span');
  dot.id = 'hb-dot';
  dot.title = 'API health';
  dot.style.cssText = 'display:inline-block; width:8px; height:8px; border-radius:50%; background:#4caf50; margin-left:8px; vertical-align:middle; transition:background 0.5s;';
  const statusEl = document.getElementById('status-text');
  if (statusEl && statusEl.parentNode) statusEl.parentNode.appendChild(dot);
  __heartbeat.el = dot;
  return dot;
}
function _updateHeartbeat(durationMs) {
  __heartbeat.samples.push(durationMs);
  if (__heartbeat.samples.length > 5) __heartbeat.samples.shift();
  const samplesLen = __heartbeat.samples.length;
  const avg = samplesLen
    ? Math.round(__heartbeat.samples.reduce((a, b) => a + b, 0) / samplesLen)
    : 0;
  const dot = _ensureHeartbeatDot();
  dot.style.background = avg < 3000 ? '#4caf50' : avg < 10000 ? '#e0af68' : '#f44336';
  dot.title = `API: ${(avg / 1000).toFixed(1)}s avg (last ${samplesLen} calls)`;
}

// ========== Cost Display (9.2) ==========
let __costEl = null;
function _ensureCostEl() {
  if (__costEl) return __costEl;
  const el = document.createElement('span');
  el.id = 'run-cost';
  el.style.cssText = 'display:inline-block; margin-left:8px; font-size:10px; color:var(--text-secondary,#aaa); vertical-align:middle; font-variant-numeric:tabular-nums;';
  el.title = 'Estimated API cost for this run';
  const statusEl = document.getElementById('status-text');
  if (statusEl && statusEl.parentNode) statusEl.parentNode.appendChild(el);
  __costEl = el;
  return el;
}
function _updateCostDisplay(estimatedCostUsd, callCount) {
  const el = _ensureCostEl();
  const cents = estimatedCostUsd * 100;
  const label = cents < 0.1 ? '<$0.01' : `$${estimatedCostUsd.toFixed(cents < 1 ? 3 : 2)}`;
  el.textContent = label;
  el.title = `Run cost: ~${label} (${callCount} API call${callCount !== 1 ? 's' : ''})`;
}

// ========== Live Status Ticker (6.0) ==========
let __lastStatusState = '';
const _STATE_ICONS = { observing: '👁', thinking: '🧠', planning: '📋', executing: '⚡', verifying: '✔', waiting: '⏳', idle: '·' };
function _showStatusTicker(state, text, timestamp) {
  const icon = _STATE_ICONS[state] || '·';
  const label = timestamp ? `${timestamp} — ${text}` : text;
  updateStatus(`${icon} ${label}`);
}

// ========== Background Message Handler ==========
chrome.runtime.onMessage.addListener((message) => {
  // (3.49.1) Undo stack size updates — enable/disable the undo button.
  if (message.action === 'undo_stack_updated') {
    if (undoBtn) {
      undoBtn.disabled = (typeof message.size !== 'number' || message.size === 0);
    }
  }
  if (message.action === 'cdp_reattach_warning') {
    updateStatus(`⚠️ ${typeof message.message === 'string' ? message.message : 'Debugger re-attached after banner was dismissed.'}`);
  }
  // (3.51) Report display — show report card in chat when report is ready
  if (message.action === 'report_update' && message.status === 'ready' && message.report) {
    try { addReportCard(message.report); } catch (e) { console.error('[Sentinel] addReportCard error:', getErrorMessage(e)); }
  }
  if (message.action === 'agent_loop_complete' && message.report) {
    try { addReportCard(message.report); } catch (e) { console.error('[Sentinel] addReportCard error:', getErrorMessage(e)); }
  }
  // (6.0) Live status narration ticker
  if (message.action === 'agent_status') {
    _showStatusTicker(message.state, message.text, message.timestamp);
  }
  // Phase 8.2: Live status bar for structured agent_status messages (type-based)
  if (message.type === 'agent_status') {
    try {
      const bar = document.getElementById('agent-status-bar') || (() => {
        const el = document.createElement('div');
        el.id = 'agent-status-bar';
        el.innerHTML = '<span class="status-dot"></span><span class="status-label"></span>';
        const chatEl = chatContainer;
        if (chatEl && chatEl.firstChild) {
          chatEl.insertBefore(el, chatEl.firstChild);
        } else if (chatEl) {
          chatEl.appendChild(el);
        }
        return el;
      })();
      const label = bar.querySelector('.status-label');
      const dot = bar.querySelector('.status-dot');
      if (label) label.textContent = message.detail || message.status || '';
      if (dot) dot.className = `status-dot status-${message.status || 'idle'}`;
      bar.classList.toggle('visible', true);
      // Auto-hide after completion or idle after a delay
      if (message.status === 'complete' || message.status === 'error') {
        setTimeout(() => { bar.classList.toggle('visible', false); }, 4000);
      }
    } catch (_) { /* non-fatal */ }
  }
  // API Health Heartbeat — live indicator for LLM API responsiveness (hidden by default; enable in Settings)
  if (message.type === 'api_health') {
    chrome.storage.local.get(['show_api_health_bar'], (result) => {
      if (!result.show_api_health_bar) return; // OFF by default
      let healthBar = document.getElementById('api-health-bar');
      if (!healthBar) {
        healthBar = document.createElement('div');
        healthBar.id = 'api-health-bar';
        healthBar.style.cssText = 'padding:4px 10px;font-size:11px;display:flex;align-items:center;gap:5px;border-bottom:1px solid rgba(255,255,255,0.06);color:#888;background:transparent;';
        const chatArea = document.getElementById('chatMessages') || document.querySelector('.chat-messages');
        if (chatArea) chatArea.parentNode.insertBefore(healthBar, chatArea);
      }
      const colors = { healthy: '#4caf50', slow: '#ff9800', down: '#f44336', idle: '#666', unknown: '#666' };
      const labels = { healthy: 'API: responding', slow: 'API: slow', down: 'API: down', idle: 'API: idle', unknown: 'API: ?' };
      const dot = colors[message.state] || '#666';
      const label = labels[message.state] || 'API: ?';
      const avg = (typeof message.avgMs === 'number') ? `${message.avgMs}ms avg` : '';
      healthBar.innerHTML = '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:' + dot + ';"></span><span>' + label + '</span>' + (avg ? '<span style="margin-left:4px;color:#555;">' + avg + '</span>' : '');
    });
  }
  // (6.0) API health heartbeat
  if (message.action === 'heartbeat_update') {
    _updateHeartbeat(message.durationMs || 0);
  }
  // (9.2) Running cost estimate
  if (message.action === 'cost_update') {
    _updateCostDisplay(message.estimatedCostUsd || 0, message.callCount || 0);
  }
  // (6.0) Screenshot live preview; (7.1) show crosshair if we have pending click coords
  if (message.action === 'screenshot_update') {
    updateMiniShot(message.base64Image);
    showMiniShot();
    if (message.viewportW && message.viewportH) __lastViewportSize = { w: message.viewportW, h: message.viewportH };
    if (__lastClickCoords && __lastViewportSize) {
      showCrosshair(__lastClickCoords.x, __lastClickCoords.y, __lastViewportSize.w, __lastViewportSize.h);
      __lastClickCoords = null;
    }
  }
  // Knowledge context bar — persistent bar above chat showing injected client facts
  if (message.type === 'knowledge_context' && message.factCount > 0) {
    try {
      let knowledgeBar = document.getElementById('knowledge-context-bar');
      if (!knowledgeBar) {
        knowledgeBar = document.createElement('div');
        knowledgeBar.id = 'knowledge-context-bar';
        knowledgeBar.style.cssText = 'padding:4px 10px;font-size:11px;display:flex;align-items:center;gap:6px;border-bottom:1px solid rgba(255,255,255,0.06);color:#888;background:transparent;cursor:pointer;';
        knowledgeBar.title = 'Click to see facts';
        const chatArea = document.getElementById('chatMessages') || document.querySelector('.chat-messages');
        if (chatArea) chatArea.parentNode.insertBefore(knowledgeBar, chatArea);
        knowledgeBar.addEventListener('click', () => {
          const details = document.getElementById('knowledge-details');
          if (details) details.style.display = details.style.display === 'none' ? 'block' : 'none';
        });
      }
      knowledgeBar.innerHTML = '<span style="color:#5bc0de;">&#9432;</span><span>Using ' + message.factCount + ' facts' + (message.clientName ? ' for ' + escapeHtml(message.clientName || '') : '') + '</span>';
      // Add expandable details
      let details = document.getElementById('knowledge-details');
      if (!details) {
        details = document.createElement('div');
        details.id = 'knowledge-details';
        details.style.cssText = 'padding:6px 10px;font-size:11px;color:#666;display:none;border-bottom:1px solid rgba(255,255,255,0.06);';
        knowledgeBar.parentNode.insertBefore(details, knowledgeBar.nextSibling);
      }
      details.innerHTML = (message.facts || []).map(f => '<div style="padding:1px 0;">• ' + escapeHtml(String(f)) + '</div>').join('');
    } catch (_kcErr) { /* non-fatal */ }
  }

  // (9.1) Client knowledge visibility — show which facts are being injected
  if (message.action === 'client_knowledge_preview') {
    try {
      const facts = message.facts;
      if (Array.isArray(facts) && facts.length) {
        const chatEl = chatContainer;
        if (chatEl) {
          const existing = chatEl.querySelector('.ck-preview-card');
          if (existing) existing.remove();
          const card = document.createElement('div');
          card.className = 'ck-preview-card';
          card.style.cssText = 'margin:6px 0; padding:8px 12px; background:var(--bg-secondary,#1a1a1a); border:1px solid var(--border,#333); border-left:3px solid #4a9eff; border-radius:6px; font-size:11px;';
          const header = document.createElement('div');
          header.style.cssText = 'display:flex; align-items:center; justify-content:space-between; cursor:pointer; user-select:none;';
          const _factsLen = facts.length; // Cache to avoid repeated property access
          header.innerHTML = `<span style="font-weight:600; color:#4a9eff;">🧠 ${_factsLen} fact${_factsLen !== 1 ? 's' : ''} for ${escapeHtml(message.clientName || 'client')}</span><span class="ck-chevron" style="color:var(--text-secondary,#aaa);">▼</span>`;
          const list = document.createElement('div');
          list.style.cssText = 'margin-top:6px;';
          facts.forEach(f => {
            const item = document.createElement('div');
            item.style.cssText = 'padding:3px 0; border-top:1px solid var(--border,#333); color:var(--text-secondary,#aaa); line-height:1.5;';
            const wisdom = (f.wisdom || '').length > 120 ? `${(f.wisdom || '').substring(0, 117)}...` : (f.wisdom || '');
            item.textContent = wisdom;
            list.appendChild(item);
          });
          header.addEventListener('click', () => {
            const shown = list.style.display !== 'none';
            list.style.display = shown ? 'none' : 'block';
            const chevron = header.querySelector('.ck-chevron');
            if (chevron) chevron.textContent = shown ? '▶' : '▼';
          });
          card.appendChild(header);
          card.appendChild(list);
          chatEl.appendChild(card);
          chatEl.scrollTop = chatEl.scrollHeight;
        }
      }
    } catch (_) { /* non-fatal */ }
  }
  // (8.1) Plan preview — show collapsible plan card before execution starts
  if (message.action === 'plan_preview') {
    try {
      const steps = message.steps;
      if (Array.isArray(steps) && steps.length) {
        const chatEl = chatContainer;
        if (chatEl) {
          const existing = chatEl.querySelector('.plan-preview-card');
          if (existing) existing.remove();
          const card = document.createElement('div');
          card.className = 'plan-preview-card';
          card.style.cssText = 'margin:8px 0; padding:10px 12px; background:var(--bg-secondary,#1a1a1a); border:1px solid var(--border,#333); border-radius:6px; font-size:12px;';
          const header = document.createElement('div');
          header.style.cssText = 'display:flex; align-items:center; justify-content:space-between; cursor:pointer; user-select:none;';
          header.innerHTML = `<span style="font-weight:600; color:var(--text-primary,#eee);">📋 Plan (${steps.length} steps)</span><span class="plan-chevron" style="color:var(--text-secondary,#aaa);">▼</span>`;
          const list = document.createElement('ol');
          list.style.cssText = 'margin:8px 0 0; padding-left:20px; color:var(--text-secondary,#aaa); line-height:1.6;';
          steps.forEach(s => {
            const li = document.createElement('li');
            li.textContent = typeof s === 'string' ? s : (s.description || JSON.stringify(s));
            list.appendChild(li);
          });
          header.addEventListener('click', () => {
            const shown = list.style.display !== 'none';
            list.style.display = shown ? 'none' : 'block';
            const chevron = header.querySelector('.plan-chevron');
            if (chevron) chevron.textContent = shown ? '▶' : '▼';
          });
          card.appendChild(header);
          card.appendChild(list);
          chatEl.appendChild(card);
          chatEl.scrollTop = chatEl.scrollHeight;
        }
      }
    } catch (_) { /* non-fatal */ }
  }
  // Plan preview panel — rendered from agent_plan message type
  if (message.type === 'agent_plan') {
    let planPanel = document.getElementById('plan-preview-panel');
    if (planPanel) planPanel.remove();

    planPanel = document.createElement('div');
    planPanel.id = 'plan-preview-panel';
    planPanel.style.cssText = 'padding:10px 12px;margin:6px 8px;background:rgba(255,255,255,0.03);border-radius:8px;border:1px solid rgba(255,255,255,0.08);';

    const header = document.createElement('div');
    header.style.cssText = 'font-size:13px;font-weight:600;color:#ccc;margin-bottom:8px;display:flex;justify-content:space-between;';
    header.innerHTML = '<span>Plan: ' + message.totalSteps + ' steps</span><span style="font-size:11px;color:#666;cursor:pointer;" id="plan-toggle">Collapse</span>';
    planPanel.appendChild(header);

    const stepsList = document.createElement('div');
    stepsList.id = 'plan-steps-list';
    stepsList.style.cssText = 'font-size:12px;';

    message.plan.forEach((step) => {
      const stepDiv = document.createElement('div');
      stepDiv.style.cssText = 'padding:4px 8px;margin:2px 0;border-radius:4px;color:#999;display:flex;gap:8px;';
      stepDiv.innerHTML = '<span style="color:#555;min-width:20px;">' + (step.index + 1) + '.</span><span>' + escapeHtml(step.text) + '</span>';
      stepsList.appendChild(stepDiv);
    });

    planPanel.appendChild(stepsList);

    // Insert after status bars, before chat messages
    const chatArea = document.getElementById('chatMessages') || document.querySelector('.chat-messages');
    if (chatArea) chatArea.parentNode.insertBefore(planPanel, chatArea);

    // Toggle collapse
    document.getElementById('plan-toggle').addEventListener('click', () => {
      const list = document.getElementById('plan-steps-list');
      const toggle = document.getElementById('plan-toggle');
      if (list.style.display === 'none') { list.style.display = 'block'; toggle.textContent = 'Collapse'; }
      else { list.style.display = 'none'; toggle.textContent = 'Expand'; }
    });
  }
  // (6.0) New step starting — create activity stream card
  if (message.action === 'agent_step_start') {
    if (message.stepNumber && message.stepNumber >= 1) _ensureActivityStream(message.stepNumber);
    updateActiveTabStep(message.stepNumber, message.totalPlannedSteps || 0);
  }
  // (6.0) Activity item upsert (observe / consult-ai / dispatch)
  if (message.action === 'agent_activity') {
    showAgentActivity(message.stepNumber, message.key, message.label, message.status, message.detail);
  }
  // (6.0) Agent action — update step card headline and active tab strip
  if (message.action === 'agent_action') {
    const p = message.payload;
    // (7.1) Save click coordinates for crosshair display on next screenshot
    if (p && (p.type === 'click_at' || (p.type === 'click' && typeof p.x === 'number'))) {
      if (typeof p.x === 'number' && typeof p.y === 'number') {
        __lastClickCoords = { x: p.x, y: p.y };
      }
    }
    if (p && p.stepNumber) {
      _ensureActivityStream(p.stepNumber);
      updateStepCardAction(p.stepNumber, p.description || p.type);
      updateActiveTabAction(p);
      // (6.5) Reasoning card — show collapsible "Thinking..." section if reasoning is present
      if (p.reasoning && p.reasoning.trim()) {
        try {
          const state = __activityState.get(p.stepNumber);
          const card = state ? state.card : null;
          if (card && !card.querySelector('.reasoning-section')) {
            const section = document.createElement('div');
            section.className = 'reasoning-section';
            section.style.cssText = 'margin:4px 0 2px; font-size:11px;';
            const toggle = document.createElement('span');
            toggle.className = 'reasoning-toggle';
            toggle.style.cssText = 'cursor:pointer; color:var(--text-secondary,#aaa); user-select:none;';
            toggle.textContent = '🧠 Thinking... (click to expand)';
            const body = document.createElement('div');
            body.className = 'reasoning-body';
            body.style.cssText = 'display:none; margin-top:4px; padding:6px 8px; background:var(--bg-tertiary,#1f1f1f); border-radius:4px; color:var(--text-secondary,#aaa); white-space:pre-wrap; word-break:break-word;';
            body.textContent = p.reasoning;
            toggle.addEventListener('click', () => {
              const shown = body.style.display !== 'none';
              body.style.display = shown ? 'none' : 'block';
              toggle.textContent = shown ? '🧠 Thinking... (click to expand)' : '🧠 Thinking... (click to collapse)';
            });
            section.appendChild(toggle);
            section.appendChild(body);
            const stream = card.querySelector('.activity-stream');
            if (stream) card.insertBefore(section, stream); else card.appendChild(section);
          }
        } catch (_) { /* non-fatal */ }
      }
      // Confidence bar — show how sure the agent is about this step
      if (typeof p.confidence === 'number') {
        try {
          const state = __activityState.get(p.stepNumber);
          const card = state ? state.card : null;
          if (card && !card.querySelector('.confidence-bar')) {
            const pct = p.confidence;
            const color = pct > 80 ? '#4caf50' : pct > 50 ? '#ff9800' : '#f44336';
            const bar = document.createElement('div');
            bar.className = 'confidence-bar';
            bar.style.cssText = 'margin:4px 0 2px 0;height:3px;border-radius:2px;background:rgba(255,255,255,0.05);overflow:hidden;';
            bar.innerHTML = '<div style="width:' + pct + '%;height:100%;background:' + color + ';border-radius:2px;"></div>';
            bar.title = 'Confidence: ' + pct + '%';
            const stream = card.querySelector('.activity-stream');
            if (stream) card.insertBefore(bar, stream); else card.appendChild(bar);
          }
        } catch (_) { /* non-fatal */ }
      }
    }
  }
  // (6.0) Action result — update step card with success/failure
  if (message.action === 'agent_action_result') {
    updateActionCardResult(message.stepNumber, message.result, message.isError);
  }
  // (Phase 8.2) Post-action verification badge — green "Verified" or red "Failed — retrying"
  if (message.action === 'agent_verification' && message.verification) {
    const card = document.getElementById(`agent-action-${message.stepNumber}`);
    if (card) {
      const inner = card.querySelector('.agent-action-inner');
      if (inner) {
        const existingBadge = inner.querySelector('.verification-badge');
        if (existingBadge) existingBadge.remove();

        const badge = document.createElement('span');
        badge.className = 'verification-badge';
        const v = message.verification;
        if (v.status === 'verified') {
          badge.style.cssText = 'display:inline-flex;align-items:center;gap:3px;margin-top:4px;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;background:rgba(34,197,94,0.15);color:#22c55e;';
          badge.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg> Verified';
        } else if (v.status === 'failed') {
          badge.style.cssText = 'display:inline-flex;align-items:center;gap:3px;margin-top:4px;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;background:rgba(239,68,68,0.15);color:#ef4444;';
          badge.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg> Failed — retrying';
        }
        if (badge.innerHTML) inner.appendChild(badge);
      }
    }
  }
  // Screenshot live preview panel — shows what the agent sees after each action
  if (message.type === 'agent_step' && message.afterScreenshot) {
    let previewPanel = document.getElementById('screenshot-preview');
    if (!previewPanel) {
      previewPanel = document.createElement('div');
      previewPanel.id = 'screenshot-preview';
      previewPanel.style.cssText = 'position:relative;width:100%;max-height:200px;overflow:hidden;border-bottom:1px solid rgba(255,255,255,0.08);cursor:pointer;';
      previewPanel.title = 'Click to expand';
      const chatArea = document.getElementById('chatMessages') || document.querySelector('.chat-messages');
      if (chatArea) chatArea.parentNode.insertBefore(previewPanel, chatArea);
      previewPanel.addEventListener('click', () => {
        const isExpanded = previewPanel.style.maxHeight === '500px';
        previewPanel.style.maxHeight = isExpanded ? '200px' : '500px';
      });
    }
    previewPanel.textContent = '';
    const img = document.createElement('img');
    img.src = message.afterScreenshot;
    img.style.cssText = 'width:100%;display:block;';
    img.alt = 'Agent view';
    previewPanel.appendChild(img);
    previewPanel.style.display = '';
  }
  if (message.action === 'tab_state_update') {
    renderTabBar(message.tabs || []);
  }
  if (message.action === 'agent_update') {
    if (message.stepNumber && message.stepNumber > 0) {
      appendLogLine(message.stepNumber, message.text);
    } else {
      updateStatus(message.text);
    }
  }
  if (message.action === 'page_context') {
    if (message.url) {
      try {
        const hostname = new URL(message.url).hostname;
        updateStatus(`On: ${hostname}${message.title ? ` — ${message.title.substring(0, 50)}` : ''}`);
      } catch {
        updateStatus(`On: ${(message.url || 'unknown').substring(0, 60)}`);
      }
      updateActiveTabPage(message.url, message.title || '');
      if (message.stepNumber) updateActiveTabStep(message.stepNumber, message.totalSteps || 0);
      if (typeof message.tabId === 'number') {
        __atsStripState.tabId = message.tabId;
      }
    }
  }
  if (message.action === 'agent_finished') {
    removeTypingIndicator();
    removeApprovalCard();
    renderTabBar([]);
    hideActiveTabStrip();
    hideMiniShot();
    const _previewPanel = document.getElementById('screenshot-preview');
    if (_previewPanel) _previewPanel.style.display = 'none';
    try { clearActivityState(); } catch { /* activity state may not be initialized */ }
    try {
      const summary = String(message.summary || 'Done');
      const prefix = summary.length > 100 ? '' : '✅ Task completed\n\n';
      addMessage(prefix + summary, 'assistant');
      try {
        const lastMsg = chatContainer.querySelector('.message-group:last-child .message.assistant-msg, .message-group:last-child .assistant-wrapper');
        if (lastMsg) renderSourceChipsIn(lastMsg);
      } catch { /* non-fatal */ }
      // Inline replay export shortcut (9.3)
      try {
        const replayBar = document.createElement('div');
        replayBar.style.cssText = 'display:flex; gap:6px; margin:6px 0 2px; padding:0 4px;';
        const replayBtn = document.createElement('button');
        replayBtn.textContent = '↓ Export Replay';
        replayBtn.title = 'Export an interactive HTML replay of this run';
        replayBtn.style.cssText = 'padding:4px 10px; font-size:11px; background:#4a9eff; color:#fff; border:none; border-radius:4px; cursor:pointer; flex-shrink:0;';
        replayBtn.addEventListener('click', async () => {
          replayBtn.disabled = true;
          replayBtn.textContent = 'Generating…';
          try {
            const costEl = document.getElementById('run-cost');
            const costText = costEl ? costEl.title : '';
            const costMatch = costText.match(COST_EXTRACTION_RE);
            const estimatedCostUsd = costMatch && costMatch[0] && typeof costMatch[0] === 'string' ? (parseFloat(costMatch[0].slice(1)) || 0) : 0;
            const resp = await chrome.runtime.sendMessage({ action: 'export_replay_report', params: { estimatedCostUsd } });
            if (!resp || !resp.ok || !resp.data || !resp.data.html) throw new Error((resp && resp.error) || 'No replay data');
            const blob = new Blob([resp.data.html], { type: 'text/html' });
            const url = URL.createObjectURL(blob);
            await chrome.downloads.download({ url, filename: `sentinel-replay-${Date.now()}.html`, saveAs: true });
            setTimeout(() => URL.revokeObjectURL(url), 5000);
            showToast('Replay report downloading…', 'info');
          } catch (e) {
            showToast(`Replay export failed: ${String(e)}`, 'error');
          } finally {
            replayBtn.disabled = false;
            replayBtn.textContent = '↓ Export Replay';
          }
        });
        replayBar.appendChild(replayBtn);
        chatContainer.appendChild(replayBar);
        chatContainer.scrollTop = chatContainer.scrollHeight;
      } catch { /* non-fatal UI enhancement */ }
      // (3.30.0) Trust score badge — inline render so we don't add a new
      // top-level helper to this file (chat.js has had recurring truncation
      // issues during large edits). All UI for the score is contained here.
      try {
        // Define _trustRow here so it's available before card.innerHTML uses it below.
        const _trustRow = (label, comp) => {
          if (!comp) return '';
          const pts = (typeof comp.points === 'number') ? comp.points : 0;
          const max = (typeof comp.max === 'number') ? comp.max : 0;
          const ratio = (typeof max === 'number' && max !== 0 && !Number.isNaN(max)) ? (Math.abs(pts) / Math.max(1, Math.abs(max))) : 0;
          const barColor = pts < 0 ? '#f44' : (ratio > 0.7 ? '#9ece6a' : ratio > 0.4 ? '#e0af68' : '#f44');
          const widthPct = Math.min(100, Math.round(ratio * 100));
          return `<div style="display:flex; justify-content:space-between; align-items:center; margin:4px 0; gap:8px;">
                   <span style="color:var(--text-secondary); flex-shrink:0; min-width:110px;">${label}</span>
                   <div style="flex:1; height:5px; background:rgba(255,255,255,0.04); border-radius:3px; overflow:hidden;">
                     <div style="width:${widthPct}%; height:100%; background:${barColor};"></div>
                   </div>
                   <span style="color:var(--text-tertiary); flex-shrink:0; min-width:48px; text-align:right; font-variant-numeric:tabular-nums;">${pts} / ${max}</span>
                 </div>`;
        };
        const ts = message.trustScore;
        if (ts && typeof ts.score === 'number') {
          const bandColor = ts.band === 'high' ? '#9ece6a'
            : ts.band === 'good' ? '#7aa2f7'
            : ts.band === 'questionable' ? '#e0af68'
            : '#f44';
          const bandLabel = ts.band === 'high' ? 'Trustworthy'
            : ts.band === 'good' ? 'Good'
            : ts.band === 'questionable' ? 'Questionable'
            : 'Low';
          const bd = ts.breakdown || {};
          const card = document.createElement('div');
          card.className = 'trust-score-card';
          card.style.cssText = `margin:8px 0; padding:10px 12px; background:var(--bg-tertiary, #1f1f1f); border:1px solid ${bandColor}; border-left-width:4px; border-radius:6px; font-size:12px;`;
          // Header line: score + band label + collapse toggle
          card.innerHTML =
            `<div style="display:flex; justify-content:space-between; align-items:center; cursor:pointer;" data-tcs-toggle="1">
              <div>
                <strong style="color:${bandColor}; font-size:14px;">Trust ${ts.score}/100</strong>
                <span style="color:var(--text-secondary); margin-left:8px;">${bandLabel}</span>
              </div>
              <span style="font-size:10px; color:var(--text-tertiary);">▾ details</span>
            </div>
            <div style="display:none; margin-top:10px; padding-top:10px; border-top:1px solid var(--border-color, rgba(255,255,255,0.06));" data-tcs-body="1">
              ${_trustRow('Failure rate',  bd.failure)}
              ${_trustRow('Productivity',  bd.productivity)}
              ${_trustRow('Recovery',      bd.recovery)}
              ${_trustRow('Plan',          bd.plan)}
              ${_trustRow('Efficiency',    bd.efficiency)}
              ${bd.safety && bd.safety.blocks > 0 ? _trustRow('Safety (deduct)', bd.safety) : ''}
            </div>`;
          // Click-to-expand
          card.addEventListener('click', () => {
            const body = card.querySelector('[data-tcs-body]');
            if (!body) return;
            body.style.display = body.style.display === 'none' ? 'block' : 'none';
          });
          chatContainer.appendChild(card);
          chatContainer.scrollTop = chatContainer.scrollHeight;
        }
        // (3.31.0) Retry-suggestion cards. Render one card per suggestion
        // when the score is low/questionable. Each card has a one-click
        // "Apply & retry" button (or a manual prompt when applyKeys is empty).
        // (3.33.0) Persistent dismissal: skip suggestions whose id was
        // dismissed within the last 7 days. Storage shape:
        //   dismissed_suggestions = { [id]: dismissedAtMs }
        // Pre-render we fetch the map, prune any entries older than the TTL
        // (which serves as a passive cleanup pass — no separate timer needed),
        // and write the trimmed map back. The dismiss button click writes
        // a fresh entry so the same suggestion stays hidden across runs.
        try {
          const DISMISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days
          const rawSuggestions = Array.isArray(message.retrySuggestions) ? message.retrySuggestions : [];
          const originalGoal = typeof message.originalGoal === 'string' ? message.originalGoal : '';
          // Fetch dismissed map, prune expired, filter incoming suggestions.
          chrome.storage.local.get('dismissed_suggestions', (stored) => {
            if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) { console.error('[Sentinel/chat] loadDismissedSuggestions failed:', getErrorMessage(chrome.runtime.lastError)); return; }
            const now = Date.now();
            const raw = (stored && stored.dismissed_suggestions && typeof stored.dismissed_suggestions === 'object')
              ? stored.dismissed_suggestions : {};
            // Prune entries older than TTL.
            const dismissedMap = {};
            const rawCount = Object.keys(raw).length;
            for (const [id, ts] of Object.entries(raw)) {
              if (typeof ts === 'number' && (now - ts) < DISMISS_TTL_MS) dismissedMap[id] = ts;
            }
            // Persist the pruned map back if anything changed (lazy cleanup).
            if (Object.keys(dismissedMap).length !== rawCount) {
              try { chrome.storage.local.set({ dismissed_suggestions: dismissedMap }); } catch { /* storage write may fail */ }
            }
            const suggestions = rawSuggestions.filter(s => s && s.id && !dismissedMap[s.id]);
            _renderSuggestionsList(suggestions, originalGoal, dismissedMap);
          });
        } catch { /* non-fatal */ }
        // Helper closures live inside the try-catch above so they can see
        // _trustRow without polluting the chat.js namespace.
        function _renderSuggestionsList(suggestions, originalGoal, _dismissedMap) {
          for (const sug of suggestions) {
            if (!sug || !sug.id) continue;
            const sevColor = sug.severity === 'high' ? '#f44'
              : sug.severity === 'medium' ? '#e0af68'
              : '#7aa2f7';
            const isAutoApply = Array.isArray(sug.applyKeys) && sug.applyKeys.length;
            const isResetSkills = sug.id === 'reset-skills-and-retry';
            const sCard = document.createElement('div');
            sCard.className = 'retry-suggestion-card';
            sCard.dataset.suggestionId = sug.id;
            sCard.style.cssText = `margin:6px 0; padding:10px 12px; background:var(--bg-tertiary, #1f1f1f); border:1px solid ${sevColor}; border-left-width:3px; border-radius:6px; font-size:12px;`;
            // Header + reason
            const header = document.createElement('div');
            header.style.cssText = 'display:flex; justify-content:space-between; align-items:flex-start; gap:10px;';
            const textWrap = document.createElement('div');
            textWrap.style.cssText = 'flex:1; min-width:0;';
            const lbl = document.createElement('div');
            lbl.style.cssText = `font-weight:600; color:${sevColor}; margin-bottom:3px;`;
            lbl.textContent = sug.label || '(no label)';
            textWrap.appendChild(lbl);
            const why = document.createElement('div');
            why.style.cssText = 'color:var(--text-secondary); line-height:1.4;';
            why.textContent = sug.reason || '';
            textWrap.appendChild(why);
            header.appendChild(textWrap);
            // Action buttons
            const btnWrap = document.createElement('div');
            btnWrap.style.cssText = 'display:flex; flex-direction:column; gap:4px; flex-shrink:0;';
            if (isAutoApply || isResetSkills) {
              const applyBtn = document.createElement('button');
              applyBtn.textContent = isResetSkills ? 'Reset & retry' : 'Apply & retry';
              applyBtn.style.cssText = `padding:5px 10px; font-size:11px; background:${sevColor}; color:#fff; border:none; border-radius:4px; cursor:pointer; white-space:nowrap;`;
              applyBtn.addEventListener('click', async () => {
                applyBtn.disabled = true;
                applyBtn.textContent = '⏳';
                try {
                  // Special-case: reset-skills uses a message API, not a storage write.
                  if (isResetSkills) {
                    await new Promise((resolve) => chrome.runtime.sendMessage({ action: 'reset_skill_stats' }, () => resolve()));
                  }
                  // Apply each (key, value) pair to chrome.storage.local.
                  if (Array.isArray(sug.applyKeys) && sug.applyKeys.length && Array.isArray(sug.applyValues)) {
                    const updates = {};
                    const applyKeysLen = sug.applyKeys.length;
                    const applyValuesLen = sug.applyValues.length;
                    for (let i = 0; i < applyKeysLen; i++) {
                      if (i < applyValuesLen) updates[sug.applyKeys[i]] = sug.applyValues[i];
                    }
                    await chrome.storage.local.set(updates);
                  }
                  // Re-fire the original goal as a new run.
                  if (originalGoal) {
                    // Use the same send-message path that the regular send button uses.
                    try {
                      const inputBox = document.getElementById('goalInput') || document.getElementById('chat-input');
                      if (inputBox) {
                        inputBox.value = originalGoal;
                      }
                      if (typeof sendMessage === 'function') sendMessage();
                    } catch (e) { console.warn('[Sentinel] DOM write error:', getErrorMessage(e)); }
                  }
                  sCard.style.opacity = '0.5';
                  applyBtn.textContent = 'Applied';
                } catch {
                  applyBtn.disabled = false;
                  applyBtn.textContent = sug.label && sug.label.startsWith('Reset') ? 'Reset & retry' : 'Apply & retry';
                }
              });
              btnWrap.appendChild(applyBtn);
            }
            const dismissBtn = document.createElement('button');
            dismissBtn.textContent = 'Dismiss';
            dismissBtn.style.cssText = 'padding:5px 10px; font-size:11px; background:transparent; color:var(--text-secondary); border:1px solid var(--border-color, rgba(255,255,255,0.12)); border-radius:4px; cursor:pointer; white-space:nowrap;';
            dismissBtn.addEventListener('click', () => {
              try {
                sCard.remove();
                if (sug && sug.id) {
                  chrome.storage.local.get('dismissed_suggestions', (stored) => {
                    if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) { console.error('[Sentinel/chat] loadDismissedSuggestion failed:', getErrorMessage(chrome.runtime.lastError)); return; }
                    const map = (stored && stored.dismissed_suggestions && typeof stored.dismissed_suggestions === 'object')
                      ? stored.dismissed_suggestions : {};
                    map[sug.id] = Date.now();
                    try { chrome.storage.local.set({ dismissed_suggestions: map }); } catch { /* storage write may fail */ }
                  });
                }
              } catch (e) { console.warn('[Sentinel] DOM removal error:', getErrorMessage(e)); }
            });
            btnWrap.appendChild(dismissBtn);
            header.appendChild(btnWrap);
            sCard.appendChild(header);
            chatContainer.appendChild(sCard);
          }
          if (suggestions.length) {
            chatContainer.scrollTop = chatContainer.scrollHeight;
          }
        }  /* end of _renderSuggestionsList (v3.33.0 callback-scoped) */
      } catch { /* trust-score render non-fatal */ }
    } catch (err) {
      console.error('Error displaying completion message:', getErrorMessage(err));
    }
    resetUI();
  }
  // Approval / pause / interrupt cards — the background sends these but the
  // handler had no cases for them, leaving every approval-mode run deadlocked.
  if (message.action === 'request_approval') {
    try { showApprovalCard(message.payload); } catch (e) { console.error('[Sentinel] showApprovalCard error:', getErrorMessage(e)); }
  }
  if (message.action === 'mfa_pause') {
    try { showMfaBanner(message.url, message.hint, message.stepNumber); } catch (e) { console.error('[Sentinel] showMfaBanner error:', getErrorMessage(e)); }
  }
  if (message.action === 'sign_in_wall_pause') {
    try { showSignInWallBanner(message.url, message.host, message.evidence, message.stepNumber); } catch (e) { console.error('[Sentinel] showSignInWallBanner error:', getErrorMessage(e)); }
  }
  if (message.action === 'adapted_goal_available') {
    try { showAdaptedGoalCard(message); } catch (e) { console.error('[Sentinel] showAdaptedGoalCard error:', getErrorMessage(e)); }
  }
  if (message.action === 'mode_mismatch_pause') {
    try { showModeMismatchCard(message); } catch (e) { console.error('[Sentinel] showModeMismatchCard error:', getErrorMessage(e)); }
  }
  if (message.action === 'download_captured') {
    try { showDownloadCaptured(message); } catch (e) { console.error('[Sentinel] showDownloadCaptured error:', getErrorMessage(e)); }
  }
  if (message.action === 'run_log_available') {
    try { showRunLogExportButton(message.runLogId, message.entryCount); } catch (e) { console.error('[Sentinel] showRunLogExportButton error:', getErrorMessage(e)); }
  }
  // (Phase 5) Learned Patterns Dashboard — show action patterns and success rates
  if (message.type === 'learned_patterns' && message.patterns && message.patterns.length > 0) {
    try {
      let patternsPanel = document.getElementById('patterns-panel');
      if (!patternsPanel) {
        patternsPanel = document.createElement('div');
        patternsPanel.id = 'patterns-panel';
        patternsPanel.style.cssText = 'padding:8px 12px;margin:4px 8px;background:rgba(255,255,255,0.02);border-radius:6px;border:1px solid rgba(255,255,255,0.06);font-size:11px;';
        const chatArea = document.getElementById('chatMessages') || document.querySelector('.chat-messages');
        if (chatArea) chatArea.parentNode.insertBefore(patternsPanel, chatArea);
      }
      const header = '<div style="color:#888;margin-bottom:4px;">Learned Patterns (' + message.patterns.length + ')</div>';
      const rows = message.patterns.slice(0, 5).map(function(p) {
        const color = p.rate >= 90 ? '#4caf50' : p.rate >= 70 ? '#ff9800' : '#f44336';
        return '<div style="display:flex;justify-content:space-between;padding:2px 0;color:#777;"><span>' + escapeHtml(String(p.pattern)) + '</span><span style="color:' + color + '">' + escapeHtml(String(p.rate)) + '% (' + escapeHtml(String(p.uses)) + ')</span></div>';
      }).join('');
      patternsPanel.innerHTML = header + rows;
    } catch (e) { console.warn('[Sentinel] Patterns panel render error:', e); }
  }
  // ERR-02/03: Render AgentError as error card in chat
  if (message.action === 'agent_error') {
    try { renderErrorCard(message.error); } catch (e) { console.error('[Sentinel] renderErrorCard error:', e); }
  }
});
