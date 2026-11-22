// Input validation and rate limiting for every client message. Anything that fails is dropped
// with an error code; nothing the client sends is trusted for gameplay outcomes.

export const MAX_MESSAGE_BYTES = 4096;
export const ROOM_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
export const TOKEN_RE = /^[a-f0-9]{32}$/;
export const AVATARS = ["bear", "fox", "panda", "rabbit", "tiger", "owl", "frog", "cat"] as const;
export const DIFFICULTY_VALUES = ["easy", "medium", "hard"] as const;

export class ValidationError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export function asRoomCode(v: unknown): string {
  if (typeof v !== "string") throw new ValidationError("INVALID_ROOM_CODE");
  const up = v.trim().toUpperCase();
  if (!ROOM_CODE_RE.test(up)) throw new ValidationError("INVALID_ROOM_CODE");
  return up;
}

export function asToken(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !TOKEN_RE.test(v)) throw new ValidationError("INVALID_TOKEN");
  return v;
}

export function asName(v: unknown): string {
  if (typeof v !== "string") throw new ValidationError("INVALID_NAME");
  const cleaned = v.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 16);
  if (cleaned.length === 0) throw new ValidationError("INVALID_NAME");
  return cleaned;
}

export function asAvatar(v: unknown): string {
  if (typeof v === "string" && (AVATARS as readonly string[]).includes(v)) return v;
  return AVATARS[0];
}

export function asBool(v: unknown): boolean {
  if (typeof v !== "boolean") throw new ValidationError("INVALID_BOOLEAN");
  return v;
}

export function asInt(v: unknown, lo: number, hi: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) {
    throw new ValidationError("INVALID_NUMBER");
  }
  return v;
}

export function asDifficulty(v: unknown): (typeof DIFFICULTY_VALUES)[number] {
  if (typeof v === "string" && (DIFFICULTY_VALUES as readonly string[]).includes(v)) {
    return v as (typeof DIFFICULTY_VALUES)[number];
  }
  throw new ValidationError("INVALID_DIFFICULTY");
}

export function asAxis(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  return Math.max(-1, Math.min(1, v));
}

/** Token bucket: `capacity` burst, refilled at `perSecond`. */
export class RateLimiter {
  private tokens: number;
  private last: number;
  private readonly capacity: number;
  private readonly perSecond: number;
  constructor(capacity: number, perSecond: number, now: number) {
    this.capacity = capacity;
    this.perSecond = perSecond;
    this.tokens = capacity;
    this.last = now;
  }
  take(now: number): boolean {
    const elapsed = Math.max(0, now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.perSecond);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
