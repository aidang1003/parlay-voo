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
  -- Raw Gamma event payload captured at sync time. Scalars above stay the
  -- hot-path read; this JSONB is for downstream consumers that need tags,
  -- volume24hr, grouping hints, etc. without re-fetching. Nullable so seed
  -- rows (and pre-migration Polymarket rows) stay legal.
  jsonbapipayload    JSONB,
  -- Curation score for ranking in the builder: volume24hr * 1000 minus the
  -- edge distance from a coinflip (abs(ppm - 500000)). Volume dominates past
  -- ~$500 of 24h volume; balance breaks ties among low-volume markets. Null
  -- for seed rows, which fall through to the end of the sort.
  bigcurationscore   BIGINT,
  -- Cluster key for sport events ("Lakers vs. Warriors — Apr 22"). Shared
  -- across every market in one game so the builder can render them together.
  -- Null for non-sport markets — those render ungrouped.
  txtgamegroup       TEXT,
  tscreatedat        TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
