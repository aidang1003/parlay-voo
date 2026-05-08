import postgres, { type Sql } from "postgres";

/**
 * Postgres client (postgres.js). One shared instance per server lambda.
 * Throws on first use if DATABASE_URL is missing so misconfiguration fails fast.
 *
 * Provider-agnostic: same driver works for Supabase and Neon. We sniff the URL
 * to pick safe defaults — pgBouncer-fronted endpoints (Supabase port 6543,
 * Neon `-pooler` host) don't support prepared statements, so we set
 * `prepare: false` for those. `max: 1` keeps the pool footprint minimal under
 * Vercel's serverless concurrency model.
 */
let cached: Sql | null = null;

type DbProvider = "supabase" | "neon" | "unknown";

function detectProvider(url: string): { provider: DbProvider; pooled: boolean } {
  let host = "";
  let port = "";
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    port = u.port;
  } catch {
    return { provider: "unknown", pooled: true };
  }

  let provider: DbProvider = "unknown";
  if (host.includes("supabase.")) provider = "supabase";
  else if (host.includes("neon.tech")) provider = "neon";

  // Supabase pooler: port 6543. Neon pooler: hostname contains `-pooler`.
  // When unknown, default to pooled (`prepare: false`) since it's the safer
  // failure mode — prepared statements over pgBouncer fail at query time.
  const pooled = port === "6543" || host.includes("-pooler") || host.includes(".pooler.") || provider === "unknown";

  return { provider, pooled };
}

export function sql(): Sql {
  if (!cached) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL is not set. See .env.example");
    }
    const { provider, pooled } = detectProvider(url);
    cached = postgres(url, {
      prepare: !pooled,
      max: 1,
    });
    console.log(`[db] connected (provider=${provider}, pooled=${pooled})`);
  }
  return cached;
}

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
  bigcurationscore: number | null;
  txtgamegroup: string | null;
  /** Non-zero ⇒ this market is part of a mutually-exclusive group. Legs
   *  sharing the same value cannot co-exist on a ticket (B_SLOG_SPRINT.md). */
  bigexclusiongroup: number | null;
  /** Event start (unix seconds). Polymarket-only; null for seed markets. */
  bigeventstart: number | null;
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
    bigcurationscore: r.bigcurationscore == null ? null : Number(r.bigcurationscore),
    txtgamegroup: (r.txtgamegroup as string | null | undefined) ?? null,
    bigexclusiongroup: r.bigexclusiongroup == null ? null : Number(r.bigexclusiongroup),
    bigeventstart: r.bigeventstart == null ? null : Number(r.bigeventstart),
    tscreatedat: r.tscreatedat as string,
  };
}

// Two predicates compose "bettable right now":
//   blnactive       — registered + not admin-disabled (sticky on conflict so
//                     a re-sync can't clobber admin state)
//   bigcutofftime   — still in the future (transient — sync doesn't toggle
//                     this; the clock does)
// Settlement uses blnactive only (it needs to find past-cutoff markets to
// resolve them on-chain), so we filter cutoff at the listing layer instead
// of mutating blnactive in the upsert.
export async function getActiveMarkets(): Promise<MarketRow[]> {
  const db = sql();
  const rows = await db`
    SELECT * FROM tblegmapping
    WHERE blnactive = true
      AND bigcutofftime > EXTRACT(EPOCH FROM NOW())::BIGINT
    ORDER BY bigcurationscore DESC NULLS LAST, txtsourceref
  `;
  return (rows as Record<string, unknown>[]).map(coerceMarketRow);
}

