# C-Sprint · User Feedback

The first sprint after putting the testnet build in front of real users. Where A-Day was about making the app feel fast and B-Slog was about making the math right, this one is about removing the rough edges that show up when someone who *isn't on the team* opens the app and clicks around. Each item starts as a piece of feedback, not a feature spec — the doc is organized that way too.

## Status

Two items already shipped on this branch (the original admin-gate work that named the branch `feedback/admin-wallet`). Eleven new items came out of round-1 user feedback and are queued for the rest of the sprint. Items 3 and 4 — the leg-resolver redesign — are the load-bearing ones; the rest are visible polish.

| # | Item | Status |
| --- | --- | --- |
| 1 | Admin wallet gate (debug + admin routes) | **shipped** (commit `23c30a3`) |
| 2 | Database flexibility (Supabase ↔ Neon) + dropping `jsonbapipayload` | **shipped** (commit `1760345`) |
| 3 | Ticket-native demo resolver (any wallet) | **shipped** (commits `449c53b`, `<demo-flow>`) |
| 4 | Per-user demo overrides for leg resolution | **shipped** (commits `449c53b`, `<demo-flow>`) |
| 5 | Hide legs whose payout is below the entrance fee | **shipped** (commit `2944c6d`) |
| 6 | Specialize MLB tab around the CLOB MLB endpoint | **shipped** (commits `1ebf758`, `cfab447`, this commit) |
| 7 | Display event start time on legs | **shipped** (commits `6d76f64`, `6833042`) |
| 8 | Clarify which side YES vs NO commits the user to | **shipped** (commit `2c36fc1`) |
| 9 | De-duplicate question text in the Yes/No box | **shipped** (commits `f3c5967`, `92b6689`) |
| 10 | Click-through from question header to Polymarket | **shipped** (commit `9bf391a`) |
| 11 | Truth-up About + (probably retire) Agents page | **shipped** (commit `e2dc26d`) |
| 12 | Vault page nuanced corrections | **shipped** (commit `b7cef14`) |
| 13 | Safari-friendly onboarding (Rabby gap) | deferred — moved to `BACKLOG.md` |
| 14 | Hide ended-game markets from the builder | **shipped** (commit `6833042`) |
| 15 | DB egress fix — slim quote-build query + idle stale clock | **shipped** (commit `<this round>`) |
| 16 | Demo flow extension: rehab credit on demo-Lost (lossless path) | **shipped** (this commit) |

---

## Part 1 — Human Spec

### 1. Admin wallet gate (debug + admin routes) — *shipped*

**Why this exists.** `/debug` (auto-generated contract debugger) and `/admin/debug` (mint MockUSDC, run DB init / Polymarket sync, manually resolve legs) were reachable by any wallet on testnet. The `WARM_DEPLOYER_PRIVATE_KEY` signer is the on-chain choke point for resolutions — so an outside wallet *clicking* the YES/NO/VOID button doesn't change the outcome by itself — but the route still spends the deployer's gas, the UI implies privilege the visitor doesn't have, and the broader admin surface (DB init, settlement trigger) shouldn't even be visible to a casual user. The fix is a wallet-address allow-list that gates the UI before the route is rendered.

**Where the allowlist lives.** Database table `tbadminwallet`. The first iteration used `NEXT_PUBLIC_ADMIN_ADDRESSES` — replaced because the list shouldn't require a redeploy to change, and a per-row note + audit-style "added by" column makes the source of truth easier to reason about than a comma-separated env string. The list is rarely-changing, so a DB read is cheap; React Query caches the result in-tab.

What landed:

- **`tbadminwallet` table** — `txtaddress` (PK, regex-checked `^0x[0-9a-f]{40}$`), `txtnote`, `txtaddedby`, `tscreatedat`. Schema lives in `lib/db/admin-schema.ts`, intentionally separate from `lib/db/schema.ts` so admin-table init and market-table init can run independently.
- **Two-source seed list** in `admin-schema.ts`. `hardcodedAdminAddresses` is the committed-to-repo list; the optional `USER_WALLET_ADDRESS` env var appends one more address at init time so a contributor can seed their own wallet without committing it. The two are concatenated, lowercased, deduped via `Set`, and exported as `INITIAL_ADMIN_ADDRESSES`.
- **`pnpm db:init-admins`** — standalone `tsx`-driven script (`scripts/init-admins.ts`) that runs `initAdmins(sql())` against `DATABASE_URL`. Idempotent. Inserts every entry in `INITIAL_ADMIN_ADDRESSES`; `ON CONFLICT DO NOTHING` makes re-runs safe and means removing an address from the source array does NOT delete it from the DB — the seed list is a "floor", not the truth.
- **Self-contained init route** — `/api/db/init-admins` mirrors the script for the deployed env (and a one-click "Init table" button on the admin page), so spinning up a fresh DB doesn't require shell access.
- **`useIsAdmin()` + `useAdminList()` hooks** — fetch `/api/admin/list` via React Query (30s `staleTime`); compare `useAccount().address` case-insensitively. Returns `{ isAdmin, isLoading, unconfigured }`. **Empty table ⇒ gate falls open** for any connected wallet — so a fresh DB doesn't lock everyone out before the first seed.
- **`AdminGate` component + `app/admin/layout.tsx`** — wraps every `/admin/*` page; shows a small spinner while the list loads, a "Not authorized" panel for non-admins, a "Connect" prompt for disconnected wallets.
- **`/debug` page** — same gate, same UX, since the auto-generated contract debugger is just as privileged as the rest.
- **TestnetBanner** — keeps the testnet pill for everyone, hides the "Open debug page" link unless the connected wallet is an admin. Casual users see the testnet warning but no path into admin tooling.
- **Admin Wallets section in `/admin/debug`** — lists current admins, accepts `address + note` for adds, has a per-row remove button, and an "Init table" shortcut. Mutations go through cron-gated `/api/db/admins` via the `/api/admin/admins` proxy.

**What's intentionally not in this iteration.** The server mutation routes (`/api/db/admins`, `/api/admin/init-admins`, `/api/admin/db-init`, `/api/admin/sync`, `/api/admin/resolve-leg`, `/api/settlement/trigger`) all rely on the chain-guard + the existing CRON_SECRET-attaching proxy for privilege. A real server-side admin gate (SIWE signature, signed nonce header proving the caller controls a current admin wallet) is a follow-up — flagged in the AI spec sheet so it doesn't get lost. The current gate is UX-grade, not a security boundary.

**What the user sees.**
- Admin wallet connected → unchanged. Banner link visible, `/debug` and `/admin/*` render normally.
- Non-admin wallet connected → testnet banner has no debug link; visiting `/debug` or `/admin/*` directly shows a courteous block screen with a Disconnect button.
- No wallet → block screen with the connect button.
- Empty `tbadminwallet` (e.g. fresh DB or local Anvil that never ran the init) → any connected wallet passes; the admin page shows a yellow notice that the gate is currently open.

### 2. Database flexibility (Supabase ↔ Neon) + dropping `jsonbapipayload` — *shipped*

**Why this exists.** Storing the raw Polymarket Gamma payload in `tblegmapping.jsonbapipayload` was carrying its weight at the time we shipped curation scoring (A-Day), but the column has had no readers since then. With the Supabase free-tier storage cap blowing past, the JSONB column was the largest single item we owned — and the only way to keep paying $0 was either drop the column or move providers. We did both: drop the dead data, and make the swap one env-var away.

What landed:

