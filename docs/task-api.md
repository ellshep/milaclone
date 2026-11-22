# Task API

An HTTP API for adding and updating to-do tasks without opening the app. It is
meant for machine clients: shortcuts, scripts, and the optional voice add-on
(`addons/voice/`). The board UI itself still has no login (see the note in the
README); this API needs a bearer token because it is the one surface built to
be called by other programs.

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

| Variable         | Default         | Purpose                                                     |
| ---------------- | --------------- | ----------------------------------------------------------- |
| `TASK_API_TOKEN` | unset (API off) | Bearer token every `/api/tasks` request must send           |
| `TASK_TZ`        | `UTC`           | Time zone that turns an ISO datetime into a task's due date |

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
| `dedupe`   | boolean                    | If an **open** task in the same list has the same title (case and spacing ignored), skip |

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

### `GET /api/tasks?view=focus&limit=3` — the focus order

The ranked open tasks the focus page, the watch and the morning digest share
(`focus.js`). `limit` is 1–1000 or `all` (default 3). Returns
`{ today, tasks, counts }`: `today` is the date in `TASK_TZ`; each task carries
`listId`, `listTitle`, `boardTitle` (the board the list sits on), `tier` and
`dueIn` (days, negative when overdue);
`counts` is `{ overdue, dueToday, open }`.

The order:

1. Overdue (most overdue first), then due today. Nothing outranks these.
2. Tasks placed by hand (`focusOrder`, lowest first).
3. The rest by tier: due within 3 days, then starred, then everything else. A
   `rankNudge` of `1` or `-1` moves a task one tier; within a tier, higher
   `rankScore` first, then unscored tasks oldest first.

Left out: done, blank and `stale` tasks, to-do lists labelled **Reference**,
and lists inside the **Templates** board on Home. The board serves the same
order without a token at `GET /api/focus` for the `/focus` page, which writes
back through two more board routes: `POST /api/focus/:taskId/done`, and
`PUT /api/focus/order` with `{ ids }`, the placed tasks top first (they get
`focusOrder` 1, 2, …, every other task loses its placement, and `[]` resets).

```bash
curl -sS "https://mila.your-tailnet.ts.net/api/tasks?view=focus&limit=3" \
  -H "Authorization: Bearer $TASK_API_TOKEN"
```

### `GET /api/tasks?view=digest` — the morning digest

What Home Assistant's morning notification shows: the focus three plus every
other overdue or due-today task, in the focus order, at most 8. Returns
`{ tasks, more }`: tasks are shaped as in `view=focus` (a line needs `text`,
`listTitle`, `due` and `tier`; the Done button sends `PATCH /api/tasks/:id`
with `{ "done": true }`), and `more` counts the overdue or due-today tasks cut
off by the cap. `limit` doesn't apply here.

### `GET /api/tasks/priorities` — the Focus priorities note

Returns `{ text }`: the whole text of the note on Home whose first line is
"Focus priorities" (the oldest, if there are several; trashed notes don't
count), or `null` when there is none. The nightly ranking sends it to the model
as written.

### `PUT /api/tasks/rank` — write the nightly ranking

`{ ranks: [{ id, rankScore, rankReason, rankNudge }] }`, up to 1000. `rankScore`
is a number or `null`, `rankReason` a string up to 300 characters or `null`,
`rankNudge` `-1`, `0` or `1` (`null` counts as `0`). One transaction: every
listed task gets its fields and `rankedAt` (ms), and **every task not listed
loses its `rankNudge`** (its score and reason stay), so moves never pile up
night after night. Tasks placed by hand (`focusOrder`) are never ranked: their
ids are skipped, and they lose any nudge. Returns `{ ranked, skipped }`,
`skipped` being the placed ids and ids no list has. A bad body is a `400` and
changes nothing.

### `PATCH /api/tasks/:id` — mark done, pin, edit, move

Any of `title`, `notes`, `tags`, `dueDate`, `done`, `starred`, `priority`,
`pinned`. Returns `{ task }`, or `404` if no list has that task.

`listId` moves the task to the end of another to-do list (`400` if it isn't a
live to-do card, or sits under the Templates board). The move is recorded on the
task as `movedFrom` (the old list id), `movedAt` (ms), `movedBy` (from the body,
1–40 characters such as `ranker`, `voice` or `owner`; default `api`, like
`source`) and `moveReason` (optional, up to 500 characters). Naming the list the
task is already in moves nothing and leaves the record as it was. A device still holding the
old list loses any edit it saves to a moved task, by the same rule as a task
deleted elsewhere (the three-way merge).

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
| `stale`      | stale rule (not built)    | Looks abandoned; hidden from the focus view    |
| `rankNudge`  | `PUT /api/tasks/rank`     | `1`/`-1`: move one tier up/down in the order   |
| `focusOrder` | focus page (List mode)    | Placed by hand; ranks above the model's order  |
| `rankScore`  | `PUT /api/tasks/rank`     | Model score used within a deterministic tier   |
| `rankReason` | `PUT /api/tasks/rank`     | One-line reason for the score                  |
| `rankedAt`   | `PUT /api/tasks/rank`     | When it was last scored (ms)                   |
| `importId`   | create (e.g. a migration) | Unique id from another system, for idempotency |
| `movedFrom`  | `PATCH` with `listId`     | The list the task was last moved out of        |
| `movedAt`    | `PATCH` with `listId`     | When it was last moved (ms)                    |
| `movedBy`    | `PATCH` with `listId`     | Who moved it                                   |
| `moveReason` | `PATCH` with `listId`     | Why, if the mover said                         |

They were added now so the later phases need no data migration. Tasks made in
the app don't have them until something sets them, and readers treat a missing
field as its default.

## Logging

Each create, skip, update, ranking and move writes one JSON line to the server log, for
example `{"event":"task.create","source":"voice-note","taskId":"t_…","listId":"i_…"}`.
With Docker: `docker compose logs app | grep task.`

## Importing a task list

`scripts/import-tasks-json.js` brings a whole task list from another app (for
example a Microsoft To Do export, cleaned up first) in through this API. It
reads one file in this shape:

```json
{
  "format": "milaclone-import/1",
  "lists": [
    {
      "name": "Errands",
      "target": { "new": true },
      "tasks": [
        {
          "importId": "mstodo:AAMk…",
          "title": "Buy printer ink",
          "note": "Black only",
          "due": "2026-11-28",
          "starred": false,
          "tags": []
        }
      ]
    },
    { "name": "Doctor", "target": { "listId": "i_…" }, "tasks": [] }
  ]
}
```

- `target` is `{ "new": true }` (optionally with `"title"`) for a new to-do
  list, or `{ "listId": "…" }` (an `id` from `GET /api/todos`) to add to an
  existing one.
- Every task needs a unique `importId` and a `title`; `note`, `due`, `starred`
  and `tags` are optional and follow the limits of `POST /api/tasks`.

```bash
node scripts/import-tasks-json.js --base http://127.0.0.1:8182 --dry-run tasks.json
TASK_API_TOKEN=… node scripts/import-tasks-json.js --base http://127.0.0.1:8182 tasks.json
```

New lists go on a board on Home (`--into`, default "From Microsoft To Do"),
made on the first run; a list with the same title already on that board is
reused. Tasks are created with `source: migration` and their `importId`, so
running it again adds nothing twice. `--dry-run` prints what would be created,
writes nothing and needs no token. Rows the API refuses are listed with the
reason, and the script then exits with status 2.
