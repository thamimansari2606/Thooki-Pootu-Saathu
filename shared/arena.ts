// Shared arena geometry and collision. Used by the authoritative server, the bots and the client.
// Units are world meters. Grid cell size is 1 meter.

export interface Vec2 {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: "house" | "wall" | "tree" | "barrel" | "box" | "building";
}

export const ARENA_SIZE = 40;
export const CELL = 1;
export const GRID_N = ARENA_SIZE / CELL;
export const PLAYER_RADIUS = 0.4;

// Hand-authored layout: open plaza in the middle, houses and buildings on the edges,
// narrow passages between them, and several hiding spots. Symmetric enough to be fair.
export const OBSTACLES: Rect[] = [
  // Houses (north-west, north-east, south-west, south-east)
  { x: 3, y: 3, w: 7, h: 5, kind: "house" },
  { x: 30, y: 3, w: 7, h: 5, kind: "house" },
  { x: 3, y: 32, w: 7, h: 5, kind: "house" },
  { x: 30, y: 32, w: 7, h: 5, kind: "house" },
  // Large buildings flanking the centre
  { x: 16, y: 1, w: 8, h: 4, kind: "building" },
  { x: 16, y: 35, w: 8, h: 4, kind: "building" },
  { x: 1, y: 18, w: 3, h: 4, kind: "building" },
  { x: 36, y: 18, w: 3, h: 4, kind: "building" },
  // Walls forming narrow passages
  { x: 12, y: 12, w: 1, h: 6, kind: "wall" },
  { x: 27, y: 12, w: 1, h: 6, kind: "wall" },
  { x: 12, y: 22, w: 1, h: 6, kind: "wall" },
  { x: 27, y: 22, w: 1, h: 6, kind: "wall" },
  { x: 19, y: 16, w: 2, h: 1, kind: "wall" },
  { x: 19, y: 23, w: 2, h: 1, kind: "wall" },
  // Trees (small blocks)
  { x: 10, y: 9, w: 1.5, h: 1.5, kind: "tree" },
  { x: 29, y: 9, w: 1.5, h: 1.5, kind: "tree" },
  { x: 10, y: 29, w: 1.5, h: 1.5, kind: "tree" },
  { x: 29, y: 29, w: 1.5, h: 1.5, kind: "tree" },
  { x: 6, y: 20, w: 1.5, h: 1.5, kind: "tree" },
  { x: 33, y: 20, w: 1.5, h: 1.5, kind: "tree" },
  // Barrels and boxes as hiding cover in the open
  { x: 18, y: 8, w: 1, h: 1, kind: "barrel" },
  { x: 21, y: 8, w: 1, h: 1, kind: "barrel" },
  { x: 18, y: 31, w: 1, h: 1, kind: "barrel" },
  { x: 21, y: 31, w: 1, h: 1, kind: "barrel" },
  { x: 8, y: 15, w: 1.5, h: 1.5, kind: "box" },
  { x: 31, y: 24, w: 1.5, h: 1.5, kind: "box" },
  { x: 14, y: 26, w: 1.5, h: 1.5, kind: "box" },
  { x: 24, y: 13, w: 1.5, h: 1.5, kind: "box" },
];

export const SPAWN_POINTS: Vec2[] = [
  { x: 5, y: 10 },
  { x: 35, y: 10 },
  { x: 5, y: 30 },
  { x: 35, y: 30 },
  { x: 20, y: 20 },
  { x: 20, y: 6 },
];

/** Circle vs axis-aligned rectangle overlap test. */
export function circleHitsRect(c: Vec2, r: number, rect: Rect): boolean {
  const nx = Math.max(rect.x, Math.min(c.x, rect.x + rect.w));
  const ny = Math.max(rect.y, Math.min(c.y, rect.y + rect.h));
  const dx = c.x - nx;
  const dy = c.y - ny;
  return dx * dx + dy * dy < r * r;
}

export function isPositionFree(p: Vec2, radius = PLAYER_RADIUS): boolean {
  if (p.x < radius || p.y < radius || p.x > ARENA_SIZE - radius || p.y > ARENA_SIZE - radius) {
    return false;
  }
  for (const rect of OBSTACLES) {
    if (circleHitsRect(p, radius, rect)) return false;
  }
  return true;
}

/**
 * Moves a circle by (dx, dy) with per-axis sliding against obstacles.
 * Returns the resulting position; never leaves the arena or enters an obstacle.
 */
export function moveWithCollision(pos: Vec2, dx: number, dy: number, radius = PLAYER_RADIUS): Vec2 {
  let x = pos.x;
  let y = pos.y;
  const tryX = { x: x + dx, y };
  if (isPositionFree(tryX, radius)) x = tryX.x;
  const tryY = { x, y: y + dy };
  if (isPositionFree(tryY, radius)) y = tryY.y;
  return { x, y };
}

/** Returns the blocked-cell grid used by pathfinding. blocked[row * GRID_N + col] */
export function buildNavGrid(radius = PLAYER_RADIUS): Uint8Array {
  const grid = new Uint8Array(GRID_N * GRID_N);
  for (let row = 0; row < GRID_N; row++) {
    for (let col = 0; col < GRID_N; col++) {
      const center = { x: col * CELL + CELL / 2, y: row * CELL + CELL / 2 };
      if (!isPositionFree(center, radius)) grid[row * GRID_N + col] = 1;
    }
  }
  return grid;
}

export function cellOf(p: Vec2): { col: number; row: number } {
  return {
    col: Math.max(0, Math.min(GRID_N - 1, Math.floor(p.x / CELL))),
    row: Math.max(0, Math.min(GRID_N - 1, Math.floor(p.y / CELL))),
  };
}

export function cellCenter(col: number, row: number): Vec2 {
  return { x: col * CELL + CELL / 2, y: row * CELL + CELL / 2 };
}

/** Straight-line visibility test used for line of sight and "can I be seen" checks. */
export function hasLineOfSight(a: Vec2, b: Vec2, step = 0.25): boolean {
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(1, Math.ceil(dist / step));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    for (const rect of OBSTACLES) {
      if (circleHitsRect(p, 0.05, rect)) return false;
    }
  }
  return true;
}
