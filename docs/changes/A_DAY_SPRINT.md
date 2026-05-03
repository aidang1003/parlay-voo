# A-Day Sprint

The original heads-down weekend that took ParlayVoo from "hackathon build" to something a real user could open without bouncing. Combines three streams of work that landed on the same branch family:

1. **Scaling pass** — make the app feel fast under realistic RPC + DB load.
2. **Architecture cleanup** — repo + docs reorganized so a new contributor (human or LLM) can navigate by intent, not by history.
3. **UI/UX polish** — the bug-fix backlog the scaling work surfaced.

Feature mechanics live in the main architecture docs (`docs/ARCHITECTURE.md`, subsystem specs). This doc keeps **why** each piece happened so future-us understands the constraint that shaped it.

---

## Scaling

**Why this stream existed.** The hackathon build worked, but every page mounted with 6–10 sequential RPC reads against a public Base Sepolia endpoint. Home page took ~3s to settle. With anyone watching the app on a flaky connection, the protocol felt broken before they reached the buy button. We were also one Vercel deploy away from regressing because the scaling story lived in shell scripts and a Makefile that nobody could safely edit.

What landed and why:

- **Private Alchemy RPC with a public fallback.** Public RPCs rate-limit hard once you have more than a single user, and the failure mode is silent. `wagmi.ts` now uses `fallback([alchemy, public])` and reads the URL from `NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL`. The fallback exists so a missing env var doesn't brick local dev.
- **React Query defaults tuned (`staleTime: 10s`, no refetch on focus / background).** Cuts background-tab RPC load in half and kills the redundant refetch storm on every route navigation. Highest value-per-line change in the whole sprint.
- **Batch reads via `useReadContracts` in vault + parlay hooks.** Home page mount dropped from ~10 RPC round trips to ~2 (Multicall3 is already deployed on Base Sepolia). The biggest visible improvement a user feels.
- **Just-in-time engine + real settlement (F-3 / F-4).** Pre-registering every leg on-chain didn't scale to live Polymarket data and made stale-odds attacks easy. JIT signing means legs only enter `LegRegistry` at buy time, with a signed quote pinning the odds the user actually saw. The settlement cron in `/api/settlement/run` then closes the loop without an admin clicking buttons.
- **Database normalization + curation score.** Sorting markets by `volume24hr × balance` and storing the raw Gamma payload in JSONB unblocked everything downstream (categories, sport grouping, agent stats) without re-fetching from Polymarket on every read. The trade-off is ~1–3 KB per row, fine at our market count.
- **Auto-generated `deployedContracts.ts`.** The 400-line hand-maintained ABI file rotted on every deploy. The generator script reads the forge broadcast JSON + `out/**` and rewrites the file in place. No more "did someone forget to commit the addresses" PR debugging.

**Skipped on purpose:**

- **Redis cache (S-4).** `agent-stats` already had a 60s in-memory cache and `/api/quote` *must* stay fresh because it's stake-dependent. No call site needed Redis.
- **Settler bot script.** Folded into `/api/settlement/run` so there's one settlement code path, not two.

## Architecture cleanup

**Why this stream existed.** The repo had three distinct layers of cruft that made every new contributor — human or LLM — slower than they should be:

- Two `hooks/` folders (`src/hooks/` and `src/lib/hooks/`) with one file in the orphan one.
- A `lib/contracts.ts` shim self-described as "backwards-compat" with no remaining migration target.
- `LockVault.sol` V1 still in tree alongside `LockVaultV2.sol` (the production contract), with V1-only test files that only existed to test V1.
- Docs that still referenced `scripts/market-agent.ts` (deleted), an Express API on :3001 (migrated to Next serverless), and a `MCP.md` describing slither/codestral tooling that doesn't exist here.
- The package was named `@parlaycity/shared` while the project had renamed itself to ParlayVoo.

What landed and why:

