# Contributing to Recensa

Thanks for your interest in improving Recensa. This guide covers how to get a dev
environment running, the quality bar for changes, and how to open a good pull
request.

## Development setup

Recensa runs in **Docker** (Docker Desktop on Windows/macOS, Docker Engine on Linux).
The server is pure Node with the built-in `node:sqlite` module — no native
dependencies to build — so it also runs directly under **Node.js 22+** from source.

```bash
cp .env.example .env                  # set CLAUDE_HOME to your .claude path
docker compose up -d --build          # build the image + start the container
```

Then open **http://localhost:7788** (or your `RECENSA_HOST_PORT`).

All operational tasks go through the single `ops.js` entry point — don't hand-run
individual steps:

| Command | What it does |
|---------|--------------|
| `node backend/scripts/ops.js up` | rebuild the image + start the container |
| `node backend/scripts/ops.js check` | type-check + lint + unit tests (backend and frontend) |
| `node backend/scripts/ops.js logs` | follow container logs |
| `node backend/scripts/ops.js status` | container state + health |

- **Code changes** land in the running container after a rebuild — `ops.js up`
  re-images and restarts.
- **Frontend iteration** is fastest with the Vite dev server: `npm run dev` inside
  `frontend/` (HMR on 5178, proxying API calls to the backend on 7788).

## Before you open a PR

Run the full check and make sure it is green:

```bash
node backend/scripts/ops.js check
```

This must pass with **zero type errors and zero lint warnings**. For frontend work,
`tsc --noEmit` must also be clean. Add or update unit tests when you change parsing,
indexing, or any data-integrity invariant (e.g. the `msg_count` alignment locked by
tests in `parse`).

## Pull request guidelines

- **Keep PRs focused** — one topic per PR makes review fast and history clean.
- **Link the issue** it addresses (`Closes #123`) when there is one.
- **Follow [Conventional Commits](https://www.conventionalcommits.org/)** for commit
  subjects: `feat(scope): …`, `fix(scope): …`, `docs: …`, `refactor: …`, `test: …`,
  `chore: …`. Keep unit tests in their own `test(scope): …` commit, separate from the
  implementation.
- **Sign off your commits** with the [Developer Certificate of Origin](https://developercertificate.org/):
  `git commit -s` adds a `Signed-off-by` trailer certifying you have the right to
  submit the contribution.

## Reporting bugs & requesting features

- **Bugs and feature requests** → open an issue. Include your OS, Node version, and
  reproduction steps for bugs.
- **Questions, ideas, and general discussion** → please use Discussions rather than
  the issue tracker, so issues stay actionable.
- **Security vulnerabilities** → do **not** open a public issue; see
  [SECURITY.md](./SECURITY.md).

## Project layout

A quick map to help you find your way (see the architecture section in the
[README](./README.md) for the data-flow overview):

```
backend/
  scripts/ops.js           the single operations entry point (Docker lifecycle + checks)
  src/
    routes/                HTTP/WS routes (no SQL here)
    services/              orchestration (messages, reconstruction, indexing)
    repositories/          all SQL lives here
    ingestion/             byte-offset incremental indexer + live-tail watcher
    parsing/               JSONL → messages
    storage/               schema + DB setup
frontend/
  src/{types,services,hooks,lib,components}   React 19 + TS + Tailwind v4
```

The backend is single-direction layered: `routes → services →
{repositories, ingestion} → {parsing, storage}`. Keep SQL in repositories and
transcript files read-only — all derived data goes into SQLite.

## Code of Conduct

This project follows a [Code of Conduct](./CODE_OF_CONDUCT.md). By participating you
are expected to uphold it.
