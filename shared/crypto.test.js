import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateEnrollmentCode,
  normalizeCode,
  generateDeviceToken,
  hashToken,
  safeEqual,
  sign,
  verify,
  hashPassword,
  verifyPassword,
  generateSessionId,
} from './crypto.js';

test('enrollment codes are grouped and readable', () => {
  const code = generateEnrollmentCode();
  assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  // Avoids ambiguous characters.
  assert.ok(!/[01OIL]/.test(code.replace(/-/g, '')));
});

test('normalizeCode strips separators and uppercases', () => {
  assert.equal(normalizeCode('k7p2-9qmr'), 'K7P29QMR');
  assert.equal(normalizeCode('  k 7 p 2 '), 'K7P2');
});

test('device tokens are prefixed and unique', () => {
  const a = generateDeviceToken();
  const b = generateDeviceToken();
  assert.ok(a.startsWith('swd_'));
  assert.notEqual(a, b);
});

test('hashToken is stable and pepper-sensitive', () => {
  assert.equal(hashToken('abc', 'p'), hashToken('abc', 'p'));
  assert.notEqual(hashToken('abc', 'p1'), hashToken('abc', 'p2'));
});

test('safeEqual compares without throwing on length mismatch', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('abc', 'abd'), false);
});

test('sign/verify round-trips and rejects tampering', () => {
  const secret = 'server-secret';
  const token = sign({ deviceId: 'd1', rev: 3 }, secret);
  const payload = verify(token, secret);
  assert.equal(payload.deviceId, 'd1');
  assert.equal(payload.rev, 3);
  assert.equal(verify(token, 'wrong-secret'), null);
  assert.equal(verify(token + 'x', secret), null);
  assert.equal(verify('garbage', secret), null);
});

test('password hashing verifies correctly and rejects wrong password', () => {
  const stored = hashPassword('correct horse');
  assert.ok(stored.startsWith('scrypt$'));
  assert.equal(verifyPassword('correct horse', stored), true);
  assert.equal(verifyPassword('wrong', stored), false);
  assert.equal(verifyPassword('x', 'malformed'), false);
});

test('session ids are unique and url-safe', () => {
  const a = generateSessionId();
  const b = generateSessionId();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
});
