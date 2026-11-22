# Board agents: the MCP and agent add-ons

Planned 2026-11-22 with the owner. Agents that live on boards: one on Home that
orchestrates, and one per project board that knows only that board. They read
the board for context, write cards back, research on the web, pass work to each
other and to Claude Code. Everything they do is a card, so it is visible,
movable and undoable.

The ground rules from `docs/roadmap.md` and `docs/next-phases.md` still apply:
one PR per item with tests, the required checks green, never `--admin`. Core
code never imports from `addons/`, the board never calls an add-on, and the
board must work the same with every add-on off. A box is ticked when its
acceptance test lands.

## Decisions

| #   | Question              | Decision                                                                                                                                                                                                                                                                                                                                                                              |
| --- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Where it lives        | Two add-ons behind one Compose profile `agent`: `addons/mcp/` (the tool surface) and `addons/agent/` (the service and its page). Core gets only the generic pieces in W1                                                                                                                                                                                                              |
| A2  | Surfaces              | Both: a comment card that starts with `@agent` (or `@<agent name>`) on the board, and the add-on's own page at `/agent/` (a Tailscale Serve route like `/ingest/`), reached from an ordinary link card                                                                                                                                                                                |
| A3  | Who may be read       | Nothing, by default. A board is readable when its `agentAccess` flag is on (board card menu) or an agent card sits on it, and then only by that agent. The orchestrator sees only the titles of blocked boards                                                                                                                                                                        |
| A4  | What an agent is      | A core item type `agent`: a form card with the fields in W1.2. No settings page; copying the card copies the agent                                                                                                                                                                                                                                                                    |
| A5  | Model per agent       | Provider, model and effort are fields on the card: `anthropic`, `openai`, `gemini`, `local` (OpenAI-compatible, for boards whose content must stay home). Model is a suggestion list with free text; effort where supported                                                                                                                                                           |
| A6  | What it may create    | Cards, columns and boards inside its scope. Never outside it                                                                                                                                                                                                                                                                                                                          |
| A7  | What it persists      | A `writes` field: **chat only** (never touches the board), **propose** (cards land in a column named "Proposed by <agent>"; drag out to accept, trash to reject) or **direct**. On the page, any reply can be pinned to the board by hand                                                                                                                                             |
| A8  | Memory                | A `memory` field: **ephemeral**, **thread** (kept in the add-on's own database) or **persistent** (the agent also keeps one memory note card on the board, which it rewrites and the owner can edit)                                                                                                                                                                                  |
| A9  | Tool surface          | One MCP server in Node, `addons/mcp/`, about twelve tools shaped like the fork's core set, outline first. The agent service, Claude Code and Claude Desktop all use it                                                                                                                                                                                                                |
| A10 | Auth                  | The MCP endpoint takes a bearer token; the task API keeps its own. No key on `/api/*`: the page would have to hand it to every browser on the tailnet, so it would guard nothing (dropped 2026-11-22)                                                                                                                                                                                 |
| A11 | Runtime               | One Tool Runner loop per agent inside the service (Anthropic SDK; other providers through the pipeline's `llm.py` pattern). Managed Agents is a later `runtime` value per agent, not a split by surface                                                                                                                                                                               |
| A12 | Context               | Three layers in cache order: persona and tools (frozen); the board outline, one line per card, capped, plus the memory card; everything else on demand through tools. A board agent never sees outside its scope                                                                                                                                                                      |
| A13 | Comment protocol      | The service polls for new `@agent` comments. Context is the thread (comments chained by `data.replyTo`), the cards the comment overlaps or shares a column with, and the outline. The reply is a comment card below it with `replyTo`                                                                                                                                                 |
| A14 | Selection on the page | The page frames the board. When framed, the board posts `{type: 'milaclone:selection', ids}` to its parent on every selection change. The page sends ids and text excerpts, never screenshots (from lavish-axi)                                                                                                                                                                       |
| A15 | Queue, send, receipts | On the page, notes on cards queue and go as one request; each shows seen, working, done (from lavish-axi)                                                                                                                                                                                                                                                                             |
| A16 | Agents talking        | Adopted from Grok Bot: one orchestrator delegating to specialists; agent-to-agent messages visible to the owner; two kinds, **priority** (run now) and **normal** (wait for the recipient's next run); memory per agent. A message is a comment card on the recipient's board. Not adopted: group chats, always-on bots, agents granting each other access. Only the owner sets scope |
| A17 | Claude Code           | W5 writes a brief card (goal, files, acceptance) for the owner to run. W6 runs it headless and posts the PR link back. Merging stays with the owner                                                                                                                                                                                                                                   |
| A18 | Scheduled runs        | None in this plan. Routines come later, alongside the M5 digest                                                                                                                                                                                                                                                                                                                       |
| A19 | Visuals               | SVG sketches uploaded through `/api/upload` as image cards. No image generation in this plan                                                                                                                                                                                                                                                                                          |
| A20 | Third parties         | Each add-on's README lists what leaves the house and when. The Reflections board uses `local` and is owner-triggered only                                                                                                                                                                                                                                                             |
| A21 | Logging               | Every agent write is logged with the agent's card id, task-API style. Nothing is deleted; every write can be trashed and restored                                                                                                                                                                                                                                                     |
| A22 | Herdr                 | Not now. Once the MCP exists, a thin Herdr mod can open the board and list its agents; the board agents must run when the laptop is shut, so the add-on is the home                                                                                                                                                                                                                   |

## Shape

An **agent card** on a board is the agent. The Home board's card is the
orchestrator. The **MCP server** is the only way any agent touches the board.
The **agent service** finds the cards, runs one loop per agent, polls for
`@agent` comments, and serves the page. The page is the board in a frame next
to a chat column, plus the agents' threads and receipts.

## W1 · Core: the generic pieces

- [x] **W1.2 `agent` item type.** A form card with `name`, `persona`,
      `boardNotes`, `provider`, `model`, `effort`, `scope` (this board, or this
      board plus listed boards), `createBoards`, `writes`, `memory`. The
      `runtime` field arrives with the second runtime (W6).
      Dropdown lists live in the card module. `data.text` holds name plus
      persona so search finds it.
  - Acceptance: Vitest renders the card and round-trips each field; the e2e
    suite creates one from the add menu and edits the provider.
- [x] **W1.3 Board access flag.** `canvases.agentAccess` (default off), toggled
      from the board card menu and written through PATCH `/api/canvas/:id`;
      `GET /api/canvas/:id` returns it.
  - Acceptance: API test toggles it; e2e flips it from the menu.
- [x] **W1.4 Selection hook.** When `window.parent !== window`, the board posts
      `milaclone:selection` with the selected ids on every change. Nothing is
      posted when not framed.
  - Acceptance: a Vitest test on the selection module.

## W2 · `addons/mcp/`

- [x] **W2.1 Server.** Node, streamable HTTP behind a bearer token, stdio for
      local use. Tools: `get_root`, `list_boards`, `get_board_outline`,
      `get_board`, `get_item`, `search`, `create_item`, `create_items`,
      `update_item`, `move_item`, `delete_item`, `restore_item`,
      `export_board_markdown`, `add_todo_task`, `set_todo_task_done`. Each
      tool respects A3: a blocked board returns a refusal naming the flag.
  - Acceptance: a test boots the board on a temp `DATA_DIR`, runs every tool
    against it, and checks a blocked board is refused.
- [x] **W2.2 Docs.** `addons/mcp/README.md` with Claude Code and Claude Desktop
      config, and what leaves the house (nothing: it is local).

## W3 · `addons/agent/`: one agent on one board

- [x] **W3.1 Service.** Finds agent cards through the MCP, builds each agent's
      loop from its card (A5, A11, A12), writes under A7, logs under A21.
  - Acceptance: with a fake provider, a request on a `propose` agent lands in
    its column; on `chat only`, the board is unchanged.
- [x] **W3.2 Comment loop.** Polls for `@agent` comments (A13), replies with a
      comment card, threads by `replyTo`.
  - Acceptance: a comment with `@agent` gets exactly one reply card below it.
- [x] **W3.3 Page.** `/agent/?board=<id>`: the board framed on the left, chat
      on the right, selection as context (A14), queue and receipts (A15), pin
      a reply to the board, thread list for agents with `memory: thread`.
  - Acceptance (Playwright, against the fake provider): select two cards, ask,
    and the request carries those two ids.
- [x] **W3.4 Compose and docs.** Profile `agent`, Tailscale Serve route,
      `addons/agent/README.md` and a `CLAUDE.md` under the 1,500-word cap.

## W4 · The orchestrator

- [x] **W4.1 Home agent.** Same service, scope is the tree: titles of every
      board, content only of readable ones (A3). Two extra tools:
      `delegate(agent, message, kind)` writes a comment card on the target
      board (A16), and `list_agents`.
  - Acceptance: a priority delegate runs the target agent at once; a normal one
    waits for its next poll; a delegate to a blocked board is refused.

## W5 · Claude Code hand-off

- [x] **W5.1 Brief cards.** `write_brief` makes a note card with goal, files,
      acceptance and the repo, in a "Briefs" column on the asking board.
  - Acceptance: the card's text round-trips through `export.md`.

## W6 · Later

- Headless runs of a brief through the Claude Agent SDK, shipping through the
  no-mistakes gate as described in [Shipping a change](../CONTRIBUTING.md#shipping-a-change)
  and posting the PR link back as a comment (A17).
- `runtime: managed` for heavy boards (A11).
- Routines, with M5 (A18). Image generation (A19). A Herdr mod (A22).

## Risks

| Risk                                           | Mitigation                                                                   |
| ---------------------------------------------- | ---------------------------------------------------------------------------- |
| An agent reads a board it shouldn't            | Blocked by default at the MCP, tested per tool; the orchestrator sees titles |
| Board content reaches a third party unnoticed  | Provider per card; `local` for sensitive boards; README per add-on           |
| Agent writes clutter a board                   | `propose` by default; a column per agent; everything trashable               |
| Polling misses or doubles a reply              | Reply cards carry `replyTo`; the service records handled comment ids         |
| Context grows past what the model handles well | Outline capped; on-demand reads; compaction on long threads                  |

Sources for the borrowed ideas: Wizard815/milaclone-mcp (tool list, outline
tool, API-key header), kunchenguid/lavish-axi (selection as locators plus
excerpts, queue then send, receipts), Grok Bot write-ups (A16).
