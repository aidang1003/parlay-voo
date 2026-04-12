export type PolymarketCategory = string;

export interface CuratedMarket {
  conditionId: string;
  category: PolymarketCategory;
  displayTitle?: string;
  cutoffOverride?: string;
  /** When sourced from Gamma, carry prices so sync can skip per-token orderbook. */
  yesPrice?: number;
  noPrice?: number;
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
