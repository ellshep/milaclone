// Pure helpers for the /focus page (focuspage.js): the due line under a task and
// the placements a List-mode drag produces. Tasks are the server's focus order
// (`GET /api/focus`), each with `tier` (overdue, today, top, rest or bottom) and
// `dueIn`.

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
 * `{ top, bottom }` body for `PUT /api/focus/order`; null when the drop changes
 * nothing. `tasks` is the whole focus order. A drag places the dragged task
 * only (R10): into "yours" (tier `top`) at the drop position, or last of yours
 * when dropped below the last placed task. Every other task keeps its band.
 * Due-now tasks can't be dragged or dropped on. Each id is sent once: lists
 * made through the API can repeat a task id, and the server rejects repeats.
 */
export function placementAfterDrop(tasks, dragId, targetId, after) {
  const movable = tasks.filter(t => !isFixed(t));
  const target = movable.find(t => t.id === targetId);
  if (!target || dragId === targetId || !movable.some(t => t.id === dragId)) return null;
  const band = (tier, skip) => [...new Set(movable.filter(t => t.tier === tier && t.id !== skip).map(t => t.id))];
  const top = band('top', dragId);
  const at = target.tier === 'top' ? top.indexOf(target.id) + (after ? 1 : 0) : top.length;
  top.splice(at, 0, dragId);
  const next = { top, bottom: band('bottom', dragId) };
  const now = { top: band('top'), bottom: band('bottom') };
  return JSON.stringify(next) === JSON.stringify(now) ? null : next;
}
