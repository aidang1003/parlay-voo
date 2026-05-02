# Correlation Engine

**Status:** Design finalized. V1 implementation pending.

Some legs in a parlay are not independent. Same-game parlays (SGP) are the obvious case — "Lakers ML" + "LeBron over 25 pts" are positively correlated, so the naive multiplier `∏(1/p_i)` overpays. Separately, some legs are *mutually exclusive* — only one can resolve true (e.g., "Lakers win NBA Finals" + "Celtics win NBA Finals"). The first gets repriced; the second gets blocked at the builder.

V1 also reworks the fee structure into a single per-leg multiplicative fee, replacing today's `baseFee + perLegFee × n` schedule. All three knobs (fee, correlation asymptote `D`, correlation half-saturation `k`) become `.env`-driven.

---

## Part 1 — Human Spec

### Why this matters now

- `RISK_MODEL.md` calls out correlation-aware discounts as future Level 2 work — this doc moves it in-scope as V1.
- The data model already groups Polymarket markets by `gameGroup`. The grouping primitive exists; the math doesn't.
- Without correlation pricing, a 4-leg SGP on the same NBA game can quote ~50× when the true joint probability supports ~15×. Bleeds the vault on every same-game ticket.
- Without exclusion gating, a user can stack mutually exclusive winners (every team to win the title) at independent-multiplier prices for an unwinnable ticket. The vault still reserves the payout.
- Today's two-knob fee (`baseFee + perLegFee × n`) is awkward to tune and harder to mirror in `.env`. Folding it into a single per-leg knob simplifies the call graph and lines up cleanly with the new `.env` config surface.

### Three distinct concerns

1. **Per-leg fee** — flat, applies to every ticket. Replaces the existing edge math.
2. **Correlation pricing** — legs that are *more likely* to all hit than independence assumes. Adjust the multiplier downward.
3. **Mutual exclusion** — legs that *cannot* all hit. Block at the builder; never let the ticket mint.

Different remedies, different code paths.

### Per-leg fee

A single multiplicative fee `f` is applied to each leg's contribution to the multiplier, before correlation:

```
mult = ∏[(1 − f) × (1/p_i)]   ×   ∏ corrFactor(n_g, D, k)
     = (1 − f)^n × ∏(1/p_i)   ×   ∏ corrFactor(n_g, D, k)
```

Multiplication is order-invariant; "fee per-leg, before correlation" is the conceptual order in the call graph.

Default **f = 1000 BPS = 10%**. Effective total fee `1 − (1−f)^n`:

| n | Effective fee | Multiplier retained |
|---|---|---|
| 2 | 19.00% | 81.00% |
| 3 | 27.10% | 72.90% |
| 4 | 34.39% | 65.61% |
| 5 | 40.95% | 59.05% |

Higher than the legacy `baseFee=100, perLegFee=50` schedule (2.0–3.5% across 2–5 legs) — V1 deliberately raises the take rate on long tickets, which is also where vault risk concentrates. The fee is *invisible* in the UI: cart shows one final multiplier and one final payout, no fee row, no edge row, no breakdown.

### Mutual exclusion

Examples of impossible-to-co-resolve legs:

- "Team A wins NBA Finals" + "Team B wins NBA Finals" — exactly one champion per season.
- "Game ends in regulation" + "Game goes to OT" — disjoint outcomes.
- "X scores >100" + "X scores <100" — opposites of the same threshold.

Mechanic:

- Each leg carries an optional `exclusionGroupId` (0 = no exclusion).
- Builder UI: selecting a leg disables every other leg sharing its `exclusionGroupId`, with a "Conflicts with: <leg>" tooltip.
- `ParlayEngine.buyTicket` reverts with `MutuallyExclusiveLegs(legA, legB)` if two legs share a non-zero `exclusionGroupId`. Defense in depth — not just a UI gate.
- Polymarket sync auto-tags legs from the same "winner" series (one row per outcome, all sharing the series ID as the exclusion group). Seed markets are tagged manually in `seed.ts`.

### Correlation pricing

Legs that share a `correlationGroupId` (typically: same game) get a saturating per-group discount on the multiplier.

**Formula:**

```
discount(n) = D × (n − 1) / (n − 1 + k)
factor(n)   = 1 − discount(n)
mult_corr   = mult_indep × factor(n)
```

