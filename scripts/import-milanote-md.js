#!/usr/bin/env node
'use strict';

/**
 * One-shot: Milanote markdown export → milaclone via HTTP API.
 *
 *   node scripts/import-milanote-md.js --base http://127.0.0.1:8182 board.md …
 *
 * ponytail: no UI, no SQLite writes, no new deps — POST /api/item (+ optional upload).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COLS = 3;
const CELL_W = 280;
const CELL_H = 240;
const GAP = 40;
const ORIGIN_X = 60;
const ORIGIN_Y = 60;

function rid() {
  return 't_' + crypto.randomBytes(6).toString('base64url');
}

function gridPos(i) {
  return {
    x: ORIGIN_X + (i % COLS) * (CELL_W + GAP),
    y: ORIGIN_Y + Math.floor(i / COLS) * (CELL_H + GAP)
  };
}

const RE_H1 = /^#\s+(.+)$/;
const RE_H23 = /^#{2,3}\s+(.+)$/;
const RE_TASK = /^[-*]\s+\[([ xX])\]\s*(.*)$/;
const RE_BULLET = /^[-*]\s+(.*)$/;
const RE_LINK = /^\[([^\]]*)\]\(([^)]+)\)$/;
const RE_IMAGE = /^!\[([^\]]*)\]\(([^)]+)\)$/;

function isJunkLink(title, url) {
  return !url || url === 'undefined' || title === 'undefined';
}

function cleanLine(s) {
  return s.replace(/\\\s*$/, '').trim();
}

/** Peek from start until next heading; true if checkbox lines dominate. */
function sectionIsTodo(lines, start) {
  let tasks = 0;
  let other = 0;
  for (let j = start; j < lines.length; j++) {
    const raw = lines[j];
    const t = raw.trim();
    if (!t) continue;
    if (RE_H1.test(t) || RE_H23.test(t)) break;
    if (RE_TASK.test(t)) tasks++;
    else other++;
  }
  return tasks > 0 && tasks >= other;
}

function flushNote(blocks, title, bodyLines) {
  const body = bodyLines.map(cleanLine).filter(Boolean).join('\n').trim();
  // ponytail: empty ## headings produce nothing
  if (!body) return;
  blocks.push({ kind: 'note', title: title || '', body });
}

function flushTodo(blocks, title, tasks) {
  if (!tasks.length) return;
  blocks.push({
    kind: 'todo',
    title: title || 'To-do',
    tasks: tasks.map(t => ({ id: rid(), text: t.text, done: t.done }))
  });
}

