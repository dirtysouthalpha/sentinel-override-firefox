/**
 * Huntress MDR console — v3.44.0 (new)
 *
 * Covers the Huntress managed detection and response platform.
 * Standard React UI with custom dropdowns.
 */

// Precompile regex patterns for hot-path detection
const _HUNTRESS_HOST_RE = /huntress/i;
const _HUNTRESS_GOAL_RE = /\bhuntress\b/i;

export const huntress = {
  id: 'huntress',
  label: 'Huntress MDR',
  memoryKeyPrefix: 'huntress_',

  /**
   * Detects if the given URL or goal matches Huntress.
   * @param {string} url - The URL to check.
   * @param {string} goal - The goal text to check.
   * @returns {boolean} True if Huntress is detected, false otherwise.
   */
  detect(url, goal) {
    if (!url && !goal) return false;
    try {
      const host = (new URL(url)).host.toLowerCase();
      if (_HUNTRESS_HOST_RE.test(host)) return true;
    } catch (_e) {
      // URL parse failed — fall through to goal regex
    }
    return _HUNTRESS_GOAL_RE.test(String(goal || ''));
  },

  pageTypes: [
    { name: 'huntress-dashboard',    urlMatch: /\/dashboard/i,          hint: 'Huntress dashboard. Threat summary with alert counts.' },
    { name: 'huntress-threats',      urlMatch: /\/threat/i,             hint: 'Threat Intelligence. Click an alert to see details.' },
    { name: 'huntress-agents',       urlMatch: /\/agent/i,              hint: 'Managed Agents page. Lists all endpoints with agent status.' },
    { name: 'huntress-reports',      urlMatch: /\/report/i,             hint: 'Reports. Generates PDF/CSV reports for compliance.' },
    { name: 'huntress-deployment',   urlMatch: /\/deploy|\/account/i,   hint: 'Account > Deployment. Download installer or copy install command.' },
  ],

  knownSelectors: {
    // Navigation
    leftNav:                'nav, [class*="sidebar"], [class*="nav"]',
    // Dashboard
    alertCount:             '[class*="alert-count"], [class*="threat-summary"]',
    // Agents table
    agentsTable:            '[class*="agent"][class*="table"], table, [role="grid"]',
    agentRow:               '[role="row"], tbody tr',
    agentStatus:            '[class*="status"], [class*="agent-status"]',
    // Threats
    threatList:             '[class*="threat"][class*="list"], [class*="alert-list"]',
    threatDetail:           '[class*="threat-detail"], [class*="alert-detail"]',
    // Reports
    reportGenerateBtn:      'button:has-text("Generate"), button[aria-label*="Generate" i]',
    reportDownloadBtn:      'button:has-text("Download"), a[download]',
    // Deployment
    downloadInstallerBtn:   'button:has-text("Download"), a[download]',
    copyCommandBtn:         'button:has-text("Copy"), button[aria-label*="Copy" i]',
    // Common
    searchInput:            'input[type="search"], input[placeholder*="Search" i]',
  },

  waitStrings: {
    dashboardLoaded:    ['Dashboard', 'Threats', 'Agents', 'Reports', 'Account'],
    agentsLoaded:       ['Agent', 'Status', 'Last Seen', 'OS'],
    threatsLoaded:      ['Threat', 'Alert', 'Severity', 'Status'],
    reportGenerated:    ['Download', 'Ready', 'Generated'],
  },

  needsTargetSelection: false,
  preflightInstructions: '',

  liveDataCaveats: 'Huntress data is near-real-time for alerts and agent status.',

  knownGotchas: [
    'Dashboard shows threat summary with alert counts.',
    'Left sidebar navigation: Dashboard, Threat Intelligence, Managed Agents, Reports, Account.',
    'Managed Agents page lists all endpoints with agent status.',
    'Alert management: Threat Intelligence > click alert to see details.',
    'Agent deployment: Account > Deployment > download installer or copy install command.',
    'Reports: generates PDF/CSV reports for compliance.',
    'Huntress uses custom React dropdowns — click to open, click to select.',
  ].join(' '),

  rewriteInstructions: `When rewriting goals for Huntress:
- Memory keys must begin with 'huntress_'.
- Custom React dropdowns: click to open, click to select (not native select).
- Preserve the user's deliverable structure exactly.`,

  workflowHints: [],
};