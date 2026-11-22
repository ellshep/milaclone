#!/usr/bin/env node
// The board agents service (docs/agent-addon.md W3). It finds agent cards
// through the MCP add-on, and every AGENT_POLL_SECONDS answers new `@agent`
// comments (A13), one at a time, each with its agent's own settings, tools and
// scope. It also serves the agent page (page.js) on PORT. Run one instance
// only: two would both answer a new comment.
//
//   MCP_URL             the MCP add-on (default http://mcp:8787/mcp)
//   MCP_TOKEN           its token
//   AGENT_API_KEY       Anthropic API key for agents with provider "anthropic"
//   AGENT_POLL_SECONDS  default 30
//   AGENT_PROVIDER=fake every agent uses the fake provider (tests, smoke runs)
//   PORT, HOST          the page (default 8788 on 0.0.0.0)
//   DATA_DIR            where agent.db keeps threads (default ./data)

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentConfig, findAgents } from './agents.js';
import { commentContext, pending, replyCard, requestOf } from './comments.js';
import { connect } from './mcp.js';
import { Threads } from './memory.js';
import { pageServer } from './page.js';
import { anthropicProvider, fakeProvider } from './providers.js';
import { runAgent } from './run.js';

const log = (event, fields) => console.error(JSON.stringify({ event, at: new Date().toISOString(), ...fields }));

export class Service {
  /** `providers` maps a card's provider name to a provider; `fake` set routes every agent to it. */
  constructor({ mcpUrl, token, providers, fake = false }) {
    Object.assign(this, { mcpUrl, token, providers, fake });
    this.clients = new Map(); // agent card id (or '' for the service) → MCP client
  }

  async mcp(agentId = '') {
    if (!this.clients.has(agentId)) this.clients.set(agentId, await connect(this.mcpUrl, this.token, agentId || null));
    return this.clients.get(agentId);
  }

  provider(agent) {
    const p = this.fake ? fakeProvider : this.providers[agent.provider];
    if (!p) throw new Error(`provider "${agent.provider}" isn't supported yet: set the agent card to Anthropic`);
    return p;
  }

  /** Every agent: `[{ agent, items }]`, items being its board's cards. */
  async agents() {
    const root = await this.mcp();
    const out = [];
    for (const found of await findAgents(root)) out.push({ agent: await agentConfig(found, root), items: found.items });
    return out;
  }

  /** Runs one agent on a request; `history` is a page thread's earlier messages. */
  async ask(agent, request, context = '', history = []) {
    return runAgent({
      agent,
      mcp: await this.mcp(agent.id),
      provider: this.provider(agent),
      request,
      context,
      history,
    });
  }

  /** Answers every waiting `@agent` comment once. Returns how many it answered. */
  async pollOnce() {
    const all = await this.agents();
    const boards = new Map();
    for (const { agent, items } of all) {
      if (!boards.has(agent.boardId)) boards.set(agent.boardId, { items, agents: [] });
      boards.get(agent.boardId).agents.push(agent);
    }
    let answered = 0;
    for (const { items, agents } of boards.values()) {
      for (const { comment, agent } of pending(items, agents)) {
        const mcp = await this.mcp(agent.id);
        // The reply card goes up first: from then on the comment counts as answered,
        // so a crash mid-run (after direct writes, say) never runs it again.
        const card = await mcp.call('create_item', replyCard(comment, agent, 'Working on it…'));
        let reply;
        try {
          reply = await this.ask(agent, requestOf(comment, agent), commentContext(comment, items));
        } catch (e) {
          // Answered with the failure, so it isn't retried (and paid for) every poll; ask again to retry.
          log('agent.failed', { agent: agent.id, comment: comment.id, error: e.message });
          reply = `Sorry, I couldn't answer that: ${e.message}`;
        }
        try {
          await mcp.call('update_item', { item_id: card.id, data: { text: reply } });
        } catch (e) {
          // Someone trashed or moved the placeholder mid-run: keep polling the rest.
          log('agent.reply_failed', { agent: agent.id, comment: comment.id, error: e.message });
        }
        answered++;
      }
    }
    return answered;
  }

  async close() {
    for (const c of this.clients.values()) await c.close();
    this.clients.clear();
  }
}

async function main() {
  const env = process.env;
  const service = new Service({
    mcpUrl: env.MCP_URL || 'http://mcp:8787/mcp',
    token: env.MCP_TOKEN || '',
    providers: { anthropic: anthropicProvider(env.AGENT_API_KEY || undefined) },
    fake: env.AGENT_PROVIDER === 'fake',
  });
  const every = Number(env.AGENT_POLL_SECONDS || 30) * 1000;
  const dir = env.DATA_DIR || 'data';
  fs.mkdirSync(dir, { recursive: true });
  const port = Number(env.PORT || 8788);
  pageServer(service, new Threads(path.join(dir, 'agent.db'))).listen(port, env.HOST || '0.0.0.0');
  log('agent.started', { mcp: service.mcpUrl, pollSeconds: every / 1000, fake: service.fake, port });
  for (;;) {
    try {
      const n = await service.pollOnce();
      if (n) log('agent.answered', { comments: n });
    } catch (e) {
      log('agent.poll_failed', { error: e.message });
      await service.close(); // reconnect next time (the MCP may have restarted)
    }
    await new Promise(r => setTimeout(r, every));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
