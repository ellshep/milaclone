'use strict';

// P4: the esbuild-bundled TipTap editor, loaded on first edit, for note and
// comment bodies (data.doc + data.text).

const { test, expect } = require('@playwright/test');
const { freshCanvas, place, leaveEdit } = require('./helpers');

const BUNDLE = '/vendor/editor.js';
const textOf = async (page, canvasId) =>
  (await (await page.request.get('/api/canvas/' + canvasId)).json()).items.map(i => i.data.text);

async function noteVia(page, canvasId, data, type = 'note') {
  return page.evaluate(
    ({ canvasId, data, type }) =>
      fetch('/api/item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ canvasId, type, x: 300, y: 200, data }),
      }).then(r => r.json()),
    { canvasId, data, type }
  );
}

test('F4.1: the server builds the editor bundle at boot', async ({ request }) => {
  const r = await request.get(BUNDLE);
  expect(r.status()).toBe(200);
  expect(r.headers()['content-type']).toMatch(/javascript/);
  expect(await r.text()).toContain('mountEditor');
});

test('F4.2: the bundle loads on first edit; markdown shortcuts format; the result persists', async ({ page }) => {
  const id = await freshCanvas(page);
  await noteVia(page, id, { body: 'plain' });
  const fetched = [];
  page.on('request', r => r.url().endsWith(BUNDLE) && fetched.push(r.url()));
  await page.reload();
  const body = page.locator('.item.type-note .nbody');
  await expect(body).toHaveText('plain');
  expect(fetched).toHaveLength(0); // nothing is edited yet

  await page.locator('.item.type-note').click();
  const pm = body.locator('.ProseMirror');
  await expect(pm).toBeFocused();
  expect(fetched).toHaveLength(1);
  await page.keyboard.type(' **bold** ==lit== ');
  await page.keyboard.press('Enter');
  await page.keyboard.type('## Head');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- item');
  await expect(pm.locator('strong')).toHaveText('bold');
  await expect(pm.locator('mark')).toHaveText('lit');
  await expect(pm.locator('h2')).toHaveText('Head');
  await expect(pm.locator('ul li')).toHaveText('item');

  // data.text is the plain text for search/labels; block separators may vary
  await expect
    .poll(async () => (await textOf(page, id))[0].split(/\s+/).join(' ').trim())
    .toBe('plain bold lit Head item');
  await leaveEdit(page);
  await expect(body.locator('.ProseMirror')).toHaveCount(0); // back to the static render
  await expect(body.locator('strong')).toHaveText('bold');
  await page.reload();
  await expect(body.locator('strong')).toHaveText('bold');
  await expect(body.locator('h2')).toHaveText('Head');
});

test('F4.3: a title + body note becomes one body that keeps both', async ({ page }) => {
  const id = await freshCanvas(page);
  await noteVia(page, id, { title: 'Groceries', body: 'milk\neggs' });
  await page.reload();
  const body = page.locator('.item.type-note .nbody');
  await expect(body.locator('h2')).toHaveText('Groceries');
  await expect(body.locator('p')).toHaveText(['milk', 'eggs']);
  expect(await textOf(page, id)).toEqual(['Groceries\nmilk\neggs']);
});

test('F4.4: a comment card supports bold', async ({ page }) => {
  const id = await freshCanvas(page);
  await place(page, 'comment');
  const pm = page.locator('.item.type-comment .ProseMirror');
  await expect(pm).toBeFocused();
  await page.keyboard.type('ship **it** ');
  await expect(pm.locator('strong')).toHaveText('it');
  await expect.poll(() => textOf(page, id)).toEqual(['ship it']);
});

test('shortcut keys type into a note instead of arming tools', async ({ page }) => {
  await freshCanvas(page);
  await place(page, 'note');
  await expect(page.locator('.item.type-note .ProseMirror')).toBeFocused();
  await page.keyboard.type('nlt');
  await expect(page.locator('.tool.armed')).toHaveCount(0);
  await expect(page.locator('.item.type-note .ProseMirror')).toHaveText('nlt');
});

// ---- review regressions ----------------------------------------------------

test('a second note edited after the bundle is cached keeps the caret', async ({ page }) => {
  const id = await freshCanvas(page);
  const a = await noteVia(page, id, { body: 'first' });
  const b = await noteVia(page, id, { body: 'second' });
  await page.evaluate(
    ({ a, b }) => {
      // spread them out so each can be clicked
      for (const [n, x] of [
        [a, 200],
        [b, 620],
      ]) {
        fetch('/api/item/' + n, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ x, y: 200 }),
        });
      }
    },
    { a: a.id, b: b.id }
  );
  await page.waitForTimeout(150);
  await page.reload();
  await page.locator(`.item[data-id="${a.id}"]`).click();
  await expect(page.locator(`.item[data-id="${a.id}"] .ProseMirror`)).toBeFocused();
  await leaveEdit(page);

  await page.locator(`.item[data-id="${b.id}"]`).click();
  const pm = page.locator(`.item[data-id="${b.id}"] .ProseMirror`);
  await expect(pm).toBeFocused();
  await page.waitForTimeout(100); // past the click's rAF focus
  await expect(pm).toBeFocused();
  await page.keyboard.type(' more');
  await expect(pm).toHaveText('second more');
});

test('re-rendering a note mid-edit ends the edit cleanly', async ({ page }) => {
  await freshCanvas(page);
  await place(page, 'note');
  const note = page.locator('.item.type-note');
  await expect(note.locator('.ProseMirror')).toBeFocused();
  await page.keyboard.type('locked text');
  await note.click({ button: 'right' });
  await page.locator('#ctxmenu .ctx-item', { hasText: 'Lock' }).click();
  await expect(note.locator('.ProseMirror')).toHaveCount(0);
  await expect(note.locator('.nbody')).toHaveText('locked text');
  await page.keyboard.press('n'); // shortcuts work again: no orphaned edit
  await expect(page.locator('.tool.armed')).toHaveCount(1);
});

test('a stored doc the editor cannot read is kept, not blanked', async ({ page }) => {
  const id = await freshCanvas(page);
  const bad = { type: 'doc', content: [{ type: 'mystery', content: [{ type: 'text', text: 'keep me' }] }] };
  await noteVia(page, id, { doc: bad });
  await page.reload();
  await page.locator('.item.type-note').click();
  await expect(page.locator('#toast')).toContainText("can't be edited");
  await expect(page.locator('.item.type-note .nbody')).toHaveText('keep me');
  await page.keyboard.type('xyz');
  await leaveEdit(page);
  const items = (await (await page.request.get('/api/canvas/' + id)).json()).items;
  expect(items[0].data.doc).toEqual(bad);
  expect(items[0].data.text).toBe('keep me'); // derived on POST
});

test('a note holding only a divider does not show the placeholder', async ({ page }) => {
  const id = await freshCanvas(page);
  await noteVia(page, id, { doc: { type: 'doc', content: [{ type: 'horizontalRule' }] } });
  await page.reload();
  await expect(page.locator('.item.type-note .nbody')).not.toHaveAttribute('data-empty', '');
});
