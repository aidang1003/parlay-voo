# F-5 — UMA OOv3 trustless oracle on Base

Removes the last admin backdoor in the oracle path before mainnet launch. Replaces the owner-arbitrated `OptimisticOracleAdapter` with a thin wrapper around UMA Optimistic Oracle V3. After this change, **no `onlyOwner` function anywhere in the oracle path can alter a leg outcome on Base mainnet.**

## Part 1 — Human Spec

### What changed

- New contract: `UmaOracleAdapter.sol`. Wraps UMA OOv3 (`0x2aBf1Bd76655de80eDB3086114315Eec75AF500c` mainnet / `0x0F7fC5E6482f096380db6158f978167b57388deE` Sepolia). Implements our `IOracleAdapter`.
- Deleted: `OptimisticOracleAdapter.sol` + its unit test. The owner-only `resolveDispute()` is gone entirely.
- `AdminOracleAdapter` stays. Still guarded by `require(block.chainid != 8453)` — unreachable on mainnet, available on Anvil + Base Sepolia.
- `quote-sign` now picks UMA on Base mainnet, Admin on testnets (with an `NEXT_PUBLIC_ORACLE_MODE=uma` escape hatch on Sepolia to exercise UMA end-to-end).
- Settlement cron (`/api/settlement/run`) branches per-leg on the snapshotted `oracleAdapter` address. Admin legs: one-shot `resolve()` as before. UMA legs: two-phase (assert → wait liveness → settle).

### How UMA resolution works for us

