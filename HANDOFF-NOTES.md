# Handoff notes: voice task capture

Running log for the voice task capture work (task API, voice pipeline, Alexa,
focus view, daily resurfacing). One entry per phase: what was built, what was
verified, what is left and what needs the owner's input.

## Discovery (before Phase 1)

What the repo actually is, against the assumptions in the original handoff:

- **Stack:** Node 22, Express 4, `better-sqlite3`. `server.js` → `routes.js` →
  `db.js`; routes call prepared statements directly. Vanilla ES-module
  frontend, no framework.
- **Database:** SQLite at `DATA_DIR/board.db`, WAL mode already on. Backups:
  `GET /api/backup` streams a snapshot, and `scripts/deploy.sh` saves one to
  `backups/` before every redeploy.
- **To-do model:** there is no tasks table. A task is an entry in
  `items.data.tasks` of a `todo` card: `{ id, text, done, starred, due
(YYYY-MM-DD), tags[], note, noteStyle, createdAt, indent }`. Quick notes (the
  mobile to-do screen) lists every todo card on every board. Tags are free
  strings with no registry. There is no priority field; the star is the
  closest thing.
- **Concurrency:** both clients send the list they last loaded (`baseTasks`)
  and the server does a three-way merge (`routes.js` `mergeTasks`), so tasks
  added by another writer survive, and fields a client doesn't know are kept.
- **Auth:** none. The app trusts the tailnet.
- **Deploy:** Docker Compose project `milaclone`: `app` on `127.0.0.1:8182`
  (0.5 CPU, 256 MB) plus a Tailscale sidecar serving
  `https://mila.<tailnet>.ts.net`. `.env` (gitignored) holds `TS_AUTHKEY`.

## Phase 1: task creation API

**Built**

- `tasks-api.js`: `POST /api/tasks`, `GET /api/tasks?status=`,
  `PATCH /api/tasks/:id`, behind `Authorization: Bearer $TASK_API_TOKEN`
  (constant-time compare; an unset token switches the API off with 503 rather
  than leaving it open). Reference: `docs/task-api.md`.
- New tasks go to an **Inbox** to-do card on Home, created on first use and
  recreated if it is trashed (owner decision). `listId` targets another list.
- **Priority is the star** (owner decision): `priority: "high"` or
  `starred: true`.
- The handoff's new columns are stored as camelCase task fields, matching the
  existing JSON: `source`, `pinned`, `stale`, `rankScore`, `rankReason`,
  `rankedAt`, `importId`. No schema migration is needed now or in later
  phases.
- Server-side dedupe (`dedupe: true` skips an open task with the same title)
  and `importId` idempotency, so the pipeline and the Microsoft To Do import
  share one implementation.
- One JSON log line per create, skip and update, including `source`.
- `.env.example`, compose env vars, README section, CLAUDE.md.

**Verified**

- `test/tasks.api.test.js` (13 tests): auth failures, disabled API, happy
  path through to `GET /api/todos`, Inbox recreation, `listId`, 23 validation
  cases, due-date time zone conversion, priority → star, importId, dedupe,
  listing order and filters, PATCH, and a stale client save keeping an
  API-added task. `tasks-api.js` coverage: 99% lines, 96% branches.
- Full `npm test`, lint, format and UI unit tests pass. Chromium e2e: 123 of
  126 pass here; the same 3 fail without these changes (the sandbox blocks the
  Lucide icon CDN), so CI is the reference.
- Manual: real server plus `curl`. Tasks showed in the Inbox card on the
  canvas and in Quick notes.

**Not verified on xbox yet.** Owner steps:

1. `echo "TASK_API_TOKEN=$(openssl rand -hex 32)" >> .env` next to
   `docker-compose.yml`, then `scripts/deploy.sh` (or `docker compose up -d --build`).
2. Run the `curl` example in `docs/task-api.md` against
   `https://mila.<tailnet>.ts.net`.
