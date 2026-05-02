# Backlog

Deferred work. Ideas that are on the table but not scheduled. **This is not a roadmap promise.** Items here get picked up when someone has a reason; until then they're parking-lot entries.

When an item here is implemented, strip it from this file and mention it in the matching change doc under `docs/changes/`. If an item here becomes irrelevant (design shifted, problem solved a different way), delete it — don't let stale ideas accumulate.

---

## 1. Dynamic max payout

**Current state:** Max payout per ticket = 5% of TVL (`maxPayoutBps = 500`). On a $10k vault, max payout = $500. A 57x parlay is capped at ~$8.77 stake.

**Problem:** Limits excitement on high-multiplier parlays. Small vaults restrict ticket sizes.

**Possible approaches:**
- **Graduated tiers:** 5% for payouts under $1k, 3% for $1k–$5k, 1% above $5k
- **TVL-scaled curve:** As TVL grows, `maxPayoutBps` increases (e.g., 500 at $10k TVL, 1000 at $100k TVL)
- **Per-ticket risk scoring:** Higher-probability parlays get larger max payouts since they're less likely to pay out

---

## 2. Dynamic fee scaling

**Current state:** Flat fee = `baseFee + perLegFee * numLegs` regardless of vault utilization.

**Improvement:** Scale fees with utilization to create natural back-pressure:

```
effectiveFeeBps = baseFee * (1 + utilization / TARGET_UTIL)
```

At 50% utilization with `TARGET_UTIL = 50%`, fees double. At 70%, fees triple. Discourages heavy betting when the vault is stressed, creates higher yield for LPs during high-demand periods, self-regulates without admin intervention.

Implementation: add `dynamicFee()` view to `ParlayEngine` that reads vault utilization on each `buyTicket`.

---

## 3. Payout tiers & jackpot pool

**Problem:** A single 200x payout can wreck the vault. Capping multipliers kills the fun.

**Improvement:** split large payouts into immediate + jackpot:
- **Immediate:** up to 50x of stake, paid instantly from vault
- **Jackpot overflow:** anything above 50x goes into a jackpot pool
- **Jackpot distribution:** pool pays out over time (weekly draws, or streamed via a vesting schedule)

Lets users build massive multiplier parlays for excitement while protecting vault solvency. Jackpot pool could be a separate contract that accumulates overflow and distributes via epochs.

---

## 4. Oracle fault recovery

**Current state:** If an oracle adapter returns inconsistent or stale data (a leg stays `Unresolved` indefinitely, or an external oracle goes down), tickets referencing that leg become stuck — they can't settle, and progressive claims can't include that leg. No mechanism to recover from a persistently faulty oracle.

**Problems:**
1. **Stuck tickets.** If an oracle never resolves a leg, the ticket stays `Active` forever. Vault reserves remain locked, reducing free liquidity for new bets.
2. **No admin override on optimistic paths.** `AdminOracleAdapter` can resolve manually, but if the production `OptimisticOracleAdapter` is the configured adapter for a leg, only its dispute/resolution flow can produce a result.
3. **No timeout mechanism.** No deadline after which an unresolved leg auto-voids or triggers an emergency path.

**Proposed improvements:**
- **Leg resolution timeout:** add `maxResolutionTime` per leg. If `block.timestamp > leg.earliestResolve + maxResolutionTime` and the leg is still `Unresolved`, anyone can call `voidStaleLeg(legId)` to force-void it. Unblocks settlement for all tickets referencing that leg.
- **Emergency oracle fallback:** owner can set a fallback oracle adapter per leg that activates after the timeout. Could be `AdminOracleAdapter` as a last resort.
- **Batch void for stuck tickets:** admin function to void all tickets older than a threshold that reference unresolved legs, releasing their reserves.
- **Oracle health monitoring:** off-chain service that tracks unresolved legs past their `earliestResolve` and alerts the team.

**Implementation sketch:**
```
LegRegistry:
- maxResolutionTime per leg (set at creation, e.g., 7 days)
- voidStaleLeg(legId): permissionless, checks timeout, sets status to Voided
- setFallbackOracle(legId, adapter): owner-only, activates after timeout

ParlayEngine:
- settleTicket already handles voided legs correctly — no engine changes needed
```

---

## 5. ABIs in Postgres (shared deployment registry)

**Current state:** Each `pnpm deploy:*` regenerates `packages/nextjs/src/contracts/deployedContracts.ts` locally; the file is committed to the repo. Vercel builds from GitHub, so whoever last deployed has to commit the refreshed file. The DB is not involved.

**Problem:** Bites once multiple devs make frontend-only changes against a shared deploy. Today everyone regenerates `deployedContracts.ts` locally and re-commits, which creates spurious diffs and rebases. Single-dev today, so the win is theoretical.

**Possible approach:**
- Add `tbcontractabi (chainid, name, deployedat, address, abi)` to `lib/db/schema.sql`.
- Have `scripts/generate-deployed-contracts.ts` mirror each contract into the DB after the file write (best-effort; tolerant of missing `DATABASE_URL`).
- `/api/db/init` backfills the table from the committed `deployedContracts.ts` so the app can come up before the DB is initialized (the file remains the bootstrap source).
- Keep the committed TS file as the zero-latency fast path; the DB is a secondary mirror.

**Why deferred:** Single-dev project today, and the DB isn't intended to live long-term at the current phase. Pick this back up if the team grows, or if we ever care about verifying old tickets against the ABI they were minted under.

---

## See also — deferred design docs

Long-form deferred designs that don't fit the bullet shape above live as full change docs:

- [`RFQ.md`](RFQ.md) — peer-to-peer parlay markets. Two-sided fills with the vault as maker-of-last-resort. Deferred until there's enough flow for an RFQ window to find takers, and a concrete maker-set answer. Design sketch only — no code planned.

---

## 6
Once a leg is lost the ticket should be resolveable since the person has no chance of winning.
Let them complete the ticket
---

## Priority (informal)

1. Oracle fault recovery — stuck tickets lock vault reserves indefinitely.
2. Dynamic fee scaling — medium effort, strong DeFi mechanic.
3. Dynamic max payout — medium effort, unlocks larger tickets.
4. Jackpot pool — high effort, major feature expansion.
5. ABIs in Postgres — only when multi-dev or historical-ABI verification becomes a real need.
