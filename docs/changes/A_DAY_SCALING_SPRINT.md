# A-DAY — Scaling Sprint

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

### S-7 — Move cache into `/api/quote` + `/api/agent-stats` ❌ SKIPPED
- Depended on S-4 (Redis) which was never implemented. `agent-stats/route.ts:67-69` already has a 60s in-memory cache that's doing its job. `quote/route.ts` intentionally has no cache — quotes are stake-dependent and must stay fresh. No work needed.

### S-8 — Kill the Makefile ✅ COMPLETE
- Shipped as part of "Structure Changes ✅ COMPLETE" item #3 (line 148). `Makefile` deleted, all targets live in root `package.json` as `pnpm <script>`.

### S-9 — `deployedContracts.ts` auto-generation ✅ COMPLETE
- Shipped. `scripts/generate-deployed-contracts.ts` reads forge broadcast JSON + `out/**/*.json` and writes `packages/nextjs/src/contracts/deployedContracts.ts`. Chained onto `pnpm deploy:*`. The old 407-line hand-maintained ABI file is now a 61-line backwards-compat shim at `packages/nextjs/src/lib/contracts.ts`.

### S-10 - Re-format database naming conventions ✅ COMPLETE
- **Time:** 20 minutes
- **Value:** low makes hand writing database schema easier
- **Change:** All table names and columns names should be lowercase i.e. parlaylegs so table names don't have to be in quotations
- **Format:** Designate table with the preceeding letters tb, designate columns with some kind of preceeding syntax, would be great if that said the data type.
- **Research:** Find an industry norm for this kind of naming with which to base our naming off of.

## Feature backlog

Add your own below. For each, jot down: time estimate, value, blockers (which scaling task it depends on, if any). Then slot them into the alternation sequence.

### F-1 — Market-driven LP pool mechanics
- **Value:** High. LPs act as the house; product needs real lock + risk-exposure dynamics, not hard-coded admin knobs.
- **Blockers:** None. LockVault tiers (30/60/90d fixed) + uniform HouseVault exposure are the two weak pieces.
- **Shape:** Split into two sub-items, shipped separately. C (full on-chain leg pricing AMM) is parked until we have liquidity — not documented here.

#### F-1A — Continuous-duration lock curve (LockVaultV2) ✅ COMPLETE
- **Shipped:** `packages/foundry/src/core/LockVaultV2.sol`. Replaces `LockVault.sol`'s tier model.
- **API:** `lock(shares, duration)` + `extend(positionId, additionalDuration)`. `MIN_LOCK_DURATION = 7 days`. No hard max — the curve's diminishing returns shape the tail.
- **Weight curve:** `feeShareBps = 10_000 + MAX_BOOST_BPS * d / (d + HALF_LIFE_SECS)` with `MAX_BOOST_BPS = 30_000`, `HALF_LIFE_SECS = 730 days`. Base 1.0x at 7d, exactly 2.0x at 1yr, asymptote 4.0x as d→∞.
- **Penalty curve:** `penaltyBps = MAX_PENALTY_BPS * remaining / (remaining + HALF_LIFE_SECS)` with `MAX_PENALTY_BPS = 3_000`. Same shape as weight, applied to `remaining`. 30% asymptote on a fresh long lock. Asymptotic (not linear) penalty closes the "commit long, exit day 0 for early-weighting arb" without a hard duration cap.
- **Synthetix `accRewardPerWeightedShare` accumulator:** preserved.
- **Tier field on `LockPosition` (rehab-mode integration):** `FULL | PARTIAL | LEAST`. `extend()` is FULL-only. `LEAST` unlock is permissionless and burns principal back to LPs. `PARTIAL` principal never unlocks (`unlockAt = type(uint256).max`). See `docs/REHAB_MODE.md`.
- **Migration:** `LockVaultV2` deployed alongside old `LockVault`; `HouseVault.setLockVault()` points at V2. Old V1 positions mature naturally.
- **Tests:** `test/unit/LockVaultV2.t.sol`, `test/invariant/LockVaultInvariant.t.sol`.

