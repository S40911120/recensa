'use strict';
// recensa-session worker thread: in-process require('@recensa/claude-session'); heavy work (reconstruct: restoring the pre-compaction conversation along the fork chain) runs on this thread,
// so the main thread's event loop (HTTP + WS) does not freeze. Each message { id, cmd:'reconstruct', file, outPath } -> replies { id, ok, result|error }.
const { parentPort } = require('node:worker_threads');
const claudeSession = require('@recensa/claude-session');

parentPort.on('message', async ({ id, cmd, file, outPath }) => {
  try {
    if (cmd !== 'reconstruct') throw new Error(`unknown cmd: ${cmd}`);
    const result = await claudeSession.reconstruct(file, outPath);
    parentPort.postMessage({ id, ok: true, result });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: e?.message ? e.message : String(e) });
  }
});
