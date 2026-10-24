// background/site-policy.js
// Phase 2.5 — per-site policy engine with always-hand-to-user classes.
//
// THE GAP THIS CLOSES
//   The capability gate (background/capabilities.js) decides whether an action
//   is *privileged* — whether it needs an operator grant. It says nothing about
//   *where* the action lands. A plain `click` is red and needs no grant, so the
//   model may click "Transfer $5,000" on a banking page without the operator
//   ever seeing it. That is the hole this module plugs: the site itself raises
//   the bar.
//
// THE CLASSES
//   free          ordinary browsing. Nothing is gated.
//   caution       worth surfacing to the operator, but not blocking.
//   hand_to_user  ALWAYS hand the action to the operator before dispatching it.
//                 This is the sticky one: once a site is in this class, no
//                 mutating action on it proceeds on model authority alone.
//   blocked       refuse outright, reads included.
//
// WHY THE CLASS CANNOT BE WIDENED OR NARROWED BY THE MODEL
//   `classifySite` derives the class from exactly two inputs: the URL, and the
//   operator's own persisted rules. It reads no field off the action. A model
//   that puts `policyClass`, `siteClass`, `class`, `policy`, `risk`, `safe` or
//   any other key on its action object changes nothing — the action's own
//   fields are never consulted for the class, only for *which* action it is
//   (to decide whether it mutates at all).
//
//   The operator rules live in chrome.storage.local under `sitePolicyRules` and
//   are written only by the settings surface. This module only ever READS that
//   key, exactly as capabilities.js only ever reads `grantedCapabilities`.
//
// HONEST LIMITS
//   - Site classification is heuristic: domain matching plus a path scan. It
//     decides whether to *escalate to a human*; it is not a boundary against a
//     determined attacker, and a novel phishing domain will classify as `free`.
//     It is a brake, not a lock.
//   - `hand_to_user` is only as strong as the engine honoring the result. The
//     engine must present the action and wait; this module cannot force that.
//     The engine-side wiring is what makes it real, and it is covered by tests
//     at both ends.

/** Ordered from least to most restrictive. */
export const POLICY_CLASSES = Object.freeze(['free', 'caution', 'hand_to_user', 'blocked']);

export const DEFAULT_POLICY_CLASS = 'free';

/** Storage key holding the operator's persisted per-site rules. Read-only here. */
export const SITE_POLICY_KEY = 'sitePolicyRules';

// ---------------------------------------------------------------------------
// Built-in high-stakes signals
// ---------------------------------------------------------------------------
//
// Each signal is `{ class, label, hosts, paths }`. A URL matches when its host
// matches one of `hosts` (exact or as a parent domain) OR its pathname starts
// with one of `paths`. `paths` is what catches the dangerous page on an
// otherwise ordinary domain — the OAuth consent screen, the account-deletion
// form, the transfer confirmation.
//
// These are deliberately conservative in the safe direction: a false positive
// costs the operator one extra approval click; a false negative costs them a
// money transfer.

const FINANCIAL_HOSTS = Object.freeze([
  // Payments
  'paypal.com', 'stripe.com', 'square.com', 'squareup.com', 'wise.com',
  'revolut.com', 'venmo.com', 'cash.app', 'zyndel.com', 'klarna.com',
  'afterpay.com', 'affirm.com', 'braintreepayments.com', 'adyen.com',
  // Crypto
  'coinbase.com', 'binance.com', 'kraken.com', 'gemini.com', 'crypto.com',
  'blockchain.com', 'metamask.io', 'ledger.com', 'trezor.io', 'kucoin.com',
  'okx.com', 'bybit.com', 'bitfinex.com',
  // Brokerage
  'robinhood.com', 'schwab.com', 'fidelity.com', 'tdameritrade.com',
  'etrade.com', 'interactivebrokers.com', 'vanguard.com', 'ibkr.com',
  // Retail banking (a representative set, not an exhaustive one)
  'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'citibank.com',
  'citi.com', 'hsbc.com', 'hsbc.co.uk', 'barclays.com', 'barclays.co.uk',
  'natwest.com', 'rbs.com', 'lloydsbank.com', 'santander.com', 'santander.co.uk',
  'ing.com', 'ing.de', 'deutsche-bank.com', 'commerzbank.com',
  'nab.com.au', 'commbank.com.au', 'anz.com.au', 'westpac.com.au',
  'td.com', 'rbc.com', 'bmo.com', 'scotiabank.com', 'cibc.com',
]);

