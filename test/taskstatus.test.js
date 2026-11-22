'use strict';

// Focus-redesign F1: tasks carry one `status` (open, done, stale). Rows from
// before it keep `done` / `stale` flags; the boot migration converts them once,
// after a VACUUM INTO backup, and later boots leave everything alone.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'milaclone-status-'));
process.env.DATA_DIR = TMP;
const { db, stmt, rootCanvasId, migrateTaskStatus } = require('../db');

test.after(() => {
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const OLD_TASKS = [
  { id: 'a', text: 'Done long ago', done: true, starred: true },
  { id: 'b', text: 'Still open', done: false },
  { id: 'c', text: 'From the task API', done: false, stale: false, source: 'voice' },
  { id: 'g', text: 'stale: true (nothing ever wrote it)', stale: true },
  { id: 'd', text: 'Never had flags' },
];
const NEW_TASKS = [
  { id: 'a', text: 'Done long ago', starred: true, status: 'done', statusAt: null },
  { id: 'b', text: 'Still open' },
  { id: 'c', text: 'From the task API', source: 'voice' },
  { id: 'g', text: 'stale: true (nothing ever wrote it)' },
  { id: 'd', text: 'Never had flags' },
];

const insert = (handle, id, type, data, trashedBy = null) =>
  handle
    .prepare(
      `INSERT INTO items (id, canvasId, type, x, y, w, z, data, createdAt, trashedBy)
       VALUES (?, (SELECT value FROM meta WHERE key = 'rootCanvasId'), ?, 0, 0, 240, 0, ?, 0, ?)`
    )
    .run(id, type, JSON.stringify(data), trashedBy);
const dataOf = (handle, id) => JSON.parse(handle.prepare('SELECT data FROM items WHERE id = ?').get(id).data);

test('migrateTaskStatus backs up first, converts every old task (trashed cards too) once', () => {
  assert.ok(rootCanvasId());
  assert.equal(migrateTaskStatus(), null); // nothing old yet: no backup
  insert(db, 'old-list', 'todo', { title: 'Old', tasks: OLD_TASKS });
  insert(db, 'old-binned', 'todo', { tasks: [{ id: 'e', text: 'Binned', done: true }] }, 'old-binned');
  insert(db, 'odd-list', 'todo', { tasks: { done: true } }); // not an array: left alone
  insert(db, 'junk-list', 'todo', { tasks: ['junk', 3, null] }); // no objects: left alone
  insert(db, 'new-list', 'todo', { tasks: [{ id: 'f', text: 'Current', status: 'done', statusAt: 5 }] });

  const backup = migrateTaskStatus();
  assert.match(path.basename(backup), /^board\.pre-status-\d+\.db$/);
  const copy = new Database(backup, { readonly: true });
  assert.deepEqual(dataOf(copy, 'old-list').tasks, OLD_TASKS, 'the backup holds the rows as they were');
  copy.close();

  assert.deepEqual(dataOf(db, 'old-list'), { title: 'Old', tasks: NEW_TASKS });
  assert.deepEqual(dataOf(db, 'old-binned').tasks, [{ id: 'e', text: 'Binned', status: 'done', statusAt: null }]);
  assert.deepEqual(dataOf(db, 'odd-list').tasks, { done: true });
  assert.deepEqual(dataOf(db, 'junk-list').tasks, ['junk', 3, null]);
  assert.deepEqual(dataOf(db, 'new-list').tasks, [{ id: 'f', text: 'Current', status: 'done', statusAt: 5 }]);
  assert.equal(migrateTaskStatus(), null, 'a second run has nothing to do and takes no backup');
  assert.ok(stmt.getItem.get('old-list'));
});

test('a real boot converts old rows; the next boot changes nothing and takes no second backup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'milaclone-status-boot-'));
  const boot = () =>
    execFileSync(process.execPath, ['-e', "require('./db').db.close()"], {
      cwd: ROOT,
      env: { ...process.env, DATA_DIR: dir },
    });
  const backups = () => fs.readdirSync(dir).filter(f => f.startsWith('board.pre-status-'));
  try {
    boot(); // a fresh database
    const seed = new Database(path.join(dir, 'board.db'));
    insert(seed, 'old-list', 'todo', { title: 'Old', tasks: OLD_TASKS });
    seed.close();
    assert.deepEqual(backups(), []);

    boot(); // the deploy after F1
    assert.equal(backups().length, 1);
    const read = new Database(path.join(dir, 'board.db'), { readonly: true });
    const once = dataOf(read, 'old-list');
    read.close();
    assert.deepEqual(once, { title: 'Old', tasks: NEW_TASKS });
    const backup = new Database(path.join(dir, backups()[0]), { readonly: true });
    assert.deepEqual(dataOf(backup, 'old-list').tasks, OLD_TASKS);
    backup.close();

    boot(); // any later restart
    assert.equal(backups().length, 1, 'no second backup');
    const again = new Database(path.join(dir, 'board.db'), { readonly: true });
    assert.deepEqual(dataOf(again, 'old-list'), once, 'no change');
    again.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
