#!/usr/bin/env node
'use strict';
// Recensa operations — Docker-first, cross-platform. One mechanized entry point.
//   node scripts/ops.js up             build image + start container (docker compose up -d --build)
//   node scripts/ops.js down           stop + remove the container
//   node scripts/ops.js restart        restart the running container
//   node scripts/ops.js logs           follow container logs
//   node scripts/ops.js status         container state + health
//   node scripts/ops.js smoke          end-to-end smoke test against the published port
//   node scripts/ops.js check          type-check + lint + unit tests (backend + frontend) — local, no container
//   node scripts/ops.js backfill-chain recompute derived columns (runs inside the container)
//   node scripts/ops.js vacuum         shrink the DB file (runs inside the container)
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..'); // packages/recensa/backend
const PKG = path.join(ROOT, '..'); // packages/recensa — docker-compose.yml lives here
const DATA = path.join(ROOT, 'data'); // real DB path only when running INSIDE the container
const IN_CONTAINER = fs.existsSync('/.dockerenv');

// Host-published port: env > packages/recensa/.env > compose default (7788).
function hostPort() {
  if (process.env.RECENSA_HOST_PORT) return process.env.RECENSA_HOST_PORT;
  try {
    const m = fs.readFileSync(path.join(PKG, '.env'), 'utf8').match(/^\s*RECENSA_HOST_PORT\s*=\s*(\d+)/m);
    if (m) return m[1];
  } catch {
    /* no .env → default */
  }
  return '7788';
}
const PORT = hostPort();
const BASE = `http://127.0.0.1:${PORT}`;

// docker compose in the package dir. All call sites pass simple space-free tokens,
// so shell:true is safe on both cmd.exe and sh (needed on Windows to resolve docker.exe).
function compose(args, opts = {}) {
  // Single command string (not an args array) with shell:true — needed on Windows to resolve
  // docker via PATHEXT, and avoids Node's DEP0190 (args + shell). Every token is a fixed literal
  // with no spaces, so plain concatenation is safe here (no external input, no injection surface).
  const r = spawnSync(['docker', 'compose', ...args].join(' '), {
    cwd: PKG,
    stdio: 'inherit',
    shell: true,
    windowsHide: true,
    ...opts,
  });
  if (r.error) throw new Error(`docker compose failed: ${r.error.message}`);
  return r.status;
}

async function health(timeoutMs = 5000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/api/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function waitHealthy(totalMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < totalMs) {
    if (await health(3000)) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

async function up() {
  console.log('building image + starting container…');
  if (compose(['up', '-d', '--build']) !== 0) throw new Error('docker compose up failed');
  console.log('waiting for health…');
  console.log((await waitHealthy()) ? `\nUP — ${BASE}` : `\nstarted, but health not green within 60s — check: ops.js logs`);
}

function down() {
  return compose(['down']);
}

async function restart() {
  if (compose(['restart', 'recensa']) !== 0) throw new Error('docker compose restart failed');
  console.log((await waitHealthy()) ? `restarted — ${BASE}` : 'restarted, but health not green within 60s');
}

function logs() {
  return compose(['logs', '-f', 'recensa']);
}

async function status() {
  compose(['ps']);
  console.log(`\nhealth: ${(await health()) ? 'OK' : 'DOWN'}  (${BASE})`);
}

async function smoke() {
  let failed = 0;
  const check = (name, ok) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) failed++;
  };
  check('health', await health());
  const list = await (await fetch(`${BASE}/api/sessions?limit=1`)).json();
  check('sessions list non-empty', Array.isArray(list) && list.length > 0);
  check('DTO does not leak file field', list[0] && !('file' in list[0]));
  if (list[0]) {
    const page = await (await fetch(`${BASE}/api/session/${list[0].id}/messages?from=0&limit=5`)).json();
    check('messages paging (hasMore field present)', Array.isArray(page.messages) && typeof page.hasMore === 'boolean');
    const detail = await (await fetch(`${BASE}/api/session/${list[0].id}`)).json();
    check('detail has chain/subagents', !!detail.chain && Array.isArray(detail.subagents));
  }
  // fetch/undici silently drops a forged Host header → use raw http to send one.
  const evilStatus = await new Promise((resolve) => {
    const req = require('http').request(
      { host: '127.0.0.1', port: Number(PORT), path: '/api/sessions', headers: { Host: 'evil.example.com' } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      }
    );
    req.on('error', () => resolve(0));
    req.end();
  });
  check('malicious Host rejected (403)', evilStatus === 403);
  console.log(failed === 0 ? '\nSMOKE ALL PASS' : `\nSMOKE FAILED: ${failed}`);
  return failed === 0;
}

