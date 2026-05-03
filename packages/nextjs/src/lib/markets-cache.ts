// Shared in-flight + TTL cache for /api/markets so feed/list components don't
// fan out one DB-backed fetch per row. See docs/changes/B_SLOG_SPRINT.md.

export interface MarketLegLite {
  id: number;
  noId?: number;
  question: string;
  sourceRef: string;
  probabilityPPM: number;
  noProbabilityPPM?: number;
}

interface MarketLite {
  legs: MarketLegLite[];
}

const TTL_MS = 30_000;

let cachedAt = 0;
let cachedData: MarketLite[] | null = null;
let inFlight: Promise<MarketLite[]> | null = null;

export async function fetchMarketsCached(): Promise<MarketLite[]> {
  const now = Date.now();
  if (cachedData && now - cachedAt < TTL_MS) return cachedData;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const res = await fetch("/api/markets");
      if (!res.ok) return [];
      const data = (await res.json()) as MarketLite[];
      cachedData = data;
      cachedAt = Date.now();
      return data;
    } catch {
      return cachedData ?? [];
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Map keyed by sourceRef → first matching leg (full record). */
export async function fetchSourceRefMap(): Promise<Map<string, MarketLegLite>> {
  const markets = await fetchMarketsCached();
  const map = new Map<string, MarketLegLite>();
  for (const m of markets) for (const leg of m.legs) map.set(leg.sourceRef, leg);
  return map;
}

/** Map keyed by sourceRef → human-readable question only. */
export async function fetchQuestionMapCached(): Promise<Map<string, string>> {
  const markets = await fetchMarketsCached();
  const map = new Map<string, string>();
  for (const m of markets) for (const leg of m.legs) map.set(leg.sourceRef, leg.question);
  return map;
}
