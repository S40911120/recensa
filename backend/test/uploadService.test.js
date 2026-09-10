'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUploadStem, makeStoredFilename } = require('../src/services/uploadNaming');

test('upload filenames are reduced to safe jsonl names without accepting path traversal', () => {
  assert.equal(normalizeUploadStem('../../my session.JSONL'), 'my-session');
  assert.equal(makeStoredFilename('../../my session.JSONL', 'fixed-id'), 'my-session-fixed-id.jsonl');
  assert.throws(() => makeStoredFilename('transcript.txt', 'fixed-id'), /\.jsonl/i);
});
