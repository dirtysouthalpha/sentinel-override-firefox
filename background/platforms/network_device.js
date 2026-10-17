// background/platforms/network_device.js
// Generic network/security device management UI — v3.44.0 (new)
//
// Catch-all profile for enterprise network devices: firewalls, routers,
// switches, access points, and generic admin panels. Fires when the goal
// text mentions device management keywords and no more-specific profile
// matched. Must be registered LAST in the profile list.

export const networkDevice = {
  id: 'network_device',
  label: 'Network/Security Device Management (generic)',
  memoryKeyPrefix: 'netdev_',

  detect(url, goal) {
    try {
      if (!url && !goal) return false;
      const goalText = String(goal || '').toLowerCase();
      return /\b(firewall|router|switch|access point|management ui|admin panel|web ui)\b/i.test(goalText);
    } catch (error) {
      console.error('[Sentinel] Error in networkDevice detect:', typeof error === 'object' && error !== null && typeof error.message === 'string' ? error.message : String(error));
      return false;
    }
  },

  pageTypes: [],

  knownSelectors: {
    // Generic device UI patterns
    leftNav:                  'nav, .sidebar, [class*="sidebar"], [class*="nav"]',
    saveButton:               'button:has-text("Save"), button:has-text("Apply"), button:has-text("Commit"), button:has-text("Accept"), button[type="submit"]',
    loginForm:                'form input[type="password"], input[name*="password" i]',
    logTable:                 'table, [class*="log"], [class*="table"]',
    editButton:               'button:has-text("Edit"), button[aria-label*="Edit" i], a:has-text("Edit")',
  },

  waitStrings: {
    pageLoaded:         ['Dashboard', 'Status', 'Configuration', 'System', 'Login'],
    saveSucceeded:      ['saved', 'applied', 'committed', 'success', 'updated'],
    saveFailed:         ['error', 'failed', 'invalid'],
    sessionExpired:     ['Login', 'Sign in', 'Session', 'timeout'],
  },

  needsTargetSelection: false,
  preflightInstructions: '',

  liveDataCaveats: 'Network device management interfaces are typically direct-access with no significant data lag.',

  knownGotchas: [
    'Many network device UIs use custom dropdowns — if "select" fails, try click-to-open then click-option.',
    'Changes are often staged — look for Apply, Save, Commit, or Accept buttons after edits.',
    'Log pages may be slow to load — use wait_for_text with generous timeouts (20000-30000ms).',
    'Session timeouts are common — if a login form appears, re-authenticate using credentials from the goal.',
    'Table rows often open edit dialogs on click — click the row or its edit icon to modify entries.',
  ].join(' '),

  rewriteInstructions: `When rewriting goals for generic network devices:
- Memory keys must begin with 'netdev_'.
- After any configuration change, look for Apply/Save/Commit/Accept button.
- Use generous wait_for_text timeouts on log pages.
- Preserve the user's deliverable structure exactly.`,

  workflowHints: [],
};