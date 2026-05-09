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
  /** Cap pulled from gamma (per-page). Default 200. */
  limit?: number;
}

export async function fetchMlbGames(opts: MlbFetchOptions = {}): Promise<CuratedMarket[]> {
  const gammaUrl = (opts.gammaUrl ?? GAMMA_BASE).replace(/\/$/, "");
  const limit = opts.limit ?? 200;

  const params = new URLSearchParams({
    tag_id: String(MLB_TAG_ID),
    closed: "false",
    order: "startDate",
    ascending: "true",
    limit: String(limit),
  });
  // Gamma rejects comma-joined multi-value params silently — `sports_market_types=a,b`
  // matches the literal string "a,b" against sportsMarketType and returns 0 rows.
  // Append the key once per value so the URL renders as
  // `sports_market_types=a&sports_market_types=b&sports_market_types=c`, which gamma
  // parses correctly.
  for (const t of TARGET_TYPES) params.append("sports_market_types", t);

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
    if (!isMlbMarketUsable(m)) continue;
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
    // Cutoff sits at gameStart + 6h (covers normal MLB game length + buffer)
    // and earliestResolve at cutoff + 48h (UMA dispute window). The chain
    // enforces `earliestResolve >= cutoff` in LegRegistry — pushing cutoff
    // past earliestResolve trips "LegRegistry: resolve before cutoff" the
    // first time anyone tries to buy a fresh leg. Visibility past 6h relies
    // on the price-based `isPostGameSettled` filter in markets.ts, which
    // hides extreme-priced post-game markets without needing the cutoff to
    // extend further.
    const CUTOFF_AFTER_GAME_SEC = 6 * 60 * 60;
    const RESOLVE_AFTER_CUTOFF_SEC = 48 * 60 * 60;
    const cutoffOverride =
      eventStart != null ? new Date((eventStart + CUTOFF_AFTER_GAME_SEC) * 1000).toISOString() : undefined;
    const earliestResolveOverride =
      eventStart != null
        ? new Date((eventStart + CUTOFF_AFTER_GAME_SEC + RESOLVE_AFTER_CUTOFF_SEC) * 1000).toISOString()
        : undefined;

    for (const type of TARGET_TYPES) {
      const candidates = gameMarkets.filter(m => m.sportsMarketType === type);
      if (candidates.length === 0) continue;

      // Polymarket sometimes lists the same wager from both perspectives —
      // e.g. "Spread: Orioles (-1.5)" AND "Spread: Athletics (-1.5)" share
      // |line|=1.5 but flip the favorite. Effectively the same logical bet
      // exposed as two yes/no markets. Collapse to one per |line| by picking
      // the candidate with the highest underdog multiplier (= lowest min
      // outcome price), so the user gets the better-priced version.
      const byAbsLine = new Map<string, GammaSportsMarket[]>();
      for (const m of candidates) {
        const key = m.line == null ? "_" : Math.abs(m.line).toString();
        const list = byAbsLine.get(key);
        if (list) list.push(m);
        else byAbsLine.set(key, [m]);
      }
      const collapsed: GammaSportsMarket[] = [];
      for (const group of byAbsLine.values()) {
        collapsed.push(group.reduce((a, b) => (minOutcomePrice(b) < minOutcomePrice(a) ? b : a)));
      }

      // Across different |line| values (e.g. O/U 7.5 vs 8.5 — *different*
      // wagers, not duplicates), pick the deepest book by 24h volume. That's
      // the line the market actually treats as "the" line.
      const best = collapsed.reduce((a, b) => (toNumber(b.volume24hr) > toNumber(a.volume24hr) ? b : a));
      const [yesPrice, noPrice] = parsePriceArray(best.outcomePrices);
      const [yesOutcome, noOutcome] = parseOutcomeLabels(best.outcomes);
      out.push({
        conditionId: best.conditionId,
        category: "mlb",
        displayTitle: formatTitle(type, best.line),
        cutoffOverride,
        earliestResolveOverride,
        // Polymarket lists each calendar game as its own event but reuses the
        // matchup title ("Athletics vs. Baltimore Orioles") across days. Date-
        // disambiguate the gameGroup so the UI buckets per-game rather than
        // per-matchup, and the correlation-group hash gives a separate group
        // to each day's contest.
        gameGroup: formatGameGroup(event.title, eventStart),
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
        // Drives the per-side YES/NO copy in ParlayBuilder. moneyline keeps
        // line undefined; spreads/totals carry the raw line.
        marketType: type,
        line: type === "moneyline" ? undefined : best.line,
      });
    }
  }

  return out;
}

function isTargetType(t: string | undefined): t is MlbSportsMarketType {
  return t === "moneyline" || t === "spreads" || t === "totals";
}

// MLB-specific usability filter. Deliberately omits the bid/ask spread check
// that featured.ts uses for political markets: MLB ships a snapshot price via
// Gamma `outcomePrices`, so a wide live book on tomorrow's game still leaves
// us with a sane displayed price. The on-chain JIT quote re-checks liquidity
// at buy time, so empty-book markets fail with a real error rather than
// silently disappearing pre-sync. Without this relaxation the 0.10 cap
// dropped ~67% of moneylines and a chunk of spreads/totals on day-ahead games.
function isMlbMarketUsable(m: GammaSportsMarket): boolean {
  if (m.closed || m.archived || !m.active) return false;
  if (!m.conditionId) return false;
  const outcomes = parseJsonField<string[]>(m.outcomes);
  if (!Array.isArray(outcomes) || outcomes.length !== 2) return false;
  return true;
}

// "Athletics vs. Baltimore Orioles (5/9)" — appends a short date so a
// scheduled rematch (next-day game with the same teams) lands in its own
// game card. Falls back to the bare title when the start time is unknown.
function formatGameGroup(title: string, eventStartSec: number | undefined): string {
  if (eventStartSec == null) return title;
  const d = new Date(eventStartSec * 1000);
  const date = d.toLocaleDateString("en-US", { month: "numeric", day: "numeric" });
  return `${title} (${date})`;
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

// Lowest yes/no outcome price → highest implied multiplier on the better
// side. Used to break a same-|line| duplicate in favor of the user.
// Returns Infinity for unparseable rows so they lose the comparison.
function minOutcomePrice(m: GammaSportsMarket): number {
  const arr = parseJsonField<string[]>(m.outcomePrices);
  if (!Array.isArray(arr) || arr.length < 2) return Infinity;
  const a = Number(arr[0]);
  const b = Number(arr[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  return Math.min(a, b);
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
