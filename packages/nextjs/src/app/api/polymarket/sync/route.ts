import { NextResponse } from "next/server";
import {
  CURATED,
  fetchFeaturedMarkets,
  fetchSportEvents,
  type CuratedMarket,
  type PolymarketOrderBook,
} from "@parlayvoo/shared";
import { PolymarketClient } from "@/lib/polymarket/client";
import { midToPpm } from "@/lib/polymarket/markets";
import { upsertMarket } from "@/lib/db/client";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SPORT_TAGS = ["nba", "nfl", "mlb", "nhl"] as const;

/**
 * GET /api/polymarket/sync
 *
 * Upserts markets from three sources, deduped by conditionId:
 *   1. CURATED — hand-picked markets
 *   2. Featured — top global events by 24h volume
 *   3. Per-sport — NBA/NFL/MLB/NHL tag queries, so sport inventory isn't
 *      gated on cracking the global volume leaderboard
 *
 * Re-runs are idempotent: existing rows get probability/cutoff/score
 * refreshed but their on-chain leg ids are preserved (upsertMarket COALESCE).
 */
export async function GET(req: Request) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const gammaUrl = process.env.POLYMARKET_GAMMA_URL ?? "https://gamma-api.polymarket.com";
  const poly = new PolymarketClient({
    gammaUrl,
    clobUrl: process.env.POLYMARKET_CLOB_URL ?? "https://clob.polymarket.com",
  });

  const fetchResults = await Promise.allSettled([
    fetchFeaturedMarkets({ gammaUrl }),
    ...SPORT_TAGS.map((tag) => fetchSportEvents(tag, { gammaUrl })),
  ]);
  const remoteBatches = fetchResults.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    const label = i === 0 ? "featured" : SPORT_TAGS[i - 1];
    console.warn(`[polymarket/sync] ${label} fetch failed:`, r.reason);
    return [] as CuratedMarket[];
  });

  const seen = new Set<string>();
  const allMarkets: CuratedMarket[] = [];
  for (const entry of [...CURATED, ...remoteBatches.flat()]) {
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
  const curationScore = computeCurationScore({
    volume24hr: entry.volume24hr,
    ppm: yesPpm,
    cutoffSec,
    nowSec,
  });

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
    curationScore,
    gameGroup: entry.gameGroup ?? null,
  });
}

// Curation score formula + rationale: docs/POLYMARKET.md § Curation score
const URGENCY_WINDOW_HOURS = 168;

function computeCurationScore(args: {
  volume24hr: number | undefined;
  ppm: number;
  cutoffSec: number;
  nowSec: number;
}): number | null {
  const { volume24hr, ppm, cutoffSec, nowSec } = args;
  if (volume24hr == null || !Number.isFinite(volume24hr)) return null;

  const volumeScore = Math.min(
    1000,
    Math.max(0, Math.floor(Math.log10(Math.max(volume24hr, 1)) * 150)),
  );
  const balanceScore = Math.max(
    0,
    Math.floor(1000 * (1 - Math.abs(ppm - 500_000) / 500_000)),
  );
  const hoursToResolve = Math.max(0, (cutoffSec - nowSec) / 3600);
  const urgencyScore = Math.max(
    0,
    Math.floor(1000 * (1 - hoursToResolve / URGENCY_WINDOW_HOURS)),
  );

  return volumeScore + balanceScore + urgencyScore;
}

function bookMid(book: PolymarketOrderBook): number {
  const bestBid = book.bids.length > 0 ? Number(book.bids[0].price) : 0;
  const bestAsk = book.asks.length > 0 ? Number(book.asks[0].price) : 0;
  if (bestBid > 0 && bestAsk > 0) return (bestBid + bestAsk) / 2;
  if (bestBid > 0) return bestBid;
  if (bestAsk > 0) return bestAsk;
  throw new Error("empty orderbook");
}
