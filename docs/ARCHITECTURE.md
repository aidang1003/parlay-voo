# ParlayVoo Architecture

## Overview

ParlayVoo (protocol name: ParlayCity) is an onchain parlay betting platform on Base. Users build 2-5 leg parlays, LPs provide house liquidity via a vault, and settlement uses a hybrid model (fast admin resolution for bootstrap, optimistic challenge-based resolution thereafter). Curated Polymarket conditions feed real binary markets into the app; a unified cron relays resolutions and settles tickets.

## System Diagram

```mermaid
flowchart TB
    subgraph "External Data Sources"
        BDL[BallDontLie API<br/>Live NBA games]
        POLY[Polymarket<br/>gamma-api]
    end

    subgraph "Crons + Agent Scripts"
        PSYNC[Polymarket Sync<br/>/api/polymarket/sync<br/>daily 08:00 UTC]
        SET[Settlement Cron<br/>/api/settlement/run]
        RA[Risk Agent<br/>scripts/risk-agent.ts]
    end

    subgraph "Frontend -- Next.js 14 (Vercel)"
        UI[Parlay Builder / Vault / Tickets / Ticket Detail / About]
        CHAT[AI Chat Panel<br/>Vercel AI SDK + Claude]
        API[API Routes<br/>/api/markets · /api/quote-sign<br/>/api/mcp · /api/premium/agent-quote]
    end

    subgraph "Neon Postgres"
        LM[tblegmapping]
        PR[tbpolymarketresolution]
    end

    subgraph "Base Sepolia -- Contracts"
        PE[ParlayEngine<br/>ERC-721 tickets]
        HV[HouseVault<br/>ERC-4626 vault]
        LR[LegRegistry]
        LV2[LockVaultV2<br/>continuous-duration<br/>Synthetix rewards]
        OA[AdminOracleAdapter]
        OO[OptimisticOracleAdapter]
        PM[ParlayMath<br/>pure library]
    end

    subgraph "Human Users"
        HU[Browse markets<br/>Buy tickets<br/>Cashout / Claim<br/>Deposit / Lock]
    end

    %% Cron + agent flows
    POLY --> PSYNC
    PSYNC --> LM
    PSYNC --> PR
    PSYNC -->|createLeg| LR
    PSYNC -->|resolve YES/NO/VOIDED| OA
    BDL --> API
    SET -->|settleTicket| PE
    SET -->|canResolve| OA
    RA -->|quote + risk| API

    %% Human flows
    HU -->|wagmi/viem| UI
    UI --> API
    HU -->|buyTicket / cashoutEarly| PE
    HU -->|deposit / withdraw| HV
    HU -->|lock / unlock| LV2
    HU -->|natural language| CHAT
    CHAT -->|tool calls| API

    %% Contract internals
    PE -->|reserve / release / pay| HV
    PE --> PM
    HV -->|notifyFees| LV2
    LR --> OA
    LR --> OO
```

## Contract Architecture

### HouseVault
ERC4626-like vault holding USDC. LPs deposit to earn the house edge. Tracks reserved exposure for active tickets. Pull-based payouts. Fee routing: 90% to LockVaultV2 lockers, 5% to safety buffer, 5% stays in vault (via `routeFees`).

### LegRegistry
Registry of betting legs (questions). Each leg has a probability, cutoff time, oracle adapter reference, and optional `sourceRef` for external data provenance (e.g., `polymarket:0xabc...:yes`). Legs are created by admin or the Polymarket sync route.

### ParlayEngine
Core engine that mints ERC-721 ticket NFTs. Validates parlay construction, computes multipliers/fees via ParlayMath library, manages settlement lifecycle. JIT-signed EIP-712 quotes gate every purchase (deterministic pricing, math-parity invariant).

### LockVaultV2
Staking contract for VOO shares. **Continuous-duration lock curve** (no fixed 30/60/90 tiers): fee share `= 10_000 + MAX_BOOST * d / (d + HALF_LIFE)`, base 1.0x at 7-day min, asymptote 4.0x as `d → ∞`, exactly 2.0x at 1 year. `MAX_PENALTY_BPS = 30%` on day-0 max-lock exit, decaying with elapsed time. Three tiers (`FULL`, `PARTIAL`, `LEAST`) serve rehab mode — FULL is the normal LP path; PARTIAL / LEAST are credit-backing positions. Synthetix-style `accRewardPerWeightedShare` accumulator distributes 90% of protocol fees, weighted by committed duration and shares.

### ParlayMath
Pure library mirrored exactly in TypeScript (`packages/shared/src/math.ts`). Computes multipliers, edge, payout, progressive payout, and cashout values. PPM scale (1e6) for probability, BPS (1e4) for fees.

### Oracle Adapters
Pluggable settlement via `IOracleAdapter` interface:
- **AdminOracleAdapter**: Owner resolves legs directly. Used during bootstrap and by the Polymarket sync route.
- **OptimisticOracleAdapter**: Permissionless propose/challenge with bonds and liveness window. Production path.

