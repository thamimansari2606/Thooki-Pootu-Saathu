import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asRoomCode,
  asToken,
  asName,
  asInt,
  asDifficulty,
  asAxis,
  asAvatar,
  ValidationError,
  RateLimiter,
} from "../src/net/validate.ts";
import { MemoryStore, FileStore, applyResult, type MatchResult } from "../src/store/store.ts";

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return (e as ValidationError).code;
  }
}

describe("input validation", () => {
  test("room codes must be six allowed characters", () => {
    assert.equal(asRoomCode("abc234"), "ABC234");
    assert.equal(codeOf(() => asRoomCode("abc23")), "INVALID_ROOM_CODE");
    assert.equal(codeOf(() => asRoomCode("ABC0O1")), "INVALID_ROOM_CODE");
    assert.equal(codeOf(() => asRoomCode(42)), "INVALID_ROOM_CODE");
  });

  test("tokens must be 32 lowercase hex characters or absent", () => {
    assert.equal(asToken(undefined), null);
    assert.equal(asToken("a".repeat(32)), "a".repeat(32));
    assert.equal(codeOf(() => asToken("nope")), "INVALID_TOKEN");
    assert.equal(codeOf(() => asToken("A".repeat(32))), "INVALID_TOKEN");
  });

  test("names are trimmed, stripped of control and markup characters, and length-limited", () => {
    assert.equal(asName("  Ana<script>  "), "Anascript");
    assert.equal(asName("x".repeat(40)).length, 16);
    assert.equal(codeOf(() => asName("   ")), "INVALID_NAME");
    assert.equal(codeOf(() => asName(null)), "INVALID_NAME");
  });

  test("integers are range-checked", () => {
    assert.equal(asInt(3, 1, 5), 3);
    assert.equal(codeOf(() => asInt(6, 1, 5)), "INVALID_NUMBER");
    assert.equal(codeOf(() => asInt(2.5, 1, 5)), "INVALID_NUMBER");
    assert.equal(codeOf(() => asInt("3", 1, 5)), "INVALID_NUMBER");
  });

  test("difficulty must be a known value", () => {
    assert.equal(asDifficulty("hard"), "hard");
    assert.equal(codeOf(() => asDifficulty("insane")), "INVALID_DIFFICULTY");
  });

  test("axis input is clamped and non-numbers become zero", () => {
    assert.equal(asAxis(5), 1);
    assert.equal(asAxis(-9), -1);
    assert.equal(asAxis(NaN), 0);
    assert.equal(asAxis("1"), 0);
  });

  test("unknown avatars fall back to a default", () => {
    assert.equal(asAvatar("dragon"), "bear");
    assert.equal(asAvatar("fox"), "fox");
  });
});

describe("rate limiter", () => {
  test("allows a burst up to capacity then refuses until refilled", () => {
    const rl = new RateLimiter(3, 1, 0);
    assert.equal(rl.take(0), true);
    assert.equal(rl.take(0), true);
    assert.equal(rl.take(0), true);
    assert.equal(rl.take(0), false);
    assert.equal(rl.take(1000), true);
  });
});

describe("persistence", () => {
  const sample: MatchResult = {
    matchId: "11111111-1111-4111-8111-111111111111",
    endedAt: "2026-11-21T10:00:00.000Z",
    winner: "survivors",
    reason: "timeout",
    durationMs: 300000,
    players: [
      { playerId: "a".repeat(32), name: "Ana", role: "survivor", knockouts: 0, damageDealt: 0, damageTaken: 40, survivedMs: 300000, placement: 1, won: true },
      { playerId: "b".repeat(32), name: "Ben", role: "catcher", knockouts: 1, damageDealt: 40, damageTaken: 0, survivedMs: 300000, placement: 2, won: false },
    ],
  };

  test("a recorded match updates both players' profiles", async () => {
    const s = new MemoryStore();
    await s.recordMatch(sample);
    const ana = (await s.getProfile("a".repeat(32)))!;
    assert.equal(ana.totalGames, 1);
    assert.equal(ana.wins, 1);
    assert.equal(ana.losses, 0);
    const ben = (await s.getProfile("b".repeat(32)))!;
    assert.equal(ben.losses, 1);
    assert.equal(ben.knockouts, 1);
    assert.equal(await s.matchCount(), 1);
  });

  test("recording the same match twice does not double count", async () => {
    const s = new MemoryStore();
    await s.recordMatch(sample);
    await s.recordMatch(sample);
    assert.equal((await s.getProfile("a".repeat(32)))!.totalGames, 1);
    assert.equal(await s.matchCount(), 1);
  });

  test("applyResult is pure and does not mutate its input", () => {
    const before = { playerId: "x", name: "X", totalGames: 0, wins: 0, losses: 0, knockouts: 0, survivalMs: 0, lastPlayedAt: null };
    const after = applyResult(before, sample.players[0], sample.endedAt);
    assert.equal(before.totalGames, 0);
    assert.equal(after.totalGames, 1);
  });

  test("the file store persists profiles across reloads with an atomic write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tps-store-"));
    try {
      const path = join(dir, "data.json");
      const s1 = new FileStore(path);
      await s1.recordMatch(sample);
      const raw = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(raw.matches.length, 1);
      const s2 = new FileStore(path);
      assert.equal((await s2.getProfile("a".repeat(32)))!.wins, 1);
      assert.equal(await s2.matchCount(), 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("guests can play: profiles are created on first match with no registration", async () => {
    const s = new MemoryStore();
    assert.equal(await s.getProfile("c".repeat(32)), null);
    await s.recordMatch({ ...sample, matchId: "22222222-2222-4222-8222-222222222222", players: [{ ...sample.players[0], playerId: "c".repeat(32) }] });
    assert.ok(await s.getProfile("c".repeat(32)));
  });
});
