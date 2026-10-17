// background/platforms/ambio_viewlinc.js
// Ambio viewLinc 5.x — v3.36.0 (new)
//
// Vaisala-distributed (Ambio-branded) environmental monitoring platform.
// On-prem web app, typically at https://192.168.x.x or http://<server>/Vaisala/.
// Used for GxP/IQ-OQ-PQ validation of temperature/humidity monitoring chambers.
// Tightly regulated — operators expect:
//   - never auto-acknowledge a real production alarm
//   - never delete a threshold the operator didn't create
//   - never modify the channel→location map (viewLinc enforces strict 1:1)
//   - every action timestamped + screenshot-evident for the OQ binder
//
// Most common MSP workflows here are OQ test execution (creating disposable
// test thresholds, watching alarm fire, verifying notification email).

// Precompile regex patterns for hot-path detection
const _VIEWLINC_HOST_RE = /(^|\.)viewlinc\b/i;
const _VIEWLINC_IP_RE = /^192\.168\.100\.\d+$/;
const _VIEWLINC_GOAL_RE = /viewlinc|ambio\b/i;
const _VALIDATION_CODE_RE = /\boq[\s_-]?\d|\biq[\s_-]?\d|\bpq[\s_-]?\d/;
const _CHAMBER_RE = /threshold|rfl100|chamber|stability/;

