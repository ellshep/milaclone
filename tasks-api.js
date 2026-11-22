'use strict';

// Machine-client task API: create, list and update to-do tasks over HTTP with a
// bearer token, for integrations such as the voice-note pipeline and Alexa.
//
// There is no tasks table. A task is an entry in `items.data.tasks` of a `todo`
// card, the same lists the canvas and Quick notes edit. Tasks created here land
// in an "Inbox" todo card on Home (made on first use, its id kept in
// meta.inboxItemId) unless the request names another list. Both clients merge
// task arrays three-way (tasklist.js merge), so tasks appended here survive
// an edit made from a stale copy, and the extra fields below are passed through.

const crypto = require('crypto');
const express = require('express');
const { db, stmt, id, rootCanvasId, rowToItem } = require('./db');
const { isBlank, newTask, applyRanks } = require('./tasklist');
const { focusView, digestView, parseLimit, LIMIT_MAX } = require('./focus');

const router = express.Router();

const TITLE_MAX = 500;
const NOTE_MAX = 20000;
const SOURCE_MAX = 40;
const TAG_MAX = 60;
const TAGS_MAX = 30;
const IMPORT_ID_MAX = 200;
const RANK_REASON_MAX = 300;
const INBOX_KEY = 'inboxItemId';

// ---- Auth --------------------------------------------------------------------
// Read on every request so an unset token always disables the API rather than
// leaving it open. Compared in constant time.
function auth(req, res, next) {
  const expected = process.env.TASK_API_TOKEN || '';
  if (!expected) return res.status(503).json({ error: 'task API disabled: TASK_API_TOKEN is not set' });
  const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  const given = Buffer.from(m ? m[1].trim() : '');
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// ---- Validation ----------------------------------------------------------------
class BadRequest extends Error {}
const bad = msg => {
  throw new BadRequest(msg);
};

const tz = () => process.env.TASK_TZ || 'UTC';

function cleanTitle(v) {
  if (typeof v !== 'string' || !v.trim()) bad('title is required');
  const t = v.trim().replace(/\s+/g, ' ');
  if (t.length > TITLE_MAX) bad(`title is longer than ${TITLE_MAX} characters`);
  return t;
}

function cleanNotes(v) {
  if (v == null) return '';
  if (typeof v !== 'string') bad('notes must be a string');
  if (v.length > NOTE_MAX) bad(`notes are longer than ${NOTE_MAX} characters`);
  return v.trim();
}

function cleanTags(v) {
  if (v == null) return [];
  if (!Array.isArray(v) || v.some(t => typeof t !== 'string')) bad('tags must be an array of strings');
  const out = [];
  for (const raw of v) {
    const t = raw.trim().replace(/^#+/, '').trim();
    if (!t) continue;
    if (t.length > TAG_MAX) bad(`tag "${t.slice(0, 20)}…" is longer than ${TAG_MAX} characters`);
    if (!out.includes(t)) out.push(t);
  }
  if (out.length > TAGS_MAX) bad(`at most ${TAGS_MAX} tags`);
  return out;
}

// Tasks store a calendar date (YYYY-MM-DD), which is what both screens read. A
// full ISO datetime is converted to its local date in TASK_TZ.
function cleanDue(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') bad('dueDate must be an ISO 8601 date or null');
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) bad('dueDate is not a real date');
    return v;
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(v)) bad('dueDate must be an ISO 8601 date or null');
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) bad('dueDate must be an ISO 8601 date or null');
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    d
  );
}

function cleanBool(v, name) {
  if (typeof v !== 'boolean') bad(`${name} must be true or false`);
  return v;
}

// Priority is the task's star: `priority: "high"` stars it, any other known
// value leaves it unstarred. An explicit `starred` wins.
function starFrom(b) {
  if (b.starred !== undefined) return cleanBool(b.starred, 'starred');
  if (b.priority === undefined || b.priority === null) return undefined;
  if (typeof b.priority !== 'string' || !['low', 'normal', 'high'].includes(b.priority.toLowerCase())) {
    bad('priority must be "low", "normal" or "high"');
  }
  return b.priority.toLowerCase() === 'high';
}

function cleanSource(v) {
  if (v == null || v === '') return 'api';
  if (typeof v !== 'string') bad('source must be a string');
  const s = v.trim();
  if (!s || s.length > SOURCE_MAX) bad(`source must be 1 to ${SOURCE_MAX} characters`);
  return s;
}

function cleanImportId(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || v.length > IMPORT_ID_MAX) bad(`importId must be a string up to ${IMPORT_ID_MAX} chars`);
  return v;
}

