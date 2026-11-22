// PostgreSQL store tests against a real database. Set TEST_DATABASE_URL (e.g. postgres://user@127.0.0.1:5433/tps_test).
// Without it the suite is skipped, so the default test run needs no database.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { PostgresStore, type MatchResult } from "../src/store/store.ts";
import { PsqlCliClient, inlineParams, literal } from "../src/store/sql.ts";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const url = process.env.TEST_DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));

describe("SQL parameter inlining (no database needed)", () => {
  test("escapes quotes and inlines types correctly", () => {
    assert.equal(literal("O'Neil"), "'O''Neil'");
    assert.equal(literal(null), "NULL");
    assert.equal(literal(true), "TRUE");
    assert.equal(literal(3), "3");
    assert.equal(inlineParams("SELECT $1, $2", ["a'b", 2]), "SELECT 'a''b', 2");
  });

  test("does not touch placeholders inside string literals", () => {
    assert.equal(inlineParams("SELECT '$1', $1", ["x"]), "SELECT '$1', 'x'");
  });

  test("rejects non-finite numbers and missing parameters", () => {
    assert.throws(() => literal(Number.NaN));
    assert.throws(() => inlineParams("SELECT $2", ["only one"]));
  });
});

describe("PostgreSQL store", { skip: url ? false : "TEST_DATABASE_URL not set" }, () => {
  const db = url ? new PsqlCliClient(url) : (null as unknown as PsqlCliClient);
  const store = new PostgresStore(db);
  const ids = { a: "a".repeat(16), b: "b".repeat(16) };

  before(async () => {
    const schema = readFileSync(join(here, "..", "migrations", "001_init.sql"), "utf8");
    await db.batch([{ text: schema }]);
    await db.batch([{ text: `DELETE FROM match_players WHERE player_id IN ('${ids.a}','${ids.b}')` }, { text: `DELETE FROM players WHERE player_id IN ('${ids.a}','${ids.b}')` }]);
  });

  after(async () => {
    await db.batch([{ text: `DELETE FROM match_players WHERE player_id IN ('${ids.a}','${ids.b}')` }, { text: `DELETE FROM players WHERE player_id IN ('${ids.a}','${ids.b}')` }]);
  });

  const match = (matchId: string, winner: "catcher" | "survivors"): MatchResult => ({
    matchId,
    endedAt: new Date().toISOString(),
    winner,
    reason: winner === "catcher" ? "all_knocked_out" : "timeout",
    durationMs: 120000,
    players: [
      { playerId: ids.a, name: "Ana's", role: "survivor", knockouts: 0, damageDealt: 0, damageTaken: 30, survivedMs: 120000, placement: 1, won: winner === "survivors" },
      { playerId: ids.b, name: "Ben", role: "catcher", knockouts: 1, damageDealt: 30, damageTaken: 0, survivedMs: 120000, placement: 2, won: winner === "catcher" },
    ],
  });

  test("records a match and accumulates player statistics", async () => {
    // The before hook removed these players' rows, so counts start from zero.
    await store.recordMatch(match(randomUUID(), "survivors"));
    await store.recordMatch(match(randomUUID(), "catcher"));
    const a = (await store.getProfile(ids.a))!;
    const b = (await store.getProfile(ids.b))!;
    assert.equal(a.totalGames, 2);
    assert.equal(a.wins, 1);
    assert.equal(a.losses, 1);
    assert.equal(b.totalGames, 2);
    assert.equal(b.knockouts, 2);
    assert.equal(a.name, "Ana's", "names with apostrophes are stored safely");
  });

  test("replaying the same match id does not double count", async () => {
    const id = randomUUID();
    const before = (await store.getProfile(ids.b))!.totalGames;
    await store.recordMatch(match(id, "catcher"));
    await store.recordMatch(match(id, "catcher"));
    assert.equal((await store.getProfile(ids.b))!.totalGames, before + 1);
    const rows = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM match_players WHERE match_id = '${id}'`);
    assert.equal(Number(rows[0].n), 2, "exactly one row per player for the replayed match");
  });

  test("leaderboard is ordered by wins and matches are counted", async () => {
    const top = await store.topProfiles(50);
    for (let i = 1; i < top.length; i++) assert.ok(top[i - 1].wins >= top[i].wins);
    assert.ok((await store.matchCount()) >= 3, "all recorded matches are counted");
  });

  test("an unknown player has no profile", async () => {
    assert.equal(await store.getProfile("f".repeat(16)), null);
  });
});