// Full-field backfill: after a schema change / count-logic change, recompute every derived
// stat column with a complete aggregate. Reuses the indexer's aggregateLine (zero copy) but
// does NOT re-write FTS (skips the most expensive trigram writes) — historical away_summary
// and similar new types won't enter search, only new data will; stat/summary columns are all filled.
function backfillChain() {
  const { DatabaseSync } = require('node:sqlite');
  const { newAggregate, aggregateLine, readAgentMeta, readLines } = require('../src/ingestion/indexer');
  const db = new DatabaseSync(path.join(DATA, 'viewer.db'));
  db.exec('PRAGMA busy_timeout = 10000'); // wait out the index worker's transient write locks instead of erroring immediately
  // This runs inside the live container beside the index worker (the sole intended writer). It is not
  // gated on a stopped service because the delegate path (docker compose exec) requires the container up;
  // instead each row's writes are serialized in a transaction and rely on busy_timeout. Run during low activity.
  console.log('backfill-chain: running beside the live index worker — per-row writes are transactional + busy_timeout-guarded; prefer low-activity windows.');
  const rows = db.prepare('SELECT id, file, kind FROM sessions').all();
  const upd = db.prepare(`UPDATE sessions SET
    msg_count = ?, user_prompts = ?, tool_calls = ?,
    tokens_out = ?, tokens_in = ?, cache_read = ?, cache_creation = ?,
    git_branch = ?, agent_model = ?, spawn_depth = ?, custom_agent_type = ?,
    model = COALESCE(?, model), forked_from = ?, compact_count = ?, model_names = ?,
    first_ts = COALESCE(first_ts, ?), last_ts = COALESCE(?, last_ts)
    WHERE id = ?`);
  // Count columns are absolute overwrites → files.offset must advance to size, or later
  // incremental passes would double-count the [offset, size) range.
  const updOffset = db.prepare('UPDATE files SET offset = ?, size = ? WHERE session_id = ?');
  let done = 0, skipped = 0, failed = 0;
  for (const r of rows) {
    try {
      const agg = newAggregate();
      const size = fs.statSync(r.file).size;
      readLines(r.file, 0, size, (line) => aggregateLine(agg, r.id, line));
      const meta = r.kind === 'subagent' ? readAgentMeta(r.file.replace(/\.jsonl$/, '.meta.json')) : {};
      // The count overwrite and the offset advance must land together: wrapping both in one
      // transaction stops a concurrent index-worker write from interleaving between them (which
      // would desync offset from counts and double-count the [offset, size) range on the next pass).
      db.exec('BEGIN IMMEDIATE');
      try {
        upd.run(
          agg.msgCount, agg.userPrompts, agg.toolCalls,
          agg.tokensOut, agg.tokensIn, agg.cacheRead, agg.cacheCreation,
          agg.gitBranch, meta.model || null,
          typeof meta.spawnDepth === 'number' ? meta.spawnDepth : null, meta.customAgentType || null,
          agg.model, agg.forkedFrom, agg.compactCount,
          agg.models.size > 0 ? JSON.stringify([...agg.models]) : null,
          agg.firstTs, agg.lastTs, r.id
        );
        updOffset.run(size, size, r.id);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      done++;
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        skipped++; // source jsonl deleted since it was indexed — expected, nothing to backfill
      } else {
        // A DB error (SQLITE_BUSY from racing the index worker, disk, corruption) must never be
        // swallowed silently — surface it and mark the run failed so the caller does not trust the counts.
        failed++;
        console.error(`backfill: session ${r.id} failed — ${e.message}`);
      }
    }
    const total = done + skipped + failed;
    if (total % 500 === 0) console.log(`${total}/${rows.length}`);
  }
  console.log(`backfill done: ${done} updated, ${skipped} skipped (file gone), ${failed} failed (stat columns filled; FTS not rebuilt, historical new-type content not searchable)`);
  if (failed > 0) process.exitCode = 1; // non-silent end-to-end: a racing-worker lock or DB error must not report success
}

