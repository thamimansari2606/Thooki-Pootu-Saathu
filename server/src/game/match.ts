// Authoritative match engine. Pure logic: no I/O, no timers. The server drives step() and
// supplies the RNG. Clients never decide damage, knockout, catcher or the outcome.
import { moveWithCollision, ARENA_SIZE, SPAWN_POINTS, PLAYER_RADIUS, type Vec2 } from "../../../shared/arena.ts";
import { resolveCatcher, validateSelection, type Rng } from "./dice.ts";

export const MATCH_DURATION_MS = 300_000;
export const MAX_HP = 100;
export const ATTACK_RANGE = 1.8;
export const ATTACK_MIN_DOT = 0.2; // roughly a 150-degree forward arc
export const INVULN_MS = 600;
export const KNOCKBACK_DIST = 1.2;
export const KNOCKBACK_MS = 220;
export const BASE_SPEED = 4.2;
export const SPRINT_SPEED = 6.6;
export const CATCHER_SPEED = 4.5;
export const DODGE_SPEED = 9;
export const DODGE_MS = 180;
export const DODGE_COOLDOWN_MS = 1500;
export const SPRINT_DRAIN_PER_S = 0.25; // stamina units per second while sprinting

export type PropId = "rod" | "hammer" | "slipper";
export const PROPS: Record<PropId, { damage: number; cooldownMs: number; label: string }> = {
  rod: { damage: 10, cooldownMs: 800, label: "Wooden rod" },
  hammer: { damage: 20, cooldownMs: 1400, label: "Hammer" },
  slipper: { damage: 10, cooldownMs: 600, label: "Slipper" },
};
export const PROP_IDS = Object.keys(PROPS) as PropId[];

export type Phase = "dice" | "playing" | "ended";
export type Role = "catcher" | "survivor";
export type Winner = "catcher" | "survivors";

export interface Input {
  dx: number; // -1..1
  dy: number; // -1..1
  sprint: boolean;
  dodge: boolean;
  attack: boolean;
  prop?: PropId;
}

export interface Fighter {
  id: string;
  name: string;
  isBot: boolean;
  role: Role;
  hp: number;
  pos: Vec2;
  facing: Vec2;
  prop: PropId | null;
  input: Input;
  stamina: number;
  knockedOut: boolean;
  invulnUntil: number;
  attackReadyAt: number;
  dodgeReadyAt: number;
  dodgeUntil: number;
  knockbackUntil: number;
  knockbackVel: Vec2;
  stats: { damageDealt: number; damageTaken: number; knockouts: number; survivedMs: number };
  koAt: number | null;
  placement: number | null;
}

export type MatchEvent =
  | { type: "dice_roll"; value: number; final: boolean }
  | { type: "catcher"; id: string }
  | { type: "attack"; by: string; target: string | null; prop: PropId }
  | { type: "damage"; target: string; amount: number; by: string; hp: number; x: number; y: number }
  | { type: "knockout"; id: string; by: string }
  | { type: "dodge"; id: string }
  | { type: "ended"; winner: Winner; reason: "all_knocked_out" | "timeout" };

export class MatchError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export interface PlayerSpec {
  id: string;
  name: string;
  isBot: boolean;
}

export class Match {
  phase: Phase = "dice";
  readonly fighters = new Map<string, Fighter>();
  private selections = new Map<string, number>();
  private events: MatchEvent[] = [];
  readonly rng: Rng;
  private clockMs = 0; // match-local time, advanced only by step()
  private pausedMs = 0;
  paused = false;
  catcherId: string | null = null;
  rolls: number[] = [];
  winner: Winner | null = null;
  endReason: "all_knocked_out" | "timeout" | null = null;
  private spawnOrder: Vec2[];

  constructor(specs: PlayerSpec[], rng: Rng = Math.random) {
    if (specs.length < 2 || specs.length > 6) throw new MatchError("INVALID_PLAYER_COUNT");
    this.rng = rng;
    this.spawnOrder = [...SPAWN_POINTS];
    specs.forEach((s, i) => {
      this.fighters.set(s.id, {
        id: s.id,
        name: s.name,
        isBot: s.isBot,
        role: "survivor",
        hp: MAX_HP,
        pos: { ...this.spawnOrder[i % this.spawnOrder.length] },
        facing: { x: 0, y: 1 },
        prop: null,
        input: emptyInput(),
        stamina: 1,
        knockedOut: false,
        invulnUntil: 0,
        attackReadyAt: 0,
        dodgeReadyAt: 0,
        dodgeUntil: 0,
        knockbackUntil: 0,
        knockbackVel: { x: 0, y: 0 },
        stats: { damageDealt: 0, damageTaken: 0, knockouts: 0, survivedMs: 0 },
        koAt: null,
        placement: null,
      });
    });
  }

  get matchTimeMs(): number {
    return this.clockMs;
  }

  get remainingMs(): number {
    return Math.max(0, MATCH_DURATION_MS - this.clockMs);
  }

