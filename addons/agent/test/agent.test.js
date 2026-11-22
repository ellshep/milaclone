// W3.1 and W3.2 acceptance against the real board and the real MCP add-on,
// both started as processes, with the fake provider (no key, no network).

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { addressee, pending } from '../src/comments.js';
import { agentTools } from '../src/tools.js';
import { Service } from '../src/service.js';
import { startStack } from './stack.js';

let stack, mcpUrl, TOKEN, api, items, board;
const logs = [];
const realError = console.error;

before(async () => {
  stack = await startStack();
  ({ mcpUrl, token: TOKEN, api, items, board } = stack);
  console.error = (...a) => logs.push(a.join(' '));
});

after(() => {
  console.error = realError;
  stack.stop();
});

const service = (opts = {}) => new Service({ mcpUrl, token: TOKEN, providers: {}, fake: true, ...opts });
const agentOn = async (svc, boardId) => (await svc.agents()).find(a => a.agent.boardId === boardId).agent;

test('a propose agent lands its cards in its column; a chat-only agent changes nothing', async () => {
  const svc = service();
  try {
    const plans = await board('Plans', { agent: { name: 'Planner', writes: 'propose' } });
    const planner = await agentOn(svc, plans);
    assert.equal(await svc.ask(planner, 'add buy milk'), 'Fake reply to: add buy milk');
    const after = await items(plans);
    const col = after.find(it => it.type === 'column');
    assert.equal(col.data.title, 'Proposed by Planner');
    const note = after.find(it => it.type === 'note');
    assert.deepEqual([note.data.text, note.parentItemId], ['buy milk', col.id]);
    // a second proposal reuses the column
    await svc.ask(planner, 'add call mum');
    assert.equal((await items(plans)).filter(it => it.type === 'column').length, 1);

    const quiet = await board('Quiet', { agent: { name: 'Quiet', writes: 'chat' } });
    const before = await items(quiet);
    const chat = await agentOn(svc, quiet);
    assert.equal(await svc.ask(chat, 'add something'), 'Fake reply to: add something');
    assert.deepEqual(await items(quiet), before);
    assert.deepEqual(
      agentTools(chat, await svc.mcp(chat.id))
        .map(t => t.name)
        .sort(),
      ['get_board', 'get_board_outline', 'get_item', 'search']
    );

    const run = logs.map(l => JSON.parse(l)).find(l => l.event === 'agent.run' && l.agent === planner.id);
    assert.deepEqual([run.writes, run.model, run.toolCalls], ['propose', 'claude-opus-5-5', 1]);
  } finally {
    await svc.close();
  }
});

