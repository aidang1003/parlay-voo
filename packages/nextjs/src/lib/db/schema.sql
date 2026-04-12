-- Canonical schema for the parlay-voo Neon Postgres database.
-- Apply with `pnpm db:init` (see packages/nextjs/src/app/api/db/init/route.ts)
-- or by pasting into the Neon SQL editor.

-- leg_mapping: catalog of every registered leg. Replaces the old leg-mapping.json.
-- Seed markets are backfilled with source='seed' so /api/markets can merge seed
-- and polymarket legs with a single SELECT.
-- on_chain_leg_id is nullable: rows pulled in by the polymarket sync route start
-- as NULL and get populated later by the registration script (forge keystore).
-- /api/markets hides any leg with on_chain_leg_id IS NULL.
CREATE TABLE IF NOT EXISTS leg_mapping (
  source_ref        TEXT PRIMARY KEY,
  source            TEXT NOT NULL,
  on_chain_leg_id   INTEGER,
  question          TEXT NOT NULL,
  category          TEXT NOT NULL,
  probability_ppm   INTEGER NOT NULL CHECK (probability_ppm BETWEEN 1 AND 1000000),
  cutoff_time       BIGINT NOT NULL,
  earliest_resolve  BIGINT NOT NULL,
  active            BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Loosen on_chain_leg_id for tables that were created before it became nullable.
-- Safe to run on a fresh DB too -- the table is already nullable above.
ALTER TABLE leg_mapping ALTER COLUMN on_chain_leg_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS leg_mapping_source_active ON leg_mapping (source, active);
CREATE INDEX IF NOT EXISTS leg_mapping_on_chain ON leg_mapping (on_chain_leg_id);

-- polymarket_resolutions: audit log of resolutions we relayed to AdminOracleAdapter.
-- Used to debug settlement, re-run failed relays, and feed future analytics.
CREATE TABLE IF NOT EXISTS polymarket_resolutions (
  condition_id      TEXT PRIMARY KEY,
  outcome           TEXT NOT NULL CHECK (outcome IN ('YES', 'NO', 'VOIDED')),
  yes_tx_hash       TEXT,
  no_tx_hash        TEXT,
  resolved_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
