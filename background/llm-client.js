// Sentinel Override v3 — LLM Client
// API calls, retry logic, response parsing, vision detection, platform context.
// Imports from message-protocol.js only (no circular dependency risk).

import { sendSilentUpdate } from './message-protocol.js';
import { getAllTabContexts, getActiveTabId, TAB_LIMIT } from './tab-context.js';
import { resolveProvider, getActiveProvider, getModelSupportsVision } from './provider-registry.js';
import { getPlatformProfile } from './platforms/index.js';
import { getErrorMessage, sleep } from './error-utils.js';
import { prepareVision, onVisionRejection, onVisionSuccess } from './vision-adapter.js';
import { resolveSystemPrompt } from './remote-config.js';
// (O4/A1) Cross-run endpoint cooldown breaker — keeps the endpoint resting
// between runs; the SO-94 fail-streak below aborts the run itself.
import { endpointBreaker } from './endpoint-breaker.js';

// v20.1: system prompt = provider tweak merged with any remote-config patch
// (Claude-in-Chrome-style server-config prompts, over SO's storage).
async function _effectiveSystemPrompt(provider) {
  try {
    const _st = (typeof chrome !== 'undefined' && chrome.storage) ? chrome.storage.local : null;
    return await resolveSystemPrompt(provider.systemPromptTweak, _st);
  } catch (_e) {
    return provider.systemPromptTweak;
  }
}
import { API_TIMEOUT_MS, PLATFORM_CTX_CACHE_TTL_MS, ONE_SECOND_MS, TWO_SECONDS_MS, VISION_FETCH_TIMEOUT_MS } from './constants.js';
import { validateAction } from './action-schema.js';

// Constants for response parsing - avoid recreating on every call
const VALID_ACTION_TYPES = new Set(['click', 'type', 'navigate', 'scroll', 'select', 'hover', 'press_key',
  'extract', 'extract_list', 'wait', 'wait_for_text', 'wait_for_element', 'wait_for_navigation',
  'execute_js', 'read_page', 'note', 'finish', 'open_tab', 'switch_tab', 'close_tab',
  'dismiss_overlay', 'switch_to_frame', 'switch_to_parent_frame', 'drag_and_drop', 'right_click', 'double_click',
  'navigate_back', 'navigate_forward',
  'click_at', 'scroll_to', 'check', 'check_all', 'open_dropdown', 'upload_file',
  'read_console_messages', 'read_network_requests',
  'drag_at', 'right_click_at', 'double_click_at', 'scroll_at', 'zoom_at', 'triple_click_at',
  'lookup', 'run_remote_command', 'verify', 'repeat_for_each',
  'smart_navigate', 'batch', 'find']);

// Exported so tests can assert parity with background/action-schema.js
// (ACTION_SCHEMA). The two must not drift: the schema is the field-level
// description, this set is the accept/reject gate.
export { VALID_ACTION_TYPES };

// Precompiled regex for extracting JSON from markdown code blocks
const CODE_BLOCK_REGEX = /```(?:json)?\s*\n?([\s\S]*?)\n?```/;

// Precompiled regex patterns for platform detection (performance optimization)
const SONICWALL_TEXT_RE = /sonicwall|sonicos/;
const SONICWALL_PATH_RE = /\/ui\b|#\/dashboard|#\/firewall|#\/network|#\/security/;
const FORTINET_URL_RE = /fortinet|fortigate|fortimanager/;
const FORTINET_TEXT_RE = /fortinet|fortigate/;

// Precompiled regex patterns for plan parsing (performance optimization)
const WHITESPACE_REPLACE_RE = /\s+/g;

// Precompiled regex patterns for salvaging finish/note from malformed LLM responses
const FINISH_SALVAGE_REGEX = /"summary"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/m;
const NOTE_SALVAGE_REGEX = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/m;
const CISCO_URL_RE = /cisco|\/asdm|\/fmc|meraki|\.ise\./;
const CISCO_TEXT_RE = /cisco asa|firepower|meraki|cisco ise/;
const PALOALTO_URL_RE = /paloalto|panorama|\/php\/rest\/pan/;

// Precompiled regex patterns for vision support detection (performance optimization)
const GPT_3_5_RE = /^gpt-3\.5/i;
const CLAUDE_3_HAIKU_TEXT_RE = /^claude-3-haiku-text/i;
const CLAUDE_2_RE = /^claude-2(\b|-)/i;
const CLAUDE_INSTANT_RE = /^claude-instant/i;
const TEXT_ONLY_RE = /-text-only$/i;
const CLAUDE_OPUS_SONNET_RE = /\bclaude-(opus|sonnet|haiku|3|4|5)\b/i;
const GPT_4_RE = /\bgpt-(4o|4\.1|4-vision|5|o\d)\b/i;
const GEMINI_RE = /\bgemini\b/i;
const QWEN_VL_RE = /\bqwen[\w.-]*-vl\b/i;
const LLAVA_RE = /\bllava\b/i;
const VISION_RE = /vision/i;
const VL_DASH_RE = /-vl-/i;
const VL_END_RE = /-vl$/i;
const PALOALTO_TEXT_RE = /palo alto|pan-os|panorama/;
const SENTINELONE_URL_RE = /sentinelone\.net|\.sentinelone\.com|s1\.com/;
const SENTINELONE_TEXT_RE = /sentinelone|singularity/;
const NVD_URL_RE = /(nvd\.nist\.gov|cve\.mitre\.org|cve\.org)/;
const VIRUSTOTAL_URL_RE = /virustotal\.com|vt-api/;
const VIRUSTOTAL_TEXT_RE = /virustotal| vt /;
const M365_ADMIN_URL_RE = /admin\.microsoft\.com|admin\.exchange\.microsoft\.com|admin\.exchange\.outlook\.com|compliance\.microsoft\.com|security\.microsoft\.com|purview\.microsoft\.com/;
const ENTRA_URL_RE = /entra\.microsoft\.com|aad\.portal\.azure\.com|myapps\.microsoft\.com/;
const ENTRA_TEXT_RE = /entra/;
const AZURE_AD_TEXT_RE = /azure ad/;
const MICROSOFT_URL_RE = /microsoft/;
const AZURE_PORTAL_RE = /portal\.azure\.com|preview\.portal\.azure\.com/;
const CONNECTWISE_URL_RE = /connectwise|cw\.manage|my\.connectwise|cwautomate/;
const CONNECTWISE_TEXT_RE = /connectwise/;
const DATTO_URL_RE = /datto|centrestage|autotask|adra/;
const DATTO_TEXT_RE = /datto rmm|autotask/;
const ITGLUE_RE = /itglue|it-glue/;
const HUNTRESS_RE = /huntress/;
const SCREENCONNECT_URL_RE = /screenconnect|connectwisecontrol/;
const SCREENCONNECT_TEXT_RE = /screenconnect/;
const GENERIC_NETWORK_RE = /firewall|router|switch|access point|management ui|admin panel|web ui/;

// Precompiled regex patterns for intent parsing (performance optimization)
const FORECAST_QUERY_RE = /(?:forecast|weather|search|find|look\s*up|about)\s+(?:for\s+)?["']?([^"',]+?)["']?\s*(?:\s+(?:and|then|,|\.|in\s+a|summar|$))/i;
const FOR_ABOUT_QUERY_RE = /(?:for|about)\s+(.+?)(?:\s+(?:and|then|,|\.|$))/i;
const NAVIGATE_URL_RE = /navigate\s+(?:to\s+)?(?:the\s+)?(?:url\s+)?["']?(https?:\/\/[^\s"'\])\]]+)/i;
const NAVIGATE_SITE_RE = /(?:go|navigate)\s+(?:to\s+)?(?:the\s+)?(amazon|reddit|youtube|google|twitter|github|wikipedia|hackernews|hacker\s+news|cnn|bbc|nytimes|weather\.gov|stackoverflow|facebook|instagram|linkedin)[\s.,)]/i;
const ARTICLE_GOAL_RE = /\b(?:top|first|best|recent)\s+(\d{1,2})\s+(articles?|stories|posts?|items?|headlines?|results?)\b/i;

// Site name to domain mapping - avoid recreating on every call
const SITE_DOMAIN_MAP = {
  amazon: 'amazon.com',
  reddit: 'reddit.com',
  youtube: 'youtube.com',
  google: 'google.com',
  twitter: 'twitter.com',
  github: 'github.com',
  wikipedia: 'wikipedia.org',
  hackernews: 'news.ycombinator.com',
  'hacker news': 'news.ycombinator.com',
  cnn: 'cnn.com',
  bbc: 'bbc.com',
  nytimes: 'nytimes.com',
  'weather.gov': 'weather.gov',
  stackoverflow: 'stackoverflow.com',
  facebook: 'facebook.com',
  instagram: 'instagram.com',
  linkedin: 'linkedin.com'
};

// Valid JSON escape characters - avoid recreating on every call
const VALID_JSON_ESCAPE_CHARS = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);

// API Health Heartbeat - tracks LLM API responsiveness
const _apiHealth = {
  lastResponseTime: null,
  avgResponseTime: null,
  totalCalls: 0,
  failures: 0,
  _times: [],    // rolling window of last 10 response times
  _lastPing: null,

  record(startTime, ok) {
    const elapsed = Date.now() - startTime;
    this._times.push(elapsed);
    if (this._times.length > 10) this._times.shift();
    this.totalCalls++;
    if (!ok) this.failures++;
    this.lastResponseTime = elapsed;
    this.avgResponseTime = Math.round(this._times.reduce((a, b) => a + b, 0) / this._times.length);
    this._lastPing = Date.now();
    // Emit health status to popup
    try {
      const status = this.getStatus();
      chrome.runtime.sendMessage({ type: 'api_health', ...status }).catch(() => {});
    } catch (_e) { /* popup not open */ }
  },

  getStatus() {
    const now = Date.now();
    const stale = this._lastPing && (now - this._lastPing > 60000);
    let state = 'unknown';
    if (stale || !this._lastPing) state = 'idle';
    else if (this.avgResponseTime && this.avgResponseTime < 5000) state = 'healthy';
    else if (this.avgResponseTime && this.avgResponseTime < 15000) state = 'slow';
    else if (this.failures > 3) state = 'down';
    else if (this._lastPing) state = 'healthy';
    return {
      state,
      avgMs: this.avgResponseTime,
      lastMs: this.lastResponseTime,
      totalCalls: this.totalCalls,
      failures: this.failures,
      timestamp: now
    };
  }
};

// ========== Multi-Portal Investigation Analyzer (3.8.1) ==========
// Detects when a goal mentions 2+ M365/security admin centers (Entra,
// Exchange, Purview, OneDrive, SharePoint, Teams, Intune, Defender, Compliance,
// Azure portal, Sentinel/RMM tools, ConnectWise, etc.) so the planner can
// route to checklist-deliverable + one-portal-execution mode instead of
// trying to cover everything in a single run and inevitably running out.

// Precompile regex patterns for performance optimization
const ENTRA_MP_RE = new RegExp('\\bentra(\\.microsoft|\\s+id)?\\b|\\bazure\\s+ad\\b|\\bsign.?in\\s+logs?\\b|\\baudit\\s+logs?\\b', 'i');
const EXCHANGE_MP_RE = new RegExp('\\bexchange(\\s+online)?\\b|\\bmailbox(\\s+audit)?\\b|\\bmessage\\s+trace\\b|\\binbox\\s+rules?\\b|\\btransport\\s+rules?\\b|\\bmail\\s+flow\\b', 'i');
const PURVIEW_MP_RE = new RegExp('\\bpurview\\b|\\bunified\\s+audit\\s+log\\b|\\bcompliance\\s+(center|search)\\b|\\bedisco\\b|\\bcontent\\s+search\\b', 'i');
const ONEDRIVE_MP_RE = new RegExp('\\bonedrive\\b|\\bone.?drive\\b', 'i');
const SHAREPOINT_MP_RE = new RegExp('\\bsharepoint\\b|\\bsharing\\s+externally\\b', 'i');
const TEAMS_MP_RE = new RegExp('\\bteams(\\s+admin|\\s+chat|\\s+meeting|\\s+call)?\\b', 'i');
const INTUNE_MP_RE = new RegExp('\\bintune\\b|\\bmdm\\b|\\bmem\\b', 'i');
const DEFENDER_MP_RE = new RegExp('\\bdefender(\\s+for\\s+endpoint|\\s+for\\s+identity|\\s+for\\s+cloud)?\\b|\\bmde\\b|\\bdevice\\s+timeline\\b', 'i');
const M365_ADMIN_MP_RE = new RegExp('\\badmin\\.microsoft\\b|\\bm365\\s+admin\\b|\\boffice\\s+365\\s+admin\\b', 'i');
const AZURE_PORTAL_MP_RE = new RegExp('\\bportal\\.azure\\b|\\bazure\\s+portal\\b', 'i');
const SENTINELONE_MP_RE = new RegExp('\\bsentinelone\\b|\\bsingularity\\b|\\bs1\\s+console\\b|\\bdeep\\s+visibility\\b', 'i');
const CONNECTWISE_MP_RE = new RegExp('\\bconnectwise\\b|\\bcw\\.manage\\b|\\bcw\\s+manage\\b', 'i');
const NINJAONE_MP_RE = new RegExp('\\bninjaone\\b|\\bninja\\s+rmm\\b', 'i');
const DATTO_MP_RE = new RegExp('\\bdatto\\b|\\bautotask\\b', 'i');
const ITGLUE_MP_RE = new RegExp('\\bit\\s*glue\\b', 'i');
const HUNTRESS_MP_RE = new RegExp('\\bhuntress\\b', 'i');

const MULTI_PORTAL_DETECTORS = [
  { key: 'entra',          re: ENTRA_MP_RE },
  { key: 'exchange',       re: EXCHANGE_MP_RE },
  { key: 'purview',        re: PURVIEW_MP_RE },
  { key: 'onedrive',       re: ONEDRIVE_MP_RE },
  { key: 'sharepoint',     re: SHAREPOINT_MP_RE },
  { key: 'teams',          re: TEAMS_MP_RE },
  { key: 'intune',         re: INTUNE_MP_RE },
  { key: 'defender',       re: DEFENDER_MP_RE },
  { key: 'm365_admin',     re: M365_ADMIN_MP_RE },
  { key: 'azure_portal',   re: AZURE_PORTAL_MP_RE },
  { key: 'sentinelone',    re: SENTINELONE_MP_RE },
  { key: 'connectwise',    re: CONNECTWISE_MP_RE },
  { key: 'ninjaone',       re: NINJAONE_MP_RE },
  { key: 'datto',          re: DATTO_MP_RE },
  { key: 'itglue',         re: ITGLUE_MP_RE },
  { key: 'huntress',       re: HUNTRESS_MP_RE }
];

/**
 * Detect which admin portals (Entra, Exchange, Defender, etc.) are referenced in a goal string.
 * @param {string} goal - The user's goal text to scan.
 * @returns {string[]} Array of detected portal keys (e.g. ['entra', 'exchange']).
 */
export function detectGoalPortals(goal) {
  if (!goal || typeof goal !== 'string') return [];
  const found = [];
  for (const d of MULTI_PORTAL_DETECTORS) {
    if (d.re.test(goal)) found.push(d.key);
  }
  return found;
}

/**
 * Build the multi-portal execution directive injected into the system prompt
 * when a goal spans 2+ admin portals. Returns empty string if only one (or zero).
 * @param {string} goal - The user's goal text.
 * @returns {string} Multi-portal directive, or '' if not applicable.
 */
export function getMultiPortalDirective(goal) {
  const portals = detectGoalPortals(goal);
  if (portals.length < 2) return '';
  const portalList = portals.join(', ');
  return `
## ⚠ MULTI-PORTAL INVESTIGATION — END-TO-END EXECUTION REQUIRED (3.8.2)

This goal spans ${portals.length} admin centers/portals: ${portalList}.

**You have an EXTENDED step budget for this run** (up to 300 steps with
productive-action extension). The user EXPECTS you to complete the entire
investigation end-to-end, NOT to stop early and suggest follow-ups.

REQUIRED EXECUTION PATTERN:

1. **Plan portal-by-portal.** Decide the order — start with the highest-value
   portal for the investigation question, but visit ALL of them. Move through
   the list systematically.

2. **For each portal:**
   - Navigate to the portal (open_tab when useful so you can return without
     reloading state in other portals).
   - Run the relevant investigation queries / filters / searches.
   - Use \`extract\` / \`extract_list\` / \`read_network_requests\` /
     \`scroll_and_collect\`-via-execute_js to PULL ACTUAL DATA, not just
     navigate. Aim for at least 2-3 productive extractions per portal.
   - **Save findings to memory using portal-prefixed keys** like
     \`entra_signins\`, \`exchange_rules\`, \`purview_audit_search\`,
     \`onedrive_external_shares\`, \`teams_call_summary\`, etc. The
     finish summary will group findings by these keys.
   - Use \`note\` actions to record per-portal section headers as you
     finish each portal (e.g., note: "PORTAL: Entra ID — sign-in audit
     complete, 47 records pulled, 3 anomalies flagged").

3. **Pace yourself.** Productive actions extend the run; aimless reads
   shorten it. Spend most steps on extract/execute_js/note, not on read_page
   or scroll. Avoid re-reading the same page (READ_PAGE LOOP guard fires
   after 2 consecutive read_page calls).

4. **Per-step orientation:** at the start of each portal, briefly note
   "Now investigating <portal>" so the progress stream shows the user where
   you are. The popup's Active Tab strip surfaces this automatically; the
   note also lands in the run log.

5. **Final report structure** (when you call \`finish\`):
   - Executive summary (1-3 sentences)
   - Per-portal findings, in order: each portal gets a section header,
     concrete evidence (timestamps, IPs, device names, event IDs, file
     paths, audit entries), and a noteworthy-or-not assessment
   - Cross-portal correlation: any patterns connecting findings across
     portals (same IP across Entra + Defender, same time window, etc.)
   - "Next questions for the client" — anything you couldn't determine
     from the audit (known work hours, known devices, etc.)
   - Defensible language only: timestamps, IPs, devices, event IDs,
     concrete audit entries. NO speculation. Mark items as "noteworthy"
     or "no evidence found" — never invent.

DO NOT stop after one portal and suggest follow-ups. DO NOT produce just a
checklist. The user has explicitly said they want the investigation handled
end-to-end. You have the budget and the tools — execute the sweep.
`;
}

// (3.20.0) Multi-article research pattern detection. The naive pattern
// (open_tab → note → close_tab × N) burns 3 steps per article — 30 steps
// for 10 articles, overflowing a typical step budget. This directive
// teaches a tighter pattern: batch-open in groups, then loop with
// read_page + note WITHOUT close, then close at the end.
const MULTI_ARTICLE_PATTERN = /\b(top|first|best|recent)\s+(\d{1,2})\s+(articles?|stories|posts?|items?|headlines?|results?)\b|\b(give|provide|write|do)\s+(?:me\s+)?(?:a\s+)?(?:full\s+)?(?:breakdown|summary|recap|briefing|overview)\s+(?:on|for|of)\s+each\b/i;

// Precompile regex for runbook pattern detection (hot paths in adaptive prompts)
const RUNBOOK_PATTERN_RE = /STEP\s+\d|PHASE\s+\d|INVESTIGATION|RUNBOOK|runbook|investigation/i;
const RUNBOOK_COMPREHENSIVE_RE = /STEP\s+\d|PHASE\s+\d|INVESTIGATION|RUNBOOK|Navigation:|Success Indicator|TICKET|checkpoint|rollback|decision tree|Phase [0-9]|what has been tried|fastest.*resolution/i;

/**
 * Build the multi-article directive for news/reading goals that request
 * summarizing multiple articles. Returns '' if not a multi-article goal.
 * @param {string} goal - The user's goal text.
 * @returns {string} Multi-article execution directive, or ''.
 */
