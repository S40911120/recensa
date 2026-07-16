'use strict';
// Express assembly layer: security middleware + the route modules + static frontend
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { PUBLIC_DIR } = require('./config');
const { getSettings } = require('./repositories/sessionRepo');
const { isAllowedRequest } = require('./security');
const log = require('./log').scope('http');

/** Zero FOUC on first paint: inject the DB theme into the <html> attributes when serving index.html.
 *  On a cold-start browser (no localStorage) the theme source of truth is the DB; waiting for the frontend to fetch it would flash the default light theme first.
 *  index.html's pre-paint script can only help returning visitors (who already have a localStorage value). */
let indexCache = { mtimeMs: 0, html: '' };
const safeAttr = (v) => (typeof v === 'string' && /^[\w-]{1,32}$/.test(v) ? v : null); // allowlist that guards the value against injection
// List of dark themes (used to derive data-scheme) -- kept in sync with the frontend Settings THEMES / index.html pre-paint
const DARK_THEMES = new Set(['dracula', 'monokai', 'onedark', 'tokyonight', 'gruvbox', 'nord', 'githubdark', 'mocha', 'solarizeddark', 'rosepine']);

function renderIndex() {
  const file = path.join(PUBLIC_DIR, 'index.html');
  const st = fs.statSync(file);
  if (st.mtimeMs !== indexCache.mtimeMs) {
    indexCache = { mtimeMs: st.mtimeMs, html: fs.readFileSync(file, 'utf8') };
  }
  let attrs = '';
  try {
    const s = getSettings();
    const theme = safeAttr(s.theme);
    const fontSize = safeAttr(s.fontSize);
    if (theme) attrs += ` data-theme="${theme}" data-scheme="${DARK_THEMES.has(theme) ? 'dark' : 'light'}"`;
    if (fontSize) attrs += ` data-font-size="${fontSize}"`;
  } catch {
    // DB not ready (before the first index) -> serve with the default theme
  }
  return indexCache.html.replace('<html lang="en">', `<html lang="en"${attrs}>`);
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');

  // DNS rebinding + CSRF protection: reject any request whose Host/Origin is off the allowlist, and require a present
  // Origin on mutating methods (binding to 127.0.0.1 is not a security boundary). See security.isAllowedRequest.
  // Rejections are logged (rate-limited, header values sanitized against log injection): a reverse-proxy /
  // custom-domain deploy that forgot RECENSA_ALLOWED_HOSTS otherwise sees only browser-side 403s with a clean
  // server log — no thread to pull on.
  const sanitizeHeader = (v) => String(v ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 100);
  let lastRejectLogAt = 0;
  app.use((req, res, next) => {
    if (!isAllowedRequest({ host: req.headers.host, origin: req.headers.origin, method: req.method })) {
      const now = Date.now();
      if (now - lastRejectLogAt > 60_000) {
        lastRejectLogAt = now;
        log.warn(`rejected request — Host "${sanitizeHeader(req.headers.host)}" Origin "${sanitizeHeader(req.headers.origin)}" not on the allowlist; if this is your reverse-proxy or LAN hostname, add it to RECENSA_ALLOWED_HOSTS`);
      }
      return res.status(403).json({ error: 'forbidden host' });
    }
    next();
  });

  app.use(express.json({ limit: '1mb' }));
  app.use(require('./routes/system'));
  app.use(require('./routes/sessions'));
  app.use(require('./routes/flags'));
  app.use(require('./routes/search'));
  // Serve the theme-injected index.html (must intercept '/' before the static handler)
  app.get(['/', '/index.html'], (_req, res, next) => {
    try {
      res.type('html').send(renderIndex());
    } catch (err) {
      next(err);
    }
  });
  app.use(express.static(PUBLIC_DIR));

  // Centralized error handling: internal details go only to the server log, never to the client (Express identifies error middleware by the 4-argument signature)
  app.use((err, _req, res, _next) => {
    log.error(err.stack || err.message);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}

module.exports = { createApp };
