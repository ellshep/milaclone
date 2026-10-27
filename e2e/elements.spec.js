'use strict';

// P6a: colour swatch, simple table and document cards.

const { test, expect } = require('@playwright/test');
const { freshCanvas, place, leaveEdit } = require('./helpers');

const items = async (page, canvasId) => (await (await page.request.get('/api/canvas/' + canvasId)).json()).items;
const post = (page, canvasId, body) =>
  page.evaluate(
    b =>
      fetch('/api/item', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }),
    { canvasId, x: 200, y: 200, ...body }
  );
const saved = page => page.waitForResponse(r => r.url().includes('/api/item/') && r.request().method() === 'PATCH');

test('F6.2: typing #ff8800 into a new note makes a swatch that copies its hex', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const id = await freshCanvas(page);
  await place(page, 'note');
  await expect(page.locator('.item.editing .ProseMirror')).toBeFocused(); // keys before the editor loads are dropped
  await page.keyboard.type('#ff8800');
  const converted = page.waitForResponse(
    r => r.request().method() === 'PATCH' && (r.request().postData() || '').includes('"type":"swatch"')
  );
  await leaveEdit(page);
  await converted;
  const sw = page.locator('.item.type-swatch');
  await expect(sw.locator('.sw-hex')).toHaveValue('#ff8800');
  await expect(sw.locator('.sw-chip')).toHaveCSS('background-color', 'rgb(255, 136, 0)');

  await sw.locator('.sw-chip').click();
  await expect(page.getByText('Copied #ff8800')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('#ff8800');

  await page.reload();
  await expect(page.locator('.item.type-swatch .sw-hex')).toHaveValue('#ff8800');
  expect((await items(page, id)).map(i => i.type)).toEqual(['swatch']);
});

test('F6.2: a pasted hex code lands as a swatch; ordinary notes stay notes', async ({ page }) => {
  await freshCanvas(page);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', '#0af');
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt }));
  });
  await expect(page.locator('.item.type-swatch .sw-hex')).toHaveValue('#00aaff');

  await place(page, 'note', 300, 500);
  await expect(page.locator('.item.editing .ProseMirror')).toBeFocused();
  await page.keyboard.type('#ff8800 is orange');
  await leaveEdit(page);
  await expect(page.locator('.item.type-note')).toHaveCount(1);
});

test('F6.2: an existing note that reads like a hex code stays a note', async ({ page }) => {
  const id = await freshCanvas(page);
  await post(page, id, { type: 'note', data: { body: '#c0ffee' } });
  await page.reload();
  await page.locator('.item.type-note').click();
  await expect(page.locator('.item.editing .ProseMirror')).toBeFocused();
  await leaveEdit(page);
  await expect(page.locator('.item.type-note')).toHaveCount(1);
  expect((await items(page, id))[0].type).toBe('note');
});

test('swatch and table cards render bad API data safely', async ({ page }) => {
  const id = await freshCanvas(page);
  await post(page, id, { type: 'swatch', data: { hex: 'url(https://example.invalid/x.png)' } });
  await post(page, id, { type: 'table', x: 400, data: { rows: [['a'], ['b', 'c', 'd']] } });
  await page.reload();
  await expect(page.locator('.sw-chip')).toHaveCSS('background-color', 'rgb(136, 136, 136)');
  await expect(page.locator('.sw-hex')).toHaveValue('#888888');
  const widths = await page.locator('.item.type-table tr').evaluateAll(trs => trs.map(tr => tr.cells.length));
  expect(widths).toEqual([3, 3]);
});

test('F6.5: edited cells and an added row persist after a reload; tab moves between cells', async ({ page }) => {
  const id = await freshCanvas(page);
  await place(page, 'table');
  const table = page.locator('.item.type-table');
  await expect(table.locator('tr')).toHaveCount(2);
  await table.locator('.tcell').first().click();
  await page.keyboard.type('Name');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Qty');
  await expect(table.locator('.tcell').nth(1)).toHaveValue('Qty');

  await table.getByRole('button', { name: '+ Row' }).click();
  await expect(table.locator('tr')).toHaveCount(3);
  await page.keyboard.type('apples'); // the new row's cell under the focused one has the focus
  await table.getByRole('button', { name: '+ Column' }).click();
  await expect(table.locator('tr').first().locator('td')).toHaveCount(4);
  await table.getByRole('button', { name: '− Column' }).click();
  await expect(table.locator('tr').first().locator('td')).toHaveCount(3);
  const done = saved(page);
  await leaveEdit(page);
  await done;

  await page.reload();
  await expect(page.locator('.item.type-table tr')).toHaveCount(3);
  const t = (await items(page, id))[0];
  expect(t.data.rows).toEqual([
    ['Name', 'Qty', ''],
    ['', 'apples', ''],
    ['', '', ''],
  ]);
  expect(t.data.text).toContain('Name | Qty');
});

test('F6.4: a document opens full screen; typed text persists and the word count updates', async ({ page }) => {
  const id = await freshCanvas(page);
  await place(page, 'document');
  await page.keyboard.type('Field notes');
  await leaveEdit(page);
  await page.locator('.item.type-document').dblclick();
  const dlg = page.locator('#docDialog');
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('.doc-title')).toHaveValue('Field notes');
  await expect(dlg.locator('.doc-count')).toHaveText('0 words');
  await expect(dlg.locator('.ProseMirror')).toBeFocused();
  await page.keyboard.type('One two three');
  await expect(dlg.locator('.doc-count')).toHaveText('3 words');
  await page.keyboard.press('Enter');
  await page.keyboard.type('four');
  await expect(dlg.locator('.doc-count')).toHaveText('4 words');
  const done = saved(page);
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  await done;
  await expect(page.locator('.item.type-document .dfoot')).toContainText('4 words');

  await page.reload();
  const card = page.locator('.item.type-document');
  await expect(card.locator('.dsnip')).toHaveText('One two three\nfour');
  await card.getByRole('button', { name: 'Open' }).click();
  await expect(dlg.locator('.ProseMirror')).toHaveText('One two threefour');
  await expect(dlg.locator('.doc-count')).toHaveText('4 words');
  const d = (await items(page, id))[0].data;
  expect(d.title).toBe('Field notes');
  expect(d.text).toBe('One two three\nfour');
});
