// background/secrets-redaction.js
// Credential redaction for everything that can reach the model.
//
// THE PROBLEM
//   The agent drives Chrome over CDP and can read the page's network traffic.
//   Request/response headers carry the session itself: `Cookie` is the login,
//   `Authorization` is the bearer/basic credential, `X-Api-Key` is the API key.
//   A URL's query string carries OAuth `?code=` / `?access_token=` and
//   `?api_key=` values. Any of those, once surfaced in a tool result, is in the
//   LLM prompt and can be repeated back or exfiltrated. So the network summary
//   must show the SHAPE of a request (method, host, path, non-secret params,
//   which headers were present) without the secret VALUES.
//
// WHAT THIS IS
//   A small, pure, structural redaction layer: header maps, URL query strings
//   and cookie strings go in, the same structure comes out with credential
//   values replaced by the literal placeholder `[REDACTED]`. Header NAMES and
//   cookie NAMES survive, and non-sensitive headers (`content-type`,
//   `content-length`, `cache-control`, ...) and non-sensitive query params pass
//   through untouched, so the summary stays useful for debugging.
//
// WHAT THIS IS NOT
//   It is NOT a capability gate and does NOT replace `network_read`
//   (background/capabilities.js). Redaction is defence-in-depth *on top of* the
//   gate: the gate decides whether the model may read the network at all; this
//   decides what the model is allowed to see in what it reads. Weakening the
//   gate is never the fix for a leak.
//
//   It is also NOT a pattern scanner. background/telemetry.js already has a
//   string-level scanner (`_redactString`) that hunts for `sk-...`, JWTs, AWS
//   keys, etc. inside free text. That runs on telemetry payloads. This module is
//   the structural counterpart: it knows a header is a header and a query param
//   is a query param, so it redacts by NAME rather than by guessing at a value's
//   shape. The two are complementary; free-form strings (console text) still
//   need the pattern scanner, not this.
//
// GUARANTEES
//   * Pure — no I/O, no globals, no mutation of the input. Unit-testable with no
//     browser. Every function takes its input explicitly.
//   * Total — never throws. A malformed URL is returned unchanged rather than
//     rejected, because a caller mid-pipeline must not blow up on odd input.
//   * Idempotent — redacting an already-redacted value leaves it as
//     `[REDACTED]`, so re-running the layer (belt and braces at storage and at
//     output) cannot double-redact or corrupt anything.
//   * Never logs a secret. Nothing here logs at all; a caller that wants to note
//     a redaction should log the COUNT or the header NAME, never the value.

/** Stable placeholder substituted for every redacted value. */
export const REDACTED = '[REDACTED]';

/**
 * Header names (lowercased) whose VALUE is a credential. Matched exactly, after
 * trimming and lowercasing, so `Authorization` and `authorization` behave alike.
 */
export const SENSITIVE_HEADER_NAMES = Object.freeze([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'set-cookie2',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'authentication',
  'x-csrf-token',
  'x-xsrf-token',
  'x-amz-security-token',
  'x-goog-authuser',
]);

const SENSITIVE_HEADER_SET = new Set(SENSITIVE_HEADER_NAMES);

// Response headers where the entire value IS the credential and there is no
// inner name worth preserving, so the whole value becomes `[REDACTED]`. A
// `Set-Cookie` value must never be emitted verbatim under any circumstance.
const FULL_REDACT_HEADER_SET = new Set(['set-cookie', 'set-cookie2']);

/**
 * Is this header name one whose value must be redacted?
 * Pure. Exact match on the trimmed, lowercased name, so `Authorization` and
 * `authorization` behave alike. Deliberately NOT a substring test: a header
 * named `x-authorization-hint` is not a credential.
 *
 * @param {string} name - Header name, any casing.
 * @returns {boolean}
 */
export function isSensitiveHeaderName(name) {
  if (typeof name !== 'string') return false;
  return SENSITIVE_HEADER_SET.has(name.trim().toLowerCase());
}

/**
 * Query parameter names (lowercased) that carry credentials.
 *
 * Matching is SEGMENT-based, not substring-based: the name is split on
 * non-alphanumeric characters and any whole segment that names a credential
 * marks the parameter sensitive (see `isSensitiveQueryParam`). That is what
 * keeps this both safe and precise -- `oauth_access_token`, `X-Api-Key` and
 * `accessToken` are credentials, while `monkey`, `keyboard`, `design`,
 * `signal` and `author` are ordinary parameters a substring test would
 * silently redact and this one leaves alone.
 */
export const SENSITIVE_QUERY_PARAMS = Object.freeze([
  'access_token',
  'token',
  'id_token',
  'refresh_token',
  'api_key',
  'apikey',
  'key',
  'sig',
  'signature',
  'code',
  'auth',
  'authentication',
  'credential',
  'credentials',
  'password',
  'passwd',
  'pwd',
  'pass',
  'secret',
  'client_secret',
  'session',
  'sessionid',
  'session_id',
  'jsessionid',
  'phpsessid',
  'sid',
  'otp',
]);

