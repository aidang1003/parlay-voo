/**
 * GET the connected wallet's deviations for read-time layering.
 *
 * Returns both leg-level (tbuserlegdeviation) and ticket-level
 * (tbticketdeviation) overrides. Leg deviations layer over chain LegStatus
 * while it's Unresolved; ticket deviations layer over chain ticket status
 * while it's Active. Once chain truth catches up, the UI suppresses the
 * deviation and the user re-Settles + re-Claims for real.
 */
import { NextResponse } from "next/server";
import { getUserLegDeviations, listTicketDeviationsForWallet } from "~~/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const wallet = searchParams.get("wallet") ?? "";
  if (!ADDRESS_RE.test(wallet)) {
    return NextResponse.json({ error: "wallet query param required" }, { status: 400 });
  }
  const [deviations, ticketRows] = await Promise.all([
    getUserLegDeviations(wallet),
    listTicketDeviationsForWallet(wallet),
  ]);
  const tickets = ticketRows.map(t => ({
    ticketId: t.ticketId.toString(),
    status: t.status,
    payout: t.payout.toString(),
    multiplierX1e6: t.multiplierX1e6.toString(),
    claimTxHash: t.claimTxHash,
  }));
  return NextResponse.json({ deviations, tickets });
}
