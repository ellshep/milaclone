'use strict';

import { state, dom, elMap } from './state.js';

// Camera / pan / zoom for the infinite canvas, plus screen<->world mapping.

export function applyCam() {
  dom.world.style.transform = `translate(${state.cam.x}px, ${state.cam.y}px) scale(${state.cam.scale})`;
  dom.zoomLvl.textContent = Math.round(state.cam.scale * 100) + '%';
  saveCam();
}

export function screenToWorld(clientX, clientY) {
  const r = dom.stage.getBoundingClientRect();
  return {
    x: (clientX - r.left - state.cam.x) / state.cam.scale,
    y: (clientY - r.top - state.cam.y) / state.cam.scale,
  };
}

export function saveCam() {
  if (state.view.canvas) localStorage.setItem('cam:' + state.view.canvas.id, JSON.stringify(state.cam));
}

export function loadCam(id) {
  try {
    const c = JSON.parse(localStorage.getItem('cam:' + id));
    if (c && c.scale) return c;
  } catch {}
  return { x: 80, y: 60, scale: 1 };
}

export function zoomBy(factor) {
  const r = dom.stage.getBoundingClientRect();
  const px = r.width / 2,
    py = r.height / 2;
  const wx = (px - state.cam.x) / state.cam.scale,
    wy = (py - state.cam.y) / state.cam.scale;
  state.cam.scale = Math.max(0.2, Math.min(2.5, state.cam.scale * factor));
  state.cam.x = px - wx * state.cam.scale;
  state.cam.y = py - wy * state.cam.scale;
  applyCam();
}

export function resetZoom() {
  state.cam = { x: 80, y: 60, scale: 1 };
  applyCam();
}

// Frames every free card on the board (never magnifying past 100%).
export function zoomToFit() {
  const boxes = state.view.items
    .filter(i => !i.parentItemId && elMap.get(i.id))
    .map(i => {
      const el = elMap.get(i.id);
      return [i.x, i.y, i.x + el.offsetWidth, i.y + el.offsetHeight];
    });
  if (!boxes.length) return resetZoom();
  const l = Math.min(...boxes.map(b => b[0])),
    t = Math.min(...boxes.map(b => b[1])),
    w = Math.max(...boxes.map(b => b[2])) - l,
    h = Math.max(...boxes.map(b => b[3])) - t;
  const r = dom.stage.getBoundingClientRect();
  const pad = 60;
  const scale = Math.max(0.2, Math.min(1, (r.width - 2 * pad) / w, (r.height - 2 * pad) / h));
  state.cam = { scale, x: (r.width - w * scale) / 2 - l * scale, y: (r.height - h * scale) / 2 - t * scale };
  applyCam();
}

// Two-finger pinch zoom for touch screens. Keeps the world point under the
// initial pinch midpoint anchored to the moving midpoint, so it also pans.
function initPinch() {
  const pts = new Map();
  let start = null;
  dom.stage.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch') return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) {
      state.pinching = true;
      state.pan = null;
      dom.stage.classList.remove('panning');
      const [a, b] = [...pts.values()];
      start = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        cx: (a.x + b.x) / 2,
        cy: (a.y + b.y) / 2,
        cam: { ...state.cam },
      };
    }
  });
  document.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!state.pinching || pts.size !== 2 || !start) return;
    const [a, b] = [...pts.values()];
    const r = dom.stage.getBoundingClientRect();
    const scale = Math.max(0.2, Math.min(2.5, start.cam.scale * (Math.hypot(a.x - b.x, a.y - b.y) / start.dist)));
    const wx = (start.cx - r.left - start.cam.x) / start.cam.scale;
    const wy = (start.cy - r.top - start.cam.y) / start.cam.scale;
    state.cam.scale = scale;
    state.cam.x = (a.x + b.x) / 2 - r.left - wx * scale;
    state.cam.y = (a.y + b.y) / 2 - r.top - wy * scale;
    applyCam();
  });
  const drop = e => {
    pts.delete(e.pointerId);
    if (pts.size < 2) {
      state.pinching = false;
      start = null;
    }
  };
  document.addEventListener('pointerup', drop);
  document.addEventListener('pointercancel', drop);
}

// Wire up the zoom controls and wheel handler. Called once at boot.
export function initViewport() {
  document.getElementById('zoomIn').onclick = () => zoomBy(1.2);
  document.getElementById('zoomOut').onclick = () => zoomBy(1 / 1.2);
  document.getElementById('zoomReset').onclick = resetZoom;

  dom.stage.addEventListener(
    'wheel',
    e => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = dom.stage.getBoundingClientRect();
        const px = e.clientX - r.left,
          py = e.clientY - r.top;
        const wx = (px - state.cam.x) / state.cam.scale,
          wy = (py - state.cam.y) / state.cam.scale;
        const factor = Math.exp(-e.deltaY * 0.0015);
        state.cam.scale = Math.max(0.2, Math.min(2.5, state.cam.scale * factor));
        state.cam.x = px - wx * state.cam.scale;
        state.cam.y = py - wy * state.cam.scale;
      } else {
        state.cam.x -= e.deltaX;
        state.cam.y -= e.deltaY;
      }
      applyCam();
    },
    { passive: false }
  );

  initPinch();
}
