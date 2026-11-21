#!/usr/bin/env node
'use strict';

/**
 * Task list importer: a cleaned-up `milaclone-import/1` file → milaclone.
 *
 *   TASK_API_TOKEN=… node scripts/import-tasks-json.js [--base URL] [--into "From Microsoft To Do"] [--dry-run] file.json
 *
 * The file (made outside this repo, e.g. from a Microsoft To Do export):
 *   { format: "milaclone-import/1", source?, lists: [
 *       { name, target: { new: true, title? } | { listId },
 *         tasks: [{ importId, title, note?, due?, starred?, tags? }] } ] }
 *
 * New lists become to-do cards on the board `--into` on Home (made if missing);
 * a card with the same title already on that board is reused. Tasks go through
 * POST /api/tasks with their importId, so a re-run creates nothing twice. Any
 * row the API refuses is reported with its reason, never dropped silently.
 * --dry-run reads only (no token needed) and prints what would be created.
 */

const fs = require('fs');
const { gridPos } = require('./import-milanote-md.js');

const FORMAT = 'milaclone-import/1';

async function api(base, method, p, body, token) {
  const opts = { method, headers: {} };
  if (token) opts.headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(base + p, opts);
  const data = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, data };
}

async function apiOk(base, method, p, body, token) {
  const r = await api(base, method, p, body, token);
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}

/** Checks the file's shape; returns its lists or throws with every problem found. */
function readFile(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const problems = [];
  if (!doc || doc.format !== FORMAT) problems.push(`format must be "${FORMAT}"`);
  const lists = doc && Array.isArray(doc.lists) ? doc.lists : (problems.push('lists must be an array'), []);
  const ids = new Set();
  lists.forEach((l, i) => {
    const at = `lists[${i}]`;
    if (!l || typeof l.name !== 'string' || !l.name.trim()) problems.push(`${at}.name is missing`);
    const t = l && l.target;
    if (!t || !(t.new === true || (typeof t.listId === 'string' && t.listId)))
      problems.push(`${at}.target must be { new: true } or { listId }`);
    if (!l || !Array.isArray(l.tasks)) return problems.push(`${at}.tasks must be an array`);
    l.tasks.forEach((task, j) => {
      const id = task && task.importId;
      if (typeof id !== 'string' || !id) problems.push(`${at}.tasks[${j}].importId is missing`);
      else if (ids.has(id)) problems.push(`${at}.tasks[${j}].importId ${id} is repeated`);
      else ids.add(id);
    });
  });
  if (problems.length) throw new Error('not a valid import file:\n  ' + problems.join('\n  '));
  return lists;
}

/**
 * Imports `lists`. With dryRun, reads only.
 * @returns {{ lists: { name, title, status }[], created, existing, rejected: { importId, title, reason }[] }}
 */
