'use strict';

// F5.4: dark mode follows prefers-color-scheme (decision D8).

const { test, expect } = require('@playwright/test');
const { freshCanvas } = require('./helpers');

// WCAG contrast of an element's text against the nearest opaque background.
const contrastOf = (page, selector) =>
  page
    .locator(selector)
    .first()
    .evaluate(el => {
      const rgb = s => s.match(/[\d.]+/g).map(Number);
      const lum = c => {
        const [r, g, b] = c.slice(0, 3).map(v => {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      let bg = el;
      // the nearest fully opaque background (translucent layers are skipped, not treated as solid)
      while (bg && (rgb(getComputedStyle(bg).backgroundColor)[3] ?? 1) < 1) bg = bg.parentElement;
      const [a, b] = [
        lum(rgb(getComputedStyle(el).color)),
        lum(rgb(getComputedStyle(bg || document.body).backgroundColor)),
      ];
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });

const post = (page, body) =>
  page.evaluate(
    b =>
      fetch('/api/item', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }),
    body
  );

test.describe('dark', () => {
  test.use({ colorScheme: 'dark' });

  test('F5.4: the canvas goes dark and card text keeps at least 4.5:1 contrast', async ({ page }) => {
    const id = await freshCanvas(page);
    await post(page, { canvasId: id, type: 'note', x: 100, y: 100, data: { title: 'Dark', body: 'readable' } });
    await post(page, {
      canvasId: id,
      type: 'todo',
      x: 400,
      y: 100,
      data: { title: 'List', tasks: [{ id: 't', text: 'a task', done: false }] },
    });
    await post(page, { canvasId: id, type: 'comment', x: 100, y: 400, data: { body: 'a comment' } });
    const lit = { type: 'text', text: 'lit', marks: [{ type: 'highlight' }] };
    await post(page, {
      canvasId: id,
      type: 'note',
      x: 400,
      y: 400,
      data: { doc: { type: 'doc', content: [{ type: 'paragraph', content: [lit] }] } },
    });
    await page.reload();
    await expect(page.locator('.item.type-note')).toHaveCount(2);

    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const [r, g, b] = bg.match(/\d+/g).map(Number);
    expect(Math.max(r, g, b)).toBeLessThan(60); // a dark canvas

    for (const sel of [
      '.item.type-note .nbody p',
      '.item.type-note .nbody h2',
      '.task .txt',
      '.item.type-comment .cbody',
      '#crumbs .crumb.current',
    ]) {
      expect(await contrastOf(page, sel), sel).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('Quick notes goes dark too', async ({ page }) => {
    await freshCanvas(page);
    await page.locator('#phoneNotes').click();
    await expect(page.locator('#quicknotes .qn-title')).toBeVisible();
    const bg = await page.locator('#quicknotes').evaluate(el => getComputedStyle(el).backgroundColor);
    expect(Math.max(...bg.match(/\d+/g).slice(0, 3).map(Number))).toBeLessThan(60);
    expect(await contrastOf(page, '#quicknotes .qn-title')).toBeGreaterThanOrEqual(4.5);
    expect(await contrastOf(page, '.qn-deskhead')).toBeGreaterThanOrEqual(4.5);
  });

  test('hover states and the mobile title stay readable', async ({ page }) => {
    await freshCanvas(page);
    await page.locator('#zoomIn').hover();
    expect(await contrastOf(page, '#zoomIn')).toBeGreaterThanOrEqual(4.5);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#mTitle')).toBeVisible();
    expect(await contrastOf(page, '#mTitle')).toBeGreaterThanOrEqual(4.5);
  });

  test('menus and sheets use the dark surface', async ({ page }) => {
    await freshCanvas(page);
    await page.locator('#exportBtn').click();
    const menuBg = await page.locator('#exportMenu').evaluate(el => getComputedStyle(el).backgroundColor);
    expect(menuBg).not.toBe('rgb(255, 255, 255)');
    expect(await contrastOf(page, '#exportMenu a')).toBeGreaterThanOrEqual(4.5);
    await page.keyboard.press('Escape');
    await page.keyboard.press('/');
    expect(await contrastOf(page, '#shortcutsDialog dd')).toBeGreaterThanOrEqual(4.5);
  });
});

test('light mode is unchanged', async ({ page }) => {
  await freshCanvas(page);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(239, 239, 241)');
});
