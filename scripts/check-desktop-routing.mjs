import {test} from 'node:test';
import assert from 'node:assert/strict';
import {OrthographicCamera, Vector3} from '../dist/assets/three.module.js';
import {DesktopNavigator, desktopBounds, routeBetween, contains} from '../dist/desktop-routing.js';

const screen = (x, y, width, height, scale = 1) => ({
  frame: {x, y, width, height}, workArea: {x, y: y + 28, width, height: height - 28}, scale,
});

test('mixed scale displays use logical coordinates and a shared-edge route', () => {
  const screens = [screen(0, 0, 1440, 900, 2), screen(1440, -180, 1920, 1080, 1)];
  assert.deepEqual(desktopBounds(screens), {x: 0, y: -180, width: 3360, height: 1080});
  const path = routeBetween(screens, {x: 400, y: 600}, {x: 2900, y: -20});
  assert.equal(path[0].x, 1280);
  assert.equal(path[1].x, 1600);
  assert.equal(path[0].y, path[1].y);
  assert.equal(path[0].y, 450);
  let previous = {x: 400, y: 600};
  for (const point of path) {
    for (let i = 0; i <= 100; i++) {
      const p = {x: previous.x + (point.x - previous.x) * i / 100, y: previous.y + (point.y - previous.y) * i / 100};
      assert(screens.some(display => contains(display.frame, p)), 'Route entered an invisible display notch');
    }
    previous = point;
  }
});

test('vertical and negative-origin displays route through their actual shared edge', () => {
  const screens = [screen(0, 0, 1440, 900, 2), screen(-300, -1080, 1920, 1080)];
  const path = routeBetween(screens, {x: 700, y: 500}, {x: 600, y: -600});
  assert.equal(path[0].y, 160);
  assert.equal(path[1].y, -160);
  assert.equal(path[0].x, path[1].x);
});

test('roaming automatically targets the other reachable display', () => {
  const screens = [screen(0, 0, 1440, 900), screen(-1920, 0, 1920, 1080, 2)];
  const navigator = new DesktopNavigator(screens, false, () => .5);
  navigator.step({x: 700, y: 450}, 'roam', null, 1.5);
  assert(contains(screens[1].frame, navigator.target));
  assert(navigator.points.some(point => point.x < 0));
});

test('follow reroutes when the pointer changes displays; observe stops navigation', () => {
  const screens = [screen(0, 0, 1440, 900), screen(1440, 0, 1920, 1080)];
  const navigator = new DesktopNavigator(screens);
  navigator.step({x: 700, y: 400}, 'follow', {x: 2300, y: 500}, 1.5);
  assert(contains(screens[1].frame, navigator.target));
  navigator.step({x: 800, y: 400}, 'follow', {x: 300, y: 500}, 1.5);
  assert(contains(screens[0].frame, navigator.target));
  assert.equal(navigator.step({x: 800, y: 400}, 'observe', null, 1.5), null);
});

test('disconnected displays never produce a path through an invisible gap', () => {
  const screens = [screen(0, 0, 1440, 900), screen(1600, 0, 1920, 1080)];
  assert.equal(routeBetween(screens, {x: 600, y: 400}, {x: 2300, y: 500}), null);
});

test('unplugging the destination leaves a valid route on the remaining display', () => {
  const navigator = new DesktopNavigator([screen(0, 0, 1440, 900)], false, () => .5);
  const goal = navigator.step({x: 2000, y: 500}, 'roam', null, 1.5);
  assert(contains(navigator.screens[0].frame, goal));
});

test('cropping preserves global pixel positions and restores the simulation camera', () => {
  const width = 3360, height = 1080;
  const camera = new OrthographicCamera(-width / 2, width / 2, height / 2, -height / 2, .1, 4000);
  camera.position.set(0, 1600, 420);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const original = camera.projectionMatrix.toArray();
  const world = new Vector3(800, 0, 200);
  const full = world.clone().project(camera);
  const x = (full.x + 1) * width / 2, y = (1 - full.y) * height / 2;
  const crop = {x: 1700, y: 200, width: 1024, height: 800};
  camera.setViewOffset(width, height, crop.x, crop.y, crop.width, crop.height);
  const clipped = world.clone().project(camera);
  assert(Math.abs(crop.x + (clipped.x + 1) * crop.width / 2 - x) < 1e-8);
  assert(Math.abs(crop.y + (1 - clipped.y) * crop.height / 2 - y) < 1e-8);
  camera.clearViewOffset();
  assert.deepEqual(camera.projectionMatrix.toArray(), original);
});

test('unreachable follow fallback respects wholeScreen and stays out of the taskbar', () => {
  const primary = {
    frame: {x: 0, y: 0, width: 1920, height: 1080},
    workArea: {x: 0, y: 0, width: 1840, height: 1080}, // 80px right taskbar
    scale: 1,
  };
  const cornerTouching = {
    frame: {x: 1920, y: 1080, width: 1920, height: 1080},
    workArea: {x: 1920, y: 1080, width: 1920, height: 1040},
    scale: 1,
  };
  const screens = [primary, cornerTouching];
  assert.equal(routeBetween(screens, {x: 800, y: 700}, {x: 2200, y: 1200}), null);

  const workOnly = new DesktopNavigator(screens, false);
  const safeFallback = workOnly.step({x: 800, y: 700}, 'follow', {x: 2200, y: 1200}, 0.5);
  assert(contains(primary.workArea, safeFallback), `Expected fallback inside workArea, got ${JSON.stringify(safeFallback)}`);
  assert(safeFallback.x <= primary.workArea.x + primary.workArea.width - 55);

  const fullFrame = new DesktopNavigator(screens, true);
  const fullFallback = fullFrame.step({x: 800, y: 700}, 'follow', {x: 2200, y: 1200}, 0.5);
  assert(contains(primary.frame, fullFallback));
  assert(fullFallback.x > primary.workArea.x + primary.workArea.width);
});
