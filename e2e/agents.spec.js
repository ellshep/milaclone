'use strict';

// W1 of docs/agent-addon.md: the agent card, the board access flag and the
// selection hook for a framing page.

const { test, expect } = require('@playwright/test');
const { freshCanvas, place, leaveEdit } = require('./helpers');

const canvas = async (page, id) => (await page.request.get('/api/canvas/' + id)).json();
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

test('W1.2: an agent card is placed from the rail, edited and comes back after a reload', async ({ page }) => {
  const id = await freshCanvas(page);
  await place(page, 'agent');
  const card = page.locator('.item.type-agent');
  await expect(card.locator('.ag-name')).toBeFocused(); // a new card opens in edit mode
  await page.keyboard.type('Clock bot');
  await card.locator('.ag-persona').fill('Finds parts for the office clock');

  const saved = page.waitForResponse(
    r => r.request().method() === 'PATCH' && (r.request().postData() || '').includes('"provider":"local"')
  );
  await card.locator('.ag-provider').selectOption('local');
  await saved;
  await expect(card.locator('.ag-effort-row')).toBeHidden(); // effort is an Anthropic setting
  await card.locator('.ag-writes').selectOption('direct');
  await leaveEdit(page);

  await page.reload();
  const again = page.locator('.item.type-agent');
  await expect(again.locator('.ag-name')).toHaveValue('Clock bot');
  await expect(again.locator('.ag-provider')).toHaveValue('local');
  await expect(again.locator('.ag-model')).toHaveValue(''); // the Anthropic id didn't follow
  await expect(again.locator('.ag-writes')).toHaveValue('direct');
  const [it] = (await canvas(page, id)).items;
  expect(it.type).toBe('agent');
  expect(it.data.text).toBe('Clock bot\nFinds parts for the office clock'); // what search reads
  expect(it.data.memory).toBe('thread');
});

test('W1.3: a board blocks agents until its card menu allows them', async ({ page }) => {
  const id = await freshCanvas(page);
  const board = await post(page, { canvasId: id, type: 'board', x: 200, y: 150, data: { title: 'Private' } });
  expect(board._childAgentAccess).toBe(false);
  await page.reload();
  const card = page.locator('.item.type-board');
  await card.click({ button: 'right' });
  await expect(page.getByRole('button', { name: 'Block Agents' })).toHaveCount(0);
  const patched = page.waitForResponse(r => r.url().includes('/api/canvas/') && r.request().method() === 'PATCH');
  await page.getByRole('button', { name: 'Allow Agents' }).click();
  await patched;
  await expect(page.getByText('Agents may read this board')).toBeVisible();
  expect((await canvas(page, board.data.childCanvasId)).canvas.agentAccess).toBe(true);

  await card.click({ button: 'right' });
  await page.getByRole('button', { name: 'Block Agents' }).click();
  await expect(page.getByText('Agents are blocked from this board')).toBeVisible();
  expect((await canvas(page, board.data.childCanvasId)).canvas.agentAccess).toBe(false);
  // other boards keep their own flag
  expect((await canvas(page, id)).canvas.agentAccess).toBe(false);
});

test('W1.4: a framed board posts its selection to the page around it; standalone it posts nothing', async ({
  page,
}) => {
  const id = await freshCanvas(page);
  const a = await post(page, { canvasId: id, type: 'note', x: 100, y: 100, data: { text: 'a' } });
  const b = await post(page, { canvasId: id, type: 'note', x: 400, y: 100, data: { text: 'b' } });

  // standalone: no message leaves the window
  await page.reload();
  const seen = await page.evaluate(() => {
    window.__seen = [];
    window.addEventListener('message', e => window.__seen.push(e.data));
    return window.__seen.length;
  });
  expect(seen).toBe(0);
  await page.locator(`[data-id="${a.id}"]`).click();
  await expect(page.locator(`[data-id="${a.id}"]`)).toHaveClass(/selected/);
  expect(await page.evaluate(() => window.__seen)).toEqual([]);

  // framed by a same-origin page: every selection change arrives as ids
  await page.goto('/focus'); // any same-origin page to host the frame
  await page.setContent(
    `<iframe id="f" src="${new URL('/#' + id, page.url()).href}" style="width:1200px;height:800px"></iframe>`
  );
  await page.evaluate(() => {
    window.__msgs = [];
    window.addEventListener('message', e => window.__msgs.push(e.data));
  });
  const frame = page.frameLocator('#f');
  await expect(frame.locator(`[data-id="${a.id}"]`)).toHaveCount(1);
  await frame.locator(`[data-id="${a.id}"]`).click();
  await frame.locator(`[data-id="${b.id}"]`).click({ modifiers: ['Shift'] });
  await expect
    .poll(() => page.evaluate(() => window.__msgs.filter(m => m.type === 'milaclone:selection').at(-1)))
    .toEqual({ type: 'milaclone:selection', ids: [a.id, b.id] });
  await frame.locator(`[data-id="${b.id}"]`).click({ modifiers: ['Shift'] });
  await expect
    .poll(() => page.evaluate(() => window.__msgs.filter(m => m.type === 'milaclone:selection').at(-1)))
    .toEqual({ type: 'milaclone:selection', ids: [a.id] });
});