export function getMultiArticleDirective(goal) {
  if (!goal || typeof goal !== 'string') return '';
  if (!MULTI_ARTICLE_PATTERN.test(goal)) return '';
  // Try to extract N if present
  const m = goal.match(ARTICLE_GOAL_RE);
  const parsedN = m ? parseInt(m[1], 10) : 0;
  const n = parsedN;
  const nLabel = (n > 0) ? n : 'N';

  return `
## 📰 MULTI-ARTICLE RESEARCH — USE BATCH PATTERN (3.20.0)

This goal asks for a deep breakdown of ${nLabel} articles. The NAIVE pattern
of open_tab → note → close_tab per article burns 3 steps × ${nLabel} = ${n > 0 ? (3 * n) : '3N'} steps and
will overflow your budget. Use this BATCH pattern instead:

### Phase A — One step: extract the article list
- Navigate to the source page, then run ONE \`execute_js\` with a \`key\` to
  scrape all ${nLabel} headlines + URLs in one shot. Save as e.g. \`top_links\`.
- Filter dedup early (don't re-extract the same headline twice).

### Phase B — Batch open tabs (3-5 at a time)
- Use \`open_tab\` with a label like \`article-1\`, \`article-2\`, ... for the
  first 3-5 URLs. Do NOT close tabs between articles in this phase.
- After each open_tab, the agent automatically switches to the new tab.

### Phase C — Loop: read + note, WITHOUT close_tab
- For each open tab: \`read_page\` then \`note\` with a 2-3 sentence summary
  (NOT a single-step open+close cycle). 2 steps per article, not 3.
- The \`note\` action persists the summary to history with portal-prefix
  memory keys recommended (\`article_1_summary\`, \`article_2_summary\`...).

### Phase D — Batch-close at the end
- After all ${nLabel} articles have been read + noted, you may close tabs in
  one pass if needed for memory pressure. But the finish handler closes all
  agent-created tabs automatically — usually you don't need explicit
  close_tab actions at all.

### Step-budget math
- Phase A: 2 steps (navigate + execute_js).
- Phase B-C: ~2 steps per article = 2*${nLabel} = ${n > 0 ? (2 * n) : '2N'} steps.
- Total: ~2 + 2*${nLabel} = ${n > 0 ? (2 + 2 * n) : '2 + 2N'} steps. Well within a 20-step budget for N≤9.

### Honest scope-setting
- If the goal genuinely asks for 10 deep article summaries AND the step
  budget is tight, prioritize: deliver thorough breakdowns of the top 3-5
  articles + headline-only listing for the rest. Mark the rest clearly as
  "[headline only — not read in this run]" so the user knows the limit.
- Never invent article content you didn't actually read.

### Cross-origin caveat
- If the goal source page (e.g., drudgereport.com, Hacker News) is just a
  headline aggregator and articles are on other domains, \`execute_js\`
  with \`fetch()\` running on the aggregator's page will be blocked by CORS
  for cross-origin article URLs. Stick with the batch open_tab pattern in
  that case — that's the right call.
`;
}

// ========== Platform Context Detection ==========
// Detects which UI the agent is currently operating in based on the page URL
// and goal text, then injects platform-specific behavioral guidance.
// Specifics (IPs, credentials, zone names, rule names) are intentionally NOT
// hardcoded here -- those come from the user's goal/Context Memory. This
// function only provides UI interaction patterns for each platform type.

// (3.18.0) Renamed to internal; the new wrapper below appends structured
// selector hints from the platforms/ profile system. Existing prose logic
// untouched — selectors complement, not replace.
// Platform detection specs: each entry has a test(url, text) predicate and prose to inject.
// Evaluated in order; first match wins. Keeping detection logic and prose co-located makes
// it easy to add or update platforms without touching function control flow.
const _PLATFORM_SPECS = [
  {
    test: (url, text) =>
      url.includes('sonicwall') || SONICWALL_TEXT_RE.test(text) ||
      SONICWALL_PATH_RE.test(url),
    prose: `
PLATFORM: SonicWall Management UI (SonicOS)
UI-SPECIFIC RULES -- follow these exactly:

DROPDOWNS: SonicWall uses Angular custom dropdowns, NOT native <select> elements.
  - To select a value: first CLICK the dropdown trigger to open the list, then CLICK the desired option.
  - Never use the "select" action on SonicWall dropdowns -- it only works on native HTML <select> and will silently fail here.
  - If a dropdown doesn't open on first click, try hover then click.

SAVING CHANGES: Every policy/object change requires an explicit commit step.
  - After editing a rule or object, look for an "Accept", "Apply", "OK", or "Save" button and click it.
  - Changes shown on screen are NOT saved until committed -- always confirm before moving on.
  - After committing, wait for the success toast/banner before proceeding.

LOG PAGES: Log > View and Connection Monitor pages are slow to populate.
  - After navigating to a log page, use wait_for_text with a 30000ms timeout before reading.
  - Filter inputs may need a click to focus before type will work.
  - Export/download buttons generate CSV files -- note the filename in a "note" action.

NAVIGATION: SonicWall uses SPA hash routing (#/path).
  - After clicking a nav item, wait 2-3 seconds for the panel to render before scanning elements.
  - If a panel seems empty, use scroll to reveal lazy-loaded content, then read_page again.

POLICY RULES TABLE: Click a rule row to open its edit dialog.
  - The edit icon (pencil) or the row itself opens the edit form.
  - Rule order matters: note the row number/position as well as the rule name.

SESSION EXPIRY: If you see a login form mid-task, the session expired.
  - The management URL and credentials are in the goal/context -- re-login and resume.

IFRAMES: Some SonicWall panels (especially older 6.5 UI) embed content in iframes.
  - If expected elements aren't found, try scrolling or waiting -- they may be in a same-origin iframe that the scanner will pick up automatically.
  - Cross-origin iframes cannot be read -- note this and use read_page on the outer frame instead.
`
  },
  {
    test: (url, text) =>
      FORTINET_URL_RE.test(url) ||
      FORTINET_TEXT_RE.test(text),
    prose: `
PLATFORM: Fortinet / FortiGate Management UI
UI-SPECIFIC RULES:
  - Dropdowns are custom widgets -- click to open, then click the option (not native select).
  - After policy changes, click Apply and wait for the green confirmation banner.
  - Log pages use virtual scrolling -- scroll down to load more entries.
  - Tables have inline edit icons (pencil); click the icon not the row to edit.
  - Session timeout is short -- if a login page appears, re-authenticate using goal credentials.
`
  },
  {
    test: (url, text) =>
      CISCO_URL_RE.test(url) ||
      CISCO_TEXT_RE.test(text),
    prose: `
PLATFORM: Cisco Management UI (ASA/FMC/Meraki/ISE)
UI-SPECIFIC RULES:
  - ASDM uses Java -- if the UI is Java-based, use execute_js sparingly; DOM interaction is limited.
  - FMC uses custom React components -- dropdowns need click-to-open then click-option.
  - Meraki dashboard: standard web UI, most actions work normally; wait for AJAX to settle after saves.
  - Always look for a Deploy or Commit button after policy changes -- pending changes are staged, not live.
  - Log tables use pagination -- note the page number when extracting log entries.
`
  },
  {
    test: (url, text) =>
      PALOALTO_URL_RE.test(url) ||
      PALOALTO_TEXT_RE.test(text),
    prose: `
PLATFORM: Palo Alto Networks (PAN-OS / Panorama)
UI-SPECIFIC RULES:
  - After any change, a "Commit" step is required -- look for the Commit button (top right) and click it.
  - Dropdowns are Ext JS widgets -- click the dropdown arrow, then click the option.
  - Tabs within panels are clickable text -- click the tab label to switch views.
  - Log Viewer uses AJAX pagination -- wait for spinner to disappear before extracting log data.
  - Object names are case-sensitive -- extract exact names as shown on screen.
`
  },
  {
    test: (url, text) =>
      SENTINELONE_URL_RE.test(url) ||
      SENTINELONE_TEXT_RE.test(text),
    prose: `
[SentinelOne Singularity Console — Platform Context]
- Top-bar global search accepts SHA1, SHA256, MD5 hashes, filenames, IPs, URLs.
  After typing, press Enter to execute the search; results appear in a side
  panel + table view.
- Threats tab: Sentinels > Threats. Each row expands to show endpoint, agent,
  AI Confidence, Analyst Verdict, Mitigation status, Originating Process.
- Deep Visibility (Hunting): supports a query language (PowerQuery-like).
  Common patterns:
    SrcProcDisplayName contains "old_msedge"
    TgtFileSha1 = "d548d72837175752fe5b563690049066ac93fdf5"
    TgtFileSha256 = "..."
    SrcProcSignedStatus = "unsigned"
- Endpoints/Sentinels tab: lists every device. Click a row for full detail
  panel (OS, agent version, last seen, IP, user).
- Site/scope picker: top-right. Switch between client tenants. ALWAYS verify
  you are on the correct site/scope before any action — cross-client data
  contamination is a serious risk.
- Action buttons (Disconnect, Quarantine, Kill, Disable Agent) require role
  permission and explicit confirmation — DO NOT auto-click these.
- Filtering: each column header has a filter dropdown; multi-select supported.
- Bulk actions: checkbox column on the left; selected rows enable a toolbar.
- Search results often paginate — scroll to load more, or use the page selector.
- Wait for spinners to clear after Run/Refresh; use wait_for_text on a result
  count (e.g., "results") with 30000ms timeout.
`
  },
  {
    test: (url) => NVD_URL_RE.test(url),
    prose: `[NIST NVD / CVE Database -- Platform Context (3.12.6)]

## CRITICAL RULE: When you have the listing data, you are DONE.

NVD search results pages embed each CVEs ID, CVSS v3 score (with severity
label like "9.8 CRITICAL"), summary description, CNA, and assigned date
INLINE in each row. ONE execute_js on the listing page can harvest all of
this for ALL listed CVEs. After that, you have everything you need.

DO NOT click into individual CVE detail pages just to "get more detail".
Detail pages cost 4-6 steps each (navigate, wait, extract, back, navigate-
next), the extraction is fragile, and the data you would gain is already
in the listing. Drilling in is the #1 budget waster on NVD goals -- the
previous version of this extension burned 14+ steps clicking into detail
pages when 1 listing extract would have answered the goal.

ONLY drill into a detail page if the user specifically asked for:
   - full CPE enumeration (every affected product/version pair)
   - the complete reference link list (advisor URLs, vendor advisories)
   - exploit module references or PoC links
For "find me N CVEs" / "rank by severity" / "give me CVSS scores" --
the listing has it. Extract once, finish.

## Listing-page extraction strategy

1. Land on nvd.nist.gov/vuln/search and use the keyword field for
   vendor name (e.g. "fortinet fortigate") OR Advanced Search with
   a CPE filter (cpe:2.3:o:fortinet:fortios:*) for cleaner results.
   Date range: "Last 3 Months" or "Last Year" for "recent" goals.
   Sort by "Date Last Modified" descending for most-recent goals.

2. Wait for results to render (NVD is server-rendered Angular but lists
   load fast). Then run a SINGLE execute_js to harvest all rows. Use
   query selectors that target the result row container -- common shapes
   are tr inside the vuln-table tbody, divs with class .row-result-snippet
   ancestors, or [data-testid="vuln-row"]. From each row pull innerText
   from: the CVE-link, the severity badge, the summary paragraph, the
   publish date. Use the (el || {}).innerText null-guard pattern from
   EXECUTE_JS RELIABILITY PATTERNS.

3. If selectors miss, use document.body.innerText regex on the listing:
   match /^CVE-\\d{4}-\\d{4,7}/ at line starts; for the next line capture
   the severity label or numeric score; capture subsequent lines as
   description until the next CVE marker. This text-pattern approach is
   robust against UI changes.

## Detail-page extraction (only if you genuinely need to drill)

If the user asked for full CPE/refs and you must drill into a detail
page (nvd.nist.gov/vuln/detail/CVE-XXXX-XXXXX):

1. The CVSS v3 base score lives in the page text near "CVSS 3.x Severity
   and Metrics" header. Use body.innerText regex: match digits.digits
   followed by space + (CRITICAL|HIGH|MEDIUM|LOW). The CVSS vector
   string starts with "CVSS:3.1/AV:" or "CVSS:3.0/AV:".

2. Affected versions are in the "Known Affected Software Configurations"
   section as CPE strings (cpe:2.3:o:fortinet:fortios:7.4.0:*). Each is
   a list item; iterate document.querySelectorAll(".vuln-detail-table
   td, .cpe-text, [class*=cpe]") and pull innerText.

3. Description text is in a <p> with id="vulnDescription" or class
   .vuln-description. Pull innerText.

If the detail extraction fails twice, FALL BACK to body.innerText regex
rather than retrying the same selectors. NVD updates their UI quarterly.

## Other CVE sources

4. CISA KEV catalog (cisa.gov/known-exploited-vulnerabilities-catalog) is
   the authoritative source for "exploited in the wild" status. If a CVE
   appears in KEV, it has confirmed in-wild exploitation. Cite as
   [src:kev_<cveid>]. The KEV table can be filtered by CVE ID.

5. MITRE / CVE.org (cve.org/CVERecord?id=...) has the CNAs official
   description but typically NO CVSS score -- NVD enriches it. Use
   CVE.org only when NVD is rate-limiting or for very-recent CVEs not
   yet in NVD.

NEVER fabricate CVSS scores or affected versions when extraction fails.
If a score was not on the page you read, leave it "not captured" and
recommend the user check NVD directly. The hallucination gate enforces.`
  },
  {
    test: (url, text) =>
      VIRUSTOTAL_URL_RE.test(url) ||
      VIRUSTOTAL_TEXT_RE.test(text),
    prose: `
[VirusTotal — Platform Context]
- The GUI is built with Lit shadow-DOM web components (vt-ui-main-generic-report,
  vt-ui-file-card, vt-ui-detections-list, vt-ui-results-summary). Standard
  document.querySelector / .innerText extraction CANNOT pierce these shadow
  roots and will return little or nothing. This is the #1 failure mode here.

EXTRACTION STRATEGY (use in order):
1. PREFER read_network_requests with url_includes: "ui/files" or "api/v3/files" —
   the GUI calls VT's own JSON API and the response contains every detection
   ratio, AV vendor result, signature info, and prevalence stat you need.
   Filter for "ui/files/<sha>" or "/api/v3/files/<sha>" specifically.
2. If read_network_requests doesn't have the entry, use execute_js with
   window.__sentinelUtils.shadow.queryDeep(document, '<selector>') to traverse
   shadow roots:
     return Array.from(window.__sentinelUtils.shadow.queryDeep(document, '[class*=detection]'))
       .map(el => el.innerText).filter(Boolean);
3. As a last resort, ask the user to paste the detection summary from the page.

URL patterns:
- /gui/file/<sha256>/detection — main detection panel
- /gui/file/<sha256>/details — file metadata, signatures, names
- /gui/file/<sha256>/relations — related files
- /gui/file/<sha256>/community — comments, votes

NEVER fabricate detection ratios or AV vendor results when extraction fails.
Report the failure honestly and recommend a manual lookup.
`
  },
  {
    test: (url) =>
      M365_ADMIN_URL_RE.test(url),
    prose: `
[Microsoft 365 Admin Center — Platform Context]
- Built on Microsoft Fluent UI / FluentUI React. Prefer selectors using:
    [data-automationid="..."]
    [aria-label="..."]
    role="button" / role="menuitem" / role="row"
- Page-level search ALWAYS exists; type to filter instead of scrolling
  virtualized lists (Active users, Mailboxes, etc. virtualize aggressively —
  scroll-and-scan loses rows).
- Side panels open from the right with class hooks like
  [data-automationid="detailsPaneOuter"] or role="complementary". After
  clicking a row, wait for the panel to render before scanning elements.
- Save buttons on Fluent UI panels are at the bottom and use class
  ms-Button--primary or text "Save". They re-disable until form changes are
  valid. Toast confirmations appear briefly with role="alert".
- Tenant safety: confirm tenant matches expected before any modifying action.
  The detected tenant is shown in the popup header chip (3.7.0).
- MFA step-up auth fires on admin actions — Sentinel auto-detects and pauses.
- Common navigation paths (verified 2026-05):
    Active users:        admin.microsoft.com → Users → Active users
    Mailbox delegation:  admin.exchange.microsoft.com → Recipients → Mailboxes
    Groups:              admin.microsoft.com → Teams & groups → Active teams & groups
    SharePoint sites:    admin.microsoft.com → SharePoint admin → Active sites
    Purview Audit:       https://purview.microsoft.com/audit/auditsearch
                         (NOT /auditlogsearch — that path redirects to home).
                         If the URL redirects to home, the new audit path is
                         purview.microsoft.com → Solutions → Audit → New search.
    Compliance Manager:  https://compliance.microsoft.com/compliancemanager
                         (note: compliance.microsoft.com is increasingly
                         redirecting to purview.microsoft.com — prefer purview).
- After ANY save: wait for toast text and re-read the user/group panel to
  verify the change is reflected. Don't finish before verification.
`
  },
  {
    test: (url, text) =>
      ENTRA_URL_RE.test(url) ||
      ENTRA_TEXT_RE.test(text) ||
      (AZURE_AD_TEXT_RE.test(text) && MICROSOFT_URL_RE.test(url)),
    prose: `
[Microsoft Entra ID — Platform Context]
- Identity admin UI built on FluentUI React + Monaco editor for JSON details.
- ⚠ CRITICAL: Sign-in logs, Audit logs, and Users tables render INSIDE
  cross-origin sandbox iframes (sandbox-1/2/3.reactblade.portal.azure.net).
  Standard DOM extraction from these tables WILL fail. Use the Microsoft
  Graph API extraction strategy: read_network_requests filter for
  graph.microsoft.com to capture the underlying JSON response (e.g.,
  /beta/auditLogs/signIns). This is reliable; DOM scraping is not.
- Sign-in logs path: Monitoring & health > Sign-in logs.
- Audit logs path: Monitoring & health > Audit logs.
- Filter chips render above tables; existing filters show as "Date: Last 24
  hours", "Status: Failure" pills. Read these BEFORE re-applying filters.
- Tables are virtualized (~30 rows in DOM at a time). To get all rows:
  use scroll-and-collect pattern (scroll the container, dedupe by row identity).
- Click a row → details panel with tabs: Basic info, Location, Device info,
  Authentication details (Monaco JSON), Conditional Access. To extract the
  JSON, use execute_js with monaco-aware code:
    return monaco.editor.getModels()[0].getValue();
- Export to CSV: button at top of table. Sentinel can detect the download
  via chrome.downloads.onCreated (3.7.0+).
- Tenant safety: ALWAYS verify tenant chip matches expected before any
  modifying action (Conditional Access, App registrations, Users).
- Sign-in audit goal pattern: group by user × status × IP, flag any IP
  with >3 failures or country mismatch with the user's typical location.
`
  },
  {
    test: (url) => AZURE_PORTAL_RE.test(url),
    prose: `
[Azure Portal — Platform Context]
- Heavy use of iframes and Monaco editor. iframe-aware element scanning is
  on by default but cross-origin frames may need execute_in_frame routing.
- Resource search: top-bar "Search resources, services, and docs" — most
  reliable navigation entry point.
- Service blade (left nav) → resource list → resource detail (right blade).
- Most actions are async — wait for the toast (top-right, role="alert") and
  the activity log row before declaring success.
- Subscription picker (top-right): cross-tenant safety same as M365. Verify
  before any modify.
- Tags + RBAC are common edit targets. Both render in side blades with Save
  at the bottom.
`
  },
  {
    test: (url, text) =>
      CONNECTWISE_URL_RE.test(url) ||
      CONNECTWISE_TEXT_RE.test(text),
    prose: `
[ConnectWise Platform Context]
- Navigation uses a left sidebar with expandable menu sections (Service, Sales, Procurement, etc.)
- Tables use a filter bar at top — click the filter icon to add criteria, then click Refresh
- Opening a ticket: Service > Service Tickets > click + or "New Ticket" button
- Ticket fields: Summary, Company (dropdown), Contact, Type, Subtype, Item, Priority, Status
- Company dropdown is searchable — type to filter, click to select
- Time entries: open ticket, click the Time tab, click "Enter Time" or + button
- Use click to interact with dropdown menus; ConnectWise uses custom dropdowns (not native <select>)
- For bulk operations, use the checkbox column to select rows, then use the action toolbar
- SSO/SAML redirects are common — if redirected to a login page, wait for it to load
- Configurations (devices) are under the Configurations tab on a company or ticket
`
  },
  {
    test: (url, text) =>
      url.includes('ninjarmm') || url.includes('ninja.io') || url.includes('ninjabe') ||
      text.includes('ninjaone') || text.includes('ninja rmm'),
    prose: `
[NinjaOne Platform Context]
- Navigation uses a top menu bar with Organizations, Devices, Software, Policies, etc.
- Device list has a search/filter bar — type to search by hostname, IP, or organization
- Click a device row to open the device detail panel (slide-in from right)
- Policy management: Policies > select policy type > edit conditions/actions
- Organization selector (top-left or top-right dropdown) switches between managed orgs
- Custom fields are under Organization > Custom Fields or Device > Custom Fields
- Scripts: Automation > Scripts > search or browse, click to run on selected devices
- Software management: Software > patching status, approve/deny updates
- Ninja uses React-based custom dropdowns — use click to open, click to select
- Tables support column sorting by clicking column headers
`
  },
  {
    test: (url, text) =>
      DATTO_URL_RE.test(url) ||
      DATTO_TEXT_RE.test(text),
    prose: `
[Datto/Autotask Platform Context]
- Autotask PSA: navigation via top menu (Dispatch, Service Desk, Projects, etc.)
- Ticket creation: Service Desk > Tickets > New Ticket
- Datto RMM: left sidebar navigation (Sites, Devices, Policies, Jobs, etc.)
- Device search: Devices > use filter bar, supports hostname/IP/serial search
- Alert management: Alerts page shows active alerts, click to acknowledge or create ticket
- Integration between Datto RMM and Autotask PSA via Datto Integration
- Autotask uses custom ASP.NET dropdowns — click to open, may need to type to filter
- Datto RMM uses Angular-based dropdowns — click to open, click to select
- Both platforms have session timeouts — if login form appears, re-authenticate
`
  },
  {
    test: (url, text) => ITGLUE_RE.test(url) || /it glue/.test(text),
    prose: `
[IT Glue Platform Context]
- Navigation: left sidebar with Organizations, Passwords, Documents, Configurations, etc.
- Search bar at top of every page — type to search across all asset types
- Organizations page lists all managed orgs, click to open org detail
- Passwords: organized by organization, click to view (may require re-authentication)
- Documents: rich text editor with version history
- Configurations: network devices, servers, workstations listed with IPs and credentials
- IT Glue uses standard HTML forms — type, click, select all work natively
- Related items section at bottom of each asset links to connected configs/passwords
`
  },
  {
    test: (url, text) => HUNTRESS_RE.test(url) || /huntress/.test(text),
    prose: `
[Huntress Platform Context]
- Dashboard shows threat summary with alert counts
- Left sidebar: Dashboard, Threat Intelligence, Managed Agents, Reports, Account
- Managed Agents page lists all endpoints with agent status
- Alert management: Threat Intelligence > click alert to see details
- Agent deployment: Account > Deployment > download installer or copy install command
- Reports: generates PDF/CSV reports for compliance
- Huntress uses custom React dropdowns — click to open, click to select
`
  },
  {
    test: (url, text) =>
      SCREENCONNECT_URL_RE.test(url) ||
      SCREENCONNECT_TEXT_RE.test(text),
    prose: `
[ScreenConnect Platform Context]
- Access page lists all managed machines with status (online/offline)
- Search bar filters by hostname, organization, or custom property
- To connect: click the checkbox next to machine, click "Connect" or double-click
- Session types: Control (full desktop), Access (background), Meeting (presentation)
- Command tab allows running commands on connected machines
- File transfer tab for uploading/downloading files
- Custom properties used for tagging/organization — editable in machine details
`
  },
  {
    test: (_, text) =>
      GENERIC_NETWORK_RE.test(text),
    prose: `
PLATFORM: Network/Security Device Management UI (generic)
UI-SPECIFIC RULES:
  - Many network device UIs use custom dropdowns -- if "select" fails, try click-to-open then click-option.
  - Changes are often staged -- look for Apply, Save, Commit, or Accept buttons after edits.
  - Log pages may be slow to load -- use wait_for_text with generous timeouts (20000-30000ms).
  - Session timeouts are common -- if a login form appears, re-authenticate using credentials from the goal.
  - Table rows often open edit dialogs on click -- click the row or its edit icon to modify entries.
`
  },
];

