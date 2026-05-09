import { type Hex } from "viem";
import { getActiveMarkets } from "~~/lib/db/client";
import { PolymarketClient } from "~~/lib/polymarket/client";
import { midToPpm, parsePolySourceRef } from "~~/lib/polymarket/markets";
import {
  type PolymarketOrderBook,
  NO_OUTCOME as SHARED_NO_OUTCOME,
  YES_OUTCOME as SHARED_YES_OUTCOME,
} from "~~/utils/parlay";

export const YES_OUTCOME = SHARED_YES_OUTCOME as Hex;
export const NO_OUTCOME = SHARED_NO_OUTCOME as Hex;

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

/** Refreshes CLOB mid for polymarket legs; throws LegBuildError on unknown
 *  sourceRef, missing no-side, or stale cutoff. Logs each leg's resolution
 *  to stdout so a chain revert with "cutoff passed" can be traced back to
 *  the exact row in the DB. */
export async function buildLegs(inputs: LegInput[]): Promise<BuiltLeg[]> {
  const markets = await getActiveMarkets();
  const bySourceRef = new Map(markets.map(m => [m.txtsourceref, m]));
  const nowSec = Math.floor(Date.now() / 1000);

  const poly = new PolymarketClient({
    gammaUrl: process.env.POLYMARKET_GAMMA_URL ?? "https://gamma-api.polymarket.com",
    clobUrl: process.env.POLYMARKET_CLOB_URL ?? "https://clob.polymarket.com",
  });

  console.log(`[buildLegs] resolving ${inputs.length} legs at nowSec=${nowSec}`);

  const built: BuiltLeg[] = [];
  for (const leg of inputs) {
    const row = bySourceRef.get(leg.sourceRef);
    if (!row) {
      console.warn(
        `[buildLegs] unknown sourceRef=${leg.sourceRef.slice(0, 12)}… ` +
          `(active set has ${markets.length} rows; sync may not have caught up)`,
      );
      throw new LegBuildError(400, `unknown leg ${leg.sourceRef}`);
    }

    // Defensive: refuse to sign a quote whose cutoff is already in the past.
    // Prevents the on-chain "cutoff passed" revert from masking what's
    // really happening — the API now returns 409 with the offending values
    // so the network tab tells us the story.
    const cutoffDeltaSec = row.bigcutofftime - nowSec;
    if (cutoffDeltaSec <= 0) {
      console.warn(
        `[buildLegs] CUTOFF IN PAST sourceRef=${leg.sourceRef.slice(0, 12)}… ` +
          `bigcutofftime=${row.bigcutofftime} nowSec=${nowSec} delta=${cutoffDeltaSec}s ` +
          `(question="${row.txtquestion.slice(0, 50)}", source=${row.txtsource}, ` +
          `eventStart=${row.bigeventstart ?? "null"})`,
      );
      throw new LegBuildError(
        409,
        `leg cutoff has passed for ${leg.sourceRef.slice(0, 12)}… ` +
          `(cutoff was ${new Date(row.bigcutofftime * 1000).toISOString()}, now is ` +
          `${new Date(nowSec * 1000).toISOString()}). Re-sync needed.`,
      );
    }

    const isNo = leg.side === "no";
    if (isNo && row.intnoprobppm == null) {
      console.warn(`[buildLegs] no-side unavailable sourceRef=${leg.sourceRef.slice(0, 12)}…`);
      throw new LegBuildError(400, `no-side unavailable for ${leg.sourceRef}`);
    }

    // DB PPM is YES-side; contract flips for no-bets
    let yesPpm = row.intyesprobppm;
    let priceSource: "db" | "clob" | "clob-failed" = "db";

    if (row.txtsource === "polymarket") {
      const parsed = parsePolySourceRef(leg.sourceRef);
      if (parsed) {
        try {
          const market = await poly.fetchMarket(parsed.conditionId);
          const book = await poly.fetchOrderBook(market.yesTokenId);
          const mid = bookMidPpm(book);
          if (mid != null) {
            yesPpm = mid;
            priceSource = "clob";
          } else {
            priceSource = "clob-failed";
          }
        } catch (e) {
          // Swallow — fall back to DB PPM so a flaky CLOB doesn't break the flow.
          priceSource = "clob-failed";
          console.warn(
            `[buildLegs] CLOB fetch failed for ${leg.sourceRef.slice(0, 12)}…: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }

    console.log(
      `[buildLegs] ok sourceRef=${leg.sourceRef.slice(0, 12)}… side=${leg.side} ` +
        `yesPpm=${yesPpm} (from ${priceSource}) cutoffIn=${cutoffDeltaSec}s ` +
        `earliestResolve=${row.bigearliestresolve}`,
    );

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
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "LegBuildError";
  }
}

/** /book sort order is undocumented so take max(bids)/min(asks); crossed books reject so caller falls back to DB PPM. */
export function bookMidPpm(book: PolymarketOrderBook): number | null {
  const bids = book.bids.map(b => Number(b.price)).filter(p => Number.isFinite(p) && p > 0);
  const asks = book.asks.map(a => Number(a.price)).filter(p => Number.isFinite(p) && p > 0);
  if (bids.length === 0 || asks.length === 0) return null;
  const bestBid = Math.max(...bids);
  const bestAsk = Math.min(...asks);
  if (bestAsk <= bestBid) return null;
  return midToPpm((bestBid + bestAsk) / 2);
}
