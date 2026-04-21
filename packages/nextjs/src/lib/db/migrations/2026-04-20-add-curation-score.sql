-- Add a curation score column on tblegmapping. The sync route fills it in
-- from the Gamma payload (volume24hr * 1000 - abs(ppm - 500000)) so the
-- builder can rank markets by traction + balance without re-parsing JSON on
-- every read.
--
-- Null-tolerant: seed rows never get a score. Postgres sorts NULLs last with
-- DESC NULLS LAST in the read path.
--
-- Idempotent: IF NOT EXISTS guards allow safe re-runs. `schema.sql` already
-- declares the column for a fresh init.
--
-- Run once per environment:
--   psql "$DATABASE_URL" -f migrations/2026-04-20-add-curation-score.sql

ALTER TABLE tblegmapping
  ADD COLUMN IF NOT EXISTS bigcurationscore BIGINT;
