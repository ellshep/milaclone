# Backlog

The one list of open work. Agents and people read it before starting and update it in the same PR as the change.

- One line per item: ID, what's wrong or wanted, where, and the fix if known. Link a longer spec only when one exists.
- **Now** is what's being worked on, **Next** is ready to pick up, **Later** is accepted but not soon, **Needs a decision** is blocked on the owner.
- When an item ships, delete its line in that PR (the PR is the record). **Closed** keeps the last few for reference; trim it past ten lines.
- IDs never get reused. `AU` = code audit finding, `DM` = deep-module candidate, `V` = voice add-on, `U` = `docs/next-updates.md`, `AG` = board agents (`docs/agent-addon.md`).
- Word cap 2,000 (`npm run check:docs`). If it doesn't fit, it's too detailed for this file.

Sources: the code audit of 2026-11-20 (Ponytail audit + Matt Pocock's `improve-codebase-architecture` pass; full write-up kept outside the repo), `docs/next-updates.md`, and the open items from the old voice handoff notes.

## Now

Nothing in progress: pick from Next.

## Next

- **AU6** `PATCH /api/item {canvasId}` moves a board without `/move`'s checks, so a board can be moved into itself and vanish (`routes.js:276`). Fix: drop cross-canvas moves from PATCH (`drag.js:139`, test at `test/api.test.js:670`).
- **AU8** The service worker caches every query-string URL (each search prefix) and never evicts; trashed images stay on the phone (`sw.js:7`). Fix: don't cache same-origin URLs with `url.search`.
- **AU9** Cut-and-paste leaves an invisible, unselectable line on the old board when one end stays behind (`db.js:248`, `lines.js:109`). Fix: in `moveItemDeep`, turn that end into a free point at the card's old position.
- **V1** Next phases, planned with the owner on 2026-11-20 (decisions N1–N22, work items M1–M5 in `docs/next-phases.md`): Microsoft To Do import (M1, waits for the owner's file), focus order, `/focus` page, nightly ranking and retention (M2), filing into lists (M3), then AG1, then Pebble watch app (M4), morning digest at 7:30 on weekdays, which settles V3 (M5). Replaces V2.
- **AG1** Board agents, planned with the owner on 2026-11-22 (decisions A1–A22, work items W1–W6 in `docs/agent-addon.md`): `agent` card, board access flag and selection hook (W1; the API key was dropped), the MCP server (W2), the agent service and page (W3), the Home orchestrator (W4), Claude Code briefs (W5). Comes after M3, before M4.

## Later

- **DM4** Move `openCanvas`/`reloadView` out of `main.js` into a navigation module so the 8 modules that import it become unit-testable.
- **DM5** One board-view module for adding/removing cards; `create.js` doesn't check `it.error`, so a 400 renders an `{error}` card (`capture.js:26`, `create.js:47`, `lines.js:171`, `menus.js:208`).
- **AU12** The 11-field `stmt.updateItem` write is copied three times (`routes.js:319`, `routes.js:353`, `tasks-api.js:174`) and the `_child*` projection twice. Fix: `saveItem(it)` in `db.js`. Overlaps DM3.
- **AU14** `b.x || 60` turns 0 into 60 on create, so the first imported card in a column sorts last (`routes.js:222`). Fix: `??`.
- **AU15** `api.create`/`api.remove` throw instead of toasting when offline.
- **AU16** `deleteList` in Quick notes flushes a save without `baseTasks`.
- **AU17** File cards link `data.src` without checking the URL scheme.
- **AU18** Typing a hex colour into a note right after its text save failed folds the retry into the swatch PATCH; if that fails too, the text edit is dropped (`editing.js` exitEdit).
- **AU19** Deleting a card while its save waits to retry: the retry gets 404 and toasts "rejected", and Undo brings the card back without that edit.
- **AU20** Quick notes `deleteList` removes the list before flushing its save, so a queued edit goes out empty and Undo restores the list without it.
- **AU21** `flush(id)` doesn't wait for a save already in flight, so `deleteItems` or closing Quick notes can act before the last save lands.
- **U1.1, U1.4, U1.5** Milanote migration: backup and inventory, staged import, reconciliation report. Specs in `docs/next-updates.md`.

## Needs a decision

- **V5** Focus page redesign (owner's mockups, not in the repo): Done earlier and Done today above the three, the Queue below with a row menu (send to the three, top or bottom of the queue, hold to complete, hold to delete), a Boards view with a Tasks only switch. Settles the stale rule and Keep (N22). Not ready to build.
- **DM3** Turn `db.js` into an item store that owns the board/canvas duality (write-through, projection, row serialisation). Conflicts with the documented "routes call prepared statements directly"; worth reopening because `tasks-api.js` is a second caller with the same invariants.

## Closed

- **DM2** `public/js/savequeue.js` is the one client save protocol (debounce, base, retry, adopt) for the canvas and Quick notes, unit-tested in Vitest.
- **AU5** Copied to-do cards get fresh task ids; the boot repair makes ids unique across cards (#71).
- **DM1** `tasklist.js` owns the task shape, blank rule, ids and the merge; the merge compares with defaults filled in.
- **AU1, AU2, AU3, AU11** Failed saves now retry, big background saves skip `keepalive`, Quick notes' base no longer erases stars and due dates; `e2e/saves.spec.js` covers all three.
- **V4** Voice tags are limited to tags already on the list (an `enum` built from the 100 most used). Done in #63.
- **AU7** `/ingest/text` blocked the pipeline's event loop during the model call. Fixed in #62.
- **AU13** `HANDOFF-NOTES.md` working log at the repo root. Deleted; open items moved here (#67).
