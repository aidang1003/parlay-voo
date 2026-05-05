import type { Hex } from "viem";
import { NO_OUTCOME, YES_OUTCOME, ZERO_OUTCOME } from "~~/utils/parlay";

export { YES_OUTCOME, NO_OUTCOME, ZERO_OUTCOME };

export const LegStatus = { Unresolved: 0, Won: 1, Lost: 2, Voided: 3 } as const;
export const TicketStatus = { Active: 0, Won: 1, Lost: 2, Voided: 3, Claimed: 4 } as const;

export function mapResolution(outcome: "YES" | "NO" | "VOIDED"): { status: number; outcome: Hex } {
  switch (outcome) {
    case "YES":
      return { status: LegStatus.Won, outcome: YES_OUTCOME as Hex };
    case "NO":
      return { status: LegStatus.Lost, outcome: NO_OUTCOME as Hex };
    case "VOIDED":
      return { status: LegStatus.Voided, outcome: ZERO_OUTCOME as Hex };
  }
}
