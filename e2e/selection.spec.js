'use strict';

const { test, expect } = require('@playwright/test');
const { freshCanvas } = require('./helpers');

// P3a · Selection set, selection box, group actions, stacking order.

const api = (page, method, url, body) =>
  page.evaluate(
    async ([method, url, body]) =>
      (
        await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          ...(body && { body: JSON.stringify(body) }),
        })
      ).json(),
    [method, url, body]
  );

// File cards: they select on click without entering edit mode.
async function threeCards(page) {
  const canvasId = await freshCanvas(page);
  const mk = (x, y, name) => api(page, 'POST', '/api/item', { canvasId, type: 'file', x, y, data: { name } });
  const cards = [await mk(100, 100, 'a.pdf'), await mk(400, 100, 'b.pdf'), await mk(100, 300, 'c.pdf')];
  await page.reload();
  for (const c of cards) await expect(page.locator(`.item[data-id="${c.id}"]`)).toBeVisible();
  return { canvasId, cards, card: c => page.locator(`.item[data-id="${c.id}"]`) };
}

const selectedCount = page => page.locator('#world .item.selected').count();

async function boxSelect(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

// Selection box from the empty corner past the bottom-right card.
async function selectAllByBox(page, cards, card) {
  const boxes = await Promise.all(cards.map(c => card(c).boundingBox()));
  const right = Math.max(...boxes.map(b => b.x + b.width)) + 20;
  const bottom = Math.max(...boxes.map(b => b.y + b.height)) + 20;
  await boxSelect(page, { x: boxes[0].x - 20, y: boxes[0].y - 20 }, { x: right, y: bottom });
}

test('F3.1 a selection box selects every card it touches; space-drag pans without selecting', async ({ page }) => {
  const { cards, card } = await threeCards(page);
  await selectAllByBox(page, cards, card);
  await expect(page.locator('#world .item.selected')).toHaveCount(3);
  await expect(page.locator('.marquee')).toHaveCount(0);

  await page.mouse.click(1100, 650); // empty canvas: clears the selection
  await expect(page.locator('#world .item.selected')).toHaveCount(0);

  const before = await page.locator('#world').evaluate(el => el.style.transform);
  await page.keyboard.down('Space');
  await boxSelect(page, { x: 1100, y: 650 }, { x: 300, y: 200 });
  await page.keyboard.up('Space');
  expect(await selectedCount(page)).toBe(0);
  expect(await page.locator('#world').evaluate(el => el.style.transform)).not.toBe(before);
});

test('F3.1 shift-click adds and removes cards', async ({ page }) => {
  const { cards, card } = await threeCards(page);
  await card(cards[0]).click();
  await card(cards[1]).click({ modifiers: ['Shift'] });
  expect(await selectedCount(page)).toBe(2);
  await card(cards[0]).click({ modifiers: ['Shift'] });
  await expect(card(cards[0])).not.toHaveClass(/selected/);
  await expect(card(cards[1])).toHaveClass(/selected/);
});

test('F3.2 dragging a selected group moves all of it, and it persists', async ({ page }) => {
  const { cards, card } = await threeCards(page);
  await card(cards[0]).click();
  await card(cards[1]).click({ modifiers: ['Shift'] });
  const b0 = await card(cards[0]).boundingBox();
  const b1 = await card(cards[1]).boundingBox();
  const b2 = await card(cards[2]).boundingBox();

  const saved = page.waitForResponse(r => r.url().endsWith('/api/items') && r.request().method() === 'PATCH');
  await page.mouse.move(b0.x + 20, b0.y + 20);
  await page.mouse.down();
  await page.mouse.move(b0.x + 80, b0.y + 120, { steps: 10 });
  await page.mouse.up();
  await saved;

  await page.reload();
  const a0 = await card(cards[0]).boundingBox();
  const a1 = await card(cards[1]).boundingBox();
  const a2 = await card(cards[2]).boundingBox();
  expect(Math.round(a0.x - b0.x)).toBe(Math.round(a1.x - b1.x));
  expect(Math.round(a0.y - b0.y)).toBe(Math.round(a1.y - b1.y));
  expect(a0.y - b0.y).toBeGreaterThan(80);
  expect(a2).toEqual(b2); // not selected, didn't move
});

test('F3.2 deleting a selection is undone in one go; cmd+A selects everything', async ({ page }) => {
  const { cards, card } = await threeCards(page);
  await page.keyboard.press('ControlOrMeta+a');
  expect(await selectedCount(page)).toBe(3);

  await page.keyboard.press('Delete');
  await expect(page.locator('#world .item')).toHaveCount(0);
  await expect(page.locator('#toast')).toContainText('Moved 3 cards to trash');
  await page.locator('#toast .toast-action').click();
  for (const c of cards) await expect(card(c)).toBeVisible();
});

test('F3.2 copying a group and pasting keeps the layout; duplicate and colour act on all', async ({ page }) => {
  const { cards, card } = await threeCards(page);
  await card(cards[0]).click();
  await card(cards[1]).click({ modifiers: ['Shift'] });

  const marker = await page.evaluate(() => {
    const dt = new DataTransfer();
    document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }));
    return dt.getData('text/plain');
  });
  expect(marker).toBe(`milaclone:item:${cards[0].id},${cards[1].id}:copy`);

  await page.keyboard.press('ControlOrMeta+d');
  await expect(page.locator('#world .item')).toHaveCount(5);
  const copies = page.locator('#world .item.selected');
  await expect(copies).toHaveCount(2);
  const [c0, c1] = await copies.evaluateAll(els => els.map(e => [parseFloat(e.style.left), parseFloat(e.style.top)]));
  expect(Math.abs(c1[0] - c0[0])).toBe(300); // same 300px gap as a.pdf → b.pdf

  await copies.first().locator('.swatch').click();
  await page.locator('#palette .sw').nth(3).click();
  const bgs = await copies.evaluateAll(els => els.map(e => e.querySelector('.swatch').style.background));
  expect(bgs[0]).toBe(bgs[1]);
});

