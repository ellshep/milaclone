// The tools one agent gets: the MCP's tools, cut to what its `writes` setting
// allows (A7) and fenced to its scope (A3, A12). The MCP itself checks only
// that a board is open to agents at all; "only that agent" is enforced here.

import { ToolError } from './mcp.js';

const READ = ['get_board_outline', 'get_board', 'get_item', 'search', 'export_board_markdown'];
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
  const right = Math.max(0, ...items.filter(it => !it.parentItemId).map(it => (it.x || 0) + (it.w || 240)));
  return (
    await mcp.call('create_item', { board_id: agent.boardId, type: 'column', data: { title }, x: right + 40, y: 60 })
  ).id;
}

/** Throws unless every board the arguments name, or a named card sits on, is in scope. */
async function fence(agent, mcp, args) {
  const out = id => new ToolError(`board ${id} is outside ${agent.name}'s scope`);
  if (args.board_id !== undefined && !agent.scope.has(args.board_id)) throw out(args.board_id);
  if (args.item_id !== undefined) {
    const { boardId } = await mcp.call('get_item', { item_id: args.item_id });
    if (!agent.scope.has(boardId)) throw out(boardId);
  }
}

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
  await fence(agent, mcp, args);
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
