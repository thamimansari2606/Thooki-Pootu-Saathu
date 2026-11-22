// Local rule-based bot AI. Finite state machine + utility scoring + grid A* navigation +
// limited memory. Bots receive ONLY a perception view built from what a human could see
// (range and line-of-sight limited). They never receive dice selections or hidden players.
import {
  ARENA_SIZE,
  GRID_N,
  buildNavGrid,
  cellCenter,
  hasLineOfSight,
  isPositionFree,
  type Vec2,
} from "../../../shared/arena.ts";
import { findPath } from "../../../shared/pathfinding.ts";
import { ATTACK_RANGE, type Input, type PropId, type Role } from "../game/match.ts";

export type Personality = "runner" | "hider" | "dodger" | "brave" | "strategist";
export type Difficulty = "easy" | "medium" | "hard";
export const PERSONALITIES: Personality[] = ["runner", "hider", "dodger", "brave", "strategist"];
export const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];

export interface DifficultyProfile {
  perceptionRange: number; // metres
  reactionMs: number; // delay between re-deciding goals
  mistakeChance: number; // chance per decision of a misjudged move
  navNoise: number; // radians of heading jitter
  speedFactor: number; // multiplier applied to requested sprint/dodge effectiveness
}

export const DIFFICULTY_PROFILES: Record<Difficulty, DifficultyProfile> = {
  easy: { perceptionRange: 7, reactionMs: 900, mistakeChance: 0.2, navNoise: 0.4, speedFactor: 0.9 },
  medium: { perceptionRange: 10, reactionMs: 500, mistakeChance: 0.08, navNoise: 0.15, speedFactor: 1 },
  hard: { perceptionRange: 14, reactionMs: 220, mistakeChance: 0.02, navNoise: 0.03, speedFactor: 1 },
};

export interface Percept {
  id: string;
  x: number;
  y: number;
  role: Role;
  knockedOut: boolean;
}

export interface BotView {
  now: number; // match time in ms
  self: { id: string; x: number; y: number; role: Role; hp: number; prop: PropId | null; knockedOut: boolean };
  seen: Percept[]; // only players within the bot's perception range and line of sight
}

type State = "idle" | "search" | "flee" | "hide" | "dodge" | "distract" | "chase" | "attack" | "hesitate";

const DANGER_DECAY_MS = 6000;
const CATCHER_MEMORY_MS = 3000;

/** Builds a perception view for one observer. Used by the server for every bot. */
export function perceive(
  observer: { id: string; x: number; y: number; role: Role; hp: number; prop: PropId | null; knockedOut: boolean },
  others: Array<{ id: string; x: number; y: number; role: Role; knockedOut: boolean }>,
  rangeM: number,
  now: number,
): BotView {
  const seen: Percept[] = [];
  for (const o of others) {
    if (o.id === observer.id) continue;
    const d = Math.hypot(o.x - observer.x, o.y - observer.y);
    if (d > rangeM) continue;
    if (!hasLineOfSight({ x: observer.x, y: observer.y }, { x: o.x, y: o.y })) continue;
    seen.push({ id: o.id, x: o.x, y: o.y, role: o.role, knockedOut: o.knockedOut });
  }
  return { now, self: observer, seen };
}

interface Memory {
  dangerSpots: Array<{ x: number; y: number; t: number }>;
  catcher: { x: number; y: number; t: number } | null;
  lastSearchTarget: Vec2 | null;
  survivorSighting: { x: number; y: number; t: number } | null;
}

const BLOCK = 4; // metres per search block
const BLOCKS = Math.ceil(ARENA_SIZE / BLOCK);
const SIGHTING_MEMORY_MS = 8000;

export class Bot {
  readonly id: string;
  readonly name: string;
  readonly personality: Personality;
  readonly difficulty: Difficulty;
  readonly profile: DifficultyProfile;
  state: State = "idle";
  private rng: () => number;
  private nav: Uint8Array;
  private path: Vec2[] = [];
  private pathGoal: Vec2 | null = null;
  private pathBuiltAt = -Infinity;
  private nextDecisionAt = 0;
  private goal: Vec2 | null = null;
  private memory: Memory = { dangerSpots: [], catcher: null, lastSearchTarget: null, survivorSighting: null };
  private visits = new Float32Array(BLOCKS * BLOCKS);
  private heading: Vec2 = { x: 0, y: 0 };
  private hesitateUntil = 0;
  private mistakeUntil = 0;
  private mistakeDir: Vec2 = { x: 0, y: 0 };
  private dodgeFlipAt = 0;
  private dodgeSign = 1;
  private nextDodgeAt = 0;
  private distractUntil = 0;
  private nextDistractRollAt = 0;
  private attackPrimed = false;

