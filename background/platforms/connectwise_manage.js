// background/platforms/connectwise_manage.js
// ConnectWise Manage (PSA) — v3.38.0
//
// Covers my.connectwise.com (cloud) and on-premise CW Manage instances.
// CW Manage is an ASP.NET SPA with a left sidebar navigation tree and custom
// Kendo-based grid controls. The primary MSP workflow surfaces are:
// Service Desk (tickets), Companies, Contacts, Configurations, Time Entries.

// Precompile regex patterns for hot-path detection
const _CW_CLOUD_HOST_RE = /my\.connectwise\.com|connectwise\.net|cw\.local/i;
const _CW_ONPREM_HOST_RE = /cw\.manage|connectwisemanage/i;
const _CW_API_PATH_RE = /\/v4_6_release\/services\/system_io\/router\/api\.rails/i;
const _CW_GOAL_RE = /\b(?:connectwise\s+manage|cw\s+manage|cwmanage|connectwise\s+psa)\b/i;

export const connectwiseManage = {
  id: 'connectwise_manage',
  label: 'ConnectWise Manage (PSA)',
  memoryKeyPrefix: 'cwm_',

  detect(url, goal) {
    if (!url && !goal) return false;
    try {
      const u = new URL(url);
      const host = u.hostname;
      if (_CW_CLOUD_HOST_RE.test(host)) return true;
      if (_CW_ONPREM_HOST_RE.test(host)) return true;
      if (_CW_API_PATH_RE.test(u.pathname)) return true;
    } catch (_e) { /* fall through */ }
    return _CW_GOAL_RE.test(String(goal || ''));
  },

  pageTypes: [
    { name: 'cwm-service-desk',   urlMatch: /\/servicedesk|\/ServiceDesk|service.*ticket/i,          hint: 'Service Desk. Ticket queue. Filter bar at top. + button creates new ticket.' },
    { name: 'cwm-ticket',         urlMatch: /\/ServiceDesk\/Tickets\/\d+|serviceticket.*\d+/i,        hint: 'Individual service ticket. Tabs: Summary, Time, Internal Notes, Documents, Tasks.' },
    { name: 'cwm-companies',      urlMatch: /\/Companies|\/company/i,                                 hint: 'Company list. Search by name. Click to open company record.' },
    { name: 'cwm-company-detail', urlMatch: /\/Companies\/\d+|CompanyID=\d+/i,                        hint: 'Company record. Tabs: Overview, Contacts, Configurations, Finance, Agreements.' },
    { name: 'cwm-configurations', urlMatch: /\/Configurations|\/configuration/i,                      hint: 'Configurations (devices). Filter by company, type, status.' },
    { name: 'cwm-time-entry',     urlMatch: /\/TimeEntry|\/timeentry/i,                               hint: 'Time entry. Enter hours billed against ticket or project.' },
    { name: 'cwm-projects',       urlMatch: /\/Project|\/project/i,                                   hint: 'Projects. Gantt chart, phases, and tasks view.' },
    { name: 'cwm-reports',        urlMatch: /\/Reports|\/report/i,                                    hint: 'Reports module. Standard and custom reports with export.' },
    { name: 'cwm-dashboard',      urlMatch: /\/Home|dashboard|\/home/i,                               hint: 'CW Manage home dashboard. My tickets widget, activity feed.' },
  ],

  knownSelectors: {
    // Global chrome
    leftNav:               '#leftNav, .left-nav, nav.sidebar, [id*="leftNav"]',
    searchBox:             'input[id*="Search"], input[placeholder*="Search" i], input[class*="search" i]',
    topBar:                '#topBar, .top-bar, header, [id*="topBar"]',
    addBtn:                'button.add-btn, a.add-btn, [title*="Add" i], button[id*="Add"], a[id*="New"]',

    // Service Desk / Ticket list
    ticketGrid:            '.k-grid[id*="ticket"], [id*="ServiceDeskGrid"], .grid-container table',
    ticketRow:             '.k-grid tr[data-id], tr.k-grid-row, tr[id*="ticket"]',
    filterBar:             '.filter-bar, [id*="filterBar"], .filters-container',
    filterAddBtn:          'button[title*="Filter" i], .add-filter, button[id*="AddFilter"]',
    statusDropdown:        'select[id*="Status"], [data-field="status"]',
    priorityDropdown:      'select[id*="Priority"], [data-field="priority"]',

    // Ticket detail
    ticketSummary:         'input[id*="Summary"], textarea[id*="Summary"], [id*="summaryField"]',
    ticketCompany:         'input[id*="Company"], [id*="companyDropdown"]',
    ticketContact:         'input[id*="Contact"], [id*="contactDropdown"]',
    ticketStatus:          'select[id*="Status"], [id*="statusDropdown"]',
    ticketPriority:        'select[id*="Priority"], [id*="priorityDropdown"]',
    ticketType:            'select[id*="Type"], [id*="typeDropdown"]',
    ticketSubtype:         'select[id*="SubType"], [id*="subtypeDropdown"]',
    ticketSaveBtn:         'button[id*="Save"], button[title*="Save" i], a[id*="Save"]',
    ticketTabBar:          '.ticket-tabs, ul[role="tablist"], [id*="tabContainer"]',
    ticketTimeTab:         'li[data-tab="time"], a[href*="TimeEntry"], [id*="timeTab"]',
    ticketNotesTab:        'li[data-tab="notes"], a[href*="Notes"], [id*="notesTab"]',

    // Time entry
    timeEntryStart:        'input[id*="Start"], [id*="startTime"]',
    timeEntryEnd:          'input[id*="End"], [id*="endTime"]',
    timeEntryHours:        'input[id*="Hours"], [id*="hoursActual"]',
    timeEntryNotes:        'textarea[id*="Notes"], [id*="notesField"]',
    timeEntrySaveBtn:      'button[id*="Save"], button[title*="Save" i]',
  },

  waitStrings: {
    pageReady:       ['Service Desk'],
    ticketSaved:     ['Record Saved'],
    loginPrompt:     ['User Name'],
  },

  commitFlow: ['Save', 'OK'],
  sessionExpiredText: 'Your session has expired',

  knownGotchas: [
    'ConnectWise Manage uses Kendo UI custom dropdowns — click to open, then click to select an item.',
    'The Company field on tickets is a search-as-you-type autocomplete — type company name and click the suggestion.',
    'After editing a ticket, look for a Save button in the header toolbar or at the bottom of the form.',
    'Bulk operations: check the checkbox column to select multiple rows, then use the Actions toolbar at the top.',
    'Configurations (devices) are linked to companies — navigate to the company first, then the Configurations tab.',
    'Time entries are on the Time tab of each ticket. Use "Enter Time" or the + icon.',
  ],

  liveDataCaveats:
    'CW Manage is an ASP.NET SPA. Dropdowns are custom Kendo controls — standard select option selection may not trigger change events. Always click the dropdown, then click the desired option from the popup list.',

  mismatchHints: [
    { pattern: /automate|labtech/i, onbox: 'ConnectWise Automate (RMM)', nsm: 'This is Manage (PSA), not Automate (RMM). Navigate to a separate CW Automate instance for RMM tasks.' },
  ],

  workflowHints: [
    {
      match: /create.*ticket|new.*ticket|open.*ticket|add.*ticket|log.*ticket/i,
      hint: 'Phase 1: Navigate to Service Desk > New Ticket (or click the + button in the Service Desk queue). Phase 2: Fill in Summary, Company (type to autocomplete, then click the suggestion), Contact, Status, Priority, Type, and Subtype. Add internal notes in the Notes tab if needed. Phase 3: Click Save in the header toolbar. Wait for "Record Saved" confirmation. Copy the ticket number from the page title or header and save to memory key cwm_new_ticket_number.',
    },
    {
      match: /time.*entry|log.*time|add.*time|enter.*hours|bill.*time/i,
      hint: 'Phase 1: Navigate to the target service ticket (Service Desk > search by ticket # or company). Phase 2: Click the Time tab on the ticket. Click "Enter Time" or the + icon. Phase 3: Fill in Start time, End time (or Hours Actual), Work Type, and Notes describing the work done. Phase 4: Click Save. Wait for "Record Saved". Verify the time entry appears in the Time tab grid.',
    },
    {
      match: /company.*config|configuration.*lookup|find.*device|asset.*lookup|configuration.*record/i,
      hint: 'Phase 1: Navigate to Companies and search for the client by name. Click the company row to open the company record. Phase 2: Click the Configurations tab on the company record. Phase 3: In the configurations grid, filter by device name, type, or status to locate the asset. Click the configuration row to view the full configuration record (serial number, IP, warranty expiry, linked ticket history). Save key fields to memory key cwm_config_<device_name>.',
    },
    {
      match: /ticket.*status|update.*ticket|change.*ticket.*status|ticket.*priority|escalat/i,
      hint: 'Phase 1: Navigate to the target ticket (Service Desk > search or open by ticket #). Wait for "Service Desk" to appear in the page. Phase 2: Locate the Status and/or Priority dropdowns in the ticket header — these are Kendo UI custom dropdowns, click to open then click to select. Phase 3: Update the Summary or add an internal note on the Notes tab to document the change. Phase 4: Click Save. Wait for "Record Saved".',
    },
    {
      match: /contact.*lookup|find.*contact|contact.*email|contact.*phone/i,
      hint: 'Phase 1: Navigate to Companies > search for the client company. Open the company record. Phase 2: Click the Contacts tab. Phase 3: Locate the contact by name. Click the contact row to open their record — extract name, email, phone, and title. Save to memory key cwm_contact_<last_name>. Alternatively, use the global search (top search bar) and type the contact\'s name directly for a faster lookup.',
    },
  ],
};
