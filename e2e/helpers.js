'use strict';

const { expect } = require('@playwright/test');

// Each test works inside its own freshly-created (empty) board canvas so tests
// stay independent despite sharing one server + DB.
async function freshCanvas(page) {
  await page.goto('/');
  const childId = await page.evaluate(async () => {
    const root = (await (await fetch('/api/root')).json()).rootCanvasId;
    const it = await (await fetch('/api/item', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ canvasId: root, type: 'board', data: { title: 'fixture' } }),
    })).json();
    return it.data.childCanvasId;
  });
  await page.goto('/#' + childId);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#' + childId);
  return childId;
}

// arm a toolbar tool, then click the canvas to drop the new card there.
// Waits for the create round-trip so the card (and any auto-edit) has settled.
async function place(page, tool, x = 600, y = 400) {
  await page.click(`.tool[data-tool="${tool}"]`);
  const created = page.waitForResponse(r => r.url().endsWith('/api/item') && r.request().method() === 'POST');
  await page.mouse.click(x, y);
  await created;
}

// note/todo/link/column cards drop into edit mode; click empty canvas to leave it
async function leaveEdit(page) {
  await page.mouse.click(1150, 660);
  await expect(page.locator('.item.editing')).toHaveCount(0);
}

module.exports = { freshCanvas, place, leaveEdit };
