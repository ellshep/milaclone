#!/usr/bin/env node
'use strict';

/**
 * Milanote → milaclone importer engine (U1.3).
 *
 *   node scripts/import-milanote.js [--base URL] [--into "From Milanote"] [--reader md|json] [--dry-run] source …
 *
 * A reader turns its sources into a card tree; the engine writes that tree
 * through the HTTP API only (POST /api/item, POST /api/upload, PATCH /api/item/:id).
 * Every item it creates carries data.sourceId, and a source id already on the
 * target canvas is skipped, so a re-run creates nothing.
 *
 * Card tree (what a reader returns: the cards for the target canvas):
 *   card = { sourceId, type, x, y, w?, h?, color?, data?,
 *            items?: card[],                    // board: what's on it; column: the cards in it
 *            file?: { path | url, name?, mime? } // image/file: uploaded before the card is made
 *            from?, to?: { ref } | { x, y }      // line ends; ref = a sourceId on the same board
 *            target?,                           // shortcut: sourceId of the board it points at
 *            missing? }                         // why it can't be imported: reported, not created
 * Board cards take their title and icon from data (colour from color), as
 * POST /api/item does.
 */

const fs = require('fs');
const path = require('path');
const { parseMd, gridPos } = require('./import-milanote-md.js');

// Every card type milaclone renders. A card of any other type is reported,
// never dropped silently.
const TYPES = new Set([
  'note',
  'todo',
  'link',
  'image',
  'file',
  'column',
  'line',
  'board',
  'shortcut',
  'swatch',
  'table',
  'document',
  'sketch',
  'comment',
]);

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

// ---- Readers ---------------------------------------------------------------

/** Route A: Milanote's per-board Markdown export, parsed by import-milanote-md.js. */
const mdReader = {
  name: 'md',
  read(files) {
    return files.map((f, i) => {
      const doc = parseMd(fs.readFileSync(f, 'utf8'));
      const id = 'md:' + path.basename(f);
      const nested = doc.boards.map((b, j) =>
        mdBoard(`${id}#${j + 1}`, b.title, b.blocks, gridPos(doc.blocks.length + j))
      );
      const top = mdBoard(id, doc.title, doc.blocks, gridPos(i));
      top.items.push(...nested);
      return top;
    });
  },
};

function mdBoard(sourceId, title, blocks, pos) {
  return {
    sourceId,
    type: 'board',
    ...pos,
    w: 152,
    data: { title },
    items: blocks.map((b, i) => mdCard(`${sourceId}/${i + 1}`, b, gridPos(i))),
  };
}

function mdCard(sourceId, b, pos) {
  const card = { sourceId, ...pos, w: 240 };
  if (b.kind === 'todo') return { ...card, type: 'todo', data: { title: b.title, tasks: b.tasks } };
  if (b.kind === 'link') return { ...card, type: 'link', color: 'blue', data: { url: b.url, title: b.title } };
  if (b.kind === 'image') {
    return { ...card, type: 'image', w: 280, data: b.alt ? { caption: b.alt } : {}, file: { url: b.url, name: b.alt } };
  }
  return { ...card, type: 'note', data: { title: b.title, body: b.body } };
}

/** A card tree saved as JSON (an array of cards); file paths are relative to the JSON file. */
const jsonReader = {
  name: 'json',
  read(files) {
    return files.flatMap(f => {
      const dir = path.dirname(path.resolve(f));
      const resolve = card => {
        if (card.file && card.file.path) card.file.path = path.resolve(dir, card.file.path);
        (card.items || []).forEach(resolve);
        return card;
      };
      return JSON.parse(fs.readFileSync(f, 'utf8')).map(resolve);
    });
  },
};

const READERS = { md: mdReader, json: jsonReader };

// ---- HTTP ------------------------------------------------------------------

async function api(base, method, p, body) {
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

/** Reads (or downloads) one file and uploads it; returns { src, name, mime } or throws. Callers go one file at a time. */
async function upload(base, file, imageOnly) {
  let buf;
  let mime = file.mime;
  let name = file.name;
  if (file.path) {
    buf = fs.readFileSync(file.path);
    name = name || path.basename(file.path);
  } else {
    const r = await fetch(file.url, { redirect: 'follow' });
    if (!r.ok) throw new Error(`download ${r.status}`);
    mime = mime || (r.headers.get('content-type') || '').split(';')[0].trim();
    buf = Buffer.from(await r.arrayBuffer());
    name = name || decodeURIComponent(new URL(file.url).pathname.split('/').pop() || '') || 'file';
  }
  mime = mime || MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
  if (imageOnly && !mime.startsWith('image/')) throw new Error('not an image: ' + mime);
  if (file.url && !path.extname(name)) name += Object.keys(MIME).find(ext => MIME[ext] === mime) || '';
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime }), name);
  const r = await fetch(base + '/api/upload', { method: 'POST', body: fd });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error || `upload ${r.status}`);
  return out;
}

