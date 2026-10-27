# milaclone roadmap

The implementation plan for closing the gaps found in a feature comparison against Milanote (kept privately, not in this repo).
Scope was agreed on 2026-10-26: **40 Do · 4 Later · 1 Drop** across P1–P7. P0, the quality gates, shipped before implementation started.

Work through it top to bottom. Tick a box only when its acceptance check passes **as an automated test in CI** (unit/API in `test/`, UI in `e2e/`), unless the check says otherwise.

## Ground rules

- **Order:** P1 → P2 → P3 → P4 → P5 → P6 → P7 (D10). No phase starts until the one before it is merged.
- **Shipping (D9):** one branch and one PR per phase (`phase/pN-<slug>`), merged by the agent with `gh pr merge --squash` once every required check is green. A phase too large for one reviewable PR may split into `pNa`, `pNb`, which are merged in order.
- **Never** merge with `--admin`, skip or `.only` tests, lower the coverage floor, or edit branch protection to get a PR through. If CI stays red after two honest fix attempts, stop and report.
- Every PR body lists the feature IDs it closes and links the tests that prove each acceptance check.
- Before merging, run a review pass (`/code-review`) on the diff and fix what it confirms.
- Merging: `gh pr merge --squash --auto` queues the merge, and GitHub completes it once all six required checks pass. Never pass `--admin`.
- Update `CLAUDE.md` in the same PR when a phase changes architecture (the build step, new item types, new endpoints).
- Every new endpoint keeps the existing invariants: it filters `trashedBy IS NULL`, it is covered by `test/api.test.js`, and uploads keep the `setUploadHeaders` treatment.

## Decisions

