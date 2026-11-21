# Next phases: backlog import, focus, filing, watch, digest

Planned 2026-11-20 with the owner, after the voice add-on (handoff Phases 1–3)
shipped. It picks up the handoff's Phases 4 and 5 and adds list filing, a
Pebble watch app and an import of the owner's Microsoft To Do backlog. Where
this plan and the original handoff disagree, this plan is the newer decision.

The ground rules from `docs/roadmap.md` still apply: one PR per item with
tests, the six required checks green, `gh pr merge --squash`, never `--admin`.
Core code still never imports from `addons/`, and the board must work the same
with every add-on off. A box is ticked when its acceptance test lands.

## Decisions

| #   | Question                   | Decision                                                                                                                                                       |
| --- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1  | Order                      | Backlog import, then ranking and the focus page, then filing, then the watch app, then the morning digest                                                      |
| N2  | Who ranks                  | Fixed tiers first; the model orders within a tier and may move a task one tier up or down (at most 3 a night, a setting turns this off or lifts the cap)       |
| N3  | Which tasks are ranked     | Every open task, except lists labelled **Reference** and the Templates board                                                                                   |
| N4  | Stale                      | A fixed rule, never the model's call; stale tasks stay on their lists, hidden from the focus three                                                             |
| N5  | Pinning                    | No pin button. The owner drags tasks in the focus page's List mode; the top three are the focus three                                                          |
| N6  | Owner order vs ranking     | A task the owner placed keeps its place and the model never moves it. Only overdue and due-today tasks rise above it. **Reset** clears all placements          |
| N7  | Ranking model              | Opus 5.5 at low effort by default (`RANK_MODEL`); about $1 a month for one call a night                                                                        |
| N8  | Where ranking runs         | Its own Compose service built from the pipeline image, behind the voice profile, nightly at 03:00 in `TASK_TZ`                                                 |
| N9  | Focus page updates         | No polling. It refetches when it becomes visible again and from a refresh control. No "re-rank now" (the board never calls an add-on)                          |
| N10 | Switches                   | Card labels, not new settings: **Reference** (left out of ranking), **Filing** (may receive filed tasks)                                                       |
| N11 | Filing                     | At capture, only when a Filing list is named. Nightly, only Inbox tasks, only when exactly one Filing list clearly fits, every move recorded and undoable      |
| N12 | Watch app                  | `addons/pebble/`, following the owner's watch handoff. Raw audio is the main capture, dictation a setting. Own code only (the reference repos have no licence) |
| N13 | Narrow tokens              | The watch and Home Assistant each get their own token, limited to what they use                                                                                |
| N14 | Digest                     | Run by Home Assistant: a phone notification on weekday mornings with Done buttons, then a later Echo announcement when someone is home. No evening reminder    |
| N15 | Recordings                 | Audio deleted 7 days after it is processed; transcripts and results kept                                                                                       |
| N16 | "Tasks added" notification | Not built; failure alerts stay                                                                                                                                 |
| N17 | Microsoft To Do backlog    | Exported and cleaned up by the owner outside this repo; this repo gets a generic importer for the cleaned file                                                 |

## M1 · Backlog import

- [ ] **M1.1 `scripts/import-tasks-json.js`.** Reads a `milaclone-import/1`
      file: `lists[]`, each with `name`, `target` (`{ new: true, title? }` or
      `{ listId }`) and `tasks[]` (`importId`, `title`, `note?`, `due?`,
      `starred?`, `tags?`).
  - New lists are to-do cards on a board "From Microsoft To Do" on Home (made
    through the board API); tasks go in through `POST /api/tasks` with
    `listId`, `importId` and `source: migration`, so a re-run creates nothing
    twice.
  - `--dry-run` prints what would be created; every rejected row is reported,
    never dropped silently.
  - Imported tasks are new tasks on import day, so nothing kept in the cleanup
    turns stale on the first night.
  - Acceptance: an API test imports a fixture twice and creates each task
    once; a bad row is reported with its reason.

## M2 · Ranking and the focus page

- [ ] **M2.1 Ordering in core.** One function computes the order from the
      task fields, so the focus page, the task API and the digest never
      disagree.
  - Tiers: overdue (most overdue first) → due today → due within 3 days →
    starred → the rest. Within a tier, `rankScore` when present, else oldest
    first.
  - The owner's placements (`placedAt`/position fields on the task) win over
    tiers and scores, except overdue and due today.
  - Left out: done, stale, blank, tasks on lists labelled Reference, the
    Templates board.
  - `GET /api/tasks?view=focus&limit=3` (task API, token) and a board route
    for the page.
