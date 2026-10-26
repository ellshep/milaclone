'use strict';

// P3b: grid snap + nudge, zoom keys, shortcuts sheet, palette None, navigation
// keys and header rename.

const { test, expect } = require('@playwright/test');
const { freshCanvas, place, leaveEdit } = require('./helpers');

const BULK = r => r.url().endsWith('/api/items') && r.request().method() === 'PATCH';
const pos = loc => loc.evaluate(el => [parseFloat(el.style.left), parseFloat(el.style.top)]);

test('F3.5: a dropped card lands on the 10 px grid; arrows nudge by 10 and shift+arrow by 100', async ({ page }) => {
  await freshCanvas(page);
  await place(page, 'note', 600, 380);
  await leaveEdit(page);
  const note = page.locator('.item.type-note');
  const b = await note.boundingBox();

  const saved = page.waitForResponse(BULK);
  await page.mouse.move(b.x + 40, b.y + 16);
  await page.mouse.down();
  await page.mouse.move(b.x + 40 + 133, b.y + 16 + 57, { steps: 8 });
  await page.mouse.up();
  const body = (await saved).request().postDataJSON();
  const it = body.updates[0];
  expect(it.x % 10).toBe(0);
  expect(it.y % 10).toBe(0);

  await page.keyboard.press('ArrowRight');
  await expect.poll(() => pos(note)).toEqual([it.x + 10, it.y]);
  const nudged = page.waitForResponse(BULK);
  await page.keyboard.press('Shift+ArrowDown');
  await nudged;
  await expect.poll(() => pos(note)).toEqual([it.x + 10, it.y + 100]);
});

test('F3.7: zoom keys scale the canvas, not the page; z fits the board', async ({ page }) => {
  await freshCanvas(page);
  await place(page, 'note', 300, 200);
  await leaveEdit(page);
  const lvl = page.locator('#zoomLvl');
  const dpr = await page.evaluate(() => devicePixelRatio);

  await page.keyboard.press('ControlOrMeta+Equal');
  await expect(lvl).toHaveText('120%');
  await page.keyboard.press('ControlOrMeta+Minus');
  await page.keyboard.press('ControlOrMeta+Minus');
  await expect(lvl).not.toHaveText('120%');
  await page.keyboard.press('ControlOrMeta+0');
  await expect(lvl).toHaveText('100%');
  expect(await page.evaluate(() => devicePixelRatio)).toBe(dpr);

  const before = await page.locator('#world').evaluate(el => el.style.transform);
  await page.keyboard.press('z');
  await expect.poll(() => page.locator('#world').evaluate(el => el.style.transform)).not.toBe(before);
  // the lone card is centred on the stage
  const card = await page.locator('.item.type-note').boundingBox();
  const stage = await page.locator('#stage').boundingBox();
  expect(Math.abs(card.x + card.width / 2 - (stage.x + stage.width / 2))).toBeLessThan(4);
});

test('F3.8: / opens the shortcuts sheet and Escape closes it', async ({ page }) => {
  await freshCanvas(page);
  const sheet = page.locator('#shortcutsDialog');
  await page.keyboard.press('/');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('Zoom to fit');
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await page.keyboard.press('/');
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(sheet).toBeHidden();
});

test('F3.10: palette None clears the colour', async ({ page }) => {
  const id = await freshCanvas(page);
  await place(page, 'note');
  const note = page.locator('.item.type-note');
  await note.locator('.card-tools .swatch').click();
  await page.locator('#palette .sw').nth(7).click(); // red
  await expect(note.locator('.accent')).toHaveCount(1);

  await note.locator('.card-tools .swatch').click();
  const saved = page.waitForResponse(r => r.url().includes('/api/item/') && r.request().method() === 'PATCH');
  await page.locator('#palette .sw-none').click();
  await saved;
  await expect(note.locator('.accent')).toHaveCount(0);
  const items = await page.evaluate(async c => (await (await fetch('/api/canvas/' + c)).json()).items, id);
  expect(items[0].color).toBeNull();
});

