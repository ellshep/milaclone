'use strict';

// Focus-redesign F2: the owner's ordering is `place: { band, order }` and the
// ranking's is `rank: { score, reason, at }`. Rows from before keep
// `focusOrder` and `rankScore`/`rankReason`/`rankedAt`/`rankNudge`; the boot
// migration converts them once, after a VACUUM INTO backup, and later boots
// leave everything alone.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'milaclone-order-'));
process.env.DATA_DIR = TMP;
const { db, stmt, rootCanvasId, migrateTaskOrder } = require('../db');

test.after(() => {
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const OLD_TASKS = [
  { id: 'p', text: 'Placed', focusOrder: 2, rankScore: 40, rankReason: 'Old', rankedAt: 100, rankNudge: 1 },
  { id: 'r', text: 'Ranked', rankScore: 80, rankReason: 'Matters', rankedAt: 200, rankNudge: -1, starred: true },
  { id: 's', text: 'Score only', rankScore: 0 },
  { id: 'n', text: 'From the task API', rankScore: null, rankReason: null, rankedAt: null, source: 'voice' },
  { id: 'u', text: 'Nudged, never scored', rankNudge: 1 },
  { id: 'z', text: 'Nothing old', status: 'open' },
];
const NEW_TASKS = [
  { id: 'p', text: 'Placed', place: { band: 'top', order: 2 }, rank: { score: 40, reason: 'Old', at: 100 } },
  { id: 'r', text: 'Ranked', starred: true, rank: { score: 80, reason: 'Matters', at: 200 } },
  { id: 's', text: 'Score only', rank: { score: 0, reason: null, at: null } },
  { id: 'n', text: 'From the task API', source: 'voice' },
  { id: 'u', text: 'Nudged, never scored' },
  { id: 'z', text: 'Nothing old', status: 'open' },
];

const insert = (handle, id, type, data, trashedBy = null) =>
  handle
    .prepare(
      `INSERT INTO items (id, canvasId, type, x, y, w, z, data, createdAt, trashedBy)
       VALUES (?, (SELECT value FROM meta WHERE key = 'rootCanvasId'), ?, 0, 0, 240, 0, ?, 0, ?)`
    )
    .run(id, type, JSON.stringify(data), trashedBy);
const dataOf = (handle, id) => JSON.parse(handle.prepare('SELECT data FROM items WHERE id = ?').get(id).data);

test('migrateTaskOrder backs up first, converts every old task (trashed cards too) once', () => {
  assert.ok(rootCanvasId());
  assert.equal(migrateTaskOrder(), null); // nothing old yet: no backup
  insert(db, 'old-list', 'todo', { title: 'Old', tasks: OLD_TASKS });
  insert(db, 'old-binned', 'todo', { tasks: [{ id: 'b', text: 'Binned', focusOrder: 1 }] }, 'old-binned');
  insert(db, 'odd-list', 'todo', { tasks: { focusOrder: 1 } }); // not an array: left alone
  insert(db, 'new-list', 'todo', { tasks: [{ id: 'f', text: 'Current', place: { band: 'bottom', order: 1 } }] });

  const backup = migrateTaskOrder();
  assert.match(path.basename(backup), /^board\.pre-order-\d+\.db$/);
  const copy = new Database(backup, { readonly: true });
  assert.deepEqual(dataOf(copy, 'old-list').tasks, OLD_TASKS, 'the backup holds the rows as they were');
  copy.close();

  assert.deepEqual(dataOf(db, 'old-list'), { title: 'Old', tasks: NEW_TASKS });
  assert.deepEqual(dataOf(db, 'old-binned').tasks, [{ id: 'b', text: 'Binned', place: { band: 'top', order: 1 } }]);
  assert.deepEqual(dataOf(db, 'odd-list').tasks, { focusOrder: 1 });
  assert.deepEqual(dataOf(db, 'new-list').tasks, [{ id: 'f', text: 'Current', place: { band: 'bottom', order: 1 } }]);
  assert.equal(migrateTaskOrder(), null, 'a second run has nothing to do and takes no backup');
  assert.ok(stmt.getItem.get('old-list'));
});

test('a real boot converts old rows; the next boot changes nothing and takes no second backup', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'milaclone-order-boot-'));
  const boot = () =>
    execFileSync(process.execPath, ['-e', "require('./db').db.close()"], {
      cwd: ROOT,
      env: { ...process.env, DATA_DIR: dir },
    });
  const backups = () => fs.readdirSync(dir).filter(f => f.startsWith('board.pre-'));
  const read = () => {
    const handle = new Database(path.join(dir, 'board.db'), { readonly: true });
    const data = dataOf(handle, 'old-list');
    handle.close();
    return data;
  };
  try {
    boot(); // a fresh database
    const seed = new Database(path.join(dir, 'board.db'));
    insert(seed, 'old-list', 'todo', { title: 'Old', tasks: OLD_TASKS });
    seed.close();
    assert.deepEqual(backups(), []);

    boot(); // the deploy after F2
    const once = read();
    t.diagnostic(`boot 1: backups ${JSON.stringify(backups())}`);
    t.diagnostic(`boot 1: tasks ${JSON.stringify(once.tasks)}`);
    assert.equal(backups().length, 1);
    assert.match(backups()[0], /^board\.pre-order-\d+\.db$/);
    assert.deepEqual(once, { title: 'Old', tasks: NEW_TASKS });
    const backup = new Database(path.join(dir, backups()[0]), { readonly: true });
    assert.deepEqual(dataOf(backup, 'old-list').tasks, OLD_TASKS);
    backup.close();

    boot(); // any later restart
    t.diagnostic(`boot 2: backups ${JSON.stringify(backups())}`);
    t.diagnostic(`boot 2: tasks unchanged: ${JSON.stringify(read()) === JSON.stringify(once)}`);
    assert.equal(backups().length, 1, 'no second backup');
    assert.deepEqual(read(), once, 'no change');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
