'use strict';

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  db,
  stmt,
  id,
  rootCanvasId,
  rowToItem,
  breadcrumb,
  itemsForCanvas,
  trashItemDeep,
  restoreItem,
  emptyTrash,
  copyItemDeep,
  moveItemDeep,
  RICH_TYPES,
  toRich,
} = require('./db');
const { exportMarkdown } = require('./export-md');

const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const BOARD_ICONS = [
  'layout-grid',
  'book-open',
  'monitor',
  'clock',
  'heart',
  'house',
  'lightbulb',
  'palette',
  'briefcase',
  'sparkles',
  'glasses',
  'landmark',
  'compass',
  'camera',
  'music',
  'pen-tool',
  'layers',
  'folder',
  'star',
  'zap',
  'globe',
  'cpu',
  'leaf',
  'target',
];
const randomBoardIcon = () => BOARD_ICONS[Math.floor(Math.random() * BOARD_ICONS.length)];

const ALLOWED_UPLOAD = mime =>
  mime.startsWith('image/') ||
  mime.startsWith('text/') ||
  mime.startsWith('audio/') ||
  mime.startsWith('video/') ||
  mime === 'application/pdf' ||
  mime === 'application/msword' ||
  mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
  mime === 'application/vnd.ms-excel' ||
  mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
  mime === 'application/vnd.ms-powerpoint' ||
  mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
  mime === 'application/zip' ||
  mime === 'application/json';

const router = express.Router();

// Uploads are served from the app's own origin, so anything a browser could run
// (HTML, SVG, XML, …) is forced to download instead of rendering. Only file types
// that are inert as documents are shown inline. <img> ignores Content-Disposition,
// so SVG images still display on the canvas.
// This keys off the file express.static actually resolved, not the request URL:
// an encoded or re-cased URL (/%75ploads/x.html, /Uploads/… on a case-insensitive
// disk) can miss the route mount yet still reach an upload through the generic
// public/ handler, so server.js passes this same function to that handler too.
// Whether a file is an upload is decided by directory identity (device + inode),
// not by comparing path strings, so case folding, Unicode or symlinks can't dodge it.
const INLINE_UPLOAD =
  /\.(png|jpe?g|gif|webp|avif|bmp|pdf|txt|csv|json|mp3|m4a|wav|ogg|oga|opus|flac|mp4|m4v|webm|mov)$/i;
function isUpload(filePath) {
  try {
    const up = fs.statSync(UPLOAD_DIR);
    for (let d = path.dirname(filePath), prev; d !== prev; prev = d, d = path.dirname(d)) {
      const s = fs.statSync(d);
      if (s.ino === up.ino && s.dev === up.dev) return true;
    }
    return false;
  } catch {
    return true;
  } // can't tell: treat as untrusted
}
function setUploadHeaders(res, filePath) {
  if (!isUpload(filePath)) return;
  res.set('X-Content-Type-Options', 'nosniff');
  if (!INLINE_UPLOAD.test(filePath)) res.set('Content-Disposition', 'attachment');
}
router.use('/uploads', express.static(UPLOAD_DIR, { setHeaders: setUploadHeaders }));

// Three-way merge of a todo's task array. `base` is the list the client last got
// from the server, `mine` its edited copy, `server` what is stored now (another
// device or the Quick notes screen may have written since). Fields the client
// changed win; everything else keeps the server's value, and tasks added or
// deleted on either side stay added or deleted.
function mergeTasks(base, server, mine) {
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
      out.push(t);
      continue;
    } // added here
    const merged = Object.assign({}, s);
    // Only keys this client sent count: one it doesn't know (e.g. `indent` from
    // the canvas, edited in an older Quick notes) isn't a deletion.
    for (const k of Object.keys(t)) {
      if (JSON.stringify(t[k]) !== JSON.stringify(b[k])) merged[k] = t[k];
    }
    out.push(merged);
  }
  for (const t of server) if (!B.has(t.id) && !M.has(t.id)) out.push(t); // added elsewhere
  return out;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '').toLowerCase().replace(/[^.a-z0-9]/g, '');
    cb(null, id('img_') + ext);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_UPLOAD(file.mimetype)) return cb(null, true);
    req.rejectedType = file.mimetype || 'unknown';
    cb(null, false);
  },
});

