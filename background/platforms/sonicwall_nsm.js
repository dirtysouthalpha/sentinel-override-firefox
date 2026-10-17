// background/platforms/sonicwall_nsm.js
// SonicWall Network Security Manager (cloud orchestrator) — v3.15.0
//
// NSM is a multi-tenant cloud management layer over SonicWall firewalls. The
// on-board SonicOS menus (System > Licenses, VPN > Settings, Firewall > Access
// Rules) DO NOT exist at the NSM root. Drill into a specific firewall first.

// Precompile regex patterns for hot-path detection
const _NSM_HOST_RE = /(^|\.)nsm[\w.-]*\.sonicwall\.com$/i;
const _NSM_CLOUD_HOST_RE = /(^|\.)cloud\.sonicwall\.com$/i;
const _NSM_GOAL_RE = /\bsonicwall\s+nsm|network\s+security\s+manager\b/i;

export const sonicwallNsm = {
  id: 'sonicwall_nsm',
  label: 'SonicWall Network Security Manager',
  memoryKeyPrefix: 'sonicwall_',

  // Match the NSM SaaS hosts AND any goal text strongly hinting on-box menus
  // while the user is on an NSM URL (the mismatch case).
  detect(url, goal) {
    if (!url && !goal) return false;
    if (url) try {
      const host = new URL(url).host;
      if (_NSM_HOST_RE.test(host)) return true;
      if (_NSM_CLOUD_HOST_RE.test(host)) return true;
    } catch (_e) { /* fall through */ }
    return _NSM_GOAL_RE.test(String(goal || ''));
  },

  // Watch for goals written against the on-box console while user is on NSM.
  // Each hint pairs an on-box menu path with the NSM equivalent.
  mismatchHints: [
    {
      pattern: /\bSystem\s*>\s*Licenses\b/i,
      onbox: 'System > Licenses',
      nsm: 'MANAGE > FIREWALLS > [click target firewall] > Device > Settings > Licenses'
    },
    {
      pattern: /\bSystem\s*>\s*Status\b/i,
      onbox: 'System > Status',
      nsm: 'MANAGE > FIREWALLS > [target firewall row] (status appears in the row + drill-down dashboard)'
    },
    {
      pattern: /\bVPN\s*>\s*Settings\b/i,
      onbox: 'VPN > Settings',
      nsm: 'Device > VPN > Base Settings (after drilling into the target firewall)'
    },
    {
      pattern: /\bVPN\s*>\s*DHCP\s*over\s*VPN\b/i,
      onbox: 'VPN > DHCP over VPN',
      nsm: 'Device > VPN > DHCP over VPN (after drilling in; may be absent on some firmware versions)'
    },
    {
      pattern: /\bVPN\s*>\s*Status\b/i,
      onbox: 'VPN > Status',
      nsm: 'Device > VPN > Active VPN Sessions (sometimes labeled "Currently Active VPN Tunnels" or under Logs/Reporting > Live Monitor > VPN)'
    },
    {
      pattern: /\bUsers\s*>\s*Local\s*Users\b/i,
      onbox: 'Users > Local Users',
      nsm: 'Device > Users > Local Users'
    },
    {
      pattern: /\bLog\s*>\s*View|Log\s+Monitor\b/i,
      onbox: 'Log > View',
      nsm: 'Device > Logs/Reporting > View Logs (per-device); NSM-wide fallback: ANALYTICS > Logs with Device filter'
    },
    {
      pattern: /\bFirewall\s*>\s*Access\s*Rules\b/i,
      onbox: 'Firewall > Access Rules',
      nsm: 'Device > Firewall > Access Rules'
    },
    {
      pattern: /\bNetwork\s*>\s*Zones|Firewall\s*>\s*Zones\b/i,
      onbox: 'Network > Zones / Firewall > Zones',
      nsm: 'Device > Network > Zones'
    },
  ],

  // Pre-flight: NSM almost always needs Phase 0 to drill into the right device
  // before any per-device menu makes sense.
  needsTargetSelection: true,
  preflightInstructions: [
    'Phase 0 — Identify and drill into the target firewall in NSM.',
    'Step 0a: Navigate to MANAGE > FIREWALLS.',
    'Step 0b: Identify the firewall serving the affected site/user. Search by hostname, site name, or serial. If multiple match, prefer the firewall whose tenant/group contains the client name.',
    'Step 0c: Save to memory: <prefix>fw_name, <prefix>fw_serial, <prefix>fw_model, <prefix>fw_firmware, <prefix>fw_status, <prefix>fw_wan_ip (if visible).',
    'Step 0d: Click the firewall row to enter the per-device console. Confirm the URL now contains /firewall/<serial>/. Save the post-drill URL to <prefix>device_console_url.',
    'Step 0e: If you cannot uniquely identify the firewall, save "[MISSING DATA — target firewall identity]" to <prefix>target_fw_blocker and STOP with a finish summary. Do not guess.',
  ].join('\n'),

  liveDataCaveats: [
    'NSM lags ~5-15 minutes on aggregated analytics (ANALYTICS > Sessions, ANALYTICS > Logs at the root).',
    'For LIVE data — active sessions, current license seat usage, real-time log tail — prefer the per-device view (Device > VPN > Active VPN Sessions, Device > Settings > Licenses, Device > Logs/Reporting > View Logs). NSM-wide views are good for trend, not for "what is happening right now."',
    'If a per-device view returns empty or unavailable for the firmware version, fall through to the firewall\'s direct web admin via its WAN IP. ONLY use direct access for reads — never modify.',
  ].join(' '),

  knownGotchas: [
    'Welcome / onboarding tour overlay may re-render on every page; dismiss ONCE at start and ignore further appearances.',
    'NSM tables are data-grid widgets — extract entire visible page in one execute_js rather than scrolling/clicking each row.',
    'WAN GroupVPN policies created on the firewall BEFORE NSM took over management may not appear in NSM\'s per-device VPN view. Fall through to direct firewall web admin if Phase 2/7 returns empty.',
    'Per-device menus only appear AFTER drilling in. Trying to find "System > Licenses" at the NSM root is the #1 cause of agent flailing on this platform.',
    'Active VPN session counts and license seat consumption are NOT available at the NSM root — only inside the per-device console.',
  ].join(' '),

  // Plain prose instructions appended to the rewriter LLM's system prompt.
  // (3.18.0) Page-type classification — helps the LLM know what surface
  // it's currently on so it can pick the right selectors below.
  pageTypes: [
    { name: 'nsm-home',       urlMatch: /\/dashboard|\/home/i, hint: 'NSM root dashboard. Drill into MANAGE > FIREWALLS first.' },
    { name: 'firewall-list',  urlMatch: /\/manage\/firewalls|\/firewalls\/list/i, hint: 'Multi-tenant firewall list. Click a row to enter the per-device console.' },
    { name: 'device-console', urlMatch: /\/firewall\/[\w-]+\//i, hint: 'Per-device console — full per-firewall menu tree is available.' },
    { name: 'device-vpn-base',urlMatch: /\/firewall\/[\w-]+\/.*\/vpn\/(base|policies|settings)/i, hint: 'IPSec VPN base settings / policies table. Each policy row is editable.' },
    { name: 'device-users',   urlMatch: /\/firewall\/[\w-]+\/.*\/users\/local/i, hint: 'Local Users table. Each row is editable; user record has Groups / VPN Access tabs.' },
    { name: 'device-logs',    urlMatch: /\/firewall\/[\w-]+\/.*\/logs(\/|\?|$)/i, hint: 'Per-device log viewer. Category filter + time range required to populate.' },
    { name: 'policy-edit',    urlMatch: /\/policy\/[\w-]+\/edit|\?dialog=policy/i, hint: 'Policy edit dialog open. Tab strip: General / Network / Proposals / Advanced / Client / Client Provisioning.' },
  ],

  // (3.18.0) Known selectors for SonicOS 7.x running under NSM 7.x. The
  // agent's runtime DOM scanner still works as fallback — these just give
  // the LLM a "try these first" hint to reduce trial-and-error.
  //
  // Selectors are written defensively (comma-separated alternatives) because
  // NSM's exact DOM varies slightly by version. Each entry is a best-effort
  // shortlist — the agent's executable selectors come from the live scan.
  knownSelectors: {
    // NSM root + firewall list
    firewallsTable:           'table[class*="firewall"], table[data-test*="firewalls"], [class*="firewall-list"]',
    firewallTableRow:         'tr[data-id], tr[data-firewall-id], .firewall-row, [class*="firewall-list-item"]',
    firewallSearchInput:      'input[placeholder*="search" i], input[aria-label*="search" i]',
    drillIntoFirewall:        '.firewall-row a, .firewall-row [role="link"], tr[data-id] td:first-child a',

    // Per-device left navigation
    deviceLeftNav:            '.device-sidebar, [class*="device-nav"], nav[aria-label*="device" i]',
    deviceNavVpn:             'nav a[href*="vpn"], [class*="nav"] [href*="vpn"]',
    deviceNavUsers:           'nav a[href*="users"], [class*="nav"] [href*="users"]',
    deviceNavLogs:            'nav a[href*="logs"], nav a[href*="reporting"]',
    deviceNavFirewall:        'nav a[href*="firewall"], nav a[href*="rules"]',
    deviceNavNetwork:         'nav a[href*="network"], nav a[href*="zones"]',
    deviceNavSettings:        'nav a[href*="settings"], nav a[href*="administration"]',

    // VPN policies table
    vpnPoliciesTable:         'table[data-test*="vpn"], .vpn-policies-table, table[aria-label*="VPN polic" i]',
    vpnPolicyRow:             'tr[data-policy-id], .policy-row, tbody tr',
    vpnPolicyNameCell:        'td.policy-name, td[class*="name"]:first-of-type',
    vpnPolicyEditIcon:        'button[aria-label*="edit" i], .edit-btn, [class*="pencil"]',

    // VPN policy edit dialog
    policyDialog:             'div[role="dialog"], .policy-dialog, .mat-dialog-container, [class*="policy-edit"]',
    policyDialogTabBar:       '[role="tablist"], .tab-bar, .nav-tabs',
    policyDialogTab:          (_name) => 'button[role="tab"]:not([disabled]), .tab-btn',  // filter by visible text matching `name` in JS
    policyTabClientText:      ['Client', 'Client Connections', 'Virtual Adapter'],
    policyTabGeneralText:     ['General'],
    policyTabNetworkText:     ['Network', 'Networks'],
    policyTabProposalsText:   ['Proposals'],
    policyTabAdvancedText:    ['Advanced'],

    // Client tab — Virtual Adapter Settings
    virtualAdapterDropdown:   'select[name*="virtualAdapter" i], [data-field*="virtual-adapter"], [aria-label*="Virtual Adapter" i]',
    virtualAdapterOption:     (_opt) => '[role="option"], li.dropdown-item, option',  // filter by text match in JS
    virtualAdapterOptions:    ['None', 'DHCP Lease', 'Internal DHCP Server', 'External DHCP Server'],

    // Client tab — IP Address Pool fields (appear once DHCP Lease is selected)
    ipPoolStartIp:            'input[name*="startIp" i], input[placeholder*="Start IP" i], input[aria-label*="Start IP" i]',
    ipPoolEndIp:              'input[name*="endIp" i], input[placeholder*="End IP" i], input[aria-label*="End IP" i]',
    ipPoolSubnetMask:         'input[name*="subnet" i], input[placeholder*="Subnet" i], input[aria-label*="Subnet" i]',
    ipPoolDns1:               'input[name*="dns1" i], input[placeholder*="DNS Server 1" i]',
    ipPoolDns2:               'input[name*="dns2" i], input[placeholder*="DNS Server 2" i]',

    // Dialog action buttons
    dialogOkButton:           'div[role="dialog"] button[type="submit"], div[role="dialog"] .btn-primary, button[aria-label="OK"]:not([disabled])',
    dialogCancelButton:       'div[role="dialog"] button[aria-label="Cancel"], div[role="dialog"] .btn-secondary',
    dialogApplyButton:        'div[role="dialog"] button[aria-label="Apply" i]',

    // NSM commit / push pending changes (top toolbar)
    commitPendingButton:      'button[aria-label*="commit" i], button[aria-label*="push" i], .commit-toolbar button.btn-primary',
    pendingChangesIndicator:  '[class*="pending-changes"], [aria-label*="pending changes" i]',

    // Users > Local Users
    usersTable:               'table[class*="users"], table[aria-label*="local users" i]',
    userSearchInput:          'input[placeholder*="Search" i][placeholder*="user" i]',
    userTableRow:             'tr[data-user-id], .user-row, tbody tr',
    userEditIcon:             'button[aria-label*="edit user" i], .user-edit-btn',
    userDetailTabGroups:      '[role="tab"]:has-text("Groups")',           // fallback: scan for text
    userDetailTabVpnAccess:   '[role="tab"]:has-text("VPN Access")',

    // Logs / Reporting view
    logCategoryFilter:        'select[name*="category" i], [aria-label*="category" i] [role="combobox"]',
    logTimeRangePicker:       'input[name*="time" i], [aria-label*="time range" i]',
    logTable:                 'table[class*="logs"], table[aria-label*="log entries" i]',
    logApplyFiltersButton:    'button[aria-label*="apply" i][aria-label*="filter" i]',

    // Onboarding / welcome overlay (3.18.0 — observed cause of step-1 flailing)
    welcomeOverlay:           '.onboarding-tour, [class*="welcome-overlay"], [data-tour]',
    welcomeOverlayDismiss:    '.onboarding-tour [aria-label*="close" i], .onboarding-tour .skip-btn',
  },

  // (3.18.0) Wait-text signals so the agent knows when an async UI change
  // has actually landed. Used with wait_for_text.
  waitStrings: {
    deviceConsoleLoaded:    ['Device Manager', 'Dashboard', 'Interfaces', 'Firmware'],
    policyDialogOpened:     ['Policy', 'General', 'Virtual Adapter', 'IKE Phase'],
    policyDialogClientTab:  ['Virtual Adapter Settings', 'IP Address Pool', 'DHCP'],
    saveSucceeded:          ['saved', 'updated', 'success', 'applied', 'commit complete', 'changes pushed'],
    saveFailed:             ['error', 'failed', 'invalid', 'permission denied', 'conflict'],
    commitPending:          ['Pending Changes', 'pending commit', 'uncommitted'],
    sessionExpired:         ['Session expired', 'Please sign in again', 'Re-authenticate'],
  },

  rewriteInstructions: `When rewriting goals for SonicWall NSM:
- Insert a Phase 0 if the user's goal jumps straight into per-device menus. Phase 0 must drill MANAGE > FIREWALLS > [target firewall row] BEFORE any per-device step.
- Replace every on-box menu path with the NSM equivalent (see mismatchHints).
- Memory keys must begin with 'sonicwall_'.
- Note that for live data (active sessions, current seat usage), the per-device console is canonical; NSM-root analytics views lag 5-15 minutes.
- If the goal asks for active VPN sessions, point to Device > VPN > Active VPN Sessions (sometimes "Currently Active VPN Tunnels") and fall through to direct firewall admin if absent.
- Tell the agent to dismiss onboarding overlays ONCE and not write overlay_dismiss_count or similar engine metadata to memory.
- Preserve the user's deliverable structure, output style, and phase boundaries exactly. Only menu paths, memory-key prefix, and Phase 0 (if needed) may be added/changed.`,

  workflowHints: [
    {
      match: /policy.*push|push.*policy|deploy.*config|install.*config|sync.*device/i,
      hint: 'Phase 0: Navigate to MANAGE > FIREWALLS and click the target firewall row. Phase 1: Navigate to MANAGE > POLICIES and locate the policy to push. Phase 2: Click Push/Deploy (or Actions > Push to Devices). Phase 3: Monitor via MANAGE > TASKS — wait_for_text "Success". Save push status to memory key sonicwall_policy_push_result.',
    },
    {
      match: /device.*health|firewall.*health|system.*status|cpu.*usage|memory.*usage|uptime/i,
      hint: 'Phase 0: Navigate to MANAGE > FIREWALLS and click the target device row. Phase 1: The device summary panel shows CPU, memory, active connections, and uptime. Wait for the panel (wait_for_text "CPU Usage"). Phase 2: Extract CPU %, memory %, connection count, uptime, and firmware version. Save to memory key sonicwall_device_health.',
    },
    {
      match: /firmware.*update|firmware.*upgrade|update.*firewall|upgrade.*os/i,
      hint: 'Phase 0: Navigate to MANAGE > FIREWALLS and click the target firewall. Phase 1: Navigate to the Firmware tab in the device panel. Phase 2: Check current vs. available firmware version. Phase 3: Schedule the update window — firmware updates reboot the device. Save current and target version to memory key sonicwall_firmware_info.',
    },
    {
      match: /vpn.*tunnel|active.*vpn|vpn.*session|site.to.site/i,
      hint: 'Phase 0: Navigate to MANAGE > FIREWALLS and click the target device. Phase 1: Navigate to MONITOR > VPN or the device VPN Status tab. Phase 2: Extract tunnel name, remote peer, and status (Up/Down). Note NSM VPN data lags 5-15 min — for live data use direct on-box admin. Save to memory key sonicwall_vpn_tunnels.',
    },
    {
      match: /license|seat.*count|vpn.*seat|gvc.*seat|support.*expir/i,
      hint: 'Phase 0: Navigate to MANAGE > FIREWALLS and click the target device. Phase 1: Open the Licensing tab in the device panel. Phase 2: Find Global VPN Client and SSL VPN rows. Extract seat count, current usage, and expiry date. Save to memory key sonicwall_license_info.',
    },
  ],
};
