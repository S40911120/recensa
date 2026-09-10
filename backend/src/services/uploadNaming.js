'use strict';

const path = require('node:path');

function normalizeUploadStem(originalName) {
  const baseName = path.basename(String(originalName || ''));
  if (path.extname(baseName).toLowerCase() !== '.jsonl') {
    throw new Error('Only .jsonl files can be uploaded');
  }
  const stem = baseName.slice(0, -'.jsonl'.length)
    .normalize('NFKC')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return stem || 'session';
}

function makeStoredFilename(originalName, suffix) {
  const token = String(suffix || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!token) throw new Error('Upload id is required');
  return `${normalizeUploadStem(originalName)}-${token}.jsonl`;
}

module.exports = { normalizeUploadStem, makeStoredFilename };
