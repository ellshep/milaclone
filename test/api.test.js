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
const routes = require('../routes');
app.use(routes);
// mirror server.js: the generic static handler sits behind the routes
app.use(express.static(path.join(__dirname, '..', 'public'), { setHeaders: routes.setUploadHeaders }));

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

// tiny fetch helpers
const get = p => fetch(base + p).then(async r => ({ status: r.status, body: await r.json() }));
const send = (m, p, b) =>
  fetch(base + p, {
    method: m,
    headers: { 'Content-Type': 'application/json' },
    // oxlint-disable-next-line unicorn/no-invalid-fetch-options -- m is never GET
    body: JSON.stringify(b),
  }).then(async r => ({ status: r.status, body: await r.json() }));

async function root() {
  return (await get('/api/root')).body.rootCanvasId;
}

test('POST converts a plain-text note or comment to doc + text', async () => {
  const canvasId = await root();
  const note = (await send('POST', '/api/item', { canvasId, type: 'note', data: { title: 'T', body: 'b' } })).body;
  assert.equal(note.data.text, 'T\nb');
  assert.equal(note.data.doc.content[0].type, 'heading');
  assert.equal(note.data.title, undefined);
  const comment = (await send('POST', '/api/item', { canvasId, type: 'comment' })).body;
  assert.deepEqual(comment.data, { doc: { type: 'doc', content: [{ type: 'paragraph' }] }, text: '' });
  await send('DELETE', '/api/item/' + note.id);
  await send('DELETE', '/api/item/' + comment.id);
});

test("PATCH rebuilds a note body from a stale client's title/body", async () => {
  const canvasId = await root();
  const note = (await send('POST', '/api/item', { canvasId, type: 'note', data: { body: 'old' } })).body;
  const r = (await send('PATCH', '/api/item/' + note.id, { data: { body: 'from an old tab' } })).body;
  assert.equal(r.data.text, 'from an old tab');
  assert.equal(r.data.body, undefined);
  assert.equal(r.data.doc.content[0].content[0].text, 'from an old tab');
  await send('DELETE', '/api/item/' + note.id);
});

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
  assert.equal(body.w, 240); // default width
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

test('PATCH turns a note into a swatch, and no other type change', async () => {
  const canvasId = await root();
  const note = (await send('POST', '/api/item', { canvasId, type: 'note', data: { body: '#ff8800' } })).body;
  const sw = (await send('PATCH', '/api/item/' + note.id, { type: 'swatch', data: { hex: '#ff8800' } })).body;
  assert.equal(sw.type, 'swatch');
  const stored = (await get('/api/canvas/' + canvasId)).body.items.find(i => i.id === note.id);
  assert.equal(stored.type, 'swatch');
  assert.equal(stored.data.hex, '#ff8800');
  const todo = (await send('POST', '/api/item', { canvasId, type: 'todo' })).body;
  assert.equal((await send('PATCH', '/api/item/' + todo.id, { type: 'swatch' })).body.type, 'todo');
  assert.equal((await send('PATCH', '/api/item/' + sw.id, { type: 'note' })).body.type, 'swatch');
});

test('board item creates + syncs a child canvas', async () => {
  const canvasId = await root();
  const board = (
    await send('POST', '/api/item', { canvasId, type: 'board', color: 'green', data: { title: 'Sprint' } })
  ).body;
  const childId = board.data.childCanvasId;
  assert.ok(childId, 'board owns a child canvas');

  // parent canvas surfaces child title/count/color
  const view = (await get('/api/canvas/' + canvasId)).body;
  const card = view.items.find(i => i.id === board.id);
  assert.equal(card._childTitle, 'Sprint');
  assert.equal(card._childCount, 0);
  assert.equal(card._childColor, 'green');
  assert.ok(card._childIcon, 'board gets a default Lucide icon');

  // renaming/recoloring/icon the card writes through to the child canvas
  await send('PATCH', '/api/item/' + board.id, { color: 'red', data: { title: 'Renamed', icon: 'heart' } });
  const child = (await get('/api/canvas/' + childId)).body.canvas;
  assert.equal(child.title, 'Renamed');
  assert.equal(child.color, 'red');
  assert.equal(child.icon, 'heart');
  const view2 = (await get('/api/canvas/' + canvasId)).body;
  assert.equal(view2.items.find(i => i.id === board.id)._childIcon, 'heart');
});

