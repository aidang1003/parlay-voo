export type PolymarketCategory = string;

export interface CuratedMarket {
  conditionId: string;
  category: PolymarketCategory;
  displayTitle?: string;
  cutoffOverride?: string;
  /** When sourced from Gamma, carry prices so sync can skip per-token orderbook. */
  yesPrice?: number;
  noPrice?: number;
  /** Raw Gamma event payload for this market. Persisted as JSONB so downstream
   *  consumers (curation score, categorization, grouping) can reach tags /
   *  volume24hr / sibling-market info without re-fetching. Undefined for
   *  hand-curated seed entries. */
  apiPayload?: unknown;
  /** 24h volume in USD, sourced from the Gamma event. Fuel for the curation
   *  score; undefined for hand-curated entries that never saw a Gamma fetch. */
  volume24hr?: number;
  /** Precomputed curation score. Set by the sync route so the DB write is the
   *  single source of truth, but CuratedMarket carries it for completeness. */
  curationScore?: number;
}

export interface PolymarketMetadata {
  conditionId: string;
  question: string;
  description: string;
  endDateIso: string;
  closed: boolean;
  archived: boolean;
  yesTokenId: string;
  noTokenId: string;
  outcomePrices: [string, string];
}

export interface PolymarketOrderBookLevel {
  price: string;
  size: string;
}

export interface PolymarketOrderBook {
  tokenId: string;
  bids: PolymarketOrderBookLevel[];
  asks: PolymarketOrderBookLevel[];
}

export interface PolymarketMarketSnapshot {
  metadata: PolymarketMetadata;
  yesBook: PolymarketOrderBook;
  noBook: PolymarketOrderBook;
  yesMidPpm: number;
  noMidPpm: number;
  fetchedAt: number;
}

export type PolymarketResolutionOutcome = "YES" | "NO" | "VOIDED";

export interface PolymarketResolution {
  conditionId: string;
  outcome: PolymarketResolutionOutcome;
  resolvedAt: number;
}