// A card may only sit inside a live column on its own canvas, and columns
// never nest (two columns parenting each other would both vanish).
function badParent(parentItemId, canvasId, selfId, selfType) {
  if (parentItemId == null) return false;
  if (selfType === 'column') return true;
  const p = stmt.getItem.get(parentItemId);
  return !p || p.type !== 'column' || p.canvasId !== canvasId || p.id === selfId;
}

// ---- Canvas ----------------------------------------------------------------
router.get('/api/root', (req, res) => res.json({ rootCanvasId: rootCanvasId() }));

router.get('/api/canvas/:id', (req, res) => {
  const canvas = stmt.getCanvas.get(req.params.id);
  if (!canvas) return res.status(404).json({ error: 'not found' });
  const items = itemsForCanvas(canvas.id).map(it => {
    if (it.type === 'board' && it.data && it.data.childCanvasId) {
      const child = stmt.getCanvas.get(it.data.childCanvasId);
      const count = stmt.childCount.get(it.data.childCanvasId).c;
      return Object.assign({}, it, {
        _childTitle: child ? child.title : 'Board',
        _childCount: count,
        _childColor: child ? child.color : 'slate',
        _childIcon: child ? child.icon || 'layout-grid' : 'layout-grid',
      });
    }
    return it;
  });
  res.json({ canvas, items, breadcrumb: breadcrumb(canvas.id) });
});

router.patch('/api/canvas/:id', (req, res) => {
  const canvas = stmt.getCanvas.get(req.params.id);
  if (!canvas) return res.status(404).json({ error: 'not found' });
  const { title, color, icon } = req.body || {};
  if (typeof title === 'string') canvas.title = title.slice(0, 200);
  if (typeof color === 'string') canvas.color = color;
  if (typeof icon === 'string') canvas.icon = icon;
  stmt.updateCanvas.run(canvas);
  res.json(canvas);
});

// ---- Items -----------------------------------------------------------------
router.post('/api/item', (req, res) => {
  const b = req.body || {};
  if (!stmt.getCanvas.get(b.canvasId)) return res.status(400).json({ error: 'bad canvasId' });
  if (badParent(b.parentItemId, b.canvasId, null, b.type || 'note')) {
    return res.status(400).json({ error: 'bad parentItemId' });
  }

  const item = {
    id: id('i_'),
    canvasId: b.canvasId,
    parentItemId: b.parentItemId || null,
    type: b.type || 'note',
    x: Math.round(b.x || 60),
    y: Math.round(b.y || 60),
    w: Math.round(b.w || 240),
    h: b.h != null ? Math.round(b.h) : null,
    z: Math.max(0, stmt.maxZ.get().m || 0) + 1,
    color: b.color || null,
    data: b.data || {},
    createdAt: Date.now(),
  };
  if (RICH_TYPES.has(item.type)) item.data = toRich(item.data);

  db.transaction(() => {
    // A board item owns a freshly created child canvas.
    if (item.type === 'board') {
      const childId = id('c_');
      const icon = (item.data && item.data.icon) || randomBoardIcon();
      stmt.insertCanvas.run({
        id: childId,
        title: item.data.title || 'Untitled board',
        parentCanvasId: item.canvasId,
        color: item.color || 'slate',
        icon,
        createdAt: Date.now(),
      });
      item.data = { childCanvasId: childId };
    }
    stmt.insertItem.run(Object.assign({}, item, { data: JSON.stringify(item.data) }));
  })();

  if (item.type === 'board' && item.data.childCanvasId) {
    const child = stmt.getCanvas.get(item.data.childCanvasId);
    Object.assign(item, {
      _childTitle: child ? child.title : 'Board',
      _childCount: 0,
      _childColor: child ? child.color : 'slate',
      _childIcon: child ? child.icon || 'layout-grid' : 'layout-grid',
    });
  }

  res.json(item);
});

