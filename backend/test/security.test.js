'use strict';
// Request-gate tests for the DNS-rebinding + CSRF allowlist (security.isAllowedRequest).
// Negative test for the hardening: a mutating request (POST/PUT/DELETE/PATCH) with NO Origin must be rejected, while
// the same-origin case (allowlisted Origin present, as a modern browser always sends) must pass -- so the UI's own
// writes keep working while a cross-site write that cannot forge Origin is blocked.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isAllowedHost, isAllowedRequest } = require('../src/security');

const GOOD_HOST = '127.0.0.1:7788';
const GOOD_ORIGIN = 'http://localhost:5178'; // hostname `localhost` is on the allowlist (covers the vite dev proxy)
const BAD_ORIGIN = 'http://evil.example.com';

test('safe methods (GET/HEAD): Origin may be omitted', () => {
  for (const method of ['GET', 'HEAD', 'get']) {
    assert.equal(isAllowedRequest({ host: GOOD_HOST, method }), true, `${method} with no Origin should pass`);
    assert.equal(isAllowedRequest({ host: GOOD_HOST, origin: GOOD_ORIGIN, method }), true, `${method} with good Origin should pass`);
  }
});

test('mutating methods with NO Origin are rejected (the F2 hardening)', () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'delete']) {
    assert.equal(isAllowedRequest({ host: GOOD_HOST, method }), false, `${method} without Origin must be rejected`);
  }
});

test('mutating methods with a correct same-origin Origin are allowed (UI writes keep working)', () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    assert.equal(isAllowedRequest({ host: GOOD_HOST, origin: GOOD_ORIGIN, method }), true, `${method} with good Origin must pass`);
  }
});

test('an off-allowlist Origin is rejected on every method', () => {
  for (const method of ['GET', 'POST', 'DELETE']) {
    assert.equal(isAllowedRequest({ host: GOOD_HOST, origin: BAD_ORIGIN, method }), false, `${method} with a foreign Origin must be rejected`);
  }
});

test('a missing or off-allowlist Host is rejected regardless of method/Origin', () => {
  assert.equal(isAllowedRequest({ origin: GOOD_ORIGIN, method: 'GET' }), false, 'missing Host must be rejected');
  assert.equal(isAllowedRequest({ host: 'evil.example.com', origin: GOOD_ORIGIN, method: 'GET' }), false, 'foreign Host must be rejected');
});

test('method defaults to a safe GET when absent (Origin stays optional)', () => {
  assert.equal(isAllowedRequest({ host: GOOD_HOST }), true, 'no method -> treated as GET -> Origin optional');
});

test('isAllowedHost primitive: allowMissing governs the empty case; the port is ignored', () => {
  assert.equal(isAllowedHost(undefined), false);
  assert.equal(isAllowedHost(undefined, { allowMissing: true }), true);
  assert.equal(isAllowedHost('localhost:9999'), true); // port irrelevant to the hostname allowlist
  assert.equal(isAllowedHost('http://127.0.0.1:5178'), true);
  assert.equal(isAllowedHost('[::1]:7788'), true); // IPv6 loopback: url.hostname is the bracketed form [::1]
  assert.equal(isAllowedHost('http://attacker.test'), false);
});