#### F-1B — Utilization tranches (concentrated-risk LP positions)
- **Time:** 3-5 days. Separate PR.
- **Gate:** Draft `docs/TRANCHES.md` with math + open questions nailed down, user sign-off, *then* code.
- **Design sketch:**
  - 4 fixed tranches by utilization BPS: Senior 0-5000, Mezz 5000-7500, Junior 7500-8000, plus "full-range" (0-10000) for legacy/default LPs.
  - LP position = `(shares, tickLower, tickUpper, feeGrowthInside, lossGrowthInside)`. Junior earns fattest fees, takes first loss.
  - Uniswap V3 `feeGrowthGlobal` / `feeGrowthInside` pattern for accounting.
  - Reserve hook in `HouseVault.reservePayout()` routes fee accrual + loss exposure by tick range crossed.
- **Open questions to resolve in TRANCHES.md:**
  1. Tick granularity — fixed 4 vs 100-BPS continuous
  2. Overlay on existing VOO or replace with per-tranche share tokens
  3. Default band for existing LPs (opt-in full-range recommended)
- **Files:** new `packages/foundry/src/core/TrancheRegistry.sol`; `HouseVault.sol` gains reserve/pay hooks; `ParlayMath.sol` untouched.

#### Ordering
1. Ship F-1A to `main`. Low risk, clean rollback.
2. Draft TRANCHES.md, sign-off.
3. Ship F-1B.

### F-2 — Add live polymarket data ✅ COMPLETE
- **Time:** 2 days
- **Value:** medium, will need this for the launch and settlement
- **Blockers:** values are hard-coded as of right now, some agent workloads probably depend on this as well. Possible need to remove Kelly and Betty agents to accomplish this. Better data retention needed (Postgres)
- **Notes:** Live polymarket data will be used to 1) find real bets with their live odds 2) settle active bets
- **CRON_SECRET caveat:** the Bearer check on `/api/polymarket/sync` and `/api/db/init` is probably not doing much for security and adds complexity we don't need. The realistic attack is Vercel compute-bill drain, not fund/data loss — sync is idempotent, reads a hand-curated list, and the on-chain writes are gated by `DEPLOYER_PRIVATE_KEY`. If the secret plumbing ever causes friction (local dev, new contributors, CI), drop it and replace with an in-route "skip if last run < 1h ago" idempotency gate.

### F-3 - Just in time parlay engine ✅ COMPLETE
- **Time:** days
- **Value:** medium
- **Blockers:** Huge overhaul of entire stack
- **Notes:** Instead of registering all possible legs in the smart contract they need to be registered at acceptance time for accurate pricing data

### F-4 Real Parlay Settlement ✅ COMPLETE
- **Time:** 1-day
- **Value:** High
- **Blockers:** Admin functionality to view all tickets so we can verify
- **Description:** The legs in a ticket should have a way of actually resolving. I envision we build a service using next's framework that reads from a list of currently active legs. When the leg resolves any tickets with that leg should update. If all legs resolve as successful then resolve the ticket and payout to the user's account. If one leg is unsuccesful designate the capital we were holding can be sent back to the pool (or marked as no longer in escrow) and the ticket can be resolved.

### F-5 Trustless oracle — UMA OOv3 on Base (replace admin backdoor)
- **Time:** 2-3 days
- **Value:** High before any real-user launch. F-4 ships the settlement automation using `AdminOracleAdapter` (owner-resolved) behind a `block.chainid != 8453` guard so it can't be used on Base mainnet. This item is what unblocks mainnet.
- **Blockers:** F-4 shipped.
- **Problem:** Both existing oracle adapters route trust through the protocol owner:
  - `AdminOracleAdapter.resolve()` is `onlyOwner` — owner writes any outcome, no challenge, no appeal.
  - `OptimisticOracleAdapter.resolveDispute()` is `onlyOwner` — the propose/bond/challenge game is real, but disputes escalate to us, not to a decentralized vote. Weakens the economic guarantee.
