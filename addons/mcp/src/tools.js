// The MCP tools (docs/agent-addon.md W2.1). Every tool goes through the board's
// public HTTP API and checks A3 first: a board is readable, and writable, only
// when its agentAccess flag is on or an agent card sits on it. A blocked board
// gets a refusal naming the flag; list_boards and search show blocked boards'
// titles only. Every write is logged as one JSON line on stderr (A21).

import { z } from 'zod';
import { BoardError, OUTLINE_MAX, blocked, label } from './board.js';
import { boardMarkdown } from './markdown.js';

const RICH = new Set(['note', 'comment']);

const text = s => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }] });

// Cards without their TipTap `doc` (the plain `data.text` says the same in far fewer tokens).
const slim = it => {
  if (!it || !it.data || !it.data.doc) return it;
  const { doc, ...data } = it.data; // oxlint-disable-line no-unused-vars -- dropped on purpose
  return Object.assign({}, it, { data });
};

// Data keys that tie a card to other boards: re-pointing a board card would orphan
// its child board, and a shortcut could be aimed anywhere. A line's ends must stay
// on the line's own board.
const TIES = ['childCanvasId', 'targetCanvasId'];
function checkTies(data, items) {
  for (const k of TIES) if (k in data) throw new BoardError(`${k} can't be changed: it ties the card to its board`);
  for (const k of ['from', 'to']) {
    const end = data[k];
    if (end && typeof end === 'object' && end.id && !items.some(i => i.id === end.id)) {
      throw new BoardError(`a line's ${k} must be a card on the same board, and ${end.id} isn't`);
    }
  }
}

const byPosition = (a, b) => (a.y || 0) - (b.y || 0) || (a.x || 0) - (b.x || 0);

// A16: only the owner sets an agent's scope, so agents never make, edit or move agent cards.
const NO_AGENTS = 'agent cards are set up by the owner on the board; agents cannot create, change or move them';

// Moving or trashing a card takes its column's cards and any boards below it
// along: refuse when that would touch an agent card or a blocked board.
function guardSubtree(item, b, tree) {
  const byId = new Map(tree.map(t => [t.canvas.id, t]));
  const check = (it, items) => {
    if (it.type === 'agent') throw new BoardError(NO_AGENTS);
    for (const k of items.filter(x => x.parentItemId === it.id)) check(k, items);
    if (it.type !== 'board' || !it.data || !byId.has(it.data.childCanvasId)) return;
    const child = byId.get(it.data.childCanvasId);
    if (!child.readable) throw new BoardError(blocked(child.canvas.title));
    for (const k of child.items.filter(x => !x.parentItemId)) check(k, child.items);
  };
  check(item, b.items);
}

function outline(c) {
  const lines = [];
  const kids = new Map();
  for (const it of c.items) {
    if (it.type === 'line') continue; // connectors carry no content
    const k = it.parentItemId || null;
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k).push(it);
  }
  const add = (parent, depth) => {
    for (const it of (kids.get(parent) || []).sort(byPosition)) {
      lines.push(`${'  '.repeat(depth)}- [${it.type} ${it.id}] ${label(it)}`);
      add(it.id, depth + 1);
    }
  };
  add(null, 0);
  const head = `Board "${c.canvas.title}" (${c.canvas.id}), ${lines.length} cards`;
  const more = lines.length > OUTLINE_MAX ? [`… ${lines.length - OUTLINE_MAX} more (use get_board)`] : [];
  return [head, ...lines.slice(0, OUTLINE_MAX), ...more].join('\n');
}

const position = {
  x: z.number().optional().describe('Left edge in board pixels'),
  y: z.number().optional().describe('Top edge in board pixels'),
  w: z.number().optional().describe('Width'),
  h: z.number().optional().describe('Height (most cards size themselves)'),
  color: z.string().optional().describe('Card colour name, e.g. "yellow"'),
  parent_item_id: z.string().optional().describe('A column on the same board to put the card in'),
};
const cardFields = {
  type: z.string().describe('Card type: note, todo, column, link, comment, board (a sub-board), swatch, table, …'),
  data: z
    .record(z.string(), z.any())
    .optional()
    .describe('Card content, e.g. { text } for a note or comment, { title, tasks: [{ text }] } for a todo'),
  ...position,
};

