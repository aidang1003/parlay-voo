import { NextResponse } from "next/server";
import { getRegisteredActiveLegs } from "@/lib/db/client";

const CACHE_TTL_MS = 5 * 60 * 1000;

const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "84532");

let cached: { generated: string; chainId: number; legs: Record<string, number> } | null = null;
let cachedAt = 0;

/**
 * GET /api/leg-mapping
 *
 * Maps frontend-facing leg IDs to on-chain leg IDs. For seed legs the catalog
 * ID (1..21 from SEED_MARKETS) maps to on-chain 0..20. For polymarket legs
 * the frontend ID *is* the on-chain ID, so the mapping is identity there.
 *
 * The ParlayBuilder component reads this to translate clicks into buyTicket
 * calldata.
 */
export async function GET() {
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) {
    return NextResponse.json(cached, {
      headers: { "Cache-Control": "public, max-age=300" },
    });
  }

  try {
    const rows = await getRegisteredActiveLegs();
    const mapping: Record<string, number> = {};
    for (const row of rows) {
      const onChainId = row.intonchainlegid as number; // non-null by helper contract
      if (row.txtsource === "seed") {
        // seed catalog ID (tblegmapping txtsourceref = "seed:{N}") → on_chain N-1
        const m = row.txtsourceref.match(/^seed:(\d+)$/);
        if (m) mapping[m[1]] = onChainId;
      } else {
        // polymarket: identity (frontend uses intonchainlegid directly)
        mapping[String(onChainId)] = onChainId;
      }
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
