#!/bin/sh
# Image starts as root; this resolves the right uid/gid, then drops privileges before exec'ing node.
#
# On Linux, `~/.claude/projects` is created owner-only (dirs 700, files 600) by the
# host Claude Code CLI, so the container must run under a matching uid/gid to read
# it. Resolution order: an explicit PUID/PGID always wins; otherwise stat the actual
# mounted directory and match whatever uid/gid it shows from inside this container's
# namespace; if the mount is absent, fall back to 1000/1000 (the common single-user
# Linux uid). The app runs as uid 0 only when explicitly requested (PUID=0) or under
# a rootless engine, where container root IS an unprivileged host user and usually
# the only uid that can read the mount.
set -e

TARGET_DIR="${RECENSA_PROJECTS_DIR:-/data/claude/projects}"

if [ "$(id -u)" != "0" ]; then
  # Already running unprivileged (e.g. a custom `docker run --user` override) -> nothing to fix.
  exec "$@"
fi

warn() { echo "docker-entrypoint: $*" >&2; }
info() { echo "docker-entrypoint: $*"; }

# Rootless engines (rootless Docker, rootless Podman) map container root to an
# unprivileged host uid: /proc/self/uid_map's first line maps 0 to a non-zero host
# uid, while a rootful engine maps 0 -> 0.
IS_ROOTLESS=0
if [ -r /proc/self/uid_map ]; then
  read -r _ HOST_ROOT _ < /proc/self/uid_map
  [ "$HOST_ROOT" != "0" ] && IS_ROOTLESS=1
fi

# Surface mount problems immediately, at the top of the logs: a wrong -v/CLAUDE_HOME
# is the single most common deploy failure and otherwise shows up only as the server
# exiting (or an empty UI) with no hint pointing at the mount.
if [ -e "$TARGET_DIR" ] && [ ! -d "$TARGET_DIR" ]; then
  warn "$TARGET_DIR exists but is not a directory — the volume mount is wrong (-v .../.claude:/data/claude); refusing to start"
  exit 1
fi
if [ ! -d "$TARGET_DIR" ]; then
  warn "$TARGET_DIR does not exist — either the volume is not mounted, or the host path (-v / CLAUDE_HOME) points at the wrong directory. The server will keep exiting until this is fixed."
fi

# $1=explicit env override  $2=stat format  $3=fallback when the mount is absent
# PUID and PGID are resolved independently -- setting only one is valid, it does
# not require setting both.
resolve() {
  if [ -n "$1" ]; then
    echo "$1"
  elif [ -d "$TARGET_DIR" ]; then
    stat -c "$2" "$TARGET_DIR"
  else
    echo "$3"
  fi
}

RESOLVED_UID="$(resolve "$PUID" '%u' 1000)"
RESOLVED_GID="$(resolve "$PGID" '%g' 1000)"

for v in "$RESOLVED_UID" "$RESOLVED_GID"; do
  case "$v" in ''|*[!0-9]*)
    warn "PUID/PGID must be a plain number (got '$v')"; exit 1;;
  esac
  if [ "$v" -gt 4294967294 ]; then
    warn "PUID/PGID out of range (got '$v', max 4294967294)"; exit 1
  fi
done

if [ "$RESOLVED_UID" = "0" ] || [ "$RESOLVED_GID" = "0" ]; then
  if [ -n "$PUID" ] && [ "$PUID" = "0" ]; then
    # Explicitly requested: the operator knows their engine (typically rootless,
    # where container root is the unprivileged host user). Honor it.
    info "PUID=0 set explicitly — running as container root"
    exec "$@"
  fi
  if [ "$IS_ROOTLESS" = "1" ]; then
    # Rootless engine: container root maps to the unprivileged host user and is
    # usually the only uid that can read the owner-only mount. Not a privilege
    # escalation -- "root" here has no host privileges.
    info "rootless engine detected — running as container root (maps to the unprivileged host user)"
    exec "$@"
  fi
  # Rootful engine, mount stats as root-owned. On Docker Desktop (macOS/Windows)
  # every bind mount stats as root and the sharing layer grants access regardless
  # of uid -> 1000:1000 works and this branch is the normal path there, not an
  # error. On native Linux a genuinely root-owned projects dir needs PUID=0 set
  # explicitly instead.
  info "mount stats as root-owned; running as 1000:1000 (expected on Docker Desktop; on native Linux with a root-owned dir, set PUID=0 explicitly)"
  RESOLVED_UID=1000
  RESOLVED_GID=1000
fi

# uid 1000 already belongs to the base image's "node" account -- that collision is
# intentional (it's the default target and file access checks the uid number, not
# the name). Any other uid/gid already claimed by a system account (daemon,
# www-data, nobody, ...) is ambiguous and not safe to reuse.
CONFLICT_UID_NAME="$(getent passwd "$RESOLVED_UID" | cut -d: -f1)"
if [ -n "$CONFLICT_UID_NAME" ] && [ "$CONFLICT_UID_NAME" != "appuser" ] && [ "$RESOLVED_UID" != "1000" ]; then
  warn "uid $RESOLVED_UID is already used by system account '$CONFLICT_UID_NAME'; falling back to 1000"
  RESOLVED_UID=1000
fi
CONFLICT_GID_NAME="$(getent group "$RESOLVED_GID" | cut -d: -f1)"
if [ -n "$CONFLICT_GID_NAME" ] && [ "$CONFLICT_GID_NAME" != "appuser" ] && [ "$RESOLVED_GID" != "1000" ]; then
  warn "gid $RESOLVED_GID is already used by system group '$CONFLICT_GID_NAME'; falling back to 1000 (transcripts are owner-only 700, so the gid does not affect reading them)"
  RESOLVED_GID=1000
fi

CURRENT_GID="$(id -g appuser)"
CURRENT_UID="$(id -u appuser)"

if [ "$CURRENT_GID" != "$RESOLVED_GID" ]; then
  groupmod -o -g "$RESOLVED_GID" appuser
fi
if [ "$CURRENT_UID" != "$RESOLVED_UID" ]; then
  usermod -o -u "$RESOLVED_UID" appuser
fi

# The named-volume data dir is baked as appuser:appuser at build time; re-own it after
# a uid/gid change so the DB files stay writable. Cheap: two small SQLite files, not a
# deep tree. The bind-mounted transcripts are NOT touched — read access comes purely
# from matching uid/gid, never from changing the host's file permissions.
chown -R appuser:appuser /app/backend/data

# Post-alignment read probe: the directory owner can match while individual files
# don't (e.g. transcripts once created via `sudo claude` are root-owned). Surface
# that as one clear warning here instead of silent per-file EACCES noise later.
if [ -d "$TARGET_DIR" ]; then
  SAMPLE="$(find "$TARGET_DIR" -mindepth 2 -maxdepth 2 -name '*.jsonl' 2>/dev/null | head -n 1)"
  if [ -n "$SAMPLE" ] && ! gosu appuser test -r "$SAMPLE"; then
    warn "resolved uid $RESOLVED_UID cannot read $SAMPLE — some transcripts have a different owner (often from running the CLI with sudo); those sessions will be skipped. Fix on the host with: chown -R \$(id -un) ~/.claude/projects"
  fi
fi

exec gosu appuser "$@"
