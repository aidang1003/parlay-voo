# B — The Slog

Carryover from `A_DAY_SCALING_SPRINT.md`. The A-DAY doc is closed; remaining unfinished work lands here. Same Time / Value / Blockers / Files / Change shape so items can be picked up directly.

## Status at branch cut

| Item | Status | Notes |
|---|---|---|
| R-1 — ABIs in Postgres | 🔲 deferred | Carried forward from A-DAY + UI/UX sprint |
| U-1 — `/vault` personal/global split | 🔲 specced | Header pill + tabs; UX decisions locked on `ui/personal-global-intro` |
| U-2 — `/tickets` personal/global split | 🔲 specced | My Tickets / Activity tabs; event-sourced feed |
| U-3 — Polymarket sync: upsert instead of rebuild | 🔲 | Preserve fast-changing fields; stop nuking the cache |
| U-4 — Show leg question text, not hash | 🔲 | `/admin/debug` + `/ticket/[id]` |
| U-5 — Per-leg multiplier in the cart | 🔲 | Builder UX |
| U-6 — Restore rocket curves on the graph | 🔲 | Visual polish |
| U-7 — Show yes/no distribution per leg in debug | 🔲 | Resolver needs to see what users actually picked |
| U-8 — Track resolved legs on debug page | 🔲 | Audit trail |
| U-9 — Hide on-chain-resolved legs from the builder | 🔲 | Stop letting users build parlays with dead legs |
| U-10 — Comma + decimal formatting on numeric inputs | 🔲 | Reduce typo risk on stake / mint amounts |

---

## R-1 — ABIs in Postgres (shared deployment registry)

- **Time:** 5–8 hours
- **Value:** Low now, medium later. Bites once we have multiple devs making frontend-only changes against a shared deploy — today everyone regenerates `deployedContracts.ts` locally and re-commits, which creates spurious diffs. A DB-backed registry also gives us history across deploys (useful for verifying old tickets against the ABI they were minted under).
- **Blockers:** None. Neon Postgres + `lib/db/client.ts` already wired.
- **Files:**
  - `scripts/generate-deployed-contracts.ts`
  - `packages/nextjs/src/lib/db/schema.sql`
  - `packages/nextjs/src/lib/db/client.ts`
  - `packages/nextjs/src/lib/hooks/useDeployedContract.ts`
- **Change:** add `tbcontractabi (name TEXT, chainid INT, deployedat TIMESTAMPTZ, address TEXT, abi JSONB, PRIMARY KEY (chainid, name, deployedat))`. Extend `generate-deployed-contracts.ts` to `INSERT` each contract alongside the file write (keep the TS file — it's the zero-latency path). Add a DB fallback in `useDeployedContract` for historical lookups (e.g. reading an old ticket's engine ABI).
- **Non-goal:** do NOT replace `deployedContracts.ts` — it's the fast path for build-time types and SSR. DB is a secondary mirror.

---

## U-1 — `/vault` personal/global split (header pill + tabs)

- **Time:** 6–10 hours
- **Value:** High. Today the vault page is a global view with personal data sprinkled in scattered cards; users can't quickly answer "how much do I have here, and how much have I earned?" without scanning. This makes the vault feel like a protocol dashboard, not a user dashboard.
- **Blockers:** None. All personal data already has hooks.
- **Decisions locked from `ui/personal-global-intro` planning:**
  - Tabs at top of `/vault`: **My Position** / **Vault Overview**. Default = My Position when connected, Vault Overview when not.
  - Header gets a compact pill (`$USDC · $vault`) between the Help button and ConnectKit. Click opens a dropdown popover with the full personal panel (same component as the My Position tab body). Pill renders nothing when disconnected.
- **Files:**
  - `packages/nextjs/src/lib/hooks/vault.ts` — new `useVaultPosition()` hook wrapping `HouseVault.balanceOf(user)` + `convertToAssets(shares)`. Currently inlined at `components/VaultDashboard.tsx:122-140`; extract for reuse.
  - `packages/nextjs/src/components/MyPositionPanel.tsx` — new component, two render modes via `variant: "pill" | "full"`. Reused by the header pill and the My Position tab body.
  - `packages/nextjs/src/components/Header.tsx:70-84` — insert pill + Tailwind-only popover (no Radix dependency) between Help and ConnectKit. Slot fits the existing `gap-2` flex; no layout shift.
  - `packages/nextjs/src/components/VaultDashboard.tsx` — add tabs at top; fold the scattered personal sections (lines 319-323, 327-376, 427-524, 527-534) into the My Position tab; keep stat row + utilization bar + mechanics under Vault Overview; right-side action panel (lines 537-833) persists across both.
