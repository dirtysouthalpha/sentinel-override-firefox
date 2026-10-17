/**
 * Sentinel Quick Assist v3.46.0 — Floating AI Panel Content Script
 * Injects a floating panel on any webpage for inline AI-powered text analysis.
 * Uses Shadow DOM for style isolation. No top-level await (MV3 constraint).
 */

(function sentinelQuickAssist() {
  'use strict';
  function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  // Avoid double-injection in same frame
  if (window.__sentinelQuickAssistLoaded) return;
  window.__sentinelQuickAssistLoaded = true;

  var enabled = true;
  var panel = null;
  var shadow = null;
  var triggerBtn = null;
  var triggerAutoHideTimer = null;
  var selectedText = '';
  var pageInfo = { title: '', url: '' };

  // ===== Action definitions =====
  var ACTIONS = [
    { id: 'summarize',   label: 'Summarize',   prompt: 'Summarize the following text concisely, highlighting key points:' },
    { id: 'explain',     label: 'Explain',     prompt: 'Explain this in plain language for a non-technical audience:' },
    { id: 'fix',         label: 'Troubleshoot',prompt: 'Given the following error/message, suggest troubleshooting steps for an IT technician:' },
    { id: 'playbook',    label: 'Playbook',    prompt: 'Based on the following, create a step-by-step IT runbook/playbook for an MSP technician:' },
    { id: 'extract',     label: 'Extract',     prompt: 'Extract all structured data (IPs, email addresses, dates, ticket numbers, hostnames, URLs) from:' },
    { id: 'rewrite',     label: 'Rewrite',     prompt: 'Rewrite the following in a professional tone suitable for client communication:' },
    { id: 'security',    label: 'Security',    prompt: 'Analyze the following for security implications: identify risks, exposed credentials, misconfigurations, and remediation steps for an IT security context:' }
  ];

  // ===== CSS =====
  var CSS = '\
    .qa-panel {\
      position: fixed;\
      z-index: 2147483647;\
      width: 420px;\
      max-height: 600px;\
      background: rgba(13, 17, 23, 0.96);\
      border: 1px solid rgba(0, 132, 255, 0.3);\
      border-radius: 12px;\
      box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 20px rgba(0,132,255,0.08);\
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\
      font-size: 13px;\
      color: #e1e4e8;\
      display: flex;\
      flex-direction: column;\
      overflow: hidden;\
      animation: qaFadeIn 200ms ease-out;\
      user-select: text;\
    }\
    @keyframes qaFadeIn {\
      from { opacity: 0; transform: translateY(-8px) scale(0.97); }\
      to   { opacity: 1; transform: translateY(0) scale(1); }\
    }\
    .qa-header {\
      display: flex;\
      align-items: center;\
      justify-content: space-between;\
      padding: 10px 14px;\
      background: rgba(0, 132, 255, 0.08);\
      border-bottom: 1px solid rgba(0, 132, 255, 0.15);\
      cursor: grab;\
      flex-shrink: 0;\
    }\
    .qa-header:active { cursor: grabbing; }\
    .qa-title {\
      font-size: 12px;\
      font-weight: 600;\
      color: #0084ff;\
      letter-spacing: 0.5px;\
      text-transform: uppercase;\
    }\
    .qa-close {\
      background: none;\
      border: none;\
      color: #8b949e;\
      font-size: 18px;\
      cursor: pointer;\
      padding: 0 4px;\
      line-height: 1;\
      transition: color 0.15s;\
    }\
    .qa-close:hover { color: #f85149; }\
    .qa-actions {\
      display: flex;\
      flex-wrap: wrap;\
      gap: 6px;\
      padding: 10px 14px;\
      border-bottom: 1px solid rgba(255,255,255,0.06);\
      flex-shrink: 0;\
    }\
    .qa-btn {\
      padding: 5px 12px;\
      border-radius: 6px;\
      border: 1px solid rgba(0,132,255,0.3);\
      background: rgba(0,132,255,0.06);\
      color: #58a6ff;\
      font-size: 12px;\
      font-weight: 500;\
      cursor: pointer;\
      transition: all 0.15s;\
      font-family: inherit;\
    }\
    .qa-btn:hover {\
      background: rgba(0,132,255,0.15);\
      border-color: #0084ff;\
      color: #79c0ff;\
    }\
    .qa-btn:active {\
      transform: scale(0.96);\
    }\
    .qa-btn.qa-loading {\
      opacity: 0.5;\
      pointer-events: none;\
    }\
    .qa-selection {\
      padding: 10px 14px;\
      border-bottom: 1px solid rgba(255,255,255,0.06);\
      max-height: 60px;\
      overflow: hidden;\
      font-size: 12px;\
      color: #8b949e;\
      line-height: 1.4;\
      flex-shrink: 0;\
    }\
    .qa-selection-text {\
      display: -webkit-box;\
      -webkit-line-clamp: 3;\
      -webkit-box-orient: vertical;\
      overflow: hidden;\
    }\
    .qa-response-wrap {\
      flex: 1;\
      min-height: 80px;\
      max-height: 300px;\
      overflow-y: auto;\
      padding: 12px 14px;\
    }\
    .qa-response-wrap::-webkit-scrollbar { width: 6px; }\
    .qa-response-wrap::-webkit-scrollbar-track { background: transparent; }\
    .qa-response-wrap::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 3px; }\
    .qa-response {\
      line-height: 1.6;\
      white-space: pre-wrap;\
      word-break: break-word;\
    }\
    .qa-response code {\
      background: rgba(255,255,255,0.08);\
      padding: 1px 5px;\
      border-radius: 4px;\
      font-family: "SF Mono", Consolas, "Liberation Mono", Menlo, monospace;\
      font-size: 12px;\
    }\
    .qa-response strong, .qa-response b { color: #79c0ff; }\
    .qa-response ul, .qa-response ol {\
      padding-left: 20px;\
      margin: 4px 0;\
    }\
    .qa-response li { margin: 2px 0; }\
    .qa-loading-indicator {\
      display: flex;\
      align-items: center;\
      gap: 8px;\
      color: #8b949e;\
      padding: 20px 14px;\
    }\
    .qa-dots span {\
      display: inline-block;\
      width: 6px;\
      height: 6px;\
      border-radius: 50%;\
      background: #0084ff;\
      animation: qaPulse 1.2s infinite;\
    }\
    .qa-dots span:nth-child(2) { animation-delay: 0.2s; }\
    .qa-dots span:nth-child(3) { animation-delay: 0.4s; }\
    @keyframes qaPulse {\
      0%, 80%, 100% { opacity: 0.2; transform: scale(0.8); }\
      40% { opacity: 1; transform: scale(1.1); }\
    }\
    .qa-footer {\
      display: flex;\
      gap: 8px;\
      padding: 10px 14px;\
      border-top: 1px solid rgba(255,255,255,0.06);\
      flex-shrink: 0;\
    }\
    .qa-footer-btn {\
      flex: 1;\
      padding: 7px 12px;\
      border-radius: 6px;\
      border: 1px solid rgba(255,255,255,0.1);\
      background: rgba(255,255,255,0.04);\
      color: #c9d1d9;\
      font-size: 12px;\
      cursor: pointer;\
      transition: all 0.15s;\
      font-family: inherit;\
      text-align: center;\
    }\
    .qa-footer-btn:hover {\
      background: rgba(255,255,255,0.08);\
      border-color: rgba(255,255,255,0.2);\
    }\
    .qa-footer-btn.qa-send-btn {\
      background: rgba(0,132,255,0.1);\
      border-color: rgba(0,132,255,0.3);\
      color: #58a6ff;\
    }\
    .qa-footer-btn.qa-send-btn:hover {\
      background: rgba(0,132,255,0.2);\
    }\
    .qa-trigger {\
      position: fixed;\
      z-index: 2147483646;\
      width: 32px;\
      height: 32px;\
      border-radius: 50%;\
      background: rgba(13,17,23,0.95);\
      border: 1px solid rgba(0,132,255,0.4);\
      color: #0084ff;\
      font-size: 16px;\
      display: flex;\
      align-items: center;\
      justify-content: center;\
      cursor: pointer;\
      box-shadow: 0 4px 12px rgba(0,0,0,0.4), 0 0 10px rgba(0,132,255,0.15);\
      animation: qaFadeIn 200ms ease-out;\
      transition: transform 0.15s, box-shadow 0.15s;\
    }\
    .qa-trigger:hover {\
      transform: scale(1.15);\
      box-shadow: 0 4px 16px rgba(0,0,0,0.5), 0 0 16px rgba(0,132,255,0.3);\
    }\
    .qa-placeholder {\
      color: #484f58;\
      font-style: italic;\
      text-align: center;\
      padding: 20px;\
    }\
    .qa-error {\
      color: #f85149;\
    }\
  ';

  // ===== Utility functions =====

  /**
   * Simple markdown-like rendering: bold, code, lists.
   */
  function renderMarkdown(text) {
    if (!text) return '';
    var html = text
      // Escape HTML
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      // Bold **text** or __text__
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/__(.+?)__/g, '<strong>$1</strong>')
      // Inline code `text`
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      // Lists: - item or * item or 1. item
      .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
      .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
      // Line breaks
      .replace(/\n/g, '<br>');

    // Wrap consecutive <li> in <ul>
    html = html.replace(/((?:<li>.*?<\/li>(?:<br>)?)+)/g, '<ul>$1</ul>');
    html = html.replace(/<br><\/ul>/g, '</ul>');
    html = html.replace(/<\/li><br>/g, '</li>');
    return html;
  }

  /**
   * Get selection position for trigger button placement.
   */
  function getSelectionPosition() {
    var sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    var range = sel.getRangeAt(0);
    var rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    return {
      x: rect.right + 8,
      y: rect.top - 4
    };
  }

  /**
   * Get position for the panel (near selection or center).
   */
  function getPanelPosition() {
    var selPos = getSelectionPosition();
    if (selPos) {
      var x = Math.min(selPos.x, window.innerWidth - 440);
      var y = Math.max(10, Math.min(selPos.y, window.innerHeight - 200));
      return { x: x, y: y };
    }
    return {
      x: Math.max(10, (window.innerWidth - 420) / 2),
      y: Math.max(10, (window.innerHeight - 400) / 2)
    };
  }

  // ===== Trigger button =====

  function showTrigger() {
    if (!enabled) return;
    hideTrigger();
    var pos = getSelectionPosition();
    if (!pos) return;

    triggerBtn = document.createElement('div');
    triggerBtn.className = 'qa-trigger';
    triggerBtn.textContent = '\u26A1';
    triggerBtn.title = 'Sentinel Quick Assist';

    // Clamp to viewport
    var x = Math.min(pos.x, window.innerWidth - 40);
    var y = Math.max(4, pos.y);
    triggerBtn.style.left = `${x}px`;
    triggerBtn.style.top = `${y}px`;

    triggerBtn.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      hideTrigger();
      showPanel();
    });

    (document.body || document.documentElement).appendChild(triggerBtn);

    // Auto-hide after 5 seconds
    if (triggerAutoHideTimer) clearTimeout(triggerAutoHideTimer);
    triggerAutoHideTimer = setTimeout(function() { hideTrigger(); }, 5000);
  }

  function hideTrigger() {
    if (triggerAutoHideTimer) { clearTimeout(triggerAutoHideTimer); triggerAutoHideTimer = null; }
    if (triggerBtn && triggerBtn.parentNode) {
      triggerBtn.parentNode.removeChild(triggerBtn);
    }
    triggerBtn = null;
  }

  // ===== Panel =====

  function showPanel() {
    if (panel) return;

    // Capture page info
    pageInfo = { title: document.title || '', url: window.location.href || '' };
    selectedText = ((window.getSelection() || { toString: () => '' }).toString()).trim() || '';

    // Create host element
    panel = document.createElement('div');
    panel.className = 'qa-panel';

    // Position — must be set inline since shadow DOM CSS doesn't apply to host element
    panel.style.position = 'fixed';
    panel.style.zIndex = '2147483647';
    var pos = getPanelPosition();
    panel.style.left = `${pos.x}px`;
    panel.style.top = `${pos.y}px`;

    // Attach shadow DOM
    shadow = panel.attachShadow({ mode: 'closed' });

    // Inject styles
    var style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    // Build panel content
    shadow.appendChild(buildHeader());
    shadow.appendChild(buildActions());
    shadow.appendChild(buildSelectionPreview());
    shadow.appendChild(buildResponseArea());
    shadow.appendChild(buildFooter());

    (document.body || document.documentElement).appendChild(panel);
    makeDraggable();
  }

  function hidePanel() {
    if (panel && panel.parentNode) {
      panel.parentNode.removeChild(panel);
    }
    panel = null;
    shadow = null;
  }

  function buildHeader() {
    var header = document.createElement('div');
    header.className = 'qa-header';

    var title = document.createElement('span');
    title.className = 'qa-title';
    title.textContent = '\u26A1 SENTINEL QUICK ASSIST';

    var closeBtn = document.createElement('button');
    closeBtn.className = 'qa-close';
    closeBtn.textContent = '\u00D7';
    closeBtn.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      hidePanel();
    });

    header.appendChild(title);
    header.appendChild(closeBtn);
    return header;
  }

  function buildActions() {
    var container = document.createElement('div');
    container.className = 'qa-actions';

    if (Array.isArray(ACTIONS) && typeof ACTIONS.forEach === 'function') {
      ACTIONS.forEach(function(action) {
        var btn = document.createElement('button');
        btn.className = 'qa-btn';
        btn.textContent = action.label;
        btn.dataset.actionId = action.id;
        btn.addEventListener('click', function(e) {
          e.preventDefault();
          e.stopPropagation();
          executeAction(action);
        });
        container.appendChild(btn);
      });
    }

    return container;
  }

  function buildSelectionPreview() {
    var container = document.createElement('div');
    container.className = 'qa-selection';

    var label = document.createElement('div');
    label.style.cssText = 'font-size:10px;color:#484f58;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;';
    label.textContent = 'Selected Text';

    var textEl = document.createElement('div');
    textEl.className = 'qa-selection-text';
    textEl.textContent = selectedText || '(no text selected)';

    container.appendChild(label);
    container.appendChild(textEl);
    return container;
  }

  function buildResponseArea() {
    var container = document.createElement('div');
    container.className = 'qa-response-wrap';
    container.id = 'qa-response-area';

    var placeholder = document.createElement('div');
    placeholder.className = 'qa-placeholder';
    placeholder.textContent = 'Click an action button above to analyze the selected text';
    container.appendChild(placeholder);

    return container;
  }

  function buildFooter() {
    var container = document.createElement('div');
    container.className = 'qa-footer';

    var copyBtn = document.createElement('button');
    copyBtn.className = 'qa-footer-btn';
    copyBtn.textContent = '\uD83D\uDCCB Copy';
    copyBtn.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      copyResponse();
    });

    var sendBtn = document.createElement('button');
    sendBtn.className = 'qa-footer-btn qa-send-btn';
    sendBtn.textContent = '\uD83D\uDE80 Send to Agent';
    sendBtn.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      sendToAgent();
    });

    container.appendChild(copyBtn);
    container.appendChild(sendBtn);
    return container;
  }

  // ===== Actions =====

  function executeAction(action) {
    if (!selectedText) {
      selectedText = (window.getSelection() || { toString: () => '' }).toString().trim();
    }
    if (!selectedText) {
      setResponseHTML('<span class="qa-error">No text selected. Select text on the page first, then try again.</span>');
      return;
    }

    // Set loading state
    setButtonsLoading(true);
    setResponseLoading();

    // Build prompt
    var prompt = `You are Sentinel Quick Assist, an AI assistant for MSP technicians.
Current page: ${typeof pageInfo.title === 'string' ? pageInfo.title : 'Unknown'} (${typeof pageInfo.url === 'string' ? pageInfo.url : 'unknown'})

${action.prompt}

---
${selectedText}`;

    // Send to background
    chrome.runtime.sendMessage(
      { action: 'quick_assist_request', prompt: prompt },
      function(response) {
        setButtonsLoading(false);
        if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) {
          setResponseHTML(`<span class="qa-error">Error: ${escapeHtml(typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null && typeof chrome.runtime.lastError.message === 'string' ? chrome.runtime.lastError.message : 'Unknown error')}</span>`);
          return;
        }
        var text = response && response.data && response.data.text;
        if (text) {
          setResponse(text);
        } else if (response && response.ok === false) {
          setResponseHTML(`<span class="qa-error">Error: ${escapeHtml(response.error || 'Unknown error')}</span>`);
        } else {
          setResponseHTML('<span class="qa-error">No response received.</span>');
        }
      }
    );
  }

  function setButtonsLoading(loading) {
    if (!shadow) return;
    var btns = shadow.querySelectorAll('.qa-btn');
    if (btns && typeof btns.forEach === 'function') {
      btns.forEach(function(btn) {
      if (loading) {
        btn.classList.add('qa-loading');
      } else {
        btn.classList.remove('qa-loading');
      }
    });
    }
  }

  function setResponseLoading() {
    if (!shadow) return;
    var area = shadow.querySelector('#qa-response-area');
    if (!area) return;
    area.innerHTML = `<div class="qa-loading-indicator">` +
      `<div class="qa-dots"><span></span><span></span><span></span></div>` +
      `<span>Analyzing...</span></div>`;
  }

  function setResponse(text) {
    if (!shadow) return;
    var area = shadow.querySelector('#qa-response-area');
    if (!area) return;
    area.innerHTML = `<div class="qa-response">${renderMarkdown(text)}</div>`;
  }

  function setResponseHTML(html) {
    if (!shadow) return;
    var area = shadow.querySelector('#qa-response-area');
    if (!area) return;
    area.innerHTML = `<div class="qa-response">${html}</div>`;
  }

  function copyResponse() {
    if (!shadow) return;
    var area = shadow.querySelector('#qa-response-area');
    if (!area) return;
    var responseEl = area.querySelector('.qa-response');
    if (!responseEl) return;
    var text = responseEl.textContent || responseEl.innerText;
    if (!text) return;

    navigator.clipboard.writeText(text).then(function() {
      if (!shadow) return;
      var btn = shadow.querySelector('.qa-footer-btn');
      if (btn) {
        var orig = btn.textContent;
        btn.textContent = '\u2713 Copied!';
        setTimeout(function() { btn.textContent = orig; }, 1500);
      }
    }).catch(function() {
      // Fallback
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      (document.body || document.documentElement).appendChild(ta);
      ta.select();
      document.execCommand('copy');
      if (ta.parentNode) ta.parentNode.removeChild(ta);
    });
  }

  function sendToAgent() {
    if (!shadow) return;
    var area = shadow.querySelector('#qa-response-area');
    if (!area) return;
    var responseEl = area.querySelector('.qa-response');
    if (!responseEl) return;
    var text = responseEl.textContent || responseEl.innerText;
    if (!text) return;

    chrome.runtime.sendMessage({ action: 'set_goal', goal: text }, function() {
      if ((typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) || !shadow) return;
      var btn = shadow.querySelector('.qa-send-btn');
      if (btn) {
        var orig = btn.textContent;
        btn.textContent = '\u2713 Sent!';
        setTimeout(function() { btn.textContent = orig; }, 1500);
      }
    });
  }

  // ===== Dragging =====

  function makeDraggable() {
    if (!panel) return;
    var header = shadow.querySelector('.qa-header');
    if (!header) return;

    var isDragging = false;
    var startX = 0, startY = 0, startLeft = 0, startTop = 0;

    function onMouseDown(e) {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startLeft = panel.offsetLeft;
      startTop = panel.offsetTop;
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      e.preventDefault();
    }

    function onMouseMove(e) {
      if (!isDragging) return;
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;
      var newLeft = Math.max(0, Math.min(startLeft + dx, window.innerWidth - 420));
      var newTop = Math.max(0, Math.min(startTop + dy, window.innerHeight - 100));
      panel.style.left = `${newLeft}px`;
      panel.style.top = `${newTop}px`;
    }

    function onMouseUp() {
      isDragging = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    }

    header.addEventListener('mousedown', onMouseDown);
  }

  // ===== Event listeners =====

  // Text selection → show trigger
  document.addEventListener('mouseup', function(e) {
    if (!enabled) return;
    // Don't trigger on our own panel
    if (panel && panel.contains(e.target)) return;

    // Small delay to let selection settle
    setTimeout(function() {
      var text = (window.getSelection() || { toString: () => '' }).toString().trim();
      var MIN_SELECTION_LENGTH = 10;
      if (text.length > MIN_SELECTION_LENGTH) {
        showTrigger();
      } else {
        hideTrigger();
      }
    }, 100);
  });

  // Click outside panel → close
  document.addEventListener('mousedown', function(e) {
    if (!panel) return;
    if (panel.contains(e.target)) return;
    // Small delay to not conflict with trigger click
    setTimeout(function() {
      if (panel && !panel.contains(document.activeElement)) {
        hidePanel();
      }
    }, 200);
  });

  // Escape key → close
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      if (panel) { hidePanel(); e.preventDefault(); }
      else if (triggerBtn) { hideTrigger(); }
    }
  });

  // Messages from background (context menu trigger)
  chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
    if (msg.action === 'show_quick_assist') {
      selectedText = msg.selectedText || '';
      if (msg.pageInfo) {
        pageInfo = msg.pageInfo;
      }
      hideTrigger();
      showPanel();
      if (sendResponse) sendResponse({ ok: true });
    }
    return false;
  });

  // Storage changes → enable/disable
  chrome.storage.onChanged.addListener(function(changes, area) {
    if (area === 'local' && changes.quickAssist) {
      enabled = changes.quickAssist.newValue !== false;
      if (!enabled) {
        hidePanel();
        hideTrigger();
      }
    }
  });

  // ===== Init =====
  // Check if Quick Assist is enabled
  try {
    chrome.storage.local.get(['quickAssist'], function(result) {
      if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) { const _err = typeof chrome.runtime.lastError.message === 'string' ? chrome.runtime.lastError.message : String(chrome.runtime.lastError); console.warn('[Sentinel/quick-assist] init failed:', _err); return; }
      enabled = result.quickAssist !== false; // default ON
    });
  } catch (_e) {
    // Storage not available — keep enabled
  }

})();
