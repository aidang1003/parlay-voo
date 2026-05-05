import type { Market } from "./types";

export const MARKET_CATEGORIES = ["crypto", "nba"] as const;

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
      {
        id: 1,
        noId: 4,
        question: "Will ETH be above $3000 by March 1?",
        sourceRef: "price-feed",
        cutoffTime: 1830000000,
        earliestResolve: 1830100000,
        probabilityPPM: 550000,
        noProbabilityPPM: 450000,
        active: true,
      },
      {
        id: 2,
        noId: 5,
        question: "Will Base TVL exceed $15B?",
        sourceRef: "defillama",
        cutoffTime: 1830000000,
        earliestResolve: 1830100000,
        probabilityPPM: 500000,
        noProbabilityPPM: 500000,
        active: true,
      },
      {
        id: 3,
        noId: 6,
        question: "Will Vitalik attend ETHDenver?",
        sourceRef: "social",
        cutoffTime: 1830000000,
        earliestResolve: 1830100000,
        probabilityPPM: 450000,
        noProbabilityPPM: 550000,
        active: true,
      },
    ],
  },
];
