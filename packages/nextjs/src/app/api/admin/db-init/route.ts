/**
 * Testnet-only proxy for /api/db/init from the F-6 debug page. Invokes the
 * cron handler in-process so we don't loop back through Vercel's SSO gate.
 */

import { NextResponse } from "next/server";
import { LOCAL_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID } from "@parlaycity/shared";
import { GET as dbInit } from "../../db/init/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID);
  if (chainId !== LOCAL_CHAIN_ID && chainId !== BASE_SEPOLIA_CHAIN_ID) {
    return NextResponse.json({ error: "Not available on this chain" }, { status: 404 });
  }

  const headers = new Headers();
  const secret = process.env.CRON_SECRET;
  if (secret) headers.set("authorization", `Bearer ${secret}`);

  return dbInit(new Request(new URL("/api/db/init", req.url), { headers }));
}
