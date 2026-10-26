'use strict';

const { test, expect } = require('@playwright/test');
const { freshCanvas } = require('./helpers');

// P2 · Capture: clipboard paste, OS drag-drop, embeds, lightbox, image options,
// file icons and players.

// 1×1 PNG
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAAJJRU5ErkJggg==';

const api = (page, method, url, body) =>
  page.evaluate(
    async ([method, url, body]) =>
      (
        await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          ...(body && { body: JSON.stringify(body) }),
        })
      ).json(),
    [method, url, body]
  );

const items = page => page.locator('#world > .item');

// Dispatch a paste carrying text and/or files, as the browser would on cmd+V.
const paste = (page, { text, files = [] }) =>
  page.evaluate(
    ([text, files, png]) => {
      const dt = new DataTransfer();
      if (text) dt.setData('text/plain', text);
      for (const f of files) {
        const bytes = f.png ? Uint8Array.from(atob(png), c => c.charCodeAt(0)) : new TextEncoder().encode(f.body);
        dt.items.add(new File([bytes], f.name, { type: f.type }));
      }
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    [text, files, PNG_B64]
  );

test('F2.1 pasting an image, a URL and text creates image, link and note cards', async ({ page }) => {
  await freshCanvas(page);
  await page.mouse.move(500, 350);

  await paste(page, { files: [{ name: 'shot.png', type: 'image/png', png: true }] });
  await expect(page.locator('#world > .item.type-image img')).toHaveAttribute('src', /^\/uploads\//);

  await paste(page, { text: 'https://example.com/page' });
  await expect(page.locator('#world > .item.type-link .lurl')).toHaveValue('https://example.com/page');

  await paste(page, { text: 'Remember the milk' });
  await expect(page.locator('#world > .item.type-note .nbody')).toHaveValue('Remember the milk');
  await expect(items(page)).toHaveCount(3);
});

test('F2.1 copying a card puts a marker on the clipboard; pasting it deep-copies the card', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  // a file card selects without entering edit mode (a note would take the copy as text)
  const note = await api(page, 'POST', '/api/item', { canvasId, type: 'file', data: { name: 'Original.pdf' } });
  await page.reload();
  await page.locator(`.item[data-id="${note.id}"]`).click();

  const marker = await page.evaluate(() => {
    const dt = new DataTransfer();
    document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }));
    return dt.getData('text/plain');
  });
  expect(marker).toBe(`milaclone:item:${note.id}:copy`);

  await paste(page, { text: marker });
  await expect(items(page)).toHaveCount(2);
  await expect(page.locator('#world > .item.type-file .fname')).toHaveText(['Original.pdf', 'Original.pdf']);
});

test('F2.2 files dropped from the computer land as cards at the drop point', async ({ page }) => {
  await freshCanvas(page);
  await page.evaluate(png => {
    const dt = new DataTransfer();
    const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));
    dt.items.add(new File([bytes], 'a.png', { type: 'image/png' }));
    dt.items.add(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    const stage = document.getElementById('stage');
    for (const type of ['dragover', 'drop']) {
      stage.dispatchEvent(
        new DragEvent(type, { dataTransfer: dt, clientX: 600, clientY: 400, bubbles: true, cancelable: true })
      );
    }
  }, PNG_B64);
  await expect(items(page)).toHaveCount(2);
  await expect(page.locator('#world > .item.type-image')).toHaveCount(1);
  await expect(page.locator('#world > .item.type-file .fname')).toHaveText('notes.txt');

  // both cards sit in one row around the drop point
  const boxes = await items(page).evaluateAll(els => els.map(e => e.getBoundingClientRect()));
  for (const b of boxes) expect(Math.abs(b.top - boxes[0].top)).toBeLessThan(2);
  expect(Math.min(...boxes.map(b => b.left))).toBeLessThan(600);
  expect(Math.max(...boxes.map(b => b.right))).toBeGreaterThan(600);
});