test('F3.4 Bring to Front / Send to Back persist after a reload', async ({ page }) => {
  const { cards, card } = await threeCards(page);
  const z = async c => Number(await card(c).evaluate(el => el.style.zIndex));

  await card(cards[0]).click({ button: 'right' });
  await page.locator('#ctxmenu .ctx-item', { hasText: 'Bring to Front' }).click();
  await card(cards[2]).click({ button: 'right' });
  const saved = page.waitForResponse(r => r.url().endsWith('/api/items')); // before the click, or it can be missed
  await page.locator('#ctxmenu .ctx-item', { hasText: 'Send to Back' }).click();
  await saved;

  await page.reload();
  await expect(card(cards[0])).toBeVisible();
  expect(await z(cards[0])).toBeGreaterThan(await z(cards[1]));
  expect(await z(cards[2])).toBeLessThan(await z(cards[1]));
});

test('F3.4 dragging a card raises it above the others', async ({ page }) => {
  const { cards, card } = await threeCards(page);
  const z = async c => Number(await card(c).evaluate(el => el.style.zIndex));
  const b = await card(cards[0]).boundingBox();
  await page.mouse.move(b.x + 20, b.y + 20);
  await page.mouse.down();
  await page.mouse.move(b.x + 60, b.y + 60, { steps: 5 });
  await page.mouse.up();
  expect(await z(cards[0])).toBeGreaterThan(Math.max(await z(cards[1]), await z(cards[2])));
});

// ---- review regressions ----------------------------------------------------

test('Lock Position on a multi-selection locks every selected card', async ({ page }) => {
  const { cards, card } = await threeCards(page);
  await card(cards[0]).click();
  await card(cards[1]).click({ modifiers: ['Shift'] });
  await card(cards[1]).click({ button: 'right' });
  await page.locator('#ctxmenu .ctx-item', { hasText: 'Lock Position' }).click();
  await expect(card(cards[0])).toHaveClass(/locked/);
  await expect(card(cards[1])).toHaveClass(/locked/);
  await expect(card(cards[2])).not.toHaveClass(/locked/);
});

test('cmd+Z after restoring the latest delete from the Trash sheet undoes the one before', async ({ page }) => {
  const { cards, card } = await threeCards(page);
  await card(cards[0]).click();
  await page.keyboard.press('Delete');
  await card(cards[1]).click();
  await page.keyboard.press('Delete');
  await page.click('#trashBtn');
  await page.locator(`#trashList li[data-id="${cards[1].id}"] .trash-restore`).click();
  await expect(card(cards[1])).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(card(cards[0])).toBeVisible();
});

test('Space on a focused button presses it instead of starting a pan', async ({ page }) => {
  await freshCanvas(page);
  await page.locator('#trashBtn').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#trashDialog')).toHaveAttribute('open', '');
});