// The nightly ranking's batch: [{ id, rankScore, rankReason, rankNudge }] →
// Map id → fields. Score a finite number or null, reason a short string or
// null, nudge -1, 0 or 1 (null counts as 0).
function cleanRanks(v) {
  if (!Array.isArray(v) || v.length > LIMIT_MAX) bad(`ranks must be an array of at most ${LIMIT_MAX}`);
  const out = new Map();
  for (const r of v) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id) bad('each rank needs an id');
    if (out.has(r.id)) bad(`task ${r.id} is ranked twice`);
    const rankScore = r.rankScore ?? null;
    if (rankScore !== null && !Number.isFinite(rankScore)) bad('rankScore must be a number or null');
    const rankReason = r.rankReason ?? null;
    if (rankReason !== null && (typeof rankReason !== 'string' || rankReason.length > RANK_REASON_MAX)) {
      bad(`rankReason must be a string up to ${RANK_REASON_MAX} characters or null`);
    }
    const rankNudge = r.rankNudge ?? 0;
    if (![-1, 0, 1].includes(rankNudge)) bad('rankNudge must be -1, 0, 1 or null');
    out.set(r.id, { rankScore, rankReason, rankNudge });
  }
  return out;
}

const normTitle = s =>
  String(s || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

// ---- Lists -------------------------------------------------------------------
const todoCards = () => stmt.todoItems.all().map(rowToItem);
const tasksOf = card => (Array.isArray(card.data.tasks) ? card.data.tasks : []);

function saveCard(card) {
  stmt.updateItem.run({
    id: card.id,
    canvasId: card.canvasId,
    parentItemId: card.parentItemId ?? null,
    type: card.type,
    x: card.x,
    y: card.y,
    w: card.w,
    h: card.h ?? null,
    z: card.z,
    color: card.color ?? null,
    data: JSON.stringify(card.data),
  });
}

// The Inbox card, made on Home if it doesn't exist or was trashed. Call inside
// a transaction.
function inboxCard() {
  const known = stmt.getMeta.get(INBOX_KEY)?.value;
  const row = known && stmt.getItem.get(known);
  if (row && row.type === 'todo') return rowToItem(row);
  const card = {
    id: id('i_'),
    canvasId: rootCanvasId(),
    parentItemId: null,
    type: 'todo',
    x: 60,
    y: 60,
    w: 240,
    h: null,
    z: Math.max(0, stmt.maxZ.get().m || 0) + 1,
    color: null,
    data: { title: 'Inbox', tasks: [] },
    createdAt: Date.now(),
  };
  stmt.insertItem.run(Object.assign({}, card, { data: JSON.stringify(card.data) }));
  stmt.setMeta.run(INBOX_KEY, card.id);
  return card;
}

const listView = (task, card) => Object.assign({}, task, { listId: card.id, listTitle: card.data.title || 'To-do' });

function findTask(taskId) {
  for (const card of todoCards()) {
    const task = tasksOf(card).find(t => t.id === taskId);
    if (task) return { card, task };
  }
  return null;
}

function log(event, fields) {
  console.log(JSON.stringify(Object.assign({ event, at: new Date().toISOString() }, fields)));
}

// Converts a thrown BadRequest into a 400; anything else is a real error.
const handle = fn => (req, res, next) => {
  try {
    fn(req, res);
  } catch (e) {
    if (e instanceof BadRequest) return res.status(400).json({ error: e.message });
    next(e);
  }
};

// ---- Routes ------------------------------------------------------------------
router.use('/api/tasks', auth);

router.post(
  '/api/tasks',
  handle((req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const text = cleanTitle(b.title);
    const note = cleanNotes(b.notes);
    const tags = cleanTags(b.tags);
    const due = cleanDue(b.dueDate);
    const starred = starFrom(b) || false;
    const source = cleanSource(b.source);
    const importId = cleanImportId(b.importId);
    if (b.dedupe !== undefined) cleanBool(b.dedupe, 'dedupe');
    if (b.listId != null && typeof b.listId !== 'string') bad('listId must be a string');

    const result = db.transaction(() => {
      const cards = todoCards();
      if (importId) {
        for (const card of cards) {
          const hit = tasksOf(card).find(t => t.importId === importId);
          if (hit) return { status: 200, body: { task: listView(hit, card), created: false } };
        }
      }
      let card;
      if (b.listId) {
        card = cards.find(c => c.id === b.listId);
        if (!card) bad('listId is not a to-do list');
      } else {
        card = inboxCard();
      }
      if (b.dedupe) {
        const key = normTitle(text);
        const hit = tasksOf(card).find(t => !t.done && normTitle(t.text) === key);
        if (hit) return { status: 200, body: { task: listView(hit, card), created: false, duplicate: true } };
      }
      const task = newTask(
        {
          text,
          starred,
          due,
          tags,
          note,
          source,
          pinned: false,
          stale: false,
          rankScore: null,
          rankReason: null,
          rankedAt: null,
          importId,
        },
        id('t_')
      );
      card.data.tasks = tasksOf(card).concat([task]);
      saveCard(card);
      return { status: 201, body: { task: listView(task, card), created: true } };
    })();

    const t = result.body.task;
    log(result.body.created ? 'task.create' : 'task.skip', {
      source,
      taskId: t.id,
      listId: t.listId,
      reason: result.body.created ? undefined : result.body.duplicate ? 'duplicate' : 'importId',
    });
    res.status(result.status).json(result.body);
  })
);

const STATUSES = { open: t => !t.done, done: t => !!t.done, all: () => true };

router.get(
  '/api/tasks',
  handle((req, res) => {
    if (req.query.view !== undefined) {
      if (req.query.view === 'digest') return res.json(digestView());
      if (req.query.view !== 'focus') bad('view must be focus or digest');
      const limit = parseLimit(req.query.limit);
      if (limit === null) bad(`limit must be 1 to ${LIMIT_MAX} or all`);
      return res.json(focusView({ limit }));
    }
    const status = req.query.status || 'open';
    const keep = STATUSES[status];
    if (!keep) bad('status must be open, done or all');
    const tasks = [];
    for (const card of todoCards()) {
      for (const t of tasksOf(card)) if (!isBlank(t) && keep(t)) tasks.push(listView(t, card));
    }
    // Due date first (undated last), then oldest first.
    tasks.sort(
      (a, b) =>
        (a.due ? 0 : 1) - (b.due ? 0 : 1) ||
        (a.due && b.due ? a.due.localeCompare(b.due) : 0) ||
        (a.createdAt || 0) - (b.createdAt || 0)
    );
    res.json({ tasks });
  })
);

// The text of the note on Home whose first line is "Focus priorities" (the
// oldest, if there are several), for the nightly ranking; null when none.
router.get('/api/tasks/priorities', (req, res) => {
  const note = stmt.itemsByCanvas
    .all(rootCanvasId())
    .map(rowToItem)
    .filter(
      it =>
        it.type === 'note' &&
        typeof it.data.text === 'string' &&
        /^focus priorities:?$/i.test(it.data.text.split('\n')[0].trim())
    )
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))[0];
  res.json({ text: note ? note.data.text : null });
});

