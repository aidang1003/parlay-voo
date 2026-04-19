# Crash-Parlay Cashout

*LLM spec: [llm-spec/CASHOUT.md](llm-spec/CASHOUT.md)*

**Status:** Implemented.

## What it is

The early-exit mechanic for an in-flight parlay. Any time at least one leg is still unresolved — and no leg has lost — the ticket owner can trade the remaining uncertainty for a guaranteed payout priced off the current state.

Lossless (rehab-credit) parlays do not support cashout. The rehab flow only pays winnings as a locked Partial-tier position; there is nothing to cash out to.

## What it does

- Computes a cashout value from the ticket's state: how much of the parlay has already won, how much remains unresolved, and the implied multiplier on the rest.
- Applies a spread (base penalty in BPS) so the protocol captures some of the risk premium the user is shedding.
- Lets the user pass a `minOut` floor — the call reverts if the computed value dips below it, giving slippage protection against adverse leg resolution between quote and tx inclusion.
- Releases the full reserved payout back to the vault, regardless of how much was actually paid out. The unused reserve becomes LP profit.
- Marks the ticket as `CashedOut`. No further settlement or claim is possible on that ticket.

## Pricing

```
V_fair    = effectiveStake * multiplier(wonLegs) * (1 / P_remaining)
V_cashout = V_fair * (1 - penaltyBps / 10_000)
```

- `multiplier(wonLegs)` = product of inverse probabilities for legs that have already won.
- `P_remaining` = product of implied probabilities for legs that are still unresolved.
- `penaltyBps` scales with how many legs remain (more uncertainty → wider spread).
- `V_cashout` is capped at the ticket's `potentialPayout`. Users can never cash out for more than the vault reserved.

If all legs are still unresolved, `multiplier(wonLegs) = 1` and the cashout value is effectively the stake minus the spread — a safety exit on a ticket the user has cold feet about.

If a single leg has lost, cashout reverts. There's nothing left to price — the ticket is a guaranteed zero and will go through normal settlement.

## Flow

1. User calls `cashoutEarly(ticketId, minOut)`.
2. Engine walks the ticket's legs once. Counts won, unresolved, and lost.
3. If any leg lost → revert ("no cashout on lost ticket").
4. If zero won AND zero unresolved (edge case all-voided) → revert.
5. Compute `V_cashout` via `ParlayMath.computeCashoutValue`.
6. If `V_cashout < minOut` → revert (slippage protection).
7. Release the ticket's full reserved payout back to the vault.
8. Transfer `V_cashout` USDC to the user.
9. Mark ticket `CashedOut`, emit event.

## Constraints and invariants

- Cashout is only available while at least one leg is `Unresolved`. Fully-resolved tickets go through `settleTicket`.
- `V_cashout <= potentialPayout` always. Vault cannot be forced to pay more than it reserved.
- Reserved liability is released before the user transfer. Checks-effects-interactions.
- `ReentrancyGuard` on the external function.
- No cashout on lossless (rehab-credit) tickets.
- Owner-only call — `ownerOf(ticketId) == msg.sender`.

## What the user sees

- Ticket detail page shows a live "Cash Out Now" value as legs resolve.
- Each leg that wins bumps the cashout value up (multiplier grows, uncertainty shrinks).
- Clicking Cash Out triggers a quote → slippage guard → on-chain call, with a short "plane is landing" animation instead of the crash state.
- A leg losing crashes the multiplier to zero — the cashout button disappears, ticket goes to loss.

## Future extensions (not built)

- **Dual execution lanes.** Small tickets fill instantly against vault pricing (AMM). Large tickets route through an RFQ lane with market-maker signed quotes for tighter spreads. Rationale: AMM pricing is acceptable on small tickets where capital-efficiency isn't tight, but large tickets get priced aggressively enough that bid/ask dominates — letting market makers compete helps sophisticated users.
- **Dynamic `penaltyBps`.** Currently a fixed-ish curve based on leg count. Could scale with vault utilization to create back-pressure under stress.
- **Partial cashout.** Today it's all-or-nothing. A partial cashout would let users take some risk off while leaving residual exposure.
