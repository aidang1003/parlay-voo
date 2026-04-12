import { neon } from "@neondatabase/serverless";

/**
 * Neon HTTP client. One shared instance per server lambda.
 * Throws on first use if DATABASE_URL is missing so misconfiguration fails fast.
 */
let cached: ReturnType<typeof neon> | null = null;

export function sql() {
  if (!cached) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL is not set. See packages/nextjs/.env.example");
    }
    cached = neon(url);
  }
  return cached;
}

// ---------------------------------------------------------------------------
// Types — field names mirror DB column names (lowercase with type prefix)
// ---------------------------------------------------------------------------

export type LegSource = "seed" | "polymarket";
export type LegSide = "yes" | "no" | "na";

export interface LegMappingRow {
  txtsourceref: string;
  txtside: LegSide;
  txtsource: LegSource;
  intonchainlegid: number | null;
  txtquestion: string;
  txtcategory: string;
  intprobabilityppm: number;
  bigcutofftime: number;
  bigearliestresolve: number;
  blnactive: boolean;
  tscreatedat: string;
}

/**
 * Pivoted market shape: one row per txtsourceref, both sides flattened into
 * columns. Produced by the CASE/MAX aggregation in getActiveMarkets so the
 * app fetches all markets in a single round-trip.
 */
export interface MarketRow {
  txtsourceref: string;
  txtsource: LegSource;
  txtquestion: string;
  txtcategory: string;
  bigcutofftime: number;
  bigearliestresolve: number;
  yeslegid: number | null;
  yesprobppm: number | null;
  nolegid: number | null;
  noprobppm: number | null;
}

export interface ResolutionRow {
  txtconditionid: string;
  txtoutcome: "YES" | "NO" | "VOIDED";
  txtyestxhash: string | null;
  txtnotxhash: string | null;
  tsresolvedat: string;
}

// Neon's HTTP tagged template returns rows as Record<string, unknown>[]. We coerce
// numeric fields back to JS numbers here because Postgres BIGINT arrives as string.
function coerceLegRow(r: Record<string, unknown>): LegMappingRow {
  return {
    txtsourceref: r.txtsourceref as string,
    txtside: r.txtside as LegSide,
    txtsource: r.txtsource as LegSource,
    intonchainlegid: r.intonchainlegid == null ? null : Number(r.intonchainlegid),
    txtquestion: r.txtquestion as string,
    txtcategory: r.txtcategory as string,
    intprobabilityppm: Number(r.intprobabilityppm),
    bigcutofftime: Number(r.bigcutofftime),
    bigearliestresolve: Number(r.bigearliestresolve),
    blnactive: r.blnactive as boolean,
    tscreatedat: r.tscreatedat as string,
  };
}

function coerceMarketRow(r: Record<string, unknown>): MarketRow {
  const toNum = (v: unknown) => (v == null ? null : Number(v));
  return {
    txtsourceref: r.txtsourceref as string,
    txtsource: r.txtsource as LegSource,
    txtquestion: r.txtquestion as string,
    txtcategory: r.txtcategory as string,
    bigcutofftime: Number(r.bigcutofftime),
    bigearliestresolve: Number(r.bigearliestresolve),
    yeslegid: toNum(r.yeslegid),
    yesprobppm: toNum(r.yesprobppm),
    nolegid: toNum(r.nolegid),
    noprobppm: toNum(r.noprobppm),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Active legs that are also registered on-chain (intonchainlegid IS NOT NULL).
 * Use for operations that need real on-chain IDs (settlement, MCP tools).
 */
export async function getRegisteredActiveLegs(): Promise<LegMappingRow[]> {
  const db = sql();
  const rows = await db`
    SELECT * FROM tblegmapping
    WHERE blnactive = true AND intonchainlegid IS NOT NULL
    ORDER BY intonchainlegid
  `;
  return (rows as Record<string, unknown>[]).map(coerceLegRow);
}

/**
 * All markets, one row per txtsourceref with yes/no sides pivoted into columns.
 * Single round-trip: Postgres does the group-by so the app avoids N+1. For
 * seed legs (side 'na') the "yes" columns carry the single leg data and the
 * "no" columns are null — frontend hides the No button when nolegid is absent.
 * Seed legs now expose their 'na' side via the yes* columns so a single query
 * handles both sources.
 */
export async function getActiveMarkets(): Promise<MarketRow[]> {
  const db = sql();
  const rows = await db`
    SELECT
      txtsourceref,
      MAX(txtsource)                                                                AS txtsource,
      MAX(txtquestion)                                                              AS txtquestion,
      MAX(txtcategory)                                                              AS txtcategory,
      MAX(bigcutofftime)                                                            AS bigcutofftime,
      MAX(bigearliestresolve)                                                       AS bigearliestresolve,
      MAX(CASE WHEN txtside IN ('yes', 'na') THEN intonchainlegid   END)            AS yeslegid,
      MAX(CASE WHEN txtside IN ('yes', 'na') THEN intprobabilityppm END)            AS yesprobppm,
      MAX(CASE WHEN txtside = 'no'           THEN intonchainlegid   END)            AS nolegid,
      MAX(CASE WHEN txtside = 'no'           THEN intprobabilityppm END)            AS noprobppm
    FROM tblegmapping
    WHERE blnactive = true
    GROUP BY txtsourceref
    ORDER BY txtsourceref
  `;
  return (rows as Record<string, unknown>[]).map(coerceMarketRow);
}

export interface UpsertLegInput {
  sourceRef: string;
  side: LegSide;
  source: LegSource;
  onChainLegId: number | null;
  question: string;
  category: string;
  probabilityPpm: number;
  cutoffTime: number;
  earliestResolve: number;
  active?: boolean;
}

/**
 * Upsert into tblegmapping. The polymarket sync passes onChainLegId=null for
 * new rows; the registration script later populates it. For seed and registered
 * polymarket rows we pass the real id.
 *
 * NOTE: on conflict we deliberately do NOT overwrite intonchainlegid with NULL
 * -- once a leg is registered on-chain, sync re-runs must not wipe it.
 */
export async function upsertLegMapping(input: UpsertLegInput): Promise<void> {
  const db = sql();
  await db`
    INSERT INTO tblegmapping (
      txtsourceref, txtside, txtsource, intonchainlegid, txtquestion, txtcategory,
      intprobabilityppm, bigcutofftime, bigearliestresolve, blnactive
    ) VALUES (
      ${input.sourceRef}, ${input.side}, ${input.source}, ${input.onChainLegId}, ${input.question}, ${input.category},
      ${input.probabilityPpm}, ${input.cutoffTime}, ${input.earliestResolve}, ${input.active ?? true}
    )
    ON CONFLICT (txtsourceref, txtside) DO UPDATE SET
      intonchainlegid    = COALESCE(tblegmapping.intonchainlegid, EXCLUDED.intonchainlegid),
      txtquestion        = EXCLUDED.txtquestion,
      txtcategory        = EXCLUDED.txtcategory,
      intprobabilityppm  = EXCLUDED.intprobabilityppm,
      bigcutofftime      = EXCLUDED.bigcutofftime,
      bigearliestresolve = EXCLUDED.bigearliestresolve,
      blnactive          = EXCLUDED.blnactive
  `;
}
