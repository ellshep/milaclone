'use strict';

// Behavioral coverage for module features the original ui.spec.js doesn't
// exercise: clipboard.js (copy/cut/paste), menus.js (colour palette, icon search), cards.js +
// util.js (link normalization), drag.js (free move + resize), editing.js
// (keyboard rename), and viewport.js (pan).

const { test, expect } = require('@playwright/test');
const { freshCanvas, place, leaveEdit } = require('./helpers');

const PATCH = r => r.url().includes('/api/item/') && r.request().method() === 'PATCH';
const PASTED = r => /\/api\/item\/[^/]+\/(copy|move)$/.test(r.url());

test('context menu: copy then paste yields a second note', async ({ page }) => {
  await freshCanvas(page);
  await place(page, 'note');
  await leaveEdit(page);
  const note = page.locator('.item.type-note');

  await note.click({ button: 'right' });
  await page.locator('#ctxmenu .ctx-item', { hasText: 'Copy' }).click();

  await note.first().click({ button: 'right' });
  const created = page.waitForResponse(PASTED);
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
  const moved = page.waitForResponse(PASTED);
  await page.locator('#ctxmenu .ctx-item', { hasText: 'Paste' }).click();
  await moved;

  // cut + paste moves the original, so the count stays at 1
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
  await page.locator('#palette .sw').nth(7).click(); // 8th swatch (red)
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

  // drops are saved in one bulk PATCH (the card plus any group it moved with)
  const moved = page.waitForResponse(r => r.url().endsWith('/api/items') && r.request().method() === 'PATCH');
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

test('a long board name wraps, Enter ends the rename, and the board card resizes', async ({ page }) => {
  const id = await freshCanvas(page);
  const name = 'A very long board name that would never fit on one line of a board card';
  await page.evaluate(
    ([canvasId, title]) =>
      fetch('/api/item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ canvasId, type: 'board', x: 300, y: 200, w: 152, data: { title } }),
      }),
    [id, name]
  );
  await page.reload();
  const board = page.locator('.item.type-board');
  const title = board.locator('.btitle');
  await expect(title).toHaveValue(name);
  const box = await board.boundingBox();
  const tb = await title.boundingBox();
  expect(tb.height).toBeGreaterThan(40); // wrapped onto several lines, not clipped
  expect(tb.width).toBeLessThanOrEqual(box.width);

  // Enter ends the rename instead of adding a line break.
  await board.locator('.tile').click();
  await page.keyboard.press('Enter');
  await expect(title).toBeFocused();
  await page.keyboard.press('End');
  const saved = page.waitForResponse(PATCH);
  await page.keyboard.type('!');
  await saved;
  await page.keyboard.press('Enter');
  await expect(page.locator('.item.editing')).toHaveCount(0);
  await expect(title).toHaveValue(name + '!');

  // The resize handle widens the board, so the name takes fewer lines.
  const hb = await board.locator('.resize').boundingBox();
  const resized = page.waitForResponse(PATCH);
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 + 300, hb.y + hb.height / 2, { steps: 10 });
  await page.mouse.up();
  await resized;
  await page.reload();
  expect((await board.boundingBox()).width - box.width).toBeGreaterThan(250);
  expect((await title.boundingBox()).height).toBeLessThan(tb.height);
});

test('Enter renames the selected board and the name persists', async ({ page }) => {
  const id = await freshCanvas(page);
  await place(page, 'board');
  await page.keyboard.press('Escape');
  await page.locator('.item.type-board .tile').click(); // select without editing

  await page.keyboard.press('Enter'); // renameSelected -> edit title
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

// Decision D2: left-drag on empty canvas selects; space-drag and middle-drag pan.
test('space-drag and middle-drag pan the world; plain left-drag does not', async ({ page }) => {
  await freshCanvas(page);
  const transform = () => page.locator('#world').evaluate(el => el.style.transform);
  const drag = async (button = 'left') => {
    await page.mouse.move(700, 300);
    await page.mouse.down({ button });
    await page.mouse.move(500, 500, { steps: 10 });
    await page.mouse.up({ button });
  };

  const t0 = await transform();
  await drag();
  expect(await transform()).toBe(t0);

  await page.keyboard.down('Space');
  await drag();
  await page.keyboard.up('Space');
  const t1 = await transform();
  expect(t1).not.toBe(t0);

  await drag('middle');
  expect(await transform()).not.toBe(t1);
});

test('board selection chrome replaces the badge with rail actions', async ({ page }) => {
  await freshCanvas(page);
  await place(page, 'board');
  await page.keyboard.press('Escape');
  const card = page.locator('.item.type-board');
  await card.locator('.tile').click();

  await expect(card.locator('.card-tools')).toHaveCount(0);
  await expect(page.locator('#railBoard')).toBeVisible();
  await expect(page.locator('#railCreate')).toBeHidden();

  await page.locator('#railBoardColor').click();
  await expect(page.locator('#palette.open')).toBeVisible();
  await page.locator('#palette .sw').nth(7).click(); // red
  await expect(card.locator('.tile')).toHaveCSS('background-color', 'rgb(239, 75, 75)');

  await page.locator('#railBoardRename').click();
  await expect(page.locator('.item.type-board .btitle')).toBeFocused();
  await page.keyboard.type('Sidebar');
  await page.locator('#stage').click({ position: { x: 40, y: 40 } }); // blur / deselect
  await expect(page.locator('.item.type-board .btitle')).toHaveValue('Sidebar');

  await card.locator('.tile').click();
  await page.locator('#railBoardDelete').click();
  await expect(page.locator('.item.type-board')).toHaveCount(0);
  await expect(page.locator('#railCreate')).toBeVisible();
});

test('board icon picker searches every Lucide icon and saves the pick', async ({ page }) => {
  await freshCanvas(page);
  await place(page, 'board');
  await page.keyboard.press('Escape');
  const card = page.locator('.item.type-board');
  await card.locator('.tile').click();

  await page.locator('#railBoardIcon').click();
  const search = page.locator('#palette .icon-search');
  await expect(search).toBeFocused();
  await expect(page.locator('#palette .icon-pick')).toHaveCount(24); // the suggestions

  await page.keyboard.type('rocket'); // not one of the suggestions
  await expect(page.locator('#palette .icon-pick[title="rocket"] svg')).toHaveCount(1);
  const saved = page.waitForResponse(PATCH);
  await page.keyboard.press('Enter');
  expect((await saved).request().postDataJSON().data.icon).toBe('rocket');
  await expect(page.locator('#palette.open')).toHaveCount(0);
  await expect(card.locator('.tile svg.lucide-rocket')).toHaveCount(1);
  await expect(card.locator('.btitle')).not.toBeFocused(); // Enter picked; it didn't also rename
});
