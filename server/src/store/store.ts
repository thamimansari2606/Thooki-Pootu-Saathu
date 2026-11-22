// Persistence for player profiles and match history. Guests are supported: a profile is keyed
// by a public ID (derived from the secret token), and nothing forces registration.
// Three implementations: PostgresStore (production), FileStore (single-instance fallback), MemoryStore (tests).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SqlClient } from "./sql.ts";

export interface MatchPlayerResult {
  playerId: string;
  name: string;
  role: "catcher" | "survivor";
  knockouts: number;
  damageDealt: number;
  damageTaken: number;
  survivedMs: number;
  placement: number | null;
  won: boolean;
}

export interface MatchResult {
  matchId: string;
  endedAt: string;
  winner: "catcher" | "survivors";
  reason: "all_knocked_out" | "timeout" | "abandoned";
  durationMs: number;
  players: MatchPlayerResult[];
}

export interface Profile {
  playerId: string;
  name: string;
  totalGames: number;
  wins: number;
  losses: number;
  knockouts: number;
  survivalMs: number;
  lastPlayedAt: string | null;
}

export interface Store {
  recordMatch(result: MatchResult): Promise<void>;
  getProfile(playerId: string): Promise<Profile | null>;
  topProfiles(limit: number): Promise<Profile[]>;
  matchCount(): Promise<number>;
  close(): Promise<void>;
}

function emptyProfile(playerId: string, name: string): Profile {
  return { playerId, name, totalGames: 0, wins: 0, losses: 0, knockouts: 0, survivalMs: 0, lastPlayedAt: null };
}

/** Applies one match to a profile. Pure: returns a new profile object. */
export function applyResult(profile: Profile, p: MatchPlayerResult, endedAt: string): Profile {
  return {
    ...profile,
    name: p.name,
    totalGames: profile.totalGames + 1,
    wins: profile.wins + (p.won ? 1 : 0),
    losses: profile.losses + (p.won ? 0 : 1),
    knockouts: profile.knockouts + p.knockouts,
    survivalMs: profile.survivalMs + Math.round(p.survivedMs),
    lastPlayedAt: endedAt,
  };
}

/** In-memory store, used by tests. */
export class MemoryStore implements Store {
  protected profiles = new Map<string, Profile>();
  protected matches: MatchResult[] = [];

  async recordMatch(result: MatchResult): Promise<void> {
    if (this.matches.some((m) => m.matchId === result.matchId)) return; // idempotent
    this.matches.push(result);
    for (const p of result.players) {
      const prev = this.profiles.get(p.playerId) ?? emptyProfile(p.playerId, p.name);
      this.profiles.set(p.playerId, applyResult(prev, p, result.endedAt));
    }
  }

  async getProfile(playerId: string): Promise<Profile | null> {
    return this.profiles.get(playerId) ?? null;
  }

  async topProfiles(limit: number): Promise<Profile[]> {
    return [...this.profiles.values()].sort((a, b) => b.wins - a.wins || b.totalGames - a.totalGames).slice(0, limit);
  }

  async matchCount(): Promise<number> {
    return this.matches.length;
  }

  async close(): Promise<void> {
    /* nothing to release */
  }
}

/**
 * JSON-file store. Writes atomically (temp file + rename). Single-instance only.
 * Kept as a no-database fallback; production should use PostgresStore.
 */
export class FileStore extends MemoryStore {
  private readonly path: string;
  constructor(path: string) {
    super();
    this.path = path;
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { profiles: Profile[]; matches: MatchResult[] };
      for (const p of raw.profiles ?? []) this.profiles.set(p.playerId, p);
      this.matches = raw.matches ?? [];
    }
  }

  async recordMatch(result: MatchResult): Promise<void> {
    await super.recordMatch(result);
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ profiles: [...this.profiles.values()], matches: this.matches }, null, 2));
    renameSync(tmp, this.path);
  }
}

/**
 * PostgreSQL store, using the schema in server/migrations/001_init.sql.
 * A match is written in one transaction. Re-recording the same match is a no-op.
 */
export class PostgresStore implements Store {
  private readonly db: SqlClient;
  constructor(db: SqlClient) {
    this.db = db;
  }

  async recordMatch(result: MatchResult): Promise<void> {
    const statements: Array<{ text: string; params: (string | number | boolean | null)[] }> = [];
    statements.push({
      text: `INSERT INTO matches (match_id, ended_at, winner, reason, duration_ms)
             VALUES ($1::uuid, $2::timestamptz, $3::text, $4::text, $5::int) ON CONFLICT (match_id) DO NOTHING`,
      params: [result.matchId, result.endedAt, result.winner, result.reason, Math.max(0, Math.round(result.durationMs))],
    });
    for (const p of result.players) {
      const won = p.won ? 1 : 0;
      // The WHERE NOT EXISTS makes the profile update happen only the first time this match is written.
      statements.push({
        text: `INSERT INTO players (player_id, name, total_games, wins, losses, knockouts, survival_ms, last_played_at)
               SELECT $1::text, $2::text, 1, $3::int, $4::int, $5::int, $6::bigint, $7::timestamptz
               WHERE NOT EXISTS (SELECT 1 FROM match_players WHERE match_id = $8::uuid AND player_id = $1::text)
               ON CONFLICT (player_id) DO UPDATE SET
                 name = EXCLUDED.name,
                 total_games = players.total_games + 1,
                 wins = players.wins + $3,
                 losses = players.losses + $4,
                 knockouts = players.knockouts + $5,
                 survival_ms = players.survival_ms + $6,
                 last_played_at = EXCLUDED.last_played_at`,
        params: [p.playerId, p.name, won, 1 - won, p.knockouts, Math.round(p.survivedMs), result.endedAt, result.matchId],
      });
      statements.push({
        text: `INSERT INTO match_players (match_id, player_id, role, knockouts, damage_dealt, damage_taken, survived_ms, placement, won)
               VALUES ($1::uuid, $2::text, $3::text, $4::int, $5::int, $6::int, $7::int, $8::int, $9::boolean) ON CONFLICT (match_id, player_id) DO NOTHING`,
        params: [result.matchId, p.playerId, p.role, p.knockouts, p.damageDealt, p.damageTaken, Math.round(p.survivedMs), p.placement, p.won],
      });
    }
    await this.db.batch(statements);
  }

  async getProfile(playerId: string): Promise<Profile | null> {
    const rows = await this.db.query<Record<string, any>>(
      `SELECT player_id, name, total_games, wins, losses, knockouts, survival_ms, last_played_at FROM players WHERE player_id = $1::text`,
      [playerId],
    );
    return rows[0] ? toProfile(rows[0]) : null;
  }

  async topProfiles(limit: number): Promise<Profile[]> {
    const rows = await this.db.query<Record<string, any>>(
      `SELECT player_id, name, total_games, wins, losses, knockouts, survival_ms, last_played_at
         FROM players ORDER BY wins DESC, total_games DESC, player_id LIMIT $1::int`,
      [Math.max(1, Math.min(100, Math.floor(limit)))],
    );
    return rows.map(toProfile);
  }

  async matchCount(): Promise<number> {
    const rows = await this.db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM matches`);
    return Number(rows[0]?.n ?? 0);
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

function toProfile(r: Record<string, any>): Profile {
  return {
    playerId: String(r.player_id),
    name: String(r.name),
    totalGames: Number(r.total_games),
    wins: Number(r.wins),
    losses: Number(r.losses),
    knockouts: Number(r.knockouts),
    survivalMs: Number(r.survival_ms),
    lastPlayedAt: r.last_played_at ? new Date(r.last_played_at).toISOString() : null,
  };
}
