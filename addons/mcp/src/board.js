// The board, as the MCP server sees it: milaclone's public HTTP API (the same
// routes the web page uses) plus the agent access rule (docs/agent-addon.md A3).
// Nothing here imports core code; the add-on works against any running board.

const LINE_MAX = 120;
export const OUTLINE_MAX = 300; // lines; a big board says how many it left out

export class BoardError extends Error {}

// A3: a board is readable when its `agentAccess` flag is on or an agent card
// sits on it. The flag can come back as true/false, 1/0 or null.
export const isReadable = (canvas, items) => !!canvas.agentAccess || items.some(it => it.type === 'agent');

export const blocked = title =>
  `Board "${title}" is blocked for agents: its agentAccess flag is off. Turn on "Allow Agents" ` +
  `in the board card's menu (or put an agent card on it) to let agents read and write it.`;

// The first line of what a card shows, for outlines and search.
export function label(it) {
  if (it.type === 'board') return it._childTitle || 'Board';
  if (it.type === 'shortcut') return 'Shortcut to ' + ((it._target && it._target.title) || 'a trashed board');
  const d = it.data || {};
  if (it.type === 'todo') {
    const open = (d.tasks || []).filter(t => (t.status ?? 'open') === 'open' && t.text && t.text.trim()).length;
    return `${d.title || 'To-do'} (${open} open)`;
  }
  const s = d.title || d.text || d.name || d.caption || d.url || d.src || '';
  return String(s).split('\n')[0].trim().slice(0, LINE_MAX);
}

export class Board {
  constructor(baseUrl, fetchImpl = fetch) {
    this.base = baseUrl.replace(/\/+$/, '');
    this.fetch = fetchImpl;
  }

  async call(method, path, body, { text = false } = {}) {
    let res;
    try {
      res = await this.fetch(this.base + path, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new BoardError(`board unreachable at ${this.base}: ${e.message}`);
    }
    const out = text ? await res.text() : await res.json().catch(() => ({}));
    if (!res.ok) throw new BoardError((out && out.error) || `board answered HTTP ${res.status}`);
    return out;
  }

  rootId() {
    return this.call('GET', '/api/root').then(r => r.rootCanvasId);
  }

  /** `{ canvas, items, breadcrumb, readable }` for one board. */
  async canvas(id) {
    const c = await this.call('GET', '/api/canvas/' + encodeURIComponent(id));
    return Object.assign(c, { readable: isReadable(c.canvas, c.items) });
  }

  /** A board the caller may read; throws the A3 refusal otherwise. */
  async readable(id) {
    const c = await this.canvas(id);
    if (!c.readable) throw new BoardError(blocked(c.canvas.title));
    return c;
  }

  /**
   * Every board in the tree, Home first: `[{ canvas, items, readable, path }]`.
   * Blocked boards are walked too (a readable board can sit inside one), but
   * callers only ever show their titles. Shortcuts aren't followed.
   * shortcut: one GET per board on every call; cache it if trees grow large.
   */
  async tree() {
    const out = [];
    const walk = async (id, path) => {
      const c = await this.canvas(id);
      const here = path.concat(c.canvas.title);
      out.push(Object.assign(c, { path: here }));
      for (const it of c.items) {
        if (it.type === 'board' && it.data && it.data.childCanvasId) await walk(it.data.childCanvasId, here);
      }
    };
    await walk(await this.rootId(), []);
    return out;
  }

  /** The live item `id`, the board it is on and the tree; throws if it is missing or blocked. */
  async item(id) {
    const tree = await this.tree();
    for (const b of tree) {
      const it = b.items.find(x => x.id === id);
      if (!it) continue;
      if (!b.readable) throw new BoardError(blocked(b.canvas.title));
      return { item: it, board: b, tree };
    }
    throw new BoardError(`no card with id ${id} (it may be in the trash)`);
  }
}
