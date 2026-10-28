# Next updates: PWA (U2), then Milanote migration (U1)

Planned 2026-10-27 after the P1–P7 roadmap (`docs/roadmap.md`) shipped. The
ground rules from the roadmap still apply. Each update gets one PR with
tests. All six required checks must pass, and each PR merges with
`gh pr merge --squash --auto`, never `--admin`. A box is ticked when its
acceptance test lands.

## Decisions

| #   | Question                        | Decision                                                                                                                                       |
| --- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | How to get data out of Milanote | Test route B, reading Milanote's own board data, on one board. Fall back to route A, the improved Markdown + ZIP import, if B doesn't hold up. |
| Q2  | Boards already imported         | Move them to Trash, then re-import. They stay restorable until Trash is emptied.                                                               |
| Q3  | How the import runs             | A one-off script, run together. No import UI in the app.                                                                                       |
| Q4  | Offline on iPhone               | Network-first service worker. The app and the last-loaded boards open offline. No offline editing (roadmap D4 stands).                         |
| Q5  | App icon                        | A serif "M" (Fraunces) in the accent blue `#2f6df0` on white.                                                                                  |
| Q6  | Order                           | U2 first, then U1.                                                                                                                             |

## U2 · Mila as an iPhone app (PWA)

The goal: adding Mila to the Home Screen from Safari's Share menu gives it its
own icon, name and colours. It opens full screen with no address bar. With no
connection it still launches and shows the boards as they were last loaded.

Already in place: Tailscale Serve provides HTTPS, which a service worker
requires. The page uses `viewport-fit=cover`, and the mobile chrome already
pads `env(safe-area-inset-*)`. There is an in-app back button (`#mBack`). A
failed write toasts "Could not save — check your connection" (`api.js`
`write`).

- [x] **U2.1 Manifest and icons.**
  - `public/manifest.webmanifest`:
    - `name`/`short_name` "Mila", `display: standalone`, `start_url: "/"`.
    - `background_color` and `theme_color` from the `:root` tokens.
    - Icons at 192, 512 and a 512 maskable.
  - `public/icons/`: the PNGs above plus a 180 px `apple-touch-icon.png`.
    They are rendered once from one committed `icon.svg` (serif M, accent on
    white) and committed, with no build step.
  - `index.html` `<head>`:
    - `<link rel="manifest">` and `apple-touch-icon`.
    - `apple-mobile-web-app-title`.
    - `apple-mobile-web-app-status-bar-style` set to `default`.
    - `theme-color` twice, one per `prefers-color-scheme`.
  - `Dockerfile` needs no change, because it copies all of `public/`.
  - Acceptance: Playwright fetches the manifest. The test checks the fields
    and that every listed icon returns 200 with an image content type.
- [x] **U2.2 Network-first service worker.**
  - `public/sw.js`:
    - Same-origin `GET`s go to the network first, which updates the cache.
    - When the network fails, they fall back to the cached copy.
    - The Lucide `unpkg` script and Google Fonts are cached the same way.
    - Non-`GET` requests and `/api/backup` bypass it.
    - The cache is named with a version, and `activate` deletes old caches.
  - `main.js` registers it.
  - `server.js` serves `/sw.js` with `Cache-Control: no-cache`, so updates
    land on the next launch.
  - Acceptance:
    - Playwright: the service worker registers. Then
      `context.setOffline(true)` plus a reload still renders the last-opened
      board.
    - API test: the `/sw.js` header is set.
- [x] **U2.3 Standalone polish.**
  - `overscroll-behavior: none` on the page, so there's no pull-to-refresh or
    rubber-band.
  - `-webkit-touch-callout: none` on cards and the stage. Text fields keep
    it.
  - Acceptance: Playwright checks the computed styles. iPhone checks:
    1. Add to Home Screen.
    2. Check the icon and name.
    3. Check the notch and home bar.
    4. Turn on Airplane mode and confirm it still opens.
  - The Playwright part is in `e2e/mobile-board.spec.js`. The owner ran all four
    iPhone checks on the home server on 2026-10-28, and they passed.

