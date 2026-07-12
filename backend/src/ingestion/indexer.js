'use strict';
// Incremental indexer: main session + subagent JSONL -> SQLite (entirely read-only)
// - byte-offset incremental: only digests newly appended bytes
// - chunked streaming: large files (100MB+) are never loaded whole into memory
// - idempotent re-read: on truncation/full re-read, clear the session's FTS and counts first so nothing is double-counted
const fs = require('node:fs');
const path = require('node:path');
const { FTS_TEXT_MAX, PROJECTS_DIR, TITLE_MAX } = require('../config');
const { open } = require('../storage/db');
const { forIndex } = require('../parsing/parse');
const log = require('../log').scope('indexer');

const CHUNK_BYTES = 4 * 1024 * 1024;

// ---------- target enumeration ----------

function mainTarget(projName, projDir, fileName) {
  return {
    file: path.join(projDir, fileName),
    sessionId: fileName.replace(/\.jsonl$/, ''),
    kind: 'main',
    project: projName,
    parentSession: null,
    metaFile: null,
  };
}

function subagentTarget(projName, subDir, parentId, fileName) {
  return {
    file: path.join(subDir, fileName),
    sessionId: `${parentId}:${fileName.replace(/\.jsonl$/, '')}`,
    kind: 'subagent',
    project: projName,
    parentSession: parentId,
    metaFile: path.join(subDir, fileName.replace(/\.jsonl$/, '.meta.json')),
  };
}

function collectSubagentTargets(projName, projDir, dirName, out) {
  const subDir = path.join(projDir, dirName, 'subagents');
  let subs;
  try {
    subs = fs.readdirSync(subDir);
  } catch {
    return;
  }
  for (const s of subs) {
    if (s.endsWith('.jsonl')) out.push(subagentTarget(projName, subDir, dirName, s));
  }
}

function collectProjectTargets(projName, projDir, out) {
  let entries;
  try {
    entries = fs.readdirSync(projDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.jsonl')) {
      out.push(mainTarget(projName, projDir, e.name));
    } else if (e.isDirectory()) {
      collectSubagentTargets(projName, projDir, e.name, out);
    }
  }
}

function listJsonlTargets() {
  const targets = [];
  let projects;
  try {
    projects = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch (err) {
    // The root projects dir is unreadable (e.g. EACCES from a wrong container-volume owner). Do NOT swallow this into a
    // silently-empty viewer -> surface it so the operator sees WHY nothing indexes, and let the job fail loudly (the worker
    // reports it and the periodic full-scan retries once permissions are fixed). Per-file/subdir EACCES stays handled
    // gracefully above (a single bad project is skipped); only the ROOT failing means the whole scan is blind.
    log.error(`cannot read the projects root ${PROJECTS_DIR}: ${err.message} — the index will stay empty until this is fixed (check directory permissions / the mounted volume)`);
    throw err;
  }
  for (const proj of projects) collectProjectTargets(proj.name, path.join(PROJECTS_DIR, proj.name), targets);
  return targets;
}

/** Derive a target directly from an absolute path (for watch events, avoiding a full-directory scan) */
function deriveTarget(filePath) {
  const rel = path.relative(PROJECTS_DIR, filePath);
  if (rel.startsWith('..') || !rel.endsWith('.jsonl')) return null;
  const parts = rel.split(path.sep);
  if (parts.length === 2) return mainTarget(parts[0], path.join(PROJECTS_DIR, parts[0]), parts[1]);
  if (parts.length === 4 && parts[2] === 'subagents') {
    return subagentTarget(parts[0], path.dirname(filePath), parts[1], parts[3]);
  }
  return null;
}

function readAgentMeta(metaFile) {
  if (!metaFile) return {};
  try {
    return JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  } catch {
    return {};
  }
}

// ---------- file reading (chunked) ----------

/** Invoke the callback for each complete line in [offset, size) (chunked, no whole-file alloc); returns the newOffset consumed up to */
function readLines(file, offset, size, onLine) {
  const fd = fs.openSync(file, 'r');
  try {
    let pos = offset;
    let carry = Buffer.alloc(0);
    while (pos < size) {
      const len = Math.min(CHUNK_BYTES, size - pos);
      const buf = Buffer.alloc(len);
      const read = fs.readSync(fd, buf, 0, len, pos);
      if (read <= 0) break;
      pos += read;
      const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, read)]) : buf.subarray(0, read);
      let start = 0;
      let nl = chunk.indexOf(0x0a, start);
      while (nl !== -1) {
        const line = chunk.subarray(start, nl).toString('utf8');
        if (line.trim()) onLine(line);
        start = nl + 1;
        nl = chunk.indexOf(0x0a, start);
      }
      carry = Buffer.from(chunk.subarray(start)); // copy, to avoid retaining the whole chunk
    }
    return pos - carry.length; // end of the last complete line
  } finally {
    fs.closeSync(fd);
  }
}

