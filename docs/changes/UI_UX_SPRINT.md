# UI/UX Sprint — Spec

Branch: `ui-ux-improvemnts-1`

Covers all pending R-series items from `A_DAY_SCALING_SPRINT.md`. Ordered by dependency and effort: quick bug-fixes first, then data infra, then market-display features.

---

## Status at branch cut

| Item | Status |
|------|--------|
| R-2 — Drop `poly:` prefix | ✅ COMPLETE |
| R-5 — Debug banner + mint + leg resolver | ✅ COMPLETE (shipped as F-6) |
| R-6 — Wallet disconnect after ticket purchase | 🔲 |
| R-7 — Scroll trap on short screens | 🔲 |
| R-8 — Lossless parlay toggle misaligned | 🔲 |
| R-3 — Store raw Gamma payloads in JSONB | 🔲 |
| R-4 — Curation score (rank by volume + balance) | 🔲 (blocked on R-3) |
| R-4b — Sport categories + group by game | 🔲 (follows R-4) |
| R-1 — ABIs in Postgres | 🔲 deferred (low priority) |

---

## R-6 — Wallet disconnect after ticket purchase

**Problem:** After buying a ticket and navigating to `/tickets`, the app loses wallet state (address/connector), but Rabby still reports connected — so Rabby blocks re-connection and the user is stuck.

**Root cause to investigate:** wagmi `useAccount` losing its connector reference across a client-side navigation. Likely a `ConnectKit`/wagmi `reconnect` not being called, or a React context being unmounted during navigation.

**Files:**
- `packages/nextjs/src/app/tickets/page.tsx`
- `packages/nextjs/src/app/ticket/[id]/page.tsx`
- `packages/nextjs/src/lib/wagmi.ts`
- `packages/nextjs/src/components/ScaffoldEthAppWithProviders.tsx` (or equivalent root provider)

**Change:**
1. Reproduce: buy ticket on testnet → navigate to `/tickets` → observe wallet state.
2. Check if `reconnect()` from wagmi is being called at app root on mount. If not, add it.
3. Check if any component unmounts the wagmi/ConnectKit provider tree during navigation.
4. Verify fix: wallet persists through `/tickets` navigation; Rabby re-connect not blocked.

**Tests:** Manual only (wallet integration). Add a `// @bug R-6` comment at the fix site.

---

## R-7 — Scroll trap on short screens

**Problem:** On viewports where the parlay builder legs list is long, the user must scroll to the bottom of the markets list before the bet-placement panel becomes reachable. The intent is: hovering over the bet-placement panel should allow independent scrolling of that container.

**Files:**
- `packages/nextjs/src/app/page.tsx`
- `packages/nextjs/src/components/ParlayBuilder.tsx` (or equivalent layout component)

**Change:**
1. Identify the flex/grid layout that positions `[markets list]` + `[bet panel]` side-by-side (or stacked on mobile).
2. Give the markets list `overflow-y: auto` with a `max-h` bound (e.g. `max-h-[calc(100vh-Xrem)]`) so it scrolls independently.
3. Give the bet panel its own scroll context if it can also overflow (`overflow-y: auto`, fixed height).
4. Test at `768px`, `900px`, and `1200px` viewport heights.

**Tests:** Manual at multiple viewport sizes.

---

## R-8 — Lossless parlay toggle misaligned

**Problem:** The lossless parlay toggle switch is not vertically centered within its container.

**Files:**
- `packages/nextjs/src/components/ParlayBuilder.tsx` (or whichever component renders the lossless toggle)

**Change:** Find the toggle wrapper element. Add `items-center` (Tailwind) or `align-items: center` to its flex parent. Confirm visually at default and large font sizes.

**Tests:** Visual only.

---

## R-3 — Store raw Gamma payloads in JSONB

**Time estimate:** 6–10 hours.

**Why first (before R-4):** R-4's curation score needs `volume24hr` from the Gamma payload. Without R-3, R-4 has to re-parse inline — doable but messier.

**Files:**
- `packages/nextjs/src/lib/db/schema.sql`
- `packages/nextjs/src/app/api/polymarket/sync/route.ts`
- `packages/nextjs/src/lib/db/client.ts`
- `packages/shared/src/polymarket/featured.ts`

