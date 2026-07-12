'use strict';
// Message read layer: incremental byte-cursor streaming (resume from a checkpoint instead of re-scanning the whole file) + subagent deep-link resolution
const fs = require('node:fs');
const { toMessage, countsAsMessage } = require('../parsing/parse');
const { listSubagents } = require('../repositories/sessionRepo');
const log = require('../log').scope('stream');

// ---------- byte-cursor cache ----------
// Hot path: live tail reads with a large `from` on every session_updated, and tail opens first -- originally both
// parsed the whole file from line 0 (1-3s of CPU per tick on a 300MB file). Each file records "byte offset where
// message N starts" checkpoints, so reads resume from the nearest checkpoint -> O(whole file) becomes O(appended).
// jsonl is append-only: if the file shrinks (truncated/rewritten) the cache is invalidated and rebuilt.
const CHECKPOINT_EVERY = 500;
const CURSOR_CACHE_MAX = 50;
const cursorCache = new Map(); // file → { size, checkpoints: [{index, byte}], lastIndex, lastByte }

function getCursor(file, size) {
  let c = cursorCache.get(file);
  if (c && size < c.size) c = null; // the prefix can no longer be trusted -> invalidate
  if (!c) c = { size, checkpoints: [], lastIndex: 0, lastByte: 0 };
  c.size = size;
  cursorCache.delete(file);
  cursorCache.set(file, c); // re-insert so the most-recently-used stays last (LRU)
  if (cursorCache.size > CURSOR_CACHE_MAX) {
    const oldest = cursorCache.keys().next().value;
    cursorCache.delete(oldest);
  }
  return c;
}

/** Nearest checkpoint with index <= target; falls back to the start when there is none */
function checkpointBefore(cursor, targetIndex) {
  let best = { index: 0, byte: 0 };
  for (const cp of cursor.checkpoints) {
    if (cp.index <= targetIndex) best = cp;
    else break;
  }
  return best;
}

/**
 * Shared streaming core: from (startByte, startIndex), parse each line with JSON.parse -> toMessage -> onMessage(msg, index);
 * return false to stop early. Bytes are counted manually (readline does not expose byte offsets), adding checkpoints and
 * advancing the high-water mark as it scans. An incomplete trailing line (mid-write) is naturally ignored and does not
 * advance the high-water mark -- it is re-read from that line on the next pass.
 * This is the single parse path for every read function -- empty/noise-filtering rules are changed only here.
 * `skipBuild(index)` (optional): when it returns true the caller will discard this index anyway, so the line is counted
 *  with the cheap countsAsMessage predicate and the expensive toMessage()/onMessage() are skipped. The index counter is
 *  advanced identically either way, so msg_count parity is preserved (proven by parse.test.js countsAsMessage <=> toMessage).
 */
