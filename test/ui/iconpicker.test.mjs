import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { iconPicker } from '../../public/js/iconpicker.js';
import { BOARD_ICONS } from '../../public/js/state.js';

// A stand-in for the CDN's `lucide` global: PascalCase keys in alphabetical
// order, so an alias (old name) can come before the current name, as in Lucide.
const node = () => [['path', {}]];
const house = node();
const circleAlert = node();
const icons = {
  AArrowDown: node(),
  AlertCircle: circleAlert, // alias
  ArrowDown: node(),
  ArrowDownAZ: node(), // its kebab name resolves to ArrowDownAz, which isn't here
  Cherry: node(),
  Circle: node(),
  CircleAlert: circleAlert,
  Download: node(),
  Grid2x2: node(),
  Home: house, // alias
  House: house,
  LayoutGrid: node(),
  Wallet: node(),
};
for (let i = 0; i < 120; i++) icons[`Bulk${String.fromCharCode(65 + (i % 26))}${i}`] = node();

const open = (current = 'layout-grid') => {
  const onPick = vi.fn();
  const el = iconPicker(current, onPick);
  const input = el.querySelector('.icon-search');
  const type = text => {
    input.value = text;
    input.dispatchEvent(new Event('input'));
  };
  const names = () => [...el.querySelectorAll('.icon-pick')].map(b => b.title);
  const note = el.querySelector('.icon-note');
  return { el, input, type, names, note, onPick };
};
const settle = () => new Promise(r => setTimeout(r));

const createIcons = vi.fn();
const fetch = vi.fn();
afterAll(() => {
  delete globalThis.lucide;
  delete globalThis.fetch;
});

describe('icon picker without the Lucide CDN', () => {
  it('offers the suggestions and searches them', () => {
    const p = open();
    expect(p.names()).toEqual(BOARD_ICONS);
    p.type('book');
    expect(p.names()).toEqual(['book-open']);
  });
});

describe('icon picker', () => {
  beforeAll(() => {
    globalThis.lucide = { icons, createIcons };
    globalThis.fetch = fetch;
  });

  it('shows the suggestions for an empty search and renders them', () => {
    const p = open();
    expect(p.names()).toEqual(BOARD_ICONS);
    expect(p.el.querySelector('.sel').title).toBe('layout-grid');
    expect(p.note.hidden).toBe(true);
    expect(createIcons).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled(); // no Lucide <script> to take a version from
  });

  it('lists each glyph once and finds it by any of its names', () => {
    const p = open();
    p.type('circle alert');
    expect(p.names()).toEqual(['alert-circle']);
    p.type('circle');
    expect(p.names()).toEqual(['circle', 'alert-circle']);
  });

  it('ranks names that start with the search, then a later word that does', () => {
    const p = open();
    p.type('down');
    expect(p.names()).toEqual(['download', 'a-arrow-down', 'arrow-down']);
  });

  it('marks the current icon even when it is saved under another name', () => {
    const p = open('house');
    p.type('hous');
    expect(p.el.querySelector('.sel').title).toBe('home');
  });

  it('turns keys into names Lucide resolves back, and skips the rest', () => {
    const p = open();
    p.type('arrow');
    expect(p.names()).toEqual(['arrow-down', 'a-arrow-down']);
    p.type('grid 2');
    expect(p.names()).toEqual(['grid-2x2']);
  });

  it('caps the results and says when nothing matches', () => {
    const p = open();
    p.type('bulk');
    expect(p.names()).toHaveLength(96);
    expect(p.note.textContent).toBe('Showing 96 of 120. Keep typing to narrow.');
    p.type('zzz');
    expect(p.names()).toEqual([]);
    expect(p.note.textContent).toBe('No icons match');
    expect(p.note.hidden).toBe(false);
  });

  it('picks by click, or the top result on Enter', () => {
    const p = open();
    p.type('ch');
    p.el.querySelector('.icon-pick').click();
    expect(p.onPick).toHaveBeenLastCalledWith('cherry');
    p.type('circle');
    p.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(p.onPick).toHaveBeenLastCalledWith('circle');
    p.type('zzz');
    p.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(p.onPick).toHaveBeenCalledTimes(2);
  });
});

describe('icon picker with tags.json', () => {
  const tags = { 'circle-alert': ['warning', 'exclamation mark'], house: ['living'], wallet: ['money', 'finance'] };
  beforeAll(() => {
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/lucide@0.469.0';
    document.head.appendChild(s);
  });

  it('asks again on the next open after a failed fetch', async () => {
    fetch.mockRejectedValueOnce(new Error('offline'));
    open();
    await settle();
    expect(fetch).toHaveBeenCalledWith('https://unpkg.com/lucide-static@0.469.0/tags.json');
    fetch.mockResolvedValueOnce({ ok: false });
    open();
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('names glyphs by their current name and searches tags once it lands', async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => tags });
    const p = open();
    p.type('circle alert');
    expect(p.names()).toEqual(['alert-circle']); // before the fetch resolves
    await settle();
    expect(p.names()).toEqual(['circle-alert']); // the open picker refreshed itself
    p.type('money');
    expect(p.names()).toEqual(['wallet']);
    p.type('exclamation mark');
    expect(p.names()).toEqual(['circle-alert']);
    p.type('hous');
    expect(p.names()).toEqual(['house']);
    open();
    expect(fetch).toHaveBeenCalledTimes(3); // fetched once, then kept
  });
});
