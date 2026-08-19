'use strict';
const { Router } = require('express');
const { PAGE_SIZE_MAX } = require('../config');
const repo = require('../repositories/sessionRepo');
const log = require('../log').scope('search');

const router = Router();

router.get('/api/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json([]);
  // A uuid prefix query is a poor fit for in-text search (trigram 3-grams "444"/"440"/"40b"... would randomly false-positive against unrelated content)
  if (repo.isSidLike(q)) return res.json([]);
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, PAGE_SIZE_MAX));
  const source = req.query.source ? String(req.query.source) : null;
  try {
    res.json(repo.searchMessages(q, limit, source));
  } catch (err) {
    log.error(err.message);
    if (/fts|match|malformed/i.test(err.message)) {
      res.status(400).json({ error: 'Invalid search syntax' });
    } else {
      res.status(500).json({ error: 'Server error' });
    }
  }
});

module.exports = router;
