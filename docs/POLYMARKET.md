# Polymarket Integration

*LLM spec: [llm-spec/POLYMARKET.md](llm-spec/POLYMARKET.md)*

ParlayVoo sources real betting data from Polymarket. This doc covers what the integration is, how curation works, how sync runs, and what to do when something stuck.

## What it is

A read-only integration with Polymarket's public API that gives ParlayVoo:
- A curated list of real binary markets (with real odds) to bet on.
- A resolution path so that when Polymarket finalizes a market, ParlayVoo can settle tickets that referenced it.

No automatic market discovery, no scraping. Every market that shows up in the app is hand-picked by someone adding an entry to `packages/shared/src/polymarket/curated.ts` and opening a PR.

## Architecture

```
curated.ts  ──►  /api/polymarket/sync  ──►  LegRegistry (on-chain)
                       │                            │
                       ▼                            ▼
               leg_mapping (Neon Postgres)    AdminOracleAdapter
                       │
                       ▼
                /api/markets  ──►  ParlayBuilder UI
```

Two phases, one cron:
- **Phase A — discovery + registration.** Walk the curated list. For each new entry, fetch current odds from Polymarket, register a leg on-chain, record the `conditionId → legId` mapping in Postgres.
- **Phase B — resolution relay.** Walk active `leg_mapping` rows past their cutoff. For each, poll Polymarket for a resolved outcome. When it lands, call `AdminOracleAdapter.resolve()` on-chain and mark the mapping row resolved.

Odds are **frozen at registration time**. The on-chain probability never updates between quote and buy — the math-parity invariant requires deterministic pricing. The UI labels this with an "Odds locked" badge so users understand why they see a slightly different price than polymarket.com.

Settlement is handled by the unified `/api/settlement/run` cron, which picks up tickets that now have all-resolved legs and calls `ParlayEngine.settleTicket()`.

## Adding a market

1. Find a liquid market on polymarket.com. Look for:
   - **Volume** > $100k (avoid thin books).
   - **End date** at least a week out (sync runs daily; give the UMA resolution window room).
   - **Resolution source** that's unambiguous (price feeds, official results).
2. Grab the `condition_id`:
   - Open devtools → Network tab → filter for `gamma-api`.
   - Click the market, look at the response.
   - Copy `condition_id` (starts with `0x`).
3. Add an entry to `packages/shared/src/polymarket/curated.ts`:
   ```ts
   { conditionId: "0xabc...", category: "crypto", displayTitle: "BTC > $200k by EOY 2026" }
   ```
4. Open a PR. Once merged, the next sync run registers it on-chain.

## Market discovery

Three sources feed each sync run, deduped by `conditionId`:

- **CURATED** — hand-picked entries in `curated.ts`. PR-gated. Listed first so they win any dedup collision.
- **Featured** — top Gamma events by 24h volume (`/events?order=volume24hr`). Global leaderboard; captures whatever is trending.
- **Per-sport** — one Gamma call per major-league tag (`nba`, `nfl`, `mlb`, `nhl`). Sport inventory isn't gated on cracking the global top-10, so in-progress games surface even when crypto/politics dominates volume.

Fans out in parallel via `Promise.allSettled` — one source failing returns an empty batch, the rest still land.

## Curation score

Ranks markets in the builder's **Featured** pill and per-category pages. Three normalized components summed, each clamped to `[0, 1000]`, so none can dominate on its own. Stored in `tblegmapping.bigcurationscore`, recomputed every sync run (so the time term stays fresh modulo cron cadence). NULL for seed rows — they sort last via `ORDER BY ... DESC NULLS LAST`.

- **Volume** — `log10(volume24hr) × 150`, capped at 1000. $1k ≈ 450, $10k ≈ 600, $1M ≈ 900, ≥$10M saturates. Log scale so a $100M market doesn't crowd out a $50k market 2000× its score.
- **Balance** — `1000 × (1 − |ppm − 500k| / 500k)`. 1000 at a coinflip, 0 at pure 0/100. Keeps parlay multipliers off the 1%/99% probability clamp where they'd degenerate.
- **Urgency** — `1000 × (1 − hoursToResolve / 168)`, floor 0. Resolving now → 1000, ≥ 7 days away → 0. Prevents the Featured page from being all week-plus-out settlements.

