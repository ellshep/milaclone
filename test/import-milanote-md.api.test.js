'use strict';

// Drives the importer's HTTP half (importFile → writeBlocks → tryUploadImage)
// against an in-process server on a throwaway DATA_DIR.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'board-import-'));
process.env.DATA_DIR = TMP;

const express = require('express');
const routes = require('../routes');
const { importFile, parseArgs } = require('../scripts/import-milanote-md.js');

// 1×1 transparent PNG, served as the "remote" image the importer uploads.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

const app = express();
app.use(express.json());
app.get('/fixture.png', (req, res) => res.type('png').send(PNG));
app.get('/fixture.txt', (req, res) => res.type('text').send('not an image'));
app.use(routes);

let base;
let server;
const uploaded = [];
test.before(async () => {
  await new Promise(r => {
    server = app.listen(0, '127.0.0.1', r);
  });
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => {
  server.close();
  for (const src of uploaded) fs.rmSync(path.join(__dirname, '..', 'public', src), { force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
});

const get = p => fetch(base + p).then(r => r.json());

test('importFile builds nested boards with every card kind', async () => {
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

![pic](${base}/fixture.png)

![broken](${base}/fixture.txt)
`
  );
  const { rootCanvasId } = await get('/api/root');
  const stats = { boards: 0, notes: 0, todos: 0, links: 0, images: 0, imageFallbacks: 0 };

  assert.equal(await importFile(base, rootCanvasId, md, stats), 'Ideas');
  assert.deepEqual(stats, { boards: 2, notes: 1, todos: 1, links: 1, images: 1, imageFallbacks: 1 });

  const home = await get('/api/canvas/' + rootCanvasId);
  const board = home.items.find(i => i.type === 'board' && i._childTitle === 'Ideas');
  assert.ok(board, 'top-level board created');

  const top = await get('/api/canvas/' + board.data.childCanvasId);
  assert.ok(top.items.some(i => i.type === 'note' && /Intro paragraph/.test(i.data.text)));
  const nestedCard = top.items.find(i => i.type === 'board');
  const nested = await get('/api/canvas/' + nestedCard.data.childCanvasId);

  const todo = nested.items.find(i => i.type === 'todo');
  assert.deepEqual(
    todo.data.tasks.map(t => [t.text, t.done]),
    [
      ['first', false],
      ['done', true],
    ]
  );
  const image = nested.items.find(i => i.type === 'image');
  assert.match(image.data.src, /^\/uploads\//);
  uploaded.push(image.data.src);
  // the non-image URL falls back to a link card
  assert.ok(nested.items.some(i => i.type === 'link' && i.data.title === 'broken'));
  assert.ok(nested.items.some(i => i.type === 'link' && i.data.url === 'https://example.com'));
});

test('importFile surfaces API errors', async () => {
  const md = path.join(TMP, 'orphan.md');
  fs.writeFileSync(md, '# Orphan\n');
  const stats = { boards: 0, notes: 0, todos: 0, links: 0, images: 0, imageFallbacks: 0 };
  await assert.rejects(importFile(base, 'c_missing', md, stats), /POST \/api\/item → 4\d\d/);
});

test('parseArgs reads flags and files', () => {
  assert.deepEqual(parseArgs(['--base', 'http://h:1/', '--parent', 'c_x', 'a.md', 'b.md']), {
    base: 'http://h:1',
    parent: 'c_x',
    files: ['a.md', 'b.md'],
  });
  assert.deepEqual(parseArgs(['-h']), { help: true });
  assert.throws(() => parseArgs(['--nope']), /unknown flag/);
  assert.equal(parseArgs([]).base, 'http://127.0.0.1:4321');
});
