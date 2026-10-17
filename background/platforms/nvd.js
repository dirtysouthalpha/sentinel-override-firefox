// background/platforms/nvd.js
// NIST NVD / CVE Database — v3.44.0 (new)
//
// Covers nvd.nist.gov, cve.mitre.org, and cve.org. The #1 optimization:
// listing pages embed CVE ID, CVSS score, severity, and summary INLINE.
// ONE execute_js on the listing page harvests everything. Do NOT drill
// into detail pages unless the user specifically needs CPE enumeration
// or reference links.

// Precompile regex patterns for hot-path detection
const _NVD_HOST_RE = /nvd\.nist\.gov|cve\.mitre\.org|cve\.org/;
const _NVD_GOAL_RE = /\b(nvd|cve\s*database|nist\s*nvd|cve\s*search)\b/i;

export const nvd = {
  id: 'nvd',
  label: 'NIST NVD / CVE Database',
  memoryKeyPrefix: 'nvd_',

  detect(url, goal) {
    if (!url && !goal) return false;
    try {
      const host = new URL(url).host.toLowerCase();
      if (_NVD_HOST_RE.test(host)) return true;
    } catch (_e) { /* fall through */ }
    return _NVD_GOAL_RE.test(String(goal || ''));
  },

  pageTypes: [
    { name: 'nvd-search',       urlMatch: /nvd\.nist\.gov\/vuln\/search/i,    hint: 'NVD search page. Keyword field for vendor name or CPE filter. Date range selector. Sort by date or relevance.' },
    { name: 'nvd-results',      urlMatch: /nvd\.nist\.gov\/vuln\/search.*results/i, hint: 'NVD search results listing. Each row: CVE ID, CVSS score + severity label, summary description, CNA, date. EXTRACT HERE — do not drill into details unless user needs full CPE/refs.' },
    { name: 'nvd-detail',       urlMatch: /nvd\.nist\.gov\/vuln\/detail/i,    hint: 'CVE detail page. Only visit if user needs full CPE enumeration or reference links. CVSS vector, affected versions (CPE strings), description.' },
    { name: 'cisa-kev',         urlMatch: /cisa\.gov.*known-exploit/i,         hint: 'CISA KEV catalog. Authoritative source for "exploited in the wild" status. Filter by CVE ID.' },
    { name: 'cve-org',          urlMatch: /cve\.org/i,                         hint: 'CVE.org record page. CNA official description but typically NO CVSS score — NVD enriches it.' },
  ],

  knownSelectors: {
    // Search page
    keywordSearchInput:    'input[name="keywordSearch"], input[placeholder*="keyword" i], #keywordSearch',
    cpeFilterInput:        'input[name*="cpe" i], input[placeholder*="CPE" i]',
    dateRangeSelect:       'select[name*="date" i], [class*="date-range"] select',
    sortSelect:            'select[name*="sort" i], [class*="sort"] select',
    searchButton:          'button[type="submit"], input[type="submit"], button:has-text("Search")',
    // Results listing
    resultsTable:          'table, [class*="vuln-table"], [class*="results-table"]',
    resultRow:             'tbody tr, [class*="vuln-row"], [data-testid*="vuln"]',
    cveIdLink:             'a[href*="/vuln/detail/CVE-"], [class*="cve-id"]',
    severityBadge:         '[class*="severity"], [class*="cvss"], [class*="badge"]',
    summaryText:           '[class*="summary"], [class*="description"], p',
    // Detail page
    cvssScoreSection:      '[class*="cvss"], [id*="cvss"], [class*="metric"]',
    cpeSection:            '[class*="cpe"], [class*="affected"], [class*="configurations"]',
    descriptionSection:    '#vulnDescription, [class*="vuln-description"], [class*="description"]',
    referenceLinks:        '[class*="reference"] a, [class*="ref"] a',
  },

  waitStrings: {
    resultsLoaded:        ['CVE-', 'CVSS', 'Published', 'NVD', 'records'],
    detailLoaded:         ['CVSS', 'Description', 'References', 'Configurations'],
    searchComplete:       ['Showing', 'results', 'CVE-'],
  },

  needsTargetSelection: false,
  preflightInstructions: '',

  liveDataCaveats: 'NVD data updates multiple times daily. Very recent CVEs (< 24 hours) may not yet have CVSS scores assigned.',

  knownGotchas: [
    'CRITICAL: When you have the listing data, you are DONE. NVD search results embed each CVE ID, CVSS v3 score (with severity label like "9.8 CRITICAL"), summary description, CNA, and assigned date INLINE in each row. ONE execute_js on the listing page harvests all of this.',
    'DO NOT click into individual CVE detail pages just to "get more detail". Detail pages cost 4-6 steps each and the data is already in the listing. Drilling in is the #1 budget waster on NVD goals.',
    'ONLY drill into a detail page if the user specifically asked for: full CPE enumeration, complete reference link list, or exploit module references/PoC links.',
    'Listing-page extraction: use a SINGLE execute_js to harvest all rows. Target result row containers (tr in vuln-table tbody, or divs with class .row-result-snippet). From each row pull: CVE link text, severity badge, summary paragraph, publish date.',
    'If selectors miss, use document.body.innerText regex: match /^CVE-\\d{4}-\\d{4,7}/ at line starts, capture severity label or numeric score on the next line, capture subsequent lines as description until the next CVE marker.',
    'Detail page extraction only if genuinely needed: CVSS v3 score near "CVSS 3.x Severity and Metrics" header, CVSS vector string starts with "CVSS:3.1/AV:" or "CVSS:3.0/AV:", affected versions as CPE strings in "Known Affected Software Configurations" section.',
    'CISA KEV catalog (cisa.gov/known-exploited-vulnerabilities-catalog) is the authoritative source for "exploited in the wild" status. If a CVE appears in KEV, it has confirmed in-wild exploitation.',
    'CVE.org has CNA official descriptions but typically NO CVSS score — NVD enriches it. Use CVE.org only when NVD is rate-limiting or for very-recent CVEs not yet in NVD.',
    'NEVER fabricate CVSS scores or affected versions when extraction fails. Leave as "not captured" and recommend manual check.',
  ].join(' '),

  rewriteInstructions: `When rewriting goals for NVD/CVE:
- Memory keys must begin with 'nvd_'.
- Default strategy: search on listing page → extract ALL rows with ONE execute_js → finish. Do NOT plan detail-page visits unless user explicitly needs CPE/refs.
- For "find me N CVEs" / "rank by severity" / "give me CVSS scores" — the listing has it all.
- If extraction fails twice with selectors, fall back to body.innerText regex.
- Preserve the user's deliverable structure exactly.`,

  workflowHints: [],
};
