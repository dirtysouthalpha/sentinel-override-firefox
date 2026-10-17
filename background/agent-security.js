// Sentinel Override v3 — Agent Security Module
// Tenant matching, MFA detection, sign-in wall detection, hallucination evaluation.
// Extracted from agent-engine.js for modularity.

import { TEXT_SAMPLE_LENGTH } from './constants.js';

// ──────────────────────────────────────────────────────────────
// Helper: count own enumerable keys on a plain object (no Array/Object.keys)
// ──────────────────────────────────────────────────────────────
const getObjectLength = (obj) => {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return 0;
  let count = 0;
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) count++;
  }
  return count;
};

// ──────────────────────────────────────────────────────────────
// Tenant Matching
// ──────────────────────────────────────────────────────────────

function _tenantsMatch(detected, expected) {
  if (!expected || (typeof expected === 'string' && !expected.trim())) return true;  // no expected = no lock
  if (!detected) return false;  // we have an expectation but nothing detected yet → block
  const exp = typeof expected === 'string' ? expected.trim().toLowerCase() : '';
  const signals = [detected.chipText || '', detected.onmicrosoft || '', detected.tid || ''].map(s => String(s).toLowerCase());
  return signals.some(s => s && (s.includes(exp) || exp.includes(s)));
}

// ──────────────────────────────────────────────────────────────
// Hallucination Hard-Stop (3.9.1)
// ──────────────────────────────────────────────────────────────
// Counts distinct "claim items" in a finish summary vs the actual evidence
// sources the agent collected (memory keys + note actions). When the claim
// density wildly outstrips evidence AND there are no "headline only / not
// read in this run" caveats, blocks the finish and forces the LLM to either
// trim the summary or tag unverified items explicitly.

const _UNVERIFIED_CAVEATS = /\b(headline only|not read in this run|not actually read|not yet read|could not (?:read|extract|verify)|unverified|extraction failed|skipped reading|did not read|not visited|not opened|listed by headline|based on headline)\b/i;

// Precompiled regex patterns for summary analysis
const SUMMARY_NUMBERED_RE = /^\s*(?:#+\s*)?\d+[.)]\s/gm;
const SUMMARY_TABLE_RE = /^\|[^\n]+\|\s*$/gm;
const SUMMARY_BULLETS_RE = /^\s*[-*]\s/gm;
const SUMMARY_SRC_RE = /\[src:[a-z0-9_-]+\]/gi;
const SUMMARY_UNVERIFIED_RE = /\[unverified\]/gi;

function _countSummaryClaims(summary) {
  if (!summary || typeof summary !== 'string') return 0;
  // Numbered list entries: "1. ", "2. ", etc., or "1) ", "## 1." style.
  const numbered = (summary.match(SUMMARY_NUMBERED_RE) || []).length;
  // Markdown table rows (excluding header + separator)
  const tableRows = Math.max(0, (summary.match(SUMMARY_TABLE_RE) || []).length - 2);
  // Top-level bullets
  const bullets = (summary.match(SUMMARY_BULLETS_RE) || []).length;
  // Use the densest grouping signal as the claim count.
  return Math.max(numbered, tableRows, bullets);
}

function _countEvidenceSources(agentMemory, history) {
  let count = 0;
  try {
    count += getObjectLength(agentMemory || {});
    if (Array.isArray(history)) {
      // Count notes in a single pass
      const noteCount = history.reduce((acc, h) => acc + (h && h.action && h.action.type === 'note' ? 1 : 0), 0);
      count += noteCount;
    }
  } catch (_e) {
    // Context data read failed non-fatally
  }
  return count;
}

// (3.10.0) Patterns for "specific claims" that should be tagged with [src:*].
const _SPECIFIC_CLAIM_RES = [
  /\b\d[\d,]{3,}\b/g,                       // 1,234 / 110,000 / 271000
  /\b\d+(?:\.\d+)?%/g,                       // 47% / 15.5%
  /\$\s?\d[\d,]*(?:\.\d+)?\s?(?:[KMB]|million|billion|thousand)?\b/gi, // $5M / $12,345
  /\b\d{4}-\d{2}-\d{2}\b/g,                 // ISO dates
  /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,\s*\d{4})?\b/g
];

