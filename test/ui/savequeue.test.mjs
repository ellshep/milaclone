import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSaveQueue } from '../../public/js/savequeue.js';

// The save protocol through its interface, against an in-memory server.

function setup({ replies = [] } = {}) {
  const sent = [];
  const local = { a: { title: 'Local', tasks: [] } };
  const saved = [];
  const server = {
    // each call takes the next scripted reply, else echoes a successful save
    send: vi.fn(async (id, body, keepalive) => {
      sent.push({ id, body: JSON.parse(JSON.stringify(body)), keepalive });
      const r = replies.length ? replies.shift() : 'ok';
      if (r !== 'ok') return r;
      return { id, data: { ...local[id], ...body.data } };
    }),
  };
  const q = createSaveQueue({
    send: server.send,
    delay: 400,
    current: (id, key) => local[id][key],
    onSaved: (id, item, patch) => saved.push({ id, item, patch }),
  });
  return { q, sent, local, saved, server };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('save queue', () => {
  it('sends every field edited inside the debounce window as one save', async () => {
    const { q, sent } = setup();
    q.edit('a', { title: 'One' });
    await vi.advanceTimersByTimeAsync(300);
    q.edit('a', { caption: 'Two' }); // restarts the window
    await vi.advanceTimersByTimeAsync(300);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toEqual([{ id: 'a', body: { data: { title: 'One', caption: 'Two' } }, keepalive: false }]);
  });

  it('sends the tracked base with a task edit and adopts the server list as the new base', async () => {
    const { q, sent, saved } = setup();
    q.track('a', [{ id: 't1', text: 'Milk' }]);
    q.edit('a', { tasks: [{ id: 't1', text: 'Oat milk' }] });
    await q.flush('a');
    expect(sent[0].body.baseTasks).toEqual([{ id: 't1', text: 'Milk' }]);
    expect(saved[0].patch).toEqual({ tasks: [{ id: 't1', text: 'Oat milk' }] });

    q.edit('a', { tasks: [{ id: 't1', text: 'Soy milk' }] });
    await q.flush('a');
    expect(sent[1].body.baseTasks).toEqual([{ id: 't1', text: 'Oat milk' }]);
  });

  it('a non-task edit carries no base', async () => {
    const { q, sent } = setup();
    q.track('a', [{ id: 't1' }]);
    q.edit('a', { title: 'x' });
    await q.flush('a');
    expect(sent[0].body).toEqual({ data: { title: 'x' } });
  });

  it('retries a failed save with the current values, backing off', async () => {
    const { q, sent, local, saved } = setup({ replies: [null, null] });
    local.a.title = 'Typed'; // surfaces update their copy, then queue the edit
    q.edit('a', { title: 'Typed' });
    await q.flush('a');
    expect(q.pending('a')).toBe(true);
    expect(saved).toHaveLength(0);

    local.a.title = 'Typed more'; // the user kept going after the failure
    await vi.advanceTimersByTimeAsync(2000); // first retry after 2 s
    expect(sent[1].body.data.title).toBe('Typed more');

    await vi.advanceTimersByTimeAsync(3999); // second retry waits 4 s
    expect(sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(3);
    expect(saved).toHaveLength(1);
    expect(q.pending()).toBe(false);
  });

  it('a retry never overwrites a newer edit queued meanwhile', async () => {
    const { q, sent, server, local } = setup();
    let fail;
    server.send.mockImplementationOnce(async (id, body) => {
      sent.push({ id, body });
      return new Promise(r => (fail = r));
    });
    Object.assign(local.a, { title: 'Old', caption: 'Cap' });
    q.edit('a', { title: 'Old', caption: 'Cap' });
    const inFlight = q.flush('a');
    local.a.title = 'Newer';
    q.edit('a', { title: 'Newer' }); // edited while the first save is in flight
    fail(null);
    await inFlight;
    await q.flush('a');
    expect(sent[1].body.data).toEqual({ title: 'Newer', caption: 'Cap' });
  });

  it('does not retry a rejected save', async () => {
    const { q, sent, saved } = setup({ replies: [false] });
    q.edit('a', { title: 'x' });
    await q.flush('a');
    await vi.advanceTimersByTimeAsync(120000);
    expect(sent).toHaveLength(1);
    expect(saved).toHaveLength(0);
    expect(q.pending('a')).toBe(false);
  });

  it('flush with no id sends every queued item and passes keepalive', async () => {
    const { q, sent } = setup();
    q.edit('a', { title: 'x' });
    q.edit('b', { title: 'y' });
    expect(q.pending()).toBe(true);
    await q.flush(undefined, { keepalive: true });
    expect(sent.map(s => [s.id, s.keepalive])).toEqual([
      ['a', true],
      ['b', true],
    ]);
    await q.flush('a'); // nothing left: no request
    expect(sent).toHaveLength(2);
  });

  it('take hands back a failed field with its current value', async () => {
    const { q, local } = setup({ replies: [null] });
    local.a.text = 'first';
    q.edit('a', { text: 'first' });
    await q.flush('a');
    local.a.text = 'second';
    expect(q.take('a')).toEqual({ text: 'second' });
  });

  it('take removes queued fields so the caller can send them itself', async () => {
    const { q, sent } = setup();
    q.edit('a', { text: 'hello' });
    expect(q.take('a')).toEqual({ text: 'hello' });
    expect(q.pending('a')).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toHaveLength(0);
  });
});
