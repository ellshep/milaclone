'use strict';

// What a to-do task is, server side. A task is an entry in a `todo` card's
// `data.tasks`; the canvas, Quick notes and the task API all write those lists.
// Every server path that reads or writes tasks goes through this module, so the
// shape, the defaults, the blank rule, ids and the merge are defined once.
//
// Stored tasks stay as minimal as their writers made them (a canvas task may
// have only id/text/status). Defaults are filled in only to compare, so a client
// that fills them in (Quick notes) and one that doesn't (the canvas) agree.

// Every field some client reads, with the value a task has when it's missing.
const DEFAULTS = {
  text: '',
  status: 'open',
  statusAt: null,
  statusReason: null,
  starred: false,
  due: null,
  tags: [],
  note: '',
  noteStyle: {},
  createdAt: null,
  indent: 0,
  place: null,
  rank: null,
  movedFrom: null,
  movedAt: null,
  movedBy: null,
  moveReason: null,
};

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// A task is open, done or stale (set aside by the stale rule), never two at once.
const STATUSES = ['open', 'done', 'stale'];

// `place` is the owner's ordering on the focus page (focus.js): `{ band, order }`,
// band "top" (yours) or "bottom" (sent to the bottom). `rank` is the nightly
// ranking's: `{ score, reason, at }`.
const BANDS = ['top', 'bottom'];
const isPlace = p => isObj(p) && BANDS.includes(p.band) && Number.isFinite(p.order);

// The task with every known field present and of the expected type; unknown
// fields (source, importId, …) pass through unchanged.
function normTask(t) {
  const src = isObj(t) ? t : {};
  return {
    ...src,
    text: typeof src.text === 'string' ? src.text : DEFAULTS.text,
    status: STATUSES.includes(src.status) ? src.status : DEFAULTS.status,
    statusAt: Number.isFinite(src.statusAt) ? src.statusAt : null,
    statusReason: typeof src.statusReason === 'string' ? src.statusReason : null,
    starred: !!src.starred,
    due: src.due || null,
    tags: Array.isArray(src.tags) ? src.tags : DEFAULTS.tags,
    note: typeof src.note === 'string' ? src.note : DEFAULTS.note,
    noteStyle: isObj(src.noteStyle) ? src.noteStyle : DEFAULTS.noteStyle,
    createdAt: src.createdAt || null,
    indent: Number.isInteger(src.indent) ? src.indent : DEFAULTS.indent,
    place: isPlace(src.place) ? src.place : null,
    rank: isObj(src.rank) ? src.rank : null,
    movedFrom: src.movedFrom || null,
    movedAt: src.movedAt || null,
    movedBy: src.movedBy || null,
    moveReason: src.moveReason || null,
  };
}

const isOpen = t => normTask(t).status === 'open';
const isDone = t => normTask(t).status === 'done';

// A task written with fields from before `status`, `place` and `rank` (old rows
// at boot, a tab still running old code, an importer).
// - With no `status`, `done` decides: done (`statusAt` null when unknown) or
//   open. With a `status` (an old tab that loaded after the deploy fills in
//   `done: false` on every task), `done` is ignored. `stale` is dropped.
// - `focusOrder` becomes `place: { band: "top", order }` (F2).
// - `rankScore`, `rankReason` and `rankedAt` become `rank: { score, reason, at }`
//   when any of them is set; `rankNudge` is dropped.
// A `status`, `place` or `rank` already there wins over the old fields.
const LEGACY = ['done', 'stale', 'focusOrder', 'rankScore', 'rankReason', 'rankedAt', 'rankNudge'];
function upgradeTask(t) {
  if (!isObj(t) || !LEGACY.some(k => k in t)) return t;
  // oxlint-disable-next-line no-unused-vars -- stale and rankNudge are dropped on purpose
  const { done, stale, focusOrder, rankScore, rankReason, rankedAt, rankNudge, ...out } = t;
  if (('done' in t || 'stale' in t) && !('status' in out)) {
    Object.assign(out, done ? { status: 'done', statusAt: out.statusAt ?? null } : { status: 'open' });
  }
  if (Number.isFinite(focusOrder) && !('place' in out)) out.place = { band: 'top', order: focusOrder };
  if ([rankScore, rankReason, rankedAt].some(v => v != null) && !('rank' in out)) {
    out.rank = { score: rankScore ?? null, reason: rankReason ?? null, at: rankedAt ?? null };
  }
  return out;
}

// `statusAt` and `statusReason` belong to the server: a write that changes a
// task's status stamps `statusAt` with now and drops the reason; any other
// write keeps the stored ones, whatever the client sent. `before` is the list
// as stored; a task it doesn't have was open. Returns a new array.
function stampStatus(tasks, before, now) {
  const prev = new Map(before.filter(isObj).map(t => [t.id, normTask(t)]));
  return tasks.map(t => {
    const p = prev.get(t.id);
    const { statusAt, statusReason, ...out } = t; // oxlint-disable-line no-unused-vars -- the client's never count
    if (normTask(t).status !== (p ? p.status : 'open')) return { ...out, statusAt: now };
    if (p && p.statusAt !== null) out.statusAt = p.statusAt;
    if (p && p.statusReason !== null) out.statusReason = p.statusReason;
    return out;
  });
}

