import {
  PPM,
  BPS,
  PROTOCOL_FEE_BPS,
  CORRELATION_ASYMPTOTE_BPS,
  CORRELATION_HALF_SAT_PPM,
  USDC_DECIMALS,
  MIN_LEGS,
  MAX_LEGS,
  MIN_STAKE_USDC,
} from "./constants.js";
import type { QuoteResponse } from "./types.js";

/**
 * Multiply probabilities (each in PPM) to get combined fair multiplier in x1e6.
 * Uses iterative division to mirror ParlayMath.sol exactly:
 *   multiplier = PPM; multiplier = multiplier * PPM / prob_i for each leg.
 *
 * NOTE: This was refactored from single-division (PPM^(n+1) / product(probs))
 * to iterative division. BigInt truncation at each step can produce results
 * that differ by at most 1 unit from the old formula for certain inputs.
 * The iterative approach is correct because it matches the Solidity contract's
 * computation exactly (shared math parity invariant).
 */
export function computeMultiplier(probsPPM: number[]): bigint {
  if (probsPPM.length === 0) {
    throw new Error("computeMultiplier: empty probs");
  }
  const ppm = BigInt(PPM);
  let multiplier = ppm; // start at 1x (1_000_000)
  for (const p of probsPPM) {
    if (p <= 0 || p > PPM) {
      throw new Error("computeMultiplier: prob out of range");
    }
    multiplier = (multiplier * ppm) / BigInt(p);
  }
  return multiplier;
}

/**
 * Apply per-leg multiplicative fee. Iteratively multiplies by (BPS - feeBps) / BPS
 * once per leg. Matches ParlayMath.applyFee (Solidity) bit-for-bit.
 *   result = mul × ((BPS - f) / BPS)^numLegs
 * Reverts when feeBps >= BPS.
 */
export function applyFee(mulX1e6: bigint, numLegs: number, feeBps: number): bigint {
  if (feeBps >= BPS) {
    throw new Error("applyFee: fee >= 100%");
  }
  const factor = BigInt(BPS - feeBps);
  const denom = BigInt(BPS);
  let m = mulX1e6;
  for (let i = 0; i < numLegs; i++) {
    m = (m * factor) / denom;
  }
  return m;
}

/**
 * Saturating discount in BPS for a single correlation group of size n.
 *   discount = D × (n - 1) × PPM / ((n - 1) × PPM + halfSatPpm)
 * Returns 0 for n < 2.
 */
export function correlationDiscountBps(
  n: number,
  asymptoteBps: number = CORRELATION_ASYMPTOTE_BPS,
  halfSatPpm: number = CORRELATION_HALF_SAT_PPM,
): bigint {
  if (n < 2) return 0n;
  const ppm = BigInt(PPM);
  const nm1 = BigInt(n - 1);
  return (BigInt(asymptoteBps) * nm1 * ppm) / (nm1 * ppm + BigInt(halfSatPpm));
}

/**
 * Compose a multiplier with per-group saturating discounts.
 *   mul × ∏ (BPS - discount_g) / BPS over all groups with n_g ≥ 2.
 * Groups with size < 2 are skipped (no discount).
 */
export function applyCorrelation(
  mulX1e6: bigint,
  groupSizes: number[],
  asymptoteBps: number = CORRELATION_ASYMPTOTE_BPS,
  halfSatPpm: number = CORRELATION_HALF_SAT_PPM,
): bigint {
  let m = mulX1e6;
  const bps = BigInt(BPS);
  for (const n of groupSizes) {
    if (n < 2) continue;
    const discount = correlationDiscountBps(n, asymptoteBps, halfSatPpm);
    m = (m * (bps - discount)) / bps;
  }
  return m;
}

/**
 * Compute payout from stake and net multiplier.
 * payout = stake * netMultiplierX1e6 / PPM
 */
export function computePayout(stake: bigint, netMultiplierX1e6: bigint): bigint {
  return (stake * netMultiplierX1e6) / BigInt(PPM);
}

