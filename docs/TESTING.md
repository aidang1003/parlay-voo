# Testing & Verification

How to check the code is correct before you ship. Covers the verification gate, each tool in it, and the ad-hoc tools available alongside it.

## The verification gate

```bash
pnpm gate        # test + typecheck + build — the full CI check
pnpm test        # test:contracts + test:web
pnpm typecheck   # tsc --noEmit on packages/nextjs
pnpm build       # next build
```

Run `pnpm gate` before every commit. CI runs the same gate on every push.

## What each piece checks

| Command | Scope | What it verifies |
|---|---|---|
| `pnpm test:contracts` | Solidity | `forge test -vvv` — unit, fuzz, invariant suites under `packages/foundry/test/` |
| `pnpm test:web` | TypeScript | `vitest` — component + API route tests under `packages/nextjs/src/**/__tests__/` |
| `pnpm typecheck` | TypeScript | Types only; no runtime behavior |
| `pnpm build` | Frontend | `next build` — catches build-time errors the dev server hides |
| `forge coverage --report summary` | Solidity | Line coverage when touching core accounting |

## Test layout

```
packages/foundry/test/unit/        Per-contract unit tests
packages/foundry/test/fuzz/        Fuzz tests (vault, math)
packages/foundry/test/invariant/   Invariant tests (totalReserved <= totalAssets)
packages/foundry/test/Integration.t.sol
packages/nextjs/src/**/__tests__/  Frontend + API tests (vitest)
```

Run a single Foundry test: `forge test -vvv --match-test <TestName>` from `packages/foundry/`.

## Expectations when adding code

- **New contract revert branch** — add a unit test asserting it.
- **New math or fee path** — add a fuzz test over the input bounds.
- **Touching vault accounting** — update the invariant tests; run `forge coverage --report summary`.
- **Changing `ParlayMath.sol`** — mirror the change in `packages/shared/src/math.ts` and add a parity test (invariant #3).

## Ad-hoc verification tools

These aren't in the gate. Run them when investigating.

### `knip` — unused code finder

Finds unused files, exports, dependencies, and types that the TS compiler can't flag because the export itself isn't an error.

```bash
pnpm knip                 # full report
pnpm knip --include files # files only
```

Config lives in `knip.json` at the repo root. It knows about:

- Next.js App Router entry points (`page`, `layout`, `route`, `loading`, `error`, etc.)
- `middleware.ts`, `next.config.mjs`, Tailwind + PostCSS configs
- `scripts/*.ts` entries for `npx tsx` invocations
- `__tests__/**` + `*.test.*` as test entry points
- Auto-generated files ignored: `src/contracts/deployedContracts.ts`, `src/contracts/deployments/**`

Knip is a static analyzer — it can't see dynamic usage (wagmi codegen, MCP tool registry, JSON ABI imports). Always cross-check a finding with `rg`/`grep` before deleting. False positives are normal.

**Why it's here:** The repo went through several cleanup passes (arch review, 8-agent code review) that turned up dead exports and stale compat shims. `knip` is the tool those passes use to find candidates; keeping it installed means the next cleanup doesn't have to re-install and re-configure it. Not wired into `pnpm gate` — the false-positive rate on a Next.js App Router codebase is high enough that a hard gate would be noisy.

### Forge linting

`forge lint` surfaces Solidity style findings. Not a pass/fail gate; review the report when touching core contracts.

## What's NOT the gate's job

- UI correctness — exercise the feature in a browser (`pnpm dev`). Type checks and tests verify code correctness, not feature correctness.
- Deployed-contract ABI parity — `scripts/generate-deployed-contracts.ts` regenerates `deployedContracts.ts` after every deploy; commit it alongside the Solidity change.
- Secret leakage — review `.env` / staged files manually before pushing.
