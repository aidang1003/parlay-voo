# Polymarket Integration — LLM spec

*Human doc: [../POLYMARKET.md](../POLYMARKET.md)*

## Code layout

```
packages/shared/src/polymarket/
  curated.ts       hand-curated market list (PR-gated)
  featured.ts      small subset surfaced on home page
  types.ts         shared Polymarket type defs

packages/nextjs/src/lib/polymarket/
  client.ts        Polymarket HTTP client (gamma-api)
  markets.ts       DB-backed market fetch for /api/markets and /api/mcp

packages/nextjs/src/lib/db/
  client.ts        Neon Postgres client + leg_mapping queries
  schema.sql       leg_mapping, polymarket_resolutions tables

packages/nextjs/src/app/api/
  polymarket/sync/route.ts     POST handler — runs Phase A + Phase B
  settlement/run/route.ts      POST handler — settles tickets whose legs are all resolved
  db/init/route.ts             POST handler — applies schema + backfills seed legs
```

## Phase A — discovery + registration

```
syncPhaseA():
  for entry in curated.ts:
    if leg_mapping has active row for entry.conditionId: continue
    meta = PolymarketClient.fetchMarket(entry.conditionId)
    if meta == null or meta.closed: skip (record error)
    for side in [YES, NO]:
      probabilityPPM = meta.priceFor(side) * 1_000_000
      cutoff         = meta.end_date_iso
      legId = LegRegistry.createLeg(question, probabilityPPM, cutoff, adminOracle, sourceRef)
      insert leg_mapping row (conditionId, side, legId, active=true)
    emit { discovered, registered }
```

## Phase B — resolution relay

```
syncPhaseB():
  rows = leg_mapping where active=true AND cutoff < now() - 1h
  for row in rows:
    if polymarket_resolutions has row for row.conditionId: skip
    outcome = PolymarketClient.fetchResolution(row.conditionId)
    if outcome == null: skip (UMA pending)
    for side in [YES, NO]:
      legId   = lookup from leg_mapping
      status  = outcome == side ? Won : (outcome == VOIDED ? Voided : Lost)
      AdminOracleAdapter.resolve(legId, status, 0x0)
      leg_mapping row.active = false
    insert polymarket_resolutions (conditionId, outcome)
    emit { resolved }
```

Idempotent: `polymarket_resolutions` is the gate.

## Database tables

```sql
-- packages/nextjs/src/lib/db/schema.sql
CREATE TABLE tblegmapping (
  conditionid    TEXT NOT NULL,
  sideyes        BOOLEAN NOT NULL,
  legid          BIGINT NOT NULL,
  probabilityppm BIGINT NOT NULL,
  cutoff         TIMESTAMPTZ NOT NULL,
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (conditionid, sideyes)
);

CREATE TABLE tbpolymarketresolution (
  conditionid TEXT PRIMARY KEY,
  outcome     TEXT NOT NULL,         -- 'YES' | 'NO' | 'VOIDED'
  resolvedat  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Naming per the project's `tb` table / all-lowercase column convention (see `docs/changes/A_DAY_SCALING_SPRINT.md` item S-10).

## Route contracts

| Route | Method | Auth | Returns |
|---|---|---|---|
| `/api/polymarket/sync` | POST | `Bearer $CRON_SECRET` | `{ discovered, registered, resolved, errors }` |
| `/api/settlement/run` | POST | `Bearer $CRON_SECRET` | `{ checked, settled, errors }` |
| `/api/db/init` | POST | `Bearer $CRON_SECRET` | `{ applied: boolean, seeded: number }` |
| `/api/markets` | GET | none | `Market[]` — merged seed + curated Polymarket |

## Invariants

1. One `leg_mapping` row per `(conditionId, side)` ever — enforced by primary key.
2. One `polymarket_resolutions` row per `conditionId` ever — enforced by primary key.
3. Once `polymarket_resolutions` has a row for a `conditionId`, Phase B skips that conditionId forever.
4. Odds frozen at registration — `probabilityppm` never updates in-place. If the market needs re-pricing, void the legs and register new ones under a fresh `legId`.
5. Phase A never registers a side whose `leg_mapping` row is already `active=true`.

## Key files

```
packages/shared/src/polymarket/curated.ts
packages/shared/src/polymarket/featured.ts
packages/shared/src/polymarket/types.ts
packages/nextjs/src/lib/polymarket/client.ts
packages/nextjs/src/lib/polymarket/markets.ts
packages/nextjs/src/lib/db/client.ts
packages/nextjs/src/lib/db/schema.sql
packages/nextjs/src/app/api/polymarket/sync/route.ts
packages/nextjs/src/app/api/settlement/run/route.ts
packages/nextjs/src/app/api/db/init/route.ts
packages/nextjs/src/app/api/markets/route.ts
vercel.json                                            (cron registration)
```

## Env dependencies

```
DATABASE_URL            Neon Postgres connection string
CRON_SECRET             shared secret for Vercel cron auth
DEPLOYER_PRIVATE_KEY    signs AdminOracleAdapter.resolve() calls
BASE_SEPOLIA_RPC_URL    RPC endpoint
```