For each correlation group with `n ≥ 2` legs:

- **D** — asymptotic ceiling on discount as `n → ∞`. "How harsh ultimately." Default **8000 BPS = 80%**.
- **k** — half-saturation point: at `n − 1 = k`, discount equals exactly `D / 2`. "How quickly we get there." Default **1.0**.

Both knobs are admin-set. Multi-group tickets compound multiplicatively across groups: `mult × factor(n_A) × factor(n_B) × …`.

At the defaults, with p=0.5 and no fee applied:

| Legs in group | Indep mult | Discount | Corr mult |
|---|---|---|---|
| 2 | 4.00× | 40% | 2.40× |
| 3 | 8.00× | 53% | 3.73× |
| 4 | 16.00× | 60% | 6.40× |
| 5 | 32.00× | 64% | 11.52× |
| 8 | 256.00× | 70% | 76.80× |
| ∞ | — | 80% | — |

### Why saturation, not power decay

A power-law `factor = c^(n-1)` was the obvious first cut. It's too gentle on 2-leg SGPs (~30% discount where retail books that correctly price SGPs hit 35–45%) and too brutal on long tickets (92% discount on 8-leg, where the marginal correlation gain is diminishing). Saturation flips both: bites harder early where most ticket volume lives, then plateaus at the configured ceiling. The shape matches what other books do empirically.

The saturation curve is also self-limiting — no separate `corrCap` is needed. `D` *is* the ceiling.

### Configurability

All three protocol knobs live in `.env` as non-sensitive `NEXT_PUBLIC_*` variables, with hardcoded fallbacks in `packages/shared/src/constants.ts` so CI and tests work without a populated `.env`.

| Variable | Default | Meaning |
|---|---|---|
| `NEXT_PUBLIC_PROTOCOL_FEE_BPS` | `1000` | Per-leg fee `f` in BPS (10% default). Applied multiplicatively per leg. |
| `NEXT_PUBLIC_CORRELATION_ASYMPTOTE_BPS` | `8000` | Correlation `D`: asymptotic ceiling on discount per group (80% default). |
| `NEXT_PUBLIC_CORRELATION_HALF_SAT_PPM` | `1000000` | Correlation `k × 1e6`: half-saturation point (k = 1.0 default). |

In addition, `maxLegsPerGroup` (default 3) lives on-chain only — it's a builder-side UX gate, not part of the multiplier math. Hard cap on legs from one correlation group; the 4th selection is rejected. Cheaper than pricing extreme stacks accurately.

The deploy script (`HelperConfig.s.sol`) reads the same env vars via `vm.envOr(...)` and constructor-injects them into `ParlayEngine` + `HouseVault`. Contracts retain `onlyOwner` setters for live tuning. If admin updates a value on-chain, the corresponding `.env` entry must be refreshed in the same PR — otherwise the off-chain quote engine and the on-chain check drift apart.

### What the user sees

**Mutual exclusion** is fully visible — it's a logic gate, not a hidden mechanic:

- Conflicting legs grey out in the builder when a sibling is selected.
- Tooltip: "Conflicts with: Lakers win NBA Finals."
- If `maxLegsPerGroup` blocks a selection, the disabled leg shows neutral "Leg limit reached" copy — no mention of correlation or "same game."

**Per-leg fee and correlation pricing** are invisible — other books don't surface their math, neither do we:

- The cart shows one final multiplier and one final payout. No fee row, no correlation row, no "Same game" tag.
- `/api/quote-sign` and MCP responses also collapse to one multiplier. No breakdown field — otherwise external agents would surface it.

### Open questions

- **Negative correlation handling.** "Team A wins" + "Team B covers" is negatively correlated and *should* increase the multiplier. We floor at zero (factor never exceeds 1.0) — match retail-book conservatism, document as deliberate.
- **Correlation arbitrage.** A user can split a correlated 3-leg ticket into three 1-leg tickets to sidestep the correlation discount. The flat fee discourages this somewhat (single-leg tickets pay `1 − (1−f) = f` = 10% vs. multi-leg compounding), but it's not a complete plug. The right counter is keeping single-leg fee high enough that arbitrage isn't worth the gas — not adding more correlation pricing.
- **Where do `correlationGroupId` and `exclusionGroupId` come from for non-Polymarket markets?** Polymarket sync uses `gameGroup` for correlation and the series ID for exclusion. Seed markets get manual tags in `seed.ts`. Future on-chain sport feeds will need a tagging convention.

