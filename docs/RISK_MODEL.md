# Risk Model

*LLM spec: [llm-spec/RISK_MODEL.md](llm-spec/RISK_MODEL.md)*

How the protocol keeps the vault from going insolvent, and how the pricing model is expected to evolve from "hard caps" to "utilization-priced" as TVL grows.

## What exists today (Level 0)

- **Per-ticket cap.** `potentialPayout` for any single ticket cannot exceed 5% of `totalAssets()` (`maxPayoutBps = 500`). A single lucky ticket can't drain the vault.
- **Global cap.** `totalReserved` (sum of outstanding potential payouts) cannot exceed 80% of `totalAssets()` (`maxUtilizationBps = 8000`). Leaves headroom for withdraw latency and shock absorption.
- **1:1 reservation.** Every ticket reserves its full worst-case payout in USDC against the vault. No fractional reserve.

**Missing at Level 0:** per-market exposure caps (a single mispriced market could soak up the entire utilization budget), and utilization-based pricing (the 80% cap is a hard cliff rather than a smooth curve).

## Where it's going (Level 1)

Two shifts from hard caps to pricing:

- **Per-market caps.** No single market can consume more than a fixed share of vault assets. `perMarketExposure[marketId] <= perMarketCapBps * totalAssets()`.
- **Utilization-priced edge.** Instead of rejecting tickets at 80% utilization, the edge climbs as utilization rises. Users see odds slide, not a rejection. Natural back-pressure, no cliff.

The pricing function is **convex**: gentle premium at low utilization, steep near the cap. In formula:

```
premium(u) = minEdgeBps + (maxEdgeBps - minEdgeBps) * (u / utilizationK)^2
```

where `u = totalReserved / totalAssets()`. Convex shape makes tickets expensive enough near the cap to discourage further concentration without forcing an outright reject.

### Correlation pricing — shipped

Correlation moved out of Level 2 and into the live pricing path. Legs sharing a `correlationGroupId` (typically same-game) get a saturating per-group discount on the multiplier:

```
discount(n) = D × (n − 1) / (n − 1 + k)
```

with defaults D = 80% (`CORRELATION_ASYMPTOTE_BPS = 8000`) and k = 1.0 (`CORRELATION_HALF_SAT_PPM = 1_000_000`). Per-group hard cap (`MAX_LEGS_PER_GROUP`, default 3) prevents extreme stacks. Mutual exclusion is enforced at both UI and contract layers. See [changes/B_SLOG_SPRINT.md](changes/B_SLOG_SPRINT.md) for the *why*.

## Level 2 (post-hackathon)

- **Scenario VaR.** Monte Carlo across outstanding binary claims to estimate the actual distribution of vault drawdown, not just the worst-case reserve.
- **Per-correlation-group exposure caps.** Once volume warrants it, cap aggregate USDC exposure per correlation group on top of the per-leg gate.

## Why convex pricing

A linear premium curve either under-prices risk near the cap (tickets still land even when the vault is stressed) or over-prices it at low utilization (no one bets, no LP yield). Convex shape matches how a well-run desk actually underwrites: the first dollar of exposure is cheap, the hundredth is not.

## Why per-market caps beat only a global cap

The global cap is a blunt instrument. It lets the entire vault's risk concentrate in one thinly-traded market if nothing else is going on. Per-market caps force distribution, which is what an LP is signing up for — exposure to many events, not one mis-priced one.

## What the LP sees

- Vault dashboard exposes utilization as a gauge with color bands (green < 50%, yellow 50–75%, red > 75%).
- When utilization-priced pricing ships, the quote UI will show the premium breakdown ("edge: 2% + utilization premium: 0.8%") so both sides know why the odds look the way they do.
- Per-market exposure isn't user-facing today; it becomes an LP-visible metric once Level 1 ships.
