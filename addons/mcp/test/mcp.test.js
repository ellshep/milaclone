// W2.1 acceptance: boots the real board (the repo's server.js) on a temp
// DATA_DIR, serves the MCP over HTTP in-process, runs every tool through the
// official client, and checks that every tool refuses a blocked board.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Board, label } from '../src/board.js';
import { httpHandler } from '../src/server.js';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const TOKEN = 'mcp-test-token-0123456789';
const TOOLS = [
  'add_todo_task',
  'create_item',
  'create_items',
  'delete_item',
  'export_board_markdown',
  'get_board',
  'get_board_outline',
  'get_item',
  'get_root',
  'list_boards',
  'move_item',
  'restore_item',
  'search',
  'set_todo_task_done',
  'update_item',
  'write_brief',
];

const freePort = () =>
  new Promise(resolve => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

let dataDir, boardProc, boardUrl, mcp, mcpUrl, client;
let token = TOKEN;
const logs = [];
const realError = console.error;

const api = async (method, p, body) => {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return (await fetch(boardUrl + p, opts)).json();
};

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
  const port = await freePort();
  boardUrl = `http://127.0.0.1:${port}`;
  boardProc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    if (
      await fetch(boardUrl + '/api/health').then(
        r => r.ok,
        () => false
      )
    )
      break;
    await new Promise(r => setTimeout(r, 200));
  }
  console.error = (...a) => logs.push(a.join(' '));
  mcp = http.createServer(httpHandler(new Board(boardUrl), () => token));
  await new Promise(r => mcp.listen(0, '127.0.0.1', r));
  mcpUrl = `http://127.0.0.1:${mcp.address().port}/mcp`;
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { Authorization: 'Bearer ' + TOKEN, 'X-Agent-Id': 'i_agent' } },
    })
  );
});