### Mutual-exclusion detection — phased rollout

Mutual exclusion is fundamentally a *data* problem, not a math problem: the engine already reverts on duplicate `exclusionGroupId`s, but it's only as good as the tags the data layer feeds it. Rolling out in two phases:

**Phase 1 — structural detection (shipped).** Polymarket's `negRisk` mechanism already groups winner-takes-all markets at the protocol level: every child market in a negRisk event shares the parent `event.id`, and Polymarket guarantees at most one resolves YES. The sync route reads `event.negRisk` from the gamma API, hashes `negrisk:<eventId>` into a numeric `exclusionGroupId`, and stores it in `tblegmapping.bigexclusiongroup`. The `/api/markets` API surfaces the field on every leg. The builder gate in `ParlayBuilder.tsx` greys out conflicting picks. On-chain enforcement requires running `LegRegistry.setLegExclusionGroup(legId, groupId)` for newly-registered legs — kept as an admin operation today (cast/script) so the JIT buy path stays uncomplicated; can be automated as a follow-up cron when there's appetite.

**Phase 2 — LLM screen + human approval (TODO).** negRisk only catches markets Polymarket itself groups. The long tail is *opposite-binary* exclusions where two separate markets cover the same axis (e.g. "ETH > $4000 by Jun 30" + "ETH < $4000 by Jun 30" listed as independent markets, or two unrelated markets that happen to ask "essentially the same thing"). Plan:

1. **Screen at sync time with Haiku.** When new markets land in `tblegmapping`, batch them up and ask Claude Haiku: "Are any of these markets mutually exclusive — i.e. wagers on them have no compounding effect because they ask the same question?" Cheap (~$0.0001/pair, batched), bounded latency, runs in the existing sync cron. Cache results in a new `tbexclusion_proposals` table keyed by `(sourceRefA, sourceRefB)` with status `pending` and the model's reasoning.
2. **Final human approval gate before activation.** A new admin debug page (`/admin/exclusion-review`) lists the pending proposals. Each row shows both markets, the LLM's reasoning, and approve/reject buttons. **A market only goes live (`blnactive=true`) once any pending exclusion proposal touching it has been resolved by an admin.** Approving merges the two source refs into a shared `exclusionGroupId` (assigned server-side); rejecting marks the pair safe and never re-prompts. This keeps the false-positive surface controllable: the LLM is a screener, not the source of truth.
3. **Schema sketch.**
   ```sql
   CREATE TABLE tbexclusion_proposals (
     txtsourcerefa     TEXT NOT NULL,
     txtsourcerefb     TEXT NOT NULL,
     bigproposedgroup  BIGINT NOT NULL,        -- assigned on approve
     txtstatus         TEXT NOT NULL,          -- 'pending' | 'approved' | 'rejected'
     txtmodelreason    TEXT,                   -- Haiku's explanation
     txtmodelid        TEXT,                   -- e.g. 'claude-haiku-4-5-20251001'
     tsproposedat      TIMESTAMPTZ NOT NULL DEFAULT now(),
     tsdecidedat       TIMESTAMPTZ,
     txtdecidedby      TEXT,                   -- admin wallet / email
     PRIMARY KEY (txtsourcerefa, txtsourcerefb)
   );
   ```
4. **Trigger conditions.** Run the screener (a) on the polymarket sync's new-market output, (b) when seed markets are added or edited. Skip pairs already approved/rejected. Batch in groups of ~20 per Haiku call to amortise cost.
5. **Activation gate.** Either gate `/api/markets` to filter rows that have unresolved `pending` proposals, or fold a `txtactivationstatus` column into `tblegmapping` driven by the proposal queue. The exact mechanism is open — pick whichever fits the catalog flow we land on.

The pitch: Haiku already nails "are these the same question?" with very high recall. Pairing it with a human approve gate keeps protocol risk low (any false-positive exclusion just reduces ticket count, not solvency) without forcing us to hand-curate every market.

### Sources consulted

