'use strict';

// P7c: labels on cards and the topbar filter.

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
const items = async (page, canvasId) => (await (await page.request.get('/api/canvas/' + canvasId)).json()).items;

test('F7.7: labels persist, and filtering by a label dims or hides the cards without it', async ({ page }) => {
  const id = await freshCanvas(page);
  const a = await post(page, { canvasId: id, type: 'note', x: 120, y: 120, data: { body: 'Alpha' } });
  const b = await post(page, { canvasId: id, type: 'note', x: 420, y: 120, data: { body: 'Beta' } });
  const c = await post(page, { canvasId: id, type: 'todo', x: 120, y: 360, data: { title: 'Gamma', tasks: [] } });
  await page.reload();
  const card = x => page.locator(`.item[data-id="${x.id}"]`);

  // Label Alpha and Gamma "urgent" (one sheet for both), and Beta "later".
  await card(a).click({ button: 'right' });
  await page.getByRole('button', { name: 'Labels…' }).click();
  await page.locator('#labelNew').fill('urgent');
  const saved = page.waitForResponse(r => r.request().method() === 'PATCH' && r.url().includes(a.id));
  await page.locator('#labelNew').press('Enter');
  await expect(page.locator('#labelList .filter-row')).toHaveText(['urgent']);
  await page.keyboard.press('Escape');
  await saved;
  await expect(card(a).locator('.label-chip')).toHaveText('urgent');

  await card(c).click({ button: 'right' });
  await page.getByRole('button', { name: 'Labels…' }).click();
  await page.locator('#labelList .filter-row', { hasText: 'urgent' }).locator('input').check();
  await page.locator('#labelNew').fill('later');
  await page.locator('#labelNew').press('Enter');
  await page.keyboard.press('Escape');
  await card(b).click({ button: 'right' });
  await page.getByRole('button', { name: 'Labels…' }).click();
  await page.locator('#labelList .filter-row', { hasText: 'later' }).locator('input').check();
  await page.keyboard.press('Escape');

  await expect
    .poll(async () => (await items(page, id)).map(i => [i.data.body || i.data.title, i.data.labels]))
    .toEqual(
      expect.arrayContaining([
        ['Gamma', ['urgent', 'later']],
        [undefined, ['later']],
      ])
    );
  await page.reload();
  await expect(card(a).locator('.label-chip')).toHaveText('urgent');
  await expect(card(c).locator('.label-chip')).toHaveText(['urgent', 'later']);
  await expect(card(b).locator('.label-chip')).toHaveText('later');

  // Filter by "urgent": Beta dims, then hides.
  await page.click('#filterBtn');
  await page.locator('#filterMenu .filter-row', { hasText: 'urgent' }).locator('input').check();
  await expect(card(b)).toHaveClass(/filtered-out/);
  await expect(card(b)).toHaveCSS('opacity', '0.18');
  await expect(card(a)).not.toHaveClass(/filtered-out/);
  await expect(card(c)).not.toHaveClass(/filtered-out/);
  await page.locator('#filterMenu .filter-mode input').check();
  await expect(card(b)).toBeHidden();
  await expect(card(a)).toBeVisible();
  await expect(page.locator('#filterBtn')).toHaveClass(/on/);

  // Clearing the label shows everything again; another board starts unfiltered.
  await page.locator('#filterMenu .filter-row', { hasText: 'urgent' }).locator('input').uncheck();
  await expect(card(b)).toBeVisible();
  await page.locator('#filterMenu .filter-row', { hasText: 'later' }).locator('input').check();
  await expect(card(a)).toBeHidden();
  await page.mouse.click(1150, 660); // close the menu
  await page.keyboard.press('ControlOrMeta+u');
  await expect(page.locator('#filterBtn')).not.toHaveClass(/on/);
  await expect(page.locator('.item.filtered-out')).toHaveCount(0);
});

test('F7.7: the filter never hides what you act on, and lets go of a label that disappears', async ({ page }) => {
  const id = await freshCanvas(page);
  const a = await post(page, { canvasId: id, type: 'note', x: 120, y: 120, data: { body: 'A', labels: ['Urgent'] } });
  const b = await post(page, { canvasId: id, type: 'note', x: 520, y: 120, data: { body: 'B' } });
  await post(page, { canvasId: id, type: 'line', data: { from: { id: a.id }, to: { id: b.id } } });
  await page.reload();
  const card = x => page.locator(`.item[data-id="${x.id}"]`);
  await expect(page.locator('#lines .line')).toHaveCount(1);

  await page.click('#filterBtn');
  await page.locator('#filterMenu .filter-row', { hasText: 'Urgent' }).locator('input').check();
  await page.locator('#filterMenu .filter-mode input').check();
  await expect(card(b)).toBeHidden();
  await expect(page.locator('#lines .line')).toHaveCount(0); // its line goes with it
  await page.mouse.click(1150, 660);

  // cmd+A + Delete only reaches the visible card.
  await page.keyboard.press('ControlOrMeta+a');
  await expect(page.locator('.item.selected')).toHaveCount(1);
  await page.keyboard.press('Escape');

  // A card made while filtering stays in view.
  await page.click('.tool[data-tool="note"]');
  await page.mouse.click(700, 450);
  await expect(page.locator('.item.type-note.editing')).toBeVisible();
  await page.mouse.click(1150, 660);

  // Typing "urgent" reuses the existing "Urgent" label.
  await card(a).click({ button: 'right' });
  await page.getByRole('button', { name: 'Labels…' }).click();
  await page.locator('#labelNew').fill('urgent');
  await page.locator('#labelNew').press('Enter');
  await expect(page.locator('#labelList .filter-row')).toHaveText(['Urgent']);
  // Removing the only "Urgent" ends the filter instead of leaving the board dimmed.
  await page.locator('#labelList .filter-row', { hasText: 'Urgent' }).locator('input').click();
  await expect(page.locator('#labelList .filter-row')).toHaveCount(0); // no card carries it now
  await page.keyboard.press('Escape');
  await expect(page.locator('#filterBtn')).not.toHaveClass(/on/);
  await expect(card(b)).toBeVisible();
  await expect(page.locator('.item.filtered-out')).toHaveCount(0);
  await expect(page.locator('#lines .line')).toHaveCount(1);
});
