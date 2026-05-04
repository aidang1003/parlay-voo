import { NextResponse } from "next/server";
import { fetchMarketsFromDb } from "~~/lib/polymarket/markets";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const categoryFilter = searchParams.get("category");

  let markets = await fetchMarketsFromDb();

  if (categoryFilter) {
    const cats = categoryFilter.split(",").map(c => c.trim().toLowerCase());
    markets = markets.filter(m => cats.includes(m.category));
  }

  const response = markets.map(m => ({
    id: m.id,
    title: m.title,
    description: m.description,
    category: m.category,
    gameGroup: m.gameGroup,
    legs: m.legs.map(l => ({
      id: l.id,
      noId: l.noId,
      question: l.question,
      sourceRef: l.sourceRef,
      cutoffTime: l.cutoffTime,
      earliestResolve: l.earliestResolve,
      probabilityPPM: l.probabilityPPM,
      noProbabilityPPM: l.noProbabilityPPM,
      active: l.active,
      correlationGroupId: l.correlationGroupId ?? 0,
      exclusionGroupId: l.exclusionGroupId ?? 0,
    })),
  }));

  return NextResponse.json(response);
}
