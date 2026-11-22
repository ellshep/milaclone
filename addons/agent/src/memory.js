// Agent memory (docs/agent-addon.md A8), set by the card's `memory` field:
//   ephemeral   each request on the page stands alone.
//   thread      the page's conversations are kept in the add-on's own SQLite
//               database (node:sqlite) and replayed to the model.
//   persistent  as thread, plus one memory note on the agent's own board: shown
//               to it on every run (A12) and rewritten with the `remember` tool;
//               the owner can edit it like any note. This holds for a chat-only
//               agent too: the owner asked for the card by choosing persistent.

import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { freeX } from './tools.js';

const plain = row => Object.assign({}, row); // node:sqlite rows have a null prototype

export class Threads {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY, agentId TEXT NOT NULL, title TEXT NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, threadId TEXT NOT NULL REFERENCES threads(id),
        role TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_by_thread ON messages(threadId, id);`);
  }

  /** One agent's threads, latest first. */
  list(agentId) {
    return this.db
      .prepare('SELECT id, title, updatedAt FROM threads WHERE agentId = ? ORDER BY updatedAt DESC')
      .all(agentId)
      .map(plain);
  }

  /** A thread with its messages, or null. */
  get(id) {
    const t = this.db.prepare('SELECT id, agentId, title, updatedAt FROM threads WHERE id = ?').get(id);
    if (!t) return null;
    const messages = this.db.prepare('SELECT role, text, at FROM messages WHERE threadId = ? ORDER BY id').all(id);
    return Object.assign(plain(t), { messages: messages.map(plain) });
  }

  start(agentId, title) {
    const id = 't_' + randomUUID();
    this.db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)').run(id, agentId, title.slice(0, 80), Date.now());
    return id;
  }

  /** Adds one question and its answer. */
  add(threadId, question, answer) {
    const at = Date.now();
    const insert = this.db.prepare('INSERT INTO messages (threadId, role, text, at) VALUES (?, ?, ?, ?)');
    insert.run(threadId, 'user', question, at);
    insert.run(threadId, 'assistant', answer, at);
    this.db.prepare('UPDATE threads SET updatedAt = ? WHERE id = ?').run(at, threadId);
  }
}

/** The agent's memory note on its own board, or null. */
export async function memoryCard(agent, mcp) {
  const { items } = await mcp.call('get_board', { board_id: agent.boardId });
  return items.find(it => it.type === 'note' && it.data && it.data.agentMemory === agent.id) || null;
}

/** The `remember` tool a persistent agent gets: it replaces the memory card's text. */
export const rememberTool = (agent, mcp) => ({
  name: 'remember',
  description:
    'Rewrite your memory card: the whole text, which replaces what it says now. Keep what is worth knowing in a later conversation, briefly.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  run: async ({ text }) => {
    const body = `Memory of ${agent.name}\n\n${String(text || '').trim()}`;
    const card = await memoryCard(agent, mcp);
    if (card) {
      await mcp.call('update_item', { item_id: card.id, data: { text: body } });
    } else {
      const { items } = await mcp.call('get_board', { board_id: agent.boardId });
      await mcp.call('create_item', {
        board_id: agent.boardId,
        type: 'note',
        x: freeX(items),
        y: 60,
        data: { text: body, agentMemory: agent.id },
      });
    }
    return 'Saved to your memory card.';
  },
});
