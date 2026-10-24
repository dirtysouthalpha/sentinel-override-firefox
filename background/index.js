// Sentinel Override v3 — Service Worker Entry Point
// Wires all modules together and handles message routing.

import { startAgent, stopAgent, agentRunning, isAgentAttachedTab, injectContext, applyCorrection, fetchAuditLog, auditLogToCsv, generateRunReplay, isAgentPaused } from './agent-engine.js';
import { wrapMessageHandler, sendSilentUpdate } from './message-protocol.js';
import { injectContentScript, sendMessageWithRetry, isValidUrl, detachAllDebuggees } from './tab-manager.js';
import { setSPATransitionPending, notifyIfEnabled, stopSwKeepalive } from './shared-state.js';
import { enumerateFrames, executeInFrame, resolveFrameForSelector, addFrameRouterListeners } from './frame-router.js';
import { getActiveTabId, handleTabRemoved } from './tab-context.js';
import { callLLMSimple } from './llm-client.js';
// (0.5) Run guard — single persisted source of truth for the kill switch,
// spend budget and rate limit. The credit handlers below delegate to it, so
// there is one ledger instead of two that can drift apart.
import { guardStore, guardStatus, GUARD_BLOCK, DEFAULT_LIMITS } from './run-guard.js';
import { listTemplates, getTemplate, saveTemplate, updateTemplate, deleteTemplate, resolveTemplateGoal } from './template-manager.js';
import { PROVIDER_CATALOG, getCatalogProvider, fetchModelsList } from './provider-registry.js';
import { createSchedule, listSchedules, deleteSchedule, toggleSchedule, executeScheduledTask, getScheduleResults, getRecentResults, clearScheduleResults, initScheduler } from './scheduler.js';
import { exportTemplate, exportAllTemplates, validateImport, importTemplates, exportReportAsMarkdown } from './collaboration.js';
// (3.26.0) Bridge for content-script telemetry — content/index.js cannot
// import telemetry.js directly (different context), so it posts a
// `content_telemetry_event` message and we re-emit via tel.emit() so the
// verbosity gate, console mirror, and panel broadcast all apply uniformly.
// (3.27.0) Also exposes Past Runs queries to the popup-side panel.
import { tel, listPersistedRuns, loadPersistedRun, deletePersistedRun } from './telemetry.js';
// (2.1) The same capability gate the run loop uses. External callers (popup,
// programmatic API, the Firefox compat layer) reach actions through this file,
// so the gate has to be applied here too — a message arriving on the runtime
// channel must not be a route around the loop's choke point.
import { checkCapability, loadGrantedCapabilities } from './capabilities.js';
import { validateAction } from './action-schema.js';
// Host access is optional now (see permission-gate.js): the panel queries it on
// open and offers the click that grants it.
import { ensureHostAccess, hasHostAccess, lastRefusal } from './permission-gate.js';

// (SO-87) Pending-goal fallback: a popup that dies mid-dispatch (sender-death
// during SW cold start silently eats the run_agent_loop message) still leaves
// the goal in storage. chrome.storage.onChanged is a registered MV3 wake
// event, so this top-level listener both wakes the SW and starts the run.
// Timestamp guard drops stale goals; the done flag makes delivery idempotent
// when both the message path and this fallback fire.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.pending_goal) return;
  const nv = changes.pending_goal.newValue;
  if (!nv || nv.done || (Date.now() - (nv.ts || 0)) > 120000) return;
  (async () => {
    try { await chrome.storage.local.set({ pending_goal: Object.assign({}, nv, { done: true }) }); } catch (e) {}
    if (agentRunning) return; // direct message path won the race — run underway
    console.log('[Sentinel/SW] pending_goal received (SO-87 fallback) — starting agent...');
    try {
      await startAgent(nv.goal, {});
    } catch (e) {
      console.error('[Sentinel/SW] pending_goal start failed:', e && e.message ? e.message : e);
    }
  })();
});
import { ONE_MINUTE_MS } from './constants.js';

// Precompute valid log levels for O(1) lookup
const VALID_LOG_LEVELS = new Set(['error', 'warn', 'info', 'debug', 'trace']);
// Precompute agent-starting actions for O(1) lookup
const AGENT_STARTING_ACTIONS = new Set(['analyze', 'extract', 'fill_form', 'screenshot', 'summarize']);
import { getErrorMessage } from './error-utils.js';
// (3.29.0) Skill outcome stats bridge — popup side reads/resets these.
import { listSkills, getSkillStats, resetSkillStats } from './skills/index.js';
import {
  listClients as ck_listClients,
  getClient as ck_getClient,
  getActiveClient as ck_getActiveClient,
  setActiveClient as ck_setActiveClient,
  createClient as ck_createClient,
  updateClient as ck_updateClient,
  deleteClient as ck_deleteClient,
  addEntry as ck_addEntry,
  updateEntry as ck_updateEntry,
  deleteEntry as ck_deleteEntry,
  exportClient as ck_exportClient,
  importClient as ck_importClient
} from './client-knowledge.js';
import { handleMenuClick } from './context-menu.js';
import { createMonitor, removeMonitor, toggleMonitor, loadMonitors, startMonitorLoop } from './page-monitor.js';
import { startRecording, stopRecording, isRecording, loadMacros } from './macro-recorder.js';
import { generateHtmlReport, generateReplayReport } from './export-report.js';
import * as pluginRegistry from './plugin-registry.js';

// v10.3.1: Startup diagnostics
console.log('[Sentinel/SW] Service worker starting...');
console.log('[Sentinel/SW] All imports resolved successfully');

// Service worker health heartbeat — confirms the SW event loop is alive
chrome.alarms.create('sw_heartbeat', { periodInMinutes: 0.5 });

// ========== One-time migration ==========
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['api_endpoint', 'model'], (result) => {
    if (chrome.runtime.lastError) { console.warn('[Sentinel] Migration get failed:', getErrorMessage(chrome.runtime.lastError)); return; }
    const updates = {};
    if (result.api_endpoint && typeof result.api_endpoint === 'string' && result.api_endpoint.includes('bigmodel.cn')) updates.api_endpoint = '';
    if (result.model && typeof result.model === 'string' && /glm-4(\.6v-flash|v-)/.test(result.model)) updates.model = '';
    if (Object.keys(updates).length) {
      chrome.storage.local.set(updates, () => {
        if (chrome.runtime.lastError) console.error('[Sentinel] Migration set failed:', getErrorMessage(chrome.runtime.lastError));
      });
    }
  });

  // (v3.44) Install context menus
  import('./context-menu.js').then(({ installContextMenus }) => {
    installContextMenus();
  }).catch(() => { /* context menus not critical */ });
});

// ========== Scheduler Initialization ==========
// Re-register alarms on service worker restart (handles browser restart alarm loss)
initScheduler();