test('create comment and file items', async () => {
  const canvasId = await root();
  const comment = (await send('POST', '/api/item', { canvasId, type: 'comment', data: { body: 'hi' } })).body;
  assert.equal(comment.type, 'comment');
  assert.equal(comment.data.text, 'hi');
  const file = (
    await send('POST', '/api/item', {
      canvasId,
      type: 'file',
      data: { src: '/uploads/x.pdf', name: 'x.pdf', mime: 'application/pdf' },
    })
  ).body;
  assert.equal(file.type, 'file');
  assert.equal(file.data.name, 'x.pdf');
});

test('upload accepts pdf', async () => {
  const canvasId = await root();
  void canvasId;
  const fd = new FormData();
  fd.append('file', new Blob(['%PDF-1.4'], { type: 'application/pdf' }), 'doc.pdf');
  const r = await fetch(base + '/api/upload', { method: 'POST', body: fd });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.match(body.src, /^\/uploads\//);
  assert.equal(body.name, 'doc.pdf');
  assert.equal(body.mime, 'application/pdf');
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
  await send('PATCH', '/api/items', {
    updates: [
      { id: a.id, x: 100 },
      { id: b.id, y: 200 },
      { id: 'ghost', x: 9 },
    ],
  });
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

test('quick notes: lists every todo card with its canvas + tasks', async () => {
  const canvasId = await root();
  const board = (await send('POST', '/api/item', { canvasId, type: 'board', data: { title: 'Nested' } })).body;
  const nested = board.data.childCanvasId;
  const tasks = [
    { id: 't1', text: 'Floss', done: false, starred: true, due: '2026-08-07', tags: ['routine'], note: 'nightly' },
  ];
  const a = (
    await send('POST', '/api/item', {
      canvasId,
      type: 'todo',
      color: 'blue',
      data: { title: 'Nightly Routine', tags: ['routine'], tasks },
    })
  ).body;
  const b = (await send('POST', '/api/item', { canvasId: nested, type: 'todo', data: { title: 'Deep list' } })).body;

  const { status, body } = await get('/api/todos');
  assert.equal(status, 200);
  assert.equal(body.rootCanvasId, canvasId);

  const first = body.lists.find(l => l.id === a.id);
  assert.equal(first.title, 'Nightly Routine');
  assert.equal(first.canvasId, canvasId);
  assert.equal(first.color, 'blue');
  assert.deepEqual(first.tags, ['routine']);
  assert.deepEqual(first.tasks, tasks); // extra task fields survive the round trip

  // todo cards on nested canvases are listed too, and report the canvas they live on
  const deep = body.lists.find(l => l.id === b.id);
  assert.equal(deep.canvasTitle, 'Nested');
  assert.deepEqual(deep.tasks, []); // missing tasks default to an empty list

  // non-todo cards never show up
  assert.ok(!body.lists.some(l => l.id === board.id));
});

test('quick notes: task edits round-trip through PATCH /api/item', async () => {
  const canvasId = await root();
  const list = (
    await send('POST', '/api/item', {
      canvasId,
      type: 'todo',
      data: { title: 'Errands', tasks: [{ id: 't1', text: 'Milk', done: false }] },
    })
  ).body;
  const tasks = [
    {
      id: 't1',
      text: 'Milk',
      done: true,
      starred: true,
      due: '2026-08-07',
      tags: ['life'],
      note: 'oat',
      noteStyle: { b: true },
    },
  ];
  await send('PATCH', '/api/item/' + list.id, { data: { tasks } });
  await send('PATCH', '/api/item/' + list.id, { data: { tags: ['life'] } });

  const saved = (await get('/api/todos')).body.lists.find(l => l.id === list.id);
  assert.deepEqual(saved.tasks, tasks);
  assert.deepEqual(saved.tags, ['life']);
  assert.equal(saved.title, 'Errands'); // shallow data merge keeps the title
});

// ---- Trash, copy, move, task merge, upload safety ---------------------------

test('trash: delete hides the subtree and restore brings all of it back', async () => {
  const canvasId = await root();
  const board = (await send('POST', '/api/item', { canvasId, type: 'board', data: { title: 'Keep me' } })).body;
  const childId = board.data.childCanvasId;
  const inner = (await send('POST', '/api/item', { canvasId: childId, type: 'note', data: { body: 'inside' } })).body;
  const col = (await send('POST', '/api/item', { canvasId: childId, type: 'column' })).body;
  const card = (await send('POST', '/api/item', { canvasId: childId, type: 'note', parentItemId: col.id })).body;

  await send('DELETE', '/api/item/' + board.id);
  assert.equal((await get('/api/canvas/' + childId)).status, 404);

  const r = await send('POST', '/api/item/' + board.id + '/restore');
  assert.equal(r.status, 200);
  const ids = (await get('/api/canvas/' + childId)).body.items.map(i => i.id);
  assert.deepEqual(ids.sort(), [inner.id, col.id, card.id].sort());
  assert.ok((await get('/api/canvas/' + canvasId)).body.items.some(i => i.id === board.id));
  assert.equal((await send('POST', '/api/item/' + board.id + '/restore')).status, 404, 'nothing left to restore');
});

test('trash: restoring a column does not resurrect a card deleted on its own earlier', async () => {
  const canvasId = await root();
  const col = (await send('POST', '/api/item', { canvasId, type: 'column' })).body;
  const keep = (await send('POST', '/api/item', { canvasId, type: 'note', parentItemId: col.id })).body;
  const gone = (await send('POST', '/api/item', { canvasId, type: 'note', parentItemId: col.id })).body;
  await send('DELETE', '/api/item/' + gone.id);
  await send('DELETE', '/api/item/' + col.id);
  await send('POST', '/api/item/' + col.id + '/restore');
  const ids = (await get('/api/canvas/' + canvasId)).body.items.map(i => i.id);
  assert.ok(ids.includes(keep.id));
  assert.ok(!ids.includes(gone.id));
});

test('copy: a board is deep-copied, including into its own subtree', async () => {
  const canvasId = await root();
  const board = (await send('POST', '/api/item', { canvasId, type: 'board', data: { title: 'Src' } })).body;
  const inside = board.data.childCanvasId;
  await send('POST', '/api/item', { canvasId: inside, type: 'note', data: { body: 'deep' } });

  const copy = (await send('POST', '/api/item/' + board.id + '/copy', { canvasId, x: 500, y: 40 })).body;
  assert.notEqual(copy.id, board.id);
  assert.equal(copy.x, 500);
  assert.notEqual(copy.data.childCanvasId, inside, 'the copy owns a new canvas');
  const copied = (await get('/api/canvas/' + copy.data.childCanvasId)).body;
  assert.equal(copied.canvas.title, 'Src');
  assert.deepEqual(
    copied.items.map(i => i.data.text),
    ['deep']
  );
  assert.deepEqual(
    copied.breadcrumb.map(c => c.id),
    [canvasId, copy.data.childCanvasId]
  );

  // pasting a board inside itself copies the original contents once and stops
  const nested = (await send('POST', '/api/item/' + board.id + '/copy', { canvasId: inside, x: 0, y: 0 })).body;
  const nestedView = (await get('/api/canvas/' + nested.data.childCanvasId)).body;
  assert.deepEqual(
    nestedView.items.map(i => i.data.text),
    ['deep']
  );
});

test('copy: a column comes with its cards', async () => {
  const canvasId = await root();
  const col = (await send('POST', '/api/item', { canvasId, type: 'column', data: { title: 'Col' } })).body;
  await send('POST', '/api/item', { canvasId, type: 'note', parentItemId: col.id, data: { body: 'a' } });
  const copy = (await send('POST', '/api/item/' + col.id + '/copy', { canvasId, x: 0, y: 0 })).body;
  const kids = (await get('/api/canvas/' + canvasId)).body.items.filter(i => i.parentItemId === copy.id);
  assert.deepEqual(
    kids.map(k => k.data.text),
    ['a']
  );
});

test('move: cut/paste relocates a board with its contents and refuses a cycle', async () => {
  const canvasId = await root();
  const a = (await send('POST', '/api/item', { canvasId, type: 'board', data: { title: 'A' } })).body;
  const b = (await send('POST', '/api/item', { canvasId, type: 'board', data: { title: 'B' } })).body;
  const note = (await send('POST', '/api/item', { canvasId: a.data.childCanvasId, type: 'note', data: { body: 'n' } }))
    .body;

  const moved = await send('POST', '/api/item/' + a.id + '/move', { canvasId: b.data.childCanvasId, x: 10, y: 20 });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.canvasId, b.data.childCanvasId);
  const inA = (await get('/api/canvas/' + a.data.childCanvasId)).body;
  assert.deepEqual(
    inA.items.map(i => i.id),
    [note.id],
    'contents survive the move'
  );
  assert.deepEqual(
    inA.breadcrumb.map(c => c.id),
    [canvasId, b.data.childCanvasId, a.data.childCanvasId]
  );

  const cycle = await send('POST', '/api/item/' + b.id + '/move', { canvasId: a.data.childCanvasId, x: 0, y: 0 });
  assert.equal(cycle.status, 400);
});

test('tasks: concurrent edits from two devices merge instead of overwriting', async () => {
  const canvasId = await root();
  const base = [
    { id: 't1', text: 'Milk', done: false },
    { id: 't2', text: 'Eggs', done: false },
  ];
  const list = (await send('POST', '/api/item', { canvasId, type: 'todo', data: { tasks: base } })).body;

  // phone: ticks Milk and adds Bread
  await send('PATCH', '/api/item/' + list.id, {
    baseTasks: base,
    data: { tasks: [{ id: 't1', text: 'Milk', done: true }, base[1], { id: 't3', text: 'Bread', done: false }] },
  });
  // desktop, still holding the old list: renames Eggs and deletes nothing it didn't see
  const r = await send('PATCH', '/api/item/' + list.id, {
    baseTasks: base,
    data: { tasks: [base[0], { id: 't2', text: 'Free-range eggs', done: false }] },
  });
  assert.deepEqual(r.body.data.tasks, [
    { id: 't1', text: 'Milk', done: true },
    { id: 't2', text: 'Free-range eggs', done: false },
    { id: 't3', text: 'Bread', done: false },
  ]);

  // a delete on one side wins over an untouched copy on the other
  const now = r.body.data.tasks;
  await send('PATCH', '/api/item/' + list.id, { baseTasks: now, data: { tasks: now.filter(t => t.id !== 't3') } });
  const stale = await send('PATCH', '/api/item/' + list.id, {
    baseTasks: now,
    data: { tasks: now.map(t => (t.id === 't1' ? { ...t, text: 'Oat milk' } : t)) },
  });
  assert.deepEqual(
    stale.body.data.tasks.map(t => t.text),
    ['Oat milk', 'Free-range eggs']
  );
});

test('F7.1 tasks: the merge keeps indent levels when both sides edited the list', async () => {
  const canvasId = await root();
  const base = [
    { id: 'p', text: 'Trip', done: false, indent: 0 },
    { id: 'c', text: 'Book train', done: false, indent: 1 },
  ];
  const list = (await send('POST', '/api/item', { canvasId, type: 'todo', data: { tasks: base } })).body;
  // canvas: outdents "Book train" and indents a new subtask
  await send('PATCH', '/api/item/' + list.id, {
    baseTasks: base,
    data: { tasks: [base[0], { ...base[1], indent: 0 }, { id: 'n', text: 'Pack', done: false, indent: 1 }] },
  });
  // Quick notes, still on the old list and unaware of `indent`: renames the trip
  const r = await send('PATCH', '/api/item/' + list.id, {
    baseTasks: base,
    data: { tasks: base.map(({ indent, ...t }) => (t.id === 'p' ? { ...t, text: 'Lisbon trip' } : t)) }, // oxlint-disable-line no-unused-vars
  });
  assert.deepEqual(
    r.body.data.tasks.map(t => [t.id, t.text, t.indent]),
    [
      ['p', 'Lisbon trip', 0],
      ['c', 'Book train', 0],
      ['n', 'Pack', 1],
    ]
  );
});

test('uploads: active content downloads instead of rendering on our origin', async () => {
  const upload = async (body, type, name) => {
    const fd = new FormData();
    fd.append('file', new Blob([body], { type }), name);
    return (await fetch(base + '/api/upload', { method: 'POST', body: fd })).json();
  };
  const html = await upload('<script>alert(1)</script>', 'text/html', 'evil.html');
  const r = await fetch(base + html.src);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-disposition'), 'attachment');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');

  // an encoded path that skips the /uploads mount must not dodge the headers
  const encoded = await fetch(base + html.src.replace('/uploads/', '/%75ploads/'));
  assert.equal(encoded.status, 200);
  assert.equal(encoded.headers.get('content-disposition'), 'attachment');
  // on a case-insensitive disk (macOS) a re-cased directory resolves to the same folder
  const recased = await fetch(base + html.src.replace('/uploads/', '/%55ploads/'));
  if (recased.status === 200) assert.equal(recased.headers.get('content-disposition'), 'attachment');

  const png = await upload('png', 'image/png', 'pic.png');
  const p = await fetch(base + png.src);
  assert.equal(p.headers.get('content-disposition'), null, 'images still display inline');
});

test('upload mime allow-list: office docs, zip and json in; executables out', async () => {
  const allowed = [
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/zip',
    'application/json',
    'text/plain',
  ];
  for (const type of allowed) {
    const fd = new FormData();
    fd.append('file', new Blob(['x'], { type }), 'f.bin');
    const r = await fetch(base + '/api/upload', { method: 'POST', body: fd });
    assert.equal(r.status, 200, type);
    fs.rmSync(path.join(__dirname, '..', 'public', (await r.json()).src), { force: true });
  }
  const fd = new FormData();
  fd.append('file', new Blob(['MZ'], { type: 'application/x-msdownload' }), 'evil.exe');
  assert.equal((await fetch(base + '/api/upload', { method: 'POST', body: fd })).status, 415);
});

test('missing ids: 404 on canvas/item routes, 400 on a bad target canvas', async () => {
  const canvasId = await root();
  assert.equal((await get('/api/canvas/c_nope')).status, 404);
  assert.equal((await send('PATCH', '/api/canvas/c_nope', { title: 'x' })).status, 404);
  assert.equal((await send('PATCH', '/api/item/i_nope', { x: 1 })).status, 404);
  assert.equal((await send('DELETE', '/api/item/i_nope')).status, 404);
  assert.equal((await send('POST', '/api/item/i_nope/restore')).status, 404);
  assert.equal((await send('POST', '/api/item/i_nope/copy', { canvasId })).status, 404);
  const note = (await send('POST', '/api/item', { canvasId, type: 'note' })).body;
  assert.equal((await send('POST', '/api/item/' + note.id + '/move', { canvasId: 'c_nope' })).status, 400);
});

test('board cards: create with icon/colour, patch colour and icon through to the child canvas', async () => {
  const canvasId = await root();
  const board = (
    await send('POST', '/api/item', { canvasId, type: 'board', color: 'red', data: { title: 'B', icon: 'star' } })
  ).body;
  assert.equal(board._childColor, 'red');
  assert.equal(board._childIcon, 'star');
  await send('PATCH', '/api/item/' + board.id, { color: 'green', data: { icon: 'heart' } });
  const child = (await get('/api/canvas/' + board.data.childCanvasId)).body.canvas;
  assert.equal(child.color, 'green');
  assert.equal(child.icon, 'heart');
  const patched = (await send('PATCH', '/api/canvas/' + child.id, { icon: 'moon' })).body;
  assert.equal(patched.icon, 'moon');
});

test('bulk patch skips unknown ids and accepts an empty body', async () => {
  assert.deepEqual((await send('PATCH', '/api/items', { updates: [{ id: 'i_nope', x: 1 }] })).body, { ok: true });
  assert.deepEqual((await send('PATCH', '/api/items', {})).body, { ok: true });
});

// ---- P1 · Robustness tail ---------------------------------------------------

const uploadBlob = async (bytes, type, name) => {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type }), name);
  const r = await fetch(base + '/api/upload', { method: 'POST', body: fd });
  return { status: r.status, body: await r.json() };
};
const uploadPath = src => path.join(__dirname, '..', 'public', src);

