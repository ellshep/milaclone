'use strict';

import { state, dom } from './state.js';
import { api } from './api.js';
import { toast, imageSize } from './util.js';
import { screenToWorld, applyCam } from './viewport.js';
import { createAt, defaultsFor } from './create.js';
import { select, deselect } from './editing.js';
import { render } from './cards.js';

// Toolbar arming, canvas panning + placing new cards, and file/image uploads.

export function arm(tool, btn) {
  disarm();
  state.armed = tool; dom.stage.classList.add('armed');
  btn.classList.add('armed');
  toast('Click the canvas to place your ' + tool);
}

export function disarm() {
  state.armed = null; dom.stage.classList.remove('armed');
  document.querySelectorAll('.tool.armed').forEach(b => b.classList.remove('armed'));
}

// Wire up the rail buttons, canvas pan/place, and the upload inputs. Called once at boot.
export function initTools() {
  document.querySelectorAll('.tool').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.tool;
      if (state.armed === t) { disarm(); return; }
      arm(t, btn);
    });
  });

  dom.stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    if (state.armed) {
      const w = screenToWorld(e.clientX, e.clientY);
      const t = state.armed; disarm();
      if (t === 'image') { state.pendingImageWorld = w; dom.fileInput.click(); }
      else if (t === 'upload') { state.pendingUploadWorld = w; dom.uploadInput.click(); }
      else createAt(t, w.x - defaultsFor(t).w / 2, w.y - 20);
      return;
    }
    deselect();
    state.pan = { sx: e.clientX, sy: e.clientY, cx: state.cam.x, cy: state.cam.y };
    dom.stage.classList.add('panning');
    const move = (ev) => { state.cam.x = state.pan.cx + (ev.clientX - state.pan.sx); state.cam.y = state.pan.cy + (ev.clientY - state.pan.sy); applyCam(); };
    const up = () => { state.pan = null; dom.stage.classList.remove('panning'); document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });

  dom.fileInput.addEventListener('change', async () => {
    const file = dom.fileInput.files[0]; dom.fileInput.value = '';
    if (!file) return;
    toast('Uploading image…');
    const res = await api.upload(file);
    if (res.error) { toast('Upload failed'); return; }
    const dim = await imageSize(res.src);
    const w = state.pendingImageWorld || screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
    const it = await api.create({
      canvasId: state.view.canvas.id, type: 'image',
      x: Math.round(w.x - 130), y: Math.round(w.y - 90), w: 260,
      data: { src: res.src, name: res.name, naturalW: dim.w, naturalH: dim.h }
    });
    state.view.items.push(it); render(); select(it.id); toast('Image added');
    state.pendingImageWorld = null;
  });

  dom.uploadInput.addEventListener('change', async () => {
    const file = dom.uploadInput.files[0]; dom.uploadInput.value = '';
    if (!file) return;
    toast('Uploading file…');
    const res = await api.upload(file);
    if (res.error) { toast('Upload failed'); return; }
    const w = state.pendingUploadWorld || screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
    const it = await api.create({
      canvasId: state.view.canvas.id, type: 'file',
      x: Math.round(w.x - 110), y: Math.round(w.y - 40), w: 220,
      data: { src: res.src, name: res.name, mime: res.mime || file.type }
    });
    state.view.items.push(it); render(); select(it.id); toast('File added');
    state.pendingUploadWorld = null;
  });
}
