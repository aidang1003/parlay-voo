import type { CuratedMarket, PolymarketCategory } from "./types.js";

/**
 * Discover trending Polymarket events via the Gamma API and return them
 * as CuratedMarket entries ready for the sync pipeline → Neon DB.
 *
 * The Gamma `/events` endpoint supports ordering by volume24hr, liquidity,
 * etc. We fetch the top active events and extract individual binary markets
 * from each one.
 */

const GAMMA_BASE = "https://gamma-api.polymarket.com";

// ── Gamma response shapes ────────────────────────────────────────────────

interface GammaMarket {
  conditionId: string;
  question: string;
  slug: string;
  /** May arrive as a JSON string (e.g. "[\"Yes\",\"No\"]") or a real array. */
  outcomes: string[] | string;
  outcomePrices: string[] | string;
  volume: string;
  liquidity: string;
  active: boolean;
  closed: boolean;
  archived: boolean;
  groupItemTitle?: string;
  bestBid: number;
  bestAsk: number;
  clobTokenIds: string[] | string;
  endDate?: string;
}

interface GammaTag {
  id?: string;
  label?: string;
  slug?: string;
}

interface GammaEvent {
  id: string;
  title: string;
  slug: string;
  description: string;
  startDate: string;
  endDate: string;
  active: boolean;
  closed: boolean;
  archived: boolean;
  volume: string;
  volume24hr: string;
  liquidity: string;
  negRisk: boolean;
  markets: GammaMarket[];
  commentCount?: number;
  tags?: GammaTag[];
  category?: string;
}

// ── Config ───────────────────────────────────────────────────────────────

export interface FeaturedOptions {
  /** Max events to fetch from Gamma (default 10) */
  limit?: number;
  /** Min 24h volume in USD to include a market (default 10_000) */
  minVolume24hr?: number;
  /** Only include markets whose best-bid/ask spread ≤ this (default 0.10 = 10¢) */
  maxSpread?: number;
  /** Override Gamma base URL (useful for testing) */
  gammaUrl?: string;
  /** Category tag to assign (default "crypto") */
  category?: PolymarketCategory;
}

const DEFAULTS: Required<FeaturedOptions> = {
  limit: 10,
  minVolume24hr: 10_000,
  maxSpread: 0.10,
  gammaUrl: GAMMA_BASE,
  category: "crypto",
};

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Fetch the top trending Polymarket events by 24h volume and return
 * the individual binary markets as CuratedMarket entries.
 *
 * Each market inside a multi-outcome event (negRisk group) is returned
 * as its own entry — the sync pipeline registers yes/no sides independently.
 */
