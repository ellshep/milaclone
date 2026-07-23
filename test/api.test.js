'use strict';

// Backend API + db integrity suite. Zero deps: node:test + global fetch.
// Runs against a throwaway DATA_DIR so it never touches real board data.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point db.js at a fresh temp dir BEFORE requiring it (it opens the DB on load).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'board-test-'));
process.env.DATA_DIR = TMP;

const express = require('express');
const app = express();
app.use(express.json());
app.use(require('../routes'));

let base;
let server;
test.before(async () => {
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => { server.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

// tiny fetch helpers
const get = (p) => fetch(base + p).then(async r => ({ status: r.status, body: await r.json() }));
const send = (m, p, b) => fetch(base + p, {
  method: m, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b)
}).then(async r => ({ status: r.status, body: await r.json() }));

async function root() { return (await get('/api/root')).body.rootCanvasId; }

test('health + root seeded', async () => {
  assert.deepEqual((await get('/api/health')).body, { ok: true });
  const id = await root();
  assert.match(id, /^c_/);
  const { body } = await get('/api/canvas/' + id);
  assert.equal(body.canvas.title, 'Home');
  assert.deepEqual(body.items, []);
  assert.equal(body.breadcrumb.length, 1);
});

test('unknown canvas 404', async () => {
  assert.equal((await get('/api/canvas/nope')).status, 404);
});

test('create item validates canvasId', async () => {
  assert.equal((await send('POST', '/api/item', { canvasId: 'nope', type: 'note' })).status, 400);
});

test('create note: rounds coords, assigns z, defaults', async () => {
  const canvasId = await root();
  const { body } = await send('POST', '/api/item', { canvasId, type: 'note', x: 10.7, y: 20.2 });
  assert.match(body.id, /^i_/);
  assert.equal(body.x, 11);
  assert.equal(body.y, 20);
  assert.equal(body.w, 240);      // default width
  assert.ok(body.z >= 1);
  // item now shows up on the canvas
  const view = (await get('/api/canvas/' + canvasId)).body;
  assert.ok(view.items.some(i => i.id === body.id));
});

test('patch item moves and updates color', async () => {
  const canvasId = await root();
  const it = (await send('POST', '/api/item', { canvasId, type: 'note' })).body;
  const upd = (await send('PATCH', '/api/item/' + it.id, { x: 5, y: 6, color: 'teal' })).body;
  assert.equal(upd.x, 5);
  assert.equal(upd.color, 'teal');
  assert.equal((await send('PATCH', '/api/item/badid', { x: 1 })).status, 404);
});

test('board item creates + syncs a child canvas', async () => {
  const canvasId = await root();
  const board = (await send('POST', '/api/item', { canvasId, type: 'board', color: 'green', data: { title: 'Sprint' } })).body;
  const childId = board.data.childCanvasId;
  assert.ok(childId, 'board owns a child canvas');

  // parent canvas surfaces child title/count/color
  const view = (await get('/api/canvas/' + canvasId)).body;
  const card = view.items.find(i => i.id === board.id);
  assert.equal(card._childTitle, 'Sprint');
  assert.equal(card._childCount, 0);
  assert.equal(card._childColor, 'green');

  // renaming/recoloring the card writes through to the child canvas
  await send('PATCH', '/api/item/' + board.id, { color: 'red', data: { title: 'Renamed' } });
  const child = (await get('/api/canvas/' + childId)).body.canvas;
  assert.equal(child.title, 'Renamed');
  assert.equal(child.color, 'red');
});

test('patch canvas clamps title, sets color', async () => {
  const canvasId = await root();
  const long = 'x'.repeat(500);
  const c = (await send('PATCH', '/api/canvas/' + canvasId, { title: long, color: 'blue' })).body;
  assert.equal(c.title.length, 200);
  assert.equal(c.color, 'blue');
});

test('bulk patch repositions many items', async () => {
  const canvasId = await root();
  const a = (await send('POST', '/api/item', { canvasId, type: 'note' })).body;
  const b = (await send('POST', '/api/item', { canvasId, type: 'note' })).body;
  await send('PATCH', '/api/items', { updates: [{ id: a.id, x: 100 }, { id: b.id, y: 200 }, { id: 'ghost', x: 9 }] });
  const view = (await get('/api/canvas/' + canvasId)).body;
  assert.equal(view.items.find(i => i.id === a.id).x, 100);
  assert.equal(view.items.find(i => i.id === b.id).y, 200);
});

test('delete cascades: column children go with the column', async () => {
  const canvasId = await root();
  const col = (await send('POST', '/api/item', { canvasId, type: 'column' })).body;
  const child = (await send('POST', '/api/item', { canvasId, type: 'note', parentItemId: col.id })).body;
  await send('DELETE', '/api/item/' + col.id);
  const ids = (await get('/api/canvas/' + canvasId)).body.items.map(i => i.id);
  assert.ok(!ids.includes(col.id));
  assert.ok(!ids.includes(child.id), 'child deleted with its column');
});

test('delete cascades: nested board subtree is removed', async () => {
  const canvasId = await root();
  const board = (await send('POST', '/api/item', { canvasId, type: 'board', data: { title: 'B' } })).body;
  const childId = board.data.childCanvasId;
  // put an item inside the nested board
  const inner = (await send('POST', '/api/item', { canvasId: childId, type: 'note' })).body;
  await send('DELETE', '/api/item/' + board.id);
  // child canvas is gone (404) and its item is unreachable
  assert.equal((await get('/api/canvas/' + childId)).status, 404);
  assert.equal((await send('PATCH', '/api/item/' + inner.id, { x: 1 })).status, 404);
});
