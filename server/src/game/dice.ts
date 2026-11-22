export type Rng = () => number;

export const MIN_NUMBER = 1;
export const MAX_NUMBER = 6;

export interface DiceRound {
  selections: Map<string, number>;
  rolls: number[];
  catcherId: string | null;
}

export function validateSelection(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_NUMBER &&
    value <= MAX_NUMBER
  );
}

/** Rolls until at least one selector matches, then picks a catcher at random among matches. */
export function resolveCatcher(
  selections: Map<string, number>,
  rng: Rng = Math.random,
  maxRolls = 1000,
): { catcherId: string; rolls: number[] } {
  if (selections.size === 0) throw new Error("No selections to resolve");

  const rolls: number[] = [];
  for (let i = 0; i < maxRolls; i++) {
    const roll = Math.floor(rng() * MAX_NUMBER) + MIN_NUMBER;
    rolls.push(roll);
    const matches = [...selections.entries()]
      .filter(([, n]) => n === roll)
      .map(([id]) => id);
    if (matches.length > 0) {
      const pick = matches[Math.floor(rng() * matches.length)];
      return { catcherId: pick, rolls };
    }
  }
  throw new Error("Dice did not resolve within maxRolls");
}