test('F2.2 a link dropped from the browser becomes a link card', async ({ page }) => {
  await freshCanvas(page);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/uri-list', '# comment\nhttps://example.org/dropped');
    const stage = document.getElementById('stage');
    for (const type of ['dragover', 'drop']) {
      stage.dispatchEvent(
        new DragEvent(type, { dataTransfer: dt, clientX: 500, clientY: 300, bubbles: true, cancelable: true })
      );
    }
  });
  await expect(page.locator('#world > .item.type-link .lurl')).toHaveValue('https://example.org/dropped');
});

test('F2.3 YouTube links play inline; other links stay plain', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  const yt = await api(page, 'POST', '/api/item', {
    canvasId,
    type: 'link',
    data: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
  });
  const plain = await api(page, 'POST', '/api/item', {
    canvasId,
    type: 'link',
    y: 400,
    data: { url: 'https://example.com' },
  });
  await page.reload();
  await expect(page.locator(`.item[data-id="${yt.id}"] iframe`)).toHaveAttribute(
    'src',
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'
  );
  await expect(page.locator(`.item[data-id="${plain.id}"] iframe`)).toHaveCount(0);
});

test('F2.4 double-clicking an image opens the lightbox; arrows step, Escape closes', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  const up = await page.evaluate(async png => {
    const fd = new FormData();
    fd.append('file', new Blob([Uint8Array.from(atob(png), c => c.charCodeAt(0))], { type: 'image/png' }), 'x.png');
    return (await fetch('/api/upload', { method: 'POST', body: fd })).json();
  }, PNG_B64);
  const first = await api(page, 'POST', '/api/item', {
    canvasId,
    type: 'image',
    x: 100,
    y: 100,
    data: { src: up.src, caption: 'First' },
  });
  await api(page, 'POST', '/api/item', {
    canvasId,
    type: 'image',
    x: 100,
    y: 500,
    data: { src: up.src, caption: 'Second' },
  });
  await page.reload();

  // the card, not the <img>: an image that hasn't loaded yet has no height
  await page.locator(`.item[data-id="${first.id}"]`).dblclick();
  const lb = page.locator('#lightbox');
  await expect(lb).toHaveAttribute('open', '');
  await expect(lb.locator('.lb-caption')).toHaveText('First');
  await expect(lb.locator('.lb-prev')).toBeHidden();
  await page.keyboard.press('ArrowRight');
  await expect(lb.locator('.lb-caption')).toHaveText('Second');
  await expect(lb.locator('.lb-next')).toBeHidden();
  await page.keyboard.press('ArrowLeft');
  await expect(lb.locator('.lb-caption')).toHaveText('First');
  await page.keyboard.press('Escape');
  await expect(lb).not.toHaveAttribute('open');
});

test('F2.5 image caption and transparent background survive a reload', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  const img = await api(page, 'POST', '/api/item', { canvasId, type: 'image', data: { src: '/x.png' } });
  await page.reload();
  const card = page.locator(`.item[data-id="${img.id}"]`);

  await card.click({ button: 'right' });
  await page.getByRole('button', { name: 'Transparent Background' }).click();
  await expect(card).toHaveClass(/transparent/);

  await card.click();
  await page.keyboard.press('Enter');
  const caption = card.getByRole('textbox', { name: 'Caption' });
  await caption.fill('Sunset over the bay');
  await page.waitForResponse(r => r.url().includes('/api/item/') && r.request().method() === 'PATCH');

  await page.reload();
  await expect(card).toHaveClass(/transparent/);
  await expect(card.getByRole('textbox', { name: 'Caption' })).toHaveValue('Sunset over the bay');
});

