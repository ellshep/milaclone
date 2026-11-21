'use strict';

// The save path: edits must reach the server even when a request fails, when
// the body is too big for a keepalive request, and when another device changed
// the same to-do list in the meantime.

const { test, expect } = require('@playwright/test');
const { freshCanvas } = require('./helpers');

let seq = 0;
const uniq = p => `${p}-${Date.now()}-${seq++}`;

async function createTodo(page, canvasId, title, tasks) {
  return page.evaluate(
    async ([canvasId, title, tasks]) => {
      const root = canvasId || (await (await fetch('/api/root')).json()).rootCanvasId;
      const r = await fetch('/api/item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ canvasId: root, type: 'todo', data: { title, tasks } }),
      });
      return (await r.json()).id;
    },
    [canvasId, title, tasks]
  );
}

const serverTasks = (page, id) =>
  page.evaluate(async id => {
    const r = await (await fetch('/api/todos')).json();
    return r.lists.find(l => l.id === id).tasks;
  }, id);

// Fail the first PATCH to this item as if the network dropped.
async function dropFirstSave(page, id) {
  let dropped = false;
  await page.route('**/api/item/' + id, route => {
    if (!dropped && route.request().method() === 'PATCH') {
      dropped = true;
      return route.abort('internetdisconnected');
    }
    return route.continue();
  });
}

// Fail every PATCH to this item until the returned function is called; counts attempts.
async function dropAllSaves(page, id) {
  const state = { attempts: 0, down: true };
  await page.route('**/api/item/' + id, route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    state.attempts++;
    return state.down ? route.abort('internetdisconnected') : route.continue();
  });
  return state;
}

// Record whether each PATCH asked for keepalive, and its size in bytes.
const recordSaves = page =>
  page.evaluate(() => {
    window.__saves = [];
    const real = window.fetch;
    window.fetch = (url, init = {}) => {
      if (init.method === 'PATCH') {
        const bytes = new TextEncoder().encode(init.body).length;
        window.__saves.push({ keepalive: !!init.keepalive, size: init.body.length, bytes });
      }
      return real(url, init);
    };
  });

test.describe('Quick notes', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  async function openList(page, title) {
    await page.click('#mNotes');
    await expect(page.locator('#quicknotes')).toBeVisible();
    await page.locator('.qn-row-btn', { hasText: title }).click();
  }
  const taskRow = (page, text) => page.locator('.qn-task', { hasText: text });

  test('an edit from a stale copy keeps the star, due date and tags set elsewhere', async ({ page }) => {
    await page.goto('/');
    const title = uniq('Shop');
    const seeded = [
      { id: 'a', text: 'Milk', done: false },
      { id: 'b', text: 'Eggs', done: false },
    ];
    const id = await createTodo(page, null, title, seeded);
    await openList(page, title);

    // another device stars Milk and gives it a due date and a tag
    await page.evaluate(
      async ([id, seeded]) => {
        const tasks = seeded.map(t => (t.id === 'a' ? { ...t, starred: true, due: '2026-12-01', tags: ['shop'] } : t));
        await fetch('/api/item/' + id, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: { tasks }, baseTasks: seeded }),
        });
      },
      [id, seeded]
    );

    // this phone still shows the old copy and ticks Eggs
    const saved = page.waitForResponse(r => r.url().endsWith('/api/item/' + id) && r.request().method() === 'PATCH');
    await taskRow(page, 'Eggs').locator('.qn-box').click();
    await saved;

    const [milk, eggs] = await serverTasks(page, id);
    expect(eggs.done).toBe(true);
    expect(milk).toMatchObject({ starred: true, due: '2026-12-01', tags: ['shop'] });
  });

  test('a save that fails is retried and lands', async ({ page }) => {
    await page.goto('/');
    const title = uniq('Retry');
    const id = await createTodo(page, null, title, [{ id: 'a', text: 'Floss', done: false }]);
    await openList(page, title);
    await dropFirstSave(page, id);

    await taskRow(page, 'Floss').locator('.qn-box').click();
    await expect(page.locator('#toast')).toContainText('check your connection');
    await expect.poll(async () => (await serverTasks(page, id))[0].done, { timeout: 10000 }).toBe(true);
  });

  test('a save bigger than the keepalive limit still goes out when the page hides', async ({ page }) => {
    await page.goto('/');
    const title = uniq('Huge');
    const long = 'x'.repeat(250);
    const tasks = Array.from({ length: 200 }, (_, i) => ({ id: 't' + i, text: `Task ${i} ${long}`, done: false }));
    const id = await createTodo(page, null, title, tasks);
    await openList(page, title);

    await recordSaves(page);

    await taskRow(page, 'Task 0 ').locator('.qn-box').click();
    // the app goes to the background before the debounced save fires
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));

    await expect.poll(async () => (await serverTasks(page, id))[0].done).toBe(true);
    const saves = await page.evaluate(() => window.__saves);
    expect(saves[0].size).toBeGreaterThan(64 * 1024);
    expect(saves[0].keepalive).toBe(false);
  });
});

