import { toHex, stringToBytes, type Hex } from "viem";

export type ClaimOutcome = "YES" | "NO" | "VOID";

export interface EncodeClaimInput {
  /** ParlayVoo leg id (from LegRegistry). */
  legId: bigint;
  /** Polymarket conditionId — 0x-prefixed 32-byte hex. Embedded verbatim in the claim. */
  conditionId: `0x${string}`;
  /** Human-readable outcome the asserter is claiming. */
  outcome: ClaimOutcome;
  /** Optional slug for the Polymarket UI link; omit to skip the slug line. */
  polymarketSlug?: string;
  /** Assertion timestamp (seconds since epoch). */
  asOfTs: number;
}

/**
 * Build the UTF-8 claim bytes passed to UmaOracleAdapter.assertOutcome.
 * Format mirrors UMA's reference PredictionMarket._composeClaim — a human-readable
 * statement that UMA's DVM voters can verify against Polymarket's live resolution.
 *
 * The adapter forwards these bytes verbatim to uma.assertTruth, so this function
 * is the single source of truth for claim encoding across the codebase.
 */
export function encodeClaim(input: EncodeClaimInput): Hex {
  const lines: string[] = [
    `As of assertion timestamp ${input.asOfTs},`,
    `ParlayVoo leg ${input.legId.toString()} (Polymarket conditionId ${input.conditionId}) has resolved ${input.outcome}.`,
    `Verify at https://gamma-api.polymarket.com/markets/${input.conditionId}.`,
  ];
  if (input.polymarketSlug) {
    lines.push(`Polymarket UI: https://polymarket.com/event/${input.polymarketSlug}.`);
  }
  return toHex(stringToBytes(lines.join(" ")));
}
