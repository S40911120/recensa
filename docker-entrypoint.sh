#!/bin/sh
# Image starts as root; this drops to appuser before exec'ing node.
#
# On Linux, `~/.claude/projects` is created owner-only (dirs 700, files 600) by the
# host Claude Code CLI, so the container must run under a matching uid/gid to read
# it. Resolution order: an explicit PUID/PGID always wins; otherwise stat the actual
# mounted directory and match whatever uid/gid it shows from inside this container's
# namespace. That also covers rootless Docker, where the uid visible in the
# container differs from the real host uid and a fixed guess cannot resolve it, but
# reading the mount directly can. If the mount does not exist yet, fall back to
# 1000/1000, the common single-user Linux uid. Never run the app itself as uid 0.
set -e

TARGET_DIR="${RECENSA_PROJECTS_DIR:-/data/claude/projects}"

if [ "$(id -u)" != "0" ]; then
  # Already running unprivileged (e.g. a custom `docker run --user` override) -> nothing to fix.
  exec "$@"
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

case "$RESOLVED_UID" in ''|*[!0-9]*)
  echo "docker-entrypoint: PUID '$RESOLVED_UID' is not a number" >&2; exit 1;;
esac
case "$RESOLVED_GID" in ''|*[!0-9]*)
  echo "docker-entrypoint: PGID '$RESOLVED_GID' is not a number" >&2; exit 1;;
esac

# The mount being root-owned would otherwise re-home appuser to uid/gid 0; refuse
# and fall back rather than run the application itself as root or in the root group.
if [ "$RESOLVED_UID" = "0" ] || [ "$RESOLVED_GID" = "0" ]; then
  echo "docker-entrypoint: $TARGET_DIR is root-owned; refusing to run as uid/gid 0, falling back to 1000:1000" >&2
  RESOLVED_UID=1000
  RESOLVED_GID=1000
fi

# uid 1000 already belongs to the base image's "node" account -- that collision is
# intentional (it's the default target and has been verified harmless: file access
# checks by uid number, not name). Any other uid/gid already claimed by a system
# account (root, daemon, www-data, nobody, ...) is ambiguous and not safe to reuse.
CONFLICT_UID_NAME="$(getent passwd "$RESOLVED_UID" | cut -d: -f1)"
if [ -n "$CONFLICT_UID_NAME" ] && [ "$CONFLICT_UID_NAME" != "appuser" ] && [ "$RESOLVED_UID" != "1000" ]; then
  echo "docker-entrypoint: uid $RESOLVED_UID is already used by system account '$CONFLICT_UID_NAME'; falling back to 1000" >&2
  RESOLVED_UID=1000
fi
CONFLICT_GID_NAME="$(getent group "$RESOLVED_GID" | cut -d: -f1)"
if [ -n "$CONFLICT_GID_NAME" ] && [ "$CONFLICT_GID_NAME" != "appuser" ] && [ "$RESOLVED_GID" != "1000" ]; then
  echo "docker-entrypoint: gid $RESOLVED_GID is already used by system group '$CONFLICT_GID_NAME'; falling back to 1000" >&2
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

exec gosu appuser "$@"