- **Hooks to reuse (no new ones beyond `useVaultPosition`):**
  - `useUSDCBalance` (`lib/hooks/usdc.ts:10-30`)
  - `useLockPositions` (`lib/hooks/lock.ts:218-315`) — `userTotalLocked` + per-position breakdown
  - `useLockStats` (`lib/hooks/lock.ts:317-345`) — `pendingRewards`
  - `useCreditBalance` (`lib/hooks/vault.ts:56-73`) — lossless credit
  - `useMintTestUSDC` — already used at `VaultDashboard.tsx:102`
- **Change:** Build `useVaultPosition` + `MyPositionPanel`, mount the pill in `Header.tsx`, restructure `VaultDashboard.tsx` around the new tabs. Format USDC via `formatUSDC` from `lib/utils.ts` (project convention — never raw `formatUnits`).
- **Lifetime earnings caveat:** `LockVaultV2` only exposes `pendingRewards`. There is no lifetime/cumulative-claimed view function. The panel surfaces pending only; do not invent contract changes for a lifetime read. If a lifetime number ever becomes a hard requirement, the right path is event indexing off-chain — out of scope for this item.
- **Verification:**
  - Disconnected: `/vault` defaults to Vault Overview; My Position tab shows connect-wallet prompt; header has no pill.
  - Connect → header pill shows `$USDC · $vault`; click opens popover; numbers match the My Position tab.
  - Deposit USDC → pill + tab refresh within the 10s vault poll.
  - Lock VOO → locked $ updates; pending-rewards row appears once fees flow.
  - 768 / 1024 / 1440 widths — pill + popover don't overflow on narrow.
  - `pnpm typecheck` + `pnpm test:web` clean.

---

## U-2 — `/tickets` personal/global split (My Tickets / Activity tabs)

- **Time:** 8–12 hours (the activity feed is the time sink)
- **Value:** Medium-high. `/tickets` is currently 100% personal — there is no surface anywhere in the app for "what's happening on the protocol right now." Adding a live activity feed is also the lightest-weight social proof we can ship: users can see real volume without us having to integrate a leaderboard or analytics service.
- **Blockers:** None. ParlayEngine emits the events we need; reads via wagmi `usePublicClient().getLogs()` or `useWatchContractEvent`.
- **Decisions locked from `ui/personal-global-intro` planning:**
  - Tabs at top of `/tickets`: **My Tickets** / **Activity**. Default = My Tickets when connected, Activity when not.
  - Activity = chronological feed of all tickets across the protocol, sourced from contract events. No DB required.
  - Status filters (All / Active / Settled / Cashed Out) only apply to My Tickets — Activity is purely time-ordered.
  - Mirrors the `/vault` pattern (U-1) for visual consistency.
- **Files:**
  - `packages/nextjs/src/lib/hooks/ticket.ts` — new `useTicketActivity({ limit })` hook. Reads `TicketMinted` / `TicketSettled` / `TicketCashedOut` (or whichever events ParlayEngine actually emits — confirm at implementation time) for the most recent N tickets across all wallets. Returns `{ events, isLoading, refetch }`. Cache via React Query with a 30s `staleTime`.
  - `packages/nextjs/src/components/ActivityFeed.tsx` — new component. Renders each event as: short address (or ENS via wagmi), action verb (bought / settled / cashed out), legs touched, stake / payout, relative timestamp. Reuse the leg-description join logic from `app/tickets/page.tsx:95-106` — both feeds need the leg → question text mapping.
  - `packages/nextjs/src/app/tickets/page.tsx` — wrap the existing personal block in a `My Tickets` tab; add an `Activity` tab rendering `<ActivityFeed />`. The existing status-filter tabs (lines 159-187) move *inside* the My Tickets tab so they only apply there.
- **Hooks to reuse:**
  - `useUserTickets` (`lib/hooks/ticket.ts`) — current `/tickets` data source, untouched.
  - `useLegDescriptions` + `useLegStatuses` (used at `tickets/page.tsx:105-106`) — Activity feed rows need the same leg → question text join.
  - `mapStatus`, `parseOutcomeChoice` (`lib/utils.ts`) — reused for status badges.
