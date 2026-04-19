/**
 * Testnet-only proxy for /api/polymarket/sync from the F-6 debug page.
 * Chain-gates on NEXT_PUBLIC_CHAIN_ID and forwards with the CRON_SECRET bearer.
 */

import { NextResponse } from "next/server";
import { LOCAL_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID } from "@parlaycity/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID);
  if (chainId !== LOCAL_CHAIN_ID && chainId !== BASE_SEPOLIA_CHAIN_ID) {
    return NextResponse.json({ error: "Not available on this chain" }, { status: 404 });
  }

  const target = new URL("/api/polymarket/sync", req.url);
  const headers: Record<string, string> = {};
  const secret = process.env.CRON_SECRET;
  if (secret) headers.authorization = `Bearer ${secret}`;

  const res = await fetch(target, { headers, cache: "no-store" });
  const body = await res.text();
  return new NextResponse(body, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}
