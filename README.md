# ParlayVoo (Scaffold-ETH 2 port)

Crash-Parlay AMM on Base. Users buy 2-5 leg parlay tickets, watch the multiplier climb as legs resolve, cash out early or ride to full payout. LPs provide liquidity via an ERC4626-like vault.

This is a port of the original `parlay-voo` repo onto the [Scaffold-ETH 2](https://scaffoldeth.io) framework. Stack: Next.js 15 + React 19 + RainbowKit + DaisyUI + wagmi 2 + viem 2 + Foundry + Solidity 0.8.24.

## Quickstart

```bash
pnpm install               # install workspace deps
pnpm chain                 # terminal 1 — start anvil at :8545
pnpm deploy:local          # terminal 2 — deploy + regenerate deployedContracts.ts
pnpm fund-wallet:local 10000  # optional — mint 10k MockUSDC + fund 0.1 ETH to USER_WALLET_ADDRESS
pnpm dev                   # terminal 3 — Next.js at :3000
```

## Layout

```
packages/foundry/      Solidity 0.8.24 + Foundry (forge), OZ 5.x via submodule
  contracts/           HouseVault, ParlayEngine, LegRegistry, LockVaultV2,
                       AdminOracleAdapter, UmaOracleAdapter, MockUSDC,
                       MockYieldAdapter, AaveYieldAdapter
  script/              Deploy.s.sol composes script/steps/*.sol; HelperConfig
                       holds per-chain knobs; FundWallet, ResolveLeg,
                       SetTrustedSigner, CreatePool
  test/                unit/, fuzz/, invariant/, fork/, helpers/, Integration

packages/nextjs/       Next.js 15 App Router (no `src/`, SE-2 convention)
  app/                 page (onboarding) + parlay, vault, tickets, ticket/[id],
                       rehab/claim, agents, admin/{debug,tickets}, about,
                       _onboard/, api/{quote,quote-sign,quote-preview,markets,
                       chat,mcp,agent-stats,polymarket/sync,settlement/*,
                       premium/agent-quote,admin/*}, plus SE-2's debug + blockexplorer
  components/          Header, Footer, ChainGuard, FTUESpotlight, ChatPanel,
                       ParlayBuilder, VaultDashboard, TicketCard, MultiplierClimb,
                       … plus scaffold-eth/ (BlockieAvatar, FaucetButton, etc.)
  contracts/           deployedContracts.ts (auto-generated) + externalContracts.ts
  hooks/scaffold-eth/  SE-2 wagmi-backed hooks (useScaffoldRead/Write/EventHistory)
  lib/                 builder-code, cashout, risk, ticket-status, markets-cache,
                       cron-auth, onboarding, polymarket/, mcp/, uma/, db/, quote/
                       and lib/hooks/* (parlay-domain hooks: usdc, vault, lock,
                       parlay, ticket, leg, onboarding, debug)
  utils/parlay/        math, types, constants, schemas, seed, chains, polymarket/
                       (was `packages/shared` in the source repo — folded in
                       since nothing else imported it)
  utils/scaffold-eth/  SE-2 utilities (notification, getParsedError, contract,
                       networks, getMetadata, fetchPriceFromUniswap, …)
  services/web3/       wagmiConfig + wagmiConnectors (RainbowKit + burner)
  scaffold.config.ts   target networks: [foundry, baseSepolia]
  middleware.ts        first-time-visitor cookie redirect to onboarding "/"
  styles/globals.css   tailwind v4 + daisyui 5 (parlay theme) + parlay design system

scripts/
  generate-deployed-contracts.ts   forge broadcast → deployedContracts.ts
                                   (chained automatically by pnpm deploy:*)
docs/                  human + LLM specs for ARCHITECTURE, RISK_MODEL, CASHOUT,
                       DEPLOYMENT, RUNBOOK, MCP, REHAB_MODE, POLYMARKET,
                       changes/, llm-spec/
```

## Commands

```bash
pnpm chain                    # anvil :8545
pnpm deploy:local             # forge → broadcast → regenerate deployedContracts.ts
pnpm deploy:sepolia           # same, against base-sepolia + verify
pnpm fund-wallet:local 10000  # mint MockUSDC (and on local: top up ETH)
pnpm resolve-leg:local "<sourceRef>" 1   # 1=Won 2=Lost 3=Voided

pnpm test                     # forge tests + vitest
pnpm foundry:test             # forge unit/fuzz/invariant
pnpm foundry:test:fork        # forge fork tests (needs BASE_SEPOLIA_RPC_URL)
pnpm test:web                 # vitest
pnpm typecheck                # tsc --noEmit
pnpm build                    # next build
pnpm gate                     # full pre-merge gate (test + typecheck + build)

pnpm dev                      # next dev
pnpm lint
pnpm format
pnpm foundry:clean
```

## Environment

Copy `.env.example` to `.env`. The required keys for Sepolia/mainnet:

- `DEPLOYER_PRIVATE_KEY` — single signing key used by all deploy + admin scripts (and the settlement cron). On local Anvil, falls back to anvil account #0 — `Deploy.s.sol` will auto-fund the resulting deployer if needed.
- `QUOTE_SIGNER_PRIVATE_KEY` — optional EIP-712 quote signer; defaults to the deployer key everywhere except mainnet, where you should split hot signer from cold deployer.
- `BASE_SEPOLIA_RPC_URL` (+ `NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL` for the frontend).
- `ETHERSCAN_API_KEY` — single Etherscan v2 key, covers Mainnet/Sepolia/Base/Base Sepolia verification + the agent-stats route.
- `DATABASE_URL` (Postgres) for the DB-backed API routes (markets sync, settlement, admin).
- `CRON_SECRET` shared with Vercel Cron.
- `ANTHROPIC_API_KEY` for `/api/chat`.

Contract addresses are NOT in env. They live in `packages/nextjs/contracts/deployedContracts.ts` (auto-generated, committed). Vercel builds need this file present since Foundry doesn't run in the build env.

## What changed vs. the source repo

| Source pattern | SE-2 port |
| --- | --- |
| pnpm + custom `scripts/dev.sh` orchestrators | pnpm workspace + `pnpm chain` / `pnpm dev` |
| `packages/foundry/src/` | `packages/foundry/contracts/` (SE-2 convention) |
| OZ via npm `--no-git` install | OZ via git submodule (`packages/foundry/lib`) |
| `@parlayvoo/shared` workspace package | folded into `packages/nextjs/utils/parlay/` |
| ConnectKit | RainbowKit (SE-2 default; burner connector on local) |
| Tailwind 3 + custom `tailwind.config.ts` | Tailwind 4 + DaisyUI 5 with a custom `parlay` theme in `globals.css` |
| Custom `lib/wagmi.ts` chain config | `scaffold.config.ts` with `targetNetworks` |
| `scripts/generate-deployed-contracts.ts` (kept) | unchanged — emits the `~~/utils/scaffold-eth/contract` shaped file |
| Source `Header` with ConnectKitButton | RainbowKit `ConnectButton` swap |
| Source's `lib/hooks/*` (custom `useDeployedContract`, `useWriteTx`) | kept as compat shims; SE-2's `useScaffoldRead/Write/Event/Transactor` available alongside under `~~/hooks/scaffold-eth` |

The `BUILDER_SUFFIX` data-suffix on every write, the chain-pinning behavior, and the source's hook signatures are all preserved so call sites didn't need rewrites.

## Status

`pnpm gate` is green: 372 forge tests, 296 vitest tests, type-check clean, 24/24 static pages built. End-to-end deploy → ABI generation verified against local Anvil (8 contracts emitted to `deployedContracts.ts`).
