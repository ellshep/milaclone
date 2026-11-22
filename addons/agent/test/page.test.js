// The page's API (W3.3) and memory (A8), against the real board and MCP with
// a provider that records what it was sent.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Threads } from '../src/memory.js';
import { pageServer, requestText } from '../src/page.js';
import { fakeProvider } from '../src/providers.js';
import { Service } from '../src/service.js';
import { startStack } from './stack.js';

let stack, svc, server, base;
const sent = []; // what each run gave the provider
const recording = async args => {
  sent.push(args);
  return fakeProvider(args);
};
const realError = console.error;

before(async () => {
  stack = await startStack();
  svc = new Service({
    mcpUrl: stack.mcpUrl,
    token: stack.token,
    providers: { anthropic: recording },
  });
  server = pageServer(svc, new Threads(':memory:'));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/agent/`;
  console.error = () => {};
});

after(async () => {
  console.error = realError;
  await svc.close();
  server.close();
  stack.stop();
});

const get = async p => (await fetch(base + p)).json();
const post = async (p, body) => {
  const r = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};
/** Sends a request and waits for its receipt to finish. */
async function ask(agent, notes, thread) {
  const { status, body } = await post('api/requests', { agent, notes, thread });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.status, 'seen');
  for (let i = 0; i < 100; i++) {
    const r = await get('api/requests/' + body.id);
    if (r.status === 'done' || r.status === 'failed') return r;
    await new Promise(res => setTimeout(res, 50));
  }
  throw new Error('request never finished');
}
const agentOn = async boardId => (await get('api/agents?board=' + boardId))[0];

test('a request carries its notes and the selected cards, fenced to the agent', async () => {
  const desk = await stack.board('Page desk', { agent: { name: 'Clerk', writes: 'chat', memory: 'ephemeral' } });
  const other = await stack.board('Elsewhere', { allow: true });
  const a = await stack.api('POST', '/api/item', { canvasId: desk, type: 'note', data: { text: 'alpha' } });
  const b = await stack.api('POST', '/api/item', { canvasId: desk, type: 'note', data: { text: 'beta' } });
  const far = await stack.api('POST', '/api/item', { canvasId: other, type: 'note', data: { text: 'hidden' } });
  const clerk = await agentOn(desk);
  assert.deepEqual(clerk, { id: clerk.id, name: 'Clerk', memory: 'ephemeral', writes: 'chat' });

  const r = await ask(clerk.id, [
    { ids: [a.id, b.id], text: 'compare these' },
    { ids: [far.id], text: 'and this' },
  ]);
  assert.equal(r.request, `On [${a.id}], [${b.id}]: compare these\nOn [${far.id}]: and this`);
  assert.equal(r.reply, 'Fake reply to: ' + r.request);
  assert.equal(r.thread, null); // ephemeral: nothing kept
  const content = sent.at(-1).messages.at(-1).content;
  assert.match(content, new RegExp(`\\[note ${a.id}\\] alpha`));
  assert.match(content, new RegExp(`\\[note ${b.id}\\] beta`));
  assert.match(content, new RegExp(`\\[${far.id}\\] \\(on a board outside your scope\\)`));
  assert.doesNotMatch(content, /hidden/);
  assert.deepEqual(await get('api/threads?agent=' + clerk.id), []);

  // bad input is refused before anything runs
  assert.equal((await post('api/requests', { agent: clerk.id, notes: [] })).status, 400);
  assert.equal((await post('api/requests', { agent: 'i_nope', notes: [{ ids: [], text: 'x' }] })).status, 404);
  const form = await fetch(base + 'api/requests', { method: 'POST', body: 'agent=x' });
  assert.equal(form.status, 415);

  // a reply pinned by hand lands on the agent's board, even for a chat-only agent
  const pinned = await post('api/pin', { agent: clerk.id, text: r.reply });
  const card = (await stack.items(desk)).find(it => it.id === pinned.body.id);
  assert.equal(card.data.text, 'From Clerk\n\n' + r.reply);
});

test('a thread is kept and replayed; a persistent agent keeps a memory card', async () => {
  // chat only, yet the memory card is written: the owner chose persistent
  const desk = await stack.board('Memory desk', { agent: { name: 'Sage', writes: 'chat', memory: 'persistent' } });
  const sage = await agentOn(desk);
  const first = await ask(sage.id, [{ ids: [], text: 'remember the owner likes tea' }]);
  assert.ok(first.thread);
  const memory = (await stack.items(desk)).find(it => it.data.agentMemory === sage.id);
  assert.equal(memory.data.text, 'Memory of Sage\n\nthe owner likes tea');

  const second = await ask(sage.id, [{ ids: [], text: 'what do I like?' }], first.thread);
  assert.equal(second.thread, first.thread);
  const { messages } = sent.at(-1);
  assert.deepEqual(
    messages.slice(0, 2).map(m => [m.role, m.content]),
    [
      ['user', 'remember the owner likes tea'],
      ['assistant', first.reply],
    ]
  );
  assert.match(messages[2].content, /<memory>\nMemory of Sage\n\nthe owner likes tea\n<\/memory>/);
  assert.ok(sent.at(-1).tools.some(t => t.name === 'remember'));

  const threads = await get('api/threads?agent=' + sage.id);
  assert.deepEqual(
    threads.map(t => t.title),
    ['remember the owner likes tea']
  );
  const t = await get('api/threads/' + first.thread);
  assert.equal(t.messages.length, 4);

  // a thread belongs to its agent
  const desk2 = await stack.board('Other desk', { agent: { name: 'Other' } });
  const other = await agentOn(desk2);
  const wrong = await post('api/requests', { agent: other.id, thread: first.thread, notes: [{ ids: [], text: 'x' }] });
  assert.equal(wrong.status, 404);
});

test('request text', () => {
  assert.equal(requestText([{ ids: [], text: 'hi' }]), 'hi');
  assert.equal(requestText([{ ids: ['i_1'], text: 'this' }]), 'On [i_1]: this');
});
