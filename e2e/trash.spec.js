'use strict';

const { test, expect } = require('@playwright/test');
const { freshCanvas } = require('./helpers');

// P1 · Robustness tail: trash sheet, refetch on focus, upload rejection reasons.

const api = (page, method, url, body) =>
  page.evaluate(
    async ([method, url, body]) => {
      const r = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body && { body: JSON.stringify(body) }),
      });
      return r.json();
    },
    [method, url, body]
  );

test('F1.1 a deleted card can be restored from the trash sheet', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  const note = await api(page, 'POST', '/api/item', { canvasId, type: 'note', data: { title: 'Bring back' } });
  await api(page, 'DELETE', '/api/item/' + note.id);
  await page.reload();

  await page.click('#trashBtn');
  const row = page.locator(`#trashList li[data-id="${note.id}"]`);
  await expect(row).toContainText('Bring back');
  await expect(row).toContainText('fixture');
  await row.getByRole('button', { name: 'Restore' }).click();

  await expect(page.locator(`.item[data-id="${note.id}"]`)).toBeVisible();
  await expect(row).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('#trashDialog')).not.toHaveAttribute('open');
});

test('F1.2 empty trash asks first, then reports what it deleted', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  const note = await api(page, 'POST', '/api/item', { canvasId, type: 'note' });
  await api(page, 'DELETE', '/api/item/' + note.id);
  // Stubbed: a real purge would race the other parallel tests' undo.
  let purged = 0;
  await page.route('**/api/trash', route => {
    if (route.request().method() !== 'DELETE') return route.continue();
    purged++;
    return route.fulfill({ json: { items: 3, files: 1 } });
  });
  await page.click('#trashBtn');

  page.once('dialog', d => d.dismiss());
  const empty = page.locator('#trashEmpty');
  await expect(empty).toBeEnabled();
  await empty.click();
  expect(purged).toBe(0);

  page.once('dialog', d => d.accept());
  await empty.click();
  await expect(page.locator('#toast')).toContainText('Deleted 3 items for good');
  expect(purged).toBe(1);
});

test('F1.4 returning to the tab shows changes made elsewhere', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  const note = await api(page, 'POST', '/api/item', { canvasId, type: 'note', data: { title: 'Before' } });
  await page.reload();
  const title = page.locator(`.item[data-id="${note.id}"]`).getByRole('textbox', { name: 'Title' });
  await expect(title).toHaveValue('Before');

  await api(page, 'PATCH', '/api/item/' + note.id, { data: { title: 'After' } }); // "another device"
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(title).toHaveValue('After');
});

test('F1.5 a rejected upload says why', async ({ page }) => {
  await freshCanvas(page);
  await page.setInputFiles('#uploadInput', {
    name: 'setup.exe',
    mimeType: 'application/x-msdownload',
    buffer: Buffer.from('MZ'),
  });
  await expect(page.locator('#toast')).toContainText("application/x-msdownload files can't be uploaded");
});