- Pinnacle Sports — articles on why they avoid SGPs.
- DraftKings and FanDuel — public engineering talks on same-game parlay pricing. (No specific patent citation: the number originally cited here belonged to a different patent and has been removed.)
- The Action Network — applied write-ups on correlated parlay edge for retail bettors.
- Fréchet (1951) / Hoeffding (1940) — bounds on joint distributions given marginals; useful as a sanity check that saturation discounts can't push the implied joint probability above `min(p_i)`.

---

## Part 2 — AI Spec Sheet

### Constants (proposed defaults)

```
PROTOCOL_FEE_BPS            = 1000      // f, 10% per-leg fee
CORRELATION_ASYMPTOTE_BPS   = 8000      // D, 80% asymptotic max discount
CORRELATION_HALF_SAT_PPM    = 1_000_000 // k = 1.0
maxLegsPerGroup             = 3         // on-chain only; not a math knob
```

`packages/shared/src/constants.ts` reads from `process.env.NEXT_PUBLIC_*` with these as hardcoded fallbacks. Removed from this file: `BASE_FEE_BPS`, `PER_LEG_FEE_BPS` (deprecated by `PROTOCOL_FEE_BPS`).

### State additions

`packages/foundry/src/core/LegRegistry.sol`:

```solidity
mapping(uint256 => uint256) public legCorrGroup;       // legId → correlationGroupId (0 = uncorrelated)
mapping(uint256 => uint256) public legExclusionGroup;  // legId → exclusionGroupId (0 = no exclusion)
function setLegCorrGroup(uint256 legId, uint256 groupId) external onlyOwner;
function setLegExclusionGroup(uint256 legId, uint256 groupId) external onlyOwner;
function getLegCorrGroups(uint256[] calldata legIds) external view returns (uint256[] memory);
function getLegExclusionGroups(uint256[] calldata legIds) external view returns (uint256[] memory);
```

`packages/foundry/src/core/ParlayEngine.sol`:

```solidity
// REMOVED:
//   uint256 public baseFee = 100;
//   uint256 public perLegFee = 50;
//   function setBaseFee(uint256 _bps) external onlyOwner;
//   function setPerLegFee(uint256 _bps) external onlyOwner;
//   event BaseFeeUpdated(uint256 oldBps, uint256 newBps);
//   event PerLegFeeUpdated(uint256 oldBps, uint256 newBps);

// ADDED:
uint256 public protocolFeeBps;     // initialized via constructor from HelperConfig (.env-driven)
event ProtocolFeeUpdated(uint256 oldBps, uint256 newBps);
function setProtocolFeeBps(uint256 _bps) external onlyOwner;
```

`packages/foundry/src/core/HouseVault.sol`:

```solidity
struct CorrelationConfig {
    uint256 corrAsymptoteBps;   // D in BPS
    uint256 corrHalfSatPpm;     // k in PPM
    uint256 maxLegsPerGroup;
}
CorrelationConfig public corrConfig;
function setCorrAsymptoteBps(uint256 bps) external onlyOwner;
function setCorrHalfSatPpm(uint256 ppm) external onlyOwner;
function setMaxLegsPerGroup(uint256 n) external onlyOwner;
```

### Math additions

`packages/foundry/src/libraries/ParlayMath.sol`:

```solidity
// REMOVED: applyEdge, computeEdge.

/// @notice Apply per-leg multiplicative fee. mul × ((BPS - feeBps) / BPS)^n iteratively.
/// @dev    Iterative loop, not pow — must match math.ts exactly for parity.
function applyFee(
    uint256 mulX1e6,
    uint256 numLegs,
    uint256 feeBps
) internal pure returns (uint256);

/// @notice Saturating discount BPS for a single correlation group of size n.
/// @dev    discount = D × (n - 1) × PPM / ((n - 1) × PPM + k_ppm). Returns 0 for n < 2.
function correlationDiscountBps(
    uint256 n,
    uint256 asymptoteBps,
    uint256 halfSatPpm
) internal pure returns (uint256);

/// @notice Compose a multiplier with per-group saturating discounts.
/// @dev    mul × ∏ (BPS - discount_g) / BPS over all groups with n_g ≥ 2.
function applyCorrelation(
    uint256 mulX1e6,
    uint256[] memory groupSizes,
    uint256 asymptoteBps,
    uint256 halfSatPpm
) internal pure returns (uint256);
```

