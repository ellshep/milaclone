import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  applyCam,
  screenToWorld,
  saveCam,
  loadCam,
  zoomBy,
  zoomToFit,
  initViewport,
} from '../../public/js/viewport.js';
import { state, dom, elMap } from '../../public/js/state.js';

// jsdom has no layout: give the stage a fixed 800×600 box at (10, 20).
dom.stage.getBoundingClientRect = () => ({ left: 10, top: 20, width: 800, height: 600 });

const pointer = (type, id, x, y, target = dom.stage) => {
  const e = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true });
  Object.defineProperties(e, { pointerId: { value: id }, pointerType: { value: 'touch' } });
  target.dispatchEvent(e);
};

beforeAll(() => initViewport());
beforeEach(() => {
  state.cam = { x: 0, y: 0, scale: 1 };
  state.view.canvas = { id: 'c_test' };
  localStorage.clear();
});

describe('viewport', () => {
  it('applyCam writes the transform, zoom label and saved camera', () => {
    state.cam = { x: 5, y: 6, scale: 1.5 };
    applyCam();
    expect(dom.world.style.transform).toBe('translate(5px, 6px) scale(1.5)');
    expect(dom.zoomLvl.textContent).toBe('150%');
    expect(loadCam('c_test')).toEqual({ x: 5, y: 6, scale: 1.5 });
  });

  it('loadCam defaults when nothing or garbage is stored; saveCam skips without a canvas', () => {
    expect(loadCam('c_none')).toEqual({ x: 80, y: 60, scale: 1 });
    localStorage.setItem('cam:c_bad', '{nope');
    expect(loadCam('c_bad')).toEqual({ x: 80, y: 60, scale: 1 });
    localStorage.clear();
    state.view.canvas = null;
    saveCam();
    expect(localStorage.length).toBe(0);
  });

  it('screenToWorld undoes stage offset, pan and scale', () => {
    state.cam = { x: 100, y: 50, scale: 2 };
    expect(screenToWorld(310, 220)).toEqual({ x: 100, y: 75 });
  });

  it('zoomBy keeps the stage centre fixed and clamps the scale', () => {
    zoomBy(2);
    expect(state.cam).toEqual({ x: -400, y: -300, scale: 2 });
    zoomBy(100);
    expect(state.cam.scale).toBe(2.5);
    zoomBy(0.001);
    expect(state.cam.scale).toBe(0.2);
  });

  it('zoom buttons and reset', () => {
    document.getElementById('zoomIn').click();
    expect(state.cam.scale).toBeCloseTo(1.2);
    document.getElementById('zoomOut').click();
    expect(state.cam.scale).toBeCloseTo(1);
    document.getElementById('zoomReset').click();
    expect(state.cam).toEqual({ x: 80, y: 60, scale: 1 });
  });

  it('zoomToFit frames the free cards, never past 100%, and resets on an empty board', () => {
    const box = (w, h) =>
      Object.defineProperties(document.createElement('div'), { offsetWidth: { value: w }, offsetHeight: { value: h } });
    state.view.items = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 1500, y: 900 },
      { id: 'in', x: 9999, y: 9999, parentItemId: 'col' }, // column cards don't count
    ];
    elMap.set('a', box(100, 100)).set('b', box(100, 100)).set('in', box(100, 100));
    zoomToFit(); // 1600×1000 into 680×480 → width-bound at 0.425, centred vertically
    expect(state.cam.scale).toBeCloseTo(0.425);
    expect(state.cam.x).toBeCloseTo(60);
    expect(state.cam.y).toBeCloseTo(87.5);
    state.view.items = [{ id: 'a', x: 100, y: 100 }];
    zoomToFit(); // a lone card is centred at 100%
    expect(state.cam).toEqual({ scale: 1, x: 250, y: 150 });
    state.view.items = [];
    zoomToFit();
    expect(state.cam).toEqual({ x: 80, y: 60, scale: 1 });
    elMap.clear();
  });

  it('wheel pans; ctrl+wheel zooms around the pointer', () => {
    dom.stage.dispatchEvent(new WheelEvent('wheel', { deltaX: 10, deltaY: 20, cancelable: true }));
    expect(state.cam).toMatchObject({ x: -10, y: -20 });
    state.cam = { x: 0, y: 0, scale: 1 };
    dom.stage.dispatchEvent(
      new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, clientX: 10, clientY: 20, cancelable: true })
    );
    expect(state.cam.scale).toBeGreaterThan(1);
    expect(state.cam).toMatchObject({ x: 0, y: 0 }); // pointer at stage origin stays put
  });

  it('two-finger pinch zooms and ends when a finger lifts', () => {
    pointer('pointerdown', 1, 110, 120);
    pointer('pointermove', 1, 110, 120, document); // single finger: no pinch yet
    expect(state.pinching).toBeFalsy();
    pointer('pointerdown', 2, 210, 120);
    expect(state.pinching).toBe(true);
    pointer('pointermove', 2, 310, 120, document); // fingers twice as far apart
    expect(state.cam.scale).toBeCloseTo(2);
    pointer('pointerup', 2, 310, 120, document);
    expect(state.pinching).toBe(false);
    pointer('pointermove', 9, 0, 0, document); // unknown pointer is ignored
    pointer('pointercancel', 1, 110, 120, document);
  });

  it('ignores non-touch pointers for pinch', () => {
    const e = new MouseEvent('pointerdown', { bubbles: true });
    Object.defineProperties(e, { pointerId: { value: 7 }, pointerType: { value: 'mouse' } });
    dom.stage.dispatchEvent(e);
    expect(state.pinching).toBeFalsy();
  });
});
