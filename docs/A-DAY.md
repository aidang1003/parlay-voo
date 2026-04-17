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

### F-2 — Add live polymarket data ✅ COMPLETE
- **Time:** 2 days
- **Value:** medium, will need this for the launch and settlement
- **Blockers:** values are hard-coded as of right now, some agent workloads probably depend on this as well. Possible need to remove Kelly and Betty agents to accomplish this. Better data retention needed (Postgres)
- **Notes:** Live polymarket data will be used to 1) find real bets with their live odds 2) settle active bets
- **CRON_SECRET caveat:** the Bearer check on `/api/polymarket/sync` and `/api/db/init` is probably not doing much for security and adds complexity we don't need. The realistic attack is Vercel compute-bill drain, not fund/data loss — sync is idempotent, reads a hand-curated list, and the on-chain writes are gated by `DEPLOYER_PRIVATE_KEY`. If the secret plumbing ever causes friction (local dev, new contributors, CI), drop it and replace with an in-route "skip if last run < 1h ago" idempotency gate.

### F-3 - Just in time parlay engine
- **Time:** days
- **Value:** medium
- **Blockers:** Huge overhaul of entire stack
- **Notes:** Instead of registering all possible legs in the smart contract they need to be registered at acceptance time for accurate pricing data


## Parlay Builder Frontend Fixes ✅ COMPLETE
1) Doesn't make sense to have a YES market for a parlay with a yes/no option and a NO option with a yes/no selection
 - ✅ COMPLETE cut database entries in half and re-make txtsourceref as primaryid by adding a yes odds and no odds column
 - ✅ COMPLETE Implement categories using the category pulled back from polymarket (Gamma event `category`/`tags` threaded through CuratedMarket)
 - ✅ COMPLETE Ensure odds are being built from the the correct number (now sourced from Gamma `outcomePrices` instead of per-token CLOB mid; midToPpm clamp widened to 1–99%)

## Structure Changes — Round 2 ✅ COMPLETE

1) ✅ **Deleted `scripts/gate.sh`.** `pnpm gate` is the single entrypoint; no shell wrapper left behind.
2) ✅ **HelperConfig pattern (mirrored from `eth-stable-ptf`).** New `packages/foundry/script/HelperConfig.s.sol` centralizes per-chain config: USDC address, bootstrap window, optimistic oracle liveness/bond, Uniswap NFPM/WETH, deployer key. `NetworkConfig` keyed by `block.chainid` (31337 / 84532 / 8453). `Deploy.s.sol` now calls `helperConfig.getConfig()` instead of reading envs inline. `DemoSeed.s.sol` uses the same helper so its LP broadcasts come from whichever key Deploy used. Reverts `HelperConfig__InvalidChainId` on unknown chains.
3) ✅ **Deploy flow: shell → pure forge + pnpm.** Deleted `scripts/deploy-local.sh`, `scripts/deploy-sepolia.sh`, `scripts/demo-seed.sh`, `scripts/fund-wallet.sh`. Replaced with pure `forge script` invocations wrapped in `dotenv-cli`:
   - `pnpm deploy:local` → `forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast` + `tsx scripts/sync-env.ts`
   - `pnpm deploy:sepolia` → same against `base-sepolia` RPC + `tsx scripts/sync-env.ts sepolia`
   - `pnpm fund-wallet WALLET=0x... AMOUNT=N` → new `script/FundWallet.s.sol` (mints MockUSDC on Sepolia)
   - `pnpm demo:seed` / `demo:seed:sepolia` → new `script/DemoSeed.s.sol` (LP + 5 legs; ticket creation omitted because the JIT engine now requires signed quotes — use the frontend or `scripts/risk-agent.ts`)
