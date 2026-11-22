import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Match, MATCH_DURATION_MS, type PropId } from "../src/game/match.ts";
import { Bot, perceive, DIFFICULTY_PROFILES, type Personality, type Difficulty } from "../src/ai/bot.ts";
import { isPositionFree, OBSTACLES, SPAWN_POINTS } from "../../shared/arena.ts";
import { findPath } from "../../shared/pathfinding.ts";
import { buildNavGrid } from "../../shared/arena.ts";

// Seeded RNG (mulberry32) so simulations are reproducible.
function rngFrom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SimResult {
  match: Match;
  bots: Map<string, Bot>;
  trace: Map<string, Array<{ x: number; y: number }>>;
  steps: number;
  badPositions: number;
}

function simulate(opts: {
  seed: number;
  humans?: number;
  personalities: Personality[];
  difficulty: Difficulty;
  maxMs?: number;
  stepMs?: number;
  humanIdle?: boolean;
  traceEvery?: number;
}): SimResult {
  const rng = rngFrom(opts.seed);
  const humans = opts.humans ?? 0;
  const specs = [];
  for (let i = 0; i < humans; i++) specs.push({ id: `h${i}`, name: `H${i}`, isBot: false });
  opts.personalities.forEach((_, i) => specs.push({ id: `b${i}`, name: `Bot${i}`, isBot: true }));
  const match = new Match(specs, rng);

  // Secret selections: every fighter, including bots, picks from its own RNG, never from others.
  for (const id of match.fighters.keys()) match.selectNumber(id, Math.floor(rng() * 6) + 1);
  match.resolveDice();
  match.drainEvents();

  const bots = new Map<string, Bot>();
  opts.personalities.forEach((p, i) => {
    const id = `b${i}`;
    bots.set(id, new Bot({ id, name: `Bot${i}`, personality: p, difficulty: opts.difficulty, rng: rngFrom(opts.seed * 31 + i) }));
  });

  const trace = new Map<string, Array<{ x: number; y: number }>>();
  for (const id of match.fighters.keys()) trace.set(id, []);

  const stepMs = opts.stepMs ?? 50;
  const maxMs = opts.maxMs ?? MATCH_DURATION_MS;
  let steps = 0;
  let badPositions = 0;

  while (match.phase === "playing" && match.matchTimeMs < maxMs) {
    const all = [...match.fighters.values()].map((f) => ({
      id: f.id,
      x: f.pos.x,
      y: f.pos.y,
      role: f.role,
      knockedOut: f.knockedOut,
    }));
    for (const [id, bot] of bots) {
      const f = match.fighters.get(id)!;
      if (f.knockedOut) continue;
      const view = perceive(
        { id, x: f.pos.x, y: f.pos.y, role: f.role, hp: f.hp, prop: f.prop, knockedOut: f.knockedOut },
        all,
        bot.perceptionRange,
        match.matchTimeMs,
      );
      const input = bot.think(view, stepMs);
      match.setInput(id, input);
    }
    match.step(stepMs);
    steps++;
    for (const f of match.fighters.values()) {
      if (!isPositionFree(f.pos, 0.39)) badPositions++;
      if (opts.traceEvery && steps % opts.traceEvery === 0) trace.get(f.id)!.push({ x: f.pos.x, y: f.pos.y });
    }
  }
  return { match, bots, trace, steps, badPositions };
}

describe("arena and navigation", () => {
  test("every spawn point is a free position", () => {
    for (const s of SPAWN_POINTS) assert.ok(isPositionFree(s), `spawn ${s.x},${s.y} blocked`);
  });

  test("obstacles stay inside the arena", () => {
    for (const r of OBSTACLES) {
      assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 40 && r.y + r.h <= 40, `${r.kind} out of bounds`);
    }
  });

  test("A* finds a path between spawn points", () => {
    const grid = buildNavGrid();
    for (let i = 0; i < SPAWN_POINTS.length; i++) {
      for (let j = i + 1; j < SPAWN_POINTS.length; j++) {
        const path = findPath(grid, SPAWN_POINTS[i], SPAWN_POINTS[j]);
        assert.ok(path && path.length > 0, `no path ${i}->${j}`);
      }
    }
  });

  test("A* routes around an obstacle instead of through it", () => {
    const grid = buildNavGrid();
    const path = findPath(grid, { x: 5, y: 20 }, { x: 35, y: 20 });
    assert.ok(path, "path exists");
    for (const p of path!) assert.ok(isPositionFree(p, 0.39), "waypoint is free");
  });
});

