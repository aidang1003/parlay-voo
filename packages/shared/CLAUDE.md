# Shared Package -- ParlayMath Parity + Config

## Math Parity (non-negotiable)

`packages/shared/src/math.ts` must match `ParlayMath.sol` exactly:
- Same integer arithmetic
- Same rounding behavior
- Same constants
- Same PPM (1e6) / BPS (1e4) scales

## Constants

```
BASE_FEE_BPS        = 100
PER_LEG_FEE_BPS     = 50
MAX_UTILIZATION_BPS  = 8000
MAX_PAYOUT_BPS      = 500
```

These live in `constants.ts` and are imported directly by the frontend (no intermediate config layer).

## Chain Config

`chains.ts` is the TS parallel to `packages/foundry/script/HelperConfig.s.sol`:
- Chain IDs, names, default RPC URLs, explorer URLs
- `getRpcUrl()` resolves env overrides
- Consumed by `lib/wagmi.ts`, scripts, and anywhere needing chain metadata

Chain IDs were removed from `constants.ts` to avoid duplicate exports.

## TS Implementation Rules

- Use `bigint` for exact integer math when needed
- No floating point for monetary values
- Off-chain quotes must always match on-chain execution

## Change Protocol

1. Change Solidity (`ParlayMath.sol`)
2. Change TypeScript (`math.ts`)
3. Add/adjust parity tests
4. Run `pnpm test`
