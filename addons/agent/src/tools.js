// The tools one agent gets: the MCP's tools, cut to what its `writes` setting
// allows (A7) and fenced to its scope (A3, A12). The MCP itself checks only
// that a board is open to agents at all; "only that agent" is enforced here.
// export_board_markdown isn't offered: it walks child boards the MCP may read,
// which can belong to another agent.

import { ToolError } from './mcp.js';

const READ = ['get_board_outline', 'get_board', 'get_item', 'search'];
// Writes fence() checks the target card of (and a column's cards, for a move or trash).
const CHANGES = new Set(['update_item', 'move_item', 'delete_item']);
const ALLOWED = {
  chat: READ,
  propose: [...READ, 'create_item', 'create_items'],
  direct: [
    ...READ,
    'create_item',
    'create_items',
    'update_item',
    'move_item',
    'delete_item',
    'add_todo_task',
    'set_todo_task_done',
  ],
};

export const proposeTitle = agent => `Proposed by ${agent.name}`;

// The agent's "Proposed by <name>" column on its own board, made on first use.
async function proposeColumn(agent, mcp) {
  const { items } = await mcp.call('get_board', { board_id: agent.boardId });
  const title = proposeTitle(agent);
  const col = items.find(it => it.type === 'column' && (it.data || {}).title === title);
  if (col) return col.id;
  return (
    await mcp.call('create_item', { board_id: agent.boardId, type: 'column', data: { title }, x: freeX(items), y: 60 })
  ).id;
}

/** An x to the right of every card on a board, for a card the service adds. */
export const freeX = items =>
  40 + Math.max(0, ...items.filter(it => !it.parentItemId).map(it => (it.x || 0) + (it.w || 240)));

/**
 * Throws unless every board the arguments name, or a named card sits on, is in
 * scope. Changing, moving or trashing a card also checks it (and, for a
 * column's move or trash, every card in it): a board card needs every board
 * under it in scope; a comment an agent wrote is never touched (it may be a
 * reply still being written); no comment goes to another board (A16). Returns
 * the named card, if any.
 */
async function fence(agent, mcp, name, args) {
  const out = id => new ToolError(`board ${id} is outside ${agent.name}'s scope`);
  if (args.board_id !== undefined && !agent.scope.has(args.board_id)) throw out(args.board_id);
  if (args.item_id === undefined) return null;
  const { item, boardId } = await mcp.call('get_item', { item_id: args.item_id });
  if (!agent.scope.has(boardId)) throw out(boardId);
  if (!CHANGES.has(name)) return item;
  const under = async id => {
    if (!agent.scope.has(id)) throw out(id);
    for (const it of (await mcp.call('get_board', { board_id: id })).items) {
      if (it.type === 'board' && it.data && it.data.childCanvasId) await under(it.data.childCanvasId);
    }
  };
  const away = name === 'move_item' && args.board_id !== boardId;
  const check = async card => {
    const d = card.data || {};
    if (card.type === 'comment' && d.agent) throw new ToolError(`comment ${card.id} was written by an agent: leave it`);
    if (card.type === 'comment' && away) throw new ToolError(`comment ${card.id} can't move to another board`);
    if (card.type === 'board' && d.childCanvasId) await under(d.childCanvasId);
  };
  await check(item);
  if (item.type === 'column' && name !== 'update_item') {
    for (const it of (await mcp.call('get_board', { board_id: boardId })).items) {
      if (it.parentItemId === item.id) await check(it);
    }
  }
  return item;
}

// The comment protocol's and memory card's keys are the service's alone: the
// model can't mark a comment answered (replyTo), pass for another agent, or
// make a memory card.
const clean = it => {
  if (!it.data) return it;
  const data = Object.assign({}, it.data);
  delete data.replyTo;
  delete data.agent;
  delete data.agentMemory;
  return Object.assign({}, it, { data });
};

// Comments an agent writes carry its card id, so they never ask an agent
// themselves (comments.js skips them): no agent loops, no agent running another.
const mark = (agent, it) =>
  it.type === 'comment' ? Object.assign({}, it, { data: Object.assign({}, it.data, { agent: agent.id }) }) : it;

async function call(agent, mcp, name, args) {
  if (agent.writes === 'propose' && (name === 'create_item' || name === 'create_items')) {
    // Proposals go into the agent's column on its own board, wherever it aimed them.
    const parent = await proposeColumn(agent, mcp);
    const place = it => Object.assign({}, it, { parent_item_id: parent, x: undefined, y: undefined });
    args =
      name === 'create_item'
        ? Object.assign(place(args), { board_id: agent.boardId })
        : { board_id: agent.boardId, items: args.items.map(place) };
  }
  if (name === 'create_item' || name === 'update_item') args = clean(args);
  if (name === 'create_items') args = Object.assign({}, args, { items: args.items.map(clean) });
  const item = await fence(agent, mcp, name, args);
  if (name === 'create_item') args = mark(agent, args);
  if (name === 'create_items') args = Object.assign({}, args, { items: args.items.map(it => mark(agent, it)) });
  if (name === 'update_item' && item.type === 'comment' && args.data) {
    args = Object.assign({}, args, { data: Object.assign({}, args.data, { agent: agent.id }) });
  }
  const result = await mcp.call(name, args);
  if (name === 'search') return result.filter(r => agent.scope.has(r.canvasId));
  return result;
}

/** `[{ name, description, inputSchema, run }]` for a provider; run returns text, never throws a ToolError. */
export function agentTools(agent, mcp) {
  const allowed = new Set(ALLOWED[agent.writes]);
  return mcp.tools
    .filter(t => allowed.has(t.name))
    .map(t => {
      const { $schema, ...inputSchema } = t.inputSchema || { type: 'object' }; // oxlint-disable-line no-unused-vars -- not part of a tool schema
      const propose =
        agent.writes === 'propose' && t.name.startsWith('create_')
          ? ` Cards land in the column "${proposeTitle(agent)}" for the owner to accept.`
          : '';
      return {
        name: t.name,
        description: (t.description || '') + propose,
        inputSchema: Object.assign({ type: 'object', properties: {} }, inputSchema),
        run: async args => {
          try {
            const r = await call(agent, mcp, t.name, args || {});
            return typeof r === 'string' ? r : JSON.stringify(r);
          } catch (e) {
            if (e instanceof ToolError) return 'Error: ' + e.message;
            throw e;
          }
        },
      };
    });
}
