'use strict';

// Task API (tasks-api.js): bearer auth, the Inbox list, validation, dedupe and
// import idempotency, listing and patching. Runs against a throwaway DATA_DIR.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-test-'));
process.env.DATA_DIR = TMP;
process.env.TASK_TZ = 'America/Chicago';
const TOKEN = 'test-token-0123456789';
process.env.TASK_API_TOKEN = TOKEN;

const express = require('express');
const app = express();
app.use(require('../routes'));

let base;
let server;
const logs = [];
const realLog = console.log;
test.before(async () => {
  console.log = (...a) => logs.push(a.join(' '));
  await new Promise(r => {
    server = app.listen(0, '127.0.0.1', r);
  });
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => {
  console.log = realLog;
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const call = async (method, p, body, token = TOKEN) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, {
    method,
    headers,
    // oxlint-disable-next-line unicorn/no-invalid-fetch-options -- only set for non-GET
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};
const post = (b, token) => call('POST', '/api/tasks', b, token);
const patch = (id, b) => call('PATCH', '/api/tasks/' + id, b);
const list = (q = '') => call('GET', '/api/tasks' + q);
const plain = p => fetch(base + p).then(r => r.json());

test('rejects a missing or wrong token with 401', async () => {
  assert.equal((await post({ title: 'x' }, null)).status, 401);
  assert.equal((await post({ title: 'x' }, 'wrong-token-0123456789')).status, 401);
  assert.equal((await post({ title: 'x' }, 'short')).status, 401);
  assert.equal((await call('GET', '/api/tasks', undefined, null)).status, 401);
  assert.equal((await call('PATCH', '/api/tasks/t_x', { done: true }, null)).status, 401);
});

test('returns 503 while TASK_API_TOKEN is unset', async () => {
  delete process.env.TASK_API_TOKEN;
  try {
    const r = await post({ title: 'x' });
    assert.equal(r.status, 503);
    assert.match(r.body.error, /TASK_API_TOKEN/);
  } finally {
    process.env.TASK_API_TOKEN = TOKEN;
  }
});

test('creates a task in an Inbox list on Home that both screens see', async () => {
  const r = await post({
    title: '  Buy   printer ink ',
    notes: 'the black one',
    tags: ['#errands', 'errands', ' home '],
    dueDate: '2026-12-01',
    source: 'voice-note',
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.created, true);
  const t = r.body.task;
  assert.match(t.id, /^t_/);
  assert.equal(t.text, 'Buy printer ink');
  assert.equal(t.note, 'the black one');
  assert.deepEqual(t.tags, ['errands', 'home']);
  assert.equal(t.due, '2026-12-01');
  assert.equal(t.source, 'voice-note');
  assert.equal(t.done, false);
  assert.equal(t.starred, false);
  assert.equal(t.pinned, false);
  assert.equal(t.stale, false);
  assert.equal(t.rankScore, null);
  assert.equal(t.listTitle, 'Inbox');
  assert.ok(logs.some(l => l.includes('"task.create"') && l.includes('"voice-note"')));

  const { lists, rootCanvasId } = await plain('/api/todos');
  const inbox = lists.find(l => l.id === t.listId);
  assert.equal(inbox.title, 'Inbox');
  assert.equal(inbox.canvasId, rootCanvasId);
  assert.equal(inbox.tasks.at(-1).text, 'Buy printer ink');
  // stored tasks don't carry the list fields the API adds
  assert.equal(inbox.tasks.at(-1).listId, undefined);

  // a second task goes into the same Inbox
  const r2 = await post({ title: 'Second' });
  assert.equal(r2.body.task.listId, t.listId);
  assert.equal(r2.body.task.source, 'api');
});

test('a trashed Inbox is replaced by a new one', async () => {
  const first = (await post({ title: 'Before trash' })).body.task;
  await fetch(base + '/api/item/' + first.listId, { method: 'DELETE' });
  const next = (await post({ title: 'After trash' })).body.task;
  assert.notEqual(next.listId, first.listId);
  assert.equal(next.listTitle, 'Inbox');
  const open = (await list()).body.tasks.map(t => t.text);
  assert.ok(!open.includes('Before trash'));
  assert.ok(open.includes('After trash'));
});

test('listId puts the task in another to-do list', async () => {
  const canvasId = (await plain('/api/root')).rootCanvasId;
  const card = await fetch(base + '/api/item', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ canvasId, type: 'todo', data: { title: 'Groceries', tasks: [] } }),
  }).then(r => r.json());
  const r = await post({ title: 'Milk', listId: card.id });
  assert.equal(r.status, 201);
  assert.equal(r.body.task.listId, card.id);
  assert.equal(r.body.task.listTitle, 'Groceries');
  // dedupe checks only the target list: an open "Milk" in Groceries doesn't block the Inbox
  const inboxMilk = await post({ title: 'Milk', dedupe: true });
  assert.equal(inboxMilk.status, 201);
  assert.notEqual(inboxMilk.body.task.listId, card.id);
  const again = await post({ title: 'milk', listId: card.id, dedupe: true });
  assert.equal(again.body.duplicate, true);
  assert.equal(again.body.task.id, r.body.task.id);

  const note = await fetch(base + '/api/item', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ canvasId, type: 'note', data: { title: 'not a list' } }),
  }).then(r => r.json());
  assert.equal((await post({ title: 'x', listId: note.id })).status, 400);
  assert.equal((await post({ title: 'x', listId: 'i_missing' })).status, 400);
  assert.equal((await post({ title: 'x', listId: 42 })).status, 400);
});

