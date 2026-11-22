# MCP add-on notes (`addons/mcp/`)

Loaded when you work under `addons/mcp/`. Overview, tools and client setup in `README.md`; the plan is `docs/agent-addon.md` (W2, decisions A3, A9, A10, A21). 1,500-word cap (`npm run check:docs`).

- Its own npm package (ES modules, `@modelcontextprotocol/sdk` and `zod` pinned exactly). It never imports core files: everything goes through the board's public HTTP API (`src/board.js`), and core never imports it.
- **A3 is enforced here, per tool.** A board is readable and writable only when `canvas.agentAccess` is truthy (it may be `true`/`false`, `1`/`0` or `null`) or an `agent` card sits on it. Every tool that names a board or card checks that first and throws `BoardError(blocked(title))`; `move_item` checks the target too. `list_boards` and `search` may show blocked boards' titles, never their cards. A new tool must do the same, with a refusal case in `test/mcp.test.js`.
- Agents never create, update or move `agent` cards (A16), and `move_item`/`delete_item` refuse a subtree (column cards, boards below) holding an agent card or a blocked board (`guardSubtree`). `export_board_markdown` is built here (`src/markdown.js`), not by the board's export, which would include blocked child boards.
- Per-agent scope ("only by that agent") is not enforced here (one token): the agent service does it.
- Finding a card by id walks the whole tree (`Board.tree`, one `GET /api/canvas/:id` per board), since the board API has no item lookup.
- Rich cards (`note`, `comment`): `update_item` sends `data.text` as `data.body`, because the board rebuilds the TipTap `doc` only from `title`/`body`. To-do writes send `baseTasks` so the board's three-way merge keeps other devices' edits.
- Logs go to **stderr** (stdout is the stdio transport). Every write logs one `mcp.write` line with the `X-Agent-Id` header as `agent` (A21).
- HTTP is stateless (a new `McpServer` per POST, JSON responses), at `/mcp` behind `MCP_TOKEN`, read per request (unset = 503). `--stdio` has no token.
- Tests: `test/mcp.test.js` spawns the repo's `server.js` on a temp `DATA_DIR`, so the repo root needs `npm ci` first. The `MCP add-on` workflow is not a required check.
