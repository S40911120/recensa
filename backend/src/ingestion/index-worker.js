'use strict';
// index worker: the sole writer of viewer.db (both re-parsing and persistence run on this thread) -> the main thread (HTTP/WS) never freezes on indexing.
// The DB uses WAL: this worker writes, the main thread reads, safely in parallel. Jobs are processed serially (a single writer never interleaves).
// Migrations run on the main thread's open() before this worker is spawned; the CREATE IF NOT EXISTS / ALTER in open() here are all idempotent no-ops.
const { parentPort } = require('node:worker_threads');
const indexer = require('./indexer');

require('../storage/db').open({ migrate: false }); // this thread has its own DB connection (connection mode: the main thread migrated before spawning, so no DDL runs here)

let busy = false;
const queue = [];

function enqueue(job) { queue.push(job); pump(); }

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) await handle(queue.shift());
  } finally {
    busy = false;
  }
}

// live-tail (one) / delete (delete-index) are high priority: when the full scan (~12s) yields, these are pulled out of the queue and handled first,
// so the hot tick does not have to wait behind the 12s full scan (cooperative cut-in within a single worker, not a parallel writer -> the single-writer / WAL safety is preserved).
const URGENT = new Set(['one', 'delete-index']);
async function drainUrgent() {
  const urgent = [];
  for (let i = 0; i < queue.length;) {
    if (URGENT.has(queue[i].type)) urgent.push(queue.splice(i, 1)[0]);
    else i++;
  }
  for (const j of urgent) await handle(j);
}

async function handle(job) {
  try {
    if (job.type === 'sync') {
      const t0 = Date.now();
      parentPort.postMessage({ event: 'sync-start' });
      // Deletion reconciliation folded into syncAsync's single directory walk (the reconcile flag controls frequency) -> no separate existsSync pass
      const res = await indexer.syncAsync({
        onProgress: (done, total) => parentPort.postMessage({ event: 'progress', done, total }),
        reconcile: job.reconcile,
        onYield: drainUrgent, // cut in with live-tail/delete work when the full scan yields -> the 12s full scan does not block the hot tick
      });
      parentPort.postMessage({ event: 'sync-done', total: res.total, changed: res.changed, changedFiles: res.changedFiles || [], removed: res.removed || [], ms: Date.now() - t0 });
    } else if (job.type === 'delete-index') {
      // deleteSession's viewer.db cleanup (serialized by the single writer, so it does not collide with deletion reconciliation)
      indexer.removeIndexByIds(job.ids);
      parentPort.postMessage({ event: 'removed', sessionId: job.sessionId || null });
    } else if (job.type === 'discover') {
      // Cheap discovery: readdir comparison for new/deleted files (no per-file stat)
      const { ingested, removed } = indexer.discover();
      parentPort.postMessage({ event: 'discover-done', ingested, removed });
    } else if (job.type === 'one') {
      const sessionId = indexer.syncOne(job.filePath);
      parentPort.postMessage({ event: 'one-done', sessionId: sessionId || null, filePath: job.filePath });
    } else if (job.type === 'remove') {
      const sessionId = indexer.removeByPath(job.filePath);
      parentPort.postMessage({ event: 'removed', sessionId: sessionId || null });
    }
  } catch (e) {
    parentPort.postMessage({ event: 'error', jobType: job.type, error: e?.message ? e.message : String(e) });
  }
}

parentPort.on('message', enqueue);
