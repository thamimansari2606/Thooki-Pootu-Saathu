import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { worldToScreen, screenToWorld, screenDirToWorld, applyDeadzone } from "../src/game/iso.ts";
import { SnapshotBuffer, INTERP_DELAY_MS, type TimedSnapshot } from "../src/game/interpolation.ts";
import { buildIntent, keyCodeToAction, EMPTY_KEYS } from "../src/game/controls.ts";

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

describe("isometric projection", () => {
  test("world -> screen -> world round-trips", () => {
    for (const p of [{ x: 3, y: 9 }, { x: 0, y: 0 }, { x: 40, y: 12.5 }]) {
      const back = screenToWorld(worldToScreen(p));
      close(back.x, p.x);
      close(back.y, p.y);
    }
  });

  test("screen up maps to world diagonal toward the top corner, unit length", () => {
    const d = screenDirToWorld({ x: 0, y: -1 });
    close(Math.hypot(d.x, d.y), 1);
    assert.ok(d.x < 0 && d.y < 0, "up goes toward decreasing x and y");
  });

  test("screen right maps to world (+x, -y) direction", () => {
    const d = screenDirToWorld({ x: 1, y: 0 });
    assert.ok(d.x > 0 && d.y < 0);
  });

  test("zero direction stays zero", () => {
    assert.deepEqual(screenDirToWorld({ x: 0, y: 0 }), { x: 0, y: 0 });
  });

  test("joystick deadzone removes drift and scales to the unit circle", () => {
    assert.deepEqual(applyDeadzone({ x: 0.05, y: 0.05 }), { x: 0, y: 0 });
    const full = applyDeadzone({ x: 2, y: 0 });
    close(Math.hypot(full.x, full.y), 1);
  });
});

describe("snapshot interpolation", () => {
  const pose = (id: string, x: number) => ({
    id, x, y: 0, facing: { x: 1, y: 0 }, hp: 100, role: "survivor" as const, knockedOut: false,
    invulnerable: false, dodging: false, prop: null, name: id, isBot: false,
  });
  const snap = (at: number, x: number): TimedSnapshot => ({ at, players: [pose("a", x)], remainingMs: 0, phase: "playing", catcherId: null });

  test("blends between bracketing snapshots at the delayed render time", () => {
    const buf = new SnapshotBuffer();
    buf.push(snap(1000, 0));
    buf.push(snap(1100, 10));
    const out = buf.sample(1050 + INTERP_DELAY_MS)!;
    close(out[0].x, 5);
  });

  test("clamps to the newest snapshot when render time is ahead of data", () => {
    const buf = new SnapshotBuffer();
    buf.push(snap(1000, 0));
    buf.push(snap(1100, 10));
    assert.equal(buf.sample(9999)![0].x, 10);
  });

  test("returns null with no data and the single frame with one", () => {
    const buf = new SnapshotBuffer();
    assert.equal(buf.sample(0), null);
    buf.push(snap(0, 3));
    assert.equal(buf.sample(0)![0].x, 3);
  });

  test("ring buffer is bounded", () => {
    const buf = new SnapshotBuffer(5);
    for (let i = 0; i < 20; i++) buf.push(snap(i, i));
    assert.equal(buf.latest!.at, 19);
  });
});

describe("controls", () => {
  test("WASD and arrows map to the same actions", () => {
    assert.equal(keyCodeToAction("KeyW"), "up");
    assert.equal(keyCodeToAction("ArrowUp"), "up");
    assert.equal(keyCodeToAction("KeyD"), "right");
    assert.equal(keyCodeToAction("Space"), "dodge");
    assert.equal(keyCodeToAction("KeyQ"), null);
  });

  test("no keys and no stick means no movement", () => {
    const i = buildIntent(EMPTY_KEYS, null);
    assert.equal(i.dx, 0);
    assert.equal(i.dy, 0);
  });

  test("a held key produces a unit-length world direction", () => {
    const i = buildIntent({ ...EMPTY_KEYS, up: true }, null);
    close(Math.hypot(i.dx, i.dy), 1, 1e-6);
  });

  test("opposite keys cancel out", () => {
    const i = buildIntent({ ...EMPTY_KEYS, up: true, down: true }, null);
    assert.equal(i.dx, 0);
    assert.equal(i.dy, 0);
  });

  test("touch stick produces movement with sprint and attack flags passed through", () => {
    const i = buildIntent({ ...EMPTY_KEYS, sprint: true, attack: true }, { x: 1, y: 0 });
    assert.ok(Math.hypot(i.dx, i.dy) > 0.9);
    assert.equal(i.sprint, true);
    assert.equal(i.attack, true);
  });
});
