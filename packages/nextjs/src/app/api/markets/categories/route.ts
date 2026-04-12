import { NextResponse } from "next/server";
import { fetchMarketsFromDb } from "@/lib/polymarket/markets";

/**
 * GET /api/markets/categories -- list available categories with counts.
 */
export async function GET() {
  const allMarkets = await fetchMarketsFromDb();

  const categories: Record<string, { marketCount: number; legCount: number }> = {};
  for (const m of allMarkets) {
    if (!categories[m.category]) {
      categories[m.category] = { marketCount: 0, legCount: 0 };
    }
    categories[m.category].marketCount++;
    categories[m.category].legCount += m.legs.length;
  }

  return NextResponse.json({
    available: Object.keys(categories),
    categories,
  });
}