test('an agent reaches only its own board and listed boards that are open to agents', async () => {
  const svc = service();
  try {
    const open = await board('Shared', { allow: true });
    const other = await board('Theirs', { agent: { name: 'Them' } }); // open only to its own agent
    const home = await board('Mine', {
      agent: { name: 'Me', writes: 'direct', scope: 'boards', scopeBoards: 'shared\nTheirs\nNope' },
    });
    await board('Twin', { allow: true });
    await board('Twin', { allow: true });
    await api('PATCH', '/api/item/' + (await items(home))[0].id, {
      data: { scopeBoards: 'shared\nTheirs\nNope\ntwin' },
    });
    const me = await agentOn(svc, home);
    assert.deepEqual([...me.scope.keys()].sort(), [home, open].sort()); // two boards called Twin: neither

    const tools = Object.fromEntries(agentTools(me, await svc.mcp(me.id)).map(t => [t.name, t]));
    assert.match(await tools.get_board.run({ board_id: other }), /^Error: board .* is outside Me's scope/);
    const theirs = (await items(other))[0];
    assert.match(await tools.delete_item.run({ item_id: theirs.id }), /outside Me's scope/);
    assert.equal((await items(other)).length, 1);
    assert.match(await tools.get_board.run({ board_id: open }), /"title":"Shared"/);
    await api('POST', '/api/item', { canvasId: other, type: 'note', data: { text: 'mango' } });
    await api('POST', '/api/item', { canvasId: open, type: 'note', data: { text: 'mango too' } });
    const hits = JSON.parse(await tools.search.run({ query: 'mango' }));
    assert.deepEqual(
      hits.map(h => h.canvasId),
      [open]
    );

    // a comment never goes to another board, on its own or in a column (A16)
    const note = await api('POST', '/api/item', {
      canvasId: home,
      type: 'comment',
      x: 0,
      y: 500,
      data: { text: 'hi' },
    });
    assert.match(await tools.move_item.run({ item_id: note.id, board_id: open }), /can't move to another board/);
    const col = await api('POST', '/api/item', { canvasId: home, type: 'column', x: 900, data: { title: 'Talk' } });
    await api('POST', '/api/item', { canvasId: home, type: 'comment', parentItemId: col.id, data: { text: 'yo' } });
    assert.match(await tools.move_item.run({ item_id: col.id, board_id: open }), /can't move to another board/);
    assert.equal((await items(open)).filter(it => it.type !== 'note').length, 0);
    assert.doesNotMatch(await tools.move_item.run({ item_id: note.id, board_id: home, x: 40 }), /Error/);
  } finally {
    await svc.close();
  }
});

test("a board card whose board is another agent's can't be changed, or exported through", async () => {
  const svc = service();
  try {
    const home = await board('Office', { agent: { name: 'Boss', writes: 'direct' } });
    // a sub-board on Boss's board, opened only by its own agent
    const sub = (await api('POST', '/api/item', { canvasId: home, type: 'board', x: 600, data: { title: 'Private' } }))
      .data.childCanvasId;
    await api('POST', '/api/item', { canvasId: sub, type: 'agent', data: { name: 'Hermit' } });
    await api('POST', '/api/item', { canvasId: sub, type: 'note', data: { text: 'secret plans' } });
    // and a column holding a board that is open to agents but not listed for Boss
    const col = await api('POST', '/api/item', { canvasId: home, type: 'column', x: 900, data: { title: 'Projects' } });
    const flagged = (
      await api('POST', '/api/item', { canvasId: home, type: 'board', parentItemId: col.id, data: { title: 'Open' } })
    ).data.childCanvasId;
    await api('PATCH', '/api/canvas/' + flagged, { agentAccess: true });
    const boss = await agentOn(svc, home);
    assert.deepEqual([...boss.scope.keys()], [home]);
    const tools = Object.fromEntries(agentTools(boss, await svc.mcp(boss.id)).map(t => [t.name, t]));
    assert.equal(tools.export_board_markdown, undefined); // it would walk into Private
    assert.match(await tools.get_board.run({ board_id: sub }), /outside Boss's scope/);
    assert.match(await tools.delete_item.run({ item_id: col.id }), /outside Boss's scope/);
    assert.match(await tools.move_item.run({ item_id: col.id, board_id: home, x: 0 }), /outside Boss's scope/);
    const card = (await items(home)).find(it => it.type === 'board' && !it.parentItemId);
    assert.match(await tools.delete_item.run({ item_id: card.id }), /outside Boss's scope/);
    assert.match(await tools.move_item.run({ item_id: card.id, board_id: home, x: 0 }), /outside Boss's scope/);
    assert.match(
      await tools.update_item.run({ item_id: card.id, data: { title: 'Mine now' } }),
      /outside Boss's scope/
    );
    const after = (await api('GET', '/api/canvas/' + home)).items.find(it => it.id === card.id);
    assert.deepEqual([after.x, after._childTitle], [600, 'Private']);
    assert.equal((await items(home)).find(it => it.id === col.id).x, 900);
    // an ordinary card on its own board is still Boss's to change
    const note = await api('POST', '/api/item', { canvasId: home, type: 'note', data: { text: 'mine' } });
    assert.doesNotMatch(await tools.delete_item.run({ item_id: note.id }), /Error/);
  } finally {
    await svc.close();
  }
});

test("comments an agent writes never ask an agent, so agents can't set each other off", async () => {
  const svc = service();
  try {
    const desk = await board('Loop', { agent: { name: 'Looper', writes: 'direct' } });
    const looper = await agentOn(svc, desk);
    const tools = Object.fromEntries(agentTools(looper, await svc.mcp(looper.id)).map(t => [t.name, t]));
    await tools.create_item.run({ board_id: desk, type: 'comment', data: { text: '@agent do it again' } });
    await tools.create_items.run({ board_id: desk, items: [{ type: 'comment', data: { text: '@Looper again' } }] });
    const plain = await api('POST', '/api/item', { canvasId: desk, type: 'comment', data: { text: 'fyi' } });
    await tools.update_item.run({ item_id: plain.id, data: { text: '@agent and again' } });
    const comments = (await items(desk)).filter(it => it.type === 'comment');
    assert.equal(comments.length, 3);
    assert.ok(comments.every(c => c.data.agent === looper.id));
    assert.equal(await svc.pollOnce(), 0);
    // what an agent wrote (a reply being written, say) is left alone
    assert.match(await tools.delete_item.run({ item_id: plain.id }), /written by an agent/);
    assert.match(await tools.update_item.run({ item_id: plain.id, data: { text: 'x' } }), /written by an agent/);
    // and it can't mark a person's question answered, or sign as another agent
    const ask = await api('POST', '/api/item', {
      canvasId: desk,
      type: 'comment',
      y: 900,
      data: { text: '@agent hi' },
    });
    const fake = JSON.parse(
      await tools.create_item.run({
        board_id: desk,
        type: 'comment',
        data: { text: 'done', replyTo: ask.id, agent: 'i_someone' },
      })
    );
    assert.deepEqual([fake.data.replyTo, fake.data.agent], [undefined, looper.id]);
    assert.equal(await svc.pollOnce(), 1);
  } finally {
    await svc.close();
  }
});

test('an @agent comment gets exactly one reply card below it', async () => {
  const svc = service();
  try {
    const desk = await board('Desk', { agent: { name: 'Clerk', writes: 'chat' } });
    await api('POST', '/api/item', {
      canvasId: desk,
      type: 'note',
      x: 400,
      y: 400,
      data: { text: 'Budget: 100' },
    });
    const ask = await api('POST', '/api/item', {
      canvasId: desk,
      type: 'comment',
      x: 420,
      y: 420,
      data: { text: '@agent is the budget enough?' },
    });
    await api('POST', '/api/item', { canvasId: desk, type: 'comment', x: 0, y: 900, data: { text: 'just a note' } });
    const named = await api('POST', '/api/item', {
      canvasId: desk,
      type: 'comment',
      x: 0,
      y: 1200,
      data: { text: '@Clerk hello' },
    });

    assert.equal(await svc.pollOnce(), 2);
    assert.equal(await svc.pollOnce(), 0); // nothing answered twice
    const replies = (await items(desk)).filter(it => it.type === 'comment' && it.data.replyTo);
    const toAsk = replies.find(r => r.data.replyTo === ask.id);
    assert.equal(toAsk.data.text, 'Fake reply to: is the budget enough?');
    assert.equal(toAsk.data.agent, (await agentOn(svc, desk)).id);
    assert.ok(toAsk.y > ask.y && toAsk.x === ask.x, 'below the comment');
    assert.equal(replies.find(r => r.data.replyTo === named.id).data.text, 'Fake reply to: hello');
    assert.equal(replies.length, 2);
  } finally {
    await svc.close();
  }
});

test('a failed run answers with the error once instead of retrying every poll', async () => {
  const failing = async () => {
    throw new Error('boom');
  };
  const svc = service({ fake: false, providers: { anthropic: failing } });
  try {
    const desk = await board('Broken', { agent: { name: 'Broken', provider: 'anthropic' } });
    const ask = await api('POST', '/api/item', { canvasId: desk, type: 'comment', data: { text: '@agent hi' } });
    const gem = await board('Gem', { agent: { name: 'Gem', provider: 'gemini' } });
    await api('POST', '/api/item', { canvasId: gem, type: 'comment', data: { text: '@agent hi' } });
    assert.equal(await svc.pollOnce(), 2);
    assert.equal(await svc.pollOnce(), 0);
    const reply = (await items(desk)).find(it => it.data.replyTo === ask.id);
    assert.equal(reply.data.text, "Sorry, I couldn't answer that: boom");
    assert.match((await items(gem)).find(it => it.data.replyTo).data.text, /provider "gemini" isn't supported yet/);
  } finally {
    await svc.close();
  }
});

test('a placeholder trashed mid-run is logged, and the poll carries on', async () => {
  let desk;
  const trashing = async () => {
    const card = (await items(desk)).find(it => it.data.replyTo);
    await api('DELETE', '/api/item/' + card.id);
    return { text: 'too late', usage: { input: 0, output: 0 }, toolCalls: 0 };
  };
  const svc = service({ fake: false, providers: { anthropic: trashing } });
  try {
    desk = await board('Gone', { agent: { name: 'Gone' } });
    await api('POST', '/api/item', { canvasId: desk, type: 'comment', data: { text: '@agent hi' } });
    assert.equal(await svc.pollOnce(), 1);
    assert.ok(logs.some(l => JSON.parse(l).event === 'agent.reply_failed'));
  } finally {
    await svc.close();
  }
});

test('who a comment is for', () => {
  const a = { name: 'Research Bot' };
  const b = { name: 'Rex' };
  const c = (text, data = {}) => ({ id: text, type: 'comment', data: { text, ...data } });
  assert.equal(addressee(c('@agent hi'), [b, a]), b); // the board's first agent
  assert.equal(addressee(c('@research bot dig'), [b, a]), a);
  assert.equal(addressee(c('@rexy hi'), [b, a]), null);
  assert.equal(addressee(c('hi @agent'), [b]), null);
  const answered = c('@agent q');
  const items = [
    answered,
    c('reply', { replyTo: '@agent q', agent: 'i_x' }),
    c('@agent open'),
    c('@agent person replied'),
    c('me too', { replyTo: '@agent person replied' }), // a person's reply doesn't answer it
    c('@agent from a bot', { agent: 'i_y' }),
  ];
  assert.deepEqual(
    pending(items, [b]).map(p => p.comment.id),
    ['@agent open', '@agent person replied']
  );
});