Mirror identical bigint logic in `packages/shared/src/math.ts` — math-parity invariant.

### Call graph

```
ParlayEngine.buyTicket(legIds, outcomes, stake, ...)
  → LegRegistry.getLegExclusionGroups(legIds)         // NEW
  → ParlayEngine._checkExclusion(exclusionGroups)     // NEW: revert on dup non-zero
  → LegRegistry.getLegProbs(legIds, outcomes)
  → LegRegistry.getLegCorrGroups(legIds)              // NEW
  → ParlayEngine._aggregateGroupSizes(corrGroups)     // NEW: { gid → count }
  → require count[g] ≤ maxLegsPerGroup ∀g             // NEW
  → ParlayMath.computeMultiplier(probs)
  → ParlayMath.applyFee(mul, numLegs, protocolFeeBps) // REPLACES applyEdge
  → ParlayMath.applyCorrelation(mul, groupSizes, D, k)
  → ParlayMath.computePayout(stake, netMul)
  → HouseVault.reservePayout(payout)
```

`buyTicketSigned` runs the same exclusion + maxLegs checks but trusts the multiplier from the EIP-712 payload — server-side quote logic uses the same shared math.

### Errors

```solidity
error MutuallyExclusiveLegs(uint256 legA, uint256 legB);
error TooManyLegsInGroup(uint256 groupId, uint256 legCount, uint256 cap);
error FeeTooHigh(uint256 bps);   // protocolFeeBps must be < BPS
```

### Invariants

1. Math parity: `ParlayMath.applyFee` / `applyCorrelation` and `math.ts` counterparts produce identical values for all inputs.
2. `factor(n) ∈ (0, 1]` for all `(n, D, k)` with `D < BPS` and `k > 0`. `factor(n) == 1` ⇔ `n < 2`.
3. For every non-zero `correlationGroupId` g present in a ticket, `count(legs with group=g) ≤ maxLegsPerGroup`.
4. For every non-zero `exclusionGroupId` e present in a ticket, exactly one leg carries that ID — `buyTicket` reverts otherwise.
5. `netMultiplier ≤ fairMultiplier` always (fee + correlation only ever discount, never inflate).
6. `legCorrGroup[legId] == 0` ⇒ leg contributes 0 to discount. `legExclusionGroup[legId] == 0` ⇒ leg never blocks another. Backwards-compatible: legs with no group set behave as today (modulo the fee change).
7. `protocolFeeBps < BPS` always. `applyFee` reverts otherwise.

### Tests required

- Unit `ParlayMath.t.sol`:
  - `applyFee` produces `mul × ((BPS-f)/BPS)^n` iteratively for n=1..10 at f=1000 BPS; matches reference table.
  - `applyFee` edge: f=0 returns input unchanged. f=BPS-1 collapses multiplier to ~0 quickly.
  - `correlationDiscountBps` matches reference table for default (D=8000, k=1e6) at n=1..8.
  - `correlationDiscountBps` edge: n=0, n=1 yield 0. D=0 yields 0 for all n. Very large k flattens curve toward 0; very small k saturates near D immediately.
- Unit `LegRegistry.t.sol`: only owner can set corr/exclusion groups; default reads return 0.
- Unit `ParlayEngine.t.sol`:
  - 3-leg ticket all in same correlation group → multiplier discounted by both fee and correlation as expected.
  - 3-leg ticket in distinct correlation groups → fee applies, no correlation discount.
  - 4th leg in capped correlation group → reverts with `TooManyLegsInGroup`.
  - 2 legs sharing exclusion group → reverts with `MutuallyExclusiveLegs`.
  - Leg in both correlation group and exclusion group behaves correctly (exclusion wins when triggered).
  - `setProtocolFeeBps` updates fee live; subsequent `buyTicket` uses new fee.
- Fuzz: random `(probs, groupSizes, f, D, k)` — invariants 2, 5, 7 hold.
- Parity: TypeScript and Solidity produce identical multipliers across 1k random vectors at random `(f, D, k)`.
- Integration: full `buyTicket` flow exercises fee + correlation + exclusion gating; `buyTicketSigned` honors all three.

### Frontend