/** Markets with at least one on-chain-registered leg id. */
export async function getRegisteredActiveMarkets(): Promise<MarketRow[]> {
  const db = sql();
  const rows = await db`
    SELECT * FROM tblegmapping
    WHERE blnactive = true
      AND bigcutofftime > EXTRACT(EPOCH FROM NOW())::BIGINT
      AND (intyeslegid IS NOT NULL OR intnolegid IS NOT NULL)
    ORDER BY bigcurationscore DESC NULLS LAST, txtsourceref
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
  curationScore?: number | null;
  gameGroup?: string | null;
  /** Stable hash of the source's exclusion identifier (Polymarket negRisk
   *  event id). 0 / null ⇒ no exclusion. */
  exclusionGroupId?: number | null;
  /** Event start (unix seconds). Polymarket only. */
  eventStart?: number | null;
}

/**
 * Upsert a market row. On conflict we refresh only the volatile fields a sync
 * needs (probs, cutoff, curation score). Registration metadata — leg ids,
 * question, category, earliestResolve, active flag, game group — is preserved
 * once written so a re-sync can't clobber a registered id or rename a market
 * the catalog has already advertised.
 */
export async function upsertMarket(input: UpsertMarketInput): Promise<void> {
  const db = sql();
  const curationScore = input.curationScore ?? null;
  const gameGroup = input.gameGroup ?? null;
  // 0 collapses to null in the DB so non-exclusion markets stay sparse and
  // the column lookup short-circuits in the API surfacing layer.
  const exclusionGroupId =
    input.exclusionGroupId != null && input.exclusionGroupId !== 0 ? input.exclusionGroupId : null;
  const eventStart = input.eventStart ?? null;
  await db`
    INSERT INTO tblegmapping (
      txtsourceref, txtsource, txtquestion, txtcategory,
      intyeslegid, intnolegid, intyesprobppm, intnoprobppm,
      bigcutofftime, bigearliestresolve, blnactive,
      bigcurationscore, txtgamegroup, bigexclusiongroup, bigeventstart
    ) VALUES (
      ${input.sourceRef}, ${input.source}, ${input.question}, ${input.category},
      ${input.yesLegId}, ${input.noLegId}, ${input.yesProbabilityPpm}, ${input.noProbabilityPpm},
      ${input.cutoffTime}, ${input.earliestResolve}, ${input.active ?? true},
      ${curationScore}, ${gameGroup}, ${exclusionGroupId}, ${eventStart}
    )
    ON CONFLICT (txtsourceref) DO UPDATE SET
      intyesprobppm      = EXCLUDED.intyesprobppm,
      intnoprobppm       = EXCLUDED.intnoprobppm,
      bigcutofftime      = EXCLUDED.bigcutofftime,
      bigcurationscore   = COALESCE(EXCLUDED.bigcurationscore, tblegmapping.bigcurationscore),
      -- Preserve a registered exclusion group; only fill in when the row
      -- didn't have one yet, so a re-sync can never silently re-tag a leg
      -- that admins already accepted on-chain.
      bigexclusiongroup  = COALESCE(tblegmapping.bigexclusiongroup, EXCLUDED.bigexclusiongroup),
      bigeventstart      = COALESCE(EXCLUDED.bigeventstart, tblegmapping.bigeventstart)
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

// ── Admin allowlist (tbadminwallet) ─────────────────────────────────────────

export interface AdminRow {
  address: string;
  note: string | null;
  addedBy: string | null;
  createdAt: string;
}

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

function normalizeAddress(raw: string): string {
  const addr = raw.trim().toLowerCase();
  if (!ADDRESS_RE.test(addr)) {
    throw new Error(`invalid address: ${JSON.stringify(raw)}`);
  }
  return addr;
}

export async function listAdmins(): Promise<AdminRow[]> {
  const db = sql();
  const rows = await db`
    SELECT txtaddress, txtnote, txtaddedby, tscreatedat FROM tbadminwallet
    ORDER BY tscreatedat ASC
  `;
  return (rows as Record<string, unknown>[]).map(r => ({
    address: r.txtaddress as string,
    note: (r.txtnote as string | null) ?? null,
    addedBy: (r.txtaddedby as string | null) ?? null,
    createdAt: r.tscreatedat as string,
  }));
}

export async function addAdmin(input: {
  address: string;
  note?: string | null;
  addedBy?: string | null;
}): Promise<void> {
  const db = sql();
  const addr = normalizeAddress(input.address);
  const addedBy = input.addedBy ? normalizeAddress(input.addedBy) : null;
  await db`
    INSERT INTO tbadminwallet (txtaddress, txtnote, txtaddedby)
    VALUES (${addr}, ${input.note ?? null}, ${addedBy})
    ON CONFLICT (txtaddress) DO NOTHING
  `;
}

export async function removeAdmin(address: string): Promise<{ removed: number }> {
  const db = sql();
  const addr = normalizeAddress(address);
  const result = await db`
    DELETE FROM tbadminwallet WHERE txtaddress = ${addr}
  `;
  return { removed: result.count };
}
