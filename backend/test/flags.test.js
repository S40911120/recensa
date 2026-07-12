'use strict';
// Route-level input-validation test for PUT /api/session/:id/flags. A non-string custom_title/note must be rejected
// with a clean 400 BEFORE it reaches the node:sqlite bind (which would otherwise throw a TypeError -> uncaught 500),
// while null (the frontend's "clear" signal) and a valid string still succeed. Mounts only the flags router on a
// throwaway express app + hermetic DB so the test targets the body validation, not the security/CSRF gate.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

// config validates the projects dir at import (flags -> sessionRepo -> db -> config); point env at throwaway dirs
// BEFORE requiring the app graph so the DB never touches the real ~/.claude data.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recensa-flags-'));
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'recensa-flags-data-'));
process.env.RECENSA_PROJECTS_DIR = tmpRoot;
process.env.RECENSA_DATA_DIR = tmpData;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { open, close } = require('../src/storage/db');
const flagsRouter = require('../src/routes/flags');

const SESSION_ID = 'flags000-0000-0000-0000-000000000001';
let server;
let port;

before(async () => {
  // Seed one session row so getSession() returns a row and the request reaches the body validation.
  open()
    .prepare('INSERT INTO sessions (id, kind, project, file, forked_from) VALUES (?, ?, ?, ?, ?)')
    .run(SESSION_ID, 'main', 'proj', path.join(tmpRoot, `${SESSION_ID}.jsonl`), null);
  const app = express();
  app.use(express.json());
  app.use(flagsRouter);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(tmpData, { recursive: true, force: true });
});

function putFlags(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'PUT',
        path: `/api/session/${SESSION_ID}/flags`,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

test('a non-string custom_title is rejected with 400 (not an uncaught 500)', async () => {
  const res = await putFlags({ custom_title: { evil: true } });
  assert.equal(res.status, 400);
});

test('a non-string note is rejected with 400', async () => {
  const res = await putFlags({ note: ['not', 'a', 'string'] });
  assert.equal(res.status, 400);
});

test('null custom_title/note (the clear signal) still succeeds', async () => {
  const res = await putFlags({ custom_title: null, note: null });
  assert.equal(res.status, 200);
});

test('a valid string custom_title succeeds', async () => {
  const res = await putFlags({ custom_title: 'My renamed session' });
  assert.equal(res.status, 200);
});