/**
 * Match a platform spec from _PLATFORM_SPECS by URL and goal text, returning its prose guidance.
 * @param {string} currentUrl - The current page URL to match against.
 * @param {string} goal - The goal text to match against.
 * @returns {string} Platform prose string, or empty string if no spec matches.
 */
function _getPlatformProseInternal(currentUrl, goal) {
  const url  = (currentUrl || '').toLowerCase();
  const text = (goal || '').toLowerCase();
  for (const spec of _PLATFORM_SPECS) {
    if (spec.test(url, text)) return spec.prose;
  }
  return '';
}

// (3.18.0) Format the structured profile's knownSelectors + waitStrings +
// pageTypes as a prose block for the agent's runtime system prompt. The LLM
// gets "try these selectors first" hints which reduce trial-and-error
// observe-and-flail loops on complex SPAs like SonicWall NSM 7.x.
/**
 * Format a platform profile's known selectors, wait strings, page types, and gotchas
 * into a prose block for the agent's system prompt.
 * @param {Object|null} profile - Platform profile object with knownSelectors, waitStrings, pageTypes, etc.
 * @param {string} currentUrl - Current URL used to detect the active page type.
 * @returns {string} Formatted prose block, or empty string if profile is null/empty.
 */
function _formatProfileSelectorsBlock(profile, currentUrl) {
  if (!profile) return '';
  const sel = profile.knownSelectors;
  const wait = profile.waitStrings;
  const pageTypes = profile.pageTypes;
  if (!sel && !wait && !pageTypes) return '';

  const parts = [];
  parts.push('');
  parts.push(`━━━ PLATFORM SELECTOR PROFILE (${profile.label || profile.id}) ━━━`);
  parts.push('These are KNOWN selectors for this platform. Try them FIRST before falling back to runtime element scanning. Each entry is a defensive comma-separated alternatives list — the content script will resolve whichever matches.');
  parts.push('');

  // Page-type classification — tell the LLM what surface it's on so it can
  // pick relevant selectors.
  if (Array.isArray(pageTypes) && pageTypes.length && currentUrl) {
    let detected = null;
    for (const pt of pageTypes) {
      try { if (pt && pt.urlMatch && pt.urlMatch.test(currentUrl)) { detected = pt; break; } } catch (e) { console.error('[Sentinel] Error in llm-client.js:', getErrorMessage(e)); }
    }
    if (detected) {
      parts.push(`CURRENT PAGE TYPE: ${detected.name} — ${detected.hint || ''}`);
      parts.push('');
    }
  }

  if (sel && typeof sel === 'object') {
    parts.push('KNOWN SELECTORS (use as preferred targets):');
    for (const [k, v] of Object.entries(sel)) {
      if (typeof v === 'string') {
        parts.push(`  ${k}: ${v}`);
      } else if (Array.isArray(v)) {
        parts.push(`  ${k}: [${v.map(s => `"${s}"`).join(', ')}]`);
      } else if (typeof v === 'function') {
        // Function-valued selectors are parameterized — describe the slot
        // rather than dump source.
        parts.push(`  ${k}: (parameterized — pass label or text to resolve)`);
      }
    }
    parts.push('');
  }

  if (wait && typeof wait === 'object') {
    parts.push('WAIT-TEXT SIGNALS (use with wait_for_text):');
    for (const [k, v] of Object.entries(wait)) {
      if (Array.isArray(v) && v.length) {
        parts.push(`  ${k}: any of [${v.map(s => `"${s}"`).join(', ')}]`);
      }
    }
    parts.push('');
  }

  if (profile.knownGotchas) {
    parts.push(`KNOWN GOTCHAS: ${profile.knownGotchas}`);
    parts.push('');
  }

  if (profile.liveDataCaveats) {
    parts.push(`LIVE DATA NOTE: ${profile.liveDataCaveats}`);
    parts.push('');
  }

  if (Array.isArray(profile.commitFlow) && profile.commitFlow.length) {
    parts.push(`COMMIT SEQUENCE: After any config change, click in order: ${profile.commitFlow.join(' → ')}. Do not skip steps — each platform requires this exact sequence to persist changes.`);
    parts.push('');
  }

  return parts.join('\n');
}

/**
 * (3.18.0) Public platform-context API. Returns the existing hardcoded prose
 * (for backwards compat with all current callers) PLUS a structured selector
 * block sourced from background/platforms/<id>.js when a profile matches.
 * Same single-string return shape — no changes needed at the call sites.
 */
// (3.41.0) Cache platform context by URL+goal prefix — rebuilding the selector
// block and prose on every LLM call (50-100 times per run) is wasteful when
// the URL is stable. TTL of 30s covers SPA route transitions.
const _platformContextCache = new Map();

/**
 * Build platform-specific context (selectors, guidance) for the current URL and goal.
 * Results are cached for 60s to avoid repeated lookups during a run.
 * @param {string} currentUrl - The active tab's URL.
 * @param {string} goal - The user's current goal text.
 * @returns {string} Formatted platform context block for the system prompt.
 */
export function getPlatformContext(currentUrl, goal) {
  const _cacheKey = `${currentUrl || ''}||${(goal || '').slice(0, 50)}`;
  const _cached = _platformContextCache.get(_cacheKey);
  if (_cached && Date.now() - _cached.ts < PLATFORM_CTX_CACHE_TTL_MS) return _cached.ctx;

  const prose = _getPlatformProseInternal(currentUrl, goal);
  let selectorBlock = '';
  try {
    const profile = getPlatformProfile(currentUrl, goal);
    selectorBlock = _formatProfileSelectorsBlock(profile, currentUrl);
  } catch (e) {
    console.warn('[Sentinel/llm] Profile lookup failed:', getErrorMessage(e));
    // Continue without selector block - non-fatal
  }
  const ctx = prose + selectorBlock;
  _platformContextCache.set(_cacheKey, { ctx, ts: Date.now() });
  if (_platformContextCache.size > 50) {
    const oldest = _platformContextCache.keys().next().value;
    _platformContextCache.delete(oldest);
  }
  return ctx;
}

// ========== Vision Support ==========
// Three-tier resolution:
//   1. Provider/model registry in provider-registry.js (deterministic).
//   2. Broad regex matcher for unknown models (forward-compatible).
//   3. Small text-only deny list as a safety net.
//
// Signature is intentionally stable: supportsVision(model[, providerHint]).
// When providerHint is omitted, we infer from common model-id patterns; this
// preserves the legacy single-arg call sites.
/**
 * Check whether a given model supports vision/screenshot analysis.
 * Uses a three-tier approach: exact model lookup, broad regex match, and a deny list.
 * @param {string} model - The model identifier (e.g. 'gpt-4o', 'claude-3-5-sonnet').
 * @param {string} [providerHint] - Optional provider key for faster matching.
 * @returns {boolean} True if the model supports vision input.
 */
export function supportsVision(model, providerHint) {
  if (!model) return false;
  const m = String(model).toLowerCase();

  // (a) Hard deny list -- confirmed text-only variants.
  // Precompiled for performance
  const denyList = [
    GPT_3_5_RE,
    CLAUDE_3_HAIKU_TEXT_RE,
    CLAUDE_2_RE,
    CLAUDE_INSTANT_RE,
    TEXT_ONLY_RE
  ];
  if (denyList.some(re => re.test(m))) return false;

  // (b) Registry lookup (provider-driven). Infer provider from model name when
  //     a hint isn't given.
  const inferredProvider =
    providerHint ||
    (m.startsWith('claude-') ? 'anthropic'
      : (m.startsWith('gpt-') || m.startsWith('o3') || m.startsWith('o4')) ? 'openai'
      : null);
  const registryAnswer = getModelSupportsVision(inferredProvider, model);
  if (registryAnswer === true) return true;
  if (registryAnswer === false) return false;

  // (c) Fallback positive matcher for unknown models.
  // Precompiled for performance
  const visionPatterns = [
    CLAUDE_OPUS_SONNET_RE,
    GPT_4_RE,
    GEMINI_RE,
    QWEN_VL_RE,
    LLAVA_RE,
    VISION_RE,
    VL_DASH_RE,
    VL_END_RE
  ];
  return visionPatterns.some(re => re.test(m));
}

// ========== Pre-flight Planning ==========
// Generates a numbered plan from the goal before execution begins.
// This gives the agent a map of what it's accomplished and what's left,
// dramatically improving reliability on multi-step and multi-site tasks.
/**
 * Generate an initial step plan for a goal using a planning LLM call.
 * Sends the goal + context to the configured model and returns parsed action steps.
 * @param {string} goal - The user's automation goal.
 * @param {Object} settings - Extension settings (api_key, model, api_endpoint, etc.).
 * @param {Object} [context={}] - Additional context (currentUrl, pageTitle, etc.).
 * @returns {Promise<Array|null>} Parsed plan steps, or null on failure.
 */
/**
 * Build the plan-generation prompt string from a goal and context object.
 * Extracted from generatePlan to keep that function under 50 lines.
 * @param {string} goal
 * @param {object} context - { currentUrl, pageTitle, platformContext, relevantPatterns }
 * @returns {string}
 */
function _buildPlanPrompt(goal, context) {
  const urlContext = context.currentUrl
    ? `Current page: ${context.currentUrl}${context.pageTitle ? ` (${context.pageTitle})` : ''}\n`
    : '';
  const platformContext = context.platformContext || '';
  const patternContext = Array.isArray(context.relevantPatterns) && context.relevantPatterns.length
    ? `\nPast successful patterns for similar tasks:\n${context.relevantPatterns.map(p => p && p.goal ? `- "${p.goal}" -> ${Array.isArray(p.steps) ? p.steps.map(s => s && s.type ? s.type : '?').join(', ') : '(no steps)'}` : '').join('\n')}\n`
    : '';

  return `You are an expert browser automation planner for an MSP (Managed Service Provider) tool. Given a user goal and current context, produce a DETAILED hierarchical execution plan formatted as structured phases with sub-tasks.

OUTPUT FORMAT:
{
  "phases": [
    {
      "phase": 1,
      "title": "Phase 1 – Setup",
      "steps": ["step 1", "step 2"]
    },
    {
      "phase": 2,
      "title": "Phase 2 – Discovery",
      "steps": ["step 1", "step 2"]
    }
  ]
}

DECOMPOSITION RULES — follow these exactly:
1. Break every task into EXPLICIT, atomic browser actions. NEVER combine multiple actions into one step.
2. Login flows: navigate to login page → type username → type password → click submit → wait for dashboard
3. Form interactions: locate field → clear/focus → type value → move to next field
4. Navigation: click menu item → wait for content → scan elements → proceed
5. Table/filter tasks: navigate to table → locate filter → set filter → wait for results → read → extract data
6. Configuration changes: navigate to config section → find item → open edit → set values → save → verify success
7. Multi-page research: navigate to source → extract links → open each in tab → read → note findings → close tabs → summarize
8. ALWAYS include data extraction steps (extract, execute_js with key, or note) — never just navigate and read without saving
9. ALWAYS include verification after saves/commits (wait for success message, then use a verify action to confirm the value persisted)
10. For firewalls/network devices: ALWAYS include the save/commit/apply step after any configuration change, followed by a verify action
11. Phases must be numbered sequentially starting at 1. Phase titles are short descriptive strings.
12. If the goal naturally splits into independent sub-goals, create separate phases for each sub-goal.
13. Maximum overall steps still limited to 100, but phases may contain multiple steps.

${urlContext}${platformContext}${patternContext}${getMultiPortalDirective(goal) || ''}${getMultiArticleDirective(goal) || ''}
<GOAL>
${goal}
</GOAL>

Return ONLY a JSON object: { "phases": [...] }

Example GOOD phased plan for a complex MSP task:
{
  "phases": [
    {
      "phase": 1,
      "title": "Initialize",
      "steps": ["Navigate to https://192.168.1.1"]
    },
    {
      "phase": 2,
      "title": "Authenticate",
      "steps": ["Type the username into the login field", "Type the password into the password field", "Click the Login button and wait for dashboard"]
    },
    {
      "phase": 3,
      "title": "Navigate to Rules",
      "steps": ["Click Policy or Firewall in the left navigation menu", "Click Access Rules or IPv4 Rules", "Wait for the rules table to load"]
    },
    {
      "phase": 4,
      "title": "Create Block Rule",
      "steps": ["Click Add Rule or the + button to create a new rule", "Set the Source Zone dropdown to WAN", "Set the Destination Zone dropdown to LAN", "Set the Service dropdown to RDP (port 3389) or type 3389", "Set the Action to Deny or Drop", "Type a descriptive name in the Comment/Name field", "Click Save or Apply", "Wait for the success confirmation banner"]
    },
    {
      "phase": 5,
      "title": "Verify",
      "steps": ["Finish with confirmation that the RDP block rule was created"]
    }
  ]
}

Example GOOD phased plan for a multi-page research task:
{
  "phases": [
    {
      "phase": 1,
      "title": "Source",
      "steps": ["Navigate to cnn.com", "Read the homepage content to identify top stories"]
    },
    {
      "phase": 2,
      "title": "Extract Links",
      "steps": ["Use execute_js with key 'headlines' to extract the top 10 headline titles, links, and descriptions"]
    },
    {
      "phase": 3,
      "title": "Detail Pages",
      "steps": ["For each article that needs more detail, open it in a new tab using open_tab with label", "Switch to each article tab, read the page, and note a brief summary", "Close article tabs when done"]
    },
    {
      "phase": 4,
      "title": "Summarize",
      "steps": ["Finish with a numbered briefing of all 10 articles with headlines and key takeaways"]
    }
  ]
}

Example BAD plan (too vague):
{
  "phases": [
    {
      "phase": 1,
      "title": "Phase 1",
      "steps": ["Go to the website", "Find the information", "Get the data"]
    }
  ]
}`;
}

/**
 * Generate a step-by-step execution plan for the given goal using the LLM.
 * Returns an array of step strings, or null if planning fails or no API key is set.
 *
 * @param {string} goal - The user's task description.
 * @param {object} settings - Provider settings: { api_endpoint, api_key, model }.
 * @param {object} [context] - Optional context: { currentUrl, pageTitle, platformContext, relevantPatterns }.
 * @returns {Promise<string[]|null>}
 */
