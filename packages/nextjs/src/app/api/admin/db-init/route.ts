/**
 * Testnet-only proxy for /api/db/init from the F-6 debug page. Invokes the
 * cron handler in-process so we don't loop back through Vercel's SSO gate.
 * The inner handler still enforces CRON_SECRET — `proxyCronHandler` attaches
 * the bearer token so auth round-trips cleanly.
 */

import { GET as dbInit } from "../../db/init/route";
import { assertTestnetOnly, proxyCronHandler } from "../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return assertTestnetOnly() ?? proxyCronHandler(dbInit, req, "/api/db/init");
}
