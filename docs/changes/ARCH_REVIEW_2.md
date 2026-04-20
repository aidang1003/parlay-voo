# Arch Review 2

**Status:** P1–P5 complete (pending commit). P6 planned, not started. Branch `arch/review-2`.

First doc written under the new change-doc flow. Every concrete edit — docs moved, files deleted, functions consolidated — is logged in the Change log section at the bottom. When a change is implemented, the corresponding architecture or reference doc is updated in the same commit.

---

## Part 1 — Human Spec

### What this change is

An architecture-cleanup pass that (a) establishes the change-doc flow and the human/LLM-spec split in `docs/`, (b) reorganizes `docs/` so a new contributor can navigate by type rather than by history, (c) deletes bloat (dead docs, stale references, orphan contracts, duplicate-name folders), and (d) brings every live doc into agreement with the code.

Audience for `docs/`: **humans only.** LLM-readable implementation detail lives in a mirror folder `docs/llm-spec/` that humans never need to read. When an LLM edits a human doc that has a mirror, it updates both.

### What it does

**Folder layout (final state).**
```
docs/
├── README.md                    folder index — what each file/folder is for
├── ARCHITECTURE.md              whole-system reference
├── DEPLOYMENT.md                how to deploy local / Sepolia
├── RUNBOOK.md                   day-to-day ops + troubleshooting
├── THREAT_MODEL.md              assets, threats, mitigations
├── MCP.md                       /api/mcp endpoint reference (rewritten)
├── REHAB_MODE.md                subsystem: rehab mode
├── CASHOUT.md                   subsystem: crash-parlay cashout
├── RISK_MODEL.md                subsystem: utilization + exposure
├── POLYMARKET.md                subsystem: curation + sync + settlement
├── UNISWAP_LP_STRATEGY.md       subsystem: planned yield strategy
├── BACKLOG.md                   deferred ideas (renamed from FUTURE_IMPROVEMENTS)
│
├── changes/                     chronological change log
│   ├── README.md                one-paragraph "add a file here per architectural change"
│   ├── ARCH_REVIEW_2.md         (this file)
│   └── A_DAY_SCALING_SPRINT.md  historical scaling sprint (verbatim move of A-DAY.md)
│
└── llm-spec/                    LLM-only mirror of subsystem specs. Humans ignore.
    ├── README.md                "this folder is for LLM consumption; editors update the mirror"
    ├── REHAB_MODE.md            AI spec for rehab mode
    ├── CASHOUT.md               AI spec for cashout
    ├── RISK_MODEL.md            AI spec for risk model
    ├── POLYMARKET.md            AI spec for polymarket integration
    └── UNISWAP_LP_STRATEGY.md   AI spec for Uniswap LP adapter
```

**Which docs get an LLM-spec mirror.** The five subsystem specs (`REHAB_MODE`, `CASHOUT`, `RISK_MODEL`, `POLYMARKET`, `UNISWAP_LP_STRATEGY`). Change docs do **not** mirror — if a change doc needs an AI spec, it goes inline in the same file (this file demonstrates the pattern in Part 2 below). Reference/ops docs (`ARCHITECTURE`, `DEPLOYMENT`, `RUNBOOK`, `THREAT_MODEL`, `MCP`, `BACKLOG`) do not mirror.

**Editor convention.** Every human doc with a mirror carries a one-liner under its title: `*LLM spec: [llm-spec/<name>.md](llm-spec/<name>.md)*`. When editing the human doc, update the mirror in the same commit. When editing the mirror without a human-visible counterpart, the human doc is probably wrong too — fix both.

**P6 follow-up (scope added mid-review).** A second code-organization pass on top of the P4 consolidation:

