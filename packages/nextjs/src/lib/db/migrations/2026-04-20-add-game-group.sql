-- Add a nullable game-cluster key on tblegmapping. The sync route fills it
-- in for sport events (NBA/NFL/MLB/NHL) with the event title so sibling
-- markets from one game render together in the builder.
--
-- Null for non-sport markets; they render ungrouped.
--
-- Idempotent: IF NOT EXISTS keeps re-runs safe. `schema.sql` already declares
-- the column for a fresh init.
--
-- Run once per environment:
--   psql "$DATABASE_URL" -f migrations/2026-04-20-add-game-group.sql

ALTER TABLE tblegmapping
  ADD COLUMN IF NOT EXISTS txtgamegroup TEXT;