test('F2.6 audio files get a player and a matching icon', async ({ page }) => {
  await freshCanvas(page);
  await page.setInputFiles('#uploadInput', { name: 'song.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('ID3') });
  const card = page.locator('#world > .item.type-file');
  await expect(card.locator('audio')).toHaveAttribute('src', /^\/uploads\/.+\.mp3$/);
  await expect(card.locator('.ficon [data-lucide="file-audio"], .ficon svg.lucide-file-audio')).toHaveCount(1);
});

// ---- review regressions ----------------------------------------------------

test('clicking an image selects it without editing, so Delete removes it', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  const img = await api(page, 'POST', '/api/item', { canvasId, type: 'image', data: { src: '/x.png' } });
  await page.reload();
  const card = page.locator(`.item[data-id="${img.id}"]`);
  await card.click();
  await expect(card).toHaveClass(/selected/);
  await expect(card).not.toHaveClass(/editing/);
  await page.keyboard.press('Delete');
  await expect(card).toHaveCount(0);
});

test('a cut marker moves the card once; pasting it again does nothing', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  const other = await api(page, 'POST', '/api/item', { canvasId, type: 'board', data: { title: 'Elsewhere' } });
  const card = await api(page, 'POST', '/api/item', {
    canvasId: other.data.childCanvasId,
    type: 'file',
    data: { name: 'cut.pdf' },
  });
  await page.reload();
  await expect(page.locator('#crumbs')).toContainText('fixture'); // board loaded: paste is handled
  const marker = `milaclone:item:${card.id}:cut`;
  await paste(page, { text: marker });
  await expect(page.locator(`.item[data-id="${card.id}"]`)).toBeVisible();
  const moved = page
    .waitForResponse(r => r.url().endsWith('/move'), { timeout: 1500 })
    .then(
      () => true,
      () => false
    );
  await paste(page, { text: marker });
  expect(await moved).toBe(false);
  await expect(page.locator('#world > .item.type-file')).toHaveCount(1);
});

test('a context-menu copy the system clipboard refused still pastes the card, not stale text', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  const card = await api(page, 'POST', '/api/item', { canvasId, type: 'file', data: { name: 'menu.pdf' } });
  await page.reload();
  await page.evaluate(() => {
    navigator.clipboard.writeText = () => Promise.reject(new Error('denied'));
  });
  await page.locator(`.item[data-id="${card.id}"]`).click({ button: 'right' });
  await page.locator('#ctxmenu .ctx-item', { hasText: 'Copy' }).click();
  await paste(page, { text: 'old text from earlier' });
  await expect(page.locator('#world > .item.type-file .fname')).toHaveText(['menu.pdf', 'menu.pdf']);
  await expect(page.locator('#world > .item.type-note')).toHaveCount(0);
});

test('an Office-style paste (text + html + rendered picture) pastes the text', async ({ page }) => {
  await freshCanvas(page);
  await page.evaluate(png => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'Q3\t42');
    dt.setData('text/html', '<table><tr><td>Q3</td><td>42</td></tr></table>');
    dt.items.add(new File([Uint8Array.from(atob(png), c => c.charCodeAt(0))], 'image.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PNG_B64);
  await expect(page.locator('#world > .item.type-note .nbody')).toHaveValue('Q3\t42');
  await expect(page.locator('#world > .item.type-image')).toHaveCount(0);
});

test("dragging a card's own link onto the canvas doesn't import it", async ({ page }) => {
  const canvasId = await freshCanvas(page);
  await api(page, 'POST', '/api/item', { canvasId, type: 'link', data: { url: 'https://example.com' } });
  await page.reload();
  await expect(page.locator('.item.type-link a.open')).toBeVisible();
  const created = await page.evaluate(() => {
    const a = document.querySelector('.item.type-link a.open');
    const dt = new DataTransfer();
    dt.setData('text/uri-list', a.href);
    a.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
    const drop = new DragEvent('drop', {
      dataTransfer: dt,
      clientX: 700,
      clientY: 400,
      bubbles: true,
      cancelable: true,
    });
    document.getElementById('stage').dispatchEvent(drop);
    a.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));
    return drop.defaultPrevented;
  });
  expect(created).toBe(false);
  await expect(page.locator('#world > .item')).toHaveCount(1);
});

test('a batch upload with one rejected file adds the rest and says what failed', async ({ page }) => {
  await freshCanvas(page);
  await paste(page, {
    files: [
      { name: 'ok.txt', type: 'text/plain', body: 'fine' },
      { name: 'bad.exe', type: 'application/x-msdownload', body: 'MZ' },
    ],
  });
  await expect(page.locator('#world > .item.type-file .fname')).toHaveText('ok.txt');
  await expect(page.locator('#toast')).toContainText("1 of 2 failed: application/x-msdownload files can't be uploaded");
});