export const ambioViewlinc = {
  id: 'ambio_viewlinc',
  label: 'Ambio viewLinc',
  memoryKeyPrefix: 'viewlinc_',
  // Phase 0: viewLinc requires picking a TEST LOCATION before any threshold
  // work begins. Adaptive Prompts will rewrite a bare goal to insert this
  // selection step when needsTargetSelection is true.
  needsTargetSelection: true,

  // Detect by host (internal IPs) OR by goal text mentioning the product.
  detect(url, goal) {
    if (url) {
      try {
        const host = new URL(url).host.toLowerCase();
        // Common internal viewLinc deployments — IP-based + DNS-based.
        if (_VIEWLINC_HOST_RE.test(host)) return true;
        if (_VIEWLINC_IP_RE.test(host)) return true;  // user's specific server
      } catch (_e) { /* fall through */ }
    }
    const g = String(goal || '').toLowerCase();
    if (_VIEWLINC_GOAL_RE.test(g)) return true;
    if (_VALIDATION_CODE_RE.test(g) && _CHAMBER_RE.test(g)) return true;
    return false;
  },

  pageTypes: [
    { name: 'viewlinc-login',         urlMatch: /\/login|\/signin/i,
      hint: 'viewLinc login. Uses local accounts or AD-joined. Operator signs in manually — never auto-fill passwords.' },
    { name: 'viewlinc-overview',      urlMatch: /\/#?\/?$|\/overview/i,
      hint: 'viewLinc overview / dashboard. Top menu: Sites, Alarms, Reports, Events, Admin. Left tree shows the Sites hierarchy.' },
    { name: 'viewlinc-sites',         urlMatch: /\/sites\b|#sites/i,
      hint: 'Sites page. Tree of zones → locations. Each location row shows current value, units, device, threshold status, alarm status.' },
    { name: 'viewlinc-sites-manager', urlMatch: /sites[-_ ]?manager|\/admin\/sites/i,
      hint: 'Admin > Sites Manager. Tree on left, tabs on right: Properties, Threshold Alarm Settings, Communication Alarms, Calibration. Threshold edits live here.' },
    { name: 'viewlinc-alarms',        urlMatch: /\/alarms\b|#alarms/i,
      hint: 'Alarms page. Active + acknowledged tabs. Columns: ID, location, type (Threshold/Communication/Device), severity, value, threshold, started, acknowledged.' },
    { name: 'viewlinc-event-log',     urlMatch: /\/events?\b|\/event[-_ ]?log|#events/i,
      hint: 'Event Log. Audit trail. Filter by event type. Columns: ID, type, time, user, location, description. OQ 9.2 evidence source.' },
    { name: 'viewlinc-reports',       urlMatch: /\/reports?\b|#reports/i,
      hint: 'Reports module. Build temperature/humidity/excursion reports across locations + date ranges.' },
    { name: 'viewlinc-admin',         urlMatch: /\/admin\b|#admin/i,
      hint: 'Admin section. Users, Groups, Hosts, Devices, Sites, Email/SMS, Schedules, Audit, License.' },
    { name: 'viewlinc-devices',       urlMatch: /\/devices?\b/i,
      hint: 'Admin > Devices. Lists RFL100 dataloggers + their channels. Strict 1:1 channel→location binding enforced.' },
    { name: 'viewlinc-email-settings',urlMatch: /\/email|\/notifications?|smtp/i,
      hint: 'Email relay configuration. SMTP host, port, sender, optional auth. OQ 9.12/9.15 depend on this being correctly configured.' },
  ],

  knownSelectors: {
    // Top chrome
    topMenuSites:              'a[href*="sites" i], #menu-sites, [data-menu="sites"]',
    topMenuAlarms:             'a[href*="alarms" i], #menu-alarms, [data-menu="alarms"]',
    topMenuReports:            'a[href*="reports" i], #menu-reports',
    topMenuEvents:             'a[href*="events" i], a[href*="event-log" i], #menu-events',
    topMenuAdmin:              'a[href*="admin" i], #menu-admin, [data-menu="admin"]',
    adminMenuSitesManager:     'a:has-text("Sites Manager"), [href*="sites-manager" i], li[data-menu="sites-manager"] a',

    // Sites tree + location list
    sitesTree:                 '.sites-tree, #sitesTree, [role="tree"]',
    sitesTreeNode:             '.sites-tree li, [role="treeitem"]',
    locationRow:               'tr.location-row, .location-list tr, [data-row-type="location"]',
    locationNameCell:          'td.location-name, td:first-of-type a',
    locationValueCell:         'td.current-value, td.reading, td[data-col="value"]',
    locationDeviceStatusCell:  'td.device-status, td[data-col="deviceStatus"]',
    locationThresholdStatus:   'td.threshold-status, td[data-col="thresholdStatus"]',
    locationAlarmStatus:       'td.alarm-status, td[data-col="alarmStatus"]',

    // Sites Manager — threshold alarm settings tab
    sitesManagerLocationTree:  '.sites-manager-tree, #sitesManagerTree, .tree-pane',
    tabThresholdAlarmSettings: 'a:has-text("Threshold Alarm"), li:has-text("Threshold Alarm") a, [data-tab="thresholdAlarms"]',
    thresholdsList:            '.thresholds-list, table.thresholds, [data-list="thresholds"]',
    thresholdRow:              '.thresholds-list tr, [data-row-type="threshold"]',
    thresholdAddButton:        'button:has-text("Add"), button[title*="Add" i], button.add-threshold, .toolbar button[aria-label*="add" i]',
    thresholdEditButton:       'button:has-text("Edit"), .threshold-row button.edit',
    thresholdDeleteButton:     'button:has-text("Delete"), button:has-text("Remove"), .threshold-row button.delete',
    thresholdSaveButton:       'button:has-text("Save"), button:has-text("OK"), .modal-footer button.btn-primary',
    thresholdCancelButton:     'button:has-text("Cancel"), .modal-footer button.btn-secondary',

    // Threshold editor dialog fields
    thresholdNameInput:        'input[name*="name" i], input[placeholder*="Name" i], #thresholdName',
    thresholdHighInput:        'input[name*="high" i]:not([name*="high-high" i]), [aria-label*="High" i]:not([aria-label*="High-High" i]) input',
    thresholdHighHighInput:    'input[name*="hh" i], input[name*="high-high" i], [aria-label*="High-High" i] input',
    thresholdLowInput:         'input[name*="low" i]:not([name*="low-low" i]), [aria-label*="Low" i]:not([aria-label*="Low-Low" i]) input',
    thresholdLowLowInput:      'input[name*="ll" i], input[name*="low-low" i], [aria-label*="Low-Low" i] input',
    thresholdEnabledCheckbox:  'input[type="checkbox"][name*="enable" i], input[type="checkbox"][aria-label*="enable" i]',
    thresholdDelayInput:       'input[name*="delay" i], input[placeholder*="delay" i], input[name*="notification-delay" i]',

    // Notification recipients section inside threshold editor
    notifyRecipientsList:      '.notify-recipients, [data-section="recipients"] ul, .recipients-list',
    notifyAddRecipientBtn:     'button:has-text("Add Recipient"), button:has-text("Add Contact"), .recipients button.add',
    notifyEmailInput:          'input[type="email"], input[name*="email" i], input[placeholder*="email" i]',
    notifyMethodEmail:         'input[type="radio"][value*="email" i], select[name*="method" i] option[value*="email" i]',

    // Alarms page
    alarmsTable:               '.alarms-table, table.active-alarms, #alarmsTable',
    alarmsActiveTab:           'a:has-text("Active"), .alarms-tabs [data-tab="active"]',
    alarmsAcknowledgedTab:     'a:has-text("Acknowledged"), .alarms-tabs [data-tab="acknowledged"]',
    alarmRow:                  '.alarms-table tr, tr.alarm-row',
    alarmIdCell:               'td.alarm-id, td[data-col="id"], td:first-of-type',
    alarmTypeCell:             'td.alarm-type, td[data-col="type"]',
    alarmLocationCell:         'td.alarm-location, td[data-col="location"]',
    alarmValueCell:            'td.alarm-value, td[data-col="value"]',
    alarmThresholdCell:        'td.alarm-threshold, td[data-col="threshold"]',
    alarmStartedCell:          'td.alarm-started, td[data-col="started"]',
    alarmAckButton:            'button:has-text("Acknowledge"), button.acknowledge, [aria-label*="acknowledge" i]',
    alarmAckCommentInput:      'textarea[name*="comment" i], textarea[placeholder*="comment" i], textarea[placeholder*="reason" i]',

    // Event Log
    eventLogTable:             '.event-log-table, #eventLogTable, table.events',
    eventLogRow:               '.event-log-table tr, tr.event-row',
    eventIdCell:               'td.event-id, td:first-of-type',
    eventTimeCell:             'td.event-time, td[data-col="time"]',
    eventTypeCell:             'td.event-type, td[data-col="type"]',
    eventLogFilterType:        'select[name*="type" i], .event-filters select.type',
    eventLogFilterDateFrom:    'input[name*="from" i][type="date"], input.date-from',
    eventLogFilterDateTo:      'input[name*="to" i][type="date"], input.date-to',
    eventLogRefreshButton:     'button:has-text("Refresh"), button[aria-label*="refresh" i]',

    // Admin > Email / Notifications
    emailRelayHostInput:       'input[name*="smtp" i][name*="host" i], input[name*="relay-host" i]',
    emailRelayPortInput:       'input[name*="port" i]',
    emailRelaySenderInput:     'input[name*="sender" i], input[name*="from" i]',
    emailRelayTestButton:      'button:has-text("Test"), button:has-text("Send Test")',

    // Modal / dialog generic chrome
    modalDialog:               '.modal, [role="dialog"], .ui-dialog',
    modalTitle:                '.modal-title, .ui-dialog-title, .modal-header h3',
    modalCloseX:               '.modal-header button.close, .ui-dialog-titlebar-close, [aria-label="close" i]',
    confirmDialogYes:          'button:has-text("Yes"), button:has-text("Confirm"), .confirm-dialog .btn-primary',
    confirmDialogNo:           'button:has-text("No"), button:has-text("Cancel"), .confirm-dialog .btn-secondary',
  },

  waitStrings: {
    loading:       ['Loading', 'Please wait'],
    saving:        ['Saving', 'Saved'],
    processing:    ['Processing', 'Acknowledging'],
  },

  knownGotchas: [
    'viewLinc enforces strict 1:1 channel→location mapping. NEVER re-link a channel that is already linked to a production location.',
    'NEVER acknowledge a real production alarm — only OQ-prefixed test alarms (alarm name begins with "OQ-").',
    'NEVER delete a threshold the operator did not just create. Pre-existing thresholds are part of the regulated configuration.',
    'Threshold editor sometimes opens in a new dialog frame — wait for "Save" to appear, do not race the input fields.',
    'After Save, viewLinc may take up to 5 minutes for the alarm to fire and the notification email to send. Use wait_for_text on the Alarms page rather than polling rapidly.',
    'Email tab is a SEPARATE BROWSER TAB (not in viewLinc). When the goal asks to check inbox, switch tabs — do not search for an inbox inside viewLinc.',
    'Acknowledgement may require a comment in the textarea — leave it as "OQ test acknowledgement" or whatever the goal specifies.',
    'Event Log entries are append-only. Record max Event ID before/after to detect new entries.',
  ],

  liveDataCaveats:
    'GxP-regulated system. Every action is logged in the Event Log with timestamp + user. Treat every write (threshold add, threshold delete, alarm ack) as an auditable event. The Event Log evidence IS the OQ deliverable.',

  // Mismatch hints — common phrasings that suggest the user is thinking of
  // a different UI (e.g., legacy viewLinc 4.x menu path). Adaptive Prompts
  // surfaces these so the rewriter can correct the goal text.
  mismatchHints: [
    { pattern: /\bConfigure\s*>\s*Thresholds?\b/i, onbox: 'Configure > Thresholds', nsm: 'Admin > Sites Manager > [location] > Threshold Alarm Settings' },
    { pattern: /\bDevices?\s*>\s*Threshold/i,      onbox: 'Devices > Threshold',    nsm: 'Admin > Sites Manager > [location] > Threshold Alarm Settings' },
    { pattern: /\bManage\s+Channels\b/i,           onbox: 'Manage Channels',         nsm: 'Admin > Devices (read-only — DO NOT re-link channels)' },
    { pattern: /\bAlarm\s+Templates?\b/i,          onbox: 'Alarm Templates',         nsm: 'Threshold Alarm Settings tab on the target Location' },
  ],

  rewriteInstructions: [
    'Always pause to identify a TEST LOCATION before creating any threshold. The location must have a current numeric reading and must not currently be in an active threshold alarm state.',
    'Test thresholds MUST be named with the prefix "OQ-" so they can be safely cleaned up later without ambiguity (the cleanup step relies on this prefix).',
    'When creating a HIGH threshold for OQ testing, set the threshold value to (current_reading - 2°C) so it fires immediately. For LOW thresholds, set to (current_reading + 2°C).',
    'After Save, navigate to the Alarms page and use wait_for_text on the new threshold name (e.g., "OQ-9.12-TEST") before declaring the alarm fired. Up to 5-minute fire delay is expected.',
    'For email-receipt verification, switch to a separate browser tab pointing at the recipient mailbox — do NOT look for an inbox inside viewLinc itself.',
    'CLEANUP IS MANDATORY: every OQ-prefixed threshold created must be deleted in the cleanup phase. Verify the location has only its pre-existing thresholds restored. Never delete a threshold whose name does NOT start with "OQ-".',
    'When the operator has provided PICKUP CONTEXT listing previously-completed steps, treat those as already done — do NOT re-create the OQ-TEST-ALARM-001 location, do NOT re-link channels, do NOT redo IQ tests.',
    'Record every alarm ID, threshold value, email subject, and timestamp in the finish summary. Defensibility requires the Event Log + report cross-reference.',
  ],

  workflowHints: [
    {
      match: /sensor.*reading|current.*reading|temperature.*reading|humidity.*reading|location.*value/i,
      hint: 'Phase 1: Navigate to the Views tab and locate the target location in the location tree. Phase 2: Click the location to open its current readings panel. Phase 3: Extract the current value, unit, channel name, and timestamp. Check whether the reading is within the configured threshold range (no active alarms). Save to memory key viewlinc_reading_<location>.',
    },
    {
      match: /alarm.*history|alarm.*log|alarm.*event|past.*alarm|alarm.*report/i,
      hint: 'Phase 1: Navigate to the Alarms tab (or Reports > Alarm History). Phase 2: Set the time range filter to the relevant window. Filter by location or device if needed. Phase 3: For each alarm entry, extract: location name, alarm name, alarm type (High/Low/Offline), start time, end time, and acknowledged-by. Phase 4: Export or save the alarm list to memory key viewlinc_alarm_history.',
    },
    {
      match: /report.*generat|create.*report|export.*data|trend.*report|compliance.*report/i,
      hint: 'Phase 1: Navigate to Reports. Phase 2: Select the report template (e.g., "Alarm Summary", "Readings", "Trend"). Phase 3: Configure the report parameters: location(s), time range, and format (PDF/CSV). Phase 4: Click Generate or Run. Wait for the report to render (wait_for_text "Report complete" or for a download link to appear). Save the report metadata to memory key viewlinc_report.',
    },
    {
      match: /threshold.*config|alarm.*threshold|set.*threshold|create.*threshold|limit.*config/i,
      hint: 'Phase 1: Navigate to the target location in the Views tree. Phase 2: Right-click the location (or use the Settings icon) to open Threshold Settings. Phase 3: Click Add Threshold. Fill in: name (use "OQ-" prefix for test thresholds), type (High/Low), value, and delay. Phase 4: Click Save. Navigate to the Alarms tab and wait_for_text the new threshold name before confirming it is active.',
    },
  ],
};
