# ParlayVoo Deployment Guide

## Prerequisites

- Foundry (`curl -L https://foundry.paradigm.xyz | bash && foundryup`)
- Node.js >= 18
- pnpm >= 8
- A funded wallet on Base Sepolia

### Fund the deployer wallet

1. **Base Sepolia ETH** — [Coinbase faucet](https://www.coinbase.com/faucets/base-ethereum-goerli-faucet) or bridge from Sepolia.
2. **Base Sepolia USDC** — [Circle faucet](https://faucet.circle.com/). Need ~100 USDC for LP + demo tickets.

## Local (Anvil)

```bash
pnpm setup
pnpm dev              # anvil + deploy + web on :3000
pnpm demo:seed        # optional: LP + 5 sample legs
```

Or step-by-step:

```bash
pnpm chain            # anvil on :8545
pnpm deploy:local     # deploy contracts, sync .env.local
pnpm --filter web dev # frontend on :3000
```

Local mode uses MockUSDC (auto-minted) and the Anvil default key. No `.env` config required beyond what ships in the repo.

## Base Sepolia

```bash
# 1. Fill root .env:
#   DEPLOYER_PRIVATE_KEY=<funded key>
#   QUOTE_SIGNER_PRIVATE_KEY=<signer key — set as trusted signer during deploy>
#   ACCOUNT1_PRIVATE_KEY=<optional, for demo:seed:sepolia>
#   BASESCAN_API_KEY=<optional, for verification>
#   USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e  (or leave blank to use the HelperConfig default)

# 2. Deploy
pnpm deploy:sepolia

# 3. (Optional) seed demo data
pnpm demo:seed:sepolia

# 4. (Optional) mint MockUSDC to any wallet (local/dev only — real USDC is not mintable)
pnpm fund-wallet 0xRecipient 1000
```

### What `pnpm deploy:sepolia` does

1. Loads `HelperConfig.getBaseSepoliaConfig()` — returns `{usdc, bootstrapDays, optimisticLiveness, optimisticBond, uniswapNFPM, weth, deployerKey}`.
2. Deploys HouseVault, LegRegistry, AdminOracleAdapter, OptimisticOracleAdapter, ParlayEngine. Wires permissions and fee routing.
3. Deploys LockVault and the yield adapter.
4. Calls `SetTrustedSigner` to register `QUOTE_SIGNER_PRIVATE_KEY`'s address as the engine's trusted JIT quote signer.
5. `tsx scripts/sync-env.ts sepolia` reads the forge broadcast JSON and writes `packages/nextjs/.env.local` with all contract addresses + forwarded secrets.

Per-chain config (USDC, bootstrap length, oracle liveness/bond) lives in `packages/foundry/script/HelperConfig.s.sol`. Adding a new chain = adding a `getXxxConfig()` branch keyed on `block.chainid`.

## Contract verification

Pass `--verify` flags through forge, or verify manually:

```bash
forge verify-contract <address> src/core/HouseVault.sol:HouseVault \
  --chain base-sepolia \
  --etherscan-api-key $BASESCAN_API_KEY \
  --constructor-args $(cast abi-encode "constructor(address)" 0x036CbD53842c5426634e7929541eC2318f3dCF7e)
```

## Frontend (Vercel)

```bash
cd packages/nextjs && npx vercel
```

Required env vars on Vercel:

| Variable | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_CHAIN_ID` | Yes | `84532` for Base Sepolia |
| `NEXT_PUBLIC_LEG_REGISTRY_ADDRESS` | Yes | LegRegistry |
| `NEXT_PUBLIC_PARLAY_ENGINE_ADDRESS` | Yes | ParlayEngine |
| `NEXT_PUBLIC_HOUSE_VAULT_ADDRESS` | Yes | HouseVault |
| `NEXT_PUBLIC_LOCK_VAULT_ADDRESS` | Yes | LockVault |
| `NEXT_PUBLIC_ADMIN_ORACLE_ADDRESS` | Yes | AdminOracleAdapter |
| `NEXT_PUBLIC_USDC_ADDRESS` | Yes | USDC |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | Yes | WalletConnect project ID |
| `ANTHROPIC_API_KEY` | For chat | Enables AI chat panel |
| `BASE_SEPOLIA_RPC_URL` | For vault reads | Alchemy RPC |

Values are in `packages/nextjs/.env.local` after deploy — copy them over.

## Post-deploy checklist

- [ ] Deployer funded with ETH + USDC on Base Sepolia
- [ ] `packages/nextjs/.env.local` contains all contract addresses (auto-written by `sync-env.ts`)
- [ ] Trusted JIT signer matches `QUOTE_SIGNER_PRIVATE_KEY`
- [ ] Contracts verified on BaseScan (optional but recommended)
- [ ] Frontend connects on chain ID 84532
- [ ] Vault deposit, ticket purchase (signed quote), and claim all work end-to-end

## Env reference

| Variable | Required | Description |
|---|---|---|
| `DEPLOYER_PRIVATE_KEY` | Yes | Deploy broadcaster |
| `QUOTE_SIGNER_PRIVATE_KEY` | Yes | Registered as engine's trusted JIT quote signer |
| `ACCOUNT1_PRIVATE_KEY` | Demo only | Second wallet for `demo:seed:sepolia` |
| `BASE_SEPOLIA_RPC_URL` | Yes | RPC endpoint (default `https://sepolia.base.org`) |
| `USDC_ADDRESS` | Optional | Override Circle USDC (HelperConfig default: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`) |
| `BASESCAN_API_KEY` | Optional | For auto-verification |