  constructor(opts: { id: string; name: string; personality: Personality; difficulty: Difficulty; rng?: () => number }) {
    this.id = opts.id;
    this.name = opts.name;
    this.personality = opts.personality;
    this.difficulty = opts.difficulty;
    this.profile = DIFFICULTY_PROFILES[opts.difficulty];
    this.rng = opts.rng ?? Math.random;
    this.nav = buildNavGrid();
    // Each bot starts with a little personal variance so two bots never move identically.
    this.nextDecisionAt = this.rng() * this.profile.reactionMs;
  }

  /** Perception range in metres for this bot's difficulty. The server uses it when building views. */
  get perceptionRange(): number {
    return this.profile.perceptionRange;
  }

  think(view: BotView, dtMs: number): Partial<Input> {
    const self = view.self;
    if (self.knockedOut) return { dx: 0, dy: 0 };
    const me: Vec2 = { x: self.x, y: self.y };
    this.updateMemory(view, me);

    if (view.now >= this.nextDecisionAt) {
      this.nextDecisionAt = view.now + this.profile.reactionMs * (0.8 + this.rng() * 0.4);
      this.decide(view, me);
    }

    const out = this.execute(view, me, dtMs);
    if (self.role === "catcher" && this.attackPrimed && self.prop) {
      out.attack = true;
      out.prop = self.prop;
      this.attackPrimed = false;
    }
    return out;
  }

  private updateMemory(view: BotView, me: Vec2): void {
    const m = this.memory;
    const catcher = view.seen.find((p) => p.role === "catcher" && !p.knockedOut);
    if (catcher && view.self.role === "survivor") {
      m.catcher = { x: catcher.x, y: catcher.y, t: view.now };
      const last = m.dangerSpots[m.dangerSpots.length - 1];
      if (!last || Math.hypot(last.x - catcher.x, last.y - catcher.y) > 1.5) {
        m.dangerSpots.push({ x: catcher.x, y: catcher.y, t: view.now });
        if (m.dangerSpots.length > 8) m.dangerSpots.shift();
      }
    }
    m.dangerSpots = m.dangerSpots.filter((d) => view.now - d.t < DANGER_DECAY_MS);
    const bx = Math.min(BLOCKS - 1, Math.floor(me.x / BLOCK));
    const by = Math.min(BLOCKS - 1, Math.floor(me.y / BLOCK));
    this.visits[by * BLOCKS + bx] += 1;
    if (view.self.role === "catcher") {
      const hunted = view.seen.find((p) => p.role === "survivor" && !p.knockedOut);
      if (hunted) m.survivorSighting = { x: hunted.x, y: hunted.y, t: view.now };
    }
    if (m.survivorSighting && view.now - m.survivorSighting.t > SIGHTING_MEMORY_MS) m.survivorSighting = null;
    if (m.catcher && view.now - m.catcher.t > CATCHER_MEMORY_MS) m.catcher = null;
    void me;
  }

  private threatFrom(view: BotView): Vec2 | null {
    const c = view.seen.find((p) => p.role === "catcher" && !p.knockedOut);
    if (c) return { x: c.x, y: c.y };
    if (view.self.role === "survivor" && this.memory.catcher) return this.memory.catcher;
    return null;
  }