function _countSpecificClaims(summary) {
  if (!summary) return 0;
  let total = 0;
  for (const re of _SPECIFIC_CLAIM_RES) {
    const matches = summary.match(re);
    if (matches) total += matches.length;
  }
  return total;
}

function _countSourceTags(summary) {
  if (!summary) return 0;
  const matches = summary.match(SUMMARY_SRC_RE) || [];
  const unverified = summary.match(SUMMARY_UNVERIFIED_RE) || [];
  return matches.length + unverified.length;
}

function evaluateHallucinationRisk(summary, agentMemory, history) {
  const claims = _countSummaryClaims(summary);
  const evidence = _countEvidenceSources(agentMemory, history);
  const hasCaveats = _UNVERIFIED_CAVEATS.test(summary || '');
  const specificClaims = _countSpecificClaims(summary);
  const sourceTags = _countSourceTags(summary);

  // 3+ claims with 0 evidence is a clear fabrication.
  if (claims >= 3 && evidence === 0) {
    return { risky: true, reason: `Summary lists ${claims} items but no data was extracted to memory or recorded as notes.` };
  }
  // claims > 2x evidence with no caveats is suspicious.
  if (claims >= 4 && evidence > 0 && claims > evidence * 2 && !hasCaveats) {
    return { risky: true, reason: `Summary lists ${claims} items but only ${evidence} evidence sources (memory keys + notes) and no "headline only / not read" caveats.` };
  }
  // (3.10.0) Lots of specific numeric/date claims with no [src:*] tags
  if (specificClaims >= 5 && sourceTags === 0) {
    return { risky: true, reason: `Summary contains ${specificClaims} specific claims (numbers, dates, statistics) but no [src:memory_key] citations. Per the SOURCE-CITED OUTPUTS rule, every specific claim must be tagged.` };
  }
  // Specific claims wildly outnumber tags
  if (specificClaims >= 8 && sourceTags > 0 && specificClaims > sourceTags * 3) {
    return { risky: true, reason: `Summary has ${specificClaims} specific claims but only ${sourceTags} source tags. Tag each specific claim with [src:memory_key] or move it to a Caveats section as [unverified].` };
  }
  return { risky: false, claims, evidence, hasCaveats, specificClaims, sourceTags };
}

// ──────────────────────────────────────────────────────────────
// MFA Challenge Detection (3.7.0)
// ──────────────────────────────────────────────────────────────
// Many M365 / Entra / firewall login flows fire a step-up auth prompt
// (verification code, push notification, authenticator app). Without this
// detection the agent loops uselessly on the auth page until step-limit.
// We scan freshly read pageText for a panel of known MFA cues; on match,
// pause the agent, fire a desktop notification, and post a chat banner with
// a Resume button. The user resolves the challenge in the page, then clicks
// Resume.

// (3.12.0) Confidence-based MFA detection. The previous flat regex array
// false-positived on retail/checkout pages (coupon code fields, security
// product descriptions, news articles mentioning two-factor). Real MFA
// pages have stacked evidence: auth-provider URL + step-up language +
// short-input field. Match scheme:
//   1. Tier-1 cue alone (specific to MFA flows) -> fire
//   2. Auth-provider URL + ANY tier-2 cue -> fire
//   3. 2+ tier-2 cues on same page -> fire
//   4. Otherwise -> no fire
// Domain exclusion list short-circuits known non-MFA contexts.

