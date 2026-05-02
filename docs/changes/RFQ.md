# RFQ — Peer-to-Peer Parlay Markets

**Status:** Deferred. Design sketch only — no implementation planned.

## Why this exists

Prediction markets are intentionally structured differently from a casino: every position has a peer on the other side, not a house. ParlayVoo today is closer to the casino end — users buy parlays priced off frozen Polymarket odds, and the LP vault is the sole counterparty. That's fine while volumes are low, but it caps how big the protocol can grow without the vault carrying all of the directional risk.

The RFQ direction is the path to a real two-sided market: users broadcast a parlay buy intent, and other participants (or the vault, as fallback) take the other side.

## The flow we sketched

1. User builds a ticket in the UI as today (legs + stake).
2. Instead of immediate confirmation, the ticket is broadcast as an open RFQ — somewhere participants can see it and decide to take the opposite side.
3. If no external counterparty steps up within some window, the AMM/vault path fills the ticket at its current price.

So the vault stops being the *primary* counterparty and becomes the **maker of last resort**, ensuring users still get a fill even when the order book is thin.

## Why this is deferred

The 3-step flow above is the easy part. Making it actually work requires answers to a stack of structural questions, and there's no point picking answers until we have:

- Real ticket volume (so an RFQ window has a non-trivial chance of finding a counterparty).
- A clearer picture of who the makers actually are (whitelisted MMs? permissionless? vault-plus-one for now?).

Without those, an RFQ implementation just adds a delay step before every ticket falls through to the vault anyway — strictly worse UX with no liquidity benefit.

## Open questions for future-us

When we come back to this, these are the decisions that drive everything else:

- **Maker set.** Pool-only / pool + whitelisted MMs / permissionless? Each one is a different protocol.
- **Maker collateral.** Pre-deposited maker vault, per-quote escrow, or signed quote with pull-on-fill?
- **RFQ unit.** Whole-parlay quote, or per-leg quotes that the engine bundles into a parlay multiplier?
- **Quote lifetime.** Single-shot auction window, or continuous per-leg limit-order book?
- **Vault sophistication.** What does "smarter market maker" mean — inventory-aware skew, Polymarket-anchored mid + utilization edge, last-look fills?
- **Polymarket anchor.** Hard guardrail (vault must quote within ±X% of Polymarket mid) or reference-only input to the vault's quote logic?
- **Frozen odds vs live re-pull.** Math-parity invariant in `POLYMARKET.md` currently depends on frozen probabilities; RFQ implies live re-quoting. Either we relax parity to only cover settlement math, or RFQ quotes a spread on top of the frozen mid.
- **Cashout in an RFQ world.** Re-RFQ the residual parlay (needs a maker willing to buy back) vs. keep AMM-style cashout against the vault and only RFQ the entry.
- **LP earnings attribution.** LPs earn only when the vault wins the auction, or a protocol fee on every match regardless of who filled? Big effect on LockVaultV2 reward flow.
- **AMM coexistence.** Replace the AMM entirely, or run RFQ as a "big tickets" lane on top of the AMM "small tickets" lane (the dual-execution-lanes idea already noted in `CASHOUT.md`).

## What to do before picking this back up

- Watch real ticket flow for long enough to know whether an RFQ window would actually find takers.
- Have a concrete maker-set answer in hand (one named MM willing to integrate beats a permissionless design with no participants).
- Re-read the open questions above and make sure the answers we pick still hang together as one system, not nine independent choices.

No code changes land from this doc. When the design is ready to implement, this file gets rewritten as a real change doc with Part 1 / Part 2 split per the standard template.




## User
I figured out how this will work.
Our AMM pool will take the other side of a parlay on checkout, then open the legs up to the market
If anyone want to buy the other end of a parlay we'll sell it to them at the odds we got it at plus a fee