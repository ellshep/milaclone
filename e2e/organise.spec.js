'use strict';

// P7b: collapsible columns, board shortcuts, templates.

const { test, expect } = require('@playwright/test');
const { freshCanvas } = require('./helpers');

const post = (page, body) =>
  page.evaluate(
    b =>
      fetch('/api/item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(b),
      }).then(r => r.json()),
    body
  );
const items = async (page, canvasId) => (await (await page.request.get('/api/canvas/' + canvasId)).json()).items;

test('F7.4: a collapsed column stays collapsed after a reload and shows its card count', async ({ page }) => {
  const id = await freshCanvas(page);
  const col = await post(page, { canvasId: id, type: 'column', x: 200, y: 120, data: { title: 'Doing' } });
  for (const [i, body] of ['one', 'two', 'three'].entries()) {
    await post(page, { canvasId: id, type: 'note', parentItemId: col.id, y: i, data: { body } });
  }
  await page.reload();
  const column = page.locator('.item.type-column');
  await expect(column.locator('.col-count')).toHaveText('3');
  await expect(column.locator('.item.type-note')).toHaveCount(3);

  const saved = page.waitForResponse(r => r.request().method() === 'PATCH' && r.url().includes(col.id));
  await column.locator('.col-fold').click();
  await expect(column).toHaveClass(/collapsed/);
  await expect(column.locator('.col-body')).toBeHidden();
  await saved;

  await page.reload();
  await expect(column).toHaveClass(/collapsed/);
  await expect(column.locator('.col-body')).toBeHidden();
  await expect(column.locator('.col-count')).toHaveText('3');
  await expect(column.locator('.col-fold')).toHaveAttribute('aria-expanded', 'false');
  expect((await items(page, id)).find(i => i.id === col.id).data.collapsed).toBe(true);

  await column.locator('.col-fold').click();
  await expect(column.locator('.item.type-note')).toHaveCount(3);
});

test('F7.5: a board shortcut opens its board, and shows as broken once that board is trashed', async ({ page }) => {
  const id = await freshCanvas(page);
  const board = await post(page, { canvasId: id, type: 'board', x: 200, y: 150, data: { title: 'Roadmap' } });
  await page.reload();
  await page.locator('.item.type-board').click({ button: 'right' });
  await page.getByRole('button', { name: 'Create Shortcut' }).click();
  const sc = page.locator('.item.type-shortcut');
  await expect(sc.locator('.btitle')).toHaveText('Roadmap');
  await expect(sc.locator('.bmeta')).toHaveText('Shortcut');

  await sc.dblclick();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#' + board.data.childCanvasId);
  await page.goto('/#' + id);
  await expect(page.locator('.item.type-shortcut')).toHaveCount(1);

  await page.evaluate(bid => fetch('/api/item/' + bid, { method: 'DELETE' }), board.id);
  await page.reload();
  await expect(sc).toHaveClass(/broken/);
  await expect(sc.locator('.bmeta')).toHaveText('Board in trash');
  await sc.dblclick();
  await expect(page.getByText('The board this shortcut opens is in the trash')).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#' + id);
});

test('F7.6: New from template deep-copies a board from the Templates board', async ({ page }) => {
  const id = await freshCanvas(page);
  const root = await page.evaluate(async () => (await (await fetch('/api/root')).json()).rootCanvasId);
  // Reuse the Templates board if an earlier run made one (it's global to Home).
  let holder = (await items(page, root)).find(i => i.type === 'board' && i._childTitle === 'Templates');
  holder ||= await post(page, { canvasId: root, type: 'board', data: { title: 'Templates' } });
  const name = 'Weekly ' + Date.now();
  const tpl = await post(page, { canvasId: holder.data.childCanvasId, type: 'board', data: { title: name } });
  await post(page, { canvasId: tpl.data.childCanvasId, type: 'note', data: { body: 'Wins' } });

  await page.click('.tool[data-tool="template"]');
  await page.mouse.click(500, 350);
  const dlg = page.locator('#templateDialog');
  await expect(dlg).toBeVisible();
  const copied = page.waitForResponse(r => r.url().includes(`/api/item/${tpl.id}/copy`));
  await dlg.getByRole('button', { name }).click();
  await copied;
  await expect(dlg).toBeHidden();

  await expect(page.locator('.item.type-board.selected .btitle')).toHaveValue(name);
  const copy = (await items(page, id)).find(i => i.type === 'board');
  expect(copy.data.childCanvasId).not.toBe(tpl.data.childCanvasId);
  const inner = await items(page, copy.data.childCanvasId);
  expect(inner.map(i => i.data.text)).toEqual(['Wins']);

  // Editing the copy leaves the template alone.
  await page.evaluate(
    nid =>
      fetch('/api/item/' + nid, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: { body: 'Changed' } }),
      }),
    inner[0].id
  );
  expect((await items(page, tpl.data.childCanvasId)).map(i => i.data.text)).toEqual(['Wins']);
});

test('F7.4: opening a search result inside a collapsed column expands it', async ({ page }) => {
  const id = await freshCanvas(page);
  const word = 'Budget' + Date.now();
  const col = await post(page, { canvasId: id, type: 'column', x: 200, y: 120, data: { collapsed: true } });
  await post(page, { canvasId: id, type: 'note', parentItemId: col.id, data: { body: word } });
  await page.reload();
  await expect(page.locator('.item.type-column')).toHaveClass(/collapsed/);
  await page.keyboard.press('ControlOrMeta+k');
  await page.locator('#searchInput').fill(word);
  await page.locator('#searchResults .sr-item', { hasText: word }).first().click();
  await expect(page.locator('.item.type-column')).not.toHaveClass(/collapsed/);
  await expect(page.locator('.item.type-note.selected')).toBeVisible();
});
