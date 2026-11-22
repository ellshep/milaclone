'use strict';

// The focus order (next-phases M2.1, four bands since focus-redesign F2): one
// ranking of every open task, shared by the /focus page, the task API's
// `view=focus`, the watch and the morning digest, so they never disagree.
//
//   1. Due now: overdue (most overdue first), then due today. Nothing outranks
//      them.
//   2. Yours: tasks the owner placed at the top (`place.band` "top"), by
//      `place.order`.
//   3. Everything else: by the nightly ranking's `rank.score`, highest first;
//      unscored tasks follow, due soonest first, then starred, then oldest. The
//      ranking only ever orders this band.
//   4. Sent to bottom: `place.band` "bottom", by `place.order`.
//
// Each task's `tier` names its band: overdue, today, top, rest or bottom. Left
// out: tasks that aren't open (`status` done or stale), blank tasks, lists
// labelled "Reference", and anything inside the Templates board on Home. Dates
// are calendar days in TASK_TZ.
//
// The /focus page writes back through `markDone` and `setPlacements` (its List
// mode drag and Reset). Only those write `place`, and only the ranking writes
// `rank` (tasks-api.js PUT /api/tasks/rank); board item writes keep the stored
// ones (tasklist.js keepOrdering).

const { db, stmt, rowToItem, breadcrumb, INBOX_KEY } = require('./db');
const { normTask, isBlank, isOpen, setStatus } = require('./tasklist');

const TIER_RANK = { overdue: 0, today: 1, top: 2, rest: 3, bottom: 4 };

const tz = () => process.env.TASK_TZ || 'UTC';
const dayOf = (date, timeZone) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
const dayNum = ymd => {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
};

const hasLabel = (card, name) =>
  Array.isArray(card.data.labels) &&
  card.data.labels.some(l => String(l).trim().toLowerCase() === name.trim().toLowerCase());
const isReference = card => hasLabel(card, 'reference');
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Orders tasks. `entries` are `{ task, card, board }` already filtered to
 * rankable lists (`board` is the title of the board the list sits on);
 * `today` is YYYY-MM-DD. Returns `{ tasks, counts }`; each task is the stored
 * task plus `listId`, `listTitle`, `boardTitle`, `place` (null when not
 * placed), `tier` and `dueIn` (days, negative when overdue, null when undated).
 */
