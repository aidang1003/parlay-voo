/**
 * Manual settlement trigger, bound to the "Run now" button on /admin/tickets.
 * No auth gate — same convention as the admin page itself (URL is the knob).
 * Server-side so CRON_SECRET never reaches the browser. Swap to a real admin
 * gate before mainnet.
 */

import { NextResponse } from "next/server";
import { runSettlement } from "../runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const result = await runSettlement();
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