test('validates the body', async () => {
  const cases = [
    {},
    { title: '' },
    { title: '   ' },
    { title: 7 },
    { title: 'x'.repeat(501) },
    { title: 'x', notes: 5 },
    { title: 'x', notes: 'n'.repeat(20001) },
    { title: 'x', tags: 'errands' },
    { title: 'x', tags: [1] },
    { title: 'x', tags: ['t'.repeat(61)] },
    { title: 'x', tags: Array.from({ length: 31 }, (_, i) => 'tag' + i) },
    { title: 'x', dueDate: 'tomorrow' },
    { title: 'x', dueDate: '2026-02-30' },
    { title: 'x', dueDate: '2026-13-01T10:00:00Z' },
    { title: 'x', dueDate: 20261201 },
    { title: 'x', starred: 'yes' },
    { title: 'x', priority: 'urgent' },
    { title: 'x', priority: 3 },
    { title: 'x', source: 9 },
    { title: 'x', source: 's'.repeat(41) },
    { title: 'x', source: '   ' },
    { title: 'x', importId: 5 },
    { title: 'x', dedupe: 'yes' },
  ];
  for (const b of cases) {
    const r = await post(b);
    assert.equal(r.status, 400, JSON.stringify(b).slice(0, 80));
    assert.equal(typeof r.body.error, 'string');
  }
});

test('normalises due dates and priority', async () => {
  // 03:30 UTC on Dec 2 is still Dec 1 in Chicago
  assert.equal((await post({ title: 'tz', dueDate: '2026-12-02T03:30:00Z' })).body.task.due, '2026-12-01');
  assert.equal((await post({ title: 'null due', dueDate: null })).body.task.due, null);
  assert.equal((await post({ title: 'empty due', dueDate: '' })).body.task.due, null);
  assert.equal((await post({ title: 'high', priority: 'HIGH' })).body.task.starred, true);
  assert.equal((await post({ title: 'low', priority: 'low' })).body.task.starred, false);
  assert.equal((await post({ title: 'star wins', priority: 'high', starred: false })).body.task.starred, false);
  assert.equal((await post({ title: 'starred', starred: true })).body.task.starred, true);
  assert.deepEqual((await post({ title: 'blank tags', tags: ['#', ' '] })).body.task.tags, []);
});

test('importId makes re-posting idempotent', async () => {
  const a = await post({ title: 'Imported', importId: 'mstodo:abc', source: 'migration' });
  assert.equal(a.status, 201);
  const b = await post({ title: 'Imported (edited title)', importId: 'mstodo:abc', source: 'migration' });
  assert.equal(b.status, 200);
  assert.equal(b.body.created, false);
  assert.equal(b.body.task.id, a.body.task.id);
  const hits = (await list('?status=all')).body.tasks.filter(t => t.importId === 'mstodo:abc');
  assert.equal(hits.length, 1);
});

