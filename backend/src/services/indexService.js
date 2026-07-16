'use strict';
// Index service facade (main thread): orchestrates the index-worker (the sole writer of viewer.db) and holds index status for /api/index-status + WS broadcast.
// All re-parsing happens in the worker -> the main thread (HTTP/WS) never freezes on indexing.
// Hot set = watched (currently being viewed, never evicted) ∪ hotFiles (recently changed, time-windowed) -> the watcher's hot tick only incrementally scans these (equivalent to touching only changed files);
// the full scan falls back to a 5min safety net. tick requests coalesce (no re-dispatch while one is in flight, just one queued rerun recorded).
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const log = require('../log').scope('index');

const WORKER_PATH = path.join(__dirname, '..', 'ingestion', 'index-worker.js');
const HOT_WINDOW_MS = Number(process.env.RECENSA_HOT_WINDOW_MS || 20_000); // how long a file can be idle before it is dropped from the hot set
const HOT_MAX = 8; // a sync is treated as live-tail (and added to the hot set) only when its changed files are <= this count (more = bulk indexing, not a hot spot)

let worker = null;
let cb = {};
const status = { indexing: false, done: 0, total: 0, changed: 0, phase: 'idle', lastCompletedAt: null, lastMs: null };
const hotFiles = new Map(); // path → lastChangeMs (time window: recently changed, auto-evicted)
const watchedFiles = new Map(); // path → refcount (explicitly "being viewed" sessions, not subject to time-window eviction -> stays instant live-tail no matter how long it idles)
const PROGRESS_THROTTLE_MS = 300; // progress broadcast throttle (avoids one WS message every 25 files during a full index)
let lastProgressBroadcast = 0;
let syncInFlight = false;
let discoverInFlight = false;
let syncQueuedAgain = false;
let queuedReconcile = false;
let respawnTimer = null;
// Worker crash-loop guard: a worker that dies on startup would otherwise respawn every second
// forever while /api/health stays green. Exponential backoff caps the log/CPU churn, and the
// consecutive-crash count feeds /api/health so a dead indexer turns the container unhealthy
// instead of "healthy but the UI is empty".
let respawnDelayMs = 1000;
let consecutiveCrashes = 0;
const RESPAWN_DELAY_MAX_MS = 60_000;
const UNHEALTHY_CRASH_THRESHOLD = 5;

function start(callbacks = {}) {
  cb = callbacks;
  spawn();
}

function spawn() {
  worker = new Worker(WORKER_PATH);
  worker.on('message', onMessage);
  worker.on('error', (err) => { log.error(`worker crashed: ${err.message}`); onWorkerDown(); });
  worker.on('exit', (code) => { if (code !== 0) { log.error(`worker exited abnormally (code ${code})`); onWorkerDown(); } });
}

function onWorkerDown() {
  status.indexing = false;
  status.phase = 'idle';
  syncInFlight = false;
  if (respawnTimer) return;
  consecutiveCrashes += 1;
  const delay = respawnDelayMs;
  respawnDelayMs = Math.min(respawnDelayMs * 2, RESPAWN_DELAY_MAX_MS);
  log.warn(`index worker down (crash #${consecutiveCrashes}) — respawning in ${delay}ms`);
  respawnTimer = setTimeout(() => { respawnTimer = null; spawn(); log.info('index worker respawned'); }, delay);
}

// Completed work is the recovery signal (any message would also arrive from a worker that
// crashes mid-job, which must not reset the backoff).
function markWorkerHealthy() {
  consecutiveCrashes = 0;
  respawnDelayMs = 1000;
}

function snapshot() {
  const idlePct = status.indexing ? 0 : 100;
  const pct = status.total > 0 ? Math.round((status.done / status.total) * 100) : idlePct;
  return {
    indexing: status.indexing, done: status.done, total: status.total, pct, phase: status.phase,
    changed: status.changed, lastCompletedAt: status.lastCompletedAt, lastMs: status.lastMs,
    workerCrashes: consecutiveCrashes,
    workerHealthy: consecutiveCrashes < UNHEALTHY_CRASH_THRESHOLD,
  };
}

function markHot(files) {
  const now = Date.now();
  for (const f of files) hotFiles.set(f, now);
}

// The per-message worker handlers (extracted from the onMessage switch to reduce cognitive complexity; behavior and side-effect ordering are unchanged).
function onSyncStart() {
  status.indexing = true; status.phase = 'indexing'; status.done = 0; status.changed = 0;
  log.info('index sync started');
  if (cb.onProgress) cb.onProgress(snapshot());
}

function onProgress(msg) {
  status.indexing = true; status.phase = 'indexing'; status.done = msg.done; status.total = msg.total;
  const now = Date.now();
  if (cb.onProgress && now - lastProgressBroadcast >= PROGRESS_THROTTLE_MS) { lastProgressBroadcast = now; cb.onProgress(snapshot()); }
}

