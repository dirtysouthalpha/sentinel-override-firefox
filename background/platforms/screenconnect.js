// background/platforms/screenconnect.js
// ConnectWise ScreenConnect (Control) — v3.37.0
//
// Covers the hosted cloud instance (instance.screenconnect.com) and on-premise
// deployments (any host with /Host#Access, /Host#Support, /Backstage paths).
// The web UI is a SPA built on Kendo UI. The command runner tab is accessed
// via the "Toolbox" tab inside an active session window.

// Precompile regex patterns for hot-path detection
const _SC_HOST_RE = /screenconnect\.com|connectwisecontrol\.com/i;
const _SC_PATH_RE = /\/Host#Access|\/Host#Support|\/Backstage|\/Host#Join/i;
const _SC_GOAL_RE = /\b(?:screenconnect|control\.connectwise|sc\.local|schost)\b/i;

export const screenconnect = {
  id: 'screenconnect',
  label: 'ConnectWise ScreenConnect (Control)',
  memoryKeyPrefix: 'screenconnect_',

  detect(url, goal) {
    if (!url && !goal) return false;
    if (url) try {
      const u = new URL(url);
      const host = u.hostname;
      if (_SC_HOST_RE.test(host)) return true;
      if (_SC_PATH_RE.test(u.href)) return true;
    } catch (_e) { /* fall through */ }
    return _SC_GOAL_RE.test(String(goal || ''));
  },

  pageTypes: [
    { name: 'sc-dashboard',   urlMatch: /\/Host#Access|\/Host$/i,            hint: 'ScreenConnect Access page. Lists all managed machines. Search box at top-right.' },
    { name: 'sc-support',     urlMatch: /\/Host#Support/i,                   hint: 'ScreenConnect Support queue. Active and waiting sessions.' },
    { name: 'sc-session',     urlMatch: /\/Backstage|Session\.aspx/i,         hint: 'Active session window. Toolbox tab provides command runner.' },
    { name: 'sc-admin',       urlMatch: /\/Administration/i,                  hint: 'ScreenConnect Admin panel. User roles, security, extensions.' },
    { name: 'sc-reports',     urlMatch: /\/Report/i,                          hint: 'ScreenConnect Reports.' },
  ],

  knownSelectors: {
    // Dashboard / machine list
    searchBox:             'input.filter-input, input[placeholder*="Filter" i], input[placeholder*="Search" i]',
    machineRow:            'tr.session-row, [data-session-id], .session-entry',
    connectBtn:            'a[title*="Join" i], button[title*="Connect" i], .join-session-link',
    machineNameCell:       'td.name-cell, [data-column="Name"], .session-name',

    // Session window (Backstage)
    toolboxTab:            '[data-tab="Toolbox"], .tab-label:has-text("Toolbox")',
    commandTypeSelect:     'select[name="commandType"], .command-type-select, #commandType',
    commandInput:          'textarea[name="command"], #commandInput, .command-input textarea',
    commandRunBtn:         'button[type="submit"]:has-text("Run"), input[value="Run"], .run-command-btn',
    commandOutput:         '#commandOutput, .command-output, pre.output',
    commandOutputLoading:  '.running-indicator, .spinner, [class*="loading"]',
  },

  commandInterface: {
    // Selectors for run_remote_command dispatch
    inputSelector:      'textarea[name="command"], #commandInput, .command-input textarea',
    typeSelect:         'select[name="commandType"], .command-type-select',
    submitSelector:     'button[type="submit"]:has-text("Run"), input[value="Run"], .run-command-btn',
    outputSelector:     '#commandOutput, .command-output, pre.output',
    outputReadyText:    null,            // No stable "done" text; rely on timeout
    outputTimeoutMs:    15000,
    commandTypes: {
      powershell: 'PowerShell',
      cmd:        'Command',
      bash:       'Shell',
    },
  },

  waitStrings: {
    sessionReady:    ['Connected'],
    commandComplete: [],
  },

  commitFlow: [],
  sessionExpiredText: 'Session has expired',

  knownGotchas: [
    'ScreenConnect sessions open in a new tab or popup window — switch tabs after clicking Connect.',
    'To run a command: navigate to the active session, click the Toolbox tab, select the command type, enter the command, and click Run.',
    'The command output appears in the output pane below the input. Allow up to 15 seconds for results.',
    'Machine names in the access list are in the "Name" column. Use the search box to filter by name, IP, or tag.',
    'commandComplete wait string is null because ScreenConnect has no stable "done" text — rely on timeout instead.',
  ],

  liveDataCaveats:
    'ScreenConnect is a Kendo UI SPA. Session state (connected/disconnected) is reflected in the session list icons, not in a status text element. The Toolbox command runner has no structured completion signal — wait for output pane to stop updating or use timeout.',

  workflowHints: [
    {
      match: /connect.*device|remote.*session|open.*session|start.*session|remote.*into/i,
      hint: 'Phase 1: In the Access tab, search for the target machine by name or IP using the search box. Wait for the results to filter. Phase 2: Click the machine row to open session options, then click Connect (or the play/connect icon). The session opens in a new tab or popup — wait for the remote desktop to render. Phase 3: Confirm the connection is live (look for the desktop or login screen).',
    },
    {
      match: /run.*command|execute.*command|remote.*command|run.*script|powershell|cmd.*prompt/i,
      hint: 'Phase 1: Connect to the target machine (search by name, click Connect). Phase 2: Once in the session, click the Toolbox tab (wrench icon). Phase 3: Select the command type (CMD or PowerShell). Type the command in the input field. Click Run. Phase 4: Wait up to 15 seconds for the output pane to populate. Read the output from the pane below the input. Save to memory key screenconnect_cmd_output.',
    },
    {
      match: /transfer.*file|upload.*file|file.*transfer|send.*file/i,
      hint: 'Phase 1: Connect to the target machine session. Phase 2: Click the Files tab (folder icon) in the session toolbar. Phase 3: Use the local file browser on the left to navigate to the source file. Use the remote file browser on the right to navigate to the destination. Phase 4: Select the file and click Transfer. Wait for the transfer progress bar to complete.',
    },
    {
      match: /event.*log|machine.*log|session.*log|host.*log|activity.*log/i,
      hint: 'Phase 1: In the Access tab, click the machine name to open its detail panel (do NOT click Connect). Phase 2: Navigate to the Session History or Event Log tab within the detail panel. Phase 3: Review events for the relevant time window — connection attempts, disconnects, commands run. Save notable events to memory key screenconnect_event_log.',
    },
  ],
};
