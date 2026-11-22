import { describe, it, expect, beforeEach } from 'vitest';
import { buildAgent, agentDefaults, agentText, MODELS, PROVIDERS } from '../../public/js/agentcard.js';

// cards.js makeField, in miniature: an inert text field until the card is in edit mode.
const field = (tag, cls, value, placeholder) => {
  const f = document.createElement(tag === 'area' ? 'textarea' : 'input');
  f.className = cls;
  f.value = value || '';
  f.placeholder = placeholder || '';
  f.setAttribute('data-edit', '');
  f.readOnly = true;
  return f;
};

let el, card, saves;
const build = data => {
  el = document.createElement('div');
  card = { id: 'i_a1', type: 'agent', data: Object.assign(agentDefaults(), data) };
  saves = [];
  buildAgent(el, card, { field, save: p => saves.push(p) });
};
const fire = (node, type) => node.dispatchEvent(new Event(type, { bubbles: true }));
const q = sel => el.querySelector(sel);

beforeEach(() => build({}));

describe('agent card', () => {
  it('renders every field from the data and fills in defaults', () => {
    build({ name: 'Clock bot', persona: 'Finds parts', provider: 'openai', model: 'x-1', writes: 'direct' });
    expect(q('.ag-name').value).toBe('Clock bot');
    expect(q('.ag-persona').value).toBe('Finds parts');
    expect(q('.ag-provider').value).toBe('openai');
    expect(q('.ag-model').value).toBe('x-1');
    expect(q('.ag-writes').value).toBe('direct');
    expect(q('.ag-memory').value).toBe('thread'); // a default the data lacked
    expect(q('.ag-scope').value).toBe('board');
    expect(q('.ag-create').checked).toBe(false);
    expect(q('.ag-provider').options.length).toBe(PROVIDERS.length);
  });

  it('saves each edit with the plain text kept in step', () => {
    q('.ag-name').value = 'Mila';
    fire(q('.ag-name'), 'input');
    q('.ag-persona').value = 'Keeps the board tidy';
    fire(q('.ag-persona'), 'input');
    q('.ag-notes').value = 'Office clock, v2';
    fire(q('.ag-notes'), 'input');
    expect(saves).toEqual([
      { name: 'Mila', text: 'Mila' },
      { persona: 'Keeps the board tidy', text: 'Mila\nKeeps the board tidy' },
      { boardNotes: 'Office clock, v2', text: 'Mila\nKeeps the board tidy' },
    ]);
    expect(card.data.boardNotes).toBe('Office clock, v2');
    for (const [cls, key, value] of [
      ['.ag-writes', 'writes', 'chat'],
      ['.ag-memory', 'memory', 'persistent'],
      ['.ag-effort', 'effort', 'high'],
    ]) {
      q(cls).value = value;
      fire(q(cls), 'change');
      expect(saves.at(-1)).toEqual({ [key]: value, text: 'Mila\nKeeps the board tidy' });
    }
    q('.ag-create').checked = true;
    fire(q('.ag-create'), 'change');
    expect(saves.at(-1).createBoards).toBe(true);
    q('.ag-model').value = 'claude-sonnet-5-5';
    fire(q('.ag-model'), 'input');
    expect(card.data.model).toBe('claude-sonnet-5-5');
  });

  it('shows effort and model suggestions only where they apply, and swaps the model with the provider', () => {
    expect(q('.ag-effort-row').hidden).toBe(false);
    expect([...q('datalist').options].map(o => o.value)).toEqual(MODELS.anthropic);
    q('.ag-provider').value = 'local';
    fire(q('.ag-provider'), 'change');
    expect(q('.ag-effort-row').hidden).toBe(true);
    expect(q('datalist').options.length).toBe(0);
    expect(card.data.model).toBe(''); // an Anthropic id doesn't follow to a local server
    expect(saves.map(p => Object.keys(p)[0])).toEqual(['provider', 'model']);
    q('.ag-model').value = 'llama';
    fire(q('.ag-model'), 'input');
    q('.ag-provider').value = 'anthropic';
    fire(q('.ag-provider'), 'change');
    expect(card.data.model).toBe(MODELS.anthropic[0]);
    expect(q('.ag-effort-row').hidden).toBe(false);
  });

  it('shows the board list only for the wider scope', () => {
    expect(q('.ag-boards-row').hidden).toBe(true);
    q('.ag-scope').value = 'boards';
    fire(q('.ag-scope'), 'change');
    expect(q('.ag-boards-row').hidden).toBe(false);
    q('.ag-boards').value = 'Mini camera\nOffice clock';
    fire(q('.ag-boards'), 'input');
    expect(card.data.scopeBoards).toBe('Mini camera\nOffice clock');
    build({ scope: 'boards' });
    expect(q('.ag-boards-row').hidden).toBe(false);
  });

  it('copes with a provider the lists do not know', () => {
    build({ provider: 'weird', model: 'm' });
    expect(q('datalist').options.length).toBe(0);
    expect(q('.ag-effort-row').hidden).toBe(true);
    expect(q('.ag-model').value).toBe('m');
  });

  it('text fields stay inert until edit mode; dropdowns never start a drag', () => {
    expect(q('.ag-name').hasAttribute('data-edit')).toBe(true);
    expect(q('.ag-persona').readOnly).toBe(true);
    expect(q('.ag-provider').hasAttribute('data-nodrag')).toBe(true);
    expect(q('.ag-create').hasAttribute('data-nodrag')).toBe(true);
  });

  it('agentText joins name and persona, skipping blanks', () => {
    expect(agentText({ name: ' A ', persona: '' })).toBe('A');
    expect(agentText({})).toBe('');
    expect(agentText({ name: 'A', persona: 'B' })).toBe('A\nB');
  });
});
