'use strict';

import { lucideEl, autoGrow } from './util.js';

// The agent card (docs/agent-addon.md A4–A8): a form that configures the agent
// living on this board. Core only stores it; the agent add-on reads it through
// the API. Name and persona are mirrored into data.text so search finds the card
// and Markdown export needs no per-type code. Text fields follow the usual
// card rule (inert until the card is in edit mode); the dropdowns and the
// checkbox are live all the time, like a table card's bar.

export const PROVIDERS = [
  ['anthropic', 'Anthropic'],
  ['openai', 'OpenAI'],
  ['gemini', 'Gemini'],
  ['local', 'Local (OpenAI-compatible)'],
];
// Suggestions only: the model field takes any id. Effort is an Anthropic setting.
export const MODELS = {
  anthropic: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  openai: [],
  gemini: [],
  local: [],
};
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const SCOPES = [
  ['board', 'This board'],
  ['boards', 'Also listed boards'],
];
const WRITES = [
  ['chat', 'Chat only'],
  ['propose', 'Propose'],
  ['direct', 'Direct'],
];
const MEMORIES = [
  ['ephemeral', 'Ephemeral'],
  ['thread', 'Per thread'],
  ['persistent', 'Persistent'],
];

export function agentDefaults() {
  return {
    name: '',
    persona: '',
    boardNotes: '',
    provider: 'anthropic',
    model: MODELS.anthropic[0],
    effort: 'medium',
    scope: 'board',
    scopeBoards: '',
    createBoards: false,
    writes: 'propose',
    memory: 'thread',
    text: '',
  };
}

export const agentText = d =>
  [d.name, d.persona]
    .map(s => String(s || '').trim())
    .filter(Boolean)
    .join('\n');

// `field(tag, cls, value, placeholder)` is cards.js makeField (an inert text field
// until edit mode); `save(patch)` is what the card saves through.
export function buildAgent(el, it, { field, save }) {
  el.classList.add('agent');
  const d = Object.assign(agentDefaults(), it.data);
  it.data = d;
  const set = patch => {
    Object.assign(d, patch);
    save(Object.assign({}, patch, { text: agentText(d) }));
  };

  const head = document.createElement('div');
  head.className = 'ag-head';
  head.appendChild(lucideEl('bot'));
  const name = field('input', 'ag-name', d.name, 'Agent name');
  name.addEventListener('input', () => set({ name: name.value }));
  head.appendChild(name);
  el.appendChild(head);

  const form = document.createElement('div');
  form.className = 'ag-form';
  el.appendChild(form);
  const row = (label, control, cls = '') => {
    const r = document.createElement('label');
    r.className = 'ag-row ' + cls;
    const l = document.createElement('span');
    l.textContent = label;
    r.append(l, control);
    form.appendChild(r);
    return r;
  };
  const area = (cls, value, placeholder, key) => {
    const t = field('area', cls, value, placeholder);
    t.addEventListener('input', () => set({ [key]: t.value }));
    return t;
  };
  const choice = (key, options, cls) => {
    const s = document.createElement('select');
    s.className = cls;
    s.setAttribute('data-nodrag', '');
    for (const [v, label] of options) s.appendChild(new Option(label, v, false, d[key] === v));
    s.addEventListener('change', () => set({ [key]: s.value }));
    return s;
  };

  row('Who it is', area('ag-persona', d.persona, 'Persona: who this agent is and how it works', 'persona'));
  row('This board', area('ag-notes', d.boardNotes, 'What this board is about and where it stands', 'boardNotes'));

  const provider = choice('provider', PROVIDERS, 'ag-provider');
  row('Provider', provider);
  const model = field('input', 'ag-model', d.model, 'model id');
  const list = document.createElement('datalist');
  list.id = 'ag-models-' + it.id;
  model.setAttribute('list', list.id);
  model.addEventListener('input', () => set({ model: model.value }));
  const modelRow = row('Model', model);
  modelRow.appendChild(list);
  const effortRow = row(
    'Effort',
    choice(
      'effort',
      EFFORTS.map(e => [e, e]),
      'ag-effort'
    ),
    'ag-effort-row'
  );
  const syncProvider = () => {
    list.replaceChildren(...(MODELS[d.provider] || []).map(m => new Option(m)));
    effortRow.hidden = d.provider !== 'anthropic';
  };
  provider.addEventListener('change', () => {
    // A model id belongs to one provider: the new provider's first suggestion, or blank.
    model.value = (MODELS[d.provider] || [])[0] || '';
    set({ model: model.value });
    syncProvider();
  });
  syncProvider();

  const scope = choice('scope', SCOPES, 'ag-scope');
  row('Reads', scope);
  const boards = area('ag-boards', d.scopeBoards, 'One board title per line', 'scopeBoards');
  const boardsRow = row('Boards', boards, 'ag-boards-row');
  const syncScope = () => (boardsRow.hidden = d.scope !== 'boards');
  scope.addEventListener('change', syncScope);
  syncScope();

  const create = document.createElement('input');
  create.type = 'checkbox';
  create.className = 'ag-create';
  create.checked = !!d.createBoards;
  create.setAttribute('data-nodrag', '');
  create.addEventListener('change', () => set({ createBoards: create.checked }));
  row('May create boards', create, 'ag-check');

  row('Writes', choice('writes', WRITES, 'ag-writes')).title =
    'Chat only: never touches the board. Propose: cards land in a column to accept from. Direct: writes at once.';
  row('Memory', choice('memory', MEMORIES, 'ag-memory')).title =
    'Ephemeral: forgets each chat. Per thread: keeps each conversation. Persistent: also keeps a memory card on the board.';
  // The card is built before it joins the DOM, where a textarea has no scroll height yet.
  requestAnimationFrame(() => el.querySelectorAll('textarea').forEach(autoGrow));
}