## Game grouping

Sport events (NBA / NFL / MLB / NHL) share a `gameGroup` key across their sibling markets — it's the Gamma event title (e.g. "Lakers vs. Warriors — Apr 22"). The builder renders all markets under one game under a single header so the UI matches how users think about games rather than individual prop markets.

Classification runs off the event's title + slug + tag labels (regex on `\bnba\b`, `national basketball`, etc.). No sport match → `gameGroup` is NULL and the market renders ungrouped.

## Running sync locally

Requires `DATABASE_URL`, `CRON_SECRET`, `DEPLOYER_PRIVATE_KEY` in `.env.local`, and the dev server running (`pnpm dev`).

```bash
# One-time: apply schema + backfill seed legs into leg_mapping
pnpm --filter web db:init

# Anytime: run the full sync (discovery + resolution relay)
pnpm --filter web polymarket:sync
```

Both commands just curl their respective API routes with the `CRON_SECRET` bearer. No standalone scripts, no separate infra. The JSON response tells you `{ discovered, registered, resolved, errors }`.

## Dev database workflow

Neon supports free branches. Each developer gets their own isolated copy:

```bash
neonctl branches create --name dev-$(whoami)
# Copy the branch connection string into .env.local as DATABASE_URL
```

Wipe and reset by deleting and recreating the branch. Inspect with either the Neon console's SQL editor or `psql $DATABASE_URL`.

## Production cron

`vercel.json` registers a daily cron at `08:00 UTC` against `/api/polymarket/sync`. Vercel attaches the `Authorization: Bearer $CRON_SECRET` header when the secret is set in project env.

```bash
vercel env ls                    # should show DATABASE_URL + CRON_SECRET + DEPLOYER_PRIVATE_KEY
vercel cron ls                   # should show the daily entry
```

## Resolution flow

1. Sync detects an expired leg (cutoff passed + 1h buffer) with no resolution row.
2. It calls `fetchResolution()` on Polymarket. If the market hasn't resolved yet, returns null and the leg stays active.
3. Once resolved, sync calls `AdminOracleAdapter.resolve(legId, status, 0x0)` for both YES and NO sides, inserts a row in `polymarket_resolutions`, and deactivates both legs in `leg_mapping`.
4. The unified `/api/settlement/run` cron (Phase B) picks up affected tickets on its next tick and settles them to users.

**Expected latency** from Polymarket resolution to ticket settlement: within 24h of the next cron run. For faster resolution, hit `pnpm polymarket:sync` by hand.

## Stuck UMA (manual void)

If a Polymarket market enters a UMA dispute that drags past our 48h `earliestResolve` buffer, the sync route will keep finding the leg unresolved every run. To manually void:

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

**"unauthorized" from `/api/polymarket/sync`** — CRON_SECRET missing or mismatched. Check `.env.local` and Vercel env.

**"missing required env"** — `DEPLOYER_PRIVATE_KEY` isn't set in root `.env`. Contract addresses live in `packages/nextjs/src/contracts/deployedContracts.ts` (regenerated on every `pnpm deploy:*`) — they are not read from env vars.

**"market already closed/archived"** — Curated entry references a market that ended before registration. Remove or replace the `conditionId` in `curated.ts`.

**"cutoff too soon"** — Polymarket's `end_date_iso` is less than 1h away. The leg would be useless; pick a longer-dated market.

**"empty orderbook"** — Market has no bids or asks right now. Usually means thin liquidity; consider dropping the market, or retry later.

**Settlement cron never resolves a market** — Check that Polymarket's `outcome_prices` has flipped to [1.00, 0.00] or [0.00, 1.00]. Any other value (ambiguous mid-settlement) returns null and retries next tick. Only a `closed=true` market with `outcome_prices` missing entirely is treated as VOIDED — otherwise, see the manual void path above.

**Ticket didn't settle after resolution** — `/api/settlement/run` is the settlement cron. Confirm the Vercel cron is hitting it (check function logs) and that the same tick returned a non-zero `settled` count.
