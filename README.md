# ParlayVoo

**A crash-parlay AMM on Base.** Users stake USDC across 2–5 prediction-market legs, watch the multiplier climb as legs resolve, cash out early or ride to full payout. LPs underwrite the exposure and earn from fees and losing stakes.

---

## Why this exists

Traditional sportsbooks and prediction markets are one-shot: place a bet, wait, collect or lose. Nothing happens in the middle. Crash games (Aviator, JetX) showed that the middle *is* the product — the rocket climbing is what people pay to feel. ParlayVoo fuses that live-instrument mechanic with binary prediction markets, backed by an on-chain LP vault instead of a house. The ticket is an NFT, the multiplier is derived from real probabilities, and cashout is slippage-protected.

---

## Startup objectives

The list below is the working target the repo is pointed at. Items in `docs/A-DAY.md` are the current sprint backlog; this list is the longer-horizon view.

### 1. Ship a crash-parlay product users actually keep open

- Live multiplier climb during leg resolution — the core differentiator vs. every other on-chain book
- Early cashout with real slippage protection (`minOut`, priced via `ParlayMath.computeCashoutValue`)
- Three payout modes (Classic / Progressive / EarlyCashout) so users pick their own risk curve
- Frontend latency good enough that the rocket *feels* live (see scaling backlog in `docs/A-DAY.md`)

### 2. Make LP economics credible enough that real capital shows up

- ERC4626-style HouseVault, vUSDC shares, permissionless deposit/withdraw
- `totalReserved <= totalAssets()` invariant enforced on every path
- Utilization cap (80%) and per-payout cap (5% TVL) so a single lucky ticket can't drain the vault
- LockVault tiers (30/60/90 days at 1.1× / 1.25× / 1.5× weight) routing fee income Synthetix-style
- Yield on idle capital via pluggable adapter (Aave V3 on mainnet, mock locally)
- Planned: rehab mode (portion of losing stakes auto-locked as vUSDC) — design in `docs/REHAB_MODE.md`

### 3. Replace admin-managed legs with live market data

- Legs now come from a curated Polymarket sync (`pnpm db:sync`), not a hand-written seed
- JIT parlay engine: legs are only registered on-chain at ticket-acceptance time, pricing against the freshest odds (see `packages/foundry/src/core/ParlayEngine.sol` — `buyTicketSigned` is the only buy path)
- Next target: live settlement against the same Polymarket feed, removing the admin-oracle crutch

### 4. Make autonomous agents a first-class user

- `scripts/risk-agent.ts` — Kelly-criterion sized betting agent, uses the same signed-quote flow as the frontend
- `/api/mcp` — six MCP tools so external LLM agents can list markets, quote parlays, assess risk, read vault health
- Signed-quote architecture (trusted signer set at deploy time) so an agent's on-chain tx carries the same guarantees as a UI click

### 5. Stay honest on-chain

- Engine holds 0 USDC — stake flows to HouseVault via `safeTransferFrom`
- No owner drain paths; owner changes parameters, never moves user or LP funds
- Permissionless settlement — anyone can call `settleTicket()` once oracle data is in
- 294 forge tests (unit / fuzz / invariant / integration) + vitest frontend tests gate every commit
- Bootstrap admin oracle is time-boxed; production uses the propose/challenge OptimisticOracleAdapter

### 6. Operational: one deploy command, one env file

- `pnpm deploy:local` and `pnpm deploy:sepolia` are the only deploy entrypoints
- All chain config lives in `packages/foundry/script/HelperConfig.s.sol` (USDC address, oracle params, deployer key, per-chain overrides)
- Root `.env` is the single hand-edited source of truth; `scripts/sync-env.ts` writes the Next.js `.env.local` from deploy broadcasts
- No Makefile, no shell-script deploy wrappers, no contract addresses pasted into env files

---

## Getting started

```bash
pnpm bootstrap       # pnpm install + forge install
pnpm dev             # anvil + deploy + web on :3000
pnpm deploy:local    # redeploy to the running anvil
pnpm demo:seed       # seed LP + 5 sample legs
pnpm gate            # tests + typecheck + build (run before commits)
```

Deploy to Base Sepolia: fill `DEPLOYER_PRIVATE_KEY` and `QUOTE_SIGNER_PRIVATE_KEY` in `.env`, then `pnpm deploy:sepolia`.

Mint MockUSDC on Sepolia: `pnpm fund-wallet 0xYourWallet 1000`.

---

## Where things live

```
packages/foundry/    Solidity 0.8.24, HelperConfig-driven deploy
packages/nextjs/     Next.js 14 app, wagmi 2, ConnectKit
packages/shared/     ParlayMath TS mirror, Zod schemas, types
scripts/             sync-env, risk-agent, settler-bot, demo-autopilot
docs/                Architecture diagrams + per-subsystem specs
```

For architecture diagrams (fund flow, crash lifecycle, oracle state machine, lock-vault distribution) see `docs/ARCHITECTURE.md`. For economics, risk model, cashout math, and threat model see the corresponding files in `docs/`.

---

## License

MIT