4) ✅ **`SetTrustedSigner.s.sol` is composable.** Added `run(uint256 ownerKey, address engineAddress)` so `Deploy.s.sol` can pass its own `cfg.deployerKey` (fixes OwnableUnauthorizedAccount when the deploy key and `DEPLOYER_PRIVATE_KEY` env differ on local anvil). Standalone `run()` still reads env.
5) ✅ **294/294 forge tests pass** after the refactor. `pnpm deploy:local` + `pnpm demo:seed` verified end-to-end against a fresh Anvil.
6) ✅ **Guiding question applied: "can this be a solidity script called via pnpm?"** Remaining `/scripts/` entries are kept because they genuinely aren't solidity:
   - `sync-env.ts` — writes `.env.local`, needs Node FS + string munging
   - `settler-bot.ts` / `risk-agent.ts` / `demo-autopilot.ts` — long-running workers that call the Next.js API and read DB state
   - `bootstrap.sh` / `dev.sh` / `dev-stop.sh` — process orchestration (installs, multi-daemon dev loop)
   - `lib/env.ts`, `lib/builder-code.ts` — shared helpers for the above

## Structure Changes ✅ COMPLETE
1) ✅ **Deleted `packages/e2e/`.** CI job removed, CLAUDE.md updated. The five vitest specs (deploy, registration, api-consistency, lifecycle, vault-flow) were Anvil-backed smoke tests redundant with forge's unit/fuzz/invariant coverage and the Next.js API tests. If we want browser-level E2E later, that belongs in `packages/nextjs/` with Playwright.
2) ✅ **Replaced `scripts/sync-env.sh` with `scripts/sync-env.ts`.** Reads `packages/foundry/broadcast/Deploy.s.sol/<chainId>/run-latest.json` directly. Removed `HOUSE_VAULT_ADDRESS / PARLAY_ENGINE_ADDRESS / LEG_REGISTRY_ADDRESS / MOCK_USDC_ADDRESS / NEXT_PUBLIC_*_ADDRESS` from root `.env` + `.env.example`. Caveat on original note: `StdJson.sol` is Solidity-only; a tsx script is the right tool to write `.env.local`. Output format preserved so Next.js reads are unchanged.
3) ✅ **Makefile → pnpm scripts.** Deleted `Makefile`. All 20+ targets now live in root `package.json` (`pnpm dev / deploy:local / gate / test / fund-wallet / ...`). Multi-process dev startup moved to `scripts/dev.sh`. Sepolia/fund-wallet logic moved to `scripts/deploy-sepolia.sh` and `scripts/fund-wallet.sh`. Tab-indent fragility and the duplicate `.PHONY` line are gone.
4) ✅ **Env consolidation.** Root `.env` is now the single hand-edited source of truth. `sync-env.ts` reads secrets (`DATABASE_URL`, `CRON_SECRET`, `DEPLOYER_PRIVATE_KEY`, `QUOTE_SIGNER_PRIVATE_KEY`, `NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL`, `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`) from root `.env` and forwards them into the auto-generated `packages/nextjs/.env.local`. Deleted `packages/nextjs/.env.example` (merged into root). Next.js still needs `.env.local` in its own dir (framework constraint) but it's now purely derived — never hand-edited.
5) ✅ **Modularized `Deploy.s.sol`.** Split into `script/steps/CoreStep.sol` (USDC/vault/registry/oracles/engine + wiring), `LockVaultStep.sol`, `YieldStep.sol`, `FaucetStep.sol`. Top-level `Deploy.s.sol` now inherits all four abstract step contracts and composes them inside one broadcast. 283/283 forge tests still green. No deploy-script solidity tests added (overkill as you called out).
6) ✅ **`/scripts/` folder — what's in it (kept, not bloat):**
   - **`bootstrap.sh`** — one-shot dev-environment installer: node, pnpm, foundry, forge deps. Used on first clone.
   - **`demo-autopilot.ts`** — background worker for demos: watches for active tickets, resolves their legs one at a time with a configurable delay, auto-settles. `pnpm demo:autopilot`.
   - **`demo-seed.sh`** — seeds a deployed stack with 5 legs, LP deposits, and 4 sample tickets across 2 wallets in Classic/Progressive/EarlyCashout modes. `pnpm demo:seed`.
   - **`gate.sh`** — old CI-gate wrapper (pre-pnpm-scripts). Safe to delete once `pnpm gate` replaces it everywhere; currently kept for anyone with muscle memory.
   - **`risk-agent.ts`** — autonomous betting agent. Discovers markets, builds candidate parlays, requests x402-paid AI risk assessment, makes sized decisions. `pnpm risk-agent` / `pnpm risk-agent:dry`.
   - **`settler-bot.ts`** — permissionless ticket settlement loop. Polls for tickets whose legs are all oracle-resolved and calls `settleTicket()`. Runs as a cron on Vercel or `pnpm settler:sepolia` locally.
   - **`sync-env.ts`** — (new) reads forge broadcast JSON, writes `packages/nextjs/.env.local`. Replaces `sync-env.sh`.
   - **`lib/env.ts`** — shared env loader for the agent scripts (reads `.env.local`).
   - **`lib/builder-code.ts`** — ERC-8021 builder-code attribution suffix for agent transactions (Node mirror of the frontend's `builder-code.ts`).
   - **New shell helpers** (`dev.sh`, `dev-stop.sh`, `deploy-local.sh`, `deploy-sepolia.sh`, `fund-wallet.sh`) — extracted from the old Makefile so `package.json` scripts stay readable.


   ## Re-factor to Chain Agnostic ✅ COMPLETE
   - So much of working with this framework is fighting next and forge to use the chain I actually want
   - Too many things are hard-coded for chain selection
   - Clean so that the project works on the anvil local chain and base sepolia
   - That way when we migrate to base mainnet we are not surprised by a few straggling functions that hardcode base sepolia

   **Fix applied (2026-04-16):** Root cause was a read/write chain split. Reads went through `useContractClient()` which pins to `NEXT_PUBLIC_CHAIN_ID`; writes called bare `writeContractAsync()` which silently used the wallet's active chain. Wallet on Base Sepolia + app pinned to Anvil = MetaMask broadcasts tx against addresses that don't exist on that chain → hang.
   - New `usePinnedWriteContract()` wrapper in `packages/nextjs/src/lib/hooks/_internal.ts`. Auto-injects `chainId` from `usePinnedChainId()` into every write. Mismatched wallets now surface `ChainMismatchError` or trigger a wallet chain-switch instead of failing silently.
   - `useDeployedContract()` now defaults to the pinned chain (was wallet chain), so reads and writes target the same network by construction. Call sites dropped the boilerplate `{ chainId: usePinnedChainId() }` option.
   - All 5 hook files (`usdc.ts`, `vault.ts`, `parlay.ts`, `ticket.ts`, `lock.ts`) migrated to the wrapper. Zero remaining direct `useWriteContract()` or `writeContractAsync({...})` without a pinned chain. `pnpm typecheck` green.
   - Added `assertDeployed()` helper in `_internal.ts` that throws `"<Contract> is not deployed on <Chain Name>"` — available for call sites that want the explicit throw pattern from `useMintTestUSDC` instead of silent `return false`.

## Non-critical bugs
- nextjs won't hot-reload on contract re-deploy
- First page-load requires refresh to actually get data. Bug with layout.js?
- Console error for pageProvider.js:2 POST https://eth.merkle.io/ net::ERR_FAILED 429 (Too Many Requests)
  > Access to fetch at 'https://eth.merkle.io/' from origin 'http://localhost:3000' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource. If an opaque response serves your needs, set the request's mode to 'no-cors' to fetch the resource with CORS disabled.
- Warning in the `forge build` command that should be silenced
- Solidify difference between, DEPLOYER WALLET, SIGNER WALLET, MY WALLET. The overhead of managing these is becoming high and it could very easily lead to errors.
- Make dev.sh/dev-stop.sh use call the same scripts I call manually (pnpm chain, pnpm deploy:local, pnpm web-dev)
- Funding my personal wallet will gas is not happening on deploy anymore

## Bailout rules

- If something in the backlog is taking 2x its estimate, stop and reassess. Don't grind.
- If a feature idea would land in a day what a scaling task would land in an hour, flip the sequence — ship the win that the user sees, bank the backlog item for next weekend.
- End Sunday night with `make gate` green (or `pnpm gate` if you did S-8). No half-merged branches going into Monday.
