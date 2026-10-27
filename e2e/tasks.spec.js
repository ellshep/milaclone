'use strict';

// P7a: nested tasks, drag to reorder, Quick notes' due dates and tags on the canvas card.

const { test, expect } = require('@playwright/test');
const { freshCanvas } = require('./helpers');

const todo = async (page, canvasId, tasks, title = 'List') => {
  await page.evaluate(
    b =>
      fetch('/api/item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(b),
      }),
    { canvasId, type: 'todo', x: 300, y: 200, data: { title, tasks } }
  );
  await page.reload();
};
const saved = async (page, canvasId) =>
  (await (await page.request.get('/api/canvas/' + canvasId)).json()).items[0].data.tasks;
const patched = page => page.waitForResponse(r => r.url().includes('/api/item/') && r.request().method() === 'PATCH');
// Fields ignore the pointer until their card is being edited: the first click edits.
const editTask = async (page, n) => {
  if (!(await page.locator('.item.type-todo.editing').count())) {
    await page.locator('.item.type-todo').click({ position: { x: 6, y: 6 } });
  }
  await page.locator('.task .txt').nth(n).click();
};
const t = (id, text, extra) => ({ id, text, done: false, ...extra });

test('F7.1: tab and shift+tab change a task’s indent, one level under the task above', async ({ page }) => {
  const id = await freshCanvas(page);
  await todo(page, id, [t('a', 'Trip'), t('b', 'Book train'), t('c', 'Pack')]);
  const indents = async () => (await saved(page, id)).map(x => x.indent || 0);

  await editTask(page, 1);
  await expect(page.locator('.task .txt').nth(1)).toBeFocused();
  let p = patched(page);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab'); // capped: one deeper than "Trip"
  await p;
  expect(await indents()).toEqual([0, 1, 0]);
  await expect(page.locator('.task').nth(1)).toHaveCSS('padding-left', '20px');

  await editTask(page, 2);
  p = patched(page);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await p;
  expect(await indents()).toEqual([0, 1, 2]);
  p = patched(page);
  await page.keyboard.press('Shift+Tab');
  await p;
  expect(await indents()).toEqual([0, 1, 1]);
  await expect(page.locator('.task .txt').nth(2)).toBeFocused(); // tab never leaves the list

  await editTask(page, 0);
  await page.keyboard.press('Tab'); // the first task can't nest
  await page.waitForTimeout(500);
  expect(await indents()).toEqual([0, 1, 1]);

  // outdenting a parent pulls its subtasks up with it
  await editTask(page, 1);
  p = patched(page);
  await page.keyboard.press('Shift+Tab');
  await p;
  expect(await indents()).toEqual([0, 0, 1]);

  await page.reload();
  await expect(page.locator('.task').nth(2)).toHaveCSS('padding-left', '20px');
});

test('F7.2: dragging a task by its grip reorders the list, and the order persists', async ({ page }) => {
  const id = await freshCanvas(page);
  await todo(page, id, [t('a', 'First'), t('b', 'Second'), t('c', 'Third')]);
  const rows = page.locator('.task');
  await rows.nth(2).hover();
  const grip = await rows.nth(2).locator('.grip').boundingBox();
  const top = await rows.nth(0).boundingBox();
  const p = patched(page);
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, top.y + 2, { steps: 8 });
  await page.mouse.up();
  await p;
  expect((await saved(page, id)).map(x => x.id)).toEqual(['c', 'a', 'b']);

  await page.reload();
  const texts = await page.locator('.task .txt').evaluateAll(f => f.map(x => x.value));
  expect(texts).toEqual(['Third', 'First', 'Second']);
  // the card itself didn't move
  await expect(page.locator('.item.type-todo')).toHaveCSS('left', '300px');
});

test('F7.3: a due date set in Quick notes shows on the canvas card, with the task’s tags', async ({ page }) => {
  const id = await freshCanvas(page);
  const title = 'Due-' + Date.now();
  await todo(page, id, [t('a', 'File taxes', { tags: ['money'] })], title);
  await expect(page.locator('.task .tmeta')).toHaveText('#money');

  await page.click('#phoneNotes');
  await expect(page.locator('#quicknotes')).toBeVisible();
  await page.locator('.qn-row-btn', { hasText: title }).click();
  await page.locator('.qn-task', { hasText: 'File taxes' }).click();
  await page.locator('#qnDetails .qn-dateinput').fill('2030-08-07');
  await expect(page.locator('.qn-due-label')).toHaveText('Due Wed, Aug 7');
  const reloaded = page.waitForResponse(r => r.url().includes('/api/canvas/' + id));
  await page.click('#phoneNotes'); // closes, flushes, re-syncs the board
  await reloaded;

  const meta = page.locator('.item.type-todo .task .tmeta');
  await expect(meta.locator('.tdue')).toHaveText('Wed, Aug 7');
  await expect(meta.locator('.ttag')).toHaveText('#money');
  expect((await saved(page, id))[0].due).toBe('2030-08-07');
});
