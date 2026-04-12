import { NextResponse } from "next/server";
import { getQuote, LEG_MAP, refreshLegMap } from "@/lib/mcp/tools";
import { parsePolySourceRef } from "@/lib/polymarket/markets";

/**
 * POST /api/quote -- compute a parlay quote from leg IDs + stake.
 *
 * Security invariant: reject any parlay that contains both YES and NO of the
 * same Polymarket condition. Such a parlay is risk-free (one side always wins)
 * which would let a user drain house edge for free.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { legIds, stake } = body as { legIds: number[]; stake: number };

    if (!Array.isArray(legIds) || typeof stake !== "number") {
      return NextResponse.json(
        { error: "legIds (number[]) and stake (number) are required" },
        { status: 400 },
      );
    }

    const guardError = await checkComplementaryLegs(legIds);
    if (guardError) {
      return NextResponse.json({ error: guardError }, { status: 400 });
    }

    const quote = await getQuote({ legIds, stake });

    if (!quote.valid) {
      return NextResponse.json({ error: quote.error ?? "Invalid quote" }, { status: 400 });
    }

    return NextResponse.json(quote);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Internal error" },
      { status: 500 },
    );
  }
}

async function checkComplementaryLegs(legIds: number[]): Promise<string | null> {
  await refreshLegMap();
  const seen = new Set<string>();
  for (const id of legIds) {
    const leg = LEG_MAP.get(id);
    if (!leg) continue;
    const parsed = parsePolySourceRef(leg.sourceRef);
    if (!parsed) continue;
    if (seen.has(parsed.conditionId)) {
      return `Cannot combine YES and NO of the same Polymarket condition (${parsed.conditionId.slice(0, 10)}...)`;
    }
    seen.add(parsed.conditionId);
  }
  return null;
}
