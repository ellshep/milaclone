# Backlog

The one list of open work. Agents and people read it before starting and update it in the same PR as the change.

- One line per item: ID, what's wrong or wanted, where, and the fix if known. Link a longer spec only when one exists.
- **Now** is what's being worked on, **Next** is ready to pick up, **Later** is accepted but not soon, **Needs a decision** is blocked on the owner.
- When an item ships, delete its line in that PR (the PR is the record). **Closed** keeps the last few for reference; trim it past ten lines.
- IDs never get reused. `AU` = code audit finding, `DM` = deep-module candidate, `V` = voice add-on, `U` = `docs/next-updates.md`, `AG` = board agents (`docs/agent-addon.md`), `Q` = test and quality tooling, `FE` = moving screens to Preact (roadmap D11).
- Word cap 2,000 (`npm run check:docs`). If it doesn't fit, it's too detailed for this file.

Sources: the code audit of 2026-11-20 (Ponytail audit + Matt Pocock's `improve-codebase-architecture` pass; full write-up kept outside the repo), `docs/next-updates.md`, and the open items from the old voice handoff notes.

## Now

Nothing in progress: pick from Next.

## Next

- **V1** Next phases, planned with the owner on 2026-11-20 (decisions N1–N26, work items M1–M5 in `docs/next-phases.md`): Microsoft To Do import (M1, waits for the owner's file), focus order, `/focus` page, nightly ranking and retention (M2), filing into lists (M3), then AG1, then Pebble watch app (M4; M4.1 waits for the M4.2 device spike, N23), morning digest at 7:30 on weekdays, which settles V3 (M5). Replaces V2.
- **AG1** Board agents, planned with the owner on 2026-11-22 (decisions A1–A22, work items W1–W6 in `docs/agent-addon.md`): `agent` card, board access flag and selection hook (W1; the API key was dropped), the MCP server (W2), the agent service and page (W3), the Home orchestrator (W4), Claude Code briefs (W5). Comes after M3, before M4. W1–W3 and W4.1 (the Home orchestrator) shipped; next is W5 (Claude Code briefs). Open: OpenAI, Gemini and local providers (agents with them answer "not supported yet").
- **V5** Focus redesign, planned with the owner on 2026-11-22 (decisions R1–R26, work items F1–F8 in `docs/focus-redesign.md`, mockups in `docs/screenshots/focus-redesign/`): one task `status` field (F1, shipped), four-band focus order with `place` and `rank` (F2), one `moved` group (F3), then the focus page stack, Queue and row menu (F4), done history (F5), the stale rule (F6), canvas filter by type (F7), Quick notes additions (F8). F1–F3 come after AG1 and before M4; F4–F8 after M5. Settles N22 and replaces N2.

## Later

- **FE** Move screens to Preact (roadmap D11), work items FE1–FE3 in `docs/preact-migration.md`: the Focus page after V5's F2/F3 and before F4; Quick notes after DM4, AU16, AU20, AU21 and before F8; dialogs only when next reworked.
- **DM6** Split `cards.js` (780 code lines) by card type, staying vanilla; board and shortcut cards are already in `boardcard.js`. Clears its ceiling.
- **DM7** Split `routes.js` (510 code lines) by area: canvases and items, focus and todos, trash, uploads and backup. Clears its ceiling.
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
- **AU22** Trashed images stay cached on the phone after Trash is emptied; the service worker never evicts /uploads entries (`sw.js`). Fix: evict cached uploads not referenced by any live item, e.g. on the warm message.
- **AU23** Cutting two connected cards together leaves their line behind with two free ends: clipboard.js sends one /move per card, so the first move frees the end before the second card follows (`clipboard.js:52`, `db.js` moveItemDeep). Fix: one /move with all ids and a shared inside set.
- **AU24** A line trashed with one card comes back invisible if its other card was moved away before the restore (`db.js` restore). Fix: run the same free-the-end step on restore.
- **U1.1, U1.4, U1.5** Milanote migration: backup and inventory, staged import, reconciliation report. Specs in `docs/next-updates.md`.
- **Q1** Mutation testing for the pure logic modules (`tasklist.js`, `focus.js` ranking, `savequeue.js`, `util.js`), on demand (`npm run mutate`) or a weekly non-required job. StrykerJS 10 covers both runners (Vitest runner; TAP runner for `node --test`). mizchi/mutator (oxc-based, much faster reruns, `--since main` PR mode) needs Vitest 5 and Node 24 and is Vitest-only; revisit after those upgrades.

## Needs a decision

- **DM3** Turn `db.js` into an item store that owns the board/canvas duality (write-through, projection, row serialisation). Conflicts with the documented "routes call prepared statements directly"; worth reopening because `tasks-api.js` is a second caller with the same invariants.

## Closed

- **DM2** `public/js/savequeue.js` is the one client save protocol (debounce, base, retry, adopt) for the canvas and Quick notes, unit-tested in Vitest.
- **AU5** Copied to-do cards get fresh task ids; the boot repair makes ids unique across cards (#71).
- **DM1** `tasklist.js` owns the task shape, blank rule, ids and the merge; the merge compares with defaults filled in.
- **AU1, AU2, AU3, AU11** Failed saves now retry, big background saves skip `keepalive`, Quick notes' base no longer erases stars and due dates; `e2e/saves.spec.js` covers all three.
- **V4** Voice tags are limited to tags already on the list (an `enum` built from the 100 most used). Done in #63.
- **AU7** `/ingest/text` blocked the pipeline's event loop during the model call. Fixed in #62.
- **AU13** `HANDOFF-NOTES.md` working log at the repo root. Deleted; open items moved here (#67).
