// Sentinel Override v3 — Action HUD
// Floating overlay that shows the user what the agent is doing in real-time.
// Like Claude's computer use — visible step counter, action type, and result feedback
// directly on the page so you can monitor and stop if needed.

window.__sentinelUtils = window.__sentinelUtils || {};

(function() {
  const HUD_ID = '__sentinel_action_hud__';
  const HUD_STYLE_ID = '__sentinel_action_hud_style__';
  let _hudEl = null;
  let hideTimer = null;
  let currentStep = 0;
  let totalSteps = 20;
  let currentAction = '';
  let _statusText = '';
  let pulseTimer = null;

  // ── Styles ──
  const HUD_CSS = `
    #${HUD_ID} {
      position: fixed !important;
      top: 12px !important;
      right: 12px !important;
      z-index: 2147483646 !important;
      pointer-events: none !important;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif !important;
      font-size: 13px !important;
      line-height: 1.4 !important;
      color: #e0e0e0 !important;
      min-width: 240px !important;
      max-width: 420px !important;
      opacity: 0;
      transform: translateY(-8px);
      transition: opacity 0.3s ease, transform 0.3s ease;
    }
    #${HUD_ID}.visible {
      opacity: 1;
      transform: translateY(0);
    }
    #${HUD_ID} .hud-card {
      background: rgba(15, 15, 20, 0.92) !important;
      backdrop-filter: blur(12px) !important;
      border: 1px solid rgba(255, 107, 0, 0.25) !important;
      border-radius: 10px !important;
      padding: 10px 14px !important;
      box-shadow: 0 4px 24px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,107,0,0.1) !important;
    }
    #${HUD_ID} .hud-header {
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;
      margin-bottom: 6px !important;
    }
    #${HUD_ID} .hud-brand {
      font-weight: 600 !important;
      font-size: 11px !important;
      text-transform: uppercase !important;
      letter-spacing: 1.2px !important;
      color: #ff6b00 !important;
    }
    #${HUD_ID} .hud-step {
      font-size: 11px !important;
      color: #888 !important;
      font-variant-numeric: tabular-nums !important;
    }
    #${HUD_ID} .hud-step .step-num {
      color: #ff6b00 !important;
      font-weight: 700 !important;
    }
    #${HUD_ID} .hud-progress-bar {
      width: 100% !important;
      height: 3px !important;
      background: rgba(255,255,255,0.08) !important;
      border-radius: 2px !important;
      margin: 6px 0 !important;
      overflow: hidden !important;
    }
    #${HUD_ID} .hud-progress-fill {
      height: 100% !important;
      background: linear-gradient(90deg, #ff6b00, #ff9500) !important;
      border-radius: 2px !important;
      transition: width 0.5s ease !important;
    }
    #${HUD_ID} .hud-action {
      display: flex !important;
      align-items: center !important;
      gap: 8px !important;
      margin-top: 4px !important;
    }
    #${HUD_ID} .hud-action-icon {
      width: 18px !important;
      height: 18px !important;
      flex-shrink: 0 !important;
    }
    #${HUD_ID} .hud-action-text {
      font-size: 13px !important;
      color: #d4d4d4 !important;
      font-weight: 500 !important;
    }
    #${HUD_ID} .hud-result {
      font-size: 11px !important;
      color: #888 !important;
      margin-top: 4px !important;
      max-height: 40px !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      white-space: nowrap !important;
    }
    #${HUD_ID} .hud-result.success { color: #4ade80 !important; }
    #${HUD_ID} .hud-result.error { color: #f87171 !important; }
    #${HUD_ID} .hud-pulse {
      display: inline-block !important;
      width: 6px !important;
      height: 6px !important;
      border-radius: 50% !important;
      background: #ff6b00 !important;
      animation: hudPulse 1.5s ease-in-out infinite !important;
      margin-right: 4px !important;
      vertical-align: middle !important;
    }
    @keyframes hudPulse {
      0%, 100% { opacity: 0.4; transform: scale(0.8); }
      50% { opacity: 1; transform: scale(1.2); }
    }
    #${HUD_ID}.action-pulse .hud-card {
      border-color: rgba(255, 107, 0, 0.6) !important;
      box-shadow: 0 4px 24px rgba(0,0,0,0.5), 0 0 16px rgba(255,107,0,0.2) !important;
    }
  `;

  // ── Action icons (simple SVG) ──
  const ICONS = {
    navigate: `<svg viewBox="0 0 18 18" fill="none" stroke="#ff6b00" stroke-width="1.5"><circle cx="9" cy="9" r="7"/><path d="M9 5v4l3 2"/></svg>`,
    click: `<svg viewBox="0 0 18 18" fill="none" stroke="#ff6b00" stroke-width="1.5"><path d="M3 3l5 12 2-5 5-2z"/></svg>`,
    type: `<svg viewBox="0 0 18 18" fill="none" stroke="#ff6b00" stroke-width="1.5"><rect x="2" y="4" width="14" height="10" rx="2"/><path d="M6 7h6M9 7v4"/></svg>`,
    execute_js: `<svg viewBox="0 0 18 18" fill="none" stroke="#ff6b00" stroke-width="1.5"><path d="M5 4l-3 5 3 5M13 4l3 5-3 5M7 14l4-10"/></svg>`,
    read_page: `<svg viewBox="0 0 18 18" fill="none" stroke="#ff6b00" stroke-width="1.5"><rect x="3" y="2" width="12" height="14" rx="2"/><path d="M6 5h6M6 8h6M6 11h4"/></svg>`,
    open_tab: `<svg viewBox="0 0 18 18" fill="none" stroke="#ff6b00" stroke-width="1.5"><rect x="2" y="3" width="14" height="12" rx="2"/><path d="M2 7h14"/><circle cx="5" cy="5" r="1" fill="#ff6b00"/><circle cx="8" cy="5" r="1" fill="#ff6b00"/></svg>`,
    close_tab: `<svg viewBox="0 0 18 18" fill="none" stroke="#ff6b00" stroke-width="1.5"><rect x="2" y="3" width="14" height="12" rx="2"/><path d="M2 7h14"/><path d="M7 10l4 4M11 10l-4 4" stroke="#f87171"/></svg>`,
    note: `<svg viewBox="0 0 18 18" fill="none" stroke="#ff6b00" stroke-width="1.5"><path d="M4 2h7l5 5v9a2 2 0 01-2 2H4a2 2 0 01-2-2V4a2 2 0 012-2z"/><path d="M11 2v5h5"/></svg>`,
    scroll: `<svg viewBox="0 0 18 18" fill="none" stroke="#ff6b00" stroke-width="1.5"><path d="M9 3v12M5 11l4 4 4-4M5 7l4-4 4 4"/></svg>`,
    finish: `<svg viewBox="0 0 18 18" fill="none" stroke="#4ade80" stroke-width="1.5"><circle cx="9" cy="9" r="7"/><path d="M6 9l2 2 4-4" stroke="#4ade80"/></svg>`,
    default: `<svg viewBox="0 0 18 18" fill="none" stroke="#ff6b00" stroke-width="1.5"><circle cx="9" cy="9" r="3"/><path d="M9 1v4M9 13v4M1 9h4M13 9h4"/></svg>`
  };

  function getIcon(actionType) {
    return ICONS[actionType] || ICONS.default;
  }

  function ensureStyle() {
    try {
      if (document.getElementById(HUD_STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = HUD_STYLE_ID;
      style.textContent = HUD_CSS;
      (document.head || document.documentElement).appendChild(style);
    } catch { /* non-fatal */ }
  }

  function ensureHUD() {
    try {
      let el = document.getElementById(HUD_ID);
      if (el && el.isConnected) return el;

      ensureStyle();
      el = document.createElement('div');
      el.id = HUD_ID;
      el.setAttribute('data-sentinel', 'action-hud');
      el.innerHTML = `
        <div class="hud-card">
          <div class="hud-header">
            <span class="hud-brand"><span class="hud-pulse"></span>SENTINEL</span>
            <span class="hud-step">Step <span class="step-num">${currentStep}</span>/${totalSteps}</span>
          </div>
          <div class="hud-progress-bar"><div class="hud-progress-fill" style="width: 0%"></div></div>
          <div class="hud-action">
            <div class="hud-action-icon">${ICONS.default}</div>
            <div class="hud-action-text">Initializing...</div>
          </div>
          <div class="hud-result"></div>
        </div>
      `;
      (document.documentElement || document.body).appendChild(el);

      // Show with animation
      requestAnimationFrame(() => {
        requestAnimationFrame(() => { el.classList.add('visible'); });
      });

      return el;
    } catch { return null; }
  }

  function updateHUD(opts) {
    try {
      const el = ensureHUD();
      if (!el) return;

      if (opts.step !== undefined) currentStep = opts.step;
      if (opts.totalSteps !== undefined) totalSteps = opts.totalSteps;
      if (opts.action) currentAction = opts.action;

      // Update step counter
      const stepEl = el.querySelector('.hud-step');
      if (stepEl) stepEl.innerHTML = `Step <span class="step-num">${currentStep}</span>/${totalSteps}`;

      // Update progress bar
      const fill = el.querySelector('.hud-progress-fill');
      if (fill) fill.style.width = `${Math.min(100, (currentStep / totalSteps) * 100)}%`;

      // Update action icon + text
      const iconEl = el.querySelector('.hud-action-icon');
      const textEl = el.querySelector('.hud-action-text');
      if (iconEl) iconEl.innerHTML = getIcon(currentAction);
      if (textEl && opts.actionLabel) textEl.textContent = opts.actionLabel;

      // Update result text
      const resultEl = el.querySelector('.hud-result');
      if (resultEl) {
        resultEl.className = 'hud-result';
        if (opts.result) {
          resultEl.textContent = (typeof opts.result === 'string' ? opts.result : String(opts.result)).substring(0, 80);
          if (opts.resultSuccess) resultEl.classList.add('success');
          if (opts.resultError) resultEl.classList.add('error');
        } else {
          resultEl.textContent = '';
        }
      }

      // Flash pulse on new action
      el.classList.remove('action-pulse');
      void el.offsetWidth; // reflow
      el.classList.add('action-pulse');
      clearTimeout(pulseTimer);
      pulseTimer = setTimeout(() => el.classList.remove('action-pulse'), 800);

      // Auto-hide after inactivity
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (currentAction === 'finish') {
          // Keep finish visible for 5s then fade; re-query el in case DOM changed
          setTimeout(() => {
            const hudEl = document.getElementById(HUD_ID);
            if (hudEl) hudEl.classList.remove('visible');
          }, 5000);
        } else {
          const hudEl = document.getElementById(HUD_ID);
          if (hudEl) hudEl.classList.remove('visible');
        }
      }, 15000);

      // Make visible
      el.classList.add('visible');
    } catch { /* non-fatal */ }
  }

  function hideHUD() {
    try {
      const el = document.getElementById(HUD_ID);
      if (el) el.classList.remove('visible');
    } catch { /* non-fatal */ }
  }

  // ── Public API ──
  window.__sentinelActionHUD = {
    update: updateHUD,
    hide: hideHUD,
    __initialized: true
  };
})();