test('dedupe skips an open task with the same title', async () => {
  const a = await post({ title: 'Call the dentist' });
  const b = await post({ title: '  call THE   dentist ', dedupe: true });
  assert.equal(b.status, 200);
  assert.equal(b.body.duplicate, true);
  assert.equal(b.body.created, false);
  assert.equal(b.body.task.id, a.body.task.id);
  assert.ok(logs.some(l => l.includes('"task.skip"') && l.includes('"duplicate"')));
  // without dedupe the same title is created again
  assert.equal((await post({ title: 'Call the dentist' })).status, 201);
  // a done task doesn't block a new one
  await patch(a.body.task.id, { done: true });
  const c = await post({ title: 'Renew passport' });
  await patch(c.body.task.id, { done: true });
  assert.equal((await post({ title: 'Renew passport', dedupe: true })).status, 201);
});

test('GET lists tasks by status, due date first then oldest', async () => {
  const late = (await post({ title: 'sort-late', dueDate: '2030-01-05' })).body.task;
  const early = (await post({ title: 'sort-early', dueDate: '2030-01-01' })).body.task;
  const undated = (await post({ title: 'sort-undated' })).body.task;
  const open = (await list()).body.tasks;
  const pos = id => open.findIndex(t => t.id === id);
  assert.ok(pos(early.id) < pos(late.id));
  assert.ok(pos(late.id) < pos(undated.id));
  assert.ok(open.every(t => !t.done));
  assert.ok(open.every(t => t.listId && t.listTitle));

  await patch(early.id, { done: true });
  const done = (await list('?status=done')).body.tasks;
  assert.ok(done.some(t => t.id === early.id));
  assert.ok(done.every(t => t.done));
  const all = (await list('?status=all')).body.tasks;
  assert.ok(all.some(t => t.id === early.id) && all.some(t => t.id === undated.id));
  assert.equal((await list('?status=nope')).status, 400);
});

test('GET skips the canvas editor’s blank placeholder rows', async () => {
  const canvasId = (await plain('/api/root')).rootCanvasId;
  await fetch(base + '/api/item', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      canvasId,
      type: 'todo',
      data: {
        tasks: [
          { id: 'blank1', text: '', done: false },
          { id: 'real1', text: 'From canvas', done: false },
        ],
      },
    }),
  });
  const open = (await list()).body.tasks;
  assert.ok(!open.some(t => t.id === 'blank1'));
  const fromCanvas = open.find(t => t.id === 'real1');
  assert.equal(fromCanvas.listTitle, 'To-do');
});

