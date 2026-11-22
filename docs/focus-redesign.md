# Focus redesign: task fields, four bands, done history, filters

Planned 2026-11-22 with the owner, from mockups made that day. It settles
backlog item V5 and decision N22 in `docs/next-phases.md`, and replaces N2, the
Stale mode in M2.3 and the Filed mode in M3.3. Where this plan and
`docs/next-phases.md` disagree, this plan is the newer decision.

The ground rules from `docs/roadmap.md` apply: one PR per item with tests, the
required checks green, core never imports from `addons/`. A box is ticked when
its acceptance test lands.

## Mockups

In `docs/screenshots/focus-redesign/`. They are static, dark theme only, with
sample data; light theme uses the same tokens the pages have today. Where a
mockup and this text disagree, the text wins.

| File                                         | Shows                                                | Item   |
| -------------------------------------------- | ---------------------------------------------------- | ------ |
| `three.png`, `three-phone.png`               | The three with the Done today and Queue edge links   | F4     |
| `queue.png`                                  | Queue with the row menu open, Complete mid-hold      | F4     |
| `queue-phone-menu.png`                       | Phone Queue with the row menu as a bottom sheet      | F4     |
| `done-today.png`, `done-today-phone.png`     | Done today with one set-aside (stale) task           | F5, F6 |
| `done-earlier.png`, `done-earlier-phone.png` | The history above Done today                         | F5     |
| `canvas-filter.png`                          | The canvas with the Filter panel open on To-dos      | F7     |
| `quicknotes-home.png`, `quicknotes-all.png`  | Quick notes: Focus link, quick filters, rank numbers | F8     |

## Decisions

