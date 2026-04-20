/**
 * Shared pieces for admin API routes.
 *
 * The F-6 debug page needs to call cron-gated handlers (like
 * /api/polymarket/sync and /api/db/init) from the browser. Vercel's SSO gate
 * blocks client-side fetches to those endpoints, so we proxy through
 * `/api/admin/*` (which is inside the SSO bubble) and invoke the cron handler
 * in-process with the CRON_SECRET bearer token attached.
 *
 * Chain guard: proxies are only ever useful on testnets. Reject anything else
 * so a production deploy can't accidentally expose a cron endpoint.
 */
import { NextResponse } from "next/server";
import { LOCAL_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID } from "@parlaycity/shared";

export function assertTestnetOnly(): NextResponse | null {
  const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID);
  if (chainId !== LOCAL_CHAIN_ID && chainId !== BASE_SEPOLIA_CHAIN_ID) {
    return NextResponse.json({ error: "Not available on this chain" }, { status: 404 });
  }
  return null;
}

/**
 * Invoke an in-process cron handler with the CRON_SECRET bearer attached. The
 * caller supplies the handler (imported from the target route) and the path
 * they want to synthesize in the forwarded Request.
 */
export function proxyCronHandler(
  handler: (req: Request) => Promise<Response>,
  originalReq: Request,
  targetPath: string,
): Promise<Response> {
  const headers = new Headers();
  const secret = process.env.CRON_SECRET;
  if (secret) headers.set("authorization", `Bearer ${secret}`);
  return handler(new Request(new URL(targetPath, originalReq.url), { headers }));
}
