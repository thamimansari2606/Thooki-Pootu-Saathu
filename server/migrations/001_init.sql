-- Thooki Pootu Saathu: initial schema for player profiles and match history.
-- Apply with: psql "$DATABASE_URL" -f server/migrations/001_init.sql
-- Idempotent: safe to run more than once.

CREATE TABLE IF NOT EXISTS players (
  player_id     TEXT PRIMARY KEY,               -- random 128-bit token, guests included
  name          TEXT NOT NULL,
  total_games   INTEGER NOT NULL DEFAULT 0,
  wins          INTEGER NOT NULL DEFAULT 0,
  losses        INTEGER NOT NULL DEFAULT 0,
  knockouts     INTEGER NOT NULL DEFAULT 0,
  survival_ms   BIGINT  NOT NULL DEFAULT 0,
  last_played_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS matches (
  match_id     UUID PRIMARY KEY,
  ended_at     TIMESTAMPTZ NOT NULL,
  winner       TEXT NOT NULL CHECK (winner IN ('catcher', 'survivors')),
  reason       TEXT NOT NULL CHECK (reason IN ('all_knocked_out', 'timeout', 'abandoned')),
  duration_ms  INTEGER NOT NULL CHECK (duration_ms >= 0)
);

CREATE TABLE IF NOT EXISTS match_players (
  match_id      UUID NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
  player_id     TEXT NOT NULL REFERENCES players(player_id),
  role          TEXT NOT NULL CHECK (role IN ('catcher', 'survivor')),
  knockouts     INTEGER NOT NULL DEFAULT 0,
  damage_dealt  INTEGER NOT NULL DEFAULT 0,
  damage_taken  INTEGER NOT NULL DEFAULT 0,
  survived_ms   INTEGER NOT NULL DEFAULT 0,
  placement     INTEGER,
  won           BOOLEAN NOT NULL,
  PRIMARY KEY (match_id, player_id)
);

CREATE INDEX IF NOT EXISTS match_players_player_idx ON match_players (player_id);
CREATE INDEX IF NOT EXISTS players_wins_idx ON players (wins DESC, total_games DESC);
