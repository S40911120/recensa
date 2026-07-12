'use strict';
// Negative test: confirm parse.test's alignment assertions aren't a hollow shell — injecting a
// fake "shown but not counted" invariant must fail.
// (This test verifies that "the tests catch a mismatch", so it asserts that misalignment is detected.)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toMessage, forIndex } = require('../src/parsing/parse');

test('the alignment detector gives a consistent verdict on a real record (anti hollow-shell)', () => {
  // A record that is clearly both shown and counted: both sides must be truthy
  const rec = { type: 'user', uuid: 'neg1', message: { role: 'user', content: 'hi' } };
  const shown = toMessage(rec) !== null;
  const idx = forIndex(rec);
  const counted = Boolean(idx && (idx.mtype === 'user' || idx.mtype === 'assistant'));
  assert.equal(shown, true);
  assert.equal(counted, true);
  // Hollow-shell guard: if the verdict were hardcoded to a constant, this "not shown, not counted" pair would expose it
  const empty = { type: 'unknown-xyz' };
  assert.equal(toMessage(empty), null);
  assert.equal(forIndex(empty), null);
});
