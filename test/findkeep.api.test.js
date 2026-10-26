'use strict';

// P5a: global search, Markdown export (round-trips through the importer) and
// the database backup download.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'board-findkeep-'));
process.env.DATA_DIR = TMP;

const express = require('express');
const Database = require('better-sqlite3');
const routes = require('../routes');
const { importFile, parseMd } = require('../scripts/import-milanote-md.js');

const app = express();
app.use(express.json());
app.use(routes);
let base, server;
test.before(async () => {
  await new Promise(r => (server = app.listen(0, '127.0.0.1', r)));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => {
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const json = async (m, p, b) => {
  const r = await fetch(base + p, {
    method: m,
    headers: { 'Content-Type': 'application/json' },
    // oxlint-disable-next-line unicorn/no-invalid-fetch-options -- only sent for writes
    body: b && JSON.stringify(b),
  });
  return r.json();
};
const post = b => json('POST', '/api/item', b);
const root = async () => (await json('GET', '/api/root')).rootCanvasId;
const search = async q => (await json('GET', '/api/search?q=' + encodeURIComponent(q))).results;

// A board with a nested board, every exportable card kind and a column.
async function sampleBoard(title) {
  const board = await post({ canvasId: await root(), type: 'board', data: { title } });
  const c = board.data.childCanvasId;
  await post({ canvasId: c, type: 'note', x: 0, y: 0, data: { title: 'Plan', body: 'step one\nstep two' } });
  await post({ canvasId: c, type: 'note', x: 300, y: 0, data: { body: 'one-liner' } });
  await post({
    canvasId: c,
    type: 'todo',
    x: 0,
    y: 300,
    data: {
      title: 'Errands',
      tasks: [
        { id: 'a', text: 'post office', done: true },
        { id: 'b', text: 'groceries', done: false },
        { id: 'c', text: '', done: false },
      ],
    },
  });
  await post({
    canvasId: c,
    type: 'link',
    x: 300,
    y: 300,
    data: { url: 'https://en.wikipedia.org/wiki/Foo_(bar)', title: 'Example' },
  });
  const col = await post({ canvasId: c, type: 'column', x: 0, y: 600, data: { title: 'Col' } });
  await post({ canvasId: c, type: 'note', parentItemId: col.id, y: 0, data: { body: 'in a column' } });
  const nested = await post({ canvasId: c, type: 'board', x: 600, y: 0, data: { title: 'Deep dive' } });
  await post({ canvasId: nested.data.childCanvasId, type: 'note', data: { body: 'needle in a nested board' } });
  return { board, canvasId: c, nested };
}

test('F5.1 search finds board titles and nested card text, never trashed rows', async () => {
  const { nested, canvasId } = await sampleBoard('Searchable');
  const hits = await search('NEEDLE');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'item');
  assert.equal(hits[0].canvasId, nested.data.childCanvasId);
  assert.equal(hits[0].title, 'needle in a nested board');
  assert.deepEqual(hits[0].path, ['Home', 'Searchable', 'Deep dive']);

  assert.equal((await search('groceries'))[0].title, 'groceries'); // to-do task text
  assert.equal((await search('Deep dive')).find(r => r.kind === 'board').canvasId, nested.data.childCanvasId);
  assert.deepEqual(await search('   '), []);
  assert.deepEqual(await search('100%_'), []); // LIKE wildcards are literal

  const gone = await post({ canvasId, type: 'note', data: { body: 'binned haystack' } });
  assert.equal((await search('haystack')).length, 1);
  await json('DELETE', '/api/item/' + gone.id);
  assert.deepEqual(await search('haystack'), []);
  await json('DELETE', '/api/item/' + nested.id); // trashing a board hides everything inside
  assert.deepEqual(await search('needle'), []);
});

test('F5.2 export then import gives back the same titles, text and tasks', async () => {
  const { canvasId } = await sampleBoard('Round trip');
  const r = await fetch(base + `/api/canvas/${canvasId}/export.md`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="Round trip.md"/);
  const md = await r.text();

  const file = path.join(TMP, 'export.md');
  fs.writeFileSync(file, md);
  assert.equal(await importFile(base, await root(), file, { boards: 0, notes: 0, todos: 0, links: 0 }), 'Round trip');

  const shape = async cid => {
    const items = (await json('GET', '/api/canvas/' + cid)).items;
    return {
      notes: items
        .filter(i => i.type === 'note')
        .map(i => i.data.text)
        .sort(),
      todos: items.filter(i => i.type === 'todo').map(i => [i.data.title, i.data.tasks.map(t => [t.text, t.done])]),
      links: items.filter(i => i.type === 'link').map(i => [i.data.title, decodeURI(i.data.url)]), // parens arrive %-encoded
      boards: items.filter(i => i.type === 'board').map(i => i._childTitle),
    };
  };
  const original = await shape(canvasId);
  original.todos[0][1] = original.todos[0][1].filter(([text]) => text); // blank rows aren't exported
  const home = (await json('GET', '/api/canvas/' + (await root()))).items;
  const copy = home.filter(i => i._childTitle === 'Round trip').at(-1);
  assert.deepEqual(await shape(copy.data.childCanvasId), original);

  const doc = parseMd(md);
  assert.deepEqual(
    doc.boards.map(b => b.title),
    ['Deep dive']
  );
  assert.equal(doc.boards[0].blocks[0].title, 'needle in a nested board');
  assert.equal((await fetch(base + '/api/canvas/c_missing/export.md')).status, 404);
});

test('export: Unicode titles survive, upload links use the page origin, captions are searchable', async () => {
  const board = await post({ canvasId: await root(), type: 'board', data: { title: '日本旅行' } });
  const c = board.data.childCanvasId;
  await post({ canvasId: c, type: 'image', data: { src: '/uploads/shot (1).png', caption: 'Kitchen floor plan' } });
  const r = await fetch(base + `/api/canvas/${c}/export.md?origin=${encodeURIComponent('https://box.ts.net')}`);
  assert.match(r.headers.get('content-disposition'), /filename\*=UTF-8''%E6%97%A5%E6%9C%AC%E6%97%85%E8%A1%8C\.md/);
  assert.match(await r.text(), /^!\[Kitchen floor plan\]\(https:\/\/box\.ts\.net\/uploads\/shot%20%281%29\.png\)$/m);
  const bad = await fetch(base + `/api/canvas/${c}/export.md?origin=${encodeURIComponent('javascript:alert(1)')}`);
  assert.match(await bad.text(), /\]\(http:\/\/127\.0\.0\.1:\d+\/uploads\//); // falls back to the request's own host
  assert.equal((await search('floor plan'))[0].title, 'Kitchen floor plan');
});

test('F5.3 the backup is a valid SQLite file that opens and contains the items', async () => {
  await sampleBoard('Backed up');
  const [r, twin] = await Promise.all([fetch(base + '/api/backup'), fetch(base + '/api/backup')]); // a double-tap
  assert.equal(r.status, 200);
  assert.equal(
    Buffer.from(await twin.arrayBuffer())
      .subarray(0, 15)
      .toString(),
    'SQLite format 3'
  );
  assert.match(r.headers.get('content-disposition'), /attachment; filename="milaclone-\d{4}-\d{2}-\d{2}\.db"/);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.subarray(0, 16).toString('latin1'), 'SQLite format 3\0');
  const file = path.join(TMP, 'download.db');
  fs.writeFileSync(file, buf);
  const copy = new Database(file, { readonly: true });
  const titles = copy
    .prepare('SELECT title FROM canvases')
    .all()
    .map(c => c.title);
  assert.ok(titles.includes('Backed up'));
  assert.ok(copy.prepare('SELECT COUNT(*) n FROM items').get().n > 0);
  copy.close();
  assert.deepEqual(
    fs
      .readdirSync(os.tmpdir())
      .filter(f => f.startsWith('milaclone-backup-') && fs.existsSync(path.join(os.tmpdir(), f, 'board.db'))),
    []
  ); // the temp snapshot is removed after sending
});
