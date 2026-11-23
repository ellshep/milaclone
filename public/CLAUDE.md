# Frontend notes (`public/`)

Loaded when you work under `public/`. Rules and invariants only; feature detail belongs in each module's header comment. 1,500-word cap (`npm run check:docs`).

`public/js/*.js` are ES modules loaded via `<script type="module" src="/js/main.js">` from `index.html`. No bundling, except `editor.js` (TipTap), which `server.js` bundles into `public/vendor/editor.js` at boot.

**Preact, one screen at a time** (roadmap D11): the Focus page, then Quick notes, then dialogs move when they're next reworked, each a whole screen in one PR. These stay vanilla: the canvas (`cards.js`, `drag.js`, `viewport.js`, `lines.js`, `tools.js`, selection), TipTap (`editor.js`, `rich.js`, `document.js`) and the shared modules (`api.js`, `savequeue.js`, `state.js`, `util.js`), which Preact screens import as they are. Never mix both styles in one screen.

## State and navigation

- `state.js` is the shared mutable app state. ES module bindings can't be reassigned by importers, so anything that changes at runtime (`view`, `cam`, `selectedId`, `drag`, …) is a field on the exported `state` object; collections mutated in place (`elMap`) are exported directly.
- `main.js` boots the app, wires the global keyboard/pointer handlers and owns `openCanvas(id)`, the single navigation primitive (fetch, reset selection, update `location.hash`, reset the label filter).
- **Selection** is a set: `state.selection` holds every selected id and `state.selectedId` is the primary one. Go through `select` / `selectIds` / `toggleSelect` in `editing.js`; never assign either field directly. `selectedItems()` drops cards whose column is also selected. Copy/cut/duplicate/delete/colour act on the whole selection.
- Left-drag on empty canvas draws the selection box (`tools.js`); space-drag, middle-drag and touch pan (decision D2).
- When the board is framed by a same-origin page, `embed.js` posts the selected ids to it on every change (`selectIds` and the delete path call `postSelection`); standalone it posts nothing.

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
- **Plain text beside rich fields:** swatch, table, document and agent cards keep `data.text` next to their own fields so search and Markdown export need no per-type code. Keep it in sync when you add a card type.
- A note whose whole text is a hex code becomes a swatch when its edit ends (`editing.js` `exitEdit`); `PATCH /api/item` allows exactly that one type change.
- `document.js` (`#docDialog`) closes on Escape itself because TipTap swallows the key.
- Lucide icons come from a CDN `<script>`; call `refreshIcons()` after DOM changes (it no-ops if the CDN failed).

## Lines

`lines.js` draws `line` items in one `<svg id="lines">` at the back of `#world`, not as cards: `render()` skips them and calls `drawLines()`, and a `MutationObserver` on `#world` redraws once per frame so attached ends follow cards. Each end is `{ id }` (clipped to that card's edge) or a free `{ x, y }`. `db.js` `collectSubtree` counts a card's attached lines as part of it (trashed, restored and purged with it); copy/move keep a line only when both attached ends travel too. A lone line is never copied or duplicated, and drag/nudge leave lines alone. The `<g>` sits in `elMap`, so selection, marquee and Delete work unchanged.

## Organisation

- A `shortcut` item (`data.targetCanvasId`) is an alias card; GET `/api/canvas/:id` adds `_target`, which is `null` once the board is trashed (renders as broken).
- Templates are boards inside a board named "Templates" on Home; `/copy` deep-copies one.
- An `agent` card (`agentcard.js`, `docs/agent-addon.md` A4–A8) is a form the agent add-on reads through the API; core only stores it. A board card's menu toggles its child canvas's `agentAccess` (`_childAgentAccess` on the card).
- `data.labels` is a list of names on any card but a line; `util.js` `labelColor` derives each colour, so there's no label registry. The filter isn't saved.

## Quick notes (`quicknotes.js`)

The mobile-only to-do workspace (`#quicknotes`). Every `todo` card in the tree is a list there: `GET /api/todos` returns them all and writes go back through `PATCH /api/item`, so the canvas and Quick notes edit the same card. Tasks carry fields the canvas ignores (`starred`, `due`, `tags`, `note`, `noteStyle`); `normTask` must pass unknown fields through. Blank-text tasks (the canvas editor's placeholder rows) are never listed. Screens are static markup in `index.html` that the module fills by `[id]`, so fields holding a caret survive a re-render.

## Saving

Every edit fires a PATCH through **`savequeue.js`**, the one save protocol: `editing.js` (400 ms) and `quicknotes.js` (200 ms) each create a queue with `send: api.patch`, a `current(id, key)` reader and an `onSaved` hook. It debounces and accumulates fields, attaches `baseTasks` (the list as that surface last got it, set with `track`) so the server's three-way merge (`tasklist.js`) keeps both sides, and adopts the server's list as the new base after a to-do save (only then: a title save must not move the base). `api.patch` resolves `null` for a retryable failure and `false` for a rejection: on `null` the queue retries with backoff (`api.js` `retryDelay`: six tries over about two minutes, then the edit waits for the next edit, `online` or the tab being shown) and re-reads each field's _current_ value at send time; rejections aren't retried. `pending()` is true from an edit until its save lands, in flight included: while it is, don't swap in the server's copy (`hasPendingSaves`, Quick notes `load`). Each surface keeps its own queue, so edits to one list from both in one tab merge on the server. Flushes run on `pagehide`/hidden (`keepalive`, only while the bytes in flight stay under 60,000; browsers cap the total at 64 KB), on `online`, and before refetching when the tab becomes visible (skipped while a card is being edited). Test the queue in Vitest with an in-memory `send`. Canvas tasks carry `indent` (0–4, at most one deeper than the task above). Restoring or emptying Trash calls `editing.js` `forgetUndo` so cmd+Z never retries a gone delete.

## Styling

**Colours are tokens.** `:root` in `style.css` defines every surface/ink/border colour and a `prefers-color-scheme: dark` block overrides them (Quick notes' `--qn-*` set too); no in-app theme switch (D8). Use a token, never a literal, for any new background, text or border — white text on a coloured fill is the only literal that stays.

## PWA

`manifest.webmanifest` + `icons/` (PNGs rendered once from `icon.svg`) make it installable. `sw.js` is network-first: same-origin GETs (and the Lucide/Google Fonts CDNs) go to the network and refresh the cache; the cache answers only when the network fails; writes, `/api/backup` and same-origin URLs with a query string bypass it; no offline editing. `server.js` serves `/sw.js` `no-cache`. Bump `CACHE` only to drop old entries. `playwright.config.js` blocks service workers so they can't cache API reads under other tests; `e2e/pwa.spec.js` opts back in.

## Focus page

`/focus` (`focus.html`, `focus.css`, `js/focuspage.js`) is its own page with its own `--fx-*` tokens and never imports `main.js`. Its order always comes from the server (`focus.js`); the client never sorts, so the page, the task API and the digest can't disagree. Pure helpers live in `js/focusorder.js` (Vitest).

## Tests

Pure helpers (`util.js`, `viewport.js`) have Vitest tests in `test/ui/`; add a module to the `vitest.config.mjs` thresholds when it gets unit tests. Anything that imports `main.js` boots the whole app, so cover it in Playwright (`e2e/`).