const IDENTITY_HOSTS = Object.freeze([
  // SSO / identity providers
  'accounts.google.com', 'login.microsoftonline.com', 'login.microsoft.com',
  'okta.com', 'onelogin.com', 'duosecurity.com', 'auth0.com', 'pingidentity.com',
  'adobe.com', 'dropbox.com', 'github.com', 'gitlab.com',
  // Vendors' account consoles
  'signin.aws.amazon.com', 'console.aws.amazon.com', 'portal.azure.com',
  'admin.google.com', 'workspace.google.com', 'salesforce.com', 'vmware.com',
  'appleid.apple.com', 'account.apple.com', 'apple.com',
  // Password managers — reading these is reading the keys to everything
  '1password.com', 'bitwarden.com', 'lastpass.com', 'dashlane.com',
  'nordpass.com', 'proton.me', 'keepersecurity.com', 'enpass.io',
]);

const EMAIL_HOSTS = Object.freeze([
  'mail.google.com', 'gmail.com', 'outlook.com', 'outlook.office.com',
  'office.com', 'mail.yahoo.com', 'yahoo.com', 'mail.aol.com', 'aol.com',
  'protonmail.com', 'mail.proton.me', 'zoho.com', 'gmx.com', 'gmx.net',
  'icloud.com', 'mailfence.com', 'tutanota.com', 'fastmail.com',
]);

// Paths that mean "this page grants, revokes, or moves something". Matched as a
// pathname prefix so `/account/delete` and `/settings/delete-account` both hit.
const HIGH_STAKES_PATHS = Object.freeze([
  '/oauth/authorize', '/oauth2/authorize', '/oauth/consent', '/oauth2/consent',
  '/connect/authorize', '/dialog/oauth', '/authorize', '/consent',
  '/permissions', '/settings/permissions', '/settings/security',
  '/account/security', '/account/delete', '/settings/delete',
  '/delete-account', '/close-account', '/deactivate', '/account/deactivate',
  '/transfer', '/transfers', '/wire', '/withdraw', '/payments/send',
  '/settings/close', '/admin/permissions', '/admin/users',
]);

const HIGH_STAKES_SIGNALS = Object.freeze([
  { class: 'hand_to_user', label: 'financial', hosts: FINANCIAL_HOSTS, paths: Object.freeze([]) },
  { class: 'hand_to_user', label: 'identity', hosts: IDENTITY_HOSTS, paths: Object.freeze(['/signin', '/login', '/session', '/sso']) },
  { class: 'hand_to_user', label: 'email', hosts: EMAIL_HOSTS, paths: Object.freeze([]) },
  { class: 'hand_to_user', label: 'high-stakes-page', hosts: Object.freeze([]), paths: HIGH_STAKES_PATHS },
]);

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

// Two-level public suffixes we know about. Without a real public-suffix list
// the best we can do is this short set; it only affects how broadly a rule
// pattern matches, never whether a built-in signal fires (those match on the
// full hostname).
const MULTI_LABEL_SUFFIXES = Object.freeze([
  'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk', 'co.jp', 'co.kr', 'com.au',
  'net.au', 'org.au', 'com.br', 'com.mx', 'co.in', 'co.nz', 'com.cn',
  'com.tw', 'com.sg', 'com.hk', 'co.za',
]);

function _registrableDomain(hostname) {
  if (!hostname) return null;
  const host = String(hostname).toLowerCase().replace(/\.$/, '');
  const labels = host.split('.');
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_LABEL_SUFFIXES.includes(lastTwo)) {
    if (labels.length <= 3) return labels.join('.');
    return labels.slice(-3).join('.');
  }
  return lastTwo;
}

/**
 * Split a URL into `{ host, domain, path }`, or null when it is not a URL we
 * can reason about. Pure, never throws.
 *
 * A host that is empty or a single label (`https:///nohost`, `http://intranet`)
 * is rejected rather than accepted. It is not a site this module can classify,
 * and returning a synthetic one-label host would let a malformed URL pose as a
 * real domain. `localhost` is the one bare label we accept, because a local
 * development server is a real place the agent may legitimately drive.
 *
 * @param {string} url
 * @returns {{host: string, domain: string, path: string}|null}
 */
export function parseSiteUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_e) {
    return null;
  }
  const host = (parsed.hostname || '').toLowerCase();
  if (!host) return null;
  if (!host.includes('.') && host !== 'localhost') return null;
  return { host, domain: _registrableDomain(host), path: parsed.pathname || '/' };
}

function _hostMatches(site, pattern) {
  const p = String(pattern || '').toLowerCase().replace(/\.$/, '');
  if (!p) return false;
  if (site.host === p || site.domain === p) return true;
  // A rule for `example.com` covers `www.example.com` and `app.example.com`.
  if (site.host.endsWith('.' + p)) return true;
  // A rule for a parent domain does not cover a sibling that merely ends with
  // the same string, which the endsWith check above already avoids.
  return false;
}