| ID  | Decision                  | Choice                                                                                                                                                                                                                          |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Rich-text editor          | TipTap, bundled by esbuild via `buildSync` in `server.js` at boot into a gitignored `public/vendor/editor.js`. `esbuild` goes in `dependencies` (Docker runs `npm ci --omit=dev`). Loaded lazily with `import()`. No framework. |
| D2  | Left-drag on empty canvas | Draws a selection box. Pan with wheel/trackpad, space-drag or middle-drag.                                                                                                                                                      |
| D3  | Cross-board to-do list    | Keep Quick notes as it is (feature-map roadmap #11 dropped).                                                                                                                                                                    |
| D4  | Link previews             | Video/music embeds only. The server never fetches URLs.                                                                                                                                                                         |
| D5  | Undo scope                | Every operation, per tab. **Deferred along with F3.3**; cmd+Z keeps undoing deletes until then.                                                                                                                                 |
| D6  | Colour palette            | Keep milaclone's 12 colours and add "None". No migration.                                                                                                                                                                       |
| D7  | Lines, first version      | Straight lines only, with arrowheads, dashed style, colour and a label.                                                                                                                                                         |
| D8  | Dark mode                 | Follow `prefers-color-scheme`. No in-app switch.                                                                                                                                                                                |
| D9  | Shipping                  | One PR per phase, merged by the agent when CI is green, before the next phase starts.                                                                                                                                           |
| D10 | Phase order               | As planned: P1 → P7; P0 shipped first.                                                                                                                                                                                          |

## P0 · Quality gates — done before the goal

Set up in the `chore/quality-gates` PR, at the user's request, so auto-merged phases ship behind enforced checks.

- [x] **G1 Branch protection on `main`.** PRs required. Six required checks: `Lint`, `Format`, `Unit / API tests`, `UI unit tests`, `E2E tests`, `Docker smoke`. Branches must be up to date before merging. Admins are included, and force-pushes and deletion are blocked. Auto-merge and delete-branch-on-merge are on, and all merge methods are allowed.
- [x] **G2 Coverage floor at 80%.** `npm test` fails when backend line, branch or function coverage drops under 80%. Vitest applies the same floor per file to the front-end modules listed in `vitest.config.mjs`. A phase may raise either floor but never lower it.
- [x] **G3 Lint and format.** oxlint (`--deny-warnings`, with `no-undef` as an error) and a Prettier check run as separate required checks.
- [x] **G4 Docker smoke.** CI builds the image, boots it, creates an item through the API and loads the page. Once P4 lands, it also fetches `/vendor/editor.js`.
- [x] **G5 Strict Playwright.** `forbidOnly` is on in CI, `retries` is 0, and every job has a timeout. Browser binaries are cached per Playwright version.
- [x] **G6 PR template.** `.github/pull_request_template.md` maps each feature ID to its test.
- [x] **Security.** Dependabot alerts and security updates are on. Secret scanning with push protection was already enabled.
- [x] **UI unit tests.** Vitest and jsdom cover the front-end modules in `test/ui/`. Each phase adds Vitest tests for any pure front-end logic it introduces and puts that module in the coverage thresholds. Playwright covers the rest.

## P1 · Robustness tail

- [x] **F1.1 Trash view with restore** (S).
  - `GET /api/trash` lists the top-level trashed items, newest first. A sheet lets you restore them.
  - Acceptance: trash an item, then GET it from `/api/trash`, restore it, and its whole subtree is live again.
- [x] **F1.2 Empty trash** (S).
  - Hard-deletes the trashed rows and unlinks their upload files, after a confirm step.
  - Acceptance: once it's emptied, the rows and the upload files are gone, and files referenced by live items survive.
- [x] **F1.3 Reparent guard** (S).
  - A PATCH with `parentItemId` must point at a live column on the same canvas.
  - Acceptance: a PATCH to a missing column, a trashed column, a column on another canvas, or a non-column item returns 400.
- [x] **F1.4 Reload when the tab regains focus** (S).
  - On `visibilitychange`→visible, flush pending saves, then refetch the canvas and Quick notes.
  - Acceptance (e2e): change an item through the API, refocus the page, and the change shows.
- [x] **F1.5 Audio/video uploads and rejection reasons** (S).
  - Allow `audio/*` and `video/*`. A rejected file gets a 415 with the reason, and the toast shows it.
  - Acceptance: an mp3 or mp4 upload returns 200, and a disallowed type returns 415 with the reason in the body.
- [x] **F1.6 Fix the flaky double-tap test** (S).
  - Remove the 120 ms gap in `e2e/mobile-board.spec.js`.
  - Acceptance: the spec passes 20 times in a row with `--repeat-each=20`.

## P2 · Capture

- [x] **F2.1 Paste from the system clipboard** (M).
  - Pasted images, URLs and text become cards. Copying a card writes a marker, so cmd+V still deep-copies it through `/copy`.
  - Acceptance (e2e): pasting an image, a URL and plain text creates an image card, a link card and a note. Copying a card and pasting it creates a deep copy.
- [x] **F2.2 Drag and drop from the computer** (M).
  - Dropped files upload and are laid out in a grid at the drop point. Dropped links become link cards.
  - Acceptance (e2e): dropping two files makes two cards at the drop point.
- [x] **F2.3 Video/music embeds** (S).
  - YouTube, Vimeo and Spotify URLs become iframe embeds. The server fetches nothing.
  - Acceptance: each provider's URL maps to the right embed `src`, and other URLs stay plain link cards.
- [x] **F2.4 Image lightbox** (S).
  - Double-clicking an image opens it full size in a `<dialog>`. ←/→ step through the board's images, and Esc closes it.
  - Acceptance (e2e): it opens, steps to the next image and closes.
- [x] **F2.5 Image caption and transparent background** (S).
  - Acceptance: both fields survive a reload.
- [x] **F2.6 File icons and media players** (S).
  - Each file extension gets a lucide icon. Audio and video files get native `<audio>` and `<video>` players.
  - Acceptance (e2e): an uploaded mp3 renders an `<audio>` element.

## P3 · Canvas mechanics

- [x] **F3.1 Multi-select and selection box** (L).
  - A selection set replaces `state.selectedId`.
  - Left-drag on empty canvas draws a selection box. Shift-click toggles a card in or out of the selection.
  - Space-drag or middle-drag pans.
  - Acceptance (e2e): a selection box around three cards selects all three, and space-drag pans without selecting.
- [x] **F3.2 Group actions** (M).
  - Move, delete, copy, duplicate and colour every selected card. cmd+A selects all.
  - A group delete can be undone with a single toast Undo, which restores each item.
  - Acceptance (e2e): dragging two selected cards moves both. Deleting both and pressing Undo restores both.
- [x] **F3.4 Stacking order** (S).
  - Each card gets a `z` value. Dragging a card raises it, and the menu has bring-to-front and send-to-back.
  - Acceptance: the order persists after a reload.
- [x] **F3.5 Grid snap and arrow-key nudge** (S).
  - Cards snap to a 10 px grid, and shift turns snapping off. Arrow keys nudge by 1 grid step, shift+arrow by 10.
  - Acceptance (e2e): a dropped card lands on multiples of 10.
- [x] **F3.7 Zoom keys** (S).
  - z zooms to fit. cmd+= / − / 0 zoom the canvas, and `preventDefault` stops the browser zooming the page.
  - Acceptance (e2e): the canvas scale changes and the page zoom doesn't.
- [x] **F3.8 Shortcuts sheet** (S).
  - `/` opens the list of keyboard shortcuts.
  - Acceptance (e2e): it opens and closes.
- [x] **F3.10 Palette: add "None"** (S, D6).
  - Keep the 12 colours and add a "None" option that clears the colour.
  - Acceptance: choosing None removes `color` from the item.
- [x] **F3.11 Navigation keys and header rename** (S).
  - cmd+[ goes back, cmd+] goes forward and cmd+U goes up a board. Clicking the board title in the header renames the board.
  - Acceptance (e2e): each key navigates, and the renamed title persists.

## P4 · Rich text

- [x] **F4.1 Build step** (S).
  - `server.js` runs esbuild `buildSync` on `public/js/editor.js`, writing `public/vendor/editor.js` (gitignored) at boot.
  - Acceptance: G4's Docker smoke fetches the bundle, and the Playwright webServer boots with the bundle present.
- [x] **F4.2 TipTap note editor** (M).
  - Supports bold, italic, headings, lists, checklists, quotes, code, highlight, links and markdown shortcuts.
  - The editor is loaded with `import()` the first time a note is edited.
  - Acceptance (e2e): typing `**x**` renders bold, and the bundle isn't requested until a note is edited.
- [x] **F4.3 One body per note** (M).
  - Notes store `data.doc` (TipTap JSON) and `data.text` (plain text).
  - A one-time migration converts old title + body notes, after a `db.backup()`.
  - Acceptance: a migrated note keeps its title and body text. Quick notes, the importer and search all read `data.text`.
- [x] **F4.4 Rich text in comment cards** (S).
  - Acceptance (e2e): a comment card supports bold.

## P5 · Find & keep

- [x] **F5.1 Global search** (M).
  - `GET /api/search` searches board titles and card `data.text`, skipping trashed rows. cmd+K opens the results with breadcrumbs.
  - Acceptance: search finds text on a nested board and not in trashed items. In the e2e test, clicking a result opens that board.
- [x] **F5.2 Markdown export** (M).
  - Exports a board in the format the importer in `scripts/import-milanote-md.js` reads.
  - Acceptance: export, then import, gives back the same titles, text and tasks.
- [x] **F5.3 Backup download** (S).
  - Downloads a `db.backup()` snapshot from the Export menu. This replaces the current toast stub at `viewport.js:78`.
  - Acceptance: the response is a valid SQLite file that opens and contains the items.
- [x] **F5.4 Dark mode** (M, D8).
  - Replace the hardcoded colours with variables, then override the variables under `prefers-color-scheme: dark`.
  - Acceptance (e2e with `colorScheme: 'dark'`): the body background is dark and the card text contrast is at least 4.5:1.

## P6 · New elements

- [x] **F6.1 Lines** (L, D7).
  - An SVG layer. Each end of a line attaches to a card or sits at a free point.
  - Lines support arrowheads, a dashed style, colour and a label. They are straight only.
  - Acceptance (e2e): a line between two cards follows a card when it moves, and survives a reload.
- [x] **F6.2 Colour swatch** (S).
  - A card showing a hex colour, which copies it when clicked. Typing a hex code into a new card creates a swatch.
  - Acceptance: typing `#ff8800` creates a swatch.
- [x] **F6.3 Sketch** (M).
  - A freehand pen in 4 sizes with the palette colours, plus an eraser. Strokes are stored as SVG paths.
  - Acceptance (e2e): a drawn stroke persists after a reload.
- [x] **F6.4 Document** (M).
  - A card that opens a full-screen TipTap editor with a word count.
  - Acceptance (e2e): text typed in the editor persists, and the word count updates.
- [x] **F6.5 Table, simple** (M, reduced scope).
  - A grid of plain-text cells. You can add and remove rows and columns, and tab moves between cells.
  - **No formulas and no cell types in this first version.**
  - Acceptance (e2e): edited cells and an added row persist after a reload.

## P7 · Organisation

- [x] **F7.1 Nested tasks** (S).
  - Each task gets an indent level, changed with tab and shift+tab. It works with `mergeTasks`.
  - Acceptance: the merge keeps the indent level when both sides have edited the list.
- [x] **F7.2 Drag to reorder tasks** (S).
  - Within a to-do card.
  - Acceptance (e2e): the new order persists.
- [x] **F7.3 Due dates and tags on canvas cards** (S).
  - Show the Quick notes `due` and `tags` fields on to-do cards.
  - Acceptance (e2e): a due date set in Quick notes shows on the canvas card.
- [x] **F7.4 Collapsible columns with counts** (S).
  - The collapse state is saved on the column.
  - Acceptance: a collapsed column stays collapsed after a reload and shows its card count.
- [x] **F7.5 Board shortcut** (S).
  - An alias card that opens another board. It shows as broken if that board is trashed.
  - Acceptance: the alias opens its target board, and shows as broken once the target is trashed.
- [x] **F7.6 Templates** (S).
  - Boards kept inside a "Templates" board. "New from template" copies one with `/copy`.
  - Acceptance: the copy is deep, and editing it leaves the template unchanged.
- [x] **F7.7 Labels and filtering** (M).
  - Coloured labels on any card, and a filter that dims or hides cards without the chosen labels.
  - Acceptance: labels persist. In the e2e test, filtering by a label hides the cards without it.

## Later

These are not part of this roadmap. Each needs a fresh scoping pass before work starts.

- **F3.3 Undo/redo for everything** (L). Moved to Later at review. D5 (every operation, per tab) still describes how it should eventually work. Until then, cmd+Z only undoes deletes.
- **F3.6 Align and distribute** (M).
- **F3.9 Double-click to create a note** (S). Moved to Later at review.
- **F5.5 Board background colours** (S).

## Dropped

- **F7.8 Synced clones.** A card mirrored in several places, where editing one updates them all.
- **Feature-map roadmap #11, a cross-board to-do view.** Quick notes already covers this (D3).

## Out of scope

- Accounts, sharing, permissions, realtime presence and notifications. milaclone is single-user and self-hosted.
- Comment threads with @mentions and reactions. Comment cards stay as single notes.
- PNG and PDF export, and a ZIP of uploads. Uploads already live on their own Docker volume.
- Link previews fetched by the server (D4), and Milanote's Quick Notes inbox board.

## Scope changes at review

- F3.3 and F3.9 changed from Do to Later. F7.7 changed from Later to Do.
- F6.5 was submitted as Later, with the note "lets do simple table elements without formulas or types in this first iteration". This doc reads that as **Do, with reduced scope**: a simple table in P6. If you meant to keep it as Later, move it back.
- P0 was added at the user's request: "thorough and enforced CI CD checks and tests in place before we start shipping phases".
