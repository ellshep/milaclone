// W4.1 acceptance: the orchestrator on Home, against the real board and MCP
// add-on (started as processes) with the fake provider.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pending } from '../src/comments.js';
import { DELEGATE_CAP, orchestratorTools } from '../src/orchestrator.js';
import { agentTools } from '../src/tools.js';
import { Service } from '../src/service.js';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const MCP = fileURLToPath(new URL('../../mcp/src/server.js', import.meta.url));
const TOKEN = 'agent-test-token-0123456789';

const freePort = () =>
  new Promise(resolve => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const waitFor = async url => {
  for (let i = 0; i < 100; i++) {
    if (
      await fetch(url).then(
        r => r.status < 500,
        () => false
      )
    )
      return;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('not up: ' + url);
};

let dataDir, procs, boardUrl, mcpUrl;
const logs = [];
const realError = console.error;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-test-'));
  const [bp, mp] = [await freePort(), await freePort()];
  boardUrl = `http://127.0.0.1:${bp}`;
  mcpUrl = `http://127.0.0.1:${mp}/mcp`;
  procs = [
    spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, DATA_DIR: dataDir, PORT: String(bp), HOST: '127.0.0.1' },
      stdio: 'ignore',
    }),
    spawn(process.execPath, [MCP], {
      env: { ...process.env, PORT: String(mp), HOST: '127.0.0.1', MCP_TOKEN: TOKEN, BOARD_URL: boardUrl },
      stdio: 'ignore',
    }),
  ];
  await waitFor(boardUrl + '/api/health');
  await waitFor(mcpUrl); // 401 without a token: up
  console.error = (...a) => logs.push(a.join(' '));
});