// Shrink the DB file after an FTS migration / large deletes. Locks the DB for minutes;
// run off-peak. Relies on busy_timeout to wait out the index worker's transient writes.
function vacuum() {
  const { DatabaseSync } = require('node:sqlite');
  const dbFile = path.join(DATA, 'viewer.db');
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA busy_timeout = 30000'); // VACUUM needs exclusive access; wait up to 30s for the index worker to go idle
  const before = fs.statSync(dbFile).size;
  console.log('VACUUM… acquires an exclusive lock and briefly stalls the index worker; may take minutes.');
  try {
    db.exec('VACUUM');
  } catch (e) {
    // Non-silent: most likely SQLITE_BUSY because the index worker (sole writer) held the lock past busy_timeout.
    throw new Error(`VACUUM failed (${e.code || 'DB'}): ${e.message} — retry during low activity or with the service stopped`, { cause: e });
  }
  const after = fs.statSync(dbFile).size;
  console.log(`done: ${(before / 1e6).toFixed(0)}MB → ${(after / 1e6).toFixed(0)}MB`);
}

function check() {
  let failed = 0;
  const FE = path.join(ROOT, '..', 'frontend');
  for (const [label, cwd, args] of [
    ['BE type-check', ROOT, ['run', 'type-check']],
    ['BE lint', ROOT, ['run', 'lint']],
    ['BE unit test', ROOT, ['test']],
    ['FE type-check', FE, ['run', 'type-check']],
    ['FE lint', FE, ['run', 'lint']],
  ]) {
    const r = spawnSync(['npm', ...args].join(' '), { cwd, encoding: 'utf8', shell: true, windowsHide: true });
    const ok = r.status === 0;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
    if (!ok) {
      failed++;
      if (r.stderr) process.stderr.write(r.stderr.slice(0, 500));
    }
  }
  console.log(failed === 0 ? '\nCHECK ALL PASS' : `\nCHECK FAILED: ${failed}`);
  return failed === 0;
}

// DB-maintenance commands operate on the DB, which lives in the container's named volume.
// On the host they delegate into the container; inside the container they run for real.
function delegateIntoContainer(cmd) {
  console.log(`delegating '${cmd}' into the running container…`);
  return compose(['exec', '-T', 'recensa', 'node', 'scripts/ops.js', cmd]);
}

(async () => {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'up':
      return up();
    case 'down':
      return down();
    case 'restart':
      return restart();
    case 'logs':
      return logs();
    case 'status':
      return status();
    case 'smoke':
      process.exitCode = (await smoke()) ? 0 : 1;
      return;
    case 'check':
      process.exitCode = check() ? 0 : 1;
      return;
    case 'backfill-chain':
      if (!IN_CONTAINER) {
        process.exitCode = delegateIntoContainer('backfill-chain');
        return;
      }
      return backfillChain();
    case 'vacuum':
      if (!IN_CONTAINER) {
        process.exitCode = delegateIntoContainer('vacuum');
        return;
      }
      return vacuum();
    default:
      console.log('usage: node scripts/ops.js <up|down|restart|logs|status|smoke|check|backfill-chain|vacuum>');
      process.exitCode = 2;
  }
})().catch((e) => {
  console.error(`FAIL: ${e.message}`);
  process.exitCode = 1;
});
