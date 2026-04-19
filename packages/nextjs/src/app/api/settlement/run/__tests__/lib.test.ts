import { describe, it, expect } from "vitest";
import {
  LegStatus,
  TicketStatus,
  YES_OUTCOME,
  NO_OUTCOME,
  ZERO_OUTCOME,
  mapResolution,
  stripPolyPrefix,
} from "../lib";

describe("settlement route enums mirror Solidity", () => {
  it("LegStatus matches ILegOracle.LegStatus order", () => {
    expect(LegStatus.Unresolved).toBe(0);
    expect(LegStatus.Won).toBe(1);
    expect(LegStatus.Lost).toBe(2);
    expect(LegStatus.Voided).toBe(3);
  });

  it("TicketStatus matches ParlayEngine.TicketStatus order", () => {
    expect(TicketStatus.Active).toBe(0);
    expect(TicketStatus.Won).toBe(1);
    expect(TicketStatus.Lost).toBe(2);
    expect(TicketStatus.Voided).toBe(3);
    expect(TicketStatus.Claimed).toBe(4);
  });

  it("outcome sentinels are 32-byte and distinct", () => {
    expect(YES_OUTCOME).toHaveLength(66);
    expect(NO_OUTCOME).toHaveLength(66);
    expect(ZERO_OUTCOME).toHaveLength(66);
    expect(new Set([YES_OUTCOME, NO_OUTCOME, ZERO_OUTCOME]).size).toBe(3);
    expect(YES_OUTCOME.endsWith("01")).toBe(true);
    expect(NO_OUTCOME.endsWith("02")).toBe(true);
    expect(ZERO_OUTCOME).toBe(`0x${"00".repeat(32)}`);
  });
});

describe("mapResolution", () => {
  it("YES → Won + 0x01", () => {
    expect(mapResolution("YES")).toEqual({ status: LegStatus.Won, outcome: YES_OUTCOME });
  });

  it("NO → Lost + 0x02", () => {
    expect(mapResolution("NO")).toEqual({ status: LegStatus.Lost, outcome: NO_OUTCOME });
  });

  it("VOIDED → Voided + 0x00", () => {
    expect(mapResolution("VOIDED")).toEqual({ status: LegStatus.Voided, outcome: ZERO_OUTCOME });
  });

  it("every output is a valid 32-byte 0x hex the AdminOracleAdapter will accept", () => {
    const hex32 = /^0x[0-9a-f]{64}$/;
    for (const input of ["YES", "NO", "VOIDED"] as const) {
      const { status, outcome } = mapResolution(input);
      expect(status).toBeGreaterThanOrEqual(LegStatus.Won);
      expect(status).toBeLessThanOrEqual(LegStatus.Voided);
      expect(outcome).toMatch(hex32);
    }
  });

  it("status never reports Unresolved — settlement only relays terminal outcomes", () => {
    for (const input of ["YES", "NO", "VOIDED"] as const) {
      expect(mapResolution(input).status).not.toBe(LegStatus.Unresolved);
    }
  });
});

describe("stripPolyPrefix", () => {
  it("strips a single poly: prefix", () => {
    const cond = "0x" + "ab".repeat(32);
    expect(stripPolyPrefix(`poly:${cond}`)).toBe(cond);
  });

  it("leaves seed refs untouched", () => {
    expect(stripPolyPrefix("seed:3")).toBe("seed:3");
  });

  it("leaves a bare conditionId untouched", () => {
    const cond = "0xdeadbeef";
    expect(stripPolyPrefix(cond)).toBe(cond);
  });

  it("only strips one prefix — a doubled prefix is only single-stripped", () => {
    // Defensive: malformed input should round-trip to *something* the
    // Polymarket client will simply fail to resolve, never a silent
    // truncation of the real id.
    expect(stripPolyPrefix("poly:poly:xyz")).toBe("poly:xyz");
  });

  it("is case-sensitive (matches the DB column convention)", () => {
    expect(stripPolyPrefix("POLY:xyz")).toBe("POLY:xyz");
  });

  it("handles the empty string", () => {
    expect(stripPolyPrefix("")).toBe("");
  });

  it("handles an exact 'poly:' with nothing after it", () => {
    expect(stripPolyPrefix("poly:")).toBe("");
  });
});