- **Provider-agnostic Postgres client.** Same `postgres.js` driver works for Supabase and Neon. `lib/db/client.ts` now sniffs `DATABASE_URL` for `*.supabase.*`, `*.neon.tech`, port `6543`, or a `-pooler` host segment, and disables prepared statements for any pgBouncer-fronted endpoint. Direct Neon endpoints get prepared statements back on (free perf). Logs the detected provider on first connect for sanity.
- **`jsonbapipayload` removed.** Gone from `MarketRow`, `UpsertMarketInput`, `coerceMarketRow`, the INSERT, and the `ON CONFLICT` clause. The `apiPayload` field on `CuratedMarket` and the `buildApiPayload()` helper in `utils/parlay/polymarket/featured.ts` went with it.
- **Idempotent migration.** `lib/db/schema.ts` now emits `DROP INDEX IF EXISTS ixlegmapping_payload` and `ALTER TABLE … DROP COLUMN IF EXISTS jsonbapipayload`. Hitting `/api/db/init` with the existing Supabase `DATABASE_URL` removes the column from a live DB; a `VACUUM FULL tblegmapping` afterward reclaims the disk.
- **`.env.example` documents both providers** with the URL shapes (Supabase pooler on 6543, Neon pooled endpoint with the `-pooler` host suffix).

**What this unlocks.** Free-tier headroom on both providers: switching to Neon is now a one-line env edit; staying on Supabase costs less because the largest column is gone. Either way the app code doesn't know which one is live.

### 3. Ticket-native demo resolver (any wallet) — *planned*

**Why this exists.** Leg resolution today sits behind the admin gate from item #1, and the surface is a debug-page-style grid of YES / NO / VOID buttons per leg. That UI was fine when the only consumer was the team flipping outcomes for testing — it's the wrong shape for users. Per-leg controls leak the protocol's plumbing (legs, sides, void semantics) into a flow that should be about a single ticket's outcome, and the only useful demo question for a regular user is "what does winning this ticket feel like?" / "what does losing feel like?". Combined with the per-user deviation model (#4), there's no reason to keep this gated, debug-styled, or per-leg.

**Sketch of the fix.** The resolver becomes a first-class part of the ticket flow, not a utility tab:

- **Lives on `/ticket/{id}`.** The detail page already shows the legs, status pills, and payout — add a small "Simulate outcome" panel inline (likely below the leg list, above the settle / claim section). No new top-level route, no `/legs` tab, no admin-debug carve-out.
- **Two buttons only: `Mark as WIN` and `Mark as LOSS`.** No YES / NO / VOID per leg. The user is telling us what they want the *ticket* to do; the server figures out which leg-level deviations make that happen.
- **Third button: `Reset demo outcome`.** Clears the deviations for this ticket's legs (scoped to the caller's wallet). Visible only when at least one leg of this ticket has an active deviation.
- **Expansion rule (server-side).** For each leg in the ticket, look up the side the user bet on (`YES` or `NO` per leg). `WIN` ⇒ deviate every leg to that bound side. `LOSS` ⇒ deviate every leg to the opposite side. Symmetric, easy to clear, and every leg lights up green or red so the visual feedback is decisive. (Alternative considered: flip only one leg for LOSS — closer to how a real parlay loses, but less dramatic and harder to explain in the UI; reject for now.)
- **Demo-state labelling.** Wherever a leg is showing a deviation, render a small "demo" badge alongside the resolved status pill so the user (and any screenshot viewer) can tell the simulated outcome apart from a real chain resolution.
- **Optional surface on `/tickets`.** Each row could grow a small overflow menu with "Simulate WIN / LOSS / Reset" so users don't have to drill into the detail page. Defer if it crowds the row; the detail page is the canonical place.

**Relationship to the existing admin per-leg resolver.** The raw per-leg YES / NO / VOID grid stays where it is — `/admin/debug`, behind `<AdminGate>`, calling the on-chain `/api/admin/resolve-leg` route. That's the path the cron and manual recovery still need. The new ticket-page panel is *additive*: it doesn't touch on-chain state, it isn't gated, and it doesn't expose leg-level controls.

**Round-2 extension: end-to-end Settle / Claim.** The leg-only deviation flipped each leg's display but left the ticket header stuck on "Active", so the SettledClimb visualization, payout panel, and Claim button never fired — exactly the visual gap that came up in user feedback ("resolving to won didn't show me the corresponding payout graph and proper multiple"). The deviation now extends through the ticket's lifecycle so Settle and Claim work in demo mode too.

