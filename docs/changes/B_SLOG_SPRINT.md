# B-Slog Sprint

The post-A-Day push. Three structural feature changes (correlation engine, trustless oracle, onboarding) and a backlog of UX work that turns the app from "the protocol is functional" into "a new user can land cold and place a bet without help."

Feature mechanics live in the main architecture docs (`docs/ARCHITECTURE.md` + the subsystem specs). This doc keeps **why** each piece happened.

---

## Correlation engine + per-leg fee

**Why this had to ship before any real usage.** Without correlation pricing, a 4-leg same-game parlay quotes ~50× when the true joint probability supports ~15×. Every same-game ticket bleeds the vault. Separately, mutually exclusive legs (every team to win the title) could be stacked at independent-multiplier prices — the user could never win, but the vault was still on the hook for the reserved payout. The two problems get distinct remedies because they're different shapes:

- **Mutual exclusion is a logic gate.** Conflicting legs can't all be true, so block at the builder *and* revert in `ParlayEngine.buyTicket` if two legs share a non-zero `exclusionGroupId`. Defense in depth — the UI alone is not enough.
- **Correlation is a pricing problem.** Same-game legs are *more likely* to all hit than independence assumes. Apply a saturating per-group discount on the multiplier.

**Why a saturation curve, not a power-law decay.** A naive `factor = c^(n-1)` was the obvious first cut. Too gentle on 2-leg SGPs (~30% discount where retail books that price SGPs correctly hit 35–45%) and too brutal on 8-leg tickets (92% discount where the marginal correlation gain is diminishing). Saturation flips both — bites harder early where most ticket volume lives, plateaus at the configured ceiling. Matches what other books do empirically. The curve is also self-limiting, so no separate `corrCap` knob is needed: `D` *is* the ceiling.

**Why fold the existing two-knob fee into one per-leg multiplicative fee at the same time.** `baseFee + perLegFee × n` is awkward to tune and harder to mirror in `.env`. A single `f = 10%` per-leg multiplicative fee compounds cleanly, lines up with the new `.env` config surface, and deliberately raises the take rate on long tickets — which is also where vault risk concentrates.

**Why mutual-exclusion detection is phased.** Polymarket's `negRisk` mechanism already groups winner-takes-all markets at the protocol level — every child market in a negRisk event shares the parent `event.id`, and Polymarket guarantees at most one resolves YES. That's free structural exclusion, shipped now. The long tail (two unrelated markets that happen to ask "essentially the same thing") needs a Haiku-screen + human-approve gate to control the false-positive surface — a market only goes live once any pending exclusion proposal touching it has been resolved by an admin. Phase 2 deferred.

**Why pricing math is invisible in the UI.** Other books don't surface their math, neither do we. Cart shows one final multiplier and one final payout. No fee row, no correlation row, no "Same game" tag. Mutual exclusion, in contrast, is fully visible — it's a logic gate, not a hidden mechanic, and the user needs to understand why a leg is greyed out.

## F-5 — Trustless UMA oracle

**Why this had to ship before mainnet.** Both pre-existing oracle adapters routed trust through the protocol owner. `AdminOracleAdapter.resolve()` was `onlyOwner` — the owner could write any outcome, no challenge, no appeal. The legacy `OptimisticOracleAdapter.resolveDispute()` was also `onlyOwner` — the propose/bond/challenge game was real, but disputes escalated to *us*, not to a decentralized vote. That's a single point of failure that nobody depositing serious capital should accept. Mainnet launch was the deadline.

**Why UMA Optimistic Oracle V3 specifically.** It's deployed on Base mainnet + Sepolia, so we don't add a bridge dependency. Disputes escalate to UMA's DVM (token-holder vote on Ethereum mainnet), which means the loser's bond is slashed by an external decentralized process — we keep the *automation* role (read Polymarket → post assertion) but lose the *arbiter* role.

**Why we still pay a bond despite Polymarket itself running on UMA.** Polymarket's UMA assertions live on OOv2 on Polygon. That's a different oracle instance on a different chain — there's no way to piggyback. Our assertion on Base OOv3 is a separate assertion about a separate statement. The bond is refundable on truthful assertions (minus cents in UMA fees), so the capital recirculates rather than being a recurring cost.

**Why `AdminOracleAdapter` stays on testnets.** UMA's 2-hour liveness window kills the "buy a ticket, watch it resolve in the next minute" demo loop. Sepolia keeps fast admin resolution for QA; flipping `NEXT_PUBLIC_ORACLE_MODE=uma` exercises the real UMA flow end-to-end. Mainnet never hands out admin — `AdminOracleAdapter.resolve()` reverts on `block.chainid == 8453` so the backdoor is literally unreachable.

**Safety property that justifies the change.** The only writer to `_finalStatus` / `_finalOutcome` / `_isFinalized` in `UmaOracleAdapter` is `assertionResolvedCallback`, gated by `msg.sender == address(uma)`. No `onlyOwner` function can reach outcome state. Config setters (`setLiveness`, `setBondAmount`) exist but never touch outcomes. Verified by unit test `test_adminSetters_cannotWriteOutcomeState`.

## Onboarding

**Why a brand-new user needed their own surface.** Landing a wallet/balance-aware parlay builder on someone who's never used a crypto wallet means they see half the UI in error states (no wallet, wrong chain, zero balance, no gas) with no obvious order to fix them. The cognitive cost is "I don't know what's broken or what I should click first." Putting onboarding at `/` and the builder at `/parlay` lets the builder assume "you're set up" and gives the new user a single linear surface to clear before they ever see odds.

**Why the CTA sits on top once complete.** A returning user who already finished onboarding shouldn't have to scroll past five green checks to find "Enter the app." First thing on the page collapses the common case into a one-click experience.

