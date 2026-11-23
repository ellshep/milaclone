# Preact migration: one screen at a time

Planned 2026-11-23. The owner chose Preact, one screen at a time (E1, E5); the
other decisions are proposals open to change in review. It carries out roadmap decision D11 and
replaces backlog items FE1 and FE2 with the work items below. Solid 2.0 and
React were weighed and set aside (E1).

The ground rules from `docs/roadmap.md` apply: one PR per item with tests, the
required checks green. A box is ticked when its acceptance test lands. No
screen is rewritten for its own sake: each move either comes before a planned
feature that rebuilds the screen anyway, or clears a file-size ceiling.

## Decisions

| #   | Question           | Decision                                                                                                                                                                                                                                                                                            |
| --- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | Framework          | Preact 10 (stable). Not Preact 11 until it leaves beta. Not React: same API at about ten times the size. Not Solid 2.0: stable since 2026-11-16, agents still write 1.x code, and it needs a Babel plugin in the boot build. Revisit Solid after 2027-05.                                           |
| E2  | Build              | The `buildSync` call in `server.js` gains one entry per migrated screen, with `jsx: 'automatic'` and `jsxImportSource: 'preact'`, writing to the gitignored `public/vendor/` next to `editor.js`. No Vite, no Babel, no second build. `preact` is exact-pinned in `dependencies`, like TipTap.      |
| E3  | Files              | Preact components are `.jsx` files under `public/js/`. A screen's entry file mounts it; everything else stays a plain `.js` module.                                                                                                                                                                 |
| E4  | State              | Hooks (`useState`, `useReducer`, `useEffect`) only. No `@preact/signals` and no `preact/compat` until a screen shows it needs them, decided in that PR.                                                                                                                                             |
| E5  | What stays vanilla | The canvas (`cards.js`, `drag.js`, `viewport.js`, `lines.js`, `tools.js`, selection, menus, clipboard, capture), TipTap (`editor.js`, `rich.js`, `document.js`) and the shared modules (`api.js`, `savequeue.js`, `state.js`, `util.js`, `focusorder.js`). Preact screens import these as they are. |
| E6  | Mixing             | A screen is either all Preact or all vanilla. No Preact islands inside canvas cards.                                                                                                                                                                                                                |
| E7  | Tests              | Components get Vitest + jsdom unit tests through `@testing-library/preact` (a dev dependency), with Vitest's esbuild set to the same JSX options. Existing Playwright specs must pass unchanged: they are the proof that the screen still behaves the same.                                         |
| E8  | Order and timing   | FE1 after V5's F2 and F3 merge (they change the focus order the page renders) and before F4 (which rebuilds the page). FE2 after DM4, AU16, AU20 and AU21, and before F8.                                                                                                                           |

## FE1 · The Focus page

- [ ] **FE1.1 The build.** E2 and E3: `preact` added, the `buildSync` entry,
      the Vitest JSX options, lint and knip seeing `.jsx`. Docker smoke boots
      with it.
- [ ] **FE1.2 The page.** `focuspage.js` (290 code lines) becomes components
      for Three mode and List mode; `focus.html` loads the bundle instead of
      `/js/focuspage.js`. `focusorder.js` stays as it is. The press-and-hold
      ring stays CSS-driven.
  - Acceptance: `e2e/focus.spec.js` passes untouched; unit tests for both
    modes; the bundle is under 15 KB gzipped.

Doing it before F4 means F4 to F6 (the stack, the Queue, the row menu, done
history, stale rows) are built in Preact rather than converted after.

## FE2 · Quick notes

Prerequisites, each its own PR from `docs/backlog.md`: **DM4** (move
`openCanvas` out of `main.js`, so Quick notes components can be unit-tested
without booting the app), and **AU16, AU20, AU21** (Quick notes delete and
flush bugs). They are fixed first so the rewrite doesn't carry them over.

- [ ] **FE2.1 Overview and list.** The home screen and a list as components,
      saving through `savequeue.js` unchanged. The hand-written "keep the caret
      through a re-render" code goes.
- [ ] **FE2.2 Task and search.** The task screen and the search layer.
      `quicknotes.js` is gone and its `.oxlintrc.json` ceiling is removed.
  - Acceptance: `e2e/quicknotes.spec.js` and `e2e/saves.spec.js` pass
    untouched; every new file is under 400 code lines.

Doing it before F8 means the Focus link, quick filters and rank numbers are
built in Preact.

## FE3 · Dialogs, when next reworked

Search, Trash and the Templates sheet move only when a feature next changes
them, in that feature's PR. Nothing is scheduled for them on their own.

## Not in this plan

- The agent add-on's page (`addons/agent/public/`). It has no build step and
  190 lines; it moves only if it grows, with its own build.
- Splitting `cards.js` and `routes.js` (backlog DM6, DM7): they stay vanilla.
- A dev watch mode. Like `editor.js` today, a change to a `.jsx` file needs a
  server restart.
