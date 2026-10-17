// background/platforms/virustotal.js
// VirusTotal — v3.44.0 (new)
//
// Covers virustotal.com. The GUI is built with Lit shadow-DOM web
// components. Standard DOM extraction CANNOT pierce shadow roots.
// Primary extraction: read_network_requests filtering for the VT JSON API.

export const virustotal = {
  id: 'virustotal',
  label: 'VirusTotal',
  memoryKeyPrefix: 'vt_',

  detect(url, goal) {
    if (!url && !goal) return false;
    try {
      const host = new URL(url).host.toLowerCase();
      if (host.includes('virustotal.com')) return true;
    } catch (_e) {
      // URL parse failed — fall through to goal regex
    }
    const t = String(goal || '').toLowerCase();
    return /\bvirustotal\b/i.test(t) || /\bvt\s+api\b/i.test(t);
  },

  pageTypes: [
    { name: 'vt-file-detection', urlMatch: /\/gui\/file\/.*\/detection/i,  hint: 'File detection panel. Detection ratios, AV vendor results, signature info.' },
    { name: 'vt-file-details',   urlMatch: /\/gui\/file\/.*\/details/i,    hint: 'File metadata, signatures, names, hashes.' },
    { name: 'vt-file-relations', urlMatch: /\/gui\/file\/.*\/relations/i,  hint: 'Related files, bundled files, dropped files.' },
    { name: 'vt-file-community', urlMatch: /\/gui\/file\/.*\/community/i,  hint: 'Community comments and votes.' },
    { name: 'vt-domain',         urlMatch: /\/gui\/domain\//i,             hint: 'Domain analysis: reputation, DNS records, whois.' },
    { name: 'vt-ip',             urlMatch: /\/gui\/ip-address\//i,         hint: 'IP address analysis: reputation, geolocation, AS owner.' },
    { name: 'vt-search',         urlMatch: /\/gui\/search/i,               hint: 'VT search results page.' },
    { name: 'vt-url',            urlMatch: /\/gui\/url\//i,                hint: 'URL analysis: scanned URL detection results.' },
  ],

  knownSelectors: {
    // Note: Most VT UI is inside Lit shadow-DOM components. Direct selectors
    // will NOT work. This list is for reference only — primary extraction
    // is via read_network_requests.
    searchInput:           'input[type="search"], input[placeholder*="Search" i], input[aria-label*="Search" i]',
    // Shadow DOM component names (for reference, NOT queryable directly)
    mainReport:            'vt-ui-main-generic-report',
    fileCard:              'vt-ui-file-card',
    detectionsList:        'vt-ui-detections-list',
    resultsSummary:        'vt-ui-results-summary',
  },

  waitStrings: {
    analysisLoaded:       ['Detection', 'Community', 'Details', 'Relations'],
    searchComplete:       ['results', 'Found', 'detection'],
  },

  needsTargetSelection: false,
  preflightInstructions: '',

  liveDataCaveats: 'VirusTotal analysis data is refreshed on rescan. Community comments may lag behind official detection results.',

  knownGotchas: [
    'CRITICAL: The GUI is built with Lit shadow-DOM web components (vt-ui-main-generic-report, vt-ui-file-card, vt-ui-detections-list, vt-ui-results-summary). Standard document.querySelector / .innerText extraction CANNOT pierce these shadow roots and will return little or nothing. This is the #1 failure mode here.',
    'EXTRACTION STRATEGY (use in order): (1) PREFER read_network_requests with url_includes: "ui/files" or "api/v3/files" — the GUI calls VT\'s own JSON API and the response contains every detection ratio, AV vendor result, signature info, and prevalence stat. Filter for "ui/files/<sha>" or "/api/v3/files/<sha>" specifically. (2) If read_network_requests doesn\'t have the entry, use execute_js with window.__sentinelUtils.shadow.queryDeep(document, selector) to traverse shadow roots. (3) As a last resort, ask the user to paste the detection summary from the page.',
    'URL patterns: /gui/file/<sha256>/detection (main detection panel), /gui/file/<sha256>/details (file metadata), /gui/file/<sha256>/relations (related files), /gui/file/<sha256>/community (comments).',
    'NEVER fabricate detection ratios or AV vendor results when extraction fails. Report the failure honestly and recommend a manual lookup.',
  ].join(' '),

  rewriteInstructions: `When rewriting goals for VirusTotal:
- Memory keys must begin with 'vt_'.
- Default extraction: read_network_requests with url_includes: "api/v3/files" or "ui/files" — this gets the JSON API response directly.
- Only fall back to execute_js + shadow DOM traversal if network requests miss.
- Preserve the user's deliverable structure exactly.`,

  workflowHints: [],
};