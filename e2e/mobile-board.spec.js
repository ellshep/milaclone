'use strict';

const { test, expect } = require('@playwright/test');
const { freshCanvas } = require('./helpers');

// Taps the centre of an element once it's visible and holding still.
// locator.tap() and click() wait for the element to keep its box across two
// animation frames, and headless WebKit under CI load can render no frame for
// 20 s or more while the page sits idle (AU26: requestAnimationFrame silent,
// timers and the server fine), so those taps ran into the 30 s test timeout.
// Here "holding still" is the same box twice 100 ms apart, which needs no
// frame, and page.touchscreen.tap needs none either (as in the double-tap test).
async function tap(locator) {
  await expect(locator).toBeVisible();
  let box = await locator.boundingBox();
  for (let prev = null; JSON.stringify(box) !== JSON.stringify(prev);) {
    prev = box;
    await locator.page().waitForTimeout(100);
    box = await locator.boundingBox();
  }
  await locator.page().touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

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
  await tap(card.locator('.tile'));

  await expect(card.locator('.card-tools')).toHaveCount(0);
  await expect(page.locator('#mfBoard')).toBeVisible();
  await expect(page.locator('#mfNav')).toBeHidden();

  await tap(page.locator('#mfBoardRename'));
  await expect(page.locator('.item.type-board .btitle')).toBeFocused();
  await page.keyboard.type('Mobile');
  await tap(page.locator('#mfBoardDone'));
  await expect(page.locator('#mfNav')).toBeVisible();
  await expect(page.locator('.item.type-board .btitle')).toHaveValue('Mobile');

  // Wait out the board double-tap window so this re-select does not navigate in.
  await page.waitForTimeout(400);
  await tap(card.locator('.tile'));
  await expect(page.locator('#mfBoard')).toBeVisible();
  await tap(page.locator('#mfBoardMore'));
  await expect(page.locator('#mBoardSheet')).toBeVisible();
  await tap(page.locator('#mBoardSheet [data-act="delete"]'));
  await expect(page.locator('.item.type-board')).toHaveCount(0);
});

test('U2.3 no rubber-band or pull-to-refresh, and no iOS callout on cards (fields keep it)', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  await page.evaluate(
    canvasId =>
      fetch('/api/item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ canvasId, type: 'board', x: 40, y: 160, data: { title: 'Callout' } }),
      }),
    canvasId
  );
  await page.goto('/#' + canvasId);
  await expect(page.locator('.item.type-board')).toBeVisible();
  expect(await page.locator('html').evaluate(el => getComputedStyle(el).overscrollBehaviorY)).toBe('none');
  expect(await page.locator('body').evaluate(el => getComputedStyle(el).overscrollBehaviorY)).toBe('none');
  // -webkit-touch-callout exists only in iOS WebKit (desktop builds drop it from the CSSOM),
  // so check the shipped rules; the computed value is part of the iPhone check.
  const sheet = (await (await page.request.get('/style.css')).text()).replace(/\s+/g, ' ');
  expect(sheet).toContain('#stage, .item { -webkit-touch-callout: none; }');
  expect(sheet).toContain(
    ".item input, .item textarea, .item [contenteditable='true'] { -webkit-touch-callout: default; }"
  );
});

test('Quick notes lifts the page touch lock while open, so its lists can scroll', async ({ page }) => {
  await freshCanvas(page);
  const touch = sel => page.locator(sel).evaluate(el => getComputedStyle(el).touchAction);
  expect(await touch('html')).toBe('none');
  expect(await touch('body')).toBe('none');

  await tap(page.locator('#mNotes'));
  await expect(page.locator('#quicknotes')).toBeVisible();
  expect(await touch('html')).toBe('auto');
  expect(await touch('body')).toBe('auto');
  expect(await touch('.qn-home-scroll')).toBe('pan-y');
  expect(await page.locator('.qn-home-scroll').evaluate(el => getComputedStyle(el).overflowY)).toBe('auto');

  await tap(page.locator('#qnBoards'));
  await expect(page.locator('#quicknotes')).toBeHidden();
  expect(await touch('html')).toBe('none');
  expect(await touch('body')).toBe('none');
});
