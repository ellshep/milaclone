'use strict';

// F4.3: notes and comments keep one rich body (data.doc + data.text). Old
// title/body rows are converted once at boot, after a backup copy.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'milaclone-rich-'));
process.env.DATA_DIR = TMP;
const { db, stmt, rootCanvasId, toRich, migrateRichText } = require('../db');

test.after(() => {
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const legacy = (id, type, data, trashedBy = null) => {
  stmt.insertItem.run({
    id,
    canvasId: rootCanvasId(),
    parentItemId: null,
    type,
    x: 0,
    y: 0,
    w: 240,
    h: null,
    z: 1,
    color: null,
    data: JSON.stringify(data),
    createdAt: Date.now(),
  });
  if (trashedBy) db.prepare('UPDATE items SET trashedBy = ? WHERE id = ?').run(trashedBy, id);
};
const para = text => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const dataOf = id => JSON.parse(db.prepare('SELECT data FROM items WHERE id = ?').get(id).data);

test('toRich turns title + body into a heading and paragraphs, and leaves rich data alone', () => {
  const r = toRich({ title: 'Plan', body: 'one\n\ntwo', keep: 1 });
  assert.equal(r.text, 'Plan\none\n\ntwo');
  assert.equal(r.keep, 1);
  assert.equal(r.title, undefined);
  assert.equal(r.body, undefined);
  assert.deepEqual(
    r.doc.content.map(n => [n.type, n.content?.[0].text]),
    [
      ['heading', 'Plan'],
      ['paragraph', 'one'],
      ['paragraph', undefined],
      ['paragraph', 'two'],
    ]
  );
  assert.deepEqual(toRich({}).doc, { type: 'doc', content: [{ type: 'paragraph' }] });
  assert.equal(toRich({ text: 'pasted' }).text, 'pasted');
  const derived = toRich({ doc: { type: 'doc', content: [para('a'), { type: 'bulletList', content: [para('b')] }] } });
  assert.equal(derived.text, 'a\nb'); // text derived when a client sends only the doc
  const rich = { doc: { type: 'doc', content: [] }, text: '' };
  assert.equal(toRich(rich), rich);
});

test('migrateRichText backs up, converts every old note/comment (trashed too) once', () => {
  assert.equal(migrateRichText(), null); // nothing old yet: no backup
  legacy('i_n', 'note', { title: 'Groceries', body: 'milk' });
  legacy('i_c', 'comment', { body: 'looks good' });
  legacy('i_t', 'note', { body: 'binned' }, 'i_t');
  legacy('i_todo', 'todo', { title: 'To-do', tasks: [] });

  const backup = migrateRichText();
  assert.ok(fs.existsSync(backup));
  const copy = new (require('better-sqlite3'))(backup, { readonly: true });
  assert.equal(JSON.parse(copy.prepare('SELECT data FROM items WHERE id = ?').get('i_n').data).title, 'Groceries');
  copy.close();

  assert.equal(dataOf('i_n').text, 'Groceries\nmilk');
  assert.equal(dataOf('i_n').doc.content[0].type, 'heading');
  assert.equal(dataOf('i_c').text, 'looks good');
  assert.equal(dataOf('i_t').text, 'binned');
  assert.deepEqual(dataOf('i_todo'), { title: 'To-do', tasks: [] });
  assert.equal(migrateRichText(), null); // one-time
});