function onSyncDone(msg) {
  markWorkerHealthy();
  status.indexing = false; status.phase = 'idle';
  status.done = msg.total; status.total = msg.total; status.changed = msg.changed;
  status.lastCompletedAt = new Date().toISOString(); status.lastMs = msg.ms;
  syncInFlight = false;
  const removedNote = msg.removed?.length ? `, ${msg.removed.length} removed` : '';
  log.info(`index sync done: ${msg.changed} changed / ${msg.total} files in ${msg.ms}ms${removedNote}`);
  // live-tail (a small change) -> add to the hot set; bulk (the first full index, a large change) is not treated as a hot spot
  if (msg.changed > 0 && msg.changed <= HOT_MAX && Array.isArray(msg.changedFiles)) markHot(msg.changedFiles);
  if (cb.onDone) cb.onDone(snapshot(), { changed: msg.changed, removed: msg.removed || [] });
  if (syncQueuedAgain) { syncQueuedAgain = false; const r = queuedReconcile; queuedReconcile = false; requestSync({ reconcile: r }); }
}

function onOneDone(msg) {
  if (msg.sessionId) {
    if (msg.filePath) markHot([msg.filePath]);
    if (cb.onSessionUpdated) cb.onSessionUpdated(msg.sessionId);
  }
}

function onRemoved(msg) {
  if (msg.filePath) hotFiles.delete(msg.filePath);
  if (msg.sessionId && cb.onSessionRemoved) cb.onSessionRemoved(msg.sessionId);
}

function onDiscoverDone(msg) {
  markWorkerHealthy();
  discoverInFlight = false;
  const nIn = Array.isArray(msg.ingested) ? msg.ingested.length : 0;
  const nRm = Array.isArray(msg.removed) ? msg.removed.length : 0;
  if (nIn || nRm) log.info(`discovered: +${nIn} new, -${nRm} removed`);
  if (nIn) {
    markHot(msg.ingested.map((x) => x.file));
    if (cb.onSessionUpdated) for (const x of msg.ingested) cb.onSessionUpdated(x.sessionId);
  }
  if (nRm && cb.onSessionRemoved) for (const sid of msg.removed) cb.onSessionRemoved(sid);
}

function onWorkerError(msg) {
  log.error(`worker job '${msg.jobType}' failed: ${msg.error}`);
  if (msg.jobType === 'sync') { status.indexing = false; status.phase = 'idle'; syncInFlight = false; }
}

// event -> handler dispatch (an unknown event has no matching handler -> no-op, consistent with the original switch having no default)
const MESSAGE_HANDLERS = {
  'sync-start': onSyncStart,
  'progress': onProgress,
  'sync-done': onSyncDone,
  'one-done': onOneDone,
  'removed': onRemoved,
  'discover-done': onDiscoverDone,
  'error': onWorkerError,
};

function onMessage(msg) {
  const handler = MESSAGE_HANDLERS[msg.event];
  if (handler) handler(msg);
}

/** Request one full/incremental sync (idempotent; runs in the worker). reconcile=true also runs deletion reconciliation. Repeated tick requests coalesce. */
function requestSync({ reconcile = false } = {}) {
  if (!worker) return;
  if (syncInFlight) { syncQueuedAgain = true; queuedReconcile = queuedReconcile || reconcile; return; }
  syncInFlight = true;
  try { worker.postMessage({ type: 'sync', reconcile }); }
  catch (e) { syncInFlight = false; log.error(`requestSync failed: ${e.message}`); } // prevents a postMessage throw from wedging the coalescing
}

function ingestPath(filePath) { if (worker) worker.postMessage({ type: 'one', filePath }); }
function removePath(filePath) { if (worker) worker.postMessage({ type: 'remove', filePath }); }
/** deleteSession's viewer.db index cleanup -> handed to the worker (the sole writer); ids = the main + descendant session ids */
function deleteIndex(ids, sessionId) { if (worker) worker.postMessage({ type: 'delete-index', ids, sessionId }); }
/** Cheap discovery of new/deleted files (readdir comparison, no per-file stat); coalesces to prevent overlapping stacking */
function requestDiscover() {
  if (!worker || discoverInFlight) return;
  discoverInFlight = true;
  try { worker.postMessage({ type: 'discover' }); } catch (e) { discoverInFlight = false; log.error(`requestDiscover failed: ${e.message}`); }
}
/** Mark a file as active (e.g. a viewed session) -> the watcher's hot tick incrementally scans just that file -> near-instant live-tail with no full scan */
function touchHot(file) { if (file) markHot([file]); }

/** Mark/unmark a session as "being viewed" (frontend live-tail WS watch/unwatch) -> it stays an active file as long as it is open,
 *  not subject to HOT_WINDOW eviction (a message appearing after any idle still updates within 700ms). The ref-count tolerates reconnects / overlapping tabs. */
function setWatched(file, on) {
  if (!file) return;
  const n = (watchedFiles.get(file) || 0) + (on ? 1 : -1);
  if (n > 0) watchedFiles.set(file, n); else watchedFiles.delete(file);
}

/** Hot set = being viewed (watched, never evicted) ∪ changed within HOT_WINDOW (time-windowed). The watcher's hot tick only incrementally scans these. */
function getActiveFiles() {
  const cutoff = Date.now() - HOT_WINDOW_MS;
  for (const [f, t] of hotFiles) if (t < cutoff) hotFiles.delete(f);
  return [...new Set([...watchedFiles.keys(), ...hotFiles.keys()])];
}

function getStatus() { return snapshot(); }

module.exports = { start, requestSync, requestDiscover, ingestPath, removePath, deleteIndex, touchHot, setWatched, getActiveFiles, getStatus };
