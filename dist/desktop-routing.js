const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const contains = (rect, point) => point.x >= rect.x && point.y >= rect.y
  && point.x < rect.x + rect.width && point.y < rect.y + rect.height;

export function desktopBounds(screens) {
  if (!screens.length) throw new Error('No desktop displays are available');
  const x = Math.min(...screens.map(screen => screen.frame.x));
  const y = Math.min(...screens.map(screen => screen.frame.y));
  return {
    x, y,
    width: Math.max(...screens.map(screen => screen.frame.x + screen.frame.width)) - x,
    height: Math.max(...screens.map(screen => screen.frame.y + screen.frame.height)) - y,
  };
}

export function clampPoint(rect, point, margin = 0) {
  const mx = Math.min(margin, rect.width / 3);
  const my = Math.min(margin, rect.height / 3);
  return {
    x: clamp(point.x, rect.x + mx, rect.x + rect.width - Math.max(mx, 1)),
    y: clamp(point.y, rect.y + my, rect.y + rect.height - Math.max(my, 1)),
  };
}

export function nearestScreen(screens, point) {
  let best = -1;
  let score = Infinity;
  screens.forEach((screen, index) => {
    const next = distance(point, clampPoint(screen.frame, point));
    if (next < score) { score = next; best = index; }
  });
  return best;
}

// Approach the shared edge head-on, then turn after entering the next screen.
// This avoids a diagonal shortcut through an invisible notch in staggered layouts.
export function crossing(a, b) {
  const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const horizontal = (edge, direction) => {
    const y = Math.max(a.y, b.y) + overlapY / 2;
    return [
      {x: edge - direction * Math.min(160, a.width / 3), y},
      {x: edge + direction * Math.min(160, b.width / 3), y},
    ];
  };
  const vertical = (edge, direction) => {
    const x = Math.max(a.x, b.x) + overlapX / 2;
    return [
      {x, y: edge - direction * Math.min(160, a.height / 3)},
      {x, y: edge + direction * Math.min(160, b.height / 3)},
    ];
  };
  if (overlapY > 1 && Math.abs(a.x + a.width - b.x) < 1) return horizontal(b.x, 1);
  if (overlapY > 1 && Math.abs(b.x + b.width - a.x) < 1) return horizontal(a.x, -1);
  if (overlapX > 1 && Math.abs(a.y + a.height - b.y) < 1) return vertical(b.y, 1);
  if (overlapX > 1 && Math.abs(b.y + b.height - a.y) < 1) return vertical(a.y, -1);
  if (overlapX > 1 && overlapY > 1) {
    return [{x: Math.max(a.x, b.x) + overlapX / 2, y: Math.max(a.y, b.y) + overlapY / 2}];
  }
  return null;
}

export function routeBetween(screens, start, target) {
  const from = nearestScreen(screens, start);
  const to = nearestScreen(screens, target);
  const previous = new Map([[from, null]]);
  const queue = [from];
  for (let i = 0; i < queue.length && !previous.has(to); i++) {
    for (let next = 0; next < screens.length; next++) {
      if (!previous.has(next) && crossing(screens[queue[i]].frame, screens[next].frame)) {
        previous.set(next, queue[i]);
        queue.push(next);
      }
    }
  }
  if (!previous.has(to)) return null;
  const indices = [to];
  while (indices[0] !== from) indices.unshift(previous.get(indices[0]));
  const points = [];
  for (let i = 1; i < indices.length; i++) {
    points.push(...crossing(screens[indices[i - 1]].frame, screens[indices[i]].frame));
  }
  points.push(clampPoint(screens[to].frame, target));
  return points;
}

export class DesktopNavigator {
  constructor(screens, wholeScreen = false, random = Math.random) {
    this.screens = screens;
    this.wholeScreen = wholeScreen;
    this.random = random;
    this.points = [];
    this.target = null;
    this.mode = null;
  }

  navigate(position, target) {
    const route = routeBetween(this.screens, position, target);
    if (!route) return false;
    this.target = {...target};
    this.points = route;
    return true;
  }

  chooseRoam(position, size) {
    const current = nearestScreen(this.screens, position);
    const candidates = this.screens.map((screen, index) => index).filter(index => index !== current
      && routeBetween(this.screens, position, clampPoint(this.screens[index].frame, position)));
    const index = candidates.length ? candidates[Math.floor(this.random() * candidates.length)] : current;
    const screen = this.screens[index];
    const area = this.wholeScreen ? screen.frame : screen.workArea;
    const target = clampPoint(area, {
      x: area.x + area.width * (.25 + this.random() * .5),
      y: area.y + area.height * (.25 + this.random() * .5),
    }, 110 * size);
    this.navigate(position, target);
  }

  step(position, mode, pointer, size) {
    if (mode !== this.mode) {
      this.mode = mode;
      this.points = [];
      this.target = null;
    }
    if (mode === 'observe') return null;
    const reach = Math.max(16, 32 * size);
    if (mode === 'follow') {
      if (!pointer) return null;
      const screen = this.screens[nearestScreen(this.screens, pointer)];
      const target = clampPoint(this.wholeScreen ? screen.frame : screen.workArea, pointer, 110 * size);
      if (!this.target || nearestScreen(this.screens, target) !== nearestScreen(this.screens, this.target)
        || distance(target, this.target) > 70 || this.points.length <= 1) {
        if (!this.navigate(position, target)) {
          const fallback = this.screens[nearestScreen(this.screens, position)];
          return clampPoint(this.wholeScreen ? fallback.frame : fallback.workArea, target, 110 * size);
        }
      }
    }
    while (this.points.length && distance(position, this.points[0]) < reach) this.points.shift();
    if (!this.points.length && mode === 'roam') this.chooseRoam(position, size);
    return this.points[0] || this.target;
  }
}
