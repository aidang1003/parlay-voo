import { NextResponse } from "next/server";
import { buildLegs, LegBuildError, type LegInput } from "@/lib/quote/build-legs";

// POST /api/quote-preview — live pricing for a draft ticket, no signature. Builder polls this ~30s.
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
