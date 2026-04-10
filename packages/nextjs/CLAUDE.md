# Frontend (Next.js 14 / wagmi / viem / ConnectKit)

## Stack

Next.js 14 (App Router), React 18, TypeScript, Tailwind 3. Wallet: wagmi 2, viem 2, ConnectKit. AI: Vercel AI SDK + Claude. Deployed to Vercel.

## Pages

- `/` -- parlay builder
- `/vault` -- LP dashboard
- `/tickets` -- user tickets list
- `/ticket/[id]` -- ticket detail + settle/claim
- `/about` -- project overview

## API Routes

- `/api/chat` -- AI chat (streaming, tool calling)
- `/api/mcp` -- MCP JSON-RPC endpoint
- `/api/markets` -- Market catalog
- `/api/premium/agent-quote` -- Agent quote + risk

## Key Files

- `lib/config.ts` -- chain config, contract addresses from env
- `lib/contracts.ts` -- ABIs + addresses
- `lib/hooks.ts` -- wagmi hooks (`isPending -> isConfirming -> isSuccess`)
- `lib/wagmi.ts` -- wagmi config (foundry + baseSepolia)
- `lib/mcp/tools.ts` -- 6 MCP tool implementations

## Rules

- Never hardcode contract addresses. Use env + `lib/config.ts`.
- USDC is 6 decimals: `parseUnits("100", 6)`.
- Polling: 5s for tickets/balances, 10s for vault stats.
- Each transaction button gets its own loading state.

## Testing

`pnpm test` runs vitest. `npx tsc --noEmit` for typecheck.
