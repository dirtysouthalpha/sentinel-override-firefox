// background/platforms/fortigate.js
// FortiGate web admin + FortiManager — v3.22.0 (expanded with full selectors)
//
// Two surfaces this profile covers:
//   1. FortiGate on-box web admin: https://<wan-ip>/ng/ (FortiOS 7.x SPA)
//   2. FortiManager: cloud or on-prem; multi-tenant ADOM (Admin Domain)
//      management layer over multiple FortiGates.
//
// MSP gotcha: FortiManager pushes config changes via "Install Wizard" — the
// agent must understand the difference between editing in FortiManager (which
// stages the change) and installing to the device (which applies it).

// Precompile regex patterns for hot-path detection
const _FORTI_HOST_RE = /fortinet|fortigate|fortimanager|fortiweb|forticloud/i;
const _FORTI_PATH_RE = /\/ng\/|\/p\/login|\/p\/dashboard/;
const _IP_ADDRESS_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const _FORTI_GOAL_RE = /\b(fortigate|fortimanager|fortinet|fortiweb|fortianalyzer)\b/i;

export const fortigate = {
  id: 'fortigate',
  label: 'FortiGate / FortiManager',
  memoryKeyPrefix: 'fortigate_',

  detect(url, goal) {
    if (!url && !goal) return false;
    try {
      const u = new URL(url);
      const host = u.host.toLowerCase();
      const path = u.pathname.toLowerCase();
      if (_FORTI_HOST_RE.test(host)) return true;
      if (_FORTI_PATH_RE.test(path) && _IP_ADDRESS_RE.test(host)) return true;
    } catch (_e) { /* fall through */ }
    return _FORTI_GOAL_RE.test(String(goal || ''));
  },

  pageTypes: [
    { name: 'fortigate-login',      urlMatch: /\/p\/login|\/login\.html|\/?$/i, hint: 'FortiGate login screen. User must sign in manually (HTTPS basic + 2FA on most deployments).' },
    { name: 'fortigate-dashboard',  urlMatch: /\/ng\/dashboard|\/p\/dashboard/i, hint: 'FortiOS 7.x dashboard. System resources, sessions, top sources widgets.' },
    { name: 'fortigate-policy',     urlMatch: /\/ng\/policy|\/p\/firewall\/policy/i, hint: 'IPv4/IPv6 policy list. Click pencil to edit, + to add. Right-click row for clone/insert.' },
    { name: 'fortigate-addr-obj',   urlMatch: /\/ng\/firewall\/address|\/p\/firewall\/address/i, hint: 'Address objects + groups. Create before policies that reference them.' },
    { name: 'fortigate-services',   urlMatch: /\/ng\/firewall\/service|\/p\/firewall\/service/i, hint: 'Service definitions (TCP/UDP/ICMP/custom). Built-in services prefixed with "ALL_".' },
    { name: 'fortigate-ipsec',      urlMatch: /\/ng\/vpn\/ipsec|\/p\/vpn\/ipsec/i, hint: 'IPsec VPN > Tunnels. Status icons (green up, gray down). Click for phase1/phase2 detail.' },
    { name: 'fortigate-sslvpn',     urlMatch: /\/ng\/vpn\/ssl|\/p\/vpn\/ssl/i, hint: 'SSL-VPN portals + settings. Authentication, portal mapping, source ranges.' },
    { name: 'fortigate-users',      urlMatch: /\/ng\/user\/user|\/p\/user\/local/i, hint: 'User & Authentication > User Definition. Local users; LDAP/RADIUS under sibling tabs.' },
    { name: 'fortigate-log',        urlMatch: /\/ng\/log|\/p\/log/i, hint: 'Log viewer. Disk/memory/FortiAnalyzer source toggle. Empty filter = empty results — set time + category first.' },
    { name: 'fortimgr-adoms',       urlMatch: /\/adom\/|\/p\/dvm\/main/i, hint: 'FortiManager ADOM list. Pick an ADOM before any device-specific work.' },
    { name: 'fortimgr-device',      urlMatch: /\/dvm\/device|\/device\/main/i, hint: 'FortiManager Device Manager — list of managed FortiGates.' },
    { name: 'fortimgr-install',     urlMatch: /\/install|\/iwiz/i, hint: 'FortiManager Install Wizard — pushes staged config changes to the actual device.' },
  ],

  knownSelectors: {
    // FortiGate generic chrome
    leftNav:                  'div[class*="sidebar"], nav.menu, aside.main-menu',
    topBar:                   '.topbar, header.app-header, div[class*="header-bar"]',
    adomPicker:               '.adom-picker, [class*="adom"][class*="select"]',
    userMenuButton:           '[class*="user-menu"], [aria-label*="user" i][role="button"]',
    logoutButton:             '[aria-label="Logout" i], button:has-text("Logout")',

    // Login
    usernameInput:            'input[name="username"], input[id="username"], input[autocomplete="username"]',
    passwordInput:            'input[name="password"], input[type="password"]',
    loginSubmit:              'button[type="submit"], input[type="submit"], button:has-text("Login")',

    // Policy
    policyTable:              '.ux-grid, .ag-root, table[class*="policy"]',
    policyRow:                'div[role="row"][role-index], .ag-row, tr.policy-row',
    policyAddButton:          'button[aria-label="Create new" i], button:has-text("Create New"), .add-policy-btn',
    policyEditIcon:           'button[aria-label="Edit" i], i.fa-pencil, .edit-icon',
    policyDeleteIcon:         'button[aria-label="Delete" i], i.fa-trash',
    policySourceField:        '[name="srcaddr"], input[placeholder*="Source" i], .source-address-input',
    policyDestField:          '[name="dstaddr"], input[placeholder*="Destination" i]',
    policyServiceField:       '[name="service"], input[placeholder*="Service" i]',
    policyActionDropdown:     'select[name="action"], [class*="action-select"]',
    policySaveButton:         'button[type="submit"]:has-text("OK"), .save-btn, button.btn-primary',

    // Address objects
    addrObjTable:             '.ux-grid, table[class*="address"]',
    addrObjCreateBtn:         'button:has-text("Create New"), button[aria-label="Create address" i]',
    addrObjNameInput:         'input[name="name"], input[placeholder="Name" i]',
    addrObjTypeSelect:        'select[name="type"], select[name="subnet"]',
    addrObjValueInput:        'input[name="subnet"], input[name="iprange"], input[name="fqdn"]',

    // IPsec VPN
    ipsecTable:               '.ux-grid, table[class*="ipsec"], table[class*="tunnel"]',
    ipsecRow:                 '.ag-row, tr.tunnel-row',
    ipsecStatusIcon:          'i[class*="status"], .tunnel-status',
    ipsecPhase1Tab:           '[role="tab"]:has-text("Phase 1"), button:has-text("Phase 1")',
    ipsecPhase2Tab:           '[role="tab"]:has-text("Phase 2"), button:has-text("Phase 2")',

    // Logs
    logCategoryDropdown:      'select[name*="category" i], .log-category-select',
    logTimeRangePicker:       '.time-range-picker input, input[name*="time" i]',
    logSourceToggle:          '.log-source-toggle, [class*="source-select"]',
    logTable:                 '.ux-grid, table[class*="log"]',
    logApplyFiltersBtn:       'button[aria-label*="apply" i], button:has-text("Apply")',
    logExportBtn:             'button:has-text("Download"), button[aria-label*="export" i]',

    // FortiManager
    fmgrAdomList:             '.adom-list-table, table[class*="adom-list"]',
    fmgrDeviceTable:          '.device-table, [class*="device-list"]',
    fmgrInstallWizardBtn:     'button:has-text("Install"), button[aria-label*="install" i]',
    fmgrInstallTargetCheckbox:'input[type="checkbox"][name*="device" i], .device-checkbox',
    fmgrInstallNextBtn:       'button:has-text("Next"), button[aria-label="Next" i]',
    fmgrInstallCompleteBtn:   'button:has-text("Install"), button:has-text("Apply")',

    // Common
    confirmYesBtn:            'button:has-text("OK"), button:has-text("Yes"), button[aria-label="OK" i]',
    cancelBtn:                'button:has-text("Cancel"), button[aria-label="Cancel" i]',
  },

  waitStrings: {
    dashboardLoaded:          ['System Resources', 'Top Sources', 'Sessions', 'Bandwidth', 'Dashboard'],
    policySaved:              ['saved', 'created', 'updated', 'modified successfully'],
    commitApplied:            ['Install completed', 'Configuration installed', 'Applied successfully'],
    tunnelUp:                 ['UP', 'Established', 'Phase 2 selectors'],
    tunnelDown:               ['DOWN', 'Not established', 'No active sessions'],
    loginRequired:            ['Please log in', 'Username', 'Login', 'Authentication required'],
    sessionExpired:           ['Session has expired', 'Login again', 'Re-authenticate'],
  },

  needsTargetSelection: false,   // FortiManager users need to pick ADOM first — handled via prompt directives
  preflightInstructions: '',

  liveDataCaveats: 'FortiGate web admin shows live data per device. FortiManager is a multi-tenant management layer — drill into a specific FortiGate via Device Manager BEFORE expecting per-device data. Changes in FortiManager are STAGED until Install Wizard pushes them to the device — verify both the FMG state AND the device state after a change.',

  knownGotchas: [
    'Default left-nav state varies by ADOM (administrative domain). Set the correct ADOM via the top-bar dropdown before navigating; cross-ADOM clicks won\'t work.',
    'Log views require a search filter to populate — empty filter often shows nothing. Set time range + category before reading.',
    'Policy rules are objects with separate "Status: Disabled" and "Action: Deny" — those mean different things.',
    'FortiOS 7.x SPA uses Vue. After clicking a left-nav item, wait 1-2 seconds for the panel to render before scraping.',
    'FortiManager installs are async — the Install Wizard returns immediately but the actual push can take 30-90s. Check Task Manager (top-right) for completion status.',
    'Some pages (Log viewer, Sessions) use virtual scrolling — DOM only contains visible rows. Use read_network_requests to capture the underlying API or scroll to load more.',
  ].join(' '),

  // run_remote_command: FortiGate CLI via web console (Dashboard > CLI Console widget)
  commandInterface: {
    inputSelector:   '.cli-console input, .console-input, textarea[class*="cli" i], #cli-input',
    typeSelect:      null,
    submitSelector:  null,  // FortiGate CLI console submits on Enter
    outputSelector:  '.cli-output, .console-output, [class*="cliOutput"]',
    outputReadyText: null,
    outputTimeoutMs: 8000,
    commandTypes: { cmd: 'cmd', powershell: 'cmd', bash: 'cmd' },
  },

  rewriteInstructions: `When rewriting goals for FortiGate / FortiManager:
- Detect if user is on FortiGate direct (single device) or FortiManager (multi-tenant). Each has a different mental model.
- If FortiManager: insert Phase 0 to pick the right ADOM, then drill into Device Manager > [target device].
- For any policy/config CHANGE on FortiManager, the workflow is edit → save (stages) → Install Wizard → verify on device. Don't skip the install step.
- Memory keys must begin with 'fortigate_'.
- Wait_for_text on dashboard or policy-saved signals after navigations/saves.
- Preserve the user's deliverable structure exactly.`,

  workflowHints: [
    {
      match: /ipsec.*tunnel|vpn.*tunnel|tunnel.*status|vpn.*up|vpn.*down/i,
      hint: 'Phase 1: Navigate to VPN > IPsec Tunnels. Wait 2 seconds for the Vue SPA to render (wait_for_text "Phase 2 selectors" or "UP"). Extract each tunnel name, remote gateway, and status (UP/DOWN) — save to fortigate_ipsec_tunnels. Phase 2: For any DOWN tunnel, click the row to open Phase 1 / Phase 2 detail and note the failure reason.',
    },
    {
      match: /firewall.*policy|add.*policy|new.*rule|create.*policy|edit.*policy/i,
      hint: 'Phase 1: Navigate to Policy & Objects > IPv4 Policy (or IPv6 Policy). Wait 2 seconds for the ag-grid to render. Phase 2: Click "Create New" (+ button) to add, or click the pencil icon on an existing row to edit. Fill in Name, Incoming Interface, Outgoing Interface, Source, Destination, Service, and Action. Phase 3: Click OK. Wait for the policy-saved signal ("saved" or "created"). Verify the policy appears in the list.',
    },
    {
      match: /ssl.*vpn|web.*portal|vpn.*portal|remote.*user.*vpn/i,
      hint: 'Phase 1: Navigate to VPN > SSL-VPN Settings. Check the Listen on Interface and port. Phase 2: Navigate to VPN > SSL-VPN Portals to verify the portal configuration. Phase 3: Navigate to VPN > SSL-VPN Realms or Authentication > User Groups to check which users have access.',
    },
    {
      match: /fortimanager.*install|install.*config|push.*config|deploy.*config/i,
      hint: 'Phase 0 (FortiManager only): Select the correct ADOM from the top-bar dropdown. Phase 1: Navigate to Device Manager and select the target FortiGate. Make the required config changes — remember these are STAGED in FortiManager, not yet on the device. Phase 2: Click Install Wizard. Select the target device checkbox. Click Next, then Install. Phase 3: Monitor Task Manager (top-right) for completion (30-90 seconds). Verify the change on the actual device afterward.',
    },
    {
      match: /log|event.*log|security.*event|traffic.*log/i,
      hint: 'Navigate to Log & Report > Forward Traffic (or Security Events or System Events). Set the Category dropdown and Time Range FIRST — empty filter shows nothing. Wait for the virtual-scroll table to load. For large result sets, use read_network_requests to capture the underlying API response rather than DOM extraction.',
    },
  ],
};
