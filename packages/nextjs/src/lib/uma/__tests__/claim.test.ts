import { describe, expect, it } from "vitest";
import { hexToString } from "viem";
import { encodeClaim } from "../claim";

describe("encodeClaim", () => {
  const base = {
    legId: 42n,
    conditionId: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as const,
    outcome: "YES" as const,
    asOfTs: 1714000000,
  };

  it("produces deterministic output for the same input", () => {
    expect(encodeClaim(base)).toEqual(encodeClaim(base));
  });

  it("differs when outcome changes", () => {
    expect(encodeClaim(base)).not.toEqual(encodeClaim({ ...base, outcome: "NO" }));
  });

  it("differs when legId changes", () => {
    expect(encodeClaim(base)).not.toEqual(encodeClaim({ ...base, legId: 43n }));
  });

  it("embeds the conditionId verbatim", () => {
    const text = hexToString(encodeClaim(base));
    expect(text).toContain(base.conditionId);
  });

  it("embeds the outcome verbatim", () => {
    const text = hexToString(encodeClaim(base));
    expect(text).toContain("YES");
  });

  it("includes a Polymarket verification URL", () => {
    const text = hexToString(encodeClaim(base));
    expect(text).toContain(`gamma-api.polymarket.com/markets/${base.conditionId}`);
  });

  it("adds a Polymarket UI line only when slug is provided", () => {
    const without = hexToString(encodeClaim(base));
    const withSlug = hexToString(encodeClaim({ ...base, polymarketSlug: "will-x-happen" }));
    expect(without).not.toContain("polymarket.com/event");
    expect(withSlug).toContain("polymarket.com/event/will-x-happen");
  });
});
