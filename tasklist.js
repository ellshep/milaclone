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
};

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// A task is open, done or stale (set aside by the stale rule), never two at once.
const STATUSES = ['open', 'done', 'stale'];

// The task with every known field present and of the expected type; unknown
// fields (source, rank*, importId, …) pass through unchanged.
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
  };
}

const isOpen = t => normTask(t).status === 'open';
const isDone = t => normTask(t).status === 'done';

// A task written with the flags from before `status` (old rows at boot, a tab
// still running old code, an importer): `done: true` becomes `status: "done"`
// (when unknown, `statusAt` null); `done: false` and `stale` are dropped, so an
// old client that sends `done: false` for every task never reopens one.
function upgradeTask(t) {
  if (!isObj(t) || !('done' in t || 'stale' in t)) return t;
  const { done, stale, ...rest } = t; // oxlint-disable-line no-unused-vars -- dropped on purpose
  return done === true ? { ...rest, status: 'done', statusAt: rest.statusAt ?? null } : rest;
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
// and `focusOrder`, which belong to the task that kept the old one. Pass the
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
    const { importId, focusOrder, ...rest } = t; // oxlint-disable-line no-unused-vars -- dropped on purpose
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
// task id to { rankScore, rankReason, rankNudge }; a listed task gets those and
// `rankedAt`. Every other task loses `rankNudge`, so last night's moves never
// pile up. A task the owner placed (`focusOrder`) is never ranked and loses any
// nudge (N6). Returns the ids written and whether the list changed.
function applyRanks(tasks, ranks, now) {
  const written = [];
  let changed = false;
  for (const t of tasks) {
    if (!isObj(t)) continue;
    const r = Number.isFinite(t.focusOrder) ? undefined : ranks.get(t.id);
    if (r) {
      t.rankScore = r.rankScore;
      t.rankReason = r.rankReason;
      t.rankedAt = now;
      written.push(t.id);
      changed = true;
    }
    if (r && r.rankNudge) t.rankNudge = r.rankNudge;
    else if ('rankNudge' in t) {
      delete t.rankNudge;
      changed = true;
    }
  }
  return { written, changed };
}

module.exports = {
  STATUSES,
  normTask,
  isOpen,
  isDone,
  upgradeTask,
  stampStatus,
  setStatus,
  isBlank,
  withIds,
  copyTasks,
  newTask,
  merge,
  applyRanks,
};