  private decide(view: BotView, me: Vec2): void {
    const self = view.self;
    const profile = this.profile;

    // Occasional misjudgement or hesitation (human-like).
    if (this.rng() < profile.mistakeChance) {
      const a = this.rng() * Math.PI * 2;
      this.mistakeDir = { x: Math.cos(a), y: Math.sin(a) };
      this.mistakeUntil = view.now + 400;
    }
    if (this.rng() < 0.05) this.hesitateUntil = view.now + 300;
    if (view.now < this.hesitateUntil) {
      this.state = "hesitate";
      this.goal = null;
      return;
    }

    if (self.role === "catcher") {
      this.decideCatcher(view, me);
      return;
    }

    const threat = this.threatFrom(view);
    const threatDist = threat ? Math.hypot(threat.x - me.x, threat.y - me.y) : Infinity;

    if (!threat) {
      this.state = "search";
      this.goal = this.pickSearchGoal(me, view.now);
      return;
    }

    switch (this.personality) {
      case "runner":
        this.state = "flee";
        this.goal = this.pickEscape(me, threat, 1);
        break;
      case "hider": {
        const hidden = this.isHiddenFrom(me, threat);
        if (hidden && threatDist > 3.5) {
          this.state = "hide";
          this.goal = null;
        } else {
          this.state = "hide";
          this.goal = this.pickHidingSpot(me, threat);
        }
        break;
      }
      case "dodger":
        if (threatDist < 3.2 && view.now >= this.nextDodgeAt) {
          this.state = "dodge";
          this.nextDodgeAt = view.now + 1400;
        } else if (threatDist < 6) {
          this.state = "dodge";
        } else {
          this.state = "flee";
        }
        this.goal = this.pickEscape(me, threat, 0.6);
        break;
      case "brave": {
        const risky = view.now >= this.nextDistractRollAt && threatDist < 9 && this.rng() < 0.25;
        this.nextDistractRollAt = view.now + 5000;
        if (risky || view.now < this.distractUntil) {
          if (view.now >= this.distractUntil) this.distractUntil = view.now + 2200;
          this.state = "distract";
          this.goal = threat;
        } else if (threatDist < 2.6) {
          this.state = "flee";
          this.goal = this.pickEscape(me, threat, 1.2);
        } else {
          this.state = "flee";
          this.goal = this.pickEscape(me, threat, 1);
        }
        break;
      }
      case "strategist": {
        const hidden = this.isHiddenFrom(me, threat);
        this.state = hidden && threatDist > 4 ? "hide" : "flee";
        this.goal = this.pickSafestSpot(me, threat, view.now);
        break;
      }
    }
  }

  private decideCatcher(view: BotView, me: Vec2): void {
    const targets = view.seen.filter((p) => p.role === "survivor" && !p.knockedOut);
    let target: Vec2 | null = null;
    if (targets.length > 0) {
      targets.sort((a, b) => dist(a, me) - dist(b, me));
      target = { x: targets[0].x, y: targets[0].y };
      this.memory.lastSearchTarget = null;
      this.memory.catcher = null;
    } else if (this.memory.survivorSighting) {
      // Investigate where a survivor was last seen, since they were probably hiding nearby.
      target = { x: this.memory.survivorSighting.x, y: this.memory.survivorSighting.y };
    } else if (this.memory.lastSearchTarget && dist(this.memory.lastSearchTarget, me) > 1.5) {
      target = this.memory.lastSearchTarget;
    } else {
      target = this.pickSearchGoal(me, view.now);
      this.memory.lastSearchTarget = target;
    }
    this.state = targets.length > 0 ? "chase" : "search";
    this.goal = target;

    if (targets.length > 0 && dist(targets[0], me) <= ATTACK_RANGE) {
      this.state = "attack";
      // Swing when in range; the server still validates range, arc, cooldown and invulnerability.
      if (this.rng() > this.profile.mistakeChance) this.attackPrimed = true;
    }
  }

  private execute(view: BotView, me: Vec2, dtMs: number): Partial<Input> {
    if (this.state === "hesitate" || view.now < this.hesitateUntil) return { dx: 0, dy: 0, sprint: false };
    if (this.state === "hide" && !this.goal) return { dx: 0, dy: 0, sprint: false };

    // Mistake: briefly wander the wrong way.
    if (view.now < this.mistakeUntil) {
      return { dx: this.mistakeDir.x * 0.7, dy: this.mistakeDir.y * 0.7, sprint: false };
    }

    // Dodge: zig-zag perpendicular to the threat with changing direction.
    if (this.state === "dodge" && view.now >= this.dodgeFlipAt) {
      this.dodgeFlipAt = view.now + 350 + this.rng() * 500;
      this.dodgeSign = this.rng() < 0.5 ? -1 : 1;
    }
    if (this.state === "dodge" && this.goal) {
      const g = this.goal;
      const dx = g.x - me.x;
      const dy = g.y - me.y;
      const len = Math.hypot(dx, dy) || 1;
      const perp = { x: -dy / len * this.dodgeSign, y: dx / len * this.dodgeSign };
      const out = this.steerTo(me, { x: me.x + perp.x * 2 + dx * 0.3, y: me.y + perp.y * 2 + dy * 0.3 }, dtMs, view.now);
      const dodgeNow = view.now < this.dodgeFlipAt - 100 && this.rng() < 0.02;
      return { ...out, dodge: dodgeNow, sprint: true };
    }

    if (!this.goal) return { dx: 0, dy: 0, sprint: false };

    const sprint = (this.state === "flee" || this.state === "distract") && this.difficulty !== "easy";
    const out = this.steerTo(me, this.goal, dtMs, view.now);

    return { ...out, sprint };
  }