- **Preferred path:** Replace `OptimisticOracleAdapter.sol` with a thin wrapper around UMA Optimistic Oracle V3 (deployed on Base mainnet + Sepolia). Mechanics: our relayer `assertTruth()` on UMA with the Polymarket-derived outcome + a bond; anyone can dispute during liveness; unresolved disputes escalate to UMA's DVM token-holder vote. We keep the *automation* role (read Polymarket → post assertion) but lose the *arbiter* role. Remove the owner-only `resolveDispute()` from our codebase entirely.
- **Alt paths (documented, not recommended):**
  - **Chainlink CCIP** to read Polymarket CTF resolution cross-chain from Base. Inherits Polymarket's UMA resolution for free but adds a bridge dependency.
  - **Deploy on Polygon** and read Polymarket's Conditional Token Framework directly. Cleanest decentralization story; loses the Base UX positioning and forces a full chain migration.
- **Acceptance:** no `onlyOwner` function in the oracle path can alter a leg outcome. Ticket settlement remains permissionless. Unit + fork tests against UMA OOv3 on Base Sepolia.
- **Consumer safeguard we ship with F-4 in the meantime:** `AdminOracleAdapter.resolve()` reverts on `block.chainid == 8453`, so the backdoor is literally unreachable on mainnet until F-5 lands.

### F-6 Debug Admin Commands ✅ COMPLETE
Shipped as a single `/admin/debug` page plus a testnet-only banner; replaces the dismissible `DemoBanner`.

