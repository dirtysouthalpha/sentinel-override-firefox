// background/platforms/ninjarmm.js
// NinjaOne (NinjaRMM) — v3.37.0
//
// Covers app.ninjarmm.com (cloud) and any on-prem NinjaOne instance.
// NinjaOne is a React SPA with hash-based routing. The "Run Automation"
// / "Scripting" pane is the primary command surface.

// Precompile regex patterns for hot-path detection
const _NINJA_HOST_RE = /ninjarmm\.com|ninjarmm\.io|app\.ninjarmm/i;
const _NINJA_HOST_SHORT_RE = /ninjarmm/i;
const _NINJA_GOAL_RE = /\b(?:ninjarmm|ninjaone|ninja[\s-]?rmm)\b/i;

export const ninjarmm = {
  id: 'ninjarmm',
  label: 'NinjaOne (NinjaRMM)',
  memoryKeyPrefix: 'ninja_',

  detect(url, goal) {
    if (!url && !goal) return false;
    try {
      const u = new URL(url);
      const host = u.hostname;
      if (_NINJA_HOST_RE.test(host)) return true;
      if (_NINJA_HOST_SHORT_RE.test(host)) return true;
    } catch (_e) { /* fall through */ }
    return _NINJA_GOAL_RE.test(String(goal || ''));
  },

  pageTypes: [
    { name: 'ninja-dashboard',  urlMatch: /\/#dashboard|\/dashboard/i,              hint: 'NinjaOne dashboard. Device health summary, alert counts.' },
    { name: 'ninja-devices',    urlMatch: /\/#devicesDashboard|\/devices/i,          hint: 'NinjaOne device list. Filter by org, location, status.' },
    { name: 'ninja-device',     urlMatch: /\/#\/device\/|\/device\//i,               hint: 'Individual device view. Overview, alerts, jobs, scripting tabs.' },
    { name: 'ninja-scripting',  urlMatch: /scripting|runscript|automation/i,         hint: 'NinjaOne Run Script / Automation panel for the selected device.' },
    { name: 'ninja-alerts',     urlMatch: /\/#alerts|\/alerts/i,                     hint: 'NinjaOne alerts queue. Active and resolved alerts.' },
    { name: 'ninja-orgs',       urlMatch: /\/#organizations|\/organizations/i,       hint: 'NinjaOne organizations list.' },
  ],

  knownSelectors: {
    // Global nav
    searchBox:              'input[placeholder*="Search" i], input[type="search"]',
    deviceListTable:        'table[data-test="devices-table"], .devices-grid, .device-list',
    deviceRow:              'tr[data-row-key], .device-row, [class*="deviceRow"]',
    deviceNameCell:         'td[data-field="name"], [class*="deviceName"]',

    // Device view
    scriptingTab:           '[data-tab="scripting"], button:has-text("Scripting"), a:has-text("Scripting")',
    runAutomationBtn:       'button:has-text("Run Automation"), button:has-text("Run Script"), [data-test="run-action"]',

    // Script runner modal
    scriptTypeSelect:       'select[name="language"], [data-test="script-language"]',
    scriptEditor:           '.code-editor textarea, [class*="CodeMirror"] textarea, textarea[name="script"]',
    scriptRunBtn:           'button[type="submit"]:has-text("Run"), button:has-text("Execute"), [data-test="run-script"]',
    scriptOutputPane:       '[class*="scriptOutput"], [class*="jobOutput"], .job-result pre',
    scriptJobStatus:        '[class*="jobStatus"], [data-test="job-status"]',

    // Alerts
    alertRow:               'tr[data-test="alert-row"], [class*="alertRow"]',
    alertAckBtn:            'button:has-text("Acknowledge"), [data-test="ack-alert"]',
    alertResolveBtn:        'button:has-text("Resolve"), [data-test="resolve-alert"]',
  },

  commandInterface: {
    // run_remote_command targets the script editor in the Run Automation panel
    inputSelector:      '.code-editor textarea, [class*="CodeMirror"] textarea, textarea[name="script"]',
    typeSelect:         'select[name="language"], [data-test="script-language"]',
    submitSelector:     'button[type="submit"]:has-text("Run"), button:has-text("Execute"), [data-test="run-script"]',
    outputSelector:     '[class*="scriptOutput"], [class*="jobOutput"], .job-result pre',
    outputReadyText:    'Completed',
    outputTimeoutMs:    30000,
    commandTypes: {
      powershell: 'PowerShell',
      cmd:        'Batch',
      bash:       'Shell',
    },
  },

  waitStrings: {
    dashboardReady: ['Dashboard'],
    commandComplete: ['Completed'],
  },

  commitFlow: ['Save', 'Apply'],
  sessionExpiredText: 'Your session has expired',

  knownGotchas: [
    'NinjaOne uses a React SPA with hash routing (#). Page transitions may not trigger a full reload.',
    'To run a command on a device: navigate to the device, click the Scripting tab, click Run Automation, select the script type, enter the command, and click Run.',
    'Script output appears in the job output panel. Wait for "Completed" status before reading results.',
    'Device search is in the top search bar. You can filter the device list by organization or location using the sidebar.',
  ],

  liveDataCaveats:
    'NinjaOne device data is near-real-time but may lag by 1-2 minutes for agent check-in. Scripting jobs can take up to 60 seconds to return output.',

  mismatchHints: [],

  workflowHints: [
    {
      match: /device.*health|device.*status|endpoint.*health|agent.*status|device.*overview/i,
      hint: 'Phase 1: Navigate to the target device (search by name in the top search bar or browse Organizations > Locations). Phase 2: The device detail panel shows OS, last-seen, agent version, CPU, memory, and disk. Wait for the panel to load (wait_for_text "Last Activity" or "Agent Version"). Phase 3: Check the Health Score and any active conditions (warnings, critical alerts). Save to memory key ninjarmm_device_<name>.',
    },
    {
      match: /run.*script|deploy.*script|execute.*script|run.*automation|script.*device/i,
      hint: 'Phase 1: Navigate to the target device. Phase 2: Click the Scripting tab (or Run Automation button). Phase 3: Select the script type (PowerShell, Bash, Batch) and enter the script or select from the library. Phase 4: Click Run. Wait for "Completed" status in the job output panel (up to 60 seconds). Read the output below. Save the output to memory key ninjarmm_script_output.',
    },
    {
      match: /alert.*review|alert.*triage|active.*alert|open.*alert|condition.*alert/i,
      hint: 'Phase 1: Navigate to ACTIVITIES > Alerts (or the Alerts tab in the left sidebar). Phase 2: Filter by organization, severity, or device as needed. Phase 3: For each alert, extract: device name, alert condition, severity, triggered-at timestamp, and message. Phase 4: Note which alerts are acknowledged vs. unacknowledged. Save to memory key ninjarmm_alerts.',
    },
    {
      match: /patch.*status|patch.*compliance|missing.*patch|update.*status|windows.*update/i,
      hint: 'Phase 1: Navigate to the target device or organization. Phase 2: Click the Patching tab (or navigate to MANAGEMENT > Patching). Phase 3: Filter for Missing or Failed patches. Phase 4: Extract patch name, KB number, severity, and status for each missing patch. Save patch compliance summary to memory key ninjarmm_patch_status.',
    },
    {
      match: /backup.*status|backup.*job|backup.*failed|continuity.*backup/i,
      hint: 'Phase 1: Navigate to the target device or MANAGEMENT > Backup. Phase 2: Review the backup job list — note job name, last run time, status (Success/Warning/Failed), and protected data size. Phase 3: For failed jobs, click the job row to see the failure reason. Save backup status to memory key ninjarmm_backup_status.',
    },
  ],
};