export async function generatePlan(goal, settings, context = {}) {
  const endpoint = settings.api_endpoint || 'https://api.z.ai/api/coding/paas/v4/chat/completions';
  const apiKey = settings.api_key;
  const model = settings.model || 'glm-5';
  if (!apiKey) return null;

  // Helper to normalize plan step objects/strings into consistent string array
  const _normalizeSteps = arr => arr.map(s => (typeof s === 'string' ? s : (s && typeof s === 'object' ? (s.action || s.description || s.step || JSON.stringify(s)) : String(s)))).filter(Boolean);

  const planPrompt = _buildPlanPrompt(goal, context);

  const controller = new AbortController(); _activeLLMCtrls.add(controller); // (SO-94) instant user-stop
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const provider = resolveProvider(endpoint);
    // Only send response_format:json_object to OpenAI proper — Z.AI and other
    // compatible providers may reject or ignore it, causing 400 errors.
    // The fallback strategies in the parse block below handle non-JSON responses.
    const useJsonMode = endpoint.includes('api.openai.com');
    const planBody = JSON.stringify(provider.buildBody(model, 'You are a planning assistant. Return ONLY valid JSON.', planPrompt, { maxTokens: 1200, temperature: 0.2, jsonMode: useJsonMode }));
    const planHeaders = provider.buildHeaders(apiKey);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: planHeaders,
      body: planBody,
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!response.ok) {
      console.warn('Plan generation API returned', response.status, '— using goal as single-step fallback');
      return [(goal || 'Complete the task').substring(0, 300)];
    }
    const data = await response.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Plan API returned invalid response body');
    // Early detection of auth errors from providers that return HTTP 200 with error payloads
    if ((!data.choices || !data.choices.length) && (data.error || data.msg || (data.code && data.success === false))) {
      const errMsg = data.error?.message || data.msg || data.message || JSON.stringify(data);
      throw new Error(`🔑 API Authentication Failed: ${errMsg}. Check your API key in extension settings.`);
    }
    const content = provider.parseResponse(data);
    if (!content) {
      console.warn('Plan generation: empty response content — using single-step fallback');
      return [(goal || 'Complete the task').substring(0, 300)];
    }
    // Pre-process: strip <think>...</think> blocks that some GLM/DeepSeek models embed
    // directly in the content field. These must be removed BEFORE any JSON scanning so
    // that a plan-like JSON snippet inside the thinking block isn't mistaken for the
    // real plan. This is a no-op when no think tags are present.
    const contentNoThink = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    // Strategy 1: strip markdown fences, strip control chars, then JSON.parse
    let jsonStr = contentNoThink;
    if (jsonStr.includes('```')) {
      const match = jsonStr.match(CODE_BLOCK_REGEX);
      if (match && match[1]) jsonStr = match[1].trim();
    }
    jsonStr = jsonStr.replace(/[\x00-\x1f]/gu, '');  // eslint-disable-line no-control-regex
    try {
      const parsed = JSON.parse(jsonStr);
      // Some models (Z.AI/GLM) return a bare array ["step1","step2"] with no wrapper object
      if (Array.isArray(parsed) && parsed.length) {
        const strs = _normalizeSteps(parsed);
        if (strs.length) return strs;
      }
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.plan) && parsed.plan.length) {
        const strs = _normalizeSteps(parsed.plan);
        if (strs.length) return strs;
      }
      // New phased format: { "phases": [{ phase: 1, title: "...", steps: [...] }] }
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.phases) && parsed.phases.length) {
        const flatSteps = [];
        for (const phase of parsed.phases) {
          if (phase && typeof phase === 'object' && Array.isArray(phase.steps)) {
            flatSteps.push(...phase.steps);
          }
        }
        if (flatSteps.length) return _normalizeSteps(flatSteps);
      }
      // Some models return { "steps": [...] } instead of { "plan": [...] }
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.steps) && parsed.steps.length) {
        const strs = _normalizeSteps(parsed.steps);
        if (strs.length) return strs;
      }
    } catch (e) { console.warn('[Sentinel/llm] Strategy 1 failed:', getErrorMessage(e)); }

    // Strategy 2: scan for the first balanced JSON object containing "plan" or "steps".
    // extractFirstJsonObject() checks for action "type" fields and never matches plan JSON.
    // Uses contentNoThink so thinking-block JSON doesn't get selected over the real plan.
    {
      let s2from = 0;
      const contentLen = contentNoThink.length;
      while (s2from < contentLen) {
        const s2start = contentNoThink.indexOf('{', s2from);
        if (s2start === -1) break;
        let depth = 0, inStr = false, esc = false, s2end = -1;
        for (let i = s2start; i < contentLen; i++) {
          const ch = contentNoThink[i];
          if (esc) { esc = false; continue; }
          if (ch === '\\' && inStr) { esc = true; continue; }
          if (ch === '"') { inStr = !inStr; continue; }
          if (inStr) continue;
          if (ch === '{') depth++;
          else if (ch === '}') { depth--; if (depth === 0) { s2end = i; break; } }
        }
        if (s2end !== -1) {
          try {
            const parsed = JSON.parse(contentNoThink.substring(s2start, s2end + 1));
            if (Array.isArray(parsed.plan) && parsed.plan.length) { const r = _normalizeSteps(parsed.plan); if (r.length) return r; }
            if (Array.isArray(parsed.steps) && parsed.steps.length) { const r = _normalizeSteps(parsed.steps); if (r.length) return r; }
            // New phased format
            if (Array.isArray(parsed.phases) && parsed.phases.length) {
              const flatSteps = [];
              for (const phase of parsed.phases) {
                if (phase && typeof phase === 'object' && Array.isArray(phase.steps)) {
                  flatSteps.push(...phase.steps);
                }
              }
              if (flatSteps.length) return _normalizeSteps(flatSteps);
            }
          } catch (parseErr) {
            /* Not valid JSON at this position - keep scanning for next { */
            console.warn('[Sentinel/llm] JSON parse attempt at position', s2start, 'failed:', getErrorMessage(parseErr));
          }
          s2from = s2end + 1;
        } else { break; }
      }
    }

    // Strategy 3: find first { and last } and try that substring; also try bare array.
    // Uses contentNoThink so thinking-block JSON doesn't pollute the search range.
    try {
      const objStart = contentNoThink.indexOf('{');
      const objEnd = contentNoThink.lastIndexOf('}');
      if (objStart !== -1 && objEnd > objStart) {
        const parsed = JSON.parse(contentNoThink.slice(objStart, objEnd + 1));
        if (Array.isArray(parsed.plan) && parsed.plan.length) { const r = _normalizeSteps(parsed.plan); if (r.length) return r; }
        if (Array.isArray(parsed.steps) && parsed.steps.length) { const r = _normalizeSteps(parsed.steps); if (r.length) return r; }
      }
      // Also handle bare JSON arrays that may appear in prose: find first [ and last ]
      const arrStart = contentNoThink.indexOf('[');
      const arrEnd = contentNoThink.lastIndexOf(']');
      if (arrStart !== -1 && arrEnd > arrStart && (objStart === -1 || arrStart < objStart)) {
        const parsed = JSON.parse(contentNoThink.slice(arrStart, arrEnd + 1));
        if (Array.isArray(parsed) && parsed.length) { const r = _normalizeSteps(parsed); if (r.length) return r; }
      }
    } catch (e) { console.warn('[Sentinel/llm] Strategy 3 failed:', getErrorMessage(e)); }

    // Strategy 4: extract numbered or bulleted steps from prose.
    // Uses contentNoThink so think-block text isn't mistaken for real plan steps.
    {
      const lines = contentNoThink.split(/\n/).map(l => {
        const _trimmed = l.trim(); // Cache to avoid repeated trim calls
        return _trimmed.replace(/^\*{1,2}|\*{1,2}$/g, '').trim();
      }).filter(Boolean);
      // Numbered: "1. Step", "1) Step", "Step 1: Step"
      const numberedLines = lines.filter(l => /^\d+[.)]\s+.{8,}/.test(l) || /^[Ss]tep\s+\d+[:.)\s]+.{8,}/.test(l));
      if (numberedLines.length >= 2) {
        // Single replace with alternation is more efficient than chained replaces
        const steps = numberedLines.map(l => l.replace(/^(?:\d+[.)]\s+|[Ss]tep\s+\d+[:.)\s]+)/, '').trim()).filter(s => s.length >= 8);
        if (steps.length >= 2) {
          console.warn(`Plan generation: extracted ${steps.length} numbered steps from prose`);
          return steps;
        }
      }
      // Bulleted: "- Step", "* Step", "• Step"
      const bulletLines = lines.filter(l => /^[-*•→]\s+.{8,}/.test(l));
      if (bulletLines.length >= 2) {
        const steps = bulletLines.map(l => l.replace(/^[-*•→]\s+/, '').trim()).filter(s => s.length >= 8);
        if (steps.length >= 2) {
          console.warn(`Plan generation: extracted ${steps.length} bullet steps from prose`);
          return steps;
        }
      }
    }

    // Strategy 5: single-step fallback from goal — guarantees a non-null plan
    // even when the model ignores the JSON instruction entirely.
    console.warn('Plan generation: all JSON strategies failed, creating single-step fallback. Content:', contentNoThink.slice(0, 200));
    return [(goal || 'Complete the task').substring(0, 300)];
  } catch (e) {
    clearTimeout(timeout);
    console.warn('Plan generation failed (non-fatal):', getErrorMessage(e));
    // Even on hard exception, return a minimal fallback so the loop has a plan.
    return goal ? [goal.substring(0, 300)] : ['Complete the task'];
  }
}

