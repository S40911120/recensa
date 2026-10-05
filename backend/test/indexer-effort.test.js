'use strict';
// Reasoning-effort aggregation through the real indexer: a full read records the latest effort plus the set of
// every effort used, and an incremental append (byte-offset slice) unions effort_names in SQL instead of
// overwriting it. Hermetic: projects root and data dir are throwaway temp dirs set BEFORE requiring the modules.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recensa-effort-'));
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'recensa-effort-data-'));
process.env.RECENSA_PROJECTS_DIR = tmpRoot;
process.env.RECENSA_DATA_DIR = tmpData;

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { open, close } = require('../src/storage/db');
const { sync } = require('../src/ingestion/indexer');
const { toSessionDto } = require('../src/repositories/sessionMappers');

after(() => {
  close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(tmpData, { recursive: true, force: true });
});

const SID = '55555555-aaaa-bbbb-cccc-dddddddddddd';
const file = path.join(tmpRoot, 'proj-effort', `${SID}.jsonl`);
fs.mkdirSync(path.dirname(file), { recursive: true });

let n = 0;
function assistant(model, effort) {
  n++;
  return JSON.stringify({
    type: 'assistant', uuid: `a${n}`, sessionId: SID, timestamp: `2026-10-01T00:00:0${n}Z`,
    effort, perTurnEffort: effort,
    message: { role: 'assistant', model, content: [{ type: 'text', text: `reply ${n}` }] },
  }) + '\n';
}

const row = () => toSessionDto(open().prepare('SELECT * FROM sessions WHERE id = ?').get(SID));

test('full read: latest effort wins, every effort used is collected, <synthetic> is ignored', () => {
  fs.writeFileSync(file, assistant('claude-opus-5-5', 'high') + assistant('claude-opus-5-5', 'xhigh') + assistant('<synthetic>', 'low'));
  sync();
  const s = row();
  assert.equal(s.effort, 'xhigh');
  assert.deepEqual([...s.efforts].sort(), ['high', 'xhigh']);
});

test('incremental append: effort_names is unioned with the earlier slice, effort follows the newest turn', () => {
  fs.appendFileSync(file, assistant('claude-opus-5-5', 'max'));
  sync();
  const s = row();
  assert.equal(s.effort, 'max');
  assert.deepEqual([...s.efforts].sort(), ['high', 'max', 'xhigh']);
});

test('a turn without effort (model lacks the setting) keeps the last known effort', () => {
  fs.appendFileSync(file, assistant('claude-haiku-4-5-20251001', null));
  sync();
  const s = row();
  assert.equal(s.effort, 'max');
  assert.deepEqual([...s.efforts].sort(), ['high', 'max', 'xhigh']);
});