after(() => {
  console.error = realError;
  for (const p of procs) p.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const api = async (method, p, body) => {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return (await fetch(boardUrl + p, opts)).json();
};
const items = async id => (await api('GET', '/api/canvas/' + id)).items;
async function board(title, { allow = false, agent } = {}) {
  const { rootCanvasId } = await api('GET', '/api/root');
  const id = (await api('POST', '/api/item', { canvasId: rootCanvasId, type: 'board', data: { title } })).data
    .childCanvasId;
  if (allow) await api('PATCH', '/api/canvas/' + id, { agentAccess: true });
  if (agent) await api('POST', '/api/item', { canvasId: id, type: 'agent', x: 0, y: 0, data: agent });
  return id;
}
const service = () => new Service({ mcpUrl, token: TOKEN, providers: {}, fake: true });
const find = async (svc, name) => (await svc.agents()).find(a => a.agent.name === name).agent;
let homeAgent;
async function home() {
  if (!homeAgent) {
    const { rootCanvasId } = await api('GET', '/api/root');
    homeAgent = await api('POST', '/api/item', {
      canvasId: rootCanvasId,
      type: 'agent',
      x: 0,
      y: 0,
      data: { name: 'Chief', writes: 'direct', scope: 'board' },
    });
  }
  return homeAgent;
}

test('the Home agent reads Home and open boards, sees every title, and lists the agents it can ask', async () => {
  const svc = service();
  try {
    await home();
    const open = await board('Garden', { allow: true, agent: { name: 'Gardener' } });
    const shut = await board('Diary', { agent: { name: 'Scribe' } }); // open only to its own agent
    const chief = await find(svc, 'Chief');
    const { rootCanvasId } = await api('GET', '/api/root');
    assert.equal(chief.orchestrator, true);
    assert.deepEqual([...chief.scope.keys()].sort(), [rootCanvasId, open].sort());
    assert.equal((await find(svc, 'Gardener')).orchestrator, false);

    const tools = Object.fromEntries(
      [...agentTools(chief, await svc.mcp(chief.id)), ...orchestratorTools(svc, chief)].map(t => [t.name, t])
    );
    assert.ok(JSON.parse(await tools.list_boards.run({})).some(b => b.id === shut && b.title === 'Diary'));
    assert.match(await tools.get_board.run({ board_id: shut }), /outside Chief's scope/);
    const agents = JSON.parse(await tools.list_agents.run({}));
    assert.deepEqual(
      agents.map(a => a.name),
      ['Gardener']
    );
    assert.equal(
      agentTools(await find(svc, 'Gardener'), await svc.mcp()).some(t => t.name === 'list_boards'),
      false
    );
  } finally {
    await svc.close();
  }
});

test('a priority delegate runs the target agent at once', async () => {
  const svc = service();
  try {
    await home();
    const shed = await board('Shed', { allow: true, agent: { name: 'Clerk', writes: 'chat' } });
    const chief = await find(svc, 'Chief');
    const reply = await svc.ask(chief, 'delegate priority Clerk: count the tools');
    assert.match(reply, /Clerk replied: Fake reply to: count the tools$/);
    const comments = (await items(shed)).filter(it => it.type === 'comment');
    const ask = comments.find(c => c.data.delegatedBy);
    assert.deepEqual(
      [ask.data.text, ask.data.agent, ask.data.delegatedBy, ask.data.kind],
      ['@Clerk count the tools', chief.id, chief.id, 'priority']
    );
    const answer = comments.find(c => c.data.replyTo === ask.id);
    assert.equal(answer.data.text, 'Fake reply to: count the tools');
    assert.equal(answer.data.agent, (await find(svc, 'Clerk')).id);
    assert.equal(await svc.pollOnce(), 0); // already answered
    assert.ok(logs.some(l => JSON.parse(l).event === 'agent.delegate'));
  } finally {
    await svc.close();
  }
});

test('a normal delegate waits for the target’s next poll', async () => {
  const svc = service();
  try {
    await home();
    const loft = await board('Loft', { allow: true, agent: { name: 'Keeper', writes: 'chat' } });
    const chief = await find(svc, 'Chief');
    assert.match(await svc.ask(chief, 'delegate normal Keeper: check the boxes'), /Asked Keeper on "Loft"/);
    const ask = (await items(loft)).find(it => it.data.delegatedBy);
    assert.equal(ask.data.kind, 'normal');
    assert.equal((await items(loft)).filter(it => it.data.replyTo === ask.id).length, 0); // not yet
    assert.equal(await svc.pollOnce(), 1);
    const answers = (await items(loft)).filter(it => it.data.replyTo === ask.id);
    assert.deepEqual(
      answers.map(a => a.data.text),
      ['Fake reply to: check the boxes']
    );
  } finally {
    await svc.close();
  }
});

test('a delegate to a blocked board is refused, and nothing is written there', async () => {
  const svc = service();
  try {
    await home();
    const vault = await board('Vault', { agent: { name: 'Guard' } }); // agentAccess off
    const before = await items(vault);
    const chief = await find(svc, 'Chief');
    assert.match(
      await svc.ask(chief, 'delegate priority Guard: open up'),
      /Error: board "Vault" is blocked: its owner hasn't turned agent access on/
    );
    assert.deepEqual(await items(vault), before);
    const tools = Object.fromEntries(orchestratorTools(svc, chief).map(t => [t.name, t]));
    assert.match(await tools.delegate.run({ agent: 'Nobody', message: 'hi', kind: 'normal' }), /no agent called/);
    assert.match(await tools.delegate.run({ agent: 'Chief', message: 'hi', kind: 'normal' }), /no agent called/);
    assert.match(await tools.delegate.run({ agent: 'Guard', message: 'hi', kind: 'soon' }), /kind must be/);
  } finally {
    await svc.close();
  }
});

test('delegations are capped per run, and only an orchestrator can sign one', async () => {
  const svc = service();
  try {
    await home();
    const yard = await board('Yard', { allow: true, agent: { name: 'Yardie', writes: 'direct' } });
    const chief = await find(svc, 'Chief');
    const tools = Object.fromEntries(orchestratorTools(svc, chief).map(t => [t.name, t]));
    for (let i = 0; i < DELEGATE_CAP; i++) {
      assert.match(await tools.delegate.run({ agent: 'Yardie', message: `job ${i}`, kind: 'normal' }), /^Asked/);
    }
    assert.match(await tools.delegate.run({ agent: 'Yardie', message: 'one more', kind: 'normal' }), /at most 5/);
    assert.equal((await items(yard)).filter(it => it.data.delegatedBy).length, DELEGATE_CAP);

    // a model can't forge a delegation: tools strip delegatedBy and stamp the writer
    const yardie = await find(svc, 'Yardie');
    const own = Object.fromEntries(agentTools(yardie, await svc.mcp(yardie.id)).map(t => [t.name, t]));
    const forged = JSON.parse(
      await own.create_item.run({
        board_id: yard,
        type: 'comment',
        y: 2000,
        data: { text: '@Yardie again', delegatedBy: chief.id },
      })
    );
    assert.deepEqual([forged.data.delegatedBy, forged.data.agent], [undefined, yardie.id]);
    const c = (id, data) => ({ id, type: 'comment', data: { text: '@agent go', ...data } });
    const agents = [{ name: 'Yardie' }];
    const list = [
      c('signed', { agent: 'i_home', delegatedBy: 'i_home' }),
      c('not an orchestrator', { agent: 'i_x', delegatedBy: 'i_x' }),
      c('mismatch', { agent: 'i_x', delegatedBy: 'i_home' }),
    ];
    assert.deepEqual(
      pending(list, agents, new Set(['i_home'])).map(p => p.comment.id),
      ['signed']
    );
    assert.deepEqual(pending(list, agents), []);
  } finally {
    await svc.close();
  }
});
