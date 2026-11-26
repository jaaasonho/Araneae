import * as THREE from './assets/three.module.js';
import {applySettings} from './desktop-adapter.js';
import {createDesktopClock} from './desktop-clock.js';
import {createContentBounds, chooseViewport, computeViewportPlacement} from './desktop-viewport.js';
import {DesktopBehavior} from './desktop-behavior.js';
import {desktopStrings, localizeDesktop} from './desktop-i18n.js';
import {desktopBounds, nearestScreen, clampPoint, contains, distance} from './desktop-routing.js';

const frame = document.getElementById('original');
const errorBox = document.getElementById('desktopError');
const {invoke} = window.__TAURI__.core;
const {listen} = window.__TAURI__.event;
let settings, page, spider, screens, bounds, behavior, viewport, clock, measureContent;
let baseScale = 1;
let stopped = false, placing = false, readingCursor = false, readingLayout = false;
let resetCrop = true, styledViewport = null;
let lastPlaced = null, topology = '';
let cursorFailures = 0, cursorErrorShown = false, activeErrorSource = null;
const cleanup = [];
let strings = desktopStrings();
const raycaster = new THREE.Raycaster();
const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

function report(error, source = 'general') {
  console.error('Desktop pet operation failed:', error);
  if (source === 'cursor' && activeErrorSource && activeErrorSource !== 'cursor') return;
  errorBox.textContent = strings.petFailed + String(error);
  errorBox.hidden = false;
  activeErrorSource = source;
}

function clearCursorError() {
  cursorErrorShown = false;
  if (activeErrorSource === 'cursor') {
    errorBox.hidden = true;
    errorBox.textContent = '';
    activeErrorSource = null;
  }
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
  if (!settings || settings.language !== next.language || settings.platform !== next.platform) {
    strings = localizeDesktop(document, next.language, next.platform);
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
    baseScale = Number.isFinite(snapshot.baseScale) && snapshot.baseScale > 0 ? snapshot.baseScale : 1;
    const dpr = frame.contentWindow?.devicePixelRatio || 1;
    const key = JSON.stringify({screens: snapshot.screens, baseScale});
    if (key === topology) {
      if (spider && settings?.visible && styledViewport && styledViewport.dpr !== dpr && clock) {
        clock.redraw();
      }
      return;
    }
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
    cursorFailures = 0;
    clearCursorError();
  } catch (error) {
    // Transient Windows failures (e.g. UAC / lock screen / monitor hot-plug)
    // must not permanently stop pointer polling.
    cursorFailures++;
    console.warn('Cursor position poll failed:', error);
    if (cursorFailures >= 10 && !cursorErrorShown) {
      report(error, 'cursor');
      cursorErrorShown = true;
    }
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
  const dpr = frame.contentWindow?.devicePixelRatio || 1;
  const placement = computeViewportPlacement(
    viewport, bounds, baseScale, dpr,
    settings?.platform === 'windows', spider.renderer.isWebGLRenderer,
  );
  if (!styledViewport || placement.frameLeft !== styledViewport.frameLeft
    || placement.frameTop !== styledViewport.frameTop
    || placement.frameScale !== styledViewport.frameScale
    || placement.canvasLeft !== styledViewport.canvasLeft
    || placement.canvasTop !== styledViewport.canvasTop) {
    frame.style.left = placement.frameLeft + 'px';
    frame.style.top = placement.frameTop + 'px';
    frame.style.transformOrigin = '0 0';
    frame.style.transform = placement.frameScale === 1 ? '' : `scale(${placement.frameScale})`;
    if (spider.renderer.isWebGLRenderer) {
      const canvas = spider.renderer.domElement;
      canvas.style.position = 'absolute';
      canvas.style.left = placement.canvasLeft + 'px';
      canvas.style.top = placement.canvasTop + 'px';
    }
    styledViewport = {...placement, dpr};
  } else if (styledViewport.dpr !== dpr) {
    styledViewport.dpr = dpr;
  }
  if (placing || (lastPlaced && distance(viewport, lastPlaced) < 1
    && viewport.width === lastPlaced.width && viewport.height === lastPlaced.height)) return;
  placing = true;
  const requested = {...viewport};
  invoke('place_viewport', {bounds: requested, center: point}).then(actual => {
    const tolerance = settings?.platform === 'windows' ? 2 : 1;
    const constrained = Math.abs(actual.x - requested.x) > tolerance
      || Math.abs(actual.y - requested.y) > tolerance
      || Math.abs(actual.width - requested.width) > tolerance
      || Math.abs(actual.height - requested.height) > tolerance;
    if (constrained) {
      if (settings?.platform === 'windows') {
        console.warn('Windows desktop viewport constrained or mid-DPI transition:', requested, actual);
        lastPlaced = actual;
      } else {
        throw new Error('The system constrained the desktop viewport position');
      }
    } else {
      lastPlaced = requested;
    }
  }).catch(report).finally(() => { placing = false; });
}

function attachRenderer() {
  const renderer = spider.renderer;
  if (renderer.isWebGLRenderer) measureContent = createContentBounds(spider.scene, spider.camera);
  const originalRender = renderer.render.bind(renderer);
  renderer.render = (scene, camera) => {
    const point = globalPoint();
    track(point);
    const dpr = frame.contentWindow.devicePixelRatio || 1;
    if (!renderer.isWebGLRenderer) {
      if (settings?.platform === 'windows') {
        const targetRatio = Math.min(baseScale, 2);
        if (renderer.pixelRatio !== targetRatio) renderer.setPixelRatio(targetRatio);
      }
      return originalRender(scene, camera);
    }
    // Crop only the render. Physics, camera projection and all original input handlers
    // keep using the full virtual desktop and the original simulation state.
    const ratio = Math.min(dpr, 2);
    // On Windows mixed-DPI displays, native window size uses shared baseScale while
    // WebView2 CSS coordinates scale by the current monitor's DPR. Compensate so the
    // canvas fills the physical HWND without clipping or visual jumping across seams.
    const {cssWidth, cssHeight} = computeViewportPlacement(
      viewport, bounds, baseScale, dpr, settings?.platform === 'windows', true,
    );
    if (renderer.getPixelRatio() !== ratio) renderer.setPixelRatio(ratio);
    const canvas = renderer.domElement;
    if (canvas.width !== Math.floor(cssWidth * ratio) || canvas.height !== Math.floor(cssHeight * ratio)) {
      renderer.setSize(cssWidth, cssHeight);
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

function watchDevicePixelRatio() {
  const target = frame.contentWindow;
  if (!target?.matchMedia) return;
  let current = target.devicePixelRatio || 1;
  let media = null;
  const onChange = () => {
    media?.removeEventListener('change', onChange);
    const next = target.devicePixelRatio || 1;
    if (next !== current) {
      current = next;
      if (spider && settings?.visible && clock) clock.redraw();
    }
    subscribe();
  };
  const subscribe = () => {
    if (stopped) return;
    media = target.matchMedia(`(resolution: ${current}dppx)`);
    media.addEventListener('change', onChange, {once: true});
  };
  subscribe();
  cleanup.push(() => media?.removeEventListener('change', onChange));
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
  watchDevicePixelRatio();
  frame.contentWindow.addEventListener('keydown', keydown);
  frame.classList.add('ready');
  await invoke('pet_ready', {renderer: spider.renderer.isWebGLRenderer ? 'WebGL' : 'Canvas fallback'});
} catch (error) {
  report(error);
  await invoke('pet_ready', {renderer: 'initialization failed'}).catch(console.error);
}
