// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ParlayMath} from "../../src/libraries/ParlayMath.sol";

/// @dev Wrapper contract so vm.expectRevert can catch reverts from library calls
contract ParlayMathWrapper {
    function computeMultiplier(uint256[] memory probs) external pure returns (uint256) {
        return ParlayMath.computeMultiplier(probs);
    }

    function applyFee(uint256 mulX1e6, uint256 numLegs, uint256 feeBps) external pure returns (uint256) {
        return ParlayMath.applyFee(mulX1e6, numLegs, feeBps);
    }

    function correlationDiscountBps(uint256 n, uint256 asymptoteBps, uint256 halfSatPpm)
        external
        pure
        returns (uint256)
    {
        return ParlayMath.correlationDiscountBps(n, asymptoteBps, halfSatPpm);
    }

    function applyCorrelation(
        uint256 mulX1e6,
        uint256[] memory groupSizes,
        uint256 asymptoteBps,
        uint256 halfSatPpm
    ) external pure returns (uint256) {
        return ParlayMath.applyCorrelation(mulX1e6, groupSizes, asymptoteBps, halfSatPpm);
    }

    function computePayout(uint256 stake, uint256 netMultiplierX1e6) external pure returns (uint256) {
        return ParlayMath.computePayout(stake, netMultiplierX1e6);
    }

    function computeCashoutValue(
        uint256 effectiveStake,
        uint256[] memory wonProbsPPM,
        uint256 unresolvedCount,
        uint256 basePenaltyBps,
        uint256 totalLegs,
        uint256 potentialPayout
    ) external pure returns (uint256, uint256) {
        return ParlayMath.computeCashoutValue(effectiveStake, wonProbsPPM, unresolvedCount, basePenaltyBps, totalLegs, potentialPayout);
    }
}

