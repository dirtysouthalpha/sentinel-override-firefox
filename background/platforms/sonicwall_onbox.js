// background/platforms/sonicwall_onbox.js
// SonicWall on-box web admin (SonicOS) — v3.22.0 (expanded with full selectors)
//
// The legacy firewall web admin reachable at https://<wan-ip>/. Covers both
// SonicOS 6.5 (classic UI) and SonicOS 7.x (newer SPA). The two UIs differ
// significantly; selectors here are best-effort against 7.x with 6.5
// fallbacks where I know the differences.
//
// Complements the sonicwall_nsm profile (cloud orchestrator). When NSM
// doesn't expose live data (active sessions, current license seats, real-
// time logs), the agent should fall through to direct on-box access via
// this profile.

// Precompile regex patterns for hot-path detection
const _SONICOS_NSM_EXCLUDE_RE = /(^|\.)nsm[\w.-]*\.sonicwall\.com$|cloud\.sonicwall\.com$/i;
const _SONICOS_PATH_RE = /\/sonicui\/|\/main\.html|\/auth\.html|\/getsystem|\/getlogout/i;
const _IP_ADDRESS_RE2 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const _DASHBOARD_PATH_RE = /\/(?:main|dashboard|policy|network|vpn|users|log|system)/i;
const _CISCO_PATH_EXCLUDE_RE = /\/(?:fmc|asdm)/i;
const _SONICOS_GOAL_RE = /\b(?:sonicwall|sonicos|tz\d+|nsa\d+|soho|gen[57]\b)/i;

