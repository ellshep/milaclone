import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../public/js/api.js';

afterEach(() => vi.unstubAllGlobals());

it('reads unknown task statuses as open in cached canvas and Quick notes responses', async () => {
  const tasks = [
    { id: 'a', text: 'Milk', status: 'pending' },
    { id: 'b', text: 'Eggs', status: null },
    { id: 'c', text: 'Bread', done: true },
    { id: 'd', text: 'Cheese', status: 'stale', statusAt: 1000 },
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(url =>
      Promise.resolve(
        Response.json(
          url === '/api/todos'
            ? { lists: [{ tasks }] }
            : {
                items: [
                  { type: 'todo', data: { tasks } },
                  { type: 'document', data: { tasks } },
                ],
              }
        )
      )
    )
  );

  const expected = [
    { id: 'a', text: 'Milk', status: 'open' },
    { id: 'b', text: 'Eggs', status: 'open' },
    { id: 'c', text: 'Bread', status: 'done', statusAt: null },
    { id: 'd', text: 'Cheese', status: 'stale', statusAt: 1000 },
  ];
  const [todo, doc] = (await api.canvas('a')).items;
  expect(todo.data.tasks).toEqual(expected);
  expect(doc.data.tasks).toEqual(tasks);
  expect((await api.todos()).lists[0].tasks).toEqual(expected);
});
