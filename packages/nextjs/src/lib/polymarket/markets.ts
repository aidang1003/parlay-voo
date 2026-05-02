import type { Market, Leg } from "@parlayvoo/shared";
import { PPM } from "@parlayvoo/shared";
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
        gameGroup: row.txtgamegroup ?? undefined,
      });
    } else {
      // polymarket: needs no-side prob to render the No button
      if (row.intnoprobppm == null) continue;
      markets.push({
        id: row.txtsourceref,
        title: row.txtquestion,
        description: `Polymarket market ${row.txtsourceref.slice(0, 10)}...`,
        category: row.txtcategory,
        legs: [rowToLeg(row, nextSynthetic)],
        gameGroup: row.txtgamegroup ?? undefined,
      });
    }
  }

  return markets;
}

function rowToLeg(row: MarketRow, nextSyntheticId: () => number): Leg {
  const yesId = row.intyeslegid ?? nextSyntheticId();
  const corrId = row.txtgamegroup ? stableHash32(`game:${row.txtgamegroup}`) : 0;
  const leg: Leg = {
    id: yesId,
    question: row.txtquestion,
    sourceRef: row.txtsourceref,
    cutoffTime: row.bigcutofftime,
    earliestResolve: row.bigearliestresolve,
    probabilityPPM: row.intyesprobppm,
    active: true,
    correlationGroupId: corrId,
    exclusionGroupId: 0,
  };
  if (row.txtsource === "polymarket" && row.intnoprobppm != null) {
    leg.noId = row.intnolegid ?? nextSyntheticId();
    leg.noProbabilityPPM = row.intnoprobppm;
  }
  return leg;
}

/** FNV-1a 32-bit hash of a string. Stable across runs and platforms; used to
 *  turn a string game-group key into the numeric correlationGroupId the
 *  on-chain registry expects. */
function stableHash32(input: string): number {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0; // FNV prime, keep unsigned
  }
  return h >>> 0;
}

/** Polymarket sourceRefs are the raw conditionId: a 0x-prefixed 32-byte hex.
 *  Seed refs look like `seed:<id>`. Shape-sniff so callers can branch without
 *  threading the `txtsource` column through every surface. */
export function parsePolySourceRef(sourceRef: string): { conditionId: string } | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(sourceRef)) return null;
  return { conditionId: sourceRef };
}

/** Convert a Polymarket mid-price (0..1) to clamped PPM. */
export function midToPpm(mid: number): number {
  if (!Number.isFinite(mid) || mid <= 0 || mid >= 1) {
    throw new Error(`midToPpm: out-of-range mid ${mid}`);
  }
  const raw = Math.round(mid * PPM);
  return Math.min(990_000, Math.max(10_000, raw));
}
