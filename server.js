'use strict';

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 4321;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
const DB_FILE = path.join(DATA_DIR, 'board.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Storage: a single JSON document held in memory and flushed atomically.
// ---------------------------------------------------------------------------
const id = (p = '') => p + crypto.randomBytes(9).toString('base64url');

let db;
function loadDb() {
  if (fs.existsSync(DB_FILE)) {
    try {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
      const backup = DB_FILE + '.corrupt-' + Date.now();
      fs.copyFileSync(DB_FILE, backup);
      console.error('board.json was unreadable; backed up to', backup);
      db = null;
    }
  }
  if (!db || !db.canvases || !db.items) {
    const rootId = id('c_');
    db = {
      rootCanvasId: rootId,
      canvases: {
        [rootId]: { id: rootId, title: 'Home', parentCanvasId: null, color: 'slate', createdAt: Date.now() }
      },
      items: {}
    };
    flush();
  }
  if (!db.rootCanvasId) {
    db.rootCanvasId = Object.values(db.canvases).find(c => !c.parentCanvasId)?.id;
  }
}

let flushTimer = null;
function flush() {
  // Atomic write: temp file then rename so a crash mid-write can't corrupt data.
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; flush(); }, 250);
}

loadDb();
process.on('SIGINT', () => { flush(); process.exit(0); });
process.on('SIGTERM', () => { flush(); process.exit(0); });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function breadcrumb(canvasId) {
  const trail = [];
  let cur = db.canvases[canvasId];
  let guard = 0;
  while (cur && guard++ < 100) {
    trail.unshift({ id: cur.id, title: cur.title });
    cur = cur.parentCanvasId ? db.canvases[cur.parentCanvasId] : null;
  }
  return trail;
}

function itemsForCanvas(canvasId) {
  return Object.values(db.items)
    .filter(it => it.canvasId === canvasId)
    .sort((a, b) => (a.z || 0) - (b.z || 0));
}

// Recursively collect a canvas and all canvases nested beneath it.
function collectDescendantCanvases(canvasId, acc) {
  acc.add(canvasId);
  for (const it of Object.values(db.items)) {
    if (it.canvasId === canvasId && it.type === 'board' && it.data && it.data.childCanvasId) {
      collectDescendantCanvases(it.data.childCanvasId, acc);
    }
  }
  return acc;
}

function deleteItemDeep(itemId) {
  const it = db.items[itemId];
  if (!it) return;
  // delete children parented to this item (e.g. cards inside a column)
  for (const child of Object.values(db.items)) {
    if (child.parentItemId === itemId) deleteItemDeep(child.id);
  }
  // if it owns a nested board canvas, remove that whole subtree
  if (it.type === 'board' && it.data && it.data.childCanvasId) {
    const canvases = collectDescendantCanvases(it.data.childCanvasId, new Set());
    for (const cid of canvases) {
      for (const sub of Object.values(db.items)) {
        if (sub.canvasId === cid) delete db.items[sub.id];
      }
      delete db.canvases[cid];
    }
  }
  delete db.items[itemId];
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '').toLowerCase().replace(/[^.a-z0-9]/g, '');
    cb(null, id('img_') + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype))
});

// ---- Canvas ----------------------------------------------------------------
app.get('/api/root', (req, res) => res.json({ rootCanvasId: db.rootCanvasId }));

app.get('/api/canvas/:id', (req, res) => {
  const canvas = db.canvases[req.params.id];
  if (!canvas) return res.status(404).json({ error: 'not found' });
  const items = itemsForCanvas(canvas.id).map(it => {
    if (it.type === 'board' && it.data && it.data.childCanvasId) {
      const child = db.canvases[it.data.childCanvasId];
      const count = Object.values(db.items).filter(x => x.canvasId === it.data.childCanvasId && !x.parentItemId).length;
      return Object.assign({}, it, { _childTitle: child ? child.title : 'Board', _childCount: count, _childColor: child ? child.color : 'slate' });
    }
    return it;
  });
  res.json({ canvas, items, breadcrumb: breadcrumb(canvas.id) });
});

