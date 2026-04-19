# Rehab Mode

*LLM spec: [llm-spec/REHAB_MODE.md](llm-spec/REHAB_MODE.md)*

**Status:** Implemented.

## What it is

When a user loses a parlay, the full stake is locked as their own productive capital and the protocol advances them twelve months of its projected yield as bet-only credit. Winning a credit-funded parlay mints a new "partial ownership" position for the user. Unused credits forfeit the locked capital back to LPs.

## What it does

- **Locks 100% of every losing stake** as the user's own capital (not LP profit).
- **Lets the user choose their own lockup** (minimum 12 months). The choice is the teaching moment.
- **Issues bet-only credit** equal to the first 12 months of projected yield on the locked principal, regardless of lockup length.
- **Routes credit-funded wins** into a new "Partial" tier — principal locked forever, earnings fully liquid.
- **Burns unused principal back to LPs** when a lock expires with the credit unspent.
- **Offers a one-way graduation** from Partial to Full (withdrawable LP position) if the user re-locks for ≥24 months.

## The three tiers

| Tier | Entered by | Principal | Earnings |
|---|---|---|---|
| **Full** | Voluntary deposit | Withdrawable at unlock | Fully liquid |
| **Partial** | Winning a credit-funded parlay | Locked forever | Fully liquid |
| **Least** | Losing a parlay | Locked forever, reverts to LPs at expiry | Bet-only credit, single-use |

## Redemption arc

```
Lose parlay  →  Least (locked + credit)
                 ├─ never bet     → principal burns to LPs at expiry
                 ├─ bet & lose    → credit gone, principal keeps earning yield for protocol
                 └─ bet & win     → winnings mint Partial principal (locked, liquid earnings)
                                     └─ re-lock ≥24mo → Full (withdrawable)
```

## Credit sizing

```
credit = principal × projectedAprBps / 10_000
```

- Default `projectedAprBps = 600` (6%, admin-settable).
- $100 loss → $6 credit, whether locked 12 months or 36.
- Longer locks → same credit, more yield captured by protocol.

## Why these design choices

- **100% locked, not 80/10/10.** An arbitrary giveback doesn't teach investing. Giving the user their own locked capital — and the yield on it to gamble with — forces the investor-side experience without costing LPs their loss income directly (the money doesn't leave; LPs capture it via yield + forfeitures).
- **User picks the lockup.** The choice itself is the lesson. A forced duration is paternalistic; a chosen one is ownership.
- **12-month credit cap.** Longer locks shouldn't mean bigger credits — that would blow up advance liability and invite gaming. Capping at 12 months normalizes protocol cost per user regardless of duration.
- **Credit is bet-only, single-use.** Keeps the narrative honest: the advance is for experiencing the product, not free money.
- **Winnings → Partial, not wallet.** Preserves parlay odds integrity (protocol pays fair odds on paper) without handing liquid USDC to users who haven't earned withdrawal rights. Creates the "become the house" funnel in concrete form.
- **Burn unused principal to LPs.** Clean accounting, rewards LPs for funding the flywheel, and creates real pressure for users to engage with their credit before expiry.
- **≥24 months for graduation.** Forces genuine commitment before granting withdrawable-equity status. Shorter thresholds would let users cycle through tiers for extraction.
- **$1 minimum, batched processing.** Every real loss qualifies, but gas is amortized across many users via a single flush transaction — no per-loss gas penalty.
- **AAVE as yield venue (via vault's existing adapter slot).** Real external APR keeps the projected-yield story honest; existing `IYieldAdapter` interface means no new routing surface.

## What the user sees

- Crash screen: "Your $X is now invested. Pick how long to lock it for and play parlays with its first year of yield."
- Vault page: three balances — Full, Partial, Least — each showing principal, earnings, and rights.
- Lossless parlay builder: spends credit instead of USDC; winnings never show in wallet.
- Graduation prompt: at any time on Partial balance, re-lock ≥24 months to upgrade to withdrawable Full.
