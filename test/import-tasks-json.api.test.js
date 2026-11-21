'use strict';

// Next phases M1.1 acceptance: the task list importer against an in-process
// server on a throwaway DATA_DIR. The fixture is made-up data.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'board-import-tasks-'));
process.env.DATA_DIR = TMP;
const TOKEN = 'import-test-token';
process.env.TASK_API_TOKEN = TOKEN;

const express = require('express');
const routes = require('../routes');
const { readFile, importLists, summary, parseArgs, main } = require('../scripts/import-tasks-json.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'tasks-import.json');

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
  fs.rmSync(TMP, { recursive: true, force: true });
});

const get = p => fetch(base + p).then(r => r.json());
const lists = async () => (await get('/api/todos')).lists;
const write = doc => {
  const f = path.join(TMP, 'in-' + Math.random().toString(36).slice(2) + '.json');
  fs.writeFileSync(f, JSON.stringify(doc));
  return f;
};

test('dry run reads only and needs no token', async () => {
  const r = await importLists(readFile(FIXTURE), { base, dryRun: true });
  assert.deepEqual(writes, []);
  assert.deepEqual(
    r.lists.map(l => [l.title, l.status]),
    [
      ['Errands', 'new'],
      ['Home repairs', 'new'],
    ]
  );
  assert.equal(r.created, 4);
  assert.equal(r.existing, 0);
});

test('imports lists onto a new board and every valid task once', async () => {
  const log = [];
  const r = await importLists(readFile(FIXTURE), { base, token: TOKEN, log: m => log.push(m) });
  assert.equal(r.created, 3);
  assert.deepEqual(r.rejected, [{ importId: 'mstodo:b2', title: 'Bad date', reason: 'dueDate is not a real date' }]);
  assert.ok(log.includes('+ board "From Microsoft To Do" (on Home)'));

  const { rootCanvasId } = await get('/api/root');
  const home = await get('/api/canvas/' + rootCanvasId);
  const board = home.items.find(it => it.type === 'board' && it._childTitle === 'From Microsoft To Do');
  const all = await lists();
  const errands = all.find(l => l.title === 'Errands');
  assert.equal(errands.canvasId, board.data.childCanvasId);
  const ink = errands.tasks.find(t => t.importId === 'mstodo:a1');
  assert.equal(ink.text, 'Buy printer ink');
  assert.equal(ink.note, 'Black only\n\n☐ Check model number');
  assert.equal(ink.due, '2026-11-28');
  assert.equal(ink.source, 'migration');
  assert.equal(errands.tasks.find(t => t.importId === 'mstodo:a2').starred, true);
  const repairs = all.find(l => l.title === 'Home repairs');
  assert.deepEqual(
    repairs.tasks.map(t => [t.text, t.tags]),
    [['Fix the squeaky door', ['house']]]
  );
});

test('a re-run reuses the lists and creates nothing', async () => {
  const before = (await lists()).length;
  const r = await importLists(readFile(FIXTURE), { base, token: TOKEN });
  assert.equal(r.created, 0);
  assert.equal(r.existing, 3);
  assert.deepEqual(
    r.lists.map(l => l.status),
    ['reused', 'reused']
  );
  assert.equal((await lists()).length, before);
  // the refused row is refused again, still reported
  assert.equal(r.rejected.length, 1);
});

test('merges into an existing list by listId; an unknown listId is reported', async () => {
  const errands = (await lists()).find(l => l.title === 'Errands');
  const f = write({
    format: 'milaclone-import/1',
    lists: [
      { name: 'Shopping', target: { listId: errands.id }, tasks: [{ importId: 'mstodo:c1', title: 'Milk' }] },
      { name: 'Gone', target: { listId: 'i_nope' }, tasks: [{ importId: 'mstodo:d1', title: 'Lost' }] },
    ],
  });
  const r = await importLists(readFile(f), { base, token: TOKEN });
  assert.equal(r.created, 1);
  assert.deepEqual(r.rejected, [{ importId: 'mstodo:d1', title: 'Lost', reason: 'listId not found' }]);
  assert.ok((await lists()).find(l => l.id === errands.id).tasks.some(t => t.text === 'Milk'));
  assert.match(summary(r, false), /missing +i_nope[\s\S]*not imported \(1\)/);
});

test('rejects malformed files with every problem listed', () => {
  const f = write({
    format: 'other',
    lists: [
      { name: '', target: {}, tasks: [{ title: 'x' }, { importId: 'a', title: 'y' }, { importId: 'a', title: 'z' }] },
      { name: 'L', target: { new: true } },
    ],
  });
  assert.throws(
    () => readFile(f),
    err => {
      for (const s of [
        'format must be',
        'lists[0].name is missing',
        'lists[0].target must be',
        'tasks[0].importId is missing',
        'tasks[2].importId a is repeated',
        'lists[1].tasks must be an array',
      ])
        assert.ok(err.message.includes(s), s);
      return true;
    }
  );
  assert.throws(() => readFile(write({ format: 'milaclone-import/1' })), /lists must be an array/);
});

test('refuses to write without a token, and on a wrong one', async () => {
  const doc = readFile(FIXTURE);
  await assert.rejects(importLists(doc, { base }), /TASK_API_TOKEN is not set/);
  const f = write({
    format: 'milaclone-import/1',
    lists: [{ name: 'Errands', target: { new: true }, tasks: [{ importId: 'mstodo:e1', title: 'New one' }] }],
  });
  await assert.rejects(importLists(readFile(f), { base, token: 'wrong' }), /refused the token \(401\)/);
  await assert.rejects(importLists(doc, { base: 'http://127.0.0.1:9', token: TOKEN }), /not reachable/);
});

test('CLI: flags, usage and exit codes', async () => {
  assert.deepEqual(parseArgs(['--base', 'http://h/', '--into', 'B', '--dry-run', 'f.json']), {
    base: 'http://h',
    into: 'B',
    dryRun: true,
    files: ['f.json'],
  });
  assert.deepEqual(parseArgs(['-h']), { help: true });
  assert.throws(() => parseArgs(['--nope']), /unknown flag/);

  const out = [];
  assert.equal(await main([], m => out.push(m)), 1);
  assert.match(out[0], /^Usage:/);
  assert.equal(await main(['--help'], () => {}), 0);

  out.length = 0;
  assert.equal(await main(['--base', base, '--dry-run', FIXTURE], m => out.push(m), {}), 0);
  assert.match(out.at(-1), /1 would be created, 3 already there/);
  // a real run with a refused row exits 2
  assert.equal(await main(['--base', base, FIXTURE], () => {}, { TASK_API_TOKEN: TOKEN }), 2);
});