router.patch('/api/item/:id', (req, res) => {
  const row = stmt.getItem.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const it = rowToItem(row);
  const b = req.body || {};
  for (const k of ['x', 'y', 'w', 'h', 'z']) {
    if (b[k] != null) it[k] = Math.round(b[k]);
  }
  if (b.color !== undefined) it.color = b.color;
  // The one type change: a note whose text is a hex colour becomes a swatch.
  if (b.type === 'swatch' && it.type === 'note') it.type = 'swatch';
  if (b.parentItemId !== undefined) it.parentItemId = b.parentItemId;
  if (b.canvasId && stmt.getCanvas.get(b.canvasId)) it.canvasId = b.canvasId;
  // Checked only when the parent or canvas changes, so an old row with an odd
  // parent can still be edited.
  const moved = b.parentItemId !== undefined || it.canvasId !== row.canvasId;
  if (moved && badParent(it.parentItemId, it.canvasId, it.id, it.type)) {
    return res.status(400).json({ error: 'bad parentItemId' });
  }
  if (b.data && typeof b.data === 'object') {
    const stored = it.data.tasks;
    it.data = Object.assign({}, it.data, b.data);
    if (Array.isArray(b.baseTasks) && Array.isArray(b.data.tasks) && Array.isArray(stored)) {
      it.data.tasks = mergeTasks(b.baseTasks, stored, b.data.tasks);
    }
  }

  // A client from before rich text may still send title/body: rebuild the body
  // from them so the edit isn't stored somewhere nothing renders.
  if (RICH_TYPES.has(it.type) && b.data && (b.data.title != null || b.data.body != null)) {
    const { doc, text, ...rest } = it.data; // oxlint-disable-line no-unused-vars -- dropped on purpose
    it.data = toRich(rest);
  }

  const isBoard = it.type === 'board' && it.data && it.data.childCanvasId;
  db.transaction(() => {
    if (b.color !== undefined && isBoard) {
      const c = stmt.getCanvas.get(it.data.childCanvasId);
      if (c) {
        c.color = b.color;
        stmt.updateCanvas.run(c);
      }
    }
    // keep nested board canvas title/icon in sync with the card
    if (isBoard && b.data && (b.data.title != null || b.data.icon != null)) {
      const c = stmt.getCanvas.get(it.data.childCanvasId);
      if (c) {
        if (b.data.title != null) c.title = String(b.data.title).slice(0, 200);
        if (b.data.icon != null) c.icon = String(b.data.icon);
        stmt.updateCanvas.run(c);
      }
      // store title/icon only on the canvas; card reads them from there
      delete it.data.title;
      delete it.data.icon;
    }
    stmt.updateItem.run({
      id: it.id,
      canvasId: it.canvasId,
      parentItemId: it.parentItemId ?? null,
      type: it.type,
      x: it.x,
      y: it.y,
      w: it.w,
      h: it.h ?? null,
      z: it.z,
      color: it.color ?? null,
      data: JSON.stringify(it.data),
    });
  })();

  res.json(it);
});

// Bulk position update (used after multi-select drags / reflows)
router.patch('/api/items', (req, res) => {
  const updates = (req.body && req.body.updates) || [];
  for (const u of updates) {
    const row = u.parentItemId !== undefined && stmt.getItem.get(u.id);
    if (row && badParent(u.parentItemId, row.canvasId, row.id, row.type)) {
      return res.status(400).json({ error: 'bad parentItemId', id: u.id });
    }
  }
  db.transaction(() => {
    for (const u of updates) {
      const row = stmt.getItem.get(u.id);
      if (!row) continue;
      const it = rowToItem(row);
      for (const k of ['x', 'y', 'w', 'h', 'z']) if (u[k] != null) it[k] = Math.round(u[k]);
      if (u.parentItemId !== undefined) it.parentItemId = u.parentItemId;
      stmt.updateItem.run({
        id: it.id,
        canvasId: it.canvasId,
        parentItemId: it.parentItemId ?? null,
        type: it.type,
        x: it.x,
        y: it.y,
        w: it.w,
        h: it.h ?? null,
        z: it.z,
        color: it.color ?? null,
        data: JSON.stringify(it.data),
      });
    }
  })();
  res.json({ ok: true });
});

// "Delete" moves the item and its whole subtree to the trash; restore undoes it.
router.delete('/api/item/:id', (req, res) => {
  if (!stmt.getItem.get(req.params.id)) return res.status(404).json({ error: 'not found' });
  db.transaction(() => trashItemDeep(req.params.id))();
  res.json({ ok: true });
});

router.post('/api/item/:id/restore', (req, res) => {
  const row = stmt.anyItem.get(req.params.id);
  if (row && row.trashedBy === row.id && !stmt.getCanvas.get(row.canvasId)) {
    return res.status(409).json({ error: 'its board is in the trash — restore that first' });
  }
  const restored = db.transaction(() => restoreItem(req.params.id))();
  if (!restored) return res.status(404).json({ error: 'not in trash' });
  res.json(rowToItem(stmt.getItem.get(req.params.id)));
});