/**
 * Round a USDC microunit amount UP to the nearest $0.01 grain.
 * 6-decimal USDC ⇒ one cent = 10_000 microunits.
 *
 * Used for the USDC approval the buy flow sets before `buyTicketSigned`:
 * the approval needs slack so a sub-cent rounding mismatch between the
 * UI's displayed stake and the parsed bigint can never make the engine's
 * `safeTransferFrom` revert. The ticket itself still consumes the exact
 * raw stake the quote was signed for.
 */
const CENT_USDC_RAW = 10_000n;
export function ceilToCentRaw(amountRaw: bigint): bigint {
  if (amountRaw <= 0n) return amountRaw;
  const remainder = amountRaw % CENT_USDC_RAW;
  if (remainder === 0n) return amountRaw;
  return amountRaw + (CENT_USDC_RAW - remainder);
}

/**
 * Full quote computation. Takes leg probabilities (PPM) and raw stake (USDC with decimals).
 * Returns a complete QuoteResponse. Optional `groupSizes` lets callers fold in
 * per-correlation-group sizes; defaults to none (independent legs).
 */
export function computeQuote(
  legProbsPPM: number[],
  stakeRaw: bigint,
  legIds: number[] = [],
  outcomes: string[] = [],
  groupSizes: number[] = [],
  feeBps: number = PROTOCOL_FEE_BPS,
  asymptoteBps: number = CORRELATION_ASYMPTOTE_BPS,
  halfSatPpm: number = CORRELATION_HALF_SAT_PPM,
): QuoteResponse {
  const numLegs = legProbsPPM.length;

  if (numLegs < MIN_LEGS || numLegs > MAX_LEGS) {
    return invalidQuote(legIds, outcomes, stakeRaw, legProbsPPM, `Leg count must be ${MIN_LEGS}-${MAX_LEGS}`);
  }

  const minStakeRaw = BigInt(MIN_STAKE_USDC) * BigInt(10 ** USDC_DECIMALS);
  if (stakeRaw < minStakeRaw) {
    return invalidQuote(legIds, outcomes, stakeRaw, legProbsPPM, `Stake must be at least ${MIN_STAKE_USDC} USDC`);
  }

  for (const p of legProbsPPM) {
    if (p <= 0 || p >= PPM) {
      return invalidQuote(legIds, outcomes, stakeRaw, legProbsPPM, "Probability must be between 0 and 1000000 exclusive");
    }
  }

  const fairMultiplier = computeMultiplier(legProbsPPM);
  const feeAdjusted = applyFee(fairMultiplier, numLegs, feeBps);
  const netMultiplier = applyCorrelation(feeAdjusted, groupSizes, asymptoteBps, halfSatPpm);
  const potentialPayout = computePayout(stakeRaw, netMultiplier);

  return {
    legIds,
    outcomes,
    stake: stakeRaw.toString(),
    multiplierX1e6: netMultiplier.toString(),
    potentialPayout: potentialPayout.toString(),
    probabilities: legProbsPPM,
    valid: true,
  };
}

/**
 * Compute progressive payout: partial claim based on won legs.
 * Returns the total partial payout and the new claimable amount.
 */
export function computeProgressivePayout(
  effectiveStake: bigint,
  wonProbsPPM: number[],
  potentialPayout: bigint,
  alreadyClaimed: bigint
): { partialPayout: bigint; claimable: bigint } {
  if (wonProbsPPM.length === 0) {
    throw new Error("computeProgressivePayout: no won legs");
  }
  const partialMultiplier = computeMultiplier(wonProbsPPM);
  let partialPayout = computePayout(effectiveStake, partialMultiplier);
  if (partialPayout > potentialPayout) partialPayout = potentialPayout;
  const claimable = partialPayout > alreadyClaimed ? partialPayout - alreadyClaimed : 0n;
  return { partialPayout, claimable };
}

/**
 * Compute cashout value for an early exit.
 * fairValue = wonValue (expected value given won legs; unresolved risk priced via penalty)
 * penaltyBps = basePenaltyBps * unresolvedCount / totalLegs
 * cashoutValue = fairValue * (BPS - penaltyBps) / BPS
 */