- `ParlayBuilder.tsx`:
  - Selecting a leg disables every other leg sharing its `exclusionGroupId`, tooltip "Conflicts with: <leg name>".
  - Selecting a leg that would push a `correlationGroupId` past `maxLegsPerGroup` disables that leg with neutral "Leg limit reached" copy.
  - Cart shows one final multiplier — no fee row, no correlation row, no "Same game" tag.
- `app/api/markets/route.ts`: surface `correlationGroupId` and `exclusionGroupId` per leg.
- `app/api/polymarket/sync/route.ts`: tag each ingested market with the source series ID as `exclusionGroupId` (winner-style markets) and the gameGroup as `correlationGroupId`.
- `app/api/quote-sign/route.ts`: compute final multiplier server-side using the shared math; sign just the multiplier — no breakdown payload.
- `lib/mcp/tools.ts`: same — single multiplier in tool responses.

### Environment variables

Three new `NEXT_PUBLIC_*` env vars in `.env` and `.env.example`. All non-sensitive (values are public on-chain constants):

```
# Per-leg fee in BPS. Applied as (1 - f) per leg before correlation. 1000 = 10%.
NEXT_PUBLIC_PROTOCOL_FEE_BPS=1000

# Correlation D: asymptotic discount ceiling in BPS. 8000 = 80%.
NEXT_PUBLIC_CORRELATION_ASYMPTOTE_BPS=8000

# Correlation k × 1e6: half-saturation point in PPM. 1_000_000 = k=1.0.
NEXT_PUBLIC_CORRELATION_HALF_SAT_PPM=1000000
```

`shared/constants.ts` reads these via `process.env`, falling back to the defaults above when unset (so tests, CI, and fresh clones work without an `.env`). `HelperConfig.s.sol` reads the same names via `vm.envOr(...)` and passes them to the deploy constructors.

### Files touched

```
packages/foundry/src/libraries/ParlayMath.sol      (drop applyEdge/computeEdge; add applyFee/correlationDiscountBps/applyCorrelation)
packages/foundry/src/core/LegRegistry.sol          (corrGroup + exclusionGroup mappings)
packages/foundry/src/core/HouseVault.sol           (CorrelationConfig)
packages/foundry/src/core/ParlayEngine.sol         (drop baseFee/perLegFee; add protocolFeeBps; exclusion check + correlation aggregation)
packages/foundry/script/HelperConfig.s.sol         (vm.envOr for the 3 new vars)
packages/foundry/script/Deploy.s.sol               (pass fee + corr config to constructors)
packages/foundry/test/unit/ParlayMath.t.sol
packages/foundry/test/unit/LegRegistry.t.sol
packages/foundry/test/unit/ParlayEngine.t.sol
packages/foundry/test/fuzz/CorrelationFuzz.t.sol
packages/shared/src/math.ts                        (drop applyEdge/computeEdge; add applyFee/correlationDiscountBps/applyCorrelation)
packages/shared/src/constants.ts                   (drop BASE_FEE_BPS/PER_LEG_FEE_BPS; add 3 new env-backed constants)
packages/shared/src/types.ts                       (Leg.correlationGroupId, Leg.exclusionGroupId)
packages/shared/src/seed.ts                        (manual tags on seed markets where applicable)
packages/nextjs/src/components/ParlayBuilder.tsx   (exclusion gating + maxLegs gating; no fee/corr breakdown UI)
packages/nextjs/src/app/api/markets/route.ts       (surface group fields)
packages/nextjs/src/app/api/polymarket/sync/route.ts (tag groups during ingest)
packages/nextjs/src/app/api/quote-sign/route.ts    (single-multiplier output)
packages/nextjs/src/lib/mcp/tools.ts               (single-multiplier output)
.env                                               (3 new vars)
.env.example                                       (3 new vars + comments)
docs/ARCHITECTURE.md                               (Protocol Parameters section)
docs/RISK_MODEL.md                                 (move correlation from Level 2 to Level 1: shipped)
docs/llm-spec/RISK_MODEL.md                        (mirror)
```

### Change log

