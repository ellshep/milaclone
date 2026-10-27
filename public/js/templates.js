'use strict';

import { state } from './state.js';
import { api } from './api.js';
import { toast } from './util.js';
import { reloadView } from './main.js';
import { select } from './editing.js';

// Templates (F7.6) are ordinary boards kept inside a board named "Templates" on
// Home. The Template tool asks where (the click), then which (this sheet), and
// deep-copies the pick there with /copy, so editing the copy never touches the
// template. The Templates board is made on first use.

const dlg = () => document.getElementById('templateDialog');

async function templatesBoard() {
  const home = await api.canvas(state.rootCanvasId);
  return (home.items || []).find(i => i.type === 'board' && /^templates$/i.test((i._childTitle || '').trim()));
}

// ponytail: two canvas fetches per pick; cache the holder id if this feels slow.
export async function pickTemplate(at) {
  const holder = await templatesBoard();
  if (!holder) {
    await api.create({ canvasId: state.rootCanvasId, type: 'board', x: 60, y: 60, data: { title: 'Templates' } });
    if (state.view.canvas.id === state.rootCanvasId) await reloadView();
    toast('Made a Templates board on Home — put boards in it to use them as templates');
    return;
  }
  const boards = ((await api.canvas(holder.data.childCanvasId)).items || []).filter(i => i.type === 'board');
  if (!boards.length) {
    toast('Your Templates board is empty — add a board to it first');
    return;
  }
  const list = dlg().querySelector('#templateList');
  list.replaceChildren(
    ...boards.map(b => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tpl-pick';
      btn.textContent = b._childTitle || 'Untitled board';
      btn.onclick = async () => {
        dlg().close();
        // Centred on the click, like every other tool (a board card is 152 wide).
        const pos = { x: Math.round(at.x - 76), y: Math.round(at.y - 20) };
        const copy = await api.copy(b.id, { canvasId: state.view.canvas.id, ...pos });
        if (!copy) return;
        await reloadView();
        select(copy.id);
      };
      li.appendChild(btn);
      return li;
    })
  );
  dlg().showModal();
}
