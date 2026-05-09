/**
 * Demo settle. Mirrors `ParlayEngine.settleTicket()` against a layered view of
 * leg statuses — chain truth where available, the caller's deviation row
 * otherwise — and writes the result to `tbticketdeviation`. No on-chain state
 * is mutated. The row is suppressed at read time once chain truth has resolved
 * every leg of the ticket; the user re-Settles + re-Claims for real then.
 *
 * Auth: same posture as /api/tickets/[id]/demo-resolve — none. Worst case is
 * a stranger painting a fake settlement on someone else's local view.
 */
import { NextResponse } from "next/server";
import { type Abi, createPublicClient, http } from "viem";
import { baseSepolia, foundry } from "viem/chains";
import deployedContracts from "~~/contracts/deployedContracts";
import { getUserLegDeviations, upsertTicketDeviation } from "~~/lib/db/client";
import {
  BASE_SEPOLIA_CHAIN_ID,
  LOCAL_CHAIN_ID,
  PPM,
  type SupportedChainId,
  computeMultiplier,
  computePayout,
  getRpcUrl,
} from "~~/utils/parlay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// ── Effective per-leg status (after layering deviations over chain) ─────────
// 1=Won, 2=Lost, 3=Voided. 0=Unresolved means we cannot settle.

const ORACLE_GETSTATUS_ABI = [
  {
    inputs: [{ name: "legId", type: "uint256" }],
    name: "getStatus",
    outputs: [
      { name: "status", type: "uint8" },
      { name: "outcome", type: "bytes32" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

function parseTicketId(idRaw: string): bigint | null {
  try {
    const id = BigInt(idRaw);
    if (id < 0n) return null;
    return id;
  } catch {
    return null;
  }
}

function devToLegStatus(outcome: "YES" | "NO" | "VOIDED"): 1 | 2 | 3 {
  return outcome === "YES" ? 1 : outcome === "NO" ? 2 : 3;
}

interface SettleResult {
  status: "Won" | "Lost" | "Voided";
  payout: bigint;
  multiplierX1e6: bigint;
}

interface LegContext {
  legStatus: 1 | 2 | 3; // Won | Lost | Voided
  isNoBet: boolean;
  probabilityPPM: bigint;
}

/**
 * Pure settlement math — mirrors ParlayEngine.settleTicket exactly. Caller
 * has already collapsed each leg into a non-Unresolved (chain-or-deviation)
 * status. Returns the resulting ticket status + payout (in USDC base units).
 */
function settle(
  legs: LegContext[],
  stake: bigint,
  feePaid: bigint,
  potentialPayout: bigint,
  multiplierX1e6: bigint,
): SettleResult {
  const ppm = BigInt(PPM);
  let allWon = true;
  let anyLost = false;
  let voidedCount = 0;

  for (const leg of legs) {
    if (leg.legStatus === 3) {
      voidedCount++;
      allWon = false;
      continue;
    }
    const bettorWon = leg.legStatus === 1 ? !leg.isNoBet : leg.isNoBet;
    if (!bettorWon) {
      anyLost = true;
      allWon = false;
      break;
    }
  }

  if (anyLost) {
    return { status: "Lost", payout: 0n, multiplierX1e6 };
  }
  if (allWon) {
    return { status: "Won", payout: potentialPayout, multiplierX1e6 };
  }

  const remainingCount = legs.length - voidedCount;
  const effectiveStake = stake - feePaid;
  if (remainingCount < 2) {
    // Refund effective stake — same as on-chain Voided path.
    return { status: "Voided", payout: effectiveStake, multiplierX1e6: ppm };
  }

  const remainingProbs: number[] = [];
  for (const leg of legs) {
    if (leg.legStatus === 3) continue;
    remainingProbs.push(leg.isNoBet ? Number(ppm - leg.probabilityPPM) : Number(leg.probabilityPPM));
  }
  const newMultiplier = computeMultiplier(remainingProbs);
  let newPayout = computePayout(effectiveStake, newMultiplier);
  if (newPayout > potentialPayout) newPayout = potentialPayout;
  return { status: "Won", payout: newPayout, multiplierX1e6: newMultiplier };
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

  const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? String(BASE_SEPOLIA_CHAIN_ID)) as SupportedChainId;
  const chain = chainId === LOCAL_CHAIN_ID ? foundry : baseSepolia;
  const client = createPublicClient({ chain, transport: http(getRpcUrl(chainId)) });
  const contracts = (deployedContracts[chainId as keyof typeof deployedContracts] ??
    Object.values(deployedContracts)[0]) as Record<string, { address: `0x${string}`; abi: Abi }>;
  const engine = contracts.ParlayEngine;
  const registry = contracts.LegRegistry;
  if (!engine || !registry) {
    return NextResponse.json({ error: "contracts not deployed for this chain" }, { status: 500 });
  }

  let ticket: {
    status: number;
    legIds: readonly bigint[];
    outcomes: readonly `0x${string}`[];
    stake: bigint;
    feePaid: bigint;
    potentialPayout: bigint;
    multiplierX1e6: bigint;
  };
  let snapshots: readonly { probabilityPPM: bigint; oracleAdapter: `0x${string}` }[];
  try {
    ticket = (await client.readContract({
      address: engine.address,
      abi: engine.abi,
      functionName: "getTicket",
      args: [ticketId],
    })) as typeof ticket;
    snapshots = (await client.readContract({
      address: engine.address,
      abi: engine.abi,
      functionName: "getTicketSnapshots",
      args: [ticketId],
    })) as typeof snapshots;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `ticket lookup failed: ${msg}` }, { status: 502 });
  }

  // 0 = Active. Anything else means the chain has already moved past Active —
  // fall back to the real flow.
  if (ticket.status !== 0) {
    return NextResponse.json({ error: "ticket already settled on chain" }, { status: 409 });
  }

  // Pull the caller's leg deviations in one shot.
  const deviations = await getUserLegDeviations(wallet);
  const devBySourceRef = new Map(deviations.map(d => [d.sourceRef, d.outcome]));

  // For each leg, derive an effective status (chain wins; deviation falls
  // through only when chain is Unresolved). We need the leg's sourceRef
  // (to look up the deviation) and oracleAdapter (to query chain status) —
  // both come from LegRegistry.getLeg.
  const legContexts: LegContext[] = [];
  for (let i = 0; i < ticket.legIds.length; i++) {
    const legId = ticket.legIds[i];
    const isNoBet = Number(BigInt(ticket.outcomes[i])) === 2;

    const leg = (await client.readContract({
      address: registry.address,
      abi: registry.abi,
      functionName: "getLeg",
      args: [legId],
    })) as { sourceRef: string; oracleAdapter: `0x${string}` };

    const [chainStatus] = (await client.readContract({
      address: leg.oracleAdapter,
      abi: ORACLE_GETSTATUS_ABI,
      functionName: "getStatus",
      args: [legId],
    })) as [number, `0x${string}`];

    let effective: 1 | 2 | 3 | 0 = chainStatus as 0 | 1 | 2 | 3;
    if (effective === 0) {
      const dev = devBySourceRef.get(leg.sourceRef);
      if (dev) effective = devToLegStatus(dev);
    }
    if (effective === 0) {
      return NextResponse.json(
        { error: `leg ${legId.toString()} unresolved (no chain truth, no deviation)` },
        { status: 422 },
      );
    }

    legContexts.push({
      legStatus: effective,
      isNoBet,
      probabilityPPM: snapshots[i].probabilityPPM,
    });
  }

  const result = settle(legContexts, ticket.stake, ticket.feePaid, ticket.potentialPayout, ticket.multiplierX1e6);

  await upsertTicketDeviation({
    wallet,
    ticketId,
    status: result.status,
    payout: result.payout,
    multiplierX1e6: result.multiplierX1e6,
  });

  return NextResponse.json({
    status: result.status,
    payout: result.payout.toString(),
    multiplierX1e6: result.multiplierX1e6.toString(),
  });
}
