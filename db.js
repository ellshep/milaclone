'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'board.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Storage: a SQLite database queried directly on every request.
// ---------------------------------------------------------------------------
const id = (p = '') => p + crypto.randomBytes(9).toString('base64url');

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS canvases (
    id TEXT PRIMARY KEY, title TEXT, parentCanvasId TEXT, color TEXT, createdAt INTEGER
  );
  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY, canvasId TEXT NOT NULL, parentItemId TEXT, type TEXT,
    x INTEGER, y INTEGER, w INTEGER, h INTEGER, z INTEGER, color TEXT,
    data TEXT, createdAt INTEGER
  );
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE INDEX IF NOT EXISTS idx_items_canvas ON items(canvasId);
  CREATE INDEX IF NOT EXISTS idx_items_parent ON items(parentItemId);
`);

// Additive columns for existing DBs. `trashedBy` holds the id of the item whose
// deletion trashed the row, so restoring that item brings back exactly its subtree.
const colsOf = t => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
if (!colsOf('canvases').includes('icon')) db.exec('ALTER TABLE canvases ADD COLUMN icon TEXT');
for (const t of ['canvases', 'items']) {
  if (!colsOf(t).includes('trashedBy')) db.exec(`ALTER TABLE ${t} ADD COLUMN trashedBy TEXT`);
  if (!colsOf(t).includes('trashedAt')) db.exec(`ALTER TABLE ${t} ADD COLUMN trashedAt INTEGER`);
}

// Prepared statements (created once, reused per request). Every read skips
// trashed rows, so a trashed item or canvas looks deleted to the rest of the app.
const LIVE = 'trashedBy IS NULL';
const stmt = {
  getMeta: db.prepare(`SELECT value FROM meta WHERE key = ?`),
  setMeta: db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
                       ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
  getCanvas: db.prepare(`SELECT * FROM canvases WHERE id = ? AND ${LIVE}`),
  insertCanvas: db.prepare(`INSERT INTO canvases (id, title, parentCanvasId, color, icon, createdAt)
                            VALUES (@id, @title, @parentCanvasId, @color, @icon, @createdAt)`),
  updateCanvas: db.prepare(`UPDATE canvases SET title = @title, color = @color, icon = @icon WHERE id = @id`),
  setCanvasParent: db.prepare(`UPDATE canvases SET parentCanvasId = ? WHERE id = ?`),
  trashCanvas: db.prepare(`UPDATE canvases SET trashedBy = ?, trashedAt = ? WHERE id = ?`),
  getItem: db.prepare(`SELECT * FROM items WHERE id = ? AND ${LIVE}`),
  itemsForCanvas: db.prepare(`SELECT * FROM items WHERE canvasId = ? AND ${LIVE} ORDER BY COALESCE(z, 0), createdAt, id`),
  itemsByParent: db.prepare(`SELECT * FROM items WHERE parentItemId = ? AND ${LIVE}`),
  todoItems: db.prepare(`SELECT * FROM items WHERE type = 'todo' AND ${LIVE} ORDER BY createdAt, id`),
  itemsByCanvas: db.prepare(`SELECT * FROM items WHERE canvasId = ? AND ${LIVE}`),
  maxZ: db.prepare(`SELECT MAX(z) AS m FROM items`),
  childCount: db.prepare(`SELECT COUNT(*) AS c FROM items WHERE canvasId = ? AND parentItemId IS NULL AND ${LIVE}`),
  insertItem: db.prepare(`INSERT INTO items (id, canvasId, parentItemId, type, x, y, w, h, z, color, data, createdAt)
                          VALUES (@id, @canvasId, @parentItemId, @type, @x, @y, @w, @h, @z, @color, @data, @createdAt)`),
  updateItem: db.prepare(`UPDATE items SET canvasId=@canvasId, parentItemId=@parentItemId, x=@x, y=@y, w=@w, h=@h,
                          z=@z, color=@color, data=@data WHERE id=@id`),
  trashItem: db.prepare(`UPDATE items SET trashedBy = ?, trashedAt = ? WHERE id = ?`),
  restoreItems: db.prepare(`UPDATE items SET trashedBy = NULL, trashedAt = NULL WHERE trashedBy = ?`),
  restoreCanvases: db.prepare(`UPDATE canvases SET trashedBy = NULL, trashedAt = NULL WHERE trashedBy = ?`)
};

// Seed a root 'Home' canvas on first run.
if (!stmt.getMeta.get('rootCanvasId')) {
  const rootId = id('c_');
  db.transaction(() => {
    stmt.insertCanvas.run({ id: rootId, title: 'Home', parentCanvasId: null, color: 'slate', icon: null, createdAt: Date.now() });
    stmt.setMeta.run('rootCanvasId', rootId);
  })();
}
function rootCanvasId() {
  return stmt.getMeta.get('rootCanvasId')?.value;
}

process.on('SIGINT', () => { db.close(); process.exit(0); });
process.on('SIGTERM', () => { db.close(); process.exit(0); });

// ---------------------------------------------------------------------------
// Mapping helpers: rows <-> API objects. `data` is stored as a JSON string but
// the API (and the frontend) always work with it as an object.
// ---------------------------------------------------------------------------
function rowToItem(row) {
  return Object.assign({}, row, { data: row.data ? JSON.parse(row.data) : {} });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function breadcrumb(canvasId) {
  const trail = [];
  let cur = stmt.getCanvas.get(canvasId);
  let guard = 0;
  while (cur && guard++ < 100) {
    trail.unshift({ id: cur.id, title: cur.title });
    cur = cur.parentCanvasId ? stmt.getCanvas.get(cur.parentCanvasId) : null;
  }
  return trail;
}

function itemsForCanvas(canvasId) {
  return stmt.itemsForCanvas.all(canvasId).map(rowToItem);
}

// Collect an item's whole live subtree: the item, cards parented to it (column
// contents), and for boards every nested canvas and the items on it. Nothing is
// written here, so callers can copy a board into its own subtree without the copy
// feeding back into the walk.
function collectSubtree(itemId) {
  const items = [], canvases = [], seen = new Set();
  const addItem = (row) => {
    if (!row || seen.has(row.id)) return;
    seen.add(row.id); items.push(row);
    for (const k of stmt.itemsByParent.all(row.id)) addItem(k);
    const data = row.data ? JSON.parse(row.data) : {};
    if (row.type === 'board' && data.childCanvasId) addCanvas(data.childCanvasId);
  };
  const addCanvas = (cid) => {
    const c = stmt.getCanvas.get(cid);
    if (!c || seen.has(cid)) return;
    seen.add(cid); canvases.push(c);
    for (const r of stmt.itemsByCanvas.all(cid)) if (!r.parentItemId) addItem(r);
  };
  addItem(stmt.getItem.get(itemId));
  return { items, canvases };
}

// Move an item and its subtree to the trash. Rows are tagged with the item's id
// so `restoreItem` brings back exactly this deletion. Run inside a transaction.
function trashItemDeep(itemId) {
  const { items, canvases } = collectSubtree(itemId);
  const now = Date.now();
  for (const r of items) stmt.trashItem.run(itemId, now, r.id);
  for (const c of canvases) stmt.trashCanvas.run(itemId, now, c.id);
}
// ponytail: trash is never purged; add a "empty trash" sweep if the db grows.

function restoreItem(itemId) {
  return stmt.restoreItems.run(itemId).changes + stmt.restoreCanvases.run(itemId).changes;
}

// Deep-copy an item (and its subtree) onto `canvasId` at (x, y). Returns the new
// root item id. Run inside a transaction.
function copyItemDeep(itemId, canvasId, x, y) {
  const { items, canvases } = collectSubtree(itemId);
  const map = new Map();
  for (const r of items) map.set(r.id, id('i_'));
  for (const c of canvases) map.set(c.id, id('c_'));
  const now = Date.now();
  for (const c of canvases) {
    stmt.insertCanvas.run({ ...c, id: map.get(c.id), parentCanvasId: map.get(c.parentCanvasId) || canvasId, createdAt: now });
  }
  let z = Math.max(0, stmt.maxZ.get().m || 0);
  items.forEach((r, i) => {
    const data = r.data ? JSON.parse(r.data) : {};
    if (data.childCanvasId) data.childCanvasId = map.get(data.childCanvasId);
    const isRoot = i === 0;
    stmt.insertItem.run({
      ...r,
      id: map.get(r.id),
      canvasId: map.get(r.canvasId) || canvasId,
      parentItemId: isRoot ? null : (map.get(r.parentItemId) || null),
      x: isRoot ? x : r.x, y: isRoot ? y : r.y,
      z: isRoot ? ++z : r.z,
      data: JSON.stringify(data),
      createdAt: now
    });
  });
  return map.get(itemId);
}

// Move an item (and the cards inside it) onto another canvas. Returns false if
// that would put a board inside itself. Run inside a transaction.
function moveItemDeep(itemId, canvasId, x, y) {
  const { items, canvases } = collectSubtree(itemId);
  if (canvases.some(c => c.id === canvasId)) return false;
  const nested = new Set(canvases.map(c => c.id));
  for (const r of items) {
    if (nested.has(r.canvasId)) continue;            // lives on a nested canvas: unchanged
    const it = rowToItem(r);
    if (r.id === itemId) Object.assign(it, { x, y, parentItemId: null, z: Math.max(0, stmt.maxZ.get().m || 0) + 1 });
    it.canvasId = canvasId;
    stmt.updateItem.run({ ...it, data: JSON.stringify(it.data) });
    if (it.type === 'board' && it.data.childCanvasId) stmt.setCanvasParent.run(canvasId, it.data.childCanvasId);
  }
  return true;
}

module.exports = {
  DB_FILE, db, stmt, id, rootCanvasId,
  rowToItem, breadcrumb, itemsForCanvas, trashItemDeep, restoreItem, copyItemDeep, moveItemDeep
};
