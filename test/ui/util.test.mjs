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
  isUrl,
  embedUrl,
  fileIcon,
  clipMarker,
  parseClipMarker,
  snap,
  zRange,
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

describe('canvas helpers', () => {
  it('snap rounds to the 10 px grid unless free', () => {
    expect(snap(14, false)).toBe(10);
    expect(snap(15, false)).toBe(20);
    expect(snap(-6, false)).toBe(-10);
    expect(snap(14.3, true)).toBe(14.3);
  });

  it('zRange spans free cards and always includes 0', () => {
    expect(zRange([])).toEqual([0, 0]);
    expect(zRange([{ z: 3 }, { z: -2 }, { z: 9, parentItemId: 'c' }])).toEqual([-2, 3]);
  });
});

describe('capture helpers', () => {
  it('isUrl accepts http(s) only', () => {
    expect(isUrl('https://a.b/c')).toBe(true);
    expect(isUrl(' http://x.y ')).toBe(true);
    expect(isUrl('example.com')).toBe(false);
    expect(isUrl('https://a b')).toBe(false);
    expect(isUrl(null)).toBe(false);
  });

  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'],
    ['https://m.youtube.com/shorts/abc_123', 'https://www.youtube-nocookie.com/embed/abc_123'],
    ['https://youtu.be/dQw4w9WgXcQ?si=x', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'],
    ['https://vimeo.com/76979871', 'https://player.vimeo.com/video/76979871'],
    [
      'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
      'https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC',
    ],
    ['https://open.spotify.com/intl-de/album/1A2B', 'https://open.spotify.com/embed/album/1A2B'],
  ])('embedUrl(%s)', (input, out) => expect(embedUrl(input)).toBe(out));

  it.each([
    'https://example.com/watch?v=x',
    'https://www.youtube.com/watch',
    'https://www.youtube.com/channel/UC1',
    'https://www.youtube.com/watch?v=<script>',
    'https://youtu.be/',
    'https://vimeo.com/channels/staff',
    'https://open.spotify.com/user/abc',
    'not a url',
    '',
  ])('embedUrl(%s) is null', input => expect(embedUrl(input)).toBeNull());

  it.each([
    ['photo.PNG', 'image/png', 'file-image'],
    ['a.mp3', 'audio/mpeg', 'file-audio'],
    ['a.mov', 'video/quicktime', 'file-video'],
    ['report.pdf', 'application/pdf', 'file-text'],
    ['sheet.XLSX', '', 'file-spreadsheet'],
    ['deck.pptx', '', 'presentation'],
    ['bundle.zip', 'application/zip', 'file-archive'],
    ['data.json', 'application/json', 'file-json'],
    ['mystery', '', 'file'],
    [undefined, undefined, 'file'],
  ])('fileIcon(%s, %s)', (name, mime, icon) => expect(fileIcon(name, mime)).toBe(icon));

  it('clip markers round-trip one or many ids and reject other text', () => {
    expect(parseClipMarker(clipMarker('i_aB-9', false))).toEqual({ ids: ['i_aB-9'], cut: false });
    expect(clipMarker(['i_a', 'i_b'], true)).toBe('milaclone:item:i_a,i_b:cut');
    expect(parseClipMarker(clipMarker(['i_a', 'i_b'], true))).toEqual({ ids: ['i_a', 'i_b'], cut: true });
    expect(parseClipMarker('milaclone:item:i_x:move')).toBeNull();
    expect(parseClipMarker('milaclone:item:i_x,:copy')).toBeNull();
    expect(parseClipMarker('hello')).toBeNull();
    expect(parseClipMarker(undefined)).toBeNull();
  });
});