function streamMessagesFrom(file, startByte, startIndex, cursor, onMessage, skipBuild) {
  return new Promise((resolve, reject) => {
    if (startByte >= cursor.size) return resolve();
    const stream = fs.createReadStream(file, { start: startByte, end: cursor.size - 1 });
    let carryParts = []; // buffers past the last newline, awaiting the chunk that completes the line (no newline inside any part)
    let carryLen = 0;    // total bytes held in carryParts (kept in sync so bufOffset math never needs to concat to measure)
    let streamed = 0; // total bytes received so far (including carry)
    let index = startIndex;
    let stopped = false;

    /** Append a checkpoint when passing beyond the last existing checkpoint (re-scanning an older region does not duplicate
     *  entries). Shared by the build and skip paths so both leave identical checkpoints regardless of which one counted the line. */
    function maybeCheckpoint(lineStartByte) {
      const lastCp = cursor.checkpoints.length > 0 ? cursor.checkpoints[cursor.checkpoints.length - 1].index : 0;
      if (index !== 0 && index % CHECKPOINT_EVERY === 0 && index > lastCp) {
        cursor.checkpoints.push({ index, byte: lineStartByte });
      }
    }

    /** Process one complete line; return false to stop early */
    function processLine(buf, start, nl, bufOffset) {
      const lineStartByte = bufOffset + start;
      const line = buf.subarray(start, nl).toString('utf8');
      if (!line.trim()) return true;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        return true;
      }
      // Fast path for lines the caller will discard anyway (index < from / the tail counting pass): count with the cheap
      // countsAsMessage predicate -- proven equivalent to !!toMessage by parse.test.js -- and skip toMessage()/onMessage().
      if (skipBuild?.(index)) {
        let counts;
        try {
          counts = countsAsMessage(rec);
        } catch (err) {
          log.error(`malformed record #${index} skipped (countsAsMessage): ${err.message}`);
          return true;
        }
        if (!counts) return true;
        maybeCheckpoint(lineStartByte);
        index++;
        return true;
      }
      // toMessage can also throw on a shape-malformed record. This runs inside the stream's 'data' handler, so an
      // unguarded throw escapes as an uncaughtException and crashes the whole server for every client -- guard it the
      // same way as the callback below. Skip the bad record (No-Silent-Failure: log to stderr; index is not advanced,
      // matching the JSON.parse skip above).
      let msg;
      try {
        msg = toMessage(rec);
      } catch (err) {
        log.error(`malformed record #${index} skipped (toMessage): ${err.message}`);
        return true;
      }
      if (!msg) return true;
      maybeCheckpoint(lineStartByte);
      // Treat jsonl as hostile input: if a single malformed record makes the callback throw, skip that record instead of crashing the whole service
      let keepGoing;
      try {
        keepGoing = onMessage(msg, index);
      } catch (err) {
        log.error(`malformed record #${index} skipped: ${err.message}`);
        keepGoing = true;
      }
      index++;
      return keepGoing !== false;
    }

    stream.on('data', (chunk) => {
      if (stopped) return;
      streamed += chunk.length;
      // A chunk with no newline cannot complete a line -> just accumulate it (O(1) append) instead of Buffer.concat-ing a
      // growing carry every chunk. That turns a single JSONL line spanning many chunks (a multi-MB embedded image /
      // tool_result) from O(L^2) copies into O(L): the concat happens once, only when a newline finally arrives.
      if (!chunk.includes(0x0a)) {
        carryParts.push(chunk);
        carryLen += chunk.length;
        return;
      }
      // Materialize (carryParts + chunk) once. bufOffset stays the in-file byte offset of buf[0], byte-identical to the
      // previous per-chunk concat (carryLen == the old carry length), so every checkpoint/high-water offset is unchanged.
      let buf;
      if (carryParts.length === 0) {
        buf = chunk;
      } else {
        carryParts.push(chunk);
        buf = Buffer.concat(carryParts, carryLen + chunk.length);
        carryParts = [];
        carryLen = 0;
      }
      const bufOffset = startByte + streamed - buf.length; // in-file byte offset of buf[0]
      let start = 0;
      let nl = buf.indexOf(0x0a, start);
      while (nl !== -1) {
        const cont = processLine(buf, start, nl, bufOffset);
        const lineEnd = bufOffset + nl + 1;
        // High-water: advanced for every complete line (non-message lines count too, otherwise trailing noise lines get re-scanned each pass)
        if (lineEnd > cursor.lastByte) {
          cursor.lastByte = lineEnd;
          cursor.lastIndex = index;
        }
        start = nl + 1;
        if (!cont) {
          stopped = true;
          stream.destroy();
          return resolve();
        }
        nl = buf.indexOf(0x0a, start);
      }
      const rem = buf.subarray(start);
      if (rem.length) {
        carryParts.push(Buffer.from(rem)); // copy the trailing partial line, to avoid retaining the whole buffer
        carryLen += rem.length;
      }
    });
    stream.on('end', resolve);
    stream.on('error', reject);
  });
}

/** Full-file stream (used by stats/skills/boundaries/locate); builds checkpoints along the way to benefit later pagination */
function streamMessages(file, onMessage) {
  let st;
  try {
    st = fs.statSync(file);
  } catch (err) {
    return Promise.reject(err);
  }
  return streamMessagesFrom(file, 0, 0, getCursor(file, st.size), onMessage);
}

/** Stream the jsonl messages in [from, from+limit); resumes from the nearest checkpoint and reads one extra to determine hasMore */
async function readMessages(file, from, limit) {
  const st = fs.statSync(file);
  const cursor = getCursor(file, st.size);
  const cp = checkpointBefore(cursor, from);
  const messages = [];
  let hasMore = false;
  await streamMessagesFrom(file, cp.byte, cp.index, cursor, (msg, index) => {
    if (index < from) return true;
    if (messages.length >= limit) {
      hasMore = true; // the (limit+1)th item exists -> there is a next page (does not rely on msg_count accuracy)
      return false;
    }
    messages.push(msg);
    return true;
  }, (index) => index < from); // skip building the discarded [cp.index, from) prefix
  return { messages, hasMore };
}

/**
 * Resolve an Agent/Task tool_use agentLink -> subagent session id.
 * Matching priority: meta.json toolUseId (no guessing) -> the named teammate name.
 */