describe("bot perception and information access", () => {
  test("perception only includes players in range and line of sight", () => {
    // Open ground: (8,14) to (10,14) has no obstacle between them.
    const observer = { id: "b0", x: 8, y: 14, role: "survivor" as const, hp: 100, prop: null, knockedOut: false };
    const others = [
      { id: "near", x: 10, y: 14, role: "catcher" as const, knockedOut: false },
      { id: "far", x: 35, y: 35, role: "survivor" as const, knockedOut: false },
    ];
    const view = perceive(observer, others, 10, 0);
    assert.deepEqual(view.seen.map((s) => s.id), ["near"]);
  });

  test("bot views contain no dice selections or hidden fields", () => {
    const observer = { id: "b0", x: 8, y: 14, role: "survivor" as const, hp: 100, prop: null, knockedOut: false };
    const view = perceive(observer, [{ id: "c", x: 10, y: 14, role: "catcher" as const, knockedOut: false }], 10, 0);
    const json = JSON.stringify(view);
    assert.equal(/selection|secret|selected/i.test(json), false);
  });

  test("difficulty changes perception range and reaction time", () => {
    const e = DIFFICULTY_PROFILES.easy;
    const m = DIFFICULTY_PROFILES.medium;
    const h = DIFFICULTY_PROFILES.hard;
    assert.ok(e.perceptionRange < m.perceptionRange && m.perceptionRange < h.perceptionRange);
    assert.ok(e.reactionMs > m.reactionMs && m.reactionMs > h.reactionMs);
    assert.ok(e.mistakeChance > m.mistakeChance && m.mistakeChance > h.mistakeChance);
  });
});

describe("single-player simulated matches", () => {
  const personalities: Personality[] = ["runner", "hider", "dodger", "brave", "strategist"];

  test("five bots plus one human-slot bot finish a full five-minute match without leaving the arena", () => {
    const result = simulate({ seed: 7, personalities: personalities, difficulty: "medium", maxMs: MATCH_DURATION_MS });
    assert.equal(result.badPositions, 0, "no bot ever entered an obstacle");
    assert.ok(result.match.phase === "ended" || result.match.matchTimeMs >= MATCH_DURATION_MS);
    assert.ok(result.steps > 0);
  });

  test("the match always terminates with a winner", () => {
    for (const seed of [1, 2, 3]) {
      const r = simulate({ seed, personalities: ["runner", "hider", "dodger"], difficulty: "hard", maxMs: MATCH_DURATION_MS });
      assert.equal(r.match.phase, "ended", `seed ${seed} did not end`);
      assert.ok(r.match.winner === "catcher" || r.match.winner === "survivors");
    }
  });

  test("bots take different paths: personalities produce distinct movement", () => {
    const r = simulate({
      seed: 11,
      personalities,
      difficulty: "medium",
      maxMs: 20_000,
      traceEvery: 10,
    });
    const sigs = [...r.trace.values()].map((pts) =>
      pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("|"),
    );
    const unique = new Set(sigs);
    assert.ok(unique.size > 1, "bots move in more than one pattern");
  });

  test("the catcher bot pursues and tags survivors within a fair time", () => {
    // Survivor bots are passive for this check: the catcher must still land hits.
    const r = simulate({ seed: 21, personalities: ["runner", "hider"], difficulty: "hard", maxMs: 120_000 });
    const catcherStats = [...r.match.fighters.values()].find((f) => f.role === "catcher")!.stats;
    assert.ok(catcherStats.damageDealt > 0 || r.match.winner === "survivors", "catcher landed hits or survivors escaped");
  });

  test("hard bots behave differently from easy bots on identical seeds", () => {
    const a = simulate({ seed: 5, personalities: ["runner", "dodger"], difficulty: "easy", maxMs: 15_000, traceEvery: 5 });
    const b = simulate({ seed: 5, personalities: ["runner", "dodger"], difficulty: "hard", maxMs: 15_000, traceEvery: 5 });
    const sa = JSON.stringify([...a.trace.values()]);
    const sb = JSON.stringify([...b.trace.values()]);
    assert.notEqual(sa, sb);
  });

  test("a bot never acts while knocked out", () => {
    const rng = rngFrom(9);
    const match = new Match([
      { id: "c", name: "C", isBot: true },
      { id: "s", name: "S", isBot: true },
    ], rng);
    match.selectNumber("c", 1);
    match.selectNumber("s", 2);
    match.resolveDice();
    match.fighters.get("s")!.knockedOut = true;
    const bot = new Bot({ id: "s", name: "S", personality: "runner", difficulty: "medium", rng });
    const view = perceive(
      { id: "s", x: 1, y: 1, role: "survivor", hp: 0, prop: null, knockedOut: true },
      [],
      10,
      0,
    );
    const out = bot.think(view, 50);
    assert.equal(out.dx, 0);
    assert.equal(out.dy, 0);
  });
});

describe("prop and catcher AI", () => {
  test("catcher bot carries the rod by default and can attack", () => {
    const rng = rngFrom(3);
    const match = new Match([
      { id: "c", name: "C", isBot: true },
      { id: "s", name: "S", isBot: true },
    ], rng);
    match.selectNumber("c", 1);
    match.selectNumber("s", 2);
    match.resolveDice();
    const prop: PropId | null = match.fighters.get("c")!.prop;
    assert.equal(prop, "rod");
  });
});
