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
const t = (id, f = {}) => ({ task: Object.assign({ id, text: id, done: false, createdAt: 0 }, f), card });
const ids = r => r.tasks.map(x => x.id);

test('orderTasks: fixed date tiers, then placed, then soon → starred → rest', () => {
  const r = orderTasks(
    [
      t('rest-old', { createdAt: 1 }),
      t('rest-new', { createdAt: 9 }),
      t('starred', { starred: true }),
      t('soon-3', { due: '2026-11-23' }),
      t('soon-1', { due: '2026-11-21' }),
      t('later', { due: '2026-11-30', createdAt: 5 }),
      t('today', { due: TODAY }),
      t('over-1', { due: '2026-11-19' }),
      t('over-5', { due: '2026-11-15' }),
      t('placed-2', { focusOrder: 2 }),
      t('placed-1', { focusOrder: 1, due: '2026-11-21' }),
      t('done', { done: true }),
      t('stale', { stale: true }),
      t('blank', { text: '  ' }),
    ],
    TODAY
  );
  assert.deepEqual(ids(r), [
    'over-5',
    'over-1',
    'today',
    'placed-1',
    'placed-2',
    'soon-1',
    'soon-3',
    'starred',
    'rest-old',
    'later',
    'rest-new',
  ]);
  assert.deepEqual(r.counts, { overdue: 2, dueToday: 1, open: 11 });
  const over = r.tasks[0];
  assert.equal(over.tier, 'overdue');
  assert.equal(over.dueIn, -5);
  assert.equal(over.listId, 'i_l');
  assert.equal(over.listTitle, 'L');
  assert.equal(r.tasks.find(x => x.id === 'later').dueIn, 10);
  assert.equal(r.tasks.find(x => x.id === 'rest-old').dueIn, null);
});

test('orderTasks: rankScore within a tier, and nudges move one tier at most', () => {
  const r = orderTasks(
    [
      t('low', { rankScore: 10 }),
      t('none'),
      t('high', { rankScore: 90 }),
      t('up', { rankScore: 1, rankNudge: 1 }),
      t('up-twice', { rankNudge: 5 }),
      t('starred-down', { starred: true, rankNudge: -1 }),
      t('soon-down', { due: '2026-11-22', rankNudge: -1 }),
      t('today-down', { due: TODAY, rankNudge: -1 }),
      t('placed-nudged', { focusOrder: 0, rankNudge: -1 }),
    ],
    TODAY
  );
  assert.deepEqual(ids(r), [
    'today-down',
    'placed-nudged',
    'up',
    'up-twice',
    'soon-down',
    'high',
    'low',
    'none',
    'starred-down',
  ]);
  assert.deepEqual(
    r.tasks.map(x => x.tier),
    ['today', 'placed', 'starred', 'starred', 'starred', 'rest', 'rest', 'rest', 'rest']
  );
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
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
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
  const mk = (id, f = {}) => Object.assign({ id, text: id, done: false, createdAt: 1 }, f);
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
