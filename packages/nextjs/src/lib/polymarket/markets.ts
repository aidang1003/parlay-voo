import type { Market, Leg } from "@parlaycity/shared";
import { PPM } from "@parlaycity/shared";
import { getActiveMarkets, type MarketRow } from "@/lib/db/client";

/**
 * Build Market[] for /api/markets from the pivoted getActiveMarkets query.
 * One DB round-trip returns one row per txtsourceref with yes/no sides
 * flattened into columns. Each Market carries a single Leg whose `id`/`noId`
 * identify the two on-chain legs (seed markets omit noId so the Yes/No card
 * renders the No button only when it's meaningful).
 *
 * DB rows are the source of truth for display. A price/leg-id verification
 * runs later at parlay checkout; this layer doesn't gate on on-chain status.
 */
export async function fetchMarketsFromDb(): Promise<Market[]> {
  const rows = await getActiveMarkets();
  if (rows.length === 0) return [];

  const markets: Market[] = [];
  let syntheticId = -1;
  const nextSynthetic = () => syntheticId--;

  for (const row of rows) {
    if (row.txtsource === "seed") {
      markets.push({
        id: row.txtsourceref,
        title: row.txtquestion,
        description: row.txtquestion,
        category: row.txtcategory,
        legs: [rowToLeg(row, nextSynthetic)],
      });
    } else {
      // polymarket: needs both sides present to build a yes/no card
      if (row.yesprobppm == null || row.noprobppm == null) continue;
      const conditionId = row.txtsourceref.replace(/^poly:/, "");
      markets.push({
        id: row.txtsourceref,
        title: row.txtquestion,
        description: `Polymarket market ${conditionId.slice(0, 10)}...`,
        category: row.txtcategory,
        legs: [rowToLeg(row, nextSynthetic)],
      });
    }
  }

  return markets;
}

function rowToLeg(row: MarketRow, nextSyntheticId: () => number): Leg {
  const yesId = row.yeslegid ?? nextSyntheticId();
  const leg: Leg = {
    id: yesId,
    question: row.txtquestion,
    sourceRef: row.txtsourceref,
    cutoffTime: row.bigcutofftime,
    earliestResolve: row.bigearliestresolve,
    probabilityPPM: row.yesprobppm ?? 500_000,
    active: true,
  };
  if (row.txtsource === "polymarket") {
    leg.noId = row.nolegid ?? nextSyntheticId();
    leg.noProbabilityPPM = row.noprobppm ?? 500_000;
  }
  return leg;
}

export function parsePolySourceRef(sourceRef: string): { conditionId: string } | null {
  const m = sourceRef.match(/^poly:([^:]+)$/);
  if (!m) return null;
  return { conditionId: m[1] };
}

/** Convert a Polymarket mid-price (0..1) to clamped PPM. */
export function midToPpm(mid: number): number {
  if (!Number.isFinite(mid) || mid <= 0 || mid >= 1) {
    throw new Error(`midToPpm: out-of-range mid ${mid}`);
  }
  const raw = Math.round(mid * PPM);
  return Math.min(950_000, Math.max(50_000, raw));
}
