import { PolymarketClient } from "../client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CONDITION = "0xdeadbeef";

function makeClient(): PolymarketClient {
  return new PolymarketClient({
    gammaUrl: "https://gamma.test",
    clobUrl: "https://clob.test",
    rateLimitMs: 0,
  });
}

function mockGammaResponse(body: Record<string, unknown>) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => [body],
    text: async () => JSON.stringify([body]),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const baseMarket = {
  conditionId: CONDITION,
  question: "Will X happen?",
  description: "",
  endDateIso: "2026-12-31T00:00:00Z",
  archived: false,
  clobTokenIds: ["yes-tok", "no-tok"],
};

describe("PolymarketClient.fetchResolution", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null when market is not closed", async () => {
    mockGammaResponse({ ...baseMarket, closed: false, outcomePrices: ["0.6", "0.4"] });
    const res = await makeClient().fetchResolution(CONDITION);
    expect(res).toBeNull();
  });

  it("resolves YES when prices are exactly 1/0", async () => {
    mockGammaResponse({ ...baseMarket, closed: true, outcomePrices: ["1", "0"] });
    const res = await makeClient().fetchResolution(CONDITION);
    expect(res).not.toBeNull();
    expect(res!.outcome).toBe("YES");
    expect(res!.conditionId).toBe(CONDITION);
  });

  it("resolves NO when prices are exactly 0/1", async () => {
    mockGammaResponse({ ...baseMarket, closed: true, outcomePrices: ["0", "1"] });
    const res = await makeClient().fetchResolution(CONDITION);
    expect(res!.outcome).toBe("NO");
  });

  it("returns null on ambiguous prices (wait-for-exactness)", async () => {
    mockGammaResponse({ ...baseMarket, closed: true, outcomePrices: ["0.97", "0.03"] });
    const res = await makeClient().fetchResolution(CONDITION);
    expect(res).toBeNull();
  });

  it("returns null when prices straddle (0.5/0.5)", async () => {
    mockGammaResponse({ ...baseMarket, closed: true, outcomePrices: ["0.5", "0.5"] });
    const res = await makeClient().fetchResolution(CONDITION);
    expect(res).toBeNull();
  });

  it("voids a closed market with no outcome prices at all", async () => {
    mockGammaResponse({ ...baseMarket, closed: true, outcomePrices: undefined });
    const res = await makeClient().fetchResolution(CONDITION);
    expect(res!.outcome).toBe("VOIDED");
  });

  it('handles stringified JSON outcomePrices (\'["1","0"]\')', async () => {
    mockGammaResponse({ ...baseMarket, closed: true, outcomePrices: '["1","0"]' });
    const res = await makeClient().fetchResolution(CONDITION);
    expect(res!.outcome).toBe("YES");
  });
});
