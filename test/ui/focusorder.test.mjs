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
    expect(['overdue', 'today', 'placed', 'soon', 'starred', 'rest'].map(tier => isFixed({ tier }))).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe('placementAfterDrop', () => {
  const tasks = [t('o', 'overdue'), t('a'), t('b'), t('c'), t('d')];

  it('places every movable task from the top down to the dropped one', () => {
    expect(placementAfterDrop(tasks, 'c', 'a', false)).toEqual(['c']);
    expect(placementAfterDrop(tasks, 'a', 'c', true)).toEqual(['b', 'c', 'a']);
    expect(placementAfterDrop(tasks, 'd', 'b', true)).toEqual(['a', 'b', 'd']);
  });

  it('keeps tasks placed further down placed', () => {
    const placed = [t('a', 'placed'), t('b', 'placed'), t('c'), t('d')];
    expect(placementAfterDrop(placed, 'b', 'a', false)).toEqual(['b', 'a']);
    expect(placementAfterDrop(placed, 'a', 'c', true)).toEqual(['b', 'c', 'a']);
  });

  it('sends a task id that two lists share only once', () => {
    const shared = [t('a'), t('x'), t('a'), t('b'), t('c')];
    expect(placementAfterDrop(shared, 'c', 'b', false)).toEqual(['a', 'x', 'c']);
  });

  it('returns null when nothing would move or a fixed task is involved', () => {
    expect(placementAfterDrop(tasks, 'a', 'b', false)).toBeNull(); // already right above
    expect(placementAfterDrop(tasks, 'b', 'a', true)).toBeNull(); // already right below
    expect(placementAfterDrop(tasks, 'a', 'a', false)).toBeNull();
    expect(placementAfterDrop(tasks, 'o', 'a', false)).toBeNull(); // can't drag a fixed task
    expect(placementAfterDrop(tasks, 'a', 'o', false)).toBeNull(); // or drop onto one
    expect(placementAfterDrop(tasks, 'zz', 'a', false)).toBeNull();
  });
});
