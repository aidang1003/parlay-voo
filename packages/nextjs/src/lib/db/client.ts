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
// Types — one row per market, yes/no sides as sibling columns.
// ---------------------------------------------------------------------------

export type LegSource = "seed" | "polymarket";

export interface MarketRow {
  txtsourceref: string;
  txtsource: LegSource;
  txtquestion: string;
  txtcategory: string;
  intyeslegid: number | null;
  intnolegid: number | null;
  intyesprobppm: number;
  intnoprobppm: number | null;
  bigcutofftime: number;
  bigearliestresolve: number;
  blnactive: boolean;
  tscreatedat: string;
}

export interface ResolutionRow {
  txtconditionid: string;
  txtoutcome: "YES" | "NO" | "VOIDED";
  txtyestxhash: string | null;
  txtnotxhash: string | null;
  tsresolvedat: string;
}

function coerceMarketRow(r: Record<string, unknown>): MarketRow {
  const toNumOrNull = (v: unknown) => (v == null ? null : Number(v));
  return {
    txtsourceref: r.txtsourceref as string,
    txtsource: r.txtsource as LegSource,
    txtquestion: r.txtquestion as string,
    txtcategory: r.txtcategory as string,
    intyeslegid: toNumOrNull(r.intyeslegid),
    intnolegid: toNumOrNull(r.intnolegid),
    intyesprobppm: Number(r.intyesprobppm),
    intnoprobppm: toNumOrNull(r.intnoprobppm),
    bigcutofftime: Number(r.bigcutofftime),
    bigearliestresolve: Number(r.bigearliestresolve),
    blnactive: r.blnactive as boolean,
    tscreatedat: r.tscreatedat as string,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * All active markets, one row each. Single round-trip.
 */
export async function getActiveMarkets(): Promise<MarketRow[]> {
  const db = sql();
  const rows = await db`
    SELECT * FROM tblegmapping
    WHERE blnactive = true
    ORDER BY txtsourceref
  `;
  return (rows as Record<string, unknown>[]).map(coerceMarketRow);
}

/**
 * Markets with at least one on-chain-registered leg id. Used by MCP tools
 * to know which legs have already been materialized on-chain.
 */
export async function getRegisteredActiveMarkets(): Promise<MarketRow[]> {
  const db = sql();
  const rows = await db`
    SELECT * FROM tblegmapping
    WHERE blnactive = true
      AND (intyeslegid IS NOT NULL OR intnolegid IS NOT NULL)
    ORDER BY txtsourceref
  `;
  return (rows as Record<string, unknown>[]).map(coerceMarketRow);
}

export interface UpsertMarketInput {
  sourceRef: string;
  source: LegSource;
  question: string;
  category: string;
  yesLegId: number | null;
  noLegId: number | null;
  yesProbabilityPpm: number;
  noProbabilityPpm: number | null;
  cutoffTime: number;
  earliestResolve: number;
  active?: boolean;
}

/**
 * Upsert a market row. On conflict we refresh probs/cutoff/etc. but preserve
 * any existing on-chain leg ids (sync must never clobber a registered id with
 * NULL once set).
 */
export async function upsertMarket(input: UpsertMarketInput): Promise<void> {
  const db = sql();
  await db`
    INSERT INTO tblegmapping (
      txtsourceref, txtsource, txtquestion, txtcategory,
      intyeslegid, intnolegid, intyesprobppm, intnoprobppm,
      bigcutofftime, bigearliestresolve, blnactive
    ) VALUES (
      ${input.sourceRef}, ${input.source}, ${input.question}, ${input.category},
      ${input.yesLegId}, ${input.noLegId}, ${input.yesProbabilityPpm}, ${input.noProbabilityPpm},
      ${input.cutoffTime}, ${input.earliestResolve}, ${input.active ?? true}
    )
    ON CONFLICT (txtsourceref) DO UPDATE SET
      intyeslegid        = COALESCE(tblegmapping.intyeslegid, EXCLUDED.intyeslegid),
      intnolegid         = COALESCE(tblegmapping.intnolegid,  EXCLUDED.intnolegid),
      txtquestion        = EXCLUDED.txtquestion,
      txtcategory        = EXCLUDED.txtcategory,
      intyesprobppm      = EXCLUDED.intyesprobppm,
      intnoprobppm       = EXCLUDED.intnoprobppm,
      bigcutofftime      = EXCLUDED.bigcutofftime,
      bigearliestresolve = EXCLUDED.bigearliestresolve,
      blnactive          = EXCLUDED.blnactive
  `;
}
