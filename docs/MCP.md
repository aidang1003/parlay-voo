# MCP Endpoint

ParlayVoo exposes a Model Context Protocol (MCP) endpoint at `/api/mcp` so external AI agents (Claude Desktop, custom agents, anything speaking MCP JSON-RPC) can read protocol state and request quotes. Same tools back the in-app AI chat panel, so chat and external-agent behavior stay in lockstep.

## Endpoint

- **URL:** `/api/mcp`
- **Protocol:** MCP JSON-RPC over HTTP POST
- **Methods:** `tools/list`, `tools/call`
- **Auth:** none (read-only tools, no user state)
- **GET:** returns tool discovery metadata for humans poking at the URL

## Tools

Six tools, all defined in `packages/nextjs/src/lib/mcp/tools.ts` and wired to the route at `packages/nextjs/src/app/api/mcp/route.ts`.

| Tool | Input | Returns |
|---|---|---|
| `list_markets` | `{ category? }` | Markets with legs, probabilities, categories |
| `get_quote` | `{ legIds, stake }` | Multiplier, edge, payout, fees |
| `assess_risk` | `{ legIds, stake, bankroll? }` | Kelly fraction, EV, BUY/REDUCE_STAKE/AVOID recommendation |
| `get_vault_health` | `{}` | Total assets, reserved, free liquidity, utilization |
| `get_leg_status` | `{ legId }` | Status, question text, sourceRef |
| `get_protocol_config` | `{}` | Fees, caps, contract addresses, chain ID |

Category filter values for `list_markets`: `crypto`, `defi`, `nft`, `policy`, `economics`, `trivia`, `ethdenver`, `nba`.

## How it's used

- **In-app chat panel** (`ChatPanel.tsx`) — the Vercel AI SDK wraps the same tool implementations as AI SDK `tool()` definitions. Chat and MCP share one source of truth.
- **External agents** — connect to `https://<host>/api/mcp`, issue `tools/list`, then `tools/call` with a tool name + arguments. No persistent session state.
- **Settlement agent** — `scripts/risk-agent.ts` uses `get_quote` and `assess_risk` through the same `/api/` surface (via the standard HTTP routes, not MCP) when sizing bets.

## Adding a tool

1. Implement the tool in `packages/nextjs/src/lib/mcp/tools.ts`. Export the function.
2. Add a definition block to `TOOL_DEFINITIONS` in `packages/nextjs/src/app/api/mcp/route.ts` with `name`, `description`, and a JSON-schema `inputSchema`.
3. Add a dispatch case in the `tools/call` switch in the same route file.
4. Re-export the AI-SDK-wrapped version through `ChatPanel.tsx` if the tool should be available to the in-app chat.
5. Test with a simple curl:
   ```bash
   curl -X POST http://localhost:3000/api/mcp \
     -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
   ```

## What this endpoint is not

- Not a write surface — no tool mutates on-chain state. Buying a ticket, depositing to the vault, locking VOO all require a wallet signature and go through the frontend or a direct contract call.
- Not session-aware — each call is stateless. Agents should not expect cross-call context.
- Not rate-limited in-repo — production deployments should front it with Vercel's edge rate limiting or equivalent.
- Not the same as the Claude Code / internal-tooling MCPs. This endpoint is the *protocol's* MCP for external consumers, not a configuration for an IDE.
