# Agent add-on

Board agents: an **agent card** on a board is an agent that knows that board.
Ask it with a comment card that starts with `@agent` (or `@<its name>`), or on
its page next to the board. It reads the board for context and, if you let it,
writes cards back. Everything it writes is an ordinary card you can move, edit
or trash.

**Off by default.** Nothing here runs unless you switch it on, and the board
works the same without it. It needs the [MCP add-on](../mcp/README.md), which
is its only way to the board.

## What leaves the house

For an agent card set to **Anthropic**, every answer is one run of the model at
Anthropic's API (with your `AGENT_API_KEY`). A run sends:

- the card's name, persona and board notes, and the titles and ids of the
  boards it may use;
- an outline of its board (one line per card) and, with persistent memory, its
  memory card;
- the question: the comment, its thread and the cards next to it, or on the
  page your notes, an excerpt of each selected card and the thread so far;
- whatever cards it reads with its tools during the run, only on its own
  boards (see below).

Nothing else is sent, and nothing is sent between questions: polling for new
comments only talks to the MCP server. Agent cards set to OpenAI, Gemini or
Local answer "not supported yet" and send nothing. Threads stay in this
add-on's own database (`agent.db` in the `milaclone_agent` volume). Keep
sensitive boards closed to agents.

## Which boards an agent sees

Its own board, plus, with **Scope: Also listed boards**, each listed board
(one title per line) whose **Allow Agents** flag is on. A board opened only by
another agent's card stays that agent's alone, and if two allowed boards share
a listed title the agent gets neither (rename one). Anything else it asks for
is refused, and searches leave other boards out.

## What it may write

- **Chat only** never touches the board. **Propose** puts new cards in a
  column "Proposed by <name>" on its board: drag one out to accept it, trash it
  to reject it. **Direct** may add, change, move and trash cards on its boards.
- It can't change agent cards (only you set an agent's scope), take a board
  outside its scope with a card it moves or trashes, move a comment to another
  board, or touch a comment an agent wrote.
- Its answers to comments are comment cards below the question, whatever the
  setting. Comments agents write never ask another agent.
- On the page, **Pin to board** turns any answer into a note on its board.
- With **Persistent** memory it keeps one memory note on its board (even when
  set to chat only), which it rewrites and you can edit.

Every write is logged by the MCP server with the agent card's id
(`docker compose logs mcp | grep mcp.write`), and every run here
(`docker compose logs agent | grep agent.run`, with tokens used).

## The page

`https://mila.<tailnet>.ts.net/agent/?board=<board id>` (the id is the part of
the board's address after `#`). Put it in a link card on the board. It shows
the board on the left and a chat with the board's agents on the right:

- Select cards on the board and they go with your question as context.
- **Queue** keeps a note about the selected cards; **Send** sends every queued
  note as one request. Each shows seen, working and done.
- With memory **Per thread** or **Persistent**, conversations are kept and
  listed; **Ephemeral** forgets each question.

## Turn it on

In `.env` next to `docker-compose.yml`:

```bash
COMPOSE_PROFILES=agent          # or voice,agent to keep the voice add-on
MCP_TOKEN=$(openssl rand -hex 32)
AGENT_API_KEY=sk-ant-…          # Anthropic API key
```

Then `docker compose up -d --build` and add an agent card to a board (its board
is open to it from then on). Run one instance only: two would both answer a
comment. `AGENT_POLL_SECONDS` (default 30) sets how often it checks for
comments.

## Development

```bash
npm ci && npx playwright install chromium   # repo root: the board, and Playwright
(cd addons/mcp && npm ci)
cd addons/agent && npm ci
npm test                                    # node tests, against the real board and MCP
npm run test:e2e                            # the page, in a browser
```

Tests use a fake provider: no key, no network. `AGENT_PROVIDER=fake` does the
same for a running service.