export function computeCashoutValue(
  effectiveStake: bigint,
  wonProbsPPM: number[],
  unresolvedCount: number,
  basePenaltyBps: number,
  totalLegs: number,
  potentialPayout: bigint,
): { cashoutValue: bigint; penaltyBps: number; fairValue: bigint } {
  if (wonProbsPPM.length === 0) {
    throw new Error("computeCashoutValue: no won legs");
  }
  if (totalLegs <= 0) {
    throw new Error("computeCashoutValue: zero totalLegs");
  }
  if (unresolvedCount <= 0) {
    throw new Error("computeCashoutValue: no unresolved legs");
  }
  if (unresolvedCount > totalLegs) {
    throw new Error("computeCashoutValue: unresolved > total");
  }
  if (basePenaltyBps < 0 || basePenaltyBps > BPS) {
    throw new Error("computeCashoutValue: penalty out of range");
  }

  const bps = BigInt(BPS);

  // Fair value = expected payout given won legs.
  // wonMultiplier = 1/product(wonProbs) in PPM; wonValue = stake / product(wonProbs).
  // This already equals Prob(unresolved win) × fullPayout because the unresolved
  // probabilities cancel out when deriving EV from won legs alone.
  // The penalty (below) prices in the risk of unresolved legs.
  const wonMultiplier = computeMultiplier(wonProbsPPM);
  const fairValue = computePayout(effectiveStake, wonMultiplier);

  // Scaled penalty
  const penaltyBps = Number(
    (BigInt(basePenaltyBps) * BigInt(unresolvedCount)) / BigInt(totalLegs),
  );
  let cashoutValue = (fairValue * (bps - BigInt(penaltyBps))) / bps;

  // Cap at potential payout
  if (cashoutValue > potentialPayout) {
    cashoutValue = potentialPayout;
  }

  return { cashoutValue, penaltyBps, fairValue };
}

/**
 * LockVaultV2 fee-share multiplier (BPS) for a committed duration (seconds).
 * Mirrors LockVaultV2.feeShareForDuration exactly.
 *
 *   feeShareBps = 10_000 + MAX_BOOST_BPS * d / (d + HALF_LIFE_SECS)
 *
 * Asymptotic: base 10_000 at d=MIN, approaches 40_000 as d → ∞.
 * Throws when duration < MIN_LOCK_DURATION (matches Solidity require).
 */
export const LOCK_MIN_DURATION_SECS = 7n * 86_400n;           // 7 days
export const LOCK_HALF_LIFE_SECS = 730n * 86_400n;            // 2 years
export const LOCK_MAX_BOOST_BPS = 30_000n;
export const LOCK_MAX_PENALTY_BPS = 3_000n;

export function feeShareForDuration(durationSecs: bigint): bigint {
  if (durationSecs < LOCK_MIN_DURATION_SECS) {
    throw new Error("feeShareForDuration: duration below minimum");
  }
  const boost = (LOCK_MAX_BOOST_BPS * durationSecs) / (durationSecs + LOCK_HALF_LIFE_SECS);
  return 10_000n + boost;
}

/**
 * LockVaultV2 early-exit penalty (BPS) given remaining lock time (seconds).
 * Mirrors LockVaultV2.penaltyBpsForRemaining exactly.
 *
 *   penaltyBps = MAX_PENALTY_BPS * remaining / (remaining + HALF_LIFE_SECS)
 *
 * Returns 0 when remaining = 0 (lock has matured).
 */
export function penaltyBpsForRemaining(remainingSecs: bigint): bigint {
  if (remainingSecs === 0n) return 0n;
  return (LOCK_MAX_PENALTY_BPS * remainingSecs) / (remainingSecs + LOCK_HALF_LIFE_SECS);
}

function invalidQuote(
  legIds: number[],
  outcomes: string[],
  stakeRaw: bigint,
  probabilities: number[],
  reason: string
): QuoteResponse {
  return {
    legIds,
    outcomes,
    stake: stakeRaw.toString(),
    multiplierX1e6: "0",
    potentialPayout: "0",
    probabilities,
    valid: false,
    reason,
  };
}
