/**
 * Palo Alto Networks (PAN-OS / Panorama) — v3.44.0 (new)
 *
 * Covers PAN-OS web UI and Panorama management console. Key gotcha:
 * every config change requires an explicit Commit step. Dropdowns are
 * Ext JS widgets needing click-arrow-then-click-option.
 */
export const paloalto = {
  id: 'paloalto',
  label: 'Palo Alto Networks (PAN-OS / Panorama)',
  memoryKeyPrefix: 'pa_',

  /**
   * Detects if the current URL or goal matches Palo Alto Networks.
   * @param {string} url - The URL to check.
   * @param {string} goal - The goal text to check.
   * @returns {boolean} - True if it's a Palo Alto Networks instance, false otherwise.
   */
  detect(url, goal) {
    if (!url && !goal) return false;
    try {
      const u = new URL(url);
      if (/paloalto/i.test(u.hostname)) return true;
      if (/panorama/i.test(u.hostname)) return true;
      if (/\/php\/rest\/pan/i.test(u.href)) return true;
    } catch (_e) {
      // URL parse failed — fall through to goal regex
    }
    const t = String(goal || '').toLowerCase();
    return /\b(palo\s*alto|pan-os|panorama)\b/i.test(t);
  },

  pageTypes: [
    { name: 'panos-dashboard',   urlMatch: /\/#\/|\/$|dashboard/i, hint: 'PAN-OS dashboard. Tabs across top: Dashboard, Monitor, Network, Objects, Policies, Device.' },
    { name: 'panos-monitor',     urlMatch: /\/#\/monitor/i,        hint: 'Log Viewer. AJAX pagination — wait for spinner to disappear before extracting.' },
    { name: 'panos-policies',    urlMatch: /\/#\/polic/i,          hint: 'Security/NAT policies table. Click Add or select a row to edit.' },
    { name: 'panos-objects',     urlMatch: /\/#\/objects/i,        hint: 'Address objects, service objects, tags. Ext JS dropdowns.' },
    { name: 'panorama-dashboard', urlMatch: /panorama/i,           hint: 'Panorama multi-device management. Device groups + templates at top.' },
  ],

  knownSelectors: {
    // Navigation
    topTabs:                 '.navbar, .tabs, [class*="main-nav"]',
    commitButton:            'button:has-text("Commit"), [class*="commit"], [data-automationid="commit"]',
    // Tables
    policyTable:             'table, .grid-table, [class*="policy-table"]',
    logTable:                'table, .log-table, [class*="log-viewer"]',
    // Forms
    dropdownArrow:           '.x-form-trigger, [class*="dropdown-arrow"], .trigger-cell',
    saveButton:              'button:has-text("OK"), button:has-text("Save")',
    cancelButton:            'button:has-text("Cancel")',
    // Common
    addButton:               'button:has-text("Add"), button[aria-label*="Add" i]',
    deleteButton:            'button:has-text("Delete"), button[aria-label*="Delete" i]',
  },

  waitStrings: {
    pageLoaded:         ['Dashboard', 'Monitor', 'Network', 'Policies', 'Device', 'Commit'],
    commitSucceeded:    ['Commit successful', 'committed successfully', 'Job queue'],
    commitFailed:       ['Commit failed', 'error', 'Validation Error'],
    logLoaded:          ['Log Viewer', 'entries', 'No logs'],
    saveSucceeded:      ['saved', 'updated', 'Object modified'],
  },

  commitFlow: ['Commit'],  // MUST commit after any change

  needsTargetSelection: false,
  preflightInstructions: '',

  liveDataCaveats: 'PAN-OS logs are near-real-time. Commit operations can take 30-120 seconds for large configs.',

  knownGotchas: [
    'After ANY change, a "Commit" step is required — look for the Commit button (top right) and click it. Pending changes are staged, not live.',
    'Dropdowns are Ext JS widgets — click the dropdown arrow, then click the option (not native select).',
    'Tabs within panels are clickable text — click the tab label to switch views.',
    'Log Viewer uses AJAX pagination — wait for spinner to disappear before extracting log data.',
    'Object names are case-sensitive — extract exact names as shown on screen.',
  ].join(' '),

  rewriteInstructions: `When rewriting goals for Palo Alto:
- ALWAYS include a Commit step after any configuration change.
- Memory keys must begin with 'pa_'.
- Preserve the user's deliverable structure exactly.`,

  workflowHints: [],
};