  /** Secret dice selection. Only the chooser's own selection is stored. Never returned to others. */
  selectNumber(id: string, value: unknown): boolean {
    if (this.phase !== "dice") throw new MatchError("NOT_IN_DICE_PHASE");
    if (!this.fighters.has(id)) throw new MatchError("NOT_IN_MATCH");
    if (this.selections.has(id)) throw new MatchError("ALREADY_SELECTED");
    if (!validateSelection(value)) throw new MatchError("INVALID_SELECTION");
    this.selections.set(id, value);
    return this.allSelected();
  }

  allSelected(): boolean {
    return this.selections.size === this.fighters.size;
  }

  hasSelected(id: string): boolean {
    return this.selections.has(id);
  }

  selectedCount(): number {
    return this.selections.size;
  }

  /** Server-side roll. Emits one event per roll so clients can animate it. Resolves catcher. */
  resolveDice(): string {
    if (this.phase !== "dice") throw new MatchError("NOT_IN_DICE_PHASE");
    if (!this.allSelected()) throw new MatchError("SELECTIONS_INCOMPLETE");
    const { catcherId, rolls } = resolveCatcher(this.selections, this.rng);
    this.rolls = rolls;
    rolls.forEach((value, i) =>
      this.events.push({ type: "dice_roll", value, final: i === rolls.length - 1 }),
    );
    this.catcherId = catcherId;
    const catcher = this.fighters.get(catcherId)!;
    catcher.role = "catcher";
    catcher.prop = "rod";
    this.events.push({ type: "catcher", id: catcherId });
    this.phase = "playing";
    return catcherId;
  }

  setInput(id: string, raw: Partial<Input>): void {
    const f = this.fighters.get(id);
    if (!f || f.knockedOut || this.phase !== "playing") return;
    const dx = clamp(Number(raw.dx) || 0, -1, 1);
    const dy = clamp(Number(raw.dy) || 0, -1, 1);
    const len = Math.hypot(dx, dy);
    const nx = len > 1 ? dx / len : dx;
    const ny = len > 1 ? dy / len : dy;
    f.input = {
      dx: nx,
      dy: ny,
      sprint: !!raw.sprint,
      dodge: !!raw.dodge,
      attack: !!raw.attack,
      prop: raw.prop && PROP_IDS.includes(raw.prop) ? raw.prop : undefined,
    };
  }

  /** Prop switching is catcher-only (the survivors have no props). */
  switchProp(id: string, prop: unknown): void {
    const f = this.fighters.get(id);
    if (!f || f.role !== "catcher" || f.knockedOut) throw new MatchError("NOT_ALLOWED");
    if (typeof prop !== "string" || !PROP_IDS.includes(prop as PropId)) {
      throw new MatchError("INVALID_PROP");
    }
    f.prop = prop as PropId;
  }

  /**
   * Removes a human who never reconnected. Not counted as a knockout for anyone.
   * Ends the match if this leaves no survivors or no catcher.
   */
  forfeit(id: string): void {
    const f = this.fighters.get(id);
    if (!f || f.knockedOut || this.phase !== "playing") return;
    f.knockedOut = true;
    f.koAt = this.clockMs;
    f.input = emptyInput();
    this.checkEnd();
  }

  setPaused(paused: boolean): void {
    if (this.phase !== "playing") return;
    this.paused = paused;
  }

  /** Advances the simulation by dtMs of match time. Pauses freeze time. */
  step(dtMs: number, now: number = this.clockMs): void {
    if (this.phase !== "playing") return;
    if (this.paused) {
      this.pausedMs += dtMs;
      return;
    }
    const dt = Math.min(dtMs, 100) / 1000; // clamp to avoid tunnelling after stalls
    this.clockMs += dtMs;
    const t = this.clockMs;

    for (const f of this.fighters.values()) {
      if (f.knockedOut) continue;
      f.stats.survivedMs += dtMs;
      this.integrate(f, dt, t);
      const inp = f.input;
      if (inp.attack && f.role === "catcher") {
        f.input = { ...inp, attack: false };
        this.attack(f, t);
      }
    }

    if (this.checkEnd()) return;

    // Timer win: survivors win if they have at least one alive when time runs out.
    if (this.clockMs >= MATCH_DURATION_MS) {
      this.end("survivors", "timeout");
    }
  }

  private integrate(f: Fighter, dt: number, t: number): void {
    // Knockback displacement takes priority over input during its window.
    if (t < f.knockbackUntil) {
      const moved = moveWithCollision(f.pos, f.knockbackVel.x * dt, f.knockbackVel.y * dt);
      f.pos = moved;
      return;
    }

    const inp = f.input;
    let speed = f.role === "catcher" ? CATCHER_SPEED : BASE_SPEED;
    const moving = inp.dx !== 0 || inp.dy !== 0;

    if (inp.sprint && moving && f.stamina > 0 && f.role === "survivor") {
      speed = SPRINT_SPEED;
      f.stamina = Math.max(0, f.stamina - SPRINT_DRAIN_PER_S * dt);
    } else {
      f.stamina = Math.min(1, f.stamina + 0.15 * dt);
    }

    if (inp.dodge && t >= f.dodgeReadyAt && f.role === "survivor" && moving) {
      f.dodgeUntil = t + DODGE_MS;
      f.dodgeReadyAt = t + DODGE_COOLDOWN_MS;
      f.input = { ...inp, dodge: false };
      this.events.push({ type: "dodge", id: f.id });
    }
    if (t < f.dodgeUntil) speed = DODGE_SPEED;

    if (moving) {
      const sx = inp.dx * speed * dt;
      const sy = inp.dy * speed * dt;
      f.pos = moveWithCollision(f.pos, sx, sy);
      f.facing = { x: inp.dx, y: inp.dy };
    }
  }