- [ ] **M2.2 `/focus` page.** Full screen, light and dark, large heavy type,
      lots of space, no chrome.
  - **Three** (default): titles only, a small muted line when due or overdue,
    the model's reason on hover. Click → "Done?" ✓ ✕ (✕ or 5 s cancels) →
    strike-through and fade (about a second) → the next task slides in.
  - **List**: every ranked task, scrollable, drag to reorder; overdue and due
    today marked. **Reset** clears placements.
  - **Stale**: stale tasks with their reason; select several → Keep or Delete
    (Delete goes to Trash).
  - **Filed**: the last 7 days of nightly moves, each with Back to Inbox.
  - Mode switch and refresh appear only on hover. Refetch on
    `visibilitychange` and refresh; no timers.
  - Mac setup in the docs: app-mode browser window, open at login, display
    sleep left on overnight.
- [ ] **M2.3 Ranking service** (add-on). Nightly at 03:00: reads open tasks,
      the **Focus priorities** note on Home if there is one, and asks the
      `RANK_*` model for a score, a one-line reason and at most 3 one-tier
      moves (`RANK_NUDGE=off|one-tier|free`).
  - Stale rule: more than 30 days old with no upcoming due date and not
    starred, or more than 14 days overdue; reason saved ("added Oct 12, no
    date", "overdue since Nov 3"). Age counts from `createdAt`, or from the
    first night the ranker saw the task.
  - Writes through the task API. Logs tokens, cost and the top three before and
    after. Failure leaves the fixed order in place.
- [ ] **M2.4 Recording retention.** Audio deleted 7 days after `done`;
      failed ingests keep theirs.

## M3 · Filing into lists

- [ ] **M3.1 Move in the task API.** `PATCH /api/tasks/:id` accepts `listId`;
      the move records `movedFrom`, `movedAt`, `movedBy`, `moveReason`.
- [ ] **M3.2 At capture.** Extraction gets the Filing lists as an enum (like
      tags) and files a task only when the speaker names one; ambiguous names
      go to the Inbox.
- [ ] **M3.3 Nightly.** The ranking pass may move Inbox tasks into exactly one
      clearly fitting Filing list, with a reason; shown in the Filed mode with
      Back to Inbox.

## M4 · Pebble watch app

- [ ] **M4.1 Server side.** Narrow tokens (watch, later Home Assistant);
      `/ingest/audio` also takes JSON base64 PCM; a client capture id makes a
      resend a no-op; an authenticated connection test.
- [ ] **M4.2 Watch app** in `addons/pebble/`, in the watch handoff's order:
      the device spikes first (tailnet reachability from the phone, microphone
      on iOS, a 3-minute recording, quick launch timing, hold-to-speak), then
      plugin and settings, focus list, dictation, audio capture, polish.
  - Footer: overdue and due-today counts only. 3-minute cap with a warning 15
    s before. README: any free quick launch button, Tailscale VPN On Demand.

## M5 · Morning digest

- [ ] **M5.1 Digest data.** A token-protected read of the focus three plus any
      other overdue or due-today tasks, at most 8 lines.
- [ ] **M5.2 Home Assistant recipe** (add-on docs): weekday notification with
      a Done button per task (default 07:30), an Echo announcement recalculated
      at its own time (default 09:30) when someone is home, and the Done
      action marking the task done with the Home Assistant token.

## Backlog

- Live updates on the focus page when a task changes elsewhere (WebSocket or
  server-sent events).

## Risks

| Risk                                                 | Mitigation                                                            |
| ---------------------------------------------------- | --------------------------------------------------------------------- |
| Ranking hides something that matters                 | Overdue and due today always on top; stale only by fixed rule; logs   |
| A filed task is never seen again                     | Filing lists are opt-in; Filed mode with undo; filed tasks still rank |
| The browser doesn't report a display wake as visible | Refresh control; tested on the owner's Mac                            |
| The watch can't reach the server through the phone   | First spike in M4.2; stop and re-plan if it fails                     |
| Duplicates from the backlog import                   | Cleanup before import, `importId`, `--dry-run`                        |
