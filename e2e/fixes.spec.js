'use strict';

// Regression coverage for the data-loss fixes: trash + undo, deep duplicate,
// accumulated/flushed saves, and browser history between boards.

const { test, expect } = require('@playwright/test');
const { freshCanvas, place } = require('./helpers');

// Create a board holding one note, straight through the API.
async function boardWithNote(page, canvasId, body) {
  return page.evaluate(
    async ({ canvasId, body }) => {
      const post = b =>
        fetch('/api/item', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(b),
        }).then(r => r.json());
      const board = await post({ canvasId, type: 'board', x: 200, y: 200, data: { title: 'Packed' } });
      await post({ canvasId: board.data.childCanvasId, type: 'note', data: { body } });
      return board;
    },
    { canvasId, body }
  );
}

test('deleting a note can be undone from the toast, and the undo sticks', async ({ page }) => {
  await freshCanvas(page);
  await place(page, 'note');
  await page.locator('.item.type-note .card-tools button[title="Delete"]').click();
  await expect(page.locator('.item.type-note')).toHaveCount(0);

  await page.locator('#toast .toast-action', { hasText: 'Undo' }).click();
  await expect(page.locator('.item.type-note')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('.item.type-note')).toHaveCount(1);
});

test('cmd+Z brings back a deleted board with everything inside it', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  await boardWithNote(page, canvasId, 'precious');
  await page.reload();
  await page.locator('.item.type-board .tile').click();
  await page.keyboard.press('Delete');
  await expect(page.locator('.item.type-board')).toHaveCount(0);

  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('.item.type-board')).toHaveCount(1);
  await page.locator('.item.type-board').dblclick();
  await expect(page.locator('.item.type-note .nbody')).toHaveText('precious');
});

test('duplicating a board copies its contents', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  await boardWithNote(page, canvasId, 'inside');
  await page.reload();
  await page.locator('.item.type-board .tile').click({ button: 'right' });
  await page.locator('#ctxmenu .ctx-item', { hasText: 'Duplicate' }).click();
  await expect(page.locator('.item.type-board')).toHaveCount(2);

  await page.locator('.item.type-board').nth(1).dblclick();
  await expect(page.locator('.item.type-note .nbody')).toHaveText('inside');
});

test('typing a heading then body quickly saves both', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  await place(page, 'note');
  await expect(page.locator('.item.type-note .ProseMirror')).toBeFocused();
  await page.keyboard.type('## Title');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Body');
  await expect
    .poll(async () => (await (await page.request.get('/api/canvas/' + canvasId)).json()).items[0]?.data.text)
    .toBe('Title\nBody');
  await page.reload();
  await expect(page.locator('.item.type-note .nbody h2')).toHaveText('Title');
  await expect(page.locator('.item.type-note .nbody p').first()).toHaveText('Body');
});

test('an edit still in the debounce window is saved when the page is left', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  await place(page, 'note');
  await expect(page.locator('.item.type-note .ProseMirror')).toBeFocused();
  await page.keyboard.type('last words');
  await page.goto('about:blank'); // leave before the 400 ms debounce fires
  await expect
    .poll(async () => {
      const r = await page.request.get('/api/canvas/' + canvasId);
      return (await r.json()).items[0]?.data.text;
    })
    .toBe('last words');
});

test('browser Back returns from a nested board to its parent', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  await place(page, 'board');
  await page.locator('.item.type-board').dblclick();
  await expect(page.locator('#crumbs .crumb')).toHaveCount(3);

  await page.goBack();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#' + canvasId);
  await expect(page.locator('#crumbs .crumb')).toHaveCount(2);
  await page.goForward();
  await expect(page.locator('#crumbs .crumb')).toHaveCount(3);
});
