// background/platforms/cisco.js
// Cisco management surfaces — v3.44.0 (new)
//
// Covers ASA/ASDM, Firepower FMC, Meraki dashboard, and ISE.
// Each sub-portal has distinct DOM patterns. The detect() heuristic
// + pageTypes classifier guide the agent to the right surface.

// Precompile regex patterns for hot-path detection
const _CISCO_HOST_RE = /cisco/i;
const _MERAKI_HOST_RE = /meraki\.com/i;
const _CISCO_PATH_RE = /\/asdm|\/fmc/;
const _ISE_HOST_RE = /\.ise\./i;
const _CISCO_GOAL_RE = /\b(cisco\s*asa|firepower|meraki|cisco\s*ise)\b/i;

export const cisco = {
  id: 'cisco',
  label: 'Cisco Management (ASA/FMC/Meraki/ISE)',
  memoryKeyPrefix: 'cisco_',

  detect(url, goal) {
    if (!url && !goal) return false;
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      const path = u.pathname.toLowerCase();
      if (_CISCO_HOST_RE.test(host)) return true;
      if (_MERAKI_HOST_RE.test(host)) return true;
      if (_CISCO_PATH_RE.test(path)) return true;
      if (_ISE_HOST_RE.test(host)) return true;
    } catch (_e) { /* fall through */ }
    const t = String(goal || '').toLowerCase();
    return _CISCO_GOAL_RE.test(t);
  },

  inferSurface(goal) {
    const t = String(goal || '').toLowerCase();
    if (/(meraki|dashboard)/i.test(t)) return 'meraki';
    if (/(fmc|firepower|firepower\s*management)/i.test(t)) return 'fmc';
    if (/(ise|identity\s*services)/i.test(t)) return 'ise';
    if (/(asdm|asa)/i.test(t)) return 'asdm';
    return 'fmc';
  },

  surfaceUrls: {
    meraki: 'https://dashboard.meraki.com/',
    fmc: '',   // Typically on-premise
    ise: '',   // Typically on-premise
    asdm: '',  // Java-based, limited web interaction
  },

  pageTypes: [
    { name: 'meraki-dashboard',  urlMatch: /dashboard\.meraki\.com/i, hint: 'Meraki dashboard. Standard web UI — most actions work normally; wait for AJAX to settle after saves.' },
    { name: 'fmc-dashboard',    urlMatch: /\/fmc/i,                   hint: 'Firepower Management Center. Custom React components — dropdowns need click-to-open then click-option.' },
    { name: 'ise-dashboard',    urlMatch: /\/ise/i,                   hint: 'Cisco ISE admin portal. Standard web forms with AJAX tables.' },
    { name: 'asdm-java',        urlMatch: /\/asdm/i,                  hint: 'ASDM Java-based UI. DOM interaction is limited; use execute_js sparingly.' },
  ],

  knownSelectors: {
    // Generic
    leftNav:                  'nav, .sidebar, #nav, [class*="sidebar"]',
    pageTitle:                'h1, .page-title, [class*="page-header"]',
    searchBar:                'input[type="search"], input[placeholder*="Search" i]',
    // Meraki
    merakiOrgSwitcher:        '[class*="org-switcher"], select[name*="org" i]',
    merakiNetworkPicker:      '[class*="network-picker"], select[name*="network" i]',
    merakiSaveButton:         'button:has-text("Save"), button[type="submit"]',
    // FMC
    fmcDeployButton:          'button:has-text("Deploy"), button:has-text("Commit"), button[aria-label*="Deploy" i]',
    fmcTable:                 '[class*="table"], table',
    fmcFilterInput:           'input[placeholder*="Filter" i], input[placeholder*="Search" i]',
    // Common
    deployCommitButton:       'button:has-text("Deploy"), button:has-text("Commit"), button[aria-label*="Deploy" i], button[aria-label*="Commit" i]',
  },

  waitStrings: {
    pageLoaded:         ['Dashboard', 'Devices', 'Network', 'Security', 'Organization'],
    deploySucceeded:    ['deployed', 'success', 'completed', 'finished'],
    saveSucceeded:      ['saved', 'updated', 'success'],
    saveFailed:         ['error', 'failed', 'invalid'],
  },

  needsTargetSelection: false,
  preflightInstructions: '',

  liveDataCaveats: 'Cisco management interfaces are typically on-premise with direct DB access — no significant data lag.',

  knownGotchas: [
    'ASDM uses Java — DOM interaction is limited. Use execute_js sparingly on ASDM surfaces.',
    'FMC uses custom React components — dropdowns need click-to-open then click-option (not native select).',
    'Meraki dashboard is standard web UI — most actions work normally; wait for AJAX to settle after saves.',
    'ALWAYS look for a Deploy or Commit button after policy changes — pending changes are staged, not live.',
    'Log tables use pagination — note the page number when extracting log entries.',
  ].join(' '),

  rewriteInstructions: `When rewriting goals for Cisco:
- Detect which surface (ASA/FMC/Meraki/ISE) from the goal text.
- After any policy change, include a Deploy/Commit step.
- Memory keys must begin with 'cisco_'.
- Preserve the user's deliverable structure exactly.`,

  workflowHints: [],
};