contract ParlayMathTest is Test {
    ParlayMathWrapper wrapper;

    function setUp() public {
        wrapper = new ParlayMathWrapper();
    }

    // ── computeMultiplier ────────────────────────────────────────────────

    function test_computeMultiplier_singleLeg50Percent() public pure {
        uint256[] memory probs = new uint256[](1);
        probs[0] = 500_000; // 50%
        uint256 mult = ParlayMath.computeMultiplier(probs);
        // 1e6 / 0.5 = 2x = 2_000_000
        assertEq(mult, 2_000_000);
    }

    function test_computeMultiplier_twoLegs50Percent() public pure {
        uint256[] memory probs = new uint256[](2);
        probs[0] = 500_000;
        probs[1] = 500_000;
        uint256 mult = ParlayMath.computeMultiplier(probs);
        // 2x * 2x = 4x = 4_000_000
        assertEq(mult, 4_000_000);
    }

    function test_computeMultiplier_threeLegsVaryingProbs() public pure {
        uint256[] memory probs = new uint256[](3);
        probs[0] = 500_000; // 2x
        probs[1] = 250_000; // 4x
        probs[2] = 1_000_000; // 1x (certainty)
        uint256 mult = ParlayMath.computeMultiplier(probs);
        // 2 * 4 * 1 = 8x = 8_000_000
        assertEq(mult, 8_000_000);
    }

    function test_computeMultiplier_certainty() public pure {
        uint256[] memory probs = new uint256[](2);
        probs[0] = 1_000_000; // 100%
        probs[1] = 1_000_000; // 100%
        uint256 mult = ParlayMath.computeMultiplier(probs);
        assertEq(mult, 1_000_000); // 1x
    }

    function test_computeMultiplier_revertsOnZeroProb() public {
        uint256[] memory probs = new uint256[](1);
        probs[0] = 0;
        vm.expectRevert("ParlayMath: prob out of range");
        wrapper.computeMultiplier(probs);
    }

    function test_computeMultiplier_revertsOnProbAbove1e6() public {
        uint256[] memory probs = new uint256[](1);
        probs[0] = 1_000_001;
        vm.expectRevert("ParlayMath: prob out of range");
        wrapper.computeMultiplier(probs);
    }

    function test_computeMultiplier_revertsOnEmpty() public {
        uint256[] memory probs = new uint256[](0);
        vm.expectRevert("ParlayMath: empty probs");
        wrapper.computeMultiplier(probs);
    }

    // ── computeMultiplier parity (non-round inputs) ─────────────────────
    // These values serve as reference for the TS mirror. Any change here
    // must be reflected in packages/services/test/quote.test.ts.

    function test_computeMultiplier_nonRound_threeLegs() public pure {
        // 60% / 40% / 50% — intermediate truncation matters
        uint256[] memory probs = new uint256[](3);
        probs[0] = 600_000;
        probs[1] = 400_000;
        probs[2] = 500_000;
        // m = 1e6 -> 1e12/600000=1666666 -> 1666666e6/400000=4166665 -> 4166665e6/500000=8333330
        assertEq(ParlayMath.computeMultiplier(probs), 8_333_330);
    }

    function test_computeMultiplier_nonRound_twoLegs() public pure {
        // 333_333 (~33.3%) / 666_667 (~66.7%)
        uint256[] memory probs = new uint256[](2);
        probs[0] = 333_333;
        probs[1] = 666_667;
        assertEq(ParlayMath.computeMultiplier(probs), 4_500_002);
    }

    function test_computeMultiplier_nonRound_fourLegs() public pure {
        // 700_000 / 300_000 / 800_000 / 450_000
        uint256[] memory probs = new uint256[](4);
        probs[0] = 700_000;
        probs[1] = 300_000;
        probs[2] = 800_000;
        probs[3] = 450_000;
        uint256 mult = ParlayMath.computeMultiplier(probs);
        // m = 1e6 -> 1428571 -> 4761903 -> 5952378 -> 13227506
        assertEq(mult, 13_227_506);
    }

    function test_computeMultiplier_nonRound_fiveLegs() public pure {
        // 550_000 / 350_000 / 650_000 / 420_000 / 780_000
        uint256[] memory probs = new uint256[](5);
        probs[0] = 550_000;
        probs[1] = 350_000;
        probs[2] = 650_000;
        probs[3] = 420_000;
        probs[4] = 780_000;
        uint256 mult = ParlayMath.computeMultiplier(probs);
        assertEq(mult, 24_395_612);
    }

    function test_computeCashoutValue_nonRound_penalty() public pure {
        // penaltyBps = basePenaltyBps * unresolvedCount / totalLegs
        // 1500 * 2 / 7 = 428 (truncated from 428.57...)
        uint256[] memory wonProbs = new uint256[](1);
        wonProbs[0] = 500_000;
        (, uint256 penaltyBps) = ParlayMath.computeCashoutValue(
            10e6, wonProbs, 2, 1500, 7, type(uint128).max
        );
        assertEq(penaltyBps, 428);
    }

    // ── applyFee ─────────────────────────────────────────────────────────

    function test_applyFee_2legsAt1000Bps() public pure {
        // mul × 0.9^2 = mul × 0.81. 4_000_000 × 0.81 = 3_240_000.
        assertEq(ParlayMath.applyFee(4_000_000, 2, 1000), 3_240_000);
    }

    function test_applyFee_5legsAt1000Bps() public pure {
        // 0.9^5 ≈ 0.59049. 1e6 × 0.59049 = 590_490.
        assertEq(ParlayMath.applyFee(1_000_000, 5, 1000), 590_490);
    }

    function test_applyFee_zeroFeeReturnsInput() public pure {
        assertEq(ParlayMath.applyFee(4_000_000, 5, 0), 4_000_000);
    }

    function test_applyFee_zeroLegsReturnsInput() public pure {
        assertEq(ParlayMath.applyFee(4_000_000, 0, 1000), 4_000_000);
    }

    function test_applyFee_revertsAt100Percent() public {
        vm.expectRevert("ParlayMath: fee >= 100%");
        wrapper.applyFee(4_000_000, 1, 10_000);
    }

    // ── correlationDiscountBps ───────────────────────────────────────────
    // Reference table: D=8000 BPS, k=1e6 PPM (k=1.0).
    //   n=2 → 4000  | n=3 → 5333  | n=4 → 6000  | n=5 → 6400  | n=8 → 7000

    function test_correlationDiscountBps_referenceTable() public pure {
        assertEq(ParlayMath.correlationDiscountBps(2, 8000, 1_000_000), 4000);
        assertEq(ParlayMath.correlationDiscountBps(3, 8000, 1_000_000), 5333);
        assertEq(ParlayMath.correlationDiscountBps(4, 8000, 1_000_000), 6000);
        assertEq(ParlayMath.correlationDiscountBps(5, 8000, 1_000_000), 6400);
        assertEq(ParlayMath.correlationDiscountBps(8, 8000, 1_000_000), 7000);
    }

    function test_correlationDiscountBps_n0_returnsZero() public pure {
        assertEq(ParlayMath.correlationDiscountBps(0, 8000, 1_000_000), 0);
    }

    function test_correlationDiscountBps_n1_returnsZero() public pure {
        assertEq(ParlayMath.correlationDiscountBps(1, 8000, 1_000_000), 0);
    }

    function test_correlationDiscountBps_dZeroAlwaysZero() public pure {
        assertEq(ParlayMath.correlationDiscountBps(2, 0, 1_000_000), 0);
        assertEq(ParlayMath.correlationDiscountBps(8, 0, 1_000_000), 0);
    }

    function test_correlationDiscountBps_largeKFlatten() public pure {
        // k = 100×PPM → at n=2 discount ≈ D/(101) ≈ 79 BPS.
        uint256 d = ParlayMath.correlationDiscountBps(2, 8000, 100 * 1_000_000);
        assertLt(d, 100);
    }

    function test_correlationDiscountBps_smallKSaturate() public pure {
        // k = 1 PPM (much smaller than (n−1)·PPM) → discount ≈ D.
        uint256 d = ParlayMath.correlationDiscountBps(2, 8000, 1);
        assertGe(d, 7900);
    }

    // ── applyCorrelation ─────────────────────────────────────────────────

    function test_applyCorrelation_singleGroup() public pure {
        // 4× indep → 40% discount → 2.4×
        uint256[] memory g = new uint256[](1);
        g[0] = 2;
        uint256 mul = ParlayMath.applyCorrelation(4_000_000, g, 8000, 1_000_000);
        assertEq(mul, 2_400_000);
    }

    function test_applyCorrelation_multipleGroups() public pure {
        // Two groups (sizes 2 + 3) → factors compose: 0.6 × 0.4666... = 0.28
        uint256[] memory g = new uint256[](2);
        g[0] = 2; // 40% discount
        g[1] = 3; // 53.33% discount
        uint256 mul = ParlayMath.applyCorrelation(10_000_000, g, 8000, 1_000_000);
        // 10e6 × (10000-4000)/10000 = 6_000_000 → 6e6 × (10000-5333)/10000 = 2_800_200
        assertEq(mul, 2_800_200);
    }

    function test_applyCorrelation_n1Skipped() public pure {
        uint256[] memory g = new uint256[](2);
        g[0] = 1; // skipped
        g[1] = 2; // 40% discount
        uint256 mul = ParlayMath.applyCorrelation(4_000_000, g, 8000, 1_000_000);
        assertEq(mul, 2_400_000);
    }

    function test_applyCorrelation_emptyGroupsReturnsInput() public pure {
        uint256[] memory g = new uint256[](0);
        assertEq(ParlayMath.applyCorrelation(4_000_000, g, 8000, 1_000_000), 4_000_000);
    }

    // ── computePayout ────────────────────────────────────────────────────

    function test_computePayout_basic() public pure {
        // 10 USDC stake, 4x multiplier => 40 USDC
        uint256 payout = ParlayMath.computePayout(10e6, 4_000_000);
        assertEq(payout, 40e6);
    }

    function test_computePayout_zeroStake() public pure {
        uint256 payout = ParlayMath.computePayout(0, 4_000_000);
        assertEq(payout, 0);
    }

    function test_computePayout_1xMultiplier() public pure {
        uint256 payout = ParlayMath.computePayout(100e6, 1_000_000);
        assertEq(payout, 100e6);
    }

    // ── computeCashoutValue input validation ──────────────────────────────

    function test_cashout_revertsOnZeroTotalLegs() public {
        uint256[] memory wonProbs = new uint256[](1);
        wonProbs[0] = 500_000;
        vm.expectRevert("ParlayMath: zero totalLegs");
        wrapper.computeCashoutValue(10e6, wonProbs, 1, 1500, 0, type(uint128).max);
    }

    function test_cashout_revertsOnUnresolvedExceedsTotal() public {
        uint256[] memory wonProbs = new uint256[](1);
        wonProbs[0] = 500_000;
        vm.expectRevert("ParlayMath: unresolved > total");
        wrapper.computeCashoutValue(10e6, wonProbs, 5, 1500, 3, type(uint128).max);
    }

    function test_cashout_revertsOnPenaltyAboveBPS() public {
        uint256[] memory wonProbs = new uint256[](1);
        wonProbs[0] = 500_000;
        vm.expectRevert("ParlayMath: penalty > 100%");
        wrapper.computeCashoutValue(10e6, wonProbs, 1, 10_001, 2, type(uint128).max);
    }
}
