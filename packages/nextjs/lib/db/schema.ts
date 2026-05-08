// Canonical schema for the parlay-voo Postgres database. Provider-agnostic —
// works on either Supabase or Neon. Imported by app/api/db/init/route.ts and
// applied via the splitStatements helper there. Stored as a TS string (not a
// .sql file) so Next.js bundles it with the function — readFile against
// process.cwd() doesn't survive Vercel's serverless tracing.
//
// Naming convention:
//   Tables:  tb<lowername>           e.g. tblegmapping
//   Columns: <typeprefix><lowername> e.g. txtsourceref, intyeslegid
//   All identifiers are lowercase so SQL doesn't require double-quoting.
//   Type prefixes:
//     txt = TEXT, int = INTEGER, bln = BOOLEAN, ts = TIMESTAMPTZ, big = BIGINT
//
// Shape: one row per market. txtsourceref is the primary key. Yes and no
// sides live as sibling columns (intyeslegid/intnolegid, intyesprobppm/
// intnoprobppm). Seed markets populate only the yes-side columns and leave
// the no-side columns null so the UI hides the No button.

export const SCHEMA_SQL = `
-- Drop legacy tables from earlier iterations.
DROP TABLE IF EXISTS leg_mapping;
DROP TABLE IF EXISTS polymarket_resolutions;
DROP TABLE IF EXISTS "tbLegMapping";
DROP TABLE IF EXISTS "tbPolymarketResolution";
DROP TABLE IF EXISTS tblegmapping;
DROP TABLE IF EXISTS tbpolymarketresolution;

CREATE TABLE IF NOT EXISTS tblegmapping (
  txtsourceref       TEXT PRIMARY KEY,
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
  bigcurationscore   BIGINT,
  txtgamegroup       TEXT,
  bigexclusiongroup  BIGINT,
  tscreatedat        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Migration: add the column on databases initialised before bigexclusiongroup
-- landed. Safe to re-run; no-op when the column exists.
ALTER TABLE tblegmapping ADD COLUMN IF NOT EXISTS bigexclusiongroup BIGINT;

-- Migration: drop the legacy jsonbapipayload column (and its GIN index).
-- The raw API payload was bulky and pushed Supabase's free-tier storage cap;
-- nothing reads it. DROP COLUMN is idempotent via IF EXISTS. Existing tables
-- still need a VACUUM FULL to reclaim disk on Postgres.
DROP INDEX IF EXISTS ixlegmapping_payload;
ALTER TABLE tblegmapping DROP COLUMN IF EXISTS jsonbapipayload;

-- Migration: event start time (unix seconds), populated from Polymarket
-- event.startDate at sync. Nullable; legacy rows leave it null and the UI
-- silently omits the line.
ALTER TABLE tblegmapping ADD COLUMN IF NOT EXISTS bigeventstart BIGINT;

-- Migration: Polymarket event slug, used to deep-link the question header
-- to https://polymarket.com/event/<slug>. Nullable; legacy rows fall back
-- to /market/<conditionid> in the UI, and seed markets stay null entirely.
ALTER TABLE tblegmapping ADD COLUMN IF NOT EXISTS txtpolymarketslug TEXT;

-- Migration: outcome labels. Polymarket markets carry an outcomes array
-- ("Yes"/"No" for binary, but team / candidate names for sports / politics).
-- We persist both sides so the YES/NO buttons can show "YES = Lakers" etc.
-- Stored verbatim from the payload; nullable when the market only ships the
-- default Yes/No labels.
ALTER TABLE tblegmapping ADD COLUMN IF NOT EXISTS txtyesoutcome TEXT;
ALTER TABLE tblegmapping ADD COLUMN IF NOT EXISTS txtnooutcome  TEXT;

CREATE INDEX IF NOT EXISTS ixlegmapping_sourceactive ON tblegmapping (txtsource, blnactive);
CREATE INDEX IF NOT EXISTS ixlegmapping_yesid        ON tblegmapping (intyeslegid);
CREATE INDEX IF NOT EXISTS ixlegmapping_noid         ON tblegmapping (intnolegid);

-- tbpolymarketresolution: audit log of resolutions relayed to AdminOracleAdapter.
CREATE TABLE IF NOT EXISTS tbpolymarketresolution (
  txtconditionid  TEXT PRIMARY KEY,
  txtoutcome      TEXT NOT NULL CHECK (txtoutcome IN ('YES', 'NO', 'VOIDED')),
  txtyestxhash    TEXT,
  txtnotxhash     TEXT,
  tsresolvedat    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- tbuserlegdeviation: per-user demo overrides for leg resolution.
-- Ticket-native demo flow (item #3) writes one row per (wallet, leg sourceRef)
-- when a user simulates a WIN or LOSS from /ticket/[id]. The display layer
-- reads from here when chain truth is still Unresolved; once the chain
-- resolves, deviations are suppressed at read time (chain wins). No on-chain
-- effect — settlement still calls settleTicket against the real LegRegistry.
CREATE TABLE IF NOT EXISTS tbuserlegdeviation (
  txtwallet     TEXT NOT NULL CHECK (txtwallet ~ '^0x[0-9a-f]{40}$'),
  txtsourceref  TEXT NOT NULL,
  txtoutcome    TEXT NOT NULL CHECK (txtoutcome IN ('YES', 'NO', 'VOIDED')),
  tscreatedat   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (txtwallet, txtsourceref)
);
CREATE INDEX IF NOT EXISTS ixuserlegdeviation_wallet ON tbuserlegdeviation (txtwallet);
`;
