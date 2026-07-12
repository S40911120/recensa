'use strict';
// Thin adapter over recensa-session (the single chokepoint to the session-JSONL toolkit): a resident worker pool + in-process require('@recensa/claude-session').
//   - Imported via require -> a single source for version management (a file: dependency / npm install inside the container), not a spawned child process.
//   - A worker thread keeps heavy work (reconstruct: restoring the full pre-compaction conversation along the fork chain) from freezing the main event loop (HTTP + WS).
//   - recensa-session's test/parity.test.js proves the output is byte-for-byte identical to the CLI `--json`.
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { INTEL_TIMEOUT_MS } = require('../config');

const WORKER_PATH = path.join(__dirname, 'claude-session-worker.js');
const POOL_SIZE = 2; // matches the original MAX_CONCURRENT: the viewer is single-user, so 2 is enough without hogging threads

let seq = 1;
const pending = new Map();  // id → { resolve, reject, timer, wIdx, cmd }
const queue = [];           // { task, resolve, reject } -- queued when all workers are busy
const workers = [];         // idx → { worker, busy }

function spawn(idx) {
  const worker = new Worker(WORKER_PATH);
  worker.on('message', (msg) => onMessage(idx, msg));
  worker.on('error', (err) => killWorker(idx, `recensa-session worker error: ${err.message}`));
  worker.on('exit', (code) => { if (code !== 0) killWorker(idx, `recensa-session worker exited (code ${code})`); });
  workers[idx] = { worker, busy: false };
}

function onMessage(idx, msg) {
  const p = pending.get(msg.id);
  if (!p) return; // already cleared by a timeout -> drop the late result
  clearTimeout(p.timer);
  pending.delete(msg.id);
  if (workers[idx]) workers[idx].busy = false;
  if (msg.ok) p.resolve(msg.result);
  else p.reject(new Error(`recensa-session ${p.cmd} failed: ${msg.error}`));
  drain();
}

// worker crash / exit / timeout -> terminate + reject its pending jobs + respawn (to keep the pool size)
function killWorker(idx, reason) {
  const slot = workers[idx];
  if (slot) { try { slot.worker.terminate(); } catch { /* already dead */ } }
  for (const [id, p] of pending) {
    if (p.wIdx === idx) { clearTimeout(p.timer); pending.delete(id); p.reject(new Error(reason)); }
  }
  spawn(idx);
  drain();
}

function drain() {
  while (queue.length) {
    const idx = workers.findIndex((w) => w && !w.busy);
    if (idx < 0) break;
    dispatch(idx, queue.shift());
  }
}

function dispatch(idx, job) {
  const id = seq++;
  workers[idx].busy = true;
  const timer = setTimeout(
    () => killWorker(idx, `recensa-session ${job.task.cmd} timeout (${INTEL_TIMEOUT_MS}ms)`),
    INTEL_TIMEOUT_MS,
  );
  pending.set(id, { resolve: job.resolve, reject: job.reject, timer, wIdx: idx, cmd: job.task.cmd });
  workers[idx].worker.postMessage({ id, ...job.task });
}

function exec(task) {
  return new Promise((resolve, reject) => {
    const job = { task, resolve, reject };
    const idx = workers.findIndex((w) => w && !w.busy);
    if (idx >= 0) dispatch(idx, job);
    else queue.push(job);
  });
}

for (let i = 0; i < POOL_SIZE; i++) spawn(i);

/** Restore the full pre-compaction conversation along the forkedFrom chain -> write clean jsonl to outPath (heavy work, run in a worker so it does not freeze the main loop) */
async function reconstruct(file, outPath) {
  await exec({ cmd: 'reconstruct', file, outPath });
}

module.exports = { reconstruct };