// The fields of POST/PATCH /api/item from the tool's arguments.
const placement = a => {
  const out = {};
  for (const k of ['x', 'y', 'w', 'h', 'color']) if (a[k] !== undefined) out[k] = a[k];
  if (a.parent_item_id !== undefined) out.parentItemId = a.parent_item_id;
  return out;
};

export function registerTools(server, board, agent = null) {
  const log = (tool, fields) =>
    console.error(JSON.stringify({ event: 'mcp.write', at: new Date().toISOString(), tool, agent, ...fields }));

  const tool = (name, description, inputSchema, fn) =>
    server.registerTool(name, { description, inputSchema }, async args => {
      try {
        return text(await fn(args || {}));
      } catch (e) {
        if (e instanceof BoardError) return { isError: true, content: [{ type: 'text', text: e.message }] };
        throw e;
      }
    });

  const create = async (boardId, a) => {
    if (a.type === 'agent') throw new BoardError(NO_AGENTS);
    const it = await board.call('POST', '/api/item', {
      canvasId: boardId,
      type: a.type,
      data: a.data || {},
      ...placement(a),
    });
    log('create_item', { boardId, itemId: it.id, type: it.type });
    return slim(it);
  };

  // A todo card's tasks, written through the board's three-way merge (baseTasks).
  const writeTasks = async (item, tasks) =>
    board.call('PATCH', '/api/item/' + item.id, { data: { tasks }, baseTasks: item.data.tasks || [] });
  const todo = async id => {
    const found = await board.item(id);
    if (found.item.type !== 'todo') throw new BoardError(`card ${id} is a ${found.item.type}, not a to-do list`);
    return found;
  };

  tool('get_root', 'The Home board: its id, title and whether agents may read it.', {}, async () => {
    const c = await board.canvas(await board.rootId());
    return { id: c.canvas.id, title: c.canvas.title, readable: c.readable };
  });

  tool(
    'list_boards',
    'Every board with its path from Home. Blocked boards (agentAccess off) are listed by title only.',
    {},
    async () =>
      (await board.tree()).map(b => ({ id: b.canvas.id, title: b.canvas.title, path: b.path, readable: b.readable }))
  );

  tool(
    'get_board_outline',
    'One line per card on a board (type, id, first line), columns nested. Start here before get_board.',
    { board_id: z.string() },
    async a => outline(await board.readable(a.board_id))
  );

  tool('get_board', 'A board and every card on it, with full content.', { board_id: z.string() }, async a => {
    const c = await board.readable(a.board_id);
    return { board: c.canvas, breadcrumb: c.breadcrumb, items: c.items.map(slim) };
  });

  tool('get_item', 'One card by id, with the board it is on.', { item_id: z.string() }, async a => {
    const { item, board: b } = await board.item(a.item_id);
    return { item: slim(item), boardId: b.canvas.id, boardTitle: b.canvas.title };
  });

  tool(
    'search',
    'Search board titles and card text. Cards on blocked boards are left out.',
    { query: z.string().min(1) },
    async a => {
      const [found, tree] = await Promise.all([
        board.call('GET', '/api/search?q=' + encodeURIComponent(a.query)),
        board.tree(),
      ]);
      const readable = new Map(tree.map(b => [b.canvas.id, b.readable]));
      return found.results
        .filter(r => r.kind === 'board' || readable.get(r.canvasId))
        .map(r => Object.assign(r, { readable: !!readable.get(r.canvasId) }));
    }
  );

  tool('create_item', 'Add one card to a board.', { board_id: z.string(), ...cardFields }, async a => {
    await board.readable(a.board_id);
    return create(a.board_id, a);
  });

  tool(
    'create_items',
    'Add several cards to one board, in order (not all-or-nothing: the result lists what was made).',
    { board_id: z.string(), items: z.array(z.object(cardFields)).min(1).max(50) },
    async a => {
      await board.readable(a.board_id);
      if (a.items.some(it => it.type === 'agent')) throw new BoardError(NO_AGENTS);
      const made = [];
      for (const it of a.items) made.push(await create(a.board_id, it));
      return made;
    }
  );

  tool(
    'update_item',
    'Change a card: data keys merge into what it has; position, size, colour and column as given. For a note or comment, data.text replaces its text.',
    { item_id: z.string(), data: cardFields.data, ...position },
    async a => {
      const { item, board: b } = await board.item(a.item_id);
      if (item.type === 'agent') throw new BoardError(NO_AGENTS);
      const body = placement(a);
      if (a.data) {
        checkTies(a.data, b.items);
        const data = Object.assign({}, a.data);
        // The board rebuilds a rich card's body from `body`; a bare `text` would leave the old one showing.
        if (RICH.has(item.type) && typeof data.text === 'string') {
          data.body = data.text;
          delete data.text;
        }
        body.data = data;
        if (Array.isArray(data.tasks)) body.baseTasks = item.data.tasks || [];
      }
      const out = await board.call('PATCH', '/api/item/' + item.id, body);
      log('update_item', { boardId: b.canvas.id, itemId: item.id, fields: Object.keys(body) });
      return slim(out);
    }
  );

  tool(
    'move_item',
    'Move a card (and everything inside it) to another board, or elsewhere on the same one.',
    { item_id: z.string(), board_id: z.string(), x: z.number().optional(), y: z.number().optional() },
    async a => {
      const { item, board: from, tree } = await board.item(a.item_id);
      await board.readable(a.board_id);
      guardSubtree(item, from, tree);
      const out = await board.call('POST', `/api/item/${item.id}/move`, { canvasId: a.board_id, x: a.x, y: a.y });
      log('move_item', { boardId: from.canvas.id, toBoardId: a.board_id, itemId: item.id });
      return slim(out);
    }
  );

  tool(
    'delete_item',
    'Move a card and everything inside it to the trash (restore_item brings it back).',
    { item_id: z.string() },
    async a => {
      const { item, board: b, tree } = await board.item(a.item_id);
      if (item.type !== 'agent') guardSubtree(item, b, tree); // trashing an agent card only narrows access
      await board.call('DELETE', '/api/item/' + item.id);
      log('delete_item', { boardId: b.canvas.id, itemId: item.id });
      return { trashed: item.id };
    }
  );

  tool('restore_item', 'Bring a deleted card back from the trash.', { item_id: z.string() }, async a => {
    const entry = (await board.call('GET', '/api/trash')).items.find(t => t.id === a.item_id);
    if (!entry) throw new BoardError(`card ${a.item_id} is not in the trash (only the card that was deleted is)`);
    // A trashed board answers 404, so its flag can't be read: say only that it's trashed.
    if (!entry.restorable) throw new BoardError(`card ${a.item_id} can't be restored: its board is in the trash`);
    const c = await board.canvas(entry.canvasId); // readability before anything about the card itself
    if (!c.readable) throw new BoardError(blocked(c.canvas.title));
    if (entry.type === 'agent') throw new BoardError(NO_AGENTS); // restoring one would widen access
    const out = await board.call('POST', `/api/item/${a.item_id}/restore`);
    log('restore_item', { boardId: entry.canvasId, itemId: a.item_id });
    return slim(out);
  });

  tool(
    'export_board_markdown',
    "A board and the boards below it as Markdown, shaped like the board's Export. Blocked boards show only their title.",
    { board_id: z.string() },
    async a => boardMarkdown(await board.readable(a.board_id), id => board.canvas(id), board.base)
  );

  tool(
    'write_brief',
    'Write a Claude Code brief (goal, files, acceptance, repo) as a note in the "Briefs" column of a board, for the owner to run.',
    {
      board_id: z.string().describe('The board asking for the work'),
      goal: z.string().min(1).describe('What the change should achieve'),
      repo: z.string().min(1).describe('The repository, e.g. "owner/name" or a URL'),
      files: z.array(z.string().min(1)).default([]).describe('Files to read or change'),
      acceptance: z.array(z.string().min(1)).min(1).describe('How to tell it is done, one check each'),
    },
    async a => {
      const b = await board.readable(a.board_id);
      // One line per value: the board's Markdown export trims lines and drops blank ones.
      const one = v => v.replace(/\s+/g, ' ').trim();
      // A leading [ ] or [x] would turn "- …" into a task, and the importer into a to-do card.
      const item = v => '- ' + one(v).replace(/^\[[ xX]\]\s*/, '');
      const lines = ['Goal: ' + one(a.goal), 'Repo: ' + one(a.repo)];
      if (a.files.length) lines.push('Files:', ...a.files.map(item));
      lines.push('Acceptance:', ...a.acceptance.map(item));
      let col = b.items.find(
        it => it.type === 'column' && !it.parentItemId && /^briefs$/i.test(String(it.data?.title || '').trim())
      );
      // shortcut: two briefs written at once may each make a column; merge them by hand if it happens.
      if (!col) {
        const top = b.items.filter(it => !it.parentItemId && it.type !== 'line');
        const right = Math.max(0, ...top.map(it => (it.x || 0) + (it.w || 240)));
        col = await board.call('POST', '/api/item', {
          canvasId: b.canvas.id,
          type: 'column',
          x: top.length ? right + 40 : 60, // beside the board's cards, not on top of them
          y: top.length ? Math.min(...top.map(it => it.y || 0)) : 60,
          data: { title: 'Briefs' },
        });
      }
      const below = b.items.filter(it => it.parentItemId === col.id).map(it => it.y || 0);
      const note = await board.call('POST', '/api/item', {
        canvasId: b.canvas.id,
        type: 'note',
        parentItemId: col.id,
        y: Math.max(0, ...below) + 1, // a column orders its cards by y: last in the column
        data: { text: lines.join('\n') },
      });
      log('write_brief', { boardId: b.canvas.id, itemId: note.id, columnId: col.id });
      return slim(note);
    }
  );

  tool(
    'add_todo_task',
    'Add a task to a to-do list card.',
    {
      item_id: z.string().describe('The to-do card'),
      text: z.string().min(1),
      due: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('YYYY-MM-DD'),
      starred: z.boolean().optional(),
    },
    async a => {
      const { item, board: b } = await todo(a.item_id);
      const before = new Set((item.data.tasks || []).map(t => t.id));
      const task = { text: a.text.trim(), done: false, createdAt: Date.now() };
      if (a.due) task.due = a.due;
      if (a.starred) task.starred = true;
      const out = await writeTasks(item, (item.data.tasks || []).concat([task]));
      const added = out.data.tasks.find(t => !before.has(t.id));
      log('add_todo_task', { boardId: b.canvas.id, itemId: item.id, taskId: added && added.id });
      return added;
    }
  );

  tool(
    'set_todo_task_done',
    'Tick (or untick) a task on a to-do list card.',
    { item_id: z.string(), task_id: z.string(), done: z.boolean().default(true) },
    async a => {
      const { item, board: b } = await todo(a.item_id);
      const tasks = item.data.tasks || [];
      if (!tasks.some(t => t.id === a.task_id)) throw new BoardError(`no task ${a.task_id} on card ${item.id}`);
      const out = await writeTasks(
        item,
        tasks.map(t => (t.id === a.task_id ? Object.assign({}, t, { done: a.done }) : t))
      );
      log('set_todo_task_done', { boardId: b.canvas.id, itemId: item.id, taskId: a.task_id, done: a.done });
      return out.data.tasks.find(t => t.id === a.task_id);
    }
  );
}
