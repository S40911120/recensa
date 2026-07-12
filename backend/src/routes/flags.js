'use strict';
const { Router } = require('express');
const repo = require('../repositories/sessionRepo');

const router = Router();

// Length caps aligned with the frontend (the maxLength on TitleFlags/SessionNote only guards the UI; hitting the API directly relies on these)
const MAX_TITLE_LEN = 160;
const MAX_NOTE_LEN = 2000;
const MAX_TAGS = 20;
const MAX_TAG_LEN = 40;

router.put('/api/session/:id/flags', (req, res) => {
  const row = repo.getSession(req.params.id);
  if (!row) return res.status(404).json({ error: 'session not found' });
  const body = req.body || {};
  // Reject non-string custom_title/note up front (null/undefined stay valid: undefined = leave unchanged,
  // null = clear). Otherwise a non-string skips the length cap and reaches the node:sqlite bind, which throws
  // a TypeError → uncaught 500 instead of a clean 400 validation error.
  if (body.custom_title != null && typeof body.custom_title !== 'string') {
    return res.status(400).json({ error: 'Title must be a string' });
  }
  if (body.note != null && typeof body.note !== 'string') {
    return res.status(400).json({ error: 'Note must be a string' });
  }
  if (typeof body.custom_title === 'string' && body.custom_title.length > MAX_TITLE_LEN) {
    return res.status(400).json({ error: `Title exceeds ${MAX_TITLE_LEN} characters` });
  }
  if (typeof body.note === 'string' && body.note.length > MAX_NOTE_LEN) {
    return res.status(400).json({ error: `Note exceeds ${MAX_NOTE_LEN} characters` });
  }
  if (Array.isArray(body.tags) && (body.tags.length > MAX_TAGS || body.tags.some((t) => typeof t !== 'string' || t.length > MAX_TAG_LEN))) {
    return res.status(400).json({ error: `Too many tags (max ${MAX_TAGS}, each up to ${MAX_TAG_LEN} characters)` });
  }
  repo.upsertFlags(row.id, {
    pinned: body.pinned,
    tags: body.tags,
    custom_title: body.custom_title,
    note: body.note,
  });
  res.json({ ok: true });
});

router.get('/api/tags', (_req, res) => res.json(repo.listTags()));

module.exports = router;
