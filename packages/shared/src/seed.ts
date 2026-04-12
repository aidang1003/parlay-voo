import type { Market } from "./types.js";

export const MARKET_CATEGORIES = [
  "crypto",
  "nba",
] as const;

export type MarketCategory = (typeof MARKET_CATEGORIES)[number];

/**
 * Static seed markets. IDs 1-21 are stable.
 */
export const SEED_MARKETS: Market[] = [
  {
    id: "ethdenver-2026",
    title: "ETHDenver 2026 Predictions",
    description: "Will these things happen at ETHDenver?",
    category: "crypto",
    legs: [
      { id: 1, question: "Will ETH be above $3000 by March 1?", sourceRef: "price-feed", cutoffTime: 1740000000, earliestResolve: 1740100000, probabilityPPM: 550000, active: true },
      { id: 2, question: "Will Base TVL exceed $15B?", sourceRef: "defillama", cutoffTime: 1740000000, earliestResolve: 1740100000, probabilityPPM: 500000, active: true },
      { id: 3, question: "Will Vitalik attend ETHDenver?", sourceRef: "social", cutoffTime: 1740000000, earliestResolve: 1740100000, probabilityPPM: 450000, active: true },
    ],
  },
];
