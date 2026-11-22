// Isometric projection and camera-relative input mapping. Pure functions (no DOM) so they are testable.
export const TILE_W = 28; // screen pixels per world unit along the iso x axis
export const TILE_H = TILE_W * 0.5;

export interface Vec2 {
  x: number;
  y: number;
}

/** World (x, y) on the ground plane -> screen pixels relative to the world origin. */
export function worldToScreen(p: Vec2): Vec2 {
  return { x: (p.x - p.y) * TILE_W, y: (p.x + p.y) * TILE_H };
}

/** Screen pixel offset -> world ground coordinates (inverse of worldToScreen). */
export function screenToWorld(s: Vec2): Vec2 {
  const a = s.x / TILE_W; // x - y
  const b = s.y / TILE_H; // x + y
  return { x: (a + b) / 2, y: (b - a) / 2 };
}

/**
 * Converts a camera-relative direction (screen up = -1 in y, right = +1 in x) into a world direction.
 * Screen up/down/left/right are diagonals in world space for an isometric camera.
 */
export function screenDirToWorld(dir: Vec2): Vec2 {
  const w = screenToWorld({ x: dir.x, y: dir.y });
  const len = Math.hypot(w.x, w.y);
  if (len === 0) return { x: 0, y: 0 };
  return { x: w.x / len, y: w.y / len };
}

/** Applies a deadzone and scales a joystick or keyboard vector to the unit circle. */
export function applyDeadzone(v: Vec2, deadzone = 0.15): Vec2 {
  const len = Math.hypot(v.x, v.y);
  if (len < deadzone) return { x: 0, y: 0 };
  const scaled = Math.min(1, (len - deadzone) / (1 - deadzone));
  return { x: (v.x / len) * scaled, y: (v.y / len) * scaled };
}
