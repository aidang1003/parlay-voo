import type { CuratedMarket } from "./types.js";

/**
 * Hand-curated Polymarket markets registered on-chain for parlay betting.
 *
 * To add a market:
 *   1. Find a liquid market on polymarket.com
 *   2. Query the gamma api by typing https://gamma-api.polymarket.com/events?slug= into the browser
 *   3. Slug is the last part of the URL. For example, for https://polymarket.com/events/elon-musk-buy-twitter, the slug is "elon-musk-buy-twitter". So the full query URL is https://gamma-api.polymarket.com/events?slug=elon-musk-buy-twitter
 *   4. Next sync run registers it on-chain wioth `make db-sync`
 */
export const CURATED: CuratedMarket[] = [
  // ── Crypto ──────────────────────────────────────────────────────────────
  // { conditionId: "0x...", category: "crypto", displayTitle: "BTC > $200k by EOY 2026" },
  // { conditionId: "0x...", category: "crypto", displayTitle: "ETH > $8k by EOY 2026" },

  // ── Sports ──────────────────────────────────────────────────────────────
  {conditionId: "0xac6b6f6da4eb31a28cd22d050038877963a4fe2243174c0e65d20f99ff20f9ce", category: "sports", displayTitle: "Will Xander Schauffele win the 2026 Masters tournament?"},
];
