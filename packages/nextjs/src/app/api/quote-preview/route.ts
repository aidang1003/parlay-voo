import { NextResponse } from "next/server";
import { buildLegs, LegBuildError, type LegInput } from "@/lib/quote/build-legs";

/**
 * POST /api/quote-preview
 *
 * Returns live pricing for a draft ticket WITHOUT producing an EIP-712
 * signature. Called every ~30s by the parlay builder while legs are staged
 * but the buy flow hasn't started — lets the UI reflect the current CLOB mid
 * instead of whatever PPM was cached when the market loaded.
 *
 * Request body:
 *   { legs: [{ sourceRef: string, side: "yes" | "no" }] }
 *
 * Response body:
 *   { legs: [{ sourceRef, side, probabilityPPM, cutoffTime, earliestResolve }] }
 *
 * Errors out with LegBuildError.status if any leg is unknown or missing the
 * requested side (same semantics as /api/quote-sign).
 */
interface PreviewBody {
  legs: LegInput[];
}

export async function POST(req: Request) {
  let body: PreviewBody;
  try {
    body = (await req.json()) as PreviewBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!Array.isArray(body?.legs) || body.legs.length < 1 || body.legs.length > 5) {
    return NextResponse.json({ error: "legs must be 1..5" }, { status: 400 });
  }

  try {
    const built = await buildLegs(body.legs);
    return NextResponse.json({
      legs: built.map((l) => ({
        sourceRef: l.sourceRef,
        side: l.side,
        probabilityPPM: l.probabilityPPM,
        cutoffTime: l.cutoffTime,
        earliestResolve: l.earliestResolve,
      })),
    });
  } catch (e) {
    if (e instanceof LegBuildError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
