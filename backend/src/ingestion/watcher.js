'use strict';
// live tail: on a native host = chokidar fs-events (low cost, instant); on a Docker bind-mount (where fs-events do not propagate) = a layered tick.
// Three layers (all handed to the index worker -> the main thread never freezes; efficiency matches or beats native):
//   1. Hot tick (HOT_MS): active files (viewed / recently changed sessions) get a single-file incremental scan -> near-instant live-tail, equivalent to native touching only changed files.
//   2. Discovery (DISCOVER_MS): readdir comparison for added/deleted files (no per-file stat) -> cheap and frequent.
//   3. Full-scan safety net (FULL_SAFETY_MS, runs rarely + a time gate prevents continuous stacking): a full stat-scan to catch content growth in non-hot background sessions + reconciliation.
const fs = require('node:fs');
const { PROJECTS_DIR, WATCH_STABILITY_MS } = require('../config');
const indexService = require('../services/indexService');
const log = require('../log').scope('watch');

function resolveMode() {
  const m = (process.env.RECENSA_WATCH_MODE || 'auto').toLowerCase();
  if (m === 'events' || m === 'tick') return m;
  // auto: in a container (/.dockerenv or an explicit RECENSA_PROJECTS_DIR) bind-mount fs-events are unreliable -> tick; native -> events
  return (fs.existsSync('/.dockerenv') || process.env.RECENSA_PROJECTS_DIR) ? 'tick' : 'events';
}

const HOT_MS = Number(process.env.RECENSA_TICK_HOT_MS || 700);              // active files, near-instant (single-file incremental, cheap)
const DISCOVER_MS = Number(process.env.RECENSA_DISCOVER_MS || 6000);        // cheap discovery of new/deleted files (readdir comparison)
const FULL_SAFETY_MS = Number(process.env.RECENSA_FULL_SCAN_MS || 300_000); // full-scan safety net (5 min; catches growth in non-hot background sessions)

function startTick() {
  log.info(`tick mode (Docker bind-mount) — hot=${HOT_MS}ms discover=${DISCOVER_MS}ms full-safety=${FULL_SAFETY_MS}ms`);
  log.info(`watching ${PROJECTS_DIR}`);
  // 1. Hot: single-file incremental scan of active files (getActiveFiles empty -> no-op, near-zero cost when idle)
  const hotTimer = setInterval(() => {
    const active = indexService.getActiveFiles();
    for (const f of active) indexService.ingestPath(f);
  }, HOT_MS);
  // 2. Discovery: readdir comparison for new/deleted (coalesces to prevent overlap)
  const discoverTimer = setInterval(() => indexService.requestDiscover(), DISCOVER_MS);
  // 3. Full-scan safety net: a time gate + only fires when not already indexing -> a full scan (~12s) does not stack continuously (it once degenerated into back-to-back full scans when COLD_MS was less than the scan time)
  const fullTimer = setInterval(() => {
    const st = indexService.getStatus();
    const lastDone = st.lastCompletedAt ? new Date(st.lastCompletedAt).getTime() : 0;
    if (!st.indexing && Date.now() - lastDone >= FULL_SAFETY_MS) indexService.requestSync({ reconcile: true });
  }, 15_000);
  for (const t of [hotTimer, discoverTimer, fullTimer]) if (t.unref) t.unref();
  return { close: () => { clearInterval(hotTimer); clearInterval(discoverTimer); clearInterval(fullTimer); }, mode: 'tick' };
}

function startEvents() {
  const chokidar = require('chokidar');
  const watcher = chokidar.watch(PROJECTS_DIR, {
    ignoreInitial: true,
    ignored: (p, stats) => Boolean(stats?.isFile() && !p.endsWith('.jsonl')),
    awaitWriteFinish: { stabilityThreshold: WATCH_STABILITY_MS, pollInterval: 200 },
    depth: 4,
  });
  const onFileEvent = (filePath) => indexService.ingestPath(filePath);
  watcher.on('add', onFileEvent);
  watcher.on('change', onFileEvent);
  watcher.on('unlink', (filePath) => indexService.removePath(filePath));
  watcher.on('error', (err) => log.error(`watcher error: ${err.message}`));
  log.info(`events mode (native fs-events) — watching ${PROJECTS_DIR}`);
  return { close: () => watcher.close(), mode: 'events' };
}

function startWatcher() {
  return resolveMode() === 'tick' ? startTick() : startEvents();
}

module.exports = { startWatcher };