  /** Follows an A* path to the goal, with smoothed heading and profile-based navigation noise. */
  private steerTo(me: Vec2, goal: Vec2, dtMs: number, now: number): Partial<Input> {
    if (dist(me, goal) < 0.4) {
      this.path = [];
      return { dx: 0, dy: 0 };
    }
    const needRebuild =
      this.path.length === 0 ||
      !this.pathGoal ||
      dist(this.pathGoal, goal) > 1.5 ||
      now - this.pathBuiltAt > 1200;
    if (needRebuild) {
      const p = findPath(this.nav, me, goal);
      this.path = p ?? [];
      this.pathGoal = { ...goal };
      this.pathBuiltAt = now;
    }
    while (this.path.length > 0 && dist(this.path[0], me) < 0.45) this.path.shift();
    const next = this.path[0] ?? goal;

    let dx = next.x - me.x;
    let dy = next.y - me.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;

    // Navigation noise: a bounded random heading jitter, so paths are never identical.
    const jitter = (this.rng() * 2 - 1) * this.profile.navNoise;
    const cos = Math.cos(jitter);
    const sin = Math.sin(jitter);
    const ndx = dx * cos - dy * sin;
    const ndy = dx * sin + dy * cos;

    // Smooth turning: move the heading toward the desired direction at a bounded rate.
    const maxTurn = (dtMs / 1000) * 6; // rad/s-ish blending factor
    const h = this.heading;
    const blend = Math.min(1, maxTurn);
    const hx = h.x * (1 - blend) + ndx * blend;
    const hy = h.y * (1 - blend) + ndy * blend;
    const hl = Math.hypot(hx, hy) || 1;
    this.heading = { x: hx / hl, y: hy / hl };
    return { dx: this.heading.x, dy: this.heading.y };
  }

  private pickEscape(me: Vec2, threat: Vec2, weight: number): Vec2 {
    const candidates: Vec2[] = [];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      for (const r of [4, 7, 10]) {
        const p = { x: me.x + Math.cos(a) * r, y: me.y + Math.sin(a) * r };
        if (isPositionFree(p)) candidates.push(p);
      }
    }
    let best: Vec2 | null = null;
    let bestScore = -Infinity;
    for (const c of candidates) {
      let score = dist(c, threat) * 1.2 * weight;
      score -= dist(c, me) * 0.2;
      if (!hasLineOfSight(c, threat)) score += 4;
      score -= this.dangerPenalty(c);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best ?? me;
  }

  private pickHidingSpot(me: Vec2, threat: Vec2): Vec2 {
    let best: Vec2 | null = null;
    let bestScore = -Infinity;
    for (let row = 0; row < GRID_N; row += 2) {
      for (let col = 0; col < GRID_N; col += 2) {
        const c = cellCenter(col, row);
        if (dist(c, me) > 9) continue;
        if (!isPositionFree(c)) continue;
        const hidden = !hasLineOfSight(c, threat);
        const score = (hidden ? 30 : 0) + dist(c, threat) * 0.8 - dist(c, me) * 0.6 - this.dangerPenalty(c);
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
    }
    return best ?? me;
  }

  private pickSafestSpot(me: Vec2, threat: Vec2, now: number): Vec2 {
    void now;
    const hide = this.pickHidingSpot(me, threat);
    const esc = this.pickEscape(me, threat, 1);
    return this.dangerPenalty(hide) < this.dangerPenalty(esc) ? hide : esc;
  }

  private pickSearchGoal(me: Vec2, now: number): Vec2 {
    void now;
    // Systematic coverage: sample open points and prefer blocks visited least often,
    // at a useful distance, with a little randomness so routes differ between bots.
    let best: Vec2 | null = null;
    let bestScore = -Infinity;
    for (let i = 0; i < 40; i++) {
      const p = { x: 2 + this.rng() * (ARENA_SIZE - 4), y: 2 + this.rng() * (ARENA_SIZE - 4) };
      if (!isPositionFree(p)) continue;
      const bx = Math.min(BLOCKS - 1, Math.floor(p.x / BLOCK));
      const by = Math.min(BLOCKS - 1, Math.floor(p.y / BLOCK));
      const d = dist(p, me);
      const score = -this.visits[by * BLOCKS + bx] * 2 - Math.abs(d - 12) * 0.15 + this.rng() * 1.5;
      if (d > 4 && score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    return best ?? me;
  }

  private isHiddenFrom(me: Vec2, threat: Vec2): boolean {
    return !hasLineOfSight(me, threat);
  }

  private dangerPenalty(p: Vec2): number {
    let pen = 0;
    for (const d of this.memory.dangerSpots) {
      const r = dist(p, d);
      if (r < 3) pen += (3 - r) * 2;
    }
    return pen;
  }
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