// Copy (deep: column cards, nested boards and everything on them) or move an
// item to { canvasId, x, y }. Used by paste, cut/paste and duplicate.
function placeTarget(req, res) {
  const b = req.body || {};
  if (!stmt.getItem.get(req.params.id)) {
    res.status(404).json({ error: 'not found' });
    return null;
  }
  if (!stmt.getCanvas.get(b.canvasId)) {
    res.status(400).json({ error: 'bad canvasId' });
    return null;
  }
  return { canvasId: b.canvasId, x: Math.round(b.x || 0), y: Math.round(b.y || 0) };
}

router.post('/api/item/:id/copy', (req, res) => {
  const t = placeTarget(req, res);
  if (!t) return;
  const newId = db.transaction(() => copyItemDeep(req.params.id, t.canvasId, t.x, t.y))();
  res.json(rowToItem(stmt.getItem.get(newId)));
});

router.post('/api/item/:id/move', (req, res) => {
  const t = placeTarget(req, res);
  if (!t) return;
  const ok = db.transaction(() => moveItemDeep(req.params.id, t.canvasId, t.x, t.y))();
  if (!ok) return res.status(400).json({ error: 'cannot move a board inside itself' });
  res.json(rowToItem(stmt.getItem.get(req.params.id)));
});

// ---- Quick notes -----------------------------------------------------------
// Every `todo` card in the tree is a Quick-notes list, wherever it sits on the
// board. The mobile Quick-notes screens read them all in one go instead of
// walking canvases; writes go back through the normal PATCH /api/item route.
router.get('/api/todos', (req, res) => {
  const lists = stmt.todoItems
    .all()
    .map(rowToItem)
    .map(it => {
      const canvas = stmt.getCanvas.get(it.canvasId);
      return {
        id: it.id,
        canvasId: it.canvasId,
        canvasTitle: canvas ? canvas.title : '',
        title: it.data.title || 'To-do',
        color: it.color || null,
        tags: Array.isArray(it.data.tags) ? it.data.tags : [],
        tasks: Array.isArray(it.data.tasks) ? it.data.tasks : [],
        createdAt: it.createdAt,
      };
    });
  res.json({ rootCanvasId: rootCanvasId(), lists });
});

// ---- Search ----------------------------------------------------------------
// Board titles and card text: rich bodies (`data.text`), titles, link URLs, file
// names and to-do tasks. Trashed rows are tagged, so `trashedBy IS NULL` skips
// them and everything inside a trashed board.
const searchItems = db.prepare(`
  SELECT id, canvasId, type, data FROM items
  WHERE trashedBy IS NULL AND type != 'board' AND (
    json_extract(data, '$.text') LIKE @q ESCAPE '\\' OR json_extract(data, '$.title') LIKE @q ESCAPE '\\'
    OR json_extract(data, '$.url') LIKE @q ESCAPE '\\' OR json_extract(data, '$.name') LIKE @q ESCAPE '\\'
    OR json_extract(data, '$.caption') LIKE @q ESCAPE '\\'
    OR EXISTS (SELECT 1 FROM json_each(items.data, '$.tasks') WHERE json_extract(value, '$.text') LIKE @q ESCAPE '\\')
  ) ORDER BY createdAt DESC LIMIT 50`);
const searchBoards = db.prepare(
  `SELECT id, title FROM canvases WHERE trashedBy IS NULL AND title LIKE @q ESCAPE '\\' ORDER BY createdAt DESC LIMIT 25`
);

// The first line of the card that contains the query (or its first line).
function snippet(data, q) {
  const lines = [data.title, data.text, data.caption, data.name, data.url, ...(data.tasks || []).map(t => t.text)]
    .filter(Boolean)
    .flatMap(s => String(s).split('\n'))
    .map(l => l.trim())
    .filter(Boolean);
  const hit = lines.find(l => l.toLowerCase().includes(q.toLowerCase())) || lines[0] || '';
  return hit.slice(0, 140);
}

