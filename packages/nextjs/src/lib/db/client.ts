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

// One row per market, yes/no sides as sibling columns.
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
  jsonbapipayload: unknown | null;
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
    jsonbapipayload: r.jsonbapipayload ?? null,
    tscreatedat: r.tscreatedat as string,
  };
}

export async function getActiveMarkets(): Promise<MarketRow[]> {
  const db = sql();
  const rows = await db`
    SELECT * FROM tblegmapping
    WHERE blnactive = true
    ORDER BY txtsourceref
  `;
  return (rows as Record<string, unknown>[]).map(coerceMarketRow);
}

/** Markets with at least one on-chain-registered leg id. */
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
  /** Raw Gamma event payload to stash alongside the scalars. Null is fine —
   *  seed rows have nothing to carry. On conflict, non-null updates win so a
   *  refresh keeps the payload fresh, but a NULL refresh won't wipe an
   *  existing payload. */
  apiPayload?: unknown | null;
}

/**
 * Upsert a market row. On conflict we refresh probs/cutoff/etc. but preserve
 * any existing on-chain leg ids (sync must never clobber a registered id with
 * NULL once set).
 */
export async function upsertMarket(input: UpsertMarketInput): Promise<void> {
  const db = sql();
  const payloadJson =
    input.apiPayload == null ? null : JSON.stringify(input.apiPayload);
  await db`
    INSERT INTO tblegmapping (
      txtsourceref, txtsource, txtquestion, txtcategory,
      intyeslegid, intnolegid, intyesprobppm, intnoprobppm,
      bigcutofftime, bigearliestresolve, blnactive, jsonbapipayload
    ) VALUES (
      ${input.sourceRef}, ${input.source}, ${input.question}, ${input.category},
      ${input.yesLegId}, ${input.noLegId}, ${input.yesProbabilityPpm}, ${input.noProbabilityPpm},
      ${input.cutoffTime}, ${input.earliestResolve}, ${input.active ?? true},
      ${payloadJson}::jsonb
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
      blnactive          = EXCLUDED.blnactive,
      jsonbapipayload    = COALESCE(EXCLUDED.jsonbapipayload, tblegmapping.jsonbapipayload)
  `;
}

/**
 * Polymarket-sourced markets not yet relayed to AdminOracleAdapter. The
 * tbpolymarketresolution row acts as the idempotency gate — once inserted,
 * the market won't be picked up again. We don't filter on intyeslegid here
 * because the JIT engine creates legs on-chain at ticket-buy time without
 * writing back to the DB; the settlement route resolves the on-chain legId
 * directly via LegRegistry.legIdBySourceRef().
 */
export async function getUnresolvedPolymarketLegs(): Promise<MarketRow[]> {
  const db = sql();
  const rows = await db`
    SELECT m.* FROM tblegmapping m
    LEFT JOIN tbpolymarketresolution r
      ON r.txtconditionid = substr(m.txtsourceref, 6)
    WHERE m.txtsource = 'polymarket'
      AND m.blnactive = true
      AND r.txtconditionid IS NULL
    ORDER BY m.txtsourceref
  `;
  return (rows as Record<string, unknown>[]).map(coerceMarketRow);
}

export interface RecordResolutionInput {
  conditionId: string;
  outcome: "YES" | "NO" | "VOIDED";
  yesTxHash: string | null;
  noTxHash: string | null;
}

/**
 * Write the audit row. Idempotent on conditionId — re-runs are a no-op.
 */
export async function recordResolution(input: RecordResolutionInput): Promise<void> {
  const db = sql();
  await db`
    INSERT INTO tbpolymarketresolution (txtconditionid, txtoutcome, txtyestxhash, txtnotxhash)
    VALUES (${input.conditionId}, ${input.outcome}, ${input.yesTxHash}, ${input.noTxHash})
    ON CONFLICT (txtconditionid) DO NOTHING
  `;
}