- `@parlaycity/shared` renamed to `@parlayvoo/shared` (package + all ~27 import sites). Root `package.json` `"name": "parlaycity"` follows suit. Directory name `packages/shared/` stays the same. The *protocol* name (`ParlayCity`) in narrative text is not renamed — only the npm/pnpm package identity.
- `scripts/` audit. Every `.ts`/`.sh` except `scripts/bootstrap.sh` is wired to a `pnpm` entry in root `package.json`. `bootstrap.sh` is a host-level installer (Node via nvm / pnpm / Foundry) and the repo-level `pnpm dev-setup` (renamed from `pnpm bootstrap` so the two names don't collide — `install`/`setup` are pnpm-reserved words) covers `pnpm install` + `forge install`. They solve different problems so both stay. Disposition: **keep + tighten.** Strip the Docker + `act` sections from `bootstrap.sh` (both tied to a removed `make ci` workflow), fix the final echo from `make setup` → `pnpm dev-setup`, and document the two-stage fresh-machine path (host tools → repo deps) in the root `README.md`.
- `packages/nextjs/src/lib/` audit. Only one real offender: `lib/utils.ts` mixes a React hook (`useSessionState`) with pure-TS helpers (input sanitizers + status/outcome mappers). Extract `useSessionState` to `lib/hooks/useSessionState.ts` and re-export from the hooks barrel. Other loose files (`cashout.ts` pure math, `builder-code.ts` encoder, `wagmi.ts` config, `cron-auth.ts` server-only auth) are correctly placed despite the naming — leave them. The duplicate `builder-code.ts` between `packages/nextjs/src/lib/` (Web `TextEncoder`) and `scripts/lib/` (Node `Buffer`) is deliberate runtime split, not redundancy — leave it.

**Dead content removed.**
- `MCP.md` — described slither/rpc/codestral tooling that doesn't exist in this repo. Rewritten end-to-end for the live `/api/mcp` endpoint.
- `A-DAY.md` — de-facto changelog of a scaling sprint whose items are mostly shipped. Moved verbatim into `changes/`.
- `FUTURE_IMPROVEMENTS.md` — renamed `BACKLOG.md`. Item #6 (LockVault economic redesign) is stripped because LockVaultV2 shipped it.
- `ARCHITECTURE.md` — "Services API :3001 (Express)" section removed (migrated to Next.js serverless long ago); `scripts/market-agent.ts` references replaced with the real pair (`scripts/risk-agent.ts` + `/api/polymarket/sync` + `/api/settlement/run` cron); LockVault diagram updated to LockVaultV2.
- `DEPLOYMENT.md` — LockVault → LockVaultV2 in the deploy step list.
- `CASHOUT.md` — "NOT YET IMPLEMENTED" banner removed; the doc now describes the live cashout path and remaining open questions.
- `packages/foundry/CLAUDE.md` — LockVault → LockVaultV2 in the core contract list.
- `packages/foundry/src/interfaces/IHedgeAdapter.sol` — orphan interface with no implementation or caller. Deleted.
- `packages/foundry/src/core/LockVault.sol` (V1) — superseded by V2 in production. Deleted along with its three dedicated test files; three shared test helpers migrated to use V2.
- `packages/nextjs/src/hooks/` — one-file folder duplicating the name of `packages/nextjs/src/lib/hooks/`. The single file (`useDeployedContract.ts`) is moved into `lib/hooks/` and the orphan folder is deleted.
- `packages/nextjs/src/lib/contracts.ts` — self-described "backwards-compat shim." Callers migrated to `useDeployedContract` / `getDeployedContract`; shim deleted.

**New content.**
- `docs/README.md` — folder-level index, first thing a new contributor opens.
- `docs/changes/README.md` — short how-to for adding a change doc.
- `docs/llm-spec/README.md` — short statement of purpose for the mirror folder.
- Root `CLAUDE.md` — new section explaining the change-doc flow so LLM contributors use it.

### Key design decisions

- **Two-file split (human doc + `llm-spec/` mirror) beats two sections in one file.** Humans skim the human doc without scrolling past a wall of function signatures; LLMs open the mirror directly. The mirror structure is discoverable (same filename under `llm-spec/`), so there's no lookup cost.
- **No LLM mirror for change docs.** Change docs are infrequent and varied; forcing them into a mirror structure creates empty files. If a specific change doc needs AI-focused implementation detail, it goes in Part 2 of the same file (this file does).
- **Folder-by-intent over folder-by-subsystem.** Three folders (`docs/` root + `changes/` + `llm-spec/`) beats eleven files flat and beats per-subsystem subdirectories that over-partition a dozen files.
- **Delete, don't archive.** `git log` is the archive. Files left with `-OLD`, `-DEPRECATED`, `-V1` suffixes rot faster than they age gracefully. The one exception: `changes/A_DAY_SCALING_SPRINT.md` is an "archive" but its role is explicit — historical sprint record — not deprecated-doc limbo.
- **Test deletion is fair game on a rebuild branch.** LockVault V1 tests exist only to test LockVault V1. Deleting the contract and its tests together is honest; keeping tests of dead code as "coverage" is not.

### What the next contributor sees

Opening `docs/`:
1. `README.md` in the folder tells them where things live.
2. Four top-level reference/ops files (`ARCHITECTURE`, `DEPLOYMENT`, `RUNBOOK`, `THREAT_MODEL`) cover "how does this system work and how do I operate it."
3. Six subsystem files (one per major feature area) cover "how does X work." Each carries a link to its LLM spec at the top — but the human doc alone is enough to understand the feature.
4. `changes/` tells them "why is it like this" for anything that changed recently.
5. `llm-spec/` is explicitly marked as LLM territory. They close it and move on.

Opening the code:
- One hook folder, not two.
- One `LockVault` contract, not two.
- No shim files asking to be migrated.
- Dead references (`scripts/market-agent.ts`, Express API on :3001, V1-LockVault everywhere) are gone.

---

## Part 2 — AI Spec Sheet

*Terse. For an LLM executing this plan or a reviewer auditing completeness. Change docs keep their AI spec inline — no `llm-spec/changes/` mirror.*

### Resolved decisions

| # | Question | Answer |
|---|---|---|
| Q1 | `LockVault.sol` (V1) disposition | Delete. Migrate shared test helpers (`FeeRouterSetup.sol`, `Integration.t.sol`, `FeeRouting.t.sol`, `FeeRoutingFuzz.t.sol`) to `LockVaultV2`. Delete V1-specific tests (`LockVault.t.sol`, `LockVaultInvariant.t.sol`). |
| Q2 | `docs/MCP.md` disposition | Keep filename, rewrite for the live `/api/mcp` endpoint (external AI agent interface). |
| Q3 | `docs/A-DAY.md` disposition | Verbatim move to `docs/changes/A_DAY_SCALING_SPRINT.md`. No content changes. |
| Q4 | Doc folder layout | Three folders: `docs/` (human), `docs/changes/` (history), `docs/llm-spec/` (AI mirror for subsystem specs only). Change docs do not mirror. |
| Q5 | `IHedgeAdapter.sol` disposition | Delete. |
| Q6 | `@parlaycity/shared` rename | Rename to `@parlayvoo/shared`. Root `package.json` `"name"` follows. Directory + protocol-name strings unchanged. |
| Q7 | `lib/utils.ts` split | Extract `useSessionState` into `lib/hooks/useSessionState.ts`; leave input sanitizers + status/outcome mappers in `utils.ts`. |
| Q8 | `scripts/bootstrap.sh` disposition | Keep + tighten. Host-level installer (Node/nvm, pnpm, Foundry) complements repo-level `pnpm dev-setup` — they don't overlap. Strip Docker + `act` blocks (tied to removed `make ci` workflow), fix final echo to `pnpm dev-setup`. Rename `pnpm bootstrap` → `pnpm dev-setup` in root `package.json` so the two setup paths have distinct names (`install`/`setup` are pnpm-reserved). |

### Phase map

| Phase | Scope | Gate |
|---|---|---|
| P1 | Folder scaffolding + doc moves. Create `llm-spec/`, `changes/`. Split `REHAB_MODE.md` into human + mirror. Verbatim-move `A-DAY.md`. Rename `FUTURE_IMPROVEMENTS.md → BACKLOG.md` and strip done items. Rewrite `MCP.md` for `/api/mcp`. Add `README.md` in each folder. | No test/build impact. |
| P2 | Two-file split for the remaining four subsystem specs: `CASHOUT.md`, `RISK_MODEL.md`, `POLYMARKET.md`, `UNISWAP_LP_STRATEGY.md`. | No test/build impact. |
| P3 | Stale-content purge in live reference docs: `ARCHITECTURE.md`, `DEPLOYMENT.md`, `THREAT_MODEL.md`. Fix package `CLAUDE.md` files. | No test/build impact. |
| P4 | Code consolidation: delete `IHedgeAdapter.sol`; merge `src/hooks/` into `src/lib/hooks/`; retire `src/lib/contracts.ts` shim; delete `LockVault.sol` V1 + V1-only tests + migrate shared helpers to V2. | `pnpm gate` must pass. |
| P5 | Root `README.md` + root `CLAUDE.md` updated for new docs layout + change-doc flow. | `pnpm gate` must pass. |
| P6 | Rename `@parlaycity/shared` → `@parlayvoo/shared` (package + imports + root `package.json` `"name"`). Extract `useSessionState` from `lib/utils.ts` → `lib/hooks/useSessionState.ts`. Tighten `scripts/bootstrap.sh` (strip Docker + `act`; point final echo at `pnpm dev-setup`) and document the two-stage fresh-machine setup path in root `README.md`. | `pnpm gate` must pass. |

### File operations

**Create**
```
docs/README.md
docs/changes/README.md
docs/llm-spec/
docs/llm-spec/README.md
docs/llm-spec/REHAB_MODE.md           (Part 2 of current REHAB_MODE.md)
docs/llm-spec/CASHOUT.md
docs/llm-spec/RISK_MODEL.md
docs/llm-spec/POLYMARKET.md
docs/llm-spec/UNISWAP_LP_STRATEGY.md
```

**Move**
```
docs/A-DAY.md  →  docs/changes/A_DAY_SCALING_SPRINT.md  (verbatim)
```

**Rename (P6)**
```
package.json                                  "name": "parlaycity" → "parlayvoo"
packages/shared/package.json                  "name": "@parlaycity/shared" → "@parlayvoo/shared"
~27 import sites (packages/nextjs/**, scripts/**, tests)
                                              from "@parlaycity/shared" → from "@parlayvoo/shared"
packages/nextjs/next.config.mjs               transpilePackages entry
CLAUDE.md ×3                                  root + packages/foundry + packages/nextjs — package-name references
```

**Move (P6)**
```
packages/nextjs/src/lib/utils.ts::useSessionState
  → packages/nextjs/src/lib/hooks/useSessionState.ts
  (+ re-export from lib/hooks/index.ts; update the 1 caller in app/page.tsx or wherever it's used)
```

**Rewrite in place (P6)**
```
scripts/bootstrap.sh                          strip Docker + act blocks;
                                              header comment → "host-level prereqs, use pnpm dev-setup afterwards";
                                              final echo "make setup" → "pnpm dev-setup"
README.md                                     new "Fresh machine? Install host tools first" subsection under Getting started,
                                              documenting scripts/bootstrap.sh → pnpm dev-setup two-stage path
package.json                                  rename "bootstrap" script → "dev-setup" (done by user prior to P6 execution)
```

**Rewrite in place**
```
docs/REHAB_MODE.md          strip Part 2, keep Part 1, add mirror link
docs/CASHOUT.md             rewrite as "what is", add mirror link
docs/RISK_MODEL.md          rewrite human-only, add mirror link
docs/POLYMARKET.md          rewrite human-only, add mirror link
docs/UNISWAP_LP_STRATEGY.md rewrite human-only, add mirror link
docs/MCP.md                 rewrite for /api/mcp endpoint
docs/ARCHITECTURE.md        purge Services API :3001, fix agent refs, LockVault→V2
docs/DEPLOYMENT.md          LockVault→V2
docs/THREAT_MODEL.md        add JIT signer + cron compromise sections
docs/FUTURE_IMPROVEMENTS.md → docs/BACKLOG.md, strip #6 (implemented), audit rest
README.md                   update "Where things live" + link to docs/README.md
CLAUDE.md (root)            add "Change-doc flow" section + updated file inventory
packages/foundry/CLAUDE.md  LockVault → LockVaultV2 in contract list
packages/nextjs/CLAUDE.md   drop lib/contracts.ts after removal
```

**Delete**
```
packages/foundry/src/interfaces/IHedgeAdapter.sol
packages/foundry/src/core/LockVault.sol
packages/foundry/test/unit/LockVault.t.sol
packages/foundry/test/invariant/LockVaultInvariant.t.sol
packages/nextjs/src/hooks/useDeployedContract.ts  (after moving to lib/hooks/)
packages/nextjs/src/hooks/                        (empty folder)
packages/nextjs/src/lib/contracts.ts              (after migrating callers)
```

**Edit to use LockVaultV2 instead of V1 (P4)**
```
packages/foundry/test/helpers/FeeRouterSetup.sol
packages/foundry/test/Integration.t.sol
packages/foundry/test/unit/FeeRouting.t.sol
packages/foundry/test/fuzz/FeeRoutingFuzz.t.sol
```

### Dead references to fix

| Reference | Location | Fix |
|---|---|---|
| `scripts/market-agent.ts` | `ARCHITECTURE.md` ×2 | Replace with `scripts/risk-agent.ts` + `/api/polymarket/sync` + `/api/settlement/run` cron. |
| `scripts/mcp/install.sh`, `scripts/mcp/doctor.sh`, `scripts/verifier/codestral_review.ts` | `MCP.md` | Remove; full rewrite of `MCP.md`. |
| "Services API :3001 (Express)" | `ARCHITECTURE.md` | Delete section. |
| `LockVault` (30/60/90 tiers) as primary | `ARCHITECTURE.md`, `DEPLOYMENT.md`, `packages/foundry/CLAUDE.md` | Replace with `LockVaultV2` (continuous-duration curve). |
| "Cashout NOT YET IMPLEMENTED" | `CASHOUT.md` | Remove; re-cast as "what is." |
| `FUTURE_IMPROVEMENTS.md` #6 (LockVault redesign) | `FUTURE_IMPROVEMENTS.md` | Strip (implemented via LockVaultV2). |

### Invariants preserved through this change

1. `pnpm gate` (test + typecheck + build) passes after P4 and P5.
2. `packages/foundry/src/libraries/ParlayMath.sol` and `packages/shared/src/math.ts` remain bit-identical.
3. `packages/nextjs/src/contracts/deployedContracts.ts` (auto-generated) is not hand-edited.
4. No fund-holding or admin-drain path is added anywhere.
5. No change to on-chain addresses on any live deployment.

### Change log

Bullets added as work lands. One bullet per concrete change, file paths included.

**P0 — scaffolding**
- `docs/changes/` created; `docs/changes/ARCH_REVIEW_2.md` drafted with plan + open questions.
- Open questions resolved: V1 LockVault deletion approved, MCP.md kept + rewritten, A-DAY.md verbatim move, three-folder layout with LLM-spec mirror for subsystem specs only, IHedgeAdapter deletion approved.

**P1 — folder scaffolding + REHAB + MCP**
- Created `docs/README.md`, `docs/changes/README.md`, `docs/llm-spec/README.md` as folder indexes.
- Split `docs/REHAB_MODE.md`: human Part 1 stays; Part 2 (AI spec) extracted to `docs/llm-spec/REHAB_MODE.md`; mirror link added at top of human doc.
- Verbatim-moved `docs/A-DAY.md` → `docs/changes/A_DAY_SCALING_SPRINT.md`.
- Renamed `docs/FUTURE_IMPROVEMENTS.md` → `docs/BACKLOG.md`; stripped item #6 (LockVault redesign, shipped as V2); audited remaining items.
- Rewrote `docs/MCP.md` end-to-end for the live `/api/mcp` endpoint (removed dead slither/rpc/codestral tooling references).

**P2 — subsystem two-file split**
- Human/LLM split applied to `docs/CASHOUT.md` + `docs/llm-spec/CASHOUT.md` (removed "NOT YET IMPLEMENTED" banner).
- Human/LLM split applied to `docs/RISK_MODEL.md` + `docs/llm-spec/RISK_MODEL.md`.
- Human/LLM split applied to `docs/POLYMARKET.md` + `docs/llm-spec/POLYMARKET.md`.
- Human/LLM split applied to `docs/UNISWAP_LP_STRATEGY.md` + `docs/llm-spec/UNISWAP_LP_STRATEGY.md`.

**P3 — stale content purged in live reference docs**
- `docs/ARCHITECTURE.md`: rewritten diagram — removed "Services API :3001 (Express)" subgraph; added "Crons + Agent Scripts" (Polymarket Sync, Settlement Cron, Risk Agent), consolidated API routes, Neon Postgres subgraph, LockVaultV2 in contracts. Added "Data + API Surface" table. Added JIT quote-signer security note. `scripts/market-agent.ts` references replaced with the real pair (`scripts/risk-agent.ts` + cron routes).
- `docs/DEPLOYMENT.md`: LockVault → LockVaultV2 (continuous-duration lock curve) in the deploy-step list.
- `docs/THREAT_MODEL.md`: added three Asset rows (JIT quote-signer key, cron secret, DB credentials) and three threat rows (T9 JIT signer compromise, T10 cron compromise, T11 Polymarket data integrity).
- `packages/foundry/CLAUDE.md`: subdir list now lists `LockVaultV2`; LockVault bullet rewritten for V2 (continuous curve, 30% max penalty, three tiers); dropped `IHedgeAdapter` from interface list; deploy order swaps to V2.
- `packages/nextjs/CLAUDE.md`: hooks path moved to `lib/hooks/useDeployedContract.ts`; dropped the stale `lib/contracts.ts` line.

**P4 — code consolidation**
- Deleted `packages/foundry/src/interfaces/IHedgeAdapter.sol` (orphan interface, no implementation or caller).
- Deleted `packages/foundry/src/core/LockVault.sol` (V1, superseded by V2).
- Deleted V1-only tests: `packages/foundry/test/unit/LockVault.t.sol`, `packages/foundry/test/invariant/LockVaultInvariant.t.sol`.
- Migrated shared test helpers to V2: `packages/foundry/test/helpers/FeeRouterSetup.sol` (rewritten for LockVaultV2), `packages/foundry/test/Integration.t.sol`, `packages/foundry/test/fuzz/FeeRoutingFuzz.t.sol`, `packages/foundry/test/unit/FeeRouting.t.sol` (V2 constructor + `ILockVault` type upcast + V2-prefixed revert strings; `LockTier.THIRTY/NINETY` → `30 days`/`90 days`).
- Doc comment on `packages/foundry/src/interfaces/ILockVault.sol` updated: "Implemented by LockVaultV2."
- Created `packages/nextjs/src/lib/hooks/useDeployedContract.ts` (imports rewritten for new location); deleted `packages/nextjs/src/hooks/useDeployedContract.ts` and the empty `src/hooks/` folder.
- Updated seven hook files' imports from `"../../hooks/useDeployedContract"` to `"./useDeployedContract"`: `debug.ts`, `leg.ts`, `parlay.ts`, `usdc.ts`, `lock.ts`, `vault.ts`, `ticket.ts`.
- Migrated all callers of the `lib/contracts.ts` shim to `deployedContracts.ts`/`useDeployedContract`: `components/RehabLocks.tsx`, `components/VaultDashboard.tsx`, `components/__tests__/VaultDashboard.test.tsx` (mock block removed; wagmi mock extended with `useChainId`/`usePublicClient`/`useWriteContract`), `app/api/agent-stats/route.ts`, `app/api/quote-sign/route.ts`, `lib/mcp/tools.ts`.
- Deleted `packages/nextjs/src/lib/contracts.ts` (shim).
- `pnpm gate` passes: 339 forge tests, 11 vitest test files, typecheck + build green.

**P5 — root docs**
- `README.md`: "Where things live" block extended with `docs/changes/` and `docs/llm-spec/` entries; added pointer to `docs/README.md` as the starting index.
- Root `CLAUDE.md`: refreshed key-files inventory (LockVault → LockVaultV2, removed `lib/contracts.ts`, added cron routes, corrected `lib/hooks/useDeployedContract.ts` path, added `lib/hooks/index.ts`); Architecture paragraph updated to LockVaultV2; new "Folder layout" + "Change-doc flow" sections added to the Docs block; doc inventory expanded to cover `docs/README.md`, `MCP.md`, `BACKLOG.md`, and `changes/`.
