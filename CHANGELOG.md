# Changelog

All notable changes to Recensa are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions are date-tagged until
a public release cadence is set.

## [Unreleased]

### Added
- **Reasoning effort**: the effort level Claude Code records on each assistant turn
  (`perTurnEffort` / `effort`, e.g. `medium` / `xhigh` / `max`) is now shown next to
  the model — in each reply's meta line and as an *Effort* row in the session
  overview (with any other levels used when `/effort` was switched mid-session).
  Transcripts written before Claude Code recorded the field, and models without an
  effort setting, show `—`.

### Upgrade notes
- `viewer.db` gains `effort` / `effort_names` columns; the first start after
  upgrading re-reads every transcript once to backfill them. `flags.db` is untouched.

## [0.1.2] — 2026-07-16

Deploy-robustness release: a broad review across deployment environments (native
Linux, Docker Desktop, rootless Docker/Podman, NAS, WSL2) focused on one goal —
anyone can deploy quickly and diagnose failures from the logs alone.

### Upgrade notes

No data migration is required from 0.1.0 or 0.1.1. Both databases carry over as-is
(`flags.db` is never touched; the `viewer.db` schema is unchanged), and data-volume
file ownership from the 0.1.0 fixed-uid era is corrected automatically at container
start. One action may be required:

- **If you access the UI via a custom hostname such as `sessions.local`** (as the
  0.1.0 README once suggested), that name is no longer on the built-in Host
  allowlist and requests will return 403 after upgrading. Set
  `RECENSA_ALLOWED_HOSTS=<your-hostname>` and restart. Access via
  `http://localhost:<port>` needs no change.

### Fixed
- **Rootless Docker / Podman**: the container now detects a rootless engine (via
  `/proc/self/uid_map`) and runs as container root — which maps to the unprivileged
  host user and is typically the only uid able to read the owner-only mount.
  Explicit `PUID=0` is also honored now instead of being rejected.
- **`docker run` without `-e RECENSA_PROJECTS_DIR` crashed**: the image now bakes in
  `/data/claude/projects` (the documented mount target), so the flag is unnecessary
  — the README one-liners dropped it.
- **Mount pointing at a file (or missing) failed far from the cause**: the
  entrypoint now calls out a missing or non-directory mount at the top of the logs,
  and the server fails fast at startup on a non-directory projects root instead of
  dying later as a bare `ENOTDIR` in the index worker.
- **`/api/health` stayed green while the index worker crash-looped**: worker
  respawns now back off exponentially, and five consecutive crashes flip health to
  503 instead of "healthy but the UI is empty". The health probe now ships as a
  Dockerfile `HEALTHCHECK`, so every deploy path — `docker run` included — reports
  an unhealthy container, not only the from-source Compose file.
- **Reverse-proxy / custom-hostname 403s were silent server-side**: rejected
  Host/Origin values are now logged (rate-limited, sanitized) with a pointer to
  `RECENSA_ALLOWED_HOSTS`.
- **Server-side theme injection (zero-FOUC) silently did nothing**: the injection
  anchor still targeted the pre-0.1.0 `lang="zh-Hant"` html tag and never matched
  after the UI moved to `lang="en"` — cold loads flashed the default theme before
  the frontend applied the saved one.

### Added
- Startup read probe: transcripts with a different owner than the directory (e.g.
  created via `sudo claude`) now produce one clear warning with the `chown` fix,
  instead of silent per-file `EACCES` skips.
- Distinct empty states in the session list: "no sessions yet" (with indexing /
  mount guidance) vs "no matching sessions" (filters active).
- README: Upgrading section, prebuilt-image Compose example, rootless/Podman and
  sudo-owned-files troubleshooting, WSL2 and cmd.exe notes, Compose v2 requirement,
  and docker-native equivalents for repo-less deploys.

### Changed
- Docker Desktop (macOS/Windows): the root-owned-mount fallback message is now an
  informational line explaining it is the expected path there, not a warning.
- `sessions.local` removed from the built-in Host allowlist (a development
  leftover); use `RECENSA_ALLOWED_HOSTS` for custom hostnames.
- `EADDRINUSE` and database-open failures now say which knob to turn
  (`RECENSA_HOST_PORT` / data-volume mount) instead of a bare error.

## [0.1.1] — 2026-07-16

### Fixed
- **Linux: container could not read `~/.claude/projects`** — the image ran as a
  fixed uid (1001), while `~/.claude/projects` is created owner-only (700/600) by
  the host Claude Code CLI, so any host uid other than 1001 (in practice, almost
  everyone) hit `EACCES` on every file. The container now starts as root and
  `docker-entrypoint.sh` re-homes its internal user to match the bind-mounted
  directory's actual uid/gid before dropping privileges via `gosu` — no
  configuration required on rootful engines (rootless engines remained broken
  until 0.1.2). `PUID`/`PGID` remain available to force a specific uid/gid. The bind
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
