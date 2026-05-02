import { type Hex } from "viem";
import type { PolymarketOrderBook } from "@parlayvoo/shared";
import { getActiveMarkets } from "@/lib/db/client";
import { PolymarketClient } from "@/lib/polymarket/client";
import { parsePolySourceRef, midToPpm } from "@/lib/polymarket/markets";

export const YES_OUTCOME = ("0x" + "01".padStart(64, "0")) as Hex;
export const NO_OUTCOME = ("0x" + "02".padStart(64, "0")) as Hex;

export type LegSide = "yes" | "no";

export interface LegInput {
  sourceRef: string;
  side: LegSide;
}

export interface BuiltLeg {
  sourceRef: string;
  side: LegSide;
  outcome: Hex;
  probabilityPPM: number;
  cutoffTime: number;
  earliestResolve: number;
}

/** Shared between /api/quote-sign (signs + returns) and /api/quote-preview
 *  (returns live pricing so the UI can periodically refresh leg odds before
 *  buy). Refreshes CLOB mid for polymarket legs; falls back to the DB PPM if
 *  Polymarket is flaky. Throws on unknown sourceRef or no-side unavailable so
 *  callers can return a 400. */
export async function buildLegs(inputs: LegInput[]): Promise<BuiltLeg[]> {
  const markets = await getActiveMarkets();
  const bySourceRef = new Map(markets.map((m) => [m.txtsourceref, m]));

  const poly = new PolymarketClient({
    gammaUrl: process.env.POLYMARKET_GAMMA_URL ?? "https://gamma-api.polymarket.com",
    clobUrl: process.env.POLYMARKET_CLOB_URL ?? "https://clob.polymarket.com",
  });

  const built: BuiltLeg[] = [];
  for (const leg of inputs) {
    const row = bySourceRef.get(leg.sourceRef);
    if (!row) throw new LegBuildError(400, `unknown leg ${leg.sourceRef}`);

    const isNo = leg.side === "no";
    if (isNo && row.intnoprobppm == null) {
      throw new LegBuildError(400, `no-side unavailable for ${leg.sourceRef}`);
    }

    // Default PPM from DB (already YES-side; contract flips for no-bets).
    let yesPpm = row.intyesprobppm;

    if (row.txtsource === "polymarket") {
      const parsed = parsePolySourceRef(leg.sourceRef);
      if (parsed) {
        try {
          const market = await poly.fetchMarket(parsed.conditionId);
          const book = await poly.fetchOrderBook(market.yesTokenId);
          const mid = bookMidPpm(book);
          if (mid != null) yesPpm = mid;
        } catch {
          // Swallow — fall back to DB PPM so a flaky CLOB doesn't break the flow.
        }
      }
    }

    built.push({
      sourceRef: leg.sourceRef,
      side: leg.side,
      outcome: isNo ? NO_OUTCOME : YES_OUTCOME,
      probabilityPPM: yesPpm,
      cutoffTime: row.bigcutofftime,
      earliestResolve: row.bigearliestresolve,
    });
  }

  return built;
}

export class LegBuildError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "LegBuildError";
  }
}

/** Best-bid / best-ask mid in PPM, or null if the book is unusable.
 *
 *  Polymarket's CLOB `/book` endpoint returns bids and asks as plain arrays
 *  with no documented sort order, so we don't trust `[0]` to be the top of
 *  book — we take max of bids and min of asks regardless of input order.
 *  Crossed/inverted books (best ask <= best bid) are stale fetches and are
 *  rejected so callers fall back to the DB PPM rather than computing a
 *  nonsense mid (e.g. dust orders straddling a dead market → 50/50). */
export function bookMidPpm(book: PolymarketOrderBook): number | null {
  const bids = book.bids
    .map((b) => Number(b.price))
    .filter((p) => Number.isFinite(p) && p > 0);
  const asks = book.asks
    .map((a) => Number(a.price))
    .filter((p) => Number.isFinite(p) && p > 0);
  if (bids.length === 0 || asks.length === 0) return null;
  const bestBid = Math.max(...bids);
  const bestAsk = Math.min(...asks);
  if (bestAsk <= bestBid) return null;
  return midToPpm((bestBid + bestAsk) / 2);
}
