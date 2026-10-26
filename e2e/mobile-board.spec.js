'use strict';

const { test, expect } = require('@playwright/test');
const { freshCanvas } = require('./helpers');

// WebKit/Safari does not synthesize dblclick from touch double-taps, so board
// open has to be driven by our own pointer double-tap detection.

test('double-tap opens a board card on mobile Safari', async ({ page }) => {
  const canvasId = await freshCanvas(page);

  const board = await page.evaluate(async canvasId => {
    const it = await (
      await fetch('/api/item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ canvasId, type: 'board', x: 40, y: 160, data: { title: 'Nested' } }),
      })
    ).json();
    return { id: it.id, childId: it.data.childCanvasId };
  }, canvasId);

  // Re-enter the canvas so the new card is rendered.
  await page.goto('/#' + canvasId);
  const card = page.locator(`.item.type-board[data-id="${board.id}"]`);
  await expect(card).toBeVisible();

  const box = await card.locator('.tile').boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  await page.touchscreen.tap(x, y);
  await page.waitForTimeout(120);
  await page.touchscreen.tap(x, y);

  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#' + board.childId);
  await expect(page.locator('#mheader')).toBeVisible();
});

test('mobile footer stays glued to the viewport bottom after canvas zoom', async ({ page }) => {
  await page.goto('/');
  const footer = page.locator('#mfooter');
  await expect(footer).toBeVisible();

  const probe = () =>
    page.locator('#mfooter').evaluate(el => {
      const r = el.getBoundingClientRect();
      return {
        bottom: r.bottom,
        position: getComputedStyle(el).position,
        vh: window.innerHeight,
      };
    });

  const before = await probe();
  expect(before.position).toBe('fixed');
  expect(Math.abs(before.bottom - before.vh)).toBeLessThan(2);

  // Canvas camera zoom transforms #world only and must not lift the footer.
  await page.evaluate(() => {
    document.getElementById('world').style.transform = 'translate(40px, 80px) scale(1.8)';
  });

  const after = await probe();
  expect(after.position).toBe('fixed');
  expect(Math.abs(after.bottom - after.vh)).toBeLessThan(2);
});

test('board selection footer offers color icon rename and delete', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  const board = await page.evaluate(async canvasId => {
    const it = await (
      await fetch('/api/item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ canvasId, type: 'board', x: 40, y: 160, data: { title: 'Phone' } }),
      })
    ).json();
    return { id: it.id };
  }, canvasId);
  await page.goto('/#' + canvasId);
  const card = page.locator(`.item.type-board[data-id="${board.id}"]`);
  await expect(card).toBeVisible();
  await card.locator('.tile').tap();

  await expect(card.locator('.card-tools')).toHaveCount(0);
  await expect(page.locator('#mfBoard')).toBeVisible();
  await expect(page.locator('#mfNav')).toBeHidden();

  await page.locator('#mfBoardRename').tap();
  await expect(page.locator('.item.type-board .btitle')).toBeFocused();
  await page.keyboard.type('Mobile');
  await page.locator('#mfBoardDone').tap();
  await expect(page.locator('#mfNav')).toBeVisible();
  await expect(page.locator('.item.type-board .btitle')).toHaveValue('Mobile');

  // Wait out the board double-tap window so this re-select does not navigate in.
  await page.waitForTimeout(400);
  await card.locator('.tile').tap();
  await expect(page.locator('#mfBoard')).toBeVisible();
  await page.locator('#mfBoardMore').tap();
  await expect(page.locator('#mBoardSheet')).toBeVisible();
  await page.locator('#mBoardSheet [data-act="delete"]').tap();
  await expect(page.locator('.item.type-board')).toHaveCount(0);
});
