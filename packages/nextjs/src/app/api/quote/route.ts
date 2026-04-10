import { NextResponse } from "next/server";
import { getQuote } from "@/lib/mcp/tools";

/**
 * POST /api/quote -- compute a parlay quote from leg IDs + stake.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { legIds, stake } = body as { legIds: number[]; stake: number };

    if (!Array.isArray(legIds) || typeof stake !== "number") {
      return NextResponse.json(
        { error: "legIds (number[]) and stake (number) are required" },
        { status: 400 },
      );
    }

    const quote = await getQuote({ legIds, stake });

    if (!quote.valid) {
      return NextResponse.json({ error: quote.error ?? "Invalid quote" }, { status: 400 });
    }

    return NextResponse.json(quote);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Internal error" },
      { status: 500 },
    );
  }
}