// ========== Self-Healing: Auto-resume interrupted runs ==========
// On SW restart, check if an agent run was in progress and auto-resume it.
(async () => {
  try {
    const stored = await chrome.storage.session.get(['agentRunning', 'agentGoal', 'agentStartTime']);
    if (stored && stored.agentRunning && stored.agentGoal) {
      const age = Date.now() - (stored.agentStartTime || 0);
      // Only auto-resume if the run started less than 10 minutes ago
      if (age < 10 * 60 * 1000) {
        console.log('[Sentinel/self-heal] Detected interrupted run. Goal:', stored.agentGoal, 'Age:', `${Math.floor(age/1000)}s`);
        // Check for checkpoint with more state
        const cp = await chrome.storage.session.get('agent_checkpoint');
        if (cp && cp.agent_checkpoint && cp.agent_checkpoint.lastGoal) {
          console.log('[Sentinel/self-heal] Checkpoint found, resuming...');
          const { restoreFromCheckpoint, clearCheckpoint } = await import('./agent-engine.js');
          const result = await restoreFromCheckpoint();
          if (result.restored) {
            await clearCheckpoint();
            console.log('[Sentinel/self-heal] State restored, restarting agent loop');
            const { startAgent } = await import('./agent-engine.js');
            // Get any active tab to restart on
            const tabs = await new Promise(resolve => {
              chrome.tabs.query({active: true, currentWindow: true}, (t) => {
                if (chrome.runtime.lastError) {
                  console.warn('[Sentinel/index] tabs.query lastError:', getErrorMessage(chrome.runtime.lastError));
                  resolve([]);
                  return;
                }
                resolve(Array.isArray(t) ? t : []);
              });
            });
            if (tabs[0]?.id) {
              await startAgent(result.goal, { tab: tabs[0] });
            }
          }
        } else {
          // No checkpoint — clear stale session flags so next SW restart doesn't loop
          await chrome.storage.session.remove(['agentRunning', 'agentGoal', 'agentStartTime']);
        }
      } else {
        // Stale run — clear the flag
        console.log('[Sentinel/self-heal] Stale run detected (', Math.floor(age/ONE_MINUTE_MS), 'min old), clearing');
        await chrome.storage.session.remove(['agentRunning', 'agentGoal', 'agentStartTime']);
      }
    }
  } catch (e) {
    console.warn('[Sentinel/self-heal] Auto-resume check failed:', getErrorMessage(e));
  }
})();

