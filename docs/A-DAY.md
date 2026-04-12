# A-DAY — 48-hour scaling sprint

Backlog for the weekend heads-down session. Target: get parlay-voo from "hackathon build that feels slow" to "production-ready for 250 users, with a clear path to 1000."

This doc is the working checklist. Feel free to ingest this doc into the real documentation.

## How to use this list

Don't just run top-to-bottom. Alternate **scaling work** (S-#) and **feature work** (F-#), and pick the next item by its **value / time** ratio — highest wins. Rules of thumb:

- A 30-minute task that unblocks three later tasks beats a 3-hour task that stands alone.
- A scaling task that changes how users *feel* the app (home page latency, tickets page loading) beats one that only shows up under load you don't have yet.
- If a scaling task becomes a prerequisite for a feature you want to ship (e.g. need the indexer before the leaderboard feature), promote it.
- If two tasks tie, pick the one you'll actually finish — momentum matters more than optimality.

Mark tasks `✅ COMPLETE` when done. Don't delete — keeps a log of what shipped vs what got deferred.

## Already done (Friday night)

- ✅ COMPLETE **Alchemy private RPC swap.** `packages/nextjs/src/lib/wagmi.ts` now uses a `fallback` transport: Alchemy primary, public Base Sepolia as backup. Reads `NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL` from env. `scripts/sync-env.sh` preserves the var across deploys so `make deploy-*` won't wipe it. Add `NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL=<alchemy-url>` to `packages/nextjs/.env.local` and restart `next dev`.

## Scaling backlog

### S-1 — Tune React Query defaults ✅ COMPLETE
- **Time:** 5 minutes
- **Value:** High. Halves background-tab RPC load and kills redundant refetches on route navigation. Whole app feels snappier with zero risk.
- **Files:** `packages/nextjs/src/components/providers.tsx`
- **Change:** pass `defaultOptions` to `new QueryClient()`:
  ```ts
  {
    queries: {
      staleTime: 10_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      refetchIntervalInBackground: false,
    },
  }
  ```
- **Do this first.** It's the highest ratio task in the whole doc.

### S-2 — RPC call counter (debug overlay) ✅ COMPLETE
- **Time:** 1 hour
- **Value:** Medium now, high later. Lets you measure whether subsequent optimizations actually helped. Without this you're flying blind.
- **Files:** `packages/nextjs/src/lib/hooks.ts` (`useContractClient` at ~line 22), new component `packages/nextjs/src/components/DebugRpcCounter.tsx`
- **Change:** wrap the viem client's `readContract` so every call increments `window.__rpcCalls`. Add a fixed-position overlay visible only when `?debug=1` query param is set. Show calls/min rolling average.
- **Why before the big optimizations:** you want a baseline reading on `/`, `/tickets`, `/vault` before touching the hooks.

### S-3 — Batch reads in useVaultStats + useParlayConfig ✅ COMPLETE
- **Time:** 2 hours
- **Value:** High. Home page mount drops from ~10 RPC round trips to ~2. Most visible improvement users will feel.
- **Files:** `packages/nextjs/src/lib/hooks.ts:149-216` (useVaultStats), `packages/nextjs/src/lib/hooks.ts:218-288` (useParlayConfig)
- **Change:** replace clusters of `useReadContract` with a single `useReadContracts` per hook. wagmi auto-batches into Multicall3 (already deployed on Base Sepolia at `0xcA11bde05977b3631167028862bE2a173976CA11`). Preserve the same return shape so callers don't need to change.

### S-7 — Move cache into `/api/quote` + `/api/agent-stats`
- **Time:** 30 minutes each (after S-4)
- **Value:** Medium. These are the other two routes with either broken or missing caching. Cheap to clean up once Redis is wired.
- **Files:** `packages/nextjs/src/app/api/quote/route.ts`, `packages/nextjs/src/app/api/agent-stats/route.ts:58-64`

