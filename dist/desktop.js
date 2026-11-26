import * as THREE from './assets/three.module.js';
import {applySettings} from './desktop-adapter.js';
import {createDesktopClock} from './desktop-clock.js';
import {createContentBounds, chooseViewport} from './desktop-viewport.js';
import {DesktopBehavior} from './desktop-behavior.js';
import {desktopStrings, localizeDesktop} from './desktop-i18n.js';
import {desktopBounds, nearestScreen, clampPoint, contains, distance} from './desktop-routing.js';

const frame = document.getElementById('original');
const errorBox = document.getElementById('desktopError');
const {invoke} = window.__TAURI__.core;
const {listen} = window.__TAURI__.event;
let settings, page, spider, screens, bounds, behavior, viewport, clock, measureContent;
let stopped = false, placing = false, readingCursor = false, readingLayout = false;
let resetCrop = true, styledViewport = null;
let lastPlaced = null, topology = '';
const cleanup = [];
let strings = desktopStrings();
const raycaster = new THREE.Raycaster();
const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

function report(error) {
  console.error('Desktop pet operation failed:', error);
  errorBox.textContent = strings.petFailed + String(error);
  errorBox.hidden = false;
}

function project(world) {
  const point = world.clone().project(spider.camera);
  return {x: bounds.x + (point.x + 1) * bounds.width / 2, y: bounds.y + (1 - point.y) * bounds.height / 2};
}

function globalPoint() { return project(spider.position); }

function worldPoint(point) {
  raycaster.setFromCamera(new THREE.Vector2(
    (point.x - bounds.x) / bounds.width * 2 - 1,
    1 - (point.y - bounds.y) / bounds.height * 2,
  ), spider.camera);
  return raycaster.ray.intersectPlane(floor, new THREE.Vector3());
}

function recoverPosition(point) {
  const screen = screens[nearestScreen(screens, point)];
  const target = clampPoint(settings.wholeScreen ? screen.frame : screen.workArea, point, 110 * settings.size);
  const world = worldPoint(target);
  if (!world) throw new Error('Could not project the desktop recovery position');
  spider.position.copy(world);
  spider.goal.copy(world);
  spider.velocity.set(0, 0, 0);
  spider.cancelManual();
  spider.legs.forEach(leg => { leg.initialized = false; leg.stepping = false; });
}

function apply(next) {
  if (!settings || settings.language !== next.language) {
    strings = localizeDesktop(document, next.language);
    frame.title = strings.petArea;
  }
  const crossingChanged = settings && settings.allowCrossScreen !== next.allowCrossScreen;
  const reroute = settings && (settings.mode !== next.mode || settings.wholeScreen !== next.wholeScreen || crossingChanged);
  const suspended = settings && (settings.paused || !settings.visible);
  if (settings && settings.size !== next.size) resetCrop = true;
  settings = next;
  if (reroute && spider) spider.cancelManual();
  if (crossingChanged && spider) {
    // Discard momentum and the old destination before locking the current display.
    spider.velocity.set(0, 0, 0);
    spider.goal.copy(spider.position);
  }
  if (spider) applySettings(page, spider, settings);
  if (reroute && spider) installBehavior();
  if (clock && spider) {
    if (suspended && next.visible && !next.paused) {
      // Reset the unchanged original loop's elapsed-time baseline after suspension.
      page.dispatchEvent(new page.defaultView.Event('visibilitychange'));
    }
    clock.setRunning(next.visible && !next.paused);
    if (next.visible) clock.redraw();
  }
}

