// cron-gated entry to settlement pipeline; see ../runner.ts for the actual logic
import { NextResponse } from "next/server";
import { runSettlement } from "../runner";
import { isAuthorizedCronRequest } from "~~/lib/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await runSettlement();
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