### Hybrid Settlement
`bootstrapEndsAt` timestamp determines mode at ticket purchase time. Before = FAST (admin resolved). After = OPTIMISTIC (challenge-based). Mode is immutable per ticket.

## Crons + Agent Scripts

Crons handle protocol infrastructure. Humans (and the risk agent when enabled) make all betting decisions.

### Polymarket Sync (`/api/polymarket/sync`)

Daily Vercel cron at 08:00 UTC. Two phases, one route:

- **Phase A — discovery + registration.** Walks `packages/shared/src/polymarket/curated.ts`. For each new entry, fetches current odds from Polymarket, registers a leg on `LegRegistry`, records the `conditionId → legId` mapping in Neon Postgres (`tblegmapping`).
- **Phase B — resolution relay.** Walks active `tblegmapping` rows past cutoff. For each, polls Polymarket for a resolved outcome. When it lands, calls `AdminOracleAdapter.resolve()` for both YES and NO legs and writes a resolution row.

Odds are **frozen at registration time** — deterministic pricing is required by the math-parity invariant. Full detail: [POLYMARKET.md](POLYMARKET.md).

### Settlement Cron (`/api/settlement/run`)

Iterates `ticketCount`; for each active ticket whose legs all return `canResolve=true`, calls `ParlayEngine.settleTicket()` to finalize payouts and release vault reserves. Idempotent — already-settled tickets are skipped.

```
Poll ticketCount  -->  canResolve for each leg  -->  settleTicket()
```

Signed with `DEPLOYER_PRIVATE_KEY`.

### Risk Agent (`scripts/risk-agent.ts`)

Standalone autonomous betting agent (Kelly-criterion sizing, optional 0G AI inference, x402 payment for premium risk assessments). Not on a cron — run by hand or scheduled externally. Not part of the core protocol loop; kept as a reference implementation for agent integration.

## MCP Server & AI Chat

### MCP Tools (`packages/nextjs/src/lib/mcp/tools.ts`)

Six protocol tools callable by any MCP-compatible AI agent:

| Tool | Input | Returns |
|------|-------|---------|
| `list_markets` | `{ category?: string }` | Markets with legs, probabilities, categories |
| `get_quote` | `{ legIds, stake }` | Multiplier, edge, payout, fees |
| `assess_risk` | `{ legIds, stake, bankroll? }` | Kelly fraction, EV, recommendation |
| `get_vault_health` | `{}` | TVL, reserved, free liquidity, utilization% |
| `get_leg_status` | `{ legId }` | Status, question, sourceRef |
| `get_protocol_config` | `{}` | Fees, caps, addresses, chain |

### MCP Endpoint (`/api/mcp`)

Stateless JSON-RPC endpoint implementing MCP protocol (`tools/list` + `tools/call`). External AI agents (Claude Desktop, etc.) connect here for programmatic protocol access. GET returns tool discovery metadata. Full detail: [MCP.md](MCP.md).

### AI Chat (`/api/chat` + `ChatPanel.tsx`)

Floating chat panel (Vercel AI SDK + Claude) available on all pages. Uses the same tool implementations as the MCP endpoint via AI SDK `tool()` wrappers. Streaming responses with inline tool call results.

## Data + API Surface

All offchain services run as Next.js serverless routes under `packages/nextjs/src/app/api/`. There is no separate Express server.

| Route | Purpose |
|---|---|
| `/api/markets` | Merged catalog: seed markets + curated Polymarket |
| `/api/quote-sign` | EIP-712 signed JIT quote for `buyTicketSigned` |
| `/api/mcp` | JSON-RPC endpoint exposing the 6 MCP tools |
| `/api/chat` | AI chat panel (streaming + tool calls) |
| `/api/premium/agent-quote` | Combined quote + risk for autonomous agents |
| `/api/polymarket/sync` | Daily cron — discovery + resolution relay |
| `/api/settlement/run` | Cron — settle tickets whose legs are all resolved |
| `/api/db/init` | One-shot — apply Neon schema + backfill seed legs |

Live NBA markets are fetched inline from BallDontLie (`packages/nextjs/src/lib/bdl.ts`, 5-min cache). Seed markets live in `packages/shared/src/seed.ts`. Curated Polymarket entries live in `packages/shared/src/polymarket/curated.ts`.

## Security Model

See [THREAT_MODEL.md](THREAT_MODEL.md) for full analysis.

Key properties:
- SafeERC20 + ReentrancyGuard on all token interactions
- Pull-based payouts (no push transfers)
- Utilization caps prevent vault insolvency (80% max utilization, 5% max single payout)
- Oracle adapter isolation (swap without touching engine)
- Pausable emergency stop on all contracts
- Permissionless settlement (no keeper dependency)
- Engine never holds USDC (stateless routing layer)
- JIT quote signer is a dedicated hot key; `DEPLOYER_PRIVATE_KEY` is the admin/cron cold fallback.
