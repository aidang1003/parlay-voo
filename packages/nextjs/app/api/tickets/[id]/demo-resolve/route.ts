/**
 * Ticket-native demo resolver. Items #3 + #4.
 *
 * The user clicks "Mark as WIN" or "Mark as LOSS" on /ticket/[id]. This route
 * reads the ticket from chain to learn (legIds, outcomes — i.e. each leg's
 * bound side), then upserts a per-(wallet, sourceRef) row in
 * tbuserlegdeviation that the UI layers over chain truth at read time.
 *
 * Auth: deliberately none. Anyone can write a deviation for any wallet —
 * the deviations have no on-chain effect (settlement still calls real
 * settleTicket against LegRegistry/Oracle), so the worst case is a stranger
 * showing themselves a fake outcome on their own browser. Documented in
 * docs/changes/C_USER_FEEDBACK.md as a deliberate UX-grade choice for the
 * demo flow.
 */
import { NextResponse } from "next/server";
import { type Abi, createPublicClient, http } from "viem";
import { baseSepolia, foundry } from "viem/chains";
import deployedContracts from "~~/contracts/deployedContracts";
import { type DeviationOutcome, deleteUserLegDeviations, upsertUserLegDeviations } from "~~/lib/db/client";
import { BASE_SEPOLIA_CHAIN_ID, LOCAL_CHAIN_ID, type SupportedChainId, getRpcUrl } from "~~/utils/parlay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

interface TicketLegInfo {
  sourceRef: string;
  outcomeChoice: 1 | 2; // 1=YES, 2=NO; legs without a clean choice are dropped
}

async function loadTicketLegs(ticketId: bigint): Promise<TicketLegInfo[]> {
  const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? String(BASE_SEPOLIA_CHAIN_ID)) as SupportedChainId;
  const chain = chainId === LOCAL_CHAIN_ID ? foundry : baseSepolia;
  const client = createPublicClient({ chain, transport: http(getRpcUrl(chainId)) });
  const contracts = (deployedContracts[chainId as keyof typeof deployedContracts] ??
    Object.values(deployedContracts)[0]) as Record<string, { address: `0x${string}`; abi: Abi }>;
  const engine = contracts.ParlayEngine;
  const registry = contracts.LegRegistry;
  if (!engine || !registry) throw new Error("contracts not deployed for this chain");

  const ticket = (await client.readContract({
    address: engine.address,
    abi: engine.abi,
    functionName: "getTicket",
    args: [ticketId],
  })) as { legIds: readonly bigint[]; outcomes: readonly `0x${string}`[] };

  const out: TicketLegInfo[] = [];
  for (let i = 0; i < ticket.legIds.length; i++) {
    const legId = ticket.legIds[i];
    const choiceVal = Number(BigInt(ticket.outcomes[i]));
    if (choiceVal !== 1 && choiceVal !== 2) continue;
    const leg = (await client.readContract({
      address: registry.address,
      abi: registry.abi,
      functionName: "getLeg",
      args: [legId],
    })) as { sourceRef: string };
    out.push({ sourceRef: leg.sourceRef, outcomeChoice: choiceVal });
  }
  return out;
}

function parseTicketId(idRaw: string): bigint | null {
  try {
    const id = BigInt(idRaw);
    if (id < 0n) return null;
    return id;
  } catch {
    return null;
  }
}

function expand(legs: TicketLegInfo[], outcome: "WIN" | "LOSS"): { sourceRef: string; outcome: DeviationOutcome }[] {
  return legs.map(leg => {
    const userBound: DeviationOutcome = leg.outcomeChoice === 1 ? "YES" : "NO";
    const opposite: DeviationOutcome = userBound === "YES" ? "NO" : "YES";
    return { sourceRef: leg.sourceRef, outcome: outcome === "WIN" ? userBound : opposite };
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ticketId = parseTicketId(id);
  if (ticketId === null) return NextResponse.json({ error: "invalid ticket id" }, { status: 400 });

  let body: { wallet?: unknown; outcome?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const wallet = typeof body.wallet === "string" ? body.wallet : "";
  if (!ADDRESS_RE.test(wallet)) {
    return NextResponse.json({ error: "wallet address required" }, { status: 400 });
  }
  const outcome = body.outcome;
  if (outcome !== "WIN" && outcome !== "LOSS") {
    return NextResponse.json({ error: "outcome must be 'WIN' or 'LOSS'" }, { status: 400 });
  }

  let legs: TicketLegInfo[];
  try {
    legs = await loadTicketLegs(ticketId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `ticket lookup failed: ${msg}` }, { status: 502 });
  }
  if (legs.length === 0) {
    return NextResponse.json({ error: "ticket has no resolvable legs" }, { status: 422 });
  }

  const deviations = expand(legs, outcome);
  const { written } = await upsertUserLegDeviations(wallet, deviations);
  return NextResponse.json({ written, outcome });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ticketId = parseTicketId(id);
  if (ticketId === null) return NextResponse.json({ error: "invalid ticket id" }, { status: 400 });

  const { searchParams } = new URL(req.url);
  const wallet = searchParams.get("wallet") ?? "";
  if (!ADDRESS_RE.test(wallet)) {
    return NextResponse.json({ error: "wallet query param required" }, { status: 400 });
  }

  let legs: TicketLegInfo[];
  try {
    legs = await loadTicketLegs(ticketId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `ticket lookup failed: ${msg}` }, { status: 502 });
  }
  const sourceRefs = legs.map(l => l.sourceRef);
  const { removed } = await deleteUserLegDeviations(wallet, sourceRefs);
  return NextResponse.json({ removed });
}
