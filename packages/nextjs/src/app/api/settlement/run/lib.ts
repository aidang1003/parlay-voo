/**
 * Pure helpers for /api/settlement/run. Extracted so they can be unit-tested
 * without spinning up viem clients or the Next.js route runtime.
 */

import type { Hex } from "viem";

// enum LegStatus { Unresolved, Won, Lost, Voided }
export const LegStatus = { Unresolved: 0, Won: 1, Lost: 2, Voided: 3 } as const;

// enum TicketStatus { Active, Won, Lost, Voided, Claimed }
export const TicketStatus = { Active: 0, Won: 1, Lost: 2, Voided: 3, Claimed: 4 } as const;

export const YES_OUTCOME: Hex = `0x${"00".repeat(31)}01`;
export const NO_OUTCOME: Hex = `0x${"00".repeat(31)}02`;
export const ZERO_OUTCOME: Hex = `0x${"00".repeat(32)}`;

export function mapResolution(
  outcome: "YES" | "NO" | "VOIDED",
): { status: number; outcome: Hex } {
  switch (outcome) {
    case "YES":
      return { status: LegStatus.Won, outcome: YES_OUTCOME };
    case "NO":
      return { status: LegStatus.Lost, outcome: NO_OUTCOME };
    case "VOIDED":
      return { status: LegStatus.Voided, outcome: ZERO_OUTCOME };
  }
}

/**
 * Polymarket conditionIds are stored in the markets table prefixed with
 * `poly:` so the sourceRef column stays self-describing across data providers
 * (seed: …, poly: …, etc.). Phase A of settlement needs the raw conditionId
 * to hit Polymarket's API, so strip the prefix if present.
 */
export function stripPolyPrefix(sourceRef: string): string {
  return sourceRef.startsWith("poly:") ? sourceRef.slice(5) : sourceRef;
}