**Change:**
1. Add column `jsonbapipayload JSONB` to `tblegmapping` in `schema.sql`.
2. Add GIN index: `CREATE INDEX IF NOT EXISTS idx_tblegmapping_payload ON tblegmapping USING GIN (jsonbapipayload jsonb_path_ops);`
3. In the sync route, capture the full Gamma event object and write it alongside the existing scalar columns (`yesProbabilityPpm`, `noProbabilityPpm`, `cutoffTime`). Keep the scalars — they are the hot-path read.
4. Migration: `packages/nextjs/src/lib/db/migrations/2026-04-20-add-gamma-payload.sql` — `ALTER TABLE tblegmapping ADD COLUMN IF NOT EXISTS jsonbapipayload JSONB;` + the GIN index. Also expose via `/api/db/init` (drop-and-recreate path picks it up from `schema.sql` automatically).

**Invariant:** scalars always populated; JSONB may be NULL for rows written before this migration.

**Watch:** ~1–3 KB per row. Fine at 50 markets, check at 10k+.

---

## R-4 — Curation score (rank markets by volume + balance)

**Time estimate:** 4–6 hours. **Depends on R-3.**

**Why it matters:** Markets currently render in Polymarket sync order (effectively random). Surfacing high-volume, near-coinflip markets improves builder UX and keeps edge math away from the 1–99% clamp.

**Files:**
- `packages/shared/src/polymarket/types.ts`
- `packages/nextjs/src/lib/db/schema.sql`
- `packages/nextjs/src/app/api/polymarket/sync/route.ts`
- `packages/nextjs/src/lib/polymarket/markets.ts`
- `packages/shared/src/polymarket/featured.ts`

**Change:**
1. Parse `volume24hr` (string → number) from the Gamma payload during sync.
2. Add `bigcurationscore BIGINT` to `tblegmapping`.
3. Compute at sync time: `score = floor(volume * 1e3) - abs(ppm - 500_000)`. Volume dominates; balance penalty caps at 500k (~$500 volume). Tune after first real data pass.
4. Change `getActiveMarkets()` `ORDER BY` from `txtsourceref` to `bigcurationscore DESC, volume24hr DESC`.
5. Add `curationScore?: number` to `CuratedMarket` type.
6. All curated bets use category `"featured"` — no UI change needed; builder renders in array order.

**Migration:** `ALTER TABLE tblegmapping ADD COLUMN IF NOT EXISTS bigcurationscore BIGINT;` in a new migration file alongside R-3's.

---

## R-4b — Sport categories + group by game

**Depends on R-4** (needs curation infra wired first so categories layer cleanly on top).

**Goal:** Replace the flat market list with tabs/sections per major sport (NBA, NFL, MLB, NHL). Within each sport, markets are grouped by game (e.g. "Lakers vs Warriors — Game 5"). No grouping for markets that don't map to a game.

**Files:**
- `packages/nextjs/src/lib/polymarket/markets.ts`
- `packages/nextjs/src/app/api/markets/route.ts`
- `packages/nextjs/src/components/ParlayBuilder.tsx`
- `packages/shared/src/polymarket/types.ts`
- `packages/nextjs/src/lib/db/schema.sql` (potentially — `txtcategory`, `txtgamegroup`)

**Change:**
1. **Category detection:** during sync, parse the Gamma event `tags` or `title` to assign a category (`NBA | NFL | MLB | NHL | featured`). Store as `txtcategory TEXT` on `tblegmapping`. Default `"featured"` for unclassified.
2. **Game grouping:** parse the event title or a structured field to extract a game key (e.g. `"LAL-GSW-2026-04-22"`). Store as `txtgamegroup TEXT`. NULL if not a game market.
3. **API:** update `getActiveMarkets()` to return `category` and `gameGroup` fields on `CuratedMarket`.
4. **UI:** add sport tabs to the parlay builder. Within each tab, render markets in `gameGroup` clusters with a game header row. Markets without a `gameGroup` render ungrouped at the end of the list.

**Open questions:**
- Best heuristic for category detection: regex on title vs. Polymarket `tags` array (needs R-3 for reliable tag access).
- Whether to group `featured` tab or leave it flat.

---

## R-1 — ABIs in Postgres (deferred)

Low priority. Not planned for this sprint. See `A_DAY_SCALING_SPRINT.md` for full spec.

---

## Execution order

```
R-6 → R-7 → R-8          # Bug fixes first (fast wins, unblocks manual QA)
R-3                        # Data infra
R-4                        # Curation score (requires R-3)
R-4b                       # Categories + game grouping (requires R-4)
R-1                        # Deferred
```

## Gate

`pnpm gate` (test + typecheck + build) green before PR. Manual wallet QA for R-6. Manual viewport QA for R-7.

## Change log

- 2026-04-20: created (`UI_UX_SPRINT.md`)