- `packages/shared/src/constants.ts` — drop `BASE_FEE_BPS` / `PER_LEG_FEE_BPS`; add env-backed `PROTOCOL_FEE_BPS`, `CORRELATION_ASYMPTOTE_BPS`, `CORRELATION_HALF_SAT_PPM`, `MAX_LEGS_PER_GROUP`.
- `packages/shared/src/math.ts` — drop `applyEdge` / `computeEdge`; add `applyFee`, `correlationDiscountBps`, `applyCorrelation`. `computeQuote` now folds in fee + correlation discounts.
- `packages/shared/src/types.ts` — `Leg.correlationGroupId` / `Leg.exclusionGroupId`; `QuoteResponse` / `RiskAssessResponse` drop `edgeBps` / `feePaid`.
- `packages/shared/src/schemas.ts` — `QuoteResponseSchema` matches the slimmed shape.
- `packages/foundry/src/libraries/ParlayMath.sol` — same drop + same three new functions, mirroring the TS implementation bit-for-bit.
- `packages/foundry/src/core/LegRegistry.sol` — `legCorrGroup` / `legExclusionGroup` mappings, owner setters, batch view getters.
- `packages/foundry/src/core/HouseVault.sol` — `CorrelationConfig` struct + storage + setters + constructor injection.
- `packages/foundry/src/core/ParlayEngine.sol` — drop `baseFee` / `perLegFee` for `protocolFeeBps`; new errors (`MutuallyExclusiveLegs`, `TooManyLegsInGroup`, `FeeTooHigh`); buy path runs `_checkExclusion` + `_aggregateGroupSizes` + new `_priceQuote` (returns fee, payout, final multiplier with fee + correlation applied).
- `packages/foundry/script/HelperConfig.s.sol` + `script/steps/CoreStep.sol` — thread the four env-driven knobs through to the constructors via `vm.envOr`.
- `packages/foundry/test/unit/{ParlayMath,LegRegistry,ParlayEngine,FeeRouting,EarlyCashout}.t.sol` — exercise the new fee + correlation + exclusion paths and align expected values with the new fee schedule.
- `packages/foundry/test/fuzz/CorrelationFuzz.t.sol` — new property tests for fee/correlation invariants.
- `packages/nextjs/src/lib/__tests__/correlation-math.test.ts` — TS↔Sol parity vectors plus a randomized 1000-vector property.
- `packages/nextjs/src/components/ParlayBuilder.tsx` — exclusion gating, `maxLegsPerGroup` gating, fee row dropped from the cart, multiplier computed via shared math.
- `packages/nextjs/src/lib/hooks/parlay.ts` — `useParlayConfig` reads `protocolFeeBps` from `ParlayEngine` and `corrConfig` from `HouseVault`.
- `packages/nextjs/src/app/api/markets/route.ts` — surface `correlationGroupId` / `exclusionGroupId`.
- `packages/nextjs/src/lib/polymarket/markets.ts` — derive `correlationGroupId` from `txtgamegroup` via FNV-1a 32-bit hash.
- `packages/nextjs/src/app/api/premium/agent-quote/route.ts` + `lib/mcp/tools.ts` — single-multiplier outputs (no `edgeBps` / `feePaid` breakdown).
- `.env.example` — four new `NEXT_PUBLIC_*` knobs.
- `docs/ARCHITECTURE.md` — Protocol Parameters table now lists the four knobs.
- `docs/RISK_MODEL.md` + `docs/llm-spec/RISK_MODEL.md` — correlation moved out of Level 2 into the live pricing path.
- `packages/shared/src/polymarket/types.ts` + `featured.ts` — `CuratedMarket` carries `negRisk` and `eventId` so the sync layer can derive an `exclusionGroupId` from Polymarket's negRisk grouping.
- `packages/nextjs/src/lib/db/schema.sql` + `lib/db/client.ts` — new `bigexclusiongroup` column on `tblegmapping`; `MarketRow` / `UpsertMarketInput` plumb it; `upsertMarket` preserves any existing exclusion tag on conflict so re-syncs can't clobber an approved tag.
- `packages/nextjs/src/lib/polymarket/markets.ts` — `rowToLeg` surfaces `bigexclusiongroup` as `Leg.exclusionGroupId`; `stableHash32` exported for the sync route.
- `packages/nextjs/src/app/api/polymarket/sync/route.ts` — when `event.negRisk === true`, hash `negrisk:<eventId>` into the numeric exclusion group and persist it.
- `docs/changes/CORRELATION.md` — Phase 1 (negRisk → DB → API → builder gate) lands; Phase 2 (Haiku screen + human approval) documented for later.
