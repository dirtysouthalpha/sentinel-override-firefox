// popup-modules/telemetry-panel.js
// Live Telemetry Panel — v3.25.0
//
// Slide-up panel from the bottom of the side panel showing every internal
// event in real time. Solves the "black box" problem: when the agent
// appears stuck, the user opens this panel to see exactly what's happening.
//
// Subscribes to chrome.runtime telemetry_event messages emitted by
// background/telemetry.js. Each event: {ts, seq, category, level, message,
// payload}. Renders into a circular buffer (last 500 events in memory).
//
// Features:
//   - Filter chips: All / LLM / Skills / Platform / Memory / Page / Errors
//   - Free-text search
//   - Pause auto-scroll toggle
//   - Copy all + Clear all
//   - Per-event expand for full payload (JSON pretty-print)
//   - Verbosity selector mirrored from Settings (Quiet/Normal/Verbose/Debug)
//
// Rail button toggles the panel.

// Precompile regex for error level filtering
const ERROR_WARN_LEVEL_RE = /^(error|warn)$/;

(function setupTelemetryPanel() {
  const MAX_BUFFER = 500;
  const events = [];           // Circular buffer
  let activeFilter = 'all';    // 'all' | category id
  let searchQuery = '';
  let autoScroll = true;
  let panelOpen = false;
  let _searchDebounce = null;  // Search input debounce timer
  // (3.27.0) When non-null, the panel is displaying a persisted past run
  // instead of the live stream. Incoming telemetry_event messages are still
  // buffered (so toggling back to "Live" doesn't lose anything), but the
  // visible list is frozen on the loaded run's events.
  let _viewingPastRun = null;  // { runId, goal, startedAt, finishedAt, count }
  let _liveBuffer = null;      // While viewing a past run, the live stream is snapshotted here

  // --------- DOM Helpers ---------

  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  function _formatTs(ts) {
    if (!ts) return '--:--:--';
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${hh}:${mm}:${ss}.${ms}`;
  }

  function _categoryBadgeColor(cat) {
    return {
      llm:       '#7aa2f7',
      skill:     '#9ece6a',
      platform:  '#bb9af7',
      memory:    '#e0af68',
      cdp:       '#7dcfff',
      page:      '#73daca',
      sleep:     '#565f89',
      storage:   '#a9b1d6',
      network:   '#ff9e64',
      lifecycle: '#f7768e',
      error:     '#f44',
    }[cat] || '#888';
  }

  function _levelDotColor(level) {
    return {
      error: '#f44',
      warn:  '#e0af68',
      info:  '#7aa2f7',
      debug: '#a9b1d6',
      trace: '#565f89',
    }[level] || '#888';
  }

  // --------- Buffer + Rendering ---------

  function _addEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    // (3.27.0) While viewing a past run, the visible event list is frozen.
    // Route live events into _liveBuffer so they're available when the user
    // clicks "Back to Live" — no events are dropped on the floor.
    if (_viewingPastRun) {
      if (!Array.isArray(_liveBuffer)) _liveBuffer = [];
      _liveBuffer.push(ev);
      while (_liveBuffer.length > MAX_BUFFER) _liveBuffer.shift();
      return;
    }
    events.push(ev);
    while (events.length > MAX_BUFFER) events.shift();
    if (panelOpen) _renderIncremental(ev);
  }

  function _eventMatchesFilter(ev) {
    if (activeFilter === 'all') {
      // 'all' shows everything EXCEPT pure trace by default — too noisy.
      return ev.level !== 'trace';
    }
    if (activeFilter === 'errors') {
      return ERROR_WARN_LEVEL_RE.test(ev.level);
    }
    return ev.category === activeFilter;
  }

  function _eventMatchesSearch(ev) {
    if (!searchQuery) return true;
    const q = typeof searchQuery === 'string' ? searchQuery.toLowerCase() : '';
    if ((ev.message || '').toLowerCase().includes(q)) return true;
    if ((ev.category || '').toLowerCase().includes(q)) return true;
    if (ev.payload) {
      try {
        if (JSON.stringify(ev.payload).toLowerCase().includes(q)) return true;
      } catch { /* JSON parse failure is non-critical */ }
    }
    return false;
  }

  function _renderEvent(ev) {
    const div = document.createElement('div');
    div.className = 'telem-event';
    div.dataset.category = ev.category;
    div.dataset.level = ev.level;
    div.style.cssText = `display:flex; gap:6px; padding:3px 8px; border-bottom:1px solid rgba(255,255,255,0.04); font-size:11px; line-height:1.45; cursor:${ev.payload ? 'pointer' : 'default'};`;

    const ts = document.createElement('span');
    ts.style.cssText = 'color:var(--text-tertiary, #777); font-family:monospace; font-size:10px; flex-shrink:0; min-width:84px;';
    ts.textContent = _formatTs(ev.ts);
    div.appendChild(ts);

    const dot = document.createElement('span');
    dot.style.cssText = `flex-shrink:0; width:6px; height:6px; border-radius:50%; background:${_levelDotColor(ev.level)}; margin-top:6px;`;
    div.appendChild(dot);

    const badge = document.createElement('span');
    badge.style.cssText = `flex-shrink:0; padding:1px 5px; font-size:9px; font-weight:600; text-transform:uppercase; letter-spacing:0.5px; border-radius:3px; background:rgba(255,255,255,0.06); color:${_categoryBadgeColor(ev.category)};`;
    badge.textContent = ev.category;
    div.appendChild(badge);

    const msg = document.createElement('span');
    msg.style.cssText = 'flex:1; min-width:0; color:var(--text-primary, #fff); word-break:break-word;';
    msg.textContent = ev.message || '';
    div.appendChild(msg);

    if (ev.payload) {
      const expandable = document.createElement('pre');
      expandable.style.cssText = 'display:none; flex-basis:100%; margin:4px 0 4px 90px; padding:6px 8px; background:rgba(0,0,0,0.25); border-radius:3px; font-family:monospace; font-size:10px; line-height:1.4; color:var(--text-secondary, #aaa); white-space:pre-wrap; word-break:break-word; max-height:200px; overflow:auto;';
      try { expandable.textContent = JSON.stringify(ev.payload, null, 2); } catch { expandable.textContent = String(ev.payload); }
      div.appendChild(expandable);
      div.addEventListener('click', (e) => {
        if (e.target.tagName === 'PRE') return;
        expandable.style.display = expandable.style.display === 'none' ? 'block' : 'none';
      });
    }

    return div;
  }

  function _renderIncremental(ev) {
    if (!_eventMatchesFilter(ev) || !_eventMatchesSearch(ev)) return;
    const list = document.getElementById('telemList');
    if (!list) return;
    const node = _renderEvent(ev);
    list.appendChild(node);

    // Keep list size bounded in DOM (last 250 visible)
    while (list.childElementCount > 250) {
      list.firstElementChild.remove();
    }
    if (autoScroll) {
      list.scrollTop = list.scrollHeight;
    }
  }

  function _renderAll() {
    const list = document.getElementById('telemList');
    if (!list) return;
    list.innerHTML = '';
    const filtered = events.filter(e => _eventMatchesFilter(e) && _eventMatchesSearch(e));
    const slice = filtered.slice(-250);
    for (const ev of slice) {
      list.appendChild(_renderEvent(ev));
    }
    if (autoScroll) list.scrollTop = list.scrollHeight;
    _updateCountBadge();
  }

  function _updateCountBadge() {
    const badge = document.getElementById('telemCountBadge');
    if (!badge) return;
    const filtered = events.filter(e => _eventMatchesFilter(e) && _eventMatchesSearch(e));
    badge.textContent = `${filtered.length} / ${events.length}`;
  }

  // --------- Panel UI ---------

  function _buildPanel() {
    if (document.getElementById('telemetry-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'telemetry-panel';
    panel.style.cssText = [
      'position:fixed',
      'left:42px',                                  // Past the rail
      'right:0',
      'bottom:0',
      'height:40vh',
      'background:var(--bg-secondary, #161616)',
      'border-top:1px solid var(--accent-primary, #ff6b00)',
      'box-shadow:0 -4px 16px rgba(0,0,0,0.4)',
      'z-index:200',
      'display:none',
      'flex-direction:column',
      'transition:transform 180ms ease-out',
      'transform:translateY(0)',
    ].join(';');

    panel.innerHTML = `
      <!-- Header bar with filters + controls -->
      <div id="telemHeader" style="display:flex; align-items:center; gap:6px; padding:6px 10px; background:var(--bg-tertiary, #1f1f1f); border-bottom:1px solid var(--border-color, rgba(255,255,255,0.06)); flex-shrink:0;">
        <span style="font-size:11px; font-weight:600; letter-spacing:0.5px; color:var(--accent-primary, #ff6b00); text-transform:uppercase; flex-shrink:0;">Telemetry</span>
        <span id="telemCountBadge" style="font-size:10px; color:var(--text-tertiary, #777); flex-shrink:0;">0 / 0</span>
        <input type="text" id="telemSearch" placeholder="Search…" style="flex:1; min-width:60px; padding:3px 8px; font-size:11px; background:var(--bg-input, rgba(255,255,255,0.04)); border:1px solid var(--border-color, rgba(255,255,255,0.10)); border-radius:4px; color:var(--text-primary, #fff);">
        <button id="telemPauseBtn" title="Pause auto-scroll" style="flex-shrink:0; padding:3px 8px; font-size:10px; background:var(--bg-input); color:var(--text-secondary); border:1px solid var(--border-color); border-radius:4px; cursor:pointer;">⏸ Auto-scroll</button>
        <button id="telemCopyBtn" title="Copy filtered events to clipboard" style="flex-shrink:0; padding:3px 8px; font-size:10px; background:var(--bg-input); color:var(--text-secondary); border:1px solid var(--border-color); border-radius:4px; cursor:pointer;">Copy</button>
        <button id="telemExportBtn" title="Export filtered events as JSON" style="flex-shrink:0; padding:3px 8px; font-size:10px; background:var(--bg-input); color:var(--text-secondary); border:1px solid var(--border-color); border-radius:4px; cursor:pointer;">Export</button>
        <button id="telemPastRunsBtn" title="View past persisted runs" style="flex-shrink:0; padding:3px 8px; font-size:10px; background:var(--bg-input); color:var(--text-secondary); border:1px solid var(--border-color); border-radius:4px; cursor:pointer;">Past Runs ▾</button>
        <button id="telemClearBtn" title="Clear buffer" style="flex-shrink:0; padding:3px 8px; font-size:10px; background:var(--bg-input); color:var(--text-secondary); border:1px solid var(--border-color); border-radius:4px; cursor:pointer;">Clear</button>
        <button id="telemCloseBtn" title="Close panel" style="flex-shrink:0; padding:3px 8px; font-size:14px; background:transparent; color:var(--text-secondary); border:none; cursor:pointer; line-height:1;">×</button>
      </div>

      <!-- Filter chips -->
      <div id="telemFilters" style="display:flex; flex-wrap:wrap; gap:4px; padding:5px 10px; background:var(--bg-secondary); border-bottom:1px solid var(--border-color, rgba(255,255,255,0.06)); flex-shrink:0;">
      </div>

      <!-- Event list -->
      <div id="telemList" style="flex:1; overflow-y:auto; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding:4px 0;"></div>

      <!-- Footer / hint -->
      <div style="padding:4px 10px; font-size:10px; color:var(--text-tertiary, #777); background:var(--bg-tertiary, #1f1f1f); border-top:1px solid var(--border-color, rgba(255,255,255,0.06)); flex-shrink:0;">
        Click any row to expand payload. Verbosity set in Settings.
      </div>
    `;
    if (document.body) document.body.appendChild(panel);

    _buildFilterChips();
    _wirePanelControls();
  }

  function _buildFilterChips() {
    const filtersBar = document.getElementById('telemFilters');
    if (!filtersBar) return;
    const chips = [
      { id: 'all', label: 'All' },
      { id: 'errors', label: 'Errors+Warn' },
      { id: 'llm', label: 'LLM' },
      { id: 'skill', label: 'Skills' },
      { id: 'platform', label: 'Platform' },
      { id: 'memory', label: 'Memory' },
      { id: 'page', label: 'Page' },
      { id: 'lifecycle', label: 'Lifecycle' },
      { id: 'cdp', label: 'CDP' },
      { id: 'network', label: 'Network' },
      { id: 'storage', label: 'Storage' },
    ];
    filtersBar.innerHTML = chips.map(c =>
      `<button class="telem-chip" data-filter="${c.id}" style="padding:2px 8px; font-size:10px; background:${c.id === activeFilter ? 'var(--accent-primary, #ff6b00)' : 'var(--bg-input, rgba(255,255,255,0.04))'}; color:${c.id === activeFilter ? '#fff' : 'var(--text-secondary, #aaa)'}; border:1px solid ${c.id === activeFilter ? 'var(--accent-primary, #ff6b00)' : 'var(--border-color, rgba(255,255,255,0.10))'}; border-radius:10px; cursor:pointer;">${c.label}</button>`
    ).join('');
    const filterChips = filtersBar.querySelectorAll('.telem-chip');
    if (filterChips && typeof filterChips.forEach === 'function') {
      filterChips.forEach(btn => {
      btn.addEventListener('click', () => {
        activeFilter = btn.dataset.filter;
        _buildFilterChips();
        _renderAll();
      });
      });
    }
  }

  function _wirePanelControls() {
    const searchInput = document.getElementById('telemSearch');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        clearTimeout(_searchDebounce);
        _searchDebounce = setTimeout(() => {
          searchQuery = searchInput.value.trim();
          _renderAll();
        }, 150);
      });
    }
    const pauseBtn = document.getElementById('telemPauseBtn');
    if (pauseBtn) {
      pauseBtn.addEventListener('click', () => {
        autoScroll = !autoScroll;
        pauseBtn.textContent = autoScroll ? '⏸ Auto-scroll' : '▶ Auto-scroll';
        if (autoScroll) {
          const list = document.getElementById('telemList');
          if (list) list.scrollTop = list.scrollHeight;
        }
      });
    }
    const copyBtn = document.getElementById('telemCopyBtn');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        const filtered = events.filter(e => _eventMatchesFilter(e) && _eventMatchesSearch(e));
        let text;
        try {
          text = filtered.map(e =>
            `${_formatTs(e.ts)} [${e.level}/${e.category}] ${getErrorMessage(e)}` +
            (e.payload ? `  ${JSON.stringify(e.payload)}` : '')
          ).join('\n');
        } catch (stringifyErr) {
          console.warn('[Sentinel] Failed to stringify event payload:', getErrorMessage(stringifyErr));
          text = filtered.map(e =>
            `${_formatTs(e.ts)} [${e.level}/${e.category}] ${getErrorMessage(e)}` +
            '  [payload omitted - circular or non-serializable]'
          ).join('\n');
        }
        try {
          navigator.clipboard.writeText(text).then(() => {
            copyBtn.textContent = 'Copied!';
            setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
          }).catch((e) => { console.error('[Sentinel] Error in telemetry-panel.js:', getErrorMessage(e)); });
        } catch (clipboardErr) { console.warn('[Sentinel] clipboard API may be restricted:', getErrorMessage(clipboardErr)); }
      });
    }
    const clearBtn = document.getElementById('telemClearBtn');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        events.length = 0;
        const list = document.getElementById('telemList');
        if (list) list.innerHTML = '';
        _updateCountBadge();
      });
    }

    // (3.27.0) Export filtered events as a downloadable .json file.
    // Includes the in-memory buffer + filter state + a small metadata header
    // so the operator can hand the file to a teammate / paste into a bug
    // report without losing context.
    // (3.27.0) Export filtered events as a downloadable .json file.
    const exportBtn = document.getElementById('telemExportBtn');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => {
        try {
          const filtered = events.filter(e => _eventMatchesFilter(e) && _eventMatchesSearch(e));
          const payload = {
            schemaVersion: 1,
            exportedAt: new Date().toISOString(),
            filter: activeFilter,
            search: searchQuery || null,
            totalEvents: events.length,
            filteredEvents: filtered.length,
            viewingPastRun: _viewingPastRun || null,
            events: filtered
          };
          const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          a.href = url;
          a.download = `sentinel-telemetry-${ts}.json`;
          if (document.body) document.body.appendChild(a);
          a.click();
          setTimeout(() => {
            try { if (document.body) document.body.removeChild(a); URL.revokeObjectURL(url); } catch { /* DOM may be detached */ }
          }, 1500);
          exportBtn.textContent = 'Exported!';
          setTimeout(() => { exportBtn.textContent = 'Export'; }, 1200);
        } catch { /* download/export may fail in restricted context */ }
      });
    }

    const pastRunsBtn = document.getElementById('telemPastRunsBtn');
    if (pastRunsBtn) {
      pastRunsBtn.addEventListener('click', _togglePastRunsMenu);
    }

    const closeBtn = document.getElementById('telemCloseBtn');
    if (closeBtn) {
      closeBtn.addEventListener('click', togglePanel);
    }

    const list = document.getElementById('telemList');
    if (list) {
      list.addEventListener('scroll', () => {
        const nearBottom = (list.scrollHeight - list.scrollTop - list.clientHeight) < 40;
        if (!nearBottom && autoScroll) {
          autoScroll = false;
          const pauseBtn = document.getElementById('telemPauseBtn');
          if (pauseBtn) pauseBtn.textContent = '▶ Auto-scroll';
        } else if (nearBottom && !autoScroll) {
          autoScroll = true;
          const pauseBtn = document.getElementById('telemPauseBtn');
          if (pauseBtn) pauseBtn.textContent = '⏸ Auto-scroll';
        }
      });
    }
  }

  async function _togglePastRunsMenu() {
    const existing = document.getElementById('telemPastRunsMenu');
    if (existing) { existing.remove(); return; }
    let runs = [];
    try {
      runs = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'list_persisted_telemetry_runs' }, (response) => {
          if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) { resolve([]); return; }
          resolve(Array.isArray(response) ? response : []);
        });
      });
    } catch { /* message may fail if background not ready */ }
    const btn = document.getElementById('telemPastRunsBtn');
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.id = 'telemPastRunsMenu';
    menu.style.cssText = `position:fixed; top:${rect.bottom + 4}px; right:${window.innerWidth - rect.right}px; min-width:280px; max-width:420px; max-height:320px; overflow-y:auto; background:var(--bg-tertiary, #1f1f1f); border:1px solid var(--border-color, rgba(255,255,255,0.10)); border-radius:6px; box-shadow:0 4px 12px rgba(0,0,0,0.5); z-index:300; padding:4px 0;`;
    const liveItem = document.createElement('div');
    liveItem.style.cssText = `padding:6px 12px; font-size:11px; color:var(--text-primary, #fff); cursor:pointer; border-bottom:1px solid var(--border-color, rgba(255,255,255,0.06)); background:${_viewingPastRun ? 'transparent' : 'rgba(255,107,0,0.15)'};`;
    liveItem.innerHTML = `<strong>● Live stream</strong><div style="font-size:10px; color:var(--text-tertiary, #777); margin-top:2px;">${events.length} events in current buffer</div>`;
    liveItem.addEventListener('click', () => { _loadLiveStream(); menu.remove(); });
    menu.appendChild(liveItem);
    if (runs.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:10px 12px; font-size:11px; color:var(--text-tertiary, #777); font-style:italic;';
      empty.textContent = 'No persisted runs yet. Enable "Persist telemetry across sessions" in Settings to save runs.';
      menu.appendChild(empty);
    } else {
      for (const run of runs) {
        const item = document.createElement('div');
        item.style.cssText = 'padding:6px 12px; font-size:11px; color:var(--text-primary, #fff); cursor:pointer; border-bottom:1px solid var(--border-color, rgba(255,255,255,0.04)); display:flex; gap:8px; align-items:flex-start;';
        const isViewing = _viewingPastRun && _viewingPastRun.runId === run.runId;
        if (isViewing) item.style.background = 'rgba(255,107,0,0.15)';
        const startStr = run.startedAt ? new Date(run.startedAt).toLocaleString() : '(unknown)';
        const completed = run.finishedAt ? '✓' : '⋯';
        const goalSnip = (run.goal || '(no goal)').substring(0, 60);
        const main = document.createElement('div');
        main.style.cssText = 'flex:1; min-width:0;';
        main.innerHTML = `<strong>${completed} ${_esc(goalSnip)}${run.goal && run.goal.length > 60 ? '…' : ''}</strong><div style="font-size:10px; color:var(--text-tertiary, #777); margin-top:2px;">${startStr} · ${run.count || 0} events</div>`;
        item.appendChild(main);
        const delBtn = document.createElement('button');
        delBtn.textContent = '✕';
        delBtn.title = 'Delete this persisted run';
        delBtn.style.cssText = 'flex-shrink:0; padding:2px 6px; font-size:10px; background:transparent; color:var(--text-tertiary); border:none; cursor:pointer;';
        delBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            await new Promise((resolve) => {
              chrome.runtime.sendMessage({ action: 'delete_persisted_telemetry_run', runId: run.runId }, () => resolve());
            });
            if (_viewingPastRun && _viewingPastRun.runId === run.runId) _loadLiveStream();
            menu.remove();
            await _togglePastRunsMenu();
          } catch { /* message may fail if background not ready */ }
        });
        item.appendChild(delBtn);
        item.addEventListener('click', () => { _loadPastRun(run); menu.remove(); });
        menu.appendChild(item);
      }
    }
    if (document.body) document.body.appendChild(menu);
    const dismiss = (e) => {
      if (menu.contains(e.target) || (e.target && e.target.id === 'telemPastRunsBtn')) return;
      menu.remove();
      document.removeEventListener('mousedown', dismiss, true);
      document.removeEventListener('keydown', escDismiss, true);
    };
    const escDismiss = (e) => {
      if (e.key === 'Escape') { menu.remove(); document.removeEventListener('mousedown', dismiss, true); document.removeEventListener('keydown', escDismiss, true); }
    };
    setTimeout(() => {
      document.addEventListener('mousedown', dismiss, true);
      document.addEventListener('keydown', escDismiss, true);
    }, 0);
  }

  async function _loadPastRun(runMeta) {
    if (!runMeta || !runMeta.runId) return;
    try {
      const pastEvents = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'load_persisted_telemetry_run', runId: runMeta.runId }, (response) => {
          if (typeof chrome.runtime.lastError === 'object' && chrome.runtime.lastError !== null) { resolve([]); return; }
          resolve(Array.isArray(response) ? response : []);
        });
      });
      if (!_viewingPastRun) _liveBuffer = events.slice();
      _viewingPastRun = runMeta;
      events.length = 0;
      events.push(...pastEvents);
      _renderAll();
      _renderViewingBanner();
    } catch { /* loading past run may fail gracefully */ }
  }

  function _loadLiveStream() {
    if (!_viewingPastRun) return;
    events.length = 0;
    if (Array.isArray(_liveBuffer)) {
      events.push(..._liveBuffer);
    }
    _liveBuffer = null;
    _viewingPastRun = null;
    _renderAll();
    _renderViewingBanner();
  }

  function _renderViewingBanner() {
    const existing = document.getElementById('telemViewingBanner');
    if (existing) existing.remove();
    if (!_viewingPastRun) return;
    const list = document.getElementById('telemList');
    if (!list) return;
    const banner = document.createElement('div');
    banner.id = 'telemViewingBanner';
    banner.style.cssText = 'position:sticky; top:0; padding:6px 10px; background:rgba(255,107,0,0.18); border-bottom:1px solid var(--accent-primary, #ff6b00); font-size:11px; color:var(--text-primary, #fff); display:flex; justify-content:space-between; align-items:center; z-index:5;';
    const startStr = _viewingPastRun.startedAt ? new Date(_viewingPastRun.startedAt).toLocaleString() : '(unknown)';
    banner.innerHTML = `<span>Viewing past run · ${_esc((_viewingPastRun.goal || '(no goal)').substring(0, 60))} · ${startStr}</span><button id="telemBackToLive" style="padding:2px 8px; font-size:10px; background:var(--accent-primary, #ff6b00); color:#fff; border:none; border-radius:3px; cursor:pointer;">Back to Live</button>`;
    if (list.parentNode) list.parentNode.insertBefore(banner, list);
    const back = document.getElementById('telemBackToLive');
    if (back) back.addEventListener('click', _loadLiveStream);
  }

  function togglePanel() {
    _buildPanel();
    const panel = document.getElementById('telemetry-panel');
    if (!panel) return;
    panelOpen = panel.style.display === 'flex';
    if (panelOpen) {
      panel.style.display = 'none';
      panelOpen = false;
    } else {
      panel.style.display = 'flex';
      panelOpen = true;
      _renderAll();
    }
  }

  if (!window.__telemetryPanelListenerRegistered) {
    window.__telemetryPanelListenerRegistered = true;
    try {
      chrome.runtime.onMessage.addListener((message) => {
        if (message && message.action === 'telemetry_event') {
          _addEvent(message);
        }
      });
    } catch { /* message listener registration may fail */ }
  }

  function init() {
    const railBtn = document.getElementById('telemetryRailBtn');
    if (railBtn) railBtn.addEventListener('click', togglePanel);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Cleanup on popup unload
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('unload', () => {
    if (_searchDebounce) {
      clearTimeout(_searchDebounce);
      _searchDebounce = null;
    }
    });
  }

  try {
    window.__sentinelTelemetry = { toggle: togglePanel, eventCount: () => events.length };
  } catch { /* window assignment may fail in restricted context */ }
})();
