# Task API

An HTTP API for adding and updating to-do tasks without opening the app. It is
meant for machine clients: the voice-note pipeline, an Alexa hop, shortcuts and
scripts. The board UI itself still has no login (see the note in the README);
this API needs a bearer token because it is the one surface built to be called
by other programs and, later, reached through a public Alexa hop.

## Where tasks live

Milaclone has no tasks table. A task is an entry in a **to-do card** on some
board — the same lists the canvas and Quick notes edit. Tasks created through
this API go to a to-do card called **Inbox** on Home. The server creates it the
first time it needs one and remembers it; if you trash it, the next task makes a
new one. Move the Inbox card anywhere you like (it keeps working), or send
`listId` to put a task in another list.

## Setup

Generate a token and put it in `.env` next to `docker-compose.yml`:

```bash
echo "TASK_API_TOKEN=$(openssl rand -hex 32)" >> .env
docker compose up -d
```

Without `TASK_API_TOKEN` the API answers `503` to everything, so it is never
open by accident. Outside Docker, export it before `npm start`.

| Variable         | Default           | Purpose                                                     |
| ---------------- | ----------------- | ----------------------------------------------------------- |
| `TASK_API_TOKEN` | unset (API off)   | Bearer token every `/api/tasks` request must send           |
| `TASK_TZ`        | `America/Chicago` | Time zone that turns an ISO datetime into a task's due date |

Every request sends `Authorization: Bearer <token>`. A missing or wrong token
gets `401`.

## Endpoints

### `POST /api/tasks` — create a task

| Field      | Type                       | Notes                                                                                    |
| ---------- | -------------------------- | ---------------------------------------------------------------------------------------- |
| `title`    | string, required           | Up to 500 characters; whitespace collapsed                                               |
| `notes`    | string                     | Shown as the task's note in Quick notes                                                  |
| `tags`     | string[]                   | Leading `#` stripped, duplicates dropped. New tags need no setup                         |
| `dueDate`  | `YYYY-MM-DD`, ISO datetime | A datetime becomes its calendar date in `TASK_TZ`. `null` for none                       |
| `starred`  | boolean                    | The star is milaclone's priority marker (Quick notes' Starred list)                      |
| `priority` | `low`, `normal`, `high`    | `high` stars the task. An explicit `starred` wins                                        |
| `source`   | string                     | Who created it, e.g. `api`, `voice-note`, `alexa`, `migration`. Default `api`            |
| `listId`   | string                     | A to-do card's id to add to instead of the Inbox                                         |
| `importId` | string                     | Unique id from another system. Posting the same one again returns the existing task      |
| `dedupe`   | boolean                    | If an **open** task already has the same title (case and spacing ignored), skip creating |

Responses:

- `201 { task, created: true }` — created.
- `200 { task, created: false, duplicate: true }` — skipped by `dedupe`.
- `200 { task, created: false }` — `importId` already exists.
- `400 { error }` — invalid body.

```bash
curl -sS https://mila.your-tailnet.ts.net/api/tasks \
  -H "Authorization: Bearer $TASK_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Buy printer ink","tags":["errands"],"dueDate":"2026-12-01","source":"api"}'
```

### `GET /api/tasks?status=open` — list tasks

`status` is `open` (default), `done` or `all`. Tasks from every to-do card,
sorted by due date (undated last), then oldest first. Each task carries
`listId` and `listTitle`. The canvas editor's empty placeholder rows are left
out.

```bash
curl -sS "https://mila.your-tailnet.ts.net/api/tasks?status=open" \
  -H "Authorization: Bearer $TASK_API_TOKEN"
```

### `PATCH /api/tasks/:id` — mark done, pin, edit

Any of `title`, `notes`, `tags`, `dueDate`, `done`, `starred`, `priority`,
`pinned`. Returns `{ task }`, or `404` if no list has that task.

```bash
curl -sS -X PATCH https://mila.your-tailnet.ts.net/api/tasks/t_abc123 \
  -H "Authorization: Bearer $TASK_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"done":true}'
```

## Task fields

Stored on each task next to the fields the app already uses (`id`, `text`,
`done`, `starred`, `due`, `tags`, `note`, `createdAt`):

| Field        | Set by                    | Meaning                                        |
| ------------ | ------------------------- | ---------------------------------------------- |
| `source`     | create                    | Who created the task                           |
| `pinned`     | `PATCH`                   | Locks the task into the focus three (Phase 4)  |
| `stale`      | nightly ranking (Phase 4) | Looks abandoned; hidden from the focus view    |
| `rankScore`  | nightly ranking (Phase 4) | Model score used within a deterministic tier   |
| `rankReason` | nightly ranking (Phase 4) | One-line reason for the score                  |
| `rankedAt`   | nightly ranking (Phase 4) | When it was last scored                        |
| `importId`   | create (e.g. a migration) | Unique id from another system, for idempotency |

They were added now so the later phases need no data migration. Tasks made in
the app don't have them until something sets them, and readers treat a missing
field as its default.

## Logging

Each create, skip and update writes one JSON line to the server log, for
example `{"event":"task.create","source":"voice-note","taskId":"t_…","listId":"i_…"}`.
With Docker: `docker compose logs app | grep task.`
