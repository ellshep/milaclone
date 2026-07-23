'use strict';

/* =========================================================================
   Shared constants, DOM references, and mutable application state.

   ES module bindings can't be reassigned by importing modules, so anything
   that gets reassigned at runtime (the current view, camera, selection, …)
   lives as a field on the exported `state` object. Collections that are only
   mutated in place (never reassigned) are exported directly.
   ========================================================================= */

export const COLORS = ['slate','gray','teal','green','brown','yellow','orange','red','pink','purple','blue','indigo'];

export const BOARD_ICONS = [
  'layout-grid', 'book-open', 'monitor', 'clock', 'heart', 'house', 'lightbulb',
  'palette', 'briefcase', 'sparkles', 'glasses', 'landmark', 'compass', 'camera',
  'music', 'pen-tool', 'layers', 'folder', 'star', 'zap', 'globe', 'cpu', 'leaf', 'target'
];

// Mutable app state, shared live across every module.
export const state = {
  rootCanvasId: null,
  view: { canvas: null, items: [], breadcrumb: [] },
  cam: { x: 80, y: 60, scale: 1 },
  armed: null,
  selectedId: null,
  editingId: null,
  clipboard: null,
  pendingImageWorld: null,
  pendingUploadWorld: null,
  drag: null,
  pan: null
};

// Item id -> rendered DOM element. Cleared/repopulated on every render.
export const elMap = new Map();

// Cached DOM references (module scripts run after the document is parsed).
export const dom = {
  stage: document.getElementById('stage'),
  world: document.getElementById('world'),
  crumbs: document.getElementById('crumbs'),
  hint: document.getElementById('hint'),
  palette: document.getElementById('palette'),
  ctxmenu: document.getElementById('ctxmenu'),
  fileInput: document.getElementById('fileInput'),
  uploadInput: document.getElementById('uploadInput'),
  zoomLvl: document.getElementById('zoomLvl'),
  toastEl: document.getElementById('toast')
};
