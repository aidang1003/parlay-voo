# ParlayVoo

**A crash-parlay AMM on Base.** Users stake USDC across 2–5 prediction-market legs, watch the multiplier climb as legs resolve, cash out early or ride to full payout. LPs underwrite the exposure and earn from fees and losing stakes.

---

## Why this exists

Traditional sportsbooks and prediction markets are one-shot: place a bet, wait, collect or lose. Nothing happens in the middle. Crash games (Aviator, JetX) showed that the middle *is* the product — the rocket climbing is what people pay to feel. ParlayVoo fuses that live-instrument mechanic with binary prediction markets, backed by an on-chain LP vault instead of a house. The ticket is an NFT, the multiplier is derived from real probabilities, and cashout is slippage-protected.

---

## Startup objectives

The list below is the working target the repo is pointed at. The chronological story of how we got here lives in `docs/changes/` (`A_DAY_SPRINT.md`, `B_SLOG_SPRINT.md`); deferred work lives in `docs/changes/BACKLOG.md`.

### 1. Ship a crash-parlay product users actually keep open

- Live multiplier climb during leg resolution — the core differentiator vs. every other on-chain book
- Early cashout with real slippage protection (`minOut`, priced via `ParlayMath.computeCashoutValue`)
- Three payout modes (Classic / Progressive / EarlyCashout) so users pick their own risk curve
- Frontend latency good enough that the rocket *feels* live (private RPC + batched reads — recap in `docs/changes/A_DAY_SPRINT.md`)

### 2. Make LP economics credible enough that real capital shows up

- ERC4626-style HouseVault, VOO shares, permissionless deposit/withdraw
- `totalReserved <= totalAssets()` invariant enforced on every path
- Utilization cap (80%) and per-payout cap (5% TVL) so a single lucky ticket can't drain the vault
- LockVaultV2: continuous-duration VOO locks (7-day min, no upper cap) with a fee-share curve (2.0× at 1yr, 4.0× asymptote), routing fee income Synthetix-style
- Yield on idle capital via pluggable adapter (Aave V3 on mainnet, mock locally)
- Rehab mode: losing stakes auto-lock as LEAST VOO, PARTIAL credit-wins route principal back to LPs — design in `docs/REHAB_MODE.md`

### 3. Replace admin-managed legs with live market data

- Legs now come from a curated Polymarket sync (`pnpm db:sync`), not a hand-written seed
- JIT parlay engine: legs are only registered on-chain at ticket-acceptance time, pricing against the freshest odds (see `packages/foundry/src/core/ParlayEngine.sol` — `buyTicketSigned` is the only buy path)
- Live settlement runs daily off the same Polymarket feed via `/api/settlement/run`

### 4. Make autonomous agents a first-class user

- `/api/mcp` — six MCP tools so external LLM agents can list markets, quote parlays, assess risk, read vault health
- Signed-quote architecture (trusted signer set at deploy time) so an agent's on-chain tx carries the same guarantees as a UI click

### 5. Stay honest on-chain

- Engine holds 0 USDC — stake flows to HouseVault via `safeTransferFrom`
- No owner drain paths; owner changes parameters, never moves user or LP funds
- Permissionless settlement — anyone can call `settleTicket()` once oracle data is in
- 294 forge tests (unit / fuzz / invariant / integration) + vitest frontend tests gate every commit
- Mainnet oracle is `UmaOracleAdapter` (UMA Optimistic Oracle V3 wrapper); no `onlyOwner` function can mutate outcome state. `AdminOracleAdapter` exists for testnet QA and reverts on Base mainnet.

### 6. Operational: one deploy command, one env file

- `pnpm deploy:local` and `pnpm deploy:sepolia` are the only deploy entrypoints
- All chain config lives in `packages/foundry/script/HelperConfig.s.sol` (USDC address, oracle params, deployer key, per-chain overrides)
- Root `.env` is the single hand-edited source of truth; `scripts/generate-deployed-contracts.ts` writes `packages/nextjs/src/contracts/deployedContracts.ts` from deploy broadcasts
- No Makefile, no shell-script deploy wrappers, no contract addresses pasted into env files

---

## Getting started

### Fresh machine? Install host tools first

Before running anything in this repo you need Node.js 18+, pnpm, and Foundry on your machine. pnpm is the package manager this repo targets — npm and yarn will not resolve the workspace layout correctly.