const SENSITIVE_QUERY_SET = new Set(SENSITIVE_QUERY_PARAMS);

/** Anything that is not a lowercase letter or digit: a segment boundary. */
const SEGMENT_SEPARATOR_RE = /[^a-z0-9]+/;

/**
 * Every sensitive name with its separators removed, lowercased. Comparing
 * against this is what lets `accessToken` and `ACCESS-TOKEN` hit the same entry
 * as `access_token` without a substring test.
 */
const SENSITIVE_QUERY_SEGMENTS = new Set(
  SENSITIVE_QUERY_PARAMS.map((p) => p.replace(SEGMENT_SEPARATOR_RE, ''))
);

/**
 * Is this query parameter name credential-bearing?
 * Pure. Case-insensitive, separator-insensitive, segment-based:
 *
 *   - the whole name matches a sensitive name (`token`, `api_key`);
 *   - or the name with its separators stripped does (`accessToken`);
 *   - or any whole segment of it does (`oauth_access_token`, `X-Api-Key`).
 *
 * @param {string} name - Query parameter name (raw or percent-encoded).
 * @returns {boolean}
 */
export function isSensitiveQueryParam(name) {
  if (typeof name !== 'string' || !name) return false;
  let decoded = name;
  try { decoded = decodeURIComponent(name); } catch (_e) { /* keep the raw name */ }
  const lower = decoded.toLowerCase();
  if (SENSITIVE_QUERY_SET.has(lower)) return true;
  if (SENSITIVE_QUERY_SEGMENTS.has(lower.replace(SEGMENT_SEPARATOR_RE, ''))) return true;
  return lower
    .split(SEGMENT_SEPARATOR_RE)
    .some((segment) => SENSITIVE_QUERY_SEGMENTS.has(segment));
}

/**
 * Redact the value of one header, given its name.
 * Pure.
 *   - Non-sensitive header: value returned unchanged.
 *   - `Cookie`: names kept, values redacted (`sid=x; theme=y` →
 *     `sid=[REDACTED]; theme=[REDACTED]`) so the model still sees WHICH cookies
 *     a request carried without seeing the session tokens.
 *   - `Set-Cookie` / everything else sensitive: whole value → `[REDACTED]`.
 *
 * @param {string} name - Header name.
 * @param {*} value - Header value (any type; non-strings are redacted whole).
 * @returns {*} The value to emit.
 */
export function redactHeaderValue(name, value) {
  const lower = typeof name === 'string' ? name.trim().toLowerCase() : '';
  if (!SENSITIVE_HEADER_SET.has(lower)) return value;
  if (lower === 'cookie') return redactCookieString(value);
  if (FULL_REDACT_HEADER_SET.has(lower)) return REDACTED;
  return REDACTED;
}

/**
 * Redact every sensitive header in a header collection.
 * Pure. Accepts either a CDP/`Headers`-style plain object (`{ name: value }`)
 * or an array of `{ name, value }` entries, and returns the same shape. The
 * input object is never mutated.
 *
 * @param {object|Array<{name:string,value:*}>|null|undefined} headers
 * @returns {object|Array|*} Redacted copy, or the input unchanged when nullish.
 */
export function redactHeaders(headers) {
  if (headers == null) return headers;
  if (Array.isArray(headers)) {
    return headers.map((h) => {
      if (!h || typeof h !== 'object') return h;
      const name = h.name;
      if (!isSensitiveHeaderName(name)) return { ...h };
      return { ...h, value: redactHeaderValue(name, h.value) };
    });
  }
  if (typeof headers === 'object') {
    const out = {};
    for (const [name, value] of Object.entries(headers)) {
      out[name] = redactHeaderValue(name, value);
    }
    return out;
  }
  return headers;
}

/**
 * Redact the values of a `name=value; name2=value2` cookie string, keeping the
 * names, the separators and any whitespace exactly as they were.
 * Pure and idempotent.
 *
 * @param {*} value - A cookie string, e.g. `sid=abc123; theme=dark`.
 * @returns {string} The cookie string with every value replaced by `[REDACTED]`
 *   (or `[REDACTED]` for a non-string, which cannot be parsed safely).
 */
export function redactCookieString(value) {
  if (typeof value !== 'string') return REDACTED;
  if (!value.length) return value;
  const parts = value.split(';');
  const out = parts.map((part) => {
    const eq = part.indexOf('=');
    if (eq === -1) return part; // a bare flag cookie carries no value
    const name = part.slice(0, eq);
    const val = part.slice(eq + 1);
    if (val === REDACTED) return part; // idempotent: already redacted
    return `${name}=${REDACTED}`;
  });
  return out.join(';');
}

/**
 * Redact an array of parsed cookie objects (`{ name, value, ... }`) as returned
 * by CDP's `associatedCookies`. Keeps every other field (domain, path, expiry)
 * and the name; replaces only `value`.
 * Pure and idempotent.
 *
 * @param {Array<object>|null|undefined} cookies
 * @returns {Array<object>|*} Redacted copy, or the input unchanged when not an array.
 */
