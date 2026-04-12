-- Canonical schema for the parlay-voo Neon Postgres database.
-- Apply with `make db-init` (see packages/nextjs/src/app/api/db/init/route.ts)
-- or by pasting into the Neon SQL editor.
--
-- Naming convention (S-10):
--   Tables:  tb<lowername>           e.g. tblegmapping
--   Columns: <typeprefix><lowername> e.g. txtsourceref, intonchainlegid
--   All identifiers are lowercase so SQL doesn't require double-quoting.
--   Type prefixes:
--     txt = TEXT, int = INTEGER, bln = BOOLEAN, ts = TIMESTAMPTZ, big = BIGINT
--
-- Shape: one row per (market, side). Polymarket markets have two rows
--   (yes + no) sharing the same txtsourceref. Seed markets have a single
--   row with txtside = 'na'. Grouping in app code pivots (sourceref, side)
--   into a single market object in one query (see getActiveMarkets).

-- Drop legacy tables from earlier naming iterations.
DROP TABLE IF EXISTS leg_mapping;
DROP TABLE IF EXISTS polymarket_resolutions;
DROP TABLE IF EXISTS "tbLegMapping";
DROP TABLE IF EXISTS "tbPolymarketResolution";
DROP TABLE IF EXISTS tblegmapping;
DROP TABLE IF EXISTS tbpolymarketresolution;

CREATE TABLE IF NOT EXISTS tblegmapping (
  txtsourceref       TEXT NOT NULL,           -- "poly:<conditionId>" or "seed:<id>"
  txtside            TEXT NOT NULL,           -- 'yes' | 'no' | 'na'
  txtsource          TEXT NOT NULL,
  intonchainlegid    INTEGER,
  txtquestion        TEXT NOT NULL,
  txtcategory        TEXT NOT NULL,
  intprobabilityppm  INTEGER NOT NULL CHECK (intprobabilityppm BETWEEN 1 AND 1000000),
  bigcutofftime      BIGINT NOT NULL,
  bigearliestresolve BIGINT NOT NULL,
  blnactive          BOOLEAN NOT NULL DEFAULT true,
  tscreatedat        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (txtsourceref, txtside),
  CHECK (txtside IN ('yes', 'no', 'na'))
);

CREATE INDEX IF NOT EXISTS ixlegmapping_sourceactive ON tblegmapping (txtsource, blnactive);
CREATE INDEX IF NOT EXISTS ixlegmapping_onchainid    ON tblegmapping (intonchainlegid);

-- tbpolymarketresolution: audit log of resolutions relayed to AdminOracleAdapter.
-- Used to debug settlement, re-run failed relays, and feed future analytics.
CREATE TABLE IF NOT EXISTS tbpolymarketresolution (
  txtconditionid  TEXT PRIMARY KEY,
  txtoutcome      TEXT NOT NULL CHECK (txtoutcome IN ('YES', 'NO', 'VOIDED')),
  txtyestxhash    TEXT,
  txtnotxhash     TEXT,
  tsresolvedat    TIMESTAMPTZ NOT NULL DEFAULT now()
);
