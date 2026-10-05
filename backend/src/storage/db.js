'use strict';
// SQLite layer: separates the index (viewer.db, rebuildable) from curated data (flags.db, user data, never cleared by a rebuild)
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { DATA_DIR } = require('../config');
const log = require('../log').scope('db');

const DB_PATH = path.join(DATA_DIR, 'viewer.db');
const FLAGS_DB_PATH = path.join(DATA_DIR, 'flags.db');

let db = null;

/** A corruption error from opening/reading a torn viewer.db (WAL corruption after a docker kill / power loss). */
function isCorruptionError(err) {
  const s = `${err?.code ?? ''} ${err?.errstr ?? ''} ${err?.message ?? ''}`.toLowerCase();
  return s.includes('malformed') || s.includes('not a database') || s.includes('sqlite_corrupt');
}

// Delete ONLY the disposable viewer.db and its WAL/SHM/journal sidecars. flags.db (precious, non-recomputable pins/tags/
// notes) is deliberately never referenced here -> a corrupt-index rebuild can never touch curated user data.
function deleteViewerDbFiles() {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    fs.rmSync(DB_PATH + suffix, { force: true });
  }
}

function closeQuietly() {
  try { if (db) db.close(); } catch { /* a half-open handle from a failed open may already be unusable */ }
  db = null;
}

function open({ migrate = true } = {}) {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Only the main thread (migrate=true, the sole migrator/owner of viewer.db) may auto-rebuild a corrupt index; the worker
  // never deletes it out from under the main thread -> a worker-side corruption surfaces (respawn) rather than racing a delete.
  try {
    return connect({ migrate });
  } catch (err) {
    if (!migrate || !isCorruptionError(err)) throw err;
    log.warn(`viewer.db is corrupt (${err.message}) — deleting the disposable index and rebuilding from scratch; flags.db (pins/tags/notes) is preserved`);
    closeQuietly();
    deleteViewerDbFiles();
    // Rebuild once. If it still fails (e.g. flags.db itself is corrupt), rethrow -> the operator sees it and flags.db is never auto-deleted.
    return connect({ migrate });
  }
}