export function redactCookiePairs(cookies) {
  if (!Array.isArray(cookies)) return cookies;
  return cookies.map((c) => {
    if (!c || typeof c !== 'object') return c;
    return { ...c, value: REDACTED };
  });
}

/**
 * Redact one query string (the part between `?` and `#`), preserving parameter
 * order, separators, percent-encoding and any non-sensitive params byte-for-byte.
 * Pure. Internal.
 *
 * @param {string} query - Raw query string without the leading `?`.
 * @returns {string}
 */
function _redactQueryString(query) {
  let changed = false;
  const parts = query.split('&').map((pair) => {
    if (!pair) return pair;
    const eq = pair.indexOf('=');
    if (eq === -1) return pair; // no value to leak
    const rawKey = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (!isSensitiveQueryParam(rawKey)) return pair;
    if (value === REDACTED) return pair; // idempotent
    changed = true;
    return `${rawKey}=${REDACTED}`;
  });
  return changed ? parts.join('&') : query;
}

/**
 * Characters that end the authority component of a URL.
 * @type {string}
 */
const AUTHORITY_TERMINATORS = '/?#';

/**
 * Redact the password in `scheme://user:pass@host/`, keeping the username.
 *
 * A URL may carry its credential in the authority rather than the query string
 * (`https://user:pass@host/`), and that is the same secret in the same tool
 * result, so it is redacted the same way. The username survives because it is
 * usually not a secret and is often the only thing that makes a URL
 * recognisable; the password becomes `REDACTED`.
 *
 * A bare `user@host` (no colon) has no password to hide and is returned
 * unchanged, and so is anything without a `://` authority. Pure and
 * idempotent: an already-redacted authority re-redacts to itself.
 *
 * @param {string} url - Candidate URL string.
 * @returns {string} The URL with any authority password replaced.
 */
function _redactAuthority(url) {
  const schemeEnd = url.indexOf('://');
  if (schemeEnd === -1) return url;
  const start = schemeEnd + 3;
  let end = url.length;
  for (let i = start; i < url.length; i += 1) {
    if (AUTHORITY_TERMINATORS.indexOf(url[i]) !== -1) {
      end = i;
      break;
    }
  }
  const authority = url.slice(start, end);
  // The last "@" is the separator: a password may contain an encoded "@", and a
  // raw one is illegal but still possible, so splitting from the right keeps
  // the host intact.
  const at = authority.lastIndexOf('@');
  if (at === -1) return url;
  const userinfo = authority.slice(0, at);
  const colon = userinfo.indexOf(':');
  if (colon === -1) return url;
  return url.slice(0, start) + userinfo.slice(0, colon) + ':' + REDACTED
    + authority.slice(at) + url.slice(end);
}

/**
 * Redact credentials in a URL -- query parameters and authority passwords.
 * Pure. Scheme, host, port, path, fragment, parameter order, encoding and every
 * non-sensitive parameter are preserved exactly. A URL with nothing to redact,
 * or one that cannot be parsed, is returned unchanged (never throws).
 *
 * @param {*} url - Candidate URL string.
 * @returns {*} Redacted URL string, or the input unchanged when not a string /
 *   unparseable / free of credentials.
 */
export function redactUrl(url) {
  if (typeof url !== 'string' || !url.length) return url;
  // Validate first: malformed input is returned as-is rather than mangled.
  try { new URL(url); } catch (_e) { return url; }
  // The authority first, so a URL carrying both a password and a credential
  // query parameter has both scrubbed.
  url = _redactAuthority(url);
  const qIndex = url.indexOf('?');
  if (qIndex === -1) return url;
  const hashIndex = url.indexOf('#', qIndex);
  const queryEnd = hashIndex === -1 ? url.length : hashIndex;
  const head = url.slice(0, qIndex);
  const query = url.slice(qIndex + 1, queryEnd);
  const tail = url.slice(queryEnd);
  if (!query) return url;
  const redactedQuery = _redactQueryString(query);
  if (redactedQuery === query) return url; // nothing sensitive → exact original
  return `${head}?${redactedQuery}${tail}`;
}

/**
 * Redact a network-buffer entry in place-free fashion: returns a shallow copy
 * with `url`, `requestHeaders` and `responseHeaders` scrubbed. Every other field
 * (`method`, `type`, `status`, timings, ...) is carried through untouched.
 * Pure. Convenience wrapper used by the tab-manager wiring.
 *
 * @param {object|null|undefined} entry - A per-request buffer entry.
 * @returns {object|*} Redacted copy, or the input unchanged when not an object.
 */
export function redactNetworkEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const out = { ...entry };
  if (typeof out.url === 'string') out.url = redactUrl(out.url);
  if (out.requestHeaders != null) out.requestHeaders = redactHeaders(out.requestHeaders);
  if (out.responseHeaders != null) out.responseHeaders = redactHeaders(out.responseHeaders);
  return out;
}
