'use strict';
// Path-containment guard for deleteSession's recursive+force rmSync of the subagents directory.
// A pathologically-named indexed row (an id resolving to `..`, embedding a separator, or landing on a real dir outside
// the projects root) must be refused BEFORE the recursive delete runs, or rmSync could wipe data outside PROJECTS_DIR.
// This drives the pure resolveSubagentDir helper directly: a normal id returns the exact <projectDir>/<id> path and a
// real rmSync of it removes only that dir; an escaping id throws (so deleteSession returns an error and deletes nothing).

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// config validates the projects dir at import (sessionRepo -> db -> config); point it at a real temp dir BEFORE
// requiring the module so the guard's PROJECTS_DIR is this hermetic root, independent of the machine's ~/.claude/projects.
// RECENSA_DATA_DIR points viewer.db/flags.db at a throwaway dir too, so the deleteSession tests below (which open the DB)
// never touch the real ~/.claude data.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recensa-repo-'));
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'recensa-repo-data-'));
process.env.RECENSA_PROJECTS_DIR = tmpRoot;
process.env.RECENSA_DATA_DIR = tmpData;

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { open, close } = require('../src/storage/db');
const { resolveSubagentDir, deleteSession, upsertFlags } = require('../src/repositories/sessionRepo');

after(() => {
  close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(tmpData, { recursive: true, force: true });
});

const PROJECT = 'proj-x';
const projectDir = path.join(tmpRoot, PROJECT);

test('a normal id resolves to <projectDir>/<id> strictly inside the projects root', () => {
  const id = '444440b0-1111-2222-3333-abcdefabcdef';
  const mainFile = path.join(projectDir, `${id}.jsonl`);
  assert.equal(resolveSubagentDir(mainFile, id), path.join(projectDir, id));
});

test('a normal delete still works: rmSync of the resolved dir removes only it', () => {
  const id = 'aaaa1111-bbbb-2222-cccc-333344445555';
  const mainFile = path.join(projectDir, `${id}.jsonl`);
  const subDir = path.join(projectDir, id);
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, 'agent.jsonl'), 'x', 'utf8');
  const sibling = path.join(projectDir, 'unrelated'); // inside root, must survive an unrelated delete
  fs.mkdirSync(sibling, { recursive: true });

  const resolved = resolveSubagentDir(mainFile, id);
  fs.rmSync(resolved, { recursive: true, force: true });
  assert.equal(fs.existsSync(subDir), false, 'the subagents dir is deleted');
  assert.equal(fs.existsSync(sibling), true, 'an unrelated sibling is untouched');
});

test('an id that escapes the projects root is refused (nothing outside is ever targeted)', () => {
  // A real victim dir OUTSIDE the projects root; a naive path.join(dirname, id) would climb out and hit it.
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recensa-outside-'));
  const victim = path.join(outsideRoot, 'victim');
  fs.mkdirSync(victim, { recursive: true });
  try {
    const mainFile = path.join(projectDir, 'x.jsonl');
    const escapers = [
      '../../victim',                                             // climbs out of the projects root
      path.join('..', '..', path.basename(outsideRoot), 'victim'), // resolves EXACTLY onto the outside victim dir
      `${PROJECT}/nested`,                                        // embeds a separator (a separator on both platforms) -> basename !== id
    ];
    for (const evil of escapers) {
      assert.throws(() => resolveSubagentDir(mainFile, evil), /projects root/i, `must refuse id=${JSON.stringify(evil)}`);
    }
    // The guard only validates; because every escaper threw, deleteSession never reaches rmSync -> the victim is intact.
    assert.equal(fs.existsSync(victim), true, 'nothing outside the projects root was deleted');
  } finally {
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test('the projects root itself is not an allowed target (resolved === PROJECTS_DIR is refused)', () => {
  // dirname(mainFile) is the projects root and id `..` climbs to it -> a bare-root recursive wipe must be refused.
  const mainFile = path.join(projectDir, 'x.jsonl'); // dirname = projectDir; `..` -> tmpRoot (the projects root)
  assert.throws(() => resolveSubagentDir(mainFile, '..'), /projects root/i);
});

// deleteSession is the only irreversible write in an otherwise read-only tool, so its three refusal guards are a headline
// README promise. Drive them end-to-end against a hermetic DB. insertSession seeds a row directly (writes normally live in
// the indexer); only id/kind/project/file/forked_from are needed (the rest of the columns default).
function insertSession(d, { id, kind = 'main', file, forkedFrom = null }) {
  d.prepare('INSERT INTO sessions (id, kind, project, file, forked_from) VALUES (?, ?, ?, ?, ?)')
    .run(id, kind, PROJECT, file, forkedFrom);
}

test('deleteSession refuses a subagent record (it belongs to its main session)', () => {
  const d = open();
  const id = 'sub00000-0000-0000-0000-000000000001';
  insertSession(d, { id, kind: 'subagent', file: path.join(projectDir, `${id}.jsonl`) });
  const res = deleteSession(id);
  assert.equal(res.ok, false);
  assert.equal(res.code, 400);
});

test('deleteSession refuses a member of a fork/resume chain', () => {
  const d = open();
  const parent = 'aaaa0001-0000-0000-0000-000000000000';
  const child = 'bbbb0002-0000-0000-0000-000000000000';
  insertSession(d, { id: parent, file: path.join(projectDir, `${parent}.jsonl`) });
  insertSession(d, { id: child, file: path.join(projectDir, `${child}.jsonl`), forkedFrom: parent });
  const res = deleteSession(parent); // parent has a downstream fork branch (child) -> refused
  assert.equal(res.ok, false);
  assert.equal(res.code, 409);
});

test('deleteSession refuses a pinned session', () => {
  const d = open();
  const id = 'cccc0003-0000-0000-0000-000000000000';
  insertSession(d, { id, file: path.join(projectDir, `${id}.jsonl`) });
  upsertFlags(id, { pinned: true });
  const res = deleteSession(id);
  assert.equal(res.ok, false);
  assert.equal(res.code, 409);
});

test('deleteSession succeeds for an unpinned, chain-free main session (files removed, ids returned)', () => {
  const d = open();
  const id = 'dddd0004-0000-0000-0000-000000000000';
  const file = path.join(projectDir, `${id}.jsonl`);
  const subDir = path.join(projectDir, id);
  fs.mkdirSync(subDir, { recursive: true }); // also creates projectDir
  fs.writeFileSync(file, '{}\n', 'utf8');
  fs.writeFileSync(path.join(subDir, 'agent.jsonl'), 'x', 'utf8');
  insertSession(d, { id, file });

  const res = deleteSession(id);
  assert.equal(res.ok, true);
  assert.deepEqual(res.ids, [id]);
  assert.equal(fs.existsSync(file), false, 'the main jsonl is deleted');
  assert.equal(fs.existsSync(subDir), false, 'the subagents dir is deleted');
});
