# Rehab Mode

**Status:** Design finalized. Ready for implementation.

---

## Part 1 — Human Spec

### What it is

When a user loses a parlay, the full stake is locked as their own productive capital and the protocol advances them twelve months of its projected yield as bet-only credit. Winning a credit-funded parlay mints a new "partial ownership" position for the user. Unused credits forfeit the locked capital back to LPs.

### What it does

- **Locks 100% of every losing stake** as the user's own capital (not LP profit).
- **Lets the user choose their own lockup** (minimum 12 months). The choice is the teaching moment.
- **Issues bet-only credit** equal to the first 12 months of projected yield on the locked principal, regardless of lockup length.
- **Routes credit-funded wins** into a new "Partial" tier — principal locked forever, earnings fully liquid.
- **Burns unused principal back to LPs** when a lock expires with the credit unspent.
- **Offers a one-way graduation** from Partial to Full (withdrawable LP position) if the user re-locks for ≥24 months.

### The three tiers

| Tier | Entered by | Principal | Earnings |
|---|---|---|---|
| **Full** | Voluntary deposit | Withdrawable at unlock | Fully liquid |
| **Partial** | Winning a credit-funded parlay | Locked forever | Fully liquid |
| **Least** | Losing a parlay | Locked forever, reverts to LPs at expiry | Bet-only credit, single-use |

### Redemption arc

```
Lose parlay  →  Least (locked + credit)
                 ├─ never bet     → principal burns to LPs at expiry
                 ├─ bet & lose    → credit gone, principal keeps earning yield for protocol
                 └─ bet & win     → winnings mint Partial principal (locked, liquid earnings)
                                     └─ re-lock ≥24mo → Full (withdrawable)
```

### Credit sizing

```
credit = principal × projectedAprBps / 10_000
```

- Default `projectedAprBps = 600` (6%, admin-settable).
- $100 loss → $6 credit, whether locked 12 months or 36.
- Longer locks → same credit, more yield captured by protocol.

### Why these design choices

