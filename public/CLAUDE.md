# Frontend notes (`public/`)

Loaded when you work under `public/`. Rules and invariants only; feature detail belongs in each module's header comment. 1,500-word cap (`npm run check:docs`).

`public/js/*.js` are ES modules loaded via `<script type="module" src="/js/main.js">` from `index.html`. No framework and no bundling, except `editor.js` (TipTap), which `server.js` bundles into `public/vendor/editor.js` at boot.

## State and navigation

- `state.js` is the shared mutable app state. ES module bindings can't be reassigned by importers, so anything that changes at runtime (`view`, `cam`, `selectedId`, `drag`, …) is a field on the exported `state` object; collections mutated in place (`elMap`) are exported directly.
- `main.js` boots the app, wires the global keyboard/pointer handlers and owns `openCanvas(id)`, the single navigation primitive (fetch, reset selection, update `location.hash`, reset the label filter).
- **Selection** is a set: `state.selection` holds every selected id and `state.selectedId` is the primary one. Go through `select` / `selectIds` / `toggleSelect` in `editing.js`; never assign either field directly. `selectedItems()` drops cards whose column is also selected. Copy/cut/duplicate/delete/colour act on the whole selection.
- Left-drag on empty canvas draws the selection box (`tools.js`); space-drag, middle-drag and touch pan (decision D2).

## Keyboard

- The global `keydown` in `main.js` owns every canvas shortcut. The `/` sheet (`#shortcutsDialog` in `index.html`) is the user-facing list: update it with any new key.
- Zoom keys run before the typing guard so the browser never zooms the page.
- `util.js` `isTyping()` is the shared "keyboard belongs to a field" check; it includes a rich body whose editor is still loading.
- While any `<dialog>` is open, `main.js` ignores global shortcuts. While Quick notes is open, `main.js` hands it the keyboard and pointer (`isQuickNotesOpen()`).
- Keyboard copy/cut ride the `copy`/`cut` events (not keydown) and write a `milaclone:item:<id>:copy|cut` marker to the system clipboard; pasting it deep-copies via `/copy` (or `/move` for cut).

## Rendering

- `cards.js` owns all DOM rendering for items. `render()` clears `#world` and re-renders everything; `refreshItem(it)` swaps one card. Cards inside a column render as children of the column's DOM, not under `#world`. Both re-apply the label filter.
- `drag.js`: dragging a card out of a column reparents it to `#world` mid-drag and clears `in-column`; dropping onto a `.col-body` reparents and reorders siblings via `api.patchMany`. Collapsed columns aren't drop targets. Drags snap the lead card to `GRID` (shift = free).
- **Never `innerHTML` user content.** Note bodies render with `util.js` `docToDom` (DOM-built, links limited to http(s)/mailto). `rich.js` mounts TipTap in `enterEdit` and destroys it in `exitEdit`, `import()`ing the bundle the first time any card is edited.
- Link cards render an iframe built from the URL alone for what `util.js` `embedUrl` recognises; the server never fetches URLs (decision D4).
- **Plain text beside rich fields:** swatch, table and document cards keep `data.text` next to their own fields so search and Markdown export need no per-type code. Keep it in sync when you add a card type.
- A note whose whole text is a hex code becomes a swatch when its edit ends (`editing.js` `exitEdit`); `PATCH /api/item` allows exactly that one type change.
- `document.js` (`#docDialog`) closes on Escape itself because TipTap swallows the key.
- Lucide icons come from a CDN `<script>`; call `refreshIcons()` after DOM changes (it no-ops if the CDN failed).

## Lines

`lines.js` draws `line` items in one `<svg id="lines">` at the back of `#world`, not as cards: `render()` skips them and calls `drawLines()`, and a `MutationObserver` on `#world` redraws once per frame so attached ends follow cards. Each end is `{ id }` (clipped to that card's edge) or a free `{ x, y }`. `db.js` `collectSubtree` counts a card's attached lines as part of it (trashed, restored and purged with it); copy/move keep a line only when both attached ends travel too. A lone line is never copied or duplicated, and drag/nudge leave lines alone. The `<g>` sits in `elMap`, so selection, marquee and Delete work unchanged.

## Organisation

- A `shortcut` item (`data.targetCanvasId`) is an alias card; GET `/api/canvas/:id` adds `_target`, which is `null` once the board is trashed (renders as broken).
- Templates are boards inside a board named "Templates" on Home; `/copy` deep-copies one.
- `data.labels` is a list of names on any card but a line; `util.js` `labelColor` derives each colour, so there's no label registry. The filter isn't saved.

## Quick notes (`quicknotes.js`)

The mobile-only to-do workspace (`#quicknotes`). Every `todo` card in the tree is a list there: `GET /api/todos` returns them all and writes go back through `PATCH /api/item`, so the canvas and Quick notes edit the same card. Tasks carry fields the canvas ignores (`starred`, `due`, `tags`, `note`, `noteStyle`); `normTask` must pass unknown fields through. Blank-text tasks (the canvas editor's placeholder rows) are never listed. Screens are static markup in `index.html` that the module fills by `[id]`, so fields holding a caret survive a re-render.

## Saving

Every edit fires a PATCH. `editing.js` accumulates every field changed in the 400 ms debounce window and flushes pending saves (with `keepalive`) on `pagehide`/hidden. When the tab becomes visible again, the canvas and Quick notes flush, then refetch (skipped while a card is being edited). Todo writes send `baseTasks` (the list as last received) so the server's three-way `mergeTasks` keeps both sides. Canvas tasks carry `indent` (0–4, at most one deeper than the task above). Restoring or emptying Trash calls `editing.js` `forgetUndo` so cmd+Z never retries a gone delete.

## Styling

**Colours are tokens.** `:root` in `style.css` defines every surface/ink/border colour and a `prefers-color-scheme: dark` block overrides them (Quick notes' `--qn-*` set too); no in-app theme switch (D8). Use a token, never a literal, for any new background, text or border — white text on a coloured fill is the only literal that stays.

## PWA

`manifest.webmanifest` + `icons/` (PNGs rendered once from `icon.svg`) make it installable. `sw.js` is network-first: same-origin GETs (and the Lucide/Google Fonts CDNs) go to the network and refresh the cache; the cache answers only when the network fails; writes and `/api/backup` bypass it; no offline editing. `server.js` serves `/sw.js` `no-cache`. Bump `CACHE` only to drop old entries. `playwright.config.js` blocks service workers so they can't cache API reads under other tests; `e2e/pwa.spec.js` opts back in.

## Tests

Pure helpers (`util.js`, `viewport.js`) have Vitest tests in `test/ui/`; add a module to the `vitest.config.mjs` thresholds when it gets unit tests. Anything that imports `main.js` boots the whole app, so cover it in Playwright (`e2e/`).