Out of scope: offline editing, Web Share Target (iOS doesn't support it) and
push notifications.

## U1 · Everything from Milanote into milaclone

The goal: every Milanote board, sub-board, card, image and file lands in the
home-server milaclone. There are no duplicates, and a report shows nothing was
missed. Keep Milanote until that report is clean.

What `scripts/import-milanote-md.js` does today:

- It reads Milanote's per-board Markdown export.
- One level of sub-boards survives.
- Cards are laid out on a 3-wide grid.
- Columns, colours, lines, comments, files and deeper nesting are lost.
- A re-run duplicates everything.

What Milanote's own export offers:

- One board at a time, and Home itself can't be exported.
- A linear Markdown document.
- A separate emailed ZIP of each board's files.

There's no account export and no public API.

- [ ] **U1.1 Backup and inventory.**
  - Download `/api/backup` from the home server.
  - List every Milanote board as a tree, and every board already in
    milaclone. That gives a checklist of what's missing, partly imported and
    done.
  - Move the earlier imports to Trash (Q2).
  - Acceptance: the inventory is saved, and the backup file exists. The
    inventory lives in the gitignored `.private/milanote-inventory.md`, not
    `docs/`, because the repo is public and board titles are personal.
  - Milanote side done 2026-10-28 (Claude in Chrome, read-only, from
    `/api/boards?ids=`): 32 boards, 143 cards. By type: BOARD 31, CARD 36,
    IMAGE 30, LINK 18, COLUMN 10, COLOR_SWATCH 9, TASK_LIST 5, TABLE 2,
    ANNOTATION 2 and COMMENT_THREAD 1. There are no lines, aliases, files or
    documents.
  - What it means for the route-B reader (now built, see U1.2):
    - A to-do list's tasks are separate TASK elements whose parent is the list.
    - ANNOTATION is a freehand drawing, so it maps to sketch.
    - Only 1 card sits in Unsorted. The first count of 34 also took in cards
      inside columns, which use the same `INBOX` section.
    - Images are behind the Milanote login. Only 12 of the 30 have a file; the
      other 18 are empty image slots from a template.
  - Still open: the backup, the milaclone side of the checklist, and moving
    earlier imports to Trash.
- [x] **U1.2 Route B test, about an hour.**
  - With Milanote open and logged in, use Chrome DevTools to capture the data
    the web app loads for one board, which needs to have sub-boards, columns,
    images and a line.
  - Map each element type to milaclone's (table below).
  - Pass: the board's types, positions and nesting can all be read.
  - Fail: switch to route A. U1.3–U1.5 are the same either way, only the
    reader changes.
  - Acceptance: one sample board's JSON plus a written field mapping in this
    doc.
  - Passed 2026-10-28. Claude in Chrome captured every board, not just one,
    into a single file: `{ homeId, responses: { <boardId>: <response> } }`.
    Each response is what `app.milanote.com/api/boards?ids=<id>` returns.
    The capture stays in the gitignored `.private/` because the repo is
    public. `test/fixtures/milanote/board-data.json` is a made-up board with
    the same shape, and it stands in as the sample. The account has no lines,
    so the line mapping is still unseen (see below).
  - Field mapping, as `scripts/read-milanote-data.js` applies it:
    - **Tree:** each element's `location.parentId` is its board, column, list
      or card. `section` says how it sits:
      - `CANVAS`: free on the board at `position.{x, y}`.
      - `INBOX`: in a list (a column, the board's Unsorted panel or a task
        list), ordered by `position.score`. Its `index` is stale.
      - `ATTACHED`: pinned to a card (comment threads).
      - `TRASH`: deleted, so it is left out.
    - **Units:** positions and `content.width` are grid units of 10 px. Where
      no width is stored, the reader uses a default per type (cards 30 grid
      units, boards 12).
    - **Layout:** Milanote packs cards tighter than milaclone draws them. A
      settle pass moves a card down only as far as it needs to stop it
      overlapping the card above it, using estimated heights. Unsorted cards
      have no position and stack to the right of the board.
    - **Text:** `content.textContent` is ProseMirror JSON. The reader keeps the
      nodes and marks milaclone's editor knows and drops Milanote-only attrs
      (`key`, `textAlign`). An unknown node keeps its words as a paragraph.
    - **CARD → note:** `background.color` becomes the card colour.
    - **TASK_LIST → todo:** the title is the `taskListTitle` node, or
      `content.title` when `showTitle` is set. Tasks come from the `taskItem`
      nodes: `taskId`, `checked`, and nesting as `indent`. The separate TASK
      elements are the same tasks. A TASK missing from its list is reported.
    - **LINK → link:** `content.link.url` and `content.link.title`. A link with
      no URL is reported.
    - **IMAGE → image:** the file is at `content.image.original`, and the
      caption is shown when `showCaption` is set. An image with no `original`
      is an empty slot, and it's reported.
    - **COLUMN → column:** `content.title`. There's no collapsed state in the
      data.
    - **BOARD → board:** `content.title`, and `content.color` (hex or a name
      such as `BLUE`) maps by hue to milaclone's palette. Milanote's icons are
      its own SVGs, so they aren't kept.
    - **COLOR_SWATCH → swatch:** `content.color.value`.
    - **TABLE → table:** each cell's `value`.
    - **ANNOTATION → sketch:** each of `content.drawing.paths` becomes a
      stroke, with its `points` scaled into the 400×280 sketch box.
    - **COMMENT_THREAD → comment:** a comment card beside its card. The text
      comes from the response's `comments` that share its `threadId`, oldest
      first.
    - **Unseen in this account:** LINE, ALIAS, FILE and DOCUMENT. Any other
      type is reported as not imported, never dropped.
- [x] **U1.3 Importer script.**
  - `scripts/import-milanote.js` writes only through the existing API:
    `POST /api/item`, `/api/upload`, `PATCH`. No server changes.
  - Each created item carries `data.sourceId` (the Milanote id), and a re-run
    skips ids that already exist.
  - `--dry-run` prints the plan and counts and writes nothing.
  - Images and files are downloaded and uploaded one at a time while each
    board imports (route A takes them from the ZIP). That keeps memory within
    the container's 256 MB.
  - Acceptance: `node --test` against a fixture of the sample board checks
    four things:
    1. Types and positions.
    2. Nesting.
    3. A second run creates nothing.
    4. `--dry-run` makes no writes.
  - The engine has landed (`scripts/import-milanote.js`, with the route-A
    Markdown reader and `test/import-milanote.api.test.js`).
  - The route-B reader has landed too (`--reader milanote`,
    `scripts/read-milanote-data.js`). `test/import-milanote-data.api.test.js`
    runs the four checks against the route-B fixture.
  - Milanote's images need the login, so a second browser capture saves them
    as `data:` URIs keyed by URL. `--media` passes that file in. Without it,
    each Milanote-hosted image is reported, not turned into a dead link, so
    a later run with `--media` still adds it.
- [ ] **U1.4 Staged import.**
  - Run against the home server into a "From Milanote" board on Home.
  - Review it on desktop and phone.
  - Then move the boards to Home with `/move`.
  - Acceptance: the boards sit on Home and the staging board is empty.
- [ ] **U1.5 Reconciliation report.**
  - Per-board counts on both sides for cards, images, files and sub-boards.
  - Anything unmapped is listed by name, never dropped silently.
  - Acceptance: every count matches, or each difference is explained.

Card type mapping (route B). The field mapping is under U1.2.

| Milanote                       | milaclone                                   |
| ------------------------------ | ------------------------------------------- |
| card (`CARD`)                  | note                                        |
| task list (`TASK_LIST`)        | todo (nesting kept as indent)               |
| link (`LINK`)                  | link (embeds stay)                          |
| image (`IMAGE`)                | image (with caption)                        |
| file                           | file (unseen; reported until mapped)        |
| column (`COLUMN`)              | column (Milanote stores no collapsed state) |
| line                           | line (unseen; reported until mapped)        |
| board (`BOARD`)                | board (colour kept, icon not)               |
| board alias                    | shortcut (unseen; reported until mapped)    |
| colour swatch (`COLOR_SWATCH`) | swatch                                      |
| table (`TABLE`)                | table                                       |
| document                       | document (unseen; reported until mapped)    |
| drawing (`ANNOTATION`)         | sketch                                      |
| comment (`COMMENT_THREAD`)     | comment                                     |

## Risks

| Risk                                      | Mitigation                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| Duplicates or bad data on the live server | Backup first, `--dry-run`, the staging board, skip-by-`sourceId`          |
| Milanote asset URLs expiring mid-run      | Download as each board imports; route A's ZIP as a fallback               |
| A stale service-worker cache after deploy | Network-first, plus `no-cache` on `sw.js`                                 |
| Container memory during a large import    | Upload one file at a time                                                 |
| Milanote's web data shape is undocumented | It's a one-off run, tested on one board first, with route A as a fallback |
