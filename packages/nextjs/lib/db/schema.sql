-- Canonical schema for the parlay-voo Neon Postgres database.
-- Apply with `make db-init`.
--
-- Naming convention:
--   Tables:  tb<lowername>           e.g. tblegmapping
--   Columns: <typeprefix><lowername> e.g. txtsourceref, intyeslegid
--   All identifiers are lowercase so SQL doesn't require double-quoting.
--   Type prefixes:
--     txt = TEXT, int = INTEGER, bln = BOOLEAN, ts = TIMESTAMPTZ, big = BIGINT
--
-- Shape: one row per market. txtsourceref is the primary key. Yes and no
-- sides live as sibling columns (intyeslegid/intnolegid, intyesprobppm/
-- intnoprobppm). Seed markets populate only the yes-side columns and leave
-- the no-side columns null so the UI hides the No button.

-- Drop legacy tables from earlier iterations.
DROP TABLE IF EXISTS leg_mapping;
DROP TABLE IF EXISTS polymarket_resolutions;
DROP TABLE IF EXISTS "tbLegMapping";
DROP TABLE IF EXISTS "tbPolymarketResolution";
DROP TABLE IF EXISTS tblegmapping;
DROP TABLE IF EXISTS tbpolymarketresolution;

CREATE TABLE IF NOT EXISTS tblegmapping (
  txtsourceref       TEXT PRIMARY KEY,                         -- polymarket conditionId (0x…) or "seed:<id>"
  txtsource          TEXT NOT NULL,
  txtquestion        TEXT NOT NULL,
  txtcategory        TEXT NOT NULL,
  intyeslegid        INTEGER,
  intnolegid         INTEGER,
  intyesprobppm      INTEGER NOT NULL CHECK (intyesprobppm BETWEEN 1 AND 1000000),
  intnoprobppm       INTEGER CHECK (intnoprobppm IS NULL OR intnoprobppm BETWEEN 1 AND 1000000),
  bigcutofftime      BIGINT NOT NULL,
  bigearliestresolve BIGINT NOT NULL,
  blnactive          BOOLEAN NOT NULL DEFAULT true,
  jsonbapipayload    JSONB,
  bigcurationscore   BIGINT,
  txtgamegroup       TEXT,
  bigexclusiongroup  BIGINT,                                   -- non-zero ⇒ legs in this group are mutually exclusive
  tscreatedat        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Migration: add the column on databases that were initialised before
-- bigexclusiongroup landed. Safe to re-run; no-op when the column exists.
ALTER TABLE tblegmapping ADD COLUMN IF NOT EXISTS bigexclusiongroup BIGINT;

CREATE INDEX IF NOT EXISTS ixlegmapping_sourceactive ON tblegmapping (txtsource, blnactive);
CREATE INDEX IF NOT EXISTS ixlegmapping_yesid        ON tblegmapping (intyeslegid);
CREATE INDEX IF NOT EXISTS ixlegmapping_noid         ON tblegmapping (intnolegid);
CREATE INDEX IF NOT EXISTS ixlegmapping_payload      ON tblegmapping USING GIN (jsonbapipayload jsonb_path_ops);

-- tbpolymarketresolution: audit log of resolutions relayed to AdminOracleAdapter.
CREATE TABLE IF NOT EXISTS tbpolymarketresolution (
  txtconditionid  TEXT PRIMARY KEY,
  txtoutcome      TEXT NOT NULL CHECK (txtoutcome IN ('YES', 'NO', 'VOIDED')),
  txtyestxhash    TEXT,
  txtnotxhash     TEXT,
  tsresolvedat    TIMESTAMPTZ NOT NULL DEFAULT now()
);