after(async () => {
  console.error = realError;
  await client.close();
  mcp.close();
  boardProc.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const raw = (name, args = {}) => client.callTool({ name, arguments: args });
async function call(name, args) {
  const r = await raw(name, args);
  assert.ok(!r.isError, `${name} failed: ${r.content[0].text}`);
  const t = r.content[0].text;
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}
async function refused(name, args) {
  const r = await raw(name, args);
  assert.equal(r.isError, true, `${name} should be refused`);
  assert.match(r.content[0].text, /blocked for agents: its agentAccess flag is off/, name);
}

async function boardOn(rootId, title, { allow = false } = {}) {
  const card = await api('POST', '/api/item', { canvasId: rootId, type: 'board', data: { title } });
  const id = card.data.childCanvasId;
  if (allow) await api('PATCH', '/api/canvas/' + id, { agentAccess: true });
  return id;
}

test('every tool works on readable boards and refuses a blocked one', async () => {
  assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), TOOLS);

  const { rootCanvasId } = await api('GET', '/api/root');
  const open = await boardOn(rootCanvasId, 'Open', { allow: true });
  const room = await boardOn(rootCanvasId, 'Agent room');
  await api('POST', '/api/item', { canvasId: room, type: 'agent', data: { name: 'Helper' } }); // readable by agent card
  const priv = await boardOn(rootCanvasId, 'Private');
  const secret = await api('POST', '/api/item', { canvasId: priv, type: 'note', data: { text: 'zebra secret' } });
  const privTodo = await api('POST', '/api/item', {
    canvasId: priv,
    type: 'todo',
    data: { title: 'Hidden', tasks: [{ text: 'hidden task' }] },
  });

  // reads
  const root = await call('get_root');
  assert.deepEqual([root.id, root.title, root.readable], [rootCanvasId, 'Home', false]);
  const boards = await call('list_boards');
  const byTitle = Object.fromEntries(boards.map(b => [b.title, b]));
  assert.deepEqual(
    ['Open', 'Agent room', 'Private'].map(t => byTitle[t].readable),
    [true, true, false]
  );
  assert.deepEqual(byTitle.Private.path, ['Home', 'Private']);

  // writes
  const note = await call('create_item', { board_id: open, type: 'note', data: { text: 'zebra plan' }, x: 10, y: 10 });
  assert.equal(note.data.text, 'zebra plan');
  assert.equal(note.data.doc, undefined); // slimmed
  const [col, list] = await call('create_items', {
    board_id: open,
    items: [
      { type: 'column', data: { title: 'Ideas' }, x: 300, y: 10 },
      { type: 'todo', data: { title: 'Jobs', tasks: [] }, x: 600, y: 10 },
    ],
  });
  await call('create_item', { board_id: open, type: 'note', data: { text: 'in the column' }, parent_item_id: col.id });

  const outline = await call('get_board_outline', { board_id: open });
  assert.match(outline, /^Board "Open" \(c_[\w-]+\), 4 cards/);
  assert.match(outline, new RegExp(`- \\[column ${col.id}\\] Ideas\\n  - \\[note i_[\\w-]+\\] in the column`));
  assert.match(outline, /\[todo i_[\w-]+\] Jobs \(0 open\)/);
  const full = await call('get_board', { board_id: open });
  assert.equal(full.items.length, 4);
  assert.equal(full.board.title, 'Open');

  const updated = await call('update_item', { item_id: note.id, data: { text: 'zebra plan v2' }, color: 'yellow' });
  assert.deepEqual([updated.data.text, updated.color], ['zebra plan v2', 'yellow']);
  const got = await call('get_item', { item_id: note.id });
  assert.deepEqual([got.item.data.text, got.boardTitle], ['zebra plan v2', 'Open']);

  const task = await call('add_todo_task', { item_id: list.id, text: 'Write tests', due: '2026-12-01' });
  assert.match(task.id, /^t_/);
  assert.equal(task.due, '2026-12-01');
  const done = await call('set_todo_task_done', { item_id: list.id, task_id: task.id });
  assert.equal(done.status, 'done');
  assert.equal(typeof done.statusAt, 'number'); // stamped by the board
  const undone = await call('set_todo_task_done', { item_id: list.id, task_id: task.id, done: false });
  assert.equal(undone.status, 'open');

  const hits = await call('search', { query: 'zebra' });
  assert.deepEqual(
    hits.filter(h => h.kind === 'item').map(h => h.id),
    [note.id]
  ); // the private zebra note is left out

  assert.match(await call('export_board_markdown', { board_id: open }), /zebra plan v2/);

  const moved = await call('move_item', { item_id: note.id, board_id: room, x: 50, y: 50 });
  assert.equal(moved.canvasId, room);
  assert.deepEqual(await call('delete_item', { item_id: note.id }), { trashed: note.id });
  assert.equal((await raw('get_item', { item_id: note.id })).isError, true);
  assert.equal((await call('restore_item', { item_id: note.id })).id, note.id);

  // a blocked board, through every tool that names a board or card
  await refused('get_board_outline', { board_id: priv });
  await refused('get_board', { board_id: priv });
  await refused('export_board_markdown', { board_id: priv });
  await refused('get_item', { item_id: secret.id });
  await refused('create_item', { board_id: priv, type: 'note', data: { text: 'x' } });
  await refused('create_items', { board_id: priv, items: [{ type: 'note' }] });
  await refused('update_item', { item_id: secret.id, data: { text: 'x' } });
  await refused('move_item', { item_id: secret.id, board_id: open });
  await refused('move_item', { item_id: list.id, board_id: priv }); // nor into one
  await refused('delete_item', { item_id: secret.id });
  await refused('add_todo_task', { item_id: privTodo.id, text: 'x' });
  await refused('set_todo_task_done', { item_id: privTodo.id, task_id: privTodo.data.tasks[0].id });
  await api('DELETE', '/api/item/' + secret.id);
  await refused('restore_item', { item_id: secret.id });

  // nothing on the private board changed
  const after = await api('GET', '/api/canvas/' + priv);
  assert.deepEqual(
    after.items.map(i => i.id),
    [privTodo.id]
  );
  assert.notEqual(after.items[0].data.tasks[0].status, 'done');

  // other refusals are plain errors, not crashes
  assert.match((await raw('get_item', { item_id: 'i_nope' })).content[0].text, /no card with id i_nope/);
  assert.match((await raw('add_todo_task', { item_id: col.id, text: 'x' })).content[0].text, /not a to-do list/);

  // A21: writes are logged with the agent card id
  const writes = logs.filter(l => l.includes('"mcp.write"')).map(l => JSON.parse(l));
  assert.ok(writes.some(w => w.tool === 'create_item' && w.agent === 'i_agent' && w.boardId === open));
  assert.deepEqual([...new Set(writes.map(w => w.tool))].sort(), [
    'add_todo_task',
    'create_item',
    'delete_item',
    'move_item',
    'restore_item',
    'set_todo_task_done',
    'update_item',
  ]);
});

