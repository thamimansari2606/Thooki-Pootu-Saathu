// Input model shared by keyboard, mouse and touch. Produces intents only; the server validates them.
import { applyDeadzone, screenDirToWorld, type Vec2 } from "./iso.ts";

export interface Intent {
  dx: number;
  dy: number;
  sprint: boolean;
  dodge: boolean;
  attack: boolean;
}

export interface KeyState {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  sprint: boolean;
  dodge: boolean;
  attack: boolean;
}

export const EMPTY_KEYS: KeyState = { up: false, down: false, left: false, right: false, sprint: false, dodge: false, attack: false };

/** WASD and arrow keys mapped to a screen-space direction. */
export function keyCodeToAction(code: string): keyof KeyState | null {
  switch (code) {
    case "KeyW":
    case "ArrowUp":
      return "up";
    case "KeyS":
    case "ArrowDown":
      return "down";
    case "KeyA":
    case "ArrowLeft":
      return "left";
    case "KeyD":
    case "ArrowRight":
      return "right";
    case "ShiftLeft":
    case "ShiftRight":
      return "sprint";
    case "Space":
      return "dodge";
    case "KeyJ":
    case "Enter":
      return "attack";
    default:
      return null;
  }
}

/** Builds the world-space intent from keys (camera-relative) plus an optional touch stick. */
export function buildIntent(keys: KeyState, stick: Vec2 | null): Intent {
  let screen: Vec2 = { x: 0, y: 0 };
  if (keys.up) screen.y -= 1;
  if (keys.down) screen.y += 1;
  if (keys.left) screen.x -= 1;
  if (keys.right) screen.x += 1;
  if (stick) {
    const s = applyDeadzone(stick);
    screen = { x: screen.x + s.x, y: screen.y + s.y };
  }
  const len = Math.hypot(screen.x, screen.y);
  if (len > 1) screen = { x: screen.x / len, y: screen.y / len };
  const world = screenDirToWorld(screen);
  const moving = Math.hypot(world.x, world.y) > 0.01;
  return {
    dx: moving ? world.x * Math.min(1, len) : 0,
    dy: moving ? world.y * Math.min(1, len) : 0,
    sprint: keys.sprint,
    dodge: keys.dodge,
    attack: keys.attack,
  };
}
