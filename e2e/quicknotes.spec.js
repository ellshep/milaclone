'use strict';

const { test, expect } = require('@playwright/test');

// Quick notes is the mobile-only task workspace, so every test here runs in a
// phone viewport. The overview aggregates every todo card in the database, so
// assertions are always scoped to a list this test created.
test.use({ viewport: { width: 390, height: 844 } });

let seq = 0;
const uniq = p => `${p}-${Date.now()}-${seq++}`;

// Seed a todo card straight through the API, then open Quick notes on it.
async function seedList(page, title, tasks) {
  await page.goto('/');
  const id = await page.evaluate(
    async ([title, tasks]) => {
      const root = (await (await fetch('/api/root')).json()).rootCanvasId;
      const it = await (
        await fetch('/api/item', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ canvasId: root, type: 'todo', data: { title, tasks } }),
        })
      ).json();
      return it.id;
    },
    [title, tasks || []]
  );
  return id;
}

async function openQuickNotes(page) {
  await page.click('#mNotes');
  await expect(page.locator('#quicknotes')).toBeVisible();
  await expect(page.locator('.qn-title')).toHaveText('Quick notes');
}

const listRow = (page, title) => page.locator('.qn-row-btn', { hasText: title });
const taskRow = (page, text) => page.locator('.qn-task', { hasText: text });

test('the Quick notes tab opens the overview with every todo list', async ({ page }) => {
  const title = uniq('Nightly');
  await seedList(page, title, [
    { id: 'a', text: 'Floss', done: false },
    { id: 'b', text: 'Shower', done: true },
  ]);
  await openQuickNotes(page);

  await expect(listRow(page, title)).toBeVisible();
  await expect(listRow(page, title).locator('.qn-row-count')).toHaveText('1'); // open tasks only
  await expect(page.locator('.qn-tile')).toHaveCount(4);
});

test('drilling into a list shows open tasks and a collapsible completed group', async ({ page }) => {
  const title = uniq('Routine');
  await seedList(page, title, [
    { id: 'a', text: 'Wash face', done: false },
    { id: 'b', text: 'Shower', done: true },
  ]);
  await openQuickNotes(page);
  await listRow(page, title).click();

  await expect(page.locator('#qnListTitle')).toHaveText(title);
  await expect(page.locator('#qnListMeta')).toContainText('1 of 2');
  await expect(taskRow(page, 'Wash face')).toBeVisible();
  await expect(taskRow(page, 'Shower')).toHaveClass(/done/);

  await page.locator('.qn-comphead').click();
  await expect(taskRow(page, 'Shower')).toHaveCount(0);
});

test('checking a task persists and moves it into Completed', async ({ page }) => {
  const title = uniq('Errands');
  const id = await seedList(page, title, [{ id: 'a', text: 'Buy milk', done: false }]);
  await openQuickNotes(page);
  await listRow(page, title).click();

  const saved = page.waitForResponse(r => r.url().includes('/api/item/' + id) && r.request().method() === 'PATCH');
  await taskRow(page, 'Buy milk').locator('.qn-box').click();
  await saved;
  await expect(page.locator('.qn-comphead')).toContainText('Completed · 1');

  // the write lands on the same todo card the canvas renders
  const tasks = await page.evaluate(async id => {
    const r = await (await fetch('/api/todos')).json();
    return r.lists.find(l => l.id === id).tasks;
  }, id);
  expect(tasks[0].done).toBe(true);
});

test('starring a task feeds the Starred smart view', async ({ page }) => {
  const title = uniq('Starry');
  const task = uniq('Call the plumber'); // the Starred view lists every run's starred tasks
  await seedList(page, title, [{ id: 'a', text: task, done: false }]);
  await openQuickNotes(page);
  await listRow(page, title).click();
  await taskRow(page, task).locator('.qn-star').click();
  await expect(taskRow(page, task).locator('.qn-star')).toHaveClass(/on/);

  await page.click('#qnListBack');
  await page.locator('.qn-tile[data-smart="starred"]').click();
  await expect(page.locator('#qnListTitle')).toHaveText('Starred');
  // smart views name the source list on a sub-line and hide the add button
  await expect(taskRow(page, task).locator('.qn-task-sub')).toHaveText(title);
  await expect(page.locator('#qnAddBar')).toBeHidden();
});

test('the add bar appends tasks and stays open for the next one', async ({ page }) => {
  const title = uniq('Groceries');
  await seedList(page, title, []);
  await openQuickNotes(page);
  await listRow(page, title).click();

  await page.click('#qnAddTask');
  await page.fill('#qnNewTask', 'Oat milk');
  await page.press('#qnNewTask', 'Enter');
  await expect(taskRow(page, 'Oat milk')).toBeVisible();
  await expect(page.locator('#qnAddField')).toBeVisible();

  await page.fill('#qnNewTask', 'Bread');
  await page.press('#qnNewTask', 'Enter');
  await expect(page.locator('.qn-task')).toHaveCount(2);
  await expect(page.locator('#qnListMeta')).toContainText('0 of 2');

  await page.click('#qnAddCancel');
  await expect(page.locator('#qnAddTask')).toBeVisible();
});

