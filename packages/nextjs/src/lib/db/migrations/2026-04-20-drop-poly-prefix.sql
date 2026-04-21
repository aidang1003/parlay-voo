-- Drop the legacy "poly:" prefix from tblegmapping.txtsourceref.
-- We only sync Polymarket into the polymarket rows, so the prefix was
-- redundant disambiguation. Seed rows ("seed:<id>") are unaffected.
--
-- Idempotent: the LIKE filter is a no-op once every row is already
-- prefix-free, so re-running is safe.
--
-- Run once against each environment:
--   psql "$DATABASE_URL" -f migrations/2026-04-20-drop-poly-prefix.sql
--
-- Alternative to re-init: `schema.sql` already drops and recreates
-- tblegmapping, so a full `/api/db/init` + `/api/polymarket/sync` will
-- also land on the new format (at the cost of wiping tbpolymarketresolution).
-- Prefer this migration in production where the audit log matters.

UPDATE tblegmapping
SET    txtsourceref = substr(txtsourceref, 6)
WHERE  txtsource    = 'polymarket'
AND    txtsourceref LIKE 'poly:%';