- **Three-folder docs layout: `docs/` (humans), `docs/changes/` (history), `docs/llm-spec/` (LLM mirror for subsystem specs).** A single LLM-spec mirror folder is discoverable; per-subsystem folders or per-doc inlines were not. Change docs don't mirror — if a change needs implementation detail, it stays inline in the same file. This very doc demonstrates the pattern.
- **Two-file split (human spec ↔ LLM spec) over two-section single files.** Humans skim the human doc without paging past function signatures; LLMs jump straight to the mirror. Both files get edited in the same commit.
- **Delete, don't archive.** Files left with `-OLD`, `-DEPRECATED`, `-V1` suffixes rot faster than they age. Git history is the archive. The one "archive" we kept (this folder) has an explicit role — historical sprint records, not deprecated-doc limbo.
- **`@parlaycity/shared` → `@parlayvoo/shared`.** ~27 import sites + the package name + root `package.json` `"name"`. The protocol-name string `ParlayCity` in narrative text was *not* renamed — only the package identity that shows up in `import` statements and `package.json`.
- **`useSessionState` extracted from `lib/utils.ts`.** Pure-TS helpers + a React hook in the same file is a category mistake; the rest of `utils.ts` (sanitizers, status mappers) is correctly placed despite the name.
- **`scripts/bootstrap.sh` kept + tightened.** It's a host-level installer (Node via nvm, pnpm, Foundry) that complements `pnpm dev-setup` (the repo-level `pnpm install` + `forge install`). They solve different problems so both stay; the Docker + `act` sections (tied to a removed `make ci` workflow) got stripped.

## UI/UX polish

**Why this stream existed.** Each one of these was a small bug or rough edge that bled into the user's first 30 seconds with the app — and the scaling work either uncovered them (e.g. wallet state actually persists now, so the disconnect bug became visible) or made them worse (faster page loads → tighter visible jank).

What landed and why:

- **Wallet stays connected through navigation + tab sleep.** Rabby's MV3 service worker gets killed by Chrome after ~30s of inactivity and re-injects a fresh `window.ethereum` on wake. wagmi's cached provider reference goes stale, so the React store reported "disconnected" while the wallet itself still trusted the site. `WagmiReconnect` now re-runs `reconnect(config)` on mount, `visibilitychange`, and `window.focus`. The UX win: buying a ticket and navigating to `/tickets` no longer drops the wallet — you arrive logged in, every time.
- **Sticky bet-placement panel with independent scroll.** On short viewports the panel was unreachable until the user scrolled the entire markets list to the bottom. `max-height: calc(100vh - 6rem)` + `overflow-y-auto` lets the panel scroll itself.
- **Lossless toggle vertically centered in its track.** Small visual fix — track 44px, knob 20px, switched the on-state translate from `translate-x-5` to 22px so the gap on either side matches.
- **Re-enabled the vault liquidity gate in the builder.** Was hard-coded to `false` ("explore before deposit"), so 4–5 leg parlays would silently revert on the buy after the user already approved USDC — the only signal was a failed tx in their wallet. The gate also surfaces an "implied cap" hint and a "Use cap" button so users don't approve-then-revert at large multipliers.
- **Admin debug page locks every row when one POST is in flight.** Firing YES on two legs in quick succession raced into `replacement transaction underpriced` because both Vercel lambdas read the same pending nonce. Cheapest correct fix — single `anyPending` flag, no queue, no nonce manager.
- **Dropped `poly:` prefix from Polymarket source refs.** The prefix was a leftover defensive check. PK is now the raw conditionId; `parsePolySourceRef()` redefined as a 0x-hex-64 shape sniffer. Reversible if a second market source ever lands — that would be a bigger refactor anyway.
- **Stored raw Gamma payloads in JSONB, then ranked by curation score.** Both shipped together because the score formula (`floor(volume × 1000) − abs(ppm − 500_000)`) needs the volume number out of the payload. Volume dominates past ~$500/24h; the edge penalty pushes ticket math away from the 1–99% probability clamp. No UI work needed — builder renders in array order.
- **Sport categorization + game grouping.** `classifySport()` runs at sync time, inspects each Gamma event's title/slug/tags for NBA/NFL/MLB/NHL tokens, and stamps `gameGroup = event title` so sibling markets (moneyline, spread, total, props) cluster under one game header in the builder.
- **Kelly AI Risk Advisor disabled and removed.** The agent-quote endpoint stayed for autonomous external agents; the in-builder fetch+debounce pipeline didn't earn its keep and was muddying the buy flow.

---

## What this sprint left behind for the next one

Items that surfaced during A-Day but didn't fit the scope:

- The vault page is still a global protocol dashboard with personal data sprinkled in — a returning LP can't quickly answer "how much do I have here, and how much have I earned?"
- `/tickets` is 100% personal; there's nowhere in the app to see "what's happening on the protocol right now," which is the lightest social-proof surface we can ship.
- Builder shows leg hashes where it should show the question text. Resolver page does the same.
- No correlation pricing, so 4-leg same-game parlays quote ~50× when the true joint probability supports ~15×.
- `AdminOracleAdapter` is the only oracle path that works on mainnet — it's guarded by a chainid revert, but the backdoor itself still exists.
- A brand-new crypto user landing on a wallet/balance-aware builder sees half the UI in error states and is left to guess the order to fix them.

All of these became the [B-Slog Sprint](B_SLOG_SPRINT.md).
