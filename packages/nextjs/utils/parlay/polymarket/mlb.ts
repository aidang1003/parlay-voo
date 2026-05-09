import type { CuratedMarket } from "./types";

// MLB-only sports fetcher. Queries Polymarket gamma /markets directly because
// /events does NOT populate sportsMarketType / line / gameId — those fields
// only show up on /markets responses. Empirically verified 2026-05-09.
//
// Intentionally MLB-specific (not generalized to NBA/NFL/NHL) so we can learn
// the per-game-card pattern on one sport before extending it. See
// docs/changes/BACKLOG.md for the generalization follow-up.

const GAMMA_BASE = "https://gamma-api.polymarket.com";

// Confirmed via GET /sports → MLB row's tags: "1,100639,100381"
// (1 = sports, 100639 = baseball-2026 broad, 100381 = mlb-specific).
const MLB_TAG_ID = 100381;

type MlbSportsMarketType = "moneyline" | "spreads" | "totals";

const TARGET_TYPES: readonly MlbSportsMarketType[] = ["moneyline", "spreads", "totals"];

interface GammaSportsMarket {
  conditionId: string;
  question: string;
  slug: string;
  sportsMarketType?: string;
  line?: number;
  groupItemTitle?: string;
  outcomes: string[] | string;
  outcomePrices: string[] | string;
  clobTokenIds?: string[] | string;
  closed: boolean;
  archived: boolean;
  active: boolean;
  bestBid?: number;
  bestAsk?: number;
  volume?: string | number;
  volume24hr?: string | number;
  gameStartTime?: string;
  startDate?: string;
  endDate?: string;
  events?: Array<{ id: string; slug: string; title: string; gameStartTime?: string | null }>;
}

export interface MlbFetchOptions {
  gammaUrl?: string;
  /** Drop markets whose best-bid/ask spread exceeds this. Default 0.10 (10¢). */
  maxSpread?: number;
  /** Cap pulled from gamma (per-page). Default 200. */
  limit?: number;
}

export async function fetchMlbGames(opts: MlbFetchOptions = {}): Promise<CuratedMarket[]> {
  const gammaUrl = (opts.gammaUrl ?? GAMMA_BASE).replace(/\/$/, "");
  const maxSpread = opts.maxSpread ?? 0.1;
  const limit = opts.limit ?? 200;

  const params = new URLSearchParams({
    tag_id: String(MLB_TAG_ID),
    closed: "false",
    sports_market_types: TARGET_TYPES.join(","),
    order: "startDate",
    ascending: "true",
    limit: String(limit),
  });

  const res = await fetch(`${gammaUrl}/markets?${params}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Gamma MLB ${res.status}: ${await res.text()}`);
  }
  const markets: GammaSportsMarket[] = await res.json();

  // Group markets by parent event id. gameId is null on MLB markets today, so
  // events[0].id is the canonical per-game key. Each game can carry several
  // candidates of the same type (multiple totals lines, multiple spreads).
  const byGame = new Map<string, GammaSportsMarket[]>();
  for (const m of markets) {
    if (!isUsable(m, maxSpread)) continue;
    if (!isTargetType(m.sportsMarketType)) continue;
    const gameKey = m.events?.[0]?.id;
    if (!gameKey) continue;
    const list = byGame.get(gameKey);
    if (list) list.push(m);
    else byGame.set(gameKey, [m]);
  }

  const out: CuratedMarket[] = [];
  for (const gameMarkets of byGame.values()) {
    const event = gameMarkets[0].events![0];
    const eventStart = parseGameStartTime(event.gameStartTime ?? gameMarkets[0].gameStartTime);

    for (const type of TARGET_TYPES) {
      const candidates = gameMarkets.filter(m => m.sportsMarketType === type);
      if (candidates.length === 0) continue;
      // Multiple lines for one game (e.g. O/U 7.5 AND O/U 8.5) — pick the
      // deepest book by 24h volume so the user sees the "real" line.
      const best = candidates.reduce((a, b) => (toNumber(b.volume24hr) > toNumber(a.volume24hr) ? b : a));
      const [yesPrice, noPrice] = parsePriceArray(best.outcomePrices);
      const [yesOutcome, noOutcome] = parseOutcomeLabels(best.outcomes);
      out.push({
        conditionId: best.conditionId,
        category: "mlb",
        displayTitle: formatTitle(type, best.line),
        gameGroup: event.title,
        eventId: event.id,
        eventStart,
        polymarketSlug: event.slug,
        yesOutcome,
        noOutcome,
        yesPrice,
        noPrice,
        volume24hr: toNumber(best.volume24hr) || undefined,
        // ML, run-line, and total are correlated but not mutually exclusive:
        // a team can win, cover, AND go over. negRisk stays false so the
        // builder doesn't grey out conflicting legs.
        negRisk: false,
      });
    }
  }

  return out;
}

function isTargetType(t: string | undefined): t is MlbSportsMarketType {
  return t === "moneyline" || t === "spreads" || t === "totals";
}

function isUsable(m: GammaSportsMarket, maxSpread: number): boolean {
  if (m.closed || m.archived || !m.active) return false;
  if (!m.conditionId) return false;
  const outcomes = parseJsonField<string[]>(m.outcomes);
  if (!Array.isArray(outcomes) || outcomes.length !== 2) return false;
  if (m.bestBid && m.bestAsk && m.bestBid > 0 && m.bestAsk > 0 && m.bestAsk - m.bestBid > maxSpread) return false;
  return true;
}

function formatTitle(type: MlbSportsMarketType, line: number | undefined): string {
  switch (type) {
    case "moneyline":
      return "Moneyline";
    case "spreads":
      if (line == null) return "Run Line";
      return `Run Line ${line > 0 ? "+" : ""}${line}`;
    case "totals":
      return line == null ? "Over/Under" : `Over/Under ${line}`;
  }
}

function toNumber(raw: string | number | undefined): number {
  if (raw == null) return 0;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function parsePriceArray(raw: string[] | string): [number | undefined, number | undefined] {
  const arr = parseJsonField<string[]>(raw);
  if (!Array.isArray(arr) || arr.length < 2) return [undefined, undefined];
  const a = Number(arr[0]);
  const b = Number(arr[1]);
  return [Number.isFinite(a) ? a : undefined, Number.isFinite(b) ? b : undefined];
}

function parseOutcomeLabels(raw: string[] | string): [string | undefined, string | undefined] {
  const arr = parseJsonField<string[]>(raw);
  if (!Array.isArray(arr) || arr.length < 2) return [undefined, undefined];
  const norm = (s: unknown) => (typeof s === "string" ? s.trim() : "");
  const yes = norm(arr[0]);
  const no = norm(arr[1]);
  const isDefault = (s: string) => s.toLowerCase() === "yes" || s.toLowerCase() === "no" || s.length === 0;
  return [isDefault(yes) ? undefined : yes, isDefault(no) ? undefined : no];
}

function parseJsonField<T>(raw: T | string): T {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as T;
    } catch {
      /* fall through */
    }
  }
  return raw as T;
}

// Polymarket sports markets ship gameStartTime as "YYYY-MM-DD HH:MM:SS+00"
// (non-ISO; space separator, short offset). Same shape used by featured.ts.
function parseGameStartTime(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const iso = raw.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}
