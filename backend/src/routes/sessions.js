'use strict';
const { Router } = require('express');
const { PAGE_SIZE_MAX } = require('../config');
const { toSessionDto, toSessionListItemDto, toSubagentTreeDto } = require('../repositories/sessionMappers');
const { getMessagesPage, listBoundariesCached, listSkillsCached, locateAgentByName, locateMessage, locateToolUse, getSessionStatsCached } = require('../services/messageService');
const { ensureReconstructed, ReconstructError } = require('../services/reconstructService');
const repo = require('../repositories/sessionRepo');
const indexService = require('../services/indexService');
const log = require('../log').scope('sessions');

function parsePageParams(req) {
  return {
    from: req.query.from === 'tail' ? 'tail' : Math.max(Number(req.query.from) || 0, 0),
    // Clamp the bounds: a negative/0 limit would make the pagination early-stop condition true immediately and always return an empty page
    limit: Math.max(1, Math.min(Number(req.query.limit) || 100, PAGE_SIZE_MAX)),
  };
}

/** Shared error response for the reconstruct endpoints: pass through 4xx semantic errors, everything else is 500 */
function reconstructErrorResponse(res, err, sessionId, label) {
  if (err instanceof ReconstructError) {
    return res.status(err.status).json({ error: err.message });
  }
  log.error(`${label} ${sessionId}: ${err.message}`);
  return res.status(500).json({ error: 'Failed to reconstruct conversation' });
}

const router = Router();

router.get('/api/sessions', (req, res) => {
  try {
    const s = (k) => (req.query[k] ? String(req.query[k]) : null);
    const rows = repo.listSessions({
      project: s('project'),
      q: s('q'),
      sid: s('sid'),
      model: s('model'),
      since: s('since'),
      until: s('until'),
      pinnedOnly: req.query.pinned === '1',
      tag: s('tag'),
      limit: Math.min(Number(req.query.limit) || 50, PAGE_SIZE_MAX),
      offset: Number(req.query.offset) || 0,
    });
    res.json(rows.map(toSessionListItemDto));
  } catch (err) {
    if (/fts|match|malformed/i.test(err.message)) {
      res.status(400).json({ error: 'Invalid search syntax' });
    } else {
      log.error(`list failed: ${err.message}`);
      res.status(500).json({ error: 'Server error' });
    }
  }
});

router.get('/api/projects', (_req, res) => res.json(repo.listProjects()));

router.get('/api/session/:id', (req, res) => {
  const row = repo.getSession(req.params.id);
  if (!row) return res.status(404).json({ error: 'session not found' });
  res.json({
    ...toSessionDto(row),
    flags: repo.getFlags(row.id),
    subagents: repo.buildSubagentTree(row.id).map(toSubagentTreeDto),
    chain: repo.getChain(row.id),
  });
});

router.delete('/api/session/:id', (req, res) => {
  try {
    const result = repo.deleteSession(req.params.id);
    if (!result.ok) return res.status(result.code).json({ error: result.error });
    indexService.deleteIndex(result.ids, req.params.id); // viewer.db index cleanup is handed to the index worker (the sole writer); it broadcasts session_removed on completion
    res.json({ ok: true });
  } catch (err) {
    log.error(`delete ${req.params.id}: ${err.message}`);
    res.status(500).json({ error: 'Delete failed' });
  }
});

router.get('/api/session/:id/messages', async (req, res) => {
  const row = repo.getSession(req.params.id);
  if (!row) return res.status(404).json({ error: 'session not found' });
  indexService.touchHot(row.file); // a viewed session -> hot set -> the watcher's hot tick gives near-instant live-tail (no full scan)
  const { from, limit } = parsePageParams(req);
  // A numeric `from` at/beyond the indexed message high-water can only ever return an empty page, so
  // short-circuit it: a huge ?from=<N> otherwise scans the whole file to find nothing. Safe for live tail
  // because the indexer commits msg_count before broadcasting session_updated, so a genuinely new appended
  // message always leaves the loaded count below msg_count (from < msg_count) and takes the normal path.
  if (typeof from === 'number' && from >= row.msg_count) {
    return res.json({ messages: [], hasMore: false, hasOlder: from > 0, total: row.msg_count, from, limit });
  }
  try {
    res.json(await getMessagesPage(row, from, limit));
  } catch (err) {
    log.error(`messages ${row.id}: ${err.message}`);
    res.status(500).json({ error: 'Failed to read messages' });
  }
});

