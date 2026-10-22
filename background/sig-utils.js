/**
 * Payload signing + token comparison helpers (v21 security hardening).
 *
 * Replaces the placeholder "signature is non-empty" checks in the UAP server
 * and the federation layer with real HMAC-SHA256 over a canonical JSON form,
 * and gives authenticate() a constant-time string compare so shared tokens
 * cannot be probed byte by byte.
 *
 * Web Crypto is available in MV3 service workers, extension pages and Node
 * 20+ (jest). When it is missing the verify helpers fail closed.
 *
 * @module background/sig-utils
 */

const SIGNATURE_FIELD = 'signature';

/**
 * Deterministic JSON: object keys sorted recursively, top-level `signature`
 * removed, undefined values dropped (like JSON.stringify does).
 */
export function canonicalize(value, _top = true) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value === undefined ? null : value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalize(v, false)).join(',') + ']';
  }
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined && !(_top && k === SIGNATURE_FIELD))
    .sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k], false)).join(',') + '}';
}

function _subtle() {
  const c = (typeof globalThis !== 'undefined' && globalThis.crypto) || null;
  return c && c.subtle ? c.subtle : null;
}

function _bytes(str) {
  return new TextEncoder().encode(String(str));
}

function _hex(buf) {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * HMAC-SHA256(secret, message) as lowercase hex. Resolves to '' when Web
 * Crypto is unavailable so callers fail closed.
 */
export async function hmacHex(secret, message) {
  const subtle = _subtle();
  if (!subtle || !secret) return '';
  try {
    const key = await subtle.importKey('raw', _bytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await subtle.sign('HMAC', key, _bytes(message));
    return _hex(sig);
  } catch (_e) {
    return '';
  }
}

/** Constant-time comparison of two strings (length leak only). */
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = _bytes(a);
  const bb = _bytes(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

/** Sign a payload object: HMAC over its canonical form (minus `signature`). */
export async function signPayload(secret, payload) {
  return hmacHex(secret, canonicalize(payload || {}));
}

/**
 * Verify `signature` against the payload. Fails closed when the secret is
 * unset, the signature is missing/malformed, or Web Crypto is unavailable.
 */
export async function verifyPayload(secret, payload, signature) {
  if (!secret || typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = await signPayload(secret, payload);
  if (!expected) return false;
  return timingSafeEqual(expected, signature.toLowerCase());
}

// ── Minimal HS256 JWT verification ───────────────────────────────────────

function _b64urlDecode(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
}

function _b64urlFromBytes(buf) {
  let bin = '';
  const arr = new Uint8Array(buf);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Verify an HS256 JWT: structure, signature (when `secret` is given) and
 * `exp`. Returns the decoded payload or null. Without a secret the token is
 * rejected — an unsigned claim is not authentication.
 */
export async function verifyJwtHs256(token, secret, nowSec = Date.now() / 1000) {
  if (typeof token !== 'string' || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header = JSON.parse(_b64urlDecode(parts[0]));
    payload = JSON.parse(_b64urlDecode(parts[1]));
  } catch (_e) {
    return null;
  }
  if (!header || header.alg !== 'HS256') return null;
  const subtle = _subtle();
  if (!subtle) return null;
  try {
    const key = await subtle.importKey('raw', _bytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await subtle.sign('HMAC', key, _bytes(parts[0] + '.' + parts[1]));
    if (!timingSafeEqual(_b64urlFromBytes(sig), parts[2])) return null;
  } catch (_e) {
    return null;
  }
  if (typeof payload.exp !== 'number' || !(payload.exp > nowSec)) return null;
  return payload;
}

/** Test/tooling helper: mint an HS256 JWT. */
export async function signJwtHs256(payload, secret) {
  const enc = (obj) => _b64urlFromBytes(_bytes(JSON.stringify(obj)));
  const head = enc({ alg: 'HS256', typ: 'JWT' });
  const body = enc(payload);
  const subtle = _subtle();
  const key = await subtle.importKey('raw', _bytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await subtle.sign('HMAC', key, _bytes(head + '.' + body));
  return head + '.' + body + '.' + _b64urlFromBytes(sig);
}
