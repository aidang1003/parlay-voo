/**
 * GET the connected wallet's leg deviations. Powers the read-time layering
 * in the ticket detail page: when chain truth is Unresolved, the UI prefers
 * the deviation; once the chain resolves, the deviation is suppressed.
 */
import { NextResponse } from "next/server";
import { getUserLegDeviations } from "~~/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const wallet = searchParams.get("wallet") ?? "";
  if (!ADDRESS_RE.test(wallet)) {
    return NextResponse.json({ error: "wallet query param required" }, { status: 400 });
  }
  const deviations = await getUserLegDeviations(wallet);
  return NextResponse.json({ deviations });
}