- **Change:** Add the activity hook, build the feed component, restructure `tickets/page.tsx` around the new tabs. Pure read-only — no contract changes.
- **Privacy / display:** ticket buyers are already public on-chain. Render addresses as short hex (`0x1214…0389`) with ENS resolved when available (wagmi's `useEnsName`). No anonymization needed.
- **Pagination:** initial cut limits the feed to the last 100 events. If we want infinite scroll later, that's a follow-up — don't gold-plate.
- **Verification:**
  - Disconnected: `/tickets` defaults to Activity; tab shows recent events from the test deploy.
  - Connect → defaults to My Tickets; status filter tabs work as before.
  - Switch to Activity → live feed; click an event row → routes to `/ticket/[id]` (same target the personal cards already link to).
  - Buy a new ticket → it appears in Activity within ~30s without a refresh (or on next refetch).
  - 768 / 1024 / 1440 widths — feed rows don't overflow; ENS-vs-address fallback renders cleanly.
  - `pnpm typecheck` + `pnpm test:web` clean.

---

## U-3 — Polymarket sync: incremental upsert instead of cache rebuild

- **Time:** 2–3 hours
- **Value:** Medium. Today a re-sync clears `tblegmapping` and rebuilds, which (a) churns the DB, (b) loses any state that was set after first registration, and (c) re-emits `createLeg` calls for markets that already have on-chain leg IDs. Want a true upsert that only refreshes the volatile fields (odds, volume, payload, curation score) and leaves registration metadata alone.
- **Blockers:** None.
- **Files:**
  - `packages/nextjs/src/app/api/polymarket/sync/route.ts`
  - `packages/nextjs/src/lib/polymarket/markets.ts`
- **Change:** Replace the clear-and-rebuild path with `INSERT ... ON CONFLICT (txtsourceref) DO UPDATE SET` keyed on `conditionId`, refreshing only `yesProbabilityPpm`, `noProbabilityPpm`, `volume24hr`, `bigcurationscore`, `jsonbapipayload`, `cutoffTime`. Skip the `createLeg` on-chain call when the row already has a leg ID. Existing schema in `packages/nextjs/src/lib/db/schema.sql` should already support this — confirm.

---

## U-4 — Replace leg hashes with readable question text

- **Time:** 1–2 hours
- **Value:** High. Both the `/admin/debug` resolver list and the `/ticket/[id]` ticket detail render a hash/legId where the actual question should appear ("Will the Nuggets win the NBA Finals?"). The hash is meaningless to the user — the resolver can't tell what they're resolving and the ticket page reads like raw on-chain data.
- **Blockers:** None. `useLegDescriptions` already exists in `lib/hooks` and joins `legId → leg.question` from the DB.
- **Files:**
  - `packages/nextjs/src/app/admin/debug/page.tsx` — resolver row
  - `packages/nextjs/src/app/ticket/[id]/page.tsx` — leg list
- **Change:** Use `useLegDescriptions(legIds)` (already used in `app/tickets/page.tsx:105`) and render `leg.question` with a `Leg #${legId}` fallback when the join misses. Keep the hash visible only on hover (tooltip) so on-chain provenance is still discoverable.

---

## U-5 — Per-leg multiplier in the cart

- **Time:** ~1 hour
- **Value:** Medium. Builder UX — user can see what each leg contributes to the combined multiplier, so trimming the cart feels intentional instead of guesswork.
- **Blockers:** None. Math is already in `packages/shared/src/math.ts`; legs in the cart already carry `probabilityPPM`.
- **Files:**
  - `packages/nextjs/src/components/ParlayBuilder.tsx` — cart row
- **Change:** For each leg in the cart, render its implied multiplier `PPM / probabilityPPM` next to the question text. Compute via the shared math util — do NOT divide inline.

---

## U-6 — Restore rocket curves on the multiplier graph

- **Time:** 1–2 hours
- **Value:** Low (visual polish), but the user explicitly flagged it. The rocket on the multiplier-climb chart used to have curved flight path styling from the original `parlaycity` repo; it's now flat/straight and looks cheaper.
- **Blockers:** None. The original styling is in `parlaycity` git history.
- **Files:**
  - Multiplier graph component (search `components/` for `Rocket` / `Multiplier` chart files; not yet identified by path).
- **Change:** Restore the curved SVG path / animation. If the original was a Bezier path or a CSS keyframe with a curved transform, port it as-is. No behavioral change.

---

## U-7 — Show yes/no distribution per leg on the debug resolver

- **Time:** 3–4 hours
- **Value:** High. Right now the resolver picks YES / NO / VOID for a leg without surfacing what the existing ticket holders actually chose. With multiple users on opposite sides of the same leg the wrong choice silently kills one cohort. Want to see "12 YES / 4 NO" before clicking.
- **Blockers:** Needs an aggregation read across all active tickets — same surface as the U-2 activity feed, but grouped by leg.
- **Files:**
  - `packages/nextjs/src/app/admin/debug/page.tsx` — per-leg row
  - Possibly new `packages/nextjs/src/app/api/admin/leg-positions/route.ts` if the aggregation is expensive enough to want a server-side cache.
- **Change:** For each unresolved leg, count tickets whose `outcomes[i]` for that `legId` is YES vs NO. Render counts + summed stake in the resolver row. Pure read-only — no contract change.

---

## U-8 — Track already-resolved legs on the debug page

- **Time:** 1–2 hours
- **Value:** Medium. Audit trail — currently the debug page only lists legs needing resolution; once resolved they vanish. Want a history strip below so we can confirm what got resolved when, and re-check the outcome we picked.
- **Blockers:** None. Oracle-side resolution status is already readable per leg.
- **Files:**
  - `packages/nextjs/src/app/admin/debug/page.tsx`
- **Change:** Add a "Recently resolved" section listing legs with `oracleResult.resolved == true`, sorted by resolution timestamp DESC, capped at the last ~20. Show question + chosen outcome + resolver address (deployer key). Read-only; no re-resolve button (legs are immutable once resolved).

---

## U-9 — Hide on-chain-resolved legs from the parlay builder

- **Time:** 1–2 hours
- **Value:** High. Today the builder lets a user add a leg that's already been resolved on-chain, then the buy reverts at signature time. Should be filtered out at the source.
- **Blockers:** None. Leg resolution status is already on `LegRegistry.getLeg(legId).status` and surfaced via `useLegStatuses`.
- **Files:**
  - `packages/nextjs/src/app/api/markets/route.ts` — preferred filter site (server, single source)
  - or `packages/nextjs/src/components/ParlayBuilder.tsx` — fallback if the API can't easily join on-chain status
- **Change:** Drop legs whose on-chain status is `resolved` from the builder's available pool. Existing tickets carrying that leg are unaffected (snapshot at buy time).

---

## U-10 — Comma + decimal formatting on numeric inputs

- **Time:** 2–3 hours
- **Value:** Medium. Stakes / mint amounts up to 100K MockUSDC are easy to mistype as 1M when there's no thousands separator. Want a formatted display ("$1,234.56") next to or in the input so the user can sanity-check before signing.
- **Blockers:** None. `formatUSDC` from `lib/utils.ts` already handles locale formatting.
- **Files:**
  - `packages/nextjs/src/components/VaultDashboard.tsx` — deposit / withdraw / lock inputs
  - `packages/nextjs/src/components/ParlayBuilder.tsx` — stake input
  - `packages/nextjs/src/app/admin/debug/page.tsx` — mint slider/input
- **Change:** Either (a) keep the input raw-numeric but render a formatted shadow below ("= $1,234.56") for confirmation, or (b) format on blur and parse on focus. Option (a) is the safer cut — no input parser footguns. Reuse `formatUSDC(x, { locale: true })`.

---

## Subsumed / superseded

- *USDC balance in the header* — subsumed by **U-1**'s header pill (which also shows vault $ value). No separate item needed.

---

### Change log

- U-1: added `useVaultPosition` hook in `lib/hooks/vault.ts`
- U-1: new `MyPositionPanel.tsx` (pill + full variants) and `HeaderPositionPill.tsx`
- U-1: header now mounts `<HeaderPositionPill>` between Help and ConnectKit
- U-1: `VaultDashboard.tsx` restructured with My Position / Vault Overview tabs; lock positions and pending-rewards moved into the My Position branch; vault stats stay under Overview (replaced "Your Position" stat card with "Reserved")
- U-1: `VaultDashboard.test.tsx` mocks `useVaultPosition` and asserts the new "Reserved" stat label
- U-2: added `useTicketActivity` hook in `lib/hooks/ticket.ts` reading `TicketPurchased` / `TicketSettled` / `EarlyCashout` events from block 0; resolves block timestamps batched and clipped at `limit`
- U-2: new `ActivityFeed.tsx` renders rows with short address (or ENS via `useEnsName` against mainnet), action verb, ticket id, stake/payout, relative timestamp; rows route to `/ticket/[id]`
- U-2: `/tickets/page.tsx` wraps existing personal block in My Tickets / Activity tabs; default view = My Tickets when connected, Activity otherwise; status-filter tabs scoped to My Tickets only