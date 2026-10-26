'use strict';

// P5a: global search (cmd+K), Markdown export and backup download.

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

test('F5.1: cmd+K finds text on a nested board; clicking the result opens it', async ({ page }) => {
  const id = await freshCanvas(page);
  const nested = await post(page, { canvasId: id, type: 'board', data: { title: 'Archive' } });
  const word = 'zebra' + Date.now();
  const hit = await post(page, {
    canvasId: nested.data.childCanvasId,
    type: 'note',
    x: 900,
    y: 700,
    data: { body: word },
  });
  const binned = await post(page, { canvasId: id, type: 'note', data: { body: word + ' binned' } });
  await page.evaluate(i => fetch('/api/item/' + i, { method: 'DELETE' }), binned.id);

  await page.keyboard.press('ControlOrMeta+k');
  const dialog = page.locator('#searchDialog');
  await expect(dialog).toBeVisible();
  await page.keyboard.type(word);
  const results = dialog.locator('.sr-item');
  await expect(results).toHaveCount(1); // the trashed note isn't listed
  await expect(results.first().locator('.sr-path')).toHaveText(/fixture \/ Archive$/);

  await results.first().click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#' + nested.data.childCanvasId);
  const card = page.locator(`.item[data-id="${hit.id}"]`);
  await expect(card).toHaveClass(/selected/);
  await expect(card).toBeInViewport(); // scrolled to, though it sits far from the origin
});

test('search: Enter opens the first result; no match says so', async ({ page }) => {
  const id = await freshCanvas(page);
  const title = 'Quokka plans ' + Date.now();
  const board = await post(page, { canvasId: id, type: 'board', data: { title } });
  await page.locator('#searchBtn').click();
  await page.keyboard.type(title.toLowerCase());
  await expect(page.locator('#searchResults .sr-item')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#' + board.data.childCanvasId);

  await page.keyboard.press('ControlOrMeta+k');
  await page.locator('#searchInput').fill('no-such-thing-' + Date.now());
  await expect(page.locator('#searchEmpty')).toBeVisible();
});

test('search: Enter right after typing opens the match for the full query', async ({ page }) => {
  const id = await freshCanvas(page);
  const tag = 'ibis' + Date.now();
  await post(page, { canvasId: id, type: 'board', data: { title: tag + ' alpha' } });
  const want = await post(page, { canvasId: id, type: 'board', data: { title: tag + ' omega' } });
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type(tag);
  await expect(page.locator('#searchResults .sr-item')).toHaveCount(2);
  await page.keyboard.type(' omega');
  await page.keyboard.press('Enter'); // inside the debounce window
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#' + want.data.childCanvasId);
});

test('F5.2 / F5.3: the Export menu downloads the board as Markdown and a database backup', async ({ page }) => {
  const id = await freshCanvas(page);
  await post(page, { canvasId: id, type: 'note', data: { title: 'Exported', body: 'body line' } });
  await page.locator('#exportBtn').click();
  const menu = page.locator('#exportMenu');
  await expect(menu).toBeVisible();

  const [md] = await Promise.all([page.waitForEvent('download'), menu.getByText('This board as Markdown').click()]);
  expect(md.suggestedFilename()).toBe('fixture.md');
  const text = require('fs').readFileSync(await md.path(), 'utf8');
  expect(text).toContain('# fixture\n\n## Exported\nbody line');
  await expect(menu).toBeHidden();

  await page.locator('#exportBtn').click();
  const [db] = await Promise.all([page.waitForEvent('download'), menu.getByText(/database backup/i).click()]);
  expect(db.suggestedFilename()).toMatch(/^milaclone-\d{4}-\d{2}-\d{2}\.db$/);
  expect(
    require('fs')
      .readFileSync(await db.path())
      .subarray(0, 15)
      .toString()
  ).toBe('SQLite format 3');
});