// `place` and `rank` belong to the focus page's order route and the nightly
// ranking (PUT /api/focus/order, PUT /api/tasks/rank), never to a board write:
// every task keeps the stored ones, whatever the client sent, and a task the
// stored list doesn't have (a new card, a new task) has none. `before` is the
// list as stored. Returns a new array.
function keepOrdering(tasks, before) {
  const prev = new Map(before.filter(isObj).map(t => [t.id, t]));
  return tasks.map(t => {
    if (!isObj(t)) return t;
    const { place, rank, ...out } = t; // oxlint-disable-line no-unused-vars -- the client's never count
    const p = prev.get(t.id);
    if (p && 'place' in p) out.place = p.place;
    if (p && 'rank' in p) out.rank = p.rank;
    return out;
  });
}

// A server write's status change, stamped like stampStatus. Returns whether it changed.
function setStatus(task, status, now) {
  if (normTask(task).status === status) return false;
  Object.assign(task, { status, statusAt: now });
  delete task.statusReason;
  return true;
}

// A row with no text: the canvas editor's "type here" placeholder. Kept in the
// list, but never surfaced as a task (task API, export).
const isBlank = t => !isObj(t) || typeof t.text !== 'string' || !t.text.trim();

// Rows are keyed by id (reorder, merge, PATCH /api/tasks/:id, /focus), so every
// task needs an id no other task has. A task given a fresh id loses `importId`
// and `place`, which belong to the task that kept the old one. Pass the
// same `seen` set across lists to make ids unique across cards. Returns the same
// array when nothing needed fixing.
function withIds(tasks, makeId, seen = new Set()) {
  if (!Array.isArray(tasks)) return [];
  let changed = false;
  const out = tasks.filter(isObj).map(t => {
    if (t.id && !seen.has(t.id)) {
      seen.add(t.id);
      return t;
    }
    changed = true;
    const { importId, place, ...rest } = t; // oxlint-disable-line no-unused-vars -- dropped on purpose
    const fresh = { ...rest, id: makeId() };
    seen.add(fresh.id);
    return fresh;
  });
  return changed || out.length !== tasks.length ? out : tasks;
}

// The tasks of a copied card: every task gets a fresh id (see withIds).
const copyTasks = (tasks, makeId) => withIds(tasks, makeId, new Set(tasks.map(t => t && t.id)));

// A new open task with an id and a creation time; `fields` may add anything.
const newTask = (fields, taskId, now = Date.now()) => ({ id: taskId, status: 'open', createdAt: now, ...fields });

// Moves `task` from list card `from` to the end of list card `to` and records
// the move on it (M3.1). Callers save both cards.
function moveTask(from, to, task, movedBy, moveReason = null, now = Date.now()) {
  Object.assign(task, { movedFrom: from.id, movedAt: now, movedBy, moveReason });
  from.data.tasks = from.data.tasks.filter(t => t !== task);
  to.data.tasks = (Array.isArray(to.data.tasks) ? to.data.tasks : []).concat([task]);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Three-way merge of a task list. `base` is the list the client last got from
// the server, `mine` its edited copy, `server` what is stored now (another
// device, Quick notes or the task API may have written since). A field the
// client changed wins; every other field keeps the server's value; tasks added
// or deleted on either side stay added or deleted. Fields are compared with
// defaults filled in, so a client that adds `starred: false` hasn't edited the
// star, and only fields the client sent count, so one it doesn't know about
// (e.g. `indent` from an older Quick notes) isn't a deletion.
function merge(base, server, mine) {
  // A base with missing or repeated ids comes from a page loaded before ids were
  // repaired: it can't be matched to the server's tasks, so the client's list wins.
  const baseIds = base.map(t => isObj(t) && t.id);
  if (!baseIds.every(Boolean) || new Set(baseIds).size !== baseIds.length) return mine;
  const byId = list => new Map(list.map(t => [t.id, t]));
  const B = byId(base),
    S = byId(server),
    M = byId(mine);
  const out = [];
  for (const t of mine) {
    const b = B.get(t.id),
      s = S.get(t.id);
    if (b && !s) continue; // deleted elsewhere
    if (!b || !s) {
      out.push(t); // added here
      continue;
    }
    const nt = normTask(t),
      nb = normTask(b);
    const merged = { ...s };
    for (const k of Object.keys(t)) if (!same(nt[k], nb[k])) merged[k] = t[k];
    out.push(merged);
  }
  for (const t of server) if (!B.has(t.id) && !M.has(t.id)) out.push(t); // added elsewhere
  return out;
}

// The nightly ranking's write (PUT /api/tasks/rank) to one list. `ranks` maps a
// task id to { score, reason }; a listed task gets `rank: { score, reason, at }`.
// The ranking orders only the tasks the owner hasn't placed (R9): a task with a
// `place` is never ranked, and `place` is never written here. Returns the ids
// written and whether the list changed.
function applyRanks(tasks, ranks, now) {
  const written = [];
  for (const t of tasks) {
    const r = isObj(t) && !isPlace(t.place) ? ranks.get(t.id) : undefined;
    if (!r) continue;
    t.rank = { score: r.score, reason: r.reason, at: now };
    written.push(t.id);
  }
  return { written, changed: written.length > 0 };
}

module.exports = {
  STATUSES,
  normTask,
  isOpen,
  isDone,
  upgradeTask,
  stampStatus,
  keepOrdering,
  setStatus,
  isBlank,
  withIds,
  copyTasks,
  newTask,
  moveTask,
  merge,
  applyRanks,
};
