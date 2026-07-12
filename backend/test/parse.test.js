'use strict';
// msg_count alignment invariant (see SKILL.md): the toMessage "shown" set must stay in sync with
// the forIndex "counted" set. If someone adds a shown subtype to toMessage but forgets to sync
// forIndex, the paging total drifts while the smoke test still passes. These tests lock the invariant:
// for every record kind, "toMessage returns non-null" <=> "forIndex counts it in msgCount".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toMessage, countsAsMessage, forIndex, isInjectedText } = require('../src/parsing/parse');

/** Whether a forIndex result counts toward msg_count (mirrors indexer.aggregateLine's accumulation condition) */
function countsInMsgCount(idx) {
  if (!idx) return false;
  if (idx.summary || idx.aiTitle || idx.customTitle) return false; // title-type records are not counted
  return Boolean(idx.boundary || idx.systemMsg || idx.mtype === 'user' || idx.mtype === 'assistant');
}

/** Core invariant: shown <=> counted, and the cheap read-layer gate (countsAsMessage) is exactly "shown" */
function assertAligned(record, label) {
  const shown = toMessage(record) !== null;
  const counted = countsInMsgCount(forIndex(record));
  assert.equal(shown, counted, `${label}: toMessage shown=${shown} but forIndex counted=${counted} (msg_count alignment invariant broken)`);
  // countsAsMessage is the cheap predicate the read layer uses to advance the message index over discarded lines
  // without building the full message; it MUST equal "toMessage shows it", or paging counts drift on discarded prefixes.
  assert.equal(countsAsMessage(record), shown, `${label}: countsAsMessage=${countsAsMessage(record)} but toMessage shown=${shown} (cheap read-gate parity broken)`);
}

test('user / assistant message: shown and counted', () => {
  assertAligned({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } }, 'user');
  assertAligned({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'yo' }] } }, 'assistant');
});

test('compact_boundary: shown and counted', () => {
  assertAligned({ type: 'system', subtype: 'compact_boundary', uuid: 'b1', timestamp: '2026-01-01T00:00:00Z' }, 'boundary');
});

test('rendered system subtypes: shown and counted', () => {
  for (const subtype of ['stop_hook', 'api_error', 'away_summary', 'local_command', 'informational']) {
    assertAligned({ type: 'system', subtype, uuid: `s-${subtype}`, content: 'x', timestamp: '2026-01-01T00:00:00Z' }, `system/${subtype}`);
  }
});

test('unknown system subtype: neither shown nor counted', () => {
  assertAligned({ type: 'system', subtype: 'some_unknown_subtype_xyz', uuid: 's-unknown', content: 'x' }, 'system/unknown');
});

test('queue-operation enqueue (real user text): shown and counted; injected/remove are not', () => {
  assertAligned({ type: 'queue-operation', operation: 'enqueue', content: 'user queued message', timestamp: '2026-01-01T00:00:00Z' }, 'queue/enqueue');
  assertAligned({ type: 'queue-operation', operation: 'remove', content: 'x' }, 'queue/remove');
  // injected text (angle-bracket caveat templates) is not real user input and is not counted
  const injected = '<system-reminder>foo</system-reminder>';
  assert.ok(isInjectedText(injected), 'isInjectedText should treat system-reminder as injected');
  assertAligned({ type: 'queue-operation', operation: 'enqueue', content: injected }, 'queue/enqueue-injected');
});

test('title-type records (summary/ai-title/custom-title): neither shown nor counted', () => {
  assertAligned({ type: 'summary', summary: 'x' }, 'summary');
  assertAligned({ type: 'ai-title', aiTitle: 'x' }, 'ai-title');
  assertAligned({ type: 'custom-title', customTitle: 'x' }, 'custom-title');
});

test('malformed record: both null, no crash', () => {
  for (const bad of [null, undefined, {}, { type: 'unknown' }, 'not-an-object', 42]) {
    assert.doesNotThrow(() => { toMessage(bad); forIndex(bad); }, `malformed input ${JSON.stringify(bad)} should not throw`);
  }
});

test('deep-nested record: extractText cap keeps toMessage/forIndex from throwing while countsAsMessage agrees (throw-parity)', () => {
  // Nested tool_result content ~20000 deep. Before the extractText depth cap this made toMessage recurse and throw
  // RangeError (record dropped, index NOT advanced) while countsAsMessage returned true without recursing (index
  // advanced) -> the same record got different indices under different `from` -> reader-vs-reader paging drift.
  let node = 'leaf';
  for (let i = 0; i < 20000; i++) node = [{ type: 'tool_result', content: node }];
  const deep = { type: 'user', uuid: 'deep', message: { role: 'user', content: node } };
  assert.doesNotThrow(() => toMessage(deep), 'deep-nested toMessage must not throw after the depth cap');
  assert.doesNotThrow(() => forIndex(deep), 'deep-nested forIndex must not throw after the depth cap');
  // After the cap: toMessage non-null (shown), forIndex counts it, countsAsMessage true -- all three agree.
  assertAligned(deep, 'deep-nested user');
});