// The nightly ranking's write, in one transaction so it lands whole or not at
// all. Listed tasks get their score, reason and nudge; every other task loses
// its nudge. Placed tasks and ids no list has are skipped and returned.
router.put(
  '/api/tasks/rank',
  handle((req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const ranks = cleanRanks(b.ranks);
    const now = Date.now();
    const written = db.transaction(() => {
      const out = new Set();
      for (const card of todoCards()) {
        const r = applyRanks(tasksOf(card), ranks, now);
        if (r.changed) saveCard(card);
        for (const taskId of r.written) out.add(taskId);
      }
      return out;
    })();
    const skipped = [...ranks.keys()].filter(taskId => !written.has(taskId));
    log('task.rank', { ranked: written.size, skipped: skipped.length });
    res.json({ ranked: written.size, skipped });
  })
);

router.patch(
  '/api/tasks/:id',
  handle((req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const patch = {};
    if (b.title !== undefined) patch.text = cleanTitle(b.title);
    if (b.notes !== undefined) patch.note = cleanNotes(b.notes);
    if (b.tags !== undefined) patch.tags = cleanTags(b.tags);
    if (b.dueDate !== undefined) patch.due = cleanDue(b.dueDate);
    if (b.done !== undefined) patch.done = cleanBool(b.done, 'done');
    if (b.pinned !== undefined) patch.pinned = cleanBool(b.pinned, 'pinned');
    const star = starFrom(b);
    if (star !== undefined) patch.starred = star;
    if (!Object.keys(patch).length) bad('nothing to update');

    const out = db.transaction(() => {
      const found = findTask(req.params.id);
      if (!found) return null;
      const { card, task } = found;
      Object.assign(task, patch);
      saveCard(card);
      return listView(task, card);
    })();
    if (!out) return res.status(404).json({ error: 'not found' });
    log('task.update', { taskId: out.id, listId: out.listId, fields: Object.keys(patch) });
    res.json({ task: out });
  })
);

module.exports = router;
