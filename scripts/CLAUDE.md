# Scripts notes (`scripts/`)

Loaded when you work under `scripts/`. 1,500-word cap (`npm run check:docs`).

## Milanote import (`import-milanote.js`)

Split into readers and one engine.

- A reader turns its sources into a card tree (`{ sourceId, type, x, y, data, items, file, from/to, target }`, documented at the top of the file). `--reader md` wraps `import-milanote-md.js`'s `parseMd` (route A); `--reader json` reads a saved tree.
- There is deliberately no reader for Milanote's own web-app data (route B was built and then removed, see `docs/next-updates.md` U1.2). Import only from Milanote's official export.
- A card with `missing` set is reported, never created. Anything the engine can't place goes in the `missed` report, never silently.
- `test/fixtures/` holds made-up data only, never a real export.
- The engine writes only through the HTTP API, one upload at a time. Every item gets `data.sourceId` (boards via a follow-up PATCH, since POST replaces a board's data), and a run skips sourceIds already on the target canvas.
- Lines and shortcuts go last on purpose: line ends and shortcut targets name other cards by sourceId.
- `export-md.js` writes the shape `import-milanote-md.js` reads back; keep the two in step (round-trip tested in `test/findkeep.api.test.js`). Nested boards are flattened to `#` sections because the importer nests one level.

## Task list import (`import-tasks-json.js`)

Reads one `milaclone-import/1` file (lists, each `{ new: true }` or an existing `listId`, with tasks carrying an `importId`) and writes only through the board API and `POST /api/tasks` (`source: migration`). New lists go on the `--into` board on Home and are reused by title; tasks are idempotent by `importId`, so a re-run creates nothing twice. Refused rows are reported and the run exits 2, never dropped silently. Documented in `docs/task-api.md`.

## Deploy (`deploy.sh`, `autodeploy.sh`)

`deploy/systemd/milaclone-deploy.{service,timer}` run `autodeploy.sh` hourly on the server. It wraps `deploy.sh` with a `flock`, skips a commit that already failed (`.autodeploy-failed`) until `main` moves, and can POST to `AUTODEPLOY_NOTIFY_URL` (from `.env.autodeploy`). Polling only, by choice: nothing public reaches the server. `deploy.sh` saves a database snapshot to `backups/` before every redeploy. Documented in `docs/self-hosting.md`.