const MFA_TIER1_PATTERNS = [
  /approve\s+(?:the\s+|this\s+)?sign.?in\s+request/i,
  /we'?ve\s+sent\s+(?:a\s+|an\s+)?(?:verification\s+)?code\s+to/i,
  /open\s+your\s+authenticator\s+app/i,
  /tap\s+the\s+number\s+you\s+see/i,         // Microsoft number-matching MFA
  /\bduo\s+(?:push|prompt|mobile)\b/i,
  /\bpush\s+(?:notification|approval)\s+sent\b/i,
  /enter\s+the\s+(?:verification\s+|security\s+)?code\s+(?:from|sent\s+to)/i,
  /\bwaiting\s+for\s+approval\b/i,
  /security\s+key\s+(?:plugged\s+in|connected|inserted)/i
];

const MFA_TIER2_PATTERNS = [
  /verify\s+your\s+identity/i,
  /two.?factor\s+(?:authentication|verification)/i,
  /multi.?factor\s+authentication/i,
  /authenticator\s+app/i,
  /one.?time\s+(?:passcode|password|code)/i,
  /\bOTP\b/,
  /6.?digit\s+(?:code|number|verification)/i,
  /check\s+your\s+phone/i,
  /enter\s+(?:the\s+)?verification\s+code/i,
  /verification\s+code\s+(?:was\s+)?sent/i
];

