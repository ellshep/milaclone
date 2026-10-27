'use strict';

// P6b: lines between cards (lines.js) and the sketch card.

const { test, expect } = require('@playwright/test');
const { freshCanvas, place, leaveEdit } = require('./helpers');

const items = async (page, canvasId) => (await (await page.request.get('/api/canvas/' + canvasId)).json()).items;
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
const centre = async loc => {
  const b = await loc.boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
const stroke = page =>
  page.locator('#lines .line-stroke').evaluate(l => ['x1', 'y1', 'x2', 'y2'].map(k => +l.getAttribute(k)));

test('F6.1: a line between two cards follows a card when it moves, and survives a reload', async ({ page }) => {
  const id = await freshCanvas(page);
  const a = await post(page, { canvasId: id, type: 'note', x: 100, y: 120, data: { body: 'From' } });
  const b = await post(page, { canvasId: id, type: 'note', x: 600, y: 160, data: { body: 'To' } });
  await page.reload();
  const cardA = page.locator(`.item[data-id="${a.id}"]`);
  const cardB = page.locator(`.item[data-id="${b.id}"]`);

  await page.click('.tool[data-tool="line"]');
  const pa = await centre(cardA),
    pb = await centre(cardB);
  await page.mouse.move(pa.x, pa.y);
  await page.mouse.down();
  await page.mouse.move((pa.x + pb.x) / 2, pa.y, { steps: 4 });
  await expect(page.locator('#lines .line-ghost')).toHaveCount(1);
  const created = page.waitForResponse(r => r.url().endsWith('/api/item') && r.request().method() === 'POST');
  await page.mouse.move(pb.x, pb.y, { steps: 4 });
  await page.mouse.up();
  await created;
  await expect(page.locator('#lines .line')).toHaveCount(1);
  const line = (await items(page, id)).find(i => i.type === 'line');
  expect(line.data.from).toEqual({ id: a.id });
  expect(line.data.to).toEqual({ id: b.id });
  await expect(page.locator('#lines .line-head')).toHaveCount(1); // arrow at the end by default

  // The line ends on card edges, so its start sits at A's right edge.
  const before = await stroke(page);
  const boxA = await cardA.boundingBox();
  expect(Math.abs(before[0] - (100 + boxA.width))).toBeLessThan(2);

  // Drag B down 200px: the line's end moves with it.
  const moved = page.waitForResponse(r => r.url().includes('/api/item') && r.request().method() === 'PATCH');
  await page.mouse.move(pb.x, pb.y);
  await page.mouse.down();
  await page.mouse.move(pb.x, pb.y + 100, { steps: 5 });
  await page.mouse.move(pb.x, pb.y + 200, { steps: 5 });
  await page.mouse.up();
  await moved;
  await expect.poll(async () => (await stroke(page))[3] - before[3]).toBeGreaterThan(150);

  // Style it from the context menu: dashed, both arrows, a label.
  const hit = page.locator('#lines .line-hit');
  await hit.dispatchEvent('contextmenu', { clientX: 0, clientY: 0, button: 2 });
  await page.getByRole('button', { name: 'Dashed Line' }).click();
  await hit.dispatchEvent('contextmenu', { clientX: 0, clientY: 0, button: 2 });
  await page.getByRole('button', { name: 'Arrows at Both Ends' }).click();
  await hit.dispatchEvent('contextmenu', { clientX: 0, clientY: 0, button: 2 });
  await page.getByRole('button', { name: 'Add Label' }).click();
  await page.locator('.line-label-edit').fill('depends on');
  const labelled = page.waitForResponse(
    r => r.request().method() === 'PATCH' && (r.request().postData() || '').includes('depends on')
  );
  await page.keyboard.press('Enter');
  await labelled;

  await page.reload();
  await expect(page.locator('#lines .line')).toHaveCount(1);
  await expect(page.locator('#lines .line-label')).toHaveText('depends on');
  await expect(page.locator('#lines .line-head')).toHaveCount(2);
  await expect(page.locator('#lines .line-stroke')).toHaveAttribute('stroke-dasharray', '7 6');
  const after = await stroke(page);
  expect(after[3] - before[3]).toBeGreaterThan(150);

  // Trashing an attached card hides the line; Undo brings both back.
  await cardB.click({ button: 'right' });
  await page.getByRole('button', { name: 'Move to Trash' }).click();
  await expect(page.locator('#lines .line')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('#lines .line')).toHaveCount(1);
});

test('F6.1: a line can run between free points, and is selected and deleted like a card', async ({ page }) => {
  const id = await freshCanvas(page);
  await page.click('.tool[data-tool="line"]');
  await page.mouse.move(300, 300);
  await page.mouse.down();
  await page.mouse.move(500, 380, { steps: 5 });
  const created = page.waitForResponse(r => r.url().endsWith('/api/item') && r.request().method() === 'POST');
  await page.mouse.up();
  await created;
  const line = (await items(page, id)).find(i => i.type === 'line');
  expect(line.data.from.id).toBeUndefined();
  expect(line.data.to.x - line.data.from.x).toBeGreaterThan(150);
  await expect(page.locator('#lines .line.selected')).toHaveCount(1); // a new line is selected
  await page.keyboard.press('Escape');
  await expect(page.locator('#lines .line.selected')).toHaveCount(0);
  await page.locator('#lines .line-hit').dispatchEvent('pointerdown', { button: 0 });
  await expect(page.locator('#lines .line.selected')).toHaveCount(1);
  await page.keyboard.press('Delete');
  await expect(page.locator('#lines .line')).toHaveCount(0);
  expect((await items(page, id)).filter(i => i.type === 'line')).toHaveLength(0);
});

test('F6.3: a drawn stroke persists after a reload; pen size/colour apply; the eraser removes it', async ({ page }) => {
  const id = await freshCanvas(page);
  await place(page, 'sketch');
  const sk = page.locator('.item.type-sketch');
  await expect(sk).toHaveClass(/editing/);
  await sk.getByTitle('Pen size 8').click();
  await sk.getByTitle('red').click();
  const pad = await sk.locator('.sk-pad').boundingBox();
  const saved = page.waitForResponse(r => r.request().method() === 'PATCH' && r.url().includes('/api/item/'));
  await page.mouse.move(pad.x + 40, pad.y + 40);
  await page.mouse.down();
  await page.mouse.move(pad.x + 120, pad.y + 90, { steps: 6 });
  await page.mouse.move(pad.x + 200, pad.y + 60, { steps: 6 });
  await page.mouse.up();
  await expect(sk.locator('.sk-pad path')).toHaveCount(1);
  await saved;

  await page.reload();
  const path = page.locator('.item.type-sketch .sk-pad path');
  await expect(path).toHaveCount(1);
  await expect(path).toHaveAttribute('stroke-width', '8');
  const s = (await items(page, id))[0].data.strokes[0];
  expect(s.color).toBe('red');
  expect(s.d.split('L').length).toBeGreaterThan(5);

  // Eraser: enter edit, pick it, scrub across the stroke.
  const card = page.locator('.item.type-sketch');
  await card.click({ position: { x: 3, y: 3 } }); // a click on a card edits it
  await expect(card).toHaveClass(/editing/);
  await card.getByTitle('Eraser').click();
  const box = await card.locator('.sk-pad path').boundingBox();
  const erased = page.waitForResponse(r => r.request().method() === 'PATCH' && r.url().includes('/api/item/'));
  await page.mouse.move(box.x + box.width / 2 - 30, box.y - 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height + 10, { steps: 20 });
  await page.mouse.up();
  await expect(card.locator('.sk-pad path')).toHaveCount(0);
  await erased;
  await leaveEdit(page);
  expect((await items(page, id))[0].data.strokes).toEqual([]);
});

test('a diagonal line is boxed by its stroke, and cmd+D never makes a hidden copy of it', async ({ page }) => {
  const id = await freshCanvas(page);
  await post(page, { canvasId: id, type: 'line', data: { from: { x: 200, y: 150 }, to: { x: 700, y: 550 } } });
  await page.reload();
  const s = await page.locator('#lines .line-stroke').boundingBox();
  // A box in the empty lower-left corner of the line's bounding box: not selected.
  await page.mouse.move(s.x + 10, s.y + s.height - 60);
  await page.mouse.down();
  await page.mouse.move(s.x + 80, s.y + s.height - 10, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator('#lines .line.selected')).toHaveCount(0);
  // A box across the middle of the stroke: selected.
  await page.mouse.move(s.x + s.width / 2 - 30, s.y + s.height / 2 - 30);
  await page.mouse.down();
  await page.mouse.move(s.x + s.width / 2 + 30, s.y + s.height / 2 + 30, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator('#lines .line.selected')).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+d');
  await page.waitForTimeout(300);
  expect((await items(page, id)).length).toBe(1);
});
