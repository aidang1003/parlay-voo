-- Add a JSONB column on tblegmapping that holds the raw Gamma event payload
-- captured at sync time, plus a GIN index for @> / ? containment queries.
--
-- Why: downstream consumers (curation score, sport categorization, game
-- grouping) want tags / volume24hr / related-market IDs that the scalar
-- columns don't carry. Keeping the scalars populated is the hot-path read;
-- jsonbapipayload is NULL-tolerant for legacy rows and seed markets.
--
-- Idempotent: IF NOT EXISTS guards allow safe re-runs. `schema.sql` already
-- declares the column + index for a fresh init; prefer this migration in
-- production so tbpolymarketresolution's audit log survives.
--
-- Run once per environment:
--   psql "$DATABASE_URL" -f migrations/2026-04-20-add-gamma-payload.sql

ALTER TABLE tblegmapping
  ADD COLUMN IF NOT EXISTS jsonbapipayload JSONB;

CREATE INDEX IF NOT EXISTS ixlegmapping_payload
  ON tblegmapping USING GIN (jsonbapipayload jsonb_path_ops);
