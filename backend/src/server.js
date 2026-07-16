'use strict';
// Entry point: HTTP + WebSocket + index worker (re-parsing without freezing the main thread) + live-tail watcher
const { WebSocketServer } = require('ws');
const { createApp } = require('./app');
const { HOST, PORT, DATA_DIR } = require('./config');
const { open } = require('./storage/db');
const indexService = require('./services/indexService');
const { getSession } = require('./repositories/sessionRepo');
const { isAllowedRequest } = require('./security');
const { startWatcher } = require('./ingestion/watcher');
const log = require('./log').scope('server');

let version = 'dev';
try { version = require('../package.json').version; } catch { /* version is best-effort */ }
log.info(`Recensa v${version} starting — node ${process.version}, pid ${process.pid}`);

// Process-level guards (registered before anything can throw): an unhandled rejection or an exception that escapes to the
// event loop must not leave the process hung or die with a lost/raw stack -> log it structured, then exit non-zero so the
// supervisor (docker/systemd) restarts cleanly.
process.on('unhandledRejection', (reason) => {
  log.error(`unhandledRejection — ${reason instanceof Error ? reason.stack : String(reason)}`);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  log.error(`uncaughtException — ${err?.stack || err}`);
  process.exit(1);
});

// The main thread opens first (running schema migration) -> then spawns the index worker (which connects with migrate:false and runs no DDL).
// The only migrator is the main thread here, ordered before the worker -> no concurrent DDL / destructive migration collision.
// A failed open is almost always a data-volume problem; node:sqlite's bare "unable to open database file"
// carries no path, so wrap it with where and what to check.
try {
  open();
} catch (err) {
  log.error(`failed to open the database in ${DATA_DIR} — is the data volume mounted and writable? (${err?.message || err})`);
  process.exit(1);
}
log.info('database opened (schema migrated)');

const app = createApp();
let watcher = null;
let isShuttingDown = false;

const httpServer = app.listen(PORT, HOST, () => {
  log.info(`listening on http://${HOST}:${PORT}`);

  // index worker (the sole writer of viewer.db) + progress/updates -> WS broadcast (every background action is visible to the frontend)
  indexService.start({
    onProgress: (s) => broadcast({ type: 'index_progress', ...s, ts: new Date().toISOString() }),
    onDone: (s, r) => {
      broadcast({ type: 'index_done', ...s, ts: new Date().toISOString() });
      for (const sid of r.removed) broadcast({ type: 'session_removed', sessionId: sid, ts: new Date().toISOString() });
    },
    onSessionUpdated: (sessionId) => broadcast({ type: 'session_updated', sessionId, ts: new Date().toISOString() }),
    onSessionRemoved: (sessionId) => broadcast({ type: 'session_removed', sessionId, ts: new Date().toISOString() }),
  });

  watcher = startWatcher();

  // Initial full index (including deletion reconciliation); progress is broadcast live and the service stays responsive throughout
  indexService.requestSync({ reconcile: true });
  log.info('initial index requested (full scan + reconcile)');
});

// Listen-socket startup errors (most commonly the port already taken) otherwise crash with a raw stack. Give a clear,
// actionable line for the common case; let anything else propagate to the uncaughtException guard above.
httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log.error(`port ${PORT} is already in use — under Docker set RECENSA_HOST_PORT (host side) instead; running from source, set SESSION_VIEWER_PORT or stop the other instance`);
    process.exit(1);
  }
  throw err;
});

// The WebSocket upgrade passes the same request gate as HTTP (DNS rebinding symmetric with HTTP; the handshake is a
// GET, so Origin stays optional for it)
const wss = new WebSocketServer({
  server: httpServer,
  path: '/ws',
  verifyClient: ({ req }) =>
    isAllowedRequest({ host: req.headers.host, origin: req.headers.origin, method: req.method }),
});

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    try { if (client.readyState === 1) client.send(data); } catch { /* one disconnected client does not affect the rest */ }
  }
}

// Heartbeat: a half-open connection (network drop / tab sleep) does not fire a close event, so ping/pong timeouts reclaim it
const HEARTBEAT_MS = 30_000;
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.watchedFile = null;
  ws.on('pong', () => { ws.isAlive = true; });
  // The frontend live-tail WS sends { type:'watch', sessionId } -> pins the "being viewed" session as an active file (700ms live no matter how long it idles); disconnect auto-cancels
  ws.on('message', (data) => {
    try {
      const m = JSON.parse(String(data));
      if (m.type === 'watch' && m.sessionId) {
        const row = getSession(m.sessionId);
        if (row) {
          if (ws.watchedFile && ws.watchedFile !== row.file) indexService.setWatched(ws.watchedFile, false);
          ws.watchedFile = row.file;
          indexService.setWatched(row.file, true);
        }
      }
    } catch { /* ignore non-JSON / unknown messages */ }
  });
  ws.on('close', () => { if (ws.watchedFile) indexService.setWatched(ws.watchedFile, false); });
  // On connect, push the current index-status snapshot (a client that joins mid-index immediately sees "indexing X/Y" without waiting for the next progress event)
  try { ws.send(JSON.stringify({ type: 'index_progress', ...indexService.getStatus(), ts: new Date().toISOString() })); } catch { /* a send failure does not affect connection setup */ }
});
const heartbeat = setInterval(() => {
  for (const client of wss.clients) {
    if (client.isAlive === false) { client.terminate(); continue; }
    client.isAlive = false;
    client.ping();
  }
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeat));

// Graceful shutdown: release the watcher, close the WS, wait for pending requests
function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log.info(`${signal} received — shutting down`);
  if (watcher) { watcher.close(); watcher = null; }
  wss.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000); // 5s hard-exit backstop
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
