import { NextResponse } from "next/server";
import {
  CURATED,
  fetchFeaturedMarkets,
  type CuratedMarket,
  type PolymarketOrderBook,
} from "@parlaycity/shared";
import { PolymarketClient } from "@/lib/polymarket/client";
import { midToPpm } from "@/lib/polymarket/markets";
import { upsertLegMapping } from "@/lib/db/client";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/polymarket/sync
 *
 * Syncs Polymarket markets into leg_mapping from two sources:
 *   1. CURATED -- hand-picked markets (curated.ts)
 *   2. Featured -- top trending markets by 24h volume (featured.ts / Gamma API)
 *
 * Deduplicates by conditionId so a market in both lists is only synced once.
 *
 * Re-runs are idempotent: existing rows get their probability/cutoff refreshed
 * but their on_chain_leg_id is preserved (see upsertLegMapping COALESCE).
 */
export async function GET(req: Request) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const poly = new PolymarketClient({
    gammaUrl: process.env.POLYMARKET_GAMMA_URL ?? "https://gamma-api.polymarket.com",
    clobUrl: process.env.POLYMARKET_CLOB_URL ?? "https://clob.polymarket.com",
  });

  // Merge curated + featured, dedup by conditionId
  let featured: CuratedMarket[] = [];
  try {
    featured = await fetchFeaturedMarkets({
      gammaUrl: process.env.POLYMARKET_GAMMA_URL ?? "https://gamma-api.polymarket.com",
    });
  } catch (e) {
    console.warn("[polymarket/sync] Featured fetch failed, continuing with curated only:", e);
  }

  const seen = new Set<string>();
  const allMarkets: CuratedMarket[] = [];
  for (const entry of [...CURATED, ...featured]) {
    if (seen.has(entry.conditionId)) continue;
    seen.add(entry.conditionId);
    allMarkets.push(entry);
  }

  const result = { upserted: 0, skipped: 0, errors: [] as string[], total: allMarkets.length };

  for (const entry of allMarkets) {
    try {
      await syncOne(entry, poly);
      result.upserted++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push(`${entry.conditionId.slice(0, 10)}: ${msg}`);
      result.skipped++;
    }
  }

  return NextResponse.json(result);
}

async function syncOne(entry: CuratedMarket, poly: PolymarketClient): Promise<void> {
  const metadata = await poly.fetchMarket(entry.conditionId);
  if (metadata.closed || metadata.archived) {
    throw new Error("market closed/archived");
  }

  const cutoffSec = Math.floor(new Date(metadata.endDateIso).getTime() / 1000);
  const nowSec = Math.floor(Date.now() / 1000);
  if (cutoffSec <= nowSec + 3600) {
    throw new Error(`cutoff too soon (${cutoffSec - nowSec}s)`);
  }
  const earliestResolve = cutoffSec + 48 * 3600;

  const [yesBook, noBook] = await Promise.all([
    poly.fetchOrderBook(metadata.yesTokenId),
    poly.fetchOrderBook(metadata.noTokenId),
  ]);

  const yesPpm = midToPpm(bookMid(yesBook));
  const noPpm = midToPpm(bookMid(noBook));
  const question = entry.displayTitle ?? metadata.question;

  for (const [side, ppm] of [
    ["yes", yesPpm],
    ["no", noPpm],
  ] as const) {
    await upsertLegMapping({
      sourceRef: `poly:${entry.conditionId}`,
      side,
      source: "polymarket",
      onChainLegId: null,
      question,
      category: entry.category,
      probabilityPpm: ppm,
      cutoffTime: cutoffSec,
      earliestResolve,
      active: true,
    });
  }
}

function bookMid(book: PolymarketOrderBook): number {
  const bestBid = book.bids.length > 0 ? Number(book.bids[0].price) : 0;
  const bestAsk = book.asks.length > 0 ? Number(book.asks[0].price) : 0;
  if (bestBid > 0 && bestAsk > 0) return (bestBid + bestAsk) / 2;
  if (bestBid > 0) return bestBid;
  if (bestAsk > 0) return bestAsk;
  throw new Error("empty orderbook");
}