- *Demo Settle.* Clicking Settle while any leg is deviated routes to `/api/tickets/[id]/demo-settle`. The route reads the chain ticket + each leg's snapshot probability + the caller's deviation rows, then runs the same algorithm as `ParlayEngine.settleTicket` against the layered statuses (chain truth wins per leg; deviation falls through where chain is still Unresolved). The result — `Won` / `Lost` / `Voided` plus the recomputed payout and multiplier — is upserted into a new `tbticketdeviation` row keyed by `(wallet, ticketId)`. Pure off-chain mirror; the on-chain ticket stays Active.
- *Demo Claim.* When the ticket renders as a deviation-Won, Claim routes to `/api/tickets/[id]/demo-claim`. The server calls `MockUSDC.mint(wallet, payout)` once with `HOT_SIGNER_PRIVATE_KEY` (MockUSDC's `mint` is permissionless and capped at 10M USDC per call — well above any realistic ticket payout). Mints free MockUSDC equal to the demo payout, flips the row to `Claimed`. The real pool/contract state is untouched, so when the chain later resolves the ticket for real, the existing on-chain Settle / Claim path keeps working unchanged.
- *Read-time layering.* `/ticket/[id]/page.tsx` overrides `ticket.status` and `ticket.payout` with the deviation row whenever (a) the chain ticket is still Active and (b) at least one leg is still pre-resolution on-chain. Both predicates failing means the chain has caught up — the deviation is suppressed (lazy GC), and the user re-Settles + re-Claims for real.
- *Two-pass interaction.* Mark as WIN/LOSS → Settle (demo) → Claim (demo). After the cron / manual resolver lands → Settle (chain) → Claim (chain). Same buttons, same visual, the demo just runs first against a deviated state.
- *Tradeoff documented.* When the chain later resolves the ticket to a real Win, the user can claim against the real pool too — collecting twice. Acceptable on testnet (MockUSDC is free) and intentional: keeps the real claim path untouched so it stays "the same code as production".

### 4. Per-user demo overrides for leg resolution — *planned, biggest item*

**Why this exists.** Today, "resolve a leg" signs a transaction through `WARM_DEPLOYER_PRIVATE_KEY` against `AdminOracleAdapter`. So one user clicking YES on a leg moves the state for *every* ticket in the system. That's wrong for the demo experience — we want a visiting user's UI to immediately reflect the outcome they chose so they can walk through the full win/loss flow without waiting for a real game, but their click shouldn't cascade into other users' tickets, the cron, or the on-chain settler. The cron-driven Polymarket resolver should remain the only source of truth for chain state. Any UI deviation has to be local, scoped to one wallet, and short-lived (real resolution eventually catches up).

**Sketch of the fix.** New table `tbuserlegdeviation` keyed by `(txtwallet, txtsourceref)` storing an outcome (`YES` / `NO` / `VOIDED`) and a timestamp. The user-facing API is **ticket-scoped**, not per-leg — `POST /api/tickets/{id}/demo-resolve` with `{ outcome: "WIN" | "LOSS" }`. The server reads the ticket's legs and bound sides, expands the intent into per-leg deviation writes (WIN ⇒ each leg deviates to its bound side; LOSS ⇒ each leg deviates to the opposite), and upserts rows scoped to the caller's wallet. `DELETE` on the same route clears the ticket's deviations. Per-leg writes never leave the server — clients only see ticket-level intents (#3). Read-time: every UI surface that reads a leg's status (parlay slip, ticket detail, ticket list, builder) layers the user's deviation row over the on-chain status before rendering. The on-chain `LegRegistry.resolved()` keeps the same value — only the *display* changes.

**Chain truth wins on resolution.** As soon as the chain resolves a leg (`LegRegistry.resolved()` returns non-Unresolved), the deviation for that leg is suppressed at read time — period. Two cases collapse into one rule:

- *Deviation matched reality.* User saw a YES demo, leg actually resolved YES — display doesn't change, ticket processes normally.
- *Deviation contradicted reality.* User saw a YES demo, leg actually resolved NO — the demo outcome falls away, the real outcome takes over, and the ticket processes normally against chain truth.

Either way the user lands in the real flow. No conflict warnings, no manual clear step, no "your demo disagrees with reality" notice — agreement is invisible, disagreement is just the demo expiring into truth. Implementation note: this falls out of the read-time layering for free (`if chainStatus !== Unresolved return chainStatus, else maybe-return deviation`); deviation rows can be garbage-collected lazily, since they're already invisible once the chain resolves.

**Important boundary.** A deviation cannot pay out a real ticket. Settlement still calls on-chain `settleTicket`, which reads chain truth. The deviation only changes what the user *sees*; if they actually hold a ticket on that leg, the cash hits their wallet only when the chain resolves their way. We make this distinction visible by labelling deviated legs with a "demo" badge (#3) until chain truth catches up.

**Decisions.**
- *Live tickets included.* Deviations apply to legs on tickets the user already holds — that's the whole demo point ("show me what winning this would feel like"). The demo badge keeps it honest.
- *Chain wins on resolution.* As soon as a leg resolves on-chain, the deviation is suppressed at read time, agreement or disagreement. See the dedicated paragraph above.
- *Pricing untouched.* Deviations don't reach `computeQuote` — pricing is global and computed pre-buy, before any wallet has a deviation to apply.

### 5. Hide legs whose payout is below the entrance fee — *planned*

**Why this exists.** At very high leg probabilities (>~99%) the implied multiplier approaches 1. After the per-leg fee (`baseFee + perLegFee × numLegs`), the user pays more than they could ever take home — the leg is dead money. The builder still surfaces these because the curation score doesn't model fees. Showing a leg you can't profit on is a UX trap, and once a user notices the trap once it erodes trust in the rest of the list.

**Sketch of the fix.** Add a payout-vs-fee check to the curation pipeline: skip any leg whose single-leg payout (at min stake) doesn't clear the marginal entrance fee. The fee model is already accessible via `ParlayEngine` config; do the math at sync time so the row gets dropped before it lands in the UI, or at render time so it tracks live fee config — pick based on how often the fee schedule actually moves (almost never, so sync time is fine).

### 6. Specialize MLB tab around the CLOB MLB endpoint — *shipped*

**Why this exists.** The MLB tab currently renders the same generic question cards as every other sport, sourced via Gamma. Polymarket's CLOB endpoint exposes richer per-market data (order book, fills, cleaner pricing) and MLB has a tightly defined per-game market set (moneyline, spread, total, run line, props) that maps well to a structured layout. Building one specialized tab as a proof-of-concept lets us see whether the CLOB-fed structured-by-game approach is worth doing for NBA / NFL too.

**What landed (round 1).** Commit `1ebf758` shipped the MLB game-card *layout* (one glass card per matchup, header with first-pitch time, market count). The layout was correct but the inputs feeding it weren't: the sync still pulled MLB through `fetchSportEvents("mlb")` → `gamma /events?tag_slug=mlb`, which returns markets whose `sportsMarketType` and `line` come back null. Result: the card rendered but couldn't be split into the canonical ML / spread / total rows.

**What landed (round 2 — this commit).** Replaced the MLB sync path with a dedicated `fetchMlbGames()` that hits `gamma /markets?tag_id=100381&sports_market_types=moneyline,spreads,totals` directly — empirically confirmed to be the only call that populates `sportsMarketType`, `line`, and `events[0]` on the response. New file `utils/parlay/polymarket/mlb.ts` groups markets by parent event id (Polymarket leaves `gameId` null on MLB rows today, so `events[0].id` is the canonical key), then for each game picks one market per type — when multiple lines exist (Polymarket lists O/U 7.5 and 8.5 simultaneously on the same matchup) the deeper book by `volume24hr` wins. Display titles are normalized: `Moneyline`, `Run Line ±X.X`, `Over/Under X.X`. Outcome labels carry through as team names (ML/spread) or `Over`/`Under` (totals) so the YES/NO buttons render meaningful copy. The sync route runs MLB first so structured rows win the dedupe over any incidental MLB markets surfacing through the volume-ranked `featured` fetch.

**Why MLB-only for now.** Intentionally scoped to MLB so we can validate the per-game-card pattern on one sport before generalizing. NBA/NFL/NHL still flow through the legacy `fetchSportEvents` path. Generalization tracked in `docs/changes/BACKLOG.md`.

**What landed (round 3 — this commit).** Hardening + UX polish from the first MLB run with users.

*Gamma data fixes.*
- `sports_market_types` had been comma-joined in the URL — gamma silently returned 0 rows because the comma was treated as a single literal value. Switched to repeated keys (`sports_market_types=moneyline&sports_market_types=spreads&sports_market_types=totals`).
- `endDateIso` (date-only) was being read from gamma when `endDate` (full timestamp) was available. For spread/total markets endDate = first pitch, so the date-only form truncated to midnight UTC of game day and flagged the cutoff as past hours before first pitch. `normalizeMarket` in `lib/polymarket/client.ts` now prefers `endDate` over `endDateIso`.

*Cutoff / earliestResolve override mechanism.*
- New `cutoffOverride` and `earliestResolveOverride` fields on `CuratedMarket`. mlb.ts emits both per game so the chain invariant `earliestResolve >= cutoff` (enforced by `LegRegistry`) holds. Settled at `cutoff = gameStart + 6h`, `earliestResolve = cutoff + 48h = gameStart + 54h`. Sync route prefers the overrides over `metadata.endDateIso`; the legacy `+1h "cutoff too soon"` buffer is gone — only rejects when cutoff is literally in the past.
- `bigearliestresolve` added to the `ON CONFLICT` update clause in `upsertMarket`. Previously preserved as registration metadata, but updating cutoff while preserving an out-of-sync earliestResolve was leaving rows in a state where the chain rejected with `LegRegistry: resolve before cutoff` on the first buy of any new sourceRef. Both fields now move together so the invariant always holds.

*Per-game uniqueness + ordering.*
- `gameGroup` now includes the game date (`"Athletics vs. Baltimore Orioles (5/9)"`) so a same-matchup series across days lands as separate cards. Driven by Polymarket reusing identical `event.title` strings for back-to-back games.
- `groupedByGame` sorts by earliest event start so today's games appear before tomorrow's; games with no start time sink to the end.

*Dedup within a game.*
- mlb.ts collapses same-`|line|` candidates to one. Polymarket sometimes lists the same wager from both perspectives (`Spread: Orioles -1.5` AND `Spread: Athletics -1.5`); the candidate with the lowest min outcome price (= highest underdog multiplier) wins. Multi-line wagers (O/U 7.5 vs. 8.5) still pick by `volume24hr`.
- Same-game ML+spread blocking via new `selectionConflicts(a, b)` helper. Mets ML YES + Mets -1.5 YES (redundant), Mets ML NO + Mets -1.5 YES (impossible), Diamondbacks ML YES + Diamondbacks +1.5 NO (redundant) all blocked. Mets ML YES + Diamondbacks +1.5 YES (fringe overlap = "fav wins by 1") allowed. `legGate` refactored to per-side gating so one side can be blocked while the other stays selectable. The existing same-game `correlationGroupId` discount still applies to the fringe-allowed pairs.

*Sports-only filters.*
- `isMlbMarketUsable` introduced in mlb.ts as a separate function from `featured.ts`'s `isUsable` so MLB skips the bid/ask spread cap. Most moneylines on day-ahead games sit at 10–20¢ spreads while the price snapshot is fine; the original 10¢ cap was dropping ~67% of moneylines and chunks of spread/total markets. The CLOB book is re-checked at quote time, so empty-book markets fail there with a real error instead of silently disappearing pre-sync.
- `isPostGameSettled` filter in `fetchMarketsFromDb`: hides rows whose price has clamped to `10000`/`990000` AND `eventStart + 4h < now`. Catches Polymarket's lingering-after-game-ends window where the 1% certain-loser side reads as a 100x phantom multiplier (vault arb risk). Pure odds-only filter would have caught legitimate pre-game heavy favorites, so we gate on eventStart-in-past as well.

*UI polish.*
- LIVE badge moved from NBA pill to MLB pill. Per-game LIVE badge inline with the date suffix when `eventStart < now < expiresAt`.
- Sports YES/NO buttons widened (`w-24` → `w-36`); label/odds bumped to `text-[13px]`.
- Wager type (`Moneyline` / `Run Line ±X.X` / `Over/Under X.X`) renders as the leg-card middle label (was `View on Polymarket`). Linked to Polymarket with `hover:text-brand-pink`. The redundant uppercase bucket `<h3>` above each sports leg is hidden — the middle label carries it.
- Polymarket click-through duplicated in three places per market (matchup title, leg-card middle wager, bet-slip row). Underline removed on the matchup-title and wager links — color-only hover for affordance, per design.
- Category pills: only `Featured` + `MLB` show by default; everything else hides behind a plaintext `+ show more` toggle. The active category surfaces inline if it's in the hidden set (so a returning user with an `nfl`-saved sessionStorage selection doesn't see an empty active state).

*Diagnostics for cutoff / quote reverts.*
- `buildLegs` logs each leg's resolution (`sourceRef`, `cutoffDeltaSec`, `priceSource`) to stdout and throws `LegBuildError(409)` on past cutoffs with the offending timestamps in the error message — clear toast instead of opaque on-chain revert.
- `buyTicket` runs `simulateContract` before `writeContract` so the chain's actual revert string surfaces in the error toast instead of "Transaction reverted on-chain". Pre-flight log dumps the signed quote (cutoffs in delta-seconds) to the browser console. Post-receipt revert (rare, e.g. block-level race) replays the call to extract the reason.
- Sync route logs every per-leg skip with category + reason so silently-dropped sync entries are visible in `vercel logs`.

### 7. Display event start time on legs — *shipped*

**Why this exists.** We show `bigcutofftime` (when the leg becomes ineligible) but never the actual game / event start. "When is this game?" is a basic prediction-market UX expectation, and without it users have to flip to Polymarket to find the time and come back.

**What landed (round 1).** New `bigeventstart` (BIGINT, unix seconds) on `tblegmapping`, a shared `formatEventStart` helper in `lib/utils.ts` that turns the timestamp into "live" / "starts in Nm" / "starts in Nh" / "starts Mon 7:00pm", and the chip rendered in four surfaces:
- Builder leg card — chip in the badge row next to category + Odds-locked.
- MLB game card header — start time alongside the matchup.
- Selected legs in the parlay slip — secondary line under the question.
- Ticket detail / list — secondary line on each unresolved leg in `TicketCard`.

`useLegDescriptions` was rewired from `fetchQuestionMapCached` to `fetchSourceRefMap` so `LegInfo.eventStart` flows through to ticket pages without a second network hop. `bigcutofftime` and `bigearliestresolve` stay where they are.

**What landed (round 2 — commit `6833042`).** First-pass ingest read `event.startDate` from Gamma, which is the *market deployment* timestamp, not the game time. Result: every active market resolved to "live" because the deploy date was always in the past. Diagnosed against the live API — the actual first-pitch / tip-off lives on `mkt.gameStartTime` (per-market, format `"YYYY-MM-DD HH:MM:SS+00"`), absent for season-long markets. Fix:
- `featured.ts`: declared `GammaMarket.gameStartTime`, new `parseGameStartTime` normalizer (space → T, short offset → `+HH:MM`), preference order `mkt.gameStartTime ?? event.startDate`.
- MLB game-card header now embeds the date inline: `Matchup - 5/9/2026 5:15 PM` (locale-formatted, suffix in muted weight). Right-side start chip removed — redundant once the title carries the time. Non-MLB game headers also get the suffix in muted text.

**Schema management.** Per `AGENTS.md` the init script wipes-and-rebuilds every pass. `lib/db/schema.ts` now `DROP TABLE IF EXISTS … CASCADE`s every non-admin table at the top, then `CREATE TABLE IF NOT EXISTS` (idempotent against partial replays) with all columns defined inline — no `ALTER TABLE … ADD COLUMN` migrations. `tbadminwallet` is owned by `lib/db/admin-schema.ts` and is never touched by `/api/db/init`.

### 8. Clarify which side YES vs NO commits the user to — *shipped*

**Why this exists.** Some Polymarket questions are phrased ambiguously enough that "YES" and "NO" don't communicate which side the user is taking. "Will the Lakers win game 3?" — clear. "Lakers vs. Celtics — first to 100" — what does YES mean? The current UI only shows the question text + YES / NO buttons, leaving the user to infer.

**What landed (commit `2c36fc1`).** The leg-card YES/NO buttons surface the resolved outcome string from the Polymarket payload's `outcomes` array — e.g. `YES = Lakers`, `NO = Celtics` — as small subtext under the button label. When the payload only carries default `Yes` / `No`, the slot stays empty so the layout doesn't shift between markets. `yesOutcome` / `noOutcome` fields plumbed through `CuratedMarket → MarketRow → Leg → DisplayLeg`. Item #6 round 2 later replaced this YES/NO + subtext layout with a sportsbook-style single label for sports markets, and #9 round 2 layered in the wager-type framing on top.

### 9. De-duplicate question text in the Yes/No box — *shipped*

**Why this exists.** The current bet box shows the question both as the card title and inside the YES / NO box body. Same string twice, ~20px apart. It looks like a bug, even when it isn't. A second wrinkle surfaced once the MLB rewrite shipped: sports markets and political markets are framed differently and the YES/NO copy needs to know which mode it's in.

**What landed (round 1 — commit `f3c5967`).** When a market has a single leg whose description equals the market title, the per-market `h3` above the card is suppressed and the leg's own description carries the question. The badge row (category, Odds-locked, event-start chip) stays so the slot keeps its context. Multi-leg markets are unchanged — the `h3` still groups the legs. Outcome labels from #8 fill in additional disambiguation per side.

**What landed (round 2 — sports market-type context).** Polymarket frames sports as *wagers* (moneyline, run line, over-under) and politics / crypto / news as *questions* with literal Yes/No. The MLB sync (item #6 round 2) already pulls the discriminator — `sportsMarketType` — but until now we discarded it after building the bucket header. Round 2 persists it and lets the YES/NO box render like a real sportsbook.

- **Schema.** `tblegmapping` gets `txtmarkettype TEXT` (`"moneyline" | "spreads" | "totals"` for MLB rows; null for political / crypto / news / seed) and `intline INTEGER` (the spread / total line scaled ×10 so half-points fit the existing `int` prefix convention — `-1.5 → -15`, `8.5 → 85`). On conflict, both columns are *not* COALESCE-pinned: a re-sync that picks a different best-line (e.g. volume migrates from O/U 7.5 to 8.5) overwrites the stored value, since the new line is the one we want to render.
- **Plumbing.** `marketType` and `line` (raw, unscaled) flow through `CuratedMarket → upsertMarket → MarketRow → Leg → /api/markets → DisplayLeg`. `mlb.ts` populates them; the legacy `fetchSportEvents` and `fetchFeaturedMarkets` paths leave them undefined.
- **UI.** The leg-card YES/NO box branches on `marketType`:
  - `moneyline` → button shows the team name (`Padres` / `Mariners`).
  - `spreads` → button shows team + signed line (`Padres -1.5` / `Cardinals +1.5`); the NO side flips the sign automatically.
  - `totals` → button shows `Over X.X` / `Under X.X`.
  - undefined (political / crypto / news / seed) → keeps the literal `Yes` / `No` layout with the existing optional outcome subtext. Round 1's de-dupe rule still applies.
- **Center body.** For sports markets, the duplicated matchup question collapses into a small `View on Polymarket →` link — the gameGroup header above already names the matchup, the buttons name the wager, so the body has no remaining job. Political markets keep the original click-through-on-the-question-text layout.
- **Selected-legs summary.** The right-rail slip's `YES` / `NO` chip swaps to the sports side label when present (`Padres -1.5` instead of `YES`), so a glance at the slip tells you what wager you actually built.
- **Out of scope for this round.** Generalizing to NBA / NFL / NHL — those still flow through the legacy `/events` path which doesn't populate `sportsMarketType`. They follow when item #6 generalizes (BACKLOG.md item 9). Until then, the `marketType`-aware copy gracefully falls back to the existing Yes/No because non-MLB rows ship `marketType === null`.

### 10. Click-through from question header to Polymarket — *shipped*

**Why this exists.** A user who wants to dig into a market — read comments, see the order book, validate the odds — can't get there from our UI. They have to open Polymarket and search by title. A direct link removes that friction and is also a small honesty signal: we're not hiding where the data comes from.

**What landed (commit `9bf391a`).** New nullable `txtpolymarketslug` TEXT column on `tblegmapping`, populated from `GammaEvent.slug` at sync. `COALESCE` on update so a missing slug doesn't wipe an existing one. The slug threads through `CuratedMarket → upsertMarket → MarketRow → Leg → /api/markets → ParlayBuilder DisplayLeg`. The leg description renders as an anchor when a slug (or conditionId-shaped sourceRef) is available, opening `https://polymarket.com/event/<slug>` in a new tab with `noopener noreferrer`. Click handler `stopPropagation`'s so the YES/NO buttons keep working. Falls back to `/market/<conditionid>` for legacy rows missing a slug. Seed markets stay unlinked.

### 11. Truth-up About + (probably retire) Agents page — *shipped*

**Why this exists.** About and Agents were written for an earlier project narrative. Agents in particular reads as if there are autonomous on-chain agents driving market discovery (BallDontLie, NBA games) and a separate Settler bot — neither matches today. Markets come from Polymarket via Gamma; the settler is a Vercel cron in `/api/settlement/run`; "Market Discovery Agent" is gone. The Agents page mostly reflects the deployer wallet's basescan stats with an "agent" label, which is worse than not having the page at all.

**What landed (commit `e2dc26d`).** `/agents` deleted along with its only consumer `/api/agent-stats`; the nav link is gone from `Header`. The useful bits (builder-code attribution, ParlayEngine + LegRegistry Basescan links, deployer wallet) moved to a "Behind the Scenes" subsection on `/about`. The `/about` page itself was rewritten: the AI Risk Analysis section + 0G Network branding came out (we don't run 0G inference); a new "Agent API" section reframes around the x402 quote endpoint that actually ships; the Vault System stats now read "≥7 days" with a 1× → 4× boost curve (was the stale 30/60/90d / 1.5x); the "0G AI Inference" trust card is replaced with "JIT Quote Signer" to match what the architecture actually does.

### 12. Vault page nuanced corrections — *shipped*

**Why this exists.** Vault page had rough edges that surface during a walkthrough rather than from a single piece of feedback. The one concrete miss flagged: the "Vault VOO" headline tile only counted liquid (unlocked) shares — locked VOO was visible only in the per-tier breakdown below.

**What landed (commit `b7cef14`).** `MyPositionPanel.tsx`'s "Vault VOO" tile now renders the total of liquid + every lock tier (`userShares + fullShares + partialShares + leastShares`). Tooltip rewritten to "Total VOO held across liquid + all lock tiers; the breakdown is in Lock Hierarchy below." Lock Hierarchy section keeps the per-tier numbers and stays the canonical place to inspect what's locked where. Alternative considered (rename tile to "Liquid Vault VOO") was rejected — the headline is what a returning LP looks at first to answer "what do I have here?", and "total" is the more useful answer.

**Closing this item.** No further vault-page corrections surfaced during the sprint review. The placeholder for "more corrections as we walk the page together" gets folded back into general polish — anything new that surfaces lands as its own ticket / change doc rather than another round here.

### 13. Safari-friendly onboarding (Rabby gap) — *deferred to BACKLOG*

Not implemented this sprint. Sketch (Safari-detection branch in `/_onboard`, swap to Coinbase Wallet / WalletConnect path) preserved in `docs/changes/BACKLOG.md` so we can pick it up once it has a concrete user driving it.

### 14. Hide ended-game markets from the builder — *shipped*

**Why this exists.** Polymarket flips a market's `closed` flag once the game ends, but Polymarket's UMA finalization can take hours-to-days afterwards. During that window the conditionId is still in our DB and the row still says `blnactive = true`, so the builder kept offering the leg as bettable for ended games (e.g. `mlb-hou-cin-2026-05-08` after the game finished). The intended hiding mechanism — "settler resolves on-chain → `useLegStatuses` flags `resolved` → `liveLegs` filter drops it" — only works for legs that already have a positive on-chain `legId`. JIT-quote markets that nobody bought yet never get registered, so the chain path never fires, and dead markets lingered.

**Why we don't reuse `blnactive`.** The settler's `getUnresolvedPolymarketLegs()` filters on `blnactive = true` so it can find closed-but-not-yet-relayed markets and write the resolution on-chain for tickets that already exist. Flipping `blnactive` on game-end would silently break settlement for those tickets. Two responsibilities, two flags.

**What landed.**
- New column `blnpolyclosed BOOLEAN NOT NULL DEFAULT false` on `tblegmapping`.
- Sync route: when `metadata.closed || metadata.archived` returns true from Gamma, `markPolyClosed(conditionId)` flips the flag instead of throwing (was: `throw new Error("market closed/archived")` → caught → `result.skipped++`). Sync result now reports `{ upserted, skipped, closed, errors }`.
- `getActiveMarkets` and `getRegisteredActiveMarkets` (builder-facing reads) add `AND blnpolyclosed = false`.
- `getUnresolvedPolymarketLegs` (settler) intentionally does **not** filter on the new column — closed rows still get picked up so the on-chain resolution flows for ticket holders.

**Net effect.** Game-ended markets disappear from the builder on the next cron tick (or manual `/api/polymarket/sync` hit). Tickets people already hold continue to settle normally because the row sticks around for the settler. No new UI affordance; per the design discussion we just hide the market rather than add a "pending settlement" badge.

### 15. DB egress fix — slim quote-build query + idle stale clock — *shipped*

**Why this exists.** Supabase + Neon free-tier egress kept blowing through (~20GB/mo against a 25MB DB). Tracing the hot paths surfaced two compounding issues, both in the quote-preview poll loop. `/api/quote-preview` runs `buildLegs(...)`, which called `getActiveMarkets()` on every invocation — `SELECT *` over the full active set (all 21 columns × ~100–300 rows) just to look up the 2–5 `sourceRef`s the user actually has in their cart. That route is polled every 30s by `ParlayBuilder` whenever ≥2 legs are selected, so an idle tab with a cart open burned ~150KB × 120 polls/hr ≈ 18MB/hour of pure DB→function egress. Multiply by a few testers leaving tabs open and 20GB/mo falls out of the math.

**What landed.**

- **Targeted SQL projection.** New `getMarketsForBuildLegs(refs[])` in `lib/db/client.ts` does `SELECT <8 columns> FROM tblegmapping WHERE txtsourceref IN (...) AND blnactive AND NOT blnpolyclosed`. Returns only the columns `buildLegs` actually reads (`txtsourceref`, `txtsource`, `txtquestion`, `intyesprobppm`, `intnoprobppm`, `bigcutofftime`, `bigearliestresolve`, `bigeventstart`). Cutoff filtering is intentionally **not** applied here — `buildLegs` needs the row so it can render the "cutoff in past" 409 with the offending timestamp.
- **`buildLegs` rewired.** `lib/quote/build-legs.ts` now calls `getMarketsForBuildLegs(uniqueRefs)` instead of `getActiveMarkets()`. The `bySourceRef` map shrinks from "every active market" to "the cart's legs". Same map shape, same error semantics — an inactive / closed leg returns nothing and the existing "unknown leg" path fires unchanged.
- **10-minute idle stale clock on the builder poll.** `ParlayBuilder.tsx` records `startedAt` inside the polling effect; the `setInterval` callback short-circuits and `clearInterval`s itself once `Date.now() - startedAt > 10 * 60 * 1000`. Any cart change re-runs the effect via the existing `selectedLegsKey` dep, so adding/removing a leg or flipping yes/no resets the window. A page refresh resets it too. After 10 minutes of cart inactivity, polling halts — the displayed prices freeze at whatever the last poll fetched. Quote-sign re-prices on submit anyway, so a stale display is harmless: worst case the user sees the wrong odds for ~1s before the signed quote returns the truth.

**Egress impact.** Per-poll payload drops from ~150KB to ~1KB — roughly **a 100× cut on the hot path**. Idle tabs that previously polled forever now stop after 10 minutes. The drop-and-rebuild on init was never the egress source — schema bytes are negligible — so it's untouched.

**What's intentionally not in this iteration.** No "prices paused" UI badge. The user accepted the worst-case stale-until-quote-sign tradeoff, and surfacing it visually is easy to add later without refactoring. Other pollers identified during the audit (`useRehabClaimable` 10s, `useAdminList` global mount, `/api/markets` uncached, etc.) are sized smaller than the quote-preview path and are queued in `BACKLOG.md` under "DB egress hardening (round 2)".

### 16. Demo flow extension: rehab credit on demo-Lost (lossless path) — *shipped*

**Why this exists.** Round 2 of #3/#4 made the demo Settle / Claim flow work end-to-end for a Won ticket — the deviation row gets minted as MockUSDC equal to the payout. The Lost path, though, dead-ended on the RehabCTA: a demo-Lost ticket never accrued anything to the user's chain `rehabClaimable[user]`, so the "Unclaimed losses" tile read `$0` and the "Claim & Lock Loss" button was disabled. Asymmetric and confusing — the user just lived through a simulated loss but the lossless rehab UX they'd see after a real loss didn't fire.

**What landed.**

- **Schema additions on `tbticketdeviation`.**
  - `bigstake NUMERIC(78,0)` — original ticket stake in USDC base units. Populated by `demo-settle` from the chain ticket so the rehab path can sum stakes across Lost rows without re-reading the chain.
  - `blnrehabclaimed BOOLEAN NOT NULL DEFAULT false` — gate per row. Lost rows contribute to the demo rehab claimable until this flips true; matches the chain's "claimed → zero out" lifecycle.
  - Re-settling resets `blnrehabclaimed` so a Lost → Won → Lost toggle correctly re-adds to claimable instead of carrying a stale claimed flag.

- **Two new helpers in `lib/db/client.ts`.**
  - `getDemoRehabClaimable(wallet)` — `SUM(bigstake) WHERE txtstatus = 'Lost' AND blnrehabclaimed = false`.
  - `markDemoRehabClaimed(wallet)` — flip the gate on every contributing row in one update. Returns the pre-clear total + row count for the response.

- **Two new endpoints under `/api/rehab`.**
  - `GET /api/rehab/demo-claimable?wallet=…` — returns `{ claimable: "<base units>" }`. Hit by the hook below.
  - `POST /api/rehab/demo-claim` — reads the wallet's demo claimable, mints `claimable * projectedAprBps / BPS` of MockUSDC to the user (mirrors the chain `claimRehab` math via `projectedAprBps` read off `HouseVault`, falls back to 600 bps if the read fails), then `markDemoRehabClaimed`. Reuses the same `MOCK_USDC_ABI.mint` + `HOT_SIGNER_PRIVATE_KEY` path as `tickets/[id]/demo-claim` so there's one minting deviation pattern, not two.

- **`useRehabClaimable` extended** to fetch the demo amount alongside the chain reads. Returns `chainClaimable`, `demoClaimable`, and a combined `claimable = sum`. Polls demo every 10s. The two pots stay separately addressable so the rehab page can route the claim button to the right backend.

- **`/rehab/claim` page** runs claim paths sequentially: chain `claimRehab(duration)` first when `chainClaimable > 0`, then `/api/rehab/demo-claim` when `demoClaimable > 0`. Footnote under the button reads "Includes $X from demo losses — credit will be minted as MockUSDC" when demo is non-zero. CTA disabled state covers both pending paths.

**Tradeoffs accepted.** When the chain later resolves the same ticket as a real Lost, the chain accrues its own `rehabClaimable[user]` independently — we don't subtract the demo amount and don't try to "balance the books". User keeps the phantom MockUSDC and can also claim against the real pot. Acceptable on testnet (MockUSDC is free) and intentional: matches the same "user can claim twice" pattern from the original demo-claim path. Faithful to the user's stated preference — "I don't really care if these excess funds stay there" — and avoids an entire class of reconciliation logic.

---

## Part 2 — AI Spec Sheet

### Files touched

- **New**
  - `docs/changes/C_USER_FEEDBACK.md` — this doc.
  - `packages/nextjs/app/admin/layout.tsx` — gate wrapper for `/admin/*`.
  - `packages/nextjs/components/AdminGate.tsx` — block-screen + spinner wrapper used by both layout and `/debug`.
  - `packages/nextjs/lib/db/admin-schema.ts` — `ADMIN_SCHEMA_SQL`, `INITIAL_ADMIN_ADDRESSES` (= `hardcodedAdminAddresses` ∪ `[USER_WALLET_ADDRESS]`, lowercased + deduped), `initAdmins(sql)`. Independent of `SCHEMA_SQL`.
  - `packages/nextjs/scripts/init-admins.ts` — standalone seeder run via `pnpm db:init-admins`.
  - `packages/nextjs/app/api/admin/list/route.ts` — public testnet GET returning lowercased addresses for the gate.
  - `packages/nextjs/app/api/db/admins/route.ts` — cron-gated GET / POST / DELETE on `tbadminwallet`.
  - `packages/nextjs/app/api/admin/admins/route.ts` — browser proxy that attaches `CRON_SECRET`; forwards POST + DELETE bodies.
  - `packages/nextjs/app/api/db/init-admins/route.ts` — cron-gated `initAdmins(sql())` runner.
  - `packages/nextjs/app/api/admin/init-admins/route.ts` — proxy.
- **Edit**
  - `packages/nextjs/lib/db/client.ts` — added `AdminRow`, `listAdmins`, `addAdmin`, `removeAdmin`, `normalizeAddress`.
  - `packages/nextjs/lib/hooks/debug.ts` — `useAdminList()` + new `useIsAdmin()` returning `{ isAdmin, isLoading, unconfigured }`.
  - `packages/nextjs/app/debug/page.tsx` — wraps content in `<AdminGate>`.
  - `packages/nextjs/app/admin/debug/page.tsx` — added `AdminWalletsSection` (list / add / remove / init).
  - `packages/nextjs/components/TestnetBanner.tsx` — destructures `{ isAdmin }` from new hook; copy varies by admin status.
  - `packages/nextjs/components/__tests__/TestnetBanner.test.tsx` — mock the new hook return shape.
  - `packages/nextjs/package.json` — `tsx` devDep + `db:init-admins` script.
  - `package.json` (root) — `db:init-admins` forwards into the nextjs package.
  - `.env.example` — removed `NEXT_PUBLIC_ADMIN_ADDRESSES`; pointed to `admin-schema.ts` + the pnpm script.

### New schema

```sql
CREATE TABLE tbadminwallet (
  txtaddress    TEXT PRIMARY KEY CHECK (txtaddress ~ '^0x[0-9a-f]{40}$'),
  txtnote       TEXT,
  txtaddedby    TEXT,
  tscreatedat   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Env vars

- `USER_WALLET_ADDRESS` (optional, server-side) — appended to `hardcodedAdminAddresses` before dedup. Lets a contributor seed their own wallet without committing it. Read once at module load in `admin-schema.ts`; only consumed by `pnpm db:init-admins` and `/api/db/init-admins`. Not `NEXT_PUBLIC_*` — never exposed to the client.

### Hook contract

```ts
export interface AdminStatus { isAdmin: boolean; isLoading: boolean; unconfigured: boolean }
export function useIsAdmin(): AdminStatus;
export function useAdminList(): UseQueryResult<string[]>; // lowercased 0x addresses
```

Behavior matrix:

| Table state          | Wallet connected? | Address in list? | `isAdmin` | `unconfigured` |
| -------------------- | ----------------- | ---------------- | --------- | -------------- |
| (loading)            | n/a               | n/a              | `false`   | `false`        |
| empty                | yes               | n/a              | `true`    | `true`         |
| empty                | no                | n/a              | `false`   | `true`         |
| non-empty            | yes               | yes              | `true`    | `false`        |
| non-empty            | yes               | no               | `false`   | `false`        |
| non-empty            | no                | n/a              | `false`   | `false`        |

### API surface

| Route                          | Method        | Auth                              | Purpose |
| ------------------------------ | ------------- | --------------------------------- | ------- |
| `/api/admin/list`              | GET           | testnet-only chain guard          | public read for `useIsAdmin()` |
| `/api/db/admins`               | GET / POST / DELETE | `CRON_SECRET` bearer        | CRUD on `tbadminwallet` |
| `/api/admin/admins`            | POST / DELETE | testnet + proxies CRON_SECRET     | browser-callable mutation |
| `/api/db/init-admins`          | GET           | `CRON_SECRET` bearer              | runs `initAdmins(sql)` |
| `/api/admin/init-admins`       | POST          | testnet + proxies CRON_SECRET     | one-click re-init from UI |

### Gate placement

| Route               | Gate mechanism                                  |
| ------------------- | ----------------------------------------------- |
| `/debug`            | wrap page content in `<AdminGate>`              |
| `/admin/debug`      | covered by `/admin/layout.tsx` (`<AdminGate>`)  |
| `/admin/tickets`    | covered by `/admin/layout.tsx`                  |
| API: `/api/admin/*` | unchanged (chain guard + on-chain key)          |
| `TestnetBanner`     | hide "Open debug page" link when `!isAdmin`     |

### Pnpm scripts

- `pnpm db:init-admins` (root) → `pnpm --filter @se-2/nextjs db:init-admins` → `tsx --env-file=.env.local scripts/init-admins.ts`. Uses Node's built-in env-file loader so the script picks up the symlinked root `.env`.

### Out of scope (follow-ups)

- Server-side admin auth (SIWE / signed-nonce header) for `/api/db/admins`, `/api/admin/*`, and `/api/settlement/trigger`. The CRON_SECRET-attaching proxy + chain guard + deployer-keyed on-chain action remain the only real privilege checks today; documented as a known limitation, not a fix.
- Surface the admin allowlist on-chain (a Roles contract) so the DB doesn't carry that responsibility long-term.
- Rate-limit the proxy admin routes when called from a non-admin wallet on a deployed env (currently any anon hit spends a Vercel invocation).
- Confirm-dialog when removing the last admin or removing your own row.

### DB changes recap (already shipped before this doc)

- `lib/db/schema.ts`: removed `jsonbapipayload` column + GIN index from `CREATE TABLE`; added idempotent `DROP INDEX IF EXISTS ixlegmapping_payload;` and `ALTER TABLE tblegmapping DROP COLUMN IF EXISTS jsonbapipayload;`.
- `lib/db/client.ts`: removed field from `MarketRow`, `coerceMarketRow`, `UpsertMarketInput`; pruned column from INSERT + `ON CONFLICT`. Added `detectProvider(url)` returning `{ provider, pooled }`; sets `prepare: !pooled` and logs detected provider.
- `utils/parlay/polymarket/types.ts`: dropped `apiPayload?: unknown` from `CuratedMarket`.
- `utils/parlay/polymarket/featured.ts`: removed `apiPayload` from result objects + deleted `buildApiPayload()` helper.
- `app/api/polymarket/sync/route.ts`: removed `apiPayload` from the `upsertMarket` call.
- `.env.example`: documented both Supabase pooler and Neon pooler URL formats.

### Invariants preserved

- `useIsTestnet()` still gates the *banner itself* and the admin pages' chain check; `useIsAdmin()` is layered on top, not a replacement.
- `assertTestnetOnly()` server-side chain guard untouched.
- `WARM_DEPLOYER_PRIVATE_KEY`-signed `AdminOracleAdapter.resolve()` remains the only path to an on-chain resolution. No client wallet ever signs `resolve()` directly.
- Empty `tbadminwallet` keeps Anvil + burner-wallet local dev working with zero config.
- `/api/db/init` (markets) and `/api/db/init-admins` (admin allowlist) are independent — running one never touches the other.
- Seed list is a floor, not a ceiling. Re-running `pnpm db:init-admins` after removing a row from `hardcodedAdminAddresses` (or after changing `USER_WALLET_ADDRESS`) won't delete the dropped address from the DB — only `removeAdmin()` (UI or DELETE route) does that.
- Settler reads (`getUnresolvedPolymarketLegs`) deliberately filter on `blnactive` only — never on `blnpolyclosed`. Game-ended markets stay reachable so on-chain resolution flows for ticket holders even after the row drops out of the builder. Builder reads (`getActiveMarkets`, `getRegisteredActiveMarkets`) filter on both.

---

### Planned-items implementation hints (#3–#13)

Light-touch reference for the items still ahead. Concrete schemas only where direction is settled (#4 deviation table, new `tblegmapping` columns for #7 and #10). Everything else stays in Part 1 narrative until the spec lands.

**New tables (items #3 + #4).** Composite primary keys, all-lowercase identifiers per the schema convention.

```sql
-- Per-leg display override.
CREATE TABLE tbuserlegdeviation (
  txtwallet      TEXT NOT NULL CHECK (txtwallet ~ '^0x[0-9a-f]{40}$'),
  txtsourceref   TEXT NOT NULL,
  txtoutcome     TEXT NOT NULL CHECK (txtoutcome IN ('YES', 'NO', 'VOIDED')),
  tscreatedat    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (txtwallet, txtsourceref)
);
CREATE INDEX IF NOT EXISTS ixuserlegdeviation_wallet ON tbuserlegdeviation (txtwallet);

-- Off-chain mirror of the ticket lifecycle (round-2 extension). Written by
-- /api/tickets/[id]/demo-settle, promoted to Claimed by /api/tickets/[id]/demo-claim.
-- NUMERIC(78,0) holds a uint256 ticketId / USDC base-unit payout without loss.
CREATE TABLE tbticketdeviation (
  txtwallet         TEXT NOT NULL CHECK (txtwallet ~ '^0x[0-9a-f]{40}$'),
  bigticketid       NUMERIC(78,0) NOT NULL,
  txtstatus         TEXT NOT NULL CHECK (txtstatus IN ('Won', 'Lost', 'Voided', 'Claimed')),
  bigpayout         NUMERIC(78,0) NOT NULL DEFAULT 0,
  bigmultiplierx1e6 NUMERIC(78,0) NOT NULL DEFAULT 1000000,
  txtclaimtxhash    TEXT,
  tssettledat       TIMESTAMPTZ NOT NULL DEFAULT now(),
  tsclaimedat       TIMESTAMPTZ,
  PRIMARY KEY (txtwallet, bigticketid)
);
CREATE INDEX IF NOT EXISTS ixticketdeviation_wallet ON tbticketdeviation (txtwallet);
```

**Columns on `tblegmapping` (post round-2).**

| Column | Type | For item | Notes |
| --- | --- | --- | --- |
| `bigeventstart` | BIGINT | #7 | Unix seconds. Sync prefers `mkt.gameStartTime` (real game time) and falls back to `event.startDate` only when absent. Nullable. |
| `txtpolymarketslug` | TEXT | #10 | Nullable; falls back to `/market/{conditionid}` when absent. |
| `txtyesoutcome` / `txtnooutcome` | TEXT | #8 | Outcome labels (e.g. "Lakers" / "Celtics"). Null when the upstream label is the default Yes/No. |
| `blnpolyclosed` | BOOLEAN | #14 | Hides game-ended markets from the builder. Sync flips this when Gamma reports `closed \|\| archived`. Settler intentionally ignores it so resolution still flows on-chain. |

No `ALTER TABLE` migrations. Per `AGENTS.md` the init script wipes-and-rebuilds, so all columns live inline in `CREATE TABLE IF NOT EXISTS tblegmapping`. Drops at the top of `SCHEMA_SQL`; `tbadminwallet` is owned by `lib/db/admin-schema.ts` and is never touched by `/api/db/init`.

**Likely API surface for the new items.**

| Route | Method | Auth | Item | Purpose |
| --- | --- | --- | --- | --- |
| `/api/tickets/[id]/demo-resolve` | POST | none (any wallet, write keyed to caller) | #3 + #4 | upsert leg deviations for every leg of this ticket; body `{ wallet, outcome: "WIN" \| "LOSS" }` |
| `/api/tickets/[id]/demo-resolve` | DELETE | none | #3 + #4 | clear the caller's deviations for every leg of this ticket and the matching `tbticketdeviation` row |
| `/api/tickets/[id]/demo-settle` | POST | none | #3 + #4 ext | mirror of `ParlayEngine.settleTicket` against (chain ⊕ deviation) leg statuses; writes `tbticketdeviation` |
| `/api/tickets/[id]/demo-claim` | POST | none | #3 + #4 ext | requires deviation row in `Won`; calls `MockUSDC.mint(wallet, payout)` once via `HOT_SIGNER_PRIVATE_KEY`; flips row to `Claimed` |
| `/api/legs/deviations` | GET | none | #3 + #4 | returns `{ deviations, tickets }` — leg-level + ticket-level overrides for read-time layering |
| `/api/polymarket/clob-mlb` | GET | cron | #6 | new sync path; mirrors `polymarket/sync` shape but reads CLOB |

The raw per-leg POST is intentionally absent — leg-level writes are an internal-only fan-out from the ticket route, never exposed to the client.

**Settle math (TS).** `lib/parlayMath.ts` was unnecessary — `packages/nextjs/utils/parlay/math.ts` already exposes `computeMultiplier` + `computePayout` as a bit-for-bit port of `ParlayMath.sol` (math-parity invariant). The demo-settle route imports those directly so the void-recompute path produces the same payout the chain would.

**Read-time layering rule (extended).**

```
ticketStatus = (onChainTicket.status !== Active)               // chain settled/won/lost/voided/claimed
             ? mapStatus(onChainTicket.status)
             : (allLegsChainResolved                            // chain caught up — let the user
                  ? "Active"                                    // settle for real
                  : (ticketDeviationRow?.status ?? "Active"))   // demo state in effect
```

`allLegsChainResolved = legs.every(l => l.resolved && !l.demo)`. When `ticketStatus` came from the deviation row, also override `ticket.payout` with `bigpayout` from the row.

**Demo-mode handler routing (TicketCard).** TicketCard accepts optional `onSettle` / `onClaim` overrides plus matching `isSettling` / `isClaiming` flags. The page wires them whenever:

| Button | Demo handler used when |
| --- | --- |
| Settle  | `chainActive && legs.some(l => l.demo)` — at least one leg is currently deviated |
| Claim   | `useTicketDeviation && ticketDeviation.status === "Won"` — the rendered Won status came from the deviation layer |

`demoActive` prop on TicketCard surfaces a small "demo" chip next to the status pill whenever either condition holds.

**Files most likely to move.**

- `lib/db/schema.ts`, `lib/db/client.ts` — tables + columns above.
- `app/api/tickets/[id]/demo-resolve/route.ts`, `app/api/tickets/[id]/demo-settle/route.ts` (new), `app/api/tickets/[id]/demo-claim/route.ts` (new), `app/api/legs/deviations/route.ts` — items #3 + #4 (and the round-2 extension).
- `app/ticket/[id]/page.tsx` — embed the WIN / LOSS / Reset panel + ticket-level deviation layering + demo Settle/Claim handlers.
- `components/TicketCard.tsx` — accept optional `onSettle` / `onClaim` overrides + `demoActive` chip.
- `lib/hooks/deviations.ts` — `useUserLegDeviations` returns both leg + ticket maps.
- `app/admin/debug/page.tsx` — left alone; existing per-leg admin grid is the cron / recovery path and stays gated.
- `components/parlay/*` (bet box / question header) — items #5, #7, #8, #9, #10.
- `utils/parlay/polymarket/*` — items #6, #7, #10 sync changes.
- `app/agents/page.tsx` — delete (item #11). `app/about/page.tsx` — edit.
- `app/_onboard/*` — item #13 Safari branch.
- `app/vault/*` — item #12, scope TBD.

**Out-of-scope (still).** Server-side admin auth (SIWE / signed-nonce header) for `/api/db/admins` etc. — already flagged under the shipped section's "Out of scope". Untouched by this round.

---

### Item #15 — DB egress fix (shipped)

**Files touched.**
- `packages/nextjs/lib/db/client.ts` — added `BuildLegRow` type + `getMarketsForBuildLegs(refs)`.
- `packages/nextjs/lib/quote/build-legs.ts` — swapped `getActiveMarkets()` → `getMarketsForBuildLegs(uniqueRefs)`.
- `packages/nextjs/components/ParlayBuilder.tsx` — 10-min idle stale clock around the 30s `quote-preview` `setInterval`.

**New function signature.**
```ts
export interface BuildLegRow {
  txtsourceref: string;
  txtsource: LegSource;
  txtquestion: string;
  intyesprobppm: number;
  intnoprobppm: number | null;
  bigcutofftime: number;
  bigearliestresolve: number;
  bigeventstart: number | null;
}
export async function getMarketsForBuildLegs(sourceRefs: string[]): Promise<BuildLegRow[]>;
```
Filters: `txtsourceref IN (...) AND blnactive AND NOT blnpolyclosed`. Cutoff filter intentionally omitted — handled in `buildLegs` so the 409 error can render the actual stale timestamp.

**Polling-loop change (`ParlayBuilder.tsx`).** Effect deps unchanged (`[selectedLegsKey, buyActive]`). Interval callback now:
```ts
const STALE_AFTER_MS = 10 * 60 * 1000;
const startedAt = Date.now();
// inside setInterval:
if (Date.now() - startedAt > STALE_AFTER_MS) { clearInterval(id); return; }
refresh();
```
No state added — pure closure timestamp + early return.

**Invariants preserved.**
- `buildLegs` error semantics unchanged: unknown / closed leg → "unknown leg" 400; cutoff-in-past → 409 with the cutoff timestamp.
- `getActiveMarkets()` retained for `/api/markets`, `/api/markets/categories`, `lib/mcp/tools.ts`, settler — all still need the full row shape.
- Quote-sign always re-prices, so cart-side display staleness never affects the on-chain quote the user signs.

**Tests.** All 33 `ParlayBuilder.test.tsx` cases still pass — the polling effect's externally-observable behavior (initial fetch + per-30s refetch) is unchanged within the 10-minute window.