test('PATCH marks done, pins and edits fields', async () => {
  const t = (await post({ title: 'Patch me', tags: ['a'] })).body.task;
  let r = await patch(t.id, { done: true, pinned: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.task.done, true);
  assert.equal(r.body.task.pinned, true);
  assert.equal(r.body.task.text, 'Patch me');
  r = await patch(t.id, {
    title: 'Patched',
    notes: 'more',
    tags: ['b'],
    dueDate: '2027-01-01',
    priority: 'high',
    done: false,
  });
  assert.equal(r.body.task.text, 'Patched');
  assert.equal(r.body.task.note, 'more');
  assert.deepEqual(r.body.task.tags, ['b']);
  assert.equal(r.body.task.due, '2027-01-01');
  assert.equal(r.body.task.starred, true);
  assert.equal(r.body.task.done, false);
  assert.ok(logs.some(l => l.includes('"task.update"')));

  const { lists } = await plain('/api/todos');
  const stored = lists.flatMap(l => l.tasks).find(x => x.id === t.id);
  assert.equal(stored.text, 'Patched');
  assert.equal(stored.source, 'api');

  assert.equal((await patch('t_missing', { done: true })).status, 404);
  assert.equal((await patch(t.id, {})).status, 400);
  assert.equal((await patch(t.id, { done: 'yes' })).status, 400);
  assert.equal((await patch(t.id, { title: '' })).status, 400);
});

test('M3.1 PATCH listId moves a task to another list and records the move', async () => {
  const canvasId = (await plain('/api/root')).rootCanvasId;
  const item = b =>
    fetch(base + '/api/item', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(b),
    }).then(r => r.json());
  const dest = await item({ canvasId, type: 'todo', data: { title: 'Errands', tasks: [] } });
  const t = (await post({ title: 'Post the parcel' })).body.task;
  const from = t.listId;
  const stale = (await plain('/api/todos')).lists.find(l => l.id === from).tasks;

  const r = await patch(t.id, { listId: dest.id, movedBy: 'ranker', moveReason: 'an errand', starred: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.task.listId, dest.id);
  assert.equal(r.body.task.listTitle, 'Errands');
  assert.equal(r.body.task.movedFrom, from);
  assert.equal(r.body.task.movedBy, 'ranker');
  assert.equal(r.body.task.moveReason, 'an errand');
  assert.ok(Date.now() - r.body.task.movedAt < 5000);
  assert.equal(r.body.task.starred, true); // other fields patch in the same call
  const lists = (await plain('/api/todos')).lists;
  assert.ok(!lists.find(l => l.id === from).tasks.some(x => x.id === t.id), 'gone from the old list');
  assert.deepEqual(
    lists.find(l => l.id === dest.id).tasks.map(x => x.id),
    [t.id]
  );
  assert.ok(logs.some(l => l.includes('"task.move"')));

  // a client saving its stale copy of the old list doesn't bring the task back there
  const saved = await fetch(base + '/api/item/' + from, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { tasks: stale }, baseTasks: stale }),
  }).then(r => r.json());
  assert.ok(!saved.data.tasks.some(x => x.id === t.id));

  // moving back defaults movedBy to "api"; the same list is a no-op that keeps the record
  const back = (await patch(t.id, { listId: from })).body.task;
  assert.equal(back.movedFrom, dest.id);
  assert.equal(back.movedBy, 'api');
  assert.equal(back.moveReason, null);
  const same = await patch(t.id, { listId: from, movedBy: 'owner' });
  assert.equal(same.status, 200);
  assert.equal(same.body.task.movedBy, 'api');

  // the target must be a live to-do list outside Templates
  const tpl = await item({ canvasId, type: 'board', data: { title: 'Templates' } });
  const inner = await item({ canvasId: tpl.data.childCanvasId, type: 'board', data: { title: 'Trip' } });
  const tplList = await item({ canvasId: inner.data.childCanvasId, type: 'todo', data: { title: 'Pack', tasks: [] } });
  const note = await item({ canvasId, type: 'note', data: { title: 'not a list' } });
  for (const listId of [tplList.id, note.id, 'i_missing', 42]) {
    assert.equal((await patch(t.id, { listId })).status, 400, String(listId));
  }
  assert.equal((await patch(t.id, { listId: dest.id, moveReason: 7 })).status, 400);
  assert.equal((await patch(t.id, { listId: dest.id, movedBy: '' })).status, 200); // blank = "api", like source
  const longBy = await patch(t.id, { listId: from, movedBy: 'x'.repeat(41) });
  assert.equal(longBy.status, 400);
  assert.match(longBy.body.error, /^movedBy /);
  assert.equal((await patch('t_missing', { listId: dest.id })).status, 404);
});

test('M3.2 GET /api/tasks/lists?label= lists the live labelled lists outside Templates', async () => {
  const canvasId = (await plain('/api/root')).rootCanvasId;
  const item = b =>
    fetch(base + '/api/item', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(b),
    }).then(r => r.json());
  const board = await item({ canvasId, type: 'board', data: { title: 'Garden' } });
  const filing = await item({
    canvasId: board.data.childCanvasId,
    type: 'todo',
    data: { title: 'Seeds', labels: [' filing '], tasks: [] },
  });
  await item({ canvasId, type: 'todo', data: { title: 'Not filing', labels: ['Reference'], tasks: [] } });
  const gone = await item({ canvasId, type: 'todo', data: { title: 'Trashed', labels: ['Filing'], tasks: [] } });
  await fetch(base + '/api/item/' + gone.id, { method: 'DELETE' });
  const tpl = await item({ canvasId, type: 'board', data: { title: 'Templates' } });
  await item({ canvasId: tpl.data.childCanvasId, type: 'todo', data: { title: 'Tpl', labels: ['Filing'], tasks: [] } });
  await item({ canvasId, type: 'note', data: { title: 'A note', labels: ['Filing'] } });

  const r = await call('GET', '/api/tasks/lists?label=Filing');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.lists, [{ id: filing.id, title: 'Seeds', boardTitle: 'Garden' }]);
  assert.equal((await call('GET', '/api/tasks/lists')).status, 400);
  assert.equal((await call('GET', '/api/tasks/lists?label=Filing', undefined, null)).status, 401);
});

