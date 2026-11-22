import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  Match,
  MatchError,
  MATCH_DURATION_MS,
  MAX_HP,
  PROPS,
  INVULN_MS,
  DODGE_COOLDOWN_MS,
} from "../src/game/match.ts";
import { OBSTACLES } from "../../shared/arena.ts";

// Deterministic RNG: returns the given sequence repeatedly.
function seq(values: number[]): () => number {
  let i = 0;
  return () => {
    const v = values[i % values.length];
    i++;
    return v;
  };
}

// A die face d (1..6) corresponds to rng value in [(d-1)/6, d/6).
const face = (d: number) => (d - 1) / 6 + 0.01;

function startedMatch(n = 3, rolls: number[] = [face(4), 0.5]) {
  const specs = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, isBot: false }));
  const m = new Match(specs, seq(rolls));
  return m;
}

function selectAll(m: Match, values: number[]) {
  [...m.fighters.keys()].forEach((id, i) => m.selectNumber(id, values[i]));
}

/** Puts two fighters in an open area facing each other at a fixed distance. */
function place(m: Match, attackerId: string, targetId: string, dist = 1.2) {
  const a = m.fighters.get(attackerId)!;
  const b = m.fighters.get(targetId)!;
  a.pos = { x: 20, y: 20 };
  b.pos = { x: 20 + dist, y: 20 };
  a.facing = { x: 1, y: 0 };
  // Keep the arena from teleporting survivors back out of range during the test.
  void OBSTACLES;
}

describe("secret dice selection", () => {
  test("selections are stored per player and reject a second choice", () => {
    const m = startedMatch(3);
    m.selectNumber("p0", 2);
    assert.throws(() => m.selectNumber("p0", 5), (e) => e instanceof MatchError && e.code === "ALREADY_SELECTED");
  });

  test("invalid numbers are rejected", () => {
    const m = startedMatch(2);
    for (const bad of [0, 7, 2.5, "3", null]) {
      assert.throws(() => m.selectNumber("p0", bad), (e) => e instanceof MatchError && e.code === "INVALID_SELECTION");
    }
  });

  test("snapshot never exposes other players' selections", () => {
    const m = startedMatch(3);
    m.selectNumber("p0", 6);
    const snap = JSON.stringify(m.snapshot("p1"));
    assert.equal(snap.includes("selection"), false);
    assert.equal(m.hasSelected("p0"), true);
  });

  test("dice cannot resolve until every fighter has selected", () => {
    const m = startedMatch(3);
    m.selectNumber("p0", 1);
    m.selectNumber("p1", 2);
    assert.throws(() => m.resolveDice(), (e) => e instanceof MatchError && e.code === "SELECTIONS_INCOMPLETE");
  });

  test("rerolls until a number matches, then reveals the catcher and gives props", () => {
    // Players pick 4, 5 and 6. Rolls are 1, 2, 4 -> 4 matches p0.
    const m = startedMatch(3, [face(1), face(2), face(4), 0.9]);
    selectAll(m, [4, 5, 6]);
    const catcher = m.resolveDice();
    assert.deepEqual(m.rolls, [1, 2, 4]);
    assert.equal(catcher, "p0");
    assert.equal(m.phase, "playing");
    assert.equal(m.fighters.get("p0")!.role, "catcher");
    assert.equal(m.fighters.get("p0")!.prop, "rod");
    const events = m.drainEvents();
    assert.equal(events.filter((e) => e.type === "dice_roll").length, 3);
    assert.ok(events.some((e) => e.type === "catcher" && e.id === "p0"));
  });

  test("multiple matching selectors: one is chosen at random among them", () => {
    const m = startedMatch(3, [face(3), 0.0]);
    selectAll(m, [3, 3, 6]);
    const catcher = m.resolveDice();
    assert.equal(catcher, "p0");
    const m2 = startedMatch(3, [face(3), 0.99]);
    selectAll(m2, [3, 3, 6]);
    assert.equal(m2.resolveDice(), "p1");
  });
});