test('todo creation tools respect server-owned status metadata and count only open tasks', async () => {
  const { rootCanvasId } = await api('GET', '/api/root');
  const board_id = await boardOn(rootCanvasId, 'Status tools', { allow: true });
  const data = {
    title: 'Jobs',
    tasks: [
      { text: 'Finished', status: 'done', statusAt: 1, statusReason: 'client' },
      { text: 'Set aside', status: 'stale' },
      { text: 'To do' },
    ],
  };
  const card = { type: 'todo', data };
  const one = await call('create_item', { board_id, ...card });
  const [many] = await call('create_items', { board_id, items: [card] });
  const outline = await call('get_board_outline', { board_id });
  for (const list of [one, many]) {
    const finished = list.data.tasks.find(t => t.text === 'Finished');
    assert.deepEqual([finished.status, finished.statusAt, finished.statusReason], ['done', null, undefined]);
    assert.ok(outline.includes(`[todo ${list.id}] Jobs (1 open)`));
  }
  const invalid = { type: 'todo', data: { tasks: [{ text: 'Invalid', status: 'complete' }] } };
  assert.equal((await raw('create_item', { board_id, ...invalid })).isError, true);
  assert.equal((await raw('create_items', { board_id, items: [invalid] })).isError, true);
});

test('the board outline counts unrecognized statuses as open', () => {
  assert.equal(
    label({
      type: 'todo',
      data: {
        title: 'Import',
        tasks: [
          { text: 'Old value', status: 'pending' },
          { text: 'No status' },
          { text: 'Open', status: 'open' },
          { text: 'Finished', status: 'done' },
          { text: 'Set aside', status: 'stale' },
        ],
      },
    }),
    'Import (3 open)'
  );
});

