# Crash-Parlay Cashout — LLM spec

*Human doc: [../CASHOUT.md](../CASHOUT.md)*

## Function signatures

```solidity
// ParlayEngine.sol
function cashoutEarly(uint256 ticketId, uint256 minOut)
    external
    nonReentrant
    whenNotPaused;
```

```solidity
// ParlayMath.sol
function computeCashoutValue(
    uint256 effectiveStake,
    uint256[] memory wonProbsPPM,
    uint256 unresolvedCount,
    uint256 basePenaltyBps,
    uint256 totalLegs,
    uint256 potentialPayout
) internal pure returns (uint256 cashoutValue, uint256 penaltyBps);
```

TypeScript mirror: `packages/shared/src/math.ts` exports `computeCashoutValue` with identical argument order. Parity test in `packages/foundry/test/unit/ParlayMath.t.sol` asserts this must stay synced.

## Access control

| Function | Caller |
|---|---|
| `ParlayEngine.cashoutEarly` | `ownerOf(ticketId)`; ticket must be `Active`; no leg may be `Lost`; `isLossless` must be `false` |

## Call graph

```
ParlayEngine.cashoutEarly
  ├─ loop ticket.legIds once → count won / unresolved / lost
  ├─ if any lost → revert
  ├─ if 0 won AND 0 unresolved → revert
  ├─ ParlayMath.computeCashoutValue → (V_cashout, penaltyBps)
  ├─ require V_cashout >= minOut
  ├─ HouseVault.releasePayout(ticket.potentialPayout, 0)   // release full reserve, no payout to vault
  ├─ HouseVault.payoutCashout(ticket.owner, V_cashout)
  ├─ ticket.status = CashedOut
  └─ emit TicketCashedOut(ticketId, owner, V_cashout, penaltyBps)
```

## Invariants

1. `V_cashout <= ticket.potentialPayout` — enforced inside `computeCashoutValue`.
2. `totalReserved` decreases by exactly `ticket.potentialPayout` (full reserve release).
3. Vault net USDC delta = `potentialPayout - V_cashout` (recovered as LP profit).
4. Ticket status is `CashedOut` post-call — no further `settleTicket` / `claimPayout` / `cashoutEarly` succeeds.
5. `wonProbsPPM.length + unresolvedCount == totalLegs` and `unresolvedCount > 0`.
6. `ticket.isLossless == false`.

## State changes

- `_tickets[ticketId].status = TicketStatus.CashedOut`
- `HouseVault.totalReserved -= ticket.potentialPayout`
- `HouseVault.<usdc balance> -= V_cashout`

## Events

```solidity
event TicketCashedOut(
    uint256 indexed ticketId,
    address indexed owner,
    uint256 cashoutValue,
    uint256 penaltyBps
);
```

## Tests (existing)

- `packages/foundry/test/unit/EarlyCashout.t.sol` — basic, twoOfThreeWon, fiveLegParlay, slippageProtection, legLost reverts, noWonLegs reverts.
- `packages/foundry/test/invariant/EngineInvariant.t.sol:220` — cashoutEarly handler in invariant harness.
- `packages/foundry/test/unit/ParlayMath.t.sol` — parity on `computeCashoutValue`.

## Frontend integration

- Hook: `useCashoutEarly` in `packages/nextjs/src/lib/hooks/ticket.ts:332`.
- Component: `TicketCard.tsx:59` calls `cashoutEarly(ticket.id, minOut)` with slippage-protected minOut.
- Display: ticket detail page computes live cashout value via the shared TS mirror; no on-chain call needed for the quote.

## Files touched (for changes)

```
packages/foundry/src/core/ParlayEngine.sol
packages/foundry/src/libraries/ParlayMath.sol        (if pricing changes)
packages/shared/src/math.ts                          (must mirror ParlayMath changes)
packages/foundry/test/unit/EarlyCashout.t.sol
packages/foundry/test/unit/ParlayMath.t.sol          (parity)
packages/nextjs/src/lib/hooks/ticket.ts
packages/nextjs/src/components/TicketCard.tsx
docs/CASHOUT.md
docs/llm-spec/CASHOUT.md                             (this file)
```