async function importLists(lists, { base, token, into = 'From Microsoft To Do', dryRun = false, log = () => {} }) {
  const health = await api(base, 'GET', '/api/health').catch(() => null);
  if (!health || !health.ok) throw new Error('server not reachable at ' + base);
  if (!dryRun && !token) throw new Error('TASK_API_TOKEN is not set');

  const { rootCanvasId, lists: current } = await apiOk(base, 'GET', '/api/todos');
  const known = new Set(current.flatMap(c => c.tasks.map(t => t.importId).filter(Boolean)));
  const home = await apiOk(base, 'GET', '/api/canvas/' + rootCanvasId);
  const boardCard = home.items.find(it => it.type === 'board' && it._childTitle === into);
  let boardId = boardCard ? boardCard.data.childCanvasId : null;
  const onBoard = boardId ? (await apiOk(base, 'GET', '/api/canvas/' + boardId)).items : [];
  let placed = onBoard.length;

  const out = { lists: [], created: 0, existing: 0, rejected: [] };
  for (const l of lists) {
    const title = (l.target.title || l.name).trim();
    let listId = l.target.listId || null;
    let status;
    if (listId) {
      if (!current.some(c => c.id === listId)) {
        for (const t of l.tasks)
          out.rejected.push({ importId: t.importId, title: t.title, reason: 'listId not found' });
        out.lists.push({ name: l.name, title: listId, status: 'missing' });
        continue;
      }
      status = 'existing';
    } else {
      const same = onBoard.find(it => it.type === 'todo' && (it.data.title || '').trim() === title);
      if (same) {
        listId = same.id;
        status = 'reused';
      } else {
        status = 'new';
        if (!dryRun) {
          if (!boardId) {
            log(`+ board "${into}" (on Home)`);
            boardId = (
              await apiOk(base, 'POST', '/api/item', { canvasId: rootCanvasId, type: 'board', data: { title: into } })
            ).data.childCanvasId;
          }
          const card = await apiOk(base, 'POST', '/api/item', {
            canvasId: boardId,
            type: 'todo',
            ...gridPos(placed++),
            w: 240,
            data: { title, tasks: [] },
          });
          onBoard.push(card);
          listId = card.id;
        }
      }
    }
    out.lists.push({ name: l.name, title, status });
    log(`${status === 'new' ? '+' : '='} list "${title}" (${l.tasks.length} tasks)`);

    for (const t of l.tasks) {
      if (known.has(t.importId)) {
        out.existing++;
        continue;
      }
      if (dryRun) {
        out.created++;
        continue;
      }
      const body = {
        title: t.title,
        notes: t.note,
        dueDate: t.due,
        starred: t.starred,
        tags: t.tags,
        importId: t.importId,
        listId,
        source: 'migration',
      };
      const r = await api(base, 'POST', '/api/tasks', body, token);
      if (r.status === 201) out.created++;
      else if (r.status === 200) out.existing++;
      else if (r.status === 401 || r.status === 503) throw new Error(`task API refused the token (${r.status})`);
      else out.rejected.push({ importId: t.importId, title: t.title, reason: r.data.error || `HTTP ${r.status}` });
      known.add(t.importId);
    }
  }
  return out;
}

function summary(r, dryRun) {
  const lines = [`lists:`];
  for (const l of r.lists) lines.push(`  ${l.status.padEnd(8)} ${l.title}`);
  lines.push(`tasks: ${r.created} ${dryRun ? 'would be created' : 'created'}, ${r.existing} already there`);
  if (r.rejected.length) {
    lines.push(`not imported (${r.rejected.length}):`);
    for (const x of r.rejected) lines.push(`  ${x.importId} "${x.title}": ${x.reason}`);
  }
  return lines.join('\n');
}

// ---- CLI -------------------------------------------------------------------

function parseArgs(argv) {
  const args = { base: 'http://127.0.0.1:4321', into: 'From Microsoft To Do', dryRun: false, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') args.base = String(argv[++i] || '').replace(/\/$/, '');
    else if (a === '--into') args.into = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') return { help: true };
    else if (a.startsWith('-')) throw new Error('unknown flag: ' + a);
    else args.files.push(a);
  }
  return args;
}

const USAGE = `Usage: TASK_API_TOKEN=… node scripts/import-tasks-json.js [--base URL] [--into "Board title"] [--dry-run] file.json

Imports a cleaned-up task list file (format "${FORMAT}") into a running
milaclone through its task API. New lists go on the board --into on Home
(default "From Microsoft To Do", made if missing). Each task keeps its importId,
so re-running skips what's already there. --dry-run prints what would be
created, writes nothing, and needs no token.`;

async function main(argv, log = console.log, env = process.env) {
  const args = parseArgs(argv);
  if (args.help || args.files.length !== 1) {
    log(USAGE);
    return args.help ? 0 : 1;
  }
  const lists = readFile(args.files[0]);
  const result = await importLists(lists, {
    base: args.base,
    token: env.TASK_API_TOKEN,
    into: args.into,
    dryRun: args.dryRun,
    log,
  });
  log(summary(result, args.dryRun));
  return result.rejected.length ? 2 : 0;
}

module.exports = { readFile, importLists, summary, parseArgs, main, FORMAT };

if (require.main === module) {
  main(process.argv.slice(2)).then(
    code => process.exit(code),
    err => {
      console.error(err.message || err);
      process.exit(1);
    }
  );
}