test('task detail edits the note, due date and tags', async ({ page }) => {
  const title = uniq('Life');
  const id = await seedList(page, title, [{ id: 'a', text: 'Book counseling', done: false }]);
  await openQuickNotes(page);
  await listRow(page, title).click();
  await taskRow(page, 'Book counseling').click();

  await expect(page.locator('#qnTaskTitle')).toHaveText('Book counseling');
  await expect(page.locator('#qnTaskBackLabel')).toHaveText(title);

  await page.fill('#qnNote', 'ask about september');
  await page.locator('#qnDetails .qn-dateinput').fill('2030-08-07');
  await expect(page.locator('.qn-due-label')).toHaveText('Due Wed, Aug 7');

  await page.click('.qn-addtag');
  await page.fill('.qn-sheet-field input', 'faith');
  await page.press('.qn-sheet-field input', 'Enter');
  // closing the sheet flushes whatever the debounced save still had queued
  const flushed = page.waitForResponse(r => r.url().includes('/api/item/' + id) && r.request().method() === 'PATCH');
  await page.click('#qnDim');
  await flushed;
  await expect(page.locator('.qn-taglist .qn-tag')).toHaveText('#faith');

  const saved = await page.evaluate(async id => {
    const r = await (await fetch('/api/todos')).json();
    return r.lists.find(l => l.id === id).tasks[0];
  }, id);
  expect(saved.note).toBe('ask about september');
  expect(saved.due).toBe('2030-08-07');
  expect(saved.tags).toEqual(['faith']);

  // the due date shows up on the row too, and clears from the detail screen
  await page.click('#qnDetails .qn-x');
  await expect(page.locator('.qn-due-add')).toBeVisible();
});

test('the note bullet button rewrites the note lines', async ({ page }) => {
  const title = uniq('Notes');
  await seedList(page, title, [{ id: 'a', text: 'Plan trip', done: false }]);
  await openQuickNotes(page);
  await listRow(page, title).click();
  await taskRow(page, 'Plan trip').click();

  await page.fill('#qnNote', 'flights\nhotel');
  await page.click('.qn-fmt button[data-fmt="bullet"]');
  await expect(page.locator('#qnNote')).toHaveValue('• flights\n• hotel');
  await page.click('.qn-fmt button[data-fmt="bullet"]');
  await expect(page.locator('#qnNote')).toHaveValue('flights\nhotel');
});

test('search matches task text and opens the task', async ({ page }) => {
  const title = uniq('Search');
  const needle = uniq('quokka');
  await seedList(page, title, [{ id: 'a', text: needle, done: false }]);
  await openQuickNotes(page);

  await page.click('#qnSearchBtn');
  await expect(page.locator('.qn-blank')).toContainText('Type to search');
  await page.fill('#qnQuery', needle);
  await expect(page.locator('#qnResults .qn-count')).toHaveText('1 result');

  await page.locator('#qnResults .qn-task').click();
  await expect(page.locator('#qnTaskTitle')).toHaveText(needle);
  await expect(page.locator('#qnTaskBackLabel')).toHaveText(title); // back goes to its own list
});

test('search reports when nothing matches', async ({ page }) => {
  await seedList(page, uniq('Empty'), [{ id: 'a', text: 'something', done: false }]);
  await openQuickNotes(page);
  await page.click('#qnSearchBtn');
  await page.fill('#qnQuery', 'zzz-no-such-task-zzz');
  await expect(page.locator('.qn-blank')).toContainText('No matching tasks');
  await page.click('#qnSearchCancel');
  await expect(page.locator('.qn-title')).toBeVisible();
});

test('an overview tag chip keeps the lists whose tasks carry that tag', async ({ page }) => {
  const tag = uniq('tag').toLowerCase();
  const tagged = uniq('Tagged');
  const plain = uniq('Plain');
  await seedList(page, tagged, [{ id: 'a', text: 'Call the bank', done: false, tags: [tag] }]);
  await seedList(page, plain, [{ id: 'a', text: 'Buy stamps', done: false }]);
  await openQuickNotes(page);

  await page.click('#qnHomeMenu');
  await page.locator('#qnSheetBody').getByText('Tag filters').click();
  await page.click('#qnDim');
  await page.locator('#qnHomeChips .qn-chip', { hasText: '#' + tag }).click();

  await expect(listRow(page, tagged)).toBeVisible();
  await expect(listRow(page, plain)).toHaveCount(0);
  await expect(page.locator('#qnLists .qn-empty')).toHaveCount(0);
});

test('the add sheet creates a todo list and drops you into it', async ({ page }) => {
  await page.goto('/');
  await openQuickNotes(page);
  await page.click('#qnAdd');
  const created = page.waitForResponse(r => r.url().endsWith('/api/item') && r.request().method() === 'POST');
  await page.locator('.qn-sheet-row', { hasText: 'Todo list' }).click();
  await created;

  await expect(page.locator('#qnListTitle')).toHaveText('New list');
  const title = uniq('Renamed');
  await page.locator('#qnListTitle').fill(title);
  await page.locator('#qnListTitle').blur();
  await page.click('#qnListBack');
  await expect(listRow(page, title)).toBeVisible();
});

test('Your boards returns to the canvas', async ({ page }) => {
  await page.goto('/');
  await openQuickNotes(page);
  await page.click('#qnBoards');
  await expect(page.locator('#quicknotes')).toBeHidden();
  await expect(page.locator('#stage')).toBeVisible();
});

test('desktop phone button opens the From your phone popover', async ({ page }) => {
  const title = uniq('DeskList');
  await seedList(page, title, [{ id: 'a', text: 'Ship it', done: false }]);
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('/');

  await expect(page.locator('#mNotes')).toBeHidden();
  await expect(page.locator('#phoneNotes')).toBeVisible();
  await expect(page.locator('#quicknotes')).toBeHidden();

  await page.click('#phoneNotes');
  await expect(page.locator('#quicknotes')).toBeVisible();
  await expect(page.locator('body')).toHaveClass(/qn-desk/);
  await expect(page.locator('#qnDeskHead')).toBeVisible();
  await expect(page.locator('#qnDeskHead')).toHaveText('From your phone');
  await expect(listRow(page, title)).toBeVisible();

  await page.click('#stage', { position: { x: 40, y: 40 } });
  await expect(page.locator('#quicknotes')).toBeHidden();
});