// The skills used in this session (aggregated from Skill tool_use)
router.get('/api/session/:id/skills', async (req, res) => {
  const row = repo.getSession(req.params.id);
  if (!row) return res.status(404).json({ error: 'session not found' });
  try {
    res.json(await listSkillsCached(row.file));
  } catch (err) {
    log.error(`skills ${row.id}: ${err.message}`);
    res.status(500).json({ error: 'Failed to scan skills' });
  }
});

// Locate a message position: one of uuid (search hit) / toolUseId (subagent call site) / agentName (name fallback when there is no toolUseId)
router.get('/api/session/:id/locate', async (req, res) => {
  const row = repo.getSession(req.params.id);
  if (!row) return res.status(404).json({ error: 'session not found' });
  const uuid = String(req.query.uuid || '');
  const toolUseId = String(req.query.toolUseId || '');
  const agentName = String(req.query.agentName || '').slice(0, 256); // length cap (defense in depth against over-long scan abuse)
  // Position among repeated dispatches of the same name (the nth matching tool_use); defaults to 1
  const nth = Math.max(1, Math.min(Number(req.query.nth) || 1, 10000));
  if (!uuid && !toolUseId && !agentName) return res.status(400).json({ error: 'Missing uuid, toolUseId or agentName' });
  try {
    let index;
    if (uuid) {
      index = await locateMessage(row.file, uuid);
    } else if (toolUseId) {
      index = await locateToolUse(row.file, toolUseId);
    } else {
      index = await locateAgentByName(row.file, agentName, nth);
    }
    if (index < 0) return res.status(404).json({ error: 'Message not found' });
    res.json({ index });
  } catch (err) {
    log.error(`locate ${row.id}: ${err.message}`);
    res.status(500).json({ error: 'Locate failed' });
  }
});

// List of compaction boundary nodes (jump points for a multiply-compacted session; reconstructed=1 reads the reconstructed cache)
router.get('/api/session/:id/boundaries', async (req, res) => {
  const row = repo.getSession(req.params.id);
  if (!row) return res.status(404).json({ error: 'session not found' });
  try {
    const file = req.query.reconstructed === '1' ? await ensureReconstructed(row) : row.file;
    res.json(await listBoundariesCached(file));
  } catch (err) {
    reconstructErrorResponse(res, err, row.id, 'boundaries');
  }
});

// Reconstructed view: the full pre-compaction conversation merged along the fork chain (opened in a separate tab; reads the reconstruct cache)
router.get('/api/session/:id/reconstructed/messages', async (req, res) => {
  const row = repo.getSession(req.params.id);
  if (!row) return res.status(404).json({ error: 'session not found' });
  const { from, limit } = parsePageParams(req);
  try {
    const file = await ensureReconstructed(row, { force: req.query.refresh === '1' });
    // No indexed total value -> use 0 (pagination relies on hasMore/hasOlder; total is display-only)
    res.json(await getMessagesPage({ ...row, file, msg_count: 0 }, from, limit));
  } catch (err) {
    reconstructErrorResponse(res, err, row.id, 'reconstructed');
  }
});

// Session stats: tool-call ranking + file-change list (aggregated in a single backend file scan; the high-IO work stays off the frontend)
router.get('/api/session/:id/stats', async (req, res) => {
  const row = repo.getSession(req.params.id);
  if (!row) return res.status(404).json({ error: 'session not found' });
  try {
    res.json(await getSessionStatsCached(row.file));
  } catch (err) {
    log.error(`stats ${row.id}: ${err.message}`);
    res.status(500).json({ error: 'Failed to compute statistics' });
  }
});

module.exports = router;