const MFA_AUTH_URL_PATTERNS = [
  /login\.microsoftonline\.com/i,
  /login\.live\.com/i,
  /accounts\.google\.com/i,
  /login\.okta\.com/i,
  /\.okta\.com\/(?:signin|verify|mfa)/i,
  /\.duosecurity\.com/i,
  /sts\.[a-z0-9.-]+\.(com|net|org)/i,
  /\/(?:mfa|2fa|otp|challenge|verify|signin|sign-in)(?:[/?#]|$)/i,
  /auth\.[a-z0-9.-]+\.(com|net|org)/i
];

// Pages that should NEVER fire MFA, even with weak text cues. Stops
// shopping / news / social sites from tripping the detector.
const MFA_EXCLUDE_DOMAINS = [
  /amazon\.[a-z.]+\/(?:s|gp|dp|product|cart|checkout)/i,
  /ebay\.[a-z.]+\/(?:itm|sch|str)/i,
  /walmart\.com\/(?:ip|search|cart)/i,
  /target\.com\/(?:p|s|c)/i,
  /bestbuy\.com\/(?:site|cart)/i,
  /apple\.com\/shop/i,
  /bhphotovideo\.com\/c/i,
  /newegg\.com\/p/i,
  /github\.com\/[^/]+\/[^/]+(?:\/|$)/i,    // GitHub repos
  /\/blog\//i,
  /\/news\//i,
  /\/article\//i,
  /\/(?:product|products|shop|store|cart|checkout)\//i,
  /(?:youtube|youtu\.be|twitter|x\.com|reddit|linkedin|facebook|instagram|tiktok)\.com/i
];

function detectMfaInText(text, currentUrl) {
  if (!text || typeof text !== 'string') return null;
  const url = (currentUrl || '').toLowerCase();

  // Hard exclude known non-MFA contexts -- protects against shopping /
  // news / social pages with random "verify" or "two-factor" text.
  for (const re of MFA_EXCLUDE_DOMAINS) {
    if (re.test(url)) return null;
  }

  const sample = text.substring(0, TEXT_SAMPLE_LENGTH);

  // Tier 1: any single match fires.
  for (const re of MFA_TIER1_PATTERNS) {
    const m = sample.match(re);
    if (m) return m[0];
  }

  const isAuthUrl = MFA_AUTH_URL_PATTERNS.some(re => re.test(url));

  // Tier 2: collect matches, decide based on count + URL.
  const tier2Hits = [];
  for (const re of MFA_TIER2_PATTERNS) {
    const m = sample.match(re);
    if (m) tier2Hits.push(m[0]);
  }

  // Auth URL + any tier-2 cue -> fire.
  if (isAuthUrl && tier2Hits.length) return tier2Hits[0];

  // Multiple tier-2 cues on same page -> fire (covers MFA flows on
  // less-common auth domains).
  if (tier2Hits.length >= 2) return tier2Hits[0];

  return null;
}

// ──────────────────────────────────────────────────────────────
// Sign-In Wall Detection (3.14.1)
// ──────────────────────────────────────────────────────────────
// Detects authentication walls (username/password forms) BEFORE the LLM tries
// to drive past them. Different from MFA detection: MFA fires AFTER credentials
// have been entered. Sign-in wall fires when we hit the login page at all and
// have no way to enter the user's password (the runtime password-field block in
// content/index.js already prevents auto-fill).
//
// Trigger requires BOTH signals to be true:
//   1. URL matches a known auth host
//   2. Page has at least one visible password input in the observation
// This guards against false positives on post-auth redirect pages that
// briefly pass through login.microsoftonline.com without showing a form.

const SIGN_IN_WALL_HOSTS_RE = /(login\.microsoftonline\.com|login\.live\.com|login\.microsoft\.com|accounts\.google\.com|accounts\.youtube\.com|login\.okta\.com|[^.]+\.okta\.com|[^.]+\.oktapreview\.com|auth0\.com|[^.]+\.auth0\.com|signin\.aws\.amazon\.com|github\.com\/login|gitlab\.com\/users\/sign_in|bitbucket\.org\/account\/signin|login\.salesforce\.com|[^.]+\.my\.salesforce\.com|signin\.intuit\.com|login\.duosecurity\.com|connect\.secureauth\.com|adfs\..+|sts\..+)/i;

const SIGN_IN_WALL_TEXT_RE = /\b(sign\s*in|log\s*in|enter\s+your\s+(?:password|email)|use\s+your\s+microsoft\s+account|stay\s+signed\s+in)\b/i;

// Returns { matched: true, host, evidence } when a sign-in wall is detected,
// or null. Evidence describes WHY we matched (URL + password-field selector
// or text cue) so the banner can show useful context.
function detectSignInWall(allElements, currentUrl, pageText) {
  if (!currentUrl) return null;
  let host;
  try { host = new URL(currentUrl).host; } catch (_e) { return null; }
  if (!SIGN_IN_WALL_HOSTS_RE.test(host) && !SIGN_IN_WALL_HOSTS_RE.test(currentUrl)) return null;

  // Signal 1: a password input is present in the observed elements
  let pwField = null;
  if (Array.isArray(allElements)) {
    pwField = allElements.find(e => {
      if (!e) return false;
      if (e.type === 'password') return true;
      const sel = String(e.selector || '').toLowerCase();
      if (/passw(or)?d|passwordinput/i.test(sel)) return true;
      return false;
    });
  }
  if (pwField) {
    return { matched: true, host, evidence: `password input on ${host}`, selector: pwField.selector || '' };
  }

  // Signal 2 (fallback): page text contains sign-in cues AND we're on a known auth host
  // This catches the brief username-only first step before the password field renders
  // (Microsoft's two-step sign-in: email page → password page).
  if (pageText && SIGN_IN_WALL_TEXT_RE.test(pageText)) {
    // Require a username/email input to be present so we don't trip on
    // post-auth redirect screens that say "Stay signed in?" without a form.
    if (Array.isArray(allElements)) {
      const emailField = allElements.find(e => {
        if (!e) return false;
        if (e.type === 'email') return true;
        const sel = String(e.selector || '').toLowerCase();
        return /(email|username|loginfmt|user_?id|user_?name|signin)/i.test(sel);
      });
      if (emailField) {
        return { matched: true, host, evidence: `email/username input on ${host}`, selector: emailField.selector || '' };
      }
    }
  }

  return null;
}

// ──────────────────────────────────────────────────────────────
// Exports
// ──────────────────────────────────────────────────────────────
export {
  _tenantsMatch,
  detectMfaInText,
  detectSignInWall,
  evaluateHallucinationRisk,
  // Internal helpers exported for test coverage
  _countSummaryClaims,
  _countSpecificClaims,
  _countSourceTags,
};