| #   | Question              | Decision                                                                                                                                                                                                                                              |
| --- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Order                 | F1–F3 come after the board agents (AG1) and before the watch app (M4), so the watch and the digest are built once against the final fields. F4–F8 come after M5                                                                                       |
| R2  | Task state            | One `status` field: `open`, `done` or `stale`. It replaces `done` and `stale`, so a task is never both. No `deleted` state: a deleted task leaves its list, as now                                                                                    |
| R3  | When and why          | `statusAt` (ms) is when the task entered its status; `statusReason` is why (the stale rule's reason). The server stamps `statusAt` whenever a write changes `status`. Not `updatedAt`: an edit or a star must not move it                             |
| R4  | The owner's ordering  | `place: { band, order }`, band `top` or `bottom`. It replaces `focusOrder`. Only the owner's actions write it                                                                                                                                         |
| R5  | The ranker's ordering | `rank: { score, reason, at }`. It replaces `rankScore`, `rankReason` and `rankedAt`. `rankNudge` and `RANK_NUDGE` are removed. Only the ranking service writes it                                                                                     |
| R6  | Moves                 | `moved: { from, at, by, reason }` replaces `movedFrom`, `movedAt`, `movedBy`, `moveReason`                                                                                                                                                            |
| R7  | Other fields          | Unchanged: `id`, `text`, `starred`, `due`, `tags`, `note`, `noteStyle`, `createdAt`, `indent`, `source`, `importId`                                                                                                                                   |
| R8  | Focus order           | Four bands, replacing N2's tiers: **due now** (overdue, most overdue first, then due today) → **yours** (`place.band` `top`, by `order`) → **everything else** → **sent to bottom** (`place.band` `bottom`, by `order`)                               |
| R9  | Everything else       | By `rank.score`, highest first. Unscored tasks follow: due soonest, then starred, then oldest. The model only ever orders this band                                                                                                                   |
| R10 | Dragging              | A drag places the dragged task only, into the "yours" band at the drop position. Dropped below the last placed task, it becomes the last of "yours". Due-now tasks cannot be dragged or dropped above                                                 |
| R11 | Send to               | **The three**: first in "yours". Disabled while three or more tasks are due now. **Top of queue**: directly after the current three; an unplaced task in the three is placed too, to hold its spot. **Bottom**: last of the bottom band               |
| R12 | Reset order           | Clears every `place`                                                                                                                                                                                                                                  |
| R13 | Focus page shape      | One vertical stack, no modes and no mode switch: Done earlier, Done today, the three, the Queue. It opens on the three. Pulling down shows Done today and snaps there; older history scrolls freely. The Queue repeats the three at its top           |
| R14 | Done history          | Tasks with `status` `done` or `stale`, by `statusAt` day in `TASK_TZ`: Today, Yesterday, Earlier this week, Earlier this month, then one section per month. A task with no `statusAt` (done before F1) is not listed                                  |
| R15 | Stale rule            | As planned in M2.3, fixed, never the model's call: more than 30 days old with no upcoming due date and not starred, or more than 14 days overdue. Age counts from the later of `createdAt` and `statusAt`, so a put-back task gets a fresh 30 days    |
| R16 | Stale in the history  | In the same timeline as done tasks, on the day it was set aside. Marked so it can't read as finished: an amber icon, full-strength text and its age ("34 days overdue", "Added 3 months ago"). The heading counts them apart ("8 done · 1 set aside") |
| R17 | Acting on a stale row | **Put back** (a tap): `status` `open`, placed at the top of the queue. **Complete** and **Delete**: press and hold                                                                                                                                    |
| R18 | Row menu              | Send to the three, top of queue, bottom of queue; Add or Remove star; Complete; Delete. A bottom sheet on a phone. Due-now rows get the menu without the three send actions                                                                           |
| R19 | Hold                  | Complete and Delete in the row menu and on a stale row need a hold of the same length as the done ring (`HOLD_MS`). The row fills as it is held; letting go early cancels                                                                             |
| R20 | Deleting a task       | Removes it from its list. A "Deleted · Undo" toast puts it back. No trash for single tasks                                                                                                                                                            |
| R21 | Boards view           | Not built. Seeing tasks in board context is the canvas with a filter (F7); seeing every list at once is Quick notes (F8)                                                                                                                              |
| R22 | Canvas filter         | In the existing **Filter** button's panel: Everything, To-dos or Notes. To-dos adds search over task text and tags, Due (Any, Overdue, Today, This week), Starred, Hide done, and tag chips. The label filter keeps its place in the panel            |
| R23 | What a filter hides   | Cards of other types are hidden. Board cards always stay and show their matching count ("4 open tasks"); a board with none fades. Inside a to-do card, tasks that don't match are hidden; a list with no match fades and keeps its place              |
| R24 | Filter lifetime       | Stays on while moving between boards (today `openCanvas` resets the label filter; this filter is not reset). Not saved: a reload clears it                                                                                                            |
| R25 | Rank numbers          | Quick notes shows each open task's focus rank as a small number inside its checkbox circle. It is the true rank across all lists, also while a filter is on (so 2, 5, 9). Three digits widen the circle into a pill                                   |
| R26 | Nightly filing        | No Filed mode. Each nightly run writes a detailed filing log the owner and the Home orchestrator (W4) can read: every Inbox task it considered, the decision and the reason. "Back to Inbox" moves to the row menu                                    |

## F1 · One status field

- [x] **F1.1 `status`, `statusAt`, `statusReason`.** `tasklist.js` defines them
      (default `open`, `null`, `null`) and stamps `statusAt` when a write
      changes `status`, in the merge and in every server write. Quick notes'
      `normTask` follows.
  - A boot migration (after a `VACUUM INTO` backup, like `migrateRichText`)
    turns `done: true` into `status: "done"` with `statusAt: null`, and drops
    `done` and `stale`.
  - Every reader moves over: `focus.js`, `tasks-api.js`, `export-md.js`,
    `scripts/import-milanote-md.js`, `public/js/cards.js`, `quicknotes.js`,
    `focuspage.js`, and the voice add-on where it reads `done`.
  - Task API: responses carry `status` and `statusAt`. `PATCH` accepts
    `status`; `{ "done": true }` stays as input shorthand for
    `status: "done"`. `GET /api/tasks?status=` also takes `stale`.
  - The Markdown export keeps `- [x]`: the round trip with the importer is
    unchanged.
  - Acceptance: the migration test converts old rows and is a no-op on a second
    boot; a merge test marks a task done on one device while another edits its
    text and keeps both; `statusAt` is the server's clock, not the client's.

## F2 · Four bands

- [ ] **F2.1 `place`, `rank` and the order.** `focus.js` `orderTasks` ranks by
      R8 and R9. The boot migration turns `focusOrder` into
      `place: { band: "top", order }`, and `rankScore`/`rankReason`/`rankedAt`
      into `rank`, and drops `rankNudge`.
  - `withIds` drops `place` from a task given a fresh id (as it drops
    `focusOrder` today).
  - `PUT /api/focus/order` takes `{ top: [ids], bottom: [ids] }`; every other
    task loses its `place`. `PUT /api/tasks/rank` takes
    `[{ id, score, reason }]`.
  - The ranking service stops sending nudges; `RANK_NUDGE` is removed from the
    add-on, its README and `.env.example`.
  - `focusorder.js` `placementAfterDrop` follows R10.
  - Acceptance: an order test per band boundary (a placed task below a
    due-today one, above a high-scored one; a bottom task below an unscored
    one); a drag places one task; the ranker's write never changes `place`.

## F3 · One moved group

- [ ] **F3.1 `moved`.** `tasks-api.js` writes `moved: { from, at, by, reason }`;
      the boot migration folds the four old fields in. `docs/task-api.md`
      follows.
  - Acceptance: the existing move tests pass against the new shape; the
    migration test covers a moved task.

## F4 · The stack, the Queue and the row menu

- [ ] **F4.1 The stack.** `/focus` becomes the stack of R13: edge links
      ("Done today · 8", "Queue · 4") on the three, "The three" on the Queue.
      `#list` keeps working and scrolls to the Queue.
- [ ] **F4.2 Queue rows.** Dense rows under "The three" and "Queue · N"
      headings: rank number, title, list and board, a pin after the title when
      placed, a star when starred, the due date in its own column. Movable rows
      have a grip, up and down buttons (desktop) and the menu button; due-now
      rows show a lock. "Reset order" sits in the header.
- [ ] **F4.3 Row menu.** R18–R20, including "Back to Inbox" on a task the
      ranking service filed in the last 7 days (R26).
  - Acceptance (e2e): send a task to the three and the old third becomes
    fourth; a short press on Complete does nothing and a full hold completes
    it; Delete then Undo leaves the list as it was.

## F5 · Done history

- [ ] **F5.1 History route and sections.** A board route returns done and stale
      tasks by `statusAt`, newest first, a page at a time. The page renders R14
      above the three with the snap of R13.
  - Acceptance: an API test for the day boundaries in `TASK_TZ`; e2e: finish a
    task on the three and it appears under Done today.

## F6 · The stale rule

- [ ] **F6.1 Rule and rows.** The ranking service applies R15 each night and
      sets `status: "stale"` with `statusReason` through the task API. The
      history shows R16 and R17. Ships with or after F5, never before: a stale
      task must be visible somewhere.
  - Acceptance: the rule's unit tests (30 days, 14 days overdue, starred
    exempt, put back resets the clock); e2e: Put back returns the task to the
    top of the queue.

## F7 · Canvas filter

- [ ] **F7.1 Filter by type.** R22–R24 in the main app. The filter state lives
      in `state.js`; `cards.js` applies it where it applies the label filter.
      Board cards get their counts from one route, not one request per board.
  - Acceptance (e2e): To-dos hides a note and keeps a board card with its
    count; the filter is still on after opening another board; a reload clears
    it.

## F8 · Quick notes

- [ ] **F8.1 Focus link.** A slim "Focus" row on the home screen that opens
      `/focus`.
- [ ] **F8.2 Quick filters.** Overdue, Due this week and Starred chips ahead of
      the tag chips, in one row that scrolls sideways.
- [ ] **F8.3 Rank numbers.** R25. Quick notes reads the rank from the focus
      order; it never computes one.
  - Acceptance (e2e): the number in a task's circle matches its position on
    `/focus`; with the Starred chip on, numbers are unchanged.

## Not in this plan

- A Boards view or page (R21).
- Rank numbers or new styling on canvas to-do cards.
- A trash for single tasks, or a `deleted` status (R2, R20).
- Live updates on the focus page (still in the `docs/next-phases.md` backlog).
