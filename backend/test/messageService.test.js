'use strict';
// End-to-end paging / byte-checkpoint parity for the message read layer (messageService).
//
// parse.test's countsAsMessage<=>toMessage invariant proves the *count* stays aligned, but it cannot catch a byte
// off-by-one in the incremental cursor: a checkpoint stores "byte offset where message N starts", and a read that
// resumes from a wrong byte would parse the wrong line at index N without changing any count. This test drives a
// synthetic session whose message stream crosses CHECKPOINT_EVERY (500) several times, then asserts every paged /
// tail read deep-equals the corresponding slice of a single full read -- a misaligned checkpoint fails the deepEqual.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// config validates the projects dir at import (via messageService -> sessionRepo -> db -> config); point it at a real,
// existing temp dir BEFORE requiring the service so the test is hermetic (independent of the machine's ~/.claude/projects).
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recensa-msvc-'));
process.env.RECENSA_PROJECTS_DIR = tmpRoot;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { readMessages, readTail } = require('../src/services/messageService');

const TOTAL = 2300; // counted messages -> crosses CHECKPOINT_EVERY (500) at index 500 / 1000 / 1500 / 2000

/** Build a deterministic jsonl session with TOTAL counted messages (uuid m0..m{TOTAL-1}), interleaving non-counted
 *  noise (a title record + a blank line) so byte offset is not a constant multiple of the message index -- exactly
 *  the condition under which a byte-checkpoint off-by-one surfaces. LF line endings, no BOM. */
function buildFixture(total) {
  const lines = [];
  for (let n = 0; n < total; n++) {
    if (n % 13 === 0) {
      lines.push(JSON.stringify({ type: 'summary', summary: `title-${n}` })); // title record: not shown, not counted
      lines.push(''); // blank line: skipped by the reader's !line.trim()
    }
    const rec = n % 2 === 0
      ? { type: 'user', uuid: `m${n}`, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: `hello ${n}` } }
      : { type: 'assistant', uuid: `m${n}`, timestamp: '2026-01-01T00:00:00Z', message: { role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: `reply ${n}` }] } };
    lines.push(JSON.stringify(rec));
  }
  return lines.join('\n') + '\n';
}

let file;
let full; // canonical full ordered read -> ground truth for every slice comparison below

before(async () => {
  file = path.join(tmpRoot, 'session.jsonl');
  fs.writeFileSync(file, buildFixture(TOTAL), 'utf8');
  // Read the whole file first: this populates the byte checkpoints, so the paged reads below genuinely *resume from a
  // checkpoint* (checkpointBefore) instead of always scanning from byte 0 -- i.e. it exercises the code path under test.
  const r = await readMessages(file, 0, TOTAL);
  full = r.messages;
});

after(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

test('full read yields every counted message in order (ground truth is well-formed)', () => {
  assert.equal(full.length, TOTAL);
  assert.equal(full[0].uuid, 'm0');
  assert.equal(full[TOTAL - 1].uuid, `m${TOTAL - 1}`);
  // noise (title/blank) must not have leaked into the message stream
  assert.ok(full.every((m) => m.type === 'user' || m.type === 'assistant'));
});

test('paged reads crossing a CHECKPOINT_EVERY boundary deep-equal the full-read slice', async () => {
  // Each window straddles or lands on a 500-checkpoint; a wrong checkpoint byte misaligns the resumed index -> fail here.
  const windows = [
    [480, 60],   // crosses 500
    [990, 40],   // crosses 1000
    [1490, 20],  // crosses 1500
    [1990, 30],  // crosses 2000
    [1000, 25],  // starts exactly on a checkpoint
    [1237, 111], // arbitrary offset, resumes from the 1000 checkpoint and skip-counts forward
  ];
  for (const [from, limit] of windows) {
    const page = await readMessages(file, from, limit);
    assert.deepEqual(page.messages, full.slice(from, from + limit), `page [${from}, ${from + limit}) content mismatch`);
    assert.equal(page.hasMore, from + limit < TOTAL, `hasMore wrong for [${from}, ${limit}]`);
  }
});

test('a page at the tail returns fewer than limit and reports no more', async () => {
  const page = await readMessages(file, TOTAL - 10, 50);
  assert.deepEqual(page.messages, full.slice(TOTAL - 10));
  assert.equal(page.messages.length, 10);
  assert.equal(page.hasMore, false);
});

test('a page at or past the high-water mark is empty', async () => {
  const page = await readMessages(file, TOTAL, 50);
  assert.deepEqual(page.messages, []);
  assert.equal(page.hasMore, false);
});

test('readTail equals the true tail slice (tail starts past a checkpoint)', async () => {
  const limit = 50; // tail starts at 2250 -> resumes from the 2000 checkpoint
  const tail = await readTail(file, limit);
  assert.equal(tail.startIndex, TOTAL - limit);
  assert.equal(tail.messages.length, limit);
  assert.deepEqual(tail.messages, full.slice(TOTAL - limit));
});

test('readTail with a limit larger than the total returns the whole conversation from index 0', async () => {
  const tail = await readTail(file, TOTAL + 100);
  assert.equal(tail.startIndex, 0);
  assert.deepEqual(tail.messages, full);
});

test('a single message whose JSONL line spans many read-stream chunks is reassembled byte-intact', async () => {
  // fs.createReadStream delivers ~64KB chunks; a ~640KB line therefore spans ~10 chunks and exercises the multi-chunk
  // carry-accumulation path (accumulate an array of buffers, concat once at the newline -- the O(L^2)->O(L) rewrite).
  // `big` is an independent ground truth: a dropped/duplicated byte in the reassembly would change its length (or
  // corrupt the JSON and drop the record), and a wrong byte offset would misalign the resumed reads below.
  const big = 'B'.repeat(640 * 1024); // >10x the 64KB stream highWaterMark, no newline inside -> accumulates across chunks
  const recs = [
    { type: 'user', uuid: 'g0', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'before the giant line' } },
    { type: 'user', uuid: 'g1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: big } },
    { type: 'assistant', uuid: 'g2', timestamp: '2026-01-01T00:00:00Z', message: { role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'after' }] } },
  ];
  const gfile = path.join(tmpRoot, 'giant.jsonl');
  fs.writeFileSync(gfile, recs.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  const whole = (await readMessages(gfile, 0, 100)).messages; // reads the giant line across many chunks + builds checkpoints
  assert.equal(whole.length, 3, 'the giant line parsed into a valid record (reassembly did not corrupt/drop it)');
  assert.deepEqual(whole.map((m) => m.uuid), ['g0', 'g1', 'g2']);
  assert.equal(whole[1].blocks[0].text.length, big.length, 'giant string length preserved byte-for-byte across chunk boundaries');
  assert.equal(whole[1].blocks[0].text, big, 'giant string content preserved exactly');
  // Offset accounting intact: a page and a tail that resume past the giant line match the corresponding full-read slice.
  assert.deepEqual((await readMessages(gfile, 1, 2)).messages, whole.slice(1, 3));
  assert.deepEqual((await readTail(gfile, 2)).messages, whole.slice(1));
});
