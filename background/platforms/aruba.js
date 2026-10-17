// background/platforms/aruba.js
// Aruba Networks management surfaces — v3.22.0 (new)
//
// Three surfaces this profile covers:
//   1. Aruba Central (central.arubanetworks.com) — cloud-managed
//      orchestrator for APs / switches / gateways. Multi-tenant via
//      Groups + Sites.
//   2. Aruba Instant (controller-less AP cluster) — on-IP web admin
//      hosted by the master AP in the cluster.
//   3. Aruba OS-CX switches — on-IP web admin for CX-series switches.
//
// Most MSP work happens in Central (cloud), so that gets the deepest
// selector coverage. Instant + OS-CX selectors are best-effort starters.

// Precompile regex patterns for hot-path detection
const _ARUBA_HOST_RE = /aruba/i;
const _ARUBA_CENTRAL_RE = /(^|\.)central\.arubanetworks\.com$/i;
const _ARUBA_PORTAL_RE = /(^|\.)portal\.central\.arubanetworks\.com$/i;
const _ARUBA_PATH_RE = /\/(?:p\/login|aruba|swarm\.html|monitoring|configuration)\b/;
const _IP_ADDRESS_RE3 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const _ARUBA_GOAL_RE = /\b(aruba|arubaos|aruba\s+central|aruba\s+instant|aos-?cx|hpe\s+aruba)\b/i;

