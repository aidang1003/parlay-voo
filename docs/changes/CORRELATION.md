# Correlation Engine

**Status:** Research / design. No implementation yet.

Some legs in a parlay are not independent. Same-game parlays (SGP) are the obvious case — "Lakers ML" + "LeBron over 25 pts" are positively correlated, so the naive multiplier `∏(1/p_i)` overpays. Cross-asset crypto bets ("BTC up 5%" + "ETH up 5%") are similarly correlated. A correlation engine estimates the joint probability of all legs hitting and applies a discount to the multiplier so the vault is paid the right risk premium.

This doc is the research deep-dive the user asked for. It surveys how the industry and the literature handle this, then narrows to a recommended scope for ParlayVoo.

---

## Part 1 — Human Spec

### Why this matters now

- `RISK_MODEL.md` already calls out "correlation-aware discounts" as Level 2.
- The data model already groups Polymarket markets by `gameGroup`. The grouping primitive exists; the math doesn't.
- Without correlation, a 4-leg SGP on the same NBA game can quote ~50× when the true joint probability supports ~15×. That is a vault-bleeding bug the moment we open SGP-friendly markets.

### Where correlation comes from

Three distinct sources, each with a different magnitude and a different remedy:

1. **Same-game / same-event** — multiple bets on one underlying game. Strong, well-studied, *positively* correlated for "rooting for the same outcome" parlays (team win + player over) and *negatively* correlated for hedge-shaped parlays (team A wins + team B covers). This is the dominant source. [DraftKings patent](https://patents.google.com/patent/US20180322749A1) targets exactly this.
2. **Same-narrative / cross-event** — different events that share a driver. "BTC > $100k" + "ETH > $5k" on the same day; both NFL favorites covering on a windy weekend. Weaker but non-trivial. Hard to attribute.
3. **Same-resolution-source** — both legs depend on the same oracle adapter. Strictly an oracle-failure correlation, not a market-fundamentals one. Lives in the threat model, not the pricing model.

ParlayVoo only needs to price (1) accurately, treat (2) as a configurable knob, and ignore (3) here (it's a `THREAT_MODEL` concern).

### The complexity spectrum

There is no "the correct" correlation model. Books and academics span five rungs of complexity, each one an order of magnitude more expensive than the last. The decision is which rung to climb to.

**Level 0 — Independence (today's state).** `multiplier = ∏(1/p_i)`. Wrong for SGP, fine for cross-event single-leg parlays where independence is a defensible assumption.

**Level 1 — Block correlation discount.** Tag each leg with a `correlationGroupId`. Count legs per group. For each group with `n > 1`, subtract a flat discount in BPS:
```
corrBps = ∑_groups corrPerExtraLegBps(category) × max(0, n_g − 1)
multiplier = ∏(1/p_i) × (1 − corrBps/10_000) × (1 − edgeBps/10_000)
```
This is the simplest model that captures the right *direction* of the bias (more legs in a group → more discount). On-chain, deterministic, pure integer math, mirrors cleanly into TypeScript. **Pinnacle** historically just refused SGP rather than build something more complex; this is a respectable middle ground. Configuration: one `corrPerExtraLegBps` per leg category (NBA: ~600 bps/leg, NFL: ~800, prediction-market event: ~300, independent: 0).

**Level 2 — Pairwise correlation matrix.** Each leg carries a `legType` tag (e.g., `home_ml`, `home_total_over`, `qb_pass_yds_over`). An admin-curated symmetric matrix `ρ[i][j] ∈ [−1, 1]` defines pairwise correlation by type. Joint probability of binary outcomes given marginals `(p_i, p_j)` and correlation `ρ` follows the Bahadur expansion:
```
P(A∩B) ≈ p_i × p_j + ρ × √(p_i (1−p_i) p_j (1−p_j))
```
Pairwise extends to k legs by an inclusion-exclusion or by collapsing pairs into a Gaussian copula. **DraftKings**' patent describes a sequential conditional approximation that is mathematically equivalent to a Gaussian copula at the pairwise level. Configuration: the matrix is the configuration. **Sklar's theorem** is the rigorous backing — every joint distribution decomposes into marginals plus a copula, and a Gaussian copula on binaries reduces to pairwise ρ.

**Level 3 — Joint distribution / copula on continuous drivers.** Model the underlying random variables (final score, player stat lines) as a multivariate distribution; legs are indicator events on that distribution. Apply a copula (Gaussian, Student-t, Archimedean) to introduce dependence. Compute leg probabilities by integrating the copula's CDF. **Genest & Favre (2007)** is the practical guide; **Embrechts, McNeil & Straumann (2002)** is the canonical "why Pearson ρ alone is dangerous" reference. Heavyweight: requires fitting copula parameters, runs off-chain only.

**Level 4 — Scenario-based simulation.** Build a per-sport game model (Glickman–Stern state-space for NFL, Markov play-by-play for NBA, Poisson goals for soccer). Monte-Carlo 10k+ scenarios per game. Joint parlay probability = fraction of scenarios where all legs hit. **DraftKings** and **FanDuel** SGP engines run at this level internally; their patents describe scenario stacks of millions per ticket. The most accurate, also the most operationally expensive — needs detailed game data, dedicated infra, and re-runs every quote.

**Bounds that constrain every level.** No matter how clever the model, the **Fréchet–Hoeffding** bounds set hard limits given marginals:
```
max(0, p_1 + p_2 − 1)  ≤  P(A ∩ B)  ≤  min(p_1, p_2)
```
Useful both as a sanity check on any computed joint probability and as a worst-case fallback if the engine misbehaves.

### Recommended scope for ParlayVoo

A tiered rollout — climb only as far as flow demands.

**V1 (in scope, ~2–3 days work).** Level 1 block discount, fully on-chain.
- Add `correlationGroupId` per leg in `LegRegistry` (default 0 = uncorrelated).
- Add `corrPerExtraLegBps` per category in `RiskConfig` (admin-set).
- `ParlayMath.computeCorrelationBps(groupCounts, perLegBps)` returns total correlation BPS.
- `buyTicket` applies the discount alongside the existing edge.
- Cart UI shows the breakdown ("base multiplier 50× → correlation-adjusted 38× → after edge 36×").
- Default to "all Polymarket markets in the same `gameGroup` share a `correlationGroupId`." Seed markets default to the market's id.

**V2 (mid-term, signed-quote only).** Level 2 pairwise matrix, off-chain + EIP-712 signed.
- `/api/quote-sign` already signs multipliers. Extend it to compute a Bahadur/copula joint probability from a server-side `ρ`-matrix keyed by `legType`.
- On-chain stays at Level 1 as the unsigned-path default. Signed quotes get the more accurate price; users without a server quote get the conservative block discount.
- Matrix is a JSON config in `packages/shared/src/correlation-matrix.ts`, hot-reloadable on the server.
- `legType` becomes a new field on `Leg`. Polymarket sync labels each market with a type (`home_ml`, `home_total_over`, `player_points_over`, `binary_event`, etc.).

**V3 (deferred, mention only).** Level 4 scenario simulation. Only if SGP volume justifies it. Likely a sport-by-sport rollout (NBA first, since BallDontLie data is already integrated). This is the **DraftKings/FanDuel** path; it's also a 6-month engineering project. Not in scope for this protocol.

We do **not** plan to build Level 3 (continuous copulas on game-level random variables). It sits in an awkward middle — more work than Level 2, less accurate than Level 4 — and the literature backs Level 4 as the right next step once Level 2 hits its accuracy ceiling.

### Configurability — what knobs the admin gets

V1 config (all on-chain, owner-set):
- `corrPerExtraLegBps[category]` — strength of the discount per category. Higher for sports than for independent prediction markets.
- `corrCap` — global ceiling on total correlation BPS so a 5-leg same-game stack cannot zero out the multiplier (e.g., 4000 = 40% max discount).
- `maxLegsPerGroup` — hard cap on legs from one correlation group (e.g., 3). Beyond the cap, the next leg is rejected outright. Cheaper than pricing extreme stacks accurately.

V2 config (server-side, admin-curated):
- `ρ-matrix` keyed by `(legType, legType)`. Admin-curated. Negative entries handle hedge legs (team A win + team B over) — though we likely floor at zero for V2 to stay conservative.
- `categoryConservatism` — global multiplier on every entry of the matrix (0.5 = use half of the curated ρ). Lets the team dial conservatism without re-curating the matrix.
- `signedQuoteRequired[category]` — for high-correlation categories (NBA SGP), require a signed quote so the unsigned path can't be used to dodge correlation pricing.

### Why this scope

- **Level 1 covers the 80% case.** For 2-leg same-game parlays, a flat per-leg discount and the Bahadur expansion produce multipliers within ~5–10% of each other for typical NBA `legType` pairs (positive ρ in the 0.3–0.6 range). The marginal accuracy gain from Level 2 is real but doesn't justify shipping it before there's volume.
- **Level 2 unlocks SGP advertising.** Once we want to market "same-game parlays" as a feature, the flat discount looks crude next to the matrix. But until that marketing happens, V1 protects the vault and V2 is dead code.
- **Signed-quote split keeps on-chain math simple.** The math-parity invariant is between `ParlayMath.sol` and `packages/shared/src/math.ts`. Pushing complexity into the off-chain quote engine doesn't break parity — the on-chain check is "did the signer authorize this multiplier", not "does the multiplier follow a specific formula."
- **Configurability beats sophistication.** A wrong matrix calibrated by gut is no better than a flat discount. The ability to ratchet `categoryConservatism` down quickly when something looks off is more valuable than another decimal of accuracy.

### What the user sees

- Cart UI shows three rows when correlation > 0: `Base × ∏(1/p_i)` → `Correlation discount −X%` → `House edge −Y%` → `Net multiplier`.
- Each leg in the cart picks up a small "Same game: NYK vs BOS" tag when it shares a `correlationGroupId` with another selected leg.
- If `maxLegsPerGroup` blocks a selection, the disabled leg shows "Already 3 legs from this game" instead of just being un-clickable.
- Quote API exposes the breakdown so external agents (MCP) get the same transparency.

### Open questions

- **Negative correlation handling.** A bet like "Team A wins" + "Team B covers" is negatively correlated and *should* increase the multiplier. Most retail books floor at zero so they never pay above independent odds. We should match that conservatism for V1, document it as deliberate, and revisit only if a sharp user community emerges.
- **Where does `legType` live for non-Polymarket markets?** Seed markets need a type tag too if V2 is going to work. Probably a `typeRef` field on `Leg`.
- **Cross-game correlation (Source 2 above).** Worth a global "narrative day" knob? E.g., on FOMC days, mark every `BTC_up` and `ETH_up` leg as same-group. Probably out of scope for V1 + V2; flag for V3.
- **Matrix curation labor.** Even a 20-`legType` matrix is 190 unique entries. Realistically we curate ~20 high-volume pairs and default the rest to 0. Labor is the same order as fee parameter tuning — doable, but allocate a day.
- **Correlation breaks the no-arbitrage decomposition.** A user can split a correlated 3-leg ticket into three 1-leg tickets and side-step the discount. The right counter is to keep edge-on-1-leg-tickets above the savings — not to fight the arbitrage with more correlation pricing.

### Sources consulted

Industry / applied:
- Pinnacle Sports — articles on why they avoid SGPs and how they think about correlated outcomes.
- DraftKings patent **US 2018/0322749 A1**, "System and methods for correlated parlays."
- FanDuel engineering presentations (Sloan Sports Analytics) on same-game parlay engines.
- The Action Network — applied write-ups on correlated parlay edge for retail bettors.

Academic / foundational:
- Sklar (1959) — copula decomposition theorem.
- Glickman & Stern (1998) — "A State-Space Model for National Football League Scores."
- Embrechts, McNeil & Straumann (2002) — "Correlation and Dependence in Risk Management: Properties and Pitfalls."
- Genest & Favre (2007) — "Everything You Always Wanted to Know about Copulas."
- Bahadur (1961) — representation of joint binary distributions.
- Fréchet (1951) / Hoeffding (1940) — bounds on joint distributions given marginals.
- Levitt (2004) — "Why Are Gambling Markets Organized So Differently from Financial Markets?"
- Wolfers & Zitzewitz — prediction-market joint-probability extraction (relevant to Polymarket-anchored legs).

---

## Part 2 — AI Spec Sheet

### V1 constants (proposed defaults)

```
corrPerExtraLegBps:
  nba:                 600
  nfl:                 800
  mlb:                 400
  nhl:                 500
  crypto:              300
  prediction_event:    300
  independent:         0
corrCap:               4000   // 40% max correlation discount
maxLegsPerGroup:       3
```

Lives in `packages/shared/src/constants.ts` and is mirrored as a `RiskConfig` field on-chain.

### V1 state additions

`packages/foundry/src/core/LegRegistry.sol`:
```solidity
mapping(uint256 => uint256) public legCorrGroup;       // legId → correlationGroupId (0 = uncorrelated)
mapping(uint256 => string) public legCategory;         // legId → category tag (e.g. "nba")
function setLegCorrGroup(uint256 legId, uint256 groupId) external onlyOwner;
function setLegCategory(uint256 legId, string calldata cat) external onlyOwner;
```

`packages/foundry/src/core/HouseVault.sol` (extending the `RiskConfig` already sketched in `RISK_MODEL.md`):
```solidity
struct CorrelationConfig {
    uint256 corrCap;                                   // bps
    uint256 maxLegsPerGroup;
    mapping(bytes32 => uint256) corrPerExtraLegBps;    // keccak256(category) → bps
}
CorrelationConfig public corrConfig;
function setCorrPerExtraLegBps(string calldata cat, uint256 bps) external onlyOwner;
function setCorrCap(uint256 bps) external onlyOwner;
function setMaxLegsPerGroup(uint256 n) external onlyOwner;
```

### V1 math additions

`packages/foundry/src/libraries/ParlayMath.sol`:
```solidity
/// @notice Compute total correlation BPS given per-group leg counts and per-leg-extra BPS.
/// @param extraLegs    Array of (legCount - 1) per non-trivial group; zero-count groups omitted.
/// @param perLegBps    Array of corrPerExtraLegBps, aligned with extraLegs.
/// @param cap          Global corrCap.
/// @return corrBps     Total correlation BPS, capped at `cap`.
function computeCorrelationBps(
    uint256[] memory extraLegs,
    uint256[] memory perLegBps,
    uint256 cap
) internal pure returns (uint256 corrBps);

/// @notice Apply correlation BPS as a multiplicative discount on a multiplier.
/// @dev    netCorrelated = mul × (BPS − corrBps) / BPS. Composes with applyEdge.
function applyCorrelation(
    uint256 mulX1e6,
    uint256 corrBps
) internal pure returns (uint256);
```

Mirror in `packages/shared/src/math.ts` with identical bigint arithmetic — math-parity invariant.

### V1 call graph

```
ParlayEngine.buyTicket(legIds, outcomes, stake, ...)
  → LegRegistry.getLegProbs(legIds, outcomes)
  → LegRegistry.getLegGroups(legIds)              // NEW
  → LegRegistry.getLegCategories(legIds)          // NEW
  → ParlayEngine._aggregateGroups(groups, cats)   // NEW: groups → (extraLegs, perLegBps)
  → ParlayMath.computeMultiplier(probs)
  → ParlayMath.computeCorrelationBps(extraLegs, perLegBps, cap)
  → ParlayMath.applyCorrelation(mul, corrBps)
  → ParlayMath.applyEdge(mul, edgeBps)
  → ParlayMath.computePayout(stake, netMul)
  → HouseVault.reservePayout(payout)
  → require ticket passes maxLegsPerGroup check    // NEW
```

`buyTicketSigned` skips the on-chain correlation calculation and trusts the multiplier in the EIP-712 payload — V2 logic lives off-chain.

### V1 invariants

1. Math parity: `ParlayMath.computeCorrelationBps` and `math.ts.computeCorrelationBps` produce identical values for all inputs.
2. `corrBps ≤ corrCap` for every accepted ticket.
3. For every non-zero `correlationGroupId` g present in a ticket, `count(legs with group=g) ≤ maxLegsPerGroup`.
4. `netMultiplier ≤ fairMultiplier` always (correlation only ever discounts, never inflates — V1 floors negative correlation at zero by construction).
5. `legCorrGroup[legId] == 0` ⇒ leg contributes 0 to `corrBps`. Backwards-compatible: existing legs with no group set behave exactly as today.

### V1 tests required

- Unit `ParlayMath.t.sol`: `computeCorrelationBps` happy path, cap enforcement, zero-extra-legs no-op.
- Unit `LegRegistry.t.sol`: only owner can set group/category; default reads return zero.
- Unit `ParlayEngine.t.sol`: 3-leg ticket all in same group → multiplier discounted; 3-leg ticket in distinct groups → no discount; 4th leg in a capped group → revert.
- Fuzz: random `(probs, groups, perLegBps, cap)` — invariant `netMul ≤ fairMul`, `corrBps ≤ cap`.
- Parity: TypeScript and Solidity produce identical multipliers across 1k random vectors.
- Integration: full `buyTicket` with a 2-leg same-game ticket vs independent-leg ticket, same probabilities — same-game should reserve less, multiplier should be lower.

### V2 sketch (deferred, off-chain only)

```ts
// packages/nextjs/src/lib/correlation/matrix.ts
export const CORRELATION_MATRIX: Record<string, Record<string, number>> = {
  nba_home_ml: { nba_home_total_over: 0.55, nba_home_total_under: -0.55, ... },
  ...
};

// packages/nextjs/src/lib/correlation/joint.ts
// Bahadur 2nd-order expansion for k-leg joint probability.
export function jointProbBahadur(
  marginals: number[],     // p_i in [0,1]
  rhoMatrix: number[][],   // symmetric, ρ_ij ∈ [-1, 1]
): number;                 // joint probability of all legs hitting
```

`/api/quote-sign` swaps `computeMultiplier` for `1 / jointProbBahadur(marginals, rhoMatrix)` and signs the result. V1 on-chain math is unchanged. The signer is the only entity that needs the matrix; mis-pricing is bounded by `signedQuoteRequired` plus the on-chain `corrCap` ceiling on the unsigned path.

### Files touched

V1:
```
packages/foundry/src/libraries/ParlayMath.sol
packages/foundry/src/core/LegRegistry.sol
packages/foundry/src/core/HouseVault.sol           (RiskConfig fields)
packages/foundry/src/core/ParlayEngine.sol         (aggregation + new path)
packages/foundry/script/Deploy.s.sol               (set defaults)
packages/foundry/test/unit/ParlayMath.t.sol
packages/foundry/test/unit/LegRegistry.t.sol
packages/foundry/test/unit/ParlayEngine.t.sol
packages/foundry/test/fuzz/CorrelationFuzz.t.sol
packages/shared/src/math.ts
packages/shared/src/constants.ts
packages/shared/src/types.ts                       (Leg.correlationGroupId, Leg.category)
packages/nextjs/src/components/ParlayBuilder.tsx   (breakdown UI + maxLegsPerGroup gating)
packages/nextjs/src/app/api/markets/route.ts       (surface group + category in API)
packages/nextjs/src/app/api/polymarket/sync/route.ts (default group = gameGroup hash)
docs/RISK_MODEL.md                                 (move correlation from Level 2 to Level 1 status: shipped)
docs/llm-spec/RISK_MODEL.md                        (mirror)
```

V2 (additional, when picked up):
```
packages/shared/src/correlation-matrix.ts          (NEW)
packages/shared/src/correlation/joint.ts           (NEW — Bahadur expansion)
packages/nextjs/src/app/api/quote-sign/route.ts    (use joint prob)
packages/foundry/src/core/ParlayEngine.sol         (signedQuoteRequired check)
```

### Change log

- _(none yet — this is a research / design doc; no code lands until V1 is approved)_