/**
 * Does a rule pattern match this site? A pattern may be a bare host
 * (`example.com`, `*.example.com`) or a host plus a path prefix
 * (`example.com/account`). The path part is optional; when absent the rule
 * matches the whole host.
 *
 * @param {{host: string, domain: string, path: string}} site
 * @param {string} pattern
 * @returns {boolean}
 */
export function ruleMatchesSite(site, pattern) {
  if (!site || typeof pattern !== 'string' || !pattern.trim()) return false;
  const raw = pattern.trim().toLowerCase();
  const hashIdx = raw.indexOf('#');
  const noHash = hashIdx === -1 ? raw : raw.slice(0, hashIdx);
  const slashIdx = noHash.indexOf('/');
  const hostPart = (slashIdx === -1 ? noHash : noHash.slice(0, slashIdx)).replace(/^\*\./, '');
  const pathPart = slashIdx === -1 ? '' : noHash.slice(slashIdx);

  if (!_hostMatches(site, hostPart)) return false;
  if (!pathPart) return true;
  return site.path === pathPart || site.path.startsWith(pathPart);
}

// ---------------------------------------------------------------------------
// Action classification
// ---------------------------------------------------------------------------

// Actions that only observe. Everything else — including a type this module has
// never heard of — is treated as mutating.
//
// The list is INVERTED on purpose. An allowlist of mutating types has a hole in
// it the moment the schema grows a new action: a future "transfer_funds" would
// not be in the list, would be classified read-only, and would sail through a
// high-stakes gate. A denylist of read-only types fails the other way — a new
// action is gated until a human says otherwise, which costs an extra approval
// click instead of costing money. The second failure is the one we can afford.
const READ_ONLY_ACTION_TYPES = Object.freeze(new Set([
  'read_page', 'read_console_messages', 'read_network_requests',
  'extract', 'extract_list', 'find', 'verify', 'lookup',
  'wait', 'wait_for_text', 'wait_for_element', 'wait_for_navigation',
  'note', 'finish',
]));

/**
 * True when the action changes state. Pure.
 *
 * Unknown action types are mutating on purpose — see the note on
 * READ_ONLY_ACTION_TYPES above. A malformed action (no `type`) is also treated
 * as mutating: it is not a known-safe read, so it must not pass a high-stakes
 * gate on the strength of being malformed.
 *
 * @param {object} action
 * @returns {boolean}
 */
export function isMutatingAction(action) {
  if (!action || typeof action !== 'object') return false;
  if (READ_ONLY_ACTION_TYPES.has(action.type)) return false;
  return true;
}

/**
 * The URL a policy should be evaluated against for this action.
 *
 * A navigation action is judged by where it is GOING, not by where the tab
 * currently sits — otherwise driving a banking site from a benign start page
 * would never be escalated. Everything else is judged by the tab's current URL.
 *
 * @param {object} action
 * @param {{currentUrl?: string, currentOrigin?: string}} [context]
 * @returns {string|null}
 */