async function readLayout() {
  if (readingLayout || stopped) return;
  readingLayout = true;
  try {
    const snapshot = await invoke('desktop_layout');
    const key = JSON.stringify(snapshot.screens);
    if (key === topology) return;
    const previousPoint = spider ? globalPoint() : null;
    topology = key;
    // Mirrored displays share the same desktop coordinates and must not become duplicate destinations.
    screens = snapshot.screens.filter((screen, index, all) => all.findIndex(other =>
      JSON.stringify(other.frame) === JSON.stringify(screen.frame)) === index);
    const previousBounds = bounds;
    bounds = desktopBounds(screens);
    bounds.width = Math.ceil(bounds.width);
    bounds.height = Math.ceil(bounds.height);
    frame.style.width = bounds.width + 'px';
    frame.style.height = bounds.height + 'px';
    viewport = snapshot.viewport;
    lastPlaced = null;
    resetCrop = true;
    if (spider && (JSON.stringify(previousBounds) !== JSON.stringify(bounds)
      || !screens.some(screen => contains(screen.frame, previousPoint)))) {
      // Only topology changes resize the virtual stage; normal crossings never reset the simulation.
      // Force the resized iframe layout, then notify the original resize handler.
      frame.getBoundingClientRect();
      frame.contentWindow.dispatchEvent(new frame.contentWindow.Event('resize'));
      if (!stopped) recoverPosition(previousPoint);
    }
    if (spider) installBehavior();
    if (spider && settings.visible) clock.redraw();
  } finally {
    readingLayout = false;
  }
}

async function readCursor() {
  if (readingCursor || stopped || !settings?.visible || settings.paused || settings.mode !== 'follow') return;
  readingCursor = true;
  try {
    const point = await invoke('cursor_position');
    if (behavior) behavior.pointer = point;
  } catch (error) {
    report(error);
    clearInterval(cursorTimer);
  } finally {
    readingCursor = false;
  }
}

function installBehavior() {
  behavior = new DesktopBehavior(spider, screens, settings.wholeScreen, project, worldPoint, bounds, settings.allowCrossScreen);
  frame.contentWindow.__spiderDesktop = behavior;
  if (settings.mode === 'roam' && !spider.sprinting && !spider.motion.arriving) {
    spider.goal.copy(behavior.chooseGoal(spider.patrol.leg));
  }
}

function track(point) {
  const content = measureContent?.(bounds);
  if (measureContent) {
    viewport = chooseViewport(content, resetCrop ? null : viewport, point, settings.size);
  } else {
    const width = Math.min(1024, bounds.width), height = Math.min(1024, bounds.height);
    viewport = {x: Math.round(point.x - width / 2), y: Math.round(point.y - height / 2), width, height};
  }
  resetCrop = false;
  const x = viewport.x - bounds.x;
  const y = viewport.y - bounds.y;
  if (!styledViewport || viewport.x !== styledViewport.x || viewport.y !== styledViewport.y
    || bounds.x !== styledViewport.desktopX || bounds.y !== styledViewport.desktopY) {
    frame.style.left = -x + 'px';
    frame.style.top = -y + 'px';
    if (spider.renderer.isWebGLRenderer) {
      const canvas = spider.renderer.domElement;
      canvas.style.position = 'absolute';
      canvas.style.left = x + 'px';
      canvas.style.top = y + 'px';
    }
    styledViewport = {...viewport, desktopX: bounds.x, desktopY: bounds.y};
  }
  if (placing || (lastPlaced && distance(viewport, lastPlaced) < 1
    && viewport.width === lastPlaced.width && viewport.height === lastPlaced.height)) return;
  placing = true;
  const requested = {...viewport};
  invoke('place_viewport', {bounds: requested, center: point}).then(actual => {
    if (Math.abs(actual.x - requested.x) > 1 || Math.abs(actual.y - requested.y) > 1) {
      throw new Error('The system constrained the desktop viewport position');
    }
    lastPlaced = requested;
  }).catch(report).finally(() => { placing = false; });
}

function attachRenderer() {
  const renderer = spider.renderer;
  if (renderer.isWebGLRenderer) measureContent = createContentBounds(spider.scene, spider.camera);
  const originalRender = renderer.render.bind(renderer);
  renderer.render = (scene, camera) => {
    const point = globalPoint();
    track(point);
    if (!renderer.isWebGLRenderer) return originalRender(scene, camera);
    // Crop only the render. Physics, camera projection and all original input handlers
    // keep using the full virtual desktop and the original simulation state.
    const ratio = Math.min(frame.contentWindow.devicePixelRatio, 2);
    if (renderer.getPixelRatio() !== ratio) renderer.setPixelRatio(ratio);
    const canvas = renderer.domElement;
    if (canvas.width !== Math.floor(viewport.width * ratio) || canvas.height !== Math.floor(viewport.height * ratio)) {
      renderer.setSize(viewport.width, viewport.height);
    }
    camera.setViewOffset(bounds.width, bounds.height,
      viewport.x - bounds.x, viewport.y - bounds.y, viewport.width, viewport.height);
    // Measuring content already updated these same interpolated world matrices.
    const autoUpdate = scene.matrixWorldAutoUpdate;
    scene.matrixWorldAutoUpdate = false;
    try { return originalRender(scene, camera); }
    finally { scene.matrixWorldAutoUpdate = autoUpdate; camera.clearViewOffset(); }
  };
  cleanup.push(() => { renderer.render = originalRender; });
}

