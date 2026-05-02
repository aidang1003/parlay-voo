// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ParlayMath
/// @notice Pure math library for parlay odds and payout calculations.
///         All probabilities are expressed in PPM (parts per million), so 500_000 = 50%.
///         Multipliers are expressed as X * 1e6 (e.g. 2x = 2_000_000).
///         Mirrors `packages/shared/src/math.ts` exactly (math-parity invariant).
library ParlayMath {
    uint256 internal constant PPM = 1e6;
    uint256 internal constant BPS = 10_000;

    /// @notice Compute the fair multiplier by chaining implied odds for each leg.
    ///         multiplier = product(1e6 / prob_i) across all legs, scaled to 1e6.
    /// @param probsPPM Array of leg probabilities in PPM (each must be > 0 and <= 1e6).
    /// @return multiplierX1e6 The combined fair multiplier scaled by 1e6.
    function computeMultiplier(uint256[] memory probsPPM) internal pure returns (uint256 multiplierX1e6) {
        require(probsPPM.length > 0, "ParlayMath: empty probs");
        multiplierX1e6 = PPM; // start at 1x (1_000_000)
        for (uint256 i = 0; i < probsPPM.length; i++) {
            require(probsPPM[i] > 0 && probsPPM[i] <= PPM, "ParlayMath: prob out of range");
            multiplierX1e6 = (multiplierX1e6 * PPM) / probsPPM[i];
        }
    }

    /// @notice Apply per-leg multiplicative fee. Iteratively multiplies by
    ///         (BPS - feeBps) / BPS once per leg.
    ///           result = mul × ((BPS - f) / BPS)^numLegs
    /// @dev    Iterative loop, not pow — must match math.ts bit-for-bit.
    function applyFee(uint256 mulX1e6, uint256 numLegs, uint256 feeBps) internal pure returns (uint256) {
        require(feeBps < BPS, "ParlayMath: fee >= 100%");
        uint256 m = mulX1e6;
        for (uint256 i = 0; i < numLegs; i++) {
            m = (m * (BPS - feeBps)) / BPS;
        }
        return m;
    }

    /// @notice Saturating discount in BPS for a single correlation group of size n.
    ///           discount = D × (n - 1) × PPM / ((n - 1) × PPM + halfSatPpm)
    ///         Returns 0 for n < 2.
    function correlationDiscountBps(uint256 n, uint256 asymptoteBps, uint256 halfSatPpm)
        internal
        pure
        returns (uint256)
    {
        if (n < 2) return 0;
        uint256 nm1 = n - 1;
        return (asymptoteBps * nm1 * PPM) / (nm1 * PPM + halfSatPpm);
    }

    /// @notice Compose a multiplier with per-group saturating discounts.
    ///           mul × ∏ (BPS - discount_g) / BPS over all groups with n_g ≥ 2.
    /// @dev    Group sizes < 2 are skipped (no discount).
    function applyCorrelation(
        uint256 mulX1e6,
        uint256[] memory groupSizes,
        uint256 asymptoteBps,
        uint256 halfSatPpm
    ) internal pure returns (uint256) {
        uint256 m = mulX1e6;
        for (uint256 i = 0; i < groupSizes.length; i++) {
            uint256 n = groupSizes[i];
            if (n < 2) continue;
            uint256 discount = correlationDiscountBps(n, asymptoteBps, halfSatPpm);
            m = (m * (BPS - discount)) / BPS;
        }
        return m;
    }

    /// @notice Compute the payout from a given stake and net multiplier.
    /// @param stake The wager amount (in token units, e.g. USDC with 6 decimals).
    /// @param netMultiplierX1e6 The net multiplier (scaled by 1e6).
    /// @return payout The total payout amount.
    function computePayout(uint256 stake, uint256 netMultiplierX1e6) internal pure returns (uint256 payout) {
        payout = (stake * netMultiplierX1e6) / PPM;
    }

    /// @notice Compute the cashout value for an early exit.
    /// @param effectiveStake The wager amount after fees.
    /// @param wonProbsPPM Probabilities of already-won legs (each in PPM).
    /// @param unresolvedCount Number of unresolved legs.
    /// @param basePenaltyBps Base penalty in bps (scaled by unresolved/total legs).
    /// @param totalLegs Total number of legs in the ticket.
    /// @param potentialPayout Maximum payout (cap).
    /// @return cashoutValue The amount the user receives.
    /// @return penaltyBps The applied penalty in bps.
    function computeCashoutValue(
        uint256 effectiveStake,
        uint256[] memory wonProbsPPM,
        uint256 unresolvedCount,
        uint256 basePenaltyBps,
        uint256 totalLegs,
        uint256 potentialPayout
    ) internal pure returns (uint256 cashoutValue, uint256 penaltyBps) {
        require(wonProbsPPM.length > 0, "ParlayMath: no won legs");
        require(totalLegs > 0, "ParlayMath: zero totalLegs");
        require(unresolvedCount > 0, "ParlayMath: no unresolved legs");
        require(unresolvedCount <= totalLegs, "ParlayMath: unresolved > total");
        require(basePenaltyBps <= BPS, "ParlayMath: penalty > 100%");

        uint256 wonMultiplier = computeMultiplier(wonProbsPPM);
        uint256 fairValue = computePayout(effectiveStake, wonMultiplier);

        penaltyBps = (basePenaltyBps * unresolvedCount) / totalLegs;
        cashoutValue = (fairValue * (BPS - penaltyBps)) / BPS;

        if (cashoutValue > potentialPayout) {
            cashoutValue = potentialPayout;
        }
    }
}
