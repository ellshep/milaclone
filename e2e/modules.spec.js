'use strict';

// Behavioral coverage for module features the original ui.spec.js doesn't
// exercise: clipboard.js (copy/cut/paste), menus.js (color palette), cards.js +
// util.js (link normalization), drag.js (free move + resize), editing.js
// (keyboard rename), and viewport.js (pan).

const { test, expect } = require('@playwright/test');
const { freshCanvas, place, leaveEdit } = require('./helpers');

const PATCH = r => r.url().includes('/api/item/') && r.request().method() === 'PATCH';
const CREATE = r => r.url().endsWith('/api/item') && r.request().method() === 'POST';

test('context menu: copy then paste yields a second note', async ({ page }) => {
  await freshCanvas(page);
  await place(page, 'note');
  await leaveEdit(page);
  const note = page.locator('.item.type-note');

  await note.click({ button: 'right' });
  await page.locator('#ctxmenu .ctx-item', { hasText: 'Copy' }).click();

  await note.first().click({ button: 'right' });
  const created = page.waitForResponse(CREATE);
  await page.locator('#ctxmenu .ctx-item', { hasText: 'Paste' }).click();
  await created;

  await expect(note).toHaveCount(2);
});

test('context menu: cut then paste keeps a single note (moves it)', async ({ page }) => {
  await freshCanvas(page);
  await place(page, 'note');
  await leaveEdit(page);
  const note = page.locator('.item.type-note');

  await note.click({ button: 'right' });
  await page.locator('#ctxmenu .ctx-item', { hasText: 'Cut' }).click();

  await note.click({ button: 'right' });
  const created = page.waitForResponse(CREATE);
  await page.locator('#ctxmenu .ctx-item', { hasText: 'Paste' }).click();
  await created;

  // cut removes the original as part of the paste, so the count stays at 1
  await expect(note).toHaveCount(1);
});

test('color palette recolors a note and the color survives reload', async ({ page }) => {
  const id = await freshCanvas(page);
  await place(page, 'note');
  // leave the note selected so its card-tools (and color swatch) stay visible
  const note = page.locator('.item.type-note');

  // a plain note has no accent bar; picking a color adds one
  await expect(note.locator('.accent')).toHaveCount(0);
  await note.locator('.card-tools .swatch').click();
  await expect(page.locator('#palette.open')).toBeVisible();
  const saved = page.waitForResponse(PATCH);
  await page.locator('#palette .sw').nth(7).click();   // 8th swatch (red)
  await saved;

  await page.goto('/#' + id);
  await expect(page.locator('.item.type-note .accent')).toHaveCount(1);
});

test('link card normalizes a bare host to an https open URL', async ({ page }) => {
  await freshCanvas(page);
  await place(page, 'link');
  const link = page.locator('.item.type-link');
  await expect(link).toHaveCount(1);

  // the card drops into edit with the title focused; fill the URL field directly
  await link.locator('.lurl').fill('example.com');
  await expect(link.locator('a.open')).toHaveAttribute('href', 'https://example.com');
});

test('free-dragging a note persists its new position across reload', async ({ page }) => {
  const id = await freshCanvas(page);
  await place(page, 'note', 600, 380);
  await leaveEdit(page);
  const note = page.locator('.item.type-note');
  const before = await note.boundingBox();

  const moved = page.waitForResponse(PATCH);
  await page.mouse.move(before.x + before.width / 2, before.y + 16);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 + 180, before.y + 16 + 70, { steps: 10 });
  await page.mouse.up();
  await moved;

  await page.goto('/#' + id);
  const after = await page.locator('.item.type-note').boundingBox();
  expect(after.x - before.x).toBeGreaterThan(120);
  expect(after.y - before.y).toBeGreaterThan(40);
});

test('resizing a note persists its new width across reload', async ({ page }) => {
  const id = await freshCanvas(page);
  await place(page, 'note', 600, 380);
  await leaveEdit(page);
  const note = page.locator('.item.type-note');
  const before = await note.boundingBox();

  const handle = note.locator('.resize');
  const hb = await handle.boundingBox();
  const resized = page.waitForResponse(PATCH);
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 + 120, hb.y + hb.height / 2, { steps: 10 });
  await page.mouse.up();
  await resized;

  await page.goto('/#' + id);
  const after = await page.locator('.item.type-note').boundingBox();
  expect(after.width - before.width).toBeGreaterThan(80);
});

test('Enter renames the selected board and the name persists', async ({ page }) => {
  const id = await freshCanvas(page);
  await place(page, 'board');
  await page.keyboard.press('Escape');
  await page.locator('.item.type-board .tile').click();   // select without editing

  await page.keyboard.press('Enter');                     // renameSelected -> edit title
  // focus lands on the title input a frame later (rAF); wait for it before
  // typing so keystrokes aren't dropped on the way in.
  await expect(page.locator('.item.type-board .btitle')).toBeFocused();
  const saved = page.waitForResponse(PATCH);
  await page.keyboard.type('Renamed');
  await saved;
  await leaveEdit(page);

  await page.goto('/#' + id);
  await expect(page.locator('.item.type-board .btitle')).toHaveValue('Renamed');
});

test('dragging empty canvas pans the world', async ({ page }) => {
  await freshCanvas(page);
  const transformBefore = await page.locator('#world').evaluate(el => el.style.transform);

  await page.mouse.move(700, 300);
  await page.mouse.down();
  await page.mouse.move(500, 500, { steps: 10 });
  await page.mouse.up();

  const transformAfter = await page.locator('#world').evaluate(el => el.style.transform);
  expect(transformAfter).not.toBe(transformBefore);
});
