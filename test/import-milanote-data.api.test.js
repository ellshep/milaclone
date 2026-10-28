'use strict';

// U1.2/U1.3: the route-B reader (Milanote's own board data) through the
// importer engine, against a made-up capture with the same shape as a real one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'board-import-route-b-'));
process.env.DATA_DIR = TMP;

const express = require('express');
const routes = require('../routes');
const { importCards, main } = require('../scripts/import-milanote.js');
const reader = require('../scripts/read-milanote-data.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'milanote', 'board-data.json');
const IMAGE_URL = 'https://app.milanote.com/media/p/images/I1/x/pixel.png';
const PNG = fs.readFileSync(path.join(__dirname, 'fixtures', 'milanote', 'pixel.png'));
// What the browser capture of Milanote's media would hold for that image.
const MEDIA = path.join(TMP, 'media.json');
fs.writeFileSync(MEDIA, JSON.stringify({ [IMAGE_URL]: 'data:image/png;base64,' + PNG.toString('base64') }));

const writes = [];
const app = express();
app.use((req, res, next) => {
  if (req.method !== 'GET') writes.push(`${req.method} ${req.path}`);
  next();
});
app.use(routes);

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
  const db = require('../db');
  for (const r of db.db.prepare("SELECT json_extract(data, '$.src') AS src FROM items").all()) {
    if (r.src) fs.rmSync(path.join(__dirname, '..', 'public', r.src), { force: true });
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

const get = p => fetch(base + p).then(r => r.json());
const canvas = async id => (await get('/api/canvas/' + id)).items;
const bySource = (items, sid) => items.find(i => i.data && i.data.sourceId === sid);
const find = (cards, sid) => {
  for (const c of cards) {
    if (c.sourceId === sid) return c;
    const inner = find(c.items || [], sid);
    if (inner) return inner;
  }
  return null;
};

test('reader: types, grid units to pixels, order and text', () => {
  const cards = reader.read([FIXTURE], { media: MEDIA });
  const trip = find(cards, 'B1');
  assert.deepEqual(
    [trip.type, trip.x, trip.y, trip.w, trip.color, trip.data.title],
    ['board', 10, 20, 120, 'pink', 'Trip']
  );
  assert.equal(find(cards, 'B4').color, 'gray', 'named colours map straight across');

  const note = find(cards, 'N1');
  assert.deepEqual([note.type, note.x, note.y, note.w, note.color], ['note', 100, 110, 340, 'blue']);
  const [heading, body, list, mention] = note.data.doc.content;
  assert.deepEqual(heading, { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Plan' }] });
  assert.deepEqual(
    body.content.map(n => n.type),
    ['text', 'text', 'text', 'hardBreak', 'text']
  );
  assert.deepEqual(body.content[0].marks, [{ type: 'bold' }]);
  assert.deepEqual(body.content[2].marks, [{ type: 'link', attrs: { href: 'https://example.com/train' } }]);
  assert.equal(body.attrs, undefined, "Milanote's key/textAlign attrs are dropped");
  assert.equal(list.type, 'bulletList');
  assert.deepEqual(
    mention,
    { type: 'paragraph', content: [{ type: 'text', text: '@Sam' }] },
    'unknown nodes keep their words'
  );

  // N2 sits 3 grid units under N1 in Milanote; here it moves below N1 instead of overlapping it.
  assert.ok(find(cards, 'N2').y > note.y + 100);

  const todo = find(cards, 'T1');
  assert.equal(todo.data.title, 'Packing');
  assert.deepEqual(
    todo.data.tasks.map(t => [t.id, t.text, t.done, t.indent]),
    [
      ['Ta', 'Bag', true, 0],
      ['Tb', 'Charger', false, 1],
      ['Tc', 'Snacks', false, 0],
    ]
  );

  const column = find(cards, 'C1');
  assert.deepEqual(
    column.items.map(c => [c.sourceId, c.type]),
    [
      ['K2', 'swatch'],
      ['K1', 'note'],
      ['B2', 'board'],
    ],
    'column cards follow score, not the stale index'
  );
  assert.deepEqual(find(cards, 'K2').data, { hex: '#2f6df0', text: '#2f6df0' });
  assert.deepEqual(find(cards, 'D1').data.rows, [
    ['Stop', ''],
    ['Museum', '3'],
  ]);

  const sketch = find(cards, 'A1');
  assert.equal(sketch.w, 232);
  assert.deepEqual(sketch.data.strokes[1], { d: 'M17.4 17.4 L34.8 34.8', size: 7, color: 'pink' });

  const image = find(cards, 'I1');
  assert.equal(image.missing, undefined);
  assert.match(image.file.url, /^data:image\/png;base64,/);
  assert.deepEqual([image.data.caption, image.file.name, image.file.mime], ['Map', 'pixel.png', 'image/png']);

  const comment = find(cards, 'CT');
  assert.deepEqual([comment.type, comment.x, comment.y], ['comment', image.x + image.w + 20, image.y]);
  assert.equal(reader.plain(comment.data.doc), 'First comment\nSecond comment');

  const unsorted = find(cards, 'U1');
  assert.ok(unsorted.x > Math.max(...trip.items.filter(c => c !== unsorted).map(c => c.x + c.w)));

  assert.equal(find(cards, 'X1'), null, 'trashed in Milanote: left out');
  const missing = Object.fromEntries(
    [...trip.items, ...cards]
      .filter(c => c.missing || c.type.startsWith('milanote:'))
      .map(c => [c.sourceId, c.missing || c.type])
  );
  assert.deepEqual(missing, {
    L2: 'link with no URL',
    I2: 'image with no file (an empty image slot in Milanote)',
    LN: 'milanote:LINE',
    Tz: 'not reachable from Home',
    O1: 'not reachable from Home',
  });

  // Without the media capture, a Milanote-hosted image is reported, not turned into a dead link.
  assert.match(find(reader.read([FIXTURE]), 'I1').missing, /pass --media/);
});

let first;
test('engine + route B: types, positions and nesting on the server', async () => {
  first = await importCards(reader.read([FIXTURE], { media: MEDIA }), { base, into: 'From Milanote' });
  assert.deepEqual(first.created, {
    board: 4,
    note: 4,
    todo: 1,
    link: 1,
    image: 1,
    column: 1,
    swatch: 1,
    sketch: 1,
    table: 1,
    comment: 1,
  });
  assert.deepEqual(first.missed.map(m => m.sourceId).sort(), ['I2', 'L2', 'LN', 'O1', 'Tz']);

  const { rootCanvasId } = await get('/api/root');
  const stage = (await canvas(rootCanvasId)).find(i => i.type === 'board' && i._childTitle === 'From Milanote');
  const top = await canvas(stage.data.childCanvasId);
  const trip = bySource(top, 'B1');
  assert.deepEqual([trip._childTitle, trip._childColor, trip.x, trip.y], ['Trip', 'pink', 10, 20]);

  const items = await canvas(trip.data.childCanvasId);
  const note = bySource(items, 'N1');
  assert.deepEqual([note.type, note.x, note.y, note.w, note.color], ['note', 100, 110, 340, 'blue']);
  assert.equal(note.data.text, 'Plan\nBook the train\nearly\nPassport\n@Sam');
  const image = bySource(items, 'I1');
  assert.deepEqual([image.type, image.data.caption, image.data.mime], ['image', 'Map', 'image/png']);
  assert.match(image.data.src, /^\/uploads\/.+\.png$/);
  assert.deepEqual(
    bySource(items, 'T1').data.tasks.map(t => t.indent),
    [0, 1, 0]
  );

  const col = bySource(items, 'C1');
  const inCol = items.filter(i => i.parentItemId === col.id).sort((a, b) => a.y - b.y);
  assert.deepEqual(
    inCol.map(i => i.data.sourceId),
    ['K2', 'K1', 'B2']
  );
  const day1 = bySource(await canvas(bySource(items, 'B2').data.childCanvasId), 'B3');
  const table = bySource(await canvas(day1.data.childCanvasId), 'D1');
  assert.deepEqual([table.type, table.x, table.y, table.data.text], ['table', 40, 60, 'Stop | \nMuseum | 3']);
});

test('route B: a second run creates nothing, and --dry-run writes nothing', async () => {
  const before = writes.length;
  const again = await importCards(reader.read([FIXTURE], { media: MEDIA }), { base, into: 'From Milanote' });
  assert.deepEqual(again.created, {});
  assert.deepEqual(again.skipped, first.created);

  const log = [];
  assert.equal(
    await main(
      ['--base', base, '--into', 'Dry run', '--reader', 'milanote', '--media', MEDIA, '--dry-run', FIXTURE],
      s => log.push(s)
    ),
    0
  );
  assert.match(log[log.length - 1], /would create/);
  assert.deepEqual(writes.slice(before), []);
  await assert.rejects(
    main(['--reader', 'milanote', '--media', path.join(TMP, 'nope.json'), FIXTURE]),
    /file not found/
  );
});
