'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMd, gridPos } = require('../scripts/import-milanote-md.js');

const FIXTURE = `# Ideas

Intro paragraph about the board.

# Nested Topic

## Checklist Section
- [ ] first task
- [x] done task
- [ ] third

## Notes Section
- bullet one
- bullet two

some prose

[Example Site](https://example.com)

![diagram](https://example.com/img.png)

[undefined](undefined)

# Empty Board
`;

test('parseMd maps boards, todos, notes, links, images; skips junk', () => {
  const doc = parseMd(FIXTURE);
  assert.equal(doc.title, 'Ideas');
  assert.equal(doc.blocks.length, 1);
  assert.equal(doc.blocks[0].kind, 'note');
  assert.match(doc.blocks[0].body, /Intro paragraph/);

  assert.equal(doc.boards.length, 2);
  assert.equal(doc.boards[0].title, 'Nested Topic');
  assert.equal(doc.boards[1].title, 'Empty Board');
  assert.deepEqual(doc.boards[1].blocks, []);

  const kinds = doc.boards[0].blocks.map(b => b.kind);
  assert.deepEqual(kinds, ['todo', 'note', 'link', 'image']);

  const todo = doc.boards[0].blocks[0];
  assert.equal(todo.title, 'Checklist Section');
  assert.equal(todo.tasks.length, 3);
  assert.equal(todo.tasks[0].text, 'first task');
  assert.equal(todo.tasks[0].done, false);
  assert.equal(todo.tasks[1].done, true);

  const note = doc.boards[0].blocks[1];
  assert.equal(note.title, 'Notes Section');
  assert.match(note.body, /bullet one/);
  assert.match(note.body, /some prose/);

  const link = doc.boards[0].blocks[2];
  assert.equal(link.url, 'https://example.com');
  assert.equal(link.title, 'Example Site');

  const image = doc.boards[0].blocks[3];
  assert.equal(image.url, 'https://example.com/img.png');
  assert.equal(image.alt, 'diagram');
});

test('gridPos lays out a simple 3-column grid', () => {
  assert.deepEqual(gridPos(0), { x: 60, y: 60 });
  assert.deepEqual(gridPos(3), { x: 60, y: 60 + 240 + 40 });
});