// ========== Context Menu Click Handler (v3.44) ==========
chrome.contextMenus.onClicked.addListener((info, tab) => {
  const result = handleMenuClick(info, tab);
  if (!result) return;

  // Route each context menu action to the message handler
  const { action, params } = result;
  const message = { action: `context_menu_${action}`, params };

  // Direct invocation for agent-starting actions
  if (AGENT_STARTING_ACTIONS.has(action)) {
    chrome.runtime.sendMessage(message).catch(() => {});
  } else if (action === 'monitor_changes') {
    // Use selected text as selector hint, prompt via side panel
    chrome.runtime.sendMessage({
      action: 'context_menu_monitor_changes',
      params: {
        selector: params.selectionText ? `*:contains('${String(params.selectionText || '').substring(0, 50).replace(/'/g, "\\'")}')` : 'body',
        label: params.selectionText ? `Monitor: "${String(params.selectionText || '').substring(0, 30)}"` : 'Page Monitor',
        url: params.pageUrl,
      },
    }).catch(() => {});
  } else if (action === 'start_recording') {
    chrome.runtime.sendMessage({ action: 'context_menu_start_recording' })
      .then(() => {
        chrome.action.setBadgeText({ text: 'REC' });
        chrome.action.setBadgeBackgroundColor({ color: '#FF0000' });
      })
      .catch(() => {});
  } else if (action === 'run_macro') {
    // Open side panel with macro selection
    openPanelForTab(tab?.id);
    chrome.runtime.sendMessage({ action: 'macro_list' }).catch(() => {});
  } else if (action === 'export_report') {
    chrome.runtime.sendMessage({ action: 'export_html_report', params: {} })
      .then((resp) => {
        if (resp?.ok && resp.data?.html) {
          const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(resp.data.html)}`;
          chrome.downloads.download({
            url: dataUrl,
            filename: `sentinel-report-${Date.now()}.html`,
            saveAs: true,
          });
        }
      })
      .catch(() => {});
  } else if (action === 'quick_assist') {
    // (3.46.0) Quick Assist — open side panel and inject selected text as prompt
    openPanelForTab(tab?.id);
    // Send show_quick_assist to the content script so quick-assist.js shows the floating panel
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, {
        action: 'show_quick_assist',
        selectedText: params.selectionText || '',
        pageInfo: { url: params.pageUrl || '' },
      }).catch(() => {});
    }
  }
});

// ========== Page Monitor Loop (v3.44) ==========
try {
  startMonitorLoop();
} catch (_e) { /* page monitor not critical */ }

// ========== Frame Router Initialization ==========
// Subscribe to webNavigation events to keep the per-tab frame map fresh
// for cross-origin iframe routing.
addFrameRouterListeners();

// ========== Content Script Auto-Injection Fallback ==========
// Manifest content_scripts may fail to auto-inject on some Firefox versions.
// This fallback injects the bundle once the top-level document finishes
// loading. The __sentinelContentAlive ping makes it a no-op when the
// manifest already injected the bundle, so the two paths never double-run.
chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  if (!details.tabId || details.tabId < 0) return;
  const url = details.url || "";
  if (!url || url.startsWith("chrome://") || url.startsWith("moz-extension://") || url.startsWith("about:") || url.startsWith("devtools://")) return;
  try {
    // Same point-of-use gate as injectContentScript: this path calls
    // executeScript directly, so without it the first injection after install
    // would throw and the catch below would swallow it — a silent no-op that
    // leaves the tab un-driven with nothing in the log.
    const access = await ensureHostAccess({
      reason: `Sentinel Override needs host access to drive tab ${details.tabId}`
    });
    if (!access.granted) throw new Error(access.error || `Cannot access tab ${details.tabId}`);

    const alreadyAlive = await chrome.scripting.executeScript({
      target: { tabId: details.tabId },
      func: () => !!(window.__sentinelContentAlive === true)
    });
    if (alreadyAlive && alreadyAlive[0] && alreadyAlive[0].result === true) return;
    await chrome.scripting.executeScript({
      target: { tabId: details.tabId },
      files: ["content/dom-utils.js", "content/highlight.js", "content/wait-utils.js", "content/dropdown-utils.js", "content/special-inputs.js", "content/overlay-detector.js", "content/frame-manager.js", "content/shadow-dom.js", "content/action-hud.js", "content/cursor.js", "content/index.js", "content/warm-scan.js", "content/quick-assist.js"]
    });
  } catch (err) {
    // A missing tab really is not injectable and is expected; a refused host
    // permission is not, and must not vanish without a trace.
    if (err && /host access|host permission/i.test(String(err.message || ''))) {
      console.warn('[Sentinel] auto-injection blocked:', err.message);
    }
  }
}, { url: [{ schemes: ["http", "https"] }] });



// Schedule alarm listener + SW heartbeat
chrome.alarms.onAlarm.addListener(async (alarm) => {
  // v10.3.1: Heartbeat diagnostic
  if (alarm.name === 'sw_heartbeat') {
    console.log('[Sentinel/SW] Heartbeat — service worker alive');
    // (A1 fix 3) Watchdog tick: stalled runs get stopped, orphaned runs get
    // resumed or their stale flags cleared — not just on SW wake anymore.
    try {
      const { runWatchdogTick } = await import('./sw-watchdog.js');
      const verdict = await runWatchdogTick({
        isRunning: () => agentRunning,
        isPaused: () => isAgentPaused(),
        getSessionState: async () => { try { return await chrome.storage.session.get(['agentRunning', 'agentGoal', 'agentStartTime']); } catch (_e) { return null; } },
        getCheckpoint: async () => { try { const s2 = await chrome.storage.session.get('agent_checkpoint'); return (s2 && s2.agent_checkpoint) || null; } catch (_e) { return null; } },
        // (0.5) The kill switch outranks auto-resume: without this the watchdog
        // resurrected a run the operator had explicitly stopped on every SW
        // restart, because agentRunning is in-memory and a restart forgets.
        isKillEngaged: async () => {
          try {
            const v = await guardStore.check();
            return !!(v && v.blocked && v.code === GUARD_BLOCK.KILL_SWITCH);
          } catch (_e) { return false; }
        },
        now: () => Date.now(),
        stopAgent,
        startAgent,
        restoreFromCheckpoint: async () => (await import('./agent-engine.js')).restoreFromCheckpoint(),
        clearCheckpoint: async () => (await import('./agent-engine.js')).clearCheckpoint(),
        clearSessionFlags: async () => { try { await chrome.storage.session.remove(['agentRunning', 'agentGoal', 'agentStartTime']); } catch (e) { console.warn('[Sentinel/watchdog] flag clear failed:', getErrorMessage(e)); } },
        log: (lvl, msg, extra) => { const f = lvl === 'error' ? console.error : lvl === 'warn' ? console.warn : console.log; f(msg, extra || ''); }
      });
      if (verdict.action !== 'ok' && verdict.action !== 'idle') tel.info('lifecycle', 'SW watchdog action', verdict);
    } catch (e) { console.warn('[Sentinel/watchdog] tick failed:', getErrorMessage(e)); }
    return;
  }
  if (alarm.name.startsWith('schedule-')) {
    const scheduleId = alarm.name.replace('schedule-', '');
    try {
      await executeScheduledTask(scheduleId);
    } catch (err) {
      console.error('Scheduled task execution failed:', getErrorMessage(err));
    }
  }
});

// ========== Download Capture (3.9.0) ==========
// While an agent run is active, capture every download Chrome creates and
// surface it in the popup chat with the file path. Lets the agent's "Click
// Export → CSV" step actually deliver the file location to the user.
try {
  if (typeof chrome !== 'undefined' && chrome.downloads && chrome.downloads.onCreated) {
    chrome.downloads.onCreated.addListener((dl) => {
      try {
        if (!agentRunning) return;
        if (!dl || typeof dl !== 'object' || dl === null) return;
        chrome.runtime.sendMessage({
          action: 'download_captured',
          download: {
            id: dl.id,
            url: dl.url || '',
            filename: dl.filename || '',
            mime: dl.mime || '',
            startTime: dl.startTime || new Date().toISOString(),
            totalBytes: dl.totalBytes || 0
          }
        }).catch((e) => {
          console.error('[download_captured] Unhandled rejection:', getErrorMessage(e));
        });
      } catch (e) { console.warn('[Sentinel/index] download capture failed:', getErrorMessage(e)); }
    });
  }
} catch (e) { console.warn('[Sentinel/index] downloads API unavailable:', getErrorMessage(e)); }

// ========== Toolbar Icon: Attach Side Panel to Tab (SO-91) ==========
// Chrome no longer owns the icon click: openPanelOnActionClick would open the
// panel regardless of tab scoping. Our own onClicked handler makes the clicked
// tab the PRIMARY tab (panel enabled there, recorded in session storage)
// before opening — Claude in Chrome's attach model. Toggle-close comes from
// scoping: switching to any non-primary tab closes the panel.
try {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false })
    .catch((e) => console.warn('[Sentinel] setPanelBehavior failed:', getErrorMessage(e)));
} catch (_e) { /* non-fatal on older Chrome */ }

// (SO-91) Attach the panel to the clicked tab and record it as primary.
async function openPanelForTab(tabId) {
  if (typeof tabId !== 'number') return;
  try { await chrome.sidePanel.setOptions({ tabId, enabled: true, path: 'popup.html' }); } catch (_e) { /* non-fatal */ }
  try { await chrome.storage.session.set({ sentinelPrimaryTabId: tabId }); } catch (_e) { /* non-fatal */ }
  try { await chrome.sidePanel.open({ tabId }); } catch (_e) { /* user-gesture requirement etc. */ }
}

chrome.action.onClicked.addListener((tab) => {
  openPanelForTab(tab && tab.id).catch((e) => console.warn('[Sentinel] action click open failed:', getErrorMessage(e)));
});

// (v3.53) When user opens a new tab during agent run, immediately disable
// the side panel on it — only agent-attached tabs should show the panel.
chrome.tabs.onCreated.addListener((tab) => {
  if (agentRunning && tab.id) {
    chrome.sidePanel.setOptions({ tabId: tab.id, enabled: false, path: 'popup.html' }).catch(() => {});
  }
});


// ========== Unified Message Handler ==========
chrome.runtime.onMessage.addListener(wrapMessageHandler(async (request, sender) => {
  switch (request.action) {
    // Diagnostic ping — remove after startup bug is fixed
    case 'ping': {
      return { pong: true, ts: Date.now(), agentRunning: typeof agentRunning !== 'undefined' ? agentRunning : 'unknown' };
    }
    // Host-access state for the panel banner. The panel asks on open: if the
    // capability is missing, it offers the one click that can grant it, since
    // a service worker has no user gesture to raise the prompt with.
    case 'host_access_status': {
      const granted = await hasHostAccess();
      return { granted, error: granted ? null : lastRefusal() };
    }
    // Grant host access from the panel. Runs inside the click handler, which is
    // the user gesture Chrome requires — the background path cannot do this.
    case 'host_access_grant': {
      const res = await ensureHostAccess({ reason: 'Granted from the Sentinel Override panel' });
      return res;
    }
    // (SO-91) Diagnostic: per-tab side panel availability (enabled flags).
    case 'sp_panel_state': {
      const allTabs = await chrome.tabs.query({});
      const out = [];
      for (const t of allTabs) {
        if (!t.id) continue;
        try {
          const o = await chrome.sidePanel.getOptions({ tabId: t.id });
          out.push({ id: t.id, enabled: o.enabled, active: !!t.active });
        } catch (_e) {
          out.push({ id: t.id, err: String((_e && _e.message) || _e) });
        }
      }
      return { ok: true, tabs: out };
    }
    // (3.26.0) Content-script telemetry bridge. The content script can't
    // import telemetry.js (different execution context, no module access in
    // MAIN world), so it sends `content_telemetry_event` messages and we
    // re-emit through the same tel.emit() that background-side code uses.
    // This means: verbosity gating, console mirror, sequence numbering, and
    // panel broadcast all behave identically for content-side events.
    //
    // Request shape:
    //   { action: 'content_telemetry_event', category, level, message, payload }
    //
    // We auto-stamp `tabId` and `frameUrl` from the sender so the panel can
    // attribute events to the originating tab without the content script
    // having to look those up itself.
    case 'content_telemetry_event': {
      try {
        const cat = String(request.category || 'content');
        const lvl = VALID_LOG_LEVELS.has(request.level) ? request.level : 'info';
        const msg = String(request.message || '');
        const payload = (request.payload && typeof request.payload === 'object') ? { ...request.payload } : {};
        // Auto-stamp the sender info so panel rows show which tab fired.
        if (sender && sender.tab && typeof sender.tab.id === 'number') payload.tabId = sender.tab.id;
        if (sender && sender.url) payload.frameUrl = String(sender.url).substring(0, 200);
        tel[lvl](cat, msg, payload);
      } catch (_e) { /* never throw on telemetry */ }
      return { ok: true };
    }

    // (3.27.0) Telemetry-panel Past Runs bridge. The panel runs in the side
    // panel context and can't import telemetry.js directly — these handlers
    // expose the persistence read/delete API.
    case 'list_persisted_telemetry_runs': {
      try { return await listPersistedRuns(); } catch (_loadErr) { return []; }
    }
    case 'load_persisted_telemetry_run': {
      if (!request.runId) return [];
      try { return await loadPersistedRun(request.runId); } catch (_loadErr) { return []; }
    }
    case 'delete_persisted_telemetry_run': {
      if (!request.runId) return { ok: false, error: 'runId required' };
      try { await deletePersistedRun(request.runId); return { ok: true }; } catch (e) { console.error('[Sentinel] Error in index.js:', getErrorMessage(e)); return { ok: false, error: getErrorMessage(e) }; }
    }

    // (3.29.0) Skill outcome bridge. Settings UI reads via list_skills_with_stats
    // to render the per-skill success-rate table, then optionally resets via
    // reset_skill_stats. Both are popup-initiated, no side effects on the agent loop.
    case 'list_skills_with_stats': {
      try { return listSkills(); } catch (_listErr) { return []; }
    }
    case 'get_skill_stats': {
      try { return getSkillStats(); } catch (_statsErr) { return {}; }
    }
    case 'reset_skill_stats': {
      try { await resetSkillStats(); return { ok: true }; } catch (e) { console.error('[Sentinel] Error in index.js:', getErrorMessage(e)); return { ok: false, error: getErrorMessage(e) }; }
    }

    case 'get_provider_catalog': {
      // (3.10.0) Return the catalog so the popup can populate the dropdown.
      try {
        if (!Array.isArray(PROVIDER_CATALOG)) return [];
        return PROVIDER_CATALOG.map(p => ({
          id: p.id, label: p.label,
          endpoint: p.endpoint,
          modelsUrl: p.modelsUrl,
          defaultModel: p.defaultModel,
          auth: p.auth,
          docsUrl: p.docsUrl
        }));
      } catch (_mapErr) { return []; }
    }
    case 'fetch_provider_models': {
      // (3.10.0) Auto-detect models for the selected provider. Caller passes
      // { providerId, apiKey, customEndpoint } — uses customEndpoint as
      // the modelsUrl base for the 'custom' provider.
      try {
        const id = request.providerId;
        const apiKey = request.apiKey || '';
        let provider = getCatalogProvider(id);
        if (!provider) return { ok: false, error: `Unknown provider id: ${id}` };
        let modelsUrl = provider.modelsUrl;
        if (id === 'custom') {
          // For 'custom', derive modelsUrl from the user's endpoint URL.
          // Strip /chat/completions and append /models.
          const ep = request.customEndpoint || '';
          if (!ep) return { ok: false, error: 'Enter your custom endpoint URL first' };
          try {
            const u = new URL(ep);
            // Strip any /chat/completions or trailing path
            const base = `${u.protocol}//${u.host}${u.pathname.replace(/\/(chat\/completions|messages|completions)\/?$/i, '')}`;
            modelsUrl = `${base.replace(/\/$/, '')}/models`;
          } catch (e) {
            return { ok: false, error: `Could not parse custom endpoint: ${getErrorMessage(e)}` };
          }
        }
        const models = await fetchModelsList({ ...provider, modelsUrl }, apiKey);
        return { ok: true, models };
      } catch (e) {
        return { ok: false, error: getErrorMessage(e) };
      }
    }
    case 'record_credit_usage': {
      // (0.5) Delegate to the run guard. This used to maintain its own
      // credit_usage ledger in chrome.storage.local — a second counter that
      // could drift from the guard's, and one that nothing enforced.
      try {
        const costUsd = (Number(request.inputTokens) || 0) + (Number(request.outputTokens) || 0);
        const isFree = String(request.model || '').includes(':free');
        const r = await guardStore.charge({
          costUsd: isFree ? 0 : costUsd * 0.000003,
          calls: 1,
          tokens: costUsd
        });
        if (!r.ok) return { ok: false, error: r.error };
        return { ok: true };
      } catch (e) {
        return { ok: false, error: getErrorMessage(e) };
      }
    }
    case 'check_credit_limit': {
      // (0.5) Read the guard's verdict. Keeps the {allowed, usage, limit}
      // shape the popup already consumes; `allowed` is now a real gate rather
      // than the old fail-open advisory probe.
      try {
        const verdict = await guardStore.check();
        const status = verdict.status || guardStatus((await guardStore.load()), Date.now());
        const today = status.today;
        return {
          allowed: !verdict.blocked,
          blocked: verdict.blocked,
          code: verdict.code,
          reason: verdict.reason,
          usage: { tokens: status.spentTokens, cost: status.spentCostUsd, calls: status.spentCalls },
          limit: status.limits.dailyCostUsd,
          today
        };
      } catch (e) {
        // Fail closed here too: an unreadable guard must not read as "allowed".
        return { allowed: false, blocked: true, code: GUARD_BLOCK.STORAGE, error: getErrorMessage(e) };
      }
    }
    // ---- (0.5) Run guard controls -------------------------------------
    case 'guard_status': {
      try {
        const { verdict, state } = await guardStore.evaluate();
        return { ok: true, status: guardStatus(state, Date.now()), verdict };
      } catch (e) {
        return { ok: false, error: getErrorMessage(e) };
      }
    }
    case 'guard_engage_kill_switch': {
      try {
        const reason = typeof request.reason === 'string' && request.reason.trim()
          ? request.reason.trim().substring(0, 300)
          : 'Stopped by operator';
        const by = typeof request.by === 'string' ? request.by : 'operator';
        const r = await guardStore.engageKillSwitch(reason, by);
        // Also stop a run that is live right now — engaging the switch should
        // take effect immediately, not at the next step boundary.
        if (agentRunning) {
          try { stopAgent('kill switch engaged'); } catch (_e) { /* already stopping */ }
        }
        console.warn(`[Sentinel/guard] Kill switch ENGAGED by ${by}: ${reason}`);
        return { ok: r.ok, error: r.error, status: r.status };
      } catch (e) {
        return { ok: false, error: getErrorMessage(e) };
      }
    }
    case 'guard_clear_kill_switch': {
      try {
        const by = typeof request.by === 'string' ? request.by : 'operator';
        const r = await guardStore.clearKillSwitch(by);
        console.info(`[Sentinel/guard] Kill switch cleared by ${by}`);
        return { ok: r.ok, error: r.error, status: r.status };
      } catch (e) {
        return { ok: false, error: getErrorMessage(e) };
      }
    }
    case 'guard_set_limits': {
      try {
        const patch = {};
        for (const k of ['dailyCostUsd', 'dailyCalls', 'windowMs', 'maxCalls']) {
          if (request[k] !== undefined && request[k] !== null && Number.isFinite(Number(request[k]))) {
            patch[k] = Number(request[k]);
          }
        }
        if (!Object.keys(patch).length) return { ok: false, error: 'No valid limits supplied' };
        const r = await guardStore.setLimits(patch);
        return { ok: r.ok, error: r.error, status: r.status, limits: { ...DEFAULT_LIMITS, ...patch } };
      } catch (e) {
        return { ok: false, error: getErrorMessage(e) };
      }
    }
    case 'guard_reset': {
      try {
        const r = await guardStore.reset();
        return { ok: r.ok, error: r.error, status: r.status };
      } catch (e) {
        return { ok: false, error: getErrorMessage(e) };
      }
    }
    case 'check_resume_available': {
      // (3.9.0) Look for a recent checkpoint that suggests an interrupted run.
      try {
        const stored = await chrome.storage.session.get('agent_checkpoint');
        const cp = stored && stored.agent_checkpoint;
        if (!cp) return { available: false };
        const age = Date.now() - (cp.lastUpdate || 0);
        if (age > 60 * 60 * 1000) return { available: false };  // older than 1h, ignore
        if (agentRunning) return { available: false };          // already running
        return {
          available: true,
          goal: cp.lastGoal || '',
          stepCount: cp.stepCount || 0,
          ageSeconds: Math.floor(age / 1000)
        };
      } catch (_checkpointErr) {
        return { available: false };
      }
    }
    case 'resume_from_checkpoint': {
      // Full state restore: recover history, agentMemory, run settings,
      // trust counters, and tab contexts from the session checkpoint,
      // then start a new agent run that inherits the restored state.
      try {
        const { restoreFromCheckpoint, clearCheckpoint } = await import('./agent-engine.js');
        if (agentRunning) return { ok: false, error: 'Agent already running' };
        const result = await restoreFromCheckpoint();
        if (!result.restored) {
          return { ok: false, error: `Cannot resume: ${result.error || 'unknown'}` };
        }
        await clearCheckpoint();
        tel.info('lifecycle', 'Agent resuming from checkpoint', {
          stepCount: result.stepCount,
          historyLength: result.historyLength,
          memoryKeys: result.memoryKeys
        });
        console.log('[Sentinel/SW] resume_from_checkpoint — starting agent...');
        return await startAgent(result.goal, sender);
      } catch (e) {
        console.error('[Sentinel/SW] resume_from_checkpoint error:', e);
        return { ok: false, error: getErrorMessage(e) };
      }
    }
    case 'execute_js_approval_request': {
      // Content-side defence-in-depth approval gate for execute_js.
      // When the agent-engine hasn't pre-approved (cmd.approvalGranted),
      // the content script sends this message to get user confirmation
      // before running arbitrary JS in the page context.
      //
      // If approvalMode is off in settings, auto-approve immediately
      // (the static privileged-API guard in the content script still
      // blocks the most dangerous operations). If approvalMode is on,
      // fire a notification and wait for the user to respond.
      try {
        const stored = await chrome.storage.local.get(['approvalMode']);
        if (!stored.approvalMode) {
          // Approval mode off — auto-approve for non-privileged code.
          // Return reason:'auto' so the content script knows this wasn't
          // explicit user approval and keeps the runtime sandbox active.
          return { approved: true, reason: 'auto' };
        }

        // Approval mode on — present the code to the user via notification
        // and wait for response.
        const requestId = crypto.randomUUID();
        const codePreview = String(request.code || '').substring(0, 500);

        return await new Promise((resolve) => {
          const finish = (payload) => {
            resolve(payload);
          };

          // Broadcast to popup so the approval card renders
          chrome.runtime.sendMessage({
            action: 'request_approval',
            payload: {
              action: 'execute_js',
              description: `Run JS: ${codePreview}${request.key ? ` → "${request.key}"` : ''}`,
              stepNumber: 0,
              requestId,
              ariaLabel: null,
              elementText: null,
              selector: null,
              codePreview,
              sourceUrl: request.url || ''
            },
            requestId
          }).catch((_e) => {
            console.error('[finish] Unhandled rejection:', getErrorMessage(_e));
          });

          // Notify the user
          try {
            notifyIfEnabled(`exec_js_approval_${requestId}`, {
              type: 'basic',
              iconUrl: chrome.runtime.getURL('icon-48.png'),
              title: 'Sentinel Override — JS execution approval needed',
              message: `Code: ${codePreview.substring(0, 100)}...`
            });
          } catch (_e) { /* notification API may not be available */ }

          let hardRejectId = null;

          const listener = (message) => {
            if (message && typeof message === 'object' && message.action === 'approval_response' && message.requestId === requestId) {
              chrome.runtime.onMessage.removeListener(listener);
              clearTimeout(timeoutId);
              if (hardRejectId) clearTimeout(hardRejectId);
              finish({
                approved: !!message.approved,
                reason: message.approved ? 'user_approved' : 'user_rejected'
              });
            }
          };
          chrome.runtime.onMessage.addListener(listener);

          // Soft timeout: 60s — pause and notify
          const timeoutId = setTimeout(() => {
            chrome.runtime.onMessage.removeListener(listener);

            const replacementListener = (message) => {
              if (message && typeof message === 'object' && message.action === 'approval_response' && message.requestId === requestId) {
                if (hardRejectId) clearTimeout(hardRejectId);
                chrome.runtime.onMessage.removeListener(replacementListener);
                finish({
                  approved: !!message.approved,
                  reason: message.approved ? 'user_approved' : 'user_rejected'
                });
              }
            };

            // Hard-reject after 5 min total — must be defined after replacementListener
            hardRejectId = setTimeout(() => {
              chrome.runtime.onMessage.removeListener(replacementListener);
              finish({ approved: false, reason: 'approval_hard_timeout' });
            }, 240000);

            chrome.runtime.onMessage.addListener(replacementListener);
          }, ONE_MINUTE_MS);
        });
      } catch (e) {
        return { approved: false, reason: getErrorMessage(e) };
      }
    }

    case 'execute_command': {
      const activeTab = getActiveTabId();
      if (!activeTab) throw new Error('No agent tab specified');
      const tab = activeTab;
      const cmd = request.command;
      if (!cmd || typeof cmd !== 'object' || cmd === null) throw new Error('execute_command: missing or invalid command object');

      // (2.1) Dispatch boundary for external callers. Two checks, both
      // fail-closed, both in code rather than in the prompt:
      //   1. the action schema — unknown action types, unknown fields, wrong
      //      value types, and the reserved trust markers (approvalGranted,
      //      _visionIndex, and any `_`/`__`-prefixed field) are rejected
      //      outright rather than passed to the content script. This is the
      //      same validateAction() call Chrome makes. It is not itself an
      //      authorisation boundary — a schema-valid execute_js still has to
      //      clear the gate below — but it is what stops a model from forging
      //      the fields the gate reads as evidence of operator consent;
      //   2. the capability gate — a blue capability needs an operator grant,
      //      and a grant never comes from the message itself.
      const _schemaCheck = validateAction(cmd);
      if (!_schemaCheck.valid) {
        throw new Error(`execute_command: rejected — ${_schemaCheck.error}`);
      }
      const _grants = await loadGrantedCapabilities();
      const _capCheck = checkCapability(cmd, _grants, { currentTabId: tab });
      if (!_capCheck.allowed) {
        throw new Error(`execute_command: blocked — ${_capCheck.reason}`);
      }

      // Handle navigate inline (no content script needed)
      if (cmd.type === 'navigate') {
        if (!isValidUrl(cmd.url)) throw new Error('Invalid URL provided');
        await chrome.tabs.update(tab, { url: cmd.url });
        return `Navigated to ${cmd.url}`;
      }

      // All other commands: inject content script, send message
      await injectContentScript(tab);
      return await sendMessageWithRetry(tab, { action: 'execute_command', command: cmd });
    }

    case 'run_agent_loop': {
      // v10.3.1: Explicit error catch for startAgent — surfaces LLM/config errors
      try {
        console.log('[Sentinel/SW] run_agent_loop received — starting agent...');
        // v20.2.1: optional explicit tabId — lets API callers target a specific
        // tab instead of the sender's tab / active tab (programmatic runs).
        // v20.2.1 + A1 fix 2: explicit tabId passes through startAgent's gate,
        // which validates it is a real web page (the old synthetic sender had no
        // URL, so the SO-85 extension-page check never saw this path).
        const result = await startAgent(
          request.goal,
          sender,
          (request.tabId && typeof request.tabId === 'number') ? request.tabId : undefined
        );
        console.log('[Sentinel/SW] startAgent returned successfully');
        return result;
      } catch (agentErr) {
        // (SO-87) The pending_goal storage fallback can win the race against
        // this direct message path. 'Agent already running' here means the
        // run IS underway — success for the popup, not an error.
        if (agentErr && /already running/i.test(String(agentErr.message || ''))) {
          return { ok: true, alreadyRunning: true };
        }
        console.error('[Sentinel/SW] startAgent threw:', agentErr);
        throw agentErr; // re-throw so wrapMessageHandler sends error response
      }
    }

    case 'stop_agent_loop': {
      return stopAgent();
    }

    case 'pause_agent_loop': {
      const { pauseAgent } = await import('./agent-engine.js');
      return pauseAgent();
    }

    case 'resume_agent_loop': {
      const { resumeAgent } = await import('./agent-engine.js');
      return resumeAgent();
    }

    case 'undo_action': {
      const { undoLastAction } = await import('./agent-engine.js');
      return await undoLastAction();
    }

    case 'quick_assist_request': {
      const qaPrompt = typeof request.prompt === 'string' ? request.prompt.trim() : '';
      if (!qaPrompt) return { text: 'Error: empty prompt' };
      const qaSystem = 'You are Sentinel Quick Assist, an AI assistant for MSP technicians. Give clear, concise, actionable answers. Format your response with markdown where helpful.';
      try {
        const text = await callLLMSimple(qaSystem, qaPrompt, 1200);
        return { text };
      } catch (err) {
        return { text: `Error: ${getErrorMessage(err)}` };
      }
    }

    case 'inject_context': {
      if (!agentRunning) return { ok: false, error: 'No agent running' };
      const note = typeof request.note === 'string' ? request.note.trim() : '';
      if (!note) return { ok: false, error: 'Empty note' };
      injectContext(note);
      return { ok: true };
    }

    case 'agent_correction': {
      if (!agentRunning) return { ok: false, error: 'No agent running' };
      const correction = typeof request.correction === 'string' ? request.correction.trim() : '';
      if (!correction) return { ok: false, error: 'Empty correction' };
      const tabId = request.tabId || (sender.tab && sender.tab.id) || 0;
      applyCorrection(tabId, correction);
      return { ok: true };
    }

    case 'get_audit_log': {
      const log = await fetchAuditLog(request.runId || null);
      return { ok: true, log, csv: auditLogToCsv(log) };
    }

    // (3.14.1) Used by the sign-in wall banner's "Focus tab" button: switch
    // the active Chrome tab+window to the URL whose auth wall caused the pause.
    case 'focus_tab_by_url': {
      try {
        const target = String(request.url || '');
        if (!target) return { ok: false, error: 'focus_tab_by_url: missing url' };
        let targetHost;
        try { targetHost = new URL(target).host; } catch (_urlErr) { targetHost = ''; }
        const tabs = await chrome.tabs.query({});
        if (!tabs || !tabs.length) return { ok: false, error: 'no tabs available' };
        // Prefer exact URL match, fall back to host match (Microsoft sign-in
        // walks the user through multiple URLs on the same host).
        let match = tabs.find(t => t && t.url === target);
        if (!match && targetHost) {
          match = tabs.find(t => {
            try { return t && t.url && new URL(t.url).host === targetHost; } catch (_e) { return false; }
          });
        }
        if (!match) return { ok: false, error: 'no matching tab' };
        try { await chrome.tabs.update(match.id, { active: true }); } catch (_e) { /* tab may have closed */ }
        try { await chrome.windows.update(match.windowId, { focused: true }); } catch (_e) { /* window may have closed */ }
        return { ok: true, tabId: match.id };
      } catch (e) {
        return { ok: false, error: getErrorMessage(e) };
      }
    }

    case 'set_agent_speed': {
      const { setAgentSpeed } = await import('./agent-engine.js');
      return setAgentSpeed(request.mode);
    }

    // SPA messages from content script
    case 'spa_navigation':
    case 'spa_content_changed':
      // Only set flag if agent is running (ignore transitions when idle)
      if (agentRunning) {
        setSPATransitionPending();
      }
      return null;

    // Cross-origin iframe commands from content script
    case 'execute_in_frame': {
      const { frameIndex, command } = request;
      const tabId = getActiveTabId();
      if (tabId == null) {
        return { ok: false, error: 'execute_in_frame: no active agent tab' };
      }
      if (frameIndex == null || frameIndex < 0) {
        return { ok: false, error: `execute_in_frame: invalid frameIndex ${frameIndex}` };
      }
      const frameId = await resolveFrameForSelector(tabId, frameIndex);
      // frameId === 0 (main frame) is a legitimate value — only reject null/undefined.
      if (frameId == null) {
        return { ok: false, error: `execute_in_frame: frame ${frameIndex} not found in tab ${tabId}` };
      }
      if (!command || typeof command !== 'object' || command === null) {
        return { ok: false, error: 'execute_in_frame: missing or invalid command' };
      }
      // (2.1) This relay exists only for frames the content script could not
      // reach, so it is a cross-origin frame access by construction and needs
      // the operator's cross_origin_frame grant. The content script forwards the
      // command verbatim, so an approval the operator gave for this action in
      // the run loop is visible here as command.approvalGranted.
      const _frameGrants = await loadGrantedCapabilities();
      const _frameCheck = checkCapability({ type: 'execute_in_frame', approvalGranted: command.approvalGranted === true }, _frameGrants);
      if (!_frameCheck.allowed) {
        return { ok: false, error: `execute_in_frame: blocked — ${_frameCheck.reason}` };
      }
      return await executeInFrame(tabId, frameId, command);
    }

    case 'enumerate_frames': {
      return await enumerateFrames(getActiveTabId());
    }

    // Template CRUD
    case 'template_list':
      return await listTemplates();

    case 'template_get':
      if (!request.id) throw new Error('Template ID required');
      return await getTemplate(request.id);

    case 'template_save':
      if (!request.template) throw new Error('Template data required');
      return await saveTemplate(request.template);

    case 'template_update':
      if (!request.id) throw new Error('Template ID required');
      if (!request.updates) throw new Error('Update data required');
      return await updateTemplate(request.id, request.updates);

    case 'template_delete':
      if (!request.id) throw new Error('Template ID required');
      await deleteTemplate(request.id);
      return { deleted: true };

    case 'template_run': {
      if (!request.templateId) throw new Error('Template ID required');
      if (agentRunning) throw new Error('Agent already running');
      const goal = await resolveTemplateGoal(request.templateId, request.params || {});
      try {
        return await startAgent(goal, sender);
      } catch (agentErr) {
        console.error('[Sentinel/SW] template_run startAgent threw:', agentErr);
        throw agentErr;
      }
    }

    // ========== Client Knowledge (3.12.0+ -- 3.12.3 unwrap fix) ==========
    // wrapMessageHandler already wraps every return as { ok: true, data: <ret> }.
    // Earlier handlers double-wrapped with { ok: true, data: ... }, so the popup
    // saw { ok: true, data: { ok: true, data: <array> } } and list.map blew up.
    // Now: handlers return data directly, throw on error -- wrapper handles the rest.
    case 'client_list':
      return await ck_listClients();

    case 'client_get_active':
      return await ck_getActiveClient();

    case 'client_set_active': {
      const r = await ck_setActiveClient(request.id || null);
      if (!r.ok) throw new Error(r.error || 'Set active failed');
      return null;
    }

    case 'client_get':
      if (!request.id) throw new Error('Client ID required');
      return await ck_getClient(request.id);

    case 'client_create': {
      const r = await ck_createClient(request.client || {});
      if (!r.ok) throw new Error(r.error || 'Create failed');
      return r.client;
    }

    case 'client_update': {
      if (!request.id) throw new Error('Client ID required');
      const r = await ck_updateClient(request.id, request.updates || {});
      if (!r.ok) throw new Error(r.error || 'Update failed');
      return r.client;
    }

    case 'client_delete': {
      if (!request.id) throw new Error('Client ID required');
      const r = await ck_deleteClient(request.id);
      if (!r.ok) throw new Error(r.error || 'Delete failed');
      return null;
    }

    case 'client_entry_add': {
      if (!request.clientId) throw new Error('Client ID required');
      const r = await ck_addEntry(request.clientId, request.entry || {});
      if (!r.ok) throw new Error(r.error || 'Add entry failed');
      return r.entry;
    }

    case 'client_entry_update': {
      if (!request.clientId || !request.entryId) throw new Error('Client + entry IDs required');
      const r = await ck_updateEntry(request.clientId, request.entryId, request.updates || {});
      if (!r.ok) throw new Error(r.error || 'Update entry failed');
      return r.entry;
    }

    case 'client_entry_delete': {
      if (!request.clientId || !request.entryId) throw new Error('Client + entry IDs required');
      const r = await ck_deleteEntry(request.clientId, request.entryId);
      if (!r.ok) throw new Error(r.error || 'Delete entry failed');
      return null;
    }

    case 'client_export':
      if (!request.id) throw new Error('Client ID required');
      return await ck_exportClient(request.id);

    case 'client_import': {
      if (!request.payload) throw new Error('Import payload required');
      const r = await ck_importClient(request.payload, { rename: request.rename });
      if (!r.ok) throw new Error(r.error || 'Import failed');
      return r.client;
    }

    // Schedule CRUD
    case 'schedule_list':
      return await listSchedules();

    case 'schedule_create':
      if (!request.schedule) throw new Error('Schedule data required');
      return await createSchedule(request.schedule);

    case 'schedule_delete':
      if (!request.id) throw new Error('Schedule ID required');
      await deleteSchedule(request.id);
      return { deleted: true };

    case 'schedule_toggle':
      if (!request.id) throw new Error('Schedule ID required');
      if (typeof request.enabled !== 'boolean') throw new Error('Enabled flag required');
      return await toggleSchedule(request.id, request.enabled);

    case 'schedule_results':
      if (request.id) return await getScheduleResults(request.id);
      return await getRecentResults(request.limit || 20);

    case 'schedule_clear_results':
      if (!request.id) throw new Error('Schedule ID required');
      await clearScheduleResults(request.id);
      return { cleared: true };

    case 'schedule_clear_badge':
      { const _p = chrome.action.setBadgeText({ text: '' }); if (typeof _p?.catch === 'function') _p.catch((e) => {
        console.error('[_p] Unhandled rejection:', getErrorMessage(e));
      }); }
      return { cleared: true };

    // Collaboration: export/import
    case 'collab_export_template':
      if (!request.id) throw new Error('Template ID required');
      return await exportTemplate(request.id);

    case 'collab_export_all_templates':
      return await exportAllTemplates();

    case 'collab_validate_import':
      if (!request.data) throw new Error('Import data required');
      return validateImport(request.data);

    case 'collab_import_templates':
      if (!request.templates || !Array.isArray(request.templates)) throw new Error('Templates array required');
      return await importTemplates(request.templates, request.conflictMode || 'skip');

    case 'collab_export_report':
      if (!request.report) throw new Error('Report data required');
      return exportReportAsMarkdown(request.report);

    // Fire-and-forget messages from content script — acknowledge silently
    case 'content_script_ready':
      return null;

    // ========== Voice Input Message Forwarding (Bug #3 fix) ==========
    // Content scripts send voice messages via chrome.runtime.sendMessage;
    // we forward them to the popup so the voice input UI can update.
    case 'voice_result':
    case 'voice_interim':
    case 'voice_error':
      // Forward to popup - chrome.runtime.sendMessage broadcasts to all contexts
      chrome.runtime.sendMessage(request).catch(() => {
        // Popup might not be open, that's fine
      });
      return null;

    // ========== Context Menu Actions (v3.44) ==========
    case 'context_menu_analyze':
    case 'context_menu_extract':
    case 'context_menu_fill_form':
    case 'context_menu_screenshot':
    case 'context_menu_summarize': {
      if (agentRunning) throw new Error('Agent already running');
      const goalMap = {
        context_menu_analyze: (p) => `Analyze this page and ${p.selectionText ? `the selected text "${p.selectionText}"` : p.linkUrl ? `the link ${p.linkUrl}` : 'the current page content'}. Provide a detailed analysis.`,
        context_menu_extract: (p) => p.selectionText ? `Extract all structured data from this text: "${p.selectionText}". Return as JSON.` : 'Extract all structured data visible on the current page. Return as JSON.',
        context_menu_fill_form: () => 'Look at the current page and fill in any forms with appropriate test data.',
        context_menu_screenshot: () => 'Take a full page screenshot of the current page.',
        context_menu_summarize: () => 'Summarize the current page content concisely.',
      };
      const goal = goalMap[request.action](request.params || {});
      try {
        return await startAgent(goal, sender);
      } catch (agentErr) {
        console.error(`[Sentinel/SW] context_menu startAgent (${request.action}) threw:`, agentErr);
        throw agentErr;
      }
    }

    case 'context_menu_monitor_changes': {
      const { selector, label, url } = request.params || {};
      const mon = await createMonitor(url || '', selector || 'body', label || 'Page Monitor');
      return { monitor: mon };
    }

    case 'context_menu_start_recording': {
      if (isRecording()) throw new Error('Already recording');
      startRecording();
      return { recording: true };
    }

    case 'context_menu_stop_recording': {
      if (!isRecording()) throw new Error('Not recording');
      const macro = await stopRecording(request.params?.name || 'Recorded Macro');
      if (!macro) throw new Error('No steps recorded — nothing to save');
      return { macro };
    }

    case 'monitor_list':
      return await loadMonitors();

    case 'monitor_create': {
      const mon = await createMonitor(
        request.params?.url || '',
        request.params?.selector || 'body',
        request.params?.label || 'Page Monitor',
        request.params?.interval || 30
      );
      return { monitor: mon };
    }

    case 'monitor_remove': {
      if (!request.params?.id) throw new Error('Monitor ID required');
      await removeMonitor(request.params.id);
      return { removed: true };
    }

    case 'monitor_toggle': {
      if (!request.params?.id) throw new Error('Monitor ID required');
      if (typeof request.params?.active !== 'boolean') throw new Error('Active flag required');
      await toggleMonitor(request.params.id, request.params.active);
      return { toggled: true };
    }

    case 'macro_list':
      return await loadMacros();

    case 'macro_stop_recording': {
      if (!isRecording()) throw new Error('Not recording');
      const macro = await stopRecording(request.params?.name || 'Recorded Macro');
      if (!macro) throw new Error('No steps recorded — nothing to save');
      return { macro };
    }

    case 'export_html_report': {
      const log = await fetchAuditLog(request.params?.runId || null);
      if (!log || !log.length) throw new Error('No audit log data to export');
      const html = generateHtmlReport(log, request.params?.metadata || {});
      return { html };
    }

    case 'export_replay_report': {
      const { runLogId: reqRunId, estimatedCostUsd } = request.params || {};
      let runId = reqRunId;
      if (!runId) {
        try {
          const r = await chrome.storage.local.get('run_log_index');
          const idxAll = (r.run_log_index || []);
          // (SO-89) Prefer the newest COMPLETED run: a crashed steps-0 run
          // would export an empty replay report.
          const idxDone = idxAll.filter((e) => e && e.completed);
          runId = (idxDone[0] || idxAll[0] || {}).runLogId ?? null;
        } catch (_) { runId = null; }
      }
      if (!runId) throw new Error('No run log available to export');
      let logData;
      try {
        const r = await chrome.storage.local.get(`run_log_${runId}`);
        logData = r[`run_log_${runId}`];
      } catch (_) { logData = null; }
      if (!logData || !logData.entries) throw new Error('Run log data not found');
      const html = generateReplayReport(logData.entries, { goal: logData.goal, runLogId: runId, estimatedCostUsd: estimatedCostUsd || 0 });
      return { html };
    }

    // Run replay export: generates HTML from in-memory step recording.
    case 'export_replay': {
      const html = generateRunReplay();
      return { html };
    }

    // ========== Plugin System (PLG-06) ==========
    case 'plugin_list': {
      const plugins = await pluginRegistry.getInstalledPlugins();
      return { ok: true, plugins };
    }
    case 'plugin_get_registry_url': {
      const url = await pluginRegistry.getRegistryUrl();
      return { ok: true, url };
    }
    case 'plugin_set_registry_url': {
      await pluginRegistry.setRegistryUrl(request.url);
      return { ok: true };
    }
    case 'plugin_install': {
      try {
        const id = await pluginRegistry.installPlugin(request.manifestUrl);
        return { ok: true, pluginId: id };
      } catch (e) {
        return { ok: false, error: getErrorMessage(e) };
      }
    }
    case 'plugin_uninstall': {
      await pluginRegistry.uninstallPlugin(request.pluginId);
      return { ok: true };
    }
    case 'plugin_toggle': {
      const active = await pluginRegistry.togglePlugin(request.pluginId);
      return { ok: true, active };
    }

    default:
      throw new Error(`Unknown action: ${request.action}`);
  }
}));

