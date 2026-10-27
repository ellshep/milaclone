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

- [ ] **U2.1 Manifest and icons.**
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
- [ ] **U2.2 Network-first service worker.**
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
- [ ] **U2.3 Standalone polish.**
  - `overscroll-behavior: none` on the page, so there's no pull-to-refresh or
    rubber-band.
  - `-webkit-touch-callout: none` on cards and the stage. Text fields keep
    it.
  - Acceptance: Playwright checks the computed styles. iPhone checks:
    1. Add to Home Screen.
    2. Check the icon and name.
    3. Check the notch and home bar.
    4. Turn on Airplane mode and confirm it still opens.

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
  - Acceptance: the inventory is saved as `docs/milanote-inventory.md`, and
    the backup file exists.
- [ ] **U1.2 Route B test, about an hour.**
  - With Milanote open and logged in, use Chrome DevTools to capture the data
    the web app loads for one board, which needs to have sub-boards, columns,
    images and a line.
  - Map each element type to milaclone's (table below).
  - Pass: the board's types, positions and nesting can all be read.
  - Fail: switch to route A. U1.3–U1.5 are the same either way, only the
    reader changes.
  - Acceptance: one sample board's JSON plus a written field mapping in this
    doc.
- [ ] **U1.3 Importer script.**
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
- [ ] **U1.4 Staged import.**
  - Run against the home server into a "From Milanote" board on Home.
  - Review it on desktop and phone.
  - Then move the boards to Home with `/move`.
  - Acceptance: the boards sit on Home and the staging board is empty.
- [ ] **U1.5 Reconciliation report.**
  - Per-board counts on both sides for cards, images, files and sub-boards.
  - Anything unmapped is listed by name, never dropped silently.
  - Acceptance: every count matches, or each difference is explained.

Card type mapping (route B):

| Milanote      | milaclone                     |
| ------------- | ----------------------------- |
| card          | note                          |
| task list     | todo                          |
| link          | link (embeds stay)            |
| image         | image (with caption)          |
| file          | file                          |
| column        | column (collapsed state kept) |
| line          | line (attached ends kept)     |
| board         | board (colour and icon kept)  |
| board alias   | shortcut                      |
| colour swatch | swatch                        |
| table         | table                         |
| document      | document                      |
| sketch        | sketch                        |
| comment       | comment                       |

## Risks

| Risk                                      | Mitigation                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| Duplicates or bad data on the live server | Backup first, `--dry-run`, the staging board, skip-by-`sourceId`          |
| Milanote asset URLs expiring mid-run      | Download as each board imports; route A's ZIP as a fallback               |
| A stale service-worker cache after deploy | Network-first, plus `no-cache` on `sw.js`                                 |
| Container memory during a large import    | Upload one file at a time                                                 |
| Milanote's web data shape is undocumented | It's a one-off run, tested on one board first, with route A as a fallback |
