'use strict';

import { state } from './state.js';
import { toast } from './util.js';
import { applyCam, zoomBy } from './viewport.js';
import { arm, disarm } from './tools.js';
import { openCanvas } from './main.js';
import { openQuickNotes } from './quicknotes.js';
import { openTrash } from './trash.js';
import { openSearch } from './search.js';
import { boardMarkdownUrl, download } from './export.js';

// Mobile chrome: the header (back / title / share) and footer (tabs, more
// menu, and the swap-in tool tray). The elements exist on every viewport but
// are only shown by the mobile media query in style.css, so all of this can
// be wired unconditionally.

const el = id => document.getElementById(id);

// Called after every canvas load: the header only appears inside sub-boards,
// the root board keeps the full-bleed canvas like Milanote's home screen.
export function updateMobileChrome() {
  const bc = state.view.breadcrumb || [];
  const header = el('mheader');
  header.hidden = bc.length <= 1;
  if (!header.hidden) el('mTitle').textContent = (state.view.canvas && state.view.canvas.title) || 'Untitled board';
}

export function initMobile() {
  const nav = el('mfNav'),
    tray = el('mfTray'),
    tools = el('mfTools'),
    sheet = el('msheet');

  // The tray mirrors the desktop rail: clone its buttons so the icon set and
  // data-tool wiring stay defined in one place. They get their own class so
  // desktop-only selectors keep matching a single element per tool.
  document.querySelectorAll('#railCreate .tool').forEach(btn => {
    const c = btn.cloneNode(true);
    c.classList.remove('tool');
    c.classList.add('mtool');
    c.addEventListener('click', () => {
      const t = c.dataset.tool;
      if (state.armed === t) {
        disarm();
        return;
      }
      arm(t, c);
    });
    tools.appendChild(c);
  });

  el('mAdd').onclick = () => {
    nav.hidden = true;
    tray.hidden = false;
  };
  el('mTrayClose').onclick = () => {
    disarm();
    tray.hidden = true;
    // Board selection chrome may own the footer; only restore the tab bar when idle.
    if (!el('mfBoard') || el('mfBoard').hidden) nav.hidden = false;
  };

  el('mBoards').onclick = () => {
    if (state.rootCanvasId) openCanvas(state.rootCanvasId);
  };
  el('mNotes').onclick = () => openQuickNotes();

  el('mBack').onclick = () => {
    const bc = state.view.breadcrumb;
    if (bc.length > 1) openCanvas(bc[bc.length - 2].id);
  };
  el('mShare').onclick = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      toast('Board link copied');
    } catch {
      toast('Copy this page URL to share');
    }
  };

  el('mMore').onclick = () => {
    sheet.hidden = !sheet.hidden;
  };
  sheet.addEventListener('click', e => {
    const act = e.target.closest('[data-act]');
    if (!act) return;
    if (act.dataset.act === 'zoomin') zoomBy(1.2);
    if (act.dataset.act === 'zoomout') zoomBy(1 / 1.2);
    if (act.dataset.act === 'reset') {
      state.cam = { x: 80, y: 60, scale: 1 };
      applyCam();
    }
    if (act.dataset.act === 'export') download(boardMarkdownUrl());
    if (act.dataset.act === 'backup') download('/api/backup');
    if (act.dataset.act === 'search') openSearch();
    if (act.dataset.act === 'trash') openTrash();
    sheet.hidden = true;
  });
  document.addEventListener(
    'pointerdown',
    e => {
      if (!sheet.hidden && !e.target.closest('#msheet') && !e.target.closest('#mMore')) sheet.hidden = true;
    },
    true
  );

  // Safari still fires gesture* events for page pinch-zoom even with the
  // viewport meta; kill them so only our canvas camera zooms.
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, e => e.preventDefault(), { passive: false });
  }
  pinChromeToVisualViewport();
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', pinChromeToVisualViewport);
    window.visualViewport.addEventListener('scroll', pinChromeToVisualViewport);
  }
  window.addEventListener('resize', pinChromeToVisualViewport);
}

// Keep header/footer glued to the *visible* screen if the browser zooms or
// shifts the visual viewport. Canvas zoom only transforms #world and never
// reaches these nodes.
function pinChromeToVisualViewport() {
  const vv = window.visualViewport;
  const footer = el('mfooter');
  const header = el('mheader');
  const sheet = el('msheet');
  if (!vv || !footer) return;

  const scale = vv.scale || 1;
  const idle = scale === 1 && vv.offsetTop === 0 && vv.offsetLeft === 0;
  const nodes = [footer, header, sheet];

  if (idle) {
    for (const node of nodes) {
      if (!node) continue;
      node.style.left = '';
      node.style.right = '';
      node.style.top = '';
      node.style.bottom = '';
      node.style.width = '';
      node.style.transform = '';
      node.style.transformOrigin = '';
    }
    return;
  }

  // Counter browser pinch-zoom: keep chrome screen-sized and glued to the
  // visible viewport edges (canvas zoom only transforms #world).
  const inv = 1 / scale;
  const tx = vv.offsetLeft;
  const tyTop = vv.offsetTop;
  const tyBottom = vv.offsetTop + vv.height - window.innerHeight;

  footer.style.left = '0';
  footer.style.right = 'auto';
  footer.style.width = window.innerWidth + 'px';
  footer.style.bottom = '0';
  footer.style.top = 'auto';
  footer.style.transformOrigin = 'left bottom';
  footer.style.transform = 'translate(' + tx + 'px, ' + tyBottom + 'px) scale(' + inv + ')';

  if (header) {
    header.style.left = '0';
    header.style.right = 'auto';
    header.style.width = window.innerWidth + 'px';
    header.style.top = '0';
    header.style.bottom = 'auto';
    header.style.transformOrigin = 'left top';
    header.style.transform = 'translate(' + tx + 'px, ' + tyTop + 'px) scale(' + inv + ')';
  }

  if (sheet) {
    sheet.style.transformOrigin = 'left bottom';
    sheet.style.transform = 'translate(' + tx + 'px, ' + tyBottom + 'px) scale(' + inv + ')';
  }
}
