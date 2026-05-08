# C-Sprint · User Feedback

The first sprint after putting the testnet build in front of real users. Where A-Day was about making the app feel fast and B-Slog was about making the math right, this one is about removing the rough edges that show up when someone who *isn't on the team* opens the app and clicks around. Each item starts as a piece of feedback, not a feature spec — the doc is organized that way too.

---

## Part 1 — Human Spec

### Admin wallet gate (debug + admin routes)

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

### Database flexibility (Supabase ↔ Neon) + dropping `jsonbapipayload`

**Why this exists.** Storing the raw Polymarket Gamma payload in `tblegmapping.jsonbapipayload` was carrying its weight at the time we shipped curation scoring (A-Day), but the column has had no readers since then. With the Supabase free-tier storage cap blowing past, the JSONB column was the largest single item we owned — and the only way to keep paying $0 was either drop the column or move providers. We did both: drop the dead data, and make the swap one env-var away.

What landed:

- **Provider-agnostic Postgres client.** Same `postgres.js` driver works for Supabase and Neon. `lib/db/client.ts` now sniffs `DATABASE_URL` for `*.supabase.*`, `*.neon.tech`, port `6543`, or a `-pooler` host segment, and disables prepared statements for any pgBouncer-fronted endpoint. Direct Neon endpoints get prepared statements back on (free perf). Logs the detected provider on first connect for sanity.
- **`jsonbapipayload` removed.** Gone from `MarketRow`, `UpsertMarketInput`, `coerceMarketRow`, the INSERT, and the `ON CONFLICT` clause. The `apiPayload` field on `CuratedMarket` and the `buildApiPayload()` helper in `utils/parlay/polymarket/featured.ts` went with it.
- **Idempotent migration.** `lib/db/schema.ts` now emits `DROP INDEX IF EXISTS ixlegmapping_payload` and `ALTER TABLE … DROP COLUMN IF EXISTS jsonbapipayload`. Hitting `/api/db/init` with the existing Supabase `DATABASE_URL` removes the column from a live DB; a `VACUUM FULL tblegmapping` afterward reclaims the disk.
- **`.env.example` documents both providers** with the URL shapes (Supabase pooler on 6543, Neon pooled endpoint with the `-pooler` host suffix).

**What this unlocks.** Free-tier headroom on both providers: switching to Neon is now a one-line env edit; staying on Supabase costs less because the largest column is gone. Either way the app code doesn't know which one is live.

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
