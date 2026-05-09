/**
 * Demo claim. Mints MockUSDC to the caller equal to the payout already
 * computed by /api/tickets/[id]/demo-settle, then flips the
 * tbticketdeviation row to `Claimed`. The on-chain pool is never touched —
 * MockUSDC has a permissionless `mint(to, amount)` (capped at 10M USDC per
 * call, which is well above any realistic ticket payout), so we can hand
 * out the demo winnings without disturbing the real claim path.
 *
 * Tradeoff: when the chain later resolves the ticket to a real Win, the
 * user can claim against the real pool too — they collect twice. Acceptable
 * on testnet (MockUSDC is free) and documented in
 * docs/changes/C_USER_FEEDBACK.md.
 */
import { NextResponse } from "next/server";
import { type Abi, type Chain, type Hex, createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, foundry } from "viem/chains";
import deployedContracts from "~~/contracts/deployedContracts";
import { getTicketDeviation, markTicketDeviationClaimed } from "~~/lib/db/client";
import {
  ANVIL_ACCOUNT_0_KEY,
  BASE_SEPOLIA_CHAIN_ID,
  LOCAL_CHAIN_ID,
  type SupportedChainId,
  getRpcUrl,
} from "~~/utils/parlay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const MOCK_USDC_ABI = parseAbi(["function mint(address to, uint256 amount)"]);
const MAX_MINT = 10_000_000n * 1_000_000n; // matches MockUSDC.MAX_MINT (10M USDC, 6 decimals)

function parseTicketId(idRaw: string): bigint | null {
  try {
    const id = BigInt(idRaw);
    if (id < 0n) return null;
    return id;
  } catch {
    return null;
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ticketId = parseTicketId(id);
  if (ticketId === null) return NextResponse.json({ error: "invalid ticket id" }, { status: 400 });

  let body: { wallet?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const wallet = typeof body.wallet === "string" ? body.wallet : "";
  if (!ADDRESS_RE.test(wallet)) {
    return NextResponse.json({ error: "wallet address required" }, { status: 400 });
  }

  const row = await getTicketDeviation(wallet, ticketId);
  if (!row) {
    return NextResponse.json({ error: "no deviation — settle first" }, { status: 404 });
  }
  if (row.status !== "Won") {
    return NextResponse.json({ error: `cannot claim a ${row.status} ticket` }, { status: 409 });
  }
  if (row.payout <= 0n) {
    return NextResponse.json({ error: "nothing to claim" }, { status: 422 });
  }
  if (row.payout > MAX_MINT) {
    return NextResponse.json({ error: "payout exceeds MockUSDC.MAX_MINT" }, { status: 500 });
  }

  const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? String(BASE_SEPOLIA_CHAIN_ID)) as SupportedChainId;
  if (chainId !== LOCAL_CHAIN_ID && chainId !== BASE_SEPOLIA_CHAIN_ID) {
    return NextResponse.json({ error: "demo claim not available on this chain" }, { status: 404 });
  }

  const contracts = (deployedContracts[chainId as keyof typeof deployedContracts] ??
    Object.values(deployedContracts)[0]) as Record<string, { address: `0x${string}`; abi: Abi }>;
  const usdc = contracts.MockUSDC;
  if (!usdc) {
    return NextResponse.json({ error: "MockUSDC not deployed on this chain" }, { status: 500 });
  }

  const pk = (chainId === LOCAL_CHAIN_ID ? ANVIL_ACCOUNT_0_KEY : process.env.HOT_SIGNER_PRIVATE_KEY) as Hex | undefined;
  if (!pk) {
    return NextResponse.json({ error: "HOT_SIGNER_PRIVATE_KEY not set" }, { status: 500 });
  }

  try {
    const chain: Chain = chainId === LOCAL_CHAIN_ID ? foundry : baseSepolia;
    const rpcUrl = process.env.RPC_URL ?? getRpcUrl(chainId);
    const account = privateKeyToAccount(pk);
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const walletClient = createWalletClient({ chain, transport: http(rpcUrl), account });

    const hash = await walletClient.writeContract({
      address: usdc.address,
      abi: MOCK_USDC_ABI,
      functionName: "mint",
      args: [wallet as `0x${string}`, row.payout],
      chain,
      account,
    });
    await publicClient.waitForTransactionReceipt({ hash });

    const { updated } = await markTicketDeviationClaimed({ wallet, ticketId, txHash: hash });
    if (updated === 0) {
      // Row was promoted in a parallel request — don't error, the user got
      // their funds either way.
      return NextResponse.json({ ok: true, txHash: hash, alreadyClaimed: true });
    }
    return NextResponse.json({ ok: true, txHash: hash });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
