import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SEED_MARKETS } from "@parlaycity/shared";
import { sql, upsertMarket } from "@/lib/db/client";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";

export const runtime = "nodejs";

/**
 * One-shot DB initializer. Applies schema.sql and backfills leg_mapping with
 * the static seed catalog so /api/markets can serve from a single source.
 *
 * Idempotent: safe to re-run. Guard via CRON_SECRET to avoid accidental hits.
 *
 *   curl -H "authorization: Bearer $CRON_SECRET" http://localhost:3000/api/db/init
 */
export async function GET(req: Request) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const schemaPath = join(process.cwd(), "src/lib/db/schema.sql");
    const schema = await readFile(schemaPath, "utf8");
    const db = sql();
    for (const stmt of splitStatements(schema)) {
      await db.query(stmt);
    }

    let seeded = 0;
    for (const market of SEED_MARKETS) {
      for (const leg of market.legs) {
        await upsertMarket({
          sourceRef: `seed:${leg.id}`,
          source: "seed",
          question: leg.question,
          category: market.category,
          yesLegId: leg.id - 1, // seed catalog 1..21 → on-chain 0..20
          noLegId: null,
          yesProbabilityPpm: leg.probabilityPPM,
          noProbabilityPpm: null,
          cutoffTime: leg.cutoffTime,
          earliestResolve: leg.earliestResolve,
          active: leg.active,
        });
        seeded++;
      }
    }

    return NextResponse.json({ ok: true, seeded });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

/** Split a .sql file into executable statements on semicolons, ignoring
 *  comments and empty lines. Good enough for our own DDL, not a real parser. */
function splitStatements(source: string): string[] {
  return source
    .split(/;\s*\n/)
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter((s) => s.length > 0);
}
