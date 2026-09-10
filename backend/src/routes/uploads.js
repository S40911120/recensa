'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const Busboy = require('busboy');
const { PROJECTS_DIR } = require('../config');
const indexService = require('../services/indexService');
const repo = require('../repositories/sessionRepo');
const { makeStoredFilename } = require('../services/uploadNaming');
const log = require('../log').scope('uploads');

const UPLOAD_PROJECT = 'uploads';
const UPLOAD_DIR = path.join(PROJECTS_DIR, UPLOAD_PROJECT);
const MAX_UPLOAD_BYTES = Number(process.env.RECENSA_MAX_UPLOAD_BYTES || 256 * 1024 * 1024);

class UploadError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function waitForIndexed(sessionId, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      try {
        if (repo.getSession(sessionId)) return resolve(true);
      } catch {
        // The worker may be committing the row; keep polling until the deadline.
      }
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(check, 100);
    };
    check();
  });
}

async function removeIfPresent(filePath) {
  if (!filePath) return;
  try { await fsp.rm(filePath, { force: true }); } catch { /* best-effort cleanup */ }
}

function parseUpload(req) {
  return new Promise((resolve, reject) => {
    let parser;
    try {
      parser = Busboy({
        headers: req.headers,
        limits: { files: 1, fileSize: MAX_UPLOAD_BYTES },
      });
    } catch {
      reject(new UploadError(400, 'Expected a multipart file upload'));
      return;
    }

    let fileSeen = false;
    let parseError = null;
    let writeTask = null;
    let result = null;

    const fail = (err) => { if (!parseError) parseError = err; };

    parser.on('file', (fieldName, file, info) => {
      if (fieldName !== 'file' || fileSeen) {
        file.resume();
        fail(new UploadError(400, 'Upload exactly one file in the file field'));
        return;
      }
      fileSeen = true;

      let storedFilename;
      try {
        storedFilename = makeStoredFilename(info.filename, randomUUID());
      } catch (err) {
        file.resume();
        fail(new UploadError(400, err.message));
        return;
      }

      const temporaryPath = path.join(UPLOAD_DIR, `.upload-${randomUUID()}.part`);
      const destination = path.join(UPLOAD_DIR, storedFilename);
      const output = fs.createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 });
      writeTask = pipeline(file, output).then(async () => {
        if (file.truncated) throw new UploadError(413, 'File is too large (maximum 256 MB)');
        await fsp.rename(temporaryPath, destination);
        result = {
          destination,
          sessionId: storedFilename.slice(0, -'.jsonl'.length),
          originalFilename: path.basename(String(info.filename || storedFilename)),
        };
      }).catch(async (err) => {
        await removeIfPresent(temporaryPath);
        throw err;
      });
    });

    parser.on('filesLimit', () => fail(new UploadError(400, 'Upload exactly one file')));
    parser.on('error', reject);
    parser.on('finish', async () => {
      try {
        if (writeTask) await writeTask;
        if (parseError) throw parseError;
        if (!result) throw new UploadError(400, 'Choose a .jsonl file');
        resolve(result);
      } catch (err) {
        await removeIfPresent(result?.destination);
        reject(err);
      }
    });

    req.pipe(parser);
  });
}

async function handleUpload(req, res) {
  try {
    await fsp.mkdir(UPLOAD_DIR, { recursive: true });
    const uploaded = await parseUpload(req);
    indexService.ingestPath(uploaded.destination);
    const indexed = await waitForIndexed(uploaded.sessionId);
    res.status(indexed ? 201 : 202).json({
      sessionId: uploaded.sessionId,
      filename: uploaded.originalFilename,
      project: UPLOAD_PROJECT,
      indexed,
    });
  } catch (err) {
    const status = err instanceof UploadError ? err.status : 500;
    if (status >= 500) log.error(`upload failed: ${err?.message || err}`);
    res.status(status).json({ error: status >= 500 ? 'Upload failed' : err.message });
  }
}

module.exports = require('express').Router().post('/api/upload', handleUpload);