**Why the faucet contract is excluded from `Deploy.s.sol`.** The faucet is operationally distinct from the protocol — it can be redeployed, drained, refilled, paused independently. A re-deploy of the protocol must not reset the faucet's `claimed` map or risk forgetting to fund it. Its own `script/DeployOnboardingFaucet.s.sol` keeps the lifecycle separate.

**Why the faucet is funded + owned by `HOT_SIGNER_PRIVATE_KEY`, not `WARM_DEPLOYER_PRIVATE_KEY`.** Refilling is a routine, repeated ops task that wants a hot key. The deployer is intended to be cold on mainnet. `HOT_SIGNER_PRIVATE_KEY` is already the project's "always-online" signer, so reusing it for faucet ops avoids introducing a third operational key. On testnet the two keys collapse onto the same address by default, so day-to-day nothing changes; on mainnet the split is meaningful.

**Why one-time ETH but daily USDC.** ETH is precious testnet inventory and a one-time bound makes refilling a manageable ops task. MockUSDC is unlimited supply and the only real cost is a tx fee, so a daily drip lets returning users top up without redeploying anything.

**Why steps are auto-detected, never re-asked.** Each step has a passive completion check, not a "did the user click the button" flag. A returning user with funds shouldn't see the faucet buttons at all. Returning users with everything in place see five green circles and the CTA, nothing else.

**Why the FTUE spotlight on the builder lost a step.** The wallet-connect step was redundant — anyone reaching `/parlay` from `/` already has a wallet on the right chain. Dropping it also fixed a long-standing bug where the spotlight's `parlay-panel` step targeted an element that only mounts after a leg is selected, so a fresh page broke the tour. The spotlight now auto-advances after a 1.5s grace if a target never appears, so the same class of bug can't reappear.

## UX overhaul (B-Slog backlog)

These are the items that surfaced during A-Day and got pushed to this sprint. Each one was a real friction point, not polish for its own sake.

- **`/vault` personal/global split.** The vault page was a global protocol dashboard with personal data sprinkled in. Users couldn't quickly answer "how much do I have here, and how much have I earned?" without scanning. Split into "My Position" and "Vault Overview" tabs; default = My Position when connected, Vault Overview when not. Header gets a compact `$USDC · $vault` pill that opens a popover with the full personal panel. The lifetime-earnings number wasn't added because `LockVaultV2` only exposes `pendingRewards` — a lifetime number would require off-chain event indexing, out of scope.
- **`/tickets` personal/global split with an event-sourced activity feed.** `/tickets` was 100% personal; nowhere in the app showed "what's happening on the protocol right now." An activity feed sourced from `TicketPurchased` / `TicketSettled` / `EarlyCashout` events is the lightest-weight social proof we can ship — no DB, no leaderboard, just chronological events with short addresses or ENS. Status filters (Active/Settled/etc.) only apply to "My Tickets" because Activity is purely time-ordered.
- **Polymarket sync: incremental upsert instead of clear-and-rebuild.** The old sync nuked `tblegmapping` and rebuilt every time, which (a) churned the DB, (b) lost any state set after first registration, (c) re-emitted `createLeg` calls for markets that already had on-chain leg IDs. The new path uses `INSERT ... ON CONFLICT DO UPDATE` keyed on `txtsourceref`, refreshing only volatile fields (probs, volume, payload, score, cutoff). Registration metadata (leg IDs, question, category, gameGroup) is preserved.
- **Replace leg hashes with question text.** Both `/admin/debug` (the resolver) and `/ticket/[id]` (the user-facing detail) rendered raw legId hashes where the question should appear. The resolver couldn't tell what they were resolving; the ticket page read like raw on-chain data. `useLegDescriptions` already existed; it was only a question of using it. Hash stays visible on hover for on-chain provenance.
- **Per-leg multiplier in the cart.** Builder UX — user can now see what each leg contributes to the combined multiplier, so trimming the cart feels intentional instead of guesswork.
- **Curved rocket flight path on the multiplier graph.** Visual polish — the rocket on the multiplier-climb chart used to have curved styling in the original `parlaycity` repo and went flat in a refactor. Catmull-Rom-to-Bezier `smoothPath`; the dash-reveal animation now scales to the actual curved path length so segment reveals stay aligned with leg resolution.
- **YES/NO distribution per leg on the debug resolver.** The resolver was picking YES/NO/VOID for a leg without knowing what existing ticket holders chose. With multiple users on opposite sides of the same leg, the wrong choice silently kills one cohort. Resolver now shows "12 YES / 4 NO" before the click.
- **Recently-resolved history strip on the debug page.** Audit trail — the debug page only listed legs needing resolution; once resolved they vanished. New "Recently Resolved" section shows the last ~20, sourced from `LegResolved` events.
- **Hide on-chain-resolved legs from the builder.** Today the builder lets a user add a leg that's already been resolved on-chain, then the buy reverts at signature time. Now filtered out at the source via `useLegStatuses`. Existing tickets carrying that leg are unaffected (snapshot at buy time).
- **Comma + decimal formatting on numeric inputs.** Stakes / mint amounts up to 100K MockUSDC are easy to mistype as 1M without thousands separators. Formatted shadow line below each input lets the user sanity-check before signing — option (a) over option (b) (format-on-blur, parse-on-focus) because option (b) introduces input-parser footguns.

---

## What this sprint left behind

The remaining open work — items deferred from this sprint — lives in [`BACKLOG.md`](BACKLOG.md). The big ones: dynamic max payout, dynamic fee scaling, oracle fault recovery, jackpot pool, ABIs in Postgres for multi-dev work, and the RFQ design sketch (peer-to-peer parlay markets — vault becomes maker-of-last-resort once we have real flow).
