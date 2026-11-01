'use strict';

// U2: Mila as an installable, offline-capable home-screen app.

const { test, expect } = require('@playwright/test');
const { freshCanvas } = require('./helpers');

test('U2.1 the manifest names Mila, runs standalone, and every icon loads', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/icons/apple-touch-icon.png');
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute('content', 'Mila');
  await expect(page.locator('meta[name="theme-color"]')).toHaveCount(2);

  const m = await (await request.get('/manifest.webmanifest')).json();
  expect(m).toMatchObject({ name: 'Mila', short_name: 'Mila', display: 'standalone', start_url: '/' });
  expect(m.background_color).toMatch(/^#[0-9a-f]{6}$/);
  expect(m.theme_color).toMatch(/^#[0-9a-f]{6}$/);
  expect(m.icons.map(i => i.sizes + (i.purpose ? ' ' + i.purpose : ''))).toEqual([
    '192x192',
    '512x512',
    '512x512 maskable',
  ]);
  for (const src of [...m.icons.map(i => i.src), '/icons/apple-touch-icon.png']) {
    const r = await request.get(src);
    expect(r.status(), src).toBe(200);
    expect(r.headers()['content-type'], src).toMatch(/^image\//);
  }
});

test.describe('offline', () => {
  test.use({ serviceWorkers: 'allow' });

  test('U2.2 after one online launch, the last board opens with no network', async ({ page, context }) => {
    const id = await freshCanvas(page);
    await page.evaluate(
      id =>
        fetch('/api/item', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ canvasId: id, type: 'note', x: 300, y: 200, data: { body: 'Still here offline' } }),
        }),
      id
    );
    await page.reload();
    await expect(page.locator('.item.type-note')).toContainText('Still here offline');

    // The worker registers, and the page's own loads (shell, modules, this board) reach its cache.
    await expect
      .poll(() =>
        page.evaluate(async id => !!(await caches.match('/api/canvas/' + id)) && !!(await caches.match('/')), id)
      )
      .toBe(true);
    expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toMatch(/\/sw\.js$/);

    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('.item.type-note')).toContainText('Still here offline');
    await expect(page.locator('#crumbs')).toContainText('fixture');
  });
});