/** subagents -> two lookup indexes: { tool_use_id -> id, agent_name -> id } */
function indexSubagents(subs) {
  const byToolUseId = new Map();
  const byName = new Map();
  for (const s of subs) {
    if (s.tool_use_id) byToolUseId.set(s.tool_use_id, s.id);
    if (s.agent_name) byName.set(s.agent_name, s.id);
  }
  return { byToolUseId, byName };
}

function resolveAgentLinks(sessionRow, messages) {
  const mainId = sessionRow.kind === 'subagent' ? sessionRow.parent_session : sessionRow.id;
  if (!mainId) return;
  const subs = listSubagents(mainId);
  if (subs.length === 0) return;
  const { byToolUseId, byName } = indexSubagents(subs);
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.kind !== 'tool_use' || !b.agentLink) continue;
      const link = b.agentLink;
      link.sessionId =
        (link.toolUseId && byToolUseId.get(link.toolUseId)) ||
        (link.name && byName.get(link.name)) ||
        undefined;
    }
  }
}

/** Tail read, two passes: first scan from the high-water mark to EOF to get the exact total (the first pass is a full
 *  scan that builds checkpoints, later passes only scan appended bytes), then collect the last `limit` messages from the nearest checkpoint. */
async function readTail(file, limit) {
  const st = fs.statSync(file);
  const cursor = getCursor(file, st.size);
  // Pass 1: advance the high-water mark to EOF -> cursor.lastIndex is the exact total. Only the count matters here
  // (the callback ignores the message), so skip building every message and just count with countsAsMessage.
  await streamMessagesFrom(file, cursor.lastByte, cursor.lastIndex, cursor, () => true, () => true);
  const total = cursor.lastIndex;
  const from = Math.max(0, total - limit);
  const cp = checkpointBefore(cursor, from);
  const window = [];
  await streamMessagesFrom(file, cp.byte, cp.index, cursor, (msg, index) => {
    if (index < from) return true;
    window.push(msg);
    return window.length < total - from; // stop once the window is full
  }, (index) => index < from); // skip building the [cp.index, from) prefix before the tail window
  return { messages: window, startIndex: from };
}

