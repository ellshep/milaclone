// The MCP tools (docs/agent-addon.md W2.1). Every tool goes through the board's
// public HTTP API and checks A3 first: a board is readable, and writable, only
// when its agentAccess flag is on or an agent card sits on it. A blocked board
// gets a refusal naming the flag; list_boards and search show blocked boards'
// titles only. Every write is logged as one JSON line on stderr (A21).

import { z } from 'zod';
import { BoardError, OUTLINE_MAX, blocked, label } from './board.js';

const RICH = new Set(['note', 'comment']);

const text = s => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }] });

// Cards without their TipTap `doc` (the plain `data.text` says the same in far fewer tokens).
const slim = it => {
  if (!it || !it.data || !it.data.doc) return it;
  const { doc, ...data } = it.data; // oxlint-disable-line no-unused-vars -- dropped on purpose
  return Object.assign({}, it, { data });
};

const byPosition = (a, b) => (a.y || 0) - (b.y || 0) || (a.x || 0) - (b.x || 0);

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
      const body = placement(a);
      if (a.data) {
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
      const { item, board: from } = await board.item(a.item_id);
      await board.readable(a.board_id);
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
      const { item, board: b } = await board.item(a.item_id);
      await board.call('DELETE', '/api/item/' + item.id);
      log('delete_item', { boardId: b.canvas.id, itemId: item.id });
      return { trashed: item.id };
    }
  );

  tool('restore_item', 'Bring a deleted card back from the trash.', { item_id: z.string() }, async a => {
    const entry = (await board.call('GET', '/api/trash')).items.find(t => t.id === a.item_id);
    if (!entry) throw new BoardError(`card ${a.item_id} is not in the trash (only the card that was deleted is)`);
    if (!entry.restorable) throw new BoardError(`card ${a.item_id}'s board is in the trash; restore that first`);
    const c = await board.canvas(entry.canvasId);
    if (!c.readable) throw new BoardError(blocked(c.canvas.title));
    const out = await board.call('POST', `/api/item/${a.item_id}/restore`);
    log('restore_item', { boardId: entry.canvasId, itemId: a.item_id });
    return slim(out);
  });

  tool(
    'export_board_markdown',
    "A board as Markdown, the same file as the board's Export.",
    { board_id: z.string() },
    async a => {
      await board.readable(a.board_id);
      return board.call('GET', `/api/canvas/${encodeURIComponent(a.board_id)}/export.md`, undefined, { text: true });
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
