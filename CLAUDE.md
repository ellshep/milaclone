# CLAUDE.md

Guidance for AI agents working in this repo. This file is loaded into every session, so it holds only commands, rules and invariants that cause bugs when missed. It has a 1,500-word cap (`npm run check:docs`, run in the Lint job). Area detail lives next to the code and loads only when you work there:

- `public/CLAUDE.md` — frontend modules, rendering, keyboard, Quick notes, PWA.
- `addons/voice/CLAUDE.md` — the voice pipeline and Alexa add-on.
- `scripts/CLAUDE.md` — the Milanote importer and the deploy scripts.

## Commands

```bash
npm start                     # run the app (default http://localhost:4321)
docker compose up -d --build  # run in Docker on 127.0.0.1:8182
npm test                      # backend + API tests (node --test), fails under 80% line/branch/function coverage
node --test test/api.test.js  # run a single test file
npm run test:ui               # Vitest + jsdom unit tests for front-end modules (test/ui/*.test.mjs)
npm run test:e2e              # Playwright end-to-end tests
npx playwright test e2e/ui.spec.js -g "creates a note"  # single e2e test
npm run lint                  # oxlint; warnings fail CI
npm run format                # prettier --write (CI runs format:check)
npm run deadcode              # knip: unused files, exports and dependencies
npm run check:docs            # word caps on the CLAUDE.md files
```

## How we work

- **Scope comes first.** Build only what the task, roadmap ID or `docs/backlog.md` item asks for. No speculative options, flags, wrappers or "while I'm here" features. See `CONTRIBUTING.md`.
- **Prefer deleting.** Reuse what exists before adding a helper, dependency or module. A PR should say what it removes, or why nothing.
- **No working logs in the repo.** Don't add handoff notes, phase logs or status files. Open work and owner decisions go in `docs/backlog.md` (update it in the same PR: delete an item's line when it ships), reasoning in the PR body; lasting facts go in the nearest `CLAUDE.md` or `docs/`.
- **Keep these files short.** Add a line to a `CLAUDE.md` only when not knowing it would cause a bug. Describe features in the code's header comment, not here.
- **Never** skip or `.only` a test, lower a coverage floor, or edit branch protection to get green.

## CI

`.github/workflows/tests.yml` runs Lint, Format, Unit / API tests, UI unit tests, E2E tests and Docker smoke on every PR; all six are required checks on `main`, so job names must not change without updating branch protection. Dead code (knip) runs too but is not required yet. The voice add-on's workflow (`voice-addon.yml`) adds three more required checks — `Voice changes`, `Pipeline tests`, `Alexa worker tests` — that run on every PR and skip their tests when no voice files changed. The E2E job runs in the `mcr.microsoft.com/playwright:v<version>-noble` image — bump that tag with `@playwright/test`. Coverage floors: `npm test` applies 80% to all backend files; Vitest applies 80% per file to the modules listed in `vitest.config.mjs` — add a module there when it gets unit tests. Modules that import `main.js` boot the whole app, so test them in Playwright instead.

Test isolation: `test/api.test.js` points `DATA_DIR` at a fresh `mkdtemp` before requiring `db.js`; `playwright.config.js` starts its own server on port 4322 with `DATA_DIR=.e2e-data` (wiped each run). `db.js` opens the SQLite handle on `require`, so any code that requires it must set `DATA_DIR` first.

## Architecture

Node backend (`server.js` → `routes.js` → `db.js`, plus `tasks-api.js` and `export-md.js`) and a vanilla ES-module frontend. The only build step: `server.js` runs esbuild `buildSync` at boot, bundling `public/js/editor.js` (TipTap) into the gitignored `public/vendor/editor.js`. `esbuild` and `@tiptap/*` are exact-pinned runtime `dependencies` because the Docker image builds the bundle on start.