describe("combat, props and health", () => {
  function playingWithCatcher() {
    const m = startedMatch(3, [face(4), 0.5]);
    selectAll(m, [4, 1, 2]);
    m.resolveDice();
    m.drainEvents();
    return m;
  }

  test("catcher hits a survivor in range, applying prop damage", () => {
    const m = playingWithCatcher();
    place(m, "p0", "p1", 1.2);
    m.setInput("p0", { attack: true });
    m.step(16);
    const target = m.fighters.get("p1")!;
    assert.equal(target.hp, MAX_HP - PROPS.rod.damage);
    assert.equal(m.fighters.get("p0")!.stats.damageDealt, PROPS.rod.damage);
  });

  test("attacks miss a target out of range", () => {
    const m = playingWithCatcher();
    place(m, "p0", "p1", 3);
    m.setInput("p0", { attack: true });
    m.step(16);
    assert.equal(m.fighters.get("p1")!.hp, MAX_HP);
  });

  test("attacks miss a target outside the forward arc", () => {
    const m = playingWithCatcher();
    place(m, "p0", "p1", 1.0);
    m.fighters.get("p0")!.facing = { x: -1, y: 0 };
    m.setInput("p0", { attack: true });
    m.step(16);
    assert.equal(m.fighters.get("p1")!.hp, MAX_HP);
  });

  test("attack cooldown blocks a second swing until it elapses", () => {
    const m = playingWithCatcher();
    place(m, "p0", "p1", 1.0);
    m.setInput("p0", { attack: true });
    m.step(16);
    const afterFirst = m.fighters.get("p1")!.hp;
    // Respect invulnerability so the next hit is not suppressed by it.
    m.fighters.get("p1")!.invulnUntil = 0;
    m.setInput("p0", { attack: true });
    m.step(16);
    assert.equal(m.fighters.get("p1")!.hp, afterFirst, "cooldown should block");
    m.step(PROPS.rod.cooldownMs);
    m.fighters.get("p1")!.invulnUntil = 0;
    m.setInput("p0", { attack: true });
    m.step(16);
    assert.ok(m.fighters.get("p1")!.hp < afterFirst, "swing after cooldown should land");
  });

  test("temporary invulnerability blocks back-to-back hits", () => {
    const m = playingWithCatcher();
    place(m, "p0", "p1", 1.0);
    m.setInput("p0", { attack: true });
    m.step(16);
    const hp = m.fighters.get("p1")!.hp;
    m.fighters.get("p0")!.attackReadyAt = 0;
    m.setInput("p0", { attack: true });
    m.step(16);
    assert.equal(m.fighters.get("p1")!.hp, hp, "target still invulnerable");
    assert.ok(m.fighters.get("p1")!.invulnUntil > m.matchTimeMs);
    void INVULN_MS;
  });

  test("hammer deals 20 and slipper deals 10", () => {
    const m = playingWithCatcher();
    place(m, "p0", "p1", 1.0);
    m.switchProp("p0", "hammer");
    m.setInput("p0", { attack: true });
    m.step(16);
    assert.equal(m.fighters.get("p1")!.hp, MAX_HP - 20);
    const m2 = playingWithCatcher();
    place(m2, "p0", "p1", 1.0);
    m2.switchProp("p0", "slipper");
    m2.setInput("p0", { attack: true });
    m2.step(16);
    assert.equal(m2.fighters.get("p1")!.hp, MAX_HP - 10);
  });

  test("survivors cannot attack and cannot switch props", () => {
    const m = playingWithCatcher();
    place(m, "p1", "p2", 1.0);
    m.setInput("p1", { attack: true });
    m.step(16);
    assert.equal(m.fighters.get("p2")!.hp, MAX_HP);
    assert.throws(() => m.switchProp("p1", "hammer"), (e) => e instanceof MatchError && e.code === "NOT_ALLOWED");
  });

  test("invalid prop switch is rejected", () => {
    const m = playingWithCatcher();
    assert.throws(() => m.switchProp("p0", "bazooka"), (e) => e instanceof MatchError && e.code === "INVALID_PROP");
  });

  test("knockback pushes the target away from the attacker", () => {
    const m = playingWithCatcher();
    place(m, "p0", "p1", 1.0);
    const before = m.fighters.get("p1")!.pos.x;
    m.setInput("p0", { attack: true });
    m.step(16);
    m.step(100);
    assert.ok(m.fighters.get("p1")!.pos.x > before, "pushed in +x away from catcher");
  });

  test("knockout at zero HP removes the survivor and counts it for the catcher", () => {
    const m = playingWithCatcher();
    const target = m.fighters.get("p1")!;
    target.hp = 10;
    place(m, "p0", "p1", 1.0);
    m.setInput("p0", { attack: true });
    m.step(16);
    assert.equal(target.hp, 0);
    assert.equal(target.knockedOut, true);
    assert.equal(m.fighters.get("p0")!.stats.knockouts, 1);
    const events = m.drainEvents();
    assert.ok(events.some((e) => e.type === "knockout" && e.id === "p1"));
  });

  test("knocked-out players cannot move or act", () => {
    const m = playingWithCatcher();
    const f = m.fighters.get("p1")!;
    f.knockedOut = true;
    const pos = { ...f.pos };
    m.setInput("p1", { dx: 1, dy: 0 });
    m.step(500);
    assert.deepEqual(f.pos, pos);
  });
});