// ---------- stats aggregation ----------

function newAggregate() {
  return {
    firstTs: null,
    lastTs: null,
    msgCount: 0,
    userPrompts: 0,
    toolCalls: 0,
    tokensOut: 0,
    tokensIn: 0,
    cacheRead: 0,
    cacheCreation: 0,
    title: null,
    titleRank: 0, // 0=none 1=first human prompt 2=ai-title 3=custom-title/summary
    model: null,
    cwd: null,
    gitBranch: null,
    forkedFrom: null,
    compactCount: 0,
    ftsRows: [],
    agentSpawns: [], // Agent/Task tool_use ids emitted by this session (builds the nesting tree)
    models: new Set(), // every model used in this session (tracks switching between models)
  };
}

function setTitle(agg, title, rank) {
  // rank 2+ (ai/custom title): on equal rank the later one wins (updates as the conversation evolves); rank 1 (first prompt): the earlier one wins
  if (!title) return;
  if (title.trimStart().startsWith('<')) return; // starting with an angle bracket = an injected tag template, never used as a title
  if (rank > agg.titleRank || (rank === agg.titleRank && rank >= 2)) {
    agg.title = title.slice(0, TITLE_MAX);
    agg.titleRank = rank;
  }
}

/** Title-type record (summary/aiTitle/customTitle) -> update the title and return true (handled, not counted) */
function applyTitleRecord(agg, idx) {
  if (idx.summary) { setTitle(agg, idx.summary, 3); return true; }
  if (idx.customTitle) {
    // The continuation boilerplate auto-written by compact/resume is not a human-chosen title and must not take priority
    if (!/^This session is being continued/i.test(idx.customTitle)) setTitle(agg, idx.customTitle, 3);
    return true;
  }
  if (idx.aiTitle) { setTitle(agg, idx.aiTitle, 2); return true; }
  return false;
}

/** system event record (boundary/systemMsg): count it and return true; returns false for non-system events */
function applySystemRecord(agg, sessionId, idx) {
  if (idx.boundary) {
    agg.msgCount++; // aligned with toMessage's boundary marker (keeps the pagination total consistent)
    agg.compactCount++;
    return true;
  }
  if (idx.systemMsg) {
    agg.msgCount++; // stop_hook/api_error/away_summary/local_command/informational, aligned with toMessage
    if (idx.ts) agg.lastTs = idx.ts;
    // System events that carry content (away_summary etc.) have their content indexed into FTS so it is searchable
    if (idx.text) {
      agg.ftsRows.push({
        sessionId,
        uuid: idx.uuid || '',
        ts: idx.ts || '',
        mtype: idx.mtype || 'system',
        text: idx.text.slice(0, FTS_TEXT_MAX),
      });
    }
    return true;
  }
  return false;
}

/** Stats accumulation for a regular user/assistant message record (token/tool/prompt/FTS) */
function applyMessageRecord(agg, sessionId, idx) {
  agg.msgCount++;
  if (idx.ts) {
    if (!agg.firstTs) agg.firstTs = idx.ts;
    agg.lastTs = idx.ts;
  }
  // <synthetic> is a placeholder fake model for API errors; excluded from the set of used models
  if (idx.model) { agg.model = idx.model; if (idx.model !== '<synthetic>') agg.models.add(idx.model); }
  if (!agg.cwd && idx.cwd) agg.cwd = idx.cwd;
  if (idx.gitBranch) agg.gitBranch = idx.gitBranch; // last one wins (on a branch switch, the latest is the displayed value)
  agg.toolCalls += idx.toolCalls;
  if (idx.agentSpawns?.length) agg.agentSpawns.push(...idx.agentSpawns);
  agg.tokensOut += idx.tokensOut;
  agg.tokensIn += idx.tokensIn;
  agg.cacheRead += idx.cacheRead;
  agg.cacheCreation += idx.cacheCreation;
  if (idx.isUserPrompt) {
    agg.userPrompts++;
    setTitle(agg, idx.text.replace(/\s+/g, ' '), 1);
  }
  if (idx.text) {
    agg.ftsRows.push({
      sessionId,
      uuid: idx.uuid || '',
      ts: idx.ts || '',
      mtype: idx.mtype,
      text: idx.text.slice(0, FTS_TEXT_MAX),
    });
  }
}

