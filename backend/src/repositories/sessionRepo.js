'use strict';
// Session query layer: list / single / project / subagents / flags / tags / search / delete (read/query SQL concentrated here;
// the write-path SQL lives in ingestion/indexer.js and the schema/DDL in storage/db.js)
const fs = require('node:fs');
const path = require('node:path');
const { open } = require('../storage/db');
const { PROJECTS_DIR } = require('../config');

function db() {
  return open();
}

function getSession(id) {
  return db().prepare('SELECT * FROM sessions WHERE id = ?').get(id) || null;
}

function getFlags(sessionId) {
  const row = db().prepare('SELECT * FROM flagsdb.session_flags WHERE session_id = ?').get(sessionId);
  return row ? { ...row, tags: JSON.parse(row.tags || '[]') } : null;
}

// Single source for the subagent column projection (shared by the listSubagents / buildSubagentTree SELECTs to prevent drift on the SQL side)
const SUBAGENT_COL_LIST = [
  'id', 'agent_name', 'agent_type', 'agent_desc', 'tool_use_id', 'task_kind', 'team_name',
  'agent_model', 'spawn_depth', 'custom_agent_type', 'title', 'msg_count', 'first_ts', 'last_ts', 'file',
];
const SUBAGENT_COLS = SUBAGENT_COL_LIST.join(', ');
const SUBAGENT_COLS_QUALIFIED = SUBAGENT_COL_LIST.map((c) => `s.${c}`).join(', '); // in a join, tool_use_id is ambiguous, so a table alias is required

function listSubagents(parentSessionId) {
  return db()
    .prepare(`SELECT ${SUBAGENT_COLS} FROM sessions WHERE parent_session = ? ORDER BY first_ts`)
    .all(parentSessionId);
}

/**
 * subagent nesting tree: all descendants are stored flat on disk in a single subagents/ level under the main session,
 * and parent_session always points at the main session (the flat pool for deep links relies on this and stays untouched).
 * agent_spawns (who emitted the dispatch) reconstructs the real spawner to rebuild the display hierarchy -- direct children hang off the root,
 * grandchildren hang under the child that spawned them.
 * Pass the main session -> get the whole tree; pass a subagent -> get only the subtree it spawned (for that subagent's own view).
 */
function buildSubagentTree(sessionId) {
  const row = getSession(sessionId);
  const mainId = row?.kind === 'subagent' ? row.parent_session : sessionId;
  if (!mainId) return [];
  const rows = db()
    .prepare(
      `SELECT ${SUBAGENT_COLS_QUALIFIED},
              sp.emitter_session AS spawner
       FROM sessions s
       LEFT JOIN agent_spawns sp ON sp.tool_use_id = s.tool_use_id
       WHERE s.parent_session = ? ORDER BY s.first_ts`
    )
    .all(mainId);
  const byId = new Map(rows.map((r) => [r.id, { ...r, children: [] }]));
  // Before attaching a node to a parent, confirm it does not create a cycle (if the parent's spawner ancestor chain already contains node, attaching would close a loop).
  // Dispatch ordering is monotonic (a child cannot spawn an ancestor), so there is normally no cycle; this guards against data anomalies that would make a subtree silently vanish / cause infinite DTO recursion.
  const wouldCycle = (parentNode, nodeId) => {
    const seen = new Set();
    let cur = parentNode;
    while (cur) {
      if (cur.id === nodeId || seen.has(cur.id)) return true;
      seen.add(cur.id);
      cur = cur.spawner && cur.spawner !== mainId ? byId.get(cur.spawner) : null;
    }
    return false;
  };
  const roots = [];
  for (const node of byId.values()) {
    // spawner points at another descendant -> hang under it (nested); points at the main session / empty / not in the pool / would cycle -> hang off the root (fallback)
    const parent = node.spawner && node.spawner !== mainId ? byId.get(node.spawner) : null;
    if (parent && !wouldCycle(parent, node.id)) parent.children.push(node);
    else roots.push(node);
  }
  // The query target is a subagent -> return only its own subtree (the grandchildren it spawned); it is the main session -> return the whole tree
  if (mainId !== sessionId) {
    const self = byId.get(sessionId);
    return self ? self.children : [];
  }
  return roots;
}

/** A query that looks like a session id (a uuid prefix) -> match by id instead of FTS. A pure hex English word (beef/dead/cafe)
 *  should not be treated as an id and swallow the in-text search -> also require a '-' or a length >= 8 (nearly all real uuid prefixes qualify).
 *  The frontend SessionList uses the matching check; change one side and you must change the other. */
const SID_LIKE_RE = /^[0-9a-fA-F-]{4,}$/;
function isSidLike(q) {
  return SID_LIKE_RE.test(q) && (q.includes('-') || q.length >= 8);
}

/** Always wrap an FTS MATCH query as a phrase (characters like '-' are FTS syntax; a uuid or mixed-script text passed raw would blow up) */
function ftsQuery(q) {
  return `"${q.replaceAll('"', '""')}"`;
}

