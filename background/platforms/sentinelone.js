// background/platforms/sentinelone.js
// SentinelOne Singularity Console — v3.44.0 (new)
//
// Covers the S1 management console (sentinelone.net/.sentinelone.com).
// Key features: global hash/IP/URL search, Deep Visibility PowerQuery,
// endpoint management, threat analysis. Critical safety: always verify
// site/scope picker before any action.

// Precompile regex patterns for hot-path detection
const _S1_NET_RE = /sentinelone\.net/i;
const _S1_COM_RE = /(^|\.)sentinelone\.com$/i;
const _S1_SHORT_RE = /s1\.com$/i;
const _S1_GOAL_RE = /\b(sentinelone|singularity)\b/i;

export const sentinelone = {
  id: 'sentinelone',
  label: 'SentinelOne Singularity Console',
  memoryKeyPrefix: 's1_',

  detect(url, goal) {
    if (!url && !goal) return false;
    try {
      const host = new URL(url).host.toLowerCase();
      if (_S1_NET_RE.test(host)) return true;
      if (_S1_COM_RE.test(host)) return true;
      if (_S1_SHORT_RE.test(host)) return true;
    } catch (_e) { /* fall through */ }
    return _S1_GOAL_RE.test(String(goal || ''));
  },

  pageTypes: [
    { name: 's1-dashboard',    urlMatch: /\/dashboard/i,        hint: 'SentinelOne dashboard. Threat summary, alert counts, top insights.' },
    { name: 's1-threats',      urlMatch: /\/threats/i,          hint: 'Threats list. Each row expands: endpoint, agent, AI Confidence, Analyst Verdict, Mitigation status, Originating Process.' },
    { name: 's1-endpoints',    urlMatch: /\/(sentinels|endpoints)/i, hint: 'Endpoints/Sentinels list. Click a row for full detail: OS, agent version, last seen, IP, user.' },
    { name: 's1-deep-visibility', urlMatch: /\/deep-visibility|\/hunting/i, hint: 'Deep Visibility (Hunting). PowerQuery-like query language.' },
    { name: 's1-ranger',       urlMatch: /\/ranger/i,           hint: 'Ranger network discovery. Discovered devices and networks.' },
    { name: 's1-activity',     urlMatch: /\/activity/i,         hint: 'Activity audit log. User actions, policy changes, alerts.' },
  ],

  knownSelectors: {
    // Global search
    globalSearch:           'input[placeholder*="Search" i], input[type="search"], .global-search input',
    // Navigation
    leftNav:                'nav, [class*="sidebar"], [class*="nav-menu"]',
    // Threats table
    threatsTable:           '[class*="threat"][class*="table"], [class*="threat-list"], [role="grid"]',
    threatRow:              '[class*="threat-row"], [role="row"]',
    threatVerdict:          '[class*="verdict"], [class*="analyst"]',
    // Endpoints table
    endpointsTable:         '[class*="endpoint"][class*="table"], [class*="sentinel-list"], [role="grid"]',
    endpointRow:            '[class*="endpoint-row"], [role="row"]',
    // Deep Visibility
    queryInput:             'textarea[class*="query"], [class*="power-query"] textarea, [class*="query-editor"]',
    queryRunButton:         'button:has-text("Run"), button[aria-label*="Run" i]',
    // Scope picker
    scopePicker:            '[class*="scope-picker"], [class*="site-picker"], [aria-label*="scope" i]',
    // Filters
    columnFilter:           '[class*="filter"], .column-header [class*="filter"]',
    // Bulk actions
    bulkActionToolbar:      '[class*="bulk-action"], [class*="selection-toolbar"]',
    checkbox:               'input[type="checkbox"]',
  },

  waitStrings: {
    pageLoaded:         ['Dashboard', 'Sentinels', 'Threats', 'Deep Visibility'],
    searchResults:      ['results', 'Found', 'No results'],
    queryComplete:      ['results', 'Completed', 'Query finished', 'No results'],
    exportComplete:     ['Download', 'exported'],
  },

  needsTargetSelection: false,
  preflightInstructions: '',

  liveDataCaveats: 'SentinelOne console data is near-real-time. Deep Visibility queries may take 10-60 seconds for large time ranges.',

  knownGotchas: [
    'Top-bar global search accepts SHA1, SHA256, MD5 hashes, filenames, IPs, URLs. After typing, press Enter; results appear in a side panel + table view.',
    'Deep Visibility (Hunting) supports a PowerQuery-like language. Common patterns: SrcProcDisplayName contains "process_name", TgtFileSha1 = "hash", SrcProcSignedStatus = "unsigned".',
    'Site/scope picker is top-right. Switch between client tenants. ALWAYS verify you are on the correct site/scope before any action — cross-client data contamination is a serious risk.',
    'Action buttons (Disconnect, Quarantine, Kill, Disable Agent) require role permission and explicit confirmation — DO NOT auto-click these.',
    'Each column header has a filter dropdown; multi-select supported.',
    'Bulk actions: checkbox column on the left; selected rows enable a toolbar.',
    'Search results often paginate — scroll to load more, or use the page selector.',
    'Wait for spinners to clear after Run/Refresh; use wait_for_text on a result count (e.g., "results") with 30000ms timeout.',
  ].join(' '),

  mismatchHints: [],

  rewriteInstructions: `When rewriting goals for SentinelOne:
- Memory keys must begin with 's1_'.
- Always include a scope/site verification step before any modifying action.
- For threat searches, prefer global search first (accepts hashes, IPs, filenames, URLs).
- For hunting queries, note the PowerQuery syntax.
- Preserve the user's deliverable structure exactly.`,

  workflowHints: [
    {
      match: /hash.*lookup|sha1|sha256|md5|malware.*analysis|threat.*search|file.*reputation/i,
      hint: 'Phase 1: Use the global search bar at the top. Type the hash (SHA1/SHA256/MD5), filename, or URL and press Enter. Phase 2: Results appear in a side panel. Extract: detection verdict, AI confidence score, analyst verdict, originating process, affected endpoints. Phase 3: If threat found, check Threats tab for full details and mitigation status.',
    },
    {
      match: /endpoint.*lookup|agent.*status|device.*status|sentinel.*status/i,
      hint: 'Phase 1: Navigate to Sentinels/Endpoints tab. Phase 2: Search for the endpoint by name, IP, or user. Phase 3: Click the row to see full detail: OS, agent version, last seen, IP, user, active threats. Save to memory key s1_endpoint_<name>.',
    },
    {
      match: /deep.*visibility|hunting|query.*process|process.*hunt|query.*activity/i,
      hint: 'Phase 1: Navigate to Deep Visibility tab. Phase 2: Enter PowerQuery in the query editor. Common syntax: SrcProcDisplayName contains "name", TgtFileSha1 = "hash". Phase 3: Click Run, wait up to 60 seconds for results. Phase 4: Extract relevant rows from the results table.',
    },
  ],
};
