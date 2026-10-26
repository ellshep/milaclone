'use strict';

import { state, dom } from './state.js';
import { toast } from './util.js';
import { addFiles } from './capture.js';
import { screenToWorld, applyCam } from './viewport.js';
import { createAt, defaultsFor } from './create.js';
import { deselect } from './editing.js';

// Toolbar arming, canvas panning + placing new cards, and file/image uploads.

export function arm(tool, btn) {
  disarm();
  state.armed = tool;
  dom.stage.classList.add('armed');
  btn.classList.add('armed');
  toast('Tap the canvas to place your ' + tool);
}

export function disarm() {
  state.armed = null;
  dom.stage.classList.remove('armed');
  document.querySelectorAll('.tool.armed, .mtool.armed').forEach(b => b.classList.remove('armed'));
}

// Wire up the rail buttons, canvas pan/place, and the upload inputs. Called once at boot.
export function initTools() {
  document.querySelectorAll('#railCreate .tool').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.tool;
      if (state.armed === t) {
        disarm();
        return;
      }
      arm(t, btn);
    });
  });

  dom.stage.addEventListener('pointerdown', e => {
    if (e.button !== 0 && e.button !== 1) return;
    if (state.pinching) return;
    if (state.armed) {
      const w = screenToWorld(e.clientX, e.clientY);
      const t = state.armed;
      disarm();
      if (t === 'image') {
        state.pendingImageWorld = w;
        dom.fileInput.click();
      } else if (t === 'upload') {
        state.pendingUploadWorld = w;
        dom.uploadInput.click();
      } else createAt(t, w.x - defaultsFor(t).w / 2, w.y - 20);
      return;
    }
    deselect();
    state.pan = { sx: e.clientX, sy: e.clientY, cx: state.cam.x, cy: state.cam.y };
    dom.stage.classList.add('panning');
    const move = ev => {
      if (state.pinching || !state.pan) return;
      state.cam.x = state.pan.cx + (ev.clientX - state.pan.sx);
      state.cam.y = state.pan.cy + (ev.clientY - state.pan.sy);
      applyCam();
    };
    const up = () => {
      state.pan = null;
      dom.stage.classList.remove('panning');
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });

  // Picked files land where the tool was clicked (several at once lay out in a grid).
  const onPicked = (input, key) =>
    input.addEventListener('change', () => {
      const files = [...input.files];
      input.value = '';
      const at = state[key] || undefined;
      state[key] = null;
      if (files.length) addFiles(files, at);
    });
  onPicked(dom.fileInput, 'pendingImageWorld');
  onPicked(dom.uploadInput, 'pendingUploadWorld');
}
