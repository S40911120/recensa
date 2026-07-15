# Changelog

All notable changes to Recensa are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions are date-tagged until
a public release cadence is set.

## [Unreleased]

### Fixed
- **Linux: container could not read `~/.claude/projects`** — the image ran as a
  fixed uid (1001), while `~/.claude/projects` is created owner-only (700/600) by
  the host Claude Code CLI, so any host uid other than 1001 (in practice, almost
  everyone) hit `EACCES` on every file. The container now starts as root and
  `docker-entrypoint.sh` re-homes its internal user to match the bind-mounted
  directory's actual uid/gid before dropping privileges via `gosu` — no
  configuration required, including under rootless Docker's uid remapping, since
  detection reads whatever the container itself sees rather than assuming a fixed
  number. `PUID`/`PGID` remain available to force a specific uid/gid. The bind
  mount also picks up the standard SELinux relabel option (`:z` / `bind.selinux:
  z`), fixing the same symptom on SELinux-enforcing hosts (RHEL/Fedora/CentOS,
  Podman) where uid/gid alone isn't sufficient. Not applicable to macOS/Windows
  Docker Desktop. (#15)

## [0.1.0] — 2026-07-12

First public release.

### Added
- Session statistics dialog: tool distribution, file edits/creates/deletes,
  model-usage ranking, token cost estimate — poster-style responsive layout
- Navigation snapshot cache: returning from a subagent (or trail navigation)
  restores the loaded window and scroll position instead of reloading
- Distinct-model tracking per session (`model_names`), surfaced in the info panel
- Name-plus-ordinal spawn-call location for subagents whose meta lacks a toolUseId
- Keyboard skip-links to the reader and info panel; focus-visible on floating nav
- Async tool-response pairing: tool_use and its tool_result share a colored left
  rail and the result row shows the call summary (filename / pattern / command)
- Self-hosted fonts (JetBrains Mono for code/data; Bricolage Grotesque for the
  Recensa wordmark); design tokens for a 6-step type scale and per-theme chart palette
- Backend unit tests (`node:test`) locking the `msg_count` alignment invariant;
  wired into `ops.js check`

### Changed
- **Renamed package `session-viewer` → `recensa`**
- Read path rebuilt on a per-session byte cursor: live tail and tail-open no
  longer re-parse the whole file from line 0 (multi-second CPU per tick on large
  sessions eliminated)
- Statistics endpoint double-cached (file mtime/size backend, `last_ts` frontend)
- Reader/MessageItem split into focused modules (landmark cards, breadcrumb,
  reading-position hook); shared `useAsyncResource`, `SectionHeader`,
  `CopyIconButton`, date formatters extracted
- `dark:` variant decoupled from a specific theme name (`data-scheme`)
- Zero-FOUC theme: injected server-side into `<html>` at request time

### Fixed
- Statistics dialog now restores focus to its trigger on close (Radix Dialog)
- Optimistic pin/tag updates roll back on save failure
- Server-side length/enum validation on settings and flags endpoints
- Startup catch-up sync (previously failing silently due to a PRAGMA bug)

### Security
- CSRF write-gate: mutating requests (POST/PUT/DELETE/PATCH) now require an `Origin`
  header that is present and on the Host/Origin allowlist, so a cross-origin page cannot
  drive state-changing calls against the local server. GET/HEAD are unchanged; the same
  rule guards the WebSocket upgrade
