# MCP add-on

An [MCP](https://modelcontextprotocol.io) server that lets agents read and edit
your boards: the [board agents](../agent/README.md), Claude Code and
Claude Desktop all use it. It is one Node process that talks to the board's
own HTTP API, the same API the web page uses.

**Off by default.** Nothing here runs unless you switch it on, and the board
works the same without it.

## What leaves the house

Nothing. The server talks only to your board. What an MCP client does with what
it reads is up to that client: Claude Code and Claude Desktop send tool results
to Anthropic as part of the conversation, so only allow agents on boards you're
happy to share with the model you use.

## Which boards agents can see

None, until you allow them. A board is open to agents when you turn on
**Allow Agents** in its board card's menu (the board's `agentAccess` flag), or
when an agent card sits on it. Each board is decided on its own: allowing a
board does not open the boards inside it.

- Agents can read, add, change, move, trash and restore cards only on open
  boards, and can't move anything into or out of a blocked one.
- Every tool asked about a blocked board says so and names the flag.
- `list_boards` and `search` still show blocked boards' **titles** (so an agent
  can tell you to allow one), never their cards.
- Home is blocked too until an agent card sits on it (it has no board card to
  flip).
- A board an agent creates starts blocked, like any new board.
- Agents can't create, change, move or restore agent cards (only you set an
  agent's scope), trash or move a card that would take a blocked board with
  it, or re-point a board card or shortcut at another board.
- Exports leave out blocked boards below the one asked for (title only).
- This server has one token, so it can't tell agents apart: "only that agent"
  (an agent card opens its board to that agent alone) is enforced by the agent
  service (`addons/agent/`), not here. Claude Code and Claude Desktop see every
  open board.

Every write is logged as one JSON line (`docker compose logs mcp | grep mcp.write`).
Nothing is deleted for good: anything an agent trashes is in the board's Trash.

## Tools

| Tool                                  | Does                                                            |
| ------------------------------------- | --------------------------------------------------------------- |
| `get_root`, `list_boards`             | Home, and every board with its path and whether agents may read |
| `get_board_outline`                   | One line per card, columns nested: the cheap first look         |
| `get_board`, `get_item`               | Full cards                                                      |
| `search`                              | Board titles and card text (cards on blocked boards left out)   |
| `create_item`, `create_items`         | Add cards: notes, to-do lists, columns, links, sub-boards, …    |
| `update_item`                         | Change content, position, size, colour or column                |
| `move_item`                           | To another board or place                                       |
| `delete_item`, `restore_item`         | To the trash and back                                           |
| `export_board_markdown`               | The board's Markdown export                                     |
| `add_todo_task`, `set_todo_task_done` | To-do lists, merged like any other edit                         |

## Turn it on (server, over the tailnet)

In `.env` next to `docker-compose.yml`:

```bash
COMPOSE_PROFILES=agent          # or voice,agent to keep the voice add-on
MCP_TOKEN=$(openssl rand -hex 32)
```

Then `docker compose up -d --build`. The server answers at
`https://mila.<tailnet>.ts.net/mcp`, and every request needs
`Authorization: Bearer <MCP_TOKEN>`. Without `MCP_TOKEN` it answers 503.

**Claude Code** (on any machine on your tailnet):

```bash
claude mcp add --transport http milaclone https://mila.<tailnet>.ts.net/mcp \
  --header "Authorization: Bearer <MCP_TOKEN>"
```

**Claude Desktop:** its custom connectors connect from Anthropic's side, so
they can't reach a tailnet address. Use the local way below.

## Use it locally (stdio)

On a machine with a checkout and Node 20+, the server can run as a child of the
MCP client, with no token, against any board it can reach:

```bash
cd addons/mcp && npm ci
```

**Claude Code:**

```bash
claude mcp add milaclone --env BOARD_URL=https://mila.<tailnet>.ts.net \
  -- node /path/to/milaclone/addons/mcp/src/server.js --stdio
```

**Claude Desktop**, in `claude_desktop_config.json` (Settings → Developer →
Edit Config):

```json
{
  "mcpServers": {
    "milaclone": {
      "command": "node",
      "args": ["/path/to/milaclone/addons/mcp/src/server.js", "--stdio"],
      "env": { "BOARD_URL": "https://mila.<tailnet>.ts.net" }
    }
  }
}
```

`BOARD_URL` defaults to `http://127.0.0.1:4321` (the board on the same machine).

## Turn it off

Take `agent` out of `COMPOSE_PROFILES`, then `docker compose rm -sf mcp`. For a
local setup, `claude mcp remove milaclone` or delete the block from the Desktop
config.

## Development

```bash
npm ci                          # at the repo root: the test boots the real board
cd addons/mcp && npm ci && npm test
```

CI runs this in the **MCP add-on** workflow when this folder or the board's API
changes.
