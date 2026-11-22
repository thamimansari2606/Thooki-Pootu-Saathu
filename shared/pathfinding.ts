// Grid A* pathfinding over the shared navigation grid.
import { GRID_N, cellOf, cellCenter, type Vec2 } from "./arena.ts";

export interface Cell {
  col: number;
  row: number;
}

const DIRS: Array<[number, number, number]> = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

function heuristic(a: Cell, b: Cell): number {
  const dx = Math.abs(a.col - b.col);
  const dy = Math.abs(a.row - b.row);
  return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
}

/** Binary min-heap keyed by number. */
class MinHeap {
  private items: Array<{ key: number; val: number }> = [];
  get size(): number {
    return this.items.length;
  }
  push(val: number, key: number): void {
    this.items.push({ key, val });
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.items[p].key <= this.items[i].key) break;
      [this.items[p], this.items[i]] = [this.items[i], this.items[p]];
      i = p;
    }
  }
  pop(): number {
    const top = this.items[0].val;
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.items.length && this.items[l].key < this.items[m].key) m = l;
        if (r < this.items.length && this.items[r].key < this.items[m].key) m = r;
        if (m === i) break;
        [this.items[m], this.items[i]] = [this.items[i], this.items[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * A* over an 8-connected grid. Returns the list of cell centers to walk through
 * (excluding the start cell), or null if no path exists. `maxNodes` bounds the work.
 */
export function findPath(
  grid: Uint8Array,
  from: Vec2,
  to: Vec2,
  maxNodes = 4000,
): Vec2[] | null {
  const start = cellOf(from);
  const goal = cellOf(to);
  if (grid[goal.row * GRID_N + goal.col]) return null;
  if (start.col === goal.col && start.row === goal.row) return [cellCenter(goal.col, goal.row)];

  const idx = (c: number, r: number) => r * GRID_N + c;
  const g = new Float64Array(GRID_N * GRID_N).fill(Infinity);
  const parent = new Int32Array(GRID_N * GRID_N).fill(-1);
  const closed = new Uint8Array(GRID_N * GRID_N);
  const open = new MinHeap();

  const s = idx(start.col, start.row);
  g[s] = 0;
  open.push(s, heuristic(start, goal));
  let expanded = 0;

  while (open.size > 0 && expanded < maxNodes) {
    const cur = open.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    expanded++;
    const cc = cur % GRID_N;
    const cr = (cur - cc) / GRID_N;
    if (cc === goal.col && cr === goal.row) {
      const cells: Vec2[] = [];
      let n = cur;
      while (n !== s) {
        const c = n % GRID_N;
        const r = (n - c) / GRID_N;
        cells.push(cellCenter(c, r));
        n = parent[n];
      }
      return cells.reverse();
    }
    for (const [dc, dr, cost] of DIRS) {
      const nc = cc + dc;
      const nr = cr + dr;
      if (nc < 0 || nr < 0 || nc >= GRID_N || nr >= GRID_N) continue;
      const ni = idx(nc, nr);
      if (grid[ni] || closed[ni]) continue;
      // Forbid cutting corners through blocked cells on diagonal moves.
      if (dc !== 0 && dr !== 0 && (grid[idx(cc + dc, cr)] || grid[idx(cc, cr + dr)])) continue;
      const ng = g[cur] + cost;
      if (ng < g[ni]) {
        g[ni] = ng;
        parent[ni] = cur;
        open.push(ni, ng + heuristic({ col: nc, row: nr }, goal));
      }
    }
  }
  return null;
}
