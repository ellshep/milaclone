// Pure helpers for the /focus page (focuspage.js): the due line under a task and
// the placements a List-mode drag produces. Tasks are the server's focus order
// (`GET /api/focus`), each with `tier` and `dueIn`.

const FIXED = new Set(['overdue', 'today']);

/** Overdue and due-today tasks keep their place: they can't be dragged or dropped above. */
export const isFixed = task => FIXED.has(task.tier);

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The small line under a task: "3 days overdue", "Due today", "Due Friday", "Due 28 Nov", or '' when undated. */
export function dueLabel(task) {
  const n = task.dueIn;
  if (typeof n !== 'number') return '';
  if (n < 0) return plural(-n, 'day') + ' overdue';
  if (n === 0) return 'Due today';
  if (n === 1) return 'Due tomorrow';
  const [y, m, d] = task.due.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const opts = n < 7 ? { weekday: 'long' } : { day: 'numeric', month: 'short' };
  return 'Due ' + date.toLocaleDateString('en-GB', Object.assign({ timeZone: 'UTC' }, opts));
}

/**
 * The placements after dropping `dragId` before (or `after`) `targetId`, as the
 * ids for `PUT /api/focus/order`; null when the drop changes nothing.
 * `tasks` is the whole focus order. Placed tasks sort above every unplaced
 * one, so the drop places every movable task from the top down to the dropped
 * one (or to the lowest task already placed), which keeps the order as shown.
 */
export function placementAfterDrop(tasks, dragId, targetId, after) {
  const movable = tasks.filter(t => !isFixed(t));
  const moved = movable.find(t => t.id === dragId);
  if (!moved || dragId === targetId) return null;
  const order = movable.filter(t => t !== moved);
  let at = order.findIndex(t => t.id === targetId);
  if (at < 0) return null;
  if (after) at++;
  if (movable[at] === moved) return null;
  order.splice(at, 0, moved);
  let last = at;
  order.forEach((t, i) => {
    if (t.tier === 'placed') last = Math.max(last, i);
  });
  return order.slice(0, last + 1).map(t => t.id);
}