// ---- Engine ----------------------------------------------------------------

const label = card => {
  const d = card.data || {};
  const s = String(d.title || d.text || d.body || d.url || d.hex || (card.file && card.file.name) || card.sourceId);
  return s.length > 48 ? s.slice(0, 47) + '…' : s;
};

/**
 * Writes `cards` under Home (or under the board titled `into` on Home, made if
 * missing). With dryRun, reads only: logs the plan and counts, writes nothing.
 * @returns {{ created: object, skipped: object, missed: { sourceId, type, reason }[] }}
 */
async function importCards(cards, { base, into = null, dryRun = false, log = () => {} }) {
  const run = { base, dryRun, log, created: {}, skipped: {}, missed: [], boards: new Map(), shortcuts: [] };
  const health = await api(base, 'GET', '/api/health').catch(() => null);
  if (!health || !health.ok) throw new Error('server not reachable at ' + base);

  let canvasId = (await api(base, 'GET', '/api/root')).rootCanvasId;
  if (into) {
    const home = await api(base, 'GET', '/api/canvas/' + canvasId);
    const staging = home.items.find(it => it.type === 'board' && it._childTitle === into);
    if (staging) canvasId = staging.data.childCanvasId;
    else {
      log(`+ board "${into}" (staging, on Home)`);
      canvasId = dryRun
        ? null
        : (await api(base, 'POST', '/api/item', { canvasId, type: 'board', data: { title: into } })).data.childCanvasId;
    }
  }

  await importCanvas(run, canvasId, cards, into ? 1 : 0);
  // Shortcuts last: their target may be a board created anywhere in the tree.
  for (const s of run.shortcuts) {
    const known = run.boards.has(s.card.target) || s.canvas.existing.has(s.card.sourceId);
    if (!known) miss(run, s.card, 'shortcut target not in this import');
    else
      await placeCard(run, s.canvas, s.card, s.parentItemId, s.depth, {
        targetCanvasId: run.boards.get(s.card.target),
      });
  }
  return { created: run.created, skipped: run.skipped, missed: run.missed };
}

function miss(run, card, reason) {
  run.missed.push({ sourceId: card.sourceId, type: card.type, reason });
  run.log(`! ${card.type} "${label(card)}": ${reason}`);
}

/** One board's cards. `canvasId` is null in a dry run for a board not created yet. */
async function importCanvas(run, canvasId, cards, depth) {
  const existing = new Map();
  if (canvasId) {
    for (const it of (await api(run.base, 'GET', '/api/canvas/' + canvasId)).items) {
      if (it.data && it.data.sourceId) existing.set(it.data.sourceId, it);
    }
  }
  const canvas = { id: canvasId, existing, ids: new Map(), lines: [] };
  for (const card of cards) await placeTree(run, canvas, card, null, depth);
  // Lines after cards, so attached ends can name cards made just now.
  for (const card of canvas.lines) {
    const ends = {};
    for (const k of ['from', 'to']) {
      const end = card[k] || {};
      if (end.ref == null) ends[k] = { x: end.x || 0, y: end.y || 0 };
      else if (canvas.ids.has(end.ref)) ends[k] = { id: canvas.ids.get(end.ref) };
    }
    if (!ends.from || !ends.to) miss(run, card, 'line end attached to a card not on this board');
    else await placeCard(run, canvas, card, null, depth, ends);
  }
}

async function placeTree(run, canvas, card, parentItemId, depth) {
  if (card.missing) return miss(run, card, card.missing);
  if (!TYPES.has(card.type)) return miss(run, card, 'no milaclone card type');
  if (card.type === 'line') return canvas.lines.push(card);
  if (card.type === 'shortcut') return run.shortcuts.push({ canvas, card, parentItemId, depth });
  const item = await placeCard(run, canvas, card, parentItemId, depth);
  if (!item) return;
  if (card.type === 'column') {
    for (const child of card.items || []) await placeTree(run, canvas, child, item.id, depth + 1);
  } else if (card.type === 'board') {
    const childCanvasId = item.data && item.data.childCanvasId;
    run.boards.set(card.sourceId, childCanvasId);
    await importCanvas(run, childCanvasId, card.items || [], depth + 1);
  }
}

