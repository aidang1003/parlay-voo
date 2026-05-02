import { describe, it, expect } from "vitest";
import type { PolymarketOrderBook } from "@parlayvoo/shared";
import { bookMidPpm } from "../build-legs";

const book = (
  bids: Array<[number, number]>,
  asks: Array<[number, number]>,
): PolymarketOrderBook => ({
  tokenId: "tok",
  bids: bids.map(([price, size]) => ({ price: String(price), size: String(size) })),
  asks: asks.map(([price, size]) => ({ price: String(price), size: String(size) })),
});

describe("bookMidPpm", () => {
  it("computes mid from best bid and best ask, regardless of array order", () => {
    // Bids ascending (worst-first): best = 0.69. Asks ascending (best-first): best = 0.71.
    const ascending = book(
      [
        [0.02, 10],
        [0.65, 50],
        [0.69, 30],
      ],
      [
        [0.71, 40],
        [0.85, 10],
        [0.98, 5],
      ],
    );
    // Bids descending: best = 0.69 still. Asks descending: best = 0.71 still.
    const descending = book(
      [
        [0.69, 30],
        [0.65, 50],
        [0.02, 10],
      ],
      [
        [0.98, 5],
        [0.85, 10],
        [0.71, 40],
      ],
    );
    // Mid = (0.69 + 0.71) / 2 = 0.70 → 700_000 PPM.
    expect(bookMidPpm(ascending)).toBe(700_000);
    expect(bookMidPpm(descending)).toBe(700_000);
  });

  it("rejects a dust-bid / dust-ask straddle that would otherwise read as 50/50", () => {
    // Old [0]-based code returned mid = (0.01 + 0.99) / 2 = 0.5.
    // New code: bestBid = 0.69 (max), bestAsk = 0.71 (min) → 700_000.
    const straddle = book(
      [
        [0.01, 1],
        [0.69, 50],
      ],
      [
        [0.99, 1],
        [0.71, 50],
      ],
    );
    expect(bookMidPpm(straddle)).toBe(700_000);
  });

  it("returns null for an empty book", () => {
    expect(bookMidPpm(book([], []))).toBeNull();
    expect(bookMidPpm(book([[0.5, 1]], []))).toBeNull();
    expect(bookMidPpm(book([], [[0.5, 1]]))).toBeNull();
  });

  it("returns null for a crossed/inverted book", () => {
    // Best bid 0.80 > best ask 0.70 → stale/bad fetch, reject.
    expect(bookMidPpm(book([[0.80, 10]], [[0.70, 10]]))).toBeNull();
  });

  it("ignores zero and non-finite prices", () => {
    const dirty = book(
      [
        [0, 1],
        [0.40, 5],
      ],
      [
        [0.60, 5],
        [0, 1],
      ],
    );
    expect(bookMidPpm(dirty)).toBe(500_000);
  });
});