/** Collect the skills activated in the session (the input.skill of each Skill tool_use), aggregating counts and first-seen time */
async function listSkills(file) {
  const agg = new Map(); // name → {count, firstTs}
  await streamMessages(file, (msg) => {
    for (const b of msg.blocks) {
      if (b.kind !== 'tool_use' || b.name !== 'Skill') continue;
      const name = b.input && typeof b.input.skill === 'string' ? b.input.skill : null;
      if (!name) continue;
      const cur = agg.get(name);
      if (cur) cur.count++;
      else agg.set(name, { count: 1, firstTs: msg.ts });
    }
    return true;
  });
  return [...agg.entries()]
    .map(([name, v]) => ({ name, count: v.count, firstTs: v.firstTs }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Scan the file for the position of the first message matching the predicate (stops on hit); returns -1 when not found (a pure not-found sentinel -- real errors propagate via streamMessages reject) */
async function locateBy(file, predicate) {
  let found = -1;
  await streamMessages(file, (msg, index) => {
    if (predicate(msg)) {
      found = index;
      return false; // stop once found
    }
    return true;
  });
  return found;
}

// Locate result cache: a single locate parses the whole file up to the hit point (seconds on a large file), but the same
// call site is jumped to repeatedly (read -> jump into subagent -> jump back to the call site). The key includes mtime, so
// file growth (live tail) auto-invalidates and re-scans; caching -1 (not-found) is also safe (same mtime invalidation). The LRU cap prevents unbounded growth.
const LOCATE_CACHE_MAX = 200;
const locateCache = new Map(); // `${file}|${mtime}|${target}` → index

function locateCached(file, target, scan) {
  let mtime;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return scan(); } // file already deleted -> let scan follow the existing error path
  const key = `${file}|${mtime}|${target}`;
  if (locateCache.has(key)) {
    const v = locateCache.get(key);
    locateCache.delete(key); locateCache.set(key, v); // LRU: touch to the tail
    return Promise.resolve(v);
  }
  return scan().then((idx) => {
    locateCache.set(key, idx);
    if (locateCache.size > LOCATE_CACHE_MAX) locateCache.delete(locateCache.keys().next().value);
    return idx;
  });
}

/** Locate a message uuid's position within the file (used to jump to a search hit); returns -1 when not found */
const locateMessage = (file, targetUuid) =>
  locateCached(file, `u:${targetUuid}`, () => locateBy(file, (msg) => msg.uuid === targetUuid));

/** Locate the position of the message that dispatched a given Agent/Task (used to jump to a subagent's call site); returns -1 when not found */
const locateToolUse = (file, targetToolUseId) =>
  locateCached(file, `t:${targetToolUseId}`, () =>
    locateBy(file, (msg) => msg.blocks.some((b) => b.kind === 'tool_use' && b.id === targetToolUseId)));

/** Name-based fallback locate: for subagents/teammates whose meta.json has no toolUseId (roughly 1 in 5 in practice),
 *  find the nth Agent/Task tool_use whose input.name matches -- positional pairing, so
 *  repeated dispatches of the same name do not all jump to the first (jumping to the wrong call site is more misleading than not jumping). */
function locateAgentByName(file, agentName, nth = 1) {
  return locateCached(file, `a:${agentName}:${nth}`, () => {
    let seen = 0;
    return locateBy(file, (msg) => {
      const hit = msg.blocks.some(
        (b) =>
          b.kind === 'tool_use' &&
          (b.name === 'Agent' || b.name === 'Task') &&
          b.input && b.input.name === agentName
      );
      return hit && ++seen === nth;
    });
  });
}

/** Collect all compaction boundary nodes (message position + timestamp) -- lets a multiply-compacted session offer jump points */
async function listBoundaries(file) {
  const boundaries = [];
  await streamMessages(file, (msg, index) => {
    if (msg.origin === 'boundary') boundaries.push({ index, ts: msg.ts });
    return true;
  });
  return boundaries;
}

/** One-stop pagination + deep-link resolution. `from` may be a number or 'tail' (used to land on the latest message by default). */
async function getMessagesPage(sessionRow, from, limit) {
  let messages;
  let actualFrom;
  let hasMore;
  if (from === 'tail') {
    const tail = await readTail(sessionRow.file, limit);
    messages = tail.messages;
    actualFrom = tail.startIndex;
    hasMore = false; // already at EOF; new messages afterward are appended by live tail
  } else {
    const r = await readMessages(sessionRow.file, from, limit);
    messages = r.messages;
    actualFrom = from;
    hasMore = r.hasMore;
  }
  resolveAgentLinks(sessionRow, messages);
  return { messages, hasMore, hasOlder: actualFrom > 0, total: sessionRow.msg_count, from: actualFrom, limit };
}

/** Full-file scan aggregating tool-call counts + file-change list + deletion detection (for the stats dialog) */
const PREVIEW_MAX = 8192; // upper bound for file-content preview (8KB)
const HISTORY_MAX = 200; // per-file edit-history cap (keeps hundreds of edits per file x 20 statsCache slots from holding tens of MB resident)
/** Hostile-input guard + preview truncation: anything non-string becomes an empty string (shared by the Edit/MultiEdit/Write branches) */
const previewStr = (v) => (typeof v === 'string' ? v.slice(0, PREVIEW_MAX) : '');

// Bash rm detection (b.input may be entirely absent -- malformed-record guard); matchAll catches multiple rm on one line (rm a && rm b)
function collectBashRemovals(b, msg, deletedFiles) {
  if (b.name !== 'Bash') return;
  const cmd = b.input && typeof b.input.command === 'string' ? b.input.command : '';
  for (const l of cmd.split('\n')) {
    for (const m of l.matchAll(/(?:^|\s)rm\s+(?:-[a-zA-Z]+\s+)*['"]?([^'"\s;|&]+)['"]?/g)) {
      deletedFiles.push({ path: m[1], ts: msg.ts || '' });
    }
  }
}

// Append one edit-history entry by tool type (the Edit/MultiEdit/Write branches share the cur accumulator)
function appendEditHistory(cur, b, ts) {
  if (b.name === 'MultiEdit' && b.input && Array.isArray(b.input.edits)) {
    for (const e of b.input.edits.slice(0, 50)) { // per-MultiEdit cap of 50 to prevent bloat
      cur.history.push({ ts, type: 'edit', old: previewStr(e?.old_string), next: previewStr(e?.new_string) });
    }
    cur.edits += b.input.edits.length;
    cur.tools.add('MultiEdit');
  } else if (b.name === 'Edit' && b.input) {
    cur.history.push({ ts, type: 'edit', old: previewStr(b.input.old_string), next: previewStr(b.input.new_string) });
    cur.edits += 1;
    cur.tools.add('Edit');
  } else if (b.name === 'Write') {
    const content = previewStr(b.input.content);
    if (!cur.content && content) cur.content = content; // keep the first Write content (snapshot at creation)
    cur.history.push({ ts, type: 'write', content });
    cur.edits += 1;
    cur.tools.add('Write');
    cur.isNew = true;
  }
}

// Accumulate Edit/MultiEdit/Write file edits (updates fileOps in place); non-mutating tools are skipped
function recordFileEdit(b, msg, fileOps) {
  const fp = b.input && typeof b.input.file_path === 'string' ? b.input.file_path : null;
  if (!fp || !/^(Edit|MultiEdit|Write)$/.test(b.name)) return; // only record tools that actually modify files
  const cur = fileOps.get(fp) || { edits: 0, tools: new Set(), isNew: false, history: [], content: null };
  appendEditHistory(cur, b, msg.ts || '');
  // Per-file history cap: keep oldest first, drop the oldest when over the cap (the "oldest to newest" presentation is unchanged, and the total edits count is still tallied)
  if (cur.history.length > HISTORY_MAX) cur.history.splice(0, cur.history.length - HISTORY_MAX);
  fileOps.set(fp, cur);
}

// Accumulate stats for a single message (updates acc in place; extracted from the getSessionStats callback to reduce cognitive complexity, with identical behavior and side-effect ordering)
function accumulateStats(msg, acc) {
  acc.msgCount++;
  if (msg.ts) {
    if (!acc.firstTs) acc.firstTs = msg.ts;
    acc.lastTs = msg.ts;
  }
  // <synthetic> is a placeholder fake model for API errors; excluded from model stats
  if (msg.origin === 'assistant') { acc.assistantCount++; if (msg.model && msg.model !== '<synthetic>') acc.modelCounts.set(msg.model, (acc.modelCounts.get(msg.model) || 0) + 1); }
  if (msg.origin === 'human') acc.userMsgCount++;

  for (const b of msg.blocks) {
    if (b.kind !== 'tool_use') continue;
    acc.toolCounts.set(b.name, (acc.toolCounts.get(b.name) || 0) + 1);
    collectBashRemovals(b, msg, acc.deletedFiles);
    recordFileEdit(b, msg, acc.fileOps);
  }
}

async function getSessionStats(file) {
  const acc = {
    toolCounts: new Map(),
    modelCounts: new Map(), // model → count (tracks switching between models)
    fileOps: new Map(),
    deletedFiles: [],
    msgCount: 0, assistantCount: 0, userMsgCount: 0,
    firstTs: null, lastTs: null,
  };

  await streamMessages(file, (msg) => {
    accumulateStats(msg, acc);
    return true;
  });

  const tools = [...acc.toolCounts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  const files = [...acc.fileOps.entries()].map(([path, v]) => ({
    path,
    edits: v.edits,
    tools: [...v.tools],
    isNew: v.isNew,
    content: v.content,
    history: v.history,
  })).sort((a, b) => b.edits - a.edits);

  const models = [...acc.modelCounts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  return {
    overview: { msgCount: acc.msgCount, assistantCount: acc.assistantCount, userMsgCount: acc.userMsgCount, firstTs: acc.firstTs, lastTs: acc.lastTs },
    tools, files, deleted: acc.deletedFiles, models,
  };
}

// Result cache for expensive full-file scans, validated by (size, mtime) -- jsonl is append-only, so an unchanged file
// must yield the same result; only a changed file is re-scanned. The LRU cap prevents resident-memory bloat. Shared by
// stats/boundaries/skills so the invalidation rule lives in one place (change it once, all three stay in sync).
const RESULT_CACHE_MAX = 20;
const statsCache = new Map();      // file → { size, mtimeMs, data }
const boundariesCache = new Map();
const skillsCache = new Map();

/** (size, mtime)-validated LRU wrapper around an async full-file scan */
async function cachedByFileStat(cache, file, scan) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return scan(file); // stat failed (rare race) -> scan directly; errors are reported by the scan path
  }
  const hit = cache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
    cache.delete(file);
    cache.set(file, hit); // re-insert so the most-recently-used stays last
    return hit.data;
  }
  const data = await scan(file);
  cache.delete(file);
  cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, data });
  if (cache.size > RESULT_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  return data;
}

const getSessionStatsCached = (file) => cachedByFileStat(statsCache, file, getSessionStats);
// listBoundaries/listSkills also do a full-file scan on every call; the reader hits them repeatedly (open a
// multiply-compacted session, jump around) so cache them with the same (size, mtime) invalidation as stats.
const listBoundariesCached = (file) => cachedByFileStat(boundariesCache, file, listBoundaries);
const listSkillsCached = (file) => cachedByFileStat(skillsCache, file, listSkills);

module.exports = { getMessagesPage, listBoundaries, listBoundariesCached, listSkills, listSkillsCached, locateAgentByName, locateMessage, locateToolUse, readMessages, readTail, resolveAgentLinks, getSessionStats, getSessionStatsCached };
