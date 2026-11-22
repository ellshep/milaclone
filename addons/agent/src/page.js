// The agent page (docs/agent-addon.md W3.3) at /agent/?board=<id>: the board
// framed next to a chat column. The board posts its selection to the page
// (A14); a request is one or more notes, each with the card ids it is about,
// sent together and tracked as seen → working → done (A15). Replies can be
// pinned to the board by hand (A7); threads are kept per agent (A8).
//
// No auth, like the board itself (A10): the port is loopback-only and Tailscale
// Serve puts it on the tailnet. POSTs must be JSON, so another site can't post
// a plain form at it.

import fs from 'node:fs';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { ToolError } from './mcp.js';
import { freeX } from './tools.js';

const PUBLIC = new URL('../public/', import.meta.url);
const STATIC = {
  '/agent/': ['index.html', 'text/html; charset=utf-8'],
  '/agent/page.js': ['page.js', 'text/javascript; charset=utf-8'],
  '/agent/page.css': ['page.css', 'text/css; charset=utf-8'],
};
const MAX_BODY = 64 * 1024;
const MAX_NOTES = 20;
const MAX_IDS = 50;
const MAX_TEXT = 4000;
// shortcut: older messages of a long thread are dropped, not summarised; compact if threads grow long.
const MAX_HISTORY = 40;
const MAX_HISTORY_CHARS = 40000;
const MAX_RECEIPTS = 200;
const EXCERPT = 300;

const log = (event, fields) => console.error(JSON.stringify({ event, at: new Date().toISOString(), ...fields }));

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readJson(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    throw new HttpError(415, 'send JSON');
  }
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, 'too large');
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad JSON');
  }
}

/** The notes of a request, checked: `[{ ids: [string], text }]`. */
function checkNotes(notes) {
  const ok =
    Array.isArray(notes) &&
    notes.length > 0 &&
    notes.length <= MAX_NOTES &&
    notes.every(
      n =>
        n &&
        typeof n.text === 'string' &&
        n.text.trim() &&
        n.text.length <= MAX_TEXT &&
        Array.isArray(n.ids) &&
        n.ids.length <= MAX_IDS &&
        n.ids.every(id => typeof id === 'string' && id.length <= 100)
    );
  if (!ok) throw new HttpError(400, `notes must be 1-${MAX_NOTES} of { ids, text }`);
  return notes.map(n => ({ ids: [...new Set(n.ids)], text: n.text.trim() }));
}

/** What the request says, as the model and the thread see it. */
export const requestText = notes =>
  notes.map(n => (n.ids.length ? `On ${n.ids.map(id => `[${id}]`).join(', ')}: ${n.text}` : n.text)).join('\n');

/** The end of a thread that fits the caps, starting on a question. */
export function recent(messages) {
  const out = [];
  let size = 0;
  for (let i = messages.length - 1; i >= 0 && out.length < MAX_HISTORY; i--) {
    size += messages[i].text.length;
    if (size > MAX_HISTORY_CHARS) break;
    out.unshift(messages[i]);
  }
  if (out.length && out[0].role !== 'user') out.shift();
  return out;
}

/** The selected cards, with an excerpt each; cards outside the agent's scope are named, not shown. */
async function selection(agent, mcp, ids) {
  const lines = [];
  for (const id of ids) {
    try {
      const { item, boardId } = await mcp.call('get_item', { item_id: id });
      if (!agent.scope.has(boardId)) {
        lines.push(`[${id}] (on a board outside your scope)`);
        continue;
      }
      const d = item.data || {};
      lines.push(
        `[${item.type} ${id}] ${String(d.text || d.title || item._childTitle || '').slice(0, EXCERPT)}`.trim()
      );
    } catch (e) {
      if (!(e instanceof ToolError)) throw e;
      lines.push(`[${id}] (${e.message})`);
    }
  }
  return lines.length ? `<selected_cards>\n${lines.join('\n')}\n</selected_cards>` : '';
}

