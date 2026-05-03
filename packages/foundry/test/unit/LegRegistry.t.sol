// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LegRegistry} from "../../src/core/LegRegistry.sol";

contract LegRegistryTest is Test {
    LegRegistry registry;
    address oracle = makeAddr("oracle");

    function setUp() public {
        vm.warp(1000);
        registry = new LegRegistry();
    }

    function test_createLeg_happy() public {
        uint256 legId = registry.createLeg("ETH > 5k?", "source", 2000, 3000, oracle, 500_000);
        assertEq(legId, 0);
        assertEq(registry.legCount(), 1);

        LegRegistry.Leg memory leg = registry.getLeg(0);
        assertEq(leg.question, "ETH > 5k?");
        assertEq(leg.cutoffTime, 2000);
        assertEq(leg.earliestResolve, 3000);
        assertEq(leg.probabilityPPM, 500_000);
        assertTrue(leg.active);
    }

    function test_createLeg_cutoffInPast_reverts() public {
        vm.expectRevert("LegRegistry: cutoff in past");
        registry.createLeg("Q", "s", 500, 600, oracle, 500_000); // 500 < block.timestamp=1000
    }

    function test_createLeg_resolveBeforeCutoff_reverts() public {
        vm.expectRevert("LegRegistry: resolve before cutoff");
        registry.createLeg("Q", "s", 2000, 1500, oracle, 500_000);
    }

    function test_createLeg_zeroProbability_reverts() public {
        vm.expectRevert("LegRegistry: invalid probability");
        registry.createLeg("Q", "s", 2000, 3000, oracle, 0);
    }

    function test_createLeg_overPPM_reverts() public {
        vm.expectRevert("LegRegistry: invalid probability");
        registry.createLeg("Q", "s", 2000, 3000, oracle, 1_000_001);
    }

    function test_createLeg_zeroOracle_reverts() public {
        vm.expectRevert("LegRegistry: zero oracle");
        registry.createLeg("Q", "s", 2000, 3000, address(0), 500_000);
    }

    function test_getLeg_invalidId_reverts() public {
        vm.expectRevert("LegRegistry: invalid legId");
        registry.getLeg(999);
    }

    function test_deactivateLeg() public {
        registry.createLeg("Q", "s", 2000, 3000, oracle, 500_000);
        registry.deactivateLeg(0);

        LegRegistry.Leg memory leg = registry.getLeg(0);
        assertFalse(leg.active);
    }

    function test_deactivateLeg_twice_succeeds() public {
        registry.createLeg("Q", "s", 2000, 3000, oracle, 500_000);
        registry.deactivateLeg(0);
        registry.deactivateLeg(0); // idempotent
        assertFalse(registry.getLeg(0).active);
    }

    function test_updateProbability() public {
        registry.createLeg("Q", "s", 2000, 3000, oracle, 500_000);
        registry.updateProbability(0, 750_000);
        assertEq(registry.getLeg(0).probabilityPPM, 750_000);
    }

    function test_updateProbability_zero_reverts() public {
        registry.createLeg("Q", "s", 2000, 3000, oracle, 500_000);
        vm.expectRevert("LegRegistry: invalid probability");
        registry.updateProbability(0, 0);
    }

    function test_updateProbability_invalidLeg_reverts() public {
        vm.expectRevert("LegRegistry: invalid legId");
        registry.updateProbability(99, 500_000);
    }

    function test_createLeg_onlyOwner() public {
        vm.prank(makeAddr("random"));
        vm.expectRevert();
        registry.createLeg("Q", "s", 2000, 3000, oracle, 500_000);
    }

    // ── Correlation + exclusion tagging ──────────────────────────────────

    function test_legCorrGroup_defaultsToZero() public {
        registry.createLeg("Q", "s", 2000, 3000, oracle, 500_000);
        assertEq(registry.legCorrGroup(0), 0);
    }

    function test_legExclusionGroup_defaultsToZero() public {
        registry.createLeg("Q", "s", 2000, 3000, oracle, 500_000);
        assertEq(registry.legExclusionGroup(0), 0);
    }

    function test_setLegCorrGroup_setsAndEmits() public {
        registry.createLeg("Q", "s", 2000, 3000, oracle, 500_000);
        vm.expectEmit(true, true, true, true);
        emit LegRegistry.LegCorrGroupSet(0, 0, 42);
        registry.setLegCorrGroup(0, 42);
        assertEq(registry.legCorrGroup(0), 42);
    }

    function test_setLegExclusionGroup_setsAndEmits() public {
        registry.createLeg("Q", "s", 2000, 3000, oracle, 500_000);
        vm.expectEmit(true, true, true, true);
        emit LegRegistry.LegExclusionGroupSet(0, 0, 7);
        registry.setLegExclusionGroup(0, 7);
        assertEq(registry.legExclusionGroup(0), 7);
    }

    function test_setLegCorrGroup_invalidLegId_reverts() public {
        vm.expectRevert("LegRegistry: invalid legId");
        registry.setLegCorrGroup(99, 1);
    }

    function test_setLegExclusionGroup_invalidLegId_reverts() public {
        vm.expectRevert("LegRegistry: invalid legId");
        registry.setLegExclusionGroup(99, 1);
    }

    function test_setLegCorrGroup_onlyOwner() public {
        registry.createLeg("Q", "s", 2000, 3000, oracle, 500_000);
        vm.prank(makeAddr("random"));
        vm.expectRevert();
        registry.setLegCorrGroup(0, 1);
    }

    function test_setLegExclusionGroup_onlyOwner() public {
        registry.createLeg("Q", "s", 2000, 3000, oracle, 500_000);
        vm.prank(makeAddr("random"));
        vm.expectRevert();
        registry.setLegExclusionGroup(0, 1);
    }

    function test_getLegCorrGroups_batchRead() public {
        registry.createLeg("a", "src-a", 2000, 3000, oracle, 500_000);
        registry.createLeg("b", "src-b", 2000, 3000, oracle, 500_000);
        registry.createLeg("c", "src-c", 2000, 3000, oracle, 500_000);
        registry.setLegCorrGroup(0, 100);
        registry.setLegCorrGroup(2, 100);

        uint256[] memory ids = new uint256[](3);
        ids[0] = 0;
        ids[1] = 1;
        ids[2] = 2;
        uint256[] memory groups = registry.getLegCorrGroups(ids);
        assertEq(groups[0], 100);
        assertEq(groups[1], 0);
        assertEq(groups[2], 100);
    }

    function test_getLegExclusionGroups_batchRead() public {
        registry.createLeg("a", "src-a", 2000, 3000, oracle, 500_000);
        registry.createLeg("b", "src-b", 2000, 3000, oracle, 500_000);
        registry.setLegExclusionGroup(0, 7);
        registry.setLegExclusionGroup(1, 7);

        uint256[] memory ids = new uint256[](2);
        ids[0] = 0;
        ids[1] = 1;
        uint256[] memory groups = registry.getLegExclusionGroups(ids);
        assertEq(groups[0], 7);
        assertEq(groups[1], 7);
    }
}