router.get('/api/search', (req, res) => {
  const q = String(req.query.q || '')
    .trim()
    .slice(0, 100);
  if (!q) return res.json({ results: [] });
  const like = { q: '%' + q.replace(/[\\%_]/g, c => '\\' + c) + '%' };
  const trails = new Map(); // many results share a board
  const trail = id =>
    trails.get(id) ||
    trails
      .set(
        id,
        breadcrumb(id).map(c => c.title)
      )
      .get(id);
  const boards = searchBoards
    .all(like)
    .map(c => ({ kind: 'board', canvasId: c.id, title: c.title, path: trail(c.id) }));
  const cards = searchItems.all(like).map(r => ({
    kind: 'item',
    id: r.id,
    canvasId: r.canvasId,
    type: r.type,
    title: snippet(JSON.parse(r.data || '{}'), q),
    path: trail(r.canvasId),
  }));
  res.json({ results: [...boards, ...cards] });
});

// ---- Export ----------------------------------------------------------------
// res.attachment encodes any Unicode; only path separators and control characters go.
const fileName = s =>
  String(s || '')
    // oxlint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\\/\x00-\x1f\x7f]+/g, '')
    .trim() || 'board';

router.get('/api/canvas/:id/export.md', (req, res) => {
  // Upload links need an absolute URL. Behind Tailscale Serve the request looks
  // like plain http, so the page passes its own origin.
  const origin = /^https?:\/\/[^/?#\s]+$/.test(req.query.origin)
    ? req.query.origin
    : req.protocol + '://' + req.get('host');
  const md = exportMarkdown(req.params.id, origin);
  if (md == null) return res.status(404).json({ error: 'not found' });
  const title = stmt.getCanvas.get(req.params.id).title;
  res
    .attachment(fileName(title) + '.md')
    .type('text/markdown')
    .send(md);
});

// A consistent snapshot of the whole database (better-sqlite3's online backup).
router.get('/api/backup', async (req, res) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'milaclone-backup-')); // one per request
  const tmp = path.join(dir, 'board.db');
  try {
    await db.backup(tmp);
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    return res.status(500).json({ error: 'backup failed: ' + e.message });
  }
  const day = new Date().toISOString().slice(0, 10);
  res.download(tmp, `milaclone-${day}.db`, () => fs.rmSync(dir, { recursive: true, force: true }));
});

// ---- Trash -----------------------------------------------------------------
// One entry per delete (the item the user deleted, not everything inside it).
const trashTitle = (row, data) => {
  if (row.type === 'board') {
    const c = data.childCanvasId && stmt.anyCanvas.get(data.childCanvasId);
    return (c && c.title) || 'Board';
  }
  const t = data.title || data.name || data.body || data.text || data.url || '';
  return String(t).split('\n')[0].trim().slice(0, 80);
};

router.get('/api/trash', (req, res) => {
  const items = stmt.trashRoots.all().map(row => {
    const data = row.data ? JSON.parse(row.data) : {};
    const canvas = stmt.anyCanvas.get(row.canvasId);
    return {
      id: row.id,
      type: row.type,
      title: trashTitle(row, data),
      canvasId: row.canvasId,
      canvasTitle: canvas ? canvas.title : '',
      restorable: !!canvas && canvas.trashedBy == null,
      trashedAt: row.trashedAt,
    };
  });
  res.json({ items });
});

router.delete('/api/trash', (req, res) => {
  const { items, orphanSrcs } = db.transaction(emptyTrash)();
  let files = 0;
  for (const src of orphanSrcs) {
    if (!String(src).startsWith('/uploads/')) continue;
    try {
      fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(src)));
      files++;
    } catch {
      /* already gone */
    }
  }
  res.json({ items, files });
});

// ---- Upload ----------------------------------------------------------------
// Rejections carry a reason the client can show: 415 for a disallowed type,
// 413 over the size cap.
const uploadOne = (req, res, next) =>
  upload.single('file')(req, res, err => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File is larger than 25 MB' });
    res.status(400).json({ error: err.message });
  });

router.post('/api/upload', uploadOne, (req, res) => {
  if (req.rejectedType) {
    return res.status(415).json({ error: `${req.rejectedType} files can't be uploaded` });
  }
  if (!req.file) return res.status(400).json({ error: 'no file' });
  res.json({
    src: '/uploads/' + req.file.filename,
    name: req.file.originalname,
    mime: req.file.mimetype,
  });
});

router.get('/api/health', (req, res) => res.json({ ok: true }));

module.exports = router;
module.exports.setUploadHeaders = setUploadHeaders;