1. Anyone calls `UmaOracleAdapter.assertOutcome(legId, status, outcome, claim)` with a bond in USDC. The adapter forwards to UMA's `assertTruth`.
2. UMA opens a liveness window. Anyone can dispute by calling `uma.disputeAssertion(assertionId, ...)` and posting a matching bond.
3. Undisputed → anyone calls `uma.settleAssertion` (or our convenience `settleMature(legId)`) → UMA calls back into our adapter → we write final state. Truthful asserter gets their bond back (minus UMA's final fee).
4. Disputed → UMA escalates to its DVM (token-holder vote on Ethereum mainnet, ~2 days). Loser's bond is slashed. DVM verdict calls back into our adapter.

### Why we pay the bond at all

Polymarket's UMA assertions live on OOv2 on Polygon. That's a different oracle instance on a different chain. Our assertion on Base OOv3 is a separate assertion about a separate statement. No way to piggyback. Bond is refundable on truthful assertions (minus cents in UMA fees) — capital recirculates, not a recurring cost.

### What the asserter's claim looks like

Human-readable UTF-8, built in TypeScript by `packages/nextjs/src/lib/uma/claim.ts` and passed to the adapter as opaque bytes. Example:

```
As of assertion timestamp 1714000000, ParlayVoo leg 42 (Polymarket conditionId 0xdeadbeef...) has resolved YES. Verify at https://gamma-api.polymarket.com/markets/0xdeadbeef....
```

UMA DVM voters (and any disputer) can verify against Polymarket's live UI or API.

### Chain selection strategy

| Chain | AdminOracleAdapter | UmaOracleAdapter | `/api/quote-sign` default |
|---|---|---|---|
| 31337 (Anvil) | deployed, `resolve()` works | not deployed | Admin |
| 84532 (Base Sepolia) | deployed, `resolve()` works | deployed | Admin (flip to UMA via `NEXT_PUBLIC_ORACLE_MODE=uma`) |
| 8453 (Base mainnet) | deployed, `resolve()` reverts on mainnet guard | deployed | UMA |

Rationale: Sepolia keeps fast admin-resolution for QA demos (no 2h wait); flipping the env var enables real UMA testing. Mainnet never hands out Admin, so the guarded `resolve()` is truly unreachable.

### Safety property

The only writer to `_finalStatus` / `_finalOutcome` / `_isFinalized` in `UmaOracleAdapter` is `assertionResolvedCallback`, gated by `msg.sender == address(uma)`. No `onlyOwner` function can reach outcome state. Config setters (`setLiveness`, `setBondAmount`) exist but never touch outcomes.

### How to watch a ticket resolve via UMA end-to-end on Base Sepolia

1. In `.env`: `NEXT_PUBLIC_ORACLE_MODE=uma`.
2. `pnpm deploy:sepolia` — deploys both adapters; UMA wired to `0x0F7fC5E6482f096380db6158f978167b57388deE`.
3. Buy a 2-leg ticket on the frontend. Leg snapshot's `oracleAdapter` will be the `UmaOracleAdapter` address.
4. Once Polymarket resolves the underlying market, `curl -X POST <sepolia-url>/api/settlement/run -H "Authorization: Bearer $CRON_SECRET"`. This posts the UMA assertion.
5. Wait liveness (2h default; `setLiveness(60)` on testnet for 60-second demos).
6. `curl -X POST ... /api/settlement/run ...` again. Cron calls `settleMature`, UMA fires the callback, Phase B calls `settleTicket` — ticket flips to Won/Lost/Voided in the UI.
7. At no point does `/admin/debug` resolver get clicked — this proves the flow works without the backdoor.

### Fork tests

`pnpm test:fork` runs `test/fork/UmaOracleSepoliaFork.t.sol` against the real UMA OOv3 on Base Sepolia using the RPC URL from `.env`. Two scenarios:
- Happy path: assert → warp past liveness → settle → adapter finalized.
- Dispute path: dispute during liveness → adapter stays pending, `settleMature` reverts.

(DVM escalation cross-chain resolution isn't exercised — DVM lives on Ethereum mainnet; the unit tests cover the final callback paths via a mock.)

## Part 2 — AI Spec Sheet

### New files

- `packages/foundry/src/interfaces/IOptimisticOracleV3.sol` — minimal local copy of `assertTruth`, `settleAssertion`, `disputeAssertion`, `getMinimumBond`, `defaultIdentifier`, `getAssertionResult` + `IOptimisticOracleV3CallbackRecipient` (`assertionResolvedCallback`, `assertionDisputedCallback`).
- `packages/foundry/src/oracle/UmaOracleAdapter.sol` — implements `IOracleAdapter` + `IOptimisticOracleV3CallbackRecipient`. Ownable + ReentrancyGuard + SafeERC20.
- `packages/foundry/test/helpers/MockOptimisticOracleV3.sol` — deterministic mock with `mockSettle(assertionId, truthful)` + `mockDispute(assertionId)` test hooks.
- `packages/foundry/test/unit/UmaOracleAdapter.t.sol` — 18 unit tests.
- `packages/foundry/test/fork/UmaOracleSepoliaFork.t.sol` — 2 fork tests; auto-skips when `BASE_SEPOLIA_RPC_URL` / `NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL` unset.
- `packages/nextjs/src/lib/uma/claim.ts` — `encodeClaim({legId, conditionId, outcome, polymarketSlug?, asOfTs}) → Hex`.
- `packages/nextjs/src/lib/uma/__tests__/claim.test.ts` — determinism + format invariants.

### Deleted files

- `packages/foundry/src/oracle/OptimisticOracleAdapter.sol`
- `packages/foundry/test/unit/OptimisticOracle.t.sol`

### Modified files

- `packages/foundry/script/HelperConfig.s.sol`:
  - Added constants: `UMA_OOV3_BASE_SEPOLIA`, `UMA_OOV3_BASE_MAINNET`, `UMA_DEFAULT_LIVENESS` (7200s), `UMA_BOND_SENTINEL` (0).
  - Removed constants: `OPTIMISTIC_LIVENESS`, `OPTIMISTIC_BOND`.
  - `NetworkConfig`: replaced `optimisticLiveness`, `optimisticBond` with `umaOracleV3`, `umaLiveness` (uint64), `umaBondAmount`. Anvil uses `umaOracleV3: address(0)` (skip deploy).
- `packages/foundry/script/steps/CoreStep.sol`:
  - `CoreDeployment` field renamed `optimisticOracle → umaOracle`.
  - Conditional deploy: `if (cfg.umaOracleV3 != address(0))` → resolve bond (sentinel `0` → `uma.getMinimumBond(usdc)`) → deploy `UmaOracleAdapter`.
- `scripts/generate-deployed-contracts.ts`: swap `OptimisticOracleAdapter` entry for `UmaOracleAdapter` in `CONTRACT_NAMES`.
- `packages/nextjs/src/lib/hooks/leg.ts`: stale doc-comment reference updated.
- `packages/nextjs/src/app/api/quote-sign/route.ts`: adapter picker branches on chainId + `NEXT_PUBLIC_ORACLE_MODE`.
- `packages/nextjs/src/app/api/settlement/runner.ts`:
  - New `UMA_ORACLE_ABI` (`assertOutcome`, `settleMature`, `assertionByLeg`, `canResolve`).
  - `ChainContracts.UmaOracleAdapter` is optional.
  - Phase A reads `LegRegistry.getLeg(legId).oracleAdapter`, branches:
    - Admin → existing `resolve()` path (unchanged).
    - UMA → `assertOutcome` if `assertionByLeg == 0x0` else `settleMature` (revert swallowed pre-liveness). `recordResolution` only after finalization.
  - Docstring updated.
- `package.json`:
  - `test:contracts` now excludes `test/fork/**`.
  - New `test:fork` script requires `BASE_SEPOLIA_RPC_URL` or `NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL`.
- `docs/changes/A_DAY_SCALING_SPRINT.md`: F-1 header marked `✅ COMPLETE`.

### Deploy-surface delta

Per-chain contract roster on `deployedContracts.ts` after next `pnpm deploy:*`:

| Chain | MockUSDC | HouseVault | LegRegistry | AdminOracle | UmaOracle | ParlayEngine | LockVaultV2 | MockYieldAdapter |
|---|---|---|---|---|---|---|---|---|
| 31337 | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ |
| 84532 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 8453 | external Circle USDC | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

### Invariants preserved

- Engine holds 0 USDC. `UmaOracleAdapter` is the sole custodian of the UMA bond (transient; forwarded to UMA on `assertTruth`, returned on truthful settlement).
- `totalReserved <= totalAssets()`. No vault changes.
- SafeERC20 on every token op in the new adapter. `forceApprove` used before each `assertTruth` so exact-amount approvals don't stack.
- BPS / PPM math untouched.
- Oracle adapter is per-leg and snapshotted at ticket purchase (`ParlayEngine.sol:393`). No engine changes needed.

### Acceptance

- No `onlyOwner` function in `packages/foundry/src/oracle/*.sol` can mutate `_finalStatus` / `_finalOutcome` / `_isFinalized`. Verified by grep + unit test `test_adminSetters_cannotWriteOutcomeState`.
- `forge test` passes (333+ tests, 18 new for UmaOracleAdapter).
- `pnpm test:web` passes (276+ tests, 7 new for claim encoder).
- `pnpm typecheck` passes.
- Mainnet: a buy transaction's leg snapshot `oracleAdapter` equals `UmaOracleAdapter.address`. (Verified post-deploy.)

### Deferred

- **Liveness tuning** — hardcoded to 7200s at deploy; `setLiveness` is owner-tunable post-deploy.
- **USDC approval style** — uses `forceApprove(bondAmount)` per-call; tuning later if gas matters.
- **DVM escalation fork coverage** — DVM votes live on Ethereum mainnet; fork tests cover only pre-DVM paths.
- **Bond sizing** — uses `uma.getMinimumBond(USDC)` at deploy. Adjust via `setBondAmount` if needed (must be `>= minBond`).