function listSessions({ project, q, sid, model, since, until, pinnedOnly, tag, limit, offset }) {
  const params = [];
  let where = "s.kind = 'main'";
  if (project) {
    where += ' AND s.project = ?';
    params.push(project);
  }
  if (sid) {
    where += ' AND s.id LIKE ?';
    params.push(`${sid}%`);
  }
  if (model) {
    where += ' AND s.model LIKE ?';
    params.push(`%${model}%`);
  }
  if (since) {
    where += ' AND s.last_ts >= ?';
    params.push(since);
  }
  if (until) {
    where += ' AND s.last_ts <= ?';
    params.push(until);
  }
  if (q) {
    if (isSidLike(q)) {
      // uuid prefix -> match id only (FTS trigram would split a uuid into 3-grams "444"/"440"/"40b"..., causing random false-positive hits in other sessions' text)
      where += ' AND s.id LIKE ?';
      params.push(`${q}%`);
    } else {
      where += ' AND s.id IN (SELECT DISTINCT session_id FROM messages_fts WHERE messages_fts MATCH ?)';
      params.push(ftsQuery(q));
    }
  }
  if (pinnedOnly) where += ' AND COALESCE(f.pinned, 0) = 1';
  if (tag) {
    where += " AND EXISTS (SELECT 1 FROM json_each(COALESCE(f.tags,'[]')) je WHERE je.value = ?)";
    params.push(tag);
  }
  const rows = db()
    .prepare(
      // subagent_count uses a correlated subquery (via idx_sessions_parent, computed only for the LIMIT rows actually returned) --
      // replacing the previous derived table that ran a full GROUP BY aggregation over every subagent row on each query:
      // that full-table aggregation had to scan the whole thing on a cold cache (3.6GB DB) -> ~5.6s for the first page load; the correlated subquery touches only a few index pages on a cold query.
      `SELECT s.*, COALESCE(f.pinned,0) AS pinned, COALESCE(f.tags,'[]') AS tags, f.custom_title, f.note,
              (SELECT COUNT(*) FROM sessions sub WHERE sub.parent_session = s.id AND sub.kind = 'subagent') AS subagent_count
       FROM sessions s
       LEFT JOIN flagsdb.session_flags f ON f.session_id = s.id
       WHERE ${where}
       ORDER BY COALESCE(f.pinned,0) DESC, s.last_ts DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);
  return rows.map((r) => ({ ...r, tags: JSON.parse(r.tags) }));
}

function listProjects() {
  return db()
    .prepare(
      "SELECT project, COUNT(*) AS n, MAX(last_ts) AS last_ts FROM sessions WHERE kind='main' GROUP BY project ORDER BY last_ts DESC"
    )
    .all();
}

function searchMessages(q, limit) {
  return db()
    .prepare(
      `SELECT m.session_id, m.uuid, m.ts, m.mtype, snippet(messages_fts, 4, '⟦', '⟧', '…', 24) AS snip,
              s.title, s.project, s.kind, s.parent_session
       FROM messages_fts m JOIN sessions s ON s.id = m.session_id
       WHERE messages_fts MATCH ? ORDER BY m.ts DESC LIMIT ?`
    )
    .all(ftsQuery(q), limit);
}

function upsertFlags(sessionId, { pinned, tags, custom_title, note }) {
  const cur = getFlags(sessionId) || { pinned: 0, tags: [], custom_title: null, note: null };
  const pinnedFlag = pinned ? 1 : 0;
  const next = {
    pinned: pinned === undefined ? cur.pinned : pinnedFlag,
    tags: JSON.stringify(Array.isArray(tags) ? tags : cur.tags),
    custom_title: custom_title === undefined ? cur.custom_title : custom_title,
    note: note === undefined ? cur.note : note,
  };
  db()
    .prepare(
      `INSERT INTO flagsdb.session_flags (session_id, pinned, tags, custom_title, note, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(session_id) DO UPDATE SET pinned=excluded.pinned, tags=excluded.tags,
         custom_title=excluded.custom_title, note=excluded.note, updated_at=excluded.updated_at`
    )
    .run(sessionId, next.pinned, next.tags, next.custom_title, next.note);
}

function listTags() {
  return db()
    .prepare('SELECT DISTINCT je.value AS tag FROM flagsdb.session_flags f, json_each(f.tags) je ORDER BY tag')
    .all()
    .map((r) => r.tag);
}

const CHAIN_MAX_DEPTH = 20;

/** Session chain: follow forked_from upward through ancestors (nearest to furthest) + direct children (who forked from this session) */
function getChain(sessionId) {
  const pick = db().prepare('SELECT id, title, forked_from, compact_count, last_ts FROM sessions WHERE id = ?');
  const ancestors = [];
  let cur = pick.get(sessionId);
  let depth = 0;
  const seen = new Set([sessionId]);
  while (cur?.forked_from && depth < CHAIN_MAX_DEPTH) {
    if (seen.has(cur.forked_from)) break; // cycle guard (do not loop forever on a data anomaly)
    seen.add(cur.forked_from);
    const parent = pick.get(cur.forked_from);
    if (!parent) {
      ancestors.push({ id: cur.forked_from, title: null, compact_count: 0, missing: true });
      break;
    }
    ancestors.push({ id: parent.id, title: parent.title, compact_count: parent.compact_count, missing: false });
    cur = parent;
    depth++;
  }
  const children = db()
    .prepare("SELECT id, title, compact_count, last_ts FROM sessions WHERE forked_from = ? AND kind = 'main' ORDER BY last_ts")
    .all(sessionId);
  return { ancestors, children };
}

/**
 * Containment guard for deleteSession's recursive+force rmSync of the subagents directory.
 * The subagents dir is `<dirname(mainFile)>/<id>`. A pathologically-named indexed row (an id that resolves to `..`, an
 * absolute path, or one embedding a separator) could otherwise make the join climb out and let rmSync recurse+force
 * OUTSIDE the projects root. Resolve the real target and assert it is (a) strictly inside PROJECTS_DIR -- the root
 * itself is NOT an allowed target -- and (b) named exactly `id`; throw otherwise. Returns the safe absolute path.
 */
function resolveSubagentDir(mainFile, id) {
  const root = path.resolve(PROJECTS_DIR);
  const target = path.resolve(path.dirname(mainFile), id);
  if (target === root || !target.startsWith(root + path.sep) || path.basename(target) !== id) {
    throw new Error(`refusing recursive delete outside the projects root: ${target}`);
  }
  return target;
}

/**
 * Delete a session (the only explicit exception to the read-only rule; irreversible).
 * Three guards: a member of a fork/resume chain is refused, a subagent cannot be deleted on its own, a pinned session is refused.
 * Scope: the main jsonl + the subagents directory + index rows + flags.
 */
function deleteSession(id) {
  const row = getSession(id);
  if (!row) return { ok: false, code: 404, error: 'session not found' };
  if (row.kind !== 'main') {
    return { ok: false, code: 400, error: 'Subagent records belong to the main session and cannot be deleted individually' };
  }
  const chain = getChain(id);
  if (chain.ancestors.length > 0 || chain.children.length > 0) {
    return { ok: false, code: 409, error: 'This session is part of a fork/resume chain (has upstream or branches) and cannot be deleted' };
  }
  const flags = getFlags(id);
  if (flags?.pinned === 1) {
    return { ok: false, code: 409, error: 'Pinned sessions cannot be deleted; unpin first' };
  }
  const d = db();
  // Enumerate the main + descendant ids precisely (no LIKE: avoids an id containing %/_ wildcards or a prefix collision deleting the wrong session)
  const ids = [id, ...d.prepare('SELECT id FROM sessions WHERE parent_session = ?').all(id).map((r) => r.id)];
  // Delete the source files (main jsonl + subagents directory); the paths come from the index scan and are always under projects. Files first, then index:
  // if the index cleanup fails after the files are gone, the next tick's deletion reconciliation compensates by clearing the index (no ghosts left behind).
  // Guard the recursive+force delete before touching anything: if the indexed row's file/id would resolve outside the
  // projects root, refuse and delete nothing (fail-safe -- a corrupt/hostile index row must never wipe outside data).
  let subagentDir;
  try {
    subagentDir = resolveSubagentDir(row.file, id);
  } catch (err) {
    return { ok: false, code: 400, error: `Refusing to delete this session: ${err.message}` };
  }
  fs.rmSync(row.file, { force: true });
  fs.rmSync(subagentDir, { recursive: true, force: true });
  // flagsdb.session_flags cleanup is left to the main thread (the sole writer of flagsdb; a single autocommit statement does not lock viewer.db main)
  d.prepare('DELETE FROM flagsdb.session_flags WHERE session_id = ?').run(id);
  // viewer.db index cleanup (fts/files/sessions/spawns) is handed to the index worker (the sole writer of viewer.db) -> eliminating the delete-vs-reconcile double-write race.
  // Returns ids for the route to dispatch; the worker broadcasts session_removed on completion.
  return { ok: true, ids };
}

function getSettings() {
  const rows = db().prepare('SELECT key, value FROM flagsdb.user_settings').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

function setSettings(updates) {
  const d = db();
  const stmt = d.prepare('INSERT OR REPLACE INTO flagsdb.user_settings (key, value) VALUES (?, ?)');
  // DEFERRED (not IMMEDIATE): only writes flagsdb.user_settings, without pre-locking viewer.db main
  // (BEGIN IMMEDIATE, even when only writing flags, still holds the viewer.db main write lock -> blocking one of the index worker's write windows)
  d.exec('BEGIN');
  try {
    for (const [k, v] of Object.entries(updates)) {
      if (v != null) stmt.run(k, String(v));
    }
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { getSession, getFlags, isSidLike, listSubagents, buildSubagentTree, listSessions, listProjects, searchMessages, upsertFlags, listTags, getChain, resolveSubagentDir, deleteSession, getSettings, setSettings };