// ========== Tab Event Listeners ==========

// SSO / OAuth popup detection: when a new window opens during an agent run
// and its first tab matches a known auth host, bring it to focus and notify
// the technician so they can complete sign-in without hunting for the window.
const _SSO_HOSTS_RE = /(login\.microsoftonline\.com|login\.live\.com|login\.microsoft\.com|accounts\.google\.com|login\.okta\.com|[^.]+\.okta\.com|auth0\.com|[^.]+\.auth0\.com|signin\.aws\.amazon\.com|login\.duosecurity\.com)/i;
chrome.windows.onCreated.addListener(async (win) => {
  if (!agentRunning) return;
  try {
    const tabs = await chrome.tabs.query({ windowId: win.id });
    if (!Array.isArray(tabs) || !tabs.length) return;
    const ssoTab = tabs.find(t => t.url && _SSO_HOSTS_RE.test(t.url));
    if (ssoTab) {
      await chrome.windows.update(win.id, { focused: true });
      let hostname = 'unknown host';
      try { hostname = new URL(ssoTab.url).hostname; } catch (_e) { /* URL parse failed */ }
      sendSilentUpdate(`🔐 SSO popup detected (${hostname}) — sign in, then the agent will continue automatically`);
    }
  } catch (e) { console.warn('[Sentinel/index] SSO popup detection failed:', getErrorMessage(e)); }
});