test('F3.11: cmd+U goes up, cmd+[ / cmd+] walk history; the header title renames the board', async ({ page }) => {
  const id = await freshCanvas(page);
  await place(page, 'board');
  await page.keyboard.press('Escape');
  await page.locator('.item.type-board').dblclick();
  await expect.poll(() => page.evaluate(() => location.hash)).not.toBe('#' + id);
  const child = await page.evaluate(() => location.hash);

  await page.keyboard.press('ControlOrMeta+u');
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#' + id);
  await page.keyboard.press('ControlOrMeta+BracketLeft');
  await expect.poll(() => page.evaluate(() => location.hash)).toBe(child);
  await page.keyboard.press('ControlOrMeta+BracketLeft');
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#' + id);
  await page.keyboard.press('ControlOrMeta+BracketRight');
  await expect.poll(() => page.evaluate(() => location.hash)).toBe(child);

  await page.locator('#crumbs .crumb.current').click();
  const input = page.locator('#crumbs .crumb-input');
  await expect(input).toBeFocused();
  const saved = page.waitForResponse(r => r.url().includes('/api/canvas/') && r.request().method() === 'PATCH');
  await input.fill('Renamed board');
  await input.press('Enter');
  await saved;
  await expect(page.locator('#crumbs .crumb.current')).toHaveText('Renamed board');

  await page.reload();
  await expect(page.locator('#crumbs .crumb.current')).toHaveText('Renamed board');
  await page.keyboard.press('ControlOrMeta+u');
  await expect(page.locator('.item.type-board .btitle')).toHaveValue('Renamed board');
});

// ---- review regressions ----------------------------------------------------

test('nudging snaps an off-grid card, saves once, and leaves focused controls alone', async ({ page }) => {
  const id = await freshCanvas(page);
  await page.evaluate(
    async c =>
      fetch('/api/item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ canvasId: c, type: 'note', x: 133, y: 77, data: { text: 'off grid' } }),
      }),
    id
  );
  await page.reload();
  const note = page.locator('.item.type-note');
  await note.click({ position: { x: 4, y: 4 } });
  await leaveEdit(page);
  await note.click({ position: { x: 4, y: 4 } });
  await page.keyboard.press('Escape'); // leave the edit a click starts; selection stays
  await note.click({ position: { x: 4, y: 4 }, modifiers: ['Shift'] }); // shift-click re-adds without editing
  await expect(note).toHaveClass(/selected/);

  let bulk = 0;
  page.on('request', r => r.url().endsWith('/api/items') && r.method() === 'PATCH' && bulk++);
  const saved = page.waitForResponse(BULK);
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  await saved;
  await expect.poll(() => pos(note)).toEqual([180, 80]);
  expect(bulk).toBe(1);

  await page.locator('#zoomIn').focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => pos(note)).toEqual([180, 80]);
});

test('cmd+[ never leaves the app; a failed rename reverts; renaming then clicking a crumb navigates', async ({
  page,
}) => {
  const id = await freshCanvas(page);
  await page.keyboard.press('ControlOrMeta+BracketLeft'); // first board this visit: nothing to go back to
  await page.waitForTimeout(200);
  expect(page.url()).toContain('#' + id);

  await page.route('**/api/canvas/*', r => (r.request().method() === 'PATCH' ? r.abort() : r.continue()));
  await page.locator('#crumbs .crumb.current').click();
  await page.locator('#crumbs .crumb-input').fill('Lost name');
  await page.locator('#crumbs .crumb-input').press('Enter');
  await expect(page.locator('.toast')).toContainText('Could not save');
  await expect(page.locator('#crumbs .crumb.current')).toHaveText('fixture');
  await page.unroute('**/api/canvas/*');

  await page.locator('#crumbs .crumb.current').click();
  await page.locator('#crumbs .crumb-input').fill('Half typed');
  await page.locator('#crumbs .crumb').first().click(); // Home
  await expect.poll(() => page.evaluate(() => location.hash)).not.toBe('#' + id);
});

test('palette offers None only where it visibly clears the colour', async ({ page }) => {
  await freshCanvas(page);
  await place(page, 'todo');
  await page.locator('.item.type-todo .card-tools .swatch').click();
  await expect(page.locator('#palette .sw')).toHaveCount(12);
  await expect(page.locator('#palette .sw-none')).toHaveCount(0);
});
