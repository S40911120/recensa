'use strict';
const { Router } = require('express');
const indexService = require('../services/indexService');
const repo = require('../repositories/sessionRepo');
const log = require('../log').scope('system');

const router = Router();

// Health reflects real usability, not just "HTTP responds": an index worker stuck in a
// crash-loop means an empty/stale UI, so it flips health to 503 (the Docker healthcheck
// then surfaces it as an unhealthy container instead of a silent green).
router.get('/api/health', (_req, res) => {
  const index = indexService.getStatus();
  res.status(index.workerHealthy ? 200 : 503).json({ ok: index.workerHealthy, ts: new Date().toISOString(), index });
});

router.get('/api/settings', (_req, res) => {
  try { res.json(repo.getSettings()); } catch (err) {
    log.error(`GET /api/settings failed: ${err?.message || err}`);
    res.status(500).json({ error: 'Failed to read settings' });
  }
});

// Enum allowlist for setting values: reject illegal values at the write side (defense in depth -- safeAttr in renderIndex on the inject side is the second layer)
const SETTING_VALUES = {
  fontSize: new Set(['sm', 'md', 'lg']),
  theme: new Set(['classic', 'solarized', 'catppuccin', 'githublight', 'dracula', 'monokai', 'onedark', 'tokyonight', 'gruvbox', 'nord', 'githubdark', 'mocha', 'solarizeddark', 'rosepine']),
  scrollToLatest: new Set(['0', '1']),
};

router.put('/api/settings', (req, res) => {
  try {
    const safe = {};
    for (const [k, valid] of Object.entries(SETTING_VALUES)) {
      if (req.body[k] == null) continue;
      const v = String(req.body[k]);
      if (!valid.has(v)) return res.status(400).json({ error: `Invalid setting value: ${k}` });
      safe[k] = v;
    }
    repo.setSettings(safe);
    res.json({ ok: true });
  } catch (err) {
    log.error(`PUT /api/settings failed: ${err?.message || err}`);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// reindex: fire-and-forget (the heavy work is in the index worker and does not block the response); returns the current index status
router.post('/api/reindex', (_req, res) => {
  indexService.requestSync({ reconcile: true });
  res.json(indexService.getStatus());
});

// Index status (the frontend banner / Settings shows "indexing X/Y"; used for the initial query/polling outside the WS index_progress stream)
router.get('/api/index-status', (_req, res) => res.json(indexService.getStatus()));

module.exports = router;
