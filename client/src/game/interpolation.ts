// Snapshot interpolation: remote and local players are drawn a fixed delay in the past,
// blending between the two server snapshots that bracket that time. Hides network jitter.
export const INTERP_DELAY_MS = 110;

export interface PlayerPose {
  id: string;
  x: number;
  y: number;
  facing: { x: number; y: number };
  hp: number;
  role: "catcher" | "survivor";
  knockedOut: boolean;
  invulnerable: boolean;
  dodging: boolean;
  prop: string | null;
  name: string;
  isBot: boolean;
}

export interface TimedSnapshot {
  at: number; // local receive time (ms)
  players: PlayerPose[];
  remainingMs: number;
  phase: string;
  catcherId: string | null;
}

export class SnapshotBuffer {
  private buf: TimedSnapshot[] = [];
  private readonly maxLen: number;
  constructor(maxLen = 30) {
    this.maxLen = maxLen;
  }

  push(s: TimedSnapshot): void {
    this.buf.push(s);
    if (this.buf.length > this.maxLen) this.buf.shift();
  }

  get latest(): TimedSnapshot | null {
    return this.buf.length ? this.buf[this.buf.length - 1] : null;
  }

  clear(): void {
    this.buf = [];
  }

  /** Returns interpolated poses at renderTime (receive-clock ms). Falls back to the newest frame. */
  sample(renderTime: number): PlayerPose[] | null {
    if (this.buf.length === 0) return null;
    if (this.buf.length === 1) return this.buf[0].players;
    const target = renderTime - INTERP_DELAY_MS;
    let a = this.buf[0];
    let b = this.buf[this.buf.length - 1];
    if (target >= b.at) return b.players;
    if (target <= a.at) return a.players;
    for (let i = 0; i < this.buf.length - 1; i++) {
      if (this.buf[i].at <= target && target <= this.buf[i + 1].at) {
        a = this.buf[i];
        b = this.buf[i + 1];
        break;
      }
    }
    const span = b.at - a.at || 1;
    const t = (target - a.at) / span;
    const byId = new Map(b.players.map((p) => [p.id, p]));
    return a.players.map((pa) => {
      const pb = byId.get(pa.id);
      if (!pb) return pa;
      return {
        ...pb,
        x: pa.x + (pb.x - pa.x) * t,
        y: pa.y + (pb.y - pa.y) * t,
      };
    });
  }
}
