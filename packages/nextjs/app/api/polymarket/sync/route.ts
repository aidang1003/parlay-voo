import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "~~/lib/cron-auth";
import { markPolyClosed, upsertMarket } from "~~/lib/db/client";
import { PolymarketClient } from "~~/lib/polymarket/client";
import { midToPpm, stableHash32 } from "~~/lib/polymarket/markets";
import {
  CURATED,
  type CuratedMarket,
  type PolymarketOrderBook,
  fetchFeaturedMarkets,
  fetchMlbGames,
  fetchSportEvents,
} from "~~/utils/parlay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// MLB has its own fetcher (gamma /markets with sportsMarketType filter) that
// emits structured per-game ML / spread / total rows — see utils/parlay/polymarket/mlb.ts.
// The remaining sports still go through the generic /events tag_slug path.
const NON_MLB_SPORT_TAGS = ["nba", "nfl", "nhl"] as const;

// Idempotent: refreshes prices/cutoff/score; preserves leg ids/question/category/earliestResolve on conflict.
export async function GET(req: Request) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const gammaUrl = process.env.POLYMARKET_GAMMA_URL ?? "https://gamma-api.polymarket.com";
  const poly = new PolymarketClient({
    gammaUrl,
    clobUrl: process.env.POLYMARKET_CLOB_URL ?? "https://clob.polymarket.com",
  });

  // MLB runs first so its structured (ML / spread / total) rows win the
  // dedupe over any incidental MLB markets that sneak in via the volume-ranked
  // /events fetch — see seen.has() check below.
  const labels = ["mlb", "featured", ...NON_MLB_SPORT_TAGS] as const;
  const fetchResults = await Promise.allSettled([
    fetchMlbGames({ gammaUrl }),
    fetchFeaturedMarkets({ gammaUrl }),
    ...NON_MLB_SPORT_TAGS.map(tag => fetchSportEvents(tag, { gammaUrl })),
  ]);
  const remoteBatches = fetchResults.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    console.warn(`[polymarket/sync] ${labels[i]} fetch failed:`, r.reason);
    return [] as CuratedMarket[];
  });

  const seen = new Set<string>();
  const allMarkets: CuratedMarket[] = [];
  for (const entry of [...CURATED, ...remoteBatches.flat()]) {
    if (seen.has(entry.conditionId)) continue;
    seen.add(entry.conditionId);
    allMarkets.push(entry);
  }

  const result = { upserted: 0, skipped: 0, closed: 0, errors: [] as string[], total: allMarkets.length };

  for (const entry of allMarkets) {
    try {
      const action = await syncOne(entry, poly);
      if (action === "closed") result.closed++;
      else result.upserted++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push(`${entry.conditionId.slice(0, 10)}: ${msg}`);
      result.skipped++;
    }
  }

  return NextResponse.json(result);
}

async function syncOne(entry: CuratedMarket, poly: PolymarketClient): Promise<"upserted" | "closed"> {
  const metadata = await poly.fetchMarket(entry.conditionId);
  if (metadata.closed || metadata.archived) {
    await markPolyClosed(entry.conditionId);
    return "closed";
  }

  const cutoffSec = Math.floor(new Date(metadata.endDateIso).getTime() / 1000);
  const nowSec = Math.floor(Date.now() / 1000);
  if (cutoffSec <= nowSec + 3600) {
    throw new Error(`cutoff too soon (${cutoffSec - nowSec}s)`);
  }
  const earliestResolve = cutoffSec + 48 * 3600;

  // Gamma prices avoid thin-book clamping from per-token orderbook mid
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

  // negRisk events: at most one child resolves YES — hash eventId into a stable exclusion group
  const exclusionGroupId = entry.negRisk && entry.eventId ? stableHash32(`negrisk:${entry.eventId}`) : 0;

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
    curationScore,
    gameGroup: entry.gameGroup ?? null,
    exclusionGroupId,
    eventStart: entry.eventStart ?? null,
    polymarketSlug: entry.polymarketSlug ?? null,
    yesOutcome: entry.yesOutcome ?? null,
    noOutcome: entry.noOutcome ?? null,
    marketType: entry.marketType ?? null,
    line: entry.line ?? null,
  });
  return "upserted";
}

// formula: docs/POLYMARKET.md § Curation score
const URGENCY_WINDOW_HOURS = 168;

function computeCurationScore(args: {
  volume24hr: number | undefined;
  ppm: number;
  cutoffSec: number;
  nowSec: number;
}): number | null {
  const { volume24hr, ppm, cutoffSec, nowSec } = args;
  if (volume24hr == null || !Number.isFinite(volume24hr)) return null;

  const volumeScore = Math.min(1000, Math.max(0, Math.floor(Math.log10(Math.max(volume24hr, 1)) * 150)));
  const balanceScore = Math.max(0, Math.floor(1000 * (1 - Math.abs(ppm - 500_000) / 500_000)));
  const hoursToResolve = Math.max(0, (cutoffSec - nowSec) / 3600);
  const urgencyScore = Math.max(0, Math.floor(1000 * (1 - hoursToResolve / URGENCY_WINDOW_HOURS)));

  return volumeScore + balanceScore + urgencyScore;
}

function bookMid(book: PolymarketOrderBook): number {
  // /book sort order is undocumented — take max(bids) / min(asks)
  const bidPrices = book.bids.map(b => Number(b.price)).filter(p => Number.isFinite(p) && p > 0);
  const askPrices = book.asks.map(a => Number(a.price)).filter(p => Number.isFinite(p) && p > 0);
  const bestBid = bidPrices.length > 0 ? Math.max(...bidPrices) : 0;
  const bestAsk = askPrices.length > 0 ? Math.min(...askPrices) : 0;
  if (bestBid > 0 && bestAsk > 0) {
    if (bestAsk <= bestBid) throw new Error("inverted orderbook");
    return (bestBid + bestAsk) / 2;
  }
  if (bestBid > 0) return bestBid;
  if (bestAsk > 0) return bestAsk;
  throw new Error("empty orderbook");
}
