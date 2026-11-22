'use strict';

// tasklist.js through its interface: the task shape, the blank rule, ids and
// the three-way merge. Pure functions, no database.

const test = require('node:test');
const assert = require('node:assert/strict');
const { normTask, isBlank, withIds, copyTasks, newTask, merge } = require('../tasklist');

let n = 0;
const makeId = () => 'new' + n++;

test('normTask fills every known field and passes unknown ones through', () => {
  assert.deepEqual(normTask({ id: 'a', text: 'Milk', source: 'alexa' }), {
    id: 'a',
    text: 'Milk',
    source: 'alexa',
    done: false,
    starred: false,
    due: null,
    tags: [],
    note: '',
    noteStyle: {},
    createdAt: null,
    indent: 0,
    movedFrom: null,
    movedAt: null,
    movedBy: null,
    moveReason: null,
  });
  // wrong types fall back to the defaults
  const t = normTask({ text: 5, done: 1, tags: 'x', note: null, noteStyle: [], indent: 1.5 });
  assert.equal(t.text, '');
  assert.equal(t.done, true);
  assert.deepEqual(t.tags, []);
  assert.equal(t.note, '');
  assert.deepEqual(t.noteStyle, {});
  assert.equal(t.indent, 0);
  assert.equal(normTask(null).text, '');
});

test('isBlank is true for placeholder rows and junk', () => {
  assert.equal(isBlank({ text: 'Milk' }), false);
  assert.equal(isBlank({ text: '   ' }), true);
  assert.equal(isBlank({ text: 3 }), true);
  assert.equal(isBlank({}), true);
  assert.equal(isBlank(null), true);
});

test('withIds gives missing and duplicated ids fresh ones and keeps the rest', () => {
  const fine = [{ id: 'a' }, { id: 'b' }];
  assert.equal(withIds(fine, makeId), fine, 'nothing to fix returns the same array');

  const out = withIds([{ id: 'a', text: 'x' }, { text: 'no id' }, { id: 'a', text: 'dup' }, 'junk'], makeId);
  assert.equal(out.length, 3, 'non-objects are dropped');
  assert.equal(out[0].id, 'a');
  assert.equal(new Set(out.map(t => t.id)).size, 3);
  assert.equal(out[2].text, 'dup');
  assert.deepEqual(withIds('nope', makeId), []);
});

test('newTask makes an open task with an id and a creation time', () => {
  assert.deepEqual(newTask({ text: 'Milk', source: 'api' }, 't1', 123), {
    id: 't1',
    done: false,
    createdAt: 123,
    text: 'Milk',
    source: 'api',
  });
});

test('merge: filled-in defaults are not edits', () => {
  // the client's base is raw (no star), the server's copy has been starred elsewhere
  const base = [{ id: 'a', text: 'Milk', done: false }];
  const server = [{ id: 'a', text: 'Milk', done: false, starred: true, due: '2026-12-01', tags: ['shop'] }];
  // the client fills in defaults and edits only the text
  const mine = [{ ...normTask(base[0]), text: 'Oat milk' }];
  const [t] = merge(base, server, mine);
  assert.equal(t.text, 'Oat milk');
  assert.equal(t.starred, true);
  assert.equal(t.due, '2026-12-01');
  assert.deepEqual(t.tags, ['shop']);
});

test('merge: a real change to a default value still wins', () => {
  const base = [{ id: 'a', text: 'Milk', starred: true }];
  const server = [{ id: 'a', text: 'Milk', starred: true }];
  const [t] = merge(base, server, [{ id: 'a', text: 'Milk', starred: false }]);
  assert.equal(t.starred, false);
});

test('merge: adds and deletes on both sides survive, unknown fields are kept', () => {
  const base = [
    { id: 'a', text: 'Milk' },
    { id: 'b', text: 'Eggs', indent: 1 },
    { id: 'c', text: 'Gone' },
  ];
  const server = [
    { id: 'a', text: 'Milk' },
    { id: 'b', text: 'Eggs', indent: 1 },
    { id: 's', text: 'Added on the server' },
  ]; // c deleted elsewhere
  const mine = [
    { id: 'a', text: 'Milk', done: true },
    { id: 'b', text: 'Free-range eggs' }, // a client that doesn't know `indent`
    { id: 'c', text: 'Gone' },
    { id: 'm', text: 'Added here' },
  ];
  assert.deepEqual(merge(base, server, mine), [
    { id: 'a', text: 'Milk', done: true },
    { id: 'b', text: 'Free-range eggs', indent: 1 },
    { id: 'm', text: 'Added here' },
    { id: 's', text: 'Added on the server' },
  ]);
});

test('withIds can make ids unique across lists, and a renamed task drops importId and focusOrder', () => {
  const seen = new Set();
  const first = withIds([{ id: 'p1', text: 'Socks', importId: 'x', focusOrder: 1 }], makeId, seen);
  const second = withIds([{ id: 'p1', text: 'Socks', importId: 'x', focusOrder: 1 }], makeId, seen);
  assert.deepEqual(first, [{ id: 'p1', text: 'Socks', importId: 'x', focusOrder: 1 }]);
  assert.notEqual(second[0].id, 'p1');
  assert.equal(second[0].importId, undefined);
  assert.equal(second[0].focusOrder, undefined);
});

test('copyTasks gives every task a fresh id', () => {
  const orig = [{ id: 'a', text: 'Socks', importId: 'x' }, { text: 'no id' }];
  const copy = copyTasks(orig, makeId);
  assert.equal(copy.length, 2);
  assert.ok(copy.every(t => t.id && t.id !== 'a'));
  assert.equal(copy[0].text, 'Socks');
  assert.equal(copy[0].importId, undefined);
  assert.equal(orig[0].id, 'a', 'the original is untouched');
});

test('merge: a base with missing or repeated ids lets the client list win', () => {
  const server = [
    { id: 't_1', text: 'Milk' },
    { id: 't_2', text: 'Eggs' },
  ];
  const mine = [
    { id: 'r1', text: 'Milk' },
    { id: 'r2', text: 'Eggs', done: true },
  ];
  assert.deepEqual(merge([{ text: 'Milk' }, { text: 'Eggs' }], server, mine), mine);
  assert.deepEqual(
    merge(
      [
        { id: 'k', text: 'Milk' },
        { id: 'k', text: 'Eggs' },
      ],
      server,
      mine
    ),
    mine
  );
  assert.deepEqual(merge([null], server, mine), mine);
});