/** The page's HTTP server for `service`, keeping threads in `threads` (memory.js). */
export function pageServer(service, threads) {
  // shortcut: receipts live in memory and are lost on restart; they only need to outlive one page visit.
  const requests = new Map();
  let queue = Promise.resolve(); // page requests run one at a time, so "seen" means waiting its turn

  const agentById = async id => {
    const found = (await service.agents()).find(a => a.agent.id === id);
    if (!found) throw new HttpError(404, 'no such agent');
    return found.agent;
  };

  const run = async (r, agent, notes) => {
    r.status = 'working';
    try {
      const mcp = await service.mcp(agent.id);
      const ids = [...new Set(notes.flatMap(n => n.ids))];
      const history = r.thread ? recent(threads.get(r.thread).messages) : [];
      r.reply = await service.ask(agent, r.request, await selection(agent, mcp, ids), history);
      if (r.thread) threads.add(r.thread, r.request, r.reply);
      r.status = 'done';
    } catch (e) {
      log('agent.page_failed', { agent: agent.id, request: r.id, error: e.message });
      Object.assign(r, { status: 'failed', error: e.message });
    }
  };

  const routes = {
    'GET /agent/api/agents': async url => {
      const board = url.searchParams.get('board');
      return (await service.agents())
        .filter(a => a.agent.boardId === board)
        .map(({ agent: a }) => ({ id: a.id, name: a.name, memory: a.memory, writes: a.writes }));
    },
    'GET /agent/api/threads': async url => {
      const agent = await agentById(url.searchParams.get('agent'));
      return agent.memory === 'ephemeral' ? [] : threads.list(agent.id);
    },
    'POST /agent/api/requests': async (url, body) => {
      const notes = checkNotes(body.notes);
      const agent = await agentById(body.agent);
      let thread = null;
      if (agent.memory !== 'ephemeral') {
        if (body.thread) {
          const t = threads.get(String(body.thread));
          if (!t || t.agentId !== agent.id) throw new HttpError(404, 'no such thread');
          thread = t.id;
        } else {
          thread = threads.start(agent.id, notes[0].text);
        }
      }
      const r = { id: 'r_' + randomUUID(), status: 'seen', thread, request: requestText(notes) };
      requests.set(r.id, r);
      for (const [id, old] of requests) {
        if (requests.size <= MAX_RECEIPTS) break;
        if (old.status === 'done' || old.status === 'failed') requests.delete(id); // oldest finished first
      }
      const receipt = Object.assign({}, r); // as it stands now: the run may start before this is sent
      queue = queue.then(() => run(r, agent, notes));
      return receipt;
    },
    'POST /agent/api/pin': async (url, body) => {
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text || text.length > 20000) throw new HttpError(400, 'text is required');
      const agent = await agentById(body.agent);
      const mcp = await service.mcp(agent.id);
      const { items } = await mcp.call('get_board', { board_id: agent.boardId });
      const card = await mcp.call('create_item', {
        board_id: agent.boardId,
        type: 'note',
        x: freeX(items),
        y: 60,
        data: { text: `From ${agent.name}\n\n${text}` },
      });
      return { id: card.id };
    },
  };

  return http.createServer(async (req, res) => {
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, {
        'Content-Type': type,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "frame-ancestors 'self'", // the page itself is never framed elsewhere
      });
      res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
    };
    try {
      const url = new URL(req.url, 'http://page');
      if (url.pathname === '/agent') {
        res.writeHead(301, { Location: '/agent/' + url.search });
        return res.end();
      }
      const file = req.method === 'GET' && STATIC[url.pathname];
      if (file) return send(200, fs.readFileSync(new URL(file[0], PUBLIC)), file[1]);
      const thread = /^\/agent\/api\/threads\/([\w-]+)$/.exec(url.pathname);
      if (req.method === 'GET' && thread) {
        const t = threads.get(thread[1]);
        return t ? send(200, t) : send(404, { error: 'no such thread' });
      }
      const receipt = /^\/agent\/api\/requests\/([\w-]+)$/.exec(url.pathname);
      if (req.method === 'GET' && receipt) {
        const r = requests.get(receipt[1]);
        return r ? send(200, r) : send(404, { error: 'no such request' });
      }
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) return send(404, { error: 'not found' });
      const body = req.method === 'POST' ? await readJson(req) : null;
      return send(200, await route(url, body || {}));
    } catch (e) {
      if (!e.status) log('agent.page_error', { error: e.message });
      return send(e.status || 500, { error: e.message });
    }
  });
}
