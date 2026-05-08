// Testnet-only browser proxy for /api/db/admins (CRUD on tbadminwallet).
// Attaches CRON_SECRET so the inner cron-gated handler trusts the call.
import { DELETE as dbDelete, POST as dbPost } from "../../db/admins/route";
import { assertTestnetOnly, proxyCronHandler } from "../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return assertTestnetOnly() ?? proxyForward(dbPost, req);
}

export async function DELETE(req: Request) {
  return assertTestnetOnly() ?? proxyForward(dbDelete, req);
}

// proxyCronHandler in _lib drops the body — it builds a synthetic Request
// from headers only. We need to forward method + body for POST/DELETE, so
// re-implement the bearer-attach inline.
async function proxyForward(handler: (req: Request) => Promise<Response>, originalReq: Request): Promise<Response> {
  const url = new URL(originalReq.url);
  url.pathname = "/api/db/admins";
  const headers = new Headers(originalReq.headers);
  const secret = process.env.CRON_SECRET;
  if (secret) headers.set("authorization", `Bearer ${secret}`);
  const body = originalReq.method === "GET" || originalReq.method === "HEAD" ? undefined : await originalReq.text();
  return handler(new Request(url, { method: originalReq.method, headers, body }));
}
