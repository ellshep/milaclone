import { describe, it, expect } from 'vitest';
import { dueLabel, isFixed, placementAfterDrop } from '../../public/js/focusorder.js';

const t = (id, tier = 'rest', extra = {}) => Object.assign({ id, tier }, extra);

describe('dueLabel', () => {
  it('says how overdue, today, tomorrow, a weekday within the week, else a date', () => {
    expect(dueLabel({ dueIn: -1, due: '2026-11-20' })).toBe('1 day overdue');
    expect(dueLabel({ dueIn: -12, due: '2026-11-09' })).toBe('12 days overdue');
    expect(dueLabel({ dueIn: 0, due: '2026-11-21' })).toBe('Due today');
    expect(dueLabel({ dueIn: 1, due: '2026-11-22' })).toBe('Due tomorrow');
    expect(dueLabel({ dueIn: 6, due: '2026-11-27' })).toBe('Due Friday');
    expect(dueLabel({ dueIn: 7, due: '2026-11-28' })).toBe('Due 28 Nov');
  });
  it('is empty for an undated task', () => {
    expect(dueLabel({ dueIn: null })).toBe('');
    expect(dueLabel({})).toBe('');
  });
});

describe('isFixed', () => {
  it('pins overdue and due-today tasks only', () => {
    expect(['overdue', 'today', 'top', 'rest', 'bottom'].map(tier => isFixed({ tier }))).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });
});

describe('placementAfterDrop', () => {
  const tasks = [t('o', 'overdue'), t('a', 'top'), t('b', 'top'), t('c'), t('d'), t('e', 'bottom')];

  it('places the dragged task only, into yours at the drop position', () => {
    expect(placementAfterDrop(tasks, 'd', 'b', false)).toEqual({ top: ['a', 'd', 'b'], bottom: ['e'] });
    expect(placementAfterDrop(tasks, 'd', 'a', false)).toEqual({ top: ['d', 'a', 'b'], bottom: ['e'] });
    expect(placementAfterDrop(tasks, 'b', 'a', false)).toEqual({ top: ['b', 'a'], bottom: ['e'] });
    expect(placementAfterDrop(tasks, 'e', 'a', true)).toEqual({ top: ['a', 'e', 'b'], bottom: [] });
  });

  it('makes a task dropped below the last placed one the last of yours', () => {
    expect(placementAfterDrop(tasks, 'd', 'c', false)).toEqual({ top: ['a', 'b', 'd'], bottom: ['e'] });
    expect(placementAfterDrop(tasks, 'c', 'e', true)).toEqual({ top: ['a', 'b', 'c'], bottom: ['e'] });
    expect(placementAfterDrop(tasks, 'a', 'd', true)).toEqual({ top: ['b', 'a'], bottom: ['e'] });
    const none = [t('x'), t('y'), t('z')];
    expect(placementAfterDrop(none, 'z', 'x', false)).toEqual({ top: ['z'], bottom: [] });
    expect(placementAfterDrop(none, 'x', 'z', true)).toEqual({ top: ['x'], bottom: [] });
  });

  it('sends a task id that two lists share only once', () => {
    const shared = [t('a', 'top'), t('x', 'top'), t('a', 'top'), t('b'), t('c')];
    expect(placementAfterDrop(shared, 'c', 'b', false)).toEqual({ top: ['a', 'x', 'c'], bottom: [] });
  });

  it('returns null when nothing would move or a due-now task is involved', () => {
    expect(placementAfterDrop(tasks, 'a', 'b', false)).toBeNull(); // already right above
    expect(placementAfterDrop(tasks, 'b', 'c', false)).toBeNull(); // already last of yours
    expect(placementAfterDrop(tasks, 'a', 'a', false)).toBeNull();
    expect(placementAfterDrop(tasks, 'o', 'a', false)).toBeNull(); // can't drag a due-now task
    expect(placementAfterDrop(tasks, 'c', 'o', false)).toBeNull(); // or drop onto one
    expect(placementAfterDrop(tasks, 'zz', 'a', false)).toBeNull();
  });
});
