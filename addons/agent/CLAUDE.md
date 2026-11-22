# Agent add-on notes (`addons/agent/`)

Loaded when you work under `addons/agent/`. The plan is `docs/agent-addon.md` (W3, decisions A2–A21). 1,500-word cap (`npm run check:docs`).

- Its own npm package (ES modules; `@anthropic-ai/sdk` and `@modelcontextprotocol/sdk` pinned exactly). It reaches the board **only through the MCP add-on** (`src/mcp.js`, A9), one MCP client per agent card so the MCP's write log carries `X-Agent-Id` (A21). Never import core files or `addons/mcp/` code.
- **Per-agent scope is enforced here** (`src/tools.js` `fence`): the MCP only knows whether a board is open to agents at all. An agent's scope is its own board plus, with scope "boards", listed boards whose `agentAccess` flag is on; a board opened only by another agent's card is that agent's alone (A3). Every tool argument naming a board, or a card (looked up with `get_item`), must be in scope; `search` results are filtered.
- `writes` (A7): `chat` gets read tools only, `propose` also gets `create_item`/`create_items` redirected into a "Proposed by <name>" column on its own board, `direct` gets every write tool. Comment replies are written by the service, so every agent can answer.
- Comments (A13, `src/comments.js`): a comment starting `@agent` (the board's oldest agent) or `@<name>` is answered once by a comment card with `data.replyTo` and `data.agent`; a comment that has such a reply is never answered again, so no local state is needed. A failed run answers with the error rather than retrying every poll.
- Providers (`src/providers.js`): `anthropic` runs the SDK's Tool Runner (`client.beta.messages.toolRunner` + `betaTool`, effort from the card, refusal fallback on models that take it); `fake` for tests. Other providers answer "not supported yet".
- Logs go to stderr as JSON lines (`agent.run` with tokens per run).
- Tests start the board (`server.js`) and the MCP add-on as processes: run `npm ci` at the root and in `addons/mcp` first. The `Agent add-on` workflow is not a required check.
