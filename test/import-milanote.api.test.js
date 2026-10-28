'use strict';

// U1.3 acceptance: the importer engine against a fixture board, through an
// in-process server on a throwaway DATA_DIR. No real Milanote data.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'board-import-u13-'));
process.env.DATA_DIR = TMP;

const express = require('express');
const routes = require('../routes');
const { importCards, mdReader, jsonReader, parseArgs, main } = require('../scripts/import-milanote.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'milanote', 'board.json');
const PNG = fs.readFileSync(path.join(__dirname, 'fixtures', 'milanote', 'pixel.png'));

// Every write the importer sends, so a test can assert there were none.
const writes = [];
const app = express();
app.use((req, res, next) => {
  if (req.method !== 'GET') writes.push(`${req.method} ${req.path}`);
  next();
});
app.get('/remote/pic.png', (req, res) => res.type('png').send(PNG));
app.get('/remote/notes.txt', (req, res) => res.type('text').send('not an image'));
app.use(routes);

let base;
let server;
test.before(async () => {
  await new Promise(r => {
    server = app.listen(0, '127.0.0.1', r);
  });
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => {
  server.close();
  // the uploads land in the real public/uploads; remove the ones this file made
  const db = require('../db');
  for (const r of db.db.prepare("SELECT json_extract(data, '$.src') AS src FROM items").all()) {
    if (r.src) fs.rmSync(path.join(__dirname, '..', 'public', r.src), { force: true });
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

const get = p => fetch(base + p).then(r => r.json());
const canvas = async id => (await get('/api/canvas/' + id)).items;
const bySource = (items, sid) => items.find(i => i.data && i.data.sourceId === sid);
async function staging(title) {
  const { rootCanvasId } = await get('/api/root');
  const card = (await canvas(rootCanvasId)).find(i => i.type === 'board' && i._childTitle === title);
  return card && card.data.childCanvasId;
}

let first;
test('json reader + engine: types and positions', async () => {
  first = await importCards(jsonReader.read([FIXTURE]), { base, into: 'From Milanote' });
  assert.deepEqual(first.created, {
    board: 3,
    note: 1,
    column: 1,
    todo: 1,
    image: 1,
    swatch: 1,
    file: 1,
    table: 1,
    comment: 1,
    line: 2,
    shortcut: 1,
  });
  assert.deepEqual(first.skipped, {});
  assert.deepEqual(first.missed.map(m => m.sourceId).sort(), ['f-exe', 'f-gone', 'l-lost', 'sc-gone', 'u-voice']);

  const stage = await staging('From Milanote');
  assert.ok(stage, 'staging board made on Home');
  const trip = bySource(await canvas(stage), 'b-trip');
  assert.equal(trip._childTitle, 'Trip');
  assert.equal(trip._childColor, 'teal');
  assert.equal(trip._childIcon, 'compass');
  assert.deepEqual([trip.x, trip.y], [60, 60]);

  const items = await canvas(trip.data.childCanvasId);
  const note = bySource(items, 'n-plan');
  assert.deepEqual([note.type, note.x, note.y, note.w], ['note', 100, 120, 260]);
  assert.equal(note.data.text, 'Plan\nPack light');
  const col = bySource(items, 'c-pack');
  assert.deepEqual([col.type, col.x, col.y, col.data.collapsed], ['column', 420, 80, true]);
  assert.equal(bySource(items, 's-blue').data.hex, '#2f6df0');
  assert.deepEqual(bySource(items, 'tb-cost').data.rows[1], ['Train', '40']);

  const file = bySource(items, 'f-list');
  assert.deepEqual([file.type, file.data.name, file.data.mime], ['file', 'packing.txt', 'text/plain']);
  assert.match(file.data.src, /^\/uploads\/.+\.txt$/);
  const image = bySource(items, 'i-map');
  assert.deepEqual([image.type, image.data.caption, image.data.mime], ['image', 'Map', 'image/png']);

  const attached = bySource(items, 'l-plan');
  assert.deepEqual(attached.data.from, { id: note.id });
  assert.deepEqual(attached.data.to, { id: col.id });
  assert.equal(attached.data.arrow, 'end');
  assert.deepEqual(bySource(items, 'l-free').data.to, { x: 900, y: 40 });
  assert.equal(bySource(items, 'l-lost'), undefined);
  assert.equal(bySource(items, 'u-voice'), undefined);
});

test('json reader + engine: nesting', async () => {
  const trip = bySource(await canvas(await staging('From Milanote')), 'b-trip');
  const items = await canvas(trip.data.childCanvasId);
  const col = bySource(items, 'c-pack');
  const inCol = items.filter(i => i.parentItemId === col.id).sort((a, b) => a.y - b.y);
  assert.deepEqual(
    inCol.map(i => i.data.sourceId),
    ['t-bag', 'i-map']
  );
  assert.equal(bySource(items, 'n-plan').parentItemId, null);

  const days = bySource(items, 'b-days');
  const day1 = bySource(await canvas(days.data.childCanvasId), 'b-day1');
  assert.equal(day1._childTitle, 'Day 1');
  const deep = await canvas(day1.data.childCanvasId);
  assert.deepEqual(
    deep.map(i => [i.type, i.data.text, i.data.sourceId]),
    [['comment', 'Museum', 'n-museum']]
  );
  // the shortcut points at the nested board it was given
  const sc = bySource(items, 'sc-day1');
  assert.equal(sc._target.title, 'Day 1');
  assert.equal(sc.data.targetCanvasId, day1.data.childCanvasId);
});

test('a second run creates nothing', async () => {
  const before = writes.length;
  const again = await importCards(jsonReader.read([FIXTURE]), { base, into: 'From Milanote' });
  // nothing new; only setup.exe, which the server refused last time, is tried (and refused) again
  assert.deepEqual(writes.slice(before), ['POST /api/upload']);
  assert.deepEqual(again.created, {});
  assert.deepEqual(
    again.missed.map(m => m.sourceId),
    first.missed.map(m => m.sourceId)
  );
  assert.deepEqual(again.skipped, first.created);
});

test('--dry-run makes no writes, before or after a real run', async () => {
  const before = writes.length;
  const log = [];
  // into a staging board that doesn't exist yet: everything is planned as new
  const fresh = await importCards(jsonReader.read([FIXTURE]), {
    base,
    into: 'Dry staging',
    dryRun: true,
    log: s => log.push(s),
  });
  // the plan can't know the server will refuse setup.exe's type
  assert.deepEqual(fresh.created, { ...first.created, file: 2 });
  assert.ok(log.includes('+ board "Dry staging" (staging, on Home)'));
  assert.ok(log.includes('    + note "Plan"'), log.join('\n'));
  // into the real staging board: everything is already there
  const done = await importCards(jsonReader.read([FIXTURE]), { base, into: 'From Milanote', dryRun: true });
  assert.deepEqual(done.created, { file: 1 }, 'only the refused setup.exe would be tried again');
  assert.deepEqual(writes.slice(before), []);
  assert.equal(await staging('Dry staging'), undefined);
});

test('md reader: Milanote Markdown through the same engine', async () => {
  const md = path.join(TMP, 'ideas.md');
  fs.writeFileSync(
    md,
    `# Ideas

Intro paragraph.

# Nested

## Checklist
- [ ] first
- [x] done

[Example](https://example.com)

![pic](${base}/remote/pic.png)

![notes](${base}/remote/notes.txt)

![](http://127.0.0.1:1/unreachable.png)
`
  );
  const cards = mdReader.read([md]);
  assert.equal(cards[0].sourceId, 'md:ideas.md');
  const r = await importCards(cards, { base });
  assert.deepEqual(r.created, { board: 2, note: 1, todo: 1, link: 3, image: 1 });
  assert.equal(r.missed.length, 2, 'the two images that stayed links are reported');

  const { rootCanvasId } = await get('/api/root');
  const ideas = bySource(await canvas(rootCanvasId), 'md:ideas.md');
  const top = await canvas(ideas.data.childCanvasId);
  assert.match(bySource(top, 'md:ideas.md/1').data.text, /Intro paragraph/);
  const nested = await canvas(bySource(top, 'md:ideas.md#1').data.childCanvasId);
  const todo = bySource(nested, 'md:ideas.md#1/1');
  assert.deepEqual([todo.type, todo.x, todo.y], ['todo', 60, 60]);
  const image = nested.find(i => i.type === 'image');
  assert.equal(image.data.caption, 'pic');
  assert.match(image.data.src, /^\/uploads\/.+\.png$/);
  assert.ok(nested.some(i => i.type === 'link' && i.data.title === 'notes'));

  const before = writes.length;
  assert.deepEqual((await importCards(mdReader.read([md]), { base })).created, {});
  assert.deepEqual(writes.slice(before), []);
});

test('main: usage, dry run and errors', async () => {
  const out = [];
  const log = s => out.push(s);
  assert.equal(await main(['--help'], log), 0);
  assert.equal(await main([], log), 1);
  assert.match(out[0], /Usage/);

  const before = writes.length;
  assert.equal(await main(['--base', base, '--reader', 'json', '--dry-run', FIXTURE], log), 0);
  assert.deepEqual(writes.slice(before), []);
  const report = out[out.length - 1];
  assert.match(report, /would create \/ already there/);
  assert.match(report, /voice-memo u-voice: no milaclone card type/);

  await assert.rejects(main(['missing.md'], log), /file not found/);
  await assert.rejects(importCards([], { base: 'http://127.0.0.1:1' }), /server not reachable/);
});

test('parseArgs reads flags and files', () => {
  assert.deepEqual(parseArgs(['--base', 'http://h:1/', '--into', 'From Milanote', '--dry-run', 'a.md']), {
    base: 'http://h:1',
    into: 'From Milanote',
    reader: 'md',
    media: null,
    dryRun: true,
    files: ['a.md'],
  });
  assert.deepEqual(parseArgs(['-h']), { help: true });
  assert.throws(() => parseArgs(['--nope']), /unknown flag/);
  assert.throws(() => parseArgs(['--reader', 'html']), /unknown reader/);
  assert.equal(parseArgs(['--reader', 'milanote', '--media', 'm.json', 'c.json']).media, 'm.json');
});