  private attack(f: Fighter, t: number): void {
    if (!f.prop) return;
    if (t < f.attackReadyAt) return;
    const prop = PROPS[f.prop];
    f.attackReadyAt = t + prop.cooldownMs;

    // Server-side target selection: nearest survivor in range and forward arc with a clear body.
    let best: Fighter | null = null;
    let bestDist = Infinity;
    for (const o of this.fighters.values()) {
      if (o.id === f.id || o.knockedOut || o.role === "catcher") continue;
      if (t < o.invulnUntil) continue;
      const dx = o.pos.x - f.pos.x;
      const dy = o.pos.y - f.pos.y;
      const d = Math.hypot(dx, dy);
      if (d > ATTACK_RANGE || d === 0) continue;
      const dot = (dx / d) * f.facing.x + (dy / d) * f.facing.y;
      if (dot < ATTACK_MIN_DOT) continue;
      if (d < bestDist) {
        best = o;
        bestDist = d;
      }
    }

    this.events.push({ type: "attack", by: f.id, target: best ? best.id : null, prop: f.prop });
    if (!best) return;
    this.hit(best, f, prop.damage, t);
  }

  private hit(target: Fighter, by: Fighter, amount: number, t: number): void {
    target.hp = Math.max(0, target.hp - amount);
    target.invulnUntil = t + INVULN_MS;
    target.stats.damageTaken += amount;
    by.stats.damageDealt += amount;
    // Knockback directly away from the attacker.
    const dx = target.pos.x - by.pos.x;
    const dy = target.pos.y - by.pos.y;
    const d = Math.hypot(dx, dy) || 1;
    target.knockbackVel = { x: (dx / d) * (KNOCKBACK_DIST / (KNOCKBACK_MS / 1000)), y: (dy / d) * (KNOCKBACK_DIST / (KNOCKBACK_MS / 1000)) };
    target.knockbackUntil = t + KNOCKBACK_MS;
    this.events.push({ type: "damage", target: target.id, amount, by: by.id, hp: target.hp, x: target.pos.x, y: target.pos.y });

    if (target.hp === 0 && !target.knockedOut) {
      target.knockedOut = true;
      target.koAt = t;
      by.stats.knockouts += 1;
      this.events.push({ type: "knockout", id: target.id, by: by.id });
    }
  }

  private checkEnd(): boolean {
    const survivorsAlive = [...this.fighters.values()].filter(
      (f) => f.role === "survivor" && !f.knockedOut,
    );
    if (survivorsAlive.length === 0) {
      this.end("catcher", "all_knocked_out");
      return true;
    }
    return false;
  }

  private end(winner: Winner, reason: "all_knocked_out" | "timeout"): void {
    if (this.phase === "ended") return;
    this.phase = "ended";
    this.winner = winner;
    this.endReason = reason;
    // Placement: survivors still standing rank first, then knockouts by reverse KO time.
    const ordered = [...this.fighters.values()].sort((a, b) => {
      const aAlive = !a.knockedOut ? 1 : 0;
      const bAlive = !b.knockedOut ? 1 : 0;
      if (aAlive !== bAlive) return bAlive - aAlive;
      return (b.koAt ?? Infinity) - (a.koAt ?? Infinity);
    });
    ordered.forEach((f, i) => (f.placement = i + 1));
    this.events.push({ type: "ended", winner, reason });
  }

  drainEvents(): MatchEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  /** Public snapshot. Contains no secret selections. Own prop is shown only to its owner. */
  snapshot(viewerId: string | null) {
    return {
      phase: this.phase,
      catcherId: this.catcherId,
      remainingMs: this.remainingMs,
      paused: this.paused,
      winner: this.winner,
      endReason: this.endReason,
      players: [...this.fighters.values()].map((f) => ({
        id: f.id,
        name: f.name,
        isBot: f.isBot,
        role: f.role,
        hp: f.hp,
        x: round(f.pos.x),
        y: round(f.pos.y),
        facing: { x: round(f.facing.x), y: round(f.facing.y) },
        knockedOut: f.knockedOut,
        invulnerable: this.clockMs < f.invulnUntil,
        dodging: this.clockMs < f.dodgeUntil,
        prop: f.role === "catcher" || f.id === viewerId ? f.prop : null,
        stamina: round(f.stamina),
        placement: f.placement,
        stats: f.stats,
      })),
    };
  }
}

function emptyInput(): Input {
  return { dx: 0, dy: 0, sprint: false, dodge: false, attack: false };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

export { ARENA_SIZE, PLAYER_RADIUS };