- **100% locked, not 80/10/10.** An arbitrary giveback doesn't teach investing. Giving the user their own locked capital — and the yield on it to gamble with — forces the investor-side experience without costing LPs their loss income directly (the money doesn't leave; LPs capture it via yield + forfeitures).
- **User picks the lockup.** The choice itself is the lesson. A forced duration is paternalistic; a chosen one is ownership.
- **12-month credit cap.** Longer locks shouldn't mean bigger credits — that would blow up advance liability and invite gaming. Capping at 12 months normalizes protocol cost per user regardless of duration.
- **Credit is bet-only, single-use.** Keeps the narrative honest: the advance is for experiencing the product, not free money.
- **Winnings → Partial, not wallet.** Preserves parlay odds integrity (protocol pays fair odds on paper) without handing liquid USDC to users who haven't earned withdrawal rights. Creates the "become the house" funnel in concrete form.
- **Burn unused principal to LPs.** Clean accounting, rewards LPs for funding the flywheel, and creates real pressure for users to engage with their credit before expiry.
- **≥24 months for graduation.** Forces genuine commitment before granting withdrawable-equity status. Shorter thresholds would let users cycle through tiers for extraction.
- **$1 minimum, batched processing.** Every real loss qualifies, but gas is amortized across many users via a single flush transaction — no per-loss gas penalty.
- **AAVE as yield venue (via vault's existing adapter slot).** Real external APR keeps the projected-yield story honest; existing `IYieldAdapter` interface means no new routing surface.

### What the user sees

- Crash screen: "Your $X is now invested. Pick how long to lock it for and play parlays with its first year of yield."
- Vault page: three balances — Full, Partial, Least — each showing principal, earnings, and rights.
- Lossless parlay builder: spends credit instead of USDC; winnings never show in wallet.
- Graduation prompt: at any time on Partial balance, re-lock ≥24 months to upgrade to withdrawable Full.

---

## Part 2 — AI Spec Sheet

*Reference for implementation. Terse on purpose. Human narrative belongs in Part 1.*

### Rename

- `HouseVault` ERC20: name `ParlayVoo`, symbol `VOO` (was `vUSDC`). Update `HouseVault.sol` constructor, `deployedContracts.ts`, every `"vUSDC"` occurrence in `packages/nextjs/src/**`, all test assertions, all docs.
- Underlying asset (USDC) is unchanged.

### Constants / params

```
projectedAprBps        uint256  owner-settable  default 600   (6%)
MIN_REHAB_STAKE        uint256  const           1e6           ($1 USDC)
MIN_REHAB_DURATION     uint256  const           365 days
MIN_GRADUATE_DURATION  uint256  const           730 days
```

### Tiers

```solidity
enum Tier { FULL, PARTIAL, LEAST }
```

Attach to `LockVaultV2.LockPosition`. `FULL` participates in `totalWeightedShares` (unchanged). `PARTIAL` and `LEAST` are excluded from weighted-share accumulator.

### State additions

**`HouseVault.sol`:**
```
uint256 projectedAprBps
address lockVault                         // LockVaultV2
mapping(address => uint256) creditBalance
PendingLoss[] pendingLosses
uint256 pendingRehabPrincipal             // sub-account of localBalance()

struct PendingLoss { address owner; uint256 stake; uint256 duration; }
```

**`LockVaultV2.sol`:**
```
// add `Tier tier` to LockPosition
// mapping to track per-user Partial-tier earnings balance (if chosen accumulator)
```

### Access control

| Function | Caller |
|---|---|
| `HouseVault.setProjectedAprBps` | `onlyOwner` |
| `HouseVault.distributeLoss` | `onlyEngine` |
| `HouseVault.flushRehabLosses` | permissionless |
| `HouseVault.routeLosslessWin` | `onlyEngine` |
| `HouseVault.spendCredit` | `onlyEngine` |
| `LockVaultV2.rehabLock` | `onlyVault` (HouseVault) |
| `LockVaultV2.graduate` | position owner; tier must be `PARTIAL`; `newDuration >= MIN_GRADUATE_DURATION` |
| `ParlayEngine.buyLosslessParlay` | EOA, credit-gated |

### Function signatures

```solidity
// HouseVault
function setProjectedAprBps(uint256 bps) external onlyOwner;
function distributeLoss(uint256 stake, address owner, uint256 duration) external onlyEngine;
function flushRehabLosses(uint256 count) external nonReentrant;
function routeLosslessWin(address owner, uint256 payout) external onlyEngine nonReentrant;
function spendCredit(address user, uint256 amount) external onlyEngine;

// LockVaultV2
function rehabLock(address user, uint256 shares, uint256 duration, Tier tier) external;
function graduate(uint256 positionId, uint256 newDuration) external nonReentrant;

// ParlayEngine
function buyLosslessParlay(Leg[] legs, uint256 creditAmount, Quote quote) external nonReentrant;
```

### Call graphs

**Loss → queued lock:**
```
ParlayEngine.settleTicket (loss branch)
  → HouseVault.releasePayout
  → HouseVault.distributeLoss(stake, owner, duration)
    └─ enqueues PendingLoss; pendingRehabPrincipal += stake
```

**Flush (permissionless, N entries):**
```
flushRehabLosses(count)
  for each PendingLoss:
    shares = convertToShares(stake)
    _mint(address(this), shares)
    approve(lockVault, shares)
    LockVaultV2.rehabLock(owner, shares, duration, Tier.LEAST)
    creditBalance[owner] += stake * projectedAprBps / 10_000
    pendingRehabPrincipal -= stake
    emit RehabLossFlushed, CreditIssued
```

**Lossless parlay buy:**
```
ParlayEngine.buyLosslessParlay
  → HouseVault.spendCredit(user, stake)
  → HouseVault.reservePayout(potentialPayout)
  → mint ERC721 ticket (isLossless = true)
```

**Lossless parlay win:**
```
ParlayEngine.settleTicket (win branch, isLossless)
  → HouseVault.routeLosslessWin(owner, payout)
    ├─ shares = convertToShares(payout)
    ├─ _mint(address(this), shares)
    ├─ LockVaultV2.rehabLock(owner, shares, duration=MIN_REHAB_DURATION, Tier.PARTIAL)
    └─ totalReserved -= payout
```

**Least lock expiry:**
```
LockVaultV2.unlock(positionId) where tier == LEAST
  → burn shares (do not transfer to user)
  → totalLockedShares -= shares; totalSupply -= shares (via _burn)
  → vault share price appreciates for remaining holders
```

**Graduate Partial → Full:**
```
LockVaultV2.graduate(positionId, newDuration)
  require tier == PARTIAL
  require newDuration >= MIN_GRADUATE_DURATION
  → _settleRewards
  → tier = FULL
  → unlockAt = block.timestamp + newDuration
  → add to totalWeightedShares with feeShareForDuration(newDuration)
  → HouseVault.issuePromoCredit(owner, principal * projectedAprBps / 10_000)
```

### Events

```solidity
// HouseVault
event RehabLossQueued(address indexed owner, uint256 stake, uint256 duration);
event RehabLossFlushed(address indexed owner, uint256 stake, uint256 shares, uint256 credit);
event CreditIssued(address indexed user, uint256 amount);
event CreditSpent(address indexed user, uint256 amount);
event LosslessWinRouted(address indexed owner, uint256 payout, uint256 shares);
event LeastPrincipalBurned(address indexed formerOwner, uint256 shares);
event ProjectedAprChanged(uint256 oldBps, uint256 newBps);

// LockVaultV2
event Graduated(uint256 indexed positionId, address indexed owner, uint256 newDuration, uint256 promoCredit);
```

### Invariants (add to invariant suite)

1. `pendingRehabPrincipal <= localBalance() - totalReserved`
2. `totalAssets()` for share-price calc: MUST subtract `pendingRehabPrincipal` (queued principal is not LP-owned yet).
3. A `LEAST`-tier position at `unlock()` time has zero associated earnings or outstanding credit.
4. No position has `tier` other than `FULL / PARTIAL / LEAST`.
5. `tier == PARTIAL && unlockAt != type(uint256).max` is a violation (Partial has no unlock time on principal).
6. `graduate()` transitions `PARTIAL → FULL`; no other tier transition function exists.
7. Credit balance never goes negative (uint256, but assert no underflow path).
8. Sum of all `creditBalance[*]` × max multiplier ≤ reservable headroom (enforced implicitly via existing reserve caps, verify in test).

### Tests required

- Unit: `distributeLoss`, `flushRehabLosses` (batch of 1, batch of 50, batch exceeding queue), `routeLosslessWin` (new Partial position, append to existing), `spendCredit` (insufficient balance reverts), `graduate` (wrong tier reverts, short duration reverts, happy path).
- Unit: `LEAST` expiry burn correctly reduces `totalSupply` and increases share price.
- Fuzz: credit issuance arithmetic across `projectedAprBps` range, `stake` range.
- Invariant: pendingRehabPrincipal accounting holds across random sequences of losses, flushes, deposits, withdrawals.
- Integration: buy → lose → flush → buy lossless → win → graduate, end-to-end with share-price assertions at every step.

### Files touched (expected)

```
packages/foundry/src/core/HouseVault.sol
packages/foundry/src/core/LockVaultV2.sol
packages/foundry/src/core/ParlayEngine.sol
packages/foundry/src/interfaces/ILockVault.sol
packages/foundry/script/steps/LockVaultStep.sol
packages/foundry/test/unit/HouseVault.t.sol
packages/foundry/test/unit/LockVaultV2.t.sol
packages/foundry/test/unit/ParlayEngine.t.sol
packages/foundry/test/invariant/*.t.sol
packages/nextjs/src/contracts/deployedContracts.ts     (auto-generated)
packages/nextjs/src/lib/hooks/*.ts
packages/nextjs/src/components/VaultDashboard.tsx
packages/nextjs/src/app/ticket/[id]/page.tsx
packages/nextjs/src/app/page.tsx                        (crash screen + lossless builder)
packages/shared/src/types.ts
docs/REHAB_MODE.md                                      (this file)
```
