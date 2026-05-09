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
2. **No admin override on UMA paths.** `AdminOracleAdapter` can resolve manually on testnets, but on mainnet legs are pinned to `UmaOracleAdapter` and only UMA's assertion/dispute/DVM flow can produce a result. If UMA itself is unavailable or assertions never get posted, there's no safety hatch.
3. **No timeout mechanism.** No deadline after which an unresolved leg auto-voids or triggers an emergency path.

**Proposed improvements:**
- **Leg resolution timeout:** add `maxResolutionTime` per leg. If `block.timestamp > leg.earliestResolve + maxResolutionTime` and the leg is still `Unresolved`, anyone can call `voidStaleLeg(legId)` to force-void it. Unblocks settlement for all tickets referencing that leg.
- **Emergency oracle fallback:** owner can set a fallback oracle adapter per leg that activates after the timeout. On mainnet this would have to be a new dedicated adapter — `AdminOracleAdapter.resolve()` reverts on `block.chainid == 8453` by design, so it can't be the fallback there.
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

## 6. Early-resolve tickets once a leg is lost

Once any leg in a ticket loses, the user has no chance of winning the parlay. The ticket should be resolvable immediately rather than waiting for every remaining leg to settle — frees vault reserves earlier and gives the user closure.

---

## 7. RFQ — peer-to-peer parlay markets

**Status:** Design sketch only. No code planned.

**Why this is on the radar.** Prediction markets are intentionally structured differently from a casino: every position has a peer on the other side, not a house. ParlayVoo today is closer to the casino end — users buy parlays priced off frozen Polymarket odds, and the LP vault is the sole counterparty. Fine while volumes are low; caps how big the protocol can grow without the vault carrying all of the directional risk.

**The shape we'd want.** User builds a ticket; instead of immediate fill, the ticket broadcasts as an open RFQ; if no external counterparty steps up within some window, the vault fills it at its current price. The vault stops being the *primary* counterparty and becomes the **maker of last resort**.

The simpler near-term variant the user landed on: the AMM pool always takes the other side at checkout and *then* opens the legs to the market — anyone who wants to buy the other end of a parlay can buy it from the vault at the original odds plus a fee. This shifts the AMM into a market-making role without needing a real RFQ window from day one.

**Why deferred.** The 3-step flow is the easy part. Making it actually work requires answers to a stack of structural questions (maker set: pool-only / whitelisted MMs / permissionless? maker collateral model? RFQ unit: whole-parlay vs per-leg? quote lifetime? Polymarket anchor as guardrail or input? cashout in an RFQ world? LP earnings attribution?) and there's no point picking answers until we have:

- Real ticket volume so an RFQ window has a non-trivial chance of finding a counterparty.
- A clearer picture of who the makers actually are — one named MM willing to integrate beats a permissionless design with no participants.

Without those, an RFQ implementation just adds a delay step before every ticket falls through to the vault anyway — strictly worse UX with no liquidity benefit. When the design is ready to implement, this entry gets rewritten as a real change doc with Part 1 / Part 2 split.

---

## 8. Compromised-key detection + auto-pause

**Why this is on the radar.** `WARM_DEPLOYER_PRIVATE_KEY` and `HOT_SIGNER_PRIVATE_KEY` both have well-defined "honest behavior" envelopes (see `docs/THREAT_MODEL.md` T7, T9). Manual recovery from a leak depends on a human noticing fast, which is the slow path — meanwhile the attacker is on-chain. We want to detect anomalous behavior automatically and pause the protocol before they can drain meaningfully.

**Honest signals to watch (warm key):**
- `setEngine` called to any address that isn't our pre-registered legitimate engine.
- `setTrustedQuoteSigner` called within a short window of a quote-pattern anomaly (T9 ↔ T7 cascade).
- `setMaxUtilizationBps` / `setMaxPayoutBps` raised significantly in one tx.
- `AdminOracleAdapter.resolve()` called by an EOA that hasn't called it before, or with a status that contradicts a Polymarket result already in the DB.
- Owner transactions originating from a new IP / region / time-of-day vs. deployer baseline.

**Honest signals to watch (hot key):**
- Quote-signing rate spike (e.g., > N quotes/minute, or > X% of recent quotes for a single user).
- Quotes with multipliers that disagree with the server's own `computeQuote` for the same leg set, by > tolerance.
- Quotes signed for nonces server-side never issued (signer key used outside the server).