test.describe('Quick notes, with a fake clock', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  async function openList(page, title) {
    await page.click('#mNotes');
    await expect(page.locator('#quicknotes')).toBeVisible();
    await page.locator('.qn-row-btn', { hasText: title }).click();
  }
  const taskRow = (page, text) => page.locator('.qn-task', { hasText: text });

  test('retries stop after six tries and the edit goes out when the connection is back', async ({ page }) => {
    await page.clock.install();
    await page.goto('/');
    const title = uniq('Offline');
    const id = await createTodo(page, null, title, [{ id: 'a', text: 'Pay rent', done: false }]);
    await openList(page, title);
    const net = await dropAllSaves(page, id);

    await taskRow(page, 'Pay rent').locator('.qn-box').click();
    // twenty minutes of fake time, in steps so each failure can schedule the next try
    for (let i = 0; i < 20; i++) {
      await page.clock.runFor(61000);
      await page.waitForTimeout(50);
    }
    expect(net.attempts).toBe(7); // the first save plus six retries
    await expect(page.locator('#toast')).toContainText("Still can't save");

    net.down = false;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(async () => (await serverTasks(page, id))[0].done).toBe(true);
    expect(net.attempts).toBe(8);
  });
});

test('saves sent together while the page hides stay under the keepalive limit', async ({ page }) => {
  await page.clock.install();
  const canvasId = await freshCanvas(page);
  const long = 'x'.repeat(200);
  const tasks = Array.from({ length: 80 }, (_, i) => ({ id: 't' + i, text: `Task ${i} ${long}`, done: false }));
  const a = await createTodo(page, canvasId, uniq('HalfA'), tasks); // about 40 KB per save
  const b = await createTodo(page, canvasId, uniq('HalfB'), tasks);
  await page.reload();
  await expect(page.locator(`[data-id="${b}"]`)).toBeVisible();
  await page.clock.pauseAt(Date.now() + 1000); // hold the save debounce until the page hides
  await recordSaves(page);
  // a paused clock also pauses animation frames, which Playwright's actionability checks wait on
  for (const id of [a, b])
    await page
      .locator(`[data-id="${id}"] .task input[type="checkbox"]`)
      .first()
      .evaluate(el => el.click());

  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect.poll(() => page.evaluate(() => window.__saves.length)).toBe(2);
  const saves = await page.evaluate(() => window.__saves);
  expect(saves.every(s => s.bytes > 30000)).toBe(true);
  expect(saves.filter(s => s.keepalive)).toHaveLength(1); // both together would pass 64 KB
});

test('a non-English save over the keepalive limit in bytes goes out without keepalive', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const title = uniq('漢字');
  const tasks = Array.from({ length: 100 }, (_, i) => ({ id: 't' + i, text: `${i} ${'漢'.repeat(120)}`, done: false }));
  const id = await createTodo(page, null, title, tasks);
  await page.click('#mNotes');
  await page.locator('.qn-row-btn', { hasText: title }).click();
  await recordSaves(page);
  await page.locator('.qn-task', { hasText: '0 漢' }).first().locator('.qn-box').click();
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));

  await expect.poll(async () => (await serverTasks(page, id))[0].done).toBe(true);
  const [save] = await page.evaluate(() => window.__saves);
  expect(save.size).toBeLessThan(60000); // under the limit in characters…
  expect(save.bytes).toBeGreaterThan(64 * 1024); // …but over it in bytes
  expect(save.keepalive).toBe(false);
});

test('returning to the tab after a failed save keeps the edit on screen', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  const id = await createTodo(page, canvasId, uniq('Keep'), [{ id: 'a', text: 'Feed cat', done: false }]);
  await page.reload();
  const box = page.locator(`[data-id="${id}"] .task input[type="checkbox"]`).first();
  await expect(box).toBeVisible();
  const net = await dropAllSaves(page, id);
  let reloads = 0;
  page.on('request', r => r.url().includes('/api/canvas/') && r.method() === 'GET' && reloads++);

  await box.check();
  await expect(page.locator('#toast')).toContainText('check your connection');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // the tab is shown again
  await expect.poll(() => net.attempts).toBeGreaterThanOrEqual(2); // it tried again…
  await page.waitForTimeout(300);
  expect(reloads).toBe(0); // …and didn't swap in the server's copy without the edit
  await expect(box).toBeChecked();
});

test('a canvas save that fails is retried and lands', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  const id = await createTodo(page, canvasId, uniq('Canvas'), [{ id: 'a', text: 'Water plants', done: false }]);
  await page.reload();
  const todo = page.locator(`[data-id="${id}"]`);
  await expect(todo).toBeVisible();
  await dropFirstSave(page, id);

  await todo.locator('.task input[type="checkbox"]').first().check();
  await expect(page.locator('#toast')).toContainText('check your connection');
  await expect.poll(async () => (await serverTasks(page, id))[0].done, { timeout: 10000 }).toBe(true);
});
