'use strict';

const { test, expect } = require('@playwright/test');

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

test('boots to the Home board', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#crumbs')).toContainText('Home');
  await expect(page.locator('#stage')).toBeVisible();
});

test('an empty board shows the hint', async ({ page }) => {
  await freshCanvas(page);
  await expect(page.locator('#hint')).toBeVisible();
  await expect(page.locator('.item')).toHaveCount(0);
});

test('create a note via the toolbar and it persists across reload', async ({ page }) => {
  const id = await freshCanvas(page);
  await place(page, 'note');
  const note = page.locator('.item.type-note');
  await expect(note).toHaveCount(1);

  // createAt() drops the card into edit mode with the title focused
  const saved = page.waitForResponse(r => r.url().includes('/api/item/') && r.request().method() === 'PATCH');
  await page.keyboard.type('Groceries');
  await saved;

  await page.goto('/#' + id);
  await expect(page.locator('.item.type-note .ntitle')).toHaveValue('Groceries');
});

test('keyboard shortcut arms the note tool', async ({ page }) => {
  await freshCanvas(page);
  await page.mouse.click(600, 400);          // ensure nothing is focused
  await page.keyboard.press('n');
  await page.mouse.click(650, 450);
  await expect(page.locator('.item.type-note')).toHaveCount(1);
});

test('board card navigates in and breadcrumb walks back out', async ({ page }) => {
  await freshCanvas(page);
  await place(page, 'board');
  const card = page.locator('.item.type-board');
  await expect(card).toHaveCount(1);

  await card.dblclick();
  // now inside the nested board: breadcrumb grew and this canvas is empty
  await expect(page.locator('#crumbs .crumb')).toHaveCount(3); // Home / fixture / new board
  await expect(page.locator('#hint')).toBeVisible();

  // click the middle crumb to walk back out
  await page.locator('#crumbs .crumb').nth(1).click();
  await expect(page.locator('.item.type-board')).toHaveCount(1);
});

test('zoom controls change the level and reset to 100%', async ({ page }) => {
  await page.goto('/');
  await page.click('#zoomIn');
  await expect(page.locator('#zoomLvl')).not.toHaveText('100%');
  await page.click('#zoomReset');
  await expect(page.locator('#zoomLvl')).toHaveText('100%');
});

test('delete a note via its trash button', async ({ page }) => {
  await freshCanvas(page);
  await place(page, 'note');
  await expect(page.locator('.item.type-note')).toHaveCount(1);
  await page.locator('.item.type-note .card-tools button[title="Delete"]').click();
  await expect(page.locator('.item.type-note')).toHaveCount(0);
});

test('delete a selected board with the Delete key', async ({ page }) => {
  await freshCanvas(page);
  await place(page, 'board');
  await expect(page.locator('.item.type-board')).toHaveCount(1);
  await page.keyboard.press('Escape');                 // leave edit/selection
  await page.locator('.item.type-board .tile').click(); // select without editing
  await page.keyboard.press('Delete');
  await expect(page.locator('.item.type-board')).toHaveCount(0);
});

test('todo: add an item and check it off', async ({ page }) => {
  await freshCanvas(page);
  await place(page, 'todo');
  const todo = page.locator('.item.type-todo');
  await expect(todo).toHaveCount(1);

  await todo.locator('button.add').click();
  const rows = todo.locator('.task');
  await expect(rows).toHaveCount(2);                    // default empty + added

  const first = rows.first();
  await first.locator('input[type="checkbox"]').check();
  await expect(first).toHaveClass(/done/);
});

test('drag a note into a column', async ({ page }) => {
  await freshCanvas(page);
  await place(page, 'column', 450, 350);
  await place(page, 'note', 800, 350);
  await leaveEdit(page);                                // so pointerdown grabs the card, not its textarea

  const note = page.locator('.item.type-note');
  const colBody = page.locator('.col-body');
  const from = await note.boundingBox();
  const to = await colBody.boundingBox();

  await page.mouse.move(from.x + from.width / 2, from.y + 20);
  await page.mouse.down();
  // move in steps past the 4px drag threshold and into the column body
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();

  await expect(page.locator('.col-body .item.type-note')).toHaveCount(1);
});
