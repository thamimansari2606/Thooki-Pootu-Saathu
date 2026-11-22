// Keyboard, touch joystick and button input. Emits a movement intent at 20 Hz; the server validates it.
import { EMPTY_KEYS, buildIntent, keyCodeToAction, type Intent, type KeyState } from "./controls.ts";
import type { Vec2 } from "./iso.ts";

export interface InputHandlers {
  onIntent: (intent: Intent) => void;
  onProp: (slot: 0 | 1 | 2) => void;
  onPause: () => void;
}

export class InputController {
  private keys: KeyState = { ...EMPTY_KEYS };
  private stick: Vec2 | null = null;
  private timer: number | null = null;
  private handlers: InputHandlers;
  private boundKeyDown = (e: KeyboardEvent) => this.onKey(e, true);
  private boundKeyUp = (e: KeyboardEvent) => this.onKey(e, false);

  constructor(handlers: InputHandlers) {
    this.handlers = handlers;
  }

  start(): void {
    window.addEventListener("keydown", this.boundKeyDown);
    window.addEventListener("keyup", this.boundKeyUp);
    window.addEventListener("blur", this.reset);
    this.timer = window.setInterval(() => {
      this.handlers.onIntent(buildIntent(this.keys, this.stick));
      // Edge-triggered actions are cleared after one send so a tap is one attack.
      this.keys.dodge = false;
      this.keys.attack = false;
    }, 50);
  }

  stop(): void {
    window.removeEventListener("keydown", this.boundKeyDown);
    window.removeEventListener("keyup", this.boundKeyUp);
    window.removeEventListener("blur", this.reset);
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.reset();
  }

  private reset = () => {
    this.keys = { ...EMPTY_KEYS };
    this.stick = null;
  };

  private onKey(e: KeyboardEvent, down: boolean) {
    if (down && e.code === "Escape") {
      this.handlers.onPause();
      return;
    }
    if (down && (e.code === "Digit1" || e.code === "Digit2" || e.code === "Digit3")) {
      this.handlers.onProp((Number(e.code.slice(-1)) - 1) as 0 | 1 | 2);
      return;
    }
    const action = keyCodeToAction(e.code);
    if (!action) return;
    if (e.code === "Space" || e.code.startsWith("Arrow")) e.preventDefault();
    if (action === "dodge" || action === "attack") {
      if (down && !this.keys[action]) this.keys[action] = true;
      return;
    }
    this.keys[action] = down;
  }

  setStick(v: Vec2 | null): void {
    this.stick = v;
  }

  /** Press an on-screen button (touch or mouse). */
  press(action: "attack" | "dodge" | "sprint", down: boolean): void {
    if (action === "attack" || action === "dodge") {
      if (down) this.keys[action] = true;
    } else {
      this.keys.sprint = down;
    }
  }

  prop(slot: 0 | 1 | 2): void {
    this.handlers.onProp(slot);
  }
}
