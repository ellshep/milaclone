// Agent cards (docs/agent-addon.md A4–A8) found through the MCP, turned into
// the settings one agent runs with, including its scope.

const WRITES = ['chat', 'propose', 'direct'];
export const DEFAULT_MODEL = 'claude-opus-5-5';

/** Every agent card on a board the MCP may read, with that board's items. */
export async function findAgents(mcp) {
  const boards = (await mcp.call('list_boards')).filter(b => b.readable);
  const found = [];
  for (const b of boards) {
    const { board, items } = await mcp.call('get_board', { board_id: b.id });
    for (const card of items
      .filter(it => it.type === 'agent')
      .sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0))) {
      found.push({ card, board, items, boards });
    }
  }
  return found;
}

/**
 * One agent's settings. Its scope is its own board plus, with scope "boards",
 * the listed boards (titles, one per line) whose agentAccess flag is on: a
 * board opened only by another agent's card is that agent's alone (A3).
 */
export async function agentConfig({ card, board, boards }, mcp) {
  const d = card.data || {};
  const scope = new Map([[board.id, board.title]]);
  if (d.scope === 'boards') {
    const wanted = new Set(
      String(d.scopeBoards || '')
        .split('\n')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean)
    );
    for (const b of boards.filter(x => x.readable && wanted.has(x.title.trim().toLowerCase()))) {
      if (scope.has(b.id)) continue;
      const { board: other } = await mcp.call('get_board', { board_id: b.id });
      if (other.agentAccess) scope.set(b.id, b.title);
    }
  }
  return {
    id: card.id,
    boardId: board.id,
    boardTitle: board.title,
    name: String(d.name || '').trim() || 'Agent',
    persona: String(d.persona || '').trim(),
    boardNotes: String(d.boardNotes || '').trim(),
    provider: d.provider || 'anthropic',
    model: String(d.model || '').trim() || DEFAULT_MODEL,
    effort: d.effort || 'medium',
    writes: WRITES.includes(d.writes) ? d.writes : 'propose',
    scope,
  };
}
