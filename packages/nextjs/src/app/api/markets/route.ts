import { NextResponse } from "next/server";
import { fetchMarketsFromDb } from "@/lib/polymarket/markets";

/**
 * GET /api/markets -- single DB read against leg_mapping. Both seed and
 * polymarket legs live in the same table; the polymarket sync route pulls
 * polymarket data in. Pending-registration rows are hidden by the DB helper.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const categoryFilter = searchParams.get("category");

  let markets = await fetchMarketsFromDb();

  if (categoryFilter) {
    const cats = categoryFilter.split(",").map((c) => c.trim().toLowerCase());
    markets = markets.filter((m) => cats.includes(m.category));
  }

  const response = markets.map((m) => ({
    id: m.id,
    title: m.title,
    description: m.description,
    category: m.category,
    legs: m.legs.map((l) => ({
      id: l.id,
      question: l.question,
      sourceRef: l.sourceRef,
      cutoffTime: l.cutoffTime,
      earliestResolve: l.earliestResolve,
      probabilityPPM: l.probabilityPPM,
      active: l.active,
    })),
  }));

  return NextResponse.json(response);
}
