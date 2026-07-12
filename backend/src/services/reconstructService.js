'use strict';
// Reconstructed view: the full pre-compaction conversation merged along the fork chain (delegates to the intel adapter's reconstruct + a local cache)
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('../config');
const { reconstruct } = require('../adapters/intel');

const CACHE_DIR = path.join(DATA_DIR, 'reconstruct');

/** A 4xx-class error (the route responds with this status code instead of falling through to 500) */
class ReconstructError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function cachePathFor(sessionId) {
  return path.join(CACHE_DIR, `${sessionId}.jsonl`);
}

// Concurrency dedup by id: in-flight generations share the same Promise (prevents spawning duplicate child processes and concurrent writes to the same file)
const inFlight = new Map();

async function generate(sessionRow, out) {
  // Write to a tmp file then rename for an atomic landing: readers never see a half-written file
  const tmp = `${out}.tmp.${process.pid}`;
  try {
    await reconstruct(sessionRow.file, tmp);
    if (!fs.existsSync(tmp)) throw new Error('reconstruct produced no file');
    fs.renameSync(tmp, out);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return out;
}

/** Ensure the reconstructed file exists and is not older than the source (regenerate if the source was updated); returns the cache path. Main sessions only. */
async function ensureReconstructed(sessionRow, { force = false } = {}) {
  if (sessionRow.kind !== 'main') {
    throw new ReconstructError(400, 'Reconstructed view is only available for main sessions');
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const out = cachePathFor(sessionRow.id);
  if (!force && fs.existsSync(out)) {
    const cacheM = fs.statSync(out).mtimeMs;
    let srcM = 0;
    try {
      srcM = fs.statSync(sessionRow.file).mtimeMs;
    } catch {
      // Source was deleted -> use the existing cache
    }
    if (cacheM >= srcM) return out;
  }
  let job = inFlight.get(sessionRow.id);
  if (!job) {
    job = generate(sessionRow, out).finally(() => inFlight.delete(sessionRow.id));
    inFlight.set(sessionRow.id, job);
  }
  return job;
}

module.exports = { ensureReconstructed, ReconstructError };