/** Creates one card (or finds it by sourceId); returns the item, or null if it couldn't be made. */
async function placeCard(run, canvas, card, parentItemId, depth, extra = {}) {
  const pad = '  '.repeat(depth);
  const have = canvas.existing.get(card.sourceId);
  if (have) {
    run.skipped[card.type] = (run.skipped[card.type] || 0) + 1;
    run.log(`${pad}= ${card.type} "${label(card)}"`);
    canvas.ids.set(card.sourceId, have.id);
    return have;
  }

  if (card.file && card.file.path && !fs.existsSync(card.file.path)) {
    miss(run, card, 'file not found: ' + card.file.path);
    return null;
  }
  let type = card.type;
  const data = { ...card.data, ...extra, sourceId: card.sourceId };
  if (card.file && !run.dryRun) {
    try {
      const up = await upload(run.base, card.file, type === 'image');
      Object.assign(data, { src: up.src, name: up.name, mime: up.mime });
    } catch (err) {
      if (!card.file.url || card.file.url.startsWith('data:')) {
        miss(run, card, 'upload failed: ' + err.message);
        return null;
      }
      // A file we can't fetch stays reachable as a link card.
      type = 'link';
      Object.assign(data, { url: card.file.url, title: data.caption || card.file.name || card.file.url });
      miss(run, card, `upload failed (${err.message}), kept as a link`);
    }
  }
  run.created[type] = (run.created[type] || 0) + 1;
  run.log(`${pad}+ ${type} "${label(card)}"`);
  if (run.dryRun) {
    const item = { id: 'dry:' + card.sourceId, data: {} };
    canvas.ids.set(card.sourceId, item.id);
    return item;
  }

  const item = await api(run.base, 'POST', '/api/item', {
    canvasId: canvas.id,
    parentItemId,
    type,
    x: card.x,
    y: card.y,
    w: card.w,
    h: card.h,
    color: card.color,
    data,
  });
  // POST replaces a board's data with { childCanvasId }, so tag it afterwards.
  if (type === 'board') {
    await api(run.base, 'PATCH', '/api/item/' + item.id, { data: { sourceId: card.sourceId } });
  }
  canvas.ids.set(card.sourceId, item.id);
  return item;
}

function summary({ created, skipped, missed }, dryRun) {
  const types = [...new Set([...Object.keys(created), ...Object.keys(skipped)])].sort();
  const rows = types.map(
    t => `  ${t.padEnd(10)} ${String(created[t] || 0).padStart(5)} ${String(skipped[t] || 0).padStart(8)}`
  );
  const lines = [
    `${dryRun ? 'would create' : 'created'} / already there:`,
    `  ${'type'.padEnd(10)} ${'new'.padStart(5)} ${'existing'.padStart(8)}`,
    ...rows,
  ];
  if (missed.length) {
    lines.push(`not imported as-is (${missed.length}):`);
    for (const m of missed) lines.push(`  ${m.type} ${m.sourceId}: ${m.reason}`);
  }
  return lines.join('\n');
}

// ---- CLI -------------------------------------------------------------------

function parseArgs(argv) {
  const args = { base: 'http://127.0.0.1:4321', into: null, reader: 'md', dryRun: false, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') args.base = String(argv[++i] || '').replace(/\/$/, '');
    else if (a === '--into') args.into = argv[++i];
    else if (a === '--reader') args.reader = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') return { help: true };
    else if (a.startsWith('-')) throw new Error('unknown flag: ' + a);
    else args.files.push(a);
  }
  if (!READERS[args.reader]) throw new Error('unknown reader: ' + args.reader);
  return args;
}

const USAGE = `Usage: node scripts/import-milanote.js [--base URL] [--into "Board title"] [--reader md|json] [--dry-run] source …

Imports Milanote boards into a running milaclone through its API. Each card
keeps its Milanote id in data.sourceId, so re-running skips what's already
there. --into puts everything under that board on Home (made if missing).
--dry-run prints the plan and counts and writes nothing.

Readers: md (Milanote's Markdown export, the default) and json (a saved card
tree).`;

async function main(argv, log = console.log) {
  const args = parseArgs(argv);
  if (args.help || !args.files.length) {
    log(USAGE);
    return args.help ? 0 : 1;
  }
  for (const f of args.files) if (!fs.existsSync(f)) throw new Error('file not found: ' + f);
  const cards = await READERS[args.reader].read(args.files);
  const result = await importCards(cards, { base: args.base, into: args.into, dryRun: args.dryRun, log });
  log(summary(result, args.dryRun));
  return 0;
}

module.exports = { importCards, mdReader, jsonReader, READERS, parseArgs, summary, main };

if (require.main === module) {
  main(process.argv.slice(2)).then(
    code => process.exit(code),
    err => {
      console.error(err.message || err);
      process.exit(1);
    }
  );
}
