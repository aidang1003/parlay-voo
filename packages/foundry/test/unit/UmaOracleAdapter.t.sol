// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MockUSDC} from "../../src/MockUSDC.sol";
import {UmaOracleAdapter} from "../../src/oracle/UmaOracleAdapter.sol";
import {MockOptimisticOracleV3} from "../helpers/MockOptimisticOracleV3.sol";
import {IOptimisticOracleV3} from "../../src/interfaces/IOptimisticOracleV3.sol";
import {LegStatus} from "../../src/interfaces/IOracleAdapter.sol";

contract UmaOracleAdapterTest is Test {
    MockUSDC usdc;
    MockOptimisticOracleV3 uma;
    UmaOracleAdapter adapter;

    uint64 constant LIVENESS = 2 hours;
    uint256 constant MIN_BOND = 5e6; // 5 USDC
    uint256 constant BOND = 10e6; // 10 USDC

    address asserter = makeAddr("asserter");
    address disputer = makeAddr("disputer");
    bytes sampleClaim = bytes("ParlayVoo leg 42 resolved YES");

    function setUp() public {
        usdc = new MockUSDC();
        uma = new MockOptimisticOracleV3();
        uma.setMinimumBond(address(usdc), MIN_BOND);

        adapter = new UmaOracleAdapter(IOptimisticOracleV3(address(uma)), IERC20(address(usdc)), LIVENESS, BOND);

        usdc.mint(asserter, 1000e6);
        vm.prank(asserter);
        usdc.approve(address(adapter), type(uint256).max);
    }

    // ── Construction ──────────────────────────────────────────────────────

    function test_constructor_cachesUmaState() public view {
        assertEq(address(adapter.uma()), address(uma));
        assertEq(address(adapter.bondToken()), address(usdc));
        assertEq(adapter.identifier(), uma.DEFAULT_IDENTIFIER());
        assertEq(adapter.minBond(), MIN_BOND);
        assertEq(adapter.liveness(), LIVENESS);
        assertEq(adapter.bondAmount(), BOND);
    }

    function test_constructor_revertsOnBondBelowMin() public {
        vm.expectRevert(UmaOracleAdapter.UmaOracle__BondBelowMin.selector);
        new UmaOracleAdapter(IOptimisticOracleV3(address(uma)), IERC20(address(usdc)), LIVENESS, MIN_BOND - 1);
    }

    // ── IOracleAdapter conformance ───────────────────────────────────────

    function test_getStatus_unresolvedByDefault() public view {
        (LegStatus s, bytes32 o) = adapter.getStatus(1);
        assertEq(uint8(s), uint8(LegStatus.Unresolved));
        assertEq(o, bytes32(0));
        assertFalse(adapter.canResolve(1));
    }

    // ── assertOutcome ────────────────────────────────────────────────────

    function test_assertOutcome_permissionless_pullsBond() public {
        uint256 balBefore = usdc.balanceOf(asserter);

        vm.prank(asserter);
        bytes32 assertionId = adapter.assertOutcome(1, LegStatus.Won, bytes32(uint256(1)), sampleClaim);

        assertEq(usdc.balanceOf(asserter), balBefore - BOND);
        assertEq(usdc.balanceOf(address(uma)), BOND);
        assertEq(adapter.assertionByLeg(1), assertionId);
        assertEq(adapter.legByAssertion(assertionId), 1);
        assertFalse(adapter.canResolve(1));
    }

    function test_assertOutcome_revertsIfPending() public {
        vm.prank(asserter);
        adapter.assertOutcome(1, LegStatus.Won, bytes32(uint256(1)), sampleClaim);

        vm.expectRevert(UmaOracleAdapter.UmaOracle__PendingAssertion.selector);
        vm.prank(asserter);
        adapter.assertOutcome(1, LegStatus.Lost, bytes32(uint256(2)), sampleClaim);
    }

    function test_assertOutcome_revertsIfFinalized() public {
        vm.prank(asserter);
        bytes32 aid = adapter.assertOutcome(1, LegStatus.Won, bytes32(uint256(1)), sampleClaim);
        uma.mockSettle(aid, true);

        vm.expectRevert(UmaOracleAdapter.UmaOracle__AlreadyFinalized.selector);
        vm.prank(asserter);
        adapter.assertOutcome(1, LegStatus.Won, bytes32(uint256(1)), sampleClaim);
    }

    function test_assertOutcome_revertsOnUnresolvedStatus() public {
        vm.expectRevert(UmaOracleAdapter.UmaOracle__InvalidStatus.selector);
        vm.prank(asserter);
        adapter.assertOutcome(1, LegStatus.Unresolved, bytes32(0), sampleClaim);
    }

    // ── Callback auth ────────────────────────────────────────────────────

    function test_assertionResolvedCallback_revertsIfNotUma() public {
        vm.expectRevert(UmaOracleAdapter.UmaOracle__NotUma.selector);
        adapter.assertionResolvedCallback(bytes32(uint256(1)), true);
    }

    // ── Truthful settlement writes final state ───────────────────────────

    function test_truthfulSettlement_writesFinalState() public {
        vm.prank(asserter);
        bytes32 aid = adapter.assertOutcome(1, LegStatus.Won, bytes32(uint256(0xa1)), sampleClaim);

        uma.mockSettle(aid, true);

        assertTrue(adapter.canResolve(1));
        (LegStatus s, bytes32 o) = adapter.getStatus(1);
        assertEq(uint8(s), uint8(LegStatus.Won));
        assertEq(o, bytes32(uint256(0xa1)));
        // pending maps cleared
        assertEq(adapter.legByAssertion(aid), 0);
    }

    function test_truthfulSettlement_refundsBondToAsserter() public {
        vm.prank(asserter);
        bytes32 aid = adapter.assertOutcome(1, LegStatus.Lost, bytes32(uint256(2)), sampleClaim);

        uint256 balBeforeSettle = usdc.balanceOf(asserter);
        uma.mockSettle(aid, true);
        assertEq(usdc.balanceOf(asserter), balBeforeSettle + BOND);
    }

    // ── Falsified settlement clears pending so retry works ───────────────

    function test_falsifiedSettlement_clearsPending_allowsRetry() public {
        vm.prank(asserter);
        bytes32 aid1 = adapter.assertOutcome(1, LegStatus.Won, bytes32(uint256(1)), sampleClaim);

        uma.mockSettle(aid1, false);

        // Not finalized
        assertFalse(adapter.canResolve(1));
        // assertionByLeg cleared -> retry is allowed
        assertEq(adapter.assertionByLeg(1), bytes32(0));

        vm.prank(asserter);
        bytes32 aid2 = adapter.assertOutcome(1, LegStatus.Lost, bytes32(uint256(2)), sampleClaim);
        assertTrue(aid2 != bytes32(0) && aid2 != aid1);
    }

    // ── settleMature wrapper ─────────────────────────────────────────────

    function test_settleMature_revertsOnUnknownLeg() public {
        vm.expectRevert(UmaOracleAdapter.UmaOracle__UnknownAssertion.selector);
        adapter.settleMature(999);
    }

    function test_settleMature_forwardsToUma() public {
        vm.prank(asserter);
        adapter.assertOutcome(1, LegStatus.Won, bytes32(uint256(1)), sampleClaim);
        // Mock's settleAssertion reverts, proving the adapter forwarded the call.
        vm.expectRevert(bytes("mock: use mockSettle"));
        adapter.settleMature(1);
    }

    // ── Dispute callback is a no-op signal ───────────────────────────────

    function test_disputeCallback_doesNotFinalize() public {
        vm.prank(asserter);
        bytes32 aid = adapter.assertOutcome(1, LegStatus.Won, bytes32(uint256(1)), sampleClaim);

        uma.mockDispute(aid);

        assertFalse(adapter.canResolve(1));
        assertEq(adapter.assertionByLeg(1), aid);
    }

    // ── Admin setters ────────────────────────────────────────────────────

    function test_setLiveness_onlyOwner() public {
        adapter.setLiveness(3600);
        assertEq(adapter.liveness(), 3600);

        vm.prank(asserter);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, asserter));
        adapter.setLiveness(60);
    }

    function test_setBondAmount_revertsBelowMin() public {
        vm.expectRevert(UmaOracleAdapter.UmaOracle__BondBelowMin.selector);
        adapter.setBondAmount(MIN_BOND - 1);
    }

    function test_setBondAmount_setsWhenAboveMin() public {
        adapter.setBondAmount(MIN_BOND);
        assertEq(adapter.bondAmount(), MIN_BOND);
    }

    function test_adminSetters_cannotWriteOutcomeState() public {
        // Seed a pending assertion, settle falsified, then exercise every
        // onlyOwner entry point — none of them should make canResolve flip.
        vm.prank(asserter);
        bytes32 aid = adapter.assertOutcome(1, LegStatus.Won, bytes32(uint256(1)), sampleClaim);
        uma.mockSettle(aid, false);

        adapter.setLiveness(1);
        adapter.setBondAmount(MIN_BOND);

        assertFalse(adapter.canResolve(1));
    }
}