export function policyUrlForAction(action, context = {}) {
  const a = action || {};
  if (a.type === 'navigate' || a.type === 'smart_navigate' || a.type === 'open_tab') {
    if (typeof a.url === 'string' && a.url.trim()) return a.url;
  }
  if (typeof (context.currentUrl) === 'string' && context.currentUrl.trim()) {
    return context.currentUrl;
  }
  if (typeof (context.currentOrigin) === 'string' && context.currentOrigin.trim()) {
    return context.currentOrigin;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Coerce arbitrary stored/derived data into a list of known rule objects.
 * Unknown or malformed entries are dropped rather than honoured, so a typo or
 * an injected value can never widen a class.
 *
 * @param {*} value
 * @returns {Array<{pattern: string, class: string, label?: string}>}
 */
export function normalizeSiteRules(value) {
  const out = [];
  if (!Array.isArray(value)) return out;
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const pattern = entry.pattern || entry.host || entry.domain || entry.url;
    const cls = entry.class || entry.policy;
    if (typeof pattern !== 'string' || !pattern.trim()) continue;
    if (typeof cls !== 'string' || !POLICY_CLASSES.includes(cls)) continue;
    out.push({
      pattern: pattern.trim(),
      class: cls,
      label: typeof entry.label === 'string' ? entry.label : 'operator-rule',
    });
  }
  return out;
}

/**
 * Read the operator's persisted per-site rules. The only side effect in this
 * module, and it is a read. Fails to an empty list: the built-in signals are
 * the safety net and must keep firing even when storage is unreadable.
 *
 * @returns {Promise<Array<{pattern: string, class: string, label: string}>>}
 */
export async function loadSitePolicyRules() {
  try {
    const stored = await chrome.storage.local.get([SITE_POLICY_KEY]);
    return normalizeSiteRules(stored && stored[SITE_POLICY_KEY]);
  } catch (_e) {
    return [];
  }
}

/**
 * Classify a site. Pure. Returns the class in force plus the reasons it was
 * reached — so the operator is told WHY they are being asked, rather than being
 * shown a bare "approve?".
 *
 * Precedence: built-in signals establish a floor, then a matching operator rule
 * OVERRIDES the result outright. The override runs last and is not compared
 * against the built-in rank, because "most restrictive wins" would make a
 * de-escalation impossible — an operator rule of `free` for a banking host
 * would lose to the built-in `hand_to_user` and be silently ignored, which is
 * exactly the failure this ordering exists to prevent. The operator is the
 * authority; the built-ins are the default they can change.
 *
 * @param {string} url
 * @param {Array<{pattern: string, class: string, label?: string}>} [rules]
 * @returns {{class: string, label: string|null, reasons: string[], url: string|null}}
 */
export function classifySite(url, rules = []) {
  const site = parseSiteUrl(url);
  const result = {
    class: DEFAULT_POLICY_CLASS,
    label: null,
    reasons: [],
    url: site ? site.host : null,
  };
  if (!site) {
    // Not `free`. When we cannot tell where an action is going, the honest
    // answer is "unknown", and the operator should see it rather than have it
    // quietly allowed. `caution` is surfaced but does not block, so an
    // occasional odd URL costs a glance instead of rendering the agent useless.
    result.class = 'caution';
    result.label = 'unparseable-url';
    result.reasons.push('unparseable-url');
    return result;
  }

  const rank = (cls) => POLICY_CLASSES.indexOf(cls);
  let best = -1;

  for (const signal of HIGH_STAKES_SIGNALS) {
    const hit = signal.hosts.some((h) => _hostMatches(site, h))
      || signal.paths.some((p) => site.path === p || site.path.startsWith(p));
    if (!hit) continue;
    result.reasons.push(signal.label);
    if (rank(signal.class) > best) {
      best = rank(signal.class);
      result.class = signal.class;
      result.label = signal.label;
    }
  }

  // Operator rules are authoritative. When several match, the most restrictive
  // one wins — an operator who writes both `example.com → free` and
  // `example.com/admin → blocked` has asked for the admin path to stay shut.
  let operatorClass = null;
  let operatorLabel = null;
  let operatorRank = -1;
  for (const rule of normalizeSiteRules(rules)) {
    if (!ruleMatchesSite(site, rule.pattern)) continue;
    result.reasons.push(rule.label || 'operator-rule');
    if (rank(rule.class) >= operatorRank) {
      operatorRank = rank(rule.class);
      operatorClass = rule.class;
      operatorLabel = rule.label || 'operator-rule';
    }
  }
  if (operatorClass !== null) {
    result.class = operatorClass;
    result.label = operatorLabel;
  }

  return result;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Decide whether one action may be dispatched on its site.
 *
 * The result is what the engine acts on. `handToUser: true` means the engine
 * MUST present the action to the operator and wait for an explicit decision —
 * it is not a hint, and `allowed` is still true so the caller does not also
 * treat it as a refusal. `allowed: false` means do not dispatch at all.
 *
 * `surfaced` marks a `caution` result — the engine should show it to the
 * operator but may proceed. It exists so "unknown site" is visible rather than
 * silent; without it an unparseable URL would be indistinguishable from a clean
 * pass, which is the silent-no-op failure this sprint exists to remove.
 *
 * @param {object} action
 * @param {{currentUrl?: string, currentOrigin?: string, rules?: Array}} [context]
 * @returns {{allowed: boolean, handToUser: boolean, blocked: boolean, surfaced: boolean,
 *            class: string, reasons: string[], mutating: boolean, url: string|null}}
 */
export function checkSitePolicy(action, context = {}) {
  const rules = Array.isArray(context.rules) ? context.rules : [];
  const url = policyUrlForAction(action, context);
  const site = classifySite(url, rules);
  const mutating = isMutatingAction(action);

  if (site.class === 'blocked') {
    return {
      allowed: false, handToUser: false, blocked: true, surfaced: false,
      class: site.class, reasons: site.reasons,
      mutating, url: site.url,
    };
  }

  const handToUser = site.class === 'hand_to_user' && mutating;

  return {
    allowed: true,
    handToUser,
    blocked: false,
    surfaced: site.class === 'caution',
    class: site.class,
    reasons: site.reasons,
    mutating,
    url: site.url,
  };
}

/** Forget the cached rule list — for tests. */
export function _resetRuleCache() {
  // Kept as a named no-op so callers and tests have a single documented reset
  // point if caching is ever added.
}