**Two-tier response:**
- *Tier 1, soft brake:* server-side rate-limit signing, refuse to issue further quotes, page the operator. Doesn't require any on-chain tx, so safe to trigger on noisy signals.
- *Tier 2, hard brake:* `pause()` `ParlayEngine` and `HouseVault` from a separate "guardian" key — a multisig or single-purpose key whose only power is `pause`. Triggered only on high-confidence signals (forged signer = not us, or owner-call from a new origin).

**The guardian-pause design.** Add a `pauseGuardian` role to `HouseVault` and `ParlayEngine`. Guardian can `pause` but **not** `unpause` and **not** call any other owner setter. Compromise of the guardian key → DoS, not drain. Compromise of warm key → still bad, but guardian gives us a separate shutoff that the attacker doesn't control. Implementation: add `onlyGuardianOrOwner` modifier to `pause()`; leave `unpause()` as `onlyOwner`.

**Watcher topology.** Off-chain watcher (a Vercel cron + Discord/PagerDuty hook) tails the Engine + Vault contract events and the JIT-quote endpoint logs. Anomaly heuristics run on the watcher; on Tier 2 trigger the watcher signs and broadcasts a `pause()` tx with the guardian key (kept in a different secrets store from the warm key — ideally an HSM).

**Why deferred.** Hackathon scope accepts the manual-rotation runbook in `THREAT_MODEL.md`. The auto-pause is architecturally clean (`pauseGuardian` role + watcher loop) but not load-bearing until we have meaningful TVL. When the TVL crosses the threshold where a 5-minute manual response window is too slow, this becomes a real change doc and lands.

**Out of scope for this entry:**
- Multisig-with-timelock for the warm key (separate, larger initiative).
- Auto-unpause / auto-rotate. Recovery should stay manual; we don't want a buggy heuristic to ship rotation calls.

---

## 9. DB egress hardening (round 2)

