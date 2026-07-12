# Versioning

Recensa follows [Semantic Versioning](https://semver.org/). While the app is pre-1.0,
minor versions (0.x) may contain breaking changes; patch versions do not.

## Three artifacts, one source of truth

A Recensa version exists in three places. The git tag is the source of truth:

| Artifact | Where | How it gets its version |
|----------|-------|-------------------------|
| Git tag | `v<version>` on this repository | Created per release, with a [CHANGELOG](./CHANGELOG.md) entry |
| Docker image | `s40911120/recensa:<version>` + `:latest` | Built and pushed by CI on the tag push (`.github/workflows/docker-publish.yml`), gated on the full check suite |
| Session engine | [@recensa/claude-session](https://www.npmjs.com/package/@recensa/claude-session) inside the image | Pinned by `backend/package-lock.json` at image build time |

`:latest` always points at the most recently tagged release.

## About the bundled engine version

The npm package and this app release independently. The engine version inside a Docker
image is the lockfile pin at build time — it can trail the npm `latest` by a patch
release (patch releases never change behavior; see the package's own VERSIONING.md).
The lockfile is refreshed as part of each Recensa release.

## Database compatibility

`viewer.db` is a disposable cache: any version can rebuild it from your transcripts,
so upgrades never require a migration on the index. `flags.db` (pins, tags, notes) is
user data; schema changes there ship with in-place migrations and are called out in
the changelog.
