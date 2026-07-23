'use strict';

import { state, dom } from './state.js';
import { toast } from './util.js';

// Camera / pan / zoom for the infinite canvas, plus screen<->world mapping.

export function applyCam() {
  dom.world.style.transform = `translate(${state.cam.x}px, ${state.cam.y}px) scale(${state.cam.scale})`;
  dom.zoomLvl.textContent = Math.round(state.cam.scale * 100) + '%';
  saveCam();
}

export function screenToWorld(clientX, clientY) {
  const r = dom.stage.getBoundingClientRect();
  return { x: (clientX - r.left - state.cam.x) / state.cam.scale, y: (clientY - r.top - state.cam.y) / state.cam.scale };
}

export function saveCam() {
  if (state.view.canvas) localStorage.setItem('cam:' + state.view.canvas.id, JSON.stringify(state.cam));
}

export function loadCam(id) {
  try { const c = JSON.parse(localStorage.getItem('cam:' + id)); if (c && c.scale) return c; } catch (e) {}
  return { x: 80, y: 60, scale: 1 };
}

export function zoomBy(factor) {
  const r = dom.stage.getBoundingClientRect();
  const px = r.width / 2, py = r.height / 2;
  const wx = (px - state.cam.x) / state.cam.scale, wy = (py - state.cam.y) / state.cam.scale;
  state.cam.scale = Math.max(0.2, Math.min(2.5, state.cam.scale * factor));
  state.cam.x = px - wx * state.cam.scale; state.cam.y = py - wy * state.cam.scale; applyCam();
}

// Wire up the zoom controls and wheel handler. Called once at boot.
export function initViewport() {
  document.getElementById('zoomIn').onclick = () => zoomBy(1.2);
  document.getElementById('zoomOut').onclick = () => zoomBy(1 / 1.2);
  document.getElementById('zoomReset').onclick = () => { state.cam = { x: 80, y: 60, scale: 1 }; applyCam(); };
  document.getElementById('exportBtn').onclick = () => toast('Tip: your boards auto-save to the server');

  dom.stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const r = dom.stage.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      const wx = (px - state.cam.x) / state.cam.scale, wy = (py - state.cam.y) / state.cam.scale;
      const factor = Math.exp(-e.deltaY * 0.0015);
      state.cam.scale = Math.max(0.2, Math.min(2.5, state.cam.scale * factor));
      state.cam.x = px - wx * state.cam.scale; state.cam.y = py - wy * state.cam.scale;
    } else {
      state.cam.x -= e.deltaX; state.cam.y -= e.deltaY;
    }
    applyCam();
  }, { passive: false });
}
