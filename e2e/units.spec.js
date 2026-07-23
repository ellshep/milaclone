'use strict';

// Unit-level coverage for the pure exports of the front-end modules. The app is
// vanilla ES modules served straight off Express, so we exercise them the way
// they actually run — imported into a real browser page via dynamic import().
// Modules are singletons, so importing here returns the same instances the app
// already booted, with no side effects.

const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  // Wait for the app to have booted (root canvas loaded) before importing modules.
  await expect(page.locator('#crumbs')).toContainText('Home');
});

test('util.normalizeUrl coerces bare hosts to https and leaves valid urls alone', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { normalizeUrl } = await import('/js/util.js');
    return {
      empty: normalizeUrl(''),
      undef: normalizeUrl(undefined),
      bare: normalizeUrl('example.com'),
      http: normalizeUrl('http://x.com'),
      https: normalizeUrl('https://x.com/a?b=c'),
    };
  });
  expect(out.empty).toBe('#');
  expect(out.undef).toBe('#');
  expect(out.bare).toBe('https://example.com');
  expect(out.http).toBe('http://x.com');
  expect(out.https).toBe('https://x.com/a?b=c');
});

test('util.colorVar maps known colors and falls back to slate', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { colorVar } = await import('/js/util.js');
    return { blue: colorVar('blue'), bogus: colorVar('chartreuse'), missing: colorVar(undefined) };
  });
  expect(out.blue).toBe('var(--c-blue)');
  expect(out.bogus).toBe('var(--c-slate)');
  expect(out.missing).toBe('var(--c-slate)');
});

test('util.isLocked reflects the data.locked flag', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { isLocked } = await import('/js/util.js');
    return {
      locked: isLocked({ data: { locked: true } }),
      unlocked: isLocked({ data: { locked: false } }),
      empty: isLocked({ data: {} }),
      noData: isLocked({}),
    };
  });
  expect(out.locked).toBe(true);
  expect(out.unlocked).toBe(false);
  expect(out.empty).toBe(false);
  expect(out.noData).toBe(false);
});

test('util.rid produces distinct short ids', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { rid } = await import('/js/util.js');
    const a = rid(), b = rid();
    return { a, b, len: a.length };
  });
  expect(out.len).toBeGreaterThan(0);
  expect(out.len).toBeLessThanOrEqual(8);
  expect(out.a).not.toBe(out.b);
});

test('create.defaultsFor returns the right shape per card type', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { defaultsFor } = await import('/js/create.js');
    const d = t => defaultsFor(t);
    return {
      note: d('note'),
      todo: d('todo'),
      link: d('link'),
      column: d('column'),
      board: d('board'),
      comment: d('comment'),
      file: d('file'),
      unknown: d('mystery'),
    };
  });
  expect(out.note).toEqual({ w: 240, data: { title: '', body: '' } });
  expect(out.todo.w).toBe(240);
  expect(out.todo.data.tasks).toHaveLength(1);
  expect(out.todo.data.tasks[0]).toMatchObject({ text: '', done: false });
  expect(out.link).toMatchObject({ w: 240, color: 'blue', data: { url: '', title: '' } });
  expect(out.column.w).toBe(252);
  expect(out.board.w).toBe(152);
  expect(out.comment.w).toBe(220);
  expect(out.file).toEqual({ w: 220, data: {} });
  expect(out.unknown).toEqual({ w: 240, data: {} });
});

test('viewport.loadCam round-trips a saved camera and defaults when absent', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { loadCam } = await import('/js/viewport.js');
    localStorage.setItem('cam:unit-test', JSON.stringify({ x: 12, y: 34, scale: 1.5 }));
    const saved = loadCam('unit-test');
    localStorage.removeItem('cam:unit-test');
    const fallback = loadCam('does-not-exist');
    return { saved, fallback };
  });
  expect(out.saved).toEqual({ x: 12, y: 34, scale: 1.5 });
  expect(out.fallback).toEqual({ x: 80, y: 60, scale: 1 });
});