function connect({ migrate }) {
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA wal_autocheckpoint = 1000'); // prevents unbounded WAL growth under the watcher's frequent small appends
  db.exec(`ATTACH DATABASE '${FLAGS_DB_PATH.replaceAll('\\', '/')}' AS flagsdb`);
  // Connection mode (index worker): the main thread has already run open() and completed schema migration -> the worker connection only sets PRAGMA + ATTACH and runs no DDL.
  // This removes any reliance on discipline to avoid two concurrent migrateFtsToTrigram destructive one-time migrations colliding -- the worker never migrates (the only migrator is the main thread, before spawning).
  if (!migrate) return db;
  // Create the base schema first: a fresh DB (e.g. a new container volume) must have the tables before the ALTER migrations below have a target
  // (otherwise, on a fresh DB, ALTER TABLE sessions -> "no such table", which is re-thrown and fails the whole open())
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      size INTEGER NOT NULL DEFAULT 0,
      mtime INTEGER NOT NULL DEFAULT 0,
      offset INTEGER NOT NULL DEFAULT 0,      -- byte offset for incremental indexing
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,                    -- main session = uuid; subagent = <parent>:<agent file name>
      kind TEXT NOT NULL DEFAULT 'main',
      project TEXT NOT NULL,
      cwd TEXT,
      file TEXT NOT NULL,
      parent_session TEXT,
      agent_name TEXT,
      agent_type TEXT,
      agent_desc TEXT,                        -- meta.json description (display name for an unnamed agent)
      tool_use_id TEXT,                       -- meta.json toolUseId (exact pairing with the main conversation's tool_use.id; specific to traditional subagents)
      task_kind TEXT,                         -- meta.json taskKind (in_process_teammate = a member of an agent team)
      team_name TEXT,                         -- meta.json teamName (the team a teammate belongs to)
      model TEXT,
      title TEXT,
      title_rank INTEGER NOT NULL DEFAULT 0,  -- title source priority: 3=custom/summary 2=ai-title 1=first prompt
      first_ts TEXT,
      last_ts TEXT,
      msg_count INTEGER NOT NULL DEFAULT 0,
      user_prompts INTEGER NOT NULL DEFAULT 0,
      tool_calls INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0,
      cache_creation INTEGER NOT NULL DEFAULT 0, -- cache-creation tokens (true prompt cost = in+cache_creation+cache_read)
      git_branch TEXT,                        -- record.gitBranch (last one wins)
      agent_model TEXT,                       -- subagent meta.model (which model it ran)
      spawn_depth INTEGER,                    -- subagent meta.spawnDepth (nesting depth)
      custom_agent_type TEXT,                 -- subagent meta.customAgentType
      forked_from TEXT,                       -- upstream session (first record-level forkedFrom.sessionId)
      compact_count INTEGER NOT NULL DEFAULT 0, -- number of compact_boundary markers (>0 = this session was compacted at some point)
      size INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_forked ON sessions(forked_from);
    CREATE INDEX IF NOT EXISTS idx_sessions_last ON sessions(last_ts DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
    CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session);
    -- Default session-list query (WHERE kind='main' ORDER BY last_ts DESC): a partial index holding
    -- only main rows lets the planner walk the list in last_ts order without scanning subagent rows
    -- (kind alone is unindexed). viewer.db is a rebuildable cache, so adding an index is safe.
    CREATE INDEX IF NOT EXISTS idx_sessions_main_last ON sessions(last_ts DESC) WHERE kind = 'main';
    -- Dispatch edges: which session emitted which Agent/Task tool_use (the source of the true parent for the subagent nesting tree)
    CREATE TABLE IF NOT EXISTS agent_spawns (
      tool_use_id TEXT PRIMARY KEY,           -- the dispatch tool_use.id (globally unique)
      emitter_session TEXT NOT NULL           -- the session that emitted this dispatch (= the true parent of the dispatched subagent)
    );
    CREATE INDEX IF NOT EXISTS idx_spawns_emitter ON agent_spawns(emitter_session);
    -- Global user settings (theme/font/panel preferences, persisted across sessions)
    CREATE TABLE IF NOT EXISTS flagsdb.user_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS flagsdb.session_flags (
      session_id TEXT PRIMARY KEY,
      pinned INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL DEFAULT '[]',
      custom_title TEXT,
      note TEXT,
      updated_at TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      session_id UNINDEXED,
      uuid UNINDEXED,
      ts UNINDEXED,
      mtype UNINDEXED,
      text,
      tokenize = 'trigram'
    );
  `);
  // Column migrations for existing databases (ALTER is idempotent; placed after CREATE -> on a fresh DB the tables already exist, duplicate-column is swallowed, everything else is re-thrown)
  for (const ddl of [
    "ALTER TABLE sessions ADD COLUMN forked_from TEXT",
    "ALTER TABLE sessions ADD COLUMN compact_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE sessions ADD COLUMN cache_creation INTEGER NOT NULL DEFAULT 0", // backfill for true prompt cost
    "ALTER TABLE sessions ADD COLUMN git_branch TEXT",                           // record.gitBranch
    "ALTER TABLE sessions ADD COLUMN agent_model TEXT",                          // subagent meta.model
    "ALTER TABLE sessions ADD COLUMN spawn_depth INTEGER",                       // subagent meta.spawnDepth
    "ALTER TABLE sessions ADD COLUMN custom_agent_type TEXT",                    // subagent meta.customAgentType
    "ALTER TABLE sessions ADD COLUMN model_names TEXT",                          // JSON array of all models used
    "ALTER TABLE sessions ADD COLUMN effort TEXT",                               // latest record.perTurnEffort/effort
    "ALTER TABLE sessions ADD COLUMN effort_names TEXT",                         // JSON array of all efforts used
  ]) {
    try {
      db.exec(ddl);
    } catch (err) {
      // Only swallow duplicate-column (idempotent migration); re-throw everything else (disk full/locked/corruption)
      if (!/duplicate column/i.test(err.message)) throw err;
    }
  }
  migrateFtsToTrigram(db);
  const uvRow = db.prepare('PRAGMA user_version').get() || { user_version: 0 };
  // v0->v1: backfill for the introduction of agent_spawns
  if (uvRow.user_version < 1) {
    db.exec('DELETE FROM files');
    uvRow.user_version = 1;
  }
  // v1->v2: one-time cleanup of the legacy main.session_flags leftover (flags have moved to flagsdb)
  if (uvRow.user_version < 2) {
    db.exec('DROP TABLE IF EXISTS main.session_flags');
    uvRow.user_version = 2;
  }
  // v2->v3: backfill for the introduction of effort/effort_names (full re-read; flags.db is unaffected)
  if (uvRow.user_version < 3) {
    db.exec('DELETE FROM files');
    uvRow.user_version = 3;
  }
  // PRAGMA does not support bound parameters (prepare('... = ?') is an outright syntax error); the value is a controlled integer, so literal interpolation is safe
  if (uvRow.user_version > 0) db.exec(`PRAGMA user_version = ${Number(uvRow.user_version)}`);
  return db;
}

/** Older databases used the default unicode61 FTS tokenizer (a whole run of CJK becomes one token, so in-text search misses) -> switch to trigram and repopulate FTS.
 *  Only the files table is cleared (byte-offset reset to 0 -> the next sync does a full re-read, idempotent via replace mode); flags.db is unaffected. */
function migrateFtsToTrigram(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'messages_fts'").get();
  if (!row || /trigram/i.test(row.sql)) return;
  // One whole transaction: a restart killed midway leaves no half-applied state (the message is only logged after commit)
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DROP TABLE messages_fts');
    db.exec(`
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        session_id UNINDEXED,
        uuid UNINDEXED,
        ts UNINDEXED,
        mtype UNINDEXED,
        text,
        tokenize = 'trigram'
      );
    `);
    db.exec('DELETE FROM files');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  log.info('FTS migrated unicode61 → trigram (files cleared; next sync rebuilds all)');
}

/** Close the connection and reset the singleton (graceful shutdown / hermetic tests). */
function close() { closeQuietly(); }

module.exports = { open, close, DB_PATH };