// Detect externally-closed tabs and clean up context
chrome.tabs.onRemoved.addListener((tabId) => {
  handleTabRemoved(tabId);
});

// Track user tab switches for popup UI awareness AND side-panel visibility.
// Do NOT change the agent's active tab when the user switches.
// Per CONTEXT.md decision: agent ignores user's manual tab switches.
//
// (3.7.2) When an agent run is in progress, hide the side panel on tabs that
// are NOT in the Sentinel attached-group, and show it on tabs that ARE.
// This mirrors Claude in Chrome's "panel only follows the agent's tabs"
// behavior. When no agent is running, every tab gets the panel.
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (!activeInfo || typeof activeInfo.tabId !== 'number') return;
  try {
    if (agentRunning) {
      const attached = isAgentAttachedTab(activeInfo.tabId);
      await chrome.sidePanel.setOptions({
        tabId: activeInfo.tabId,
        enabled: attached,
        path: 'popup.html'
      });
    } else {
      // (SO-91) No run in progress — the panel stays scoped to the primary
      // tab. Activating any other tab disables the panel there, which is
      // what makes Chrome close it when the user switches away.
      let primary = null;
      try { primary = (await chrome.storage.session.get('sentinelPrimaryTabId')).sentinelPrimaryTabId ?? null; } catch (_e) { /* unavailable */ }
      await chrome.sidePanel.setOptions({
        tabId: activeInfo.tabId,
        enabled: activeInfo.tabId === primary,
        path: 'popup.html'
      });
    }
  } catch (e) { console.warn('[Sentinel/index] sidePanel configuration failed:', getErrorMessage(e)); }
});