describe("movement and dodge", () => {
  test("diagonal input is normalised so diagonal is not faster", () => {
    const m = startedMatch(2, [face(1), 0.5]);
    selectAll(m, [1, 2]);
    m.resolveDice();
    const f = m.fighters.get("p0")!;
    f.pos = { x: 10, y: 10 };
    m.setInput("p0", { dx: 1, dy: 1 });
    m.step(100);
    const moved = Math.hypot(f.pos.x - 10, f.pos.y - 10);
    assert.ok(moved <= 4.2 * 0.1 + 0.001, `moved ${moved}`);
  });

  test("movement never passes through an obstacle", () => {
    const m = startedMatch(2, [face(1), 0.5]);
    selectAll(m, [1, 2]);
    m.resolveDice();
    const f = m.fighters.get("p0")!;
    const wall = OBSTACLES.find((r) => r.kind === "building")!;
    f.pos = { x: wall.x - 1, y: wall.y + wall.h / 2 };
    m.setInput("p0", { dx: 1, dy: 0 });
    for (let i = 0; i < 50; i++) m.step(50);
    assert.ok(f.pos.x < wall.x, "blocked by the building");
  });

  test("dodge is a burst with a cooldown", () => {
    const m = startedMatch(2, [face(1), 0.5]);
    selectAll(m, [1, 2]);
    m.resolveDice();
    m.drainEvents();
    const f = m.fighters.get("p1")!;
    f.pos = { x: 10, y: 10 };
    m.setInput("p1", { dx: 1, dy: 0, dodge: true });
    m.step(50);
    assert.ok(m.drainEvents().some((e) => e.type === "dodge"));
    m.setInput("p1", { dx: 1, dy: 0, dodge: true });
    m.step(50);
    assert.equal(m.drainEvents().filter((e) => e.type === "dodge").length, 0, "cooldown");
    void DODGE_COOLDOWN_MS;
  });
});

describe("timer and victory conditions", () => {
  test("catcher wins when every survivor is knocked out", () => {
    const m = startedMatch(3, [face(4), 0.5]);
    selectAll(m, [4, 1, 2]);
    m.resolveDice();
    m.fighters.get("p1")!.knockedOut = true;
    m.fighters.get("p1")!.hp = 0;
    m.fighters.get("p2")!.hp = 1;
    place(m, "p0", "p2", 1.0);
    m.setInput("p0", { attack: true });
    m.step(16);
    assert.equal(m.phase, "ended");
    assert.equal(m.winner, "catcher");
    assert.equal(m.endReason, "all_knocked_out");
  });

  test("survivors win when the timer reaches five minutes with a survivor left", () => {
    const m = startedMatch(3, [face(4), 0.5]);
    selectAll(m, [4, 1, 2]);
    m.resolveDice();
    m.step(MATCH_DURATION_MS - 1000);
    assert.equal(m.phase, "playing");
    m.step(1000);
    assert.equal(m.phase, "ended");
    assert.equal(m.winner, "survivors");
    assert.equal(m.endReason, "timeout");
  });

  test("the match lasts exactly five minutes of match time", () => {
    const m = startedMatch(2, [face(1), 0.5]);
    selectAll(m, [1, 2]);
    m.resolveDice();
    assert.equal(m.remainingMs, MATCH_DURATION_MS);
    m.step(1000);
    assert.equal(m.remainingMs, MATCH_DURATION_MS - 1000);
  });

  test("pause freezes the timer and movement", () => {
    const m = startedMatch(2, [face(1), 0.5]);
    selectAll(m, [1, 2]);
    m.resolveDice();
    m.setPaused(true);
    m.step(10_000);
    assert.equal(m.remainingMs, MATCH_DURATION_MS);
    m.setPaused(false);
    m.step(1000);
    assert.equal(m.remainingMs, MATCH_DURATION_MS - 1000);
  });

  test("placements are assigned at the end, survivors first", () => {
    const m = startedMatch(3, [face(4), 0.5]);
    selectAll(m, [4, 1, 2]);
    m.resolveDice();
    m.fighters.get("p1")!.knockedOut = true;
    m.fighters.get("p1")!.hp = 0;
    m.fighters.get("p1")!.koAt = 5;
    m.step(MATCH_DURATION_MS);
    // Standing players (catcher p0 and survivor p2) rank above the knocked-out p1.
    assert.ok(m.fighters.get("p0")!.placement! <= 2);
    assert.ok(m.fighters.get("p2")!.placement! <= 2);
    assert.equal(m.fighters.get("p1")!.placement, 3);
  });

  test("a match cannot be ended twice", () => {
    const m = startedMatch(2, [face(1), 0.5]);
    selectAll(m, [1, 2]);
    m.resolveDice();
    m.step(MATCH_DURATION_MS);
    const events = m.drainEvents().filter((e) => e.type === "ended");
    m.step(1000);
    assert.equal(m.drainEvents().filter((e) => e.type === "ended").length, 0);
    assert.equal(events.length, 1);
  });

  test("the full player count must be between 2 and 6", () => {
    assert.throws(() => new Match([{ id: "a", name: "a", isBot: false }]), (e) => e instanceof MatchError);
    const six = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, isBot: false }));
    assert.equal(new Match(six).fighters.size, 6);
    const seven = Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, isBot: false }));
    assert.throws(() => new Match(seven), (e) => e instanceof MatchError);
  });
});

describe("forfeit", () => {
  test("a forfeiting survivor is out, is not credited as a knockout, and can end the match", () => {
    const m = startedMatch(2, [face(1), 0.5]);
    selectAll(m, [1, 2]);
    m.resolveDice();
    m.drainEvents();
    m.forfeit("p1");
    assert.equal(m.fighters.get("p1")!.knockedOut, true);
    assert.equal(m.fighters.get("p0")!.stats.knockouts, 0);
    assert.equal(m.phase, "ended");
    assert.equal(m.winner, "catcher");
  });
});
