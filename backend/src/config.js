'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveProjectsDir } = require('@recensa/claude-session');

// Codex session root: RECENSA_CODEX_SESSIONS_DIR -> CODEX_HOME/sessions -> ~/.codex/sessions.
// Unlike PROJECTS_DIR this is optional (Codex may not be installed) -> no fail-fast validation here;
// a missing directory just yields zero Codex sessions (handled by the indexer's target enumeration).
function resolveCodexSessionsDir() {
  if (process.env.RECENSA_CODEX_SESSIONS_DIR) return process.env.RECENSA_CODEX_SESSIONS_DIR;
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'sessions');
}

// resolveProjectsDir({validate:true}) only checks existence; a path that exists but is a
// FILE (a botched volume mount) would pass it and then die much later as a bare ENOTDIR
// in the index worker while /api/health stays green. Fail fast here with the fix in hand.
function resolveProjectsDirStrict() {
  const dir = resolveProjectsDir({ validate: true });
  if (!fs.statSync(dir).isDirectory()) {
    throw new Error(`Session JSONL root is not a directory: ${dir}\n  → the volume mount is wrong (-v .../.claude:/data/claude) or RECENSA_PROJECTS_DIR points at a file`);
  }
  return dir;
}

module.exports = {
  PORT: Number(process.env.SESSION_VIEWER_PORT || 7788),
  // Binds loopback only by default (a local service); inside a container, set SESSION_VIEWER_HOST=0.0.0.0 so a published port can reach it.
  // security.js's Host/Origin allowlist is a browser-trust / DNS-rebinding defense (it stops a malicious web page from scripting this
  // origin) -- it is NOT network access control and does not authenticate callers. Binding 0.0.0.0 for LAN/hosted use exposes the API to
  // anyone who can reach the port, so front it with an added credential or an authenticating reverse proxy.
  HOST: process.env.SESSION_VIEWER_HOST || '127.0.0.1',
  // Root directory of the session JSONL files (single source of truth: resolveProjectsDir in claude-session/lib/resolver)
  // Precedence: RECENSA_PROJECTS_DIR -> CLAUDE_CONFIG_DIR/projects -> ~/.claude/projects; fail-fast at startup if missing or not a directory
  PROJECTS_DIR: resolveProjectsDirStrict(),
  CODEX_SESSIONS_DIR: resolveCodexSessionsDir(),
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
