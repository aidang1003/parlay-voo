# ParlayCity Runbook

## Quick Start

```bash
git clone <repo>
cd parlay-voo
pnpm setup
pnpm dev              # anvil + deploy + web on :3000 (single command)
```

Or, for manual control:

```bash
pnpm chain            # terminal 1: anvil on :8545
pnpm deploy:local     # terminal 2: deploy + sync .env.local
pnpm --filter web dev # terminal 3: frontend on :3000
```

## Common Operations

### Mint Test USDC + Fund ETH (local)
```bash
pnpm fund-wallet:local 10000    # Mints USDC + sends 0.1 ETH from Anvil #0
```

Or manually via cast:
```bash
cast send <MOCK_USDC> "mint(address,uint256)" <YOUR_ADDR> 10000000000 \
  --rpc-url http://127.0.0.1:8545 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

For one-off ETH funding without the script:
```bash
cast send <YOUR_ADDR> --value 0.1ether --rpc-url http://127.0.0.1:8545 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

### Onboarding ETH drip (Sepolia)

The onboarding step at `/` drips 0.005 ETH for gas via `POST /api/onboarding/claim-eth`. The relayer is `HOT_SIGNER_PRIVATE_KEY` on testnet (anvil#0 locally) — no contract, no separate deploy. Just keep the hot signer wallet topped up.

**Check the relayer balance:**

```bash
cast balance $(cast wallet address --private-key $HOT_SIGNER_PRIVATE_KEY) --rpc-url base-sepolia
```

**Top it up** from your funding wallet:

```bash
cast send $(cast wallet address --private-key $HOT_SIGNER_PRIVATE_KEY) --value 0.1ether \
  --rpc-url base-sepolia --private-key $WARM_DEPLOYER_PRIVATE_KEY
```

### Check Vault Stats
```bash
cast call <HOUSE_VAULT> "totalAssets()(uint256)" --rpc-url http://127.0.0.1:8545
cast call <HOUSE_VAULT> "totalReserved()(uint256)" --rpc-url http://127.0.0.1:8545
```

### Resolve a Leg (FAST mode)
```bash
cast send <ADMIN_ORACLE> "resolve(uint256,uint8,bytes32)" <LEG_ID> 1 0x01 \
  --rpc-url http://127.0.0.1:8545 \
  --private-key <ADMIN_KEY>
```
Status values: 0=Unresolved, 1=Won, 2=Lost, 3=Voided

### Check Ticket Status
```bash
cast call <PARLAY_ENGINE> "getTicket(uint256)" <TICKET_ID> --rpc-url http://127.0.0.1:8545
```

## Troubleshooting

### "Insufficient liquidity"
Vault doesn't have enough free USDC. Either:
- Deposit more USDC to vault
- Reduce ticket stake
- Check utilization isn't at cap

### "Cutoff passed"
Leg's betting window has closed. Create legs with future cutoff times.

### Transaction reverts with no message
- Check USDC approval: `cast call <USDC> "allowance(address,address)" <USER> <ENGINE>`
- Check USDC balance: `cast call <USDC> "balanceOf(address)" <USER>`

### Anvil reset
```bash
# Kill anvil and restart
pnpm dev:stop
pnpm chain                    # terminal 1
pnpm deploy:local             # terminal 2 — regenerates deployedContracts.ts
# Next.js HMR picks up the new addresses automatically (no restart needed)
```

## Monitoring

### Services health
```bash
curl http://localhost:3001/health
```

### Exposure report
```bash
curl http://localhost:3001/exposure
```

## Emergency

### Pause all contracts
```bash
cast send <PARLAY_ENGINE> "pause()" --private-key <ADMIN_KEY> --rpc-url <RPC>
cast send <HOUSE_VAULT> "pause()" --private-key <ADMIN_KEY> --rpc-url <RPC>
```

### Unpause
```bash
cast send <PARLAY_ENGINE> "unpause()" --private-key <ADMIN_KEY> --rpc-url <RPC>
cast send <HOUSE_VAULT> "unpause()" --private-key <ADMIN_KEY> --rpc-url <RPC>
```
