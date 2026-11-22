// The orchestrator (docs/agent-addon.md W4.1, A3, A16): an agent card on Home.
// Its scope is Home plus every board open to agents (agentAccess on), whatever
// its card's scope says; list_boards shows it every board's title. Two more
// tools: list_agents, and delegate, which asks another agent with a comment card
// on that agent's board, signed `agent` and `delegatedBy` with the orchestrator's
// card id. comments.js answers an agent's comment only when it is signed so by an
// orchestrator, and tools.js strips `delegatedBy` from what models write, so
// delegate (capped per run) is the one way an agent sets another off.

export const DELEGATE_CAP = 5; // delegations per orchestrator run
const CARD_H = 160;
const key = s => String(s).trim().toLowerCase();
const log = (event, fields) => console.error(JSON.stringify({ event, at: new Date().toISOString(), ...fields }));

export const ORCHESTRATOR_RULE =
  'You are the orchestrator on Home. list_boards shows the title of every board, but you can read only the boards listed above. ' +
  'To pass work to the agent on a board, use list_agents, then delegate: "priority" runs that agent now and gives you its reply; ' +
  '"normal" leaves the request on its board for its next run. The owner sees every request and reply on that board.';

/** Home plus every board whose agentAccess flag is on (not boards opened only by their own agent card, A3). */
export async function orchestratorScope(home, boards, mcp) {
  const scope = new Map([[home.id, home.title]]);
  for (const b of boards.filter(x => x.readable && x.id !== home.id)) {
    if ((await mcp.call('get_board', { board_id: b.id })).board.agentAccess) scope.set(b.id, b.title);
  }
  return scope;
}

// The request card: right of the target's agent card, below earlier requests.
function requestCard(home, target, message, kind, items) {
  const card = items.find(it => it.id === target.id) || {};
  const before = items.filter(it => it.type === 'comment' && it.data && it.data.delegatedBy).length;
  return {
    board_id: target.boardId,
    type: 'comment',
    x: (card.x || 0) + (card.w || 320) + 40,
    y: (card.y || 0) + before * CARD_H,
    w: 240,
    data: { text: `@${target.name} ${message}`, agent: home.id, delegatedBy: home.id, kind },
  };
}

/** list_agents and delegate for `home`'s run. `service` runs a priority request at once. */
export function orchestratorTools(service, home) {
  let sent = 0;
  const others = async () => (await service.agents()).filter(a => !a.agent.orchestrator);
  const listAgents = async () =>
    JSON.stringify(
      (await others())
        .filter(({ agent }) => home.scope.has(agent.boardId))
        .map(({ agent }) => ({ id: agent.id, name: agent.name, board: agent.boardTitle, writes: agent.writes }))
    );
  const delegate = async ({ agent: who, message, kind }) => {
    if (sent >= DELEGATE_CAP) return `Error: at most ${DELEGATE_CAP} delegations per run`;
    if (typeof message !== 'string' || !message.trim()) return 'Error: message is empty';
    if (kind !== 'priority' && kind !== 'normal') return 'Error: kind must be "priority" or "normal"';
    const hits = (await others()).filter(({ agent }) => agent.id === who || key(agent.name) === key(who || ''));
    if (!hits.length) return `Error: no agent called "${who}" (list_agents names them)`;
    if (hits.length > 1) return `Error: several agents are called "${who}": use the id from list_agents`;
    const { agent: target, items } = hits[0];
    if (!home.scope.has(target.boardId)) {
      return `Error: board "${target.boardTitle}" is blocked: its owner hasn't turned agent access on`;
    }
    sent++;
    const mcp = await service.mcp(home.id);
    const comment = await mcp.call('create_item', requestCard(home, target, message.trim(), kind, items));
    log('agent.delegate', { agent: home.id, to: target.id, boardId: target.boardId, comment: comment.id, kind });
    if (kind === 'normal') return `Asked ${target.name} on "${target.boardTitle}"; it answers on its next run.`;
    return `${target.name} replied: ${await service.answer(comment, target, [...items, comment])}`;
  };
  return [
    {
      name: 'list_agents',
      description: 'The agents on boards you can read: id, name, board and what they may write.',
      inputSchema: { type: 'object', properties: {} },
      run: listAgents,
    },
    {
      name: 'delegate',
      description:
        `Ask another agent (by name or id from list_agents) with a comment on its board. "priority" runs it now and ` +
        `returns its reply; "normal" waits for its next run. At most ${DELEGATE_CAP} per run.`,
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'The agent’s name or id.' },
          message: { type: 'string', description: 'What to ask it.' },
          kind: { type: 'string', enum: ['priority', 'normal'] },
        },
        required: ['agent', 'message', 'kind'],
      },
      run: delegate,
    },
  ];
}
