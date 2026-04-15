# Polymarket Integration Runbook

ParlayVoo sources real betting data from Polymarket. This doc covers curation,
sync operation, and troubleshooting.

## Architecture at a glance

```
curated.ts ──►  /api/polymarket/sync  ──►  LegRegistry (on-chain)
                      │                           │
                      ▼                           ▼
               leg_mapping (Neon)            AdminOracleAdapter
                      │
                      ▼
              /api/markets  ──►  ParlayBuilder UI
```

- **Curation is hand-picked** (`packages/shared/src/polymarket/curated.ts`).
  No auto-discovery, no scraping. If you want a market, open a PR.
- **Sync is one daily cron** (`/api/polymarket/sync`) that handles both
  discovery/registration (Phase A) and resolution relay (Phase B).
- **Odds are frozen at registration time.** The plan deliberately avoids
  `updateProbability()` between quote and buy to preserve the math-parity
  invariant. The UI labels this with an "Odds locked" badge.

## Adding a market

1. Find a liquid market on polymarket.com. Look for:
   - **Volume** > $100k (avoid thin books)
   - **End date** at least a week out (sync runs daily; give the UMA window room)
   - **Resolution source** that's unambiguous (price feeds, official results)
2. Grab the `condition_id`:
   - Open devtools → Network tab → filter for `gamma-api`
   - Click the market, look at the response
   - Copy `condition_id` (starts with `0x`)
3. Add an entry to `packages/shared/src/polymarket/curated.ts`:
   ```ts
   { conditionId: "0xabc...", category: "crypto", displayTitle: "BTC > $200k by EOY 2026" }
   ```
4. Open a PR. Once merged, the next sync run registers it on-chain.

## Running sync locally

Requires `DATABASE_URL`, `CRON_SECRET`, `DEPLOYER_PRIVATE_KEY` in `.env.local`,
and the dev server running (`pnpm dev`).

```bash
# One-time: apply schema + backfill seed legs into leg_mapping
pnpm --filter web db:init

# Anytime: run the full sync (discovery + resolution relay)
pnpm --filter web polymarket:sync
```

Both commands just curl their respective API routes with the `CRON_SECRET`
bearer. No standalone scripts, no separate infra. The JSON response tells you
`{ discovered, registered, resolved, errors }`.

## Dev database workflow

Neon supports free branches. Each developer gets their own isolated copy:

```bash
neonctl branches create --name dev-$(whoami)
# Copy the branch connection string into .env.local as DATABASE_URL
```

Wipe and reset by deleting and recreating the branch. Inspect with either the
Neon console's SQL editor or `psql $DATABASE_URL`.

## Production cron

`vercel.json` registers a daily cron at `08:00 UTC` against `/api/polymarket/sync`.
Vercel attaches the `Authorization: Bearer $CRON_SECRET` header when the secret
is set in project env.

Verify it's wired:
```bash
vercel env ls                    # should show DATABASE_URL + CRON_SECRET + DEPLOYER_PRIVATE_KEY
vercel cron ls                   # should show the daily entry
```

## Resolution flow

1. Sync detects an expired leg (cutoff passed + 1h buffer) with no resolution row.
2. It calls `fetchResolution()` on Polymarket. If the market hasn't resolved yet,
   this returns null and the leg stays active.
3. Once resolved, sync calls `AdminOracleAdapter.resolve(legId, status, 0x0)`
   for both YES and NO sides, inserts a row in `polymarket_resolutions`, and
   deactivates both legs in `leg_mapping`.
4. The permissionless `settler-bot` (unchanged) picks up affected tickets on
   its next loop and settles them to users.

Expected latency from Polymarket resolution to ticket settlement: within 24h
of the next cron run. For faster resolution, hit `pnpm polymarket:sync` by hand.

## Stuck UMA (manual void path)

If a Polymarket market enters a UMA dispute that drags past our 48h
`earliestResolve` buffer, the sync route will keep finding the leg unresolved
every run. To manually void:

```bash
# From anywhere with DEPLOYER_PRIVATE_KEY in scope:
cast send $NEXT_PUBLIC_ADMIN_ORACLE_ADDRESS \
  "resolve(uint256,uint8,bytes32)" \
  <yesLegId> 3 0x0000...0000 \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --private-key $DEPLOYER_PRIVATE_KEY

# LegStatus enum: Unresolved=0, Won=1, Lost=2, Voided=3
# Then do the same for <noLegId>, and manually insert a row into
# polymarket_resolutions with outcome='VOIDED' so sync stops re-checking it.
```

## Troubleshooting

**"unauthorized" from /api/polymarket/sync**
CRON_SECRET missing or mismatched. Check `.env.local` and Vercel env.

**"missing required env"**
One of `DEPLOYER_PRIVATE_KEY`, `NEXT_PUBLIC_LEG_REGISTRY_ADDRESS`, or
`ADMIN_ORACLE_ADDRESS` isn't set. `scripts/sync-env.ts` preserves these across
deploys.

**"market already closed/archived"**
Curated entry references a market that ended before registration. Remove or
replace the `conditionId` in `curated.ts`.

**"cutoff too soon"**
Polymarket's `end_date_iso` is less than 1h away. The leg would be useless —
pick a longer-dated market.

**"empty orderbook"**
Market has no bids or asks right now. Usually means thin liquidity; consider
dropping the market, or retry later.

**Sync Phase B never resolves a market**
Check that Polymarket's `outcome_prices` has flipped to [1.00, 0.00] or
[0.00, 1.00]. If the market is closed but `outcome_prices` is missing, sync
treats it as VOIDED — see the manual void path above.

**Ticket didn't settle after resolution**
`settler-bot.ts` has its own polling loop. Make sure it's running (Vercel
Function or local process) and watch its logs for the affected `ticketId`.
