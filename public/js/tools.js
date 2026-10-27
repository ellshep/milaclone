'use strict';

import { state, dom } from './state.js';
import { toast } from './util.js';
import { addFiles } from './capture.js';
import { screenToWorld, applyCam } from './viewport.js';
import { createAt, defaultsFor } from './create.js';
import { deselect, selectIds } from './editing.js';
import { elMap } from './state.js';
import { startLine } from './lines.js';
import { pickTemplate } from './templates.js';

// Toolbar arming, canvas panning + placing new cards, and file/image uploads.

export function arm(tool, btn) {
  disarm();
  state.armed = tool;
  dom.stage.classList.add('armed');
  btn.classList.add('armed');
  const hint = { line: 'Drag from a card or point to another', template: 'Tap where the copy should go' };
  toast(hint[tool] || 'Tap the canvas to place your ' + tool);
}

export function disarm() {
  state.armed = null;
  dom.stage.classList.remove('armed');
  document.querySelectorAll('.tool.armed, .mtool.armed').forEach(b => b.classList.remove('armed'));
}

// A line is boxed by its stroke, not its bounding box (a long diagonal's box is
// mostly empty canvas): screen points sampled along it, or null for a card.
function linePoints(el) {
  const ln = el instanceof SVGElement && el.querySelector('.line-stroke');
  if (!ln) return null;
  const m = ln.getScreenCTM();
  const [a, b] = [
    ['x1', 'y1'],
    ['x2', 'y2'],
  ].map(([x, y]) => new DOMPoint(+ln.getAttribute(x), +ln.getAttribute(y)).matrixTransform(m));
  return Array.from({ length: 17 }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / 16, y: a.y + ((b.y - a.y) * i) / 16 }));
}

// Selection box: every free card it touches is selected (shift adds to the
// current selection). The selection updates live while dragging. Card rects are
// measured once (nothing moves mid-box), and the stage captures the pointer so a
// release outside the window still ends the box.
function startMarquee(e) {
  const base = e.shiftKey ? [...state.selection] : [];
  if (!e.shiftKey) deselect();
  const box = document.createElement('div');
  box.className = 'marquee';
  dom.stage.appendChild(box);
  const sr = dom.stage.getBoundingClientRect();
  const cards = state.view.items
    .filter(i => !i.parentItemId && elMap.get(i.id))
    .map(i => ({ id: i.id, r: elMap.get(i.id).getBoundingClientRect(), pts: linePoints(elMap.get(i.id)) }));
  const sx = e.clientX,
    sy = e.clientY;
  let moved = false;
  let lastHit = '';
  dom.stage.setPointerCapture(e.pointerId);
  const move = ev => {
    const l = Math.min(sx, ev.clientX),
      t = Math.min(sy, ev.clientY),
      r = Math.max(sx, ev.clientX),
      b = Math.max(sy, ev.clientY);
    if (!moved && r - l < 3 && b - t < 3) return;
    moved = true;
    Object.assign(box.style, {
      left: l - sr.left + 'px',
      top: t - sr.top + 'px',
      width: r - l + 'px',
      height: b - t + 'px',
    });
    const hit = cards
      .filter(c =>
        c.pts
          ? c.pts.some(p => p.x > l && p.x < r && p.y > t && p.y < b)
          : c.r.left < r && c.r.right > l && c.r.top < b && c.r.bottom > t
      )
      .map(c => c.id);
    const key = hit.join(',');
    if (key !== lastHit) {
      lastHit = key;
      selectIds([...new Set([...base, ...hit])]);
    }
  };
  const end = () => {
    box.remove();
    dom.stage.removeEventListener('pointermove', move);
    dom.stage.removeEventListener('pointerup', end);
    dom.stage.removeEventListener('pointercancel', end);
  };
  dom.stage.addEventListener('pointermove', move);
  dom.stage.addEventListener('pointerup', end);
  dom.stage.addEventListener('pointercancel', end);
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
      if (t === 'line') return e.button === 0 && startLine(e);
      if (t === 'template') return pickTemplate(w);
      if (t === 'image') {
        state.pendingImageWorld = w;
        dom.fileInput.click();
      } else if (t === 'upload') {
        state.pendingUploadWorld = w;
        dom.uploadInput.click();
      } else createAt(t, w.x - defaultsFor(t).w / 2, w.y - 20);
      return;
    }
    // Left-drag on empty canvas draws a selection box; space-drag, middle-drag
    // and touch pan (decision D2).
    if (e.button === 0 && !state.spaceDown && e.pointerType !== 'touch') {
      startMarquee(e);
      return;
    }
    e.preventDefault(); // middle-click autoscroll
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
