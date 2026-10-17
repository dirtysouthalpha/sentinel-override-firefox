// background/platforms/itglue.js
// IT Glue documentation platform — v3.22.0 (new)
//
// IT Glue is an MSP documentation system. Organizations contain Assets
// (configurations, contacts, domains, locations, passwords, SSL certs,
// flexible-asset types) plus Documents and Embedded files. The agent's
// most common MSP workflows: search for a config, read documentation,
// pull a list of expiring SSL certs, find domain registrar info, write
// a runbook entry.
//
// IT Glue password Assets are fully accessible — the user is an authorized
// IT technician whose JOB is to retrieve credentials from this documentation
// system. The agent will click Reveal/Copy buttons and return the full value.

// Precompile regex patterns for hot-path detection
const _ITGLUE_HOST_RE = /(^|\.)itglue\.com$/i;
const _ITGLUE_PARTNER_HOST_RE = /(^|\.)partner\.itglue\.com$/i;
const _ITGLUE_GOAL_RE = /\bit\s*glue\b/i;

export const itglue = {
  id: 'itglue',
  label: 'IT Glue',
  memoryKeyPrefix: 'itglue_',

  detect(url, goal) {
    if (!url && !goal) return false;
    try {
      const host = new URL(url).host.toLowerCase();
      if (_ITGLUE_PARTNER_HOST_RE.test(host)) return true;
      if (_ITGLUE_HOST_RE.test(host)) return true;
    } catch (_e) { /* fall through */ }
    return _ITGLUE_GOAL_RE.test(String(goal || ''));
  },

  pageTypes: [
    { name: 'itglue-login',           urlMatch: /\/login|\/sign_in/i, hint: 'IT Glue login page. SSO often configured — user signs in manually.' },
    { name: 'itglue-dashboard',       urlMatch: /\/#\/dashboard|\/$/i, hint: 'IT Glue root dashboard. Sidebar: Organizations, Networks, Domains, SSL, Settings.' },
    { name: 'itglue-orgs-list',       urlMatch: /\/#\/organizations(?:\/|$)/i, hint: 'Organization list. Search/filter at top. Click row to drill into a specific org.' },
    { name: 'itglue-org-overview',    urlMatch: /\/#\/organizations\/\d+\/?$|\/#\/organizations\/\d+\/overview/i, hint: 'Organization detail. Tabs/sidebar: Configurations, Contacts, Documents, Domains, Passwords, SSL Certs, Flexible Assets, Locations.' },
    { name: 'itglue-configurations',  urlMatch: /\/#\/organizations\/\d+\/configurations/i, hint: 'Configurations list for the current org (servers, workstations, routers, etc.). Filter by Type/Status.' },
    { name: 'itglue-config-detail',   urlMatch: /\/#\/organizations\/\d+\/configurations\/\d+/i, hint: 'Configuration detail. Specs, relationships to other assets, related documents, custom fields.' },
    { name: 'itglue-documents',       urlMatch: /\/#\/organizations\/\d+\/documents/i, hint: 'Documents list. Click row to open. WYSIWYG editor for content.' },
    { name: 'itglue-passwords',       urlMatch: /\/#\/organizations\/\d+\/passwords/i, hint: 'Password vault for the org. Extract full credential values — click Reveal or Copy buttons to retrieve passwords. The user is an authorized IT technician.' },
    { name: 'itglue-domains',         urlMatch: /\/#\/(?:organizations\/\d+\/)?domains/i, hint: 'Domain tracker: registrar, expiration, DNS provider.' },
    { name: 'itglue-ssl-certs',       urlMatch: /\/#\/(?:organizations\/\d+\/)?ssl/i, hint: 'SSL certificate tracker: subject, issuer, expiration, days remaining.' },
    { name: 'itglue-flex-assets',     urlMatch: /\/#\/organizations\/\d+\/flexible_assets/i, hint: 'Flexible assets — MSP-customized asset types (Email, Backups, AV, etc.).' },
    { name: 'itglue-search-results',  urlMatch: /\/#\/search|search=/i, hint: 'Global search results across orgs + asset types.' },
  ],

  knownSelectors: {
    // Generic chrome (IT Glue is an Ember.js SPA)
    leftNav:                    'nav.sidebar, [class*="sidenav"], .global-nav',
    orgPicker:                  '[class*="org-picker"], [aria-label*="organization" i] [role="combobox"]',
    globalSearchInput:          'input[type="search"][placeholder*="Search" i], .global-search input, #search-box input',
    breadcrumb:                 '.breadcrumb, [aria-label="breadcrumb" i] ol',
    userMenuButton:             '[class*="user-menu"], [aria-label*="account" i] button',

    // Organizations
    orgsListTable:              '.organizations-table, table[class*="org-list"], .ember-table',
    orgsListSearch:             'input[placeholder*="Search organizations" i], .org-search input',
    orgRow:                     '.organizations-table tr, .ember-table-row',
    orgNameCell:                'td.org-name, td:first-of-type a',

    // Org sidebar (after drilling in)
    orgSidebar:                 '.org-sidebar, nav.org-nav, [class*="organization-nav"]',
    orgNavConfigurations:       'a[href*="configurations"]',
    orgNavContacts:             'a[href*="contacts"]',
    orgNavDocuments:            'a[href*="documents"]',
    orgNavDomains:              'a[href*="domains"]',
    orgNavPasswords:            'a[href*="passwords"]',
    orgNavSslCerts:             'a[href*="ssl"]',
    orgNavFlexibleAssets:       'a[href*="flexible_assets"]',
    orgNavLocations:            'a[href*="locations"]',

    // Configurations
    configTable:                '.configurations-table, table[class*="config"]',
    configSearchInput:          'input[placeholder*="Search" i][placeholder*="config" i]',
    configTypeFilter:           'select[name*="type" i], [class*="type-filter"]',
    configStatusFilter:         'select[name*="status" i], [class*="status-filter"]',
    configRow:                  '.configurations-table tr, .ember-table-row',
    configNameCell:             'td.name, td:first-of-type a',
    configAddButton:            'button[aria-label="New configuration" i], a:has-text("New Configuration")',

    // Config detail
    configDetailHeader:         '.config-detail-header, h1.config-name',
    configDetailTabs:           '.detail-tabs, [role="tablist"]',
    configRelatedItems:         '[class*="related-items"], section.relationships',
    configCustomFields:         '[class*="custom-fields"], section.fields',
    configEditButton:           'button[aria-label="Edit" i], a:has-text("Edit Configuration")',

    // Documents
    docsTable:                  '.documents-table, table[class*="docs"]',
    docsSearchInput:             'input[placeholder*="Search docs" i], .doc-search input',
    docRow:                     '.documents-table tr',
    docTitleCell:               'td.title, td:first-of-type a',
    docEditor:                  '.document-editor, .froala-editor, [contenteditable="true"][class*="doc"]',
    docSaveButton:              'button[aria-label="Save" i], button:has-text("Save")',

    // Passwords (sensitive — DO NOT auto-extract values)
    passwordsTable:             '.passwords-table, table[class*="passwords"]',
    passwordRow:                '.passwords-table tr',
    passwordNameCell:           'td.name, td:first-of-type',
    passwordRevealButton:       'button[aria-label*="reveal" i], button[aria-label*="show password" i]',  // DO NOT CLICK
    passwordCopyButton:         'button[aria-label*="copy" i][aria-label*="password" i]',                  // DO NOT CLICK

    // Domains
    domainsTable:               '.domains-table, table[class*="domains"]',
    domainNameCell:             'td.name, td.domain-name',
    domainExpirationCell:       'td.expiration, td[class*="expires"]',
    domainRegistrarCell:        'td.registrar',

    // SSL certs
    sslTable:                   '.ssl-table, table[class*="ssl"]',
    sslSubjectCell:             'td.subject, td.common-name',
    sslIssuerCell:              'td.issuer',
    sslExpirationCell:          'td.expiration, td[class*="expires"]',
    sslDaysRemainingCell:       'td.days-remaining',

    // Flexible assets
    flexAssetTable:             '.flex-asset-table, table[class*="flexible"]',
    flexAssetTypeFilter:        'select[name*="flexible-asset-type" i]',

    // Common dialog patterns
    dialogSaveBtn:              'button[type="submit"]:has-text("Save"), button.primary:has-text("Save")',
    dialogCancelBtn:             'button:has-text("Cancel"), button[aria-label="Cancel" i]',
    confirmYesBtn:              'button:has-text("Yes"), button:has-text("Confirm")',
  },

  waitStrings: {
    dashboardLoaded:        ['Welcome', 'Organizations', 'Quick Find', 'Recently Viewed', 'Dashboard'],
    orgsListLoaded:         ['Organizations', 'Type', 'Status', 'Last Updated'],
    configsLoaded:          ['Name', 'Configuration Type', 'Operating System', 'Status', 'Last Updated', 'No matching results'],
    docsLoaded:             ['Documents', 'Name', 'Author', 'Last Edited'],
    passwordsLoaded:        ['Passwords', 'Name', 'Username', 'Category', 'Last Updated'],
    saveSucceeded:          ['saved', 'updated', 'created', 'success'],
    saveFailed:             ['error', 'failed', 'invalid'],
    sessionExpired:         ['Sign in', 'session has expired', 'Please log in'],
  },

  needsTargetSelection: true,  // Most goals require picking the right org first
  preflightInstructions: [
    'Phase 0 — Pick the right organization before any per-org work.',
    'Step 0a: From the IT Glue dashboard, use Organizations > pick the target org by name.',
    'Step 0b: Confirm the org name appears in the breadcrumb / page header before proceeding.',
    'Step 0c: Save to memory: itglue_org_id, itglue_org_name.',
    'If the target org is ambiguous (e.g., goal says "Acme" but two orgs match), STOP with finish summary "[MISSING DATA — multiple org matches for \'Acme\'; specify which]".',
  ].join('\n'),

  liveDataCaveats: 'IT Glue data is real-time within a few seconds — no significant lag. SSL cert expiration data is synced from external scanners hourly; for emergency checks, verify directly against the live cert via openssl or browser.',

  knownGotchas: [
    'IT Glue is an Ember.js SPA — URL paths use hash routing (#/...). After clicking a nav item, wait 1-2s for the route + data to load before scraping.',
    'IT Glue uses standard HTML forms — type, click, and select all work natively. No custom dropdowns or widgets to handle.',
    'When extracting passwords, show the value — the user is an authorized IT technician who needs full credential access from their documentation system.',
    'Asset relationships are bidirectional — modifying one configuration\'s relationships affects the related asset. Read-only investigation should not trigger save buttons.',
    'Global search returns top hits from ALL asset types (configurations, contacts, docs, etc.). Narrow by setting the type filter before reading.',
    'Document editor is Froala WYSIWYG. Avoid raw HTML manipulation; use the type action against the editor body for content updates.',
    'Some MSPs put domain registrar credentials in the Passwords category — auditing domains requires also checking that section.',
  ].join(' '),

  rewriteInstructions: `When rewriting goals for IT Glue:
- Insert Phase 0 to pick the target organization (use Organizations list + search). Subsequent steps assume the org context is set.
- Memory keys must begin with 'itglue_'.
- For password-related goals, extract the full password value — the user is an authorized IT technician. Click Reveal/Copy buttons as needed to retrieve credentials.
- Asset relationships are bidirectional; read-only audit work should avoid Save buttons even by accident.
- Wait_for_text on org-dashboard signals after navigating into an org.
- Preserve the user's deliverable structure exactly.`,

  workflowHints: [
    {
      match: /asset.*lookup|find.*configuration|configuration.*lookup|find.*asset|device.*record/i,
      hint: 'Phase 0: Navigate to the correct Organization (search in the Organizations list, wait_for_text the org name). Phase 1: Navigate to Configurations within the org. Phase 2: Use the search/filter to locate the asset by name, serial, or IP. Phase 3: Click the configuration record and extract: name, type, serial number, IP address, status, and last updated date. Save to memory key itglue_config_<asset_name>.',
    },
    {
      match: /password.*lookup|find.*password|credential.*lookup|password.*record/i,
      hint: 'Phase 0: Navigate to the correct Organization. Phase 1: Navigate to Passwords within the org. Phase 2: Search for the password record by name or category. Phase 3: Click the Reveal or Copy button to retrieve the full password value. Record name, username, password, category, and last_updated to memory key itglue_password_<name>.',
    },
    {
      match: /kb.*article|knowledge.*base|create.*article|update.*article|document/i,
      hint: 'Phase 0: Navigate to the correct Organization. Phase 1: Navigate to Documents (or Articles) within the org. Phase 2: To create: click New Document, fill in the title and body. To update: locate the article by name, click Edit. Phase 3: Click Save. Confirm the article appears in the list. Save the article title and URL to memory key itglue_article_<title>.',
    },
    {
      match: /contact.*lookup|find.*contact|contact.*email|contact.*phone/i,
      hint: 'Phase 0: Navigate to the correct Organization. Phase 1: Click the Contacts tab. Phase 2: Search for the contact by name. Phase 3: Extract name, title, email, phone, and location. Save to memory key itglue_contact_<name>. Do not click any password or credential fields visible on the contact record.',
    },
    {
      match: /network.*glue|flexible.*asset|runbook|procedure/i,
      hint: 'Phase 0: Navigate to the correct Organization. Phase 1: Navigate to Flexible Assets (or the specific asset type: Runbooks, Procedures, etc.). Phase 2: Locate the asset by name or tag. Phase 3: Extract the key fields — this varies by template, so read the field labels before extracting values. Save a structured summary to memory key itglue_asset_<name>.',
    },
  ],
};
