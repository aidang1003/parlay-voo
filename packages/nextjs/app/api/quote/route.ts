import { NextResponse } from "next/server";
import { LEG_MAP, getQuote, refreshLegMap } from "~~/lib/mcp/tools";
import { parsePolySourceRef } from "~~/lib/polymarket/markets";

// Rejects YES+NO of the same condition — that parlay is risk-free and would drain house edge.
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { legIds?: unknown; stake?: unknown };
    const { legIds: legIdsRaw, stake } = body;

    if (
      !Array.isArray(legIdsRaw) ||
      !legIdsRaw.every((id): id is number => typeof id === "number") ||
      typeof stake !== "number"
    ) {
      return NextResponse.json({ error: "legIds (number[]) and stake (number) are required" }, { status: 400 });
    }
    const legIds: number[] = legIdsRaw;

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
    return NextResponse.json({ error: e instanceof Error ? e.message : "Internal error" }, { status: 500 });
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
