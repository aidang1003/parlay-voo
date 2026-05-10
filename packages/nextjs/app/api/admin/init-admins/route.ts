// Browser proxy for /api/db/init-admins.
import { GET as initAdminsRoute } from "../../db/init-admins/route";
import { assertTestnetOnly, proxyCronHandler } from "../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return assertTestnetOnly() ?? proxyCronHandler(initAdminsRoute, req, "/api/db/init-admins");
}
