import { type MarketRow, getActiveMarkets } from "~~/lib/db/client";
import type { Leg, Market } from "~~/utils/parlay";
import { BPS, PPM, PROTOCOL_FEE_BPS } from "~~/utils/parlay";

/** A side is profitable if its post-fee multiplier exceeds 1.0 — i.e. winning
 *  pays out more than was staked. We use this to drop markets where neither
 *  side could ever profit; showing them is a UX trap (item #5). */
function isSideProfitable(probPpm: number | null, feeBps: number): boolean {
  if (probPpm == null || probPpm <= 0) return false;
  // multiplier = PPM / probPpm; post-fee factor = (BPS - feeBps) / BPS.
  // Profitable when (PPM / probPpm) * (BPS - feeBps) > BPS, i.e.
  //   probPpm * BPS < PPM * (BPS - feeBps)
  return probPpm * BPS < PPM * (BPS - feeBps);
}

// midToPpm clamps Polymarket prices to [10000, 990000] (= 1% / 99%). When
// either side hits a clamp boundary, the underlying market has effectively
// priced certainty on one outcome. Pre-game heavy favorites can sit at this
// boundary legitimately, so we don't hide on price alone — see
// `isPostGameSettled` below for the combined gate.
const CLAMP_FLOOR_PPM = 10_000;
const CLAMP_CEIL_PPM = 990_000;

// Sports lingering window: Polymarket usually flips `closed=true` within the
// game-end-to-resolution window, but there's a gap where the market still
// trades at ~99/1 splits. After 4h past first pitch the game is virtually
// guaranteed to be over (longest baseball games rarely top ~3.5h), so any
// lingering extreme-priced row is settled in everything-but-name.
const POST_GAME_LINGER_SECS = 4 * 60 * 60;

/** Three-way settled-but-not-closed signal:
 *   - Either side's price has clamped to the boundary (1% or 99%)
 *   - eventStart is known and ≥ 4h in the past
 *   - cutoff (when meaningfully in the future, i.e. not the gameStart+7d
 *     override) is also in the past — a redundant confirmation that gamma's
 *     own lifecycle treats the market as concluded
 *
 * Returns true when all available signals point to a settled market.
 * Markets with no eventStart (political / crypto / news) bypass this entirely
 * — they have their own end-of-life handling via `closed=true` →
 * `markPolyClosed`. */
function isPostGameSettled(row: MarketRow, nowSec: number): boolean {
  if (row.bigeventstart == null) return false;
  const postGame = row.bigeventstart + POST_GAME_LINGER_SECS < nowSec;
  if (!postGame) return false;
  const yesClamped =
    row.intyesprobppm != null && (row.intyesprobppm <= CLAMP_FLOOR_PPM || row.intyesprobppm >= CLAMP_CEIL_PPM);
  const noClamped =
    row.intnoprobppm != null && (row.intnoprobppm <= CLAMP_FLOOR_PPM || row.intnoprobppm >= CLAMP_CEIL_PPM);
  return yesClamped || noClamped;
}

/** One row per sourceRef with yes/no flattened. Display only — checkout re-verifies prices/leg-ids on-chain. */
export async function fetchMarketsFromDb(): Promise<Market[]> {
  const rows = await getActiveMarkets();
  if (rows.length === 0) return [];

  const markets: Market[] = [];
  let syntheticId = -1;
  const nextSynthetic = () => syntheticId--;

  const nowSec = Math.floor(Date.now() / 1000);
  for (const row of rows) {
    const yesProfitable = isSideProfitable(row.intyesprobppm, PROTOCOL_FEE_BPS);
    const noProfitable = isSideProfitable(row.intnoprobppm, PROTOCOL_FEE_BPS);
    if (!yesProfitable && !noProfitable) continue; // both sides dead money

    // Hide settled-but-not-yet-closed sports markets so the 1% certain-loser
    // side doesn't render as a free 100x against the vault while we wait for
    // Polymarket to flip closed=true.
    if (isPostGameSettled(row, nowSec)) continue;

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
  // pre-hashed by sync route on insert
  const exclusionId = row.bigexclusiongroup ?? 0;
  const leg: Leg = {
    id: yesId,
    question: row.txtquestion,
    sourceRef: row.txtsourceref,
    cutoffTime: row.bigcutofftime,
    earliestResolve: row.bigearliestresolve,
    probabilityPPM: row.intyesprobppm,
    active: true,
    correlationGroupId: corrId,
    exclusionGroupId: exclusionId,
    eventStart: row.bigeventstart ?? undefined,
    polymarketSlug: row.txtpolymarketslug ?? undefined,
    yesOutcome: row.txtyesoutcome ?? undefined,
    noOutcome: row.txtnooutcome ?? undefined,
    marketType: marketTypeFromRow(row.txtmarkettype),
    // Stored ×10 to fit INTEGER while preserving half-points; unscale here.
    line: row.intline == null ? undefined : row.intline / 10,
  };
  if (row.txtsource === "polymarket" && row.intnoprobppm != null) {
    leg.noId = row.intnolegid ?? nextSyntheticId();
    leg.noProbabilityPPM = row.intnoprobppm;
  }
  return leg;
}

// Narrow the loose TEXT column back to the union the UI expects. Anything
// outside the known set (or null) collapses to undefined so we fall through
// to plain Yes/No copy.
function marketTypeFromRow(raw: string | null): "moneyline" | "spreads" | "totals" | undefined {
  if (raw === "moneyline" || raw === "spreads" || raw === "totals") return raw;
  return undefined;
}

/** FNV-1a 32-bit hash. Used by both this file and sync route — must match. */
export function stableHash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Shape-sniff polymarket conditionId vs `seed:<id>` without threading txtsource everywhere. */
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
