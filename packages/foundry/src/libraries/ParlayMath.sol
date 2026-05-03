// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Probabilities in PPM (1e6); multipliers as X*1e6. Mirrors packages/shared/src/math.ts exactly.
library ParlayMath {
    uint256 internal constant PPM = 1e6;
    uint256 internal constant BPS = 10_000;

    /// @notice multiplier = ∏(1e6 / prob_i).
    function computeMultiplier(uint256[] memory probsPPM) internal pure returns (uint256 multiplierX1e6) {
        require(probsPPM.length > 0, "ParlayMath: empty probs");
        multiplierX1e6 = PPM;
        for (uint256 i = 0; i < probsPPM.length; i++) {
            require(probsPPM[i] > 0 && probsPPM[i] <= PPM, "ParlayMath: prob out of range");
            multiplierX1e6 = (multiplierX1e6 * PPM) / probsPPM[i];
        }
    }

    /// @notice mul × ((BPS - f) / BPS)^numLegs.
    /// @dev Iterative loop not pow — must match math.ts bit-for-bit.
    function applyFee(uint256 mulX1e6, uint256 numLegs, uint256 feeBps) internal pure returns (uint256) {
        require(feeBps < BPS, "ParlayMath: fee >= 100%");
        uint256 m = mulX1e6;
        for (uint256 i = 0; i < numLegs; i++) {
            m = (m * (BPS - feeBps)) / BPS;
        }
        return m;
    }

    /// @notice discount = D × (n-1) × PPM / ((n-1) × PPM + halfSatPpm). Returns 0 for n < 2.
    function correlationDiscountBps(uint256 n, uint256 asymptoteBps, uint256 halfSatPpm)
        internal
        pure
        returns (uint256)
    {
        if (n < 2) return 0;
        uint256 nm1 = n - 1;
        return (asymptoteBps * nm1 * PPM) / (nm1 * PPM + halfSatPpm);
    }

    /// @notice mul × ∏ (BPS - discount_g) / BPS over groups with n_g ≥ 2.
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

    function computePayout(uint256 stake, uint256 netMultiplierX1e6) internal pure returns (uint256 payout) {
        payout = (stake * netMultiplierX1e6) / PPM;
    }

    /// @notice penaltyBps scales by unresolvedCount/totalLegs; cashoutValue is capped at potentialPayout.
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
