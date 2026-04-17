import type {
  PolymarketMetadata,
  PolymarketOrderBook,
  PolymarketResolution,
} from "@parlaycity/shared";

export interface PolymarketClientConfig {
  gammaUrl: string;
  clobUrl: string;
  rateLimitMs?: number;
  max429Retries?: number;
  signer?: unknown;
}

interface GammaMarketResponse {
  conditionId: string;
  question: string;
  description: string;
  endDateIso: string;
  closed: boolean;
  archived: boolean;
  clobTokenIds?: string | string[];
  outcomePrices: string | string[];
  tokens?: Array<{ token_id?: string; tokenId?: string; outcome: string }>;
}



interface ClobBookResponse {
  market: string;
  asset_id: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
}

export class PolymarketClient {
  private lastRequestAt = 0;
  private readonly rateLimitMs: number;
  private readonly max429Retries: number;
  private readonly gammaUrl: string;
  private readonly clobUrl: string;

  constructor(config: PolymarketClientConfig) {
    this.gammaUrl = config.gammaUrl.replace(/\/$/, "");
    this.clobUrl = config.clobUrl.replace(/\/$/, "");
    this.rateLimitMs = config.rateLimitMs ?? 150;
    this.max429Retries = config.max429Retries ?? 3;
  }

  async fetchMarket(conditionId: string): Promise<PolymarketMetadata> {
    const url = `${this.gammaUrl}/markets?condition_ids=${encodeURIComponent(conditionId)}`;
    const raw = await this.request<GammaMarketResponse[] | GammaMarketResponse>(url);
    const market = Array.isArray(raw) ? raw[0] : raw;
    if (!market) throw new Error(`Polymarket: no market for conditionId ${conditionId}`);
    return normalizeMarket(market);
  }

  async fetchOrderBook(tokenId: string): Promise<PolymarketOrderBook> {
    const url = `${this.clobUrl}/book?token_id=${encodeURIComponent(tokenId)}`;
    const raw = await this.request<ClobBookResponse>(url);
    return {
      tokenId,
      bids: (raw.bids ?? []).map((l) => ({ price: l.price, size: l.size })),
      asks: (raw.asks ?? []).map((l) => ({ price: l.price, size: l.size })),
    };
  }

  async fetchResolution(conditionId: string): Promise<PolymarketResolution | null> {
    const metadata = await this.fetchMarket(conditionId);
    if (!metadata.closed) return null;

    const [yesPrice, noPrice] = metadata.outcomePrices;
    const yes = Number(yesPrice);
    const no = Number(noPrice);
    const resolvedAt = Math.floor(Date.now() / 1000);

    // Wait-for-exactness: only settle when Polymarket returns clean 1/0 prices.
    // Anything else (e.g. 0.97/0.03 mid-settle rounding) returns null so the
    // cron retries next tick rather than mis-voiding a live resolution.
    if (yes === 1 && no === 0) return { conditionId, outcome: "YES", resolvedAt };
    if (yes === 0 && no === 1) return { conditionId, outcome: "NO", resolvedAt };
    // Both-zero is the normalizer's sentinel for "outcomePrices missing entirely"
    // — a closed market with no prices at all is a genuine void.
    if (yes === 0 && no === 0) return { conditionId, outcome: "VOIDED", resolvedAt };
    return null;
  }

  private async request<T>(url: string): Promise<T> {
    await this.throttle();
    let attempt = 0;
    for (;;) {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (res.status === 429 && attempt < this.max429Retries) {
        attempt++;
        await sleep(Math.min(2000, 250 * 2 ** attempt));
        continue;
      }
      if (!res.ok) {
        throw new Error(`Polymarket ${res.status} ${url}: ${await res.text()}`);
      }
      return (await res.json()) as T;
    }
  }

  private async throttle(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < this.rateLimitMs) {
      await sleep(this.rateLimitMs - elapsed);
    }
    this.lastRequestAt = Date.now();
  }
}

function normalizeMarket(raw: GammaMarketResponse): PolymarketMetadata {
  const tokens = parseTokens(raw);
  const outcomePrices = parseOutcomePrices(raw.outcomePrices);
  return {
    conditionId: raw.conditionId,
    question: raw.question,
    description: raw.description,
    endDateIso: raw.endDateIso,
    closed: raw.closed,
    archived: raw.archived,
    yesTokenId: tokens.yes,
    noTokenId: tokens.no,
    outcomePrices: outcomePrices || ["0", "0"],
  };
}

function parseTokens(raw: GammaMarketResponse): { yes: string; no: string } {
  if (raw.tokens && raw.tokens.length >= 2) {
    const yes = raw.tokens.find((t) => t.outcome?.toLowerCase() === "yes");
    const no = raw.tokens.find((t) => t.outcome?.toLowerCase() === "no");
    if (yes && no) return { yes: (yes.token_id || yes.tokenId) as string, no: (no.token_id || no.tokenId) as string };
  }
  if (raw.clobTokenIds) {
    if (Array.isArray(raw.clobTokenIds)) {
      if (raw.clobTokenIds.length >= 2) return { yes: raw.clobTokenIds[0], no: raw.clobTokenIds[1] };
    } else if (typeof raw.clobTokenIds === "string") {
      try {
        const parsed = JSON.parse(raw.clobTokenIds) as string[];
        if (parsed.length >= 2) return { yes: parsed[0], no: parsed[1] };
      } catch {
        /* fall through */
      }
    }
  }
  throw new Error(`Polymarket: cannot parse token IDs for ${raw.conditionId}`);
}

function parseOutcomePrices(raw: string | string[] | undefined): [string, string] | undefined {
  if (!raw) return undefined;
  if (Array.isArray(raw)) {
    if (raw.length >= 2) return [raw[0], raw[1]];
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as string[];
    if (parsed.length >= 2) return [parsed[0], parsed[1]];
  } catch {
    /* ignore */
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
