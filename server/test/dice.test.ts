import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCatcher, validateSelection } from "../src/game/dice.ts";

function seq(values: number[]): () => number {
  let i = 0;
  return () => {
    const v = values[i % values.length];
    i++;
    // map integer die face d (1..6) to a value whose floor(x*6)+1 === d
    return (v - 1) / 6 + 0.01;
  };
}

test("validateSelection accepts only integers 1..6", () => {
  for (const n of [1, 2, 3, 4, 5, 6]) assert.equal(validateSelection(n), true);
  for (const bad of [0, 7, 1.5, -1, NaN, "3", null, undefined]) {
    assert.equal(validateSelection(bad), false);
  }
});

test("rerolls until a roll matches a selection", () => {
  const selections = new Map([["a", 4]]);
  const result = resolveCatcher(selections, seq([1, 2, 3, 4]));
  assert.deepEqual(result.rolls, [1, 2, 3, 4]);
  assert.equal(result.catcherId, "a");
});

test("picks a catcher among multiple matching players", () => {
  const selections = new Map([
    ["a", 2],
    ["b", 2],
    ["c", 5],
  ]);
  const result = resolveCatcher(selections, seq([2, 2]));
  assert.ok(["a", "b"].includes(result.catcherId));
});

test("throws on empty selections", () => {
  assert.throws(() => resolveCatcher(new Map()));
});
