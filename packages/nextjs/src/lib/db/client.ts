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

export interface LegMappingRow {
  txtsourceref: string;
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
 * All active legs -- the catalog for /api/markets. Includes legs pending
 * on-chain registration so Polymarket data shows up immediately after sync.
 * Registered legs sort first; unregistered sort by txtsourceref.
 */
export async function getAllActiveLegs(): Promise<LegMappingRow[]> {
  const db = sql();
  const rows = await db`
    SELECT * FROM tblegmapping
    WHERE blnactive = true
    ORDER BY intonchainlegid NULLS LAST, txtsourceref
  `;
  return (rows as Record<string, unknown>[]).map(coerceLegRow);
}

export interface UpsertLegInput {
  sourceRef: string;
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
      txtsourceref, txtsource, intonchainlegid, txtquestion, txtcategory,
      intprobabilityppm, bigcutofftime, bigearliestresolve, blnactive
    ) VALUES (
      ${input.sourceRef}, ${input.source}, ${input.onChainLegId}, ${input.question}, ${input.category},
      ${input.probabilityPpm}, ${input.cutoffTime}, ${input.earliestResolve}, ${input.active ?? true}
    )
    ON CONFLICT (txtsourceref) DO UPDATE SET
      intonchainlegid    = COALESCE(tblegmapping.intonchainlegid, EXCLUDED.intonchainlegid),
      txtquestion        = EXCLUDED.txtquestion,
      txtcategory        = EXCLUDED.txtcategory,
      intprobabilityppm  = EXCLUDED.intprobabilityppm,
      bigcutofftime      = EXCLUDED.bigcutofftime,
      bigearliestresolve = EXCLUDED.bigearliestresolve,
      blnactive          = EXCLUDED.blnactive
  `;
}