app.patch('/api/canvas/:id', (req, res) => {
  const canvas = db.canvases[req.params.id];
  if (!canvas) return res.status(404).json({ error: 'not found' });
  const { title, color } = req.body || {};
  if (typeof title === 'string') canvas.title = title.slice(0, 200);
  if (typeof color === 'string') canvas.color = color;
  scheduleFlush();
  res.json(canvas);
});

// ---- Items -----------------------------------------------------------------
app.post('/api/item', (req, res) => {
  const b = req.body || {};
  if (!db.canvases[b.canvasId]) return res.status(400).json({ error: 'bad canvasId' });

  const item = {
    id: id('i_'),
    canvasId: b.canvasId,
    parentItemId: b.parentItemId || null,
    type: b.type || 'note',
    x: Math.round(b.x || 60),
    y: Math.round(b.y || 60),
    w: Math.round(b.w || 240),
    h: b.h != null ? Math.round(b.h) : null,
    z: (Math.max(0, ...Object.values(db.items).map(i => i.z || 0)) + 1),
    color: b.color || null,
    data: b.data || {},
    createdAt: Date.now()
  };

  // A board item owns a freshly created child canvas.
  if (item.type === 'board') {
    const childId = id('c_');
    db.canvases[childId] = {
      id: childId,
      title: item.data.title || 'Untitled board',
      parentCanvasId: item.canvasId,
      color: item.color || 'slate',
      createdAt: Date.now()
    };
    item.data = { childCanvasId: childId };
  }

  db.items[item.id] = item;
  scheduleFlush();
  res.json(item);
});

app.patch('/api/item/:id', (req, res) => {
  const it = db.items[req.params.id];
  if (!it) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  for (const k of ['x', 'y', 'w', 'h', 'z']) {
    if (b[k] != null) it[k] = Math.round(b[k]);
  }
  if (b.color !== undefined) {
    it.color = b.color;
    if (it.type === 'board' && it.data && it.data.childCanvasId) {
      const c = db.canvases[it.data.childCanvasId];
      if (c) c.color = b.color;
    }
  }
  if (b.parentItemId !== undefined) it.parentItemId = b.parentItemId;
  if (b.canvasId && db.canvases[b.canvasId]) it.canvasId = b.canvasId;
  if (b.data && typeof b.data === 'object') it.data = Object.assign({}, it.data, b.data);

  // keep nested board canvas title in sync with the card label
  if (it.type === 'board' && b.data && b.data.title != null && it.data.childCanvasId) {
    const c = db.canvases[it.data.childCanvasId];
    if (c) c.title = String(b.data.title).slice(0, 200);
    // store title only on the canvas; card reads it from there
    delete it.data.title;
  }
  scheduleFlush();
  res.json(it);
});

// Bulk position update (used after multi-select drags / reflows)
app.patch('/api/items', (req, res) => {
  const updates = (req.body && req.body.updates) || [];
  for (const u of updates) {
    const it = db.items[u.id];
    if (!it) continue;
    for (const k of ['x', 'y', 'w', 'h', 'z']) if (u[k] != null) it[k] = Math.round(u[k]);
    if (u.parentItemId !== undefined) it.parentItemId = u.parentItemId;
  }
  scheduleFlush();
  res.json({ ok: true });
});

app.delete('/api/item/:id', (req, res) => {
  if (!db.items[req.params.id]) return res.status(404).json({ error: 'not found' });
  deleteItemDeep(req.params.id);
  scheduleFlush();
  res.json({ ok: true });
});

// ---- Upload ----------------------------------------------------------------
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no image' });
  res.json({ src: '/uploads/' + req.file.filename, name: req.file.originalname });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, HOST, () => {
  console.log(`\n  Canvas board running at http://${HOST}:${PORT}`);
  console.log(`  Data stored in ${DB_FILE}\n`);
});