// ========== Keyboard Shortcut Commands ==========
chrome.commands.onCommand.addListener(async (command) => {
  try {
    switch (command) {
      case 'toggle-agent': {
        if (agentRunning) {
          await stopAgent();
          notifyIfEnabled({ type: 'basic', iconUrl: chrome.runtime.getURL('icon-48.png'), title: 'Sentinel Override', message: 'Agent stopped' });
        }
        // Start requires a goal — open the side panel instead.
        // sidePanel.open() needs a tabId or windowId; query active tab first.
        else {
          try {
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (activeTab && typeof activeTab.id === 'number') {
              await chrome.sidePanel.open({ tabId: activeTab.id }).catch((e) => {
                console.error('[attached] Unhandled rejection:', getErrorMessage(e));
              });
            }
          } catch (_e) { /* no active tab — silently ignore */ }
        }
        break;
      }
      case 'pause-agent': {
        if (agentRunning) {
          const { pauseAgent } = await import('./agent-engine.js');
          // Simple toggle: pause if running, resume if paused (agentPaused read from module scope won't work)
          // Instead, just send both and let the engine decide
          await pauseAgent(); // Will set agentPaused = true
        }
        break;
      }
      case 'turbo-mode': {
        const { setAgentSpeed } = await import('./agent-engine.js');
        setAgentSpeed('turbo');
        notifyIfEnabled({ type: 'basic', iconUrl: chrome.runtime.getURL('icon-48.png'), title: 'Sentinel Override', message: '🚀 Turbo mode' });
        break;
      }
      case 'normal-mode': {
        const { setAgentSpeed } = await import('./agent-engine.js');
        setAgentSpeed('normal');
        notifyIfEnabled({ type: 'basic', iconUrl: chrome.runtime.getURL('icon-48.png'), title: 'Sentinel Override', message: '👤 Normal mode' });
        break;
      }
      case 'stealth-mode': {
        const { setAgentSpeed } = await import('./agent-engine.js');
        setAgentSpeed('stealth');
        notifyIfEnabled({ type: 'basic', iconUrl: chrome.runtime.getURL('icon-48.png'), title: 'Sentinel Override', message: '🥷 Stealth mode' });
        break;
      }
    }
  } catch (e) { console.warn('Command handler error:', getErrorMessage(e)); }
});

// ========== Service Worker Suspend Cleanup ==========
// Chrome suspends the service worker when idle to save resources.
// Clean up resources to prevent memory leaks and dangling connections.
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onSuspend) {
  chrome.runtime.onSuspend.addListener(() => {
    // Detach all debugger connections to prevent port conflicts
    try {
      detachAllDebuggees().catch((e) => {
        console.warn('[Sentinel] Failed to detach debuggees on suspend:', getErrorMessage(e));
      });
    } catch (e) {
      console.warn('[Sentinel] Error detaching debuggees on suspend:', getErrorMessage(e));
    }

    // Stop all keepalive intervals
    try {
      stopSwKeepalive('default');
      stopSwKeepalive('agent-loop');
    } catch (e) {
      console.warn('[Sentinel] Error stopping keepalive on suspend:', getErrorMessage(e));
    }
  });
}