- **Gating.** `useIsTestnet()` (chain 31337 / 84532). `TestnetBanner` renders null on Base mainnet and the page itself shows "Disabled on this chain". API routes return 404 off testnet. `AdminOracleAdapter.resolve()` still has its `block.chainid != 8453` revert as the last line of defense.
- **Mint MockUSDC.** Slider (1 – 100,000) + numeric input. Reuses `useMintTestUSDC(amount)` — the existing hook already accepted an optional amount override, no signature change needed.
- **DB buttons.** "Initialize DB" and "Sync Polymarket" call two thin testnet-gated proxy routes (`/api/admin/db-init`, `/api/admin/sync`) that import the existing cron handlers in-process and pass `Authorization: Bearer $CRON_SECRET`. Avoids looping through Vercel's SSO gate on preview URLs (which was 401-ing the first HTTP-fetch attempt).
- **Leg resolver.** Lists every unresolved leg referenced by any ticket. Question + yes/no probabilities are joined from `/api/markets` (DB) rather than the on-chain `LegRegistry` snapshot, which can drift from the latest CLOB mid. Per-row YES / NO / VOID buttons post `{ legId, status }` to `/api/admin/resolve-leg`, which signs `AdminOracleAdapter.resolve()` with `DEPLOYER_PRIVATE_KEY` via viem. The original plan was to shell out to `pnpm resolve-leg:*`, but Vercel functions don't have pnpm/forge on PATH (`spawn pnpm ENOENT`), so we call the contract directly instead.
- **Files:** `components/TestnetBanner.tsx`, `app/admin/debug/page.tsx`, `app/api/admin/{resolve-leg,db-init,sync}/route.ts`, `lib/hooks/debug.ts`. `DemoBanner` + its test deleted.



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
   - `risk-agent.ts` / `demo-autopilot.ts` — long-running workers that call the Next.js API and read DB state (settlement moved in-process to `/api/settlement/run` as part of F-4)
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
   - ~~**`settler-bot.ts`**~~ — replaced by `/api/settlement/run` cron in F-4. The route unifies Phase A (relay Polymarket resolutions into `AdminOracleAdapter`) with Phase B (call `settleTicket()` when all legs are resolvable) in one request.
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
- ✅ COMPLETE **Hot-reload on contract re-deploy.** Verified against live dev stack: `pnpm deploy:local` rewrites `packages/nextjs/src/contracts/deployedContracts.ts`, webpack picks the change up (`✓ Compiled in 3.2s` in next-dev log), and the next request recompiles the page. The `managedPaths: []` + `followSymlinks: true` block already in `next.config.mjs:24-27` does the job. Stale note.
- ✅ COMPLETE **First page-load requires refresh.** Root cause: `.env.example` ships `NEXT_PUBLIC_CHAIN_ID=84532`, so a local dev who copies it ends up pinning the frontend to Base Sepolia while Anvil runs on 31337 — `useDeployedContract` resolves stale/empty addresses until the user manually overrides the chain. Fix: `scripts/dev.sh` now exports `NEXT_PUBLIC_CHAIN_ID=31337` after sourcing `.env`, so the local stack always reads from Anvil regardless of `.env` content. Verified the client bundle now inlines `const env = Number("31337")` in `usePinnedChainId`.
- ✅ COMPLETE **`eth.merkle.io` CORS spam silenced.** ConnectKit's default mainnet transport is `eth.merkle.io` which blocks CORS and rate-limits quickly. `packages/nextjs/src/lib/wagmi.ts:39` explicitly maps `[mainnet.id]: http("https://cloudflare-eth.com")`, so ENS lookups route through Cloudflare instead. Fix landed inline; the A-DAY entry was just stale.
- ✅ COMPLETE **Silence `forge build` warnings.** `forge-lint` (nightly) was emitting 6 warnings across test/script files. All are known-safe patterns: `uint8(48+i)` with `i<6` in `ParlayEngine.t.sol`, raw `IERC20.transfer()` on the vault's own OZ share token in `Graduate.t.sol` (×3) and `Rehab.t.sol`, and the Uniswap V3 tick-alignment idiom `(887272 / tickSpacing) * tickSpacing` in `CreatePool.s.sol`. Silenced per-site with `// forge-lint: disable-next-line(<lint>)` comments. Production contracts (`src/`) had zero warnings — all six lived in non-production code.
- ✅ COMPLETE **Solidify difference between DEPLOYER / SIGNER / MY WALLET.** CLAUDE.md now documents that `DEPLOYER_PRIVATE_KEY` is the single required key (deploys, admin calls, settlement cron, agent scripts) and `QUOTE_SIGNER_PRIVATE_KEY` falls back to it when unset.
- ✅ COMPLETE **`dev.sh` wraps the pnpm scripts instead of inlining commands.** The script previously ran `anvil`, `forge clean + forge script`, and `cd packages/nextjs && pnpm dev` directly — so any change to `pnpm chain` / `pnpm deploy:local` / `pnpm dev` had to be mirrored in two places. Now `dev.sh` calls `pnpm -C "$ROOT" chain`, `pnpm -C "$ROOT" deploy:local`, and `pnpm -C "$ROOT" dev` — single code path. `dev-stop.sh` was already using the port-kill fallback so it continues to clean up the pnpm→child process tree correctly. Bash syntax verified (`bash -n`).
- ✅ COMPLETE **Auto-fund personal wallet on Anvil deploy.** `Deploy.s.sol` tops up the deployer from Anvil account #0 when `block.chainid == 31337` and balance < 0.01 ETH. `FundWallet.s.sol` does the same for deployer + target wallet.
- ✅ COMPLETE **Finish the `parlaycity` → `parlayvoo` rename.** `ARCH_REVIEW_2.md` (P6) claimed this was done, but the rename had never actually been applied. Root `package.json` name was still `parlaycity`, `packages/shared/package.json` was still `@parlaycity/shared`, and all ~20 import sites in `packages/nextjs/src/` still imported from `@parlaycity/shared`. Executed the rename: updated both package names, `packages/nextjs/package.json` workspace dep, `next.config.mjs` `transpilePackages`, every `import ... from "@parlaycity/shared"` in source + CLAUDE.md, regenerated `pnpm-lock.yaml`. `pnpm typecheck` + 276 vitest tests green.
- ✅ COMPLETE **Deploy console messages cover every wiring call.** Audited `Deploy.s.sol` + steps against the emitted log: addresses, amounts, and ordering were already accurate, but four state-changing setter calls ran silently between the address prints — `vault.setLockVault`, `vault.setSafetyModule`, `lockVault.setFeeDistributor` (all in `LockVaultStep`), and `vault.setYieldAdapter` (in `YieldStep`). Added two confirmation log lines so the deploy output reflects every operation; no behavior change. Re-deploy output: `LockVault + SafetyModule wired on vault; FeeDistributor set on LockVault` / `YieldAdapter wired on vault`.
- ✅ COMPLETE **`pnpm deploy:sepolia` no longer rewrites `deployments/31337.json`.** `scripts/generate-deployed-contracts.ts:213` iterated `Object.keys(merged)` when writing per-chain JSON, so a targeted run (e.g. chainId=84532) would re-emit every chain loaded from the existing TS file — polluting git diffs. Now tracks `updatedChains[]` inside the loop and only writes JSON for chains we actually regenerated. The TS file still gets merged output across all chains (correct — frontend needs both mappings). Verified end-to-end with a synthetic broadcast fixture: `... 84532` only writes `84532.json`, `... 31337` only writes `31337.json`, no-arg run still writes both.

