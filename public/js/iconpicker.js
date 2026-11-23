'use strict';

import { BOARD_ICONS } from './state.js';
import { lucideEl, refreshIcons } from './util.js';

// The board icon picker: a search box over every icon in the Lucide CDN build
// (about 1,500). An empty search shows BOARD_ICONS as suggestions. Lucide's
// `icons` map has PascalCase keys plus aliases (old names) pointing at the same
// glyph, so each glyph is listed once and matches any of its names. The first
// open also fetches lucide-static's tags.json, at the same version as the
// loaded script: its keys are the current names (what a pick saves, since a
// Lucide upgrade can drop an alias) and its tags let "money" find wallet.
// Without it the picker still works, naming each glyph by its first key.
// Results are capped so a one-letter search doesn't render hundreds of SVGs.

const MAX_RESULTS = 96;
let glyphs = null; // [{ name, names, tags }]
let tagsAsked = false;
let rerender = null; // the open picker's refresh, for when tags.json lands

// Lucide's own rule for turning a data-lucide name into an `icons` key.
const pascal = name => name.replace(/(\w)(\w*)(_|-|\s*)/g, (_, a, b) => a.toUpperCase() + b.toLowerCase());
// The reverse: LayoutGrid → layout-grid, AArrowDown → a-arrow-down, Grid2x2 → grid-2x2.
const kebab = key =>
  key.replace(/[a-z0-9](?=[A-Z])|[A-Z](?=[A-Z][a-z])|(?<![0-9])[a-zA-Z](?=[0-9])/g, '$&-').toLowerCase();
const words = s =>
  s
    .trim()
    .toLowerCase()
    .split(/[\s-]+/)
    .filter(Boolean)
    .join('-');

// tags: { name: [keyword] } from tags.json, or null.
function buildGlyphs(tags) {
  const byNode = new Map();
  for (const [name, list] of Object.entries(tags || {})) {
    const node = lucide.icons[pascal(name)];
    if (node && !byNode.has(node)) byNode.set(node, { name, names: [name], tags: list.map(words) });
  }
  for (const [key, node] of Object.entries(lucide.icons)) {
    const name = kebab(key);
    if (lucide.icons[pascal(name)] !== node) continue; // a name createIcons can't resolve back
    const g = byNode.get(node);
    if (!g) byNode.set(node, { name, names: [name], tags: [] });
    else if (!g.names.includes(name)) g.names.push(name);
  }
  return [...byNode.values()];
}

function loadTags() {
  const v = /\/lucide@([\d.]+)/.exec(document.querySelector('script[src*="/lucide@"]')?.src || '');
  if (tagsAsked || !v) return;
  tagsAsked = true;
  fetch(`https://unpkg.com/lucide-static@${v[1]}/tags.json`)
    .then(r => (r.ok ? r.json() : Promise.reject()))
    .then(tags => {
      glyphs = buildGlyphs(tags);
      rerender?.();
    })
    .catch(() => (tagsAsked = false)); // try again next open
}

function allGlyphs() {
  // Without the CDN nothing renders anyway; offer the suggestions and retry next open.
  if (typeof lucide === 'undefined' || !lucide.icons) return BOARD_ICONS.map(n => ({ name: n, names: [n], tags: [] }));
  loadTags();
  return (glyphs ||= buildGlyphs(null));
}

// A name is the query, then starts with it, then a later word of one does,
// then a name contains it, then a tag does.
function findIcons(query) {
  const q = words(query);
  const all = allGlyphs();
  const glyphOf = n => all.find(g => g.names.includes(n)) || { names: [n] };
  if (!q) return BOARD_ICONS.map(n => ({ name: n, names: glyphOf(n).names }));
  const tiers = [n => n === q, n => n.startsWith(q), n => n.includes('-' + q), n => n.includes(q)];
  const rank = g => {
    const i = tiers.findIndex(t => g.names.some(t));
    return i >= 0 ? i : g.tags.some(t => t.includes(q)) ? tiers.length : -1;
  };
  return all
    .map(g => [rank(g), g])
    .filter(([r]) => r >= 0)
    .sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name))
    .map(([, g]) => g);
}

// Returns the picker element; onPick(name) gets the chosen icon's name.
export function iconPicker(current, onPick) {
  const box = document.createElement('div');
  box.className = 'icon-picker';
  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'icon-search';
  input.placeholder = 'Search icons';
  input.setAttribute('aria-label', 'Search icons');
  input.autocomplete = 'off';
  input.spellcheck = false;
  const grid = document.createElement('div');
  grid.className = 'icon-grid';
  const note = document.createElement('div');
  note.className = 'icon-note';

  let shown = [];
  const show = () => {
    const found = findIcons(input.value);
    shown = found.slice(0, MAX_RESULTS);
    grid.replaceChildren(
      ...shown.map(g => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'icon-pick' + (g.names.includes(current) ? ' sel' : '');
        btn.title = g.name;
        btn.setAttribute('aria-label', g.name);
        btn.appendChild(lucideEl(g.name));
        btn.onclick = () => onPick(g.name);
        return btn;
      })
    );
    note.textContent = !found.length
      ? 'No icons match'
      : found.length > shown.length
        ? `Showing ${shown.length} of ${found.length}. Keep typing to narrow.`
        : '';
    note.hidden = !note.textContent;
    refreshIcons(grid);
  };
  input.oninput = show;
  input.onkeydown = e => {
    if (e.key !== 'Enter' || !shown.length) return;
    e.stopPropagation(); // picking closes the palette, so main.js would read Enter as Rename
    onPick(shown[0].name);
  };
  box.append(input, grid, note);
  rerender = show;
  show();
  return box;
}
