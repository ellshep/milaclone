// The comment protocol (docs/agent-addon.md A13): a comment card that starts
// with `@agent` or `@<agent name>` asks the agent on that board. Its context is
// the thread (comments chained by `data.replyTo`), the cards it overlaps or
// shares a column with, and the board outline. The answer is a comment card
// below it with `replyTo` and the agent's card id, so a comment with a reply is
// never answered again, even after a restart. The service posts that reply
// as a placeholder before the run, so a crash mid-run can't run it twice.

const text = it => String((it.data && it.data.text) || '').trim();
const CARD_H = 120; // cards that size themselves have no stored height
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The agent a comment asks, or null. `agents` are this board's, oldest first. */
export function addressee(comment, agents) {
  const t = text(comment).toLowerCase();
  if (!t.startsWith('@')) return null;
  const byName = [...agents]
    .sort((a, b) => b.name.length - a.name.length)
    .find(a => new RegExp(`^@${esc(a.name.toLowerCase())}(?![\\w-])`).test(t));
  if (byName) return byName;
  return /^@agent(?![\w-])/.test(t) ? agents[0] || null : null;
}

/** `[{ comment, agent }]` still waiting for an answer on one board. */
export function pending(items, agents) {
  const comments = items.filter(it => it.type === 'comment');
  const byAgent = c => !!(c.data && c.data.agent);
  // Only an agent's reply answers a comment; a person replying doesn't.
  const answered = new Set(comments.filter(byAgent).map(c => c.data.replyTo));
  const out = [];
  for (const c of comments) {
    // Comments an agent wrote never ask an agent (tools.js stamps them), so agents can't loop or run each other.
    if (answered.has(c.id) || byAgent(c)) continue;
    const agent = addressee(c, agents);
    if (agent) out.push({ comment: c, agent });
  }
  return out;
}

const overlaps = (a, b) =>
  a.x < b.x + (b.w || 240) && b.x < a.x + (a.w || 240) && a.y < b.y + (b.h || CARD_H) && b.y < a.y + (a.h || CARD_H);

/** The model's context for one comment: thread and neighbouring cards. */
export function commentContext(comment, items) {
  const byId = new Map(items.map(it => [it.id, it]));
  const thread = [];
  for (let c = byId.get(comment.data.replyTo); c && thread.length < 20; c = byId.get(c.data && c.data.replyTo)) {
    thread.unshift(c);
  }
  const near = items.filter(
    it =>
      it.id !== comment.id &&
      it.type !== 'line' &&
      !thread.includes(it) &&
      ((comment.parentItemId && it.parentItemId === comment.parentItemId) ||
        (!comment.parentItemId && !it.parentItemId && overlaps(comment, it)))
  );
  const line = it => `[${it.type} ${it.id}] ${text(it) || (it.data && it.data.title) || ''}`.trim();
  return [
    thread.length && `<thread>\n${thread.map(line).join('\n')}\n</thread>`,
    near.length && `<near_the_comment>\n${near.map(line).join('\n')}\n</near_the_comment>`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** The comment's text without the @mention. */
export const requestOf = (comment, agent) =>
  text(comment)
    .replace(new RegExp(`^@(${esc(agent.name)}|agent)`, 'i'), '')
    .trim();

/** The answer card: under the comment, in its column if it has one. */
export const replyCard = (comment, agent, reply) => ({
  board_id: agent.boardId,
  type: 'comment',
  data: { text: reply, replyTo: comment.id, agent: agent.id },
  ...(comment.parentItemId
    ? { parent_item_id: comment.parentItemId, y: (comment.y || 0) + 1 }
    : { x: comment.x || 0, y: (comment.y || 0) + (comment.h || CARD_H) + 16, w: comment.w || 240 }),
});
