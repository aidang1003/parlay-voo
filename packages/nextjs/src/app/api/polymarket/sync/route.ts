import { NextResponse } from "next/server";
import {
  CURATED,
  fetchFeaturedMarkets,
  type CuratedMarket,
  type PolymarketOrderBook,
} from "@parlayvoo/shared";
import { PolymarketClient } from "@/lib/polymarket/client";
import { midToPpm } from "@/lib/polymarket/markets";
import { upsertMarket } from "@/lib/db/client";
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
 * but their on-chain leg ids are preserved (see upsertMarket COALESCE).
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

  // Prefer Gamma-provided prices (one HTTP round-trip per batch, tighter than
  // per-token orderbook mid which often clamps against our thin-book bounds).
  let yesMid: number | undefined = entry.yesPrice;
  let noMid: number | undefined = entry.noPrice;

  if (yesMid == null || noMid == null) {
    const [yesBook, noBook] = await Promise.all([
      poly.fetchOrderBook(metadata.yesTokenId),
      poly.fetchOrderBook(metadata.noTokenId),
    ]);
    yesMid = bookMid(yesBook);
    noMid = bookMid(noBook);
  }

  const yesPpm = midToPpm(yesMid);
  const noPpm = midToPpm(noMid);
  const question = entry.displayTitle ?? metadata.question;

  await upsertMarket({
    sourceRef: entry.conditionId,
    source: "polymarket",
    question,
    category: entry.category,
    yesLegId: null,
    noLegId: null,
    yesProbabilityPpm: yesPpm,
    noProbabilityPpm: noPpm,
    cutoffTime: cutoffSec,
    earliestResolve,
    active: true,
    apiPayload: entry.apiPayload ?? null,
  });
}

function bookMid(book: PolymarketOrderBook): number {
  const bestBid = book.bids.length > 0 ? Number(book.bids[0].price) : 0;
  const bestAsk = book.asks.length > 0 ? Number(book.asks[0].price) : 0;
  if (bestBid > 0 && bestAsk > 0) return (bestBid + bestAsk) / 2;
  if (bestBid > 0) return bestBid;
  if (bestAsk > 0) return bestAsk;
  throw new Error("empty orderbook");
}