function orderTasks(entries, today) {
  const t0 = dayNum(today);
  const rows = [];
  for (const { task, card, board } of entries) {
    if (!isOpen(task) || isBlank(task)) continue;
    const dueIn = typeof task.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(task.due) ? dayNum(task.due) - t0 : null;
    const { place } = normTask(task);
    const tier = dueIn !== null && dueIn < 0 ? 'overdue' : dueIn === 0 ? 'today' : place ? place.band : 'rest';
    const listTitle = card.data.title || 'To-do';
    rows.push(
      Object.assign({}, task, {
        status: 'open',
        statusAt: task.statusAt ?? null,
        listId: card.id,
        listTitle,
        boardTitle: board || null,
        place,
        tier,
        dueIn,
      })
    );
  }
  const score = t => (t.rank && typeof t.rank === 'object' ? num(t.rank.score) : null);
  const nullsLast = (a, b, asc) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : asc ? a - b : b - a);
  rows.sort((a, b) => {
    if (a.tier !== b.tier) return TIER_RANK[a.tier] - TIER_RANK[b.tier];
    if (a.tier === 'overdue') return a.dueIn - b.dueIn;
    if (a.tier === 'top' || a.tier === 'bottom') return a.place.order - b.place.order;
    if (a.tier === 'rest') {
      const byScore = nullsLast(score(a), score(b), false);
      if (byScore) return byScore;
      const byDue = nullsLast(a.dueIn, b.dueIn, true);
      if (byDue) return byDue;
      if (!a.starred !== !b.starred) return a.starred ? -1 : 1;
    }
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
  return {
    tasks: rows,
    counts: {
      overdue: rows.filter(r => r.tier === 'overdue').length,
      dueToday: rows.filter(r => r.tier === 'today').length,
      open: rows.length,
    },
  };
}

// Whether a board's breadcrumb runs through the Templates board on Home.
const inTemplates = trail => trail.length > 1 && /^templates$/i.test((trail[1].title || '').trim());

/**
 * Every to-do card that counts for the focus order (not Reference, not under
 * Templates) as `{ card, board }`, `board` being the title of its board.
 */
function rankableCards() {
  const boards = new Map(); // canvasId → board title, or null under Templates
  const out = [];
  for (const card of stmt.todoItems.all().map(rowToItem)) {
    if (isReference(card)) continue;
    if (!boards.has(card.canvasId)) {
      const trail = breadcrumb(card.canvasId);
      boards.set(card.canvasId, inTemplates(trail) ? null : trail.at(-1)?.title || 'Board');
    }
    if (boards.get(card.canvasId) !== null) out.push({ card, board: boards.get(card.canvasId) });
  }
  return out;
}

/** The focus order as of `now`: `{ today, tasks, counts }`, tasks cut to `limit`. */
function focusView({ limit = 3, now = new Date() } = {}) {
  const today = dayOf(now, tz());
  const entries = [];
  for (const { card, board } of rankableCards()) {
    for (const task of Array.isArray(card.data.tasks) ? card.data.tasks : []) entries.push({ task, card, board });
  }
  const { tasks, counts } = orderTasks(entries, today);
  const inbox = stmt.getMeta.get(INBOX_KEY)?.value; // the ranker files only Inbox tasks (M3.3)
  for (const t of tasks) if (t.listId === inbox) t.inbox = true;
  return { today, tasks: tasks.slice(0, limit), counts };
}

/**
 * The morning digest (M5.1): the focus three plus every other overdue or
 * due-today task, at most DIGEST_MAX; `more` counts the ones cut off.
 */
const DIGEST_MAX = 8;
function digestView() {
  const due = focusView({ limit: Infinity }).tasks.filter(
    (t, i) => i < 3 || t.tier === 'overdue' || t.tier === 'today'
  );
  return { tasks: due.slice(0, DIGEST_MAX), more: Math.max(0, due.length - DIGEST_MAX) };
}

// ---- Writes from the /focus page ----------------------------------------------
// Board routes (unauthenticated like the rest of the board UI). Each runs in one
// transaction over the to-do cards, so a placement change spanning several lists
// lands whole.

const saveCard = card => stmt.updateItem.run({ ...card, data: JSON.stringify(card.data) });

/** Marks one open task done. Returns false when no open task has that id. */
function markDone(taskId) {
  return db.transaction(() => {
    for (const card of stmt.todoItems.all().map(rowToItem)) {
      const task = (Array.isArray(card.data.tasks) ? card.data.tasks : []).find(t => t.id === taskId);
      if (!task) continue;
      if (!isOpen(task)) return false;
      setStatus(task, 'done', Date.now());
      saveCard(card);
      return true;
    }
    return false;
  })();
}

/**
 * The owner's placements (List mode): the tasks in `top` get
 * `place: { band: "top", order }` 1..n in that order, those in `bottom` the same
 * with band "bottom", and every other task loses its `place`, so empty lists
 * are Reset (R12).
 */
function setPlacements({ top, bottom }) {
  const at = new Map([
    ...top.map((taskId, i) => [taskId, { band: 'top', order: i + 1 }]),
    ...bottom.map((taskId, i) => [taskId, { band: 'bottom', order: i + 1 }]),
  ]);
  db.transaction(() => {
    for (const card of stmt.todoItems.all().map(rowToItem)) {
      let changed = false;
      for (const task of Array.isArray(card.data.tasks) ? card.data.tasks : []) {
        const want = at.get(task.id);
        if (want && JSON.stringify(task.place) !== JSON.stringify(want)) {
          task.place = { ...want };
          changed = true;
        } else if (!want && 'place' in task) {
          delete task.place;
          changed = true;
        }
      }
      if (changed) saveCard(card);
    }
  })();
}

const LIMIT_MAX = 1000;
/** Parses a `limit` query value: default 3, "all" or 1..LIMIT_MAX; null when invalid. */
function parseLimit(v) {
  if (v === undefined || v === '') return 3;
  if (v === 'all') return LIMIT_MAX;
  if (!/^\d+$/.test(String(v))) return null;
  const n = Number(v);
  return n >= 1 && n <= LIMIT_MAX ? n : null;
}

module.exports = {
  orderTasks,
  focusView,
  digestView,
  markDone,
  setPlacements,
  parseLimit,
  dayOf,
  inTemplates,
  hasLabel,
  LIMIT_MAX,
};
