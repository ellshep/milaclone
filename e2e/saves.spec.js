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

    // record what each PATCH asked the browser for
    await page.evaluate(() => {
      window.__saves = [];
      const real = window.fetch;
      window.fetch = (url, init = {}) => {
        if (init.method === 'PATCH') window.__saves.push({ keepalive: !!init.keepalive, size: init.body.length });
        return real(url, init);
      };
    });

    await taskRow(page, 'Task 0 ').locator('.qn-box').click();
    // the app goes to the background before the debounced save fires
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));

    await expect.poll(async () => (await serverTasks(page, id))[0].done).toBe(true);
    const saves = await page.evaluate(() => window.__saves);
    expect(saves[0].size).toBeGreaterThan(64 * 1024);
    expect(saves[0].keepalive).toBe(false);
  });
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