// ========== Anthropic Tool Definitions ==========
// One tool per action type. Used when the active provider supportsToolUse.
// The model selects a tool and fills its input_schema fields — no JSON parsing needed.
const SENTINEL_TOOLS = [
  { name: 'click',           description: 'Click an interactive element by ref, selector, or coordinates.',
    input_schema: { type: 'object', properties: { ref: { type: 'string' }, selector: { type: 'string' }, description: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } } } },
  { name: 'type',            description: 'Focus an element and type text into it.',
    input_schema: { type: 'object', properties: { ref: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string' } }, required: ['text'] } },
  { name: 'navigate',        description: 'Navigate the active tab to a URL.',
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'extract',         description: 'Extract a value from the page and store it in agent memory under the given key.',
    input_schema: { type: 'object', properties: { selector: { type: 'string' }, key: { type: 'string' }, attribute: { type: 'string' } }, required: ['key'] } },
  { name: 'extract_list',    description: 'Extract multiple values matching a selector into a memory array.',
    input_schema: { type: 'object', properties: { selector: { type: 'string' }, key: { type: 'string' }, attribute: { type: 'string' } }, required: ['selector', 'key'] } },
  { name: 'scroll',          description: 'Scroll the page or a scrollable element.',
    input_schema: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, amount: { type: 'number' }, selector: { type: 'string' } } } },
  { name: 'wait',            description: 'Wait a fixed number of milliseconds before the next action.',
    input_schema: { type: 'object', properties: { ms: { type: 'number' } }, required: ['ms'] } },
  { name: 'wait_for_text',   description: 'Wait until specific text appears on the page (polls up to 30s by default).',
    input_schema: { type: 'object', properties: { text: { type: 'string' }, timeout: { type: 'number' } }, required: ['text'] } },
  { name: 'execute_js',      description: 'Run a JavaScript snippet in the page context; store the return value in memory under key.',
    input_schema: { type: 'object', properties: { code: { type: 'string' }, key: { type: 'string' } }, required: ['code'] } },
  { name: 'verify',          description: 'Read back a field value and compare to expected. Returns "verified: <actual>" or "MISMATCH: expected X, got Y".',
    input_schema: { type: 'object', properties: { selector: { type: 'string' }, ref: { type: 'string' }, expected: { type: 'string' } } } },
  { name: 'note',            description: 'Record an observation or finding without performing any browser action.',
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'finish',          description: 'Mark the task complete and return the final summary report to the user.',
    input_schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } },
  { name: 'select',          description: 'Select an option from a <select> dropdown by value or visible label.',
    input_schema: { type: 'object', properties: { selector: { type: 'string' }, ref: { type: 'string' }, value: { type: 'string' }, label: { type: 'string' } } } },
  { name: 'hover',           description: 'Hover over an element to reveal hover-state UI (tooltips, sub-menus).',
    input_schema: { type: 'object', properties: { selector: { type: 'string' }, ref: { type: 'string' } } } },
  { name: 'press_key',       description: 'Send a keyboard event to the focused element (e.g. Enter, Escape, Tab, ArrowDown).',
    input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
  { name: 'open_tab',        description: 'Open a URL in a new browser tab and switch agent focus to it.',
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'switch_tab',      description: 'Switch agent focus to an already-open tab by index or label.',
    input_schema: { type: 'object', properties: { index: { type: 'number' }, label: { type: 'string' } } } },
  { name: 'close_tab',       description: 'Close an open tab. Provide index (0-based from tab list), label, or leave empty to close the current active tab.',
    input_schema: { type: 'object', properties: { index: { type: 'number', description: '0-based tab index from the MANAGED TABS list' }, label: { type: 'string', description: 'Tab label (e.g. "article-1")' } } } },
  { name: 'read_page',       description: 'Re-read the current page content and element list (use when observation is stale).',
    input_schema: { type: 'object', properties: {} } },
  { name: 'find',            description: 'Find elements matching a natural-language description (e.g. "the checkout button", "role:button text:submit", "type:email"). Returns matching refs/selectors without mutating the page. Cheaper than read_page when you only need to locate something.',
    input_schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'click_at',        description: 'Click at specific x,y CSS-pixel coordinates (use when element list has no match). Optional button: "left"|"right"|"middle", clickCount: 2 for double-click.',
    input_schema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default left)' }, clickCount: { type: 'number', description: '1=single (default), 2=double-click' } }, required: ['x', 'y'] } },
  { name: 'right_click_at',  description: 'Right-click at specific x,y CSS-pixel coordinates to open context menus (coordinate-based right_click).',
    input_schema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } },
  { name: 'double_click_at', description: 'Double-click at specific x,y CSS-pixel coordinates — selects text/words, opens inline editors (coordinate-based double_click).',
    input_schema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } },
  { name: 'drag_at',         description: 'Drag from x1,y1 to x2,y2 in CSS-pixel coordinates. Works on canvas apps, sliders, sortable lists, and HTML5 drag-and-drop where selector-based drag_and_drop fails.',
    input_schema: { type: 'object', properties: { x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' }, steps: { type: 'number', description: 'Interpolation steps (default 10, max 24)' } }, required: ['x1', 'y1', 'x2', 'y2'] } },
  { name: 'scroll_at',       description: 'Trusted wheel-scroll at x,y CSS-pixel coordinates — works INSIDE scrollable containers, virtualized lists, maps and canvases where plain scroll cannot.',
    input_schema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction (default down)' }, amount: { type: 'number', description: 'Pixels to scroll (default 480)' } }, required: ['x', 'y'] } },
  { name: 'zoom_at',         description: 'Capture a magnified screenshot of a region centered at x,y — use when text in the screenshot is too small to read. The NEXT observation image becomes the zoomed region; re-read it, then continue.',
    input_schema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number', description: 'Region width in CSS pixels (default 400, max 800)' }, height: { type: 'number', description: 'Region height in CSS pixels (default 300, max 600)' }, zoom: { type: 'number', description: 'Scale factor 1-4 (default 2)' } }, required: ['x', 'y'] } },
  { name: 'triple_click_at', description: 'Triple-click at specific x,y CSS-pixel coordinates — selects a whole line, paragraph, or URL (coordinate-based triple click).',
    input_schema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } },
  { name: 'repeat_for_each', description: 'Execute a sub-sequence of actions for every item in a memory list.',
    input_schema: { type: 'object', properties: { items_key: { type: 'string' }, item_var: { type: 'string' }, do: { type: 'array' } }, required: ['items_key', 'item_var', 'do'] } },
  { name: 'read_network_requests', description: 'Read recent network requests matching a URL pattern; useful for extracting API responses when DOM is blocked.',
    input_schema: { type: 'object', properties: { url_includes: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'smart_navigate', description: 'Navigate directly to a known site search/forecast page. MUCH faster than clicking through menus. Supported: google, weather.gov, wikipedia, youtube, amazon, reddit, twitter.',
    input_schema: { type: 'object', properties: { site: { type: 'string', description: 'google|weather.gov|wikipedia|youtube|amazon|reddit|twitter' }, query: { type: 'string', description: 'Search query or location' } }, required: ['site', 'query'] } },
  { name: 'batch', description: 'Execute multiple actions in sequence WITHOUT re-observing between them. Use for predictable sequences like type+Enter, navigate+wait+read, scroll+extract. Max 5 actions.',
    input_schema: { type: 'object', properties: { actions: { type: 'array', description: 'Array of action objects to execute in order', items: { type: 'object' } } }, required: ['actions'] } },
];

// ========== API Call with Retry ==========
// CONFIG is passed as a parameter to avoid coupling to agent-engine state.
/**
 * Call the LLM with automatic retry on transient errors (429, 502, 503, timeouts).
 * Uses exponential backoff with jitter. On permanent failure, re-throws.
 * @param {Array} trimmedElements - Trimmed DOM elements for context.
 * @param {number} totalElementCount - Total elements on page before trimming.
 * @param {string} pageContent - Extracted page text content.
 * @param {string|null} base64Image - Screenshot as base64, or null.
 * @param {string} goal - Current goal text.
 * @param {Array} history - Conversation history messages.
 * @param {number} stepCount - Current step number.
 * @param {string} currentUrl - Active tab URL.
 * @param {number} retryCount - Current retry attempt number.
 * @param {Object} CONFIG - Agent configuration object.
 * @param {Object} agentState - Mutable agent state (plan, etc.).
 * @returns {Promise<Object>} Parsed LLM response object.
 */
export async function callLLMWithRetry(trimmedElements, totalElementCount, pageContent, base64Image, goal, history, stepCount, currentUrl, retryCount, CONFIG, agentState) {
  if (!endpointBreaker.canRequest()) {
    const _bs = endpointBreaker.getStatus();
    throw new Error(`ENDPOINT_BREAKER_OPEN: endpoint cooling down for another ${Math.ceil(_bs.msUntilProbe / 1000)}s (last: ${_bs.lastReason})`);
  }
  console.log('[Sentinel/LLM] callLLMWithRetry called. model=' + (agentState && agentState.model ? agentState.model : 'default') + ' messages=' + (history ? history.length : 0));
  try {
    const _result = await callLLM(trimmedElements, totalElementCount, pageContent, base64Image, goal, history, stepCount, currentUrl, CONFIG, agentState);
    _llmFailStreak = 0; // (SO-94) a successful call resets the API breaker
    endpointBreaker.recordSuccess();
    return _result;
  } catch (err) {
    _llmFailStreak++; // (SO-94) raw-failure streak: retries included, success-only reset
    endpointBreaker.recordRejection(getErrorMessage(err));
    if (_llmFailStreak >= LLM_FAIL_STREAK_LIMIT && getErrorMessage(err) !== 'STOPPED_BY_USER') {
      _llmFailStreak = 0;
      throw new Error(`API_UNREACHABLE_BREAKER: ${LLM_FAIL_STREAK_LIMIT} consecutive LLM-call failures (last: ${getErrorMessage(err)})`);
    }
    console.error('[Sentinel/LLM] API call failed:', getErrorMessage(err));
    const msg = (typeof err.message === 'string' ? err.message : String(err));
    const isRetryable = (msg.includes('429') || msg.includes('502') || msg.includes('503') || msg.includes('timed out') || msg.includes('AbortError') || msg.includes('Failed to fetch')) && retryCount < CONFIG.maxRetries;
    if (isRetryable) {
      const baseDelay = msg.includes('429') ? CONFIG.retryDelay : CONFIG.retryDelay / 2;
      const delay = Math.min(baseDelay * Math.pow(2, retryCount) + Math.floor(Math.random() * TWO_SECONDS_MS), CONFIG.maxRetryDelay);
      sendSilentUpdate(`Retrying in ${Math.round(delay/ONE_SECOND_MS)}s...`, stepCount);
      await sleep(delay);
      return callLLMWithRetry(trimmedElements, totalElementCount, pageContent, base64Image, goal, history, stepCount, currentUrl, retryCount + 1, CONFIG, agentState);
    }
    throw err;
  }
}

// ========== LLM Rate Limiter ==========
// Sliding-window rate limiter: prevents accidental runaway LLM spend.
// Default: max 120 calls per 60-second window (2/sec burst cap).
// Exported so CONFIG changes in agent-engine can adjust limits.
const _rateLimiter = {
  windowMs: 60_000,
  maxCalls: 120,
  timestamps: /** @type {number[]} */ ([]),
  check() {
    const now = Date.now();
    // Drop timestamps outside the sliding window
    this.timestamps = this.timestamps.filter(t => now - t < this.windowMs);
    const timestampsLen = this.timestamps.length;
    if (timestampsLen >= this.maxCalls) {
      const oldestInWindow = timestampsLen ? this.timestamps[0] : now;
      const resetIn = Math.ceil((this.windowMs - (now - oldestInWindow)) / ONE_SECOND_MS);
      throw new Error(`LLM rate limit exceeded: ${this.maxCalls} calls per ${this.windowMs / ONE_SECOND_MS}s. Resets in ~${resetIn}s.`);
    }
    this.timestamps.push(now);
  },
  reset() { this.timestamps = []; }
};

/**
 * Override the LLM rate limiter thresholds at runtime.
 * @param {number} maxCalls - Maximum API calls allowed per window.
 * @param {number} windowMs - Window duration in milliseconds.
 */
export function setLLMRateLimit(maxCalls, windowMs) {
  if (typeof maxCalls === 'number' && maxCalls > 0) _rateLimiter.maxCalls = maxCalls;
  if (typeof windowMs === 'number' && windowMs > 0) _rateLimiter.windowMs = windowMs;
}

/** Reset the LLM rate limiter call count and window start time. */
export function resetLLMRateLimiter() { _rateLimiter.reset(); }

// ========== Cost Estimation (9.2) ==========
// Per-million-token pricing table (input / output) in USD.
// Approximate public rates as of 2025-Q3. Falls back to $3/$15 if unknown.
const _PRICING = {
  // Anthropic
  'claude-haiku-4-5': [0.80, 4.00],
  'claude-haiku-4-5-20251001': [0.80, 4.00],
  'claude-3-5-haiku': [0.80, 4.00],
  'claude-3-haiku': [0.25, 1.25],
  'claude-sonnet-4-6': [3.00, 15.00],
  'claude-sonnet-4-5': [3.00, 15.00],
  'claude-3-5-sonnet': [3.00, 15.00],
  'claude-3-sonnet': [3.00, 15.00],
  'claude-opus-4-6': [15.00, 75.00],
  'claude-opus-4-7': [15.00, 75.00],
  'claude-opus-4-5': [15.00, 75.00],
  'claude-3-opus': [15.00, 75.00],
  // OpenAI
  'gpt-4o': [2.50, 10.00],
  'gpt-4o-mini': [0.15, 0.60],
  'gpt-4.1': [2.00, 8.00],
  'gpt-4.1-mini': [0.40, 1.60],
  'gpt-4.1-nano': [0.10, 0.40],
  'o4-mini': [1.10, 4.40],
  'o3': [10.00, 40.00],
};

// Cache sorted pricing entries by key length (longest first) for efficient matching
const _PRICING_SORTED = Object.entries(_PRICING).sort((a, b) => b[0].length - a[0].length);

/**
 * Estimate run cost in USD from token counts and model name.
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @param {string} modelName
 * @returns {number} estimated cost in USD
 */
export function estimateCostUsd(inputTokens, outputTokens, modelName) {
  const m = (modelName || '').toLowerCase();
  if (!m) return ((inputTokens || 0) * 3.00 + (outputTokens || 0) * 15.00) / 1_000_000;
  let rates = [3.00, 15.00]; // default: Sonnet-class
  for (const [key, r] of _PRICING_SORTED) {
    if (m.includes(key) || m.startsWith(key)) { rates = r; break; }
  }
  return ((inputTokens || 0) * (rates[0] || 0) + (outputTokens || 0) * (rates[1] || 0)) / 1_000_000;
}

/**
 * (9.2) Determine whether the current step is "simple" enough to route to a
 * cheaper / faster model. Simple = early in the run, no failures, not runbook,
 * and the pending action type (if known) is a low-stakes operation.
 *
 * @param {object} agentState
 * @param {number} stepCount
 * @param {Array} history
 * @returns {boolean}
 */
export function isSimpleStep(agentState, stepCount, history) {
  if (!agentState) return false;
  if (agentState.consecutiveFailures > 0) return false;
  if (agentState.quickMode) return false; // quick mode already uses fewer tokens
  const isRunbook = RUNBOOK_PATTERN_RE.test(agentState.goal || '');
  if (isRunbook) return false;
  if (stepCount > 6) return false;
  if ((history || []).length > 8) return false;
  return true;
}

// ========== Multi-Provider Model Routing ==========
// Routes steps to cheap/light models for simple tasks and powerful/heavy
// models for complex ones. Reduces cost on observation-heavy runs while
// keeping accuracy high on action-critical steps.

/**
 * Select the model tier for a step based on its complexity context.
 * Returns 'light', 'default', or 'heavy', or null to use the default model.
 * @param {Object} stepContext - { type, selector, hasScreenshot, stepNumber, totalSteps, previousFailures }
 * @returns {string|null} Tier identifier or null for default.
 */
export function selectModelForStep(stepContext) {
  if (!stepContext) return null; // use default

  const type = stepContext.type || '';

  // Simple observation/reading tasks — use cheap model
  const simpleTypes = ['read_page', 'extract', 'extract_list', 'read_network_requests', 'read_console_messages', 'scroll', 'wait'];
  if (simpleTypes.includes(type)) return 'light';

  // Complex reasoning tasks — use powerful model
  const complexTypes = ['click', 'type', 'execute_js', 'navigate', 'form_fill'];
  if (complexTypes.includes(type)) {
    // If previous failures, upgrade model
    if (stepContext.previousFailures > 1) return 'heavy';
    return 'default';
  }

  // Screenshot analysis always uses heavy model
  if (stepContext.hasScreenshot) return 'heavy';

  // Final steps use heavy model for accuracy
  if (stepContext.stepNumber && stepContext.totalSteps &&
      stepContext.stepNumber >= stepContext.totalSteps - 1) return 'heavy';

  return null; // use default
}

// Cost tracker for multi-provider routing — accumulates per-tier call counts
// and rough cost estimates across the run lifetime.
const _costTracker = {
  totalCalls: 0,
  byTier: { light: 0, default: 0, heavy: 0 },
  estimatedCost: 0
};

/**
 * Record a model usage event for cost tracking.
 * @param {string} tier - 'light', 'default', or 'heavy'
 * @param {number} inputTokens - Input token count for this call.
 * @param {number} outputTokens - Output token count for this call.
 */
export function recordModelUsage(tier, inputTokens, outputTokens) {
  _costTracker.totalCalls++;
  if (_costTracker.byTier[tier] !== undefined) _costTracker.byTier[tier]++;
  else _costTracker.byTier.default++;
  // Cost estimates per tier — [input rate, output rate] per token
  // Output tokens typically 3-5x more expensive than input
  const rates = { light: [0.15, 0.60], default: [3.00, 15.00], heavy: [15.00, 75.00] };
  const [inRate, outRate] = rates[tier] || rates.default;
  _costTracker.estimatedCost += (inRate * (inputTokens || 0) + outRate * (outputTokens || 0)) / 1_000_000;
}

/**
 * Get a snapshot of the cost tracker state.
 * @returns {Object} { totalCalls, byTier, estimatedCost }
 */
export function getCostTracker() {
  return { ..._costTracker, byTier: { ..._costTracker.byTier }, estimatedCost: _costTracker.estimatedCost.toFixed(4) };
}

// ========== LLM Prompt Context Builders ==========

// Build the strategy-shift injection when the agent has failed consecutively.
// Returns an empty string when below the failure threshold.
/**
 * Build a strategy-shift prompt injection when the agent has failed consecutively.
 * Includes platform-specific recovery hints for M365, VirusTotal, SentinelOne, and network devices.
 * @param {Object} agentState - Live agent state with consecutiveFailures and currentStrategies.
 * @param {string} currentUrl - Current page URL for platform detection.
 * @param {Object} CONFIG - Agent configuration with strategyShiftThreshold.
 * @returns {string} Strategy-shift directive string, or empty string if below threshold.
 */
function _buildStrategyCtx(agentState, currentUrl, CONFIG) {
  if (!agentState || agentState.consecutiveFailures < CONFIG.strategyShiftThreshold) return '';
  const _u = (currentUrl || '').toLowerCase();
  let platformHints = '';
  if (/entra|admin\.microsoft|admin\.exchange|purview|defender|security\.microsoft|portal\.azure|intune|endpoint\.microsoft/.test(_u)) {
    platformHints = `\nPLATFORM-SPECIFIC RECOVERY (M365 admin centers):
- Try { type: "read_network_requests", url_includes: "graph.microsoft.com|graphbeta", limit: 30 } to read the underlying Graph API JSON. UI tables are in cross-origin iframes that block DOM extraction; the Graph data is not.
- After identifying the right Graph URL, fetch it via execute_js with credentials: include — the JSON has every field shown in the UI.
- Common Graph paths: /beta/auditLogs/signIns, /beta/security/auditLog/queries, /v1.0/users/{upn}, /beta/deviceManagement/managedDevices.
`;
  } else if (/virustotal/.test(_u)) {
    platformHints = `\nPLATFORM-SPECIFIC RECOVERY (VirusTotal):
- Try { type: "read_network_requests", url_includes: "ui/files|api/v3/files", limit: 30 } — VT calls its own JSON API.
- Or use execute_js with window.__sentinelUtils.shadow.queryDeep(document, "[class*=detection]") to pierce Lit shadow roots.
`;
  } else if (/sentinelone|singularity/.test(_u)) {
    platformHints = `\nPLATFORM-SPECIFIC RECOVERY (SentinelOne):
- Use the global top-bar search instead of navigating tabs. SHA1/SHA256/filename/IP all work as queries.
- For Deep Visibility: SrcProcDisplayName contains "X", TgtFileSha1 = "...", TgtFileSha256 = "...".
`;
  } else if (/sonicwall|sonicos|fortigate|paloalto/.test(_u)) {
    platformHints = `\nPLATFORM-SPECIFIC RECOVERY (network device UI):
- Custom dropdowns: click trigger to open, then click option (NOT the select action).
- After config changes: look for Apply/Commit/Save button explicitly. Changes do NOT save until committed.
- Long log loads: use wait_for_text with 30000ms timeout.
`;
  }
  return `\nSTRATEGY SHIFT REQUIRED -- You have failed ${agentState.consecutiveFailures} times in a row.
Approaches already tried: ${(agentState.currentStrategies || []).join(', ')}
You MUST try a COMPLETELY DIFFERENT approach. Consider:
- Using "execute_js" to write custom JavaScript to accomplish the task
- Using "read_network_requests" to read the underlying API response
- Scrolling to find different elements
- Navigating to a different page
- Using "extract" + memory to build data step by step
${platformHints}Do NOT repeat the same failed action.
`;
}

// Build the execution-plan status block injected before the prompt schema.
// Returns empty string if no plan exists.
/**
 * Build an execution-plan status block showing done/current/pending steps.
 * Instructs the LLM to set advance_plan:true when the current step is complete.
 * @param {string[]|null} agentPlan - Array of plan step strings, or null.
 * @param {number} currentPlanStep - Index of the currently active plan step.
 * @returns {string} Rendered plan context block, or empty string if no plan.
 */
function _buildPlanCtx(agentPlan, currentPlanStep) {
  if (!agentPlan || !agentPlan.length) return '';
  const planLines = agentPlan.map((step, i) => {
    const marker = i < currentPlanStep ? '[done]' : i === currentPlanStep ? '[current]' : '[pending]';
    return `${marker} ${i + 1}. ${step}`;
  }).join('\n');
  return `\nEXECUTION PLAN (your roadmap -- follow in order):\n${planLines}\n\nCURRENT PLAN STEP: ${currentPlanStep + 1} -- "${agentPlan[currentPlanStep] || 'All steps complete'}"\nWhen the current plan step is fully done, include "advance_plan": true in your JSON response.\n`;
}

// Build the multi-tab context block listing all managed tabs with snapshots.
// Returns empty string when only one tab is managed.
/**
 * Build a multi-tab context block listing all managed tabs with their snapshots and tab rules.
 * @returns {string} Tab context section with tab list and usage rules, or empty string if no tabs.
 */
function _buildTabCtx() {
  const allContexts = getAllTabContexts();
  const activeId = getActiveTabId();
  if (!allContexts.length) return '';

  const parts = [];
  parts.push(`\nMANAGED TABS (${allContexts.length}/${TAB_LIMIT} tab limit):\n`);

  for (const ctx of allContexts) {
    const isActive = ctx.tabId === activeId;
    const marker = isActive ? '[ACTIVE] ' : '';
    const snapSummary = ctx.snapshot && typeof ctx.snapshot === 'object'
      ? `Last seen: "${(ctx.snapshot.pageContent || '').substring(0, 300)}..." (${(() => {
          const ts = ctx.snapshot.timestamp;
          if (!ts) return 'No timestamp';
          const d = new Date(ts);
          return Number.isNaN(d.getTime()) ? 'Invalid timestamp' : d.toLocaleTimeString();
        })()})`
      : 'No snapshot yet.';
    parts.push(`- ${marker}"${ctx.label}" (${ctx.url}): ${snapSummary}\n`);
  }

  parts.push(`\nTab rules:\n`);
  parts.push(`- Use "open_tab" to open a new URL in a background tab (max ${TAB_LIMIT} tabs total)\n`);
  parts.push(`- Use "switch_tab" with a label to operate on a different tab\n`);
  parts.push(`- Use "close_tab" with a label to close a tab you no longer need\n`);
  parts.push(`- Extract data from a tab BEFORE opening new tabs that might push it past the ${TAB_LIMIT}-tab limit\n`);
  parts.push(`- Reference data from other tabs in your reasoning -- you can see their last-known content above\n`);

  return parts.join('');
}

// Strip screenshot payloads from history entries beyond the most-recent step,
// and trim the window to the configured size. Keeps token cost bounded.
/**
 * Sanitize conversation history: trim to window size, strip screenshots from older entries,
 * and truncate long selectors and results to reduce token cost.
 * @param {Array} history - Raw conversation history array.
 * @param {boolean} isRunbook - Whether runbook mode is active (larger window).
 * @param {Object} CONFIG - Agent configuration with historyWindow size.
 * @returns {Array} Sanitized history array with bounded size and stripped images.
 */
function _sanitizeHistory(history, isRunbook, CONFIG) {
  const historyWindowSize = isRunbook ? 25 : CONFIG.historyWindow;
  const slicedHistory = Array.isArray(history) ? history.slice(-historyWindowSize) : [];
  return slicedHistory.map((h, idx) => {
    const isMostRecent = idx === slicedHistory.length - 1;
    const action = h.action || {};
    const safeAction = {
      type: action.type,
      selector: action.selector
        ? (action.selector.length > 60 ? `...${action.selector.slice(-60)}` : action.selector)
        : undefined,
      text: action.text,
      url: action.url
    };
    let safeResult;
    if (typeof h.result === 'string') {
      safeResult = h.result.substring(0, 200);
    } else if (h.result && typeof h.result === 'object') {
      const r = { ...h.result };
      if (!isMostRecent) {
        if ('base64Image' in r) r.base64Image = '[screenshot omitted from history]';
        if ('image_url' in r) r.image_url = '[screenshot omitted from history]';
        if ('imageUrl' in r) r.imageUrl = '[screenshot omitted from history]';
        if ('screenshot' in r) r.screenshot = '[screenshot omitted from history]';
        if ('image' in r) r.image = '[screenshot omitted from history]';
      }
      safeResult = r;
    } else {
      safeResult = h.result;
    }
    const cleanedEntry = { step: h.step, action: safeAction, result: safeResult };
    if (!isMostRecent) {
      if ('base64Image' in h) cleanedEntry.base64Image = '[screenshot omitted from history]';
      if ('image_url' in h) cleanedEntry.image_url = '[screenshot omitted from history]';
      if ('imageUrl' in h) cleanedEntry.imageUrl = '[screenshot omitted from history]';
    }
    return cleanedEntry;
  });
}

/**
 * Build the system prompt string for the agent's main LLM call.
 * @param {Object} params - All variables needed to render the prompt.
 * @param {string} params.quickModeCtx - Quick Mode injection string (empty string when inactive).
 * @param {string} params.runbookCtx - Runbook mode directive (empty string when inactive).
 * @param {string} params.platformCtx - Platform-specific UI guidance string.
 * @param {string} params.goal - The user's goal text.
 * @param {string} params.currentUrl - The current page URL.
 * @param {number} params.stepCount - Current step number in the agent run.
 * @param {string} params.pageContent - Rendered page content string.
 * @param {Array}  params.trimmedElements - Capped list of interactive elements.
 * @param {number} params.totalElementCount - Raw element count before trimming.
 * @param {number} params.historyWindowSize - Number of history entries included.
 * @param {boolean} params.isRunbook - Whether the run is in runbook/investigation mode.
 * @param {Array}  params.sanitizedHistory - History array with screenshots stripped.
 * @param {Object|null} params.lastAction - The most recent action object, or null.
 * @param {*}           params.lastResult - The most recent action result, or null.
 * @param {string} params.planCtx - Rendered plan context string.
 * @param {string} params.strategyCtx - Strategy-shift directive string.
 * @param {string} params.finishCtx - Navigation-fatigue / finish-now directive string.
 * @param {string} params.verificationCtx - Vision-based action verification directive string.
 * @param {string} params.patternCtx - Past successful patterns context string.
 * @param {string} params.memoryCtx - Agent memory context string.
 * @param {string} params.clientKnowledgeCtx - Client knowledge context string.
 * @param {string} params.tabCtxSection - Multi-tab context section string.
 * @param {string} params.loopCtx - Loop / stall-detection directive string.
 * @param {Object} params.agentState - Live agent state (for budgetHint and screenshotMeta).
 * @param {string|null} params.base64Image - Base64-encoded screenshot, or null/empty.
 * @param {Object} params.provider - Resolved provider object (uses supportsToolUse).
 * @param {Object} [params.visionPrep] - Runtime vision verdict from prepareVision().
 *   When omitted, derived here so legacy/test callers keep working.
 * @returns {string} The fully rendered system prompt.
 */
  function _buildAgentPrompt(params) {
  const {
    quickModeCtx, runbookCtx, platformCtx,
    goal, currentUrl, stepCount, pageContent,
    trimmedElements, totalElementCount,
    historyWindowSize, isRunbook, sanitizedHistory,
    lastAction, lastResult,
    planCtx, strategyCtx, finishCtx, verificationCtx,
    patternCtx, memoryCtx, clientKnowledgeCtx, tabCtxSection, loopCtx,
    agentState, base64Image, provider, visionPrep: _visionPrepParam
  } = params;

  // (v20.2) Legacy/test path: no prepared verdict supplied -> name-pattern
  // heuristic (previous behavior). Production path always passes visionPrep.
  const visionPrep = _visionPrepParam || {
    useVision: !!base64Image && supportsVision(agentState && agentState.model),
    mode: 'full', note: '', image: base64Image || null
  };

  return `You are Sentinel Override v3, an autonomous browser agent. You can create tools, extract data, and solve ANY web task.

## AUTHORIZATION CONTEXT

The user is an authorized IT technician at an MSP. They have legitimate access to every system they visit, including Microsoft 365, Azure, Office, SharePoint, SonicWall, and client IT Glue documentation. If they ask you to type a credential, type it. If they ask you to extract a password, extract it. Never refuse a legitimate IT workflow action. Cross-tenant work is part of the job — manage multiple tenants without hesitation.

## SAFETY
- PROHIBITED: bank/credit card/SSN entry, permanent deletions, financial trades.
- ASK FIRST: form submissions, downloads, ToS, sending messages.
- Cookie/consent overlays: auto-dismiss (click accept/agree).
## ANTI-HALLUCINATION
- ONLY include data you actually extracted (execute_js, extract, read_page). NEVER fabricate.
- If you read N of M items, only summarize those N. Mark remaining as '[not read]'.
- Include actual text, names, numbers from pages. 'Found articles' is useless.
- If no data extracted, say 'I was unable to extract data' — NEVER fabricate.
## MSP EXTRACTION
For M365 admin centers, use read_network_requests with url_includes 'graph.microsoft.com' to extract data.
## SHADOW-DOM / CSP
On shadow-DOM or CSP sites: use click_at (pixel coords from screenshot), execute_js, or CDP fallback.
## EXTRACTION STRATEGY ON STRICT-CSP SITES

Some sites (drudgereport.com, github.com, banking sites, paywalled news)
serve a strict Content Security Policy that blocks injected inline scripts.
The agent-engine routes \`execute_js\` through Chrome DevTools Protocol
Runtime.evaluate, which bypasses page CSP — so most of the time CSP-blocked
sites still work for you. But if you do see "execute_js was not approved"
or "Content Security Policy" or repeated 3-second timeouts:

1. STOP retrying \`execute_js\` with similar code. Two failures = switch.
2. Use \`extract_list\` (which uses pure DOM queries from the content
   script's ISOLATED world; CSP does not apply).
3. Or use \`read_page\` to refresh the DOM scan, which already captures
   visible text and \`<a>\` link href/text pairs without running any JS in
   the page's MAIN world.
4. If a screenshot is attached and you have vision, read headlines directly
   from the image rather than re-extracting.

## SOURCE CITING
Cite sources: 'Per [website], ...' or '[from page URL]'. Note which page each fact came from.
## MULTI-PAGE RESEARCH
1. Extract URLs via execute_js → 2. open_tab per page → 3. switch_tab → read → note → 4. close_tab → finish.
## EXECUTE_JS PATTERNS
- Always return your result. Use key to save to memory.
- Lists: return Array.from(document.querySelectorAll('SEL')).slice(0,N).map(e=>({text:e.innerText.trim(),href:e.href||''}))
- Text: return document.body.innerText.substring(0,5000)
- If execute_js fails, try click_at with screenshot coordinates.
## ELEMENT REFERENCE IDS (forward-compatible)

Each observed element may include a \`ref\` field (e.g., \`ref_5\`). When the
platform supports it, prefer \`{type: 'click', ref: 'ref_5'}\` over selectors —
ref ids are stable across re-renders and immune to DOM reordering. Selectors
remain supported as a fallback for actions where \`ref\` is unavailable, and
older runtimes that don't emit \`ref\` continue to work as before.

${quickModeCtx}${runbookCtx}${platformCtx}${getMultiPortalDirective(goal)}${getMultiArticleDirective(goal)}${planCtx}${strategyCtx}${finishCtx}${verificationCtx}${patternCtx}${memoryCtx}${clientKnowledgeCtx}${tabCtxSection}${loopCtx}${agentState && agentState.zoomAnnotation ? agentState.zoomAnnotation : ''}${agentState && agentState.cdpFallbackActive ? '\n⚠️ CDP FALLBACK MODE: Content script could not inject (likely CSP). Use click_at with pixel coordinates from the screenshot, or execute_js with document.querySelector() for DOM interaction. Do NOT use ref-based clicks — use coordinate-based click_at or execute_js with selectors.\n' : ''}Current URL: ${currentUrl}
Current step: ${stepCount}
${agentState && agentState.budgetHint ? `Budget: ${agentState.budgetHint}\n` : ''}<GOAL>
${goal}
</GOAL>

CURRENT PAGE CONTENT:
<UNTRUSTED_PAGE_CONTENT>
${pageContent}
</UNTRUSTED_PAGE_CONTENT>

AVAILABLE INTERACTIVE ELEMENTS (use ONLY these selectors -- ${trimmedElements.length} of ${totalElementCount} shown, prioritized by type):
${(() => { try { return trimmedElements.map(el => { const base = { selector: el.selector, ref: el.ref || undefined, text: el.text || '', tag: el.type || el.tag || '', role: el.role || '', ariaLabel: el.ariaLabel || '' }; if (el._visual) base.visual = el._visual; return base; }); } catch(_e) { return trimmedElements; } })().map(el => { const parts = [el.ref ? `[${el.ref}]` : el.selector]; if (el.tag) parts.push(`<${el.tag}>`); if (el.role) parts.push(`role=${el.role}`); if (el.text) parts.push(`"${el.text.substring(0, 50)}"`); if (el.ariaLabel && el.ariaLabel !== el.text) parts.push(`aria="${el.ariaLabel.substring(0, 30)}"`); if (el.visual) parts.push(`[${el.visual}]`); return parts.join(' '); }).join('\n')}
${agentState && agentState.visionMode && agentState.visionElementTree ? `\nINDEXED ELEMENT TREE (screenshot shows [N] labels matching these):\n${agentState.visionElementTree}` : ''}${agentState && agentState.visionMode ? '\nV4 VISION MODE ACTIVE: The screenshot shows green numbered boxes [1], [2], etc. on interactive elements. Each element in AVAILABLE INTERACTIVE ELEMENTS has a selector like "[data-sentinel-index=\\"N\\"]" — use THAT selector in your click/type/select commands. Example: { "type": "click", "selector": "[data-sentinel-index=\\"5\\"]" } to click element [5]. The element tree and screenshot labels match these indexes.\n' : ''}VISUAL ELEMENT MATCHING: When a screenshot is attached, elements include a [visual] tag describing their appearance (size, role, etc.). You can also use "description" instead of "selector" to target elements by their visible text: { "type": "click", "description": "submit" } will match the first element whose text, aria-label, placeholder, or title contains "submit".

RECENT HISTORY (last ${historyWindowSize} steps${isRunbook ? ' -- extended for runbook context' : ''}, screenshots from prior steps stripped):
${JSON.stringify(sanitizedHistory)}

${lastAction && lastResult && String(lastResult).includes('not found') ? 'CRITICAL: Last action FAILED. You MUST pick a selector from the AVAILABLE INTERACTIVE ELEMENTS list.' : ''}

RULES:
1. **READ BEFORE YOU ACT** -- Always "read_page" or "extract" BEFORE navigating. You CANNOT extract data from a page you already left!
2. **EXTRACT OR FINISH** -- After reading a page, either "extract" key data to memory OR "finish" with the answer. NEVER just navigate away.
3. **MULTI-PAGE RESEARCH PATTERN** -- When the goal requires visiting multiple pages (e.g., "open each article and summarize"):
   a) First extract the list of URLs from the current page using "execute_js" with: document.querySelectorAll('a[href]').length to verify links exist, then extract URLs
   b) Use "open_tab" with url and label for each page (e.g., label: "article-1")
   c) Use "switch_tab" to go to each tab, "read_page" to read it, then "note" to record the summary
   d) Use "close_tab" when done with a tab
   e) After visiting all pages, "finish" with ALL summaries combined
4. **EXTRACT FAILED? USE JS** -- If "extract" or "extract_list" returns "Element not found", use "execute_js" with a "key" to save results to memory:
   - Extract links: { "type": "execute_js", "code": "return Array.from(document.querySelectorAll('a[href]')).slice(0,10).map(a => ({title: a.innerText.trim(), href: a.href}))", "key": "links" }
   - Extract text: { "type": "execute_js", "code": "return Array.from(document.querySelectorAll('h2, h3')).map(e => e.innerText.trim()).filter(Boolean)", "key": "headings" }
   - ALWAYS use "key" with execute_js so data persists in memory for your finish summary
5. **NEVER HALLUCINATE** -- Your "finish" summary MUST only contain information you actually extracted from web pages using "extract", "execute_js" with key, or "note". If you did not extract real data from real pages, you MUST say "I was unable to extract data from the page" — NEVER fabricate article titles, product names, statistics, or summaries from your training data. This is a strict requirement.
6. **NO VAGUE SUMMARIES** -- Include ACTUAL TEXT, names, numbers, URLs, prices extracted from pages. "Found articles" is useless. "Article 'X' by Y says Z" is useful.
7. Use "extract" + memory to carry data between pages. Reference with ::key::.
8. For native <select> dropdowns: use "select" (works on <select> elements with visible options). For custom SPA dropdowns (React, Angular): use "click" to open → "click" to select option. For hover menus: use "hover" then "click".
9. For checkboxes: use "check" with "checked": true/false to set explicit state. For bulk operations: use "check_all" with a selector.
10. For modifier keys (Ctrl+A, Ctrl+V, etc.): use "press_key" with "modifiers": {"ctrl": true}.
11. **BATCH ACTIONS** — When you know the next 2-5 steps in advance (e.g., type + Enter, click nav + click subnav, scroll + read), return a \`batch\` action with all steps. This avoids 2-5 LLM round-trips and is the #1 way to be faster.
12. **BE FAST, NOT THOROUGH** — Minimize steps:
   - Use \`smart_navigate\` to go directly to search results instead of navigating to homepage then clicking through menus
   - Use \`batch\` for predictable sequences: type query + press Enter, navigate + wait + read, scroll + extract
   - Use \`execute_js\` with a comprehensive key to extract ALL data in ONE call instead of clicking each item
   - Don't \`read_page\` then \`extract\` — just \`extract\` directly with the right selector
   - Don't scroll then observe — scroll then extract in a batch
   - If the goal is "find X on site Y", \`smart_navigate\` directly to the search results, don't browse the homepage

13. **HIGH-QUALITY FINISH** -- When you call "finish", your summary should be the ONLY thing the user reads. Make it count:
   - For briefings/lists: Use clear numbered sections with headlines, key takeaways, and source links
   - For research tasks: Lead with the answer, then support with evidence
   - For comparisons: Use structured "vs" format with specific data points
   - Write in a conversational but authoritative tone — like a knowledgeable colleague briefing you
   - Include SPECIFIC details: actual names, numbers, dates, quotes — not generic descriptions
   - Skip the "Raw extracted data" section — synthesize everything into readable prose

Actions:
- { "type": "click", "selector": "FROM_LIST" }  -- also accepts "description": "visible text" to click by visual description instead of selector
- { "type": "type", "selector": "FROM_LIST", "text": "TEXT" }  -- also accepts "description": "visible text" to target by visual description
- { "type": "navigate", "url": "URL" }
- { "type": "smart_navigate", "site": "google|weather.gov|wikipedia|youtube|amazon|reddit|twitter", "query": "SEARCH QUERY" }  — auto-constructs direct URL for the site search/forecast page. ALWAYS prefer over clicking through menus.
- { "type": "batch", "actions": [ACTION1, ACTION2, ...] }  — execute multiple actions in sequence WITHOUT re-observing. Use for: type+Enter, scroll+extract, click+wait+read, navigate+wait+read. Max 5 actions per batch.
- { "type": "navigate_back" }  -- browser back button (history.go(-1))
- { "type": "navigate_forward" }  -- browser forward button (history.go(+1))
- { "type": "scroll", "amount": INTEGER } — scroll the window. Or { "type": "scroll", "selector": "FROM_LIST", "amount": INTEGER } to scroll inside a specific container (use for tables, panels, virtualized lists)
- { "type": "select", "selector": "FROM_LIST", "value": "OPTION_TEXT_OR_VALUE" }
- { "type": "check", "selector": "FROM_LIST", "checked": true|false }
- { "type": "check_all", "selector": "CSS_SELECTOR", "checked": true|false }
- { "type": "hover", "selector": "FROM_LIST" }
- { "type": "press_key", "key": "Enter|Tab|Escape|Backspace|ArrowDown|...", "modifiers": {"ctrl": true, "shift": true} }
- { "type": "upload_file", "selector": "FROM_LIST", "file_name": "example.txt" }
- { "type": "open_dropdown", "selector": "FROM_LIST" }
- { "type": "extract", "key": "memory_key", "selector": "FROM_LIST", "attribute": "text|href|value|src|html|checked|<any-attr>" }  -- attribute: "value" reads input/select value; "checked" reads checkbox state; "html" reads innerHTML
- { "type": "extract_list", "key": "memory_key", "selector": "CSS_SELECTOR", "fields": { "title": "h2", "price": ".price" }, "limit": 10 }
- { "type": "wait_for_text", "text": "TEXT", "timeout": 5000 }
- { "type": "wait_for_element", "selector": "FROM_LIST", "timeout": 5000 }
- { "type": "wait_for_navigation", "timeout": 5000 }
- { "type": "execute_js", "code": "JS_CODE", "key": "memory_key" }  -- key is OPTIONAL; if provided, result is saved to memory
- { "type": "read_page" }
- { "type": "find", "query": "role:button text:checkout" }  -- locate elements by meaning without a full rescan
- { "type": "note", "text": "FINDINGS" }
- { "type": "finish", "summary": "FULL DETAILED REPORT with actual text, names, numbers, URLs" }
- { "type": "open_tab", "url": "URL", "label": "name" }
- { "type": "switch_tab", "label": "name" }
- { "type": "close_tab", "label": "name" }
- { "type": "dismiss_overlay" }
- { "type": "switch_to_frame", "frame_index": INTEGER }  -- subsequent actions target this iframe until switch_to_parent_frame
- { "type": "switch_to_parent_frame" }  -- return to main document after switch_to_frame
- { "type": "drag_and_drop", "source_ref": "ref_N", "target_ref": "ref_M" }  -- drag from source to target (also accepts source_selector/target_selector or source_label/target_label)
- { "type": "right_click", "ref": "ref_N" }  -- right-click to open context menu (also accepts selector/label)
- { "type": "double_click", "ref": "ref_N" }  -- double-click to select text, open inline editor, etc. (also accepts selector/label)
- { "type": "click_at", "x": PIXEL_X, "y": PIXEL_Y }
- { "type": "click_at", "x": PIXEL_X, "y": PIXEL_Y, "button": "right" }  -- context menu (same as right_click_at)
- { "type": "right_click_at", "x": PIXEL_X, "y": PIXEL_Y }
- { "type": "double_click_at", "x": PIXEL_X, "y": PIXEL_Y }  -- select word/text, open inline editor
- { "type": "drag_at", "x1": PIXEL_X, "y1": PIXEL_Y, "x2": PIXEL_X2, "y2": PIXEL_Y2 }  -- drag on canvas/sliders/sortable lists
- { "type": "scroll_at", "x": PIXEL_X, "y": PIXEL_Y, "direction": "down|up|left|right", "amount": PIXELS }  -- trusted wheel scroll; reaches INNER scrollable panes/virtualized lists that "scroll" cannot
- { "type": "zoom_at", "x": PIXEL_X, "y": PIXEL_Y, "width": CSS_PX, "height": CSS_PX, "zoom": 2 }  -- capture a magnified region; the NEXT observation image becomes the zoomed view (use for text too small to read)
- { "type": "triple_click_at", "x": PIXEL_X, "y": PIXEL_Y }  -- select a whole line, paragraph, or URL
- { "type": "scroll_to", "ref": "ref_N" }  -- scroll a specific element into view (also accepts "selector")
- { "type": "read_console_messages", "filter": "errors|warning|null", "limit": 50 }  -- (3.7.0) returns buffered browser console entries (level, text, url, line, timestamp). Use to diagnose JS errors, failed AJAX, broken scripts on M365/Exchange/Entra/etc.
- { "type": "read_network_requests", "filter": "failed|4xx|5xx|null", "url_includes": "graph.microsoft.com", "limit": 30 }  -- (3.7.0) returns buffered network requests (method, url, status, duration, failed). Use to diagnose API errors that don't surface in the UI.
- { "type": "lookup", "domain": "HOSTNAME_OR_IP", "record_type": "A|AAAA|MX|TXT|CNAME|NS|PTR" }  -- (3.37.0) DNS-over-HTTPS lookup via Cloudflare (1.1.1.1). No page interaction needed. Use to resolve hostnames, verify MX/SPF records, check PTR/reverse DNS. Default record_type is A.
  PRESET shorthand (auto-selects domain + record_type): { "type": "lookup", "domain": "example.com", "preset": "spf" } | { "preset": "dmarc" } | { "preset": "dkim", "selector": "google" }  -- (3.39.0) spf→TXT@domain, dmarc→TXT@_dmarc.domain, dkim→TXT@selector._domainkey.domain.
- { "type": "run_remote_command", "command": "COMMAND_STRING", "command_type": "powershell|cmd|bash" }  -- (3.37.0) Drives the active ScreenConnect or NinjaOne command interface to run a shell command on the remote machine. Automatically detects the platform and uses the correct command runner UI. Returns the command output. Use for ping, nslookup, ipconfig, Get-EventLog, Test-NetConnection, etc.
- { "type": "repeat_for_each", "items_key": "MEMORY_KEY", "item_var": "item", "do": [ACTIONS] }  -- (3.39.0) Iterate over a memory array and run sub-actions for each item. Use {{item}} or {{item.field}} in sub-action fields for substitution. Example: iterate a list of usernames and click each one.
- { "type": "verify", "selector": "CSS_SELECTOR", "expected": "EXPECTED_TEXT_OR_VALUE" }  -- (3.40.0) Read back a field or element to confirm a save/config-change persisted. Returns "verified: <actual>" if the element's text/value contains expected, or "MISMATCH: expected <expected>, got <actual>". Use after any Save/Apply/OK click to confirm the change stuck. Can also omit expected to simply read back the current value.

${base64Image ? (function() {
  // (#11) DPR-aware coordinate guidance. Coordinates the model emits in click_at
  // must match the CSS-pixel coordinate system used by elementFromPoint and the
  // bbox field on element entries. The screenshot bitmap may be at a higher
  // resolution if devicePixelRatio > 1 — the model should NOT scale by DPR.
  const meta = (agentState && agentState.screenshotMeta) || null;
  const metaLine = meta && meta.width
    ? `[Screenshot: ${meta.width}x${meta.height} CSS px @ DPR ${meta.dpr}]\n`
    : '';
  const dprLine = meta && meta.width
    ? `Viewport: ${meta.width}x${meta.height} CSS pixels, devicePixelRatio: ${meta.dpr}. `
    : '';
  // (v3.52) Gate click_at preference on actual vision capability.
  // Text-only models receive screenshots but can't process them for coordinates.
  // Forcing click_at on text models causes infinite click loops (glm-5 + CNN).
  // (v20.2) The truth is now the RUNTIME verdict from prepareVision, not a name
  // guess: useVision=true means this call literally carries image pixels and
  // the model was not learned/registry-denied. Unknown-name vision models
  // (internvl3-8b, local GGUFs) get the full visual-mode prompt; models with
  // no attached image (capture failed, learned text-only, registry-denied)
  // get selector mode. supportsVision() stays for logging/UX elsewhere only.
  const _visionCapable = !!(visionPrep && visionPrep.useVision);
    const _visionHeader = _visionCapable
      ? 'VISUAL MODE — SCREENSHOT ACTIVE. You have a screenshot of the current page. PREFER coordinate-based interaction:\n'
      : `SCREENSHOT ACTIVE — a screenshot is attached for visual context, but you cannot determine pixel coordinates from it.\nUse selector-based click (with ref or selector from the element list) for all interactions. Do NOT use click_at.\n`;
    return `${metaLine}${_visionHeader}1. Look at the screenshot to find the element you want to interact with.
2. ${_visionCapable
      ? `Estimate the x,y CSS pixel coordinates of the element center from the screenshot.
3. Use { "type": "click_at", "x": NUMBER, "y": NUMBER } to click it.`
      : `Use the element list below to find the right ref or selector, then use click with that ref.
3. Example: { "type": "click", "ref": "ref_12" } or { "type": "click", "selector": "button.accept" }.`}
4. Use { "type": "type", "ref": "CSS_SELECTOR", "value": "TEXT" } for text input (use selectors for input fields).
RULES:
${_visionCapable
      ? `- PREFER click_at over click when you can see the element in the screenshot. Coordinate clicking works on shadow DOM, canvas, and custom elements where selectors fail.
- Use click (selector-based) only for form inputs, text fields, and elements with stable selectors.
- If click_at misses, fall back to click with a selector from the element list.`
      : `- Use click with ref/selector from the element list for ALL interactions.
- Do NOT use click_at — you cannot determine pixel coordinates without vision capability.
- For overlays/popups: find the dismiss/accept button in the element list and click it by ref.`}
- For scroll: use { "type": "scroll", "direction": "down" } or { "type": "scroll_to", "selector": "CSS_SELECTOR" }.
${dprLine}Coordinates are CSS pixels (same as bbox in element data). The screenshot may be higher resolution if DPR > 1, but always emit CSS-pixel coordinates — do NOT scale by DPR.
`;
})() : ''}

${provider.supportsToolUse ? '' : 'IMPORTANT: Return ONLY a single JSON object like { "type": "read_page" }. No thinking, no explanation, no markdown, no text before or after the JSON.'}`;
}

// ========== Main LLM Call ==========
// trimmedElements: the capped/cleaned element list built in the main loop
// totalElementCount: the raw count before trimming (for the prompt header)
/**
 * Main LLM call: builds the full system prompt, sends the request to the active provider,
 * parses the response, and handles vision fallback on 400 errors. Increments apiCallCount
 * and applies rate limiting before each call. Routes simple steps to the fast model when configured.
 * @param {Array} trimmedElements - Capped list of interactive DOM elements.
 * @param {number} totalElementCount - Raw element count before trimming.
 * @param {string} pageContent - Extracted page text content.
 * @param {string|null} base64Image - Screenshot as base64, or null.
 * @param {string} goal - Current goal text.
 * @param {Array} history - Conversation history messages.
 * @param {number} stepCount - Current step number in the agent run.
 * @param {string} currentUrl - Active tab URL.
 * @param {Object} CONFIG - Agent configuration (timeouts, retries, model, etc.).
 * @param {Object} agentState - Mutable agent state (apiCallCount, plan, memory, etc.).
 * @returns {Promise<Object>} Parsed LLM response object.
 */
// ========== (SO-94) Instant-stop + hard API breaker ==========
// cancelActiveLLM aborts the in-flight fetch so a user stop takes effect in
// milliseconds instead of waiting out the current call's timeout.
// _llmFailStreak counts RAW consecutive LLM-call failures (retries included);
// only a successful call resets it, so no other subsystem can mask a dead
// endpoint. At the limit the run aborts instead of marching to the step cap.
// (O4/A1) Cross-run endpoint cooldown breaker — the module keeps the
// endpoint resting between runs; SO-94 below aborts the run itself.
const LLM_FAIL_STREAK_LIMIT = 5;
let _llmFailStreak = 0;
const _activeLLMCtrls = new Set();
export function cancelActiveLLM(reason = 'user-stop') {
  let _n = 0;
  for (const _c of _activeLLMCtrls) { try { _c.abort(reason); _n++; } catch (_e) { /* already settled */ } }
  _activeLLMCtrls.clear();
  return _n;
}
export function resetLLMFailStreak() { _llmFailStreak = 0; }

async function callLLM(trimmedElements, totalElementCount, pageContent, base64Image, goal, history, stepCount, currentUrl, CONFIG, agentState) {
  if (!agentState) throw new Error('agentState is required');
  if (!CONFIG) throw new Error('CONFIG is required');
  const _apiStart = Date.now();
  _rateLimiter.check();
  // Credit protection: check daily limit before making API call
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      const limitCheck = await chrome.runtime.sendMessage({ action: 'check_credit_limit' }).catch(() => null);
      if (limitCheck && !limitCheck.allowed) {
        console.warn('[Sentinel/LLM] Daily credit limit exceeded');
        return { type: 'finish', summary: 'Daily credit limit reached. Increase limit in Settings or wait until tomorrow.' };
      }
    }
  } catch (_e) { /* non-fatal — allow call if check fails */ }
  agentState.apiCallCount++; // increment before any throws so the count is always recorded
  const providerConfig = await getActiveProvider();
  const { endpoint, apiKey } = providerConfig;
  // (SO-73) Keyless local endpoints: llama-server/vLLM/Ollama on loopback need no key.
  const _isLocalEndpoint = /^(https?:)?\/\/(127\.0\.0\.1|localhost|\[::1\])([:/]|$)/i.test(endpoint || '');
  if (!apiKey && !_isLocalEndpoint) {
    console.error('[Sentinel/LLM] No API key configured! Provider:', providerConfig.providerId || endpoint || 'unknown');
    throw new Error('No API key configured. Open Settings and configure a provider.');
  }
  const provider = resolveProvider(endpoint);
  if (!provider) throw new Error(`Unknown provider for endpoint: ${endpoint}`);
  // (9.2) Route simple steps to fast model if configured
  const _useSimple = isSimpleStep(agentState, stepCount, history) && providerConfig.fastModel;
  // Multi-provider model routing: check stepContext for complexity-based tier selection
  const _stepTier = selectModelForStep(agentState.stepContext || null);
  let model;
  if (_stepTier === 'light' && providerConfig.fastModel) {
    model = providerConfig.fastModel;
  } else if (_stepTier === 'heavy' && providerConfig.heavyModel) {
    model = providerConfig.heavyModel;
  } else if (_useSimple) {
    model = providerConfig.fastModel;
  } else {
    model = providerConfig.model;
  }
  agentState.model = model; // needed by _buildAgentPrompt → supportsVision
  const _resolvedTier = _stepTier || (_useSimple ? 'light' : 'default');
  if (_useSimple) agentState.fastModelCallCount = (agentState.fastModelCallCount || 0) + 1;
  agentState._lastModelTier = _resolvedTier; // track tier for cost recording after response

  const hasHistory = Array.isArray(history) && history.length;
  const lastEntry = hasHistory ? history[history.length - 1] : null;
  const lastAction = lastEntry ? lastEntry.action : null;
  const lastResult = lastEntry ? lastEntry.result : null;

  // Runbook detection
  const isRunbook = RUNBOOK_COMPREHENSIVE_RE.test(goal);

  const runbookCtx = isRunbook ? `
RUNBOOK / INVESTIGATION MODE ACTIVE
You are executing a structured, multi-phase IT investigation. Rules for this mode:
1. NEVER finish early -- complete ALL phases listed in the goal before calling "finish".
2. Use "note" actions liberally to document every finding: IPs, zone names, rule IDs, log entries, FQDN lists, any value observed on screen.
3. Use "extract" to save key values (client IP, rule name, zone, etc.) to memory for later reference via ::key::.
4. Navigate to each UI location specified. Read the page after every navigation before acting.
5. If a page has a form or filter, fill it in before reading results.
6. Follow the phase order exactly. Complete each phase fully before advancing.
7. At the end, call "finish" with a COMPLETE ticket-ready summary: all phases covered, all findings listed, the exact change made (or recommended), and rollback steps.
8. Do NOT skip phases because you think you found the answer early -- document ALL phases as instructed.
` : '';

  // Navigation fatigue detection -- DISABLED in runbook mode.
  const _actionCounts = Array.isArray(history) ? history.reduce((acc, h) => {
    if (!h || !h.action) return acc;
    const type = h.action.type;
    if (type === 'navigate') acc.navigate++;
    if (/^extract(_list)?$/.test(type)) acc.extract++;
    if (type === 'note') acc.note++;
    return acc;
  }, { navigate: 0, extract: 0, note: 0 }) : { navigate: 0, extract: 0, note: 0 };
  const navigateCount = _actionCounts.navigate;
  const extractCount = _actionCounts.extract;
  const noteCount = _actionCounts.note;

  const finishCtx = isRunbook ? '' :
    (navigateCount >= 5 && extractCount === 0 && noteCount === 0)
    ? `\nFINISH NOW -- ${navigateCount} navigates with nothing recorded. Use your memory and finish with a comprehensive answer. Include ACTUAL content.\n`
    : (navigateCount >= 3 && extractCount === 0 && noteCount === 0)
    ? `\nHARD STOP -- You navigated ${navigateCount} times without extracting or noting anything. You MUST use "extract", "note", or "finish" NOW. Do NOT navigate again.\n`
    : '';

  // (3.45.0) Quick Mode — action-oriented prompt injection
  const quickModeCtx = (agentState && agentState.quickMode) ?
    '\nQUICK MODE ACTIVE: Skip "note" actions. Every step must be a real action (click, type, navigate, extract, scroll, finish). Do NOT use "note" — think less, act more.\n' : '';

  // Platform-specific UI guidance
  const platformCtx = getPlatformContext(currentUrl, goal);

  // Self-healing: strategy shift prompt — platform-aware (3.9.0)
  const strategyCtx = _buildStrategyCtx(agentState, currentUrl, CONFIG);

  // Self-learning: inject relevant patterns
  const patterns = await getRelevantPatterns(goal);
  const patternCtx = Array.isArray(patterns) && patterns.length
    ? `\nPAST SUCCESSFUL PATTERNS (similar tasks):\n${patterns.map((p, i) => p && p.goal ? `${i+1}. "${p.goal}" -> ${Array.isArray(p.steps) ? p.steps.map(s => s.type).join(' -> ') : '(no steps)'}` : '').join('\n')}\n`
    : '';

  // Memory context
  const memoryKeys = Object.keys(agentState?.agentMemory || {});
  const memoryCtx = memoryKeys.length
    ? `\nAGENT MEMORY (data extracted from pages, use ::key:: to reference):\n${JSON.stringify(agentState?.agentMemory || {})}\n`
    : '';

  // (3.12.0) Client knowledge context. agent-engine.js pre-formats this
  // string at run start and passes it through agentState.clientKnowledgeText.
  // When set, it lists facts learned from prior runs for the active client
  // — site quirks, timing rules, custom paths, recurring errors. Inject
  // verbatim so the LLM sees them every step.
  const clientKnowledgeCtx = (agentState.clientKnowledgeText && typeof agentState.clientKnowledgeText === 'string')
    ? agentState.clientKnowledgeText
    : '';

  // (3.12.0) Vision-based action verification. When the immediately prior
  // step was a modifying action (click, type, select, check, press_key,
  // upload_file), force the model to look at the post-action screenshot
  // and explicitly confirm the action took effect BEFORE proposing the next
  // command. No extra API call -- this just sharpens the existing
  // observation cycle so silent failures (click registered but modal didn't
  // close, form filled but hidden validation rejected) get caught.
  const _pv = (agentState && agentState.pendingVerification) || null;
  const verificationCtx = (_pv && _pv.type && typeof _pv === 'object')
    ? `\n## VERIFY YOUR LAST ACTION FIRST\nYour previous step was: **${_pv.type}** -> "${(_pv.description || '').replace(/"/g, '\\"').substring(0, 100)}".\n\nBefore proposing the next command, examine the current screenshot and confirm the action took effect. Look for evidence:\n- Click on a button -> Did the modal close? Did the page navigate? Did a success message appear?\n- Type in a field -> Does the field now contain the typed text?\n- Select a dropdown -> Did the selected value update?\n- Check / check_all -> Are the checkboxes now in the expected state?\n- press_key (Enter/Tab/etc.) -> Did the form submit / focus advance / dropdown open?\n\nIf the page state confirms the action took effect: proceed with the next planned step.\n\nIf the page does NOT reflect the action (button still highlighted, modal still open, field still empty, no navigation): treat the step as failed. Do NOT proceed as if it succeeded. Choose ONE recovery:\n1. Retry the same action with a different selector (often the click missed or hit a wrapper element).\n2. wait 1500ms, then re-observe -- some SPAs commit asynchronously.\n3. scroll_to the element first, then retry.\n4. Use execute_js to trigger the action programmatically (.click(), dispatchEvent('click'), HTMLElement.value setter + 'input' event).\n\nThis verification is mandatory -- never skip past a destructive action without confirming it landed.\n`
    : '';

  // Inject plan context if a plan was generated
  const planCtx = _buildPlanCtx(agentState.agentPlan, agentState.currentPlanStep);

  // Multi-tab context: show all managed tabs with summaries
  const tabCtxSection = _buildTabCtx();

  // Loop directive from stall detection
  const loopCtx = agentState.loopDirective || '';

  // (v20.2) Runtime vision verdict — computed BEFORE the prompt so the
  // visual/selector mode header reflects what this call actually carries.
  // prepareVision consults learned per-model verdicts, the registry, and
  // attaches the (possibly degraded) image. This is the single source of
  // truth; name-pattern supportsVision() no longer gates the prompt mode.
  const _storage = (typeof chrome !== 'undefined' && chrome.storage) ? chrome.storage.local : null;
  const visionPrep = await prepareVision(provider, model, base64Image, { storage: _storage });

  // History sanitization: strip screenshot payloads from older entries
  const historyWindowSize = isRunbook ? 25 : CONFIG.historyWindow;
  const sanitizedHistory = _sanitizeHistory(history, isRunbook, CONFIG);

  const prompt = _buildAgentPrompt({
    quickModeCtx, runbookCtx, platformCtx,
    goal, currentUrl, stepCount, pageContent,
    trimmedElements, totalElementCount,
    historyWindowSize, isRunbook, sanitizedHistory,
    lastAction, lastResult,
    planCtx, strategyCtx, finishCtx, verificationCtx,
    patternCtx, memoryCtx, clientKnowledgeCtx, tabCtxSection, loopCtx,
    agentState, base64Image, provider, visionPrep
  });

  const controller = new AbortController();
  _activeLLMCtrls.add(controller); // (SO-94) registered for instant user-stop
  // SO-92: vision requests carry a large payload and slow-thinking models routinely take >30s to first byte.
  const _effTimeout = base64Image ? Math.max(CONFIG.fetchTimeout, VISION_FETCH_TIMEOUT_MS) : CONFIG.fetchTimeout;
  const fetchTimeout = setTimeout(() => controller.abort(), _effTimeout);

  // Build request body using provider registry
  // (3.51) Send vision content when we have an image and the provider supports it.
  // If the endpoint rejects the vision request with 400, we fall back to text-only
  // (see the 400-retry block below) so non-vision model variants don't silently fail.
  // v20.1: vision prep through the adapter — learned per-model verdicts,
  // registry short-circuit, and the degradation-ladder hooks. Known
  // text-only models skip the wasted image call entirely.
  const _useVision = visionPrep.useVision;
  const _visionTextOnly = !_useVision && !!base64Image;
  if (_visionTextOnly) console.log('[Sentinel/Vision] Skipping image for', model, '—', visionPrep.note);
  let _visionDegradeNote = visionPrep.note || '';
  const userContent = (_useVision)
    ? provider.buildVisionContent(prompt, base64Image)
    : prompt;

  const useThinking = provider.supportsToolUse && provider.id === 'anthropic'
    && typeof provider.buildBodyWithThinking === 'function'
    && CONFIG.strategyShiftThreshold > 0
    && agentState.consecutiveFailures >= CONFIG.strategyShiftThreshold;
  const _sysPrompt = await _effectiveSystemPrompt(provider);
  let requestBody;
  if (useThinking) {
    requestBody = JSON.stringify(provider.buildBodyWithThinking(model, _sysPrompt, userContent, SENTINEL_TOOLS, 8000, { maxTokens: 8000 }));
  } else if (provider.supportsToolUse) {
    requestBody = JSON.stringify(provider.buildBodyWithTools(model, _sysPrompt, userContent, SENTINEL_TOOLS, { maxTokens: 8000, temperature: 0.1 }));
  } else {
    requestBody = JSON.stringify(provider.buildBody(model, _sysPrompt, userContent, { maxTokens: 8000, temperature: 0.1 }));
  }
  const requestHeaders = provider.buildHeaders(apiKey, { thinking: useThinking });

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: requestHeaders,
      body: requestBody,
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(fetchTimeout);
    _activeLLMCtrls.delete(controller);
    _apiHealth.record(_apiStart, false);
    // (SO-94) A user stop aborts with a reason string; never relabel it as a timeout.
    if (controller.signal && controller.signal.reason === 'user-stop') {
      throw new Error('STOPPED_BY_USER');
    }
    console.error('[Sentinel/LLM] API call failed:', getErrorMessage(err));
    throw (typeof err === 'object' && err !== null && typeof err.name === 'string' && err.name === 'AbortError') ? new Error(`API timed out after ${_effTimeout/ONE_SECOND_MS}s`) : err;
  }
  clearTimeout(fetchTimeout);
  _activeLLMCtrls.delete(controller);
  console.log('[Sentinel/LLM] Response received. status=' + (response ? response.status : 'null'));
  let _apiHealthRecorded = false;
  try {
  if (!response.ok) {
    let errorData;
    try { errorData = await response.text(); } catch (_readErr) { errorData = 'unable to read error body'; }
    if (response.status === 429) throw new Error(`429 Rate limited. ${errorData}`);
    if (response.status === 400 && errorData && typeof errorData === 'string' && errorData.includes('Unknown Model')) throw new Error(`Unknown model "${model}".`);
    // (3.51.1) Vision fallback: if we sent image content and got a 400, retry
    // text-only. Some OpenAI-compatible endpoints (e.g. Z.AI for text-primary
    // GLM variants) reject image_url even though the protocol accepts it.
    if (response.status === 400 && _useVision) {
      console.warn('[Sentinel] Vision request rejected (400) — climbing degradation ladder. Error:', (errorData || 'unknown error').slice(0, 200));
      // v20.1: try cheaper image modes (grayscale -> tile -> crop) before
      // abandoning vision; learn per-model verdicts along the way.
      let _visionRecovered = false;
      let _ladder = await onVisionRejection({ provider, model, status: 400, bodyText: errorData, base64Image, elements: null, storage: _storage, mode: visionPrep.mode || 'full' });
      while (_ladder && !_ladder.passthrough && !_ladder.giveUp && _ladder.image) {
        _rateLimiter.check();
        agentState.apiCallCount++;
        _visionDegradeNote = _ladder.note || '';
        const _dgContent = prompt + (_ladder.note ? `\n\n[Vision degraded: ${_ladder.note}]` : '');
        const _dgVision = provider.buildVisionContent(_dgContent, _ladder.image);
        const _dgBody = (useThinking)
          ? JSON.stringify(provider.buildBodyWithThinking(model, _sysPrompt, _dgVision, SENTINEL_TOOLS, 8000, { maxTokens: 8000 }))
          : (provider.supportsToolUse
            ? JSON.stringify(provider.buildBodyWithTools(model, _sysPrompt, _dgVision, SENTINEL_TOOLS, { maxTokens: 8000, temperature: 0.1 }))
            : JSON.stringify(provider.buildBody(model, _sysPrompt, _dgVision, { maxTokens: 8000, temperature: 0.1 })));
        const _dgCtrl = new AbortController(); _activeLLMCtrls.add(_dgCtrl); // (SO-94)
        const _dgTimeout = setTimeout(() => _dgCtrl.abort(), _effTimeout);
        let _dgResp;
        try {
          _dgResp = await fetch(endpoint, { method: 'POST', headers: requestHeaders, body: _dgBody, signal: _dgCtrl.signal });
        } catch (err) {
          clearTimeout(_dgTimeout);
          throw (typeof err === 'object' && err !== null && err.name === 'AbortError') ? new Error(`API timed out after ${_effTimeout/ONE_SECOND_MS}s`) : err;
        }
        clearTimeout(_dgTimeout);
        if (_dgResp.ok) {
          response = _dgResp;
          _visionRecovered = true;
          onVisionSuccess(provider, model, _storage).catch(() => {});
          break;
        }
        let _dgErr;
        try { _dgErr = await _dgResp.text(); } catch (_readErr2) { _dgErr = 'unable to read error body'; }
        if (_dgResp.status === 429) throw new Error(`429 Rate limited. ${_dgErr}`);
        _ladder = await onVisionRejection({ provider, model, status: _dgResp.status, bodyText: _dgErr, base64Image, elements: null, storage: _storage, mode: _ladder.mode || 'full' });
      }
      if (!_visionRecovered) {
      _rateLimiter.check(); // rate-limit the fallback call just like the original
      agentState.apiCallCount++; // second attempt counts as its own call
      const _fbContent = prompt; // text-only
      let _fbBody;
      if (useThinking) {
        _fbBody = JSON.stringify(provider.buildBodyWithThinking(model, provider.systemPromptTweak, _fbContent, SENTINEL_TOOLS, 8000, { maxTokens: 8000 }));
      } else if (provider.supportsToolUse) {
        _fbBody = JSON.stringify(provider.buildBodyWithTools(model, provider.systemPromptTweak, _fbContent, SENTINEL_TOOLS, { maxTokens: 8000, temperature: 0.1 }));
      } else {
        _fbBody = JSON.stringify(provider.buildBody(model, provider.systemPromptTweak, _fbContent, { maxTokens: 8000, temperature: 0.1 }));
      }
      const _fbCtrl = new AbortController(); _activeLLMCtrls.add(_fbCtrl); // (SO-94)
      const _fbTimeout = setTimeout(() => _fbCtrl.abort(), _effTimeout);
      let _fbResp;
      try {
        _fbResp = await fetch(endpoint, { method: 'POST', headers: requestHeaders, body: _fbBody, signal: _fbCtrl.signal });
      } catch (err) {
        clearTimeout(_fbTimeout);
        console.error('[Sentinel/LLM] Vision fallback API call failed:', getErrorMessage(err));
        throw (typeof err === 'object' && err !== null && typeof err.name === 'string' && err.name === 'AbortError') ? new Error(`API timed out after ${_effTimeout/ONE_SECOND_MS}s`) : err;
      }
      clearTimeout(_fbTimeout);
      if (!_fbResp.ok) {
        let _fbErr;
        try { _fbErr = await _fbResp.text(); } catch (_readErr) { _fbErr = 'unable to read error body'; }
        if (_fbResp.status === 429) throw new Error(`429 Rate limited. ${_fbErr}`);
        throw new Error(`API Error: ${_fbResp.status} - ${_fbErr}`);
      }
      // Replace `response` with the successful fallback response for the parse logic below
      response = _fbResp;
      }
    } else {
      throw new Error(`API Error: ${response.status} - ${errorData}`);
    }
  }

  let data;
  try {
    data = await response.json();
  } catch (e) {
    throw new Error(`API returned invalid JSON: ${getErrorMessage(e)}`);
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('API returned invalid response body (expected object)');
  }
  // Early detection of auth errors from providers that return HTTP 200 with error payloads
  if ((!data.choices || !data.choices.length) && (data.error || data.msg || (data.code && data.success === false))) {
    const errMsg = data.error?.message || data.msg || data.message || JSON.stringify(data);
    throw new Error(`🔑 API Authentication Failed: ${errMsg}. Check your API key in extension settings.`);
  }

  // Extract real token usage (provider-normalised).
  // Anthropic: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }
  // OpenAI:    { prompt_tokens, completion_tokens, total_tokens }
  const _u = data.usage || {};
  const _in  = _u.input_tokens  || _u.prompt_tokens    || 0;
  const _out = _u.output_tokens || _u.completion_tokens || 0;
  if (_in > 0 || _out > 0) {
    agentState.totalInputTokens  = (agentState.totalInputTokens  || 0) + _in;
    agentState.totalOutputTokens = (agentState.totalOutputTokens || 0) + _out;
    // (9.2) Update running cost estimate
    agentState.estimatedCostUsd = estimateCostUsd(agentState.totalInputTokens, agentState.totalOutputTokens, model);
    // Multi-provider cost tracking by tier
    recordModelUsage(agentState._lastModelTier || 'default', _in, _out);
    // Credit protection: record usage for daily limit tracking
    try {
      const _msg = { action: 'record_credit_usage', inputTokens: _in, outputTokens: _out, model };
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage(_msg).catch(() => {});
      }
    } catch (_e) { /* non-fatal */ }
  }
  if (_u.cache_read_input_tokens)    agentState.totalCacheReadTokens  = (agentState.totalCacheReadTokens  || 0) + _u.cache_read_input_tokens;
  if (_u.cache_creation_input_tokens) agentState.totalCacheWriteTokens = (agentState.totalCacheWriteTokens || 0) + _u.cache_creation_input_tokens;
  // API Health: record successful response
  _apiHealthRecorded = true; _apiHealth.record(_apiStart, true);


  // Extract reasoning_content from models that return it (GLM, DeepSeek, etc.)
  // This is the model's chain-of-thought, separate from the action text.
  // parseLLMResponse captures text-before-JSON reasoning; this captures the
  // API-level reasoning field. We merge both so the popup reasoning cards
  // show the most complete picture.
  const _apiReasoning = (typeof data.choices?.[0]?.message?.reasoning_content === 'string')
    ? data.choices[0].message.reasoning_content.trim().substring(0, 600)
    : '';
  function _attachReasoning(cmd) {
    if (!_apiReasoning || !cmd || typeof cmd !== 'object') return cmd;
    if (cmd.__reasoning) {
      cmd.__reasoning = (_apiReasoning + '\n' + cmd.__reasoning).substring(0, 600);
    } else {
      cmd.__reasoning = _apiReasoning;
    }
    return cmd;
  }
  // Parse response — tool use path for providers that support it
  if (provider.supportsToolUse) {
    // Anthropic: check stop_reason === 'tool_use'
    if (data.stop_reason === 'tool_use') {
      try {
        return provider.parseToolUseResponse(data);
      } catch (e) {
        // Malformed Anthropic tool_use response — fall through to text parsing
        console.warn('[Sentinel] Anthropic parseToolUseResponse failed, falling back to text parsing:', getErrorMessage(e));
      }
    }
    // OpenAI-compatible: check for tool_calls in the response message
    const choice = Array.isArray(data.choices) && data.choices.length ? data.choices[0] : null;
    const hasToolCalls = choice && choice.message && Array.isArray(choice.message.tool_calls) && choice.message.tool_calls.length;
    if (hasToolCalls) {
      try {
        return provider.parseToolUseResponse(data);
      } catch (e) {
        // parseToolUseResponse failed — fall through to text parsing
        console.warn('[Sentinel] tool_use parse failed, falling back to text parsing:', getErrorMessage(e));
      }
    }
    // Fallback: model returned text instead of tool_calls (e.g. finish_reason !== 'tool_calls')
    // Try text-JSON parsing as a safety net
    try {
      const responseText = provider.parseResponse(data);
      if (responseText) return _attachReasoning(parseLLMResponse(responseText));
    } catch (e) {
      console.warn('[Sentinel/llm] parseResponse fallback failed:', getErrorMessage(e));
    }
    // If we get here, the model returned tool_calls but parsing failed AND text fallback failed
    // One last attempt: try the raw tool_calls directly
    if (hasToolCalls && choice.message && Array.isArray(choice.message.tool_calls) && choice.message.tool_calls.length) {
      const tc = choice.message.tool_calls[0];
      if (tc && tc.function && tc.function.name) {
        try {
          const input = JSON.parse(tc.function.arguments || '{}');
          return _attachReasoning({ type: tc.function.name, ...input });
        } catch (e) { console.warn('[Sentinel/llm] tool_calls JSON parse failed:', getErrorMessage(e)); }
      }
    }
    // v3.61: z.ai sometimes returns finish_reason="tool_calls" with malformed/empty tool_calls
    // but the content or reasoning_content contains the tool intent. Detect and construct action.
    if (choice && choice.finish_reason === 'tool_calls') {
      const _msg = choice.message || {}; // Cache to avoid repeated property access
      const _intentText = `${(typeof _msg.content === 'string' ? _msg.content : '') || ''} ${(typeof _msg.reasoning_content === 'string' ? _msg.reasoning_content : '') || ''}`;
      // Detect smart_navigate intent from content
      if (/smart[._-]?navigate/i.test(_intentText)) {
        const _goal = goal || ''; // Cache to avoid repeated fallback
        let _site = 'google', _query = '';
        if (/weather\.gov/i.test(_goal)) _site = 'weather.gov';
        else if (/wikipedia/i.test(_goal)) _site = 'wikipedia';
        else if (/youtube/i.test(_goal)) _site = 'youtube';
        else if (/amazon/i.test(_goal)) _site = 'amazon';
        else if (/reddit/i.test(_goal)) _site = 'reddit';
        else if (/twitter\.com|x\.com/i.test(_goal)) _site = 'twitter';
        // Extract query from goal text
        const _qm = _goal.match(FORECAST_QUERY_RE);
        if (_qm && _qm[1]) _query = _qm[1].trim();
        else {
          const _fm = _goal.match(FOR_ABOUT_QUERY_RE);
          if (_fm && _fm[1]) _query = _fm[1].trim();
        }
        if (_query) {
          console.warn('[Sentinel/FALLBACK] Detected smart_navigate intent from content — site:', _site, 'query:', _query);
          return { type: 'smart_navigate', site: _site, query: _query };
        }
      }
      // Detect explicit navigate URL in content
      const _navUrl = _intentText.match(NAVIGATE_URL_RE);
      if (_navUrl && _navUrl[1]) {
        console.warn('[Sentinel/FALLBACK] Detected navigate intent from content — url:', _navUrl[1]);
        return { type: 'navigate', url: _navUrl[1] };
      }
      // v3.63: Detect navigate_back / go back intent
      if (/\b(?:go|navigate)\s*back\b|\bback\s+to\b|\breturn\s+to\b|\bprevious\s+page\b/i.test(_intentText)) {
        console.warn('[Sentinel/FALLBACK] Detected navigate_back intent from content');
        return { type: 'navigate_back' };
      }
      // v3.63: Detect navigate to named site from content ("go to Amazon", "navigate to Reddit")
      const _siteUrl = _intentText.match(NAVIGATE_SITE_RE);
      if (_siteUrl && _siteUrl[1]) {
        const _mapped = SITE_DOMAIN_MAP[_siteUrl[1].toLowerCase().replace(WHITESPACE_REPLACE_RE, '')];
        if (_mapped) {
          console.warn('[Sentinel/FALLBACK] Detected navigate to site from content:', _mapped);
          return { type: 'navigate', url: `https://${_mapped}` };
        }
      }
      // v3.63: Detect finish intent from content
      if (/\b(?:finish|done|complete|here\s+(?:is|are)|summary|report)\b/i.test(_intentText) && /\b(?:task|report|findings|articles|results)\b/i.test(_intentText)) {
        console.warn('[Sentinel/FALLBACK] Detected finish intent from content');
        return { type: 'finish', summary: _intentText.substring(0, 500) };
      }
    }
    return { type: 'note', text: 'LLM returned an unparseable response. Will retry.' };
  }
  // Fallback: text-JSON parsing (non-tool-use providers)
  let responseText;
  try {
    responseText = provider.parseResponse(data);
  } catch (e) {
    console.warn('[Sentinel/llm] parseResponse failed (non-tool-use path):', getErrorMessage(e));
    return { type: 'note', text: 'LLM returned an unparseable response. Will retry.' };
  }
  if (!responseText) return { type: 'note', text: 'Empty LLM response — will retry on next step.' };
  return _attachReasoning(parseLLMResponse(responseText));
  } catch(_apiErr) { if (!_apiHealthRecorded) _apiHealth.record(_apiStart, false); throw _apiErr; }
}

// ========== Response Parsing ==========
/**
 * Extract the first valid JSON object with a recognized "type" field from a string.
 * Handles models that prepend reasoning/thinking text before the actual JSON payload.
 * @param {string} str - Raw LLM response text.
 * @returns {Object|null} Parsed action object, or null if no valid JSON found.
 */
export function extractFirstJsonObject(str) {
  // Try every '{' position to find a valid JSON object with a "type" field.
  // This handles models that prepend reasoning text before the actual JSON.

  let searchFrom = 0;
  const strLen = str.length;
  while (searchFrom < strLen) {
    const start = str.indexOf('{', searchFrom);
    if (start === -1) return null;

    let depth = 0, inString = false, escape = false;
    let end = -1;
    for (let i = start; i < strLen; i++) {
      const ch = str[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
    }

    if (end !== -1) {
      const candidate = str.substring(start, end + 1);
      try {
        const parsed = JSON.parse(candidate);
        // A candidate is only an "action" if it is both a known type and
        // schema-valid (no unknown/reserved fields, no wrong value types). An
        // invalid object is skipped rather than returned, so the caller falls
        // through to parseLLMResponse's rejecting path instead of executing a
        // half-understood action.
        if (parsed.type && VALID_ACTION_TYPES.has(parsed.type) && validateAction(parsed).valid) return candidate;
      } catch (e) { console.warn('[Sentinel/llm] JSON parse failed:', getErrorMessage(e)); }
      searchFrom = end + 1;
    } else {
      break;
    }
  }
  return null;
}

// (3.8.4) Sanitize LLM-emitted JSON: handle invalid escape sequences and
// literal control characters inside string values WITHOUT corrupting the
// structural JSON. Operates only inside string contexts (between unescaped
// double-quotes) so JSON syntax outside strings is left untouched.
/**
 * Sanitize LLM-emitted JSON by fixing invalid escape sequences and replacing
 * literal control characters inside string values with valid JSON escapes.
 * @param {string} jsonStr - Raw JSON string from the LLM.
 * @returns {string} Sanitized JSON string safe for JSON.parse.
 */
function sanitizeLlmJson(jsonStr) {
  if (typeof jsonStr !== 'string') return jsonStr;
  let out = '';
  let inStr = false;
  const len = jsonStr.length;
  for (let i = 0; i < len; i++) {
    const ch = jsonStr[i];
    if (!inStr) {
      if (ch === '"') { inStr = true; out += ch; continue; }
      out += ch;
      continue;
    }
    // We are inside a string.
    if (ch === '"') { inStr = false; out += ch; continue; }
    if (ch === '\\') {
      const next = jsonStr[i + 1];
      if (next === undefined) { out += ch; continue; }
      if (VALID_JSON_ESCAPE_CHARS.has(next)) {
        // Valid JSON escape — emit both chars and skip ahead.
        out += ch + next;
        i++;
        continue;
      }
      // Invalid escape (e.g., \\` from a markdown code fence). Drop the
      // backslash, keep the next char as a literal so the JSON parses.
      out += next;
      i++;
      continue;
    }
    // Inside a string, raw control chars are illegal. Replace newlines, CRs,
    // and tabs with their valid escapes; drop any other control chars.
    const code = ch.charCodeAt(0);
    if (code === 0x0A) { out += '\\n'; continue; }
    if (code === 0x0D) { out += '\\r'; continue; }
    if (code === 0x09) { out += '\\t'; continue; }
    if (code < 0x20) { continue; /* drop other ctrl chars */ }
    out += ch;
  }
  return out;
}

// (3.8.4) Last-ditch regex extraction for finish/note actions when JSON.parse
// fails completely. Pulls the summary or text content via a permissive regex
// that tolerates whatever malformed escapes the LLM emitted.
/**
 * Last-ditch regex extraction for finish/note actions when JSON.parse fails.
 * Detects "summary" or "text" keys and extracts their values, tolerating malformed escapes.
 * @param {string} content - Raw LLM response text.
 * @returns {Object|null} Parsed action object {type: 'finish'|'note', summary|text}, or null if no match.
 */
function regexSalvageFinishOrNote(content) {
  if (typeof content !== 'string') return null;
  // Detect finish vs note by which marker appears first.
  const finishIdx = content.indexOf('"summary"');
  const noteIdx = content.indexOf('"text"');
  if (finishIdx === -1 && noteIdx === -1) return null;
  const useFinish = finishIdx !== -1 && (noteIdx === -1 || finishIdx < noteIdx);
  // Use precompiled regex to avoid recreating on every call
  const re = useFinish ? FINISH_SALVAGE_REGEX : NOTE_SALVAGE_REGEX;
  const m = content.match(re);
  if (!m) return null;
  let raw = m[1];
  // Soften common malformations the LLM emits: \\` -> \`, then unescape \n/\r/\t
  raw = raw.replace(/\\([^"\\/bfnrtu])/g, '$1')
           .replace(/\\n/g, '\n')
           .replace(/\\r/g, '\r')
           .replace(/\\t/g, '\t')
           .replace(/\\"/g, '"');
  if (useFinish) return { type: 'finish', summary: raw };
  if (!raw) return null;
  return { type: 'note', text: raw };
}

/**
 * Parse an LLM response string into an action object.
 * Strips markdown code fences, then tries direct JSON parse, then
 * falls back to extractFirstJsonObject for responses with preamble text.
 * @param {string} content - Raw LLM response text.
 * @returns {Object} Parsed action object with a "type" field.
 * @throws {Error} If the response cannot be parsed as valid action JSON.
 */
export function parseLLMResponse(content) {
  try {
    if (!content || typeof content !== 'string') {
      throw new Error('Empty or null response from API');
    }
    let jsonStr = content.trim();
    // Strip <think>...</think> blocks (GLM/DeepSeek) so JSON inside them
    // isn't mistaken for the real action. Same fix as in generatePlan.
    jsonStr = jsonStr.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    if (jsonStr.includes('```')) {
      const match = jsonStr.match(CODE_BLOCK_REGEX);
      if (match && match[1]) jsonStr = match[1].trim();
    }
    const firstObj = extractFirstJsonObject(jsonStr);
    // (6.0) Capture pre-JSON reasoning text for reasoning cards in the popup.
    let __reasoning = '';
    if (firstObj) {
      const jsonIdx = jsonStr.indexOf(firstObj.substring(0, 30));
      if (jsonIdx > 10) __reasoning = jsonStr.substring(0, jsonIdx).trim().slice(0, 600);
      jsonStr = firstObj;
    }
    // (3.8.4) Sanitize invalid escape sequences and raw control chars inside
    // string values BEFORE parsing. Replaces the old "strip 0x00-0x1f" pass
    // which destroyed newlines and broke the salvage path.
    jsonStr = sanitizeLlmJson(jsonStr);
    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      throw new Error(`Failed to parse action JSON: ${getErrorMessage(e)}`);
    }
    if (!parsed.type && parsed.action && typeof parsed.action === 'object') parsed = parsed.action;
    if (!parsed.type && parsed.command && typeof parsed.command === 'object') parsed = parsed.command;
    if (!parsed.type && parsed.next_action && typeof parsed.next_action === 'object') parsed = parsed.next_action;
    if (!parsed.type) throw new Error('Missing type field');
    if (!VALID_ACTION_TYPES.has(parsed.type)) throw new Error(`Invalid command type: ${parsed.type}`);
    // Reject unknown fields, reserved engine-trust fields, and wrong value
    // types with a message the model can act on. Thrown (not silently dropped)
    // so the caller surfaces it as a retryable parse error.
    //
    // This is the parse-path half of the trust boundary. The dispatch boundary
    // in agent-engine.js strips only the four names it knows about
    // (approvalGranted, autoApproved, approved, _engineInternal); without this
    // check a model could set `_visionIndex` or any other `_`-prefixed field
    // and have the engine read it as vision provenance the model never earned.
    const _schemaResult = validateAction(parsed);
    if (!_schemaResult.valid) throw new Error(`Invalid ${parsed.type} action: ${_schemaResult.error}`);
    if (__reasoning) parsed.__reasoning = __reasoning;
    return parsed;
  } catch (err) {
    console.error('Failed to parse LLM response:', getErrorMessage(err), 'Content:', content);
    // (3.8.4) Two-tier salvage:
    //  1. Try sanitize-then-parse on the raw content (in case extractFirstJsonObject
    //     truncated something we needed).
    //  2. If that fails, regex-extract finish/note content directly.
    if (typeof content === 'string' && content) {
      try {
        const sanitized = sanitizeLlmJson(content.trim());
        const parsed = JSON.parse(sanitized);
        // Same schema gate as the primary path — the salvage route must not
        // become a way to slip an unknown field or reserved marker through.
        if (parsed && parsed.type && VALID_ACTION_TYPES.has(parsed.type) && validateAction(parsed).valid) return parsed;
      } catch (e) { console.warn('[Sentinel/llm] Regex salvage failed:', getErrorMessage(e)); }
      try {
        const salvaged = regexSalvageFinishOrNote(content);
        if (salvaged) {
          console.warn(`[Sentinel] Recovered ${salvaged.type} action via regex salvage`);
          return salvaged;
        }
      } catch (e) { console.warn('[Sentinel/llm] Parse failed:', getErrorMessage(e)); }
    }
    return { type: 'note', text: `Parse error (will retry): ${getErrorMessage(err)}` };
  }
}

// ========== Self-Learning ==========
/**
 * Retrieve learned action patterns relevant to the current goal from storage.
 * Patterns are scored by keyword overlap with the goal text and sorted by
 * recency and success count.
 * @param {string} goal - The user's current goal text.
 * @returns {Promise<Array>} Sorted array of relevant learned patterns.
 */
export async function getRelevantPatterns(goal) {
  try {
    if (!goal || typeof goal !== 'string') return [];
    const stored = await chrome.storage.local.get(['learned_patterns']).catch(() => ({ learned_patterns: [] }));
    const patterns = stored.learned_patterns || [];
    // Cache goal processing to avoid repeated toLowerCase and split calls
    const goalLower = goal.toLowerCase();
    const goalWords = goalLower.split(/\s+/).filter(w => w.length > 3);
    const scored = patterns
      .filter(p => p.success)
      .map(p => {
        // Cache goal processing to avoid repeated toLowerCase calls
        const pGoalLower = p.goal && typeof p.goal === 'string' ? p.goal.toLowerCase() : '';
        return {
          pattern: p,
          score: goalWords.reduce((acc, w) => acc + (pGoalLower.includes(w) ? 1 : 0), 0)
        };
      })
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    return scored.map(s => s.pattern);
  } catch (e) { console.error('[Sentinel/llm] getRelevantPatterns failed:', getErrorMessage(e)); return []; }
}

// ========== Simple LLM Call (Quick Assist) ==========
/**
 * Make a single-turn LLM call for Quick Assist and similar lightweight uses.
 * Uses the active provider from settings. Returns the text response or throws.
 *
 * @param {string} systemPrompt - The system/instruction context.
 * @param {string} userPrompt - The user's query or content to process.
 * @param {number} [maxTokens=1200] - Maximum tokens for the response.
 * @returns {Promise<string>} The LLM's text response.
 */
export async function callLLMSimple(systemPrompt, userPrompt, maxTokens = 1200) {
  if (!systemPrompt || !userPrompt) throw new Error('systemPrompt and userPrompt are required');
  const providerConfig = await getActiveProvider();
  if (!providerConfig) throw new Error('No active provider configured. Set one in extension settings.');
  const { endpoint, apiKey, model } = providerConfig;
  const _isLocalEndpoint = /^(https?:)?\/\/(127\.0\.0\.1|localhost|\[::1\])([:/]|$)/i.test(endpoint || '');
  if (!apiKey && !_isLocalEndpoint) throw new Error('API key not configured. Set it in extension settings.');
  const provider = resolveProvider(endpoint);
  if (!provider) throw new Error(`Unknown provider for endpoint: ${endpoint}`);

  const controller = new AbortController(); _activeLLMCtrls.add(controller); // (SO-94) instant user-stop
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const body = JSON.stringify(provider.buildBody(model, systemPrompt, userPrompt, { maxTokens, temperature: 0.4 }));
    const headers = provider.buildHeaders(apiKey);
    const response = await fetch(endpoint, { method: 'POST', headers, body, signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) {
      let errText;
      try { errText = await response.text(); } catch (_) { errText = ''; }
      throw new Error(`API Error ${response?.status || 'unknown'}: ${errText.substring(0, 200)}`);
    }
    const data = await response.json();
    if (!data) throw new Error('Quick Assist API returned null response body');
    const text = provider.parseResponse(data);
    if (!text) throw new Error('Empty response from API');
    return text;
  } catch (err) {
    clearTimeout(timeout);
    throw (typeof err === 'object' && err !== null && typeof err.name === 'string' && err.name === 'AbortError') ? new Error('Quick Assist request timed out after 30s') : err;
  }
}