export async function fetchFeaturedMarkets(
  opts?: FeaturedOptions,
): Promise<CuratedMarket[]> {
  const cfg = { ...DEFAULTS, ...opts };
  const url = buildEventsUrl(cfg);

  const res = await fetch(url, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Gamma API ${res.status}: ${await res.text()}`);
  }

  const events: GammaEvent[] = await res.json();
  const results: CuratedMarket[] = [];

  for (const event of events) {
    const markets = event.markets ?? [];
    const eventCategory = resolveCategory(event, cfg.category);
    const eventVolume24hr = parseNumOrUndef(event.volume24hr);
    for (const mkt of markets) {
      if (!isUsable(mkt, cfg)) continue;
      const [yesPrice, noPrice] = parsePrices(mkt.outcomePrices);

      results.push({
        conditionId: mkt.conditionId,
        category: eventCategory,
        displayTitle: mkt.groupItemTitle
          ? `${event.title}: ${mkt.groupItemTitle}`
          : mkt.question,
        yesPrice,
        noPrice,
        apiPayload: buildApiPayload(event, mkt),
        volume24hr: eventVolume24hr,
      });
    }
  }

  return results;
}

function parseNumOrUndef(raw: string | number | undefined): number | undefined {
  if (raw == null) return undefined;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Snapshot of the Gamma event + market shapes we persist. We strip the
 *  sibling `markets` array off the event copy so a negRisk group with N
 *  markets doesn't balloon each row to N× the payload. */
function buildApiPayload(event: GammaEvent, market: GammaMarket): Record<string, unknown> {
  const { markets: _siblings, ...eventMeta } = event;
  return {
    event: eventMeta,
    market,
    capturedAt: new Date().toISOString(),
  };
}

/** Derive a category slug from Gamma event metadata. Falls back to the
 *  provided default if the event carries no usable tag/category. */
function resolveCategory(event: GammaEvent, fallback: string): string {
  if (event.category && event.category.trim()) return event.category.toLowerCase();
  const firstTag = event.tags?.find((t) => t?.slug || t?.label);
  if (firstTag) {
    const val = firstTag.slug ?? firstTag.label ?? "";
    if (val) return val.toLowerCase();
  }
  return fallback;
}

/** Extract [yes, no] prices (0..1 floats) from Gamma outcomePrices. */
function parsePrices(raw: string[] | string): [number | undefined, number | undefined] {
  const arr = parseJsonField<string[]>(raw);
  if (!Array.isArray(arr) || arr.length < 2) return [undefined, undefined];
  const yes = Number(arr[0]);
  const no = Number(arr[1]);
  return [Number.isFinite(yes) ? yes : undefined, Number.isFinite(no) ? no : undefined];
}

/**
 * Convenience: fetch a single top event (by 24h volume) and return its
 * markets as CuratedMarket entries — useful for a quick smoke test.
 */
export async function fetchTopEvent(
  opts?: Omit<FeaturedOptions, "limit">,
): Promise<{ event: Pick<GammaEvent, "id" | "title" | "slug" | "volume24hr">; markets: CuratedMarket[] }> {
  const cfg = { ...DEFAULTS, ...opts, limit: 1 };
  const url = buildEventsUrl(cfg);

  const res = await fetch(url, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Gamma API ${res.status}: ${await res.text()}`);
  }

  const events: GammaEvent[] = await res.json();
  if (events.length === 0) {
    throw new Error("Gamma API returned no active events");
  }

  const event = events[0];
  const eventCategory = resolveCategory(event, cfg.category);
  const markets: CuratedMarket[] = (event.markets ?? [])
    .filter((m) => isUsable(m, cfg))
    .map((mkt) => {
      const [yesPrice, noPrice] = parsePrices(mkt.outcomePrices);
      return {
        conditionId: mkt.conditionId,
        category: eventCategory,
        displayTitle: mkt.groupItemTitle
          ? `${event.title}: ${mkt.groupItemTitle}`
          : mkt.question,
        yesPrice,
        noPrice,
      };
    });

  return {
    event: {
      id: event.id,
      title: event.title,
      slug: event.slug,
      volume24hr: event.volume24hr,
    },
    markets,
  };
}

// ── Internals ────────────────────────────────────────────────────────────

function buildEventsUrl(cfg: Required<FeaturedOptions>): string {
  const base = cfg.gammaUrl.replace(/\/$/, "");
  const params = new URLSearchParams({
    limit: String(cfg.limit),
    active: "true",
    closed: "false",
    order: "volume24hr",
    ascending: "false",
  });
  return `${base}/events?${params}`;
}

/** Gamma sometimes returns JSON-encoded strings instead of arrays. */
function parseJsonField<T>(raw: T | string): T {
  if (typeof raw === "string") {
    try { return JSON.parse(raw) as T; } catch { /* fall through */ }
  }
  return raw as T;
}

function isUsable(
  mkt: GammaMarket,
  cfg: Pick<Required<FeaturedOptions>, "minVolume24hr" | "maxSpread">,
): boolean {
  if (mkt.closed || mkt.archived || !mkt.active) return false;
  if (!mkt.conditionId) return false;

  // Must be a binary (yes/no) market
  const outcomes = parseJsonField<string[]>(mkt.outcomes);
  if (!Array.isArray(outcomes) || outcomes.length !== 2) return false;

  // Require non-trivial volume
  const vol = Number(mkt.volume);
  if (isNaN(vol) || vol < cfg.minVolume24hr) return false;

  // Require a tight-ish spread so mid-price is meaningful
  if (mkt.bestBid > 0 && mkt.bestAsk > 0) {
    const spread = mkt.bestAsk - mkt.bestBid;
    if (spread > cfg.maxSpread) return false;
  }

  return true;
}
