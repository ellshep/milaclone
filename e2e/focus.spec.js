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

// Hold the pointer down on a task's ring for `ms`.
async function hold(page, name, ms) {
  const box = await page.getByRole('button', { name }).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

test('Three: three tasks at one size; holding a ring marks one done, a tap does not', async ({ page, request }) => {
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
  const first = page.locator('#three .task').first();
  await expect(first.locator('.reason')).toBeHidden();
  await titles.first().hover();
  await expect(first.locator('.reason')).toHaveText('Blocks the trip');

  // a tap only shows the hint; letting go early drains the ring
  await page.getByRole('button', { name: 'Hold to finish: Renew passport' }).click();
  await expect(first.locator('.hint')).toHaveCSS('opacity', '1');
  await hold(page, 'Hold to finish: Renew passport', 400);
  await page.waitForTimeout(800);
  await expect(page.locator('#three .task.charged')).toHaveCount(0);
  await expect(titles.first()).toHaveText('Renew passport');

  const saved = page.waitForResponse(r => r.url().endsWith('/done'));
  await hold(page, 'Hold to finish: Renew passport', 1100);
  expect((await saved).ok()).toBe(true);
  await expect(titles).toHaveText(['Call the plumber', 'Pay the electric bill', 'Book the dentist']);
  const lists = (await (await request.get('/api/todos')).json()).lists;
  expect(lists.flatMap(l => l.tasks).find(t => t.id === added[0]).done).toBe(true);

  // holding Space works the same from the keyboard
  await page.getByRole('button', { name: 'Hold to finish: Call the plumber' }).focus();
  await page.keyboard.down(' ');
  await page.waitForTimeout(1100);
  await page.keyboard.up(' ');
  await expect(titles.first()).toHaveText('Pay the electric bill');
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
  // each row says which list and board it's on
  await expect(mine.first().locator('.where')).toHaveText('Focus list in Home');
  // overdue tasks are marked and can't be dragged
  const overdue = page.locator('#list .row.overdue', { hasText: 'Return library books' });
  await expect(overdue.locator('.due')).toContainText('days overdue');
  await expect(overdue).not.toHaveClass(/movable/);
  await expect(overdue.locator('.grip svg')).toHaveCount(0);

  const saved = page.waitForResponse(r => r.url().endsWith('/api/focus/order'));
  await page
    .locator('#list .row', { hasText: 'Order printer ink' })
    .locator('.grip')
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

test('List: a finger drags a row by its grip', async ({ page, request }) => {
  await addList(request, 'Focus touch', [
    task('Clean the oven', { createdAt: 5 }),
    task('Defrost the freezer', { createdAt: 6 }),
  ]);
  await page.goto('/focus#list');
  const mine = page.locator('#list .row', { hasText: /Clean the oven|Defrost the freezer/ });
  await expect(mine).toHaveText([/Clean the oven/, /Defrost the freezer/]);

  // Chromium turns these into touch pointer events, as a phone sends them.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  const at = async (loc, dy) => {
    const b = await loc.boundingBox();
    return { x: b.x + b.width / 2, y: b.y + dy(b) };
  };
  const from = await at(mine.nth(1).locator('.grip'), b => b.height / 2);
  const to = await at(mine.nth(0), () => 4);
  const touch = (type, p) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [p] : [] });
  const saved = page.waitForResponse(r => r.url().endsWith('/api/focus/order'));
  await touch('touchStart', from);
  for (let i = 1; i <= 8; i++) {
    await touch('touchMove', { x: from.x, y: from.y + ((to.y - from.y) * i) / 8 });
  }
  await touch('touchEnd');
  expect((await saved).ok()).toBe(true);
  await expect(mine).toHaveText([/Defrost the freezer/, /Clean the oven/]);
  await page.getByRole('button', { name: 'Reset order' }).click();
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

test('Filed: the night’s filings show with their reason, and Back to Inbox moves one back', async ({
  page,
  request,
}) => {
  const filed = task('Buy compost', { movedBy: 'ranker', movedAt: Date.now(), moveReason: 'Garden shopping' });
  const list = await addList(request, 'Garden jobs', [filed]);
  await page.goto('/focus#filed');
  const row = page.locator('#filed .row', { hasText: 'Buy compost' });
  await expect(row).toContainText('Garden jobs in Home');
  await expect(row).toContainText('Garden shopping');
  await expect(page.locator('#three')).toBeHidden();

  await row.getByRole('button', { name: 'Back to Inbox: Buy compost' }).click();
  await expect(row).toHaveCount(0);
  const { tasks } = await (await request.get('/api/focus?limit=all')).json();
  const moved = tasks.find(t => t.id === filed.id);
  expect([moved.inbox, moved.movedBy, moved.movedFrom]).toEqual([true, 'owner', list.id]);

  await page.getByRole('link', { name: 'List' }).click(); // the other modes still load their own data
  await expect(page.locator('#list .row', { hasText: 'Buy compost' })).toBeVisible();
});
