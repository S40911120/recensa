'use strict';
// Corruption recovery: a malformed/garbage viewer.db (WAL corruption after a docker kill / power loss) must not brick
// startup. open() detects the corruption, deletes ONLY the disposable viewer.db (+ its sidecars), and rebuilds from
// scratch -- while flags.db (precious, non-recomputable pins/tags/notes) is preserved untouched (the headline README
// promise that "index rebuilds never touch flags.db").
//
// Point the data dir at a hermetic temp dir BEFORE requiring the module (DB_PATH/FLAGS_DB_PATH derive from DATA_DIR at
// load), so the real ~/.claude data is never involved. RECENSA_PROJECTS_DIR must also be a real dir (config validates it).
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const tmpProjects = fs.mkdtempSync(path.join(os.tmpdir(), 'recensa-db-proj-'));
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'recensa-db-data-'));
process.env.RECENSA_PROJECTS_DIR = tmpProjects;
process.env.RECENSA_DATA_DIR = tmpData;

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { open, close, DB_PATH } = require('../src/storage/db');

const FLAGS_DB_PATH = path.join(tmpData, 'flags.db');

after(() => {
  close();
  fs.rmSync(tmpProjects, { recursive: true, force: true });
  fs.rmSync(tmpData, { recursive: true, force: true });
});

test('a corrupt viewer.db is deleted + rebuilt on open, and flags.db (precious) survives', () => {
  // 1. A first open creates a valid viewer.db + flags.db; drop a sentinel into flags.db to prove it is never wiped.
  const db1 = open();
  db1.exec("INSERT INTO flagsdb.user_settings (key, value) VALUES ('theme', 'sentinel-dark')");
  close();
  assert.equal(fs.existsSync(DB_PATH), true, 'viewer.db exists after the first open');
  assert.equal(fs.existsSync(FLAGS_DB_PATH), true, 'flags.db exists after the first open');

  // 2. Simulate corruption: clear any stale sidecars, then overwrite viewer.db with garbage
  //    (its header is no longer a valid SQLite file -> "file is not a database" on the next open).
  for (const sfx of ['-wal', '-shm', '-journal']) fs.rmSync(DB_PATH + sfx, { force: true });
  fs.writeFileSync(DB_PATH, 'not a sqlite database — corrupt WAL / torn write');

  // 3. Reopen: must detect the corruption, delete only viewer.db, rebuild, and hand back a working connection.
  const db2 = open();
  const sessions = db2.prepare('SELECT COUNT(*) AS n FROM sessions').get();
  assert.equal(sessions.n, 0, 'the rebuilt index is a working, empty sessions table');

  // 4. Red line: flags.db was NOT deleted and its sentinel survived the index rebuild.
  assert.equal(fs.existsSync(FLAGS_DB_PATH), true, 'flags.db is still on disk after the rebuild');
  const flag = db2.prepare("SELECT value FROM flagsdb.user_settings WHERE key = 'theme'").get();
  assert.equal(flag?.value, 'sentinel-dark', 'flags.db content is preserved across an index rebuild');
});