test('a client edit from a stale copy keeps tasks the API added', async () => {
  const t = (await post({ title: 'Merge base' })).body.task;
  const cardRow = (await plain('/api/todos')).lists.find(l => l.id === t.listId);
  const baseTasks = cardRow.tasks;
  // the API adds a task after the client loaded the list
  const added = (await post({ title: 'Added by API' })).body.task;
  // the client ticks its copy of the first task and saves with its stale base
  const mine = baseTasks.map(x => (x.id === t.id ? Object.assign({}, x, { done: true }) : x));
  const saved = await fetch(base + '/api/item/' + t.listId, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { tasks: mine }, baseTasks }),
  }).then(r => r.json());
  const ids = saved.data.tasks.map(x => x.id);
  assert.ok(ids.includes(added.id));
  const kept = saved.data.tasks.find(x => x.id === t.id);
  assert.equal(kept.done, true);
  assert.equal(kept.source, 'api');
});

test('a client edit from a stale copy keeps the nightly ranking written since', async () => {
  const t = (await post({ title: 'Rank base' })).body.task;
  const baseTasks = (await plain('/api/todos')).lists.find(l => l.id === t.listId).tasks;
  const ranked = await call('PUT', '/api/tasks/rank', {
    ranks: [{ id: t.id, rankScore: 77, rankReason: 'Matters', rankNudge: 1 }],
  });
  assert.deepEqual(ranked.body, { ranked: 1, skipped: [], moved: 0, movesSkipped: [] });
  // the client still has the copy from before the ranking (rankScore: null) and renames the task
  const mine = baseTasks.map(x => (x.id === t.id ? Object.assign({}, x, { text: 'Renamed' }) : x));
  const saved = await fetch(base + '/api/item/' + t.listId, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { tasks: mine }, baseTasks }),
  }).then(r => r.json());
  const kept = saved.data.tasks.find(x => x.id === t.id);
  assert.deepEqual([kept.text, kept.rankScore, kept.rankReason, kept.rankNudge], ['Renamed', 77, 'Matters', 1]);
  assert.equal(typeof kept.rankedAt, 'number');
});

test('view=digest: the focus three plus overdue and due today, at most 8 lines', async () => {
  const digest = async () => (await list('?view=digest')).body;
  const three = (await list('?view=focus&limit=3')).body.tasks.map(t => t.id);
  const before = await digest();
  assert.deepEqual(
    before.tasks.slice(0, 3).map(t => t.id),
    three
  );
  assert.ok(before.tasks.slice(3).every(t => t.tier === 'overdue' || t.tier === 'today'));

  const root = (await plain('/api/root')).rootCanvasId;
  const item = async (canvasId, type, data) =>
    (
      await fetch(base + '/api/item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ canvasId, type, data }),
      })
    ).json();
  const task = (id, due, f = {}) => ({ id, text: id, done: false, createdAt: 1, due, ...f });
  // Nine tasks more overdue than anything else here; decoys more overdue still, all left out.
  const late = Array.from({ length: 9 }, (_, i) => task(`dg-${i + 1}`, `2000-01-0${i + 1}`));
  await item(root, 'todo', {
    title: 'Late',
    tasks: [...late, task('dg-stale', '1999-01-01', { stale: true }), task('dg-done', '1999-01-01', { done: true })],
  });
  await item(root, 'todo', { title: 'Ref', labels: ['Reference'], tasks: [task('dg-ref', '1999-01-01')] });
  const tpl = await item(root, 'board', { title: 'Templates' });
  await item(tpl.data.childCanvasId, 'todo', { title: 'Tpl', tasks: [task('dg-tpl', '1999-01-01')] });

  const d = await digest();
  assert.deepEqual(
    d.tasks.map(t => t.id),
    late.slice(0, 8).map(t => t.id)
  );
  assert.ok(d.more >= 1); // dg-9 and any other overdue task
  const first = d.tasks[0];
  assert.deepEqual([first.text, first.listTitle, first.due, first.tier], ['dg-1', 'Late', '2000-01-01', 'overdue']);

  // the Done button: PATCH done, and the next one moves up
  assert.equal((await patch('dg-1', { done: true })).status, 200);
  assert.equal((await digest()).tasks.at(-1).id, 'dg-9');
  assert.equal((await call('GET', '/api/tasks?view=digest', undefined, null)).status, 401);
});