**Why this is here.** Round 1 (item #15 in `C_USER_FEEDBACK.md`) cut the dominant egress source — the `/api/quote-preview` poll loop running `SELECT *` on the active-markets table — to a targeted lookup. The remaining offenders are smaller individually but constant. Worth a pass before the free-tier ceiling bites again.

**Items, ordered by likely impact.**

1. **HTTP-level caching for `/api/markets`, `/api/markets/categories`, `/api/admin/list`.** All three call into the DB on every request and have no `Cache-Control` / `revalidate`. The in-process cache in `lib/markets-cache.ts` is per-Lambda-instance and per-tab — cold starts and parallel users miss it. Replace `dynamic = "force-dynamic"` with `revalidate = 30` (markets) / `revalidate = 300` (admin list). One origin hit per TTL window instead of one per user-mount.
2. **Slim `getActiveMarkets()` projection.** Still returns all 21 columns. Audit each call site and either (a) shrink the SELECT to columns actually consumed, or (b) split into purpose-specific projections (`getMarketsForList`, `getMarketsForSettler`) the same way `getMarketsForBuildLegs` was carved out.
3. **Kill or back off the 10s `useRehabClaimable` poll.** `lib/hooks/vault.ts:164` runs `setInterval(refetchDemo, 10_000)` against `/api/rehab/demo-claimable`. The value only changes when the user demo-settles or claims — switch to action-driven refetch (call `refetchDemo()` from those handlers), or push the interval to 60s+. The hook is mounted on every page that renders the rehab banner, so the multiplier across users + tabs is real.
4. **`useAdminList` is mounted globally.** `TestnetBanner` lives in `ScaffoldEthAppWithProviders.tsx`, so every page hits `/api/admin/list`. React Query staleTime is 30s but every fresh tab open = a query. Combine with item #1's `revalidate = 300` and this becomes a single-digit hits/day endpoint.
5. **Audit other 5–10s pollers for action-driven alternatives.** `useTicket` (5s), `useUserTickets` (5s), `useUSDCBalance` (5s), `useVaultPosition` (10s), etc. — these hit RPC, not Postgres, so they don't show up on the DB egress bill, but the same "poll forever vs. refetch on tx confirm" question applies and they cost user-side data + RPC quota.
6. **Batch the seed/sync upsert loops.** `/api/db/init` and `/api/polymarket/sync` `await upsertMarket()` per row in a serial loop — 200+ round trips per run. Bundle into `INSERT … VALUES (...), (...), … ON CONFLICT … DO UPDATE` per batch (or use `postgres.js`'s `sql.unsafe(query, [params])` with arrays). Not the ongoing-egress story, but cuts cron runtime + connection overhead.
7. **Confirm Vercel crons fire on production only.** `vercel.json` has the `polymarket/sync` (8 AM) and `settlement/run` (8 PM) crons. Make sure they're not duplicated on preview deployments — Vercel honours cron config per-environment, but a preview branch with `vercel.json` edits can silently fire too. Five-minute dashboard check, not a code change.

**Deferred because.** Round 1 was the smoking gun (~100× cut on the hottest path). Each remaining item is single-digit-percent of that. Picking these up makes sense if the egress bill stays elevated *after* round 1 ships, or if a future expansion (more pages, more pollers, more users) re-inflates the baseline.

---

## 10. Generalize MLB game-card sync to NBA / NFL / NHL

**Current state.** `utils/parlay/polymarket/mlb.ts` ships an MLB-only fetcher built around `gamma /markets?tag_id=100381&sports_market_types=moneyline,spreads,totals` — empirically the only call that populates `sportsMarketType`, `line`, and `events[0]` for grouping. NBA, NFL, NHL still flow through the legacy `fetchSportEvents("nba"|"nfl"|"nhl")` → `gamma /events?tag_slug=…` path, where those fields come back null and the per-game card layout can't split a matchup into ML / spread / total rows.

**Why deferred.** The MLB rewrite is intentionally a proof-of-concept. We want to validate the per-game-card pattern on one sport (does the deeper-book heuristic pick the right line? does the bucket-by-event grouping hold up when a game has props in addition to ML/spread/total? does the UI feel right with three rows per game?) before committing to the same shape across four sports.

**Sketch when we pick this up.**
- Lift the MLB fetcher to `fetchSportGames(sport)` keyed off a per-sport config: `{ tagId, marketTypes, formatTitle }`. NBA = spread + total + moneyline; NFL = same; NHL = puck line + total + moneyline. Tag IDs come from `gamma /sports`.
- Per-sport `formatTitle` so spreads read as "Run Line ±X" (MLB), "Spread ±X" (NBA/NFL), "Puck Line ±X" (NHL). Totals stay "Over/Under X.X".
- Each sport may surface different non-core types (NRFI for MLB, "first to score" for NHL, anytime TD for NFL). Decide per sport whether to render those as additional rows on the game card or hide them.
- Same dedupe-priority trick: each sport's structured fetcher runs before the volume-ranked `featured` fetch so its rows win.

**Out of scope for the generalization.**
- Player props (assists, points, anytime TDs). Different shape — one market per (player × stat) instead of per game. Worth its own pass once core ML/spread/total feels right.
- Live in-game odds. Polymarket's CLOB pushes price updates over websocket; pulling those into our sync is a bigger change than the REST poll the current MLB fetcher does.

**When this picks up.** After we've watched the MLB tab in production for at least one weekend slate of games and the per-game-card layout has held up.

---

## 11. Safari-friendly onboarding (Rabby gap)

**Status:** Carried over from `C_USER_FEEDBACK.md` item #13 — sketched but not implemented in the C-sprint. Picks up when an actual Safari user driver shows up.

**Why this is on the radar.** Onboarding currently funnels new users to install Rabby. Rabby ships Chrome / Firefox / Brave / Edge extensions and a desktop app, but **no Safari extension** — Safari users hit a dead-end at install time. The funnel needs a Safari-specific branch.

**Sketch of the fix.** Detect Safari in `/_onboard` (User-Agent regex like `/^((?!chrome|android).)*safari/i`). On Safari, swap the install path to a wallet that supports it — Coinbase Wallet on iOS / macOS, MetaMask Mobile via WalletConnect, or the WalletConnect QR path itself — and rewrite the copy so we're not telling Safari users to install something that doesn't exist for them. Keep the Rabby path for everyone else.

**Why deferred.** No reported Safari user during the C-sprint. The existing copy is misleading on Safari but not blocking — the user just bounces. Worth picking up when (a) someone actually flags it, or (b) we promote the testnet build to a wider audience and Safari traffic becomes non-trivial.

---

## Priority (informal)

1. Oracle fault recovery — stuck tickets lock vault reserves indefinitely.
2. Early-resolve tickets once a leg is lost — quick win, frees reserves sooner.
3. DB egress hardening (round 2) — pick up if the egress bill stays elevated after round 1.
4. Compromised-key detection + auto-pause — picks up real urgency once TVL crosses a threshold.
5. Dynamic fee scaling — medium effort, strong DeFi mechanic.
6. Dynamic max payout — medium effort, unlocks larger tickets.
7. Jackpot pool — high effort, major feature expansion.
8. ABIs in Postgres — only when multi-dev or historical-ABI verification becomes a real need.
9. RFQ — only when real flow + a concrete maker set are in hand.
10. Generalize MLB game-card sync to NBA / NFL / NHL — wait for one MLB weekend in prod first.
11. Safari-friendly onboarding — pick up when an actual Safari user shows up.