async function waitForOriginal() {
  const response = await fetch('index.html');
  if (!response.ok) throw new Error('Could not load the original spider page');
  const html = await response.text();
  // Keep the original document unchanged, but install the desktop clock before
  // its external module registers the first animation callback.
  const child = frame.contentWindow;
  const document = child.document;
  document.open();
  clock = createDesktopClock(child, frameId => invoke('request_animation_frame', {frameId}).catch(report));
  // Install the crop before the original's first display frame can allocate a
  // full virtual-desktop drawing surface.
  clock.setRunning(false);
  cleanup.push(await listen('desktop-frame', event => clock.tick(event.payload)));
  child.requestAnimationFrame = clock.request;
  child.cancelAnimationFrame = clock.cancel;
  cleanup.push(clock.dispose);
  document.write(html);
  document.close();
  const deadline = performance.now() + 30000;
  while (!frame.contentWindow?.__spider) {
    if (stopped) throw new Error('Desktop pet was closed during initialization');
    if (performance.now() > deadline) throw new Error('Original spider did not initialize within 30 seconds');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  page = frame.contentDocument;
  spider = frame.contentWindow.__spider;
  page.documentElement.classList.add('desktop-pet');
  const style = page.createElement('link');
  style.rel = 'stylesheet';
  style.href = 'desktop.css';
  await new Promise((resolve, reject) => {
    style.onload = resolve;
    style.onerror = () => reject(new Error('Could not load desktop transparency styles'));
    page.head.append(style);
  });
  const point = globalPoint();
  if (!screens.some(screen => contains(screen.frame, point))) recoverPosition(point);
}

function keydown(event) {
  if (event.code === 'Space' && !['INPUT', 'BUTTON'].includes(page.activeElement.tagName)) {
    invoke('update_settings', {command: {type: 'paused', value: spider.state.paused}}).catch(report);
  }
}

const cursorTimer = setInterval(() => readCursor(), 1000 / 30);
const geometryTimer = setInterval(() => readLayout().catch(report), 2000);
window.addEventListener('pagehide', () => {
  stopped = true;
  clearInterval(cursorTimer);
  clearInterval(geometryTimer);
  cleanup.forEach(dispose => dispose());
}, {once: true});
window.addEventListener('keydown', event => {
  if (event.code === 'Space' && page) {
    event.preventDefault();
    frame.contentWindow.dispatchEvent(new page.defaultView.KeyboardEvent('keydown', {
      code: 'Space', key: ' ', bubbles: true,
    }));
  }
});

try {
  cleanup.push(await listen('pet-settings', event => apply(event.payload)));
  cleanup.push(await listen('pet-relocate', event => {
    behavior?.relocate(event.payload);
  }));
  cleanup.push(await listen('pet-destination', event => {
    if (!settings?.visible || settings.paused || !spider || !behavior) return;
    const {point, fast} = event.payload;
    if (!behavior.allowsPoint(point)) return;
    spider.commandMove({clientX: point.x - bounds.x, clientY: point.y - bounds.y, button: 0}, fast);
    if (settings.visible) clock.redraw();
  }));
  apply(await invoke('get_settings'));
  await readLayout();
  await waitForOriginal();
  installBehavior();
  apply(settings);
  attachRenderer();
  // Match the first crop and native position before revealing the window.
  track(globalPoint());
  frame.contentWindow.addEventListener('keydown', keydown);
  frame.classList.add('ready');
  await invoke('pet_ready', {renderer: spider.renderer.isWebGLRenderer ? 'WebGL' : 'Canvas fallback'});
} catch (error) {
  report(error);
  await invoke('pet_ready', {renderer: 'initialization failed'}).catch(console.error);
}
