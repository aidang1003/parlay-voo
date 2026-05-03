// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ParlayMath} from "../../src/libraries/ParlayMath.sol";

/// @notice Property-based tests for the correlation engine. Locks down the
///         invariants that fee + correlation can only ever discount the
///         multiplier and never inflate it, and that factor(n) stays in (0, 1].
contract CorrelationFuzz is Test {
    uint256 constant BPS = 10_000;
    uint256 constant PPM = 1_000_000;

    /// @notice applyFee never inflates and matches the iterative formula
    ///         exactly: result == mul × ((BPS - f) / BPS)^numLegs.
    function testFuzz_applyFee_iterativeMatch(uint256 mul, uint256 numLegs, uint256 feeBps) public pure {
        mul = bound(mul, 0, type(uint128).max);
        numLegs = bound(numLegs, 0, 8);
        feeBps = bound(feeBps, 0, BPS - 1);

        uint256 expected = mul;
        for (uint256 i = 0; i < numLegs; i++) {
            expected = (expected * (BPS - feeBps)) / BPS;
        }
        uint256 got = ParlayMath.applyFee(mul, numLegs, feeBps);
        assertEq(got, expected);
        assertLe(got, mul);
    }

    /// @notice correlationDiscountBps is bounded by [0, asymptoteBps] and
    ///         monotonically non-decreasing in `n` for fixed (D, k).
    /// @dev    Truncation can collapse the discount to zero when D × (n-1) < k,
    ///         so the lower bound is 0, not >0.
    function testFuzz_correlation_boundedAndMonotonic(uint256 n, uint256 d, uint256 k) public pure {
        n = bound(n, 2, 10);
        d = bound(d, 1, BPS - 1);
        k = bound(k, 1, 100 * PPM);

        uint256 disc = ParlayMath.correlationDiscountBps(n, d, k);
        assertLe(disc, d);

        uint256 discPlus = ParlayMath.correlationDiscountBps(n + 1, d, k);
        assertGe(discPlus, disc);
    }

    /// @notice applyCorrelation only ever discounts the multiplier — n_g < 2
    ///         groups are skipped, every other group contributes a factor in
    ///         (0, 1]. Composing them must produce result <= input.
    function testFuzz_applyCorrelation_neverInflates(
        uint256 mul,
        uint256 g0,
        uint256 g1,
        uint256 d,
        uint256 k
    ) public pure {
        mul = bound(mul, PPM, 1e15);
        g0 = bound(g0, 0, 8);
        g1 = bound(g1, 0, 8);
        d = bound(d, 0, BPS - 1);
        k = bound(k, 1, 100 * PPM);

        uint256[] memory groups = new uint256[](2);
        groups[0] = g0;
        groups[1] = g1;
        uint256 got = ParlayMath.applyCorrelation(mul, groups, d, k);
        assertLe(got, mul);
    }

    /// @notice Reference-table parity: at the documented defaults
    ///         (D=8000, k=1e6) the discount equals D/2 exactly when
    ///         n - 1 == 1 (i.e. n=2) and approaches D as n grows.
    function test_correlation_referenceHalfSat() public pure {
        // n=2 → discount = 8000 × 1 × 1e6 / (1 × 1e6 + 1e6) = 4000 = D/2
        assertEq(ParlayMath.correlationDiscountBps(2, 8000, 1_000_000), 4000);
        // n=∞ asymptote: 8000 × n / (n + 1) → 8000 as n → ∞
        // n=100 should be very close to 8000.
        uint256 d100 = ParlayMath.correlationDiscountBps(100, 8000, 1_000_000);
        assertGe(d100, 7900);
        assertLe(d100, 8000);
    }
}