### S-8 — Kill the Makefile (optional, Option A from planning)
- **Time:** 1-2 hours
- **Value:** Quality-of-life only. No performance impact. Do this if the Makefile is still annoying you by Sunday afternoon and you have spare cycles.
- **Files:** `Makefile` (delete), `package.json` root (add scripts), `packages/nextjs/package.json` (tweak scripts), `packages/foundry/package.json` (add forge wrappers), possibly `scripts/dev.sh` for the multi-process dev loop
- **Change:** replace `make dev / make deploy-local / make gate / make test-all` with `pnpm dev / pnpm deploy:local / pnpm gate / pnpm test`. Keep the same behavior, just through package.json scripts.

### S-9 — `deployedContracts.ts` auto-generation (optional, Option B from planning)
- **Time:** 3-4 hours
- **Value:** Medium-low. Kills the hand-maintained 407-line ABI file at `packages/nextjs/src/lib/contracts.ts`, which drifts every time you touch a contract. Worth doing if you're about to edit contracts heavily.
- **Files:** new forge script `packages/foundry/script/GenerateAbis.s.sol` or a tsx script that reads `packages/foundry/out/**/*.json`, writes `packages/nextjs/src/contracts/deployedContracts.ts`. Update `hooks.ts` imports.
- **Natural bundling:** do this during S-3 if you find yourself already rewriting how hooks consume ABIs.

### S-10 - Re-format database naming conventions ✅ COMPLETE
- **Time:** 20 minutes
- **Value:** low makes hand writing database schema easier
- **Change:** All table names and columns names should be lowercase i.e. parlaylegs so table names don't have to be in quotations
- **Format:** Designate table with the preceeding letters tb, designate columns with some kind of preceeding syntax, would be great if that said the data type.
- **Research:** Find an industry norm for this kind of naming with which to base our naming off of.

## Feature backlog

Add your own below. For each, jot down: time estimate, value, blockers (which scaling task it depends on, if any). Then slot them into the alternation sequence.

### F-1 — Implement real AMM pool
- **Time:** 1 day
- **Value:** high, the product is not complete until we have an actual lock up mechanism driven by market dynamics
- **Blockers:** currect lock functionality has return periods and values hard-coded 
- **Notes:**

### F-2 — Add live polymarket data
- **Time:** 2 days
- **Value:** medium, will need this for the launch and settlement
- **Blockers:** values are hard-coded as of right now, some agent workloads probably depend on this as well. Possible need to remove Kelly and Betty agents to accomplish this. Better data retention needed (Postgres)
- **Notes:** Live polymarket data will be used to 1) find real bets with their live odds 2) settle active bets
- **CRON_SECRET caveat:** the Bearer check on `/api/polymarket/sync` and `/api/db/init` is probably not doing much for security and adds complexity we don't need. The realistic attack is Vercel compute-bill drain, not fund/data loss — sync is idempotent, reads a hand-curated list, and the on-chain writes are gated by `DEPLOYER_PRIVATE_KEY`. If the secret plumbing ever causes friction (local dev, new contributors, CI), drop it and replace with an in-route "skip if last run < 1h ago" idempotency gate.


## Parlay Builder Frontend Fixes ✅ COMPLETE
1) Doesn't make sense to have a YES market for a parlay with a yes/no option and a NO option with a yes/no selection
 - ✅ COMPLETE cut database entries in half and re-make txtsourceref as primaryid by adding a yes odds and no odds column
 - ✅ COMPLETE Implement categories using the category pulled back from polymarket (Gamma event `category`/`tags` threaded through CuratedMarket)
 - ✅ COMPLETE Ensure odds are being built from the the correct number (now sourced from Gamma `outcomePrices` instead of per-token CLOB mid; midToPpm clamp widened to 1–99%)

## Bailout rules

- If something in the backlog is taking 2x its estimate, stop and reassess. Don't grind.
- If a feature idea would land in a day what a scaling task would land in an hour, flip the sequence — ship the win that the user sees, bank the backlog item for next weekend.
- End Sunday night with `make gate` green (or `pnpm gate` if you did S-8). No half-merged branches going into Monday.
