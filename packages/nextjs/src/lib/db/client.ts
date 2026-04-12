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
// Types
// ---------------------------------------------------------------------------

export type LegSource = "seed" | "polymarket";

export interface LegMappingRow {
  source_ref: string;
  source: LegSource;
  on_chain_leg_id: number | null;
  question: string;
  category: string;
  probability_ppm: number;
  cutoff_time: number;
  earliest_resolve: number;
  active: boolean;
  created_at: string;
}

export interface ResolutionRow {
  condition_id: string;
  outcome: "YES" | "NO" | "VOIDED";
  yes_tx_hash: string | null;
  no_tx_hash: string | null;
  resolved_at: string;
}

// Neon's HTTP tagged template returns rows as Record<string, unknown>[]. We coerce
// numeric fields back to JS numbers here because Postgres BIGINT arrives as string.
function coerceLegRow(r: Record<string, unknown>): LegMappingRow {
  return {
    source_ref: r.source_ref as string,
    source: r.source as LegSource,
    on_chain_leg_id: r.on_chain_leg_id == null ? null : Number(r.on_chain_leg_id),
    question: r.question as string,
    category: r.category as string,
    probability_ppm: Number(r.probability_ppm),
    cutoff_time: Number(r.cutoff_time),
    earliest_resolve: Number(r.earliest_resolve),
    active: r.active as boolean,
    created_at: r.created_at as string,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Active legs that are also registered on-chain (on_chain_leg_id IS NOT NULL).
 * Use for operations that need real on-chain IDs (settlement, MCP tools).
 */
export async function getRegisteredActiveLegs(): Promise<LegMappingRow[]> {
  const db = sql();
  const rows = await db`
    SELECT * FROM leg_mapping
    WHERE active = true AND on_chain_leg_id IS NOT NULL
    ORDER BY on_chain_leg_id
  `;
  return (rows as Record<string, unknown>[]).map(coerceLegRow);
}

/**
 * All active legs -- the catalog for /api/markets. Includes legs pending
 * on-chain registration so Polymarket data shows up immediately after sync.
 * Registered legs sort first; unregistered sort by source_ref.
 */
export async function getAllActiveLegs(): Promise<LegMappingRow[]> {
  const db = sql();
  const rows = await db`
    SELECT * FROM leg_mapping
    WHERE active = true
    ORDER BY on_chain_leg_id NULLS LAST, source_ref
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
 * Upsert into leg_mapping. The polymarket sync passes onChainLegId=null for new
 * rows; the registration script later populates it. For seed and registered
 * polymarket rows we pass the real id.
 *
 * NOTE: on conflict we deliberately do NOT overwrite on_chain_leg_id with NULL
 * -- once a leg is registered on-chain, sync re-runs must not wipe it.
 */
export async function upsertLegMapping(input: UpsertLegInput): Promise<void> {
  const db = sql();
  await db`
    INSERT INTO leg_mapping (
      source_ref, source, on_chain_leg_id, question, category,
      probability_ppm, cutoff_time, earliest_resolve, active
    ) VALUES (
      ${input.sourceRef}, ${input.source}, ${input.onChainLegId}, ${input.question}, ${input.category},
      ${input.probabilityPpm}, ${input.cutoffTime}, ${input.earliestResolve}, ${input.active ?? true}
    )
    ON CONFLICT (source_ref) DO UPDATE SET
      on_chain_leg_id  = COALESCE(leg_mapping.on_chain_leg_id, EXCLUDED.on_chain_leg_id),
      question         = EXCLUDED.question,
      category         = EXCLUDED.category,
      probability_ppm  = EXCLUDED.probability_ppm,
      cutoff_time      = EXCLUDED.cutoff_time,
      earliest_resolve = EXCLUDED.earliest_resolve,
      active           = EXCLUDED.active
  `;
}

