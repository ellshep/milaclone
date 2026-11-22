'use strict';

// The /focus page (next-phases M2.2). Other specs add to-do tasks to the same
// server in parallel, and the focus order ranks every list, so these tests use
// tasks that sort first (overdue since 2000) or look only at their own rows.

const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

// Unique ids per run, and every task this spec adds is marked done afterwards,
// so a re-run (or --repeat-each) starts from the same order.
let added = [];
test.afterEach(async ({ request }) => {
  for (const id of added) await request.post(`/api/focus/${encodeURIComponent(id)}/done`);
  added = [];
});

async function addList(request, title, tasks) {
  added.push(...tasks.map(t => t.id));
  const { rootCanvasId } = await (await request.get('/api/root')).json();
  const r = await request.post('/api/item', {
    data: { canvasId: rootCanvasId, type: 'todo', x: 0, y: 0, data: { title, tasks } },
  });
  expect(r.ok()).toBeTruthy();
  return r.json();
}
const task = (text, extra = {}) =>
  Object.assign({ id: `${text}-${Date.now()}-${Math.random()}`, text, done: false, createdAt: 1 }, extra);

test('Three: three tasks at one size, each with a done tab; Undo keeps a task', async ({ page, request }) => {
  await addList(request, 'Focus three', [
    task('Renew passport', { due: '2000-01-01', rankReason: 'Blocks the trip' }),
    task('Call the plumber', { due: '2000-01-02' }),
    task('Pay the electric bill', { due: '2000-01-03' }),
    task('Book the dentist', { due: '2000-01-04' }),
  ]);
  await page.goto('/focus');
  const titles = page.locator('#three .title');
  await expect(titles).toHaveText(['Renew passport', 'Call the plumber', 'Pay the electric bill']);
  await expect(page.locator('#three .task').first().locator('.due')).toContainText('days overdue');
  const sizes = await titles.evaluateAll(ns => ns.map(n => getComputedStyle(n).fontSize));
  expect(new Set(sizes).size).toBe(1);
  await expect(page.locator('#queue')).toHaveText(/^\d+ in queue$/);

  // the model's reason shows on hover only
  const reason = page.locator('#three .task').first().locator('.reason');
  await expect(reason).toBeHidden();
  await titles.first().hover();
  await expect(reason).toHaveText('Blocks the trip');

  // Undo keeps it, and nothing is saved
  await page.getByRole('button', { name: 'Done: Renew passport' }).click();
  await expect(page.locator('#three .task.pending')).toHaveCount(1);
  await page.getByRole('button', { name: 'Undo: Renew passport' }).click();
  await expect(page.locator('#three .task.pending')).toHaveCount(0);
  await page.waitForTimeout(4500);
  await expect(titles.first()).toHaveText('Renew passport');

  const saved = page.waitForResponse(r => r.url().endsWith('/done'));
  await page.getByRole('button', { name: 'Done: Renew passport' }).click();
  expect((await saved).ok()).toBe(true);
  await expect(titles).toHaveText(['Call the plumber', 'Pay the electric bill', 'Book the dentist']);
  const lists = (await (await request.get('/api/todos')).json()).lists;
  const done = lists.flatMap(l => l.tasks).find(t => t.id === added[0]);
  expect(done.done).toBe(true);
});

test('List: drag to reorder saves placements, and Reset clears them', async ({ page, request }) => {
  await addList(request, 'Focus list', [
    task('Sort the garage', { createdAt: 2 }),
    task('Fix the bike light', { createdAt: 3 }),
    task('Order printer ink', { createdAt: 4 }),
    task('Return library books', { due: '2000-02-01' }),
  ]);
  await page.goto('/focus#list');
  const mine = page.locator('#list .row', { hasText: /Sort the garage|Fix the bike light|Order printer ink/ });
  await expect(mine).toHaveText([/Sort the garage/, /Fix the bike light/, /Order printer ink/]);
  // overdue tasks are marked and can't be dragged
  const overdue = page.locator('#list .row.overdue', { hasText: 'Return library books' });
  await expect(overdue.locator('.due')).toContainText('days overdue');
  await expect(overdue).not.toHaveAttribute('draggable', 'true');

  const saved = page.waitForResponse(r => r.url().endsWith('/api/focus/order'));
  await page
    .locator('#list .row', { hasText: 'Order printer ink' })
    .dragTo(page.locator('#list .row', { hasText: 'Sort the garage' }), { targetPosition: { x: 20, y: 4 } });
  await saved;
  await expect(mine).toHaveText([/Order printer ink/, /Sort the garage/, /Fix the bike light/]);

  // Alt+↓ moves a task down one
  await page.locator('#list .row', { hasText: 'Order printer ink' }).focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(mine).toHaveText([/Sort the garage/, /Order printer ink/, /Fix the bike light/]);

  await page.getByRole('button', { name: 'Reset order' }).click();
  await expect(mine).toHaveText([/Sort the garage/, /Fix the bike light/, /Order printer ink/]);
  await expect(page.getByRole('button', { name: 'Reset order' })).toBeHidden();
});

test('controls appear on hover; the mode switch and refresh work', async ({ page, request }) => {
  await addList(request, 'Focus controls', [task('Wash the car', { createdAt: 0 })]);
  await page.goto('/focus');
  const controls = page.locator('.controls');
  await page.mouse.move(5, 5);
  await expect(controls).toHaveCSS('opacity', '1');
  await page.getByRole('link', { name: 'List' }).click();
  await expect(page.locator('#list .row', { hasText: 'Wash the car' })).toBeVisible();
  await expect(page.locator('#three')).toBeHidden();

  await addList(request, 'Focus refresh', [task('Water the plants', { createdAt: 0 })]);
  await expect(page.locator('#list .row', { hasText: 'Water the plants' })).toHaveCount(0); // no polling
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.locator('#list .row', { hasText: 'Water the plants' })).toHaveCount(1);
});