/** Parse body lines (no leading H1) into content blocks. */
function parseBlocks(lines) {
  const blocks = [];
  let i = 0;
  let noteTitle = '';
  let noteBody = [];
  let todoTitle = '';
  let todoTasks = [];
  let mode = null; // 'note' | 'todo' | null

  function flush() {
    if (mode === 'todo') flushTodo(blocks, todoTitle, todoTasks);
    else if (mode === 'note' || noteBody.length || noteTitle) flushNote(blocks, noteTitle, noteBody);
    noteTitle = '';
    noteBody = [];
    todoTitle = '';
    todoTasks = [];
    mode = null;
  }

  while (i < lines.length) {
    const raw = lines[i];
    const t = raw.trim();
    i++;

    if (!t) {
      if (mode === 'note' && noteBody.length) noteBody.push('');
      continue;
    }

    const h23 = t.match(RE_H23);
    if (h23) {
      flush();
      const title = h23[1].trim();
      if (sectionIsTodo(lines, i)) {
        mode = 'todo';
        todoTitle = title;
      } else {
        mode = 'note';
        noteTitle = title;
      }
      continue;
    }

    // Nested `#` inside a board section shouldn't happen (caller splits), but ignore.
    if (RE_H1.test(t)) continue;

    const img = t.match(RE_IMAGE);
    if (img) {
      flush();
      const alt = img[1].trim();
      const url = img[2].trim();
      if (!isJunkLink(alt, url)) blocks.push({ kind: 'image', alt, url });
      continue;
    }

    const link = t.match(RE_LINK);
    if (link) {
      flush();
      const title = link[1].trim();
      const url = link[2].trim();
      if (!isJunkLink(title, url)) blocks.push({ kind: 'link', title: title || url, url });
      continue;
    }

    const task = t.match(RE_TASK);
    if (task) {
      if (mode !== 'todo') {
        flush();
        mode = 'todo';
        todoTitle = noteTitle || 'To-do';
        noteTitle = '';
      }
      todoTasks.push({ done: task[1].toLowerCase() === 'x', text: cleanLine(task[2]) });
      continue;
    }

    const bullet = t.match(RE_BULLET);
    if (bullet) {
      // Empty "-"/placeholder rows from Milanote
      if (!bullet[1].trim()) continue;
      if (mode === 'todo') {
        // stray bullet inside a todo section → treat as unchecked task text
        todoTasks.push({ done: false, text: cleanLine(bullet[1]) });
        continue;
      }
      if (mode !== 'note') {
        flush();
        mode = 'note';
      }
      noteBody.push('- ' + cleanLine(bullet[1]));
      continue;
    }

    // Prose
    if (mode === 'todo') {
      // prose mid-todo: fold into last task or skip
      if (todoTasks.length) {
        todoTasks[todoTasks.length - 1].text =
          (todoTasks[todoTasks.length - 1].text + ' ' + cleanLine(t)).trim();
      }
      continue;
    }
    if (mode !== 'note') {
      flush();
      mode = 'note';
    }
    noteBody.push(cleanLine(t));
  }

  flush();
  return blocks;
}

/**
 * Parse a Milanote markdown export.
 * @returns {{ title: string, blocks: object[], boards: { title: string, blocks: object[] }[] }}
 */
function parseMd(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;

  let title = 'Imported';
  const h1 = lines[i] && lines[i].trim().match(RE_H1);
  if (h1) {
    title = h1[1].trim();
    i++;
  }

  // Split remaining into root body + nested `#` boards
  const rootLines = [];
  const boards = [];
  let curBoard = null; // { title, lines }

  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    const m = t.match(RE_H1);
    if (m) {
      if (curBoard) boards.push(curBoard);
      curBoard = { title: m[1].trim(), lines: [] };
      continue;
    }
    if (curBoard) curBoard.lines.push(lines[i]);
    else rootLines.push(lines[i]);
  }
  if (curBoard) boards.push(curBoard);

  return {
    title,
    blocks: parseBlocks(rootLines),
    boards: boards.map(b => ({ title: b.title, blocks: parseBlocks(b.lines) }))
  };
}

// ---- API -------------------------------------------------------------------

async function apiJson(base, method, p, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(base + p, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}

async function tryUploadImage(base, url, alt) {
  try {
    const r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) return null;
    const mime = (r.headers.get('content-type') || 'image/png').split(';')[0].trim();
    if (!/^image\//.test(mime)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return null;
    const ext = mime === 'image/jpeg' ? '.jpg'
      : mime === 'image/webp' ? '.webp'
      : mime === 'image/gif' ? '.gif'
      : '.png';
    const name = (alt || 'image').replace(/[^\w.-]+/g, '_').slice(0, 60) + ext;
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: mime }), name);
    const up = await fetch(base + '/api/upload', { method: 'POST', body: fd });
    if (!up.ok) return null;
    return up.json();
  } catch {
    return null;
  }
}

