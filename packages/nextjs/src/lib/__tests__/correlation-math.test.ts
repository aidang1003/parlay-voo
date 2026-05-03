import { describe, it, expect } from "vitest";
import {
  applyFee,
  correlationDiscountBps,
  applyCorrelation,
  computeMultiplier,
  ceilToCentRaw,
  BPS,
  PPM,
  PROTOCOL_FEE_BPS,
  CORRELATION_ASYMPTOTE_BPS,
  CORRELATION_HALF_SAT_PPM,
} from "@parlayvoo/shared";

// These vectors are produced by the same iterative formula the Solidity
// `ParlayMath.applyFee` and `ParlayMath.applyCorrelation` use. Any drift
// breaks the math-parity invariant called out in CLAUDE.md.

describe("applyFee", () => {
  it("matches the iterative reference formula", () => {
    const cases: Array<{ mul: bigint; n: number; f: number; expected: bigint }> = [
      { mul: 4_000_000n, n: 2, f: 1000, expected: 3_240_000n }, // 4e6 × 0.9² = 3.24e6
      { mul: 1_000_000n, n: 5, f: 1000, expected: 590_490n }, // 1e6 × 0.9⁵ = 590_490
      { mul: 4_000_000n, n: 0, f: 1000, expected: 4_000_000n }, // n=0 → unchanged
      { mul: 4_000_000n, n: 5, f: 0, expected: 4_000_000n }, // f=0 → unchanged
    ];
    for (const c of cases) {
      expect(applyFee(c.mul, c.n, c.f)).toBe(c.expected);
    }
  });

  it("throws when fee >= BPS", () => {
    expect(() => applyFee(1_000_000n, 1, BPS)).toThrow();
  });
});

describe("correlationDiscountBps", () => {
  it("matches the reference table at default D=8000, k=1e6", () => {
    expect(correlationDiscountBps(2, 8000, 1_000_000)).toBe(4000n);
    expect(correlationDiscountBps(3, 8000, 1_000_000)).toBe(5333n);
    expect(correlationDiscountBps(4, 8000, 1_000_000)).toBe(6000n);
    expect(correlationDiscountBps(5, 8000, 1_000_000)).toBe(6400n);
    expect(correlationDiscountBps(8, 8000, 1_000_000)).toBe(7000n);
  });

  it("returns 0 for n < 2", () => {
    expect(correlationDiscountBps(0, 8000, 1_000_000)).toBe(0n);
    expect(correlationDiscountBps(1, 8000, 1_000_000)).toBe(0n);
  });

  it("returns 0 when D is 0 regardless of n or k", () => {
    expect(correlationDiscountBps(2, 0, 1_000_000)).toBe(0n);
    expect(correlationDiscountBps(8, 0, 1_000_000)).toBe(0n);
  });

  it("flattens with very large k", () => {
    // k = 100×PPM makes discount(2) ≈ D / 101 ≈ 79 bps
    expect(correlationDiscountBps(2, 8000, 100 * 1_000_000)).toBeLessThan(100n);
  });
});

describe("applyCorrelation", () => {
  it("composes per-group factors", () => {
    // Two groups (sizes 2 + 3) → factors compose: 0.6 × 0.4666... = 0.28
    // 10e6 × (10000-4000)/10000 = 6e6 → 6e6 × (10000-5333)/10000 = 2_800_200
    const mul = applyCorrelation(10_000_000n, [2, 3], 8000, 1_000_000);
    expect(mul).toBe(2_800_200n);
  });

  it("skips groups with n < 2", () => {
    const mul = applyCorrelation(4_000_000n, [1, 2], 8000, 1_000_000);
    expect(mul).toBe(2_400_000n);
  });

  it("returns input unchanged when all groups are < 2", () => {
    expect(applyCorrelation(4_000_000n, [], 8000, 1_000_000)).toBe(4_000_000n);
    expect(applyCorrelation(4_000_000n, [1, 1], 8000, 1_000_000)).toBe(4_000_000n);
  });
});

describe("ceilToCentRaw", () => {
  // 6-decimal USDC. One cent = 10_000 microunits. Used to size the buy-flow
  // approve so a sub-cent drift can never starve the engine's transferFrom.
  it("leaves zero unchanged", () => {
    expect(ceilToCentRaw(0n)).toBe(0n);
  });

  it("leaves an exact cent unchanged", () => {
    expect(ceilToCentRaw(5_930_000n)).toBe(5_930_000n);
  });

  it("rounds up sub-cent residue", () => {
    // 5.9311 USDC → 5_931_100 → next cent is 5_940_000 (5.94 USDC).
    expect(ceilToCentRaw(5_931_100n)).toBe(5_940_000n);
    // 5.9301 USDC → 5_930_100 → next cent is 5_940_000.
    expect(ceilToCentRaw(5_930_100n)).toBe(5_940_000n);
    // 5.93001 truncated to 6dp is 5_930_010 → 5_940_000.
    expect(ceilToCentRaw(5_930_010n)).toBe(5_940_000n);
  });

  it("rounds up the smallest possible residue", () => {
    expect(ceilToCentRaw(1n)).toBe(10_000n);
  });

  it("passes through negative or unusable values unchanged", () => {
    expect(ceilToCentRaw(-1n)).toBe(-1n);
  });
});

describe("end-to-end pricing parity", () => {
  // Full pipeline: independent legs → fair multiplier → fee → correlation.
  // This is exactly what the Solidity ParlayEngine runs, so the resulting
  // bigint must match across runtimes for the invariant to hold.
  it("reproduces the on-chain ticket multiplier formula", () => {
    const probs = [500_000, 250_000, 200_000];
    const fair = computeMultiplier(probs);
    const feeAdjusted = applyFee(fair, probs.length, PROTOCOL_FEE_BPS);
    // No correlation group → discount path is a no-op.
    const final = applyCorrelation(
      feeAdjusted,
      [],
      CORRELATION_ASYMPTOTE_BPS,
      CORRELATION_HALF_SAT_PPM,
    );
    // Sanity bounds: final must be a strict subset of fair, and within
    // (1−f)^n × fair to within rounding.
    expect(final).toBeLessThan(fair);
    expect(final).toBe(feeAdjusted);
  });

  it("randomized 1000-vector property: fee+corr never inflates", () => {
    let rng = 0xdeadbeef;
    const next = (max: number) => {
      rng = (Math.imul(rng, 0x01000193) ^ 0x9e3779b9) >>> 0;
      return rng % max;
    };

    for (let i = 0; i < 1000; i++) {
      const n = 2 + next(4);
      const probs = Array.from({ length: n }, () => 1 + next(PPM - 2));
      const fair = computeMultiplier(probs);
      const feeAdjusted = applyFee(fair, n, PROTOCOL_FEE_BPS);
      const groupCount = next(2);
      const groupSizes = groupCount === 0 ? [] : [2 + next(Math.min(n, 3))];
      const finalMul = applyCorrelation(
        feeAdjusted,
        groupSizes,
        CORRELATION_ASYMPTOTE_BPS,
        CORRELATION_HALF_SAT_PPM,
      );
      // Net invariant: result ≤ fair for any combination of legs and groups.
      expect(finalMul <= fair).toBe(true);
    }
  });
});
