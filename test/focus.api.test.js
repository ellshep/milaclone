'use strict';

// Next phases M2.1: the focus order (focus.js) and its two read routes,
// GET /api/focus (board) and GET /api/tasks?view=focus (task API, token).
// Runs against a throwaway DATA_DIR.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-test-'));
process.env.DATA_DIR = TMP;
process.env.TASK_TZ = 'America/Chicago';
const TOKEN = 'focus-token-0123456789';
process.env.TASK_API_TOKEN = TOKEN;

const express = require('express');
const app = express();
app.use(require('../routes'));
const { orderTasks, parseLimit, dayOf } = require('../focus');

let base;
let server;
test.before(async () => {
  await new Promise(r => {
    server = app.listen(0, '127.0.0.1', r);
  });
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => {
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const TODAY = '2026-11-20';
const card = { id: 'i_l', data: { title: 'L' } };
const t = (id, f = {}) => ({ task: Object.assign({ id, text: id, status: 'open', createdAt: 0 }, f), card });
const ids = r => r.tasks.map(x => x.id);

test('orderTasks: due now, then yours, then everything else, then sent to bottom (R8, R9)', () => {
  const top = order => ({ place: { band: 'top', order } });
  const bottom = order => ({ place: { band: 'bottom', order } });
  const r = orderTasks(
    [
      t('rest-old', { createdAt: 1 }),
      t('rest-new', { createdAt: 9 }),
      t('starred', { starred: true }),
      t('soon-1', { due: '2026-11-21' }),
      t('later', { due: '2026-11-30', createdAt: 5 }),
      t('low', { rank: { score: 10, reason: 'Can wait', at: 1 }, due: '2026-11-21' }),
      t('high', { rank: { score: 90, reason: 'Matters', at: 1 } }),
      t('tie-undated', { rank: { score: 50 }, starred: true }),
      t('tie-dated', { rank: { score: 50 }, due: '2026-11-25' }),
      t('bottom-2', { ...bottom(2), starred: true, rank: { score: 99 } }),
      t('bottom-1', bottom(1)),
      t('bottom-late', { ...bottom(1), due: '2026-11-18' }),
      t('top-2', top(2)),
      t('top-1', { ...top(1), due: '2026-11-21' }),
      t('top-today', { ...top(1), due: TODAY, createdAt: 2 }),
      t('today', { due: TODAY }),
      t('over-1', { due: '2026-11-19' }),
      t('over-5', { due: '2026-11-15' }),
      t('odd-place', { place: { band: 'middle', order: 1 }, createdAt: 3 }),
      t('done', { status: 'done' }),
      t('stale', { status: 'stale' }),
      t('blank', { text: '  ' }),
    ],
    TODAY
  );
  assert.deepEqual(ids(r), [
    'over-5',
    'bottom-late',
    'over-1',
    'today',
    'top-today',
    'top-1',
    'top-2',
    'high',
    'tie-dated',
    'tie-undated',
    'low',
    'soon-1',
    'later',
    'starred',
    'rest-old',
    'odd-place',
    'rest-new',
    'bottom-1',
    'bottom-2',
  ]);
  assert.deepEqual([...new Set(r.tasks.map(x => x.tier))], ['overdue', 'today', 'top', 'rest', 'bottom']);
  assert.deepEqual(r.counts, { overdue: 3, dueToday: 2, open: 19 });
  const over = r.tasks[0];
  assert.equal(over.tier, 'overdue');
  assert.equal(over.dueIn, -5);
  assert.equal(over.listId, 'i_l');
  assert.equal(over.listTitle, 'L');
  assert.equal(over.place, null);
  assert.deepEqual(r.tasks.find(x => x.id === 'top-2').place, { band: 'top', order: 2 });
  assert.equal(r.tasks.find(x => x.id === 'odd-place').place, null);
  assert.equal(r.tasks.find(x => x.id === 'later').dueIn, 10);
  assert.equal(r.tasks.find(x => x.id === 'rest-old').dueIn, null);
});

test('orderTasks band boundaries: placed below due today and above a high score; bottom below unscored', () => {
  const r = orderTasks(
    [
      t('scored', { rank: { score: 100, reason: 'Top of the model', at: 1 } }),
      t('bottom', { place: { band: 'bottom', order: 1 }, starred: true, due: '2026-11-21' }),
      t('unscored', { createdAt: 99 }),
      t('placed', { place: { band: 'top', order: 5 } }),
      t('due-today', { due: TODAY }),
    ],
    TODAY
  );
  assert.deepEqual(ids(r), ['due-today', 'placed', 'scored', 'unscored', 'bottom']);
});

test('parseLimit', () => {
  assert.equal(parseLimit(undefined), 3);
  assert.equal(parseLimit(''), 3);
  assert.equal(parseLimit('10'), 10);
  assert.equal(parseLimit('all'), 1000);
  for (const bad of ['0', '1001', '-1', '2.5', 'x']) assert.equal(parseLimit(bad), null, bad);
});

// ---- Through the routes -------------------------------------------------------

const json = async (method, p, body, token) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const opts = { method, headers };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(base + p, opts);
  return { status: r.status, body: await r.json() };
};
const shift = n => {
  const d = new Date(Date.now() + n * 86400000);
  return dayOf(d, 'America/Chicago');
};
async function todo(canvasId, title, tasks, extra = {}) {
  const r = await json('POST', '/api/item', {
    canvasId,
    type: 'todo',
    x: 0,
    y: 0,
    data: Object.assign({ title, tasks }, extra),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

test('GET /api/focus and view=focus share one order; Reference lists and Templates are left out', async () => {
  const { rootCanvasId } = (await json('GET', '/api/root')).body;
  const mk = (id, f = {}) => Object.assign({ id, text: id, status: 'open', createdAt: 1 }, f);
  await todo(rootCanvasId, 'Work', [mk('w-over', { due: shift(-2) }), mk('w-rest'), mk('w-star', { starred: true })]);
  await todo(rootCanvasId, 'Goals', [mk('g-over', { due: shift(-9) })], { labels: ['reference'] });
  const tpl = (await json('POST', '/api/item', { canvasId: rootCanvasId, type: 'board', data: { title: 'Templates' } }))
    .body;
  const inner = (
    await json('POST', '/api/item', { canvasId: tpl.data.childCanvasId, type: 'board', data: { title: 'Trip' } })
  ).body;
  await todo(inner.data.childCanvasId, 'Packing', [mk('tpl-today', { due: shift(0) })]);

  const board = (await json('GET', '/api/focus')).body;
  assert.equal(board.today, shift(0));
  assert.deepEqual(
    board.tasks.map(x => x.id),
    ['w-over', 'w-star', 'w-rest']
  );
  assert.deepEqual(board.counts, { overdue: 1, dueToday: 0, open: 3 });
  assert.deepEqual([board.tasks[0].listTitle, board.tasks[0].boardTitle], ['Work', 'Home']);

  const viaApi = await json('GET', '/api/tasks?view=focus&limit=2', undefined, TOKEN);
  assert.equal(viaApi.status, 200);
  assert.deepEqual(
    viaApi.body.tasks.map(x => x.id),
    ['w-over', 'w-star']
  );
  assert.deepEqual(viaApi.body.counts, board.counts);
  assert.equal((await json('GET', '/api/focus?limit=all')).body.tasks.length, 3);
});

test('limit and view validation; the task API view needs the token', async () => {
  assert.equal((await json('GET', '/api/focus?limit=0')).status, 400);
  assert.equal((await json('GET', '/api/tasks?view=focus&limit=x', undefined, TOKEN)).status, 400);
  const badView = await json('GET', '/api/tasks?view=other', undefined, TOKEN);
  assert.equal(badView.status, 400);
  assert.match(badView.body.error, /view must be focus/);
  assert.equal((await json('GET', '/api/tasks?view=focus')).status, 401);
});

test('POST /api/focus/:taskId/done marks the task done once', async () => {
  const { rootCanvasId } = (await json('GET', '/api/root')).body;
  const list = await todo(rootCanvasId, 'Done list', [{ id: 'd-1', text: 'Finish me', status: 'open', createdAt: 1 }]);
  assert.deepEqual((await json('POST', '/api/focus/d-1/done')).body, { ok: true });
  const card = (await json('GET', '/api/canvas/' + rootCanvasId)).body.items.find(it => it.id === list.id);
  assert.equal(card.data.tasks[0].status, 'done');
  assert.ok(Math.abs(card.data.tasks[0].statusAt - Date.now()) < 5000, 'stamped with the server clock');
  assert.equal((await json('POST', '/api/focus/d-1/done')).status, 404); // already done
  assert.equal((await json('POST', '/api/focus/nope/done')).status, 404);
});

test('PUT /api/focus/order places tasks in both bands across lists, and empty bands reset', async () => {
  const { rootCanvasId } = (await json('GET', '/api/root')).body;
  const mk = (id, f = {}) => Object.assign({ id, text: id, status: 'open', createdAt: 1 }, f);
  const a = await todo(rootCanvasId, 'Place A', [mk('p-a1'), mk('p-a2')]);
  await todo(rootCanvasId, 'Place B', [mk('p-b1'), mk('p-b2')]);
  assert.equal((await json('PUT', '/api/focus/order', { top: ['p-a2'], bottom: [] })).status, 200);

  const r = await json('PUT', '/api/focus/order', { top: ['p-b1', 'p-a1'], bottom: ['p-b2'] });
  assert.equal(r.status, 200);
  const placed = r.body.tasks.filter(t => t.place).map(t => [t.id, t.tier, t.place.order]);
  assert.deepEqual(placed, [
    ['p-b1', 'top', 1],
    ['p-a1', 'top', 2],
    ['p-b2', 'bottom', 1],
  ]);
  assert.equal(r.body.tasks.at(-1).id, 'p-b2', 'sent to the bottom of everything');
  // a task left out loses its old placement
  const cardA = (await json('GET', '/api/canvas/' + rootCanvasId)).body.items.find(it => it.id === a.id);
  assert.equal('place' in cardA.data.tasks[1], false);

  const reset = await json('PUT', '/api/focus/order', { top: [], bottom: [] });
  assert.equal(
    reset.body.tasks.some(t => t.place),
    false
  );

  for (const body of [
    { ids: ['p-a1'] },
    { top: ['p-a1'] },
    { top: 'p-a1', bottom: [] },
    { top: ['p-a1', 'p-a1'], bottom: [] },
    { top: ['p-a1'], bottom: ['p-a1'] },
    { top: [''], bottom: [] },
    { top: [3], bottom: [] },
  ]) {
    assert.equal((await json('PUT', '/api/focus/order', body)).status, 400, JSON.stringify(body));
  }
});

test('PUT /api/tasks/rank writes rank in one go, skips placed tasks and never changes place', async () => {
  const { rootCanvasId } = (await json('GET', '/api/root')).body;
  const mk = (id, f = {}) => Object.assign({ id, text: id, status: 'open', createdAt: 1 }, f);
  const old = { score: 5, reason: 'Old' };
  const top = { band: 'top', order: 1 };
  const bottom = { band: 'bottom', order: 1 };
  const list = await todo(rootCanvasId, 'Rank me', [mk('r-a'), mk('r-b'), mk('r-top'), mk('r-bottom')]);
  const put = body => json('PUT', '/api/tasks/rank', body, TOKEN);
  const first = await put({ ranks: ['r-b', 'r-top'].map(id => ({ id, score: old.score, reason: old.reason })) });
  assert.equal(first.status, 200);
  await json('PUT', '/api/focus/order', { top: ['r-top'], bottom: ['r-bottom'] });
  const before = Date.now();
  const r = await put({
    ranks: [
      { id: 'r-a', score: 80, reason: 'Unblocks the rest' },
      { id: 'r-top', score: 99, reason: 'no' },
      { id: 'r-bottom', score: 99, reason: 'no' },
      { id: 'gone', score: 1 },
    ],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ranked: 1, skipped: ['r-top', 'r-bottom', 'gone'], moved: 0, movesSkipped: [] });
  const tasks = (await json('GET', '/api/canvas/' + rootCanvasId)).body.items.find(it => it.id === list.id).data.tasks;
  const [a, b, placedTop, placedBottom] = tasks;
  assert.deepEqual([a.rank.score, a.rank.reason], [80, 'Unblocks the rest']);
  assert.ok(a.rank.at >= before && a.rank.at <= Date.now(), 'stamped with the server clock');
  assert.equal('place' in a, false, 'ranking never places a task');
  assert.deepEqual([b.rank.score, b.rank.reason], [old.score, old.reason]); // not listed: kept
  assert.deepEqual([placedTop.place, placedTop.rank], [top, b.rank]);
  assert.deepEqual([placedBottom.place, 'rank' in placedBottom], [bottom, false]);

  for (const ranks of [
    undefined,
    [{}],
    [{ id: 'r-a' }], // no score: a client on the old field names
    [{ id: 'r-a', rankScore: 50 }],
    [{ id: 'r-a', score: 'x' }],
    [{ id: 'r-a', score: 1, reason: 'x'.repeat(301) }],
    [
      { id: 'r-a', score: 1 },
      { id: 'r-a', score: 2 },
    ],
  ]) {
    assert.equal((await put({ ranks })).status, 400, JSON.stringify(ranks));
  }
  assert.equal((await json('PUT', '/api/tasks/rank', { ranks: [] })).status, 401);
});

test('board writes never set place or rank: the stored ones stay, new tasks get none', async () => {
  const { rootCanvasId } = (await json('GET', '/api/root')).body;
  const forged = { place: { band: 'top', order: 1 }, rank: { score: 100, reason: 'Me first', at: 1 } };
  const mk = (id, f = {}) => Object.assign({ id, text: id, status: 'open', createdAt: 1 }, f);
  const list = await todo(rootCanvasId, 'Forge', [
    mk('k-a', forged),
    mk('k-b'),
    mk('k-c', { focusOrder: 1, rankScore: 9 }),
  ]);
  assert.deepEqual(
    list.data.tasks.map(t => ['place', 'rank', 'focusOrder', 'rankScore'].filter(k => k in t)),
    [[], [], []],
    'a new card keeps no place or rank, old or new field names'
  );
  await json('PUT', '/api/tasks/rank', { ranks: [{ id: 'k-b', score: 3, reason: 'Real' }] }, TOKEN);
  await json('PUT', '/api/focus/order', { top: ['k-b'], bottom: [] }); // after: placed tasks aren't ranked
  const stored = (await json('GET', '/api/canvas/' + rootCanvasId)).body.items.find(it => it.id === list.id).data.tasks;
  // a client sends forged values on k-a, clears k-b's, and adds a task with its own
  const mine = [{ ...stored[0], ...forged }, { ...stored[1], place: null, rank: null }, stored[2], mk('k-d', forged)];
  const r = await json('PATCH', '/api/item/' + list.id, { data: { tasks: mine } });
  assert.equal(r.status, 200);
  const [ka, kb, , kd] = r.body.data.tasks;
  assert.equal('place' in ka || 'rank' in ka, false);
  assert.deepEqual(kb.place, { band: 'top', order: 1 });
  assert.deepEqual([kb.rank.score, kb.rank.reason], [3, 'Real']);
  assert.equal('place' in kd || 'rank' in kd, false);
  await json('PUT', '/api/focus/order', { top: [], bottom: [] });
});

test('GET /api/tasks/priorities returns the Home note headed "Focus priorities"', async () => {
  const get = () => json('GET', '/api/tasks/priorities', undefined, TOKEN);
  assert.deepEqual((await get()).body, { text: null });
  const { rootCanvasId } = (await json('GET', '/api/root')).body;
  const note = text => json('POST', '/api/item', { canvasId: rootCanvasId, type: 'note', x: 0, y: 0, data: { text } });
  await note('Shopping\nfocus priorities');
  const trashed = (await note('Focus priorities\nold')).body;
  await json('DELETE', '/api/item/' + trashed.id);
  await note('Focus priorities:\nHealth first');
  await note('focus priorities\nnewer one');
  assert.deepEqual((await get()).body, { text: 'Focus priorities:\nHealth first' });
  assert.equal((await json('GET', '/api/tasks/priorities')).status, 401);
});

test('view=digest stops at the three when the rest are neither overdue nor due today', async () => {
  const { rootCanvasId } = (await json('GET', '/api/root')).body;
  const mk = (id, f = {}) => Object.assign({ id, text: id, status: 'open', createdAt: 1 }, f);
  await todo(rootCanvasId, 'Digest mix', [mk('n-over', { due: shift(-30) }), mk('n-p1'), mk('n-p2'), mk('n-p3')]);
  await json('PUT', '/api/focus/order', { top: ['n-p1', 'n-p2', 'n-p3'], bottom: [] });
  const focus = (await json('GET', '/api/tasks?view=focus&limit=5', undefined, TOKEN)).body.tasks;
  const digest = (await json('GET', '/api/tasks?view=digest', undefined, TOKEN)).body;
  // n-over and w-over, then the first placed task; later placed tasks are left out
  assert.deepEqual(
    focus.map(t => t.tier),
    ['overdue', 'overdue', 'top', 'top', 'top']
  );
  assert.deepEqual(digest, { tasks: focus.slice(0, 3), more: 0 });
  await json('PUT', '/api/focus/order', { top: [], bottom: [] });
});

test('M3.3 nightly filing: the focus view marks Inbox tasks, and PUT /api/tasks/rank moves them', async () => {
  const { rootCanvasId } = (await json('GET', '/api/root')).body;
  const add = title => json('POST', '/api/tasks', { title }, TOKEN);
  const a = (await add('Buy seeds')).body.task;
  const b = (await add('Sharpen the shears')).body.task;
  const inboxId = a.listId;
  const errands = await todo(rootCanvasId, 'Garden jobs', [], { labels: ['Filing'] });

  // the focus view marks Inbox rows, so the ranker knows what it may file
  const view = (await json('GET', '/api/focus?limit=all')).body.tasks;
  assert.equal(view.find(x => x.id === a.id).inbox, true);
  assert.equal(
    view.some(x => x.listId === errands.id && x.inbox),
    false
  );

  const put = body => json('PUT', '/api/tasks/rank', body, TOKEN);
  const r = await put({
    ranks: [{ id: a.id, score: 50, reason: 'Spring' }],
    moves: [
      { id: a.id, listId: errands.id, reason: 'Garden shopping' },
      { id: 't_missing', listId: errands.id, reason: 'x' },
    ],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    ranked: 1,
    skipped: [],
    moved: 1,
    movesSkipped: [{ id: 't_missing', reason: 'no list has it any more' }],
  });
  const filed = (await json('GET', '/api/focus?limit=all')).body.tasks.find(x => x.id === a.id);
  assert.equal(filed.listId, errands.id);
  assert.deepEqual(
    [filed.movedFrom, filed.movedBy, filed.moveReason, filed.rank.score],
    [inboxId, 'ranker', 'Garden shopping', 50]
  );

  // a bad target refuses the whole write: no score, no move
  const before = (await json('GET', '/api/focus?limit=all')).body.tasks.find(x => x.id === b.id);
  const refused = await put({
    ranks: [{ id: b.id, score: 99, reason: 'x' }],
    moves: [{ id: b.id, listId: 'i_nope', reason: 'x' }],
  });
  assert.equal(refused.status, 400);
  const after = (await json('GET', '/api/focus?limit=all')).body.tasks.find(x => x.id === b.id);
  assert.deepEqual([after.listId, after.rank], [before.listId, before.rank]);
  for (const moves of ['x', [{ id: b.id }], [{ id: b.id, listId: errands.id, reason: 'r'.repeat(501) }]]) {
    assert.equal((await put({ ranks: [], moves })).status, 400, JSON.stringify(moves));
  }

  // planned on a stale read: the task left the Inbox, or was sent back to it, since
  const other = await todo(rootCanvasId, 'Elsewhere', []);
  await json('PATCH', '/api/tasks/' + b.id, { listId: other.id }, TOKEN);
  const fileA = { id: a.id, listId: errands.id, reason: 'x' };
  await json('PATCH', '/api/tasks/' + a.id, { listId: inboxId }, TOKEN); // the owner sends a back
  const stale = await put({ ranks: [], moves: [{ id: b.id, listId: errands.id, reason: 'x' }, fileA] });
  assert.deepEqual(stale.body.movesSkipped, [
    { id: b.id, reason: 'it left the Inbox before the move' },
    { id: a.id, reason: 'it was moved back by api' },
  ]);
  assert.equal(stale.body.moved, 0);
  const now = (await json('GET', '/api/focus?limit=all')).body.tasks;
  assert.deepEqual([now.find(x => x.id === a.id).listId, now.find(x => x.id === b.id).listId], [inboxId, other.id]);
});
