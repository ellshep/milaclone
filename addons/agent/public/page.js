// The agent page's client (src/page.js serves it). The board is framed from
// the site root, so it shares this page's origin and posts its selection here.

const $ = id => document.getElementById(id);
const boardId = new URLSearchParams(location.search).get('board');
let agents = [];
let selection = [];
let thread = null;
const queue = []; // { ids, text, status }: status is queued, seen, working, done or failed

async function api(path, body) {
  const init = body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : {};
  const r = await fetch('api/' + path, init);
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || r.statusText);
  return out;
}

const agent = () => agents.find(a => a.id === $('agent').value);

function button(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function message(role, text) {
  const li = document.createElement('li');
  li.className = role;
  const p = document.createElement('p');
  p.textContent = text;
  li.append(p);
  if (role === 'assistant') {
    const pin = button('Pin to board', async () => {
      pin.disabled = true;
      try {
        await api('pin', { agent: agent().id, text });
        pin.textContent = 'Pinned';
      } catch (e) {
        pin.disabled = false;
        pin.textContent = `Pin failed (${e.message}): retry`;
      }
    });
    li.append(pin);
  }
  $('messages').append(li);
  li.scrollIntoView({ block: 'end' });
}

function renderQueue() {
  $('queue').replaceChildren(
    ...queue.map(n => {
      const li = document.createElement('li');
      const what = document.createElement('span');
      what.textContent = (n.ids.length ? `${n.ids.length} card${n.ids.length > 1 ? 's' : ''}: ` : '') + n.text;
      const receipt = document.createElement('span');
      receipt.className = 'receipt';
      receipt.textContent = n.status;
      li.append(what, receipt);
      return li;
    })
  );
}

function setStatus(batch, status) {
  for (const n of batch) n.status = status;
  renderQueue();
}

// Sent notes stay in the list with their receipts until the next note is queued.
function addNote() {
  const text = $('text').value.trim();
  if (!text) return;
  for (let i = queue.length - 1; i >= 0; i--) if (['done', 'failed'].includes(queue[i].status)) queue.splice(i, 1);
  queue.push({ ids: [...selection], text, status: 'queued' });
  $('text').value = '';
  renderQueue();
}

async function follow(id, batch) {
  for (;;) {
    await new Promise(r => setTimeout(r, 1000));
    let r;
    try {
      r = await api('requests/' + encodeURIComponent(id));
    } catch {
      continue; // the service restarting; keep asking
    }
    setStatus(batch, r.status);
    if (r.status === 'done') return message('assistant', r.reply);
    if (r.status === 'failed') return message('error', r.error);
  }
}

async function send(e) {
  e.preventDefault();
  addNote();
  const batch = queue.filter(n => n.status === 'queued');
  if (!batch.length || !agent()) return;
  setStatus(batch, 'sending');
  try {
    const r = await api('requests', {
      agent: agent().id,
      thread,
      notes: batch.map(({ ids, text }) => ({ ids, text })),
    });
    setStatus(batch, r.status);
    message('user', r.request);
    if (r.thread !== thread) {
      thread = r.thread;
      loadThreads();
    }
    await follow(r.id, batch);
  } catch (err) {
    setStatus(batch, 'failed');
    message('error', err.message);
  }
}

async function loadThreads() {
  const a = agent();
  const kept = !!a && a.memory !== 'ephemeral';
  $('threads').hidden = $('new-thread').hidden = !kept;
  if (!kept) return;
  const list = await api('threads?agent=' + encodeURIComponent(a.id));
  $('threads').replaceChildren(
    ...list.map(t => {
      const b = button(t.title, () => openThread(t.id));
      b.title = t.title;
      b.setAttribute('aria-current', String(t.id === thread));
      return b;
    })
  );
}

async function openThread(id) {
  const t = await api('threads/' + encodeURIComponent(id));
  thread = t.id;
  $('messages').replaceChildren();
  for (const m of t.messages) message(m.role, m.text);
  loadThreads();
}

function newThread() {
  thread = null;
  $('messages').replaceChildren();
  loadThreads();
}

window.addEventListener('message', e => {
  if (e.origin !== location.origin || e.source !== $('board').contentWindow) return;
  if (!e.data || e.data.type !== 'milaclone:selection' || !Array.isArray(e.data.ids)) return;
  selection = e.data.ids.map(String);
  const n = selection.length;
  $('selection').textContent = n ? `${n} card${n > 1 ? 's' : ''} selected` : 'No cards selected';
});

async function start() {
  if (!boardId) {
    $('chat').textContent = 'Open this page from a link card on a board: /agent/?board=<board id>.';
    return;
  }
  $('board').src = '/#' + encodeURIComponent(boardId);
  agents = await api('agents?board=' + encodeURIComponent(boardId));
  if (!agents.length) {
    $('selection').textContent = 'No agent card on this board (or the board is closed to agents).';
    $('ask').hidden = true;
  }
  $('agent').replaceChildren(
    ...agents.map(a => {
      const o = document.createElement('option');
      o.value = a.id;
      o.textContent = a.name;
      return o;
    })
  );
  $('agent').addEventListener('change', newThread);
  $('new-thread').addEventListener('click', newThread);
  $('queue-note').addEventListener('click', addNote);
  $('ask').addEventListener('submit', send);
  loadThreads();
}

start().catch(e => message('error', e.message));