## Random Things I think of

Grab-bag of smaller ideas. Each fleshed below with the same Time/Value/Blockers/Files/Change shape the rest of the doc uses, so they can be slotted into the alternation sequence or promoted to S-#/F-# when picked up.

### R-1 — ABIs in Postgres (shared deployment registry)
- **Time:** 5–8 hours
- **Value:** Low now, medium later. Bites once we have multiple devs making frontend-only changes against a shared deploy — today everyone regenerates `deployedContracts.ts` locally and re-commits, which creates spurious diffs. A DB-backed registry also gives us history across deploys (useful for verifying old tickets against the ABI they were minted under).
- **Blockers:** None. Neon Postgres + `lib/db/client.ts` already wired.
- **Files:** `scripts/generate-deployed-contracts.ts`, `packages/nextjs/src/lib/db/schema.sql`, `packages/nextjs/src/lib/db/client.ts`, `packages/nextjs/src/lib/hooks/useDeployedContract.ts`
- **Change:** add `tbcontractabi (name TEXT, chainid INT, deployedat TIMESTAMPTZ, address TEXT, abi JSONB, PRIMARY KEY (chainid, name, deployedat))`. Extend `generate-deployed-contracts.ts` to `INSERT` each contract alongside the file write (keep the TS file — it's the zero-latency path). Add a DB fallback in `useDeployedContract` for historical lookups (e.g. reading an old ticket's engine ABI).
- **Non-goal:** do NOT replace `deployedContracts.ts` — it's the fast path for build-time types and SSR. DB is a secondary mirror.

### R-2 — Drop `poly:` prefix from `txtsourceref` PK ✅ COMPLETE
- **Shipped:** sync writes the raw conditionId as PK; `stripPolyPrefix()` + its 7 tests deleted. `parsePolySourceRef()` redefined as a 0x-hex-64 shape sniffer so `/api/quote`, `/api/quote-sign`, and `lib/mcp/tools.ts` keep working without a `source` field on `Leg`. `ParlayBuilder.tsx`'s "Odds locked" badge now checks `sourceRef.startsWith("0x")`.
- **Migration:** `packages/nextjs/src/lib/db/migrations/2026-04-20-drop-poly-prefix.sql` — one-shot idempotent `UPDATE ... WHERE txtsourceref LIKE 'poly:%'`. Run against Neon in each env; or, since `schema.sql` is drop-and-recreate, a fresh `/api/db/init` + `/api/polymarket/sync` also lands on the new format (at the cost of wiping `tbpolymarketresolution`).
- **Files touched:** `packages/nextjs/src/app/api/polymarket/sync/route.ts`, `packages/nextjs/src/lib/polymarket/markets.ts`, `packages/nextjs/src/app/api/settlement/runner.ts`, `packages/nextjs/src/app/api/settlement/run/lib.ts`, `packages/nextjs/src/app/api/settlement/run/__tests__/lib.test.ts`, `packages/nextjs/src/components/ParlayBuilder.tsx`, `packages/nextjs/src/components/__tests__/ParlayBuilder.test.tsx`, `packages/nextjs/src/lib/db/schema.sql`, `packages/nextjs/src/lib/db/migrations/2026-04-20-drop-poly-prefix.sql`, `packages/foundry/src/core/ParlayEngine.sol` (doc comment only), `packages/foundry/script/ResolveLeg.s.sol` (doc comment only).
- **Gate:** `pnpm typecheck` + `pnpm test:web` (269 passing) + `pnpm build` green. `forge test` not run in this sandbox — solidity edits were comment-only, no functional change.
- **Caveat:** if we ever add a second market source this decision reverses. Acceptable — a second source is a bigger refactor anyway and we'd pick a new scheme then. Foundry unit tests that use `"poly:a"` as arbitrary string sourceRef fixtures (`SignedQuote.t.sol`) were left alone — they're valid test data regardless of the off-chain convention.

