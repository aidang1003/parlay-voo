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
// Per AGENTS.md: every init drops every table except tbadminwallet and
// rebuilds. No migration scripts — change a column shape, re-init.

export const SCHEMA_SQL = `
DROP TABLE IF EXISTS tblegmapping CASCADE;
DROP TABLE IF EXISTS tbpolymarketresolution CASCADE;
DROP TABLE IF EXISTS tbuserlegdeviation CASCADE;
DROP TABLE IF EXISTS tbticketdeviation CASCADE;

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
  bigeventstart      BIGINT,
  txtpolymarketslug  TEXT,
  txtyesoutcome      TEXT,
  txtnooutcome       TEXT,
  blnpolyclosed      BOOLEAN NOT NULL DEFAULT false,
  -- Sports markets only: "moneyline" | "spreads" | "totals" (Polymarket's
  -- sportsMarketType). Null for political/crypto/news/seed markets, which
  -- continue to render as plain question + Yes/No.
  txtmarkettype      TEXT,
  -- Spread or total line, scaled ×10 so half-points fit the int prefix
  -- convention (-1.5 → -15, 8.5 → 85). Null when no line applies (moneyline,
  -- non-sports). Pair with txtmarkettype for the YES/NO copy branch.
  intline            INTEGER,
  tscreatedat        TIMESTAMPTZ NOT NULL DEFAULT now()
);

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

-- tbticketdeviation: ticket-level mirror of the on-chain lifecycle for the
-- demo flow. Written by /api/tickets/[id]/demo-settle (Won/Lost/Voided) and
-- promoted to Claimed by /api/tickets/[id]/demo-claim. Suppressed at read
-- time once chain truth has resolved every leg of the ticket — the user
-- then re-Settles + re-Claims against the real chain. NUMERIC(78,0) holds a
-- uint256 ticket id and USDC payout (6-decimal base units) without loss.
CREATE TABLE IF NOT EXISTS tbticketdeviation (
  txtwallet         TEXT NOT NULL CHECK (txtwallet ~ '^0x[0-9a-f]{40}$'),
  bigticketid       NUMERIC(78,0) NOT NULL,
  txtstatus         TEXT NOT NULL CHECK (txtstatus IN ('Won', 'Lost', 'Voided', 'Claimed')),
  bigpayout         NUMERIC(78,0) NOT NULL DEFAULT 0,
  bigmultiplierx1e6 NUMERIC(78,0) NOT NULL DEFAULT 1000000,
  -- Original ticket stake (USDC base units). Populated at demo-settle time so
  -- the demo rehab path can reconstruct rehabClaimable without re-reading the
  -- chain ticket. Zero on rows written before this column existed.
  bigstake          NUMERIC(78,0) NOT NULL DEFAULT 0,
  -- Demo-rehab gate. Once a Lost row's stake has been "claimed" through the
  -- demo rehab flow (server mints MockUSDC = stake * projectedAprBps / BPS),
  -- this flips true so the row stops contributing to demo claimable. Real
  -- chain rehabClaimable is independent — both pots can pay out.
  blnrehabclaimed   BOOLEAN NOT NULL DEFAULT false,
  txtclaimtxhash    TEXT,
  tssettledat       TIMESTAMPTZ NOT NULL DEFAULT now(),
  tsclaimedat       TIMESTAMPTZ,
  PRIMARY KEY (txtwallet, bigticketid)
);
CREATE INDEX IF NOT EXISTS ixticketdeviation_wallet ON tbticketdeviation (txtwallet);
`;
