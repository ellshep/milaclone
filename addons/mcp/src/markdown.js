// A board as Markdown, in the same shape as the board's own Export
// (export-md.js): `# board` sections, `## first line` + lines for notes,
// `## title` + `- [ ]` tasks, link and file lines. Built here from the boards
// agents may read, because the board's export appends every board below the
// asked-for one, blocked ones included (A3). A blocked board keeps only its
// title, with a note saying why.

const oneLine = s =>
  String(s || '')
    .replace(/\s+/g, ' ')
    .trim();
const label = s => oneLine(s).replace(/[[\]]/g, '');
const url = s =>
  String(s || '').replace(/[()\s]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
const readingOrder = (a, b) => a.y - b.y || a.x - b.x;
const blank = t => !t || typeof t.text !== 'string' || !t.text.trim();

function cardLines(it, origin) {
  const d = it.data || {};
  if (['note', 'comment', 'swatch', 'table', 'document', 'agent'].includes(it.type)) {
    const lines = String(d.text || '')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);
    if (it.type === 'document') lines.unshift(oneLine(d.title) || 'Document');
    return lines.length ? ['## ' + lines[0], ...lines.slice(1), ''] : [];
  }
  if (it.type === 'todo') {
    const tasks = (d.tasks || []).filter(t => !blank(t));
    if (!tasks.length) return [];
    return [
      '## ' + (oneLine(d.title) || 'To-do'),
      ...tasks.map(t => `- [${t.status === 'done' ? 'x' : ' '}] ${oneLine(t.text)}`),
      '',
    ];
  }
  if (it.type === 'link' && d.url) return [`[${label(d.title) || label(d.url)}](${url(d.url)})`, ''];
  if ((it.type === 'image' || it.type === 'file') && d.src) {
    const href = url(d.src.startsWith('/') ? origin + d.src : d.src);
    return [`${it.type === 'image' ? '!' : ''}[${label(d.caption || d.name) || 'file'}](${href})`, ''];
  }
  return [];
}

/** `first` is a readable board from Board.canvas; `load(id)` fetches another. */
export async function boardMarkdown(first, load, origin) {
  const out = [];
  const queue = [first];
  for (let i = 0; i < queue.length; i++) {
    const c = queue[i];
    out.push('# ' + (oneLine(c.canvas.title) || 'Board'), '');
    if (!c.readable) {
      out.push('(Blocked for agents: its agentAccess flag is off.)', '');
    }
    const items = c.items;
    for (const it of items.filter(x => !x.parentItemId).sort(readingOrder)) {
      if (it.type === 'board' && it.data && it.data.childCanvasId) queue.push(await load(it.data.childCanvasId));
      if (!c.readable) continue;
      const cards = it.type === 'column' ? items.filter(k => k.parentItemId === it.id).sort((a, b) => a.y - b.y) : [it];
      for (const k of cards) out.push(...cardLines(k, origin));
    }
  }
  return (
    out
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd() + '\n'
  );
}