test('agent cards, and blocked boards below an open one, stay out of reach', async () => {
  const { rootCanvasId } = await api('GET', '/api/root');
  const open = await boardOn(rootCanvasId, 'Open 2', { allow: true });
  await api('POST', '/api/item', { canvasId: open, type: 'note', data: { text: 'visible fig' }, x: 0, y: 0 });
  const kiwiCard = await api('POST', '/api/item', { canvasId: open, type: 'board', data: { title: 'Kiwi' }, y: 200 });
  const kiwi = kiwiCard.data.childCanvasId;
  await api('POST', '/api/item', { canvasId: kiwi, type: 'note', data: { text: 'kiwi hidden' } });
  const deep = await boardOn(kiwi, 'Deeper', { allow: true }); // readable, though under a blocked board
  await api('POST', '/api/item', { canvasId: deep, type: 'note', data: { text: 'deep visible' } });

  const md = await call('export_board_markdown', { board_id: open });
  assert.match(md, /^# Open 2\n\n## visible fig/);
  assert.match(md, /# Kiwi\n\n\(Blocked for agents: its agentAccess flag is off\.\)/);
  assert.match(md, /# Deeper\n\n## deep visible/);
  assert.doesNotMatch(md, /kiwi hidden/);

  await refused('delete_item', { item_id: kiwiCard.id }); // would trash the blocked board
  await refused('move_item', { item_id: kiwiCard.id, board_id: open });
  assert.equal((await api('GET', '/api/canvas/' + kiwi)).canvas.title, 'Kiwi');

  const room = await boardOn(rootCanvasId, 'Agent room 2');
  const agent = await api('POST', '/api/item', { canvasId: room, type: 'agent', data: { name: 'A', scope: 'board' } });
  const col = await api('POST', '/api/item', { canvasId: room, type: 'column', data: { title: 'C' } });
  await api('PATCH', '/api/item/' + agent.id, { parentItemId: col.id });
  const noAgents = async (name, args) => {
    const r = await raw(name, args);
    assert.equal(r.isError, true, name);
    assert.match(r.content[0].text, /agent cards are set up by the owner/, name);
  };
  await noAgents('create_item', { board_id: open, type: 'agent', data: { name: 'Me too' } });
  await noAgents('create_items', { board_id: open, items: [{ type: 'note' }, { type: 'agent' }] });
  await noAgents('update_item', { item_id: agent.id, data: { scope: 'boards', scopeBoards: 'Private' } });
  await noAgents('move_item', { item_id: agent.id, board_id: open });
  await noAgents('move_item', { item_id: col.id, board_id: open }); // the column carries the agent card
  const still = (await api('GET', '/api/canvas/' + room)).items.find(i => i.id === agent.id);
  assert.deepEqual([still.data.scope, still.canvasId], ['board', room]);
  assert.deepEqual(await call('delete_item', { item_id: agent.id }), { trashed: agent.id }); // narrowing is fine
});

test('update_item never re-points a board card, a shortcut or a line elsewhere; agent cards stay trashed', async () => {
  const { rootCanvasId } = await api('GET', '/api/root');
  const open = await boardOn(rootCanvasId, 'Open 3', { allow: true });
  const other = await boardOn(rootCanvasId, 'Elsewhere');
  const sub = await api('POST', '/api/item', { canvasId: open, type: 'board', data: { title: 'Sub' } });
  const short = await api('POST', '/api/item', { canvasId: open, type: 'shortcut', data: { targetCanvasId: open } });
  const add = data => api('POST', '/api/item', { canvasId: open, type: 'note', data });
  const [a, b2, far] = [
    await add({ text: 'a' }),
    await add({ text: 'b' }),
    await api('POST', '/api/item', { canvasId: other, type: 'note' }),
  ];
  const line = await api('POST', '/api/item', {
    canvasId: open,
    type: 'line',
    data: { from: { id: a.id }, to: { id: a.id } },
  });
  const no = async (args, re) => {
    const r = await raw('update_item', args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.content[0].text, re);
  };
  await no({ item_id: sub.id, data: { childCanvasId: other } }, /childCanvasId can't be changed/);
  await no({ item_id: short.id, data: { targetCanvasId: other } }, /targetCanvasId can't be changed/);
  await no({ item_id: line.id, data: { to: { id: far.id } } }, /line's to must be a card on the same board/);
  const items = (await api('GET', '/api/canvas/' + open)).items;
  assert.equal(items.find(i => i.id === sub.id).data.childCanvasId, sub.data.childCanvasId);
  assert.equal(items.find(i => i.id === short.id).data.targetCanvasId, open);
  assert.deepEqual((await call('update_item', { item_id: line.id, data: { to: { id: b2.id } } })).data.to, {
    id: b2.id,
  });
  assert.deepEqual((await call('update_item', { item_id: line.id, data: { to: { x: 5, y: 6 } } })).data.to, {
    x: 5,
    y: 6,
  });

  // an agent card the owner trashed stays trashed, even on a board open by its flag
  const agent = await api('POST', '/api/item', { canvasId: open, type: 'agent', data: { name: 'Gone' } });
  await api('DELETE', '/api/item/' + agent.id);
  const r = await raw('restore_item', { item_id: agent.id });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /agent cards are set up by the owner/);
  assert.ok((await api('GET', '/api/trash')).items.some(t => t.id === agent.id));
});

test('write_brief files briefs in a Briefs column, and their text round-trips through export.md', async () => {
  const { rootCanvasId } = await api('GET', '/api/root');
  const open = await boardOn(rootCanvasId, 'Briefed', { allow: true });
  await api('POST', '/api/item', {
    canvasId: open,
    type: 'note',
    x: 100,
    y: 80,
    w: 300,
    data: { text: 'already here' },
  });
  const first = await call('write_brief', {
    board_id: open,
    goal: 'Add  a digest\nview',
    repo: 'ellshep/milaclone',
    files: ['focus.js', 'tasks-api.js'],
    acceptance: ['Capped at 8 lines', '[ ] Done moves the next one up'],
  });
  const text = [
    'Goal: Add a digest view',
    'Repo: ellshep/milaclone',
    'Files:',
    '- focus.js',
    '- tasks-api.js',
    'Acceptance:',
    '- Capped at 8 lines',
    '- Done moves the next one up',
  ].join('\n');
  assert.equal(first.data.text, text);
  const second = await call('write_brief', { board_id: open, goal: 'Second', repo: 'r', acceptance: ['ok'] });
  assert.equal(second.data.text, 'Goal: Second\nRepo: r\nAcceptance:\n- ok');
  assert.ok(logs.some(l => l.includes('"write_brief"') && l.includes(first.id)));

  const items = (await api('GET', '/api/canvas/' + open)).items;
  const cols = items.filter(i => i.type === 'column');
  assert.deepEqual([cols[0].x, cols[0].y], [440, 80]); // to the right of the note, not on it
  assert.deepEqual(
    cols.map(c => c.data.title),
    ['Briefs']
  ); // made once, then reused
  const inCol = items.filter(i => i.parentItemId === cols[0].id).sort((a, b) => a.y - b.y);
  assert.deepEqual(
    inCol.map(i => i.id),
    [first.id, second.id]
  );
  await refused('write_brief', {
    board_id: await boardOn(rootCanvasId, 'No briefs'),
    goal: 'x',
    repo: 'r',
    acceptance: ['y'],
  });

  // export.md, then the board's own importer reads it back as the same notes, into a fresh board
  const md = await (await fetch(`${boardUrl}/api/canvas/${open}/export.md`)).text();
  const file = path.join(dataDir, 'briefs.md');
  fs.writeFileSync(file, md);
  const target = await boardOn(rootCanvasId, 'Import target');
  const importer = ['scripts/import-milanote-md.js', '--base', boardUrl, '--parent', target, file];
  execFileSync(process.execPath, importer, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }); // stderr lands in the error
  const copies = (await api('GET', '/api/canvas/' + target)).items.filter(i => i.type === 'board');
  assert.deepEqual(
    copies.map(c => c._childTitle),
    ['Briefed']
  );
  assert.notEqual(copies[0].data.childCanvasId, open);
  const imported = (await api('GET', '/api/canvas/' + copies[0].data.childCanvasId)).items;
  assert.deepEqual(
    imported.map(n => n.type).sort(),
    ['note', 'note', 'note'] // no to-do card from the checkbox line
  );
  assert.deepEqual(imported.map(n => n.data.text).sort(), ['already here', text, second.data.text].sort());
});

test('the HTTP endpoint needs the token and POST', async () => {
  const post = (headers = {}) =>
    fetch(mcpUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });
  assert.equal((await post()).status, 401);
  assert.equal((await post({ Authorization: 'Bearer wrong-token-0123456789x' })).status, 401);
  assert.equal((await fetch(mcpUrl, { headers: { Authorization: 'Bearer ' + TOKEN } })).status, 405);
  assert.equal((await fetch(mcpUrl.replace('/mcp', '/other'))).status, 404);
  const bad = await fetch(mcpUrl, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: '{' });
  assert.equal(bad.status, 400);
  token = '';
  try {
    assert.equal((await post({ Authorization: 'Bearer ' + TOKEN })).status, 503);
  } finally {
    token = TOKEN;
  }
});

test('stdio serves the same tools without a token', async () => {
  const local = new Client({ name: 'test-stdio', version: '1.0.0' });
  await local.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../src/server.js', import.meta.url)), '--stdio'],
      env: { ...process.env, BOARD_URL: boardUrl, MCP_TOKEN: '' },
      stderr: 'ignore',
    })
  );
  try {
    const r = await local.callTool({ name: 'get_root', arguments: {} });
    assert.equal(JSON.parse(r.content[0].text).title, 'Home');
  } finally {
    await local.close();
  }
});
