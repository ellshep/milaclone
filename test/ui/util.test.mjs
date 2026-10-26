import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  colorVar,
  lucideEl,
  refreshIcons,
  autoGrow,
  isLocked,
  rid,
  normalizeUrl,
  imageSize,
  toast,
} from '../../public/js/util.js';
import { dom } from '../../public/js/state.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('util', () => {
  it('colorVar maps known colours and falls back to slate', () => {
    expect(colorVar('blue')).toBe('var(--c-blue)');
    expect(colorVar('nope')).toBe('var(--c-slate)');
  });

  it('normalizeUrl adds https to bare hosts', () => {
    expect(normalizeUrl('')).toBe('#');
    expect(normalizeUrl('example.com')).toBe('https://example.com');
    expect(normalizeUrl('http://x.com')).toBe('http://x.com');
  });

  it('isLocked and rid', () => {
    expect(isLocked({ data: { locked: true } })).toBe(true);
    expect(isLocked({})).toBe(false);
    expect(rid()).toMatch(/^[a-z0-9]{1,8}$/);
  });

  it('lucideEl builds an icon placeholder', () => {
    expect(lucideEl('star').getAttribute('data-lucide')).toBe('star');
  });

  it('refreshIcons no-ops without the CDN global and scopes to a root when given', () => {
    expect(() => refreshIcons()).not.toThrow();
    const createIcons = vi.fn();
    vi.stubGlobal('lucide', { createIcons });
    const root = document.createElement('div');
    refreshIcons(root);
    refreshIcons();
    expect(createIcons).toHaveBeenNthCalledWith(1, { nodes: [root] });
    expect(createIcons).toHaveBeenNthCalledWith(2, undefined);
  });

  it('autoGrow sizes a textarea to its content', () => {
    const t = document.createElement('textarea');
    Object.defineProperty(t, 'scrollHeight', { value: 42 });
    autoGrow(t);
    expect(t.style.height).toBe('42px');
  });

  it('imageSize resolves 1×1 when the image fails to load', async () => {
    vi.stubGlobal(
      'Image',
      class {
        set src(_) {
          queueMicrotask(() => this.onerror());
        }
      }
    );
    await expect(imageSize('x.png')).resolves.toEqual({ w: 1, h: 1 });
  });

  it('imageSize resolves natural dimensions on load', async () => {
    vi.stubGlobal(
      'Image',
      class {
        naturalWidth = 30;
        naturalHeight = 20;
        set src(_) {
          queueMicrotask(() => this.onload());
        }
      }
    );
    await expect(imageSize('x.png')).resolves.toEqual({ w: 30, h: 20 });
  });

  it('toast shows a message and hides it after a delay', () => {
    vi.useFakeTimers();
    toast('Saved');
    expect(dom.toastEl.textContent).toBe('Saved');
    expect(dom.toastEl.classList.contains('show')).toBe(true);
    vi.advanceTimersByTime(2200);
    expect(dom.toastEl.classList.contains('show')).toBe(false);
  });

  it('toast with an action renders a button that runs it and dismisses', () => {
    const fn = vi.fn();
    toast('Deleted', { label: 'Undo', fn });
    const btn = dom.toastEl.querySelector('.toast-action');
    expect(btn.textContent).toBe('Undo');
    btn.click();
    expect(fn).toHaveBeenCalledOnce();
    expect(dom.toastEl.classList.contains('show')).toBe(false);
  });
});
