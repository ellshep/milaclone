import { describe, it, expect, vi } from 'vitest';
import { postSelection } from '../../public/js/embed.js';

describe('postSelection', () => {
  it('posts the selected ids to a framing page on the same origin', () => {
    const parent = { postMessage: vi.fn() };
    const win = { parent, location: { origin: 'https://mila.example' } };
    postSelection(new Set(['i_1', 'i_2']), win);
    expect(parent.postMessage).toHaveBeenCalledWith(
      { type: 'milaclone:selection', ids: ['i_1', 'i_2'] },
      'https://mila.example'
    );
    postSelection([], win);
    expect(parent.postMessage).toHaveBeenLastCalledWith(
      { type: 'milaclone:selection', ids: [] },
      'https://mila.example'
    );
  });

  it('posts nothing when the board is not framed', () => {
    const win = { postMessage: vi.fn(), location: { origin: 'https://mila.example' } };
    win.parent = win;
    postSelection(new Set(['i_1']), win);
    expect(win.postMessage).not.toHaveBeenCalled();
    postSelection(new Set()); // the real window, standalone under jsdom
  });
});
