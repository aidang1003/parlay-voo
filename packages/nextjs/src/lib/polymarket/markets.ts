import type { Market, Leg } from "@parlaycity/shared";
import { PPM } from "@parlaycity/shared";
import { getAllActiveLegs, type LegMappingRow } from "@/lib/db/client";

/**
 * Build Market[] for /api/markets directly from leg_mapping. One DB read,
 * grouped by source-specific keys:
 *   - polymarket legs: grouped by condition_id (yes + no into one Market)
 *   - seed legs: each row becomes its own single-leg Market (matches the
 *     legacy seed catalog shape)
 *
 * Includes legs pending on-chain registration (on_chain_leg_id IS NULL).
 * Those get synthetic negative IDs so they render on the frontend with an
 * "Analysis Only" badge until registered on-chain.
 */
export async function fetchMarketsFromDb(): Promise<Market[]> {
  const rows = await getAllActiveLegs();
  if (rows.length === 0) return [];

  const polyByCid = new Map<string, { yes?: LegMappingRow; no?: LegMappingRow }>();
  const seedRows: LegMappingRow[] = [];

  for (const row of rows) {
    if (row.source === "polymarket") {
      const parsed = parsePolySourceRef(row.source_ref);
      if (!parsed) continue;
      const bucket = polyByCid.get(parsed.conditionId) ?? {};
      bucket[parsed.side] = row;
      polyByCid.set(parsed.conditionId, bucket);
    } else {
      seedRows.push(row);
    }
  }

  const markets: Market[] = [];
  let syntheticId = -1;

  for (const row of seedRows) {
    markets.push({
      id: `seed:${row.on_chain_leg_id ?? row.source_ref}`,
      title: row.question,
      description: row.question,
      category: row.category,
      legs: [rowToLeg(row, undefined, () => syntheticId--)],
    });
  }

  for (const [conditionId, { yes, no }] of polyByCid) {
    if (!yes || !no) continue; // skip half-synced markets
    markets.push({
      id: `poly:${conditionId}`,
      title: yes.question,
      description: `Polymarket market ${conditionId.slice(0, 10)}...`,
      category: yes.category,
      legs: [
        rowToLeg(yes, "YES", () => syntheticId--),
        rowToLeg(no, "NO", () => syntheticId--),
      ],
    });
  }

  return markets;
}

function rowToLeg(
  row: LegMappingRow,
  sideLabel?: "YES" | "NO",
  nextSyntheticId?: () => number,
): Leg {
  // Real on-chain ID if registered, otherwise a synthetic negative ID
  // so the frontend can display it (negative IDs never collide with real ones).
  const id = row.on_chain_leg_id ?? nextSyntheticId?.() ?? -1;
  return {
    id,
    question: sideLabel ? `${row.question} — ${sideLabel}` : row.question,
    sourceRef: row.source_ref,
    cutoffTime: row.cutoff_time,
    earliestResolve: row.earliest_resolve,
    probabilityPPM: row.probability_ppm,
    active: row.active,
  };
}

export function parsePolySourceRef(
  sourceRef: string,
): { conditionId: string; side: "yes" | "no" } | null {
  const m = sourceRef.match(/^poly:(.+):(yes|no)$/);
  if (!m) return null;
  return { conditionId: m[1], side: m[2] as "yes" | "no" };
}

/** Convert a Polymarket mid-price (0..1) to clamped PPM. */
export function midToPpm(mid: number): number {
  if (!Number.isFinite(mid) || mid <= 0 || mid >= 1) {
    throw new Error(`midToPpm: out-of-range mid ${mid}`);
  }
  const raw = Math.round(mid * PPM);
  return Math.min(950_000, Math.max(50_000, raw));
}
