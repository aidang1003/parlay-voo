import { NextResponse } from "next/server";
import { getRegisteredActiveMarkets } from "@/lib/db/client";

const CACHE_TTL_MS = 5 * 60 * 1000;

const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "84532");

let cached: { generated: string; chainId: number; legs: Record<string, number> } | null = null;
let cachedAt = 0;

/**
 * GET /api/leg-mapping
 *
 * Identity map of every on-chain-registered leg id. With the DB as source of
 * truth, /api/markets emits on-chain ids directly on legs (leg.id and
 * leg.noId); this endpoint just tells the frontend which of those ids are
 * actually registered on-chain so the UI can decide what's buyable. Keyed by
 * legId (string) → legId (number) for backward compat with ParlayBuilder.
 */
export async function GET() {
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) {
    return NextResponse.json(cached, {
      headers: { "Cache-Control": "public, max-age=300" },
    });
  }

  try {
    const rows = await getRegisteredActiveMarkets();
    const mapping: Record<string, number> = {};
    for (const row of rows) {
      if (row.intyeslegid != null) mapping[String(row.intyeslegid)] = row.intyeslegid;
      if (row.intnolegid != null) mapping[String(row.intnolegid)] = row.intnolegid;
    }

    cached = {
      generated: new Date().toISOString(),
      chainId,
      legs: mapping,
    };
    cachedAt = Date.now();

    return NextResponse.json(cached, {
      headers: { "Cache-Control": "public, max-age=300" },
    });
  } catch (e) {
    return NextResponse.json(
      { error: `Failed to read leg mapping: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }
}
