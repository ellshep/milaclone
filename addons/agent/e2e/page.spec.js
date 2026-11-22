// W3.3 acceptance: select two cards on the framed board, ask, and the request
// carries those two ids. The fake provider answers; nothing leaves the machine.

import { expect, test } from '@playwright/test';
import { Threads } from '../src/memory.js';
import { pageServer } from '../src/page.js';
import { Service } from '../src/service.js';
import { startStack } from '../test/stack.js';

let stack, svc, server, pageUrl;

test.beforeAll(async () => {
  stack = await startStack();
  svc = new Service({ mcpUrl: stack.mcpUrl, token: stack.token, providers: {}, fake: true });
  server = pageServer(svc, new Threads(':memory:'));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  pageUrl = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  await svc.close();
  server.close();
  stack.stop();
});

test('select two cards, ask, and the request carries those two ids', async ({ page }) => {
  // The board posts its selection only to a parent on its own origin, as under
  // Tailscale Serve (board at /, page at /agent/): serve the page from the board's origin.
  await page.route(`${stack.boardUrl}/agent/**`, async route => {
    const url = route.request().url().replace(stack.boardUrl, pageUrl);
    await route.fulfill({ response: await route.fetch({ url }) });
  });
  const id = await stack.board('Framed', { agent: { name: 'Clerk', writes: 'chat', memory: 'thread' } });
  const card = (text, x) => stack.api('POST', '/api/item', { canvasId: id, type: 'note', x, y: 300, data: { text } });
  const a = await card('alpha', 60);
  const b = await card('beta', 360);

  await page.goto(`${stack.boardUrl}/agent/?board=${id}`);
  await expect(page.locator('#agent option')).toHaveText(['Clerk']);
  const frame = page.frameLocator('#board');
  await frame.locator(`[data-id="${a.id}"]`).click();
  await frame.locator(`[data-id="${b.id}"]`).click({ modifiers: ['Shift'] });
  await expect(page.locator('#selection')).toHaveText('2 cards selected');

  await page.fill('#text', 'compare these');
  const sent = page.waitForRequest(r => r.method() === 'POST' && r.url().endsWith('/agent/api/requests'));
  await page.click('#ask button[type=submit]');
  expect((await sent).postDataJSON().notes).toEqual([{ ids: [a.id, b.id], text: 'compare these' }]);

  // the receipt runs to done and the reply names both cards
  await expect(page.locator('#queue .receipt')).toHaveText('done');
  const reply = page.locator('#messages li.assistant');
  await expect(reply).toContainText(`Fake reply to: On [${a.id}], [${b.id}]: compare these`);
  await expect(page.locator('#threads button')).toHaveText(['compare these']);

  // pin the reply to the board
  await reply.getByRole('button', { name: 'Pin to board' }).click();
  await expect(reply.getByRole('button', { name: 'Pinned' })).toBeVisible();
  const pinned = (await stack.items(id)).find(it => String(it.data.text || '').startsWith('From Clerk'));
  expect(pinned.data.text).toContain('Fake reply to:');
});
