// SafeWeb credential helpers.
//
// Two kinds of secrets flow through the system:
//   * Enrollment codes — short, human-typable, single-use codes a partner reads
//     to the person being protected to pair a device.
//   * Device tokens — long random bearer tokens a paired device sends with
//     every request. We store only a salted hash server-side.
//
// All comparisons that touch a secret are timing-safe.

import { createHmac, randomBytes, randomInt, timingSafeEqual, createHash } from 'node:crypto';

// Enrollment codes avoid ambiguous characters (0/O, 1/I/L) so they can be read
// aloud without confusion.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * Generate a grouped, human-friendly enrollment code, e.g. "K7P2-9QMR-3TXF".
 * @param {{ groups?: number, groupLen?: number }} [opts]
 */
export function generateEnrollmentCode({ groups = 3, groupLen = 4 } = {}) {
  const parts = [];
  for (let g = 0; g < groups; g++) {
    let part = '';
    for (let i = 0; i < groupLen; i++) {
      part += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
    }
    parts.push(part);
  }
  return parts.join('-');
}

/** Canonicalize a typed code: uppercase, strip spaces/dashes. */
export function normalizeCode(code) {
  return String(code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/**
 * Generate a device bearer token. Returned once to the device; the server
 * persists only `hashToken(token)`.
 */
export function generateDeviceToken() {
  return `swd_${randomBytes(32).toString('base64url')}`;
}

/**
 * Hash a token/secret for at-rest storage. Uses SHA-256 with an optional
 * pepper (a server-wide secret) so a leaked DB alone does not reveal tokens.
 * @param {string} token
 * @param {string} [pepper]
 */
export function hashToken(token, pepper = '') {
  return createHash('sha256').update(`${pepper}:${token}`).digest('hex');
}

/**
 * Constant-time string comparison that never throws on length mismatch.
 * @param {string} a
 * @param {string} b
 */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // Still do a comparison to keep timing roughly constant.
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

// ---------------------------------------------------------------------------
// Signed payloads (used for tamper-evident config revisions and SSE tickets).
// ---------------------------------------------------------------------------

/**
 * HMAC-sign a compact JSON payload. Returns "<base64url(json)>.<hex sig>".
 * @param {object} payload
 * @param {string} secret
 */
export function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('hex');
  return `${body}.${sig}`;
}

/**
 * Verify and decode a signed payload. Returns the payload object or null.
 * @param {string} token
 * @param {string} secret
 */
export function verify(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  if (!safeEqual(sig, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Password hashing for partner accounts (scrypt, dependency-free).
// ---------------------------------------------------------------------------
import { scryptSync } from 'node:crypto';

/** Hash a partner password. Returns "scrypt$<saltHex>$<hashHex>". */
export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/**
 * Verify a partner password against a stored "scrypt$salt$hash" string.
 * @param {string} password
 * @param {string} stored
 */
export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(String(password), salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Random opaque session id for partner cookies. */
export function generateSessionId() {
  return randomBytes(24).toString('base64url');
}
