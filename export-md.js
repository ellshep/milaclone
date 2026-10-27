'use strict';

const { stmt, itemsForCanvas } = require('./db');

// A board as Markdown in the shape scripts/import-milanote-md.js reads back:
// `# board` sections, `## first line` + lines for notes and comments, `## title`
// + `- [ ]` tasks for to-dos, and `[title](url)` / `![name](url)` lines for links,
// files and images. Formatting is dropped: notes export their plain `data.text`.
// ponytail: the importer nests boards one level deep, so every board below this
// one becomes a flat `#` section; a note line that itself looks like Markdown
// syntax (`# x`, `- [ ] x`, `[a](b)`) is re-read as that syntax.

const oneLine = s =>
  String(s || '')
    .replace(/\s+/g, ' ')
    .trim();
const label = s => oneLine(s).replace(/[[\]]/g, '');
// `(`, `)` and spaces would end the Markdown link early (encodeURIComponent keeps parens)
const url = s =>
  String(s || '').replace(/[()\s]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
const readingOrder = (a, b) => a.y - b.y || a.x - b.x;

function cardLines(it, origin) {
  const d = it.data || {};
  // Swatches and tables keep their plain text (the hex, `a | b` rows) in data.text too.
  // ponytail: these three come back from the importer as notes (text kept, card
  // type lost); teach scripts/import-milanote-md.js their shapes if that matters.
  if (['note', 'comment', 'swatch', 'table', 'document'].includes(it.type)) {
    const lines = String(d.text || '')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);
    if (it.type === 'document') lines.unshift(oneLine(d.title) || 'Document');
    return lines.length ? ['## ' + lines[0], ...lines.slice(1), ''] : [];
  }
  if (it.type === 'todo') {
    const tasks = (d.tasks || []).filter(t => oneLine(t.text));
    if (!tasks.length) return [];
    return [
      '## ' + (oneLine(d.title) || 'To-do'),
      ...tasks.map(t => `- [${t.done ? 'x' : ' '}] ${oneLine(t.text)}`),
      '',
    ];
  }
  if (it.type === 'link' && d.url) return [`[${label(d.title) || label(d.url)}](${url(d.url)})`, ''];
  if ((it.type === 'image' || it.type === 'file') && d.src) {
    const href = url(d.src.startsWith('/') ? origin + d.src : d.src);
    return [`${it.type === 'image' ? '!' : ''}[${label(d.caption || d.name) || 'file'}](${href})`, ''];
  }
  return []; // columns export through their cards; boards become sections
}

function exportMarkdown(canvasId, origin = '') {
  const canvas = stmt.getCanvas.get(canvasId);
  if (!canvas) return null;
  const boards = [];
  const section = c => {
    const items = itemsForCanvas(c.id);
    const lines = ['# ' + (oneLine(c.title) || 'Board'), ''];
    for (const it of items.filter(i => !i.parentItemId).sort(readingOrder)) {
      if (it.type === 'board') boards.push(it.data.childCanvasId);
      const cards = it.type === 'column' ? items.filter(k => k.parentItemId === it.id).sort((a, b) => a.y - b.y) : [it];
      for (const k of cards) lines.push(...cardLines(k, origin));
    }
    return lines;
  };
  const out = section(canvas);
  for (let i = 0; i < boards.length; i++) {
    const c = stmt.getCanvas.get(boards[i]); // boards found below are appended as we go
    if (c) out.push(...section(c));
  }
  return (
    out
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd() + '\n'
  );
}

module.exports = { exportMarkdown };