### R-3 — Store raw Gamma payloads in JSONB
- **Time:** 6–10 hours
- **Value:** Medium. Unlocks two things: (a) cheap backfills when we want a new field (volume, liquidity, tags) without re-syncing, (b) a single source of truth for the LLM risk agent and MCP surface, which currently has to re-call Polymarket for anything past `ppm`. GIN indexes on specific JSON paths keep reads fast.
- **Blockers:** None, but pairs naturally with R-4 (curation needs `volume`, which this exposes for free).
- **Files:** `packages/nextjs/src/lib/db/schema.sql`, `packages/nextjs/src/app/api/polymarket/sync/route.ts`, `packages/nextjs/src/lib/db/client.ts`, `packages/shared/src/polymarket/featured.ts`
- **Change:** add `jsonbapipayload JSONB` to `tblegmapping`. Capture the full Gamma event object in the sync route; write it alongside the scalar columns we already extract (`yesProbabilityPpm`, `noProbabilityPpm`, `cutoffTime`). Keep scalars — they're the hot-path read. Create a GIN index on `jsonbapipayload jsonb_path_ops` so future field lookups (e.g. `volume24hr`, `tags`) stay O(log n).
- **Watch:** JSONB adds ~1–3 KB per row. At current ~50 markets that's trivial; worth re-checking if we scale the synced universe to 10k+.

### R-4 — Curation score (rank markets by volume + balance)
- **Time:** 4–6 hours
- **Value:** Medium-high. The frontend currently shows whatever Polymarket returned in sync order, which is effectively random. Surfacing deep-liquidity, near-coinflip markets makes the builder feel curated and the edge math happier (away from the 1–99% clamp).
- **Blockers:** R-3 is a natural predecessor (volume comes from the Gamma payload). Can ship standalone by parsing `volume24hr` inline in sync, but R-3 first is cleaner.
- **Files:** `packages/shared/src/polymarket/types.ts` (`CuratedMarket`), `packages/nextjs/src/lib/db/schema.sql`, `packages/nextjs/src/app/api/polymarket/sync/route.ts`, `packages/nextjs/src/lib/polymarket/markets.ts`, `packages/shared/src/polymarket/featured.ts`
- **Change:**
  1. Parse `volume24hr` (string → number) during featured fetch.
  2. Add `bigcurationscore BIGINT` to `tblegmapping`.
  3. Compute at sync time: `score = floor(volume * 1e3) - abs(ppm - 500_000)`. Volume dominates; balance penalty caps at 500k which is ~500 USD of volume. Tune once we see real data.
  4. Change `getActiveMarkets()` ORDER BY from `txtsourceref` to `bigcurationscore DESC, volume24hr DESC`.
  5. Add `curationScore?: number` to `CuratedMarket` so future UI can surface it.
- **No UI work needed** — the parlay builder already renders in array order.

### R-5 — Debug banner + mint + leg resolver ✅ COMPLETE
Shipped as F-6 (see line 141). `/admin/debug` page with testnet-gated mint UI and leg resolver. Leaving this bullet here as a pointer; remove on the next doc pass.


## Bailout rules

- If something in the backlog is taking 2x its estimate, stop and reassess. Don't grind.
- If a feature idea would land in a day what a scaling task would land in an hour, flip the sequence — ship the win that the user sees, bank the backlog item for next weekend.
- End Sunday night with `make gate` green (or `pnpm gate` if you did S-8). No half-merged branches going into Monday.
