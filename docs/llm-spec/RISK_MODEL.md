# Risk Model — LLM spec

*Human doc: [../RISK_MODEL.md](../RISK_MODEL.md)*

## Current constants (Level 0, live)

Defined in `packages/foundry/src/core/HouseVault.sol` and mirrored in `packages/shared/src/constants.ts`.

```
maxUtilizationBps  uint256  8000   // 80% of totalAssets()
maxPayoutBps       uint256  500    // 5% of totalAssets() per ticket
```

Enforcement:
```
HouseVault.reservePayout(potentialPayout):
  require(potentialPayout <= totalAssets() * maxPayoutBps / 10_000, "payout cap");
  require(totalReserved + potentialPayout <= totalAssets() * maxUtilizationBps / 10_000, "util cap");
```

## Correlation engine — shipped

```solidity
// HouseVault.sol
struct CorrelationConfig {
    uint256 corrAsymptoteBps;   // D, default 8000 (80%)
    uint256 corrHalfSatPpm;     // k × 1e6, default 1_000_000 (k = 1.0)
    uint256 maxLegsPerGroup;    // builder-side hard cap, default 3
}
CorrelationConfig public corrConfig;
```

```solidity
// LegRegistry.sol
mapping(uint256 => uint256) public legCorrGroup;       // legId → correlationGroupId (0 = uncorrelated)
mapping(uint256 => uint256) public legExclusionGroup;  // legId → exclusionGroupId (0 = no exclusion)
```

```solidity
// ParlayEngine.sol
uint256 public protocolFeeBps;  // per-leg multiplicative fee, default 1000 (10%)
error MutuallyExclusiveLegs(uint256 legA, uint256 legB);
error TooManyLegsInGroup(uint256 groupId, uint256 legCount, uint256 cap);
error FeeTooHigh(uint256 bps);
```

Buy path: `_checkExclusion(legIds)` → `_aggregateGroupSizes(legIds)` (also enforces `maxLegsPerGroup`) → `ParlayMath.applyFee` → `ParlayMath.applyCorrelation` → reserve. Math mirrors `packages/shared/src/math.ts`.

Defaults are env-driven via `NEXT_PUBLIC_PROTOCOL_FEE_BPS`, `NEXT_PUBLIC_CORRELATION_ASYMPTOTE_BPS`, `NEXT_PUBLIC_CORRELATION_HALF_SAT_PPM`, `NEXT_PUBLIC_MAX_LEGS_PER_GROUP` — see [../changes/CORRELATION.md](../changes/CORRELATION.md).

## Proposed Level 1 config (not yet on-chain)

```solidity
struct RiskConfig {
    uint256 maxUtilizationBps;   // 8000
    uint256 perMarketCapBps;     // 2000   (20% of TVL in any one market)
    uint256 perGroupCapBps;      // 3000   (30% of TVL in any correlation group, future)
    uint256 maxLegs;             // 5
    uint256 minEdgeBps;          // 100
    uint256 maxEdgeBps;          // 2000
    uint256 utilizationK;        // TBD — curve parameter for convex premium
    uint256 rfqThreshold;        // TBD — stake threshold for RFQ lane
}
```

## Pricing curve (Level 1)

```
premium(u) = minEdgeBps + (maxEdgeBps - minEdgeBps) * (u / utilizationK)^2
u = totalReserved / totalAssets()
edgeBps = baseEdge + premium(u)
```

Evaluated at ticket purchase time. Premium replaces the hard 80% reject with a soft slide; the hard cap remains as a final safety bound.

## State additions required for Level 1

**`HouseVault.sol`:**
```
RiskConfig public riskConfig;                       // struct above
mapping(uint256 => uint256) public perMarketReserved;  // marketId → reserved notional
mapping(uint256 => uint256) public perGroupReserved;   // correlationGroupId → reserved notional

function setRiskConfig(RiskConfig calldata cfg) external onlyOwner;
```

**`LegRegistry.sol`:**
```
mapping(uint256 => uint256) public legMarket;        // legId → marketId
mapping(uint256 => uint256) public legGroup;         // legId → correlationGroupId (0 = uncorrelated)
```

**`ParlayEngine.sol`:**
```
// In buyTicket / buyTicketSigned flow:
for each leg:
    perMarketReserved[market] += potentialPayout
    require perMarketReserved[market] <= TVL * perMarketCapBps / 10_000
    perGroupReserved[group]   += potentialPayout
    require perGroupReserved[group] <= TVL * perGroupCapBps / 10_000
// On settle / cashout, decrement the same counters.
```

## Invariants (Level 1)

1. `totalReserved <= totalAssets() * maxUtilizationBps / 10_000` — already enforced.
2. For every `marketId` with active exposure: `perMarketReserved[marketId] <= totalAssets() * perMarketCapBps / 10_000`.
3. For every non-zero `correlationGroupId`: `perGroupReserved[groupId] <= totalAssets() * perGroupCapBps / 10_000`.
4. `sum(perMarketReserved) == totalReserved` — market accounting matches global accounting.
5. `edgeBps in [minEdgeBps, maxEdgeBps]` for every accepted quote.
6. `premium(u)` monotonically non-decreasing in `u`.

## Tests required (Level 1)

- Unit: per-market cap enforcement (single market hits cap → next ticket in that market reverts; other markets unaffected).
- Unit: per-group cap enforcement.
- Unit: `premium(u)` continuity + monotonicity across `u` domain.
- Fuzz: random sequences of buy/settle/cashout preserve `sum(perMarketReserved) == totalReserved`.
- Invariant: no sequence of operations lets `perMarketReserved` exceed the cap by more than rounding.

## Files touched (Level 1 rollout)

```
packages/foundry/src/core/HouseVault.sol
packages/foundry/src/core/LegRegistry.sol
packages/foundry/src/core/ParlayEngine.sol
packages/foundry/src/libraries/ParlayMath.sol           (premium curve helper)
packages/shared/src/math.ts                             (mirror)
packages/shared/src/constants.ts                        (RiskConfig defaults)
packages/foundry/test/unit/HouseVault.t.sol
packages/foundry/test/fuzz/VaultFuzz.t.sol
packages/foundry/test/invariant/*.t.sol
packages/nextjs/src/components/VaultDashboard.tsx       (exposure breakdown UI)
```