test('F1.5 audio and video upload; rejections say why', async () => {
  for (const [type, name] of [
    ['audio/mpeg', 'song.mp3'],
    ['video/mp4', 'clip.mp4'],
  ]) {
    const r = await uploadBlob('x', type, name);
    assert.equal(r.status, 200, type);
    assert.equal(r.body.mime, type);
    fs.rmSync(uploadPath(r.body.src), { force: true });
  }
  const bad = await uploadBlob('MZ', 'application/x-msdownload', 'evil.exe');
  assert.equal(bad.status, 415);
  assert.match(bad.body.error, /application\/x-msdownload files can't be uploaded/);

  const big = await uploadBlob(Buffer.alloc(25 * 1024 * 1024 + 1), 'text/plain', 'big.txt');
  assert.equal(big.status, 413);
  assert.match(big.body.error, /25 MB/);

  const none = await fetch(base + '/api/upload', { method: 'POST', body: new FormData() });
  assert.equal(none.status, 400);
});

test('F1.1 trash lists each delete once and restore brings back the whole subtree', async () => {
  const canvasId = await root();
  const board = (await send('POST', '/api/item', { canvasId, type: 'board', data: { title: 'Trip' } })).body;
  const inner = board.data.childCanvasId;
  const note = (await send('POST', '/api/item', { canvasId: inner, type: 'note', data: { title: 'Pack' } })).body;
  await send('DELETE', '/api/item/' + board.id);

  const listed = (await get('/api/trash')).body.items;
  const entry = listed.find(i => i.id === board.id);
  assert.deepEqual(
    { type: entry.type, title: entry.title, canvasId: entry.canvasId, restorable: entry.restorable },
    { type: 'board', title: 'Trip', canvasId, restorable: true }
  );
  assert.ok(entry.trashedAt > 0);
  assert.ok(!listed.some(i => i.id === note.id), 'contents are not listed separately');

  assert.equal((await send('POST', '/api/item/' + board.id + '/restore')).status, 200);
  assert.ok(!(await get('/api/trash')).body.items.some(i => i.id === board.id));
  const back = (await get('/api/canvas/' + inner)).body;
  assert.ok(back.items.some(i => i.id === note.id));
});

test('F1.1 restore refuses an item whose board is trashed, and frees a card whose column is gone', async () => {
  const canvasId = await root();
  const board = (await send('POST', '/api/item', { canvasId, type: 'board', data: { title: 'Outer' } })).body;
  const inner = board.data.childCanvasId;
  const note = (await send('POST', '/api/item', { canvasId: inner, type: 'note', data: { title: 'first' } })).body;
  await send('DELETE', '/api/item/' + note.id);
  await send('DELETE', '/api/item/' + board.id);
  const entry = (await get('/api/trash')).body.items.find(i => i.id === note.id);
  assert.equal(entry.restorable, false);
  const r = await send('POST', '/api/item/' + note.id + '/restore');
  assert.equal(r.status, 409);
  assert.match(r.body.error, /board is in the trash/);

  const col = (await send('POST', '/api/item', { canvasId, type: 'column', data: { title: 'Col' } })).body;
  const card = (await send('POST', '/api/item', { canvasId, type: 'note', parentItemId: col.id })).body;
  await send('DELETE', '/api/item/' + card.id);
  await send('DELETE', '/api/item/' + col.id);
  const restored = (await send('POST', '/api/item/' + card.id + '/restore')).body;
  assert.equal(restored.parentItemId, null);
});

test('F1.2 empty trash hard-deletes rows and unlinks only unreferenced uploads', async () => {
  const canvasId = await root();
  const shared = (await uploadBlob('a', 'text/plain', 'shared.txt')).body;
  const orphan = (await uploadBlob('b', 'text/plain', 'orphan.txt')).body;
  const keep = (await send('POST', '/api/item', { canvasId, type: 'file', data: { src: shared.src } })).body;
  const copy = (await send('POST', '/api/item/' + keep.id + '/copy', { canvasId, x: 0, y: 0 })).body;
  const gone = (await send('POST', '/api/item', { canvasId, type: 'file', data: { src: orphan.src } })).body;
  await send('DELETE', '/api/item/' + copy.id);
  await send('DELETE', '/api/item/' + gone.id);

  const r = await send('DELETE', '/api/trash');
  assert.equal(r.status, 200);
  assert.ok(r.body.items >= 2);
  assert.equal(r.body.files, 1);
  assert.deepEqual((await get('/api/trash')).body.items, []);
  assert.equal((await send('POST', '/api/item/' + gone.id + '/restore')).status, 404);
  assert.ok(fs.existsSync(uploadPath(shared.src)), 'still used by a live item');
  assert.ok(!fs.existsSync(uploadPath(orphan.src)), 'nothing references it any more');
  fs.rmSync(uploadPath(shared.src), { force: true });
});

test('F1.3 a card can only be parented to a live column on its own canvas', async () => {
  const canvasId = await root();
  const other = (await send('POST', '/api/item', { canvasId, type: 'board' })).body.data.childCanvasId;
  const col = (await send('POST', '/api/item', { canvasId, type: 'column' })).body;
  const farCol = (await send('POST', '/api/item', { canvasId: other, type: 'column' })).body;
  const deadCol = (await send('POST', '/api/item', { canvasId, type: 'column' })).body;
  await send('DELETE', '/api/item/' + deadCol.id);
  const note = (await send('POST', '/api/item', { canvasId, type: 'note' })).body;
  const notCol = (await send('POST', '/api/item', { canvasId, type: 'note' })).body;

  for (const parentItemId of ['i_missing', deadCol.id, farCol.id, notCol.id, note.id]) {
    const r = await send('PATCH', '/api/item/' + note.id, { parentItemId });
    assert.equal(r.status, 400, parentItemId);
    assert.equal(r.body.error, 'bad parentItemId');
  }
  assert.equal((await send('PATCH', '/api/item/' + note.id, { parentItemId: col.id })).body.parentItemId, col.id);
  assert.equal((await send('PATCH', '/api/item/' + note.id, { parentItemId: null })).body.parentItemId, null);

  const bulk = await send('PATCH', '/api/items', { updates: [{ id: note.id, parentItemId: farCol.id }] });
  assert.equal(bulk.status, 400);
  assert.equal((await send('PATCH', '/api/items', { updates: [{ id: note.id, parentItemId: col.id }] })).status, 200);
});

test('F1.3 the parent rule also holds on create, on a canvas move, and for columns', async () => {
  const canvasId = await root();
  const other = (await send('POST', '/api/item', { canvasId, type: 'board' })).body.data.childCanvasId;
  const col = (await send('POST', '/api/item', { canvasId, type: 'column' })).body;
  const col2 = (await send('POST', '/api/item', { canvasId, type: 'column' })).body;

  assert.equal((await send('POST', '/api/item', { canvasId, type: 'note', parentItemId: 'i_missing' })).status, 400);
  assert.equal((await send('POST', '/api/item', { canvasId, type: 'column', parentItemId: col.id })).status, 400);
  const inCol = (await send('POST', '/api/item', { canvasId, type: 'note', parentItemId: col.id })).body;
  assert.equal(inCol.parentItemId, col.id);

  // moving canvases without clearing the parent would strand the card
  assert.equal((await send('PATCH', '/api/item/' + inCol.id, { canvasId: other })).status, 400);
  const moved = await send('PATCH', '/api/item/' + inCol.id, { canvasId: other, parentItemId: null });
  assert.equal(moved.body.canvasId, other);

  const cycle = await send('PATCH', '/api/items', {
    updates: [
      { id: col.id, parentItemId: col2.id },
      { id: col2.id, parentItemId: col.id },
    ],
  });
  assert.equal(cycle.status, 400);
});

test('F1.1 a card freed from a deleted column comes back where the column stood', async () => {
  const canvasId = await root();
  const col = (await send('POST', '/api/item', { canvasId, type: 'column', x: 900, y: 700 })).body;
  const card = (await send('POST', '/api/item', { canvasId, type: 'note', parentItemId: col.id, x: 0, y: 3 })).body;
  await send('DELETE', '/api/item/' + card.id);
  await send('DELETE', '/api/item/' + col.id);
  const back = (await send('POST', '/api/item/' + card.id + '/restore')).body;
  assert.deepEqual([back.parentItemId, back.x, back.y], [null, 900, 700]);
});

test('F1.5 uploaded audio and video are served inline (still nosniff)', async () => {
  const up = (await uploadBlob('x', 'video/mp4', 'clip.mp4')).body;
  const r = await fetch(base + up.src);
  assert.equal(r.headers.get('content-disposition'), null);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  fs.rmSync(uploadPath(up.src), { force: true });
});

test('lines travel with their cards: trashed, restored, purged, and copied only whole', async () => {
  const board = (await send('POST', '/api/item', { canvasId: await root(), type: 'board' })).body;
  const c = board.data.childCanvasId;
  const card = async () => (await send('POST', '/api/item', { canvasId: c, type: 'note' })).body;
  const [a, b] = [await card(), await card()];
  const line = (
    await send('POST', '/api/item', { canvasId: c, type: 'line', data: { from: { id: a.id }, to: { id: b.id } } })
  ).body;
  const lines = async cid => (await get('/api/canvas/' + cid)).body.items.filter(i => i.type === 'line');

  await send('DELETE', '/api/item/' + a.id);
  assert.deepEqual(await lines(c), []); // trashed with its card…
  assert.equal((await get('/api/trash')).body.items.filter(t => t.id === line.id).length, 0); // …not listed on its own
  await send('POST', `/api/item/${a.id}/restore`);
  assert.deepEqual(
    (await lines(c)).map(l => l.id),
    [line.id]
  );

  // Copying one end drops the line; copying the whole board remaps both ends.
  await send('POST', `/api/item/${a.id}/copy`, { canvasId: c, x: 0, y: 0 });
  assert.equal((await lines(c)).length, 1);
  const copy = (await send('POST', `/api/item/${board.id}/copy`, { canvasId: await root(), x: 0, y: 0 })).body;
  const cc = copy.data.childCanvasId;
  const [copied] = await lines(cc);
  const cards = (await get('/api/canvas/' + cc)).body.items.filter(i => i.type === 'note').map(i => i.id);
  assert.ok(cards.includes(copied.data.from.id) && cards.includes(copied.data.to.id));
  assert.ok(![a.id, b.id].includes(copied.data.from.id));

  await send('DELETE', '/api/item/' + b.id);
  await send('DELETE', '/api/trash');
  const left = (await get('/api/canvas/' + c)).body.items.map(i => i.id);
  assert.ok(!left.includes(line.id));
});

test('F7.5 a shortcut carries its target board, and reads as broken once that board is trashed', async () => {
  const canvasId = await root();
  const board = (await send('POST', '/api/item', { canvasId, type: 'board', data: { title: 'Target' } })).body;
  const sc = (
    await send('POST', '/api/item', { canvasId, type: 'shortcut', data: { targetCanvasId: board.data.childCanvasId } })
  ).body;
  const target = async () => (await get('/api/canvas/' + canvasId)).body.items.find(i => i.id === sc.id)._target;
  assert.equal((await target()).title, 'Target');
  await send('DELETE', '/api/item/' + board.id);
  assert.equal(await target(), null);
  await send('POST', `/api/item/${board.id}/restore`);
  assert.equal((await target()).title, 'Target');
});

test('F7.6 a template copy is deep: editing it leaves the template unchanged', async () => {
  const canvasId = await root();
  const tpl = (await send('POST', '/api/item', { canvasId, type: 'board', data: { title: 'Weekly review' } })).body;
  const note = (
    await send('POST', '/api/item', { canvasId: tpl.data.childCanvasId, type: 'note', data: { body: 'Wins' } })
  ).body;
  const copy = (await send('POST', `/api/item/${tpl.id}/copy`, { canvasId, x: 0, y: 0 })).body;
  assert.notEqual(copy.data.childCanvasId, tpl.data.childCanvasId);
  const [copied] = (await get('/api/canvas/' + copy.data.childCanvasId)).body.items;
  assert.notEqual(copied.id, note.id);
  assert.equal(copied.data.text, 'Wins');
  await send('PATCH', '/api/item/' + copied.id, { data: { body: 'Wins and lessons' } });
  await send('PATCH', '/api/canvas/' + copy.data.childCanvasId, { title: 'Week 43' });
  const [orig] = (await get('/api/canvas/' + tpl.data.childCanvasId)).body.items;
  assert.equal(orig.data.text, 'Wins');
  assert.equal((await get('/api/canvas/' + tpl.data.childCanvasId)).body.canvas.title, 'Weekly review');
});

test('F7.5 shortcuts need a live target, are titled in Trash, and follow a copied board', async () => {
  const canvasId = await root();
  assert.equal((await send('POST', '/api/item', { canvasId, type: 'shortcut', data: {} })).status, 400);
  assert.equal(
    (await send('POST', '/api/item', { canvasId, type: 'shortcut', data: { targetCanvasId: 'c_nope' } })).status,
    400
  );
  // A board holding a nested board plus a shortcut to it: the copy's shortcut opens the copy's board.
  const outer = (await send('POST', '/api/item', { canvasId, type: 'board', data: { title: 'Outer' } })).body;
  const inner = (
    await send('POST', '/api/item', { canvasId: outer.data.childCanvasId, type: 'board', data: { title: 'Inner' } })
  ).body;
  const sc = (
    await send('POST', '/api/item', {
      canvasId: outer.data.childCanvasId,
      type: 'shortcut',
      data: { targetCanvasId: inner.data.childCanvasId },
    })
  ).body;
  const copy = (await send('POST', `/api/item/${outer.id}/copy`, { canvasId, x: 0, y: 0 })).body;
  const copied = (await get('/api/canvas/' + copy.data.childCanvasId)).body.items;
  const copiedInner = copied.find(i => i.type === 'board');
  assert.equal(copied.find(i => i.type === 'shortcut').data.targetCanvasId, copiedInner.data.childCanvasId);

  await send('DELETE', '/api/item/' + sc.id);
  const entry = (await get('/api/trash')).body.items.find(t => t.id === sc.id);
  assert.equal(entry.title, 'Shortcut to Inner');
});

test('a compressed JSON body is refused, not inflated', async () => {
  const body = require('zlib').gzipSync(JSON.stringify({ canvasId: await root(), type: 'note' }));
  const r = await fetch(base + '/api/item', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
    body,
  });
  assert.equal(r.status, 415);
});

test('U2.2 the service worker is served no-cache so updates land on the next launch', async () => {
  const r = await fetch(base + '/sw.js');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  assert.match(r.headers.get('content-type'), /javascript/);
});