If you're missing any of those, run the host bootstrapper once:

```bash
./scripts/bootstrap.sh     # installs Node (via nvm if missing), pnpm, Foundry
```

It is safe to re-run; each check is idempotent. This script only touches host-level tooling — it does not install repo dependencies.

### One-time repo setup

With host tools in place:

```bash
pnpm dev-setup       # pnpm install + forge install (forge-std, openzeppelin-contracts)
```

Then copy `.env.example` to `.env` and fill in the keys you need (`DATABASE_URL`, `ANTHROPIC_API_KEY`, and on Sepolia `DEPLOYER_PRIVATE_KEY` + `QUOTE_SIGNER_PRIVATE_KEY`).

> **Note:** `scripts/bootstrap.sh` (host tools) and `pnpm dev-setup` (repo deps) solve different problems and are both needed on a fresh machine. They were deliberately given distinct names so neither shadows the other.

### Path A — one command

```bash
pnpm dev-start       # anvil + deploy + next dev, all in the background
pnpm dev-stop        # tear it down
```

Does everything in Path B for you. Logs land in `.pids/*.log`.

### Path B — start each piece yourself (local, from zero)

Run each in its own terminal so you can see the logs:

```bash
pnpm chain                          # 1. anvil on :8545
pnpm deploy:local                   # 2. deploy contracts + regen deployedContracts.ts
pnpm dev                            # 3. next dev on :3000
pnpm fund-wallet:local 10000        # 4. mint 10k MockUSDC + ETH to your wallet
pnpm db-init                        # 5. create the Neon tables (one-time per DB)
pnpm db-sync                        # 6. populate markets from Polymarket
```

Steps 5–6 hit the running web server, so `pnpm dev` must be up first. Step 4 funds the deployer key from `.env` by default — pass an address as the second arg to fund someone else.

### Base Sepolia

Same flow, swap the `:local` suffixes for `:sepolia` (`pnpm deploy:sepolia`, `pnpm fund-wallet:sepolia 1000`, etc.) and skip `pnpm chain`. `pnpm fund-wallet:sepolia` mints MockUSDC; for real Sepolia ETH use a public faucet (e.g. [Coinbase](https://portal.cdp.coinbase.com/products/faucet), [Alchemy](https://sepoliafaucet.com)).

### Everyday commands

```bash
pnpm gate            # tests + typecheck + build (run before commits)
pnpm re-deploy:local # wipe .next + forge artifacts, redeploy
```

---

## Debugging stuck transactions

- **Nonce hang (tx sits pending forever after an anvil restart):** anvil reset your account's on-chain nonce to 0, but your browser wallet still holds a higher cached nonce and signs new txs at it — anvil parks them in the `queued` pool forever. Verify with `curl -s -X POST http://127.0.0.1:8545 -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","method":"txpool_status","params":[],"id":1}'` — if `queued > 0`, that's it.
  - **Fix in Rabby:** gear icon → Settings → *Clear Pending* → pick the stuck network.
  - **Fix via cast:** `cast rpc anvil_setNonce 0xYourWallet 0xN --rpc-url http://127.0.0.1:8545` where `N` is **one past** the highest queued nonce (hex), then `cast rpc anvil_mine`.
  - **If it persists:** restart the dev stack (`pnpm dev:stop && pnpm dev`), hard-reload the dapp, and reconnect the wallet — that drops any wagmi/viem client-side nonce cache too.

---

## Where things live

```
packages/foundry/    Solidity 0.8.24, HelperConfig-driven deploy
packages/nextjs/     Next.js 14 app, wagmi 2, ConnectKit
packages/shared/     ParlayMath TS mirror, Zod schemas, types
scripts/             generate-deployed-contracts
docs/                Human-readable reference + subsystem specs (see docs/README.md)
docs/changes/        Chronological change log — one file per architectural change
docs/llm-spec/       LLM-only mirror of subsystem specs; humans can ignore
```

Start at `docs/README.md` for the folder index. For architecture diagrams (fund flow, crash lifecycle, oracle state machine, lock-vault distribution) see `docs/ARCHITECTURE.md`. For economics, risk model, cashout math, and threat model see the corresponding files in `docs/`. Recent architectural decisions live in `docs/changes/`.

---

## License

MIT
