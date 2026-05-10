// Public read-only list of admin addresses. Powers the client-side gate
// (useIsAdmin / AdminGate). Testnet-only — see docs/changes/C_USER_FEEDBACK.md.
import { NextResponse } from "next/server";
import { assertTestnetOnly } from "../_lib";
import { listAdmins } from "~~/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const blocked = assertTestnetOnly();
  if (blocked) return blocked;

  try {
    const rows = await listAdmins();
    return NextResponse.json({ admins: rows.map(r => r.address) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