export const aruba = {
  id: 'aruba',
  label: 'Aruba Central / Instant / OS-CX',
  memoryKeyPrefix: 'aruba_',

  detect(url, goal) {
    if (!url && !goal) return false;
    try {
      const u = new URL(url);
      const host = u.host.toLowerCase();
      const path = u.pathname.toLowerCase();
      // Aruba Central cloud — check specific subdomains before generic /aruba/i
      if (_ARUBA_PORTAL_RE.test(host)) return true;
      if (_ARUBA_CENTRAL_RE.test(host)) return true;
      if (_ARUBA_HOST_RE.test(host)) return true;
      // Aruba Instant / on-IP — IP-based hosts with characteristic paths
      if (_ARUBA_PATH_RE.test(path) && _IP_ADDRESS_RE3.test(host)) return true;
    } catch (_e) { /* fall through */ }
    return _ARUBA_GOAL_RE.test(String(goal || ''));
  },

  pageTypes: [
    { name: 'central-login',       urlMatch: /central\.arubanetworks\.com\/[^/]*\/login|sso/i, hint: 'Aruba Central login. SSO or local. User signs in manually.' },
    { name: 'central-dashboard',   urlMatch: /central\.arubanetworks\.com\/[^/]*\/(?:dashboard|home)/i, hint: 'Central dashboard — global view across all groups/sites.' },
    { name: 'central-groups',      urlMatch: /central\.arubanetworks\.com\/[^/]*\/(?:groups|hierarchy)/i, hint: 'Group/site selector. Pick a group before per-device config work.' },
    { name: 'central-devices',     urlMatch: /central\.arubanetworks\.com\/[^/]*\/(?:devices|inventory)/i, hint: 'Device inventory: APs, switches, gateways. Filter by site/group/status.' },
    { name: 'central-ap-detail',   urlMatch: /central\.arubanetworks\.com\/[^/]*\/ap\/[\w-]+|device\/ap\//i, hint: 'AP detail — clients, RF stats, firmware, location.' },
    { name: 'central-switch-detail',urlMatch: /central\.arubanetworks\.com\/[^/]*\/(?:switch|sw)\/[\w-]+/i, hint: 'Switch detail — ports, VLANs, PoE, uptime.' },
    { name: 'central-wireless',    urlMatch: /central\.arubanetworks\.com\/[^/]*\/(?:wireless|ssid|wlan)/i, hint: 'Wireless settings — SSIDs, security, radio config per group.' },
    { name: 'central-clients',     urlMatch: /central\.arubanetworks\.com\/[^/]*\/(?:clients|connected)/i, hint: 'Connected clients across the network. Filter by AP/SSID/user.' },
    { name: 'central-alerts',      urlMatch: /central\.arubanetworks\.com\/[^/]*\/(?:alerts|notif)/i, hint: 'Alerts + notifications. Filter by severity, time, device.' },
    { name: 'central-reports',     urlMatch: /central\.arubanetworks\.com\/[^/]*\/reports/i, hint: 'Reports — usage, top clients, RF health. Schedulable.' },
    { name: 'instant-master',      urlMatch: /\/swarm\.html|\/aruba\/main\.html/i, hint: 'Aruba Instant cluster web admin (on-IP, master AP). Single-pane controller-less management.' },
    { name: 'oscx-login',          urlMatch: /\/p\/login\?next=|\/login/i, hint: 'OS-CX switch login. Web admin available on default IP after first-boot setup.' },
    { name: 'oscx-dashboard',      urlMatch: /\/p\/dashboard|\/system/i, hint: 'OS-CX switch dashboard. Ports, VLANs, MAC table.' },
  ],

  knownSelectors: {
    // Generic
    leftNav:                  'nav.sidebar, [class*="side-nav"], aside.left-nav',
    topBar:                   '.topbar, header.app-header',
    breadcrumb:               '.breadcrumb, nav[aria-label="breadcrumb" i]',

    // Aruba Central — group/site picker
    groupPicker:              '[class*="group-picker"], [aria-label*="group" i] [role="combobox"]',
    sitePicker:               '[class*="site-picker"], [aria-label*="site" i] [role="combobox"]',
    hierarchyToggle:          '[aria-label*="hierarchy" i], button[class*="hierarchy"]',

    // Central — search
    globalSearch:             'input[type="search"][placeholder*="Search" i], .global-search input',

    // Central — devices
    devicesTable:             'table[class*="devices"], .devices-grid, [role="grid"][aria-label*="device" i]',
    devicesTableRow:          'tr[data-device-id], .devices-grid-row, div[role="row"][aria-rowindex]',
    deviceNameCell:           'td.device-name, td:first-of-type a',
    deviceStatusIcon:         '[class*="status"][class*="icon"], .device-status',
    deviceFilterStatus:       'select[name*="status" i], button[aria-label="Filter by status" i]',

    // Central — AP detail
    apDetailHeader:           'h1.ap-name, .ap-detail-header',
    apClientsTable:           'table[aria-label*="clients" i], .ap-clients',
    apRfStats:                '[class*="rf-stats"], section.radio-info',
    apFirmwareInfo:           '[class*="firmware"], section.system-info',

    // Central — switch detail
    swPortsTable:             'table[aria-label*="ports" i], .switch-ports',
    swPortRow:                'tr[data-port-id], .port-row',
    swVlansTable:             'table[aria-label*="vlans" i], .switch-vlans',

    // Central — wireless
    ssidList:                 'table[aria-label*="ssid" i], .ssid-list, .wlan-table',
    ssidRow:                  'tr[data-ssid], .ssid-row',
    ssidEditBtn:              'button[aria-label="Edit" i]:not([disabled]), .edit-ssid',
    ssidSecurityField:        'select[name*="security" i], [class*="auth-mode-select"]',

    // Central — clients
    clientsTable:             'table[aria-label*="clients" i], .clients-grid',
    clientsFilterApDropdown:  'select[name*="ap" i][name*="filter" i]',
    clientsFilterSsidDropdown:'select[name*="ssid" i]',

    // Central — alerts
    alertsTable:              'table[aria-label*="alerts" i], .alerts-grid',
    alertsSeverityFilter:     'select[name*="severity" i]',
    alertsTimeRangePicker:    '.time-range-picker input, input[name*="time" i]',

    // Aruba Instant
    instantTopBar:             '.topbar, .main-header',
    instantNavWireless:        'a[href*="wireless"], a:has-text("Wireless")',
    instantNavSecurity:        'a[href*="security"], a:has-text("Security")',
    instantApsTable:           '.aps-table, table[class*="ap-list"]',

    // OS-CX
    oscxNavInterfaces:         'a[href*="interface"], a:has-text("Interfaces")',
    oscxNavVlans:              'a[href*="vlan"], a:has-text("VLANs")',
    oscxNavSystem:             'a[href*="system"], a:has-text("System")',
    oscxPortTable:             'table[aria-label*="port" i], .ports-table',

    // Common dialog patterns
    dialogSaveBtn:            'button[type="submit"]:has-text("Save"), button.primary:has-text("Save")',
    dialogApplyBtn:           'button:has-text("Apply"), button:has-text("Deploy")',
    dialogCancelBtn:          'button:has-text("Cancel")',
    confirmYesBtn:            'button:has-text("Yes"), button:has-text("Confirm")',
  },

  waitStrings: {
    centralLoaded:          ['Dashboard', 'Groups', 'Sites', 'Devices', 'Clients', 'Alerts'],
    devicesPopulated:       ['Device Type', 'Status', 'IP Address', 'MAC Address', 'No devices'],
    clientsPopulated:       ['Client', 'SSID', 'AP', 'Signal', 'Connection Time', 'No clients'],
    saveSucceeded:          ['saved', 'updated', 'configuration deployed', 'changes applied'],
    saveFailed:             ['error', 'failed', 'invalid'],
    deviceOnline:           ['Online', 'Up', 'Connected'],
    deviceOffline:          ['Offline', 'Down', 'Disconnected'],
    sessionExpired:         ['Session expired', 'Please log in', 'Authentication required'],
  },

  needsTargetSelection: true,  // Central is multi-group; users need to pick a group/site first
  preflightInstructions: [
    'Phase 0 — On Aruba Central, pick the correct Group and Site BEFORE per-device work.',
    'Step 0a: Use the group/site picker in the top bar to navigate to the target hierarchy node.',
    'Step 0b: Confirm the breadcrumb shows the right group/site before proceeding.',
    'Step 0c: Save to memory: aruba_group_name, aruba_site_name (if applicable).',
    'For Aruba Instant or OS-CX (on-IP devices), Phase 0 is not needed — the URL itself selects the device.',
  ].join('\n'),

  liveDataCaveats: 'Aruba Central polls device state on a ~5-minute interval — client lists and RF stats are slightly delayed from live. For real-time troubleshooting, prefer the on-AP web admin (Aruba Instant) or the on-switch admin (OS-CX). Alerts surface in 1-3 minutes from event.',

  knownGotchas: [
    'Aruba Central uses long-poll for live updates — websocket failures can leave widgets stale. Refresh the page if a widget shows "Loading..." for >30s.',
    'OS-CX switches default to short session timeout (15min). Re-login may be required mid-investigation.',
    'Aruba Instant on older firmware (8.5 and below) flags Chrome as "unsupported browser" — there\'s often a bypass link or a hidden ?force=1 query parameter.',
    'Group/Site selection on Central is sticky per-session — picking the wrong one early in the run shows wrong data everywhere. Always verify breadcrumb on first observation.',
    'AP location updates (rename, move to different floor) require Save + 30-60s sync. Don\'t flag as failed if the rename doesn\'t appear immediately.',
    'Wireless config changes on Central are GROUP-scoped — they push to every AP in the group. Verify the group is correct before saving SSID changes.',
  ].join(' '),

  rewriteInstructions: `When rewriting goals for Aruba:
- Detect whether the user is on Central (cloud) or on-IP (Instant/OS-CX). Each has different navigation.
- On Central: insert Phase 0 to pick the correct Group AND Site before per-device steps.
- On Instant/OS-CX: no group-picking needed — the device IS the scope.
- Memory keys must begin with 'aruba_'.
- For configuration CHANGES on Central, the workflow is edit → save (deploys to group). For instant changes, edit → apply. For OS-CX, edit → save running config + commit-changes to startup config.
- Wait_for_text on devicesPopulated or clientsPopulated signals before scraping lists.
- Preserve the user's deliverable structure exactly.`,

  workflowHints: [
    {
      match: /ap.*status|access.*point.*status|ap.*down|ap.*offline|wireless.*status/i,
      hint: 'Phase 0 (Central only): Navigate to MANAGE > Access Points and select the correct Group and Site from the filter dropdowns. Phase 1: The AP list shows each AP name, IP, status (Up/Down), and connected clients. Wait for the list to populate (wait_for_text "Access Points"). Phase 2: Filter by Status = Down if checking for failures. Phase 3: Click an AP to see its detail: radio bands, channels, tx power, and client count. Save to memory key aruba_ap_status.',
    },
    {
      match: /client.*connection|client.*troubleshoot|wifi.*client|wireless.*client|client.*disconnect/i,
      hint: 'Phase 0 (Central only): Navigate to ANALYZE > Clients and set the correct Group/Site filter. Phase 1: Search for the client by MAC address or username. Phase 2: Click the client row to open the Client 360 view — shows association history, SSID, AP name, RSSI, SNR, and roaming events. Phase 3: Check the Connectivity Score and any error events in the timeline. Save findings to memory key aruba_client_<mac>.',
    },
    {
      match: /ssid.*policy|ssid.*config|wireless.*policy|vlan.*assignment|ssid.*review/i,
      hint: 'Phase 0 (Central only): Navigate to CONFIGURE > WLANs and select the correct Group. Phase 1: The WLAN list shows each SSID with its security type, VLAN, and status. Phase 2: Click an SSID to review its configuration: authentication (WPA3/WPA2/Open), VLAN assignment, bandwidth limits, and client isolation. Phase 3: Save SSID name, VLAN, security type, and any noted issues to memory key aruba_ssid_<name>.',
    },
    {
      match: /rogue.*ap|rogue.*device|containment|intrusion.*detection/i,
      hint: 'Navigate to SECURITY > Rogue APs (on Central) or the Intrusion Detection section. Phase 1: Review the list of detected rogue BSSIDs, their channels, and containment status. Phase 2: Identify which rogues are classified as Interfering vs. Rogue (different threat levels). Phase 3: Extract rogue BSSID, SSID, channel, and classification. Save to memory key aruba_rogues.',
    },
  ],
};
