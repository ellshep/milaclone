'use strict';

// The focus order (next-phases M2.1): one ranking of every open task, shared by
// the /focus page, the task API's `view=focus`, the watch and the morning
// digest, so they never disagree.
//
//   1. Overdue (most overdue first), then due today. Fixed: nothing outranks them.
//   2. Tasks the owner placed by hand (`focusOrder`, lowest first). The nightly
//      ranking never moves them; Reset clears `focusOrder`.
//   3. Everything else by tier: due within 3 days → starred → the rest. The
//      ranker may shift a task one tier with `rankNudge` (+1 up, -1 down);
//      within a tier, higher `rankScore` first, then unscored oldest first.
//
// Left out: done, blank and `stale` tasks, lists labelled "Reference", and
// anything inside the Templates board on Home. Dates are calendar days in
// TASK_TZ.
//
// The /focus page writes back through `markDone` and `setPlacements` (its List
// mode drag and Reset).

const { db, stmt, rowToItem, breadcrumb } = require('./db');
const { isBlank } = require('./tasklist');

const SOON_DAYS = 3;
const TIERS = ['soon', 'starred', 'rest'];

const tz = () => process.env.TASK_TZ || 'UTC';
const dayOf = (date, timeZone) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
const dayNum = ymd => {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
};

const isReference = card =>
  Array.isArray(card.data.labels) && card.data.labels.some(l => String(l).trim().toLowerCase() === 'reference');
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Orders tasks. `entries` are `{ task, card, board }` already filtered to
 * rankable lists (`board` is the title of the board the list sits on);
 * `today` is YYYY-MM-DD. Returns `{ tasks, counts }`; each task is the stored
 * task plus `listId`, `listTitle`, `boardTitle`, `tier` and `dueIn` (days,
 * negative when overdue, null when undated).
 */
function orderTasks(entries, today) {
  const t0 = dayNum(today);
  const rows = [];
  for (const { task, card, board } of entries) {
    if (task.done || task.stale || isBlank(task)) continue;
    const dueIn = typeof task.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(task.due) ? dayNum(task.due) - t0 : null;
    let tier;
    if (dueIn !== null && dueIn < 0) tier = 'overdue';
    else if (dueIn === 0) tier = 'today';
    else if (num(task.focusOrder) !== null) tier = 'placed';
    else {
      const base = dueIn !== null && dueIn <= SOON_DAYS ? 0 : task.starred ? 1 : 2;
      const nudge = Math.max(-1, Math.min(1, Math.trunc(num(task.rankNudge) || 0)));
      tier = TIERS[Math.max(0, Math.min(2, base - nudge))];
    }
    const listTitle = card.data.title || 'To-do';
    rows.push(Object.assign({}, task, { listId: card.id, listTitle, boardTitle: board || null, tier, dueIn }));
  }
  const rank = { overdue: 0, today: 1, placed: 2, soon: 3, starred: 4, rest: 5 };
  rows.sort((a, b) => {
    if (a.tier !== b.tier) return rank[a.tier] - rank[b.tier];
    if (a.tier === 'overdue') return a.dueIn - b.dueIn;
    if (a.tier === 'placed') return a.focusOrder - b.focusOrder;
    if (a.tier !== 'today') {
      const sa = num(a.rankScore);
      const sb = num(b.rankScore);
      if (sa !== sb) return sa === null ? 1 : sb === null ? -1 : sb - sa;
      if (a.tier === 'soon' && a.dueIn !== b.dueIn) return a.dueIn - b.dueIn;
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
      if (task.done) return false;
      task.done = true;
      saveCard(card);
      return true;
    }
    return false;
  })();
}

/**
 * The owner's placements (List mode): the tasks in `ids` get `focusOrder` 1..n
 * in that order and every other task loses its `focusOrder`, so `[]` is Reset.
 */
function setPlacements(ids) {
  const at = new Map(ids.map((taskId, i) => [taskId, i + 1]));
  db.transaction(() => {
    for (const card of stmt.todoItems.all().map(rowToItem)) {
      let changed = false;
      for (const task of Array.isArray(card.data.tasks) ? card.data.tasks : []) {
        const want = at.get(task.id);
        if (want !== undefined && task.focusOrder !== want) {
          task.focusOrder = want;
          changed = true;
        } else if (want === undefined && 'focusOrder' in task) {
          delete task.focusOrder;
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
  LIMIT_MAX,
};