async function writeBlocks(base, canvasId, blocks, stats) {
  let n = 0;
  for (const b of blocks) {
    const pos = gridPos(n++);
    if (b.kind === 'note') {
      await apiJson(base, 'POST', '/api/item', {
        canvasId, type: 'note', ...pos, w: 240,
        data: { title: b.title || '', body: b.body || '' }
      });
      stats.notes++;
    } else if (b.kind === 'todo') {
      await apiJson(base, 'POST', '/api/item', {
        canvasId, type: 'todo', ...pos, w: 240,
        data: { title: b.title || 'To-do', tasks: b.tasks }
      });
      stats.todos++;
    } else if (b.kind === 'link') {
      await apiJson(base, 'POST', '/api/item', {
        canvasId, type: 'link', ...pos, w: 240, color: 'blue',
        data: { url: b.url, title: b.title || '' }
      });
      stats.links++;
    } else if (b.kind === 'image') {
      const uploaded = await tryUploadImage(base, b.url, b.alt);
      if (uploaded && uploaded.src) {
        await apiJson(base, 'POST', '/api/item', {
          canvasId, type: 'image', ...pos, w: 280,
          data: { src: uploaded.src, name: uploaded.name || b.alt || 'image' }
        });
        stats.images++;
      } else {
        await apiJson(base, 'POST', '/api/item', {
          canvasId, type: 'link', ...pos, w: 240, color: 'blue',
          data: { url: b.url, title: b.alt || b.url }
        });
        stats.imageFallbacks++;
      }
    }
  }
}

async function importFile(base, parentCanvasId, filePath, stats) {
  const text = fs.readFileSync(filePath, 'utf8');
  const doc = parseMd(text);

  const top = await apiJson(base, 'POST', '/api/item', {
    canvasId: parentCanvasId,
    type: 'board',
    ...gridPos(stats.boards),
    w: 152,
    data: { title: doc.title }
  });
  stats.boards++;
  const rootChild = top.data.childCanvasId;
  if (!rootChild) throw new Error('board create missing childCanvasId for ' + filePath);

  await writeBlocks(base, rootChild, doc.blocks, stats);

  let bi = doc.blocks.length;
  for (const nb of doc.boards) {
    const card = await apiJson(base, 'POST', '/api/item', {
      canvasId: rootChild,
      type: 'board',
      ...gridPos(bi++),
      w: 152,
      data: { title: nb.title }
    });
    stats.boards++;
    const childId = card.data.childCanvasId;
    if (!childId) throw new Error('nested board missing childCanvasId: ' + nb.title);
    await writeBlocks(base, childId, nb.blocks, stats);
  }

  return doc.title;
}

function parseArgs(argv) {
  let base = 'http://127.0.0.1:4321';
  let parent = null;
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') base = String(argv[++i] || '').replace(/\/$/, '');
    else if (a === '--parent') parent = argv[++i];
    else if (a === '--help' || a === '-h') return { help: true };
    else if (a.startsWith('-')) throw new Error('unknown flag: ' + a);
    else files.push(a);
  }
  return { base, parent, files };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.files.length) {
    console.log(`Usage: node scripts/import-milanote-md.js [--base URL] [--parent canvasId] file.md …

Maps Milanote markdown exports into nested boards / notes / todos / links
on a running milaclone instance. Images are uploaded when the CDN allows;
otherwise a link card is created.`);
    process.exit(args.help ? 0 : 1);
  }

  for (const f of args.files) {
    if (!fs.existsSync(f)) throw new Error('file not found: ' + f);
  }

  const health = await fetch(args.base + '/api/health').then(r => r.json()).catch(() => null);
  if (!health || !health.ok) throw new Error('server not reachable at ' + args.base);

  let parent = args.parent;
  if (!parent) {
    const root = await apiJson(args.base, 'GET', '/api/root');
    parent = root.rootCanvasId;
  }

  const stats = { boards: 0, notes: 0, todos: 0, links: 0, images: 0, imageFallbacks: 0 };
  for (const f of args.files) {
    const title = await importFile(args.base, parent, f, stats);
    console.log('imported:', path.basename(f), '→', title);
  }
  console.log('done:', stats);
}

module.exports = { parseMd, parseBlocks, gridPos, rid };

if (require.main === module) {
  main().catch(err => {
    console.error(err.message || err);
    process.exit(1);
  });
}
