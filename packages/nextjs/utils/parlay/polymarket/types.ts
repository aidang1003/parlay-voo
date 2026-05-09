export type PolymarketCategory = string;

export interface CuratedMarket {
  conditionId: string;
  category: PolymarketCategory;
  displayTitle?: string;
  cutoffOverride?: string;
  /** When sourced from Gamma, carry prices so sync can skip per-token orderbook. */
  yesPrice?: number;
  noPrice?: number;
  volume24hr?: number;
  curationScore?: number;
  gameGroup?: string;
  /** True when the parent Polymarket event uses the negRisk mechanism. Every
   *  child market in a negRisk event is mutually exclusive: at most one
   *  resolves YES. The sync layer turns this + `eventId` into a non-zero
   *  `exclusionGroupId` so the builder can grey out conflicting legs and
   *  the engine can reject `MutuallyExclusiveLegs` on buy. */
  negRisk?: boolean;
  /** Polymarket event id. Stable across child markets in the same event;
   *  used as the seed for the exclusion-group hash when `negRisk` is true. */
  eventId?: string;
  /** Event start time (unix seconds). When present, the UI shows it on the
   *  leg card so users can answer "when is this game?" without opening
   *  Polymarket. Sourced from GammaEvent.startDate. */
  eventStart?: number;
  /** Polymarket event slug. Powers the question-header click-through to
   *  https://polymarket.com/event/<slug>. Sourced from GammaEvent.slug. */
  polymarketSlug?: string;
  /** Outcome label for the YES side. Undefined when the market ships the
   *  default "Yes" — we only persist labels that add information (team,
   *  candidate, etc.). */
  yesOutcome?: string;
  /** Outcome label for the NO side. Same convention as yesOutcome. */
  noOutcome?: string;
  /** Polymarket sportsMarketType. Set by the MLB fetcher; undefined elsewhere
   *  so the UI falls back to plain question + Yes/No copy. */
  marketType?: "moneyline" | "spreads" | "totals";
  /** Raw spread/total line (e.g. -1.5, 8.5). Undefined for moneyline and for
   *  non-sports markets. Stored ×10 in DB but flows through unscaled. */
  line?: number;
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