- `db.js` opens `better-sqlite3` in WAL mode, creates the schema, seeds a root `Home` canvas and exports prepared statements (`stmt.*`). **Routes call the prepared statements directly**; there is no repository layer.
- Schema: `canvases` (tree via `parentCanvasId`; `agentAccess` = agents may read the board, off by default, `docs/agent-addon.md` A3), `items` (belong to a `canvasId`, may nest under `parentItemId` for cards in a column), `meta` (key/value: `rootCanvasId`, the task API's `inboxItemId`).
- `items.data` is a JSON string in SQLite but always an object at the API boundary — `rowToItem` parses on read, routes `JSON.stringify` on write.
- **Rich text:** `note` and `comment` items keep `data.doc` (TipTap JSON) plus `data.text` (its plain text; search and labels read `text`). `db.js` `toRich` converts plain-text writes on POST; `migrateRichText` converts old rows once at boot after a `VACUUM INTO` backup.
- `GET /api/search` matches live rows only, with LIKE wildcards escaped.
- **Task API** (`tasks-api.js`, documented in `docs/task-api.md`): bearer-token routes for machine clients; unset `TASK_API_TOKEN` → 503, so it's never open. Tasks stay entries in `todo` cards' `data.tasks` — there is no tasks table. **`tasklist.js` defines a task** (shape and defaults, blank rule, unique ids, new tasks, the merge): server code that touches tasks goes through it. A field a client reads gets a default in its `normTask` and in Quick notes' `normTask`. Board UI routes stay open on the tailnet unless `API_KEY` is set: then every `/api/*` route but `/api/health` and `/api/tasks` wants `X-API-Key` (`routes.js`); the page gets the key as a cookie, so the key gates machine clients and cross-site requests, not people who can load the page.
- **Focus order** (`focus.js`): one ranking of open tasks, shared by `GET /api/focus` (board route) and `GET /api/tasks?view=focus` (token): overdue → due today → hand-placed (`focusOrder`) → due within 3 days → starred → rest, with the ranker's `rankNudge` (±1 tier) and `rankScore` (within a tier). Done, blank and `stale` tasks, Reference-labelled lists and lists under Home's "Templates" board are left out. Change the order only there.

**The board/canvas duality is the trickiest invariant.** A `board` item on canvas A owns a child canvas B (`routes.js` POST `/api/item`). The card's title, color and icon live on the child canvas row: GET `/api/canvas/:id` adds `_childTitle`/`_childCount`/`_childColor`/`_childIcon`, and PATCH writes those fields through to the child canvas and strips them off `item.data`.

**Deleting never removes rows.** `trashItemDeep` tags the item and its whole subtree with `trashedBy = <item id>`, and every prepared statement filters `trashedBy IS NULL`. Any new query or endpoint must do the same. Restore clears the tag (409 when the item's board is itself trashed); `DELETE /api/trash` hard-deletes and unlinks upload files no surviving item references. A `parentItemId` sent to PATCH must name a live `column` on the item's own canvas, or 400. Copy (`collectSubtree`) and move are server-side; move refuses a board inside itself.

**Export/import round-trip:** `export-md.js` writes the Markdown shape `scripts/import-milanote-md.js` reads back — keep them in step (tested in `test/findkeep.api.test.js`).

**Auto-save:** every edit fires a PATCH; data keys merge shallowly, last write wins per key — except todo `tasks`: clients send `baseTasks` and `tasklist.js` `merge` does a three-way merge per task field, comparing with defaults filled in and counting only fields the client sent, so neither a filled-in default nor a missing field erases another device's edit. Task ids are unique across all cards: writes fill in missing ones, copies get fresh ones, and `db.js` `migrateTaskIds` repairs old rows at boot. There's no realtime sync.

**Add-ons** (`addons/`) are optional and off by default; the board must work identically without them. Core code never imports from `addons/`; add-ons reach the board only through public HTTP APIs. Each add-on sits behind a Compose profile and has a README stating what it sends to third parties. Keep add-on docs inside the add-on folder, and keep personal setup details out of the repo.

## Data & config

- `data/board.db` (+ `-wal`, `-shm`) — all board content. `GET /api/backup` streams a snapshot.
- `public/uploads/` — uploads (25 MB cap, mime-filtered; 415/413 with an `error` the client toasts). The path is hardcoded. `routes.js` `setUploadHeaders` adds `nosniff` and `Content-Disposition: attachment` to every file resolved under it, identified by directory device+inode, and `server.js` passes it to the generic `express.static` too (encoded URLs like `/%75ploads/…` miss the `/uploads` mount). Keep both.
- Env vars: `PORT` (4321), `HOST` (0.0.0.0), `DATA_DIR` (`./data`), `API_KEY` (unset = open), `TASK_API_TOKEN` (unset = task API off), `TASK_TZ` (`UTC`). `.env.example` lists them; `.env` is gitignored.
- Docker: `Dockerfile` is a two-stage alpine build that copies the backend files **by name** — add any new top-level module to its `COPY` line. `docker-compose.yml` runs a loopback-only port with resource caps and named volumes `milaclone_data` and `milaclone_uploads`, fronted by Tailscale Serve.
- `main` auto-deploys hourly to the owner's server (`scripts/autodeploy.sh`): anything merged runs there within an hour.
