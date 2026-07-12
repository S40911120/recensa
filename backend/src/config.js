'use strict';
const path = require('node:path');
const { resolveProjectsDir } = require('@recensa/claude-session');

module.exports = {
  PORT: Number(process.env.SESSION_VIEWER_PORT || 7788),
  // Binds loopback only by default (a local service); inside a container, set SESSION_VIEWER_HOST=0.0.0.0 so a published port can reach it.
  // security.js's Host/Origin allowlist is a browser-trust / DNS-rebinding defense (it stops a malicious web page from scripting this
  // origin) -- it is NOT network access control and does not authenticate callers. Binding 0.0.0.0 for LAN/hosted use exposes the API to
  // anyone who can reach the port, so front it with an added credential or an authenticating reverse proxy.
  HOST: process.env.SESSION_VIEWER_HOST || '127.0.0.1',
  // Root directory of the session JSONL files (single source of truth: resolveProjectsDir in claude-session/lib/resolver)
  // Precedence: RECENSA_PROJECTS_DIR -> CLAUDE_CONFIG_DIR/projects -> ~/.claude/projects; validate = check at startup and fail-fast if missing
  PROJECTS_DIR: resolveProjectsDir({ validate: true }),
  // viewer.db + flags.db live here. Overridable (RECENSA_DATA_DIR) for container volume placement and hermetic tests;
  // default unchanged (backend/data, the path the Docker volume mounts), so leaving the env unset is a no-op.
  DATA_DIR: process.env.RECENSA_DATA_DIR || path.join(__dirname, '..', 'data'),
  // public (the frontend build output) stays at the package root, shared by backend/ and frontend/; backend/src -> two levels up
  PUBLIC_DIR: path.join(__dirname, '..', '..', 'public'),
  PAGE_SIZE_MAX: 500,
  TITLE_MAX: 160,
  FTS_TEXT_MAX: 2000, // per-message character cap for FTS (huge tool outputs are only indexed at the head, trading completeness for size and build speed)
  INTEL_TIMEOUT_MS: 60_000,
  INTEL_MAX_BUFFER: 32 * 1024 * 1024,
  WATCH_STABILITY_MS: 400,
};