export const sonicwallOnbox = {
  id: 'sonicwall_onbox',
  label: 'SonicWall on-box web admin (SonicOS)',
  memoryKeyPrefix: 'sonicwall_',

  detect(url, goal) {
    if (!url && !goal) return false;
    try {
      const u = new URL(url);
      const host = u.host;
      // Skip NSM hosts explicitly
      if (_SONICOS_NSM_EXCLUDE_RE.test(host)) return false;
      // SonicOS URL patterns
      if (_SONICOS_PATH_RE.test(u.pathname + u.search)) return true;
      // IP-based on-box: typical paths during admin sessions
      // Exclude /fmc (Cisco Firepower Management Center) and /asdm (Cisco ASA) paths
      // that also match the dashboard/system patterns on IP hosts.
      if (_IP_ADDRESS_RE2.test(host) && _DASHBOARD_PATH_RE.test(u.pathname) && !_CISCO_PATH_EXCLUDE_RE.test(u.pathname)) return true;
    } catch (_e) { /* fall through */ }
    return _SONICOS_GOAL_RE.test(String(goal || ''));
  },

  pageTypes: [
    { name: 'sonicos-login',         urlMatch: /\/auth\.html|\/?$/i, hint: 'SonicWall login screen. Admin sign-in (local or LDAP/RADIUS).' },
    { name: 'sonicos-dashboard',     urlMatch: /\/main\.html|\/sonicui\/.+\/dashboard/i, hint: 'SonicOS dashboard. Sessions, bandwidth, recent threats, device health widgets.' },
    { name: 'sonicos-network-int',   urlMatch: /\/network\/interfaces|#\/Manage\/Network\/Interfaces/i, hint: 'Network > Interfaces. WAN/LAN/DMZ definitions, IP assignments.' },
    { name: 'sonicos-network-zones', urlMatch: /\/network\/zones|#\/Manage\/Network\/Zones/i, hint: 'Network > Zones. WAN / LAN / DMZ / Custom. Click zone name to set Allow IKE / VPN / SSL.' },
    { name: 'sonicos-firewall-rules',urlMatch: /\/firewall\/(?:accessrules|rules)|#\/Manage\/Firewall\/Rules/i, hint: 'Firewall > Access Rules. Matrix by zone-to-zone. Click row to edit, + to add.' },
    { name: 'sonicos-firewall-nat',  urlMatch: /\/firewall\/natpolicies|#\/Manage\/Firewall\/NAT/i, hint: 'Firewall > NAT Policies. Original/translated source/destination.' },
    { name: 'sonicos-vpn-settings',  urlMatch: /\/vpn\/(?:settings|basesettings)|#\/Manage\/VPN/i, hint: 'VPN > Settings (6.5) or Base Settings (7.x). IPsec policies, WAN GroupVPN, SSL VPN base.' },
    { name: 'sonicos-vpn-dhcp',      urlMatch: /\/vpn\/dhcpovervpn/i, hint: 'VPN > DHCP over VPN. Lease tracking for client VPN.' },
    { name: 'sonicos-vpn-status',    urlMatch: /\/vpn\/status|\/vpn\/active/i, hint: 'VPN > Status / Currently Active VPN Tunnels. Live session list.' },
    { name: 'sonicos-users-local',   urlMatch: /\/users\/localusers|#\/Manage\/Users\/Local/i, hint: 'Users > Local Users. Per-user account, group membership, VPN Access tab.' },
    { name: 'sonicos-users-groups',  urlMatch: /\/users\/localgroups/i, hint: 'Users > Local Groups. Group definitions + policy associations.' },
    { name: 'sonicos-log-view',      urlMatch: /\/log\/view|#\/Monitor\/Logs/i, hint: 'Log > View. Live log viewer. Category + severity filters required.' },
    { name: 'sonicos-system-status', urlMatch: /\/system\/status|#\/Investigate\/System\/Status/i, hint: 'System > Status. Firmware version, uptime, signature versions.' },
    { name: 'sonicos-system-license',urlMatch: /\/system\/licenses|#\/Manage\/System\/Licenses/i, hint: 'System > Licenses. License keys, GVC seat count, services activation status.' },
  ],

  knownSelectors: {
    // Generic chrome
    leftNav:                  '.left-nav, nav.sidebar, [id="navTreeContainer"], .navtree',
    topBar:                   '#topBar, .top-bar, header',
    statusBar:                '#statusBar, .status-bar, footer.status',
    pageContent:              '#pageContent, .right-pane, .content-pane',
    loadingSpinner:           '.spinner, [class*="loading"]',

    // Login
    usernameInput:            'input[name="user"], input[name="username"], #username',
    passwordInput:            'input[name="password"], input[type="password"]',
    loginSubmit:              'input[type="submit"][value*="Login" i], button[type="submit"]',

    // Firewall rules
    rulesTable:               '#sgGrid, table[id*="rules"], table.policyTable',
    rulesAddBtn:              'button[title="Add" i], a[onclick*="addRule" i], .add-rule',
    rulesRow:                 'tr.policyRow, tr[id^="row_"]',
    rulesEditIcon:            'img[alt="Edit" i], a[title="Edit" i], button.edit-btn',
    ruleSourceZoneSelect:     'select[name*="source-zone" i], select[name="srczone"]',
    ruleDestZoneSelect:       'select[name*="dest-zone" i], select[name="dstzone"]',
    ruleServiceSelect:        'select[name*="service" i]',
    ruleActionSelect:         'select[name="action"]',
    ruleSaveBtn:              'input[type="submit"][value="OK" i], button:has-text("OK")',

    // VPN
    vpnPolicyTable:           'table.policyTable, table[id*="vpn"]',
    vpnPolicyRow:             'tr.policyRow',
    vpnPolicyEditIcon:        'img[alt="Configure" i], a.editLink',
    vpnDialogTabBar:          '.tabBar, ul[role="tablist"]',
    vpnDialogClientTab:       'a:has-text("Client"), [role="tab"]:has-text("Client")',
    vpnDialogGeneralTab:      'a:has-text("General"), [role="tab"]:has-text("General")',
    vpnDialogProposalsTab:    'a:has-text("Proposals"), [role="tab"]:has-text("Proposals")',
    vpnVirtualAdapterDropdown:'select[name*="virtualAdapter" i], select[name*="virtual-adapter"]',
    vpnIpPoolStartIp:         'input[name*="startIp" i], input[name*="addressStart"]',
    vpnIpPoolEndIp:           'input[name*="endIp" i], input[name*="addressEnd"]',
    vpnSubnetMaskInput:       'input[name*="subnet" i], input[name*="netmask"]',
    vpnOkBtn:                 'input[type="submit"][value="OK" i], button.btn-primary',

    // Users
    usersTable:               'table.userTable, table[id*="users"]',
    usersSearchInput:         'input[placeholder*="Search" i][type="text"]',
    userRow:                  'tr.userRow',
    userEditIcon:             'a.editLink, img[alt="Configure" i]',
    userDetailTabBar:         '.tabBar, ul[role="tablist"]',
    userDetailTabGroups:      'a:has-text("Groups")',
    userDetailTabVpnAccess:   'a:has-text("VPN Access"), a:has-text("VPNAccess")',

    // Logs
    logCategoryFilter:        'select[name*="category" i]',
    logSeverityFilter:        'select[name*="severity" i], select[name*="priority"]',
    logTimeRangePicker:       'input[name*="time" i], input[name*="date" i]',
    logTable:                 'table.logTable, table[id*="log"]',
    logApplyFiltersBtn:       'input[type="submit"][value*="Apply" i], button:has-text("Apply")',
    logExportBtn:             'a[href*="exportLog"], button:has-text("Export")',

    // System
    licensesTable:            'table.licenseTable, table[id*="license"]',
    licensesGvcSeatRow:       'tr:has-text("Global VPN Client"), tr:has(.gvc-license)',

    // Zones (Network > Zones)
    zonesTable:               'table.zoneTable, table[id*="zones"]',
    zoneEditIcon:             'a.editLink',
    zoneAllowIkeCheckbox:     'input[name*="allowIke" i][type="checkbox"], input[name*="allow-ike"]',
    zoneAllowVpnCheckbox:     'input[name*="allowVpn" i][type="checkbox"]',

    // Common dialog
    dialogOkBtn:              'input[type="submit"][value="OK" i], button:has-text("OK")',
    dialogCancelBtn:          'input[type="button"][value="Cancel" i], button:has-text("Cancel")',
    confirmYesBtn:            'button:has-text("Yes"), input[value="Yes" i]',
  },

  waitStrings: {
    dashboardLoaded:          ['System Information', 'Current Sessions', 'WAN Status', 'Dashboard'],
    rulesTableLoaded:         ['Priority', 'From', 'To', 'Source', 'Destination', 'Service', 'No rules'],
    vpnPolicyDialogLoaded:    ['General', 'Proposals', 'Advanced', 'Client', 'OK', 'Cancel'],
    saveSucceeded:            ['saved', 'updated', 'applied', 'success', 'modified successfully'],
    saveFailed:               ['error', 'failed', 'invalid', 'conflict'],
    commitRequired:           ['Pending Changes', 'Commit'],
    sessionExpired:           ['Session has expired', 'Please log in', 'Authentication failed'],
  },

  mismatchHints: [],

  // run_remote_command: SonicWall System > Diagnostics > Ping/Traceroute/DNS
  commandInterface: {
    inputSelector:   'input[name*="host" i], input[id*="target" i], input[id*="Host" i]',
    typeSelect:      'select[name*="tool" i], select[id*="tool" i], select[id*="DiagType"]',
    submitSelector:  'input[type="submit"], button[type="submit"], a[onclick*="diag" i]',
    outputSelector:  'pre.diag-output, textarea[readonly], #diagOutput, .diagnostic-result',
    outputReadyText: null,
    outputTimeoutMs: 10000,
    commandTypes: { cmd: 'Ping' },
  },

  needsTargetSelection: false,
  preflightInstructions: '',

  liveDataCaveats: 'On-box web admin is the canonical source of LIVE data — active sessions, current license seat usage, real-time logs all live here. NSM is for trend/config; the firewall is for "what is happening right now."',

  knownGotchas: [
    'Some pages load via XHR; wait for the right-pane content to appear before reading.',
    'Older SonicOS firmware (5.9, 6.2) put VPN status under VPN > Settings and clientless under Users > Status. Newer firmware (6.5+, 7.x) moved VPN status to VPN > Base Settings or VPN > Currently Active VPN Tunnels. Detect firmware via System > Status first.',
    'When extracting tables, prefer one execute_js dump over per-row clicks — most table rows are scrollable but not paginated.',
    'Some commit actions require a follow-up "Apply" or "Accept" button click — always verify with a read after.',
    'SonicOS 7.x SPA uses hash routing (#/Manage/...). After clicking a left-nav item, wait 2-3 seconds for the panel to render before scanning.',
    'Session expiry is silent — clicking somewhere after expiry redirects to login. If the agent sees a login form mid-task, it expired; re-login with the stashed credentials.',
  ].join(' '),

  rewriteInstructions: `When rewriting goals for SonicWall on-box admin:
- The user's prompt is likely already correct for this surface — make minimal changes.
- Memory keys must begin with 'sonicwall_'.
- Detect firmware version on System > Status BEFORE navigating to version-renamed menus (VPN > Settings vs VPN > Base Settings).
- Wait_for_text on dashboard or page-loaded signals after navigations to handle the XHR rendering pattern.
- Preserve the user's deliverable structure exactly.`,

  workflowHints: [
    {
      match: /vpn.*tunnel|tunnel.*status|vpn.*up|vpn.*down|site.to.site|ipsec.*status/i,
      hint: 'Phase 1: Navigate to VPN > Status (firmware 7.x) or VPN > Currently Active VPN Tunnels (firmware 6.5+). Wait for the tunnel table to load. Extract each tunnel name, remote peer IP, and Up/Down status — save to memory key sonicwall_vpn_tunnels. Phase 2: If a specific tunnel is Down, navigate to VPN > Settings and locate the matching policy to check its Phase 1/Phase 2 configuration.',
    },
    {
      match: /firewall.*rule|access.*rule|add.*rule|block.*traffic|allow.*traffic|new.*policy/i,
      hint: 'Phase 1: Navigate to Firewall > Access Rules. Select the correct zone pair from the From/To matrix (e.g., WAN to LAN). Wait for the rules table to load. Phase 2: Click + to add a new rule, or click the pencil/edit icon on an existing row. Fill in Source, Destination, Service, and Action fields. Phase 3: Click OK/Accept to save. Confirm the success banner, then navigate away and back to verify the rule appears in the list.',
    },
    {
      match: /license|gvc.*seat|vpn.*seat|seat.*count|ssl.*vpn.*user/i,
      hint: 'Navigate to System > Licenses. Locate the "Global VPN Client" row (for GVC/IPsec) or "SSL VPN" row. Extract the licensed seat count, current active sessions, and expiry date — save to memory key sonicwall_license_info.',
    },
    {
      match: /active.*session|current.*session|who.*connected|connection.*monitor/i,
      hint: 'Navigate to Monitor > Connection Monitor (or Dashboard > Active Connections widget). Set filters for the relevant IP range or user. Extract the source IP, destination, protocol, and session count. Use execute_js for a bulk table dump rather than reading row by row.',
    },
    {
      match: /log|event.*log|security.*event|blocked.*traffic/i,
      hint: 'Navigate to Log > View. Set Category and Severity filters BEFORE reading — empty filters return nothing on most firmware versions. Set the time range to the relevant window. Wait 30 seconds for the log to populate (use wait_for_text with a known log entry pattern). Use the Export button to get a CSV if more than 100 entries are needed.',
    },
  ],
};
