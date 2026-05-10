// Modular admin-table init. Separate from /api/db/init so re-seeding admins
// doesn't touch market data and vice-versa.
import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "~~/lib/cron-auth";
import { initAdmins } from "~~/lib/db/admin-schema";
import { sql } from "~~/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await initAdmins(sql());
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
