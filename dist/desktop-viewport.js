import {Box3, Vector3} from './assets/three.module.js';

// Project actual visible geometry, including the ground shadows it can cast.
// All measurements stay in logical pixels; the renderer keeps its original DPR.
export function createContentBounds(scene, camera) {
  scene.updateMatrixWorld(true);
  const boxes = new WeakMap();
  const world = new Vector3(), projected = new Vector3(), shadowPoint = new Vector3();
  const lightPosition = new Vector3(), target = new Vector3();
  const shadows = [];
  let groundY = null;
  scene.traverseVisible(object => {
    if (object.material?.isShadowMaterial) groundY = object.matrixWorld.elements[13];
    if (object.isDirectionalLight && object.castShadow) {
      object.getWorldPosition(lightPosition);
      object.target.getWorldPosition(target);
      const dy = target.y - lightPosition.y;
      if (Math.abs(dy) > 1e-8) shadows.push({x: (target.x - lightPosition.x) / dy,
        z: (target.z - lightPosition.z) / dy});
    }
  });
  return desktop => {
    scene.updateMatrixWorld();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const include = point => {
      projected.copy(point).project(camera);
      const x = desktop.x + (projected.x + 1) * desktop.width / 2;
      const y = desktop.y + (1 - projected.y) * desktop.height / 2;
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    };
    scene.traverseVisible(object => {
      const geometry = object.geometry;
      if (!geometry || object.material?.isShadowMaterial) return;
      const position = geometry.getAttribute('position');
      if (!position) return;
      let cached = boxes.get(geometry);
      if (!cached || cached.version !== position.version) {
        const box = cached?.box ?? new Box3();
        box.setFromBufferAttribute(position);
        cached = {box, version: position.version};
        boxes.set(geometry, cached);
      }
      const {min, max} = cached.box;
      for (let corner = 0; corner < 8; corner++) {
        world.set(corner & 1 ? max.x : min.x, corner & 2 ? max.y : min.y,
          corner & 4 ? max.z : min.z).applyMatrix4(object.matrixWorld);
        include(world);
        if (object.castShadow && groundY !== null) {
          for (const shadow of shadows) {
            const height = groundY - world.y;
            shadowPoint.set(world.x + shadow.x * height, groundY, world.z + shadow.z * height);
            include(shadowPoint);
          }
        }
      }
    });
    if (![minX, minY, maxX, maxY].every(Number.isFinite)) {
      throw new Error('Could not measure the desktop pet render bounds');
    }
    // Preserve soft shadow filtering and antialiased silhouettes beyond geometry edges.
    return {x: minX - 12, y: minY - 12, width: maxX - minX + 24, height: maxY - minY + 24};
  };
}

export function chooseViewport(content, previous, anchor, size) {
  const quantize = value => Math.ceil(value / 64) * 64;
  // Reserve the full turning envelope at each size, then grow if actual geometry
  // needs more room. Ordinary poses must not keep resizing the native surface.
  const envelope = quantize(size * 500 + 96);
  const width = Math.max(envelope, previous?.width ?? 0,
    quantize(2 * Math.max(anchor.x - content.x, content.x + content.width - anchor.x) + 64));
  const height = Math.max(envelope, previous?.height ?? 0,
    quantize(2 * Math.max(anchor.y - content.y, content.y + content.height - anchor.y) + 64));
  // Keep the spider at the same local pixel even while native movement and
  // WebKit presentation complete at different times. Batched recentering lets
  // the old surface briefly appear ahead of the new one.
  return {x: Math.round(anchor.x - width / 2), y: Math.round(anchor.y - height / 2), width, height};
}

// Compute iframe/canvas placement and Windows mixed-DPI CSS scaling for both
// WebGL cropped rendering and 2D Canvas fallback rendering.
export function computeViewportPlacement(viewport, bounds, baseScale, dpr, isWindows, isWebGL) {
  const x = viewport.x - bounds.x;
  const y = viewport.y - bounds.y;
  const cssScale = isWindows && dpr > 0 ? baseScale / dpr : 1;
  const scaled = Math.abs(cssScale - 1) > 1e-3;
  const cssWidth = Math.max(1, Math.round(viewport.width * cssScale));
  const cssHeight = Math.max(1, Math.round(viewport.height * cssScale));
  if (isWebGL) {
    return {
      cssScale,
      frameLeft: scaled ? 0 : -x,
      frameTop: scaled ? 0 : -y,
      frameScale: 1,
      canvasLeft: scaled ? 0 : x,
      canvasTop: scaled ? 0 : y,
      cssWidth,
      cssHeight,
    };
  }
  return {
    cssScale,
    frameLeft: scaled ? -x * cssScale : -x,
    frameTop: scaled ? -y * cssScale : -y,
    frameScale: scaled ? cssScale : 1,
    canvasLeft: 0,
    canvasTop: 0,
    cssWidth,
    cssHeight,
  };
}
