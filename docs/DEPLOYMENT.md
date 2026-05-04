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
```

Or step-by-step:

```bash
pnpm chain            # anvil on :8545
pnpm deploy:local     # deploy contracts, regenerate deployedContracts.ts
pnpm --filter web dev # frontend on :3000
```

Local mode uses MockUSDC (auto-minted). The Deploy script auto-funds the deployer from Anvil account #0 if needed. No `.env` config required beyond what ships in the repo.

To fund a wallet with MockUSDC + ETH on Anvil:
```bash
pnpm fund-wallet:local 10000
```

## Base Sepolia

```bash
# 1. Fill root .env:
#   WARM_DEPLOYER_PRIVATE_KEY=<funded key>
#   HOT_SIGNER_PRIVATE_KEY=<signer key — set as trusted signer during deploy>
#   ETHERSCAN_API_KEY=<optional, for verification>
#   USE_REAL_USDC=true  (use the chain's canonical Circle USDC; otherwise deploys MockUSDC)

# 2. Deploy
pnpm deploy:sepolia

# 3. (Optional) mint MockUSDC to any wallet
pnpm fund-wallet:sepolia 1000
```

### What `pnpm deploy:sepolia` does

1. Loads `HelperConfig.getBaseSepoliaConfig()` — returns `{usdc, bootstrapDays, umaOracleV3, umaLiveness, umaBondAmount, uniswapNFPM, weth, deployerKey}`.
2. Deploys HouseVault, LegRegistry, AdminOracleAdapter, UmaOracleAdapter (wrapping UMA OOv3 at `0x0F7fC5E6482f096380db6158f978167b57388deE` on Base Sepolia), ParlayEngine. Wires permissions and fee routing.
3. Deploys LockVaultV2 (continuous-duration lock curve) and the yield adapter.
4. Calls `SetTrustedSigner` to register `HOT_SIGNER_PRIVATE_KEY`'s address as the engine's trusted JIT quote signer.
5. `tsx scripts/generate-deployed-contracts.ts 84532` reads the forge broadcast JSON + ABIs from `forge out/` and writes `packages/nextjs/src/contracts/deployedContracts.ts`.

Per-chain config (USDC, bootstrap length, UMA OOv3 address / liveness / bond) lives in `packages/foundry/script/HelperConfig.s.sol`. Adding a new chain = adding a `getXxxConfig()` branch keyed on `block.chainid`.

## Onboarding ETH drip

The new-user onboarding page on `/` drips 0.005 ETH for gas via `POST /api/onboarding/claim-eth`. The relayer key is `ANVIL_ACCOUNT_0` on local and `HOT_SIGNER_PRIVATE_KEY` on testnet — no contract, no separate deploy. Keep the testnet hot signer wallet topped up.

## Contract verification

Pass `--verify` flags through forge, or verify manually:

```bash
forge verify-contract <address> src/core/HouseVault.sol:HouseVault \
  --chain base-sepolia \
  --etherscan-api-key $ETHERSCAN_API_KEY \
  --constructor-args $(cast abi-encode "constructor(address)" 0x036CbD53842c5426634e7929541eC2318f3dCF7e)
```

## Frontend (Vercel)

```bash
cd packages/nextjs && npx vercel
```

Contract addresses are baked into `deployedContracts.ts` (committed to git), so no `NEXT_PUBLIC_*_ADDRESS` env vars are needed on Vercel.

Required env vars on Vercel:

| Variable | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_CHAIN_ID` | Yes | `84532` for Base Sepolia, `31337` for local |
| `NEXT_PUBLIC_WC_PROJECT_ID` | Yes | WalletConnect project ID |
| `HOT_SIGNER_PRIVATE_KEY` | Yes | Server-side JIT quote signing |
| `ANTHROPIC_API_KEY` | For chat | Enables AI chat panel |
| `BASE_SEPOLIA_RPC_URL` | Optional | Alchemy RPC (fallback: public Base Sepolia) |

## Post-deploy checklist

- [ ] Deployer funded with ETH + USDC on Base Sepolia
- [ ] `deployedContracts.ts` regenerated with correct addresses (auto-written by `generate-deployed-contracts.ts`)
- [ ] Trusted JIT signer matches `HOT_SIGNER_PRIVATE_KEY`
- [ ] Contracts verified on BaseScan (optional but recommended)
- [ ] Frontend connects on chain ID 84532
- [ ] Vault deposit, ticket purchase (signed quote), and claim all work end-to-end

## Env reference

| Variable | Required | Description |
|---|---|---|
| `WARM_DEPLOYER_PRIVATE_KEY` | Yes | Deploy broadcaster |
| `HOT_SIGNER_PRIVATE_KEY` | Yes | Registered as engine's trusted JIT quote signer |
| `BASE_SEPOLIA_RPC_URL` | Yes | RPC endpoint (default `https://sepolia.base.org`) |
| `USE_REAL_USDC` | Optional | `true` → canonical Circle USDC for the chain (per `CodeConstants`). Unset / `false` → deploy MockUSDC (mint button works in-app, even on mainnets — see CoreStep warning). |
| `ETHERSCAN_API_KEY` | Optional | Single Etherscan v2 key — covers Mainnet/Sepolia/Base/Base Sepolia auto-verification |