function aggregateLine(agg, sessionId, line) {
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    return;
  }
  // forIndex recurses into message content; a shape-hostile record can throw (e.g. RangeError on pathological
  // nesting). Mirror the reader's per-record guard: skip the bad record instead of letting the throw abort the
  // whole file's msg_count (ingestFile's catch would drop every count accumulated so far). No-Silent-Failure: log.
  let idx;
  try {
    idx = forIndex(rec);
  } catch (err) {
    log.error(`skip malformed record in ${sessionId}: ${err.message}`);
    return;
  }
  if (!idx) return;
  if (applyTitleRecord(agg, idx)) return;
  if (!agg.forkedFrom && idx.forkedFrom) agg.forkedFrom = idx.forkedFrom;
  if (applySystemRecord(agg, sessionId, idx)) return;
  applyMessageRecord(agg, sessionId, idx);
}

// ---------- writes ----------

function persist(db, stmts, t, st, newOffset, agg, isIncremental) {
  const agentMeta = t.kind === 'subagent' ? readAgentMeta(t.metaFile) : {};
  const row = {
    id: t.sessionId,
    kind: t.kind,
    project: t.project,
    cwd: agg.cwd,
    file: t.file,
    parent_session: t.parentSession,
    agent_name: agentMeta.name || null,
    agent_type: agentMeta.agentType || null,
    agent_desc: agentMeta.description || null,
    tool_use_id: agentMeta.toolUseId || null,
    task_kind: agentMeta.taskKind || null,
    team_name: agentMeta.teamName || null,
    model: agg.model,
    // subagent-specific meta (which model it ran / nesting depth / custom type)
    agent_model: agentMeta.model || null,
    spawn_depth: typeof agentMeta.spawnDepth === 'number' ? agentMeta.spawnDepth : null,
    custom_agent_type: agentMeta.customAgentType || null,
    title: agg.title,
    title_rank: agg.titleRank,
    first_ts: agg.firstTs,
    last_ts: agg.lastTs,
    msg_count: agg.msgCount,
    user_prompts: agg.userPrompts,
    tool_calls: agg.toolCalls,
    tokens_out: agg.tokensOut,
    tokens_in: agg.tokensIn,
    cache_read: agg.cacheRead,
    cache_creation: agg.cacheCreation,
    git_branch: agg.gitBranch,
    forked_from: agg.forkedFrom,
    compact_count: agg.compactCount,
    model_names: agg.models.size > 0 ? JSON.stringify([...agg.models]) : null,
    size: st.size,
  };
  db.exec('BEGIN IMMEDIATE');
  try {
    stmts.upsertFile.run(t.file, st.size, st.mtimeMs, newOffset, t.sessionId);
    if (isIncremental) {
      stmts.upsertSessionAdd.run(row);
    } else {
      // Full read (new file or truncated re-read): clear old FTS rows + old spawn edges first, then absolutely overwrite the counts, to stay idempotent
      stmts.deleteFts.run(t.sessionId);
      stmts.deleteSpawns.run(t.sessionId);
      stmts.upsertSessionReplace.run(row);
    }
    for (const r of agg.ftsRows) stmts.insertFts.run(r.sessionId, r.uuid, r.ts, r.mtype, r.text);
    for (const id of agg.agentSpawns) stmts.insertSpawn.run(id, t.sessionId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function ingestFile(db, t, stmts) {
  let st;
  try {
    st = fs.statSync(t.file);
  } catch {
    return false;
  }
  const known = stmts.getFile.get(t.file);
  let offset = known ? known.offset : 0;
  if (known && st.size < known.offset) offset = 0; // file was truncated -> full re-read
  if (known && st.size === known.offset && st.mtimeMs <= known.mtime) return false;

  const agg = newAggregate();
  const newOffset = readLines(t.file, offset, st.size, (line) => aggregateLine(agg, t.sessionId, line));
  if (newOffset === offset && known) {
    stmts.touchFile.run(st.size, st.mtimeMs, t.file);
    return false;
  }
  persist(db, stmts, t, st, newOffset, agg, Boolean(known) && offset > 0);
  return true;
}

/** File deleted -> clear the session's index (files / sessions / fts) */
function removeByPath(filePath) {
  const t = deriveTarget(filePath);
  if (!t) return null;
  const db = open();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM files WHERE path = ?').run(filePath);
    db.prepare('DELETE FROM messages_fts WHERE session_id = ?').run(t.sessionId);
    db.prepare('DELETE FROM agent_spawns WHERE emitter_session = ?').run(t.sessionId);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(t.sessionId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return t.sessionId;
}

const SESSION_COLUMNS = `(id, kind, project, cwd, file, parent_session, agent_name, agent_type, agent_desc,
   tool_use_id, task_kind, team_name, model, agent_model, spawn_depth, custom_agent_type, title, title_rank, first_ts, last_ts, msg_count, user_prompts, tool_calls, tokens_out, tokens_in, cache_read, cache_creation, git_branch, forked_from, compact_count, model_names, size)
  VALUES (@id, @kind, @project, @cwd, @file, @parent_session, @agent_name, @agent_type, @agent_desc,
   @tool_use_id, @task_kind, @team_name, @model, @agent_model, @spawn_depth, @custom_agent_type, @title, @title_rank, @first_ts, @last_ts, @msg_count, @user_prompts, @tool_calls, @tokens_out, @tokens_in, @cache_read, @cache_creation, @git_branch, @forked_from, @compact_count, @model_names, @size)`;

const SESSION_META_UPDATES = `
  cwd = COALESCE(sessions.cwd, excluded.cwd),
  model = COALESCE(excluded.model, sessions.model),
  agent_model = COALESCE(excluded.agent_model, sessions.agent_model),
  spawn_depth = COALESCE(excluded.spawn_depth, sessions.spawn_depth),
  custom_agent_type = COALESCE(excluded.custom_agent_type, sessions.custom_agent_type),
  git_branch = COALESCE(excluded.git_branch, sessions.git_branch),
  title = CASE WHEN excluded.title IS NOT NULL AND excluded.title_rank >= sessions.title_rank
               THEN excluded.title ELSE sessions.title END,
  title_rank = MAX(sessions.title_rank, excluded.title_rank),
  agent_name = COALESCE(sessions.agent_name, excluded.agent_name),
  agent_type = COALESCE(sessions.agent_type, excluded.agent_type),
  agent_desc = COALESCE(sessions.agent_desc, excluded.agent_desc),
  tool_use_id = COALESCE(sessions.tool_use_id, excluded.tool_use_id),
  task_kind = COALESCE(sessions.task_kind, excluded.task_kind),
  team_name = COALESCE(sessions.team_name, excluded.team_name),
  forked_from = COALESCE(sessions.forked_from, excluded.forked_from),
  first_ts = COALESCE(sessions.first_ts, excluded.first_ts),
  last_ts = COALESCE(excluded.last_ts, sessions.last_ts),
  size = excluded.size`;

function makeStatements(db) {
  return {
    getFile: db.prepare('SELECT offset, size, mtime FROM files WHERE path = ?'),
    touchFile: db.prepare('UPDATE files SET size = ?, mtime = ? WHERE path = ?'),
    upsertFile: db.prepare(`
      INSERT INTO files (path, size, mtime, offset, session_id) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, offset = excluded.offset
    `),
    // Incremental append: counts add up; model_names takes the union of old and new JSON (an incremental slice only sees newly appearing models, so it must not overwrite)
    upsertSessionAdd: db.prepare(`
      INSERT INTO sessions ${SESSION_COLUMNS}
      ON CONFLICT(id) DO UPDATE SET ${SESSION_META_UPDATES},
        msg_count = sessions.msg_count + excluded.msg_count,
        user_prompts = sessions.user_prompts + excluded.user_prompts,
        tool_calls = sessions.tool_calls + excluded.tool_calls,
        tokens_out = sessions.tokens_out + excluded.tokens_out,
        tokens_in = sessions.tokens_in + excluded.tokens_in,
        cache_read = sessions.cache_read + excluded.cache_read,
        cache_creation = sessions.cache_creation + excluded.cache_creation,
        compact_count = sessions.compact_count + excluded.compact_count,
        model_names = (
          SELECT json_group_array(DISTINCT value) FROM (
            SELECT value FROM json_each(COALESCE(sessions.model_names, '[]'))
            UNION
            SELECT value FROM json_each(COALESCE(excluded.model_names, '[]'))
          )
        )
    `),
    // Full read: counts are absolutely overwritten (together with deleteFts this stays idempotent); model_names is likewise absolutely overwritten
    upsertSessionReplace: db.prepare(`
      INSERT INTO sessions ${SESSION_COLUMNS}
      ON CONFLICT(id) DO UPDATE SET ${SESSION_META_UPDATES},
        msg_count = excluded.msg_count,
        user_prompts = excluded.user_prompts,
        tool_calls = excluded.tool_calls,
        tokens_out = excluded.tokens_out,
        tokens_in = excluded.tokens_in,
        cache_read = excluded.cache_read,
        cache_creation = excluded.cache_creation,
        compact_count = excluded.compact_count,
        model_names = excluded.model_names
    `),
    deleteFts: db.prepare('DELETE FROM messages_fts WHERE session_id = ?'),
    insertFts: db.prepare('INSERT INTO messages_fts (session_id, uuid, ts, mtype, text) VALUES (?, ?, ?, ?, ?)'),
    deleteSpawns: db.prepare('DELETE FROM agent_spawns WHERE emitter_session = ?'),
    insertSpawn: db.prepare('INSERT OR REPLACE INTO agent_spawns (tool_use_id, emitter_session) VALUES (?, ?)'),
  };
}

/** Full/incremental sync (idempotent, synchronous version; used by the CLI and manual reindex) */
function sync({ onProgress } = {}) {
  const db = open();
  const stmts = makeStatements(db);
  const targets = listJsonlTargets();
  let changed = 0;
  let done = 0;
  for (const t of targets) {
    try {
      if (ingestFile(db, t, stmts)) changed++;
    } catch (err) {
      log.error(`${t.file}: ${err.message}`);
    }
    done++;
    if (onProgress && done % 200 === 0) onProgress(done, targets.length);
  }
  return { total: targets.length, changed };
}

const YIELD_EVERY = 25;

/** Digest a single file with error isolation; returns true on a successful change and records it in changedFiles (cap 32) */
function tryIngest(db, t, stmts, changedFiles) {
  try {
    if (!ingestFile(db, t, stmts)) return false;
    if (changedFiles.length < 32) changedFiles.push(t.file); // changed-file paths (for indexService's hot set: only a few files change during live-tail)
    return true;
  } catch (err) {
    log.error(`${t.file}: ${err.message}`);
    return false;
  }
}

/** Yield the event loop every YIELD_EVERY files (lets high-priority live-tail/deletion jobs cut in -> a full scan does not block the hot tick) */
async function maybeYield(done, total, onProgress, onYield) {
  if (done % YIELD_EVERY !== 0) return;
  if (onProgress) onProgress(done, total);
  if (onYield) await onYield();
  await new Promise((resolve) => setImmediate(resolve));
}

/** Deletion reconciliation: registered in the DB but not seen in the on-disk set during this pass = deleted -> clear the index, return the list of deleted sessionIds */
function collectDeletedSessions(dbPaths, onDisk) {
  const removed = [];
  for (const p of dbPaths) {
    if (onDisk.has(p)) continue;
    try { const sid = removeByPath(p); if (sid) removed.push(sid); } catch { /* a single-file failure does not halt the pass */ }
  }
  return removed;
}

/** Non-blocking version: yields the event loop every YIELD_EVERY files. Runs inside the index worker (the main thread does no parsing and never freezes).
 *  onProgress reports (0, total) up front (so the UI immediately knows the total count), updates every YIELD_EVERY files, and reports (total, total) at the end. */
async function syncAsync({ onProgress, reconcile = false, onYield } = {}) {
  const db = open();
  const stmts = makeStatements(db);
  const targets = listJsonlTargets();
  let changed = 0;
  let done = 0;
  const changedFiles = [];
  if (onProgress) onProgress(0, targets.length);
  for (const t of targets) {
    if (tryIngest(db, t, stmts, changedFiles)) changed++;
    done++;
    await maybeYield(done, targets.length, onProgress, onYield);
  }
  if (onProgress) onProgress(targets.length, targets.length);
  // Deletion reconciliation folded into this pass: the on-disk set is known -> registered in the DB but not scanned this pass = deleted. Drops the separate existsSync pass (one directory walk serves both purposes).
  let removed = [];
  if (reconcile) {
    const onDisk = new Set(targets.map((t) => t.file));
    let rows;
    try { rows = db.prepare('SELECT DISTINCT path FROM files').all(); } catch { rows = []; }
    removed = collectDeletedSessions(rows.map((r) => r.path), onDisk);
  }
  return { total: targets.length, changed, changedFiles, removed };
}

/** Cheap incremental discovery: build the target list via readdir (no per-file stat) -> compare against the DB files set.
 *  New file (on-disk, not in DB) -> ingest; deleted (in DB, not on-disk) -> remove.
 *  Content growth of existing files is not detected here (that is handled by indexService's hot set / the periodic full-scan safety net).
 *  Returns { ingested:[{sessionId,file}], removed:[sessionId] }. */
/** New files that are on-disk but not registered in the DB -> ingest, returns [{sessionId, file}] */
function ingestNewTargets(db, targets, stmts, dbFiles) {
  const ingested = [];
  for (const t of targets) {
    if (dbFiles.has(t.file)) continue;
    try {
      if (ingestFile(db, t, stmts)) ingested.push({ sessionId: t.sessionId, file: t.file });
    } catch (err) {
      log.error(`discover ${t.file}: ${err.message}`);
    }
  }
  return ingested;
}

function discover() {
  const db = open();
  const stmts = makeStatements(db);
  const targets = listJsonlTargets();
  const onDisk = new Set(targets.map((t) => t.file));
  let dbRows;
  try { dbRows = db.prepare('SELECT DISTINCT path FROM files').all(); } catch { dbRows = []; }
  const dbFiles = new Set(dbRows.map((r) => r.path));
  const ingested = ingestNewTargets(db, targets, stmts, dbFiles);
  const removed = collectDeletedSessions(dbFiles, onDisk);
  return { ingested, removed };
}

/** Clear the viewer.db index (fts/files/sessions/spawns) for a set of ids. This is deleteSession's viewer.db write path,
 *  called by the index worker (the sole writer of viewer.db) -> serialized with the tick's deletion reconciliation, eliminating the double-write race.
 *  Cleanup of flagsdb.session_flags is left to the main thread (the sole writer of flagsdb). */
function removeIndexByIds(ids) {
  if (!ids || ids.length === 0) return;
  const db = open();
  const ph = ids.map(() => '?').join(',');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`DELETE FROM messages_fts WHERE session_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM files WHERE session_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM agent_spawns WHERE emitter_session IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM sessions WHERE id IN (${ph})`).run(...ids);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Single-file incremental digest (watch event); returns sessionId or null */
function syncOne(filePath) {
  const t = deriveTarget(filePath);
  if (!t) return null;
  const db = open();
  const stmts = makeStatements(db);
  return ingestFile(db, t, stmts) ? t.sessionId : null;
}

if (require.main === module) {
  const t0 = Date.now();
  const res = sync({ onProgress: (d, total) => console.log(`  ${d}/${total}`) });
  console.log(`indexed: ${res.changed} changed / ${res.total} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

module.exports = {
  sync,
  syncAsync,
  syncOne,
  discover,
  removeByPath,
  removeIndexByIds,
  deriveTarget,
  listJsonlTargets,
  // Reused by the backfill tool (recomputes stat fields without re-populating FTS)
  newAggregate,
  aggregateLine,
  readAgentMeta,
  readLines,
};